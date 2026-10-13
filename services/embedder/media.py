"""Bounded local media snapshots and ffmpeg conversion. No URL inputs."""
import base64
import binascii
from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import stat
import subprocess
import time
import wave

from .errors import RequestError

# Exclude playlists and indirect demuxers that can read other files or URLs.
FORMATS = 'png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,wav,mp3,flac,ogg,mov,matroska,webm,avi,aac'


@dataclass(frozen=True)
class MediaPart:
    kind: str
    path: Path


def validate_media(item, config):
    if item.get('type') not in ('image', 'audio', 'video'):
        raise RequestError('media type must be image, audio, or video')
    if set(item) - {'type', 'path', 'base64', 'role'}:
        raise RequestError('unsupported media fields')
    if ('path' in item) == ('base64' in item):
        raise RequestError('media needs exactly one of path or base64')
    key = 'path' if 'path' in item else 'base64'
    if not isinstance(item[key], str) or not item[key]:
        raise RequestError('media source must be a nonempty string')
    if key == 'path' and (len(item[key]) > 4096 or '\x00' in item[key]):
        raise RequestError('invalid media path')
    if key == 'base64' and len(item[key]) > 4 * math.ceil(config.max_file_bytes / 3):
        raise RequestError('media exceeds byte limit', 413)


def sample_times(duration, max_frames):
    count = min(max_frames, max(1, math.ceil(duration)))
    # Include the first frame and a frame in the final tenth, never seek at EOF.
    return [0.] if count == 1 else [duration * .9 * i / (count - 1) for i in range(count)]


class Decoder:
    def __init__(self, config):
        self.config = config

    def _open_allowed(self, name):
        """Resolve symlinks, then walk with no-follow fds to resist replacement."""
        try:
            resolved = Path(name).resolve(strict=True)
            for root in self.config.allowed_roots:
                root = Path(root)  # Pinned at startup, never follow a replacement root symlink.
                if resolved.is_relative_to(root):
                    relative = resolved.relative_to(root)
                    break
            else:
                raise RequestError('path is outside allowed roots')
            if not relative.parts:
                raise RequestError('path must be a regular file')
            # Walk from / as well: an allowed-root ancestor cannot be swapped.
            fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
            try:
                for component in resolved.parts[1:-1]:
                    next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    os.close(fd)
                    fd = next_fd
                source = os.open(resolved.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            finally:
                os.close(fd)
            if not stat.S_ISREG(os.fstat(source).st_mode):
                os.close(source)
                raise RequestError('path must be a regular file')
            return os.fdopen(source, 'rb')
        except (OSError, RuntimeError, ValueError) as exc:
            raise RequestError('media path cannot be read safely') from exc

    def snapshot(self, item, directory):
        validate_media(item, self.config)
        target = directory / 'source.bin'
        if 'path' in item:
            with self._open_allowed(item['path']) as source:
                if os.fstat(source.fileno()).st_size > self.config.max_file_bytes:
                    raise RequestError('media exceeds byte limit', 413)
                with target.open('wb') as output:
                    copied = 0
                    while chunk := source.read(min(65536, self.config.max_file_bytes - copied + 1)):
                        copied += len(chunk)
                        if copied > self.config.max_file_bytes:
                            raise RequestError('media exceeds byte limit', 413)
                        output.write(chunk)
        else:
            try:
                value = base64.b64decode(item['base64'], validate=True)
            except (ValueError, binascii.Error) as exc:
                raise RequestError('invalid media base64') from exc
            if not value or len(value) > self.config.max_file_bytes:
                raise RequestError('media is empty or exceeds byte limit', 413)
            target.write_bytes(value)
        if target.stat().st_size == 0:
            raise RequestError('empty media')
        return target

    def _run(self, args, deadline, stdout=subprocess.DEVNULL):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RequestError('media decode timed out', 422, 'decode_timeout')
        try:
            subprocess.run(args, check=True, timeout=remaining, stdin=subprocess.DEVNULL,
                           stdout=stdout, stderr=subprocess.DEVNULL)
        except subprocess.TimeoutExpired as exc:
            raise RequestError('media decode timed out', 422, 'decode_timeout') from exc
        except (OSError, subprocess.CalledProcessError) as exc:
            raise RequestError('invalid or unsupported media', 422, 'decode_error') from exc

    def _probe(self, source, kind, directory, deadline):
        target = directory / 'probe.json'
        selector = 'a:0' if kind == 'audio' else 'v:0'
        with target.open('wb') as output:
            self._run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file',
                       '-format_whitelist', FORMATS, '-select_streams', selector,
                       '-show_entries', 'stream=width,height,codec_type,duration:format=duration',
                       '-of', 'json', str(source)], deadline, output)
        try:
            if target.stat().st_size > 65536:
                raise ValueError('oversize probe')
            probe = json.loads(target.read_text())
            stream = probe['streams'][0]
            if kind != 'audio':
                w, h = int(stream['width']), int(stream['height'])
                if (min(w, h) < 1 or max(w, h) > self.config.max_source_side
                        or w * h > self.config.max_source_pixels):
                    raise RequestError('source image dimensions exceed limit', 413)
            if kind == 'image':
                return None
            value = stream.get('duration', probe.get('format', {}).get('duration'))
            if value == 'N/A':
                value = probe.get('format', {}).get('duration')
            duration = float(value)
            cap = self.config.max_audio_seconds if kind == 'audio' else self.config.max_video_seconds
            if not math.isfinite(duration) or duration <= 0:
                raise ValueError('invalid duration')
            if duration > cap:
                raise RequestError('media duration exceeds limit', 413)
            return duration
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise RequestError('media requires a valid stream and finite duration', 422) from exc

    def _convert(self, source, target, deadline, *, audio=False, timestamp=None):
        args = ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-threads', '2',
                '-filter_threads', '2', '-protocol_whitelist', 'file', '-format_whitelist', FORMATS]
        if timestamp is not None:
            args += ['-ss', f'{timestamp:.6f}']
        args += ['-i', str(source)]
        if audio:
            args += ['-map', '0:a:0', '-vn', '-t', str(self.config.max_audio_seconds + .05),
                     '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le']
        else:
            side = self.config.max_image_side
            args += ['-map', '0:v:0', '-an', '-frames:v', '1', '-vf',
                     f'scale=w=min({side}\\,iw):h=min({side}\\,ih):force_original_aspect_ratio=decrease',
                     '-c:v', 'png']
        args += ['-threads', '2', '-fs', str(self.config.max_file_bytes), str(target)]
        self._run(args, deadline)
        if not target.is_file() or not 0 < target.stat().st_size <= self.config.max_file_bytes:
            raise RequestError('media decode produced no bounded output', 422)

    def prepare(self, item, directory):
        deadline = time.monotonic() + self.config.decode_timeout
        source = self.snapshot(item, directory)
        kind = item['type']
        duration = self._probe(source, kind, directory, deadline)
        if kind == 'audio':
            target = directory / 'audio.wav'
            self._convert(source, target, deadline, audio=True)
            with wave.open(str(target)) as audio:
                if (audio.getnframes() / 16000 > self.config.max_audio_seconds
                        or audio.getnframes() == 0 or audio.getnchannels() != 1
                        or audio.getframerate() != 16000):
                    raise RequestError('decoded audio exceeds duration limit', 413)
            return [MediaPart('audio', target)]
        times = sample_times(duration, self.config.max_frames) if kind == 'video' else [None]
        parts = []
        for index, timestamp in enumerate(times):
            target = directory / f'frame-{index}.png'
            self._convert(source, target, deadline, timestamp=timestamp)
            parts.append(MediaPart('image', target))
        return parts
