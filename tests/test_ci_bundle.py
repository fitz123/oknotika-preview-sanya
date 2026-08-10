from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import stat
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
CHECK_SCRIPT = REPO / "scripts/check_ci_bundle.py"
CHECK_SPEC = importlib.util.spec_from_file_location("check_ci_bundle", CHECK_SCRIPT)
assert CHECK_SPEC and CHECK_SPEC.loader
checker = importlib.util.module_from_spec(CHECK_SPEC)
sys.modules["check_ci_bundle"] = checker
CHECK_SPEC.loader.exec_module(checker)

BUILD_SCRIPT = REPO / "scripts/build_ci_bundle.py"
BUILD_SPEC = importlib.util.spec_from_file_location("build_ci_bundle", BUILD_SCRIPT)
assert BUILD_SPEC and BUILD_SPEC.loader
builder = importlib.util.module_from_spec(BUILD_SPEC)
sys.modules["build_ci_bundle"] = builder
BUILD_SPEC.loader.exec_module(builder)


FIXTURE_FILES = {
    "index.html": b"<title>OKNOTIKA</title>\n",
    "script.js": b"console.log('ok')\n",
    "style.css": b"body { color: black; }\n",
    "js/latest-fact.js": b"export const latest = true;\n",
    "img/logo-oknotika.svg": b"<svg/>\n",
    "articles/index.html": b"<title>Articles</title>\n",
    "articles/latest.json": b"{}\n",
    "admin-app/package.json": b'{"name":"fixture"}\n',
    "admin-app/package-lock.json": b'{"lockfileVersion":3}\n',
    "admin-app/src/http/start.js": b"export const start = true;\n",
    "deploy/release-manifest.json": b"{}\n",
    "deploy/cicd/oknotika-deploy": b"#!/usr/bin/env bash\n",
    "deploy/scripts/install-marketing.sh": b"#!/usr/bin/env bash\n",
    "deploy/scripts/preflight.sh": b"#!/usr/bin/env bash\n",
    "deploy/scripts/smoke-test.sh": b"#!/usr/bin/env bash\n",
    "deploy/systemd/oknotika-admin.service": b"[Service]\n",
}
EXECUTABLES = {
    "deploy/cicd/oknotika-deploy",
    "deploy/scripts/install-marketing.sh",
    "deploy/scripts/preflight.sh",
    "deploy/scripts/smoke-test.sh",
}


def initialize_fixture_repo(root: Path) -> str:
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.email", "test@example.com"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.name", "Test"], check=True)
    for relative, data in FIXTURE_FILES.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        if relative in EXECUTABLES:
            path.chmod(0o755)
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    subprocess.run(["git", "-C", str(root), "commit", "-qm", "fixture"], check=True)
    return subprocess.run(
        ["git", "-C", str(root), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def regular_info(name: str, mode: int = 0o644) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, builder.FIXED_TIMESTAMP)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | mode) << 16
    return info


def rewrite_archive(
    source: Path,
    target: Path,
    transform=None,
    additions: list[tuple[zipfile.ZipInfo, bytes]] | None = None,
) -> None:
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(
        target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
    ) as changed:
        for original_info in original.infolist():
            info = copy.copy(original_info)
            data = original.read(original_info)
            if transform is not None:
                info, data = transform(info, data)
            changed.writestr(info, data)
        for info, data in additions or []:
            changed.writestr(info, data)


