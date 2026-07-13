#!/usr/bin/env python3
"""Capture the immutable V2.27 manifest and homepage visual baseline."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import threading
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


PINNED_COMMIT = "5364ff160ffa9b8e9f2d0998a5eef1cf6cd3f5ed"
PINNED_TREE = "1025debb9c1d76f41fad3ed9d2ded8b3afa71d7b"
PINNED_PLAYWRIGHT = "1.58.2"
PINNED_CHROMIUM = "145.0.7632.6"
VIEWPORT_WIDTHS = (1440, 1280, 1180, 768, 760, 390)
VIEWPORT_HEIGHT = 1000


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return


def run(*args: str, cwd: Path | None = None, text: bool = False) -> bytes | str:
    result = subprocess.run(
        list(args),
        cwd=cwd,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=text,
    )
    return result.stdout


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def playwright_package(playwright_cli: str) -> Path:
    executable = shutil.which(playwright_cli)
    if executable is None:
        raise RuntimeError(f"Playwright CLI not found: {playwright_cli}")
    resolved = Path(executable).resolve()
    package = resolved.parent
    if not (package / "package.json").is_file():
        raise RuntimeError(f"Cannot locate Playwright package from {resolved}")
    version = str(run(executable, "--version", text=True)).strip().removeprefix("Version ")
    if version != PINNED_PLAYWRIGHT:
        raise RuntimeError(f"Playwright {PINNED_PLAYWRIGHT} required, got {version}")
    return package


def tracked_manifest(repo: Path, commit: str, output: Path) -> tuple[int, list[dict[str, str]]]:
    tree_output = run("git", "-C", str(repo), "ls-tree", "-r", "-z", commit)
    records: list[dict[str, str]] = []
    sha_lines: list[str] = []
    for item in tree_output.split(b"\0"):  # type: ignore[union-attr]
        if not item:
            continue
        metadata, raw_path = item.split(b"\t", 1)
        mode, kind, object_id = metadata.decode().split()
        if kind != "blob":
            continue
        path = raw_path.decode()
        content = run("git", "-C", str(repo), "cat-file", "blob", object_id)
        digest = sha256(content)  # type: ignore[arg-type]
        sha_lines.append(f"{digest}  {path}")
        records.append({"path": path, "mode": mode, "git_blob": object_id, "sha256": digest})
    (output / "v227-tracked-files.sha256").write_text("\n".join(sha_lines) + "\n", encoding="utf-8")
    write_json(output / "v227-tracked-files.json", records)
    return len(records), records


CAPTURE_SCRIPT = r"""
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.argv[2]);

(async () => {
  const url = process.argv[3];
  const output = process.argv[4];
  const expectedVersion = process.argv[5];
  const viewportHeight = Number(process.argv[6]);
  const widths = process.argv.slice(7).map(Number);
  const browser = await chromium.launch({ headless: true });
  try {
    const actualVersion = browser.version();
    if (actualVersion !== expectedVersion) {
      throw new Error(`Chromium ${expectedVersion} required, got ${actualVersion}`);
    }
    const results = [];
    for (const width of widths) {
      const context = await browser.newContext({
        viewport: { width, height: viewportHeight },
        colorScheme: 'dark',
        deviceScaleFactor: 1,
        locale: 'ru-RU',
        reducedMotion: 'reduce',
        timezoneId: 'Europe/Moscow',
      });
      await context.addInitScript(() => localStorage.setItem('oknotika_cookie_ok', '1'));
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.addStyleTag({ content: `
        *, *::before, *::after { animation: none !important; transition: none !important; }
        .reveal { opacity: 1 !important; transform: none !important; }
      ` });
      await page.evaluate(async () => {
        await Promise.all(Array.from(document.images, (image) => image.decode().catch(() => {})));
        if (document.fonts?.ready) await document.fonts.ready;
      });
      const fullHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      const filename = `index-${width}.jpg`;
      await page.screenshot({
        path: path.join(output, filename),
        fullPage: true,
        type: 'jpeg',
        quality: 82,
      });
      results.push({ filename, width, height: fullHeight });
      await context.close();
    }
    process.stdout.write(JSON.stringify({ chromium: browser.version(), screenshots: results }));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
"""


def capture_screenshots(source: Path, output: Path, playwright: Path) -> dict[str, object]:
    handler = partial(QuietHandler, directory=str(source))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".cjs", encoding="utf-8", delete=False) as script:
            script.write(CAPTURE_SCRIPT)
            script_path = Path(script.name)
        try:
            url = f"http://127.0.0.1:{server.server_port}/index.html"
            stdout = run(
                "node",
                str(script_path),
                str(playwright),
                url,
                str(output),
                PINNED_CHROMIUM,
                str(VIEWPORT_HEIGHT),
                *(str(width) for width in VIEWPORT_WIDTHS),
                text=True,
            )
            result = json.loads(stdout)
        finally:
            script_path.unlink(missing_ok=True)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    hash_lines: list[str] = []
    for screenshot in result["screenshots"]:
        path = output / screenshot["filename"]
        screenshot["sha256"] = sha256(path.read_bytes())
        screenshot["bytes"] = path.stat().st_size
        hash_lines.append(f"{screenshot['sha256']}  {screenshot['filename']}")
    (output / "v227-screenshots.sha256").write_text("\n".join(hash_lines) + "\n", encoding="utf-8")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path("."))
    parser.add_argument("--baseline", default=PINNED_COMMIT)
    parser.add_argument("--output", type=Path, default=Path("release-evidence/baseline"))
    parser.add_argument("--playwright", default="playwright")
    args = parser.parse_args()
    repo = args.repo.resolve()
    output = args.output if args.output.is_absolute() else repo / args.output

    commit = str(run("git", "-C", str(repo), "rev-parse", f"{args.baseline}^{{commit}}", text=True)).strip()
    tree = str(run("git", "-C", str(repo), "rev-parse", f"{commit}^{{tree}}", text=True)).strip()
    if commit != PINNED_COMMIT or tree != PINNED_TREE:
        raise RuntimeError(f"unexpected V2.27 identity: commit={commit}, tree={tree}")
    output.mkdir(parents=True, exist_ok=True)
    file_count, _records = tracked_manifest(repo, commit, output)
    playwright = playwright_package(args.playwright)

    with tempfile.TemporaryDirectory(prefix="oknotika-v227-") as directory:
        source = Path(directory)
        archive = run("git", "-C", str(repo), "archive", "--format=tar", commit)
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:  # type: ignore[arg-type]
            tar.extractall(source, filter="data")
        screenshots = capture_screenshots(source, output, playwright)

    commit_time = str(run("git", "-C", str(repo), "show", "-s", "--format=%cI", commit, text=True)).strip()
    metadata = {
        "baseline": {
            "label": "V2.27",
            "commit": commit,
            "tree": tree,
            "commit_timestamp": commit_time,
            "tracked_files": file_count,
        },
        "capture": {
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "source": "git archive of the pinned commit",
            "page": "/index.html",
            "playwright": PINNED_PLAYWRIGHT,
            "chromium": screenshots["chromium"],
            "viewport_height": VIEWPORT_HEIGHT,
            "device_scale_factor": 1,
            "locale": "ru-RU",
            "timezone": "Europe/Moscow",
            "color_scheme": "dark",
            "animations": "disabled; reveal nodes forced visible",
            "cookie_banner": "suppressed with the site's accepted localStorage value",
            "screenshots": screenshots["screenshots"],
        },
    }
    write_json(output / "v227-baseline.json", metadata)
    print(f"Captured V2.27 baseline: {file_count} files, {len(VIEWPORT_WIDTHS)} screenshots")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
