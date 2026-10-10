"""The opt-in remote API: token auth, tailnet-only binding and each endpoint,
against temporary libraries with synthetic files. No real Claude call."""
from http.client import HTTPConnection
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from unittest.mock import patch

from framewright import remote, settings
from framewright import server as studio

TOKEN = "t" * 43
# A small, complete baseline JPEG (8x8 grey), so the preview fallback can serve it.
JPEG = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432"
    "ffc0000b080008000801011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa"
    "ffda0008010100003f00fbd3ffd9")


def library(base: Path) -> Path:
    root = base / "library"
    day = root / "2026-01-02_camera" / "raw"
    day.mkdir(parents=True)
    (day / "PAIR.JPG").write_bytes(JPEG)
    (day / "PAIR.DNG").write_bytes(b"synthetic raw")
    (day / "ONLY.JPG").write_bytes(JPEG)
    older = root / "2026-01-01_camera" / "raw"
    older.mkdir(parents=True)
    (older / "OLD.JPG").write_bytes(JPEG)
    (root / "2026-01-02_camera" / "picks.txt").write_text("PAIR\n")
    return root


class RemoteTestCase(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name).resolve()
        env = patch.dict(os.environ, {"STUDIO_CONFIG": str(self.base / "config" / "config.json"),
                                      "STUDIO_LUTS": str(self.base / "luts")})
        env.start()
        self.addCleanup(env.stop)
        self.root = library(self.base)
        self.day = self.root / "2026-01-02_camera"
        self.suggestions = remote.Suggestions(self.root, timeout=20)
        self.server = remote.make_server(self.root, "127.0.0.1", 0, TOKEN, self.suggestions)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.addCleanup(self.suggestions.close)

    def request(self, method, path, body=None, headers=None, token=TOKEN):
        connection = HTTPConnection(*self.server.server_address[:2], timeout=10)
        headers = dict(headers or {})
        if token is not None:
            headers.setdefault("Authorization", f"Bearer {token}")
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
            headers.setdefault("Content-Type", "application/json")
        try:
            connection.request(method, "/remote/v1" + path, body, headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def get_json(self, path):
        status, _, data = self.request("GET", path)
        return status, json.loads(data)

    def post_json(self, path, body):
        status, _, data = self.request("POST", path, body)
        return status, json.loads(data)


class AuthTests(RemoteTestCase):
    def test_missing_or_wrong_token_is_401_before_body_reads(self):
        reads = []
        original = remote.RemoteHandler.json_body
        with patch.object(remote.RemoteHandler, "json_body", lambda self: reads.append(1) or original(self)):
            for token in (None, "", "wrong", TOKEN + "x", TOKEN[:-1]):
                status, headers, data = self.request("POST", "/edit", {"shoot": "x"}, token=token)
                self.assertEqual(status, 401, token)
                self.assertEqual(json.loads(data), {"error": "unauthorized"})
            for header in ("Basic " + TOKEN, TOKEN, f"Bearer  {TOKEN}x"):
                status, _, _ = self.request("GET", "/info", headers={"Authorization": header}, token=None)
                self.assertEqual(status, 401, header)
            # Even unknown paths reveal nothing without the token.
            status, _, _ = self.request("GET", "/../../etc/passwd", token=None)
            self.assertEqual(status, 401)
        self.assertEqual(reads, [])

    def test_valid_token_and_unknown_paths(self):
        status, info = self.get_json("/info")
        self.assertEqual(status, 200)
        self.assertEqual(info["library"], "library")
        self.assertEqual(info["version"], studio.__dict__.get("__version__", info["version"]))
        self.assertIsInstance(info["claude"], bool)
        self.assertIsInstance(info["suggest"], bool)
        self.assertEqual(self.request("GET", "/nope")[0], 404)
        self.assertEqual(self.request("DELETE", "/edit")[0], 405)


class HostTests(unittest.TestCase):
    def test_only_tailnet_addresses_without_override(self):
        for good in ("100.64.0.1", "100.101.102.103", "100.127.255.254", "fd7a:115c:a1e0::1", "[fd7a:115c:a1e0:ab12::5]"):
            self.assertTrue(remote.validate_remote_host(good))
        for bad in ("127.0.0.1", "10.0.0.5", "192.168.1.2", "100.128.0.1", "100.63.255.255", "8.8.8.8",
                    "fd7a:115c:a1e1::1", "::1", "example.com", "", "localhost"):
            with self.assertRaises(ValueError, msg=bad):
                remote.validate_remote_host(bad)
        self.assertEqual(remote.validate_remote_host("127.0.0.1", allow_any=True), "127.0.0.1")
        for wildcard in ("0.0.0.0", "::", "[::]"):
            with self.assertRaises(ValueError):
                remote.validate_remote_host(wildcard, allow_any=True)

    def test_detection_prefers_tailscale_cli_then_interfaces(self):
        with patch.object(studio, "tailscale", return_value="/x/tailscale"), \
                patch.object(remote, "_run", return_value="100.100.1.2\n"):
            self.assertEqual(remote.detect_tailscale_ip(), "100.100.1.2")
        ifconfig = "lo0: inet 127.0.0.1 netmask 0xff000000\nutun4: inet 100.88.7.6 --> 100.88.7.6\n"
        with patch.object(studio, "tailscale", return_value=None), \
                patch.object(remote.shutil, "which", side_effect=lambda n: "/sbin/ifconfig" if n == "ifconfig" else None), \
                patch.object(remote, "_run", return_value=ifconfig), patch.object(remote.sys, "platform", "darwin"):
            self.assertEqual(remote.detect_tailscale_ip(), "100.88.7.6")
        with patch.object(studio, "tailscale", return_value=None), \
                patch.object(remote.shutil, "which", side_effect=lambda n: "/sbin/ifconfig" if n == "ifconfig" else None), \
                patch.object(remote, "_run", return_value="inet 10.0.0.5\n"), patch.object(remote.sys, "platform", "darwin"):
            self.assertIsNone(remote.detect_tailscale_ip())

    def test_pairing_lines(self):
        lines = remote.pairing_lines("100.64.0.9", 8766, "abc-_123", "mac.tail1234.ts.net")
        self.assertEqual(lines[0], "remote API: http://mac.tail1234.ts.net:8766/remote/v1  token: abc-_123")
        self.assertEqual(lines[1], "pair: framewright://pair?url=http%3A%2F%2Fmac.tail1234.ts.net%3A8766&token=abc-_123")
        self.assertIn("http://[fd7a:115c:a1e0::1]:8766", remote.pairing_lines("fd7a:115c:a1e0::1", 8766, "x")[0])


class TokenTests(unittest.TestCase):
    def test_token_is_generated_once_kept_private_and_rotates(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "config.json"
            config.write_text(json.dumps({"library": "photos"}))
            os.chmod(config, 0o644)
            with patch.dict(os.environ, {"STUDIO_CONFIG": str(config)}):
                token = settings.remote_token()
                self.assertGreaterEqual(len(token), 40)
                self.assertEqual(settings.remote_token(), token)
                data = json.loads(config.read_text())
                self.assertEqual(data["library"], "photos")
                self.assertEqual(data["remoteToken"], token)
                if sys.platform != "win32":
                    self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o600)
                rotated = settings.remote_token(rotate=True)
                self.assertNotEqual(rotated, token)
                if sys.platform != "win32":
                    self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o600)
                    os.chmod(config, 0o644)
                    settings.remote_token()
                    self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o600)
                with patch("sys.stdout") as out:
                    self.assertEqual(remote.token_main([]), 0)
                self.assertIn(rotated, "".join(c.args[0] for c in out.write.call_args_list))
                config.write_text(json.dumps({"remote": "yes"}))
                with self.assertRaises(ValueError):
                    settings.load_config()


