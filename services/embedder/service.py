import base64
import gc
import os
import struct
import tempfile
import threading
import time
from pathlib import Path

from .config import MODEL_ID
from .errors import RequestError
from .media import Decoder, validate_media
from .text import byte_length, pooled, text_chunks
from .queue import EngineQueue


class Embedder:
    def __init__(self, config, factory=None, clock=time.monotonic):
        self.config = config
        if factory is None:
            from .engine import LiteRTEngine
            factory = lambda: LiteRTEngine(config)
        self.factory, self.clock = factory, clock
        self.decoder = Decoder(config)
        self.lock = threading.Lock()
        self.queue = EngineQueue(self.lock, config.queue_size, config.queue_timeout)
        self.engine = None
        self.last_used = self.clock()
        self.stopped = False

    def health(self):
        # No engine lock: health stays responsive while decoding or computing.
        return {'status': 'stopped' if self.stopped else 'ok', 'model': MODEL_ID,
                'model_available': self.model_available(), 'loaded': self.engine is not None, 'busy': self.lock.locked(),
                'queued': self.queue.queued, 'threads': 2, 'vision_tokens': 140, 'idle_seconds': self.config.idle_seconds,
                'rss_kib': current_rss_kib()}

    def model_available(self):
        try:
            return (self.config.model_path.is_file() and self.config.cache_dir.is_dir()
                    and os.access(self.config.model_path, os.R_OK)
                    and os.access(self.config.cache_dir, os.R_OK | os.W_OK | os.X_OK))
        except OSError:
            return False

    def _plan(self, request):
        if not isinstance(request, dict):
            raise RequestError('request must be an object')
        if request.get('model', MODEL_ID) != MODEL_ID:
            raise RequestError(f'model must be {MODEL_ID}')
        dimensions = request.get('dimensions', 768)
        if type(dimensions) is not int or dimensions not in (128, 256, 512, 768):
            raise RequestError('dimensions must be 128, 256, 512, or 768')
        encoding = request.get('encoding_format', 'float')
        if encoding not in ('float', 'base64'):
            raise RequestError('encoding_format must be float or base64')
        role, fmt = request.get('role', 'document'), request.get('input_format', 'raw')
        title = request.get('title')
        items = request.get('input')
        if isinstance(items, (str, dict)):
            items = [items]
        if not isinstance(items, list) or not 1 <= len(items) <= self.config.max_batch:
            raise RequestError('input must be text, media, or a batch of 1 to 8 items')
        plan, count = [], 0
        for item in items:
            item_role = item.get('role', role) if isinstance(item, dict) else role
            if item_role not in ('query', 'document') or fmt not in ('raw', 'prefixed'):
                raise RequestError('invalid role or input_format')
            if 'title' in request and (not isinstance(title, str) or byte_length(title) > 256):
                raise RequestError('title must be a string of at most 256 UTF-8 bytes')
            if isinstance(item, str):
                if byte_length(item) > self.config.max_text_bytes:
                    raise RequestError('text exceeds byte limit', 413)
                chunks = text_chunks(item, item_role, title, fmt, self.config.chunk_bytes)
                count += len(chunks)
                plan.append(chunks)
            elif isinstance(item, dict):
                validate_media(item, self.config)
                plan.append(item)
                count += 1
            else:
                raise RequestError('input items must be strings or media objects')
        if count > self.config.max_chunks:
            raise RequestError('request exceeds chunk budget', 413)
        return plan, dimensions, encoding

    def embeddings(self, request):
        plan, dimensions, encoding = self._plan(request)
        items = request['input'] if isinstance(request['input'], list) else [request['input']]
        query = any((item.get('role', request.get('role', 'document')) if isinstance(item, dict)
                     else request.get('role', 'document')) == 'query' for item in items)
        self.queue.acquire(query)
        try:
            if self.stopped:
                raise RequestError('service stopped', 503, 'unavailable')
            data = []
            # Every decoded file and engine call belongs to this lock. Socket
            # disconnects only affect writing the response, never this lifetime.
            with tempfile.TemporaryDirectory(prefix='chat-embedder-') as temp:
                for index, item in enumerate(plan):
                    directory = Path(temp) / str(index)
                    directory.mkdir()
                    content = self.decoder.prepare(item, directory) if isinstance(item, dict) else None
                    if self.engine is None:
                        try:
                            self.engine = self.factory()
                        except Exception as exc:
                            raise RequestError('local embedding engine unavailable', 503, 'unavailable') from exc
                    vectors = ([self.engine.embed(content)] if content is not None else
                               [self.engine.embed(chunk) for chunk in item])
                    vector = pooled(vectors, dimensions)
                    if encoding == 'base64':
                        vector = base64.b64encode(struct.pack(f'<{dimensions}f', *vector)).decode('ascii')
                    data.append({'object': 'embedding', 'index': index, 'embedding': vector})
            return {'object': 'list', 'data': data, 'model': MODEL_ID}
        except RequestError:
            raise
        except Exception as exc:
            raise RequestError('embedding failed', 500, 'engine_error') from exc
        finally:
            self.last_used = self.clock()
            self.queue.release()

    def unload_if_idle(self):
        if not self.lock.acquire(blocking=False):
            return False
        try:
            if self.engine is not None and self.clock() - self.last_used >= self.config.idle_seconds:
                self._unload()
                return True
            return False
        finally:
            self.lock.release()
            self.queue.notify()

    def _unload(self):
        engine, self.engine = self.engine, None
        if engine is not None:
            engine.close()
            del engine
            gc.collect()

    def close(self):
        with self.lock:
            self.stopped = True
            self._unload()


def current_rss_kib():
    try:
        with open('/proc/self/status') as f:
            return next(int(line.split()[1]) for line in f if line.startswith('VmRSS:'))
    except (OSError, StopIteration):
        return None
