"""Synthetic JPEG marker streams test fallback selection without bundled photos."""
from pathlib import Path
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from framewright import previews
from framewright import server as studio


def jpeg(payload=b"pixels"):
    # SOI, baseline SOF with 1x1 dimensions, SOS, entropy bytes, EOI.
    return (b"\xff\xd8\xff\xc0\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00"
            b"\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00" + payload + b"\xff\xd9")


class PreviewTests(unittest.TestCase):
    def test_largest_complete_embedded_preview(self):
        small, large = jpeg(), jpeg(b"longer image" * 20)
        self.assertEqual(previews.embedded_jpeg(b"RAW" + small + b"metadata" + large + b"tail"), large)
        self.assertEqual(previews.embedded_jpeg(large + jpeg()[:-2]), large)
        with self.assertRaises(ValueError):
            previews.embedded_jpeg(b"no JPEG here")
        with self.assertRaises(ValueError):
            previews.embedded_jpeg(b"\xff\xd8\xff\xd9")

    def test_entropy_stuffing_and_restart_markers(self):
        data = jpeg(b"a\xff\x00b\xff\xd0c")
        self.assertEqual(previews.embedded_jpeg(data), data)

    def test_without_image_tools_jpeg_is_served_and_raw_preview_is_cached(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(studio.shutil, "which", return_value=None):
            root = Path(tmp)
            (root / "raw").mkdir()
            camera = root / "raw/frame.JPG"
            camera.write_bytes(jpeg())
            self.assertEqual(studio.preview(camera, root), camera)
            self.assertEqual(studio.thumb(camera, root), camera)
            raw = root / "raw/raw-only.NEF"
            raw.write_bytes(b"RAW" + jpeg())
            cached = studio.preview(raw, root)
            self.assertEqual(cached.read_bytes(), jpeg())
            self.assertEqual(studio.thumb(raw, root), cached)

    def test_packaged_server_delivers_fallback_previews_without_tools(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(studio.shutil, "which", return_value=None):
            root = Path(tmp)
            raw = root / "shoot/raw"
            raw.mkdir(parents=True)
            (raw / "frame.NEF").write_bytes(b"RAW" + jpeg())

            class Handler(studio.Handler):
                def log_message(self, *_):
                    pass

            Handler.root = root
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            connection = HTTPConnection(*server.server_address)
            try:
                for kind in ("preview", "thumb"):
                    connection.request("GET", f"/{kind}/shoot/frame.jpg")
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.getheader("Content-Type"), "image/jpeg")
                    self.assertEqual(response.read(), jpeg())
            finally:
                connection.close()
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
