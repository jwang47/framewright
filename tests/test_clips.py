"""Video clips in the library, with synthetic files only."""
import json
import os
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from framewright import clips
from framewright import store

SIDECAR = b"""<?xml version="1.0" encoding="UTF-8"?>
<NonRealTimeMeta lastUpdate="2026-03-15T12:00:05-07:00">
  <Duration value="240"/>
  <CreationDate value="2026-03-15T12:00:00-07:00"/>
  <VideoFormat>
    <VideoFrame videoCodec="HEVC_3840_2160_M10P@L52HT" captureFps="119.88p" formatFps="23.98p"/>
    <VideoLayout pixel="3840" numOfVerticalLine="2160" aspectRatio="16:9"/>
  </VideoFormat>
  <Device manufacturer="Acme" modelName="Cine 1" serialNo="1"/>
  <Lens modelName="Test 35mm"/>
  <AcquisitionRecord><Group name="CameraUnitMetadataSet">
    <Item name="CaptureGammaEquation" value="s-log3-cine"/>
  </Group></AcquisitionRecord>
</NonRealTimeMeta>"""


class ClipTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name)
        self.env = patch.dict(os.environ, {"STUDIO_CONFIG": str(self.base / "config.json")}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.shoot = self.base / "library" / "2026-03-15_acme"
        (self.shoot / "raw").mkdir(parents=True)

    def clip(self, folder, key="C0001"):
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"{key}.MP4").write_bytes(b"\0" * 1000)
        (folder / f"{key}M01.XML").write_bytes(SIDECAR)

    def test_sidecar_details(self):
        meta = clips.parse_sidecar(SIDECAR.decode())
        self.assertEqual(meta["duration"], round(240 / 23.98, 2))
        self.assertEqual((meta["fps"], meta["captureFps"]), (23.98, 119.88))
        self.assertEqual((meta["size"], meta["codec"]), ("3840×2160", "HEVC"))
        self.assertEqual((meta["camera"], meta["lens"]), ("Acme Cine 1", "Test 35mm"))
        self.assertTrue(clips.is_log(meta))

    def test_local_clips_listed_with_picks_and_sidecar_folded_in(self):
        self.clip(self.shoot / "video")
        listed = clips.list_clips(self.shoot, {"C0001"})
        self.assertEqual([c["key"] for c in listed], ["C0001"])
        self.assertTrue(listed[0]["picked"] and listed[0]["online"] and listed[0]["log"])
        self.assertEqual(listed[0]["time"], "12:00:00")
        self.assertEqual(listed[0]["bytes"], 1000)

    def test_store_clip_details_survive_unplugged_drive(self):
        remote = self.base / "store"
        self.clip(remote / self.shoot.name / "video")
        for name in ("C0001.MP4", "C0001M01.XML"):
            store.record(self.shoot, f"video/{name}", remote / self.shoot.name / "video" / name)
        with patch.object(store, "configured_store", return_value=remote):
            self.assertEqual(clips.list_clips(self.shoot, set())[0]["duration"], 10.01)
        with patch.object(store, "configured_store", return_value=self.base / "gone"):
            listed = clips.list_clips(self.shoot, set())
        self.assertFalse(listed[0]["online"])
        self.assertEqual(listed[0]["duration"], 10.01)    # from the cache

    def test_byte_ranges(self):
        self.assertIsNone(clips.byte_range(None, 100))
        self.assertEqual(clips.byte_range("bytes=0-", 100), (0, 99))
        self.assertEqual(clips.byte_range("bytes=10-19", 100), (10, 19))
        self.assertEqual(clips.byte_range("bytes=90-500", 100), (90, 99))
        self.assertEqual(clips.byte_range("bytes=-10", 100), (90, 99))
        for bad in ("bytes=100-", "bytes=5-1", "bytes=-", "items=0-1", "bytes=0-1,4-5"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                clips.byte_range(bad, 100)

    def test_log_preview_curve(self):
        self.assertEqual(clips.log_preview(0.0), 0.0)
        self.assertAlmostEqual(clips.log_preview(420 / 1023), 0.48, places=2)   # 18% grey
        values = [clips.log_preview(i / 100) for i in range(101)]
        self.assertEqual(values, sorted(values))
        self.assertLessEqual(values[-1], 1.0)

    def test_video_only_shoot_is_listed(self):
        from framewright import server
        self.clip(self.shoot / "video")
        self.assertEqual(server.list_shoots(self.shoot.parent), [self.shoot.name])


    def test_http_playback_and_clips_in_collections(self):
        import threading
        from http.client import HTTPConnection
        from http.server import ThreadingHTTPServer
        from framewright import server

        self.clip(self.shoot / "video")

        class TestHandler(server.Handler):
            root = self.shoot.parent
            def log_message(self, *_):
                pass

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), TestHandler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)

        def request(method, path, body=None, headers=None):
            connection = HTTPConnection(*httpd.server_address)
            self.addCleanup(connection.close)
            headers = {**({"Content-Type": "application/json"} if body is not None else {}), **(headers or {})}
            connection.request(method, path, json.dumps(body) if body is not None else None, headers)
            response = connection.getresponse()
            return response.status, response.getheader("Content-Range"), response.read()

        status, span, body = request("GET", f"/clip/{self.shoot.name}/C0001", headers={"Range": "bytes=10-19"})
        self.assertEqual((status, span, len(body)), (206, "bytes 10-19/1000", 10))
        self.assertEqual(request("GET", f"/clip/{self.shoot.name}/C0001", headers={"Range": "bytes=5000-"})[0], 416)

        self.assertEqual(request("POST", "/api/collections/create", {"name": "Reel"})[0], 200)
        ref = {"collection": "reel", "shoot": self.shoot.name, "key": "C0001", "selected": True}
        self.assertEqual(request("POST", "/api/select", ref)[0], 200)
        status, _, body = request("GET", "/api/collection?slug=reel")
        listed = json.loads(body)
        self.assertEqual(listed["items"], [f"{self.shoot.name}/C0001"])
        self.assertEqual(listed["clipItems"], listed["items"])
        status, _, body = request("GET", "/api/frames?collection=reel")
        self.assertEqual([(c["key"], c["selected"]) for c in json.loads(body)["clips"]], [("C0001", 1)])

        # Mark for deletion clears the pick; Move to Trash takes the clip, its
        # sidecar and its collection entry, through the (stubbed) Trash.
        pick = {"shoot": self.shoot.name, "key": "C0001"}
        self.assertEqual(request("POST", "/api/pick", {**pick, "picked": True})[0], 200)
        self.assertEqual(request("POST", "/api/pick", {**pick, "rejected": True})[0], 200)
        self.assertFalse((self.shoot / "picks.txt").exists())
        self.assertEqual((self.shoot / "rejects.txt").read_text(), "C0001\n")
        trashed = []
        with patch.object(server, "to_trash", lambda paths, _root: trashed.extend(p.name for p in paths)):
            status, _, body = request("POST", "/api/trash", {"refs": [f"{self.shoot.name}/C0001"]})
        self.assertEqual(status, 200)
        self.assertEqual(sorted(trashed), ["C0001.MP4", "C0001M01.XML"])
        self.assertFalse((self.shoot / "rejects.txt").exists())
        status, _, body = request("GET", "/api/collection?slug=reel")
        self.assertEqual(json.loads(body)["items"], [])

        # A collection's own date wins over the derived one, and clears back.
        self.assertEqual(request("POST", "/api/collections/date", {"collection": "reel", "date": "2026-01-02"})[0], 200)
        status, _, body = request("GET", "/api/shoots")
        reel = next(c for c in json.loads(body)["collections"] if c["slug"] == "reel")
        self.assertEqual((reel["date"], reel["dateSet"], reel["kind"]), ("2026-01-02", True, "set"))
        self.assertEqual(request("POST", "/api/collections/date", {"collection": "reel", "date": "Jan 2"})[0], 400)
        self.assertEqual(request("POST", "/api/collections/date", {"collection": "reel", "date": ""})[0], 200)
        status, _, body = request("GET", "/api/frames?all=1")
        self.assertEqual(json.loads(body)["frames"], [])    # this library has only a clip

        # Formatting wants the typed name and a plugged-in card.
        self.assertEqual(request("POST", "/api/card/format", {"card": "NOPE", "confirm": "NOPE"})[0],
                         409 if sys.platform == "darwin" else 400)

    def test_collections_newest_first(self):
        from framewright import server
        trips = [{"name": "Old trip", "days": {"from": "2025-01-01", "to": "2025-01-05"}, "items": []},
                 {"name": "Portfolio", "items": ["2026-03-15_acme/A", "2024-02-01_acme/B"]},
                 {"name": "Empty", "items": []},
                 {"name": "New trip", "days": {"from": "2026-09-01", "to": "2026-09-20"}, "items": []}]
        dates = sorted(((server.collection_date(c), c["name"]) for c in trips), reverse=True)
        self.assertEqual([n for _, n in dates], ["New trip", "Portfolio", "Old trip", "Empty"])

    def test_format_refuses_until_everything_is_imported(self):
        from framewright import server
        card = self.base / "CARD"
        (card / "DCIM" / "100MSDCF").mkdir(parents=True)
        (card / "DCIM" / "100MSDCF" / "DSC00001.JPG").write_bytes(b"photo")
        volume = {"FilesystemType": "exfat", "DeviceIdentifier": "disk99s1"}
        calls = []
        fake_run = lambda cmd, **kw: calls.append(cmd) or type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        with patch.object(server, "card_volume", return_value=volume), patch.object(server.subprocess, "run", fake_run):
            server._format.update(running=True, error=None, done=False)
            server.run_format(self.shoot.parent, card)
            self.assertIn("not in the library yet", server._format["error"])
            self.assertEqual(calls, [])
            with patch.object(server, "card_plan", return_value={}):
                server._format.update(running=True, error=None, done=False)
                server.run_format(self.shoot.parent, card)
        self.assertTrue(server._format["done"])
        self.assertEqual(calls, [["diskutil", "eraseVolume", "ExFAT", "CARD", "disk99s1"]])

if __name__ == "__main__":
    unittest.main()
