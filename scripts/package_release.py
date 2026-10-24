#!/usr/bin/env python3
"""Build a deterministic, self-validating TorranceTabs release archive."""

from __future__ import print_function

import argparse
import hashlib
import io
import json
import os
import stat
import sys
import tempfile
import zipfile
from pathlib import Path

import manage


ARCHIVE_PREFIX = "TorranceTabs-v"
FIXED_TIME = (1980, 1, 1, 0, 0, 0)


def configure_utf8_output():
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name)
        buffer = getattr(stream, "buffer", None)
        if buffer is not None:
            setattr(sys, name, io.TextIOWrapper(buffer, encoding="utf-8", errors="backslashreplace", line_buffering=True))


def collect_extension(repo, version):
    extension = repo / "extension"
    _root, files, actual = manage.inspect_source_directory(extension, version)
    if actual != version:
        raise manage.ManageError("扩展版本与发布版本不一致。")
    return [(path, "extension/%s" % relative.as_posix(), 0o644) for path, relative in files]


def release_files(repo, version):
    entries = collect_extension(repo, version)
    for relative, mode in (
        ("LICENSE", 0o644),
        ("install.sh", 0o755),
        ("uninstall.sh", 0o755),
        ("scripts/manage.py", 0o755),
        ("scripts/package_release.py", 0o755),
    ):
        path = repo / relative
        if path.is_symlink() or not path.is_file():
            raise manage.ManageError("发布入口缺失或不是普通文件：%s" % relative)
        entries.append((path, relative, mode))
    entries.append((None, "VERSION", 0o644))
    return sorted(entries, key=lambda entry: entry[1])


def add_bytes(bundle, archive_name, payload, mode):
    info = zipfile.ZipInfo(archive_name, FIXED_TIME)
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | mode) << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    bundle.writestr(info, payload)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build(repo, output_dir, version):
    version = manage.require_version(version)
    version_file = repo / "VERSION"
    if version_file.is_symlink() or not version_file.is_file():
        raise manage.ManageError("仓库缺少普通文件 VERSION。")
    if version_file.read_text(encoding="ascii").strip() != version:
        raise manage.ManageError("仓库 VERSION 与发布版本不一致。")
    package_file = repo / "extension" / "package.json"
    if package_file.is_symlink() or not package_file.is_file():
        raise manage.ManageError("扩展缺少普通文件 package.json。")
    try:
        package_version = json.loads(package_file.read_text(encoding="utf-8")).get("version")
    except (ValueError, AttributeError) as error:
        raise manage.ManageError("package.json 无效：%s" % error)
    if package_version != version:
        raise manage.ManageError("package.json 与发布版本不一致。")
    entries = release_files(repo, version)
    output_dir.mkdir(parents=True, exist_ok=True)
    archive_name = "%s%s.zip" % (ARCHIVE_PREFIX, version)
    archive = output_dir / archive_name
    sidecar = output_dir / (archive_name + ".sha256")
    descriptor, temporary_name = tempfile.mkstemp(prefix=".%s." % archive_name, dir=str(output_dir))
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(str(temporary), "w", compression=zipfile.ZIP_DEFLATED) as bundle:
            for path, archive_path, mode in entries:
                payload = (version + "\n").encode("ascii") if path is None else path.read_bytes()
                add_bytes(bundle, archive_path, payload, mode)
        digest = sha256(temporary)
        check, _names = manage.inspect_zip(temporary)
        check.close()
        os.replace(str(temporary), str(archive))
        sidecar.write_text("%s  %s\n" % (digest, archive.name), encoding="ascii")
    finally:
        if temporary.exists():
            temporary.unlink()
    print("发布包：%s" % archive)
    print("SHA-256：%s" % sidecar)
    return archive, sidecar


def parser():
    result = argparse.ArgumentParser(description="构建 TorranceTabs release ZIP")
    result.add_argument("--version", required=True, help="数字版本，例如 1.5.0")
    result.add_argument("--output-dir", default="dist", help="输出目录，默认 dist")
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    repo = Path(__file__).resolve().parent.parent
    output = Path(args.output_dir).expanduser()
    if not output.is_absolute():
        output = Path.cwd() / output
    try:
        build(repo, output, args.version)
        return 0
    except (manage.ManageError, OSError, zipfile.BadZipFile) as error:
        print("错误：%s" % error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    configure_utf8_output()
    sys.exit(main())
