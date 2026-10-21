"""Migrating an old library copies work into the current one without overwriting."""
import contextlib
import io
import tempfile
import unittest
from pathlib import Path

from framewright import migrate


class MigrateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.old, self.new = base / "old", base / "new"
        raw = self.old / "2026-01-01_camera" / "raw"
        raw.mkdir(parents=True)
        (raw / "FRAME0001.edit.json").write_text('{"version": 1}')
        (raw / "FRAME0001.ARW").write_bytes(b"raw")
        (self.old / "2026-01-01_camera" / "picks.txt").write_text("FRAME0001\n")
        (self.old / ".git").mkdir()
        (self.old / ".git" / "HEAD").write_text("ref")

    def run_migrate(self, *extra):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = migrate.main([str(self.old), "--library", str(self.new), *extra])
        return code, out.getvalue()

    def test_dry_run_writes_nothing(self):
        code, out = self.run_migrate("--dry-run")
        self.assertEqual(code, 0)
        self.assertIn("would copy 3 file(s)", out)
        self.assertFalse(self.new.exists())

    def test_copies_work_and_keeps_existing_files(self):
        kept = self.new / "2026-01-01_camera" / "picks.txt"
        kept.parent.mkdir(parents=True)
        kept.write_text("FRAME0002\n")
        code, out = self.run_migrate("--metadata-only")
        self.assertEqual(code, 0)
        self.assertEqual((self.new / "2026-01-01_camera/raw/FRAME0001.edit.json").read_text(), '{"version": 1}')
        self.assertFalse((self.new / "2026-01-01_camera/raw/FRAME0001.ARW").exists())
        self.assertFalse((self.new / ".git").exists())
        self.assertEqual(kept.read_text(), "FRAME0002\n")
        self.assertIn("1 differing file(s) left alone", out)
        self.assertTrue((self.old / "2026-01-01_camera/raw/FRAME0001.ARW").exists())

    def test_refuses_checkout_and_nested_libraries(self):
        with self.assertRaisesRegex(ValueError, "contain each other"):
            migrate.plan(self.old, self.old / "inner", False)
        (self.old / "framewright").mkdir()
        (self.old / "framewright" / "server.py").write_text("")
        with self.assertRaisesRegex(ValueError, "app checkout"):
            migrate.plan(self.old, self.new, False)


if __name__ == "__main__":
    unittest.main()