def rewrite_payload_file(source: Path, target: Path, relative: str, data: bytes) -> None:
    root = checker.inspect_bundle(source)["payloadRoot"]
    assert isinstance(root, str)

    def transform(info: zipfile.ZipInfo, original: bytes) -> tuple[zipfile.ZipInfo, bytes]:
        if info.filename == f"{root}/{relative}":
            return info, data
        if info.filename == f"{root}/BUNDLE_MANIFEST.json":
            manifest = json.loads(original)
            manifest["files"][relative]["sha256"] = hashlib.sha256(data).hexdigest()
            manifest["files"][relative]["bytes"] = len(data)
            return info, (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()
        return info, original

    rewrite_archive(source, target, transform)


class CiBundleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="oknotika-ci-bundle-test-")
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.commit = initialize_fixture_repo(self.repo)
        self.bundle = self.root / "bundle.zip"
        builder.build_bundle(self.repo, "HEAD", self.bundle)
        result = checker.inspect_bundle(self.bundle, self.commit)
        self.assertEqual(result["errors"], [])
        self.payload_root = result["payloadRoot"]
        assert isinstance(self.payload_root, str)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_build_is_deterministic_and_uses_the_exact_commit(self) -> None:
        second = self.root / "second.zip"
        first_result = builder.build_bundle(self.repo, self.commit, self.root / "first.zip")
        second_result = builder.build_bundle(self.repo, self.commit, second)
        self.assertEqual(first_result["sha256"], second_result["sha256"])
        self.assertEqual((self.root / "first.zip").read_bytes(), second.read_bytes())

        with zipfile.ZipFile(second) as archive:
            manifest = json.loads(archive.read(f"{self.payload_root}/BUNDLE_MANIFEST.json"))
            self.assertEqual(manifest["implementationCommit"], self.commit)
            self.assertEqual(
                archive.read(f"{self.payload_root}/index.html"),
                subprocess.run(
                    ["git", "-C", str(self.repo), "show", f"{self.commit}:index.html"],
                    check=True,
                    capture_output=True,
                ).stdout,
            )

    def test_dirty_and_uncommitted_payload_inputs_are_rejected(self) -> None:
        index = self.repo / "index.html"
        index.write_text("working tree\n", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "payload worktree must be clean"):
            builder.build_bundle(self.repo, "HEAD", self.root / "dirty.zip")

        index.write_bytes(FIXTURE_FILES["index.html"])
        untracked = self.repo / "admin-app/uncommitted.js"
        untracked.write_text("private input\n", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "uncommitted.js"):
            builder.build_bundle(self.repo, "HEAD", self.root / "untracked.zip")

    def test_manifest_checksum_tampering_is_rejected(self) -> None:
        tampered = self.root / "tampered.zip"

        def transform(info: zipfile.ZipInfo, data: bytes) -> tuple[zipfile.ZipInfo, bytes]:
            if info.filename == f"{self.payload_root}/index.html":
                return info, b"tampered\n"
            return info, data

        rewrite_archive(self.bundle, tampered, transform)
        errors = checker.inspect_bundle(tampered)["errors"]
        self.assertTrue(any("checksum mismatch: index.html" in error for error in errors), errors)

    def test_manifest_implementation_sha_mismatch_is_rejected(self) -> None:
        mismatched = self.root / "mismatched.zip"

        def transform(info: zipfile.ZipInfo, data: bytes) -> tuple[zipfile.ZipInfo, bytes]:
            if info.filename == f"{self.payload_root}/BUNDLE_MANIFEST.json":
                manifest = json.loads(data)
                manifest["implementationCommit"] = "f" * 40
                data = (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()
            return info, data

        rewrite_archive(self.bundle, mismatched, transform)
        errors = checker.inspect_bundle(mismatched, self.commit)["errors"]
        self.assertTrue(any("does not match the payload root" in error for error in errors), errors)
        self.assertTrue(any("does not match the expected commit" in error for error in errors), errors)

    def test_secret_content_and_runtime_paths_are_rejected(self) -> None:
        secret = self.root / "secret.zip"
        secret_marker = b"-----BEGIN " + b"PRIVATE KEY-----\nnot-a-real-key\n"
        rewrite_payload_file(self.bundle, secret, "script.js", secret_marker)
        secret_errors = checker.inspect_bundle(secret)["errors"]
        self.assertTrue(any("private key detected in script.js" in error for error in secret_errors), secret_errors)

        runtime = self.root / "runtime.zip"
        runtime_path = "admin-app/var/admin.sqlite"
        runtime_data = b"not-a-database"

        def add_runtime_to_manifest(info: zipfile.ZipInfo, data: bytes) -> tuple[zipfile.ZipInfo, bytes]:
            if info.filename == f"{self.payload_root}/BUNDLE_MANIFEST.json":
                manifest = json.loads(data)
                manifest["files"][runtime_path] = {
                    "sha256": hashlib.sha256(runtime_data).hexdigest(),
                    "bytes": len(runtime_data),
                    "mode": "0644",
                }
                data = (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()
            return info, data

        rewrite_archive(
            self.bundle,
            runtime,
            add_runtime_to_manifest,
            [(regular_info(f"{self.payload_root}/{runtime_path}"), runtime_data)],
        )
        runtime_errors = checker.inspect_bundle(runtime)["errors"]
        self.assertTrue(any("secret/runtime path is forbidden" in error for error in runtime_errors), runtime_errors)
        self.assertTrue(any("secret/runtime file suffix is forbidden" in error for error in runtime_errors), runtime_errors)

    def test_traversal_symlink_duplicates_and_unexpected_content_are_rejected(self) -> None:
        cases: list[tuple[str, zipfile.ZipInfo, bytes, str]] = [
            (
                "traversal",
                regular_info(f"{self.payload_root}/../escape"),
                b"escape",
                "unsafe archive path",
            ),
            (
                "unexpected",
                regular_info(f"{self.payload_root}/README.md"),
                b"not deployment input",
                "unexpected top-level bundle content",
            ),
        ]
        symlink = zipfile.ZipInfo(f"{self.payload_root}/admin-app/current", builder.FIXED_TIMESTAMP)
        symlink.create_system = 3
        symlink.compress_type = zipfile.ZIP_DEFLATED
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        cases.append(("symlink", symlink, b"releases/target", "symlink is forbidden"))

        for label, info, data, expected in cases:
            with self.subTest(label=label):
                changed = self.root / f"{label}.zip"
                rewrite_archive(self.bundle, changed, additions=[(info, data)])
                errors = checker.inspect_bundle(changed)["errors"]
                self.assertTrue(any(expected in error for error in errors), errors)

        duplicate = self.root / "duplicate.zip"
        with zipfile.ZipFile(self.bundle) as archive:
            original_info = archive.getinfo(f"{self.payload_root}/index.html")
            duplicate_entry = (copy.copy(original_info), archive.read(original_info))
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            rewrite_archive(self.bundle, duplicate, additions=[duplicate_entry])
        duplicate_errors = checker.inspect_bundle(duplicate)["errors"]
        self.assertTrue(any("duplicate filenames" in error for error in duplicate_errors), duplicate_errors)


if __name__ == "__main__":
    unittest.main()