class EndpointTests(RemoteTestCase):
    def test_shoots_and_frames(self):
        studio.edit_path(self.day, "ONLY").write_text(json.dumps({"version": 1, "exposure": 0.5}))
        studio.proposal_path(self.day, "PAIR").write_text(json.dumps({"params": {"version": 1}, "note": "", "created": "x"}))
        status, body = self.get_json("/shoots")
        self.assertEqual(status, 200)
        self.assertEqual(body["shoots"], [
            {"name": "2026-01-02_camera", "count": 2, "picks": 1, "edited": 1},
            {"name": "2026-01-01_camera", "count": 1, "picks": 0, "edited": 0}])
        status, body = self.get_json("/frames?shoot=2026-01-02_camera")
        self.assertEqual(status, 200)
        frames = {f["key"]: f for f in body["frames"]}
        self.assertEqual(frames["PAIR"], {"key": "PAIR", "hasRaw": True, "hasJpeg": True, "edited": False,
                                          "proposed": True, "picked": True, "available": True})
        self.assertEqual(frames["ONLY"], {"key": "ONLY", "hasRaw": False, "hasJpeg": True, "edited": True,
                                          "proposed": False, "picked": False, "available": True})
        for bad in ("nope", "..", "../library", "%2e%2e", ".preview", ""):
            self.assertIn(self.get_json(f"/frames?shoot={bad}")[0], (400, 404), bad)

    def test_offline_frames_are_unavailable(self):
        day = self.root / "2026-01-03_camera"
        (day / "raw").mkdir(parents=True)
        (day / "store.json").write_text(json.dumps({"files": {"raw/GONE.JPG": {"mtime": 1, "size": 8}}}))
        with patch.dict(os.environ, {"STUDIO_STORE": str(self.base / "unplugged")}):
            status, body = self.get_json("/frames?shoot=2026-01-03_camera")
            self.assertEqual(status, 200)
            self.assertEqual(body["frames"][0]["key"], "GONE")
            self.assertFalse(body["frames"][0]["available"])
            self.assertEqual(self.request("GET", "/source?shoot=2026-01-03_camera&key=GONE&kind=jpeg")[0], 404)
            self.assertEqual(self.request("GET", "/preview?shoot=2026-01-03_camera&key=GONE")[0], 404)

    def test_preview_and_source(self):
        with patch.object(studio.shutil, "which", return_value=None), patch.object(remote.shutil, "which", return_value=None):
            status, headers, data = self.request("GET", "/preview?shoot=2026-01-02_camera&key=ONLY&size=300")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/jpeg")
        self.assertEqual(data, JPEG)
        self.assertEqual(self.request("GET", "/preview?shoot=2026-01-02_camera&key=ONLY&size=big")[0], 400)
        self.assertEqual(self.request("GET", "/preview?shoot=2026-01-02_camera&key=MISSING")[0], 404)
        status, headers, data = self.request("GET", "/source?shoot=2026-01-02_camera&key=PAIR&kind=raw")
        self.assertEqual((status, data, headers["Content-Type"]), (200, b"synthetic raw", "image/x-adobe-dng"))
        status, headers, data = self.request("GET", "/source?shoot=2026-01-02_camera&key=PAIR&kind=jpeg")
        self.assertEqual((status, data, headers["Content-Type"]), (200, JPEG, "image/jpeg"))
        self.assertEqual(self.request("GET", "/source?shoot=2026-01-02_camera&key=ONLY&kind=raw")[0], 404)
        self.assertEqual(self.request("GET", "/source?shoot=2026-01-02_camera&key=ONLY&kind=xmp")[0], 400)
        self.assertEqual(self.request("GET", "/source?shoot=2026-01-02_camera&key=../ONLY&kind=jpeg")[0], 404)

    def test_edit_round_trip_and_conflict(self):
        status, body = self.get_json("/edit?shoot=2026-01-02_camera&key=PAIR")
        self.assertEqual((status, body), (200, {"recipe": None, "revision": "none"}))
        status, body = self.post_json("/edit", {"shoot": "2026-01-02_camera", "key": "PAIR",
                                                "recipe": {"exposure": 9, "bogus": 1, "source": "raw"}, "base": "none"})
        self.assertEqual(status, 200)
        rev = body["revision"]
        saved = json.loads(studio.edit_path(self.day, "PAIR").read_text())
        self.assertEqual(saved, {"version": 1, "exposure": 4.0, "source": "raw"})
        self.assertEqual(self.get_json("/edit?shoot=2026-01-02_camera&key=PAIR")[1], {"recipe": saved, "revision": rev})
        status, body = self.post_json("/edit", {"shoot": "2026-01-02_camera", "key": "PAIR",
                                                "recipe": {"exposure": 1}, "base": "none"})
        self.assertEqual(status, 409)
        self.assertEqual(body, {"error": "conflict", "revision": rev, "recipe": saved})
        self.assertEqual(self.post_json("/edit", {"shoot": "2026-01-02_camera", "key": "ONLY",
                                                  "recipe": {"source": "raw"}, "base": "none"})[0], 400)
        self.assertEqual(self.post_json("/edit", {"shoot": "2026-01-02_camera", "key": "PAIR",
                                                  "recipe": {"exposure": "x"}, "base": rev})[0], 400)
        self.assertEqual(self.post_json("/edit", {"shoot": "2026-01-02_camera", "key": "NOPE", "recipe": {}})[0], 404)
        status, body = self.post_json("/edit", {"shoot": "2026-01-02_camera", "key": "PAIR", "recipe": None, "base": rev})
        self.assertEqual((status, body), (200, {"revision": "none"}))
        self.assertFalse(studio.edit_path(self.day, "PAIR").exists())

    def test_json_content_type_and_size(self):
        status, _, _ = self.request("POST", "/pick", json.dumps({"shoot": "2026-01-02_camera", "key": "ONLY", "picked": True}),
                                    {"Content-Type": "text/plain"})
        self.assertEqual(status, 415)
        status, _, _ = self.request("POST", "/pick", b"x", {"Content-Type": "application/json",
                                                             "Content-Length": str(remote.MAX_JSON_BYTES + 1)})
        self.assertEqual(status, 413)
        self.assertEqual(self.request("POST", "/pick", b"[1]", {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.request("POST", "/pick", b"{nope", {"Content-Type": "application/json"})[0], 400)

    def test_proposal_accept_and_discard(self):
        self.assertEqual(self.get_json("/proposal?shoot=2026-01-02_camera&key=PAIR"), (200, {"proposal": None}))
        self.assertEqual(self.post_json("/proposal/accept", {"shoot": "2026-01-02_camera", "key": "PAIR"})[0], 404)
        # The frame already develops from its JPEG (an edit with no source): accepting keeps that.
        studio.edit_path(self.day, "PAIR").write_text(json.dumps({"version": 1, "exposure": 0.2}))
        proposal = {"params": {"version": 1, "contrast": 20, "source": "raw"}, "note": "more punch", "created": "2026-01-02T10:00:00"}
        studio.proposal_path(self.day, "PAIR").write_text(json.dumps(proposal))
        self.assertEqual(self.get_json("/proposal?shoot=2026-01-02_camera&key=PAIR"), (200, {"proposal": proposal}))
        status, body = self.post_json("/proposal/accept", {"shoot": "2026-01-02_camera", "key": "PAIR", "base": "stale"})
        self.assertEqual(status, 409)
        self.assertTrue(studio.proposal_path(self.day, "PAIR").exists())
        status, body = self.post_json("/proposal/accept", {"shoot": "2026-01-02_camera", "key": "PAIR"})
        self.assertEqual(status, 200)
        self.assertEqual(body["revision"], studio.edit_rev(studio.edit_path(self.day, "PAIR")))
        self.assertEqual(json.loads(studio.edit_path(self.day, "PAIR").read_text()),
                         {"version": 1, "contrast": 20.0, "source": "jpeg"})
        self.assertFalse(studio.proposal_path(self.day, "PAIR").exists())
        studio.proposal_path(self.day, "ONLY").write_text(json.dumps(proposal))
        self.assertEqual(self.post_json("/proposal/discard", {"shoot": "2026-01-02_camera", "key": "ONLY"}), (200, {}))
        self.assertFalse(studio.proposal_path(self.day, "ONLY").exists())
        self.assertFalse(studio.edit_path(self.day, "ONLY").exists())

    def test_pick(self):
        self.assertEqual(self.post_json("/pick", {"shoot": "2026-01-02_camera", "key": "ONLY", "picked": True}), (200, {}))
        self.assertEqual(studio.read_picks(self.day), {"PAIR", "ONLY"})
        self.assertEqual(self.post_json("/pick", {"shoot": "2026-01-02_camera", "key": "PAIR", "picked": False}), (200, {}))
        self.assertEqual(studio.read_picks(self.day), {"ONLY"})
        self.assertEqual(self.post_json("/pick", {"shoot": "2026-01-02_camera", "key": "ONLY", "picked": "yes"})[0], 400)
        self.assertEqual(self.post_json("/pick", {"shoot": "2026-01-02_camera", "key": "X", "picked": True})[0], 404)

    def test_looks_and_lut(self):
        luts = self.base / "luts"
        luts.mkdir()
        text = "TITLE \"synthetic\"\n" + "LUT_3D" + "_SIZE 2\n" + "".join(f"{r} {g} {b}\n" for b in (0, 1) for g in (0, 1) for r in (0, 1))
        (luts / "Synthetic.cube").write_bytes(text.encode())   # exact bytes on every platform
        status, body = self.get_json("/looks")
        self.assertEqual(status, 200)
        files = [lk for lk in body["looks"] if lk.get("file")]
        self.assertEqual(files[0]["params"]["lut"], "Synthetic.cube")
        status, headers, data = self.request("GET", f"/lut?name=Synthetic.cube&hash={files[0]['params']['lutHash']}")
        self.assertEqual((status, data.decode()), (200, text))
        self.assertTrue(headers["Content-Type"].startswith("text/plain"))
        status, headers, _ = self.request("GET", "/lut?name=Synthetic.cube&hash=0123456789abcdef")
        self.assertEqual(status, 200)
        self.assertIn("X-LUT-Warning", headers)
        for bad in ("../Synthetic.cube", "Missing.cube", "x.txt"):
            self.assertEqual(self.request("GET", f"/lut?name={bad}")[0], 404, bad)

    def test_upload(self):
        def upload(shoot, name, data=JPEG, ctype="application/octet-stream"):
            return self.request("POST", f"/upload?shoot={shoot}&name={name}", data, {"Content-Type": ctype})

        status, _, data = upload("2026-03-04_iphone", "IMG_0001.HEIC")
        self.assertEqual((status, json.loads(data)), (200, {"shoot": "2026-03-04_iphone", "key": "IMG_0001"}))
        self.assertEqual((self.root / "2026-03-04_iphone" / "raw" / "IMG_0001.HEIC").read_bytes(), JPEG)
        self.assertEqual(upload("2026-03-04_iphone", "IMG_0001.HEIC", b"other")[0], 409)
        self.assertEqual(upload("2026-03-04_iphone", "img_0001.heic", b"other")[0], 409)
        self.assertEqual((self.root / "2026-03-04_iphone" / "raw" / "IMG_0001.HEIC").read_bytes(), JPEG)
        self.assertEqual(upload("2026-03-04_iphone", "IMG_0001.DNG", b"raw")[0], 200)   # a raw beside the HEIC
        self.assertIn("2026-03-04_iphone", [s["name"] for s in self.get_json("/shoots")[1]["shoots"]])
        for shoot, name in [("2026-03-04_iphone", "../x.jpg"), ("2026-03-04_iphone", "x.txt"), ("2026-03-04_iphone", ".x.jpg"),
                            ("2026-03-04_iphone", "a/b.jpg"), ("2026-03-04_iphone", "x.edit.json"), ("2026-03-04_iphone", "x.jpg.json"),
                            ("2026-03-04_iphone", "noext"), ("../escape", "x.jpg"), ("2026-03-04_IPHONE", "x.jpg"),
                            ("library", "x.jpg"), ("2026-03-04", "x.jpg"), ("2026-03-04_a/b", "x.jpg")]:
            self.assertEqual(upload(shoot, name)[0], 400, (shoot, name))
        self.assertEqual(upload("2026-03-04_iphone", "IMG_0002.JPG", ctype="image/jpeg")[0], 415)
        self.assertEqual(upload("2026-03-04_iphone", "IMG_0002.JPG", b"")[0], 400)
        status, _, _ = self.request("POST", "/upload?shoot=2026-03-04_iphone&name=IMG_0003.JPG", b"x",
                                    {"Content-Type": "application/octet-stream",
                                     "Content-Length": str(remote.MAX_UPLOAD_BYTES + 1)})
        self.assertEqual(status, 413)
        self.assertFalse((self.root / "2026-03-04_iphone" / "raw" / "IMG_0003.JPG").exists())
        self.assertEqual(sorted(p.name for p in (self.root / "2026-03-04_iphone" / "raw").iterdir()),
                         ["IMG_0001.DNG", "IMG_0001.HEIC"])

    def test_no_file_management_routes(self):
        for path in ("/import", "/offload", "/eject", "/send", "/export", "/settings", "/setup", "/luts/install"):
            self.assertEqual(self.request("POST", path, {})[0], 404, path)


FAKE_CLAUDE = textwrap.dedent(r'''
    #!{python}
    import json, os, re, sys, time
    prompt = sys.argv[sys.argv.index("-p") + 1]
    frame = re.search(r"^Frame: (\S+)$", prompt, re.M).group(1)
    shoot, key = frame.split("/")
    library = os.environ["STUDIO_LIBRARY"]
    with open(os.path.join(os.getcwd(), "args.json"), "w") as f:
        json.dump(sys.argv[1:], f)
    def emit(event):
        print(json.dumps(event), flush=True)
    emit({{"type": "system", "subtype": "init"}})
    emit({{"type": "assistant", "message": {{"content": [{{"type": "tool_use", "name": "Bash",
          "input": {{"command": f"python3 -m framewright render --library {{library}} {{frame}} --recipe edit -o baseline.jpg"}}}}]}}}})
    emit({{"type": "assistant", "message": {{"content": [{{"type": "text", "text": "The frame is a little dark."}}]}}}})
    emit({{"type": "assistant", "message": {{"content": [{{"type": "tool_use", "name": "Read", "input": {{"file_path": "/x/baseline.jpg"}}}}]}}}})
    if "SLOW" in prompt:
        time.sleep(30)
    if "FAIL" not in prompt:
        with open(os.path.join(library, shoot, "raw", key + ".proposal.json"), "w") as f:
            json.dump({{"params": {{"version": 1, "exposure": 0.4}}, "note": "brighter", "created": "now"}}, f)
        emit({{"type": "assistant", "message": {{"content": [{{"type": "tool_use", "name": "Bash",
              "input": {{"command": f"python3 -m framewright render --library {{library}} {{frame}} --propose trial.json --note x"}}}}]}}}})
        emit({{"type": "result", "subtype": "success", "is_error": False, "num_turns": 4, "result": "Brightened."}})
    else:
        emit({{"type": "result", "subtype": "error_max_turns", "is_error": True, "num_turns": 40}})
''').lstrip()


@unittest.skipIf(sys.platform == "win32", "the fake claude is a shebang script")
class SuggestTests(RemoteTestCase):
    def setUp(self):
        super().setUp()
        bin_dir = self.base / "bin"
        bin_dir.mkdir()
        fake = bin_dir / "claude"
        fake.write_text(FAKE_CLAUDE.format(python=sys.executable))
        fake.chmod(0o755)
        env = patch.dict(os.environ, {"PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"})
        env.start()
        self.addCleanup(env.stop)

    def wait(self, job, timeout=20):
        deadline = time.time() + timeout
        while time.time() < deadline:
            status, body = self.get_json(f"/suggest?job={job}")
            self.assertEqual(status, 200)
            if body["state"] in ("done", "failed"):
                return body
            time.sleep(0.1)
        self.fail("suggest job did not finish")

    def test_suggest_runs_claude_and_reports_the_proposal(self):
        status, info = self.get_json("/info")
        self.assertTrue(info["claude"] and info["suggest"])
        status, body = self.post_json("/suggest", {"shoot": "2026-01-02_camera", "key": "PAIR", "note": "brighter please"})
        self.assertEqual(status, 200)
        result = self.wait(body["job"])
        self.assertEqual(result["state"], "done", result)
        self.assertTrue(result["proposal"])
        self.assertIn("rendering baseline", result["log"])
        self.assertIn("The frame is a little dark.", result["log"])
        self.assertIn("inspecting baseline.jpg", result["log"])
        self.assertIn("writing the proposal", result["log"])
        self.assertTrue(studio.proposal_path(self.day, "PAIR").is_file())
        self.assertFalse(studio.edit_path(self.day, "PAIR").exists())

    def test_prompt_and_command(self):
        prompt = remote.suggest_prompt(self.root, "2026-01-02_camera", "PAIR", "warmer", True)
        self.assertIn("Frame: 2026-01-02_camera/PAIR", prompt)
        self.assertIn(str(self.root), prompt)
        self.assertIn("--replace-proposal", prompt)
        self.assertIn("*.edit.json", prompt)
        self.assertIn('"warmer"', prompt)
        cmd = remote.suggest_command("claude", prompt)
        self.assertEqual(cmd[:3], ["claude", "-p", prompt])
        for part in ("stream-json", "--verbose", "40", "Bash(python3 -m framewright render:*)",
                     "Bash(python -m framewright render:*)", "Read"):
            self.assertIn(part, cmd)
        self.assertNotIn("Bash", [c for c in cmd if c.startswith("Bash") and "render" not in c])

    def test_failures_validation_and_queue(self):
        status, body = self.post_json("/suggest", {"shoot": "2026-01-02_camera", "key": "PAIR", "note": "FAIL"})
        result = self.wait(body["job"])
        self.assertEqual(result["state"], "failed")
        self.assertFalse(result["proposal"])
        self.assertIn("error_max_turns", result["error"])
        self.assertEqual(self.post_json("/suggest", {"shoot": "2026-01-02_camera", "key": "PAIR", "note": "x" * 501})[0], 400)
        self.assertEqual(self.post_json("/suggest", {"shoot": "2026-01-02_camera", "key": "NOPE"})[0], 404)
        self.assertEqual(self.get_json("/suggest?job=unknown")[0], 404)
        # One runs, five wait, the next is refused.
        jobs = [self.post_json("/suggest", {"shoot": "2026-01-02_camera", "key": "ONLY", "note": "SLOW"}) for _ in range(6)]
        self.assertTrue(all(status == 200 for status, _ in jobs), jobs)
        time.sleep(0.3)
        states = [self.get_json(f"/suggest?job={b['job']}")[1]["state"] for _, b in jobs]
        self.assertEqual(states.count("running"), 1, states)
        self.assertEqual(self.post_json("/suggest", {"shoot": "2026-01-02_camera", "key": "ONLY"})[0], 429)

    def test_timeout_kills_the_process(self):
        self.suggestions.timeout = 1
        status, body = self.post_json("/suggest", {"shoot": "2026-01-02_camera", "key": "ONLY", "note": "SLOW"})
        started = time.time()
        result = self.wait(body["job"], timeout=15)
        self.assertLess(time.time() - started, 10)
        self.assertEqual(result["state"], "failed")
        self.assertIn("timed out", result["error"])


class ServerOptionTests(unittest.TestCase):
    def test_remote_flag_requires_a_tailnet_address(self):
        with tempfile.TemporaryDirectory() as tmp, \
                patch.dict(os.environ, {"STUDIO_CONFIG": str(Path(tmp) / "config.json")}), \
                patch("sys.stderr") as err:
            code = studio.main(["--library", tmp, "--no-reload", "--no-browser", "--remote", "--remote-host", "127.0.0.1"])
        self.assertEqual(code, 1)
        self.assertIn("not a Tailscale address", "".join(c.args[0] for c in err.write.call_args_list))


if __name__ == "__main__":
    unittest.main()
