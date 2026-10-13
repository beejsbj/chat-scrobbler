import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from services.embedder.config import Config


class ModelTests(unittest.TestCase):
    def test_deploy_defaults_are_independent_of_spike(self):
        self.assertEqual(str(Config().model_path), '/opt/models/embeddinggemma-2-740m.litertlm')
        self.assertEqual(str(Config().cache_dir), '/var/cache/embedder')
        dockerfile = Path('services/embedder/Dockerfile').read_text()
        self.assertNotIn('/spikes/', dockerfile)
        self.assertIn('pip install', dockerfile)
        self.assertIn('services.embedder.fetch_model', dockerfile)
        self.assertIn('USER 1001:1001', dockerfile)

    def test_pinned_download_is_verified_and_valid_cache_is_reused(self):
        from services.embedder.fetch_model import fetch_model, MODEL_URL
        self.assertIn('/24d962e906c7d332c6428e71c9676855024569e2/', MODEL_URL)
        data = b'model fixture'
        digest = hashlib.sha256(data).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'model'
            with patch('urllib.request.urlopen', return_value=io.BytesIO(data)) as fetch:
                fetch_model(target, expected=digest)
                self.assertEqual(target.read_bytes(), data)
                fetch_model(target, expected=digest)
                self.assertEqual(fetch.call_count, 1)
            target.unlink()
            with patch('urllib.request.urlopen', return_value=io.BytesIO(b'corrupt')):
                with self.assertRaises(ValueError):
                    fetch_model(target, expected=digest)
            self.assertFalse(target.exists())
            self.assertEqual(list(Path(directory).iterdir()), [])
