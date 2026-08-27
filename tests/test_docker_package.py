from __future__ import annotations

import copy
import importlib.util
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


if __name__ == "__main__":
    unittest.main()
