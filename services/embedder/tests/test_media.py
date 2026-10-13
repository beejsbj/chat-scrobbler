import base64
import json
import shutil
import subprocess
import tempfile
import unittest
import wave
from dataclasses import replace
from pathlib import Path

from services.embedder.config import Config
from services.embedder.errors import RequestError
from services.embedder.media import Decoder, sample_times


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.allowed = self.root / 'allowed'
        self.allowed.mkdir()
        self.work = self.root / 'decoded'
        self.work.mkdir()
        self.decoder = Decoder(Config(allowed_roots=(self.allowed,)))

    def tearDown(self):
        self.temp.cleanup()

    def test_paths_traversal_symlinks_and_nonfiles(self):
        outside = self.root / 'secret'
        outside.write_bytes(b'private')
        (self.allowed / 'escape').symlink_to(outside)
        for path in [outside, self.allowed / '../secret', self.allowed / 'escape', self.allowed]:
            with self.subTest(path=path), self.assertRaises(RequestError):
                self.decoder.snapshot({'type': 'image', 'path': str(path)}, self.work)
        inside = self.allowed / 'ok'
        inside.write_bytes(b'ok')
        (self.allowed / 'alias').symlink_to(inside)
        copy = self.decoder.snapshot({'type': 'image', 'path': str(self.allowed / 'alias')}, self.work)
        self.assertEqual(copy.read_bytes(), b'ok')
        self.assertNotEqual(copy, inside)

    def test_replaced_allowed_root_is_not_trusted(self):
        secret = self.root / 'secret'
        secret.write_bytes(b'private')
        self.allowed.rename(self.root / 'previous-root')
        self.allowed.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(RequestError):
            self.decoder.snapshot({'type': 'image', 'path': str(secret)}, self.work)

    def test_body_file_and_base64_bounds(self):
        self.decoder = Decoder(replace(self.decoder.config, max_file_bytes=4))
        for value in ['!', 'eHh4eHg=', '']:
            with self.assertRaises(RequestError):
                self.decoder.snapshot({'type': 'image', 'base64': value}, self.work)
        p = self.allowed / 'big'
        p.write_bytes(b'12345')
        with self.assertRaises(RequestError):
            self.decoder.snapshot({'type': 'image', 'path': str(p)}, self.work)
        with self.assertRaises(RequestError):
            Decoder(Config()).snapshot({'type': 'image', 'path': str(p)}, self.work)

    def test_frame_times_cover_duration_and_are_bounded(self):
        for duration in [.1, 1, 3, 30, 300]:
            ts = sample_times(duration, 8)
            self.assertLessEqual(len(ts), 8)
            self.assertEqual(ts[0], 0)
            self.assertTrue(all(0 <= x < duration for x in ts))
            if len(ts) > 1:
                self.assertGreaterEqual(ts[-1], duration * .9)
        self.assertEqual(len(sample_times(300, 8)), 8)

    def ffmpeg(self, *args):
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-threads', '1',
                        '-filter_threads', '1', '-y', *args], check=True, timeout=15,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg required')
    def test_synthetic_image_audio_video_decode(self):
        image = self.allowed / 'image.png'
        self.ffmpeg('-f', 'lavfi', '-i', 'color=c=red:s=1200x900', '-frames:v', '1',
                    '-threads', '1', str(image))
        parts = self.decoder.prepare({'type': 'image', 'base64':
                                     base64.b64encode(image.read_bytes()).decode()}, self.work)
        probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams',
                                                    '-of', 'json', str(parts[0].path)]))
        self.assertEqual(parts[0].kind, 'image')
        self.assertEqual(probe['streams'][0]['width'], 768)
        self.assertEqual(probe['streams'][0]['height'], 576)
        audio = self.allowed / 'audio.wav'
        self.ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', '-ac', '2',
                    '-ar', '48000', str(audio))
        parts = self.decoder.prepare({'type': 'audio', 'path': str(audio)}, self.work)
        with wave.open(str(parts[0].path)) as w:
            self.assertEqual((w.getframerate(), w.getnchannels(), w.getsampwidth()), (16000, 1, 2))
        video = self.allowed / 'video.mkv'
        self.ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=96x64:r=10:d=3', '-c:v', 'ffv1',
                    '-threads', '1', str(video))
        parts = self.decoder.prepare({'type': 'video', 'path': str(video)}, self.work)
        self.assertEqual(len(parts), 3)
        self.assertTrue(all(p.kind == 'image' and p.path.is_file() for p in parts))
        self.assertNotEqual(parts[0].path.read_bytes(), parts[-1].path.read_bytes())

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg required')
    def test_duration_dimension_and_playlist_rejection(self):
        audio = self.allowed / 'audio.wav'
        self.ffmpeg('-f', 'lavfi', '-i', 'sine=duration=0.3', str(audio))
        decoder = Decoder(replace(self.decoder.config, max_audio_seconds=.1))
        with self.assertRaises(RequestError):
            decoder.prepare({'type': 'audio', 'path': str(audio)}, self.work)
        image = self.allowed / 'image.png'
        self.ffmpeg('-f', 'lavfi', '-i', 'color=s=96x64', '-frames:v', '1', '-threads', '1', str(image))
        decoder = Decoder(replace(self.decoder.config, max_source_side=32))
        with self.assertRaises(RequestError):
            decoder.prepare({'type': 'image', 'path': str(image)}, self.work)
        playlist = self.allowed / 'list.m3u8'
        playlist.write_text('#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n')
        with self.assertRaises(RequestError):
            self.decoder.prepare({'type': 'audio', 'path': str(playlist)}, self.work)


if __name__ == '__main__':
    unittest.main()
