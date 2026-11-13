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



class SpikeLocationTests(unittest.TestCase):
    def spike(self, **env):
        import subprocess
        import sys
        root = Path(__file__).resolve().parents[3]
        clean = {k: v for k, v in os.environ.items() if k != 'EMBEDDER_SPIKE_DIR'}
        result = subprocess.run([sys.executable, '-B', '-c',
                                 'from services.embedder.config import SPIKE; print(SPIKE)'],
                                cwd=root, env={**clean, **env}, capture_output=True, text=True, check=True)
        return result.stdout.strip()

    def test_spike_workspace_is_env_driven_with_a_host_neutral_default(self):
        self.assertEqual(self.spike(EMBEDDER_SPIKE_DIR='/work/spike'), '/work/spike')
        self.assertEqual(self.spike(), 'spike')


if __name__ == '__main__':
    unittest.main()
