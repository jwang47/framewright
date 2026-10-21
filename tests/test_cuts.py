"""Video cuts: validation, saving and the ffmpeg command, with synthetic clips."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from framewright import cuts


class CutTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        env = patch.dict(os.environ, {"STUDIO_CONFIG": str(self.root / "config.json")}, clear=True)
        env.start()
        self.addCleanup(env.stop)
        video = self.root / "2026-03-15_acme" / "video"
        video.mkdir(parents=True)
        (self.root / "2026-03-15_acme" / "raw").mkdir()
        for key in ("C0001", "C0002"):
            (video / f"{key}.MP4").write_bytes(b"\0" * 100)

    def test_clean_cut_rejects_bad_ranges_and_names(self):
        good = cuts.clean_cut({"name": "Reel", "clips": [{"shoot": "s", "key": "C0001", "in": 1, "out": 2.5}]})
        self.assertEqual(good["clips"][0], {"shoot": "s", "key": "C0001", "in": 1.0, "out": 2.5})
        self.assertTrue(good["log709"])
        for bad in ({"name": ""}, {"name": "x", "clips": [{"shoot": "s", "key": "k", "in": 2, "out": 1}]},
                    {"name": "x", "clips": [{"shoot": "../s", "key": "k", "in": 0, "out": 1}]},
                    {"name": "x", "clips": [{"shoot": "s", "key": "k", "in": True, "out": 1}]}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                cuts.clean_cut(bad)

    def test_save_rename_and_list(self):
        slug = cuts.write_cut(self.root, cuts.clean_cut({"name": "First draft", "clips": []}))
        self.assertEqual(slug, "first-draft")
        renamed = cuts.write_cut(self.root, cuts.clean_cut({"name": "Final", "clips": []}), slug)
        self.assertEqual([c["slug"] for c in cuts.list_cuts(self.root)], [renamed])
        self.assertFalse(cuts.cut_path(self.root, slug).exists())
        with self.assertRaises(ValueError):
            cuts.cut_path(self.root, "../x")

    def test_render_command_trims_and_joins(self):
        cut = cuts.clean_cut({"name": "Reel", "clips": [
            {"shoot": "2026-03-15_acme", "key": "C0001", "in": 1, "out": 3},
            {"shoot": "2026-03-15_acme", "key": "C0002", "in": 0, "out": 1.5}]})
        with patch.object(cuts, "has_audio", side_effect=[True, False]), \
                patch.object(cuts, "encoder", return_value=["-c:v", "libx264"]):
            cmd, total = cuts.render_command(self.root, cut, "1080", "h264", self.root / "out.mp4")
        self.assertEqual(total, 3.5)
        graph = cmd[cmd.index("-filter_complex") + 1]
        self.assertIn("concat=n=2:v=1:a=1", graph)
        self.assertIn("scale=-2:1080", graph)
        self.assertIn("anullsrc", " ".join(cmd))          # the silent clip gets silence
        self.assertEqual(cmd[cmd.index("-ss") + 1], "1.000")
        with self.assertRaises(ValueError):
            cuts.render_command(self.root, cuts.clean_cut({"name": "Empty"}), "1080", "h264", self.root / "o.mp4")


    def test_transitions_speed_music_and_titles(self):
        cut = cuts.clean_cut({"name": "Reel", "clipGain": -6, "clips": [
            {"shoot": "2026-03-15_acme", "key": "C0001", "in": 0, "out": 4},
            {"shoot": "2026-03-15_acme", "key": "C0002", "in": 0, "out": 1, "speed": 0.2,
             "trans": {"type": "cross", "dur": 9}}],
            "music": {"file": "song.m4a", "gain": -12}, "titles": [{"text": "Hello", "at": 1, "dur": 2}]})
        # 1 s at 0.2 runs 5 s; the crossfade is capped at half the shorter clip.
        self.assertEqual(cut["clips"][1]["trans"], {"type": "cross", "dur": 2.0})
        self.assertEqual(cuts.starts(cut["clips"]), [0.0, 2.0])
        self.assertEqual(cuts.running_time(cut["clips"]), 7.0)
        self.assertEqual(cut["music"], {"file": "song.m4a", "start": 0.0, "gain": -12.0, "fade": 1.5})
        self.assertEqual(cut["titles"][0]["style"], "center")
        song = self.root / "music" / "song.m4a"
        song.parent.mkdir()
        song.write_bytes(b"\0")
        with patch.object(cuts, "has_audio", return_value=True), patch.object(cuts, "encoder", return_value=[]):
            cmd, total = cuts.render_command(self.root, cut, "720", "h264", self.root / "out.mp4")
        graph = cmd[cmd.index("-filter_complex") + 1]
        self.assertEqual(total, 7.0)
        self.assertIn("xfade=transition=fade:duration=2.000:offset=2.000", graph)
        self.assertIn("setpts=(PTS-STARTPTS)/0.2", graph)
        self.assertIn("anullsrc", " ".join(cmd))       # slow motion plays silent
        self.assertIn("drawtext=", graph)
        self.assertIn("amix=inputs=2", graph)
        for bad in ({"text": "", "at": 0}, {"text": "x", "at": 0, "style": "huge"}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                cuts.clean_cut({"name": "x", "titles": [bad]})

if __name__ == "__main__":
    unittest.main()
