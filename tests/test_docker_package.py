from __future__ import annotations

import copy
import importlib.util
import os
import re
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock


REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "scripts/check_docker_package.py"
SPEC = importlib.util.spec_from_file_location("check_docker_package", SCRIPT)
assert SPEC and SPEC.loader
checker = importlib.util.module_from_spec(SPEC)
sys.modules["check_docker_package"] = checker
SPEC.loader.exec_module(checker)


class DockerPackageTests(unittest.TestCase):
    def test_static_package_policy_passes(self) -> None:
        self.assertEqual(checker.validate(REPO), [])

    @unittest.skipUnless(shutil.which("docker"), "docker compose is unavailable")
    def test_resolved_compose_topology_passes(self) -> None:
        model = checker.compose_model(REPO)
        self.assertEqual(checker.validate_compose_model(model), [])

    @unittest.skipUnless(shutil.which("docker"), "docker compose is unavailable")
    def test_compose_model_ignores_ambient_topology_overrides(self) -> None:
        overrides = {
            "OKNOTIKA_HOST_ROOT": "/tmp/ambient-oknotika-host",
            "OKNOTIKA_BUILD_ROOT": "/tmp/ambient-oknotika-build",
            "OKNOTIKA_ADMIN_PORT": "18000",
            "OKNOTIKA_PUBLIC_PORT": "18001",
        }
        with mock.patch.dict(os.environ, overrides):
            model = checker.compose_model(REPO)

        self.assertEqual(checker.validate_compose_model(model), [])
        for service in model["services"].values():
            self.assertEqual(service["build"]["context"], str(REPO))

    @unittest.skipUnless(shutil.which("docker"), "docker compose is unavailable")
    def test_resolved_bind_mount_defaults_are_cross_version_safe(self) -> None:
        model = checker.compose_model(REPO)
        omitted = copy.deepcopy(model)
        for service in omitted["services"].values():
            for volume in service.get("volumes", []):
                volume.get("bind", {}).pop("create_host_path", None)
        self.assertEqual(checker.validate_compose_model(omitted), [])

        for service_name, expected_error in (
            ("admin", "admin persistent bind mappings are not exact"),
            ("public", "public must mount only article_releases read-only"),
        ):
            with self.subTest(service=service_name, field="create_host_path"):
                explicit_true = copy.deepcopy(model)
                volume = explicit_true["services"][service_name]["volumes"][0]
                volume.setdefault("bind", {})["create_host_path"] = True
                self.assertIn(
                    expected_error,
                    checker.validate_compose_model(explicit_true),
                )

        regressions = (
            ("admin", "type", "volume"),
            ("admin", "source", "/tmp/wrong-source"),
            ("admin", "target", "/tmp/wrong-target"),
            ("admin", "read_only", True),
            ("public", "type", "volume"),
            ("public", "source", "/tmp/wrong-source"),
            ("public", "target", "/tmp/wrong-target"),
            ("public", "read_only", False),
        )
        for service_name, field, wrong_value in regressions:
            with self.subTest(service=service_name, field=field):
                changed = copy.deepcopy(omitted)
                changed["services"][service_name]["volumes"][0][field] = wrong_value
                self.assertTrue(checker.validate_compose_model(changed))

    @unittest.skipUnless(shutil.which("docker"), "docker compose is unavailable")
    def test_public_private_bind_mount_or_public_port_regressions_are_rejected(self) -> None:
        model = checker.compose_model(REPO)
        private_mount = copy.deepcopy(model)
        private_mount["services"]["public"]["volumes"].append({
            "type": "bind",
            "source": "/var/home/oknotika/admin-app/data/uploads",
            "target": "/srv/private",
        })
        self.assertTrue(any(
            "public must mount only" in error
            for error in checker.validate_compose_model(private_mount)
        ))

        public_port = copy.deepcopy(model)
        public_port["services"]["admin"]["ports"][0]["host_ip"] = "0.0.0.0"
        self.assertTrue(any(
                "port binding is not exact" in error
                for error in checker.validate_compose_model(public_port)
            ))

    def test_archive_sibling_source_layout_and_scoped_dockerignores(self) -> None:
        admin = (REPO / "deploy/docker/admin.Dockerfile").read_text(encoding="utf-8")
        public = (REPO / "deploy/docker/public.Dockerfile").read_text(encoding="utf-8")
        compose = (REPO / "deploy/docker/docker-compose.yml").read_text(encoding="utf-8")

        self.assertIn("context: ${OKNOTIKA_BUILD_ROOT:-../..}", compose)
        self.assertIn("COPY admin-app/package.json admin-app/package-lock.json ./", admin)
        self.assertIn("COPY --chown=node:node public-app/style.css", admin)
        self.assertIn("COPY public-app/index.html public-app/style.css public-app/script.js", public)
        self.assertNotIn("\nCOPY index.html", public)

        for name in ("admin.Dockerfile.dockerignore", "public.Dockerfile.dockerignore"):
            ignore = REPO / "deploy/docker" / name
            self.assertTrue(ignore.is_file(), name)
            contents = ignore.read_text(encoding="utf-8")
            self.assertIn("**/data", contents)

    def test_exact_host_data_layout_is_documented_and_reserved(self) -> None:
        compose = (REPO / "deploy/docker/docker-compose.yml").read_text(encoding="utf-8")
        runbook = (REPO / "deploy/docker/README_ZHENYA.md").read_text(encoding="utf-8")
        for path in (
            "/var/home/oknotika/admin-app",
            "/var/home/oknotika/public-app",
            "/var/home/oknotika/admin-app/data",
            "/var/home/oknotika/public-app/data",
        ):
            with self.subTest(path=path):
                self.assertIn(path, runbook)
        self.assertIn("${OKNOTIKA_HOST_ROOT:-/var/home/oknotika}/admin-app/data/db", compose)
        self.assertIn("${OKNOTIKA_HOST_ROOT:-/var/home/oknotika}/admin-app/data/secrets", compose)
        self.assertNotIn("\nvolumes:\n", compose)
        self.assertNotIn("/var/lib/oknotika-admin", compose)

    def test_direct_compose_credentials_are_rejected(self) -> None:
        compose = (REPO / "deploy/docker/docker-compose.yml").read_text(encoding="utf-8")
        changed = compose.replace(
            "OKNOTIKA_LOCAL_PASSWORD_HASH_FILE: /run/secrets/local_password_hash",
            "OKNOTIKA_LOCAL_PASSWORD: assigned-value",
        )
        self.assertIn(
            "Compose environment contains a direct credential value",
            checker.validate_compose_text(changed),
        )

    def test_credential_examples_allow_only_the_exact_invalid_placeholder(self) -> None:
        name = "local-password-hash"
        relative = f"deploy/docker/secrets/{name}.example"
        placeholder = checker.SECRET_EXAMPLE_PLACEHOLDERS[name]
        self.assertEqual(
            checker.validate_secret_example_text(placeholder, relative, placeholder),
            [],
        )
        self.assertTrue(checker.validate_secret_example_text(
            placeholder + "opaque-production-value\n",
            relative,
            placeholder,
        ))

    def test_root_credential_helper_keeps_plaintext_out_of_process_configuration(self) -> None:
        helper = (REPO / "deploy/docker/configure-local-credentials.sh").read_text(encoding="utf-8")
        self.assertIn('[[ "$(id -u)" -ne 0 ]]', helper)
        self.assertIn('IFS= read -r -s -p "Пароль (минимум 14 символов): "', helper)
        self.assertIn('| "${container_command[@]}"', helper)
        self.assertIn("--network none", helper)
        self.assertIn('"${compose[@]}" stop admin', helper)
        self.assertIn("restore_admin_after_failure", helper)
        self.assertIn('"${compose[@]}" start admin', helper)
        self.assertLess(
            helper.index('IFS= read -r -p "Локальный логин: "'),
            helper.index('"${compose[@]}" stop admin'),
        )
        self.assertNotRegex(helper, r"--password(?:=|\s)")
        self.assertNotRegex(helper, r"export\s+[^\n]*PASSWORD")

    def test_host_nginx_domains_ports_proxy_headers_and_login_limit_are_enforced(self) -> None:
        nginx = (REPO / "deploy/docker/host-nginx.conf").read_text(encoding="utf-8")
        changes = (
            (
                nginx.replace("server 127.0.0.1:8000;", "server 0.0.0.0:8000;", 1),
                "public backend upstream",
            ),
            (
                nginx.replace("admin.oknotika.ru", checker.REJECTED_ADMIN_DOMAIN, 1),
                "rejected typo admin domain",
            ),
            (
                nginx.replace(
                    "proxy_set_header X-Forwarded-For $remote_addr;",
                    "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
                    1,
                ),
                "must replace, not append",
            ),
            (
                nginx.replace("server 127.0.0.1:8001;", "server 127.0.0.1:8081;", 1),
                "127.0.0.1:8001",
            ),
            (
                nginx.replace("location = /login {", "location = /auth/callback {", 1),
                "obsolete OIDC route /auth/callback",
            ),
            (
                nginx.replace(
                    "limit_req zone=oknotika_docker_admin_login burst=3 nodelay;",
                    "limit_req zone=oknotika_docker_admin_general burst=3 nodelay;",
                    1,
                ),
                "oknotika_docker_admin_login",
            ),
        )
        for changed, expected in changes:
            with self.subTest(expected=expected):
                self.assertTrue(any(
                    expected in error
                    for error in checker.validate_host_nginx_text(changed)
                ))

    def test_runbook_local_credential_safety_and_no_secret_boundary_are_enforced(self) -> None:
        runbook = (REPO / "deploy/docker/README_ZHENYA.md").read_text(encoding="utf-8")
        changes = (
            (
                runbook.replace(
                    "configure-local-credentials.sh",
                    "manual-password-file-edit.sh",
                ),
                "configure-local-credentials.sh",
            ),
            (
                runbook.replace("docker compose down -v ЗАПРЕЩЕНА", "volume warning removed"),
                "docker compose down -v",
            ),
            (
                runbook.replace(
                    "credential-rollback",
                    "rollback reason removed",
                ),
                "credential-rollback",
            ),
            (
                runbook.replace(
                    '--project-name "$OKNOTIKA_ACTIVE_PROJECT"',
                    '--project-name oknotika',
                    1,
                ),
                "hardcodes the original Compose project name",
            ),
            (
                runbook + "\nOKNOTIKA_LOCAL_" + "PASSWORD=assigned-production-value\n",
                "embeds a credential",
            ),
            (
                runbook.replace("set -euo pipefail", "set +e"),
                "not fail-fast",
            ),
            (
                runbook.replace(
                    "export OKNOTIKA_ROOT=/var/home/oknotika",
                    "export OKNOTIKA_ROOT=/tmp/oknotika",
                ),
                "OKNOTIKA_ROOT",
            ),
            (
                runbook.replace(
                    "Единственный runtime mount public — article-releases read-only",
                    "public mount policy removed",
                ),
                "article-releases read-only",
            ),
            (
                runbook.replace(
                    "export OKNOTIKA_BACKUP_DIR=/var/backups/oknotika/YYYYMMDD-HHMMSS",
                    "restore backup input removed",
                ),
                "OKNOTIKA_BACKUP_DIR",
            ),
            (
                runbook.replace(
                    "data.before-restore",
                    "restore staging removed",
                ),
                "data.before-restore",
            ),
            (
                runbook.replace(
                    "OKNOTIKA_HOST_ROOT=/var/home/oknotika",
                    "OKNOTIKA_HOST_ROOT=/tmp/oknotika",
                ),
                "OKNOTIKA_HOST_ROOT",
            ),
            (
                runbook.replace("trap restart_after_backup EXIT", "backup restart trap removed"),
                "trap restart_after_backup EXIT",
            ),
            (
                runbook.replace(
                    "admin npm run register-weekly-cover --",
                    "weekly cover command removed",
                ),
                "admin npm run register-weekly-cover --",
            ),
            (
                runbook.replace(
                    "admin node /run/smoke-weekly-ingestion.mjs",
                    "weekly smoke command removed",
                ),
                "admin node /run/smoke-weekly-ingestion.mjs",
            ),
            (
                runbook.replace("rollback_failed_restore() {", "restore rollback removed"),
                "rollback_failed_restore() {",
            ),
            (
                runbook.replace(
                    'sudo install -o root -g root -m 0600 "$OKNOTIKA_COMPOSE_ENV" "$OKNOTIKA_ACTIVE_RESTORE_ENV"',
                    "active restore Compose env preservation removed",
                ),
                "preserve and promote active image tags",
            ),
            (
                runbook.replace(
                    'sudo install -o root -g 1000 -m 0640 "$OKNOTIKA_ACTIVE_RESTORE_ENV" "$OKNOTIKA_COMPOSE_ENV.next"',
                    "active restore Compose env promotion removed",
                ),
                "preserve and promote active image tags",
            ),
            (
                runbook.replace(
                    "trap cleanup_failed_upgrade_prepare EXIT",
                    "upgrade preparation cleanup trap removed",
                ),
                "arm preparation cleanup before staging and image build",
            ),
            (
                runbook.replace(
                    'sudo rm -rf --one-file-system -- "$OKNOTIKA_STAGE_ROOT" "$OKNOTIKA_PREVIOUS_ROOT"',
                    "upgrade preparation directory cleanup removed",
                ),
                'sudo rm -rf --one-file-system -- "$OKNOTIKA_STAGE_ROOT" "$OKNOTIKA_PREVIOUS_ROOT"',
            ),
            (
                runbook.replace("rollback_failed_upgrade() {", "upgrade rollback removed"),
                "rollback_failed_upgrade() {",
            ),
            (
                runbook.replace(
                    'sudo install -o root -g root -m 0600 "$OKNOTIKA_COMPOSE_ENV" "$OKNOTIKA_OLD_COMPOSE_ENV"',
                    "previous Compose env preservation removed",
                ),
                'sudo install -o root -g root -m 0600 "$OKNOTIKA_COMPOSE_ENV" "$OKNOTIKA_OLD_COMPOSE_ENV"',
            ),
            (
                runbook.replace(
                    'sudo install -d -o 1000 -g 1000 -m 0750 "$OKNOTIKA_ROOT/public-app/data"',
                    "reserved public data recreation removed",
                ),
                'sudo install -d -o 1000 -g 1000 -m 0750 "$OKNOTIKA_ROOT/public-app/data"',
            ),
            (
                runbook.replace(
                    'sudo install -o root -g 1000 -m 0640 "$OKNOTIKA_NEW_COMPOSE_ENV" "$OKNOTIKA_COMPOSE_ENV.next"',
                    "active Compose env promotion removed",
                ),
                'sudo install -o root -g 1000 -m 0640 "$OKNOTIKA_NEW_COMPOSE_ENV" "$OKNOTIKA_COMPOSE_ENV.next"',
            ),
            (
                runbook.replace(
                    'sudo install -o root -g 1000 -m 0640 "$OKNOTIKA_OLD_COMPOSE_ENV" "$OKNOTIKA_COMPOSE_ENV.next"',
                    "rollback Compose env promotion removed",
                ),
                'sudo install -o root -g 1000 -m 0640 "$OKNOTIKA_OLD_COMPOSE_ENV" "$OKNOTIKA_COMPOSE_ENV.next"',
            ),
        )
        for changed, expected in changes:
            with self.subTest(expected=expected):
                self.assertTrue(any(
                    expected in error
                    for error in checker.validate_docker_runbook_text(changed)
                ))

    def test_operator_handoff_has_no_checksum_steps_and_html_is_standalone(self) -> None:
        runbook = (REPO / "deploy/docker/README_ZHENYA.md").read_text(encoding="utf-8")
        instruction = (REPO / checker.STANDALONE_INSTRUCTION).read_text(encoding="utf-8")
        self.assertEqual(checker.validate_standalone_instruction_text(instruction), [])
        for forbidden in ("sha256sum", "SHA256SUMS", ".zip.sha256", "OKNOTIKA_ARCHIVE_SHA"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, runbook)
                self.assertNotIn(forbidden, instruction)

    def test_incremental_handoff_removes_relay_through_compose_service(self) -> None:
        instruction = (REPO / "release/oknotika-local-password-auth-20260902-instruction.html").read_text(
            encoding="utf-8"
        )
        self.assertIn('stop "$OKNOTIKA_TELEGRAM_RELAY_SERVICE"', instruction)
        self.assertIn('rm --force "$OKNOTIKA_TELEGRAM_RELAY_SERVICE"', instruction)
        self.assertNotIn('docker inspect "$OKNOTIKA_TELEGRAM_RELAY_SERVICE"', instruction)
        self.assertNotIn('docker stop "$OKNOTIKA_TELEGRAM_RELAY_SERVICE"', instruction)
        self.assertNotIn('docker rm "$OKNOTIKA_TELEGRAM_RELAY_SERVICE"', instruction)

    def test_incremental_handoff_preserves_relay_override_for_full_rollback(self) -> None:
        instruction = (REPO / "release/oknotika-local-password-auth-20260902-instruction.html").read_text(
            encoding="utf-8"
        )
        preserved_override = (
            'sudo install -o root -g root -m 0600 "$OKNOTIKA_TELEGRAM_OVERRIDE" '
            '"$OKNOTIKA_BACKUP/telegram-override.before.yml"'
        )
        candidate_recreate = '--force-recreate --wait --wait-timeout 120 admin'
        rollback_recreate = (
            '--file "$OKNOTIKA_ROLLBACK_TELEGRAM_OVERRIDE" --env-file "$OKNOTIKA_COMPOSE_ENV" '
            'up --detach --no-build --wait --wait-timeout 120'
        )
        self.assertIn(preserved_override, instruction)
        self.assertIn(rollback_recreate, instruction)
        self.assertLess(instruction.index(preserved_override), instruction.index(candidate_recreate))
        self.assertLess(instruction.index(candidate_recreate), instruction.index(rollback_recreate))

    def test_admin_image_and_smoke_include_preview_assets(self) -> None:
        dockerfile = (REPO / "deploy/docker/admin.Dockerfile").read_text(encoding="utf-8")
        smoke = (REPO / "deploy/docker/smoke-test.sh").read_text(encoding="utf-8")
        for path in ("style.css", "img/logo-oknotika.svg"):
            with self.subTest(path=path):
                self.assertIn(path, dockerfile)
                self.assertIn(path, smoke)

    def test_container_shell_scripts_have_valid_syntax(self) -> None:
        for relative, shell in (
            ("deploy/docker/admin-entrypoint.sh", "sh"),
            ("deploy/docker/smoke-test.sh", "bash"),
        ):
            result = subprocess.run(
                [shell, "-n", REPO / relative],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_runbook_bash_blocks_have_valid_syntax(self) -> None:
        runbook = (REPO / "deploy/docker/README_ZHENYA.md").read_text(encoding="utf-8")
        blocks = re.findall(r"~~~bash\n(.*?)\n~~~", runbook, flags=re.DOTALL)
        self.assertGreater(len(blocks), 0)
        for index, block in enumerate(blocks, start=1):
            with self.subTest(block=index):
                result = subprocess.run(
                    ["bash", "-n"],
                    input=block,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
