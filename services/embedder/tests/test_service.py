import math
import tempfile
import threading
import time
import unittest
from dataclasses import replace
from pathlib import Path

from services.embedder.config import Config
from services.embedder.errors import RequestError
from services.embedder.service import Embedder
from services.embedder.text import text_chunks


class FakeEngine:
    def __init__(self):
        self.calls = []
        self.closed = False

    def embed(self, content):
        self.calls.append(content)
        return [3.0, 4.0] + [0.0] * 766

    def close(self):
        self.closed = True


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.engines = []
        self.config = Config()
        self.service = Embedder(self.config, self.factory)

    def factory(self):
        e = FakeEngine()
        self.engines.append(e)
        return e

    def tearDown(self):
        self.service.close()

    def test_doctor_health_and_queue_contract(self):
        self.assertEqual(self.config.queue_timeout, 110)
        with tempfile.TemporaryDirectory() as directory:
            model, cache = Path(directory) / 'model', Path(directory) / 'cache'
            self.service.config = replace(self.config, model_path=model, cache_dir=cache)
            self.assertFalse(self.service.health()['model_available'])
            model.write_bytes(b'fixture')
            cache.mkdir()
            health = self.service.health()
            self.assertEqual(health['status'], 'ok')
            self.assertEqual(health['model'], 'litert-community/embeddinggemma-2-740m-litert-lm')
            self.assertTrue(health['model_available'])
            self.assertFalse(health['loaded'])
        self.assertEqual(self.engines, [])

    def test_lazy_prefix_batch_and_normalization(self):
        self.assertFalse(self.service.health()['loaded'])
        result = self.service.embeddings({'input': ['bread', 'coffee'], 'role': 'query'})
        self.assertEqual(self.engines[0].calls, [
            'task: search result | query: bread', 'task: search result | query: coffee'])
        self.assertEqual([r['index'] for r in result['data']], [0, 1])
        self.assertEqual(result['object'], 'list')
        self.assertEqual(result['model'], 'litert-community/embeddinggemma-2-740m-litert-lm')
        self.assertAlmostEqual(sum(x*x for x in result['data'][0]['embedding']), 1)
        self.assertTrue(self.service.health()['loaded'])

    def test_prefixed_is_not_prefixed_twice(self):
        text = 'title: My chat | text: something useful'
        self.service.embeddings({'input': text, 'input_format': 'prefixed'})
        self.assertEqual(self.engines[0].calls, [text])
        self.service.embeddings({'input': 'task: search result | query: bread',
                                 'input_format': 'prefixed', 'role': 'query'})
        self.assertEqual(self.engines[0].calls[-1], 'task: search result | query: bread')

    def test_explicit_title_delimiters_preserve_entire_body(self):
        title = 'Chat | text: with a delimiter'
        prefix = f'title: {title} | text: '
        body = 'A body with | text: inside.\n\n' + 'Sentence. ' * 40 + 'tail'
        chunks = text_chunks(prefix + body, 'document', title, 'prefixed', 180)
        self.assertEqual(''.join(c[len(prefix):] for c in chunks), body)
        self.assertTrue(all(c.startswith(prefix) for c in chunks))
        self.service.embeddings({'input': prefix + body, 'title': title, 'input_format': 'prefixed'})
        self.assertEqual(self.engines[0].calls, [prefix + body])
        # Legacy callers that omit title still split only at the first delimiter.
        legacy = 'title: Bake | text: body | text: kept'
        self.assertEqual(text_chunks(legacy, 'document', None, 'prefixed', 180), [legacy])

    def test_role_and_exact_title_must_agree_with_prefix(self):
        for request in [
            {'input': 'task: search result | query: bread', 'role': 'document', 'input_format': 'prefixed'},
            {'input': 'title: Bake | text: bread', 'role': 'query', 'input_format': 'prefixed'},
            {'input': 'title: Bake | text: bread', 'title': 'Other', 'input_format': 'prefixed'},
        ]:
            with self.assertRaises(RequestError):
                self.service.embeddings(request)
        self.assertEqual(self.engines, [])

    def test_long_raw_and_prefixed_documents_keep_context_and_tail(self):
        body = 'First paragraph about bread.\n\n' + 'A sentence about ovens. ' * 200 + 'FINAL TAIL'
        for text, fmt in [(body, 'raw'), ('title: Bake | text: ' + body, 'prefixed')]:
            chunks = text_chunks(text, 'document', 'Bake', fmt, 240)
            self.assertGreater(len(chunks), 2)
            self.assertTrue(all(c.startswith('title: Bake | text: ') for c in chunks))
            self.assertTrue(all(len(c.encode()) <= 240 for c in chunks))
            self.assertIn('FINAL TAIL', chunks[-1])
            self.assertIn('First paragraph about bread.', chunks[0])
            self.assertEqual(''.join(c.split(' | text: ', 1)[1] for c in chunks), body)

    def test_unicode_and_long_unbroken_text(self):
        body = '日本語🧘' * 700
        chunks = text_chunks(body, 'query', 'none', 'raw', 200)
        prefix = 'task: search result | query: '
        self.assertEqual(''.join(c[len(prefix):] for c in chunks), body)
        self.assertTrue(all(len(c.encode()) <= 200 for c in chunks))

    def test_pooling_renormalizes_and_dimensions(self):
        self.service.config = replace(self.config, chunk_bytes=120)
        vectors = iter([[3., 0.] + [0.] * 766, [0., 4.] + [0.] * 766])
        e = FakeEngine()
        e.embed = lambda _: next(vectors)
        self.service.factory = lambda: e
        result = self.service.embeddings({'input': 'x' * 194, 'dimensions': 128})
        v = result['data'][0]['embedding']
        self.assertEqual(len(v), 128)
        self.assertAlmostEqual(v[0], math.sqrt(.5))
        self.assertAlmostEqual(v[1], math.sqrt(.5))

    def test_validation_does_not_load_engine(self):
        invalid = [None, {}, {'input': []}, {'input': [1]}, {'input': ''},
                   {'input': 'a', 'role': 'bad'}, {'input': 'a', 'dimensions': True},
                   {'input': 'a', 'dimensions': 3}, {'input': 'a', 'encoding_format': 'bad'},
                   {'input': 'a', 'input_format': 'bad'},
                   {'input': 'not prefixed', 'input_format': 'prefixed'},
                   {'input': 'a', 'model': 'wrong'}, {'input': ['x'] * 9},
                   {'input': 'x' * (self.config.max_text_bytes + 1)},
                   {'input': {'type': 'image', 'base64': '!', 'path': '/x'}},
                   {'input': 'a', 'title': 'x' * 257}]
        for payload in invalid:
            with self.subTest(payload=str(payload)[:100]), self.assertRaises(RequestError):
                self.service.embeddings(payload)
        self.assertEqual(self.engines, [])

    def test_rejects_nonfinite_wrong_size_and_zero_vectors(self):
        for vector in [[float('nan')] * 768, [0.] * 768, [1.] * 3]:
            service = Embedder(self.config, lambda: FakeEngine())
            engine = FakeEngine()
            engine.embed = lambda _: vector
            service.factory = lambda: engine
            with self.assertRaises(RequestError):
                service.embeddings({'input': 'a'})
            service.close()

    def test_idle_unload_and_reload(self):
        now = [10.]
        self.service.clock = lambda: now[0]
        self.service.config = replace(self.config, idle_seconds=2)
        self.service.embeddings({'input': 'a'})
        now[0] = 11
        self.assertFalse(self.service.unload_if_idle())
        now[0] = 13
        self.assertTrue(self.service.unload_if_idle())
        self.assertTrue(self.engines[0].closed)
        self.service.embeddings({'input': 'b'})
        self.assertEqual(len(self.engines), 2)

    def test_queue_bounded_and_idle_never_closes_active_engine(self):
        entered, release = threading.Event(), threading.Event()
        e = FakeEngine()
        def blocked(content):
            entered.set()
            release.wait(3)
            return [1.] * 768
        e.embed = blocked
        self.service = Embedder(replace(self.config, queue_size=0, idle_seconds=.01), lambda: e)
        errors = []
        def work():
            try:
                self.service.embeddings({'input': 'a'})
            except Exception as exc:
                errors.append(exc)
        worker = threading.Thread(target=work)
        worker.start()
        self.assertTrue(entered.wait(1))
        self.assertFalse(self.service.unload_if_idle())
        self.assertFalse(e.closed)
        with self.assertRaises(RequestError) as caught:
            self.service.embeddings({'input': 'b'})
        self.assertEqual(caught.exception.status, 429)
        release.set()
        worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])

    def test_decode_and_engine_share_lock(self):
        from services.embedder.media import MediaPart
        entered, release = threading.Event(), threading.Event()
        class Decoder:
            def prepare(inner, item, directory):
                entered.set()
                release.wait(3)
                p = directory / 'a.png'
                p.write_bytes(b'fake')
                return [MediaPart('image', p)]
        self.service.decoder = Decoder()
        errors = []
        def media_work():
            try:
                self.service.embeddings({'input': {'type': 'image', 'base64': 'eA=='}})
            except Exception as e:
                errors.append(e)
        a = threading.Thread(target=media_work)
        b = threading.Thread(target=lambda: self.service.embeddings({'input': 'text'}))
        a.start()
        self.assertTrue(entered.wait(1))
        b.start()
        time.sleep(.03)
        self.assertEqual(self.engines, [])
        release.set()
        a.join(3)
        b.join(3)
        self.assertEqual(errors, [])
        self.assertEqual(len(self.engines), 1)
        self.assertEqual(len(self.engines[0].calls), 2)


if __name__ == '__main__':
    unittest.main()
