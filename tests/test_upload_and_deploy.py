from __future__ import annotations

import hashlib
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
HELPER = REPO / "deploy/cicd/upload-and-deploy.sh"
SHA = "d" * 40


class UploadAndDeployHelperTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="oknotika-upload-helper-")
        self.root = Path(self.temporary.name)
        self.bin_root = self.root / "bin"
        self.bin_root.mkdir()
        self.log = self.root / "commands.log"
        self.bundle = self.root / f"{SHA}.zip"
        self.bundle.write_bytes(b"reviewed bundle\n")
        digest = hashlib.sha256(self.bundle.read_bytes()).hexdigest()
        self.checksum = self.root / f"{SHA}.zip.sha256"
        self.checksum.write_text(f"{digest}  {self.bundle.name}\n", encoding="ascii")
        self.identity = self.root / "deploy-identity"
        self.identity.write_text("private material fixture\n", encoding="utf-8")
        self.known_hosts = self.root / "known-hosts"
        self.known_hosts.write_text("deploy.example.test ssh-ed25519 fixture\n", encoding="utf-8")
        self.make_stubs()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_executable(self, name: str, source: str) -> None:
        path = self.bin_root / name
        path.write_text(source, encoding="utf-8")
        path.chmod(0o755)

    def make_stubs(self) -> None:
        self.write_executable(
            "ssh-keygen",
            "#!/usr/bin/env bash\n"
            "printf 'ssh-keygen:%s\\n' \"$*\" >> \"$OKNOTIKA_HELPER_TEST_LOG\"\n"
            "[[ \"$*\" == *'deploy.example.test'* ]]\n",
        )
        self.write_executable(
            "scp",
            "#!/usr/bin/env bash\n"
            "printf 'scp:%s\\n' \"$*\" >> \"$OKNOTIKA_HELPER_TEST_LOG\"\n",
        )
        self.write_executable(
            "ssh",
            "#!/usr/bin/env bash\n"
            "printf 'ssh:%s\\n' \"$*\" >> \"$OKNOTIKA_HELPER_TEST_LOG\"\n",
        )

    def command(self, **replacements: str) -> list[str]:
        values = {
            "bundle": str(self.bundle),
            "checksum": str(self.checksum),
            "sha": SHA,
            "host": "deploy.example.test",
            "port": "22",
            "user": "oknotika-deploy",
            "identity": str(self.identity),
            "known_hosts": str(self.known_hosts),
            "incoming": "/var/lib/oknotika-deploy/incoming",
            **replacements,
        }
        return [
            "bash", str(HELPER),
            "--bundle", values["bundle"],
            "--checksum-file", values["checksum"],
            "--release-sha", values["sha"],
            "--host", values["host"],
            "--port", values["port"],
            "--user", values["user"],
            "--identity-file", values["identity"],
            "--known-hosts", values["known_hosts"],
            "--remote-incoming", values["incoming"],
        ]

    def run_helper(self, **replacements: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            self.command(**replacements),
            env={
                **os.environ,
                "PATH": f"{self.bin_root}:{os.environ['PATH']}",
                "OKNOTIKA_HELPER_TEST_LOG": str(self.log),
            },
            capture_output=True,
            text=True,
            check=False,
        )

    def test_verified_files_are_uploaded_and_fixed_primitive_is_invoked(self) -> None:
        result = self.run_helper()
        self.assertEqual(result.returncode, 0, result.stderr)
        events = self.log.read_text(encoding="utf-8").splitlines()
        self.assertEqual(sum(event.startswith("scp:") for event in events), 1)
        self.assertEqual(sum(event.startswith("ssh:") for event in events), 1)
        joined = "\n".join(events)
        self.assertIn("StrictHostKeyChecking=yes", joined)
        self.assertIn("sudo -n /usr/local/sbin/oknotika-deploy", joined)
        self.assertIn(f"--release-sha {SHA}", joined)
        self.assertNotIn("private material fixture", joined)

    def test_checksum_host_and_remote_destination_fail_before_network(self) -> None:
        self.checksum.write_text(f"{'0' * 64}  {self.bundle.name}\n", encoding="ascii")
        checksum = self.run_helper()
        self.assertNotEqual(checksum.returncode, 0)
        self.assertIn("does not match", checksum.stderr)
        self.assertFalse(self.log.exists())

        digest = hashlib.sha256(self.bundle.read_bytes()).hexdigest()
        self.checksum.write_text(f"{digest}  {self.bundle.name}\n", encoding="ascii")
        for replacements, expected in (
            ({"host": "host;command"}, "host must be"),
            ({"incoming": "/tmp/incoming"}, "reviewed fixed path"),
        ):
            with self.subTest(replacements=replacements):
                result = self.run_helper(**replacements)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected, result.stderr)
                self.assertFalse(self.log.exists())
