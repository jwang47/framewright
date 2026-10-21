"""Video clips in the library, with synthetic files only."""
import json
import os
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


if __name__ == "__main__":
    unittest.main()
