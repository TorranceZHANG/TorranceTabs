#!/usr/bin/env python3
"""Safe local installer and uninstaller for TorranceTabs.

This module intentionally uses only the Python standard library and never edits
Chrome profiles, preferences, policies, or extension registrations.
"""

from __future__ import print_function

import argparse
import errno
import fcntl
import hashlib
import io
import json
import os
import platform
import re
import shutil
import stat
import sys
import tempfile
import time
import uuid
import zipfile
from pathlib import Path, PurePosixPath


PROJECT_ID = "TorranceZHANG/TorranceTabs"
OWNER_FILE = ".torrance-tabs-owner.json"
OWNER_SCHEMA = 1
TRANSACTION_FILE = ".TorranceTabs.transaction.json"
TRANSACTION_SCHEMA = 1
VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
INSTALL_ID_RE = re.compile(r"^[0-9a-f]{32}$")
MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
MAX_EXPANDED_BYTES = 64 * 1024 * 1024
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_FILES = 512
MAX_COMPRESSION_RATIO = 500
EXCLUDED_EXTENSION_PARTS = {"tests"}
EXCLUDED_EXTENSION_FILES = {"README.md", "package.json"}
RELEASE_REQUIRED = {
    "VERSION",
    "LICENSE",
    "install.sh",
    "uninstall.sh",
    "scripts/manage.py",
    "extension/manifest.json",
}


class ManageError(Exception):
    pass


def configure_utf8_output():
    """Keep Chinese CLI diagnostics writable under an ASCII process locale."""
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name)
        buffer = getattr(stream, "buffer", None)
        if buffer is not None:
            setattr(sys, name, io.TextIOWrapper(buffer, encoding="utf-8", errors="backslashreplace", line_buffering=True))


def require_version(value):
    if not isinstance(value, str) or not VERSION_RE.match(value):
        raise ManageError("版本必须是数字格式，例如 1.5.0。")
    return value


def target_path(test_mode=False, test_root=None):
    if test_root and not test_mode:
        raise ManageError("--test-root 只能与 --test-mode 一起使用。")
    if test_mode:
        if not test_root:
            raise ManageError("--test-mode 必须提供 --test-root。")
        root = Path(test_root).expanduser()
        if not root.is_absolute() or ".." in root.parts:
            raise ManageError("测试根目录必须是无 .. 的绝对路径。")
        return root / "TorranceTabs"

    home = Path.home()
    system = platform.system()
    if system == "Darwin":
        return home / "Library" / "Application Support" / "TorranceTabs"
    if system == "Linux":
        xdg = os.environ.get("XDG_DATA_HOME")
        if xdg:
            base = Path(xdg).expanduser()
            if not base.is_absolute() or ".." in base.parts:
                raise ManageError("XDG_DATA_HOME 必须是无 .. 的绝对路径。")
        else:
            base = home / ".local" / "share"
        return base / "TorranceTabs"
    raise ManageError("当前仅支持 macOS 和 Linux。")


def check_target_shape(target):
    current = target
    while True:
        if current.is_symlink():
            raise ManageError("安装目录路径不能经过符号链接：%s" % current)
        if current == current.parent:
            break
        current = current.parent


def read_owner(target):
    check_target_shape(target)
    marker = target / OWNER_FILE
    if not target.exists():
        return None
    if not target.is_dir() or marker.is_symlink() or not marker.is_file():
        raise ManageError("目标位置已存在且不属于 TorranceTabs，已拒绝覆盖。")
    try:
        if marker.stat().st_size > 16 * 1024:
            raise ManageError("安装所有权标记异常。")
        data = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ManageError("无法验证现有安装的所有权：%s" % error)
    validate_owner_data(data)
    return data


