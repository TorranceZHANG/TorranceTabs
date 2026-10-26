import json
import struct
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))
import package_store


class StorePackageTests(unittest.TestCase):
    def test_store_zip_has_root_manifest_all_assets_and_no_development_files(self):
        with tempfile.TemporaryDirectory() as directory:
            archive, sidecar = package_store.build(ROOT, Path(directory))
            with zipfile.ZipFile(str(archive)) as bundle:
                names = set(bundle.namelist())
                self.assertIn('manifest.json', names)
                self.assertFalse(any(name.startswith(('extension/', 'tests/', 'review/', 'scripts/')) for name in names))
                self.assertIsNone(bundle.testzip())
                manifest = json.loads(bundle.read('manifest.json').decode('utf-8'))
                self.assertNotIn('chrome_url_overrides', manifest)
                self.assertLessEqual(sum('suggested_key' in command for command in manifest['commands'].values()), 4)
                for path in [manifest['background']['service_worker'], manifest['action']['default_popup'],
                             manifest['options_ui']['page'], manifest['side_panel']['default_path']]:
                    self.assertIn(path, names)
                for size, path in manifest['icons'].items():
                    data = bundle.read(path)
                    self.assertEqual(data[:8], b'\x89PNG\r\n\x1a\n')
                    self.assertEqual(struct.unpack('>II', data[16:24]), (int(size), int(size)))
                for name in names:
                    self.assertNotIn('__pycache__', name)
                    self.assertNotIn('.test.', name)
            self.assertEqual(sidecar.read_text(encoding='ascii').split()[0], package_store.sha256(archive))


if __name__ == '__main__':
    unittest.main()
