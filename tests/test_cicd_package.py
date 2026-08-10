from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "scripts/check_cicd_package.py"
SPEC = importlib.util.spec_from_file_location("check_cicd_package", SCRIPT)
assert SPEC and SPEC.loader
checker = importlib.util.module_from_spec(SPEC)
sys.modules["check_cicd_package"] = checker
SPEC.loader.exec_module(checker)


class CiWorkflowPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.workflow = (REPO / ".github/workflows/ci.yml").read_text(encoding="utf-8")

    def assert_rejected(self, workflow: str, expected: str) -> None:
        errors = checker.validate_ci_text(workflow)
        self.assertTrue(
            any(expected in error for error in errors),
            f"expected {expected!r} in {errors!r}",
        )

    def test_current_workflow_is_secret_free_and_pinned(self) -> None:
        self.assertEqual(checker.validate_ci_text(self.workflow), [])

    def test_write_permissions_are_rejected(self) -> None:
        changed = self.workflow.replace("contents: read", "contents: write", 1)
        self.assert_rejected(changed, "write permissions are forbidden")

    def test_pull_request_secret_access_is_rejected(self) -> None:
        for expression in (
            "${{ secrets.PRODUCTION_SSH_KEY }}",
            "${{ secrets['PRODUCTION_SSH_KEY'] }}",
        ):
            with self.subTest(expression=expression):
                changed = self.workflow.replace(
                    "    timeout-minutes: 30",
                    "    environment: production\n"
                    "    env:\n"
                    f"      DEPLOY_KEY: {expression}\n"
                    "    timeout-minutes: 30",
                    1,
                )
                self.assert_rejected(changed, "must not access secrets")
                self.assert_rejected(changed, "must not select a deployment environment")

    def test_floating_action_tags_are_rejected(self) -> None:
        changed = replace_action_pin(self.workflow, "actions/checkout", "v6")
        self.assert_rejected(changed, "full commit SHA")

    def test_unsupported_or_floating_node_versions_are_rejected(self) -> None:
        for version in ("22.12.0", "24"):
            with self.subTest(version=version):
                changed = self.workflow.replace(
                    "node-version: '24.18.0'",
                    f"node-version: '{version}'",
                    1,
                )
                self.assert_rejected(changed, "Node version must be exactly 24.18.0")


class ProductionWorkflowPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.workflow = (REPO / ".github/workflows/deploy-production.yml").read_text(encoding="utf-8")
        cls.helper = (REPO / "deploy/cicd/upload-and-deploy.sh").read_text(encoding="utf-8")

    def assert_workflow_rejected(self, workflow: str, expected: str) -> None:
        errors = checker.validate_deploy_workflow_text(workflow)
        self.assertTrue(any(expected in error for error in errors), errors)

    def test_current_production_workflow_and_helper_pass(self) -> None:
        self.assertEqual(checker.validate_deploy_workflow_text(self.workflow), [])
        self.assertEqual(checker.validate_upload_helper_text(self.helper), [])

    def test_non_main_trigger_and_missing_approval_are_rejected(self) -> None:
        branch = self.workflow.replace("      - main", "      - feature/demo", 1)
        self.assert_workflow_rejected(branch, "exactly push to main")
        no_environment = self.workflow.replace("    environment: production\n", "", 1)
        self.assert_workflow_rejected(no_environment, "production Environment")

    def test_floating_deploy_action_and_missing_ci_dependency_are_rejected(self) -> None:
        floating = replace_action_pin(self.workflow, "actions/upload-artifact", "v4")
        self.assert_workflow_rejected(floating, "full commit SHA")
        no_ci = self.workflow.replace("    needs: ci\n", "", 1)
        self.assert_workflow_rejected(no_ci, "CI dependency chain")

    def test_artifact_checksum_gate_is_required(self) -> None:
        no_checksum = self.workflow.replace(
            '          sha256sum -c "$RELEASE_SHA.zip.sha256"',
            "          true # checksum removed",
            1,
        )
        self.assert_workflow_rejected(no_checksum, "sha256sum -c")

    def test_unapproved_secret_and_host_key_bypass_are_rejected(self) -> None:
        application_secret = self.workflow.replace(
            "          DEPLOY_HOST:",
            "          OIDC_SECRET: ${{ secrets.TELEGRAM_OIDC_CLIENT_SECRET }}\n"
            "          DEPLOY_HOST:",
            1,
        )
        self.assert_workflow_rejected(application_secret, "must be exactly")
        self.assert_workflow_rejected(application_secret, "application credentials")
        bypass = self.helper.replace("StrictHostKeyChecking=yes", "StrictHostKeyChecking=no", 1)
        errors = checker.validate_upload_helper_text(bypass)
        self.assertTrue(any("forbidden operation" in error for error in errors), errors)


def replace_action_pin(workflow: str, action: str, replacement: str) -> str:
    prefix = f"uses: {action}@"
    start = workflow.index(prefix) + len(prefix)
    end = workflow.index(" ", start)
    return workflow[:start] + replacement + workflow[end:]


if __name__ == "__main__":
    unittest.main()
