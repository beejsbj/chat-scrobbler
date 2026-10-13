import signal
import threading

from .config import Config
from .http_server import Server
from .service import Embedder


def main():
    service = Embedder(Config.from_env())
    with Server(service) as server:
        def stop(signum, frame):
            threading.Thread(target=server.shutdown, daemon=True).start()
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        try:
            server.serve_forever(poll_interval=.5)
        finally:
            # server_close drains handlers, then close native state under its lock.
            server.server_close()
            service.close()


if __name__ == '__main__':
    main()
