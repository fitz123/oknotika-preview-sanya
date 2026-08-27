from __future__ import annotations

import copy
import importlib.util
import re
import shutil
import subprocess
import sys
import unittest
from pathlib import Path


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
    def test_public_private_volume_or_public_port_regressions_are_rejected(self) -> None:
        model = checker.compose_model(REPO)
        private_mount = copy.deepcopy(model)
        private_mount["services"]["public"]["volumes"].append({
            "type": "volume",
            "source": "admin_uploads",
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

    def test_direct_compose_credentials_are_rejected(self) -> None:
        compose = (REPO / "deploy/docker/docker-compose.yml").read_text(encoding="utf-8")
        changed = compose.replace(
            "TELEGRAM_OIDC_CLIENT_ID_FILE: /run/secrets/telegram_oidc_client_id",
            "TELEGRAM_OIDC_CLIENT_ID: assigned-value",
        )
        self.assertIn(
            "Compose environment contains a direct credential value",
            checker.validate_compose_text(changed),
        )

    def test_host_nginx_domains_ports_and_proxy_headers_are_enforced(self) -> None:
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
        )
        for changed, expected in changes:
            with self.subTest(expected=expected):
                self.assertTrue(any(
                    expected in error
                    for error in checker.validate_host_nginx_text(changed)
                ))

    def test_runbook_callback_safety_and_no_secret_boundary_are_enforced(self) -> None:
        runbook = (REPO / "deploy/docker/README_ZHENYA.md").read_text(encoding="utf-8")
        changes = (
            (
                runbook.replace(
                    "https://admin.oknotika.ru/auth/callback",
                    "https://admin.oknotika.ru/callback",
                ),
                "https://admin.oknotika.ru/auth/callback",
            ),
            (
                runbook.replace("`docker compose down -v` ЗАПРЕЩЕНА", "volume warning removed"),
                "docker compose down -v",
            ),
            (
                runbook.replace(
                    'chown root:1000 /etc/oknotika/secrets/*',
                    'chown root:root /etc/oknotika/secrets/*',
                ),
                "root:1000",
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
                runbook + "\nTELEGRAM_OIDC_CLIENT_" + "SECRET=assigned-production-value\n",
                "embeds a credential",
            ),
            (
                runbook.replace("set -euo pipefail", "set +e"),
                "not fail-fast",
            ),
            (
                runbook.replace("/etc/oknotika/active-project", "/tmp/active-project"),
                "/etc/oknotika/active-project",
            ),
            (
                runbook.replace("OKNOTIKA_RESTORE_ARCHIVE_SHA", "IGNORED_ARCHIVE_SHA"),
                "OKNOTIKA_RESTORE_ARCHIVE_SHA",
            ),
            (
                runbook.replace("/opt/oknotika-docker/previous", "/tmp/previous"),
                "/opt/oknotika-docker/previous",
            ),
        )
        for changed, expected in changes:
            with self.subTest(expected=expected):
                self.assertTrue(any(
                    expected in error
                    for error in checker.validate_docker_runbook_text(changed)
                ))

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
        blocks = re.findall(r"```bash\n(.*?)\n```", runbook, flags=re.DOTALL)
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
