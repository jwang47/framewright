"""Opt-in real-browser LibRaw/WebGL smoke using a temporary synthetic DNG.

Run STUDIO_RAW_SMOKE=1 python -m unittest discover -s tests -p test_raw_smoke.py.
Chrome/Chromium (or CHROME) is required; no real photograph is read or written.
"""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from synthetic_dng import write_dng


@unittest.skipUnless(os.environ.get('STUDIO_RAW_SMOKE') == '1', 'set STUDIO_RAW_SMOKE=1 for browser integration')
class RawBrowserSmokeTests(unittest.TestCase):
    def test_synthetic_raw_decodes_and_renders_to_jpeg(self):
        project = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix='framewright-raw-smoke-') as tmp:
            root = Path(tmp)
            library = root / 'library'
            write_dng(library / '2026-01-01_synthetic' / 'raw' / 'gradient.DNG')
            output = root / 'render.jpg'
            env = {**os.environ, 'STUDIO_CONFIG': str(root / 'config.json'),
                   'STUDIO_LIBRARY': str(library), 'STUDIO_LUTS': str(root / 'luts')}
            command = ([sys.executable, '-m', 'framewright', 'render'] if (project / 'framewright').is_dir()
                       else [sys.executable, str(project / 'scripts' / 'render.py')])
            result = subprocess.run(command + ['2026-01-01_synthetic/gradient', '--library', str(library),
                                               '--recipe', 'none', '--full', '--max', '256', '--timeout', '90',
                                               '-o', str(output)], cwd=project, env=env, capture_output=True,
                                    text=True, timeout=110)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertNotIn('unavailable', result.stdout.lower())
            self.assertTrue(output.is_file(), result.stdout + result.stderr)
            data = output.read_bytes()
            self.assertTrue(data.startswith(b'\xff\xd8\xff'))
            self.assertTrue(data.endswith(b'\xff\xd9'))
            self.assertGreater(len(data), 1000)


if __name__ == '__main__':
    unittest.main()
