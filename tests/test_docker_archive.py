from __future__ import annotations

import copy
import importlib.util
import stat
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
CHECK_SCRIPT = REPO / "scripts/check_docker_archive.py"
CHECK_SPEC = importlib.util.spec_from_file_location("check_docker_archive", CHECK_SCRIPT)
assert CHECK_SPEC and CHECK_SPEC.loader
checker = importlib.util.module_from_spec(CHECK_SPEC)
sys.modules["check_docker_archive"] = checker
CHECK_SPEC.loader.exec_module(checker)

BUILD_SCRIPT = REPO / "scripts/build_docker_package.py"
BUILD_SPEC = importlib.util.spec_from_file_location("build_docker_package", BUILD_SCRIPT)
assert BUILD_SPEC and BUILD_SPEC.loader
builder = importlib.util.module_from_spec(BUILD_SPEC)
sys.modules["build_docker_package"] = builder
BUILD_SPEC.loader.exec_module(builder)


FIXTURE_FILES = {
    path: f"fixture for {path}\n".encode() for path in checker.REQUIRED_SOURCE_FILES
}
FIXTURE_FILES.update(checker.SECRET_EXAMPLE_PLACEHOLDERS)
EXECUTABLES = {
    "deploy/docker/admin-entrypoint.sh",
    "deploy/docker/smoke-test.sh",
    "deploy/scripts/smoke-weekly-ingestion.mjs",
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


def rewrite_payload_file(source: Path, target: Path, archive_path: str, data: bytes) -> None:
    def transform(info: zipfile.ZipInfo, original: bytes) -> tuple[zipfile.ZipInfo, bytes]:
        if info.filename == archive_path:
            return info, data
        return info, original

    rewrite_archive(source, target, transform)


class DockerArchiveTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="oknotika-docker-archive-test-")
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.commit = initialize_fixture_repo(self.repo)
        self.archive = self.root / "package.zip"
        builder.build_package(self.repo, "HEAD", self.archive)
        result = checker.inspect_archive(self.archive, self.commit, self.repo)
        self.assertEqual(result["errors"], [])

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_double_build_is_deterministic_and_uses_exact_commit_blobs(self) -> None:
        first = self.root / "first.zip"
        second = self.root / "second.zip"
        first_result = builder.build_package(self.repo, self.commit, first)
        second_result = builder.build_package(self.repo, self.commit, second)
        self.assertEqual(first_result["sha256"], second_result["sha256"])
        self.assertEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual(stat.S_IMODE(second.stat().st_mode), 0o644)
        self.assertFalse(second.with_name(f"{second.name}.sha256").exists())

        with zipfile.ZipFile(second) as archive:
            self.assertEqual(
                {name.split("/", 1)[0] for name in archive.namelist()},
                checker.ARCHIVE_ROOTS,
            )
            for archive_path in (
                "public-app/index.html",
                "deploy/scripts/smoke-weekly-ingestion.mjs",
                "deploy/docs/WEEKLY_INGESTION.md",
            ):
                self.assertIn(archive_path, archive.namelist())
            self.assertFalse(any("MANIFEST" in name for name in archive.namelist()))
            self.assertEqual(
                archive.read("public-app/index.html"),
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
            builder.build_package(self.repo, "HEAD", self.root / "dirty.zip")

        index.write_bytes(FIXTURE_FILES["index.html"])
        untracked = self.repo / "admin-app/private-runtime.txt"
        untracked.write_text("private input\n", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "private-runtime.txt"):
            builder.build_package(self.repo, "HEAD", self.root / "untracked.zip")

    def test_committed_content_tampering_is_rejected_without_a_shipped_manifest(self) -> None:
        tampered = self.root / "tampered.zip"

        def transform(info: zipfile.ZipInfo, data: bytes) -> tuple[zipfile.ZipInfo, bytes]:
            if info.filename == "public-app/index.html":
                return info, b"tampered\n"
            return info, data

        rewrite_archive(self.archive, tampered, transform)
        errors = checker.inspect_archive(tampered, self.commit, self.repo)["errors"]
        self.assertTrue(
            any("committed source content mismatch: public-app/index.html" in error for error in errors),
            errors,
        )

    def test_secret_content_and_runtime_paths_are_rejected(self) -> None:
        secret = self.root / "secret.zip"
        secret_marker = b"-----BEGIN " + b"PRIVATE KEY-----\nnot-a-real-key\n"
        rewrite_payload_file(self.archive, secret, "public-app/script.js", secret_marker)
        secret_errors = checker.inspect_archive(secret)["errors"]
        self.assertTrue(any(
            "private key detected in public-app/script.js" in error
            for error in secret_errors
        ), secret_errors)

        runtime = self.root / "runtime.zip"
        runtime_path = "admin-app/data/admin.sqlite"
        runtime_data = b"not-a-database"

        rewrite_archive(
            self.archive,
            runtime,
            additions=[(regular_info(runtime_path), runtime_data)],
        )
        runtime_errors = checker.inspect_archive(runtime)["errors"]
        self.assertTrue(any("secret/runtime path is forbidden" in error for error in runtime_errors), runtime_errors)
        self.assertTrue(any("secret/runtime file suffix is forbidden" in error for error in runtime_errors), runtime_errors)

    def test_credential_examples_allow_only_the_exact_invalid_placeholder(self) -> None:
        tampered = self.root / "credential-example.zip"
        example_path = "deploy/docker/secrets/telegram-oidc-client-secret.example"
        rewrite_payload_file(
            self.archive,
            tampered,
            example_path,
            checker.SECRET_EXAMPLE_PLACEHOLDERS[example_path] + b"opaque-production-value\n",
        )

        errors = checker.inspect_archive(tampered)["errors"]
        self.assertTrue(any(
            "credential example must contain only the invalid deployment placeholder" in error
            for error in errors
        ), errors)

    def test_traversal_symlink_duplicates_and_excluded_content_are_rejected(self) -> None:
        cases: list[tuple[str, zipfile.ZipInfo, bytes, str]] = [
            (
                "traversal",
                regular_info("admin-app/../escape"),
                b"escape",
                "unsafe archive path",
            ),
            (
                "evidence",
                regular_info("deploy/release-evidence/private.json"),
                b"private evidence",
                "unexpected Docker package content",
            ),
            (
                "prior-release",
                regular_info("admin-app/release/old.zip"),
                b"prior release",
                "secret/runtime path is forbidden",
            ),
            (
                "raw-portrait",
                regular_info("public-app/img/raw/portrait.jpg"),
                b"raw portrait",
                "raw photo path is forbidden",
            ),
            (
                "credential",
                regular_info("deploy/docker/secrets/telegram-oidc-client-secret"),
                b"assigned credential",
                "credential file is forbidden",
            ),
        ]
        symlink = zipfile.ZipInfo(
            "admin-app/current", builder.FIXED_TIMESTAMP
        )
        symlink.create_system = 3
        symlink.compress_type = zipfile.ZIP_DEFLATED
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        cases.append(("symlink", symlink, b"releases/target", "symlink is forbidden"))

        for label, info, data, expected in cases:
            with self.subTest(label=label):
                changed = self.root / f"{label}.zip"
                rewrite_archive(self.archive, changed, additions=[(info, data)])
                errors = checker.inspect_archive(changed)["errors"]
                self.assertTrue(any(expected in error for error in errors), errors)

        duplicate = self.root / "duplicate.zip"
        with zipfile.ZipFile(self.archive) as archive:
            original_info = archive.getinfo("public-app/index.html")
            duplicate_entry = (copy.copy(original_info), archive.read(original_info))
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            rewrite_archive(self.archive, duplicate, additions=[duplicate_entry])
        duplicate_errors = checker.inspect_archive(duplicate)["errors"]
        self.assertTrue(any("duplicate filenames" in error for error in duplicate_errors), duplicate_errors)


if __name__ == "__main__":
    unittest.main()
