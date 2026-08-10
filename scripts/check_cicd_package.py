#!/usr/bin/env python3
"""Validate the secret-free CI/CD repository policy."""

from __future__ import annotations

import re
import sys
from pathlib import Path


PINNED_NODE_VERSION = "24.18.0"
REQUIRED_CI_COMMANDS = (
    "npm ci",
    "npm audit --audit-level=high",
    "npm audit --omit=dev --audit-level=high",
    "npm run lint",
    "npm test",
    "npm run test:security",
    "npm run build",
    "npm run render:fixture",
    "python3 -m unittest discover -s tests -v",
    "python3 scripts/check_generated_articles.py var/test-release",
    "python3 scripts/check_deploy_package.py .",
    "python3 scripts/check_final_documentation.py .",
    "python3 scripts/check_cicd_package.py .",
)


def top_level_block(text: str, key: str) -> list[str]:
    """Return indented lines belonging to one top-level YAML mapping key."""
    lines = text.splitlines()
    marker = f"{key}:"
    for index, line in enumerate(lines):
        if line == marker:
            block: list[str] = []
            for candidate in lines[index + 1:]:
                if candidate and not candidate[0].isspace():
                    break
                block.append(candidate)
            return block
    return []


def validate_ci_text(text: str) -> list[str]:
    errors: list[str] = []

    event_lines = {line.strip() for line in top_level_block(text, "on") if line.strip()}
    if "pull_request:" not in event_lines:
        errors.append("CI must run on pull_request")
    if "workflow_call:" not in event_lines:
        errors.append("CI must support workflow_call")
    if re.search(r"(?m)^[ \t]*pull_request_target[ \t]*:", text):
        errors.append("pull_request_target is forbidden")

    permission_lines = [line.strip() for line in top_level_block(text, "permissions") if line.strip()]
    if permission_lines != ["contents: read"]:
        errors.append("top-level permissions must be exactly contents: read")
    permission_declarations = re.findall(r"(?m)^([ \t]*)permissions[ \t]*:", text)
    if permission_declarations != [""]:
        errors.append("job-level or duplicate permissions are forbidden")
    if re.search(r"(?m)^[ \t]*[\w-]+[ \t]*:[ \t]*(?:write|write-all)[ \t]*(?:#.*)?$", text):
        errors.append("write permissions are forbidden")

    concurrency_lines = {line.strip() for line in top_level_block(text, "concurrency") if line.strip()}
    if not any(line.startswith("group:") for line in concurrency_lines):
        errors.append("CI concurrency group is missing")
    if "cancel-in-progress: true" not in concurrency_lines:
        errors.append("CI must cancel superseded runs")

    if re.search(r"\$\{\{\s*secrets(?:\.|\[)", text, re.IGNORECASE) or re.search(
        r"(?m)^[ \t]*secrets[ \t]*:[ \t]*inherit[ \t]*(?:#.*)?$", text,
    ):
        errors.append("CI must not access secrets")
    if re.search(r"(?m)^[ \t]+environment[ \t]*:", text):
        errors.append("CI must not select a deployment environment")

    action_references = re.findall(r"(?m)^[ \t]*-?[ \t]*uses[ \t]*:[ \t]*([^\s#]+)", text)
    if not action_references:
        errors.append("CI must use pinned checkout and setup-node actions")
    for reference in action_references:
        if "@" not in reference or not re.fullmatch(r"[0-9a-f]{40}", reference.rsplit("@", 1)[1]):
            errors.append(f"action reference must use a full commit SHA: {reference}")
    for action in ("actions/checkout", "actions/setup-node"):
        if not any(reference.startswith(f"{action}@") for reference in action_references):
            errors.append(f"CI is missing {action}")

    node_versions = [
        value.strip("'\"")
        for value in re.findall(r"(?m)^[ \t]*node-version[ \t]*:[ \t]*([^\s#]+)", text)
    ]
    if node_versions != [PINNED_NODE_VERSION]:
        errors.append(f"CI Node version must be exactly {PINNED_NODE_VERSION}")
    if not re.search(
        r"(?m)^[ \t]*persist-credentials[ \t]*:[ \t]*false[ \t]*(?:#.*)?$",
        text,
    ):
        errors.append("checkout credentials must not persist")

    workflow_lines = {line.strip() for line in text.splitlines()}
    for command in REQUIRED_CI_COMMANDS:
        if command not in workflow_lines and f"run: {command}" not in workflow_lines:
            errors.append(f"CI command is missing: {command}")

    return errors


def validate(root: Path) -> list[str]:
    workflow = root / ".github/workflows/ci.yml"
    if not workflow.is_file():
        return [f"missing workflow: {workflow.relative_to(root)}"]
    try:
        return validate_ci_text(workflow.read_text(encoding="utf-8"))
    except OSError as exc:
        return [f"unable to read CI workflow: {exc}"]


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    errors = validate(root)
    if errors:
        print("CI/CD package check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"CI/CD package check passed: secret-free CI uses Node {PINNED_NODE_VERSION}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
