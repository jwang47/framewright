import importlib.util
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location(
    "check_release", Path(__file__).resolve().parents[1] / "tools" / "check_release.py")
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)


def png(width, height):
    return guard.PNG + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", width, height)


class ContentTests(unittest.TestCase):
    def test_lut_extensions_and_renamed_header(self):
        for path in ("scripts/test.CUBE", "docs/samples/test.3DL"):
            self.assertTrue(guard.violations(path, b""))
        for header in (b"LUT_3D_SIZE 33\n", b"  LUT_3D_SIZE\t17 # comment\r\n",
                       b"\xef\xbb\xbfLUT_3D_SIZE 33\n"):
            self.assertTrue(guard.violations("scripts/disguised.txt", header))

    def test_parser_strings_and_documentation_are_not_headers(self):
        self.assertFalse(guard.violations("scripts/parser.py", b'if key == "LUT_3D_SIZE":\n'))
        self.assertFalse(guard.violations("README.md", b"Reject LUT_3D_SIZE headers.\n"))

    def test_images_and_signature_detection(self):
        for path, data in (("scripts/photo.JPG", b""), ("scripts/data.bin", png(10, 12)),
                           ("scripts/hidden", b"\xff\xd8\xff\xe0"),
                           ("scripts/hidden", b"RIFF0000WEBP")):
            self.assertTrue(guard.violations(path, data))
        self.assertFalse(guard.violations("docs/samples/photo.png", png(10, 12)))
        self.assertTrue(guard.violations("docs/samples-other/photo.png", png(10, 12)))

    def test_hald_rejected_even_in_samples(self):
        for size in (8, 27, 64, 512, 4096):
            self.assertTrue(guard.violations("docs/samples/neutral.png", png(size, size)))
        self.assertTrue(guard.violations("docs/samples/my-Hald.png", png(10, 12)))
        self.assertFalse(guard.hald_png(png(512, 513)))

    def test_allowlist_boundary(self):
        for path in ("scripts/app.py", "studio/app.py", "tests/test.py", "README.md",
                     ".githooks/pre-commit", ".github/workflows/checks.yml"):
            self.assertTrue(guard.is_public(path), path)
        for path in ("shoots/luts/private.cube", "GEAR.md", "TRIPS.md", "release-plan.md"):
            self.assertFalse(guard.is_public(path), path)


@unittest.skipUnless(shutil.which("git"), "Git required")
class IndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        self.git("config", "core.autocrlf", "false")
        self.git("config", "core.safecrlf", "false")

    def git(self, *args):
        subprocess.run(["git", "-C", str(self.root), *args], check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def write(self, path, content):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(content)

    def test_partial_staging_checks_index_blob(self):
        self.write("scripts/data.txt", b"LUT_3D_SIZE 33\n")
        self.git("add", ".")
        self.write("scripts/data.txt", b"clean working tree\n")
        self.assertTrue(guard.check(self.root, staged=True)[1])
        self.assertFalse(guard.check(self.root)[1])

    def test_private_scope_and_full_export_scope(self):
        self.write("shoots/luts/private.cube", b"LUT_3D_SIZE 33\n")
        self.write("scripts/good.py", b"print('ok')\n")
        self.git("add", ".")
        self.assertEqual(guard.check(self.root, staged=True), (1, []))
        self.assertTrue(guard.check(self.root, staged=True, all_files=True)[1])

    def test_staged_deletions_are_absent(self):
        self.write("scripts/bad.cube", b"bad")
        self.git("add", ".")
        self.git("rm", "--cached", "scripts/bad.cube")
        self.assertEqual(guard.check(self.root, staged=True), (0, []))


if __name__ == "__main__":
    unittest.main()
