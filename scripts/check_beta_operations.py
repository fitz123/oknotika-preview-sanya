#!/usr/bin/env python3
"""Rehearse encrypted backup/restore and application downgrade in isolation."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PREVIOUS_APPLICATION_COMMIT = "bbf4e4d"


def run(args: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(
        args,
        cwd=cwd,
        env=env,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=300,
    )
    return result.stdout.strip()


def node_eval(source: str, *, cwd: Path) -> str:
    return run(["node", "--input-type=module", "--eval", source], cwd=cwd)


def prepare_portable_commands(directory: Path) -> None:
    # The production scripts use Linux flock and realpath -m. These tiny adapters
    # preserve their command contracts for the macOS beta host only.
    flock = directory / "flock"
    flock.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    realpath = directory / "realpath"
    realpath.write_text(
        "#!/usr/bin/env python3\nimport os, sys\nargs=[a for a in sys.argv[1:] if a != '-m']\nprint(os.path.realpath(args[-1]))\n",
        encoding="utf-8",
    )
    flock.chmod(0o755)
    realpath.chmod(0o755)


def create_current_database(repo: Path, filename: Path, state: Path) -> None:
    source = f"""
import {{ openDatabase }} from {json.dumps((repo / 'admin-app/src/content/database.js').as_uri())};
import {{ createContentService }} from {json.dumps((repo / 'admin-app/src/content/service.js').as_uri())};
import {{ importAlBahr }} from {json.dumps((repo / 'admin-app/src/content/al-bahr.js').as_uri())};
import {{ createPublisher }} from {json.dumps((repo / 'admin-app/src/render/publisher.js').as_uri())};
const db = openDatabase({json.dumps(str(filename))});
const service = createContentService(db);
const editorId = service.configureEditor({{ issuer: 'https://oauth.telegram.org', subject: '9988776655' }});
const coverAssetId = service.registerAsset({{
  privatePath: {json.dumps(str(repo / 'articles/assets/e794ac9b2fc096b47e5a406d.jpg'))},
  mediaType: 'image/jpeg',
}});
const article = importAlBahr(service, {{ editorId, coverAssetId }});
const publisher = createPublisher(db, {{
  releasesRoot: {json.dumps(str(state / 'article-releases'))},
  publicOrigin: 'https://oknotika.ru',
  clock: () => new Date('2026-07-14T00:00:00.000Z'),
}});
await publisher.publish({{
  editorId,
  transition: {{ type: 'publish', articleId: article.articleId, expectedRevisionId: article.revisionId }},
}});
db.prepare(`INSERT INTO audit_events (event_type, details_json, created_at) VALUES ('beta.backup', '{{}}', '2026-07-14T00:00:00.000Z')`).run();
db.close();
"""
    node_eval(source, cwd=repo)


def backup_restore_rehearsal(repo: Path, restic: Path, root: Path) -> dict[str, Any]:
    state = root / "state"
    database = state / "db/admin.sqlite"
    repository = root / "restic-repository"
    restored = root / "isolated-restore"
    bin_directory = root / "bin"
    for directory in (
        database.parent,
        state / "uploads/originals",
        state / "backups",
        bin_directory,
    ):
        directory.mkdir(parents=True, exist_ok=True)
    create_current_database(repo, database, state)
    (state / "uploads/originals/approved.source").write_bytes(b"beta private backup fixture")
    password_file = root / "restic-password"
    repository_file = root / "restic-repository-path"
    password_file.write_text("beta-only-strong-password-not-for-production\n", encoding="utf-8")
    repository_file.write_text(f"{repository}\n", encoding="utf-8")
    password_file.chmod(0o600)
    repository_file.chmod(0o600)
    prepare_portable_commands(bin_directory)
    env = {
        **os.environ,
        "PATH": f"{bin_directory}:{restic.parent}:{os.environ['PATH']}",
        "RESTIC_PASSWORD_FILE": str(password_file),
        "RESTIC_REPOSITORY_FILE": str(repository_file),
        "OKNOTIKA_STATE_ROOT": str(state),
        "OKNOTIKA_DATABASE_PATH": str(database),
        "OKNOTIKA_RELEASE_SHA": "beta-rehearsal",
    }
    init_output = run([str(restic), "--repository-file", str(repository_file), "init"], env=env)
    backup_output = run([str(repo / "deploy/scripts/backup.sh")], cwd=repo, env=env)
    snapshots = json.loads(run([str(restic), "--repository-file", str(repository_file), "snapshots", "--json"], env=env))
    check_output = run([str(restic), "--repository-file", str(repository_file), "check"], env=env)
    restore_output = run(
        [str(repo / "deploy/scripts/restore-drill.sh"), "--target", str(restored)],
        cwd=repo,
        env=env,
    )
    verification = json.loads(run(
        ["node", str(repo / "deploy/scripts/verify-restored-state.mjs"), str(restored)],
        cwd=repo,
    ).splitlines()[-1])
    if not (restored / "uploads/originals/approved.source").is_file():
        raise RuntimeError("isolated restore omitted private originals")
    if not init_output or "no errors were found" not in backup_output or "no errors were found" not in check_output:
        raise RuntimeError("restic init, backup, or integrity output did not confirm success")
    if "Restore drill passed" not in restore_output:
        raise RuntimeError("isolated restore drill did not confirm success")
    return {
        "status": "pass",
        "resticVersion": run([str(restic), "version"]).splitlines()[0],
        "repository": "ephemeral encrypted local repository (deleted after rehearsal)",
        "snapshotId": snapshots[-1]["short_id"],
        "snapshotCount": len(snapshots),
        "init": "pass",
        "backup": "pass",
        "integrity": "pass",
        "restore": "pass",
        "verification": verification,
        "productionNote": "real encrypted off-host repository restore remains a Linux production gate",
    }


def extract_previous_application(repo: Path, destination: Path) -> str:
    commit = run(["git", "-C", str(repo), "rev-parse", f"{PREVIOUS_APPLICATION_COMMIT}^{{commit}}"])
    archive_path = destination / "previous.tar"
    with archive_path.open("wb") as output:
        subprocess.run(
            ["git", "-C", str(repo), "archive", "--format=tar", commit, "admin-app"],
            check=True,
            stdout=output,
        )
    with tarfile.open(archive_path, "r:") as archive:
        archive.extractall(destination, filter="data")
    archive_path.unlink()
    return commit


def migration_count(database_module: Path, database: Path, cwd: Path) -> int:
    source = f"""
