"""Finite test server. Uses no model, archived input, or production paths."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from services.embedder.config import Config
from services.embedder.service import Embedder
from services.embedder.http_server import Server

class Engine:
    def embed(self, content):
        return [1.] + [0.] * 767
    def close(self):
        pass

service = Embedder(Config(port=0, model_path=Path('/nonexistent-synthetic-model')), Engine)
with Server(service) as server:
    print(server.server_port, flush=True)
    try:
        server.serve_forever(poll_interval=.1)
    finally:
        service.close()
