"""Synthetic camera metadata and card safety tests; no personal media."""
import contextlib
from datetime import datetime
import io
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

from framewright import import_photos as importer
from framewright import settings
from framewright import store


def exif(make, model):
    """Minimal TIFF IFD0 with Make and Model ASCII tags."""
    values = [(0x010f, make.encode() + b"\0"), (0x0110, model.encode() + b"\0")]
    offset = 8 + 2 + 12 * len(values) + 4
    entries, strings = b"", b""
    for tag, value in values:
        entries += struct.pack("<HHI", tag, 2, len(value))
        if len(value) <= 4:
            entries += value.ljust(4, b"\0")
        else:
            entries += struct.pack("<I", offset + len(strings))
            strings += value
    return b"II*\0" + struct.pack("<I", 8) + struct.pack("<H", 2) + entries + b"\0" * 4 + strings


class CameraImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.library, self.card = self.base / "library", self.base / "card"
        self.card.mkdir()
        self.env = patch.dict(os.environ, {"STUDIO_CONFIG": str(self.base / "config.json")}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def media(self, name, contents=b"photograph"):
        path = self.card / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(contents)
        stamp = datetime(2026, 3, 15, 12).timestamp()
        os.utime(path, (stamp, stamp))
        return path

    def plan(self, **kwargs):
        return importer.plan(self.card, self.library, None, None, False, **kwargs)

    def test_camera_formats_and_generic_make_model(self):
        samples = [
            ("Canon", "EOS R5", ".CR3", "100CANON"),
            ("Nikon", "Z 8", ".NEF", "100NIKON"),
            ("FUJIFILM", "X-T5", ".RAF", "100_FUJI"),
            ("Panasonic", "DC-S5M2", ".RW2", "100_PANA"),
            ("OM Digital Solutions", "OM-1", ".ORF", "100OLYMP"),
            ("Leica", "Q3", ".DNG", "100LEICA"),
            ("Apple", "iPhone 17", ".HEIC", "100APPLE"),
        ]
        for make, model, ext, directory in samples:
            with self.subTest(make=make):
                header = exif(make, model)
                # Exercise both TIFF raws and metadata embedded in containers.
                contents = b"container" + header if ext in (".CR3", ".HEIC", ".RAF") else header
                src = self.media(f"DCIM/{directory}/{make.split()[0]}{ext}", contents)
                self.assertEqual(importer.camera_model(src), f"{make} {model}")
        planned = self.plan()
        self.assertEqual(len(planned), len(samples))
        for make, model, _, _ in samples:
            self.assertIn(self.library / f"2026-03-15_{importer.model_slug(make + ' ' + model)}" / "raw", planned)

    def test_jpeg_make_not_duplicated_and_malformed_exif_safe(self):
        src = self.media("frame.JPG", b"\xff\xd8prefixExif\0\0" + exif("Canon", "Canon EOS R6"))
        self.assertEqual(importer.camera_model(src), "Canon EOS R6")
        src.write_bytes(b"II*\0\xff\xff\xff\xff")
        self.assertIsNone(importer.camera_model(src))

    def test_sidecars_travel_only_with_media_and_do_not_set_capture_day(self):
        self.media("DCIM/100CAM/IMG0001.RW2")
        self.media("DCIM/100CAM/IMG0001.JPG")
        for sidecar in ("IMG0001.XMP", "IMG0001.RW2.xmp", "IMG0001.THM", "IMG0001.LRV", "orphan.XMP"):
            path = self.media("DCIM/100CAM/" + sidecar)
            os.utime(path, (1, 1))
        files = list(self.plan().values())[0]
        self.assertEqual(len(files), 6)
        self.assertFalse(any(f.name == "orphan.XMP" for f in files))
        self.assertEqual(importer.shot_at(files).date().isoformat(), "2026-03-15")

    def test_sony_sd_and_cfexpress_clip_layouts(self):
        for prefix in ("PRIVATE/", ""):
            with self.subTest(prefix=prefix):
                clip = self.media(prefix + "M4ROOT/CLIP/C0001.MP4")
                sidecar = self.media(prefix + "M4ROOT/CLIP/C0001M01.XML", b'<Device modelName="Cinema Body"/>')
                planned = self.plan()
                self.assertTrue(all(dest.name == "video" for dest in planned))
                self.assertIn(clip, next(iter(planned.values())))
                self.assertIn(sidecar, next(iter(planned.values())))
                clip.unlink()
                sidecar.unlink()

    def test_configured_folder_pattern_and_reject_path_escape(self):
        self.media("frame.JPG", exif("Acme", "Camera"))
        (self.base / "config.json").write_text(json.dumps({"shoot_folder_pattern": "{camera}_{date}"}))
        self.assertIn(self.library / "acme-camera_2026-03-15" / "raw", self.plan())
        for pattern in ("../{date}_{camera}", "{date}/{camera}", "{camera.__class__}_{date}", "{date}", "{date}_{camera:>20}", "{date}_{camera}."):
            with self.subTest(pattern=pattern), self.assertRaises(ValueError):
                settings.validate_shoot_pattern(pattern)

    def test_partial_import_retries_missing_siblings_without_force(self):
        jpeg = self.media("DCIM/CAM/frame.JPG", exif("Acme", "Body"))
        raw = self.media("DCIM/CAM/frame.NEF", exif("Acme", "Body") + b"RAW")
        sidecar = self.media("DCIM/CAM/frame.XMP", b"sidecar")
        planned = self.plan(jpeg_only=True)
        dest = next(iter(planned))
        importer.place(jpeg, dest, False)
        pending = self.plan()
        self.assertEqual(set(pending[dest]), {raw, sidecar})
        for source in pending[dest]:
            importer.place(source, dest, False)
        self.assertEqual(self.plan(), {})

    def test_offline_manifest_hash_preserves_missing_sibling(self):
        jpeg = self.media("frame.JPG", exif("Acme", "Body"))
        raw = self.media("frame.NEF", exif("Acme", "Body") + b"RAW")
        dest = next(iter(self.plan()))
        remote = self.base / "store"
        remote.mkdir()
        with patch.object(store, "configured_store", return_value=remote):
            importer.place(jpeg, dest, True)
        with patch.object(store, "configured_store", return_value=None):
            self.assertEqual(self.plan()[dest], [raw])
        self.assertIn("sha256", store.read_manifest(dest.parent)["raw/frame.JPG"])

    def test_conflicting_destination_does_not_overwrite_or_delete_card(self):
        source = self.media("frame.JPG", b"new bytes")
        dest = self.library / "shoot" / "raw"
        dest.mkdir(parents=True)
        target = dest / source.name
        target.write_bytes(b"different photo")
        with self.assertRaisesRegex(importer.ImportError_, "different file"):
            importer.place(source, dest, False, delete_from_card=True)
        self.assertEqual(source.read_bytes(), b"new bytes")
        self.assertEqual(target.read_bytes(), b"different photo")

    def test_delete_off_by_default_and_only_after_verified_copy(self):
        source = self.media("frame.JPG")
        dest = self.library / "shoot" / "raw"
        importer.place(source, dest, False)
        self.assertTrue(source.exists())
        importer.place(source, dest, False, delete_from_card=True)
        self.assertFalse(source.exists())
        self.assertEqual((dest / source.name).read_bytes(), b"photograph")

    def test_copy_failure_preserves_card_file(self):
        source = self.media("frame.JPG")
        with patch.object(importer, "copy_verified", side_effect=importer.ImportError_("checksum mismatch")):
            with self.assertRaises(importer.ImportError_):
                importer.place(source, self.library / "shoot" / "raw", False, delete_from_card=True)
        self.assertTrue(source.exists())

    def test_dry_run_never_deletes(self):
        source = self.media("frame.JPG")
        with contextlib.redirect_stdout(io.StringIO()):
            status = importer.main(["--library", str(self.library), "--source", str(self.card), "--delete-from-card", "--dry-run"])
        self.assertEqual(status, 0)
        self.assertTrue(source.exists())
        self.assertFalse(self.library.exists())

    def test_orphan_clip_xml_is_not_a_frame(self):
        self.media("PRIVATE/M4ROOT/CLIP/C0001M01.XML", b'<Device modelName="Camera"/>')
        with self.assertRaisesRegex(importer.ImportError_, "no media files"):
            self.plan()

    def test_config_delete_can_be_disabled_explicitly(self):
        (self.base / "config.json").write_text(json.dumps({"delete_from_card": True}))
        source = self.media("frame.JPG")
        with contextlib.redirect_stdout(io.StringIO()):
            status = importer.main(["--library", str(self.library), "--source", str(self.card), "--no-delete-from-card"])
        self.assertEqual(status, 0)
        self.assertTrue(source.exists())

    def test_delete_on_store_requires_manifest_success(self):
        source = self.media("frame.JPG")
        remote = self.base / "store"
        remote.mkdir()
        with patch.object(store, "configured_store", return_value=remote), \
                patch.object(importer, "record", side_effect=OSError("manifest write failed")):
            with self.assertRaises(OSError):
                importer.place(source, self.library / "shoot" / "raw", True, delete_from_card=True)
        self.assertTrue(source.exists())

    def test_server_delete_progress_uses_size_before_removing_source(self):
        from framewright import server as studio
        source = self.media("frame.JPG")
        state = {"running": True, "copied": 0, "bytes": 0, "deleted": 0}
        with patch.object(studio, "_import", state):
            studio.run_import(self.library, self.card, False, True)
        self.assertFalse(state["running"])
        self.assertNotIn("error", state)
        self.assertEqual(state["bytes"], len(b"photograph"))
        self.assertEqual(state["deleted"], 1)
        self.assertFalse(source.exists())

    def test_reused_basenames_in_different_camera_directories_stay_separate(self):
        canon = self.media("DCIM/100CANON/IMG0001.JPG", exif("Canon", "R5"))
        nikon = self.media("DCIM/100NIKON/IMG0001.JPG", exif("Nikon", "Z8"))
        plan = self.plan(match="IMG000*")
        self.assertEqual(plan[self.library / "2026-03-15_canon-r5" / "raw"], [canon])
        self.assertEqual(plan[self.library / "2026-03-15_nikon-z8" / "raw"], [nikon])

    def test_failed_batch_keeps_every_source_for_retry(self):
        from framewright import server as studio
        photo = self.media("frame.JPG")
        sidecar = self.media("frame.XMP", b"sidecar")
        real_place = importer.place
        def fail_sidecar(src, dest, to_store):
            if src == sidecar:
                raise OSError("card read failed")
            real_place(src, dest, to_store)
        state = {"running": True, "copied": 0, "bytes": 0, "deleted": 0}
        with patch.object(studio, "_import", state), patch.object(studio, "place", side_effect=fail_sidecar):
            studio.run_import(self.library, self.card, False, True)
        self.assertIn("card read failed", state["error"])
        self.assertTrue(photo.exists())
        self.assertTrue(sidecar.exists())
        self.assertEqual([p for files in self.plan().values() for p in files], [sidecar])

    def test_changed_copy_blocks_source_deletion(self):
        source = self.media("frame.JPG")
        dest = self.library / "shoot" / "raw"
        importer.place(source, dest, False)
        (dest / source.name).write_bytes(b"changed copy")
        with self.assertRaisesRegex(importer.ImportError_, "copy changed"):
            importer.delete_verified_source(source, dest, False)
        self.assertTrue(source.exists())

    def test_custom_folder_dates_work_in_library_and_collections(self):
        from framewright import server as studio
        for name in ("z-camera_2026-03-14", "a-camera_2026-03-16", "2026-03-15_camera"):
            raw = self.library / name / "raw"
            raw.mkdir(parents=True)
            (raw / "frame.JPG").write_bytes(b"photo")
        self.assertEqual(studio.list_shoots(self.library), ["a-camera_2026-03-16", "2026-03-15_camera", "z-camera_2026-03-14"])
        self.assertEqual(studio.collection_shoots(self.library, {"days": {"from": "2026-03-14", "to": "2026-03-15"}}),
                         ["z-camera_2026-03-14", "2026-03-15_camera"])

    def test_windows_card_search_includes_only_removable_drives(self):
        with patch.object(importer.sys, "platform", "win32"), patch.object(importer, "windows_removable", side_effect=lambda root: root == "E:\\"):
            self.assertEqual(importer.candidate_card_roots(), [Path("E:\\")])


if __name__ == "__main__":
    unittest.main()