def validate_owner_data(data):
    if not isinstance(data, dict) or data.get("project") != PROJECT_ID or data.get("schema") != OWNER_SCHEMA:
        raise ManageError("目标位置已存在且不属于 TorranceTabs，已拒绝覆盖。")
    require_version(data.get("version"))
    install_id = data.get("installId")
    if install_id is not None and (not isinstance(install_id, str) or not INSTALL_ID_RE.match(install_id)):
        raise ManageError("安装所有权标记的 installId 无效。")
    if not isinstance(data.get("installedAt"), int):
        raise ManageError("安装所有权标记的 installedAt 无效。")
    return data


def fsync_directory(path):
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    descriptor = os.open(str(path), flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fsync_tree(root):
    directories = []
    for directory, _children, files in os.walk(str(root), followlinks=False):
        directory_path = Path(directory)
        directories.append(directory_path)
        for filename in files:
            path = directory_path / filename
            descriptor = os.open(str(path), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    for directory in reversed(directories):
        fsync_directory(directory)


def transaction_path(target):
    return target.parent / TRANSACTION_FILE


def validate_transaction_name(value, prefix, allow_none=False):
    if value is None and allow_none:
        return None
    if not isinstance(value, str) or not value.startswith(prefix):
        raise ManageError("安装事务记录包含无效路径。")
    if value in ("", ".", "..") or "/" in value or "\\" in value or Path(value).name != value:
        raise ManageError("安装事务记录包含无效路径。")
    return value


def read_transaction(target):
    path = transaction_path(target)
    if not path.exists() and not path.is_symlink():
        return None
    if path.is_symlink() or not path.is_file():
        raise ManageError("安装事务记录不是普通文件。")
    try:
        if path.stat().st_size > 32 * 1024:
            raise ManageError("安装事务记录超过大小限制。")
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ManageError("安装事务记录损坏：%s" % error)
    if not isinstance(data, dict) or data.get("project") != PROJECT_ID or data.get("schema") != TRANSACTION_SCHEMA:
        raise ManageError("安装事务记录身份无效。")
    tx_id = data.get("txId")
    if not isinstance(tx_id, str) or not INSTALL_ID_RE.match(tx_id):
        raise ManageError("安装事务记录 txId 无效。")
    validate_transaction_name(data.get("stage"), ".TorranceTabs.stage-")
    old_owner = data.get("oldOwner")
    if old_owner is not None:
        validate_owner_data(old_owner)
        validate_transaction_name(data.get("backup"), "TorranceTabs.backup-v")
    elif data.get("backup") is not None:
        raise ManageError("首次安装事务不能指定 backup。")
    require_version(data.get("newVersion"))
    return data


def write_transaction(target, data):
    path = transaction_path(target)
    if path.exists() or path.is_symlink():
        raise ManageError("已有未处理的安装事务记录。")
    temporary = target.parent / ("%s.tmp-%s" % (TRANSACTION_FILE, uuid.uuid4().hex))
    payload = (json.dumps(data, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8")
    descriptor = None
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(str(temporary), flags, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = None
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(str(temporary), str(path))
        fsync_directory(target.parent)
    except OSError as error:
        if descriptor is not None:
            os.close(descriptor)
        try:
            temporary.unlink()
        except OSError:
            pass
        raise ManageError("无法持久化安装事务：%s" % error)


def clear_transaction(target):
    path = transaction_path(target)
    if not path.exists() and not path.is_symlink():
        return
    if path.is_symlink() or not path.is_file():
        raise ManageError("安装事务记录不是普通文件，拒绝取消。")
    try:
        path.unlink()
        fsync_directory(target.parent)
    except OSError as error:
        raise ManageError("无法持久取消安装事务：%s" % error)


class DirectoryLock(object):
    def __init__(self, target):
        self.path = target.parent / (".%s.lock" % target.name)
        self.stream = None

    def __enter__(self):
        descriptor = None
        try:
            flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(str(self.path), flags, 0o600)
            lock_stat = os.fstat(descriptor)
            if not stat.S_ISREG(lock_stat.st_mode) or lock_stat.st_nlink != 1:
                raise ManageError("安装锁必须是单一普通文件。")
            if hasattr(os, "getuid") and lock_stat.st_uid != os.getuid():
                raise ManageError("安装锁不属于当前用户。")
            self.stream = os.fdopen(descriptor, "r+")
            descriptor = None
            os.chmod(str(self.path), 0o600)
            fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.stream.seek(0)
            self.stream.truncate()
            self.stream.write(
                json.dumps({"project": PROJECT_ID, "pid": os.getpid(), "startedAt": int(time.time())}) + "\n"
            )
            self.stream.flush()
        except (ManageError, OSError) as error:
            if descriptor is not None:
                os.close(descriptor)
            self.release()
            if isinstance(error, ManageError):
                raise
            if error.errno in (errno.EACCES, errno.EAGAIN, errno.EWOULDBLOCK):
                raise ManageError("另一个安装或卸载任务正在运行；请稍后重试。")
            raise ManageError("无法取得安装锁：%s" % error)
        return self

    def release(self):
        if self.stream is not None:
            try:
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_UN)
            finally:
                self.stream.close()
                self.stream = None

    def __exit__(self, exc_type, exc_value, traceback):
        self.release()


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_checksum(archive, checksum_file):
    if not checksum_file:
        raise ManageError("安装 ZIP 必须同时提供 SHA-256 sidecar。")
    sidecar = Path(checksum_file)
    if sidecar.is_symlink() or not sidecar.is_file():
        raise ManageError("SHA-256 sidecar 不存在或不是普通文件。")
    try:
        line = sidecar.read_text(encoding="ascii").strip().splitlines()[0]
    except (OSError, UnicodeError, IndexError):
        raise ManageError("无法读取 SHA-256 sidecar。")
    expected = line.split()[0].lower() if line.split() else ""
    if not re.match(r"^[0-9a-f]{64}$", expected):
        raise ManageError("SHA-256 sidecar 格式无效。")
    actual = sha256_file(archive)
    if actual != expected:
        raise ManageError("安装包 SHA-256 校验失败。")


def safe_zip_name(name):
    if not name or "\\" in name or "\x00" in name:
        raise ManageError("ZIP 包含无效路径。")
    if name.startswith("/") or re.match(r"^[A-Za-z]:", name):
        raise ManageError("ZIP 包含绝对路径。")
    trimmed = name[:-1] if name.endswith("/") else name
    if any(part in ("", ".", "..") for part in trimmed.split("/")):
        raise ManageError("ZIP 包含路径穿越或不规范路径。")
    path = PurePosixPath(trimmed)
    if not trimmed:
        raise ManageError("ZIP 包含路径穿越或不规范路径。")
    return path


def inspect_zip(archive):
    if archive.is_symlink() or not archive.is_file():
        raise ManageError("安装 ZIP 不存在或不是普通文件。")
    if archive.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ManageError("安装 ZIP 超过大小限制。")
    try:
        bundle = zipfile.ZipFile(str(archive), "r")
    except (OSError, zipfile.BadZipFile) as error:
        raise ManageError("安装 ZIP 损坏：%s" % error)
    names = set()
    folded = set()
    total = 0
    try:
        infos = bundle.infolist()
        if len(infos) > MAX_FILES:
            raise ManageError("安装 ZIP 文件数量超过限制。")
        for info in infos:
            path = safe_zip_name(info.filename)
            key = str(path)
            folded_key = key.casefold()
            if key in names or folded_key in folded:
                raise ManageError("安装 ZIP 包含重复或大小写冲突路径。")
            names.add(key)
            folded.add(folded_key)
            if info.flag_bits & 0x1:
                raise ManageError("安装 ZIP 不能包含加密文件。")
            mode = (info.external_attr >> 16) & 0xFFFF
            file_type = stat.S_IFMT(mode)
            if file_type == stat.S_IFLNK:
                raise ManageError("安装 ZIP 不能包含符号链接。")
            if file_type not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ManageError("安装 ZIP 不能包含特殊文件。")
            if info.file_size > MAX_FILE_BYTES:
                raise ManageError("安装 ZIP 中单个文件超过大小限制。")
            total += info.file_size
            if total > MAX_EXPANDED_BYTES:
                raise ManageError("安装 ZIP 解压后超过大小限制。")
            if info.file_size and not info.compress_size:
                raise ManageError("安装 ZIP 压缩数据异常。")
            if info.file_size and info.file_size / float(info.compress_size) > MAX_COMPRESSION_RATIO:
                raise ManageError("安装 ZIP 压缩比异常。")
        missing = RELEASE_REQUIRED.difference(names)
        if missing:
            raise ManageError("安装 ZIP 不完整，缺少：%s" % ", ".join(sorted(missing)))
        for name in names:
            if name.startswith("extension/tests/") or name in {
                "extension/README.md",
                "extension/package.json",
            }:
                raise ManageError("安装 ZIP 混入了非生产文件。")
        return bundle, names
    except Exception:
        bundle.close()
        raise


def parse_manifest_bytes(raw):
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeError, ValueError) as error:
        raise ManageError("manifest.json 无效：%s" % error)


def safe_entrypoint(value):
    if not isinstance(value, str) or not value or "\\" in value:
        raise ManageError("manifest 入口路径无效。")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise ManageError("manifest 入口路径无效。")
    return path


def validate_manifest(manifest, available, expected_version=None):
    if not isinstance(manifest, dict):
        raise ManageError("manifest.json 的根值必须是对象。")
    if manifest.get("manifest_version") != 3:
        raise ManageError("扩展必须使用 Manifest V3。")
    version = require_version(manifest.get("version"))
    if expected_version and version != expected_version:
        raise ManageError("扩展版本 %s 与请求版本 %s 不一致。" % (version, expected_version))
    entries = []
    background = manifest.get("background") or {}
    if not isinstance(background, dict):
        raise ManageError("manifest background 必须是对象。")
    entries.append(background.get("service_worker"))
    action = manifest.get("action") or {}
    if not isinstance(action, dict):
        raise ManageError("manifest action 必须是对象。")
    if action.get("default_popup"):
        entries.append(action.get("default_popup"))
    options = manifest.get("options_ui") or {}
    if not isinstance(options, dict):
        raise ManageError("manifest options_ui 必须是对象。")
    if options.get("page"):
        entries.append(options.get("page"))
    overrides = manifest.get("chrome_url_overrides") or {}
    if not isinstance(overrides, dict):
        raise ManageError("manifest chrome_url_overrides 必须是对象。")
    entries.extend(overrides.values())
    if not background.get("service_worker"):
        raise ManageError("manifest 缺少后台 service worker。")
    for entry in entries:
        path = str(safe_entrypoint(entry))
        if path not in available:
            raise ManageError("manifest 入口文件缺失：%s" % path)
    return version


def include_extension_file(relative):
    return relative.name not in EXCLUDED_EXTENSION_FILES and not any(
        part in EXCLUDED_EXTENSION_PARTS for part in relative.parts
    )


def inspect_source_directory(source, expected_version=None):
    if source.is_symlink() or not source.is_dir():
        raise ManageError("本地 source 必须是普通目录。")
    extension = source / "extension" if (source / "extension" / "manifest.json").is_file() else source
    if extension.is_symlink() or not (extension / "manifest.json").is_file():
        raise ManageError("本地 source 缺少 extension/manifest.json 或 manifest.json。")
    available = set()
    files = []
    total = 0
    for root, directories, filenames in os.walk(str(extension), followlinks=False):
        root_path = Path(root)
        for directory in list(directories):
            child = root_path / directory
            if child.is_symlink():
                raise ManageError("本地 source 不能包含符号链接。")
        for filename in filenames:
            path = root_path / filename
            if path.is_symlink() or not path.is_file():
                raise ManageError("本地 source 不能包含符号链接或特殊文件。")
            relative = path.relative_to(extension)
            if not include_extension_file(relative):
                continue
            size = path.stat().st_size
            if size > MAX_FILE_BYTES:
                raise ManageError("本地 source 中单个文件超过大小限制。")
            total += size
            if total > MAX_EXPANDED_BYTES or len(files) >= MAX_FILES:
                raise ManageError("本地 source 超过安装大小限制。")
            available.add(relative.as_posix())
            files.append((path, relative))
    manifest = parse_manifest_bytes((extension / "manifest.json").read_bytes())
    version = validate_manifest(manifest, available, expected_version)
    version_file = source / "VERSION"
    if version_file.is_file():
        declared = version_file.read_text(encoding="ascii").strip()
        if declared != version:
            raise ManageError("VERSION 与 manifest 版本不一致。")
    return extension, files, version


def write_owner(stage, version, install_id):
    marker = {
        "project": PROJECT_ID,
        "schema": OWNER_SCHEMA,
        "version": version,
        "installedAt": int(time.time()),
        "installId": install_id,
    }
    path = stage / OWNER_FILE
    path.write_text(json.dumps(marker, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    path.chmod(0o600)


def copy_directory_source(source, destination, expected_version=None):
    _extension, files, version = inspect_source_directory(source, expected_version)
    destination.mkdir(mode=0o755)
    for path, relative in files:
        output = destination / relative
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(str(path), str(output))
        output.chmod(0o644)
    return version


def extract_zip_source(archive, checksum_file, destination, expected_version=None):
    verify_checksum(archive, checksum_file)
    bundle, names = inspect_zip(archive)
    try:
        declared = bundle.read("VERSION").decode("ascii").strip()
        require_version(declared)
        if expected_version and declared != expected_version:
            raise ManageError("安装包版本 %s 与请求版本 %s 不一致。" % (declared, expected_version))
        manifest = parse_manifest_bytes(bundle.read("extension/manifest.json"))
        available = {
            name[len("extension/"):]
            for name in names
            if name.startswith("extension/") and name != "extension"
        }
        version = validate_manifest(manifest, available, declared)
        destination.mkdir(mode=0o755)
        for info in bundle.infolist():
            if not info.filename.startswith("extension/") or info.is_dir():
                continue
            relative = PurePosixPath(info.filename).relative_to("extension")
            output = destination.joinpath(*relative.parts)
            output.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(info, "r") as source_stream, output.open("xb") as output_stream:
                shutil.copyfileobj(source_stream, output_stream, 1024 * 1024)
            output.chmod(0o644)
        return version
    except (KeyError, UnicodeError) as error:
        raise ManageError("安装 ZIP 不完整：%s" % error)
    finally:
        bundle.close()


def prepare_stage(source, checksum_file, parent, expected_version=None, dry_run=False, install_id=None):
    install_id = install_id or uuid.uuid4().hex
    temporary_parent = None if dry_run else str(parent)
    stage = Path(tempfile.mkdtemp(prefix=".TorranceTabs.stage-", dir=temporary_parent))
    try:
        extension = stage / "extension"
        if source.is_dir():
            version = copy_directory_source(source, extension, expected_version)
        else:
            version = extract_zip_source(source, checksum_file, extension, expected_version)
        inspect_source_directory(extension, version)
        write_owner(stage, version, install_id)
        if not dry_run:
            fsync_tree(stage)
        return stage, version
    except Exception:
        shutil.rmtree(str(stage), ignore_errors=True)
        raise


def unique_sibling(target, label, version):
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    return target.parent / ("%s.%s-v%s-%s-%s" % (target.name, label, version, stamp, uuid.uuid4().hex[:8]))


def read_complete_owner(path):
    owner = read_owner(path)
    if owner:
        inspect_source_directory(path / "extension", owner["version"])
    return owner


def cleanup_transaction_stage(target, transaction):
    stage = target.parent / transaction["stage"]
    if not stage.exists() and not stage.is_symlink():
        return
    owner = read_complete_owner(stage)
    if (
        not owner
        or owner.get("installId") != transaction["txId"]
        or owner.get("version") != transaction["newVersion"]
    ):
        raise ManageError("安装事务的 stage 身份不匹配，拒绝自动删除。")
    try:
        shutil.rmtree(str(stage))
        fsync_directory(target.parent)
    except OSError as error:
        raise ManageError("无法清理未提交的安装 stage：%s" % error)


def recover_interrupted_install(target, apply=True):
    """Resolve only the exact transaction recorded by the durable WAL."""
    transaction = read_transaction(target)
    if transaction is None:
        return None
    old_owner = transaction["oldOwner"]

    if target.exists() or target.is_symlink():
        active_owner = read_complete_owner(target)
        if (
            active_owner.get("installId") == transaction["txId"]
            and active_owner.get("version") == transaction["newVersion"]
        ):
            if apply:
                clear_transaction(target)
            return target
        if old_owner is not None and active_owner == old_owner:
            if apply:
                cleanup_transaction_stage(target, transaction)
                clear_transaction(target)
            return target
        raise ManageError("活动安装与未完成事务均不匹配，拒绝猜测恢复。")

    if old_owner is None:
        if apply:
            cleanup_transaction_stage(target, transaction)
            clear_transaction(target)
        return None

    backup = target.parent / transaction["backup"]
    backup_owner = read_complete_owner(backup)
    if backup_owner != old_owner:
        raise ManageError("安装事务指定的 backup 缺失或身份不匹配，拒绝猜测恢复。")
    if not apply:
        return backup
    try:
        os.replace(str(backup), str(target))
        fsync_directory(target.parent)
    except OSError as error:
        raise ManageError("无法恢复事务指定的旧版本：%s" % error)
    cleanup_transaction_stage(target, transaction)
    clear_transaction(target)
    return target


def install(args):
    source = Path(args.source).expanduser()
    if not source.is_absolute():
        source = Path.cwd() / source
    expected = require_version(args.version) if args.version else None
    target = target_path(args.test_mode, args.test_root)
    check_target_shape(target)

    if args.dry_run:
        recovered = recover_interrupted_install(target, apply=False)
        owner_path = recovered if recovered else target
        owner = read_complete_owner(owner_path)
        stage, version = prepare_stage(
            source,
            args.checksum_file,
            target.parent,
            expected,
            dry_run=True,
        )
        shutil.rmtree(str(stage), ignore_errors=True)
        action = "更新" if owner else "首次安装"
        if recovered:
            print("DRY RUN：检测到可恢复的完整旧版本：%s" % recovered)
        print("DRY RUN：将%s TorranceTabs %s 到 %s" % (action, version, target))
        return 0

    target.parent.mkdir(parents=True, exist_ok=True)
    with DirectoryLock(target):
        recover_interrupted_install(target, apply=True)
        owner = read_complete_owner(target)
        tx_id = uuid.uuid4().hex
        stage, version = prepare_stage(
            source,
            args.checksum_file,
            target.parent,
            expected,
            dry_run=False,
            install_id=tx_id,
        )
        backup = None
        transaction_written = False
        committed = False
        try:
            if owner:
                backup = unique_sibling(target, "backup", owner["version"])
            transaction = {
                "project": PROJECT_ID,
                "schema": TRANSACTION_SCHEMA,
                "txId": tx_id,
                "stage": stage.name,
                "backup": backup.name if backup else None,
                "oldOwner": owner,
                "newVersion": version,
            }
            write_transaction(target, transaction)
            transaction_written = True
            if owner:
                os.replace(str(target), str(backup))
                fsync_directory(target.parent)
                if args.test_mode and os.environ.get("TORRANCE_TABS_TEST_FAIL_AFTER_BACKUP") == "1":
                    raise ManageError("测试注入：替换前失败。")
            os.replace(str(stage), str(target))
            stage = None
            committed = True
            fsync_directory(target.parent)
            clear_transaction(target)
        except Exception as error:
            if committed:
                if isinstance(error, ManageError):
                    raise ManageError("新版本已安装，但无法清理事务记录：%s" % error)
                raise ManageError("新版本已安装，但提交清理失败：%s" % error)
            if backup and backup.exists() and not target.exists():
                os.replace(str(backup), str(target))
                fsync_directory(target.parent)
            if transaction_written:
                cleanup_transaction_stage(target, transaction)
                clear_transaction(target)
            if isinstance(error, ManageError):
                raise
            raise ManageError("安装替换失败，旧版本已恢复：%s" % error)
        finally:
            if stage and stage.exists() and not transaction_path(target).exists():
                shutil.rmtree(str(stage), ignore_errors=True)

    print("已安装 TorranceTabs %s。" % version)
    print("Chrome 扩展目录：%s" % (target / "extension"))
    if backup:
        print("旧版本已保留用于回退：%s" % backup)
        print("请在 chrome://extensions 中找到 TorranceTabs 并点击“重新加载”。")
    else:
        print("请打开 chrome://extensions，启用开发者模式，选择“加载已解压的扩展程序”。")
        print("然后选择上面的 extension 目录。")
    return 0


def uninstall(args):
    target = target_path(args.test_mode, args.test_root)
    check_target_shape(target)
    if not target.parent.exists() and not target.parent.is_symlink():
        print("未发现 TorranceTabs 安装，无需卸载。")
        print("如 Chrome 中仍显示扩展，请在 chrome://extensions 中手动移除。")
        return 0
    if args.dry_run:
        active_exists = target.exists() or target.is_symlink()
        read_complete_owner(target) if active_exists else None
        transaction = read_transaction(target)
        if not active_exists:
            if transaction:
                print("DRY RUN：将取消未完成事务；不会恢复其 backup。")
            else:
                print("未发现 TorranceTabs 安装，无需卸载。")
            return 0
        print("DRY RUN：将把 %s 移到可恢复备份；不会修改 Chrome 配置。" % target)
        return 0
    with DirectoryLock(target):
        active_exists = target.exists() or target.is_symlink()
        owner = read_complete_owner(target) if active_exists else None
        transaction = read_transaction(target)
        if transaction:
            clear_transaction(target)
        if not active_exists:
            print("未发现 TorranceTabs 安装，无需卸载。")
            print("如 Chrome 中仍显示扩展，请在 chrome://extensions 中手动移除。")
            return 0
        removed = unique_sibling(target, "removed", owner["version"])
        try:
            os.replace(str(target), str(removed))
            fsync_directory(target.parent)
        except OSError as error:
            raise ManageError("无法移动安装目录：%s" % error)
    print("已将安装目录移到可恢复位置：%s" % removed)
    print("请在 chrome://extensions 中手动移除 TorranceTabs；脚本未修改 Chrome 数据。")
    return 0


def parser():
    root = argparse.ArgumentParser(description="TorranceTabs 本地安装管理器")
    commands = root.add_subparsers(dest="command")
    install_parser = commands.add_parser("install", help="安装或更新")
    install_parser.add_argument("--source", required=True, help="release ZIP 或本地源码目录")
    install_parser.add_argument("--checksum-file", help="ZIP 的 SHA-256 sidecar")
    install_parser.add_argument("--version", help="要求安装的数字版本")
    install_parser.add_argument("--dry-run", action="store_true")
    uninstall_parser = commands.add_parser("uninstall", help="安全卸载")
    uninstall_parser.add_argument("--dry-run", action="store_true")
    for subparser in (install_parser, uninstall_parser):
        subparser.add_argument("--test-mode", action="store_true", help=argparse.SUPPRESS)
        subparser.add_argument("--test-root", help=argparse.SUPPRESS)
    return root


def main(argv=None):
    arguments = parser().parse_args(argv)
    if not arguments.command:
        parser().print_help()
        return 2
    try:
        return install(arguments) if arguments.command == "install" else uninstall(arguments)
    except (ManageError, OSError) as error:
        print("错误：%s" % error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    configure_utf8_output()
    sys.exit(main())
