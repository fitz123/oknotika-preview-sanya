#!/usr/bin/env python3
"""Render and assert the three site-content revision pages at desktop and mobile widths."""

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
const path = require('path');
const { chromium } = require(process.argv[2]);

const pages = [
  { slug: 'homepage', url: '/' },
  { slug: 'aluminum', url: '/aluminum/' },
  { slug: 'document-revision', url: '/aluminum/document-revision-check/' },
];

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
    const legacyContext = await browser.newContext();
    await legacyContext.addInitScript(() => localStorage.setItem('oknotika_cookie_ok', '1'));
    const legacyPage = await legacyContext.newPage();
    await legacyPage.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await legacyPage.waitForFunction(() => document.querySelector('[data-cookie]')?.classList.contains('is-visible'));
    const legacySources = await legacyPage.locator('[data-yandex-proof] iframe').evaluateAll(
      frames => frames.map(frame => frame.getAttribute('src')),
    );
    if (legacySources.some(Boolean)) {
      throw new Error('legacy generic cookie consent authorized Yandex embeds');
    }
    await legacyContext.close();

    const blockedStorageContext = await browser.newContext();
    await blockedStorageContext.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new Error('storage read blocked'); };
      Storage.prototype.setItem = () => { throw new Error('storage write blocked'); };
    });
    const blockedStoragePage = await blockedStorageContext.newPage();
    const blockedStorageErrors = [];
    blockedStoragePage.on('pageerror', error => blockedStorageErrors.push(error.message));
    await blockedStoragePage.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await blockedStoragePage.locator('[data-yandex-proof] [data-cookie-accept]').first().click();
    await blockedStoragePage.waitForFunction(
      () => Array.from(document.querySelectorAll('[data-yandex-proof] iframe')).every(frame => frame.getAttribute('src')),
    );
    if (blockedStorageErrors.length) {
      throw new Error(`storage-blocked consent raised page errors: ${blockedStorageErrors.join('; ')}`);
    }
    await blockedStorageContext.close();

    for (const item of pages) {
      for (const width of [1440, 390]) {
        process.stderr.write(`checking ${item.slug} at ${width}px\n`);
        const context = await browser.newContext({
          viewport: { width, height: 1000 },
          colorScheme: 'dark',
          deviceScaleFactor: 1,
          locale: 'ru-RU',
          reducedMotion: 'reduce',
          timezoneId: 'Europe/Moscow',
        });
        await context.addInitScript(() => localStorage.setItem('oknotika_yandex_embed_consent_v1', '1'));
        const page = await context.newPage();
        await page.goto(`${baseUrl}${item.url}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.addStyleTag({ content: `
          *, *::before, *::after { animation: none !important; transition: none !important; }
          .reveal { opacity: 1 !important; transform: none !important; }
        ` });
        await page.evaluate(async () => {
          document.querySelectorAll('img').forEach(image => { image.loading = 'eager'; });
          const pause = () => new Promise(resolve => setTimeout(resolve, 45));
          for (let y = 0; y < document.documentElement.scrollHeight; y += 850) {
            window.scrollTo(0, y);
            await pause();
          }
          window.scrollTo(0, 0);
        });
        await page.waitForFunction(
          () => Array.from(document.images).every(image => image.complete && image.naturalWidth > 0),
          null,
          { timeout: 12000 },
        );
        await page.evaluate(() => Promise.all(Array.from(document.images, image => image.decode())));
        await page.waitForTimeout(150);

        const metrics = await page.evaluate(({ slug, width }) => {
          const safeNewTab = link => {
            if (!link) return false;
            const rel = new Set((link.getAttribute('rel') || '').toLowerCase().split(/\s+/));
            return link.target === '_blank' && rel.has('noopener') && rel.has('noreferrer');
          };
          const rect = element => {
            if (!element) return null;
            const bounds = element.getBoundingClientRect();
            return {
              x: bounds.x,
              y: bounds.y + window.scrollY,
              width: bounds.width,
              height: bounds.height,
            };
          };
          const rects = selector => Array.from(document.querySelectorAll(selector), rect);
          const result = {
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            scrollHeight: document.documentElement.scrollHeight,
            bodyWidth: document.body.getBoundingClientRect().width,
          };

          if (slug === 'homepage') {
            const glassImage = document.querySelector('a.product-link-card[href="glass/"] img');
            const heroImage = document.querySelector('.hero__visual img');
            const casesPartner = document.querySelector('[data-rubikon-proof]');
            const caseGrid = document.querySelector('.case-grid');
            const teamCards = rects('#team .person');
            const teamPortraits = rects('#team .person__portrait');
            const embeds = rects('[data-yandex-proof] .yandex-embed');
            const iframeElements = Array.from(document.querySelectorAll('[data-yandex-proof] iframe'));
            const iframes = iframeElements.map(rect);
            const reviewLink = document.querySelector('[data-yandex-proof] a[href*="add-review=true"]');
            result.homepage = {
              glassImage: glassImage ? {
                src: glassImage.getAttribute('src'),
                naturalWidth: glassImage.naturalWidth,
                naturalHeight: glassImage.naturalHeight,
              } : null,
              heroImage: heroImage ? {
                src: heroImage.getAttribute('src'),
                naturalWidth: heroImage.naturalWidth,
                naturalHeight: heroImage.naturalHeight,
              } : null,
              casesPartner: rect(casesPartner),
              caseGrid: rect(caseGrid),
              casesPartnerText: casesPartner?.textContent.replace(/\s+/g, ' ').trim() || '',
              teamCards,
              teamPortraits,
              embeds,
              iframes,
              iframeSources: iframeElements.map(frame => frame.getAttribute('src')),
              iframeLazy: iframeElements.map(frame => frame.loading),
              safeReviewLink: safeNewTab(reviewLink),
              width,
            };
          } else if (slug === 'aluminum') {
            const video = document.querySelector('.raluma-gallery video');
            const teaserLink = document.querySelector('[data-document-revision-teaser] a');
            result.aluminum = {
              designFeature: rect(document.querySelector('.design-path__feature')),
              ralumaItems: rects('.raluma-gallery__item'),
              video: video ? {
                autoplay: video.autoplay,
                muted: video.muted,
                loop: video.loop,
                playsInline: video.playsInline,
                poster: video.getAttribute('poster'),
              } : null,
              safeTeaserLink: safeNewTab(teaserLink),
            };
          } else {
            const telegramLink = document.querySelector('a[href^="https://t.me/"]');
            result.presentation = {
              slides: rects('.revision-slide'),
              safeTelegramLink: safeNewTab(telegramLink),
            };
          }
          return result;
        }, { slug: item.slug, width });

        if (metrics.scrollWidth > metrics.clientWidth + 1 || metrics.bodyWidth > metrics.clientWidth + 1) {
          throw new Error(`${item.slug} ${width}px overflows horizontally: ${metrics.scrollWidth}/${metrics.clientWidth}`);
        }
        if (metrics.scrollHeight <= 1000) {
          throw new Error(`${item.slug} ${width}px rendered page is unexpectedly collapsed`);
        }

        if (metrics.homepage) {
          const home = metrics.homepage;
          if (!home.glassImage || home.glassImage.src !== 'img/product-world/glass-art.jpg' || home.glassImage.naturalWidth < 1 || home.glassImage.naturalHeight < 1) {
            throw new Error(`${width}px homepage glass photograph did not render`);
          }
          if (!home.heroImage || home.heroImage.src !== 'img/cases/atrium.jpg' || home.heroImage.naturalWidth < 1 || home.heroImage.naturalHeight < 1) {
            throw new Error(`${width}px homepage unique atrium hero did not render`);
          }
          if (!home.casesPartner || home.casesPartner.height < 100 || !home.casesPartnerText.includes('Рубикон') || !home.casesPartnerText.includes('Лункаша') || !home.casesPartnerText.includes('особенно ценит') || !home.casesPartnerText.includes('доверяет')) {
            throw new Error(`${width}px homepage Rubikon proof is missing or collapsed`);
          }
          if (!home.caseGrid || home.casesPartner.y + home.casesPartner.height > home.caseGrid.y + 1) {
            throw new Error(`${width}px homepage Rubikon proof must render before the case grid`);
          }
          if (home.teamCards.length !== 9 || home.teamPortraits.length !== 9) {
            throw new Error(`${width}px homepage team must render nine cards and portraits`);
          }
          if (home.teamPortraits.some(portrait => Math.abs(portrait.width / portrait.height - 0.8) > 0.02)) {
            throw new Error(`${width}px homepage team portrait crop ratio changed`);
          }
          if (home.embeds.length !== 2 || home.iframes.length !== 2 || home.iframeSources.some(source => !source.includes('122138017646')) || home.iframeLazy.some(value => value !== 'lazy')) {
            throw new Error(`${width}px homepage Yandex embeds are missing or invalid`);
          }
          if (home.iframes.some((frame, index) => frame.width > metrics.clientWidth || Math.abs(frame.width - home.embeds[index].width) > 2)) {
            throw new Error(`${width}px homepage Yandex iframe is not responsive`);
          }
          if (!home.safeReviewLink) {
            throw new Error(`${width}px homepage Yandex review link is not a safe new-tab CTA`);
          }
          if (width === 1440) {
            if (new Set(home.teamCards.slice(0, 3).map(card => Math.round(card.x))).size !== 3 || home.teamCards.slice(0, 3).some(card => Math.abs(card.y - home.teamCards[0].y) > 2)) {
              throw new Error('desktop homepage team is not a three-column grid');
            }
            if (home.embeds[0].x === home.embeds[1].x || Math.abs(home.embeds[0].y - home.embeds[1].y) > 2) {
              throw new Error('desktop homepage Yandex embeds are not side by side');
            }
          } else {
            if (home.teamCards.some((card, index) => index > 0 && (Math.abs(card.x - home.teamCards[0].x) > 2 || card.y <= home.teamCards[index - 1].y))) {
              throw new Error('mobile homepage team is not a single-column stack');
            }
            if (Math.abs(home.embeds[0].x - home.embeds[1].x) > 2 || home.embeds[1].y <= home.embeds[0].y) {
              throw new Error('mobile homepage Yandex embeds are not stacked');
            }
          }
        }

        if (metrics.aluminum) {
          const aluminum = metrics.aluminum;
          if (!aluminum.designFeature || aluminum.designFeature.height < 300 || aluminum.ralumaItems.length !== 3) {
            throw new Error(`${width}px aluminum photographic composition is incomplete`);
          }
          if (!aluminum.video || !aluminum.video.autoplay || !aluminum.video.muted || !aluminum.video.loop || !aluminum.video.playsInline || !aluminum.video.poster) {
            throw new Error(`${width}px aluminum RALUMA video contract is incomplete`);
          }
          if (!aluminum.safeTeaserLink) {
            throw new Error(`${width}px aluminum presentation teaser is not a safe new-tab CTA`);
          }
        }

        if (metrics.presentation) {
          if (metrics.presentation.slides.length < 6 || metrics.presentation.slides.some(slide => slide.height < 200)) {
            throw new Error(`${width}px document-revision presentation slides are missing or collapsed`);
          }
          if (!metrics.presentation.safeTelegramLink) {
            throw new Error(`${width}px document-revision Telegram CTA is not a safe new-tab link`);
          }
        }

        const filename = `site-content-${item.slug}-${width === 1440 ? 'desktop-1440' : 'mobile-390'}.jpg`;
        process.stderr.write(`capturing ${filename}\n`);
        await page.screenshot({ path: path.join(output, filename), fullPage: true, type: 'jpeg', quality: 80, timeout: 30000 });
        results.push({ page: item.slug, width, filename, metrics });
        await context.close();
      }
    }
    process.stdout.write(JSON.stringify({
      playwright: require(path.join(process.argv[2], 'package.json')).version,
      chromium: browser.version(),
      results,
    }));
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
    parser.add_argument("repo", nargs="?", type=Path, default=Path("."))
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
                timeout=180,
            )
        finally:
            script_path.unlink(missing_ok=True)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    metadata = json.loads(result.stdout)
    (output / "site-content-revision-render.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print("Site content render check passed: homepage, aluminum, and document revision at 1440 px and 390 px")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
