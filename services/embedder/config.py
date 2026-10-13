from dataclasses import dataclass
from pathlib import Path
import os

MODEL_ID = 'litert-community/embeddinggemma-2-740m-litert-lm'
SPIKE = Path('/mnt/server-ssd/spikes/bjs-544')
MODEL = SPIKE / ('hf/hub/models--litert-community--embeddinggemma-2-740m-litert-lm/'
                 'snapshots/24d962e906c7d332c6428e71c9676855024569e2/'
                 'embeddinggemma-2-740m.litertlm')


@dataclass(frozen=True)
class Config:
    model_path: Path = MODEL
    cache_dir: Path = SPIKE / 'litert-cache'
    allowed_roots: tuple = ()  # Deny path inputs until explicitly configured.
    network_mode: str = 'loopback'
    port: int = 4320
    idle_seconds: float = 300
    queue_size: int = 2
    queue_timeout: float = 110
    body_timeout: float = 15
    max_body_bytes: int = 8 * 1024 * 1024
    max_file_bytes: int = 16 * 1024 * 1024
    max_batch: int = 8
    max_text_bytes: int = 64 * 1024
    chunk_bytes: int = 1800  # UTF-8 byte ceiling, not a claimed tokenizer count.
    max_chunks: int = 128
    max_input_length: int = 2048
    max_audio_seconds: float = 30
    max_video_seconds: float = 300
    max_frames: int = 8
    max_image_side: int = 768
    max_source_side: int = 8192
    max_source_pixels: int = 32 * 1024 * 1024
    decode_timeout: float = 30

    @classmethod
    def from_env(cls):
        return cls(
            model_path=Path(os.environ.get('EMBEDDER_MODEL_PATH', str(MODEL))),
            cache_dir=Path(os.environ.get('EMBEDDER_CACHE_DIR', str(SPIKE / 'litert-cache'))),
            allowed_roots=tuple(Path(p).resolve(strict=True) for p in
                                os.environ.get('EMBEDDER_ALLOWED_ROOTS', '').split(os.pathsep) if p),
            network_mode=os.environ.get('EMBEDDER_NETWORK_MODE', 'loopback'),
            port=int(os.environ.get('EMBEDDER_PORT', '4320')),
            idle_seconds=float(os.environ.get('EMBEDDER_IDLE_SECONDS', '300')),
        )

    @property
    def bind_host(self):
        return '0.0.0.0' if self.network_mode == 'private-docker' else '127.0.0.1'

    def __post_init__(self):
        roots = tuple(Path(root).resolve(strict=True) for root in self.allowed_roots)
        if any(not root.is_dir() for root in roots):
            raise ValueError('allowed roots must be existing directories')
        object.__setattr__(self, 'allowed_roots', roots)
        if self.network_mode not in ('loopback', 'private-docker'):
            raise ValueError('network mode must be loopback or private-docker')
        if not 0 <= self.port <= 65535 or self.idle_seconds <= 0:
            raise ValueError('invalid port or idle timeout')
        if not 0 <= self.queue_size <= 8 or self.queue_timeout <= 0:
            raise ValueError('invalid queue configuration')
        if not 1 <= self.max_frames <= 8 or not 1 <= self.max_image_side <= 768:
            raise ValueError('invalid media budget')
        if not 64 <= self.chunk_bytes <= 1800 or self.max_input_length != 2048:
            raise ValueError('invalid text budget')
