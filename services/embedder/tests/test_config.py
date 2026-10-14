import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from services.embedder.config import Config
from services.embedder import native_check


class ConfigTests(unittest.TestCase):
    def test_constructor_and_environment_defaults_keep_four_frames_and_watchdog(self):
        with patch.dict(os.environ, {}, clear=True):
            for config in (Config(), Config.from_env()):
                self.assertEqual(config.max_frames, 4)
                self.assertEqual(config.inference_timeout, 120)

    def test_native_probe_explicitly_keeps_historical_eight_frame_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            spike = Path(directory)
            (spike / 'inputs').mkdir()
            with patch.object(native_check, 'SPIKE', spike):
                config = native_check.probe_config()
            self.assertEqual(config.max_frames, 8)
            self.assertEqual(config.inference_timeout, 120)
            self.assertEqual(config.allowed_roots, (spike / 'inputs',))
        self.assertEqual(Config().max_frames, 4)


if __name__ == '__main__':
    unittest.main()
