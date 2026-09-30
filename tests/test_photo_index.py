"""Source indexing must stay accurate without rescanning for every request."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from concurrent.futures import ThreadPoolExecutor

from framewright.photo_index import PhotoIndex
from framewright.server import Handler, _scan_image_files, frame_key, RAW_EXTS, JPEG_EXTS


class PhotoIndexTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.day = self.root / 'day'
        (self.day / 'raw').mkdir(parents=True)
        self.store = patch('framewright.store.store_root', return_value=None)
        self.store.start()
        self.addCleanup(self.store.stop)
        self.scan = Mock(wraps=_scan_image_files)
        self.index = PhotoIndex(self.scan, frame_key, RAW_EXTS, JPEG_EXTS)

    def photo(self, name, day=None):
        p = (day or self.day) / 'raw' / name
        p.write_bytes(b'synthetic photo')
        return p

    def test_reuses_snapshot_and_deduplicates_raw_jpeg(self):
        raw = self.photo('pair.DNG')
        jpeg = self.photo('pair.JPG')
        self.photo('other.JPG')
        first = self.index.get(self.day)
        for _ in range(20):
            self.assertIs(self.index.get(self.day), first)
        self.assertEqual(self.scan.call_count, 1)
        self.assertEqual(len(first.sources), 2)
        self.assertEqual(first.sources['pair'], jpeg)
        self.assertEqual(first.raws['pair'], raw)
        with self.assertRaises(TypeError):
            first.sources['bad'] = raw

    def test_add_remove_and_rename_refresh_on_next_lookup(self):
        self.photo('first.JPG')
        self.index.get(self.day)
        second = self.photo('second.JPG')
        self.assertEqual(set(self.index.get(self.day).sources), {'first', 'second'})
        second.rename(second.with_name('renamed.JPG'))
        self.assertEqual(set(self.index.get(self.day).sources), {'first', 'renamed'})
        (self.day / 'raw' / 'first.JPG').unlink()
        self.assertEqual(set(self.index.get(self.day).sources), {'renamed'})

    def test_offload_manifest_and_store_configuration_refresh(self):
        self.photo('local.JPG')
        first = self.index.get(self.day)
        (self.day / 'store.json').write_text(json.dumps({'files': {
            'raw/offline.DNG': {'mtime': 7, 'size': 14},
            'raw/offline.JPG': {'mtime': 7, 'size': 14},
        }}))
        offline = self.index.get(self.day)
        self.assertIsNot(offline, first)
        self.assertEqual(set(offline.sources), {'local', 'offline'})
        self.assertIn('.offline-store', str(offline.sources['offline']))
        with patch('framewright.store.store_root', return_value=self.root / 'drive'):
            moved = self.index.get(self.day, self.root / 'drive')
        self.assertEqual(moved.sources['offline'], self.root / 'drive' / 'day' / 'raw' / 'offline.JPG')

    def test_in_place_changes_refresh_after_interval(self):
        photo = self.photo('first.JPG')
        with patch('framewright.photo_index.monotonic', return_value=1):
            first = self.index.get(self.day)
        # In-place file writes need not update the directory timestamp.
        photo.write_bytes(b'changed synthetic contents')
        with patch('framewright.photo_index.monotonic', return_value=32):
            refreshed = self.index.get(self.day)
        self.assertIsNot(refreshed, first)
        self.assertEqual(refreshed.files[photo], photo.stat().st_mtime)

    def test_libraries_are_isolated_and_deleted_days_are_pruned(self):
        self.photo('first.JPG')
        other = self.root / 'other-library' / 'day'
        (other / 'raw').mkdir(parents=True)
        self.photo('second.JPG', other)
        self.index.get(self.day)
        second = self.index.get(other)
        self.assertEqual(set(second.sources), {'second'})
        self.index.retain(self.root, [])
        self.assertNotIn(self.day, self.index.entries)
        self.assertIs(self.index.get(other), second)

    def test_concurrent_requests_share_one_scan(self):
        self.photo('first.JPG')
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.index.get(self.day), range(32)))
        self.assertEqual(self.scan.call_count, 1)
        self.assertTrue(all(result is results[0] for result in results))

    def test_search_checks_edit_files_only_for_returned_results(self):
        for i in range(100):
            self.photo(f'photo-{i:03}.JPG')
        handler = Handler.__new__(Handler)
        handler.root = self.root
        handler.send_json = Mock()
        with patch('framewright.server._photo_index', self.index), \
                patch('framewright.server.configured_store', return_value=None), \
                patch('framewright.server.edit_path') as edit:
            edit.return_value.is_file.return_value = False
            handler.api_search('photo')
            self.assertEqual(edit.call_count, 40)
        result = handler.send_json.call_args.args[0]
        self.assertEqual(result['total'], 100)
        self.assertEqual(len(result['results']), 40)
        self.assertEqual(result['results'][0]['key'], 'photo-000')
        self.assertEqual(self.scan.call_count, 1)
