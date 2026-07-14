from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "scripts/scan_release_zip.py"
SPEC = importlib.util.spec_from_file_location("scan_release_zip", SCRIPT)
assert SPEC and SPEC.loader
scanner = importlib.util.module_from_spec(SPEC)
sys.modules["scan_release_zip"] = scanner
SPEC.loader.exec_module(scanner)

DOCS_SCRIPT = REPO / "scripts/check_final_documentation.py"
DOCS_SPEC = importlib.util.spec_from_file_location("check_final_documentation", DOCS_SCRIPT)
assert DOCS_SPEC and DOCS_SPEC.loader
docs_checker = importlib.util.module_from_spec(DOCS_SPEC)
sys.modules["check_final_documentation"] = docs_checker
DOCS_SPEC.loader.exec_module(docs_checker)

BUILD_SCRIPT = REPO / "scripts/build_release_zip.py"
BUILD_SPEC = importlib.util.spec_from_file_location("build_release_zip", BUILD_SCRIPT)
assert BUILD_SPEC and BUILD_SPEC.loader
builder = importlib.util.module_from_spec(BUILD_SPEC)
BUILD_SPEC.loader.exec_module(builder)


def archive_with(extra: dict[str, bytes] | None = None) -> Path:
    directory = Path(tempfile.mkdtemp(prefix="oknotika-zip-test-"))
    filename = directory / "release.zip"
    root = "oknotika-final-test"
    files = {
        "CHANGED_FILES.txt": b"A\tCHANGED_FILES.txt\n",
        "README.md": b"readme",
        "RELEASE_NOTES.md": b"notes",
        "index.html": b"<title>OKNOTIKA</title>",
        "admin-app/package-lock.json": b"{}",
        "deploy/README_ZHENYA.md": b"deploy",
        "deploy/systemd/oknotika-admin.service": b"[Service]",
        **(extra or {}),
    }
    manifest = {
        "version": "test",
        "files": {
            path: {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
            for path, data in files.items()
        },
    }
    with zipfile.ZipFile(filename, "w") as archive:
        for path, data in files.items():
            archive.writestr(f"{root}/{path}", data)
        archive.writestr(f"{root}/RELEASE_MANIFEST.json", json.dumps(manifest).encode())
    return filename


class ReleaseZipTests(unittest.TestCase):
    def test_clean_secret_free_package_passes(self) -> None:
        result = scanner.scan_archive(str(archive_with()))
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["status"], "pass")

    def test_runtime_data_and_secrets_fail_closed(self) -> None:
        result = scanner.scan_archive(str(archive_with({
            "uploads/raw/source.jpg": b"private",
            "admin-app/.env": b"TELEGRAM_OIDC_CLIENT_" + b"SECRET=" + b"credential-value-for-test",
            "server.key": b"-----BEGIN PRIVATE " + b"KEY-----\nprivate\n",
        })))
        self.assertEqual(result["status"], "fail")
        joined = "\n".join(result["errors"])
        self.assertIn("private/runtime path", joined)
        self.assertIn("environment file", joined)
        self.assertIn("private key", joined)

    def test_manifest_tampering_is_detected(self) -> None:
        filename = archive_with()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(filename, "a") as archive:
                archive.writestr("oknotika-final-test/index.html", b"tampered")
        result = scanner.scan_archive(str(filename))
        self.assertEqual(result["status"], "fail")
        self.assertTrue(any("duplicate" in error or "mismatch" in error for error in result["errors"]))

    def test_large_files_and_environment_variants_are_scanned_for_secrets(self) -> None:
        private_key_marker = b"-----BEGIN " + b"PRIVATE KEY-----"
        large_secret = b"x" * (4 * 1024 * 1024 + 17) + b"\n" + private_key_marker + b"\n"
        result = scanner.scan_archive(str(archive_with({
            "docs/large-record.txt": large_secret,
            "admin-app/.env.production": b"SAFE_NAME=placeholder\n",
        })))
        self.assertEqual(result["status"], "fail")
        joined = "\n".join(result["errors"])
        self.assertIn("private key", joined)
        self.assertIn("environment file", joined)

    def test_builder_uses_committed_blobs_and_rejects_dirty_payload_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.email", "test@example.com"], check=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.name", "Test"], check=True)
            (repo / "admin-app").mkdir()
            tracked = repo / "admin-app/tracked.txt"
            tracked.write_text("committed\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
            subprocess.run(["git", "-C", str(repo), "commit", "-qm", "fixture"], check=True)

            tracked.write_text("working tree\n", encoding="utf-8")
            (repo / "admin-app/private-rights.txt").write_text("private\n", encoding="utf-8")
            self.assertEqual(builder.source_paths(repo), [Path("admin-app/tracked.txt")])
            self.assertEqual(builder.git_blob(repo, "HEAD", Path("admin-app/tracked.txt")), b"committed\n")
            with self.assertRaisesRegex(RuntimeError, "worktree must be clean"):
                builder.ensure_clean_payload_worktree(repo)


class FinalDocumentationTests(unittest.TestCase):
    def test_final_documentation_and_release_records_are_consistent(self) -> None:
        self.assertEqual(docs_checker.validate(REPO), [])

    def test_stale_preview_markers_are_rejected(self) -> None:
        errors = docs_checker.validate_readme_text(
            "# ОКНОТИКА — финальный beta-релиз сайта\nV2.18\nV2.25\n"
        )
        self.assertTrue(any("V2.18" in error for error in errors))
        self.assertTrue(any("V2.25" in error for error in errors))
        homepage_errors = docs_checker.validate_public_html_text(
            '<footer><p>V2.25 multipage preview</p></footer>'
        )
        self.assertTrue(any("index.html" in error and "V2.25" in error for error in homepage_errors))

    def test_release_only_followup_is_allowed_but_later_source_change_is_stale(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.email", "test@example.com"], check=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.name", "Test"], check=True)
            (repo / "app.js").write_text("first\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
            subprocess.run(["git", "-C", str(repo), "commit", "-qm", "implementation"], check=True)
            implementation = subprocess.run(
                ["git", "-C", str(repo), "rev-parse", "HEAD"],
                check=True, capture_output=True, text=True,
            ).stdout.strip()
            (repo / "release").mkdir()
            (repo / "release/package.zip").write_bytes(b"release")
            subprocess.run(["git", "-C", str(repo), "add", "release"], check=True)
            subprocess.run(["git", "-C", str(repo), "commit", "-qm", "release"], check=True)
            self.assertEqual(docs_checker.non_release_changes_since(repo, implementation), [])

            (repo / "app.js").write_text("later source change\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(repo), "add", "app.js"], check=True)
            subprocess.run(["git", "-C", str(repo), "commit", "-qm", "source"], check=True)
            self.assertEqual(docs_checker.non_release_changes_since(repo, implementation), ["app.js"])


if __name__ == "__main__":
    unittest.main()
