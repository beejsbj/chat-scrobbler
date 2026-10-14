"""Opt-in finite RSS experiment. Refuses high load or ineffective cgroup caps."""
import argparse
from dataclasses import replace
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import threading
import time

from .config import Config, SPIKE, MODEL_ID, MODEL_REVISION, MODEL_FILENAME
from .errors import RequestError
from .service import Embedder, current_rss_kib


def ensure_low_load():
    loads = os.getloadavg()
    if loads[0] > 8:
        raise RequestError(f'model measurement skipped: one-minute load {loads[0]} exceeds 8 (all averages: {loads})', 503)


def measurement_command():
    root = Path(__file__).resolve().parents[2]
    return ['systemd-run', '--user', '--wait', '--pipe', '--collect',
            '--property=MemoryMax=2G', '--property=MemorySwapMax=0',
            '--property=CPUQuota=200%', '--property=Nice=19',
            '--property=RuntimeMaxSec=300', '--property=TasksMax=32',
            '--property=NoNewPrivileges=yes', f'--working-directory={root}',
            str(SPIKE / 'venv-a/bin/python'), '-B', '-m', 'services.embedder.measure', '--child']


def cgroup_limits():
    entry = next(line for line in Path('/proc/self/cgroup').read_text().splitlines()
                 if line.startswith('0::'))
    directory = Path('/sys/fs/cgroup') / entry.split('::', 1)[1].lstrip('/')
    values = {name: (directory / name).read_text().strip()
              for name in ('memory.max', 'memory.swap.max', 'cpu.max', 'memory.current')}
    quota, period = values['cpu.max'].split()
    if (values['memory.max'] == 'max' or int(values['memory.max']) > 2 * 1024**3
            or values['memory.swap.max'] != '0' or quota == 'max'
            or int(quota) / int(period) > 2 or os.getpriority(os.PRIO_PROCESS, 0) < 19):
        raise RuntimeError('required memory, swap, CPU, and nice caps are not effective')
    return directory, values


def run_stages(service, request, sample, sleep=time.sleep):
    def idle_unload(cycle):
        sample(f'loaded_idle_{cycle}')
        sleep(1.1)
        if not service.unload_if_idle():
            raise RuntimeError('idle unload did not occur')
        sample(f'unload_{cycle}_immediate')
        settled = 0
        for delay in (1, 4, 10):
            sleep(delay)
            settled += delay
            sample(f'unload_{cycle}_settled_{settled}s')

    request('after_lazy_load_and_text', {'input': 'A loaf of sourdough bread.'})
    # Capture the explicit unload requirement before spending time on media.
    idle_unload(1)
    request('after_reload_and_text', {'input': 'Reload the same embedding engine.'})
    for kind, filename in [('image', 'image.png'), ('audio', 'speech.wav'), ('video', 'video_10s.mp4')]:
        request('after_' + kind, {'input': {'type': kind, 'path': str(SPIKE / 'inputs' / filename)}})
    idle_unload(2)
    service.close()
    sample('after_close')


def child():
    ensure_low_load()
    directory, limits = cgroup_limits()  # Verify before importing LiteRT.
    print(json.dumps({'stage': 'caps_verified', 'limits': limits}), flush=True)
    stop = threading.Event()
    def guard():
        while not stop.wait(.5):
            if os.getloadavg()[0] > 8:
                print(json.dumps({'stage': 'aborted_high_load', 'load': os.getloadavg(),
                                  'rss_kib': current_rss_kib()}), flush=True)
                os._exit(75)  # Kill native work as well; never leave a busy worker.
    watchdog = threading.Thread(target=guard, daemon=True)
    watchdog.start()
    config = replace(Config.from_env(), idle_seconds=1, allowed_roots=(SPIKE / 'inputs',),
                     model_path=SPIKE / 'hf/hub' / ('models--' + MODEL_ID.replace('/', '--'))
                     / 'snapshots' / MODEL_REVISION / MODEL_FILENAME,
                     cache_dir=SPIKE / 'litert-cache')
    service = Embedder(config)
    def sample(stage, **extra):
        print(json.dumps({'stage': stage, 'rss_kib': current_rss_kib(),
                          'peak_rss_kib': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                          'cgroup_bytes': int((directory / 'memory.current').read_text()),
                          'loaded': service.engine is not None, 'load': os.getloadavg(),
                          **extra}), flush=True)
    def factory():
        ensure_low_load()
        from .engine import LiteRTEngine
        started = time.monotonic()
        engine = LiteRTEngine(config)
        sample('after_native_load', loaded=True, elapsed_seconds=time.monotonic() - started)
        return engine
    service.factory = factory
    def request(stage, payload):
        ensure_low_load()
        start = time.monotonic()
        service.embeddings(payload)
        sample(stage, elapsed_seconds=time.monotonic() - start)
    try:
        if not service.model_available():
            raise RuntimeError('existing model/cache unavailable; no download attempted')
        sample('baseline_before_litert_import')
        run_stages(service, request, sample)
    finally:
        stop.set()
        service.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--child', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        ensure_low_load()
        if args.child:
            child()
            return 0
        return subprocess.run(measurement_command(), check=False, timeout=330).returncode
    except (RequestError, RuntimeError, OSError, subprocess.TimeoutExpired) as exc:
        print(json.dumps({'stage': 'not_measured', 'reason': str(exc)}), flush=True)
        return 75


if __name__ == '__main__':
    sys.exit(main())
