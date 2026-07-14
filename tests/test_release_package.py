from __future__ import annotations

import hashlib
import importlib.util
import json
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


def archive_with(extra: dict[str, bytes] | None = None) -> Path:
    directory = Path(tempfile.mkdtemp(prefix="oknotika-zip-test-"))
    filename = directory / "release.zip"
    root = "oknotika-final-test"
    files = {
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


if __name__ == "__main__":
    unittest.main()
