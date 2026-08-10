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


def replace_action_pin(workflow: str, action: str, replacement: str) -> str:
    prefix = f"uses: {action}@"
    start = workflow.index(prefix) + len(prefix)
    end = workflow.index(" ", start)
    return workflow[:start] + replacement + workflow[end:]


if __name__ == "__main__":
    unittest.main()
