"""Library separation and safe optional storage regression coverage."""
import json
import contextlib
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from framewright import import_photos
from framewright import store


class LibraryStoreTests(unittest.TestCase):
    def test_malformed_config_reports_error_without_traceback(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "config.json"
            config.write_text("{invalid json", encoding="utf-8")
            card = Path(tmp) / "card"
            card.mkdir()
            (card / "frame.JPG").write_bytes(b"photo")
            with patch.dict(os.environ, {"STUDIO_CONFIG": str(config)}, clear=True):
                for args in ([], ["--library", str(Path(tmp) / "library"), "--source", str(card)]):
                    error = io.StringIO()
                    with contextlib.redirect_stderr(error):
                        self.assertEqual(import_photos.main(args), 1)
                    self.assertIn("cannot read settings", error.getvalue())
                    self.assertNotIn("Traceback", error.getvalue())
                with contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaises(SystemExit) as exit_:
                        import_photos.main(["--help"])
                self.assertEqual(exit_.exception.code, 0)

    @unittest.skipUnless(os.name == "nt", "Windows drive mount layout")
    def test_windows_drive_root_must_be_mounted(self):
        root = Path("Z:/photos")
        with patch.object(store.os.path, "ismount", return_value=False):
            self.assertFalse(store.store_mounted(root))
        with patch.object(store.os.path, "ismount", side_effect=lambda p: p == Path(root.anchor)), \
                patch.object(Path, "is_dir", return_value=True):
            self.assertTrue(store.store_mounted(root))
        with patch.object(store.os.path, "ismount", return_value=True), \
                patch.object(Path, "is_dir", return_value=False):
            self.assertFalse(store.store_mounted(root))

    def test_unconfigured_import_requires_library(self):
        with patch.object(import_photos, "resolve_library", return_value=None):
            with self.assertRaisesRegex(import_photos.ImportError_, "no library configured"):
                import_photos.default_library()

    def test_import_uses_selected_library_even_with_shoots_subfolder(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            library, card = base / "library", base / "card"
            (library / "shoots").mkdir(parents=True)
            card.mkdir()
            (card / "frame.JPG").write_bytes(b"camera jpeg")
            planned = import_photos.plan(card, library, "camera", None, False)
            self.assertEqual(len(planned), 1)
            self.assertEqual(next(iter(planned)).parent.parent, library)

    def test_unconfigured_store_preserves_offline_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            shoot = Path(tmp) / "2026-01-01_camera"
            shoot.mkdir()
            (shoot / "store.json").write_text(json.dumps({
                "files": {"raw/frame.JPG": {"size": 100, "mtime": 123.0}}
            }))
            with patch.object(store, "configured_store", return_value=None):
                self.assertFalse(store.store_mounted())
                frames = store.stored(shoot)
                self.assertEqual(frames["frame.JPG"][1], 123.0)
                self.assertFalse(frames["frame.JPG"][0].exists())
                self.assertIn("frame", import_photos.imported_frames(Path(tmp)))

    def test_unconfigured_store_never_writes_or_removes_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            src = base / "frame.JPG"
            src.write_bytes(b"photo")
            shoot = base / "library" / "2026-01-01_camera"
            with patch.object(store, "configured_store", return_value=None):
                for operation in (
                    lambda: import_photos.place(src, shoot / "raw", True),
                    lambda: import_photos.offload_file(shoot, "raw", src),
                ):
                    with self.assertRaisesRegex(import_photos.ImportError_, "no store configured"):
                        operation()
            self.assertEqual(src.read_bytes(), b"photo")
            self.assertFalse(shoot.exists())

    @unittest.skipUnless(os.name == "posix", "POSIX mount layout")
    def test_orphan_removable_paths_are_unavailable_even_if_directory_exists(self):
        with patch.object(store.os.path, "ismount", return_value=False), \
                patch.object(Path, "is_dir", return_value=True):
            for root in ("/Volumes/Card/photos", "/media/user/Card/photos", "/run/media/user/Card/photos"):
                self.assertFalse(store.store_mounted(Path(root)), root)

    @unittest.skipUnless(os.name == "posix", "POSIX mount layout")
    def test_parent_filesystem_mount_does_not_make_removable_drive_available(self):
        with patch.object(store.os.path, "ismount", side_effect=lambda p: p == Path("/run")):
            self.assertFalse(store.store_mounted(Path("/run/media/user/Card/photos")))

    @unittest.skipUnless(os.name == "posix", "POSIX mount layout")
    def test_present_removable_mount_allows_new_store_folder(self):
        with patch.object(store.os.path, "ismount", side_effect=lambda p: p == Path("/Volumes/Card")):
            self.assertTrue(store.store_mounted(Path("/Volumes/Card/photos")))

    @unittest.skipUnless(os.name == "posix", "POSIX mount layout")
    def test_existing_ordinary_folder_is_supported(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(store.os.path, "ismount", return_value=False):
            self.assertTrue(store.store_mounted(Path(tmp)))
            self.assertFalse(store.store_mounted(Path(tmp) / "absent"))

    def test_offload_to_configured_folder_verifies_and_records_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            shoot = base / "library" / "2026-01-01_camera"
            (shoot / "raw").mkdir(parents=True)
            src = shoot / "raw" / "frame.JPG"
            src.write_bytes(b"verified photograph")
            remote = base / "store"
            remote.mkdir()
            with patch.object(store, "configured_store", return_value=remote):
                import_photos.offload_file(shoot, "raw", src)
            self.assertFalse(src.exists())
            self.assertEqual((remote / shoot.name / "raw" / src.name).read_bytes(), b"verified photograph")
            self.assertEqual(store.read_manifest(shoot)["raw/frame.JPG"]["size"], 19)

    def _check_offload_alias(self, alias_kind):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            library = base / "library"
            shoot = library / "2026-01-01_camera"
            (shoot / "raw").mkdir(parents=True)
            src = shoot / "raw" / "frame.JPG"
            src.write_bytes(b"irreplaceable photograph")
            manifest = shoot / "store.json"
            original_manifest = '{"files": {}}\n'
            manifest.write_text(original_manifest)
            remote = library if alias_kind == "same" else base / "store"
            if alias_kind == "symlink":
                try:
                    remote.symlink_to(library, target_is_directory=True)
                except (OSError, NotImplementedError):
                    self.skipTest("directory symlinks unavailable")
            elif alias_kind == "hardlink":
                remote_file = remote / shoot.name / "raw" / src.name
                remote_file.parent.mkdir(parents=True)
                try:
                    os.link(src, remote_file)
                except (OSError, NotImplementedError):
                    self.skipTest("hardlinks unavailable")
            with patch.object(store, "configured_store", return_value=remote):
                with self.assertRaisesRegex(import_photos.ImportError_, "same file"):
                    import_photos.offload_file(shoot, "raw", src)
            self.assertEqual(src.read_bytes(), b"irreplaceable photograph")
            self.assertEqual(manifest.read_text(), original_manifest)
            self.assertFalse((src.parent / (src.name + ".part")).exists())

    def test_offload_same_library_preserves_source_and_manifest(self):
        self._check_offload_alias("same")

    def test_offload_symlink_alias_preserves_source_and_manifest(self):
        self._check_offload_alias("symlink")

    def test_offload_hardlink_alias_preserves_source_and_manifest(self):
        self._check_offload_alias("hardlink")

    def test_local_import_rejects_copy_to_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "frame.JPG"
            src.write_bytes(b"original")
            with self.assertRaisesRegex(import_photos.ImportError_, "same file"):
                import_photos.place(src, src.parent, False)
            self.assertEqual(src.read_bytes(), b"original")
            self.assertEqual(list(Path(tmp).iterdir()), [src])

    def test_corrupt_manifest_is_not_overwritten_by_offload(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            shoot = base / "library" / "shoot"
            (shoot / "raw").mkdir(parents=True)
            src = shoot / "raw" / "frame.JPG"
            src.write_bytes(b"original")
            manifest = shoot / "store.json"
            manifest.write_text("{malformed")
            remote = base / "store"
            remote.mkdir()
            with patch.object(store, "configured_store", return_value=remote):
                with self.assertRaises(ValueError):
                    import_photos.offload_file(shoot, "raw", src)
            self.assertTrue(src.exists())
            self.assertEqual(manifest.read_text(), "{malformed")

    def test_stale_partial_hardlink_does_not_truncate_unrelated_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            src = base / "frame.JPG"
            src.write_bytes(b"new photo")
            other = base / "other.JPG"
            other.write_bytes(b"unrelated original")
            dest = base / "destination"
            dest.mkdir()
            try:
                os.link(other, dest / "frame.JPG.part")
            except (OSError, NotImplementedError):
                self.skipTest("hardlinks unavailable")
            import_photos.copy_verified(src, dest)
            self.assertEqual(other.read_bytes(), b"unrelated original")
            self.assertEqual((dest / src.name).read_bytes(), b"new photo")

    def test_offline_drive_blocks_copy_even_after_import_planning(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "frame.JPG"
            src.write_bytes(b"photo")
            destination = Path(tmp) / "shoot" / "raw"
            with patch.object(store, "configured_store", return_value=Path(tmp) / "unmounted"), \
                    patch.object(store.os.path, "ismount", return_value=False):
                with self.assertRaisesRegex(import_photos.ImportError_, "not available"):
                    import_photos.place(src, destination, True)
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
