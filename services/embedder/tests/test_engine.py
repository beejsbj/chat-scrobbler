import sys
import tempfile
import types
from pathlib import Path
from unittest.mock import patch
import unittest

from services.embedder.config import Config
from services.embedder.engine import LiteRTEngine
from services.embedder.media import MediaPart


class EngineTests(unittest.TestCase):
    def test_single_media_uses_bare_native_input_and_video_uses_list(self):
        received = []
        class ImageFile:
            def __init__(self, path):
                self.path = path
        class AudioFile(ImageFile):
            pass
        class Native:
            def __init__(self, *args, **kwargs):
                pass
            def compute_embedding(self, content, options):
                received.append(content)
                return types.SimpleNamespace(embedding=[1.] * 768)
        lm = types.SimpleNamespace(EmbeddingEngine=Native,
            EmbeddingOptions=lambda **kwargs: kwargs,
            Backend=types.SimpleNamespace(CPU=lambda **kwargs: kwargs),
            InputOverflowStrategy=types.SimpleNamespace(ERROR='error'))
        messages = types.SimpleNamespace(ImageFile=ImageFile, AudioFile=AudioFile)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            model = path / 'model'
            model.touch()
            with patch.dict(sys.modules, {'litert_lm': lm, 'litert_lm._messages': messages}):
                engine = LiteRTEngine(Config(model_path=model, cache_dir=path))
                engine.embed([MediaPart('image', path / 'image.png')])
                engine.embed([MediaPart('audio', path / 'audio.wav')])
                engine.embed([MediaPart('image', path / f'{i}.png') for i in range(4)])
        self.assertIsInstance(received[0], ImageFile)
        self.assertIsInstance(received[1], AudioFile)
        self.assertIsInstance(received[2], list)
        self.assertEqual(len(received[2]), 4)
