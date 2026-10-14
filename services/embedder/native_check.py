"""One finite native parity/RSS run, using only existing synthetic spike data."""
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import threading
import time
from dataclasses import replace

from .config import Config, SPIKE, MODEL_ID, MODEL_REVISION, MODEL_FILENAME
from .errors import RequestError
from .measure import ensure_low_load, cgroup_limits, measurement_command
from .media import MediaPart
from .service import Embedder, current_rss_kib


def cases(video_only=False, eight_only=False):
    inputs = SPIKE / 'inputs'
    sequence = [
        ('text_query', {'input': 'how do I bake bread with a starter', 'role': 'query'}),
        ('image', {'input': {'type': 'image', 'path': str(inputs / 'image.png')}}),
        ('audio', {'input': {'type': 'audio', 'path': str(inputs / 'speech.wav')}}),
        # Exact four original frames permit a like-for-like spike NPZ comparison.
        ('video4s', [MediaPart('image', inputs / 'frames4' / f'f{i:02d}.png') for i in range(1, 5)]),
        ('video8s', {'input': {'type': 'video', 'path': str(inputs / 'video_10s.mp4')}}),
    ]
    return sequence[-1:] if eight_only else sequence[3:] if video_only else sequence


def probe_config():
    # Keep the historical eight-frame experiment explicit as service defaults change.
    return replace(Config(), idle_seconds=1, max_frames=8,
                   model_path=SPIKE / 'hf/hub' / ('models--' + MODEL_ID.replace('/', '--'))
                   / 'snapshots' / MODEL_REVISION / MODEL_FILENAME,
                   cache_dir=SPIKE / 'litert-cache', allowed_roots=(SPIKE / 'inputs',))


def child(video_only=False, eight_only=False):
    ensure_low_load()
    directory, limits = cgroup_limits()
    print(json.dumps({'stage': 'caps_verified', 'limits': limits}), flush=True)
    stop = threading.Event()
    def guard():
        while not stop.wait(.25):
            if os.getloadavg()[0] > 8:
                print(json.dumps({'stage': 'aborted_high_load', 'load': os.getloadavg(),
                                  'rss_kib': current_rss_kib()}), flush=True)
                os._exit(75)
    threading.Thread(target=guard, daemon=True).start()
    config = probe_config()
    service = Embedder(config)
    def sample(stage, **extra):
        print(json.dumps({'stage': stage, 'rss_kib': current_rss_kib(),
                          'peak_rss_kib': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                          'cgroup_bytes': int((directory / 'memory.current').read_text()),
                          'cgroup_peak_bytes': int((directory / 'memory.peak').read_text()),
                          'loaded': service.engine is not None, 'load': os.getloadavg(),
                          **extra}), flush=True)
    try:
        if not service.model_available():
            raise RuntimeError('cached pinned model/runtime unavailable; no fetch attempted')
        sample('baseline_before_native')
        import numpy as np
        references = {}
        for filename in ('vec_a_a_text.npz', 'vec_a_a_media.npz'):
            with np.load(SPIKE / 'out' / filename) as vectors:
                references.update({name: vectors[name] for name in vectors.files})
        for name, payload in cases(video_only=video_only, eight_only=eight_only):
            ensure_low_load()
            started = time.monotonic()
            if isinstance(payload, list):
                # Same engine as the service, held under its sole inference lock.
                with service.lock:
                    if service.engine is None:
                        service.engine = service._native_call(service.factory)
                    vector = service._native_call(service.engine.embed, payload)
            else:
                vector = service.embeddings(payload)['data'][0]['embedding']
            vector = np.asarray(vector, dtype=np.float32)
            if vector.shape != (768,) or not np.isfinite(vector).all() or abs(np.linalg.norm(vector) - 1) > .001:
                raise RuntimeError(f'{name} returned an invalid vector')
            extra = {'elapsed_seconds': time.monotonic() - started,
                     'dimensions': len(vector), 'finite': bool(np.isfinite(vector).all()),
                     'norm': float(np.linalg.norm(vector))}
            if name in references:
                ref = references[name]
                cosine = float(np.dot(vector, ref) / (np.linalg.norm(vector) * np.linalg.norm(ref)))
                extra['cosine_to_spike'] = cosine
                extra['max_abs_delta_to_spike'] = float(np.max(np.abs(vector - ref)))
                if cosine < .999:
                    raise RuntimeError(f'{name} parity below .999: {cosine}')
            if name == 'video8s':
                extra['frames'] = config.max_frames
                extra['near_2g_limit'] = int((directory / 'memory.peak').read_text()) >= int(1.8 * 1024**3)
            sample(name, **extra)
        time.sleep(1.1)
        if not service.unload_if_idle():
            raise RuntimeError('idle close did not occur')
        sample('media_unload_immediate')
        for delay in (1, 4, 10):
            time.sleep(delay)
            sample(f'media_unload_settle_{delay}s')
        sample('complete')
    finally:
        stop.set()
        service.close()


def main():
    try:
        ensure_low_load()
        if '--child' in sys.argv:
            child(video_only='--video-only' in sys.argv, eight_only='--eight-only' in sys.argv)
            return 0
        command = measurement_command()
        command[command.index('services.embedder.measure')] = 'services.embedder.native_check'
        for option in ('--video-only', '--eight-only'):
            if option in sys.argv:
                command.append(option)
        return subprocess.run(command, check=False, timeout=330).returncode
    except (RequestError, RuntimeError, OSError, subprocess.TimeoutExpired) as exc:
        print(json.dumps({'stage': 'not_measured', 'reason': str(exc)}), flush=True)
        return 75


if __name__ == '__main__':
    sys.exit(main())
