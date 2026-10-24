import hashlib
import fcntl
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
MANAGER = REPO / "scripts" / "manage.py"
PACKAGER = REPO / "scripts" / "package_release.py"
OWNER_FILE = ".torrance-tabs-owner.json"
TRANSACTION_FILE = ".TorranceTabs.transaction.json"


def manifest(version="1.5.0", background="background.js"):
    return {
        "manifest_version": 3,
        "name": "TorranceTabs",
        "version": version,
        "background": {"service_worker": background, "type": "module"},
    }


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = Path(tempfile.mkdtemp(prefix="torrance-installer-test-"))
        self.test_root = (self.temporary / "isolated-data").resolve()

    def tearDown(self):
        shutil.rmtree(str(self.temporary), ignore_errors=True)

    @property
    def target(self):
        return self.test_root / "TorranceTabs"

    def source(self, version="1.5.0", broken_manifest=None):
        root = self.temporary / ("source-" + version.replace(".", "-"))
        if root.exists():
            shutil.rmtree(str(root))
        extension = root / "extension"
        extension.mkdir(parents=True)
        data = broken_manifest if broken_manifest is not None else manifest(version)
        (extension / "manifest.json").write_text(json.dumps(data), encoding="utf-8")
        (extension / "background.js").write_text("export const version = %r;\n" % version, encoding="utf-8")
        (extension / "README.md").write_text("excluded\n", encoding="utf-8")
        (extension / "package.json").write_text("{}\n", encoding="utf-8")
        tests = extension / "tests"
        tests.mkdir()
        (tests / "not-shipped.js").write_text("throw new Error();\n", encoding="utf-8")
        (root / "VERSION").write_text(version + "\n", encoding="ascii")
        return root

    def run_manage(self, command, *arguments, env=None):
        actual_env = os.environ.copy()
        if env:
            actual_env.update(env)
        cmd = [sys.executable, str(MANAGER), command]
        cmd.extend(arguments)
        cmd.extend(["--test-mode", "--test-root", str(self.test_root)])
        return subprocess.run(cmd, encoding="utf-8", universal_newlines=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=actual_env)

    def install(self, source, version=None, **kwargs):
        arguments = ["--source", str(source)]
        if version:
            arguments.extend(["--version", version])
        return self.run_manage("install", *arguments, **kwargs)

    def make_zip(self, version="1.5.0", extra=None, manifest_data=None, corrupt=False):
        archive = self.temporary / ("fixture-%s-%d.zip" % (version, len(list(self.temporary.glob("fixture-*.zip")))))
        if corrupt:
            archive.write_bytes(b"not a zip")
        else:
            entries = [
                ("VERSION", (version + "\n").encode("ascii"), None),
                ("LICENSE", b"test license\n", None),
                ("install.sh", b"#!/bin/sh\n", None),
                ("uninstall.sh", b"#!/bin/sh\n", None),
                ("scripts/manage.py", b"# manager\n", None),
                ("extension/manifest.json", json.dumps(manifest_data or manifest(version)).encode("utf-8"), None),
                ("extension/background.js", b"export {};\n", None),
            ]
            if extra:
                entries.extend(extra)
            with zipfile.ZipFile(str(archive), "w", zipfile.ZIP_DEFLATED) as bundle:
                for name, payload, mode in entries:
                    if mode is None:
                        bundle.writestr(name, payload)
                    else:
                        info = zipfile.ZipInfo(name)
                        info.create_system = 3
                        info.external_attr = mode << 16
                        bundle.writestr(info, payload)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        sidecar = Path(str(archive) + ".sha256")
        sidecar.write_text("%s  %s\n" % (digest, archive.name), encoding="ascii")
        return archive, sidecar

    def write_transaction(self, old_owner, backup, tx_id="a" * 32, stage=".TorranceTabs.stage-crash", new_version="1.5.1"):
        data = {
            "project": "TorranceZHANG/TorranceTabs",
            "schema": 1,
            "txId": tx_id,
            "stage": stage,
            "backup": backup,
            "oldOwner": old_owner,
            "newVersion": new_version,
        }
        path = self.test_root / TRANSACTION_FILE
        path.write_text(json.dumps(data), encoding="utf-8")
        return path

    def test_first_install_update_and_backup(self):
        first = self.install(self.source("1.5.0"), "1.5.0")
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertTrue((self.target / "extension" / "background.js").is_file())
        self.assertFalse((self.target / "extension" / "README.md").exists())
        owner = json.loads((self.target / OWNER_FILE).read_text(encoding="utf-8"))
        self.assertEqual(owner["version"], "1.5.0")

        second = self.install(self.source("1.5.1"), "1.5.1")
        self.assertEqual(second.returncode, 0, second.stderr)
        owner = json.loads((self.target / OWNER_FILE).read_text(encoding="utf-8"))
        self.assertEqual(owner["version"], "1.5.1")
        backups = list(self.test_root.glob("TorranceTabs.backup-v1.5.0-*"))
        self.assertEqual(len(backups), 1)
        self.assertTrue((backups[0] / OWNER_FILE).is_file())

    def test_uninstall_dry_run_actual_and_repeat(self):
        self.assertEqual(self.install(self.source()).returncode, 0)
        dry = self.run_manage("uninstall", "--dry-run")
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertTrue(self.target.exists())
        removed = self.run_manage("uninstall")
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertFalse(self.target.exists())
        self.assertEqual(len(list(self.test_root.glob("TorranceTabs.removed-v1.5.0-*"))), 1)
        repeated = self.run_manage("uninstall")
        self.assertEqual(repeated.returncode, 0, repeated.stderr)
        self.assertIn("无需卸载", repeated.stdout)

    def test_dry_runs_do_not_create_parent_target_or_lock(self):
        source = self.source("1.5.0")
        install_preview = self.run_manage("install", "--source", str(source), "--dry-run")
        self.assertEqual(install_preview.returncode, 0, install_preview.stderr)
        self.assertFalse(self.test_root.exists())

        self.test_root.mkdir(parents=True)
        uninstall_preview = self.run_manage("uninstall", "--dry-run")
        self.assertEqual(uninstall_preview.returncode, 0, uninstall_preview.stderr)
        self.assertTrue(self.test_root.exists())
        self.assertFalse(self.target.exists())
        self.assertFalse((self.test_root / ".TorranceTabs.lock").exists())

    def test_update_rollback_and_interrupted_backup_recovery(self):
        self.assertEqual(self.install(self.source("1.5.0")).returncode, 0)
        failed = self.install(
            self.source("1.5.1"),
            env={"TORRANCE_TABS_TEST_FAIL_AFTER_BACKUP": "1"},
        )
        self.assertNotEqual(failed.returncode, 0)
        owner = json.loads((self.target / OWNER_FILE).read_text(encoding="utf-8"))
        self.assertEqual(owner["version"], "1.5.0")

        interrupted = self.test_root / "TorranceTabs.backup-v1.5.0-interrupted"
        os.replace(str(self.target), str(interrupted))
        self.write_transaction(owner, interrupted.name)
        recovered_update = self.install(self.source("1.5.1"))
        self.assertEqual(recovered_update.returncode, 0, recovered_update.stderr)
        owner = json.loads((self.target / OWNER_FILE).read_text(encoding="utf-8"))
        self.assertEqual(owner["version"], "1.5.1")
        self.assertFalse(interrupted.exists())
        self.assertFalse((self.test_root / TRANSACTION_FILE).exists())

    def test_failed_reinstall_after_uninstall_does_not_revive_historical_backup(self):
        self.assertEqual(self.install(self.source("1.5.0")).returncode, 0)
        self.assertEqual(self.install(self.source("1.5.1")).returncode, 0)
        self.assertEqual(self.run_manage("uninstall").returncode, 0)
        self.assertFalse(self.target.exists())
        self.assertEqual(len(list(self.test_root.glob("TorranceTabs.backup-v1.5.0-*"))), 1)

        invalid_manifest = manifest("1.5.2")
        invalid_manifest["manifest_version"] = 2
        failed = self.install(self.source("1.5.2", broken_manifest=invalid_manifest))
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("Manifest V3", failed.stderr)
        self.assertFalse(self.target.exists(), "失败安装不得复活历史备份")
        self.assertEqual(len(list(self.test_root.glob("TorranceTabs.removed-v1.5.1-*"))), 1)

    def test_uninstall_cancels_interrupted_transaction_without_recovery(self):
        self.assertEqual(self.install(self.source("1.5.0")).returncode, 0)
        owner = json.loads((self.target / OWNER_FILE).read_text(encoding="utf-8"))
        backup = self.test_root / "TorranceTabs.backup-v1.5.0-crash"
        os.replace(str(self.target), str(backup))
        wal = self.write_transaction(owner, backup.name)

        result = self.run_manage("uninstall")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.target.exists())
        self.assertTrue(backup.exists(), "卸载不得把事务backup恢复为active")
        self.assertFalse(wal.exists(), "卸载必须先持久取消WAL")

    def test_first_install_wal_discards_only_its_stage(self):
        tx_id = "b" * 32
        stage = self.test_root / ".TorranceTabs.stage-first-crash"
        shutil.copytree(str(self.source("1.5.0") / "extension"), str(stage / "extension"))
        (stage / OWNER_FILE).write_text(json.dumps({
            "project": "TorranceZHANG/TorranceTabs",
            "schema": 1,
            "version": "1.5.0",
            "installedAt": 1,
            "installId": tx_id,
        }), encoding="utf-8")
        wal = self.write_transaction(None, None, tx_id=tx_id, stage=stage.name, new_version="1.5.0")
        invalid = manifest("1.5.1")
        invalid["manifest_version"] = 2

        result = self.install(self.source("1.5.1", broken_manifest=invalid))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.target.exists())
        self.assertFalse(stage.exists())
        self.assertFalse(wal.exists())

    def test_wal_commit_and_rollback_states_are_resolved_by_owner_identity(self):
        self.assertEqual(self.install(self.source("1.5.0")).returncode, 0)
        active_owner = json.loads((self.target / OWNER_FILE).read_text(encoding="utf-8"))
        committed = self.write_transaction(
            None,
            None,
            tx_id=active_owner["installId"],
            stage=".TorranceTabs.stage-committed",
            new_version="1.5.0",
        )
        invalid = manifest("1.5.1")
        invalid["manifest_version"] = 2
        result = self.install(self.source("1.5.1", broken_manifest=invalid))
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.target.exists())
        self.assertFalse(committed.exists())

        tx_id = "c" * 32
        stage = self.test_root / ".TorranceTabs.stage-rolled-back"
        shutil.copytree(str(self.target), str(stage))
        stage_owner = dict(active_owner, installId=tx_id)
        (stage / OWNER_FILE).write_text(json.dumps(stage_owner), encoding="utf-8")
        rolled_back = self.write_transaction(
            active_owner,
            "TorranceTabs.backup-v1.5.0-unused",
            tx_id=tx_id,
            stage=stage.name,
            new_version="1.5.0",
        )
        result = self.install(self.source("1.5.1", broken_manifest=invalid))
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.target.exists())
        self.assertFalse(stage.exists())
        self.assertFalse(rolled_back.exists())

    def test_malformed_or_mismatched_wal_never_guesses_recovery(self):
        self.test_root.mkdir(parents=True)
        wal = self.test_root / TRANSACTION_FILE
        wal.write_text("{}", encoding="utf-8")
        malformed = self.install(self.source("1.5.0"))
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("事务记录", malformed.stderr)
        self.assertFalse(self.target.exists())

        wal.unlink()
        unrelated = self.test_root / "TorranceTabs.backup-v1.5.0-unrelated"
        shutil.copytree(str(self.source("1.5.0") / "extension"), str(unrelated / "extension"))
        owner = {
            "project": "TorranceZHANG/TorranceTabs",
            "schema": 1,
            "version": "1.5.0",
            "installedAt": 1,
            "installId": "d" * 32,
        }
        (unrelated / OWNER_FILE).write_text(json.dumps(owner), encoding="utf-8")
        self.write_transaction(owner, "TorranceTabs.backup-v1.5.0-missing")
        mismatched = self.install(self.source("1.5.0"))
        self.assertNotEqual(mismatched.returncode, 0)
        self.assertIn("backup", mismatched.stderr)
        self.assertFalse(self.target.exists())
        self.assertTrue(unrelated.exists())

    def test_external_lock_rejects_concurrent_operation(self):
        self.test_root.mkdir(parents=True)
        lock = self.test_root / ".TorranceTabs.lock"
        with lock.open("a+") as stream:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.install(self.source())
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("正在运行", result.stderr)
            self.assertFalse(self.target.exists())

    def test_stale_lock_file_does_not_block_and_symlink_ancestor_is_rejected(self):
        self.test_root.mkdir(parents=True)
        (self.test_root / ".TorranceTabs.lock").write_text("stale\n", encoding="utf-8")
        installed = self.install(self.source())
        self.assertEqual(installed.returncode, 0, installed.stderr)

        other = self.temporary / "other-data"
        other.mkdir()
        alias = self.temporary / "linked-data"
        try:
            alias.symlink_to(other, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("平台不支持符号链接")
        result = subprocess.run(
            [
                sys.executable, str(MANAGER), "uninstall",
                "--test-mode", "--test-root", str(alias),
            ],
            encoding="utf-8", universal_newlines=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("符号链接", result.stderr)

    def test_refuses_unowned_target_and_target_symlink(self):
        self.target.mkdir(parents=True)
        (self.target / "personal.txt").write_text("keep", encoding="utf-8")
        result = self.install(self.source())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("不属于", result.stderr)
        self.assertEqual((self.target / "personal.txt").read_text(), "keep")

        shutil.rmtree(str(self.target))
        elsewhere = self.temporary / "elsewhere"
        elsewhere.mkdir()
        try:
            self.target.symlink_to(elsewhere, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("平台不支持符号链接")
        linked = self.install(self.source())
        self.assertNotEqual(linked.returncode, 0)
        self.assertIn("符号链接", linked.stderr)

    def test_refuses_symlink_in_directory_source(self):
        source = self.source()
        try:
            (source / "extension" / "linked.js").symlink_to(source / "extension" / "background.js")
        except (OSError, NotImplementedError):
            self.skipTest("平台不支持符号链接")
        result = self.install(source)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("符号链接", result.stderr)

    def test_zip_checksum_corruption_and_bad_manifest(self):
        archive, sidecar = self.make_zip()
        sidecar.write_text("0" * 64 + "  bad.zip\n", encoding="ascii")
        bad_hash = self.run_manage(
            "install", "--source", str(archive), "--checksum-file", str(sidecar)
        )
        self.assertNotEqual(bad_hash.returncode, 0)
        self.assertIn("SHA-256", bad_hash.stderr)

        corrupt, corrupt_sidecar = self.make_zip(corrupt=True)
        bad_zip = self.run_manage(
            "install", "--source", str(corrupt), "--checksum-file", str(corrupt_sidecar)
        )
        self.assertNotEqual(bad_zip.returncode, 0)
        self.assertIn("损坏", bad_zip.stderr)

        malformed = manifest()
        malformed["manifest_version"] = 2
        bad_manifest, bad_manifest_sidecar = self.make_zip(manifest_data=malformed)
        bad = self.run_manage(
            "install", "--source", str(bad_manifest), "--checksum-file", str(bad_manifest_sidecar)
        )
        self.assertNotEqual(bad.returncode, 0)
        self.assertIn("Manifest V3", bad.stderr)

    def test_zip_rejects_dangerous_and_special_entries(self):
        attacks = [
            ("../escape", b"x", None),
            ("/absolute", b"x", None),
            ("C:/absolute", b"x", None),
            ("extension//evil.js", b"x", None),
            ("extension/./evil.js", b"x", None),
            ("extension\\evil.js", b"x", None),
            ("extension/link.js", b"target", stat.S_IFLNK | 0o777),
            ("extension/device", b"x", stat.S_IFCHR | 0o600),
        ]
        for attack in attacks:
            with self.subTest(name=attack[0]):
                archive, sidecar = self.make_zip(extra=[attack])
                result = self.run_manage(
                    "install", "--source", str(archive), "--checksum-file", str(sidecar)
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.target.exists())

    def test_zip_rejects_duplicate_case_conflict_and_incomplete(self):
        duplicate, duplicate_sidecar = self.make_zip(extra=[("extension/background.js", b"again", None)])
        repeated = self.run_manage(
            "install", "--source", str(duplicate), "--checksum-file", str(duplicate_sidecar)
        )
        self.assertNotEqual(repeated.returncode, 0)
        self.assertIn("重复", repeated.stderr)

        archive, sidecar = self.make_zip(extra=[("Extension/background.js", b"x", None)])
        conflict = self.run_manage(
            "install", "--source", str(archive), "--checksum-file", str(sidecar)
        )
        self.assertNotEqual(conflict.returncode, 0)
        self.assertIn("大小写冲突", conflict.stderr)

        incomplete = self.temporary / "incomplete.zip"
        with zipfile.ZipFile(str(incomplete), "w") as bundle:
            bundle.writestr("VERSION", "1.5.0\n")
        digest = hashlib.sha256(incomplete.read_bytes()).hexdigest()
        side = Path(str(incomplete) + ".sha256")
        side.write_text(digest + "  incomplete.zip\n", encoding="ascii")
        missing = self.run_manage(
            "install", "--source", str(incomplete), "--checksum-file", str(side)
        )
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("不完整", missing.stderr)

    def test_zip_rejects_excessive_compression_ratio(self):
        archive, sidecar = self.make_zip(extra=[("extension/highly-compressed.txt", b"x" * (1024 * 1024), None)])
        result = self.run_manage(
            "install", "--source", str(archive), "--checksum-file", str(sidecar)
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("压缩比", result.stderr)

    def test_packager_outputs_installable_production_archive(self):
        output = self.temporary / "dist"
        result = subprocess.run(
            [sys.executable, str(PACKAGER), "--version", "1.5.0", "--output-dir", str(output)],
            encoding="utf-8", universal_newlines=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        archive = output / "TorranceTabs-v1.5.0.zip"
        sidecar = Path(str(archive) + ".sha256")
        self.assertTrue(archive.is_file())
        self.assertTrue(sidecar.is_file())
        with zipfile.ZipFile(str(archive)) as bundle:
            names = set(bundle.namelist())
        self.assertIn("extension/manifest.json", names)
        self.assertIn("LICENSE", names)
        self.assertIn("scripts/manage.py", names)
        self.assertNotIn("extension/package.json", names)
        self.assertFalse(any(name.startswith("extension/tests/") for name in names))
        installed = self.run_manage(
            "install",
            "--source", str(archive),
            "--checksum-file", str(sidecar),
            "--version", "1.5.0",
        )
        self.assertEqual(installed.returncode, 0, installed.stderr)

    def test_offline_shell_source_does_not_need_network(self):
        source = self.source()
        shell_env = dict(os.environ, PATH=os.path.dirname(sys.executable) + ":/usr/bin:/bin")
        result = subprocess.run(
            [
                "sh", str(REPO / "install.sh"),
                "--source", str(source),
                "--test-mode", "--test-root", str(self.test_root),
            ],
            encoding="utf-8", universal_newlines=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=shell_env,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.target / "extension" / "manifest.json").is_file())
        dry = subprocess.run(
            [
                "sh", str(REPO / "uninstall.sh"), "--dry-run",
                "--test-mode", "--test-root", str(self.test_root),
            ],
            encoding="utf-8", universal_newlines=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=shell_env,
        )
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertTrue(self.target.exists())
        removed = subprocess.run(
            [
                "sh", str(REPO / "uninstall.sh"),
                "--test-mode", "--test-root", str(self.test_root),
            ],
            encoding="utf-8", universal_newlines=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=shell_env,
        )
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertFalse(self.target.exists())

    def test_cli_forces_utf8_output_under_ascii_environment(self):
        ascii_env = dict(os.environ, LC_ALL="C", LANG="C", PYTHONIOENCODING="ascii")
        success = self.install(self.source(), env=ascii_env)
        self.assertEqual(success.returncode, 0, success.stderr)
        self.assertIn("已安装", success.stdout)

        failed = self.install(self.source("1.5.1", broken_manifest=[]), env=ascii_env)
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("根值必须是对象", failed.stderr)
        self.assertNotIn("\\u", failed.stderr)


if __name__ == "__main__":
    unittest.main()
