"""Real HTTP requests must cross the origin/Host boundary before any body read."""
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest

from framewright.server import Handler
from framewright.render import RenderHandler


class HTTPBoundaryTests(unittest.TestCase):
    def test_day_counts_include_offline_frames_and_count_raw_jpeg_pairs_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            day = root / '2026-01-01_camera'
            (day / 'raw').mkdir(parents=True)
            for name in ('pair.JPG', 'pair.DNG', 'jpeg.JPG', 'raw.DNG'):
                (day / 'raw' / name).write_bytes(b'synthetic')
            (day / 'store.json').write_text(json.dumps({'files': {
                'raw/offline.DNG': {'mtime': 1, 'size': 8},
                'raw/offline.JPG': {'mtime': 1, 'size': 8},
            }}))

            class TestHandler(Handler):
                pass

            TestHandler.root = root
            server = self.start(TestHandler)
            status, body = self.request(server, 'GET', '/api/shoots')
            self.assertEqual(status, 200)
            data = json.loads(body)
            self.assertEqual(data['shoots'], [day.name])
            self.assertEqual(data['shootCounts'], {day.name: 4})

    def start(self, handler):
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def request(self, server, method, path, body=None, headers=None):
        connection = HTTPConnection(*server.server_address, timeout=3)
        try:
            connection.request(method, path, body, headers or {})
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def test_import_rejects_remote_origin_host_and_simple_post_before_reading(self):
        with tempfile.TemporaryDirectory() as tmp:
            class TestHandler(Handler):
                root = Path(tmp)
                reads = []
                imports = []

                def read_body(self):
                    self.reads.append(True)
                    return super().read_body()

                def api_import(self, body):
                    self.imports.append(body)
                    self.send_json({"ok": True})

            server = self.start(TestHandler)
            host = f"127.0.0.1:{server.server_port}"
            body = json.dumps({"deleteFromCard": True})
            invalid = [
                ({"Origin": "https://untrusted.example", "Content-Type": "text/plain"}, 403),
                ({"Origin": "null", "Content-Type": "application/json"}, 403),
                ({"Origin": "http://127.0.0.1:1", "Content-Type": "application/json"}, 403),
                ({"Host": f"rebind.example:{server.server_port}", "Content-Type": "application/json"}, 403),
                ({"Host": "127.0.0.1:1", "Content-Type": "application/json"}, 403),
                ({"Content-Type": "text/plain"}, 415),
                ({}, 415),
                ({"Sec-Fetch-Site": "cross-site", "Content-Type": "application/json"}, 403),
            ]
            for headers, status in invalid:
                with self.subTest(headers=headers):
                    self.assertEqual(self.request(server, "POST", "/api/import", body, headers)[0], status)
                    self.assertEqual(TestHandler.reads, [])
                    self.assertEqual(TestHandler.imports, [])
            for headers in ({"Content-Type": "application/json"},
                            {"Origin": f"http://{host}", "Content-Type": "application/json; charset=utf-8"}):
                self.assertEqual(self.request(server, "POST", "/api/import", body, headers)[0], 200)
            self.assertEqual(len(TestHandler.imports), 2)
            self.assertEqual(self.request(server, "GET", "/api/shoots", headers={"Host": "rebind.example"})[0], 403)
            self.assertEqual(self.request(server, "GET", "/api/shoots", headers={"Origin": "https://untrusted.example"})[0], 403)
            self.assertEqual(self.request(server, "GET", "/api/shoots")[0], 200)

    def test_renderer_subclass_cannot_bypass_checks_and_jpeg_upload_still_works(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "result.jpg"
            class TestRenderer(RenderHandler):
                root = Path(tmp)
                jobs = [{"id": "0", "out": destination}]
                results = {}
                done = threading.Event()

            server = self.start(TestRenderer)
            blob = b"\xff\xd8\xffJPEG"
            headers = {"Content-Type": "image/jpeg", "Origin": "https://untrusted.example"}
            self.assertEqual(self.request(server, "POST", "/headless/result?id=0", blob, headers)[0], 403)
            self.assertFalse(destination.exists())
            self.assertEqual(TestRenderer.results, {})
            self.assertEqual(self.request(server, "GET", "/headless/jobs", headers={"Host": "rebind.example"})[0], 403)
            headers["Origin"] = f"http://127.0.0.1:{server.server_port}"
            self.assertEqual(self.request(server, "POST", "/headless/result?id=0", blob, headers)[0], 200)
            self.assertEqual(destination.read_bytes(), blob)

    def test_binary_and_error_content_types_are_explicit(self):
        class TestHandler(Handler):
            def do_POST(self):
                self.send_json({"ok": True})
        server = self.start(TestHandler)
        for endpoint, mime in (("/api/luts/install", "application/octet-stream"),
                               ("/api/export", "image/jpeg"),
                               ("/api/post-export", "image/jpeg"),
                               ("/headless/error", "text/plain")):
            self.assertEqual(self.request(server, "POST", endpoint, b"", {"Content-Type": mime})[0], 200)
            self.assertEqual(self.request(server, "POST", endpoint, b"", {"Content-Type": "application/json"})[0], 415)


if __name__ == "__main__":
    unittest.main()
