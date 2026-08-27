#!/usr/bin/env python3
"""Validate the secret-free CI/CD repository policy."""

from __future__ import annotations

import re
import sys
from pathlib import Path


PINNED_NODE_VERSION = "24.18.0"
RIPGREP_INSTALL_COMMAND = "sudo apt-get install --yes ripgrep"
ALLOWED_DEPLOY_SECRETS = {
    "OKNOTIKA_DEPLOY_HOST",
    "OKNOTIKA_DEPLOY_PORT",
    "OKNOTIKA_DEPLOY_USER",
    "OKNOTIKA_DEPLOY_SSH_PRIVATE_KEY",
    "OKNOTIKA_DEPLOY_SSH_KNOWN_HOSTS",
}
REQUIRED_CI_COMMANDS = (
    "sudo apt-get update",
    RIPGREP_INSTALL_COMMAND,
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
    'python3 scripts/build_ci_bundle.py --repo . --commit "$CI_SHA" --output var/ci-bundle.zip',
    'python3 scripts/check_ci_bundle.py var/ci-bundle.zip --expected-commit "$CI_SHA"',
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


def mapping_block(text: str, key: str, indent: int) -> list[str]:
    """Return lines nested below a YAML mapping key at a fixed indentation."""
    lines = text.splitlines()
    marker = f"{' ' * indent}{key}:"
    for index, line in enumerate(lines):
        if line == marker:
            block: list[str] = []
            for candidate in lines[index + 1:]:
                if candidate and len(candidate) - len(candidate.lstrip()) <= indent:
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
    if RIPGREP_INSTALL_COMMAND in workflow_lines and "npm test" in workflow_lines:
        if text.index(RIPGREP_INSTALL_COMMAND) > text.index("npm test"):
            errors.append("CI must install ripgrep before admin tests")

    return errors


def action_references(text: str) -> list[str]:
    return re.findall(r"(?m)^[ \t]*-?[ \t]*uses[ \t]*:[ \t]*([^\s#]+)", text)


def validate_deploy_workflow_text(text: str) -> list[str]:
    errors: list[str] = []
    event_lines = [line.strip() for line in top_level_block(text, "on") if line.strip()]
    if event_lines != ["push:", "branches:", "- main"]:
        errors.append("production workflow trigger must be exactly push to main")
    if re.search(r"(?m)^[ \t]*(?:pull_request(?:_target)?|workflow_dispatch|schedule|tags)[ \t]*:", text):
        errors.append("production workflow must not allow alternate deployment triggers")

    permission_lines = [line.strip() for line in top_level_block(text, "permissions") if line.strip()]
    if permission_lines != ["contents: read"]:
        errors.append("production permissions must be exactly contents: read")
    permission_declarations = re.findall(r"(?m)^([ \t]*)permissions[ \t]*:", text)
    if permission_declarations != [""]:
        errors.append("production workflow must not add job-level permissions")

    concurrency_lines = [line.strip() for line in top_level_block(text, "concurrency") if line.strip()]
    if concurrency_lines != ["group: oknotika-production", "cancel-in-progress: false"]:
        errors.append("production workflow must serialize deployments without cancellation")

    references = action_references(text)
    for reference in references:
        if reference.startswith("./"):
            continue
        if "@" not in reference or not re.fullmatch(r"[0-9a-f]{40}", reference.rsplit("@", 1)[1]):
            errors.append(f"production action reference must use a full commit SHA: {reference}")
    for required in (
        "./.github/workflows/ci.yml",
        "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
        "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
        "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    ):
        if required not in references:
            errors.append(f"production workflow is missing pinned dependency: {required}")

    deploy_block = "\n".join(mapping_block(text, "deploy", 2))
    if not deploy_block or len(re.findall(
        r"(?m)^[ \t]+environment[ \t]*:[ \t]*production[ \t]*$", deploy_block
    )) != 1:
        errors.append("the deployment job must select the production Environment exactly once")
    if len(re.findall(r"(?m)^[ \t]+environment[ \t]*:[ \t]*production[ \t]*$", text)) != 1:
        errors.append("only the deployment job may select the production Environment")
    if "needs: ci" not in text or "needs: build" not in text:
        errors.append("production build and deploy jobs must preserve the CI dependency chain")
    if "secrets: inherit" in text:
        errors.append("production workflow must not inherit secrets into reusable CI")

    secret_names = set(re.findall(r"\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}", text))
    secret_names.update(re.findall(r"\$\{\{\s*secrets\[['\"]([A-Za-z0-9_]+)['\"]\]\s*\}\}", text))
    if secret_names != ALLOWED_DEPLOY_SECRETS:
        errors.append(
            "production workflow secret access must be exactly: "
            + ", ".join(sorted(ALLOWED_DEPLOY_SECRETS))
        )
    if re.search(r"TELEGRAM|WEEKLY_INGEST|RESTIC|OIDC", text, re.IGNORECASE):
        errors.append("production application credentials must not enter GitHub Actions")

    required_fragments = (
        'RELEASE_SHA: ${{ github.sha }}',
        '--commit "$RELEASE_SHA"',
        '--expected-commit "$RELEASE_SHA"',
        'sha256sum -c "$RELEASE_SHA.zip.sha256"',
        'name: oknotika-ci-${{ github.sha }}',
        "deploy/cicd/upload-and-deploy.sh",
        "--known-hosts \"$known_hosts_path\"",
        "--remote-incoming /var/lib/oknotika-deploy/incoming",
    )
    for fragment in required_fragments:
        if fragment not in text:
            errors.append(f"production workflow is missing required gate: {fragment}")
    if re.search(r"(?m)^[ \t]*continue-on-error[ \t]*:[ \t]*true", text):
        errors.append("production deployment gates must not continue on error")
    return errors


def validate_upload_helper_text(text: str) -> list[str]:
    errors: list[str] = []
    for fragment in (
        "StrictHostKeyChecking=yes",
        "UserKnownHostsFile=",
        "IdentitiesOnly=yes",
        "BatchMode=yes",
        "ssh-keygen -F",
        "sha256sum --",
        "scp",
        "sudo -n /usr/local/sbin/oknotika-deploy",
        'remote_incoming" == "/var/lib/oknotika-deploy/incoming"',
    ):
        if fragment not in text:
            errors.append(f"upload helper is missing required boundary: {fragment}")
    for forbidden in ("ssh-keyscan", "StrictHostKeyChecking=no", "eval "):
        if forbidden in text:
            errors.append(f"upload helper contains forbidden operation: {forbidden}")
    return errors


def validate(root: Path) -> list[str]:
    ci_workflow = root / ".github/workflows/ci.yml"
    deploy_workflow = root / ".github/workflows/deploy-production.yml"
    upload_helper = root / "deploy/cicd/upload-and-deploy.sh"
    errors: list[str] = []
    try:
        if not ci_workflow.is_file():
            errors.append(f"missing workflow: {ci_workflow.relative_to(root)}")
        else:
            errors.extend(validate_ci_text(ci_workflow.read_text(encoding="utf-8")))
        if not deploy_workflow.is_file():
            errors.append(f"missing workflow: {deploy_workflow.relative_to(root)}")
        else:
            errors.extend(validate_deploy_workflow_text(deploy_workflow.read_text(encoding="utf-8")))
        if not upload_helper.is_file():
            errors.append(f"missing helper: {upload_helper.relative_to(root)}")
        else:
            errors.extend(validate_upload_helper_text(upload_helper.read_text(encoding="utf-8")))
        return errors
    except OSError as exc:
        return [f"unable to read CI/CD package: {exc}"]


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    errors = validate(root)
    if errors:
        print("CI/CD package check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"CI/CD package check passed: secret-free CI/CD uses Node {PINNED_NODE_VERSION}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
