#!/usr/bin/env python3
"""Capture and assert desktop/mobile aluminum composition with pinned Chromium."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


PINNED_PLAYWRIGHT = "1.58.2"
PINNED_CHROMIUM = "145.0.7632.6"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return


CAPTURE_SCRIPT = r"""
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.argv[2]);

(async () => {
  const baseUrl = process.argv[3];
  const output = process.argv[4];
  const expectedVersion = process.argv[5];
  const browser = await chromium.launch({ headless: true });
  if (browser.version() !== expectedVersion) {
    throw new Error(`Chromium ${expectedVersion} required, got ${browser.version()}`);
  }
  const results = [];
  try {
    for (const width of [1440, 390]) {
      process.stderr.write(`checking aluminum at ${width}px\n`);
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        colorScheme: 'dark',
        deviceScaleFactor: 1,
        locale: 'ru-RU',
        reducedMotion: 'reduce',
        timezoneId: 'Europe/Moscow',
      });
      await context.addInitScript(() => localStorage.setItem('oknotika_cookie_ok', '1'));
      const page = await context.newPage();
      await page.goto(`${baseUrl}/aluminum/`, { waitUntil: 'load', timeout: 15000 });
      await page.addStyleTag({ content: `
        *, *::before, *::after { animation: none !important; transition: none !important; }
        .reveal { opacity: 1 !important; transform: none !important; }
      ` });
      await page.evaluate(async () => {
        document.querySelectorAll('img').forEach(image => { image.loading = 'eager'; });
        const pause = () => new Promise(resolve => setTimeout(resolve, 60));
        for (let y = 0; y < document.documentElement.scrollHeight; y += 800) {
          window.scrollTo(0, y);
          await pause();
        }
        window.scrollTo(0, 0);
      });
      await page.waitForFunction(
        () => Array.from(document.images).every(image => image.complete && image.naturalWidth > 0),
        null,
        { timeout: 10000 },
      );
      const metrics = await page.evaluate(() => {
        const rects = selector => Array.from(document.querySelectorAll(selector), element => {
          const rect = element.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        });
        return {
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          scenarioCards: rects('.facade-scenario-card'),
          shellItems: rects('.integration-shell__list li'),
          designSteps: rects('.design-path__steps li'),
          requiredSections: rects('.schueco-hero, .facade-scenarios, .integration-shell, .design-path, .facade-caveat'),
        };
      });
      if (metrics.scrollWidth > metrics.clientWidth + 1) {
        throw new Error(`${width}px page overflows horizontally: ${metrics.scrollWidth}/${metrics.clientWidth}`);
      }
      if (metrics.scenarioCards.length !== 4 || metrics.shellItems.length !== 6 || metrics.designSteps.length !== 6 || metrics.requiredSections.length !== 5) {
        throw new Error(`${width}px page misses required composition nodes`);
      }
      if (metrics.requiredSections.some(section => section.height < 100 || section.width > metrics.clientWidth + 1)) {
        throw new Error(`${width}px page contains a collapsed or overflowing section`);
      }
      if (width === 1440) {
        if (Math.abs(metrics.scenarioCards[0].y - metrics.scenarioCards[1].y) > 2 || metrics.scenarioCards[0].x === metrics.scenarioCards[1].x) {
          throw new Error('desktop scenario cards are not a two-column grid');
        }
      } else {
        const firstX = metrics.scenarioCards[0].x;
        if (metrics.scenarioCards.some(card => Math.abs(card.x - firstX) > 2)) {
          throw new Error('mobile scenario cards are not a single-column stack');
        }
        if (metrics.scenarioCards.some((card, index) => index > 0 && card.y <= metrics.scenarioCards[index - 1].y)) {
          throw new Error('mobile scenario cards overlap or are reordered');
        }
      }
      const filename = `aluminum-${width === 1440 ? 'desktop-1440' : 'mobile-390'}.jpg`;
      process.stderr.write(`capturing ${filename}\n`);
      await page.screenshot({ path: path.join(output, filename), fullPage: true, type: 'jpeg', quality: 82, timeout: 30000 });
      results.push({ filename, width, metrics });
      await context.close();
    }

    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark', reducedMotion: 'reduce' });
    await context.addInitScript(() => localStorage.setItem('oknotika_cookie_ok', '1'));
    const page = await context.newPage();
    process.stderr.write('checking homepage aluminum card\n');
    await page.goto(`${baseUrl}/`, { waitUntil: 'load', timeout: 15000 });
    await page.addStyleTag({ content: '.reveal { opacity: 1 !important; transform: none !important; transition: none !important; }' });
    const card = page.locator('a.product-link-card[href="aluminum/"]');
    if (await card.count() !== 1 || !await card.isVisible()) {
      throw new Error('homepage aluminum card is missing or invisible');
    }
    const imageSource = await card.locator('img').getAttribute('src');
    if (imageSource !== 'img/aluminum/schueco-facade-grid.webp') {
      throw new Error(`homepage aluminum card uses unexpected image: ${imageSource}`);
    }
    await card.screenshot({ path: path.join(output, 'homepage-aluminum-card-1440.jpg'), type: 'jpeg', quality: 86, timeout: 30000 });
    await context.close();
    process.stdout.write(JSON.stringify({ chromium: browser.version(), playwright: require(path.join(process.argv[2], 'package.json')).version, results }));
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
"""


def package_path() -> Path:
    executable = shutil.which("playwright")
    if executable is None:
        raise RuntimeError("Playwright CLI is not installed")
    package = Path(executable).resolve().parent
    metadata = json.loads((package / "package.json").read_text(encoding="utf-8"))
    if metadata.get("version") != PINNED_PLAYWRIGHT:
        raise RuntimeError(f"Playwright {PINNED_PLAYWRIGHT} required, got {metadata.get('version')}")
    return package


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path("."))
    parser.add_argument("--output", type=Path, default=Path("release-evidence/qa"))
    args = parser.parse_args()
    repo = args.repo.resolve()
    output = args.output if args.output.is_absolute() else repo / args.output
    output.mkdir(parents=True, exist_ok=True)
    package = package_path()
    handler = partial(QuietHandler, directory=str(repo))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".cjs", encoding="utf-8", delete=False) as script:
            script.write(CAPTURE_SCRIPT)
            script_path = Path(script.name)
        try:
            result = subprocess.run(
                [
                    "node",
                    str(script_path),
                    str(package),
                    f"http://127.0.0.1:{server.server_port}",
                    str(output),
                    PINNED_CHROMIUM,
                ],
                check=True,
                stdout=subprocess.PIPE,
                text=True,
                timeout=120,
            )
        finally:
            script_path.unlink(missing_ok=True)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    metadata = json.loads(result.stdout)
    (output / "aluminum-composition.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print("Aluminum composition check passed: desktop, mobile, and homepage card captured")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
