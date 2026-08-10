from __future__ import annotations

import copy
import grp
import hashlib
import json
import os
import pwd
import shutil
import stat
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
DEPLOY = REPO / "deploy/cicd/oknotika-deploy"
SHA = "a" * 40
PREVIOUS_APPLICATION_SHA = "b" * 40
PREVIOUS_MARKETING_SHA = "c" * 40


def executable_info(name: str, mode: int = 0o644) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = (stat.S_IFREG | mode) << 16
    return info


class ServerDeployPrimitiveTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="oknotika-server-deploy-")
        self.root = Path(self.temporary.name)
        self.application_root = self.root / "application"
        self.marketing_root = self.root / "marketing"
        self.incoming_root = self.root / "incoming"
        self.lock_root = self.root / "lock"
        self.bin_root = self.root / "bin"
        self.runtime_root = self.root / "runtime-bin"
        for path in (
            self.application_root / "releases",
            self.marketing_root / "releases",
            self.incoming_root,
            self.lock_root,
            self.bin_root,
            self.runtime_root,
        ):
            path.mkdir(parents=True)

        previous_application = self.application_root / "releases" / PREVIOUS_APPLICATION_SHA
        previous_smoke = previous_application / "deploy/scripts/smoke-test.sh"
        previous_smoke.parent.mkdir(parents=True)
        self.write_executable(previous_smoke, self.smoke_script())
        (self.marketing_root / "releases" / PREVIOUS_MARKETING_SHA).mkdir()
        (self.marketing_root / "releases" / PREVIOUS_MARKETING_SHA / "index.html").write_text(
            "previous\n", encoding="utf-8"
        )
        (self.application_root / "current").symlink_to(
            f"releases/{PREVIOUS_APPLICATION_SHA}"
        )
        (self.marketing_root / "current").symlink_to(
            f"releases/{PREVIOUS_MARKETING_SHA}"
        )

        self.article_root = self.root / "state/article-releases/releases/content-1"
        self.article_root.mkdir(parents=True)
        self.article_current = self.root / "state/article-releases/active"
        self.article_current.symlink_to("releases/content-1")

        self.log = self.root / "commands.log"
        self.smoke_count = self.root / "smoke-count"
        self.make_command_stubs()
        self.bundle = self.incoming_root / f"{SHA}.zip"
        self.checksum = self.incoming_root / f"{SHA}.zip.sha256"
        self.build_bundle()

        user = pwd.getpwuid(os.getuid()).pw_name
        group = grp.getgrgid(os.getgid()).gr_name
        gnu_mv = shutil.which("gmv") or shutil.which("mv")
        gnu_realpath = shutil.which("grealpath") or shutil.which("realpath")
        gnu_sha256sum = shutil.which("gsha256sum") or shutil.which("sha256sum")
        assert gnu_mv and gnu_realpath and gnu_sha256sum
        self.env = {
            **os.environ,
            "PATH": f"{self.bin_root}:{os.environ.get('PATH', '')}",
            "OKNOTIKA_ALLOW_UNPRIVILEGED_TEST": "1",
            "OKNOTIKA_APPLICATION_ROOT": str(self.application_root),
            "OKNOTIKA_MARKETING_ROOT": str(self.marketing_root),
            "OKNOTIKA_INCOMING_ROOT": str(self.incoming_root),
            "OKNOTIKA_DEPLOY_LOCK": str(self.lock_root / "deploy.lock"),
            "OKNOTIKA_NODE_BIN": str(self.runtime_root / "node"),
            "OKNOTIKA_NPM_BIN": str(self.runtime_root / "npm"),
            "OKNOTIKA_MARKETING_INSTALLER_BIN": str(
                self.bin_root / "oknotika-install-marketing"
            ),
            "OKNOTIKA_SYSTEMCTL_BIN": str(self.bin_root / "systemctl"),
            "OKNOTIKA_FLOCK_BIN": str(self.bin_root / "flock"),
            "OKNOTIKA_REALPATH_BIN": gnu_realpath,
            "OKNOTIKA_SHA256SUM_BIN": gnu_sha256sum,
            "OKNOTIKA_MV_BIN": gnu_mv,
            "OKNOTIKA_SLEEP_BIN": str(self.bin_root / "sleep"),
            "OKNOTIKA_SERVICE_USER": user,
            "OKNOTIKA_SERVICE_GROUP": group,
            "OKNOTIKA_RELEASE_OWNER": user,
            "OKNOTIKA_RELEASE_GROUP": group,
            "OKNOTIKA_TEST_LOG": str(self.log),
            "OKNOTIKA_SMOKE_COUNT": str(self.smoke_count),
        }

    def tearDown(self) -> None:
        self.temporary.cleanup()

    @staticmethod
    def smoke_script() -> str:
        return """#!/usr/bin/env bash
set -euo pipefail
count=0
[[ ! -f "$OKNOTIKA_SMOKE_COUNT" ]] || count="$(< "$OKNOTIKA_SMOKE_COUNT")"
count=$((count + 1))
printf '%s\n' "$count" > "$OKNOTIKA_SMOKE_COUNT"
[[ "$(node --version)" == "v24.18.0" ]]
printf 'smoke:%s:%s\n' "$(readlink "$OKNOTIKA_APPLICATION_ROOT/current")" "$(readlink "$OKNOTIKA_MARKETING_ROOT/current")" >> "$OKNOTIKA_TEST_LOG"
if (( count <= ${OKNOTIKA_SMOKE_FAILURES:-0} )); then
  echo "injected post-switch smoke failure" >&2
  exit 42
fi
"""

    @staticmethod
    def write_executable(path: Path, content: str) -> None:
        path.write_text(content, encoding="utf-8")
        path.chmod(0o755)

    def make_command_stubs(self) -> None:
        self.write_executable(
            self.runtime_root / "node",
            """#!/usr/bin/env bash
[[ "${1:-}" == "--version" ]] || exit 2
echo v24.18.0
""",
        )
        self.write_executable(
            self.runtime_root / "npm",
            """#!/usr/bin/env bash
[[ "$(node --version)" == "v24.18.0" ]]
printf 'npm:%s\n' "$*" >> "$OKNOTIKA_TEST_LOG"
mkdir node_modules
printf 'locked runtime\n' > node_modules/runtime.txt
""",
        )
        self.write_executable(
            self.bin_root / "systemctl",
            """#!/usr/bin/env bash
printf 'systemctl:%s:app=%s:marketing=%s\n' "$*" "$(readlink "$OKNOTIKA_APPLICATION_ROOT/current")" "$(readlink "$OKNOTIKA_MARKETING_ROOT/current")" >> "$OKNOTIKA_TEST_LOG"
""",
        )
        self.write_executable(
            self.bin_root / "flock",
            """#!/usr/bin/env bash
[[ "$1" == "-n" && "$2" == "9" ]]
""",
        )
        self.write_executable(
            self.bin_root / "sleep",
            """#!/usr/bin/env bash
printf 'sleep:%s\n' "$*" >> "$OKNOTIKA_TEST_LOG"
""",
        )
        self.write_executable(
            self.bin_root / "oknotika-install-marketing",
            (REPO / "deploy/scripts/install-marketing.sh").read_text(encoding="utf-8"),
        )
        gnu_mv = shutil.which("gmv") or shutil.which("mv")
        gnu_ln = shutil.which("gln") or shutil.which("ln")
        assert gnu_mv and gnu_ln
        self.write_executable(
            self.bin_root / "mv", f'#!/usr/bin/env bash\nexec "{gnu_mv}" "$@"\n'
        )
        self.write_executable(
            self.bin_root / "ln", f'#!/usr/bin/env bash\nexec "{gnu_ln}" "$@"\n'
        )

    def build_bundle(
        self,
        additions: list[tuple[zipfile.ZipInfo, bytes]] | None = None,
        overrides: dict[str, tuple[bytes, int]] | None = None,
    ) -> None:
        package_lock = b'{"lockfileVersion":3,"packages":{}}\n'
        release_manifest = json.dumps(
            {
                "runtime": {
                    "nodeVersion": "24.18.0",
                    "packageLockVersion": 3,
                    "packageLockSha256": hashlib.sha256(package_lock).hexdigest(),
                }
            },
            sort_keys=True,
        ).encode() + b"\n"
        files: dict[str, tuple[bytes, int]] = {
            "index.html": (b"<title>OKNOTIKA</title>\n", 0o644),
            "script.js": (b"console.log('ok')\n", 0o644),
            "style.css": (b"body{}\n", 0o644),
            "js/latest-fact.js": (b"export default true\n", 0o644),
            "img/logo-oknotika.svg": (b"<svg/>\n", 0o644),
            "articles/index.html": (b"articles\n", 0o644),
            "articles/latest.json": (b"{}\n", 0o644),
            "admin-app/package.json": (b'{"name":"oknotika-admin"}\n', 0o644),
            "admin-app/package-lock.json": (package_lock, 0o644),
            "admin-app/src/http/start.js": (b"// start\n", 0o644),
            "deploy/release-manifest.json": (release_manifest, 0o644),
            "deploy/cicd/oknotika-deploy": (DEPLOY.read_bytes(), 0o755),
            "deploy/scripts/install-marketing.sh": (
                (REPO / "deploy/scripts/install-marketing.sh").read_bytes(),
                0o755,
            ),
            "deploy/scripts/preflight.sh": (
                b"#!/usr/bin/env bash\nset -euo pipefail\n[[ \"$(node --version)\" == \"v24.18.0\" ]]\nprintf 'preflight:%s\\n' \"$OKNOTIKA_APP_ROOT\" >> \"$OKNOTIKA_TEST_LOG\"\n",
                0o755,
            ),
            "deploy/scripts/smoke-test.sh": (self.smoke_script().encode(), 0o755),
            "deploy/systemd/oknotika-admin.service": (b"[Service]\n", 0o644),
        }
        files.update(overrides or {})
        manifest = {
            "schemaVersion": 1,
            "format": "oknotika-ci-bundle",
            "implementationCommit": SHA,
            "payloadRoot": f"oknotika-ci-{SHA}",
            "files": {
                path: {
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "bytes": len(data),
                    "mode": f"{mode:04o}",
                }
                for path, (data, mode) in sorted(files.items())
            },
        }
        with zipfile.ZipFile(self.bundle, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path, (data, mode) in sorted(files.items()):
                archive.writestr(executable_info(f"oknotika-ci-{SHA}/{path}", mode), data)
            archive.writestr(
                executable_info(f"oknotika-ci-{SHA}/BUNDLE_MANIFEST.json"),
                (json.dumps(manifest, sort_keys=True) + "\n").encode(),
            )
            for info, data in additions or []:
                archive.writestr(info, data)
        digest = hashlib.sha256(self.bundle.read_bytes()).hexdigest()
        self.checksum.write_text(f"{digest}  {self.bundle.name}\n", encoding="ascii")

    def run_deploy(self, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                "bash",
                str(DEPLOY),
                "--bundle",
                str(self.bundle),
                "--checksum-file",
                str(self.checksum),
                "--release-sha",
                SHA,
            ],
            env=env or self.env,
            capture_output=True,
            text=True,
            check=False,
        )

    def rewrite_bundle_file_without_updating_manifest(self, relative: str, data: bytes) -> None:
        changed = self.root / "changed.zip"
        expected = f"oknotika-ci-{SHA}/{relative}"
        with zipfile.ZipFile(self.bundle) as source, zipfile.ZipFile(
            changed, "w", compression=zipfile.ZIP_DEFLATED
        ) as target:
            for original in source.infolist():
                target.writestr(
                    copy.copy(original),
                    data if original.filename == expected else source.read(original),
                )
        os.replace(changed, self.bundle)
        digest = hashlib.sha256(self.bundle.read_bytes()).hexdigest()
        self.checksum.write_text(f"{digest}  {self.bundle.name}\n", encoding="ascii")

    def test_success_installs_both_immutable_releases_and_health_checks(self) -> None:
        result = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(os.readlink(self.application_root / "current"), f"releases/{SHA}")
        self.assertEqual(os.readlink(self.marketing_root / "current"), f"releases/{SHA}")
        application = self.application_root / "releases" / SHA
        marketing = self.marketing_root / "releases" / SHA
        self.assertTrue((application / "admin-app/node_modules/runtime.txt").is_file())
        self.assertTrue((application / "BUNDLE_MANIFEST.json").is_file())
        self.assertTrue((marketing / "index.html").is_file())
        self.assertFalse((marketing / "admin-app").exists())
        events = self.log.read_text(encoding="utf-8").splitlines()
        self.assertTrue(events[0].startswith("npm:ci --omit=dev"), events)
        self.assertTrue(events[1].startswith("preflight:"), events)
        self.assertIn(f"systemctl:restart oknotika-admin.service:app=releases/{SHA}:marketing=releases/{SHA}", events)
        self.assertEqual(events[-1], f"smoke:releases/{SHA}:releases/{SHA}")
        self.assertEqual(os.readlink(self.article_current), "releases/content-1")

    def test_smoke_retries_a_startup_readiness_race_before_succeeding(self) -> None:
        result = self.run_deploy({**self.env, "OKNOTIKA_SMOKE_FAILURES": "1"})
        self.assertEqual(result.returncode, 0, result.stderr)
        events = self.log.read_text(encoding="utf-8").splitlines()
        self.assertEqual(sum(event.startswith("systemctl:restart") for event in events), 1)
        self.assertEqual(sum(event.startswith("smoke:") for event in events), 2)
        self.assertIn("Smoke attempt 1 failed", result.stderr)

    def test_post_switch_failure_restores_exact_targets_and_verifies_health(self) -> None:
        env = {**self.env, "OKNOTIKA_SMOKE_FAILURES": "5"}
        result = self.run_deploy(env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Rollback health verified", result.stderr)
        self.assertEqual(
            os.readlink(self.application_root / "current"),
            f"releases/{PREVIOUS_APPLICATION_SHA}",
        )
        self.assertEqual(
            os.readlink(self.marketing_root / "current"),
            f"releases/{PREVIOUS_MARKETING_SHA}",
        )
        self.assertFalse((self.application_root / "releases" / SHA).exists())
        self.assertFalse((self.marketing_root / "releases" / SHA).exists())
        self.assertTrue(self.bundle.is_file())
        events = self.log.read_text(encoding="utf-8").splitlines()
        self.assertEqual(sum(event.startswith("systemctl:restart") for event in events), 2)
        self.assertEqual(sum(event.startswith("smoke:") for event in events), 6)
        self.assertEqual(
            events[-1],
            f"smoke:releases/{PREVIOUS_APPLICATION_SHA}:releases/{PREVIOUS_MARKETING_SHA}",
        )
        self.assertEqual(os.readlink(self.article_current), "releases/content-1")

        retry = self.run_deploy()
        self.assertEqual(retry.returncode, 0, retry.stderr)
        self.assertEqual(os.readlink(self.application_root / "current"), f"releases/{SHA}")
        self.assertEqual(os.readlink(self.marketing_root / "current"), f"releases/{SHA}")

    def test_artifact_cannot_replace_the_root_installed_marketing_helper(self) -> None:
        marker = self.root / "artifact-installer-ran"
        artifact_installer = (
            b"#!/usr/bin/env bash\n"
            b"touch \"$OKNOTIKA_ARTIFACT_INSTALLER_MARKER\"\n"
            b"exit 99\n"
        )
        self.build_bundle(
            overrides={"deploy/scripts/install-marketing.sh": (artifact_installer, 0o755)}
        )
        result = self.run_deploy(
            {**self.env, "OKNOTIKA_ARTIFACT_INSTALLER_MARKER": str(marker)}
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(marker.exists())

    def test_initial_bootstrap_and_checksum_fail_closed_before_staging(self) -> None:
        (self.marketing_root / "current").unlink()
        bootstrap = self.run_deploy()
        self.assertNotEqual(bootstrap.returncode, 0)
        self.assertIn("initial bootstrap is required", bootstrap.stderr)
        self.assertFalse((self.application_root / "releases" / SHA).exists())

        (self.marketing_root / "current").symlink_to(f"releases/{PREVIOUS_MARKETING_SHA}")
        self.checksum.write_text(f"{'0' * 64}  {self.bundle.name}\n", encoding="ascii")
        checksum = self.run_deploy()
        self.assertNotEqual(checksum.returncode, 0)
        self.assertIn("does not match the checksum file", checksum.stderr)
        self.assertFalse((self.application_root / "releases" / SHA).exists())

    def test_archive_traversal_is_rejected_without_switching(self) -> None:
        unsafe = executable_info(f"oknotika-ci-{SHA}/../escape")
        self.build_bundle(additions=[(unsafe, b"escape\n")])
        result = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsafe archive path", result.stderr)
        self.assertEqual(
            os.readlink(self.application_root / "current"),
            f"releases/{PREVIOUS_APPLICATION_SHA}",
        )
        self.assertFalse((self.application_root / "releases" / SHA).exists())

    def test_internal_manifest_tampering_and_symlinks_are_rejected(self) -> None:
        self.rewrite_bundle_file_without_updating_manifest("index.html", b"tampered\n")
        tampered = self.run_deploy()
        self.assertNotEqual(tampered.returncode, 0)
        self.assertIn("manifest checksum/size/mode mismatch", tampered.stderr)

        symlink = zipfile.ZipInfo(
            f"oknotika-ci-{SHA}/admin-app/current", (1980, 1, 1, 0, 0, 0)
        )
        symlink.create_system = 3
        symlink.compress_type = zipfile.ZIP_DEFLATED
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        self.build_bundle(additions=[(symlink, b"releases/escape")])
        linked = self.run_deploy()
        self.assertNotEqual(linked.returncode, 0)
        self.assertIn("regular 0644/0755 file", linked.stderr)
        self.assertEqual(
            os.readlink(self.application_root / "current"),
            f"releases/{PREVIOUS_APPLICATION_SHA}",
        )
        self.assertFalse((self.application_root / "releases" / SHA).exists())

    def test_primitive_is_root_defaulted_and_has_no_content_activation_path(self) -> None:
        source = DEPLOY.read_text(encoding="utf-8")
        self.assertIn("/opt/oknotika-admin", source)
        self.assertIn("/srv/oknotika", source)
        self.assertIn("/var/lib/oknotika-deploy/incoming", source)
        self.assertIn("/usr/local/sbin/oknotika-install-marketing", source)
        self.assertIn('"$flock_bin" -n 9', source)
        self.assertNotIn('"$application_target/deploy/scripts/install-marketing.sh"', source)
        self.assertNotIn("article-releases/active", source)


if __name__ == "__main__":
    unittest.main()