import {{ openDatabase }} from {json.dumps(database_module.as_uri())};
const db = openDatabase({json.dumps(str(database))});
const count = db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count;
db.prepare('SELECT COUNT(*) AS count FROM audit_events').get();
db.close();
console.log(JSON.stringify({{ count }}));
"""
    return int(json.loads(node_eval(source, cwd=cwd).splitlines()[-1])["count"])


def downgrade_rehearsal(repo: Path, root: Path) -> dict[str, Any]:
    previous_root = root / "previous-release"
    previous_root.mkdir()
    previous_commit = extract_previous_application(repo, previous_root)
    previous_module = previous_root / "admin-app/src/content/database.js"
    database = root / "pre-migration.sqlite"
    previous_count = migration_count(previous_module, database, previous_root / "admin-app")
    backup = root / "verified-pre-migration.sqlite"
    backup_output = json.loads(run([
        "node", str(repo / "deploy/scripts/sqlite-online-backup.mjs"), str(database), str(backup),
    ]).splitlines()[-1])
    upgraded = root / "upgrade-copy.sqlite"
    restored = root / "restored-pre-migration.sqlite"
    shutil.copy2(backup, upgraded)
    current_count = migration_count(repo / "admin-app/src/content/database.js", upgraded, repo / "admin-app")
    shutil.copy2(backup, restored)
    restored_count = migration_count(previous_module, restored, previous_root / "admin-app")
    if not (previous_count == 1 and current_count == 3 and restored_count == 1):
        raise RuntimeError(
            f"downgrade rehearsal mismatch: previous={previous_count}, current={current_count}, restored={restored_count}"
        )
    return {
        "status": "pass",
        "previousApplicationCommit": previous_commit,
        "preMigrationSchemaVersions": previous_count,
        "upgradedCopySchemaVersions": current_count,
        "restoredPreMigrationSchemaVersions": restored_count,
        "backupIntegrity": backup_output["integrity"],
        "strategy": "upgrade a copy; downgrade by restoring the verified pre-migration database",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path("."))
    parser.add_argument("--restic", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("release-evidence/qa/operations-rehearsal.json"))
    args = parser.parse_args()
    repo = args.repo.resolve()
    restic = args.restic.resolve()
    if not restic.is_file():
        raise SystemExit(f"restic binary does not exist: {restic}")
    output = args.output if args.output.is_absolute() else repo / args.output
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="oknotika-beta-operations-") as directory:
        root = Path(directory)
        backup = backup_restore_rehearsal(repo, restic, root / "backup")
        downgrade_root = root / "downgrade"
        downgrade_root.mkdir()
        downgrade = downgrade_rehearsal(repo, downgrade_root)
    report = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "host": "Darwin beta host; Linux service verification remains a production gate",
        "backupRestore": backup,
        "applicationDowngrade": downgrade,
        "status": "pass",
    }
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Beta operations rehearsal passed: restic snapshot {backup['snapshotId']}, downgrade restore verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
