import base64
import http.client
import json
import socket
import struct
import threading
import time
import unittest
from unittest.mock import patch
from dataclasses import replace

from services.embedder.config import Config
from services.embedder.http_server import Server
from services.embedder.service import Embedder
from test_service import FakeEngine


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.engine = FakeEngine()
        self.service = Embedder(replace(Config(), port=0, body_timeout=.3), lambda: self.engine)
        self.server = Server(self.service)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.service.close()
        self.thread.join(2)

    def request(self, method, path, payload=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        body = None if payload is None else json.dumps(payload)
        conn.request(method, path, body=body,
                     headers={'Content-Type': 'application/json', **(headers or {})})
        resp = conn.getresponse()
        result = (resp.status, json.loads(resp.read()))
        conn.close()
        return result

    def test_health_and_openai_shape(self):
        status, health = self.request('GET', '/health')
        self.assertEqual(status, 200)
        self.assertFalse(health['loaded'])
        self.assertIsInstance(health['model_available'], bool)
        self.assertEqual(health['model'], 'litert-community/embeddinggemma-2-740m-litert-lm')
        status, result = self.request('POST', '/v1/embeddings',
                                      {'model': 'litert-community/embeddinggemma-2-740m-litert-lm', 'input': 'bread'})
        self.assertEqual(status, 200)
        self.assertEqual(len(result['data'][0]['embedding']), 768)
        self.assertEqual(self.engine.calls, ['title: none | text: bread'])

    def test_base64_encoding(self):
        status, result = self.request('POST', '/v1/embeddings',
                                      {'input': 'bread', 'dimensions': 128, 'encoding_format': 'base64'})
        self.assertEqual(status, 200)
        vector = struct.unpack('<128f', base64.b64decode(result['data'][0]['embedding']))
        self.assertAlmostEqual(sum(x*x for x in vector), 1, places=6)

    def test_bad_routes_content_type_invalid_json_and_limits(self):
        self.assertEqual(self.request('GET', '/other')[0], 404)
        self.assertEqual(self.request('POST', '/other', {})[0], 404)
        self.assertEqual(self.request('POST', '/v1/embeddings', {'input': 'a'},
                                      {'Content-Type': 'text/plain'})[0], 415)
        for headers, body, expected in [
            (b'Content-Length: 999999999\r\n', b'', 413),
            (b'Transfer-Encoding: chunked\r\n', b'', 400),
            (b'Content-Length: 1\r\n', b'{', 400),
            (b'Content-Length: 1\r\nContent-Length: 1\r\n', b'{', 400),
            (b'', b'', 411),
        ]:
            with socket.create_connection(('127.0.0.1', self.port), timeout=3) as s:
                s.sendall(b'POST /v1/embeddings HTTP/1.1\r\nHost: localhost\r\n'
                          b'Content-Type: application/json\r\n' + headers + b'\r\n' + body)
                response = s.recv(4096)
                self.assertIn(f' {expected} '.encode(), response)
        self.assertEqual(self.engine.calls, [])

    def test_private_docker_host_requires_explicit_mode(self):
        headers = {'Host': 'embedder:4320'}
        self.assertEqual(self.request('GET', '/health', headers=headers)[0], 403)
        self.service.config = replace(self.service.config, network_mode='private-docker')
        self.assertEqual(self.request('GET', '/health', headers=headers)[0], 200)
        self.assertEqual(self.request('GET', '/health', headers={'Host': 'attacker.example'})[0], 403)
        self.assertEqual(self.request('GET', '/health', headers={'Origin': 'https://example.com'})[0], 403)

    def test_slow_body_times_out(self):
        with socket.create_connection(('127.0.0.1', self.port), timeout=3) as s:
            s.sendall(b'POST /v1/embeddings HTTP/1.1\r\nHost: localhost\r\n'
                      b'Content-Type: application/json\r\nContent-Length: 30\r\n\r\n{')
            self.assertIn(b' 408 ', s.recv(4096))

    def test_disconnect_does_not_release_engine_or_block_health(self):
        entered, release = threading.Event(), threading.Event()
        active, peak = [0], [0]
        def blocked(content):
            active[0] += 1
            peak[0] = max(peak[0], active[0])
            entered.set()
            release.wait(3)
            active[0] -= 1
            return [1.] * 768
        self.engine.embed = blocked
        body = b'{"input":"first"}'
        s = socket.create_connection(('127.0.0.1', self.port), timeout=3)
        s.sendall(b'POST /v1/embeddings HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n'
                  + f'Content-Length: {len(body)}\r\n\r\n'.encode() + body)
        self.assertTrue(entered.wait(1))
        s.close()
        status, health = self.request('GET', '/health')
        self.assertEqual(status, 200)
        self.assertTrue(health['busy'])
        results = []
        worker = threading.Thread(target=lambda: results.append(
            self.request('POST', '/v1/embeddings', {'input': 'second'})))
        worker.start()
        release.set()
        worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(results[0][0], 200)
        self.assertEqual(peak[0], 1)

    def test_hung_health_is_503_and_watchdog_exits_for_container_restart(self):
        now = [10.]
        self.service.clock = lambda: now[0]
        exited = threading.Event()
        with patch('services.embedder.http_server.os._exit', side_effect=lambda code: exited.set()) as terminate:
            try:
                self.service.work_started = 10.
                now[0] = 131.
                status, health = self.request('GET', '/health')
                self.assertEqual(status, 503)
                self.assertEqual(health['status'], 'hung')
                self.assertTrue(exited.wait(2))
                terminate.assert_called_once_with(70)
            finally:
                self.service.work_started = None

    def test_watchdog_detects_idle_close_hang_while_poll_thread_is_blocked(self):
        entered, release, exited = threading.Event(), threading.Event(), threading.Event()
        now = [10.]
        self.service.clock = lambda: now[0]
        self.service.config = replace(self.service.config, idle_seconds=1)
        self.request('POST', '/v1/embeddings', {'input': 'load'})
        def blocked_close():
            entered.set()
            release.wait(4)
        self.engine.close = blocked_close
        with patch('services.embedder.http_server.os._exit', side_effect=lambda code: exited.set()) as terminate:
            try:
                now[0] = 12.
                self.assertTrue(entered.wait(2))
                now[0] = 133.
                self.assertTrue(exited.wait(1.5))
                terminate.assert_called_once_with(70)
            finally:
                release.set()

    def test_server_close_stops_and_joins_watchdog(self):
        self.server.shutdown()
        self.server.server_close()
        self.assertFalse(self.server.watchdog_thread.is_alive())

    def test_connection_slots_bounded_before_body_reads(self):
        sockets = [socket.create_connection(('127.0.0.1', self.port), timeout=3)
                   for _ in range(self.server.max_connections)]
        try:
            # Establish receipt of all connections without completing their headers.
            for s in sockets:
                s.sendall(b'POST /v1/embeddings HTTP/1.1\r\n')
            deadline = time.monotonic() + 1
            while self.server.connection_count < self.server.max_connections and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertEqual(self.server.connection_count, self.server.max_connections)
            with socket.create_connection(('127.0.0.1', self.port), timeout=3) as extra:
                extra.sendall(b'GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n')
                self.assertIn(b' 429 ', extra.recv(4096))
        finally:
            for s in sockets:
                s.close()


if __name__ == '__main__':
    unittest.main()
