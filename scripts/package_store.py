#!/usr/bin/env python3
"""Build a Chrome Web Store ZIP with manifest.json at its root."""
from __future__ import print_function
import json
import os
import tempfile
import zipfile
from pathlib import Path
import manage
from package_release import add_bytes, configure_utf8_output, sha256


def build(repo, output_dir):
    version = manage.require_version((repo / 'VERSION').read_text(encoding='ascii').strip())
    _root, files, _version = manage.inspect_source_directory(repo / 'extension', version)
    output_dir.mkdir(parents=True, exist_ok=True)
    archive = output_dir / ('TorranceTabs-store-v%s.zip' % version)
    descriptor, temporary_name = tempfile.mkstemp(prefix='.store-', dir=str(output_dir))
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(str(temporary), 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
            for path, relative in sorted(files, key=lambda entry: entry[1].as_posix()):
                add_bytes(bundle, relative.as_posix(), path.read_bytes(), 0o644)
        with zipfile.ZipFile(str(temporary)) as bundle:
            manifest = json.loads(bundle.read('manifest.json').decode('utf-8'))
            if manifest.get('version') != version or 'chrome_url_overrides' in manifest:
                raise manage.ManageError('Invalid store manifest')
            if '128' not in manifest.get('icons', {}):
                raise manage.ManageError('Missing store icon')
            if bundle.testzip() is not None:
                raise manage.ManageError('Invalid store ZIP')
        os.replace(str(temporary), str(archive))
    finally:
        if temporary.exists():
            temporary.unlink()
    sidecar = archive.with_name(archive.name + '.sha256')
    sidecar.write_text('%s  %s\n' % (sha256(archive), archive.name), encoding='ascii')
    print('Chrome Web Store ZIP: %s' % archive)
    return archive, sidecar


if __name__ == '__main__':
    configure_utf8_output()
    root = Path(__file__).resolve().parent.parent
    build(root, root / 'dist')
