"""Settings precedence and the first-run HTTP flow use isolated folders."""
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from framewright import settings
from framewright import server as studio


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.config = self.base / "settings" / "config.json"
        self.env = patch.dict(os.environ, {"STUDIO_CONFIG": str(self.config)}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def write_config(self, data):
        self.config.parent.mkdir(exist_ok=True)
        self.config.write_text(json.dumps(data))

    def test_no_config_has_no_library_or_store_and_does_not_write(self):
        self.assertIsNone(settings.resolve_library())
        self.assertIsNone(settings.configured_store())
        self.assertEqual(settings.configured_port(), 8765)
        self.assertFalse(self.config.exists())

    def test_library_precedence_and_config_relative_paths(self):
        self.write_config({"library": "photos"})
        self.assertEqual(settings.resolve_library(), self.config.parent / "photos")
        with patch.dict(os.environ, {"STUDIO_LIBRARY": str(self.base / "environment")}):
            self.assertEqual(settings.resolve_library(), self.base / "environment")
            self.assertEqual(settings.resolve_library(self.base / "cli"), self.base / "cli")

    def test_configured_store_and_legacy_override(self):
        self.write_config({"store": "store"})
        self.assertEqual(settings.configured_store(), self.config.parent / "store")
        with patch.dict(os.environ, {"PHOTO_STORE": str(self.base / "legacy")}):
            self.assertEqual(settings.configured_store(), self.base / "legacy")
            with patch.dict(os.environ, {"STUDIO_STORE": str(self.base / "current")}):
                self.assertEqual(settings.configured_store(), self.base / "current")

    def test_lut_order(self):
        self.write_config({"luts": ["custom", "extra"]})
        user = self.base / "user"
        with patch.object(settings, "user_lut_directory", return_value=user), patch.dict(os.environ, {
            "STUDIO_LUTS": os.pathsep.join([str(self.base / "env"), str(self.base / "env2")])
        }):
            self.assertEqual(settings.lut_directories(self.base / "library"), [
                self.base / "env", self.base / "env2", self.config.parent / "custom",
                self.config.parent / "extra", user, self.base / "library/luts",
            ])

    def test_malformed_config_reports_error(self):
        for config in ([], {"library": 1}, {"store": ""}, {"luts": [2]}, {"port": True}, {"port": 70000}):
            self.write_config(config)
            with self.assertRaises(ValueError):
                settings.load_config()

    def test_port_and_saved_choice_preserve_other_settings(self):
        self.write_config({"port": 9000, "store": "archive"})
        self.assertEqual(settings.configured_port(), 9000)
        self.assertEqual(settings.configured_port(9001), 9001)
        settings.save_library(self.base / "library")
        self.assertEqual(settings.load_config(), {
            "port": 9000, "store": "archive", "library": str(self.base / "library"),
        })

    def test_first_run_then_empty_library_and_restart(self):
        class TestHandler(studio.Handler):
            root = None
            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), TestHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        connection = HTTPConnection(*server.server_address)
        self.addCleanup(connection.close)

        def request(method, path, body=None, headers=None):
            headers = {**({"Content-Type": "application/json"} if body is not None else {}), **(headers or {})}
            connection.request(method, path, json.dumps(body) if body is not None else None, headers)
            response = connection.getresponse()
            return response.status, response.read()

        status, page = request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"Choose a folder for your photos", page)
        self.assertNotIn(b"__SETUP_TOKEN__", page)
        self.assertEqual(request("GET", "/api/shoots")[0], 503)
        library = self.base / "new-library"
        self.assertEqual(request("POST", "/api/setup", {"library": str(library)})[0], 403)
        self.assertFalse(library.exists())
        headers = {"X-Studio-Setup": TestHandler.setup_token, "Content-Type": "application/json"}
        self.assertEqual(request("POST", "/api/setup", {"library": "relative"}, headers)[0], 400)
        self.assertEqual(request("POST", "/api/setup", {"library": str(library)}, headers)[0], 200)
        self.assertTrue(library.is_dir())
        self.assertEqual(settings.resolve_library(), library)
        status, body = request("GET", "/api/shoots")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"shoots": [], "collections": []})
        status, body = request("GET", "/api/offload")
        self.assertEqual(status, 200)
        self.assertFalse(json.loads(body)["configured"])
        self.assertEqual(request("POST", "/api/setup", {"library": str(self.base / "other")}, headers)[0], 409)


if __name__ == "__main__":
    unittest.main()
