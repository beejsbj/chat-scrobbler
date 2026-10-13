import unittest
from unittest.mock import patch

from services.embedder.measure import ensure_low_load, measurement_command, run_stages
from services.embedder.errors import RequestError


class MeasurementTests(unittest.TestCase):
    def test_first_idle_unload_precedes_reload_and_all_media(self):
        stages, sleeps = [], []
        class Service:
            def unload_if_idle(self):
                return True
            def close(self):
                stages.append('close')
        def request(stage, payload):
            stages.append(stage)
        def sample(stage):
            stages.append(stage)
        run_stages(Service(), request, sample, sleep=sleeps.append)
        self.assertEqual(stages, [
            'after_lazy_load_and_text', 'loaded_idle_1', 'unload_1_immediate',
            'unload_1_settled_1s', 'unload_1_settled_5s', 'unload_1_settled_15s',
            'after_reload_and_text', 'after_image', 'after_audio', 'after_video',
            'loaded_idle_2', 'unload_2_immediate', 'unload_2_settled_1s',
            'unload_2_settled_5s', 'unload_2_settled_15s', 'close', 'after_close'])
        self.assertEqual(sleeps, [1.1, 1, 4, 10, 1.1, 1, 4, 10])

    def test_load_guard_checks_one_minute_average(self):
        with patch('os.getloadavg', return_value=(9., 7., 6.)):
            with self.assertRaises(RequestError):
                ensure_low_load()
        with patch('os.getloadavg', return_value=(8., 9., 10.)):
            ensure_low_load()

    def test_measurement_is_temporary_resource_capped_existing_python(self):
        command = measurement_command()
        for option in ['--user', '--wait', '--pipe', '--collect',
                       '--property=MemoryMax=2G', '--property=MemorySwapMax=0',
                       '--property=CPUQuota=200%', '--property=Nice=19',
                       '--property=RuntimeMaxSec=300']:
            self.assertIn(option, command)
        self.assertTrue(any('bjs-544/venv-a/bin/python' in x for x in command))
        self.assertIn('--child', command)


class NativeCheckTests(unittest.TestCase):
    def test_native_sequence_compares_spike_then_checks_eight_frame_decode(self):
        from services.embedder.native_check import cases
        sequence = cases()
        self.assertEqual([name for name, _ in sequence], ['text_query', 'image', 'audio', 'video4s', 'video8s'])
        self.assertEqual(sequence[0][1]['role'], 'query')
        self.assertEqual(len(sequence[3][1]), 4)
        self.assertEqual(sequence[4][1]['input']['type'], 'video')
        self.assertEqual([name for name, _ in cases(video_only=True)], ['video4s', 'video8s'])
        self.assertEqual([name for name, _ in cases(eight_only=True)], ['video8s'])


if __name__ == '__main__':
    unittest.main()
