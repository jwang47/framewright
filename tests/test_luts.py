"""External LUT lookup and saved-look warnings; all assets are temporary."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from framewright import server as studio


class LutLookupTests(unittest.TestCase):
    def test_first_directory_wins_and_names_are_deduplicated(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            external, local = root / 'external', root / 'library' / 'luts'
            external.mkdir()
            local.mkdir(parents=True)
            (external / 'shared.cube').write_text('external')
            (local / 'shared.cube').write_text('local')
            (local / 'other.cube').write_text('local')
            (local / 'directory.cube').mkdir()
            with patch.object(studio, 'lut_directories', return_value=[root / 'absent', external, local]):
                self.assertEqual(studio.list_luts(root), ['other.cube', 'shared.cube'])
                self.assertEqual(studio.lut_files(root)['shared.cube'], external / 'shared.cube')
                self.assertNotIn('../shared.cube', studio.lut_files(root))

    def test_missing_look_stays_available_with_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            look = {'name': 'My look', 'params': {'lut': 'missing.cube'}}
            (root / studio.LOOKS_FILE).write_text(json.dumps({'looks': [look]}))
            with patch.object(studio, 'lut_directories', return_value=[]):
                self.assertEqual(studio.all_looks(root), [{**look, 'missingLut': 'missing.cube'}])
            self.assertEqual(studio.clean_look(look['params']), look['params'])
            self.assertEqual(studio.read_looks(root), [look])


class FingerprintAndInstallTests(unittest.TestCase):
    @staticmethod
    def cube():
        return ('LUT_' + '3D_SIZE 2\n' + '\n'.join(f'{i & 1} {(i >> 1) & 1} {(i >> 2) & 1}' for i in range(8))).encode()

    def test_hash_finds_renamed_and_shadowed_file_before_name(self):
        from framewright.luts import lut_hash
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first, second = root / 'first', root / 'second'
            first.mkdir(); second.mkdir()
            (first / 'same.cube').write_bytes(b'other')
            (second / 'same.cube').write_bytes(self.cube())
            with patch.object(studio, 'lut_directories', return_value=[first, second]):
                path, warning = studio.resolve_lut(root, 'renamed.cube', lut_hash(self.cube()))
                self.assertEqual(path, second / 'same.cube')
                self.assertEqual(warning, '')
                path, warning = studio.resolve_lut(root, 'same.cube', '0' * 16)
                self.assertEqual(path, first / 'same.cube')
                self.assertIn('mismatch', warning)

    def test_install_is_validated_external_and_never_overwrites(self):
        from framewright.luts import install_lut, validate_cube
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app, user = root / 'app', root / 'user'
            data = self.cube()
            installed = install_lut(user, 'test.cube', data, app)
            self.assertEqual(installed.read_bytes(), data)
            install_lut(user, 'test.cube', data, app)
            with self.assertRaises(ValueError):
                install_lut(user, 'test.cube', data + b'\n#different', app)
            self.assertEqual(installed.read_bytes(), data)
            for name in ('../escape.cube', 'bad\nname.cube', 'bad\\name.cube'):
                with self.assertRaises(ValueError):
                    install_lut(user, name, data, app)
            with self.assertRaises(ValueError):
                install_lut(app / 'luts', 'test.cube', data, app)
            for bad in (data.replace(b'0 0 0', b'nan 0 0'), data.replace(b'0 0 0', b'0 0'), data + b'\nDOMAIN_MAX 0 1 1', data.replace(b'3D_SIZE 2', b'3D_SIZE 2.5')):
                with self.assertRaises(ValueError):
                    validate_cube(bad)

    def test_hash_recipe_validation_and_original_examples(self):
        from framewright.luts import lut_hash
        params = {'lut': 'test.cube', 'lutHash': lut_hash(self.cube())}
        self.assertEqual(studio.clean_look(params), params)
        for bad in ({'lutHash': '0' * 16}, {'lut': 'test.cube', 'lutHash': 'ABC'}, {'lut': 'test.cube', 'lutHash': 42}):
            with self.assertRaises(ValueError):
                studio.clean_look(bad)
        examples = json.loads((Path(__file__).resolve().parents[1] / 'framewright/looks.example.json').read_text())
        for look in examples['looks']:
            self.assertNotIn('lut', look['params'])
            self.assertEqual(studio.clean_look(look['params']), look['params'])


class LutEndpointTests(unittest.TestCase):
    def test_upload_then_hashed_download_and_mismatch_header(self):
        import io
        from urllib.parse import quote
        from framewright.luts import lut_hash
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            folder = root / 'user'
            data = FingerprintAndInstallTests.cube()
            handler = object.__new__(studio.Handler)
            handler.root = root
            handler.path = '/api/luts/install?name=identity.cube'
            handler.headers = {'Content-Type': 'application/octet-stream', 'Content-Length': str(len(data))}
            handler.rfile = io.BytesIO(data)
            responses = []
            handler.send_json = lambda body, *args: responses.append(body)
            with patch.object(studio, 'user_lut_directory', return_value=folder), patch.object(studio, 'lut_directories', return_value=[folder]):
                handler.do_POST()
                self.assertEqual(responses[-1]['look']['params']['lutHash'], lut_hash(data))
                for fingerprint, expected_warning in ((lut_hash(data), False), ('0' * 16, True)):
                    handler.path = '/luts/identity.cube?hash=' + fingerprint
                    headers = {}
                    handler.send_response = lambda status: self.assertEqual(status, 200)
                    handler.send_header = lambda key, value: headers.update({key: value})
                    handler.end_headers = lambda: None
                    handler.wfile = io.BytesIO()
                    handler.do_GET()
                    self.assertEqual(handler.wfile.getvalue(), data)
                    self.assertEqual('X-LUT-Warning' in headers, expected_warning)
                handler.headers['Content-Length'] = str(65 * 1024 * 1024)
                handler.rfile = io.BytesIO(b'')
                handler.path = '/api/luts/install?name=too-big.cube'
                handler.do_POST()
                self.assertIn('64 MiB', responses[-1]['error'])

class LutSafetyReviewTests(unittest.TestCase):
    def test_bad_lengths_and_content_types_do_not_read_upload(self):
        import io
        handler = object.__new__(studio.Handler)
        handler.root = Path('.')
        handler.path = '/api/luts/install?name=test.cube'
        responses = []
        handler.send_json = lambda body, *args: responses.append(body)
        for length in ('-1', '+2', 'two', '', '9' * 100, '0', str(65 * 1024 * 1024)):
            handler.headers = {'Content-Type': 'application/octet-stream', 'Content-Length': length}
            handler.rfile = io.BytesIO(b'unchanged')
            handler.do_POST()
            self.assertIn('error', responses[-1])
            self.assertEqual(handler.rfile.tell(), 0)
        handler.headers = {'Content-Type': 'application/octet-stream-evil', 'Content-Length': '2'}
        handler.do_POST()
        self.assertIn('error', responses[-1])

    def test_symlink_install_targets_are_rejected(self):
        from framewright.luts import install_lut
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app, user = root / 'app', root / 'user'
            app.mkdir(); user.mkdir()
            link = root / 'linked'
            try:
                link.symlink_to(app, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest('symlinks unavailable')
            data = FingerprintAndInstallTests.cube()
            with self.assertRaises(ValueError):
                install_lut(link, 'test.cube', data, app)
            target = root / 'outside.cube'
            target.write_bytes(data)
            (user / 'test.cube').symlink_to(target)
            with self.assertRaises(ValueError):
                install_lut(user, 'test.cube', data, app)
            self.assertEqual(target.read_bytes(), data)

    def test_examples_are_used_once_and_preserved_on_first_save(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            examples = studio.read_looks(root)
            self.assertGreater(len(examples), 0)
            handler = object.__new__(studio.Handler)
            handler.root = root
            handler.send_json = lambda *args: None
            with patch.object(studio, 'lut_directories', return_value=[]):
                handler.api_looks('save', {'name': 'New look', 'params': {'grain': 1}})
                saved = studio.read_looks(root)
                self.assertEqual(len(saved), len(examples) + 1)
                for example in examples:
                    self.assertIn(example, saved)
                studio.write_looks(root, [])
                self.assertEqual(studio.read_looks(root), [])


def xmp_profile(n=2, dims=3, amount='1', table=None):
    """A synthetic look profile with an identity RGB table, encoded as Camera
    Raw does. Test data only, never a real film profile."""
    import struct
    import zlib
    from framewright.luts import XMP_ALPHABET
    body = struct.pack('<4I', 1, 1, dims, n) + bytes(n ** 3 * 6) + struct.pack('<2I', 1, 3) if table is None else table
    raw = struct.pack('<I', len(body)) + zlib.compress(body)
    text = ''
    for i in range(0, len(raw), 4):
        chunk = raw[i:i + 4]
        value = int.from_bytes(chunk, 'little')
        for _ in range(len(chunk) + 1):
            text += XMP_ALPHABET[value % 85]
            value //= 85
    text = text.replace('&', '&amp;').replace('"', '&quot;').replace('<', '&lt;').replace('>', '&gt;')
    digest = '0123456789ABCDEF' * 2
    return (f'<x:xmpmeta><rdf:RDF><rdf:Description crs:RGBTable="{digest}" crs:{"Table"}_{digest}="{text}" '
            f'crs:RGBTableAmount="{amount}"/></rdf:RDF></x:xmpmeta>').encode()


class LookProfileTests(unittest.TestCase):
    def test_profiles_validate_list_and_install_beside_cubes(self):
        from framewright.luts import install_lut, validate_lut
        validate_lut('look.xmp', xmp_profile())
        validate_lut('look.xmp', xmp_profile(n=32, amount='0.9'))
        for bad in (b'<x:xmpmeta/>', xmp_profile(dims=1), xmp_profile(amount='nan'),
                    xmp_profile(table=b'\x01\x00\x00\x00'), xmp_profile().replace(b'crs:Table', b'crs:Tabel')):
            with self.assertRaises(ValueError):
                validate_lut('look.xmp', bad)
        with self.assertRaises(ValueError):
            validate_lut('look.cube', xmp_profile())
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app, user = root / 'app', root / 'user'
            install_lut(user, 'Film.xmp', xmp_profile(), app)
            (user / 'shoot.ARW.xmp').mkdir()
            (user / 'notes.txt').write_text('x')
            with self.assertRaises(ValueError):
                install_lut(user, 'Other.xmp', b'<x:xmpmeta/>', app)
            with patch.object(studio, 'lut_directories', return_value=[user]):
                self.assertEqual(studio.list_luts(root), ['Film.xmp'])
            self.assertEqual(studio.clean_look({'lut': 'Film.xmp'}), {'lut': 'Film.xmp'})


if __name__ == '__main__':
    unittest.main()
