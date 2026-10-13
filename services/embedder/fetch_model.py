"""Build-time pinned model fetch. The serving process never downloads weights."""
import hashlib
from pathlib import Path
import tempfile
import urllib.request

from .config import MODEL, MODEL_ID, MODEL_REVISION, MODEL_FILENAME

MODEL_URL = f'https://huggingface.co/{MODEL_ID}/resolve/{MODEL_REVISION}/{MODEL_FILENAME}'
MODEL_SHA256 = 'e7a8a2204b91e0f96e92960e84a09a89212e1633dcb7575a9bf3378b4df77f4c'


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def fetch_model(target=MODEL, *, expected=MODEL_SHA256):
    target = Path(target)
    if target.is_file() and digest(target) == expected:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as output:
            temporary = Path(output.name)
            with urllib.request.urlopen(MODEL_URL, timeout=120) as response:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
        if digest(temporary) != expected:
            raise ValueError('pinned model SHA-256 mismatch')
        temporary.chmod(0o444)
        temporary.replace(target)
        return target
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    fetch_model()
