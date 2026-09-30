"""File-manager sending is local and never shells out user-provided commands."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from framewright import server as studio


class RevealTests(unittest.TestCase):
    def test_reveal_groups_exports_by_folder_and_preserves_literal_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            files = [folder / 'a $(echo bad).jpg', folder / 'b.jpg']
            for path in files:
                path.write_bytes(b'export')
            with patch.object(studio.sys, 'platform', 'darwin'), patch.object(studio.subprocess, 'run') as run:
                run.return_value.returncode = 0
                studio.reveal_exports(files)
                self.assertEqual(run.call_count, 1)
                self.assertEqual(run.call_args.args[0], ['open', '-R', str(files[0].resolve())])
                self.assertNotIn('shell', run.call_args.kwargs)

    def test_missing_export_never_launches(self):
        with patch.object(studio.subprocess, 'run') as run:
            with self.assertRaises(ValueError):
                studio.reveal_exports([Path('/nonexistent/framewright/export.jpg')])
            run.assert_not_called()
