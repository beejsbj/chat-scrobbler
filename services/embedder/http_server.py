"""Loopback stdlib HTTP, bounded connections, bodies, queue, and read deadlines."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import socket
import threading
import time

from .errors import RequestError


def unique_object(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError('duplicate JSON field')
        obj[key] = value
    return obj


def invalid_constant(value):
    raise ValueError('invalid JSON constant')


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'ChatEmbedder/1'

    def setup(self):
        self.timeout = self.server.embedder.config.body_timeout
        super().setup()

    def log_message(self, format, *args):
        pass  # Do not log private content, file paths, or headers.

    def _reply(self, status, result):
        self.close_connection = True  # One request per connection bounds resources.
        body = json.dumps(result, allow_nan=False, separators=(',', ':')).encode()
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Connection', 'close')
            self.send_header('Cache-Control', 'no-store')
            if status in (429, 503):
                self.send_header('Retry-After', '5')
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass

    def _error(self, error):
        self._reply(error.status, {'error': {'message': str(error),
                                           'type': 'invalid_request_error' if error.status < 500 else 'server_error',
                                           'code': error.code}})

    def _check_origin(self):
        host = self.headers.get('Host', '').split(':')[0].lower()
        hosts = ('127.0.0.1', 'localhost', 'embedder') if self.server.embedder.config.network_mode == 'private-docker' else ('127.0.0.1', 'localhost')
        if host not in hosts or self.headers.get('Origin') is not None:
            raise RequestError('private service clients only', 403, 'forbidden')

    def do_GET(self):
        try:
            self._check_origin()
            if self.path != '/health':
                raise RequestError('not found', 404, 'not_found')
            self._reply(200, self.server.embedder.health())
        except RequestError as exc:
            self._error(exc)

    def _body(self):
        config = self.server.embedder.config
        if self.headers.get('Transfer-Encoding') is not None:
            raise RequestError('transfer encoding is unsupported')
        lengths = self.headers.get_all('Content-Length', [])
        if not lengths:
            raise RequestError('Content-Length required', 411)
        if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit():
            raise RequestError('invalid Content-Length')
        try:
            length = int(lengths[0])
        except ValueError as exc:
            raise RequestError('invalid Content-Length') from exc
        if length > config.max_body_bytes:
            raise RequestError('body exceeds byte limit', 413)
        if self.headers.get_content_type() != 'application/json':
            raise RequestError('Content-Type must be application/json', 415)
        deadline = time.monotonic() + config.body_timeout
        remaining, chunks = length, []
        while remaining:
            timeout = deadline - time.monotonic()
            if timeout <= 0:
                raise RequestError('body read timed out', 408, 'read_timeout')
            self.connection.settimeout(timeout)
            try:
                chunk = self.rfile.read1(min(remaining, 65536))
            except (TimeoutError, OSError) as exc:
                raise RequestError('body read timed out', 408, 'read_timeout') from exc
            if not chunk:
                raise RequestError('incomplete request body')
            chunks.append(chunk)
            remaining -= len(chunk)
        self.connection.settimeout(config.body_timeout)
        try:
            return json.loads(b''.join(chunks).decode('utf-8'), object_pairs_hook=unique_object,
                              parse_constant=invalid_constant)
        except (ValueError, UnicodeError, RecursionError) as exc:
            raise RequestError('body must be valid JSON') from exc

    def do_POST(self):
        try:
            self._check_origin()
            if self.path != '/v1/embeddings':
                raise RequestError('not found', 404, 'not_found')
            self._reply(200, self.server.embedder.embeddings(self._body()))
        except RequestError as exc:
            self._error(exc)

    def handle_expect_100(self):
        self._error(RequestError('Expect is unsupported', 417))
        return False


class Server(ThreadingHTTPServer):
    daemon_threads = False  # Shutdown drains work before closing the engine.
    request_queue_size = 8
    allow_reuse_address = True

    def __init__(self, embedder):
        self.embedder = embedder
        self.max_connections = embedder.config.queue_size + 4
        self.connections = threading.BoundedSemaphore(self.max_connections)
        self.connection_count = 0
        self.count_lock = threading.Lock()
        super().__init__((embedder.config.bind_host, embedder.config.port), Handler)

    def process_request(self, request, client_address):
        if not self.connections.acquire(blocking=False):
            try:
                request.settimeout(.1)
                body = b'{"error":{"message":"connection limit reached","code":"queue_full"}}'
                request.sendall(b'HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\n'
                                + f'Content-Length: {len(body)}\r\n'.encode()
                                + b'Connection: close\r\nRetry-After: 5\r\n\r\n' + body)
            except OSError:
                pass
            finally:
                self.shutdown_request(request)
            return
        with self.count_lock:
            self.connection_count += 1
        try:
            super().process_request(request, client_address)
        except Exception:
            self._release_connection()
            raise

    def _release_connection(self):
        with self.count_lock:
            self.connection_count -= 1
        self.connections.release()

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._release_connection()

    def service_actions(self):
        self.embedder.unload_if_idle()
