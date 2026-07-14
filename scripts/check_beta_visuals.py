#!/usr/bin/env python3
"""Run the pinned-browser beta rehearsal and compare V2.27 protected pixels."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import shutil
import subprocess
import tarfile
import tempfile
import threading
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageDraw


PINNED_COMMIT = "5364ff160ffa9b8e9f2d0998a5eef1cf6cd3f5ed"
PINNED_PLAYWRIGHT = "1.58.2"
PINNED_CHROMIUM = "145.0.7632.6"
WIDTHS = (1440, 1280, 1180, 768, 760, 390)
STATIC_PATHS = (
    "/",
    "/aluminum/",
    "/articles/",
    "/articles/al-bahr-towers-dynamic-facade/",
    "/carbon-glass/",
    "/glass/",
    "/oknotika-smart-window/",
    "/protectapeel/",
    "/pvc/",
    "/wood-stoller/",
)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return


class StaticServer:
    def __init__(self, directory: Path):
        handler = partial(QuietHandler, directory=str(directory))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def origin(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}"

    def __enter__(self) -> "StaticServer":
        self.thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


BROWSER_SCRIPT = r"""
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.argv[2]);

const finalOrigin = process.argv[3];
const baselineOrigin = process.argv[4];
const output = process.argv[5];
const expectedVersion = process.argv[6];
const widths = JSON.parse(process.argv[7]);
const staticPaths = JSON.parse(process.argv[8]);

async function settle(page, scrollPage = true) {
  await page.addStyleTag({ content: `
    *, *::before, *::after { animation: none !important; transition: none !important; }
    html { scroll-behavior: auto !important; }
    .reveal { opacity: 1 !important; transform: none !important; }
  ` });
  await page.evaluate(async scrollPage => {
    if (scrollPage) document.querySelectorAll('img').forEach(image => { image.loading = 'eager'; });
    const pause = () => new Promise(resolve => setTimeout(resolve, 40));
    if (scrollPage) {
      for (let y = 0; y < document.documentElement.scrollHeight; y += 800) {
        window.scrollTo(0, y);
        await pause();
      }
    }
    window.scrollTo(0, 0);
    await Promise.race([
      Promise.all(Array.from(document.images, image => image.decode().catch(() => {}))),
      new Promise(resolve => setTimeout(resolve, 10000)),
    ]);
    if (document.fonts?.ready) await document.fonts.ready;
  }, scrollPage);
}

async function homepage(browser, origin, width, filename, teamFilename = null, reproductionFilename = null) {
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
  const errors = [];
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  const response = await page.goto(`${origin}/`, { waitUntil: 'networkidle', timeout: 20000 });
  if (!response?.ok()) errors.push(`navigation: ${response?.status() ?? 'missing response'}`);
  await settle(page, false);
  const metrics = await page.evaluate(() => {
    const absoluteRect = selector => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      };
    };
    return {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      header: absoluteRect('.site-header'),
      allowedRegions: [
        '#team',
        '.weekly-fact',
        'a.product-link-card[href="aluminum/"]',
        'footer.footer',
      ].map(absoluteRect).filter(Boolean),
      teamCards: document.querySelectorAll('#team .person').length,
      teamImagesReady: Array.from(document.querySelectorAll('#team img'))
        .every(image => image.complete && image.naturalWidth > 0),
      protectedGeometry: Object.fromEntries([
        '.site-header',
        '.hero__content',
        '#approach .container',
        '#cases .container',
        '#proof .container',
        '#contacts .container',
      ].map(selector => [selector, absoluteRect(selector)])),
    };
  });
  if (metrics.scrollWidth > metrics.clientWidth + 1) errors.push('horizontal overflow');
  if (metrics.teamCards !== 8) errors.push('team composition is incomplete');
  if (reproductionFilename) {
    await page.screenshot({ path: reproductionFilename, fullPage: true, type: 'jpeg', quality: 82, timeout: 30000 });
  }
  // Chromium's full-page compositor can place fixed layers inconsistently when
  // approved content changes the mobile page height. Absolute positioning keeps
  // the same top geometry while producing a deterministic comparison raster.
  await page.addStyleTag({ content: '.site-header { position: absolute !important; }' });
  await page.screenshot({ path: filename, fullPage: true, type: 'jpeg', quality: 82, timeout: 30000 });
  if (teamFilename) {
    await page.locator('#team').screenshot({ path: teamFilename, type: 'jpeg', quality: 86, timeout: 30000 });
  }
  await context.close();
  return { width, metrics, errors };
}

async function staticPage(browser, origin, pathname, width) {
  const context = await browser.newContext({
    viewport: { width, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce', locale: 'ru-RU',
  });
  await context.route('**/*', route => route.request().resourceType() === 'media' ? route.abort() : route.continue());
  await context.addInitScript(() => localStorage.setItem('oknotika_cookie_ok', '1'));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('response', response => {
    if (response.url().startsWith(origin) && response.status() >= 400) {
      errors.push(`http ${response.status()}: ${response.url().slice(origin.length)}`);
    }
  });
  const response = await page.goto(`${origin}${pathname}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  if (!response?.ok()) errors.push(`navigation: ${response?.status() ?? 'missing response'}`);
  await page.addStyleTag({ content: `
    *, *::before, *::after { animation: none !important; transition: none !important; }
    .reveal { opacity: 1 !important; transform: none !important; }
  ` });
  await page.evaluate(async () => {
    if (document.fonts?.ready) {
      await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 1000))]);
    }
  });
  const metrics = await page.evaluate(() => ({
    title: document.title,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    images: document.images.length,
    brokenImages: Array.from(document.images).filter(image => image.complete && image.naturalWidth === 0).length,
    canonical: document.querySelector('link[rel="canonical"]')?.href ?? null,
    ogTitle: document.querySelector('meta[property="og:title"]')?.content ?? null,
    ogDescription: document.querySelector('meta[property="og:description"]')?.content ?? null,
    ogImage: document.querySelector('meta[property="og:image"]')?.content ?? null,
  }));
  if (!metrics.title) errors.push('document title is empty');
  if (metrics.scrollWidth > metrics.clientWidth + 1) errors.push('horizontal overflow');
  if (metrics.brokenImages) errors.push(`${metrics.brokenImages} broken images`);
  await context.close();
  return { pathname, width, metrics, errors };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    if (browser.version() !== expectedVersion) {
      throw new Error(`Chromium ${expectedVersion} required, got ${browser.version()}`);
    }
    const final = [];
    const baseline = [];
    for (const width of widths) {
      final.push(await homepage(
        browser,
        finalOrigin,
        width,
        path.join(output, `index-${width}.jpg`),
        path.join(output, `team-${width}.jpg`),
        null,
      ));
      baseline.push(await homepage(
        browser,
        baselineOrigin,
        width,
        path.join(output, `.baseline-${width}.jpg`),
        null,
        path.join(output, `.baseline-reproduction-${width}.jpg`),
      ));
    }
    process.stdout.write(JSON.stringify({
      playwright: require(path.join(process.argv[2], 'package.json')).version,
      chromium: browser.version(), final, baseline,
    }));
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
"""


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def playwright_package() -> Path:
    executable = shutil.which("playwright")
    if executable is None:
        raise RuntimeError("Playwright CLI is not installed")
    package = Path(executable).resolve().parent
    metadata = json.loads((package / "package.json").read_text(encoding="utf-8"))
    if metadata.get("version") != PINNED_PLAYWRIGHT:
        raise RuntimeError(f"Playwright {PINNED_PLAYWRIGHT} required, got {metadata.get('version')}")
    return package


def archive_baseline(repo: Path, destination: Path) -> None:
    archive = subprocess.run(
        ["git", "-C", str(repo), "archive", "--format=tar", PINNED_COMMIT],
        check=True,
        stdout=subprocess.PIPE,
    ).stdout
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as stream:
        stream.extractall(destination, filter="data")


def count_changed_pixels(first: Image.Image, second: Image.Image, tolerance: int, mask: Image.Image | None = None) -> tuple[int, int]:
    width = max(first.width, second.width)
    height = max(first.height, second.height)
    canvas_a = Image.new("RGB", (width, height))
    canvas_b = Image.new("RGB", (width, height))
    canvas_a.paste(first.convert("RGB"), (0, 0))
    canvas_b.paste(second.convert("RGB"), (0, 0))
    difference = ImageChops.difference(canvas_a, canvas_b)
    channels = [channel.point(lambda value: 255 if value > tolerance else 0) for channel in difference.split()]
    changed = ImageChops.lighter(ImageChops.lighter(channels[0], channels[1]), channels[2])
    if mask is not None:
        changed = ImageChops.multiply(changed, ImageChops.invert(mask))
        denominator = width * height - mask.histogram()[255]
    else:
        denominator = width * height
    count = sum(changed.histogram()[1:])
    return count, max(denominator, 1)


def region_mask(size: tuple[int, int], *groups: list[dict[str, float]]) -> Image.Image:
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    for regions in groups:
        for region in regions:
            # Allowed components use wide CSS shadows; those painted pixels belong
            # to the component even though getBoundingClientRect excludes them.
            padding = 80
            left = max(0, int(region["x"]) - padding)
            top = max(0, int(region["y"]) - padding)
            right = min(size[0], int(region["x"] + region["width"] + 0.999) + padding)
            bottom = min(size[1], int(region["y"] + region["height"] + 0.999) + padding)
            draw.rectangle((left, top, right, bottom), fill=255)
    return mask


def register_allowed_bands(
    current: Image.Image,
    baseline: Image.Image,
    current_regions: list[dict[str, float]],
    baseline_regions: list[dict[str, float]],
) -> tuple[Image.Image, list[dict[str, float]], int, int]:
    """Align downstream content after approved components change their height."""
    current_rgb = current.convert("RGB")
    registered = Image.new("RGB", baseline.size)
    pairs = sorted(zip(current_regions, baseline_regions, strict=True), key=lambda pair: pair[1]["y"])
    current_cursor = 0
    baseline_cursor = 0
    spacing_residual = 0
    approved_height_delta = 0
    incoming_shift = 0.0
    transformed_by_identity: dict[int, dict[str, float]] = {}
    for index, (current_region, baseline_region) in enumerate(pairs):
        outgoing_shift = (
            pairs[index + 1][0]["y"] - pairs[index + 1][1]["y"]
            if index + 1 < len(pairs)
            else current.height - baseline.height
        )
        transformed = dict(current_region)
        transformed["y"] = current_region["y"] - incoming_shift
        transformed_by_identity[id(current_region)] = transformed
        if abs(outgoing_shift - incoming_shift) <= 1:
            incoming_shift = outgoing_shift
            continue
        current_top = round(current_region["y"])
        current_bottom = round(current_region["y"] + current_region["height"])
        baseline_top = round(baseline_region["y"])
        baseline_bottom = round(baseline_region["y"] + baseline_region["height"])
        source_gap = current_top - current_cursor
        target_gap = baseline_top - baseline_cursor
        spacing_residual = max(spacing_residual, abs(source_gap - target_gap))
        gap = current_rgb.crop((0, current_cursor, current_rgb.width, current_top))
        if gap.height and gap.height != target_gap:
            gap = gap.resize((gap.width, target_gap), Image.Resampling.BICUBIC)
        registered.paste(gap, (0, baseline_cursor))
        band = current_rgb.crop((0, current_top, current_rgb.width, current_bottom))
        target_height = baseline_bottom - baseline_top
        approved_height_delta += round(outgoing_shift - incoming_shift)
        if band.height and band.height != target_height:
            band = band.resize((band.width, target_height), Image.Resampling.BICUBIC)
        registered.paste(band, (0, baseline_top))
        transformed_by_identity[id(current_region)] = dict(baseline_region)
        current_cursor = current_bottom
        baseline_cursor = baseline_bottom
        incoming_shift = outgoing_shift
    trailing = current_rgb.crop((0, current_cursor, current_rgb.width, current_rgb.height))
    target_trailing = baseline.height - baseline_cursor
    spacing_residual = max(spacing_residual, abs(trailing.height - target_trailing))
    if trailing.height and trailing.height != target_trailing:
        trailing = trailing.resize((trailing.width, target_trailing), Image.Resampling.BICUBIC)
    registered.paste(trailing, (0, baseline_cursor))
    transformed_regions = [transformed_by_identity[id(region)] for region in current_regions]
    return registered, transformed_regions, approved_height_delta, spacing_residual


def compare_visuals(repo: Path, output: Path, capture: dict[str, Any]) -> list[dict[str, Any]]:
    policy = json.loads((repo / "release-evidence/baseline/visual-diff-policy.json").read_text(encoding="utf-8"))["comparison"]
    results: list[dict[str, Any]] = []
    for current, recaptured in zip(capture["final"], capture["baseline"], strict=True):
        width = current["width"]
        baseline_path = repo / "release-evidence/baseline" / f"index-{width}.jpg"
        recaptured_path = output / f".baseline-reproduction-{width}.jpg"
        comparison_baseline_path = output / f".baseline-{width}.jpg"
        current_path = output / f"index-{width}.jpg"
        with (
            Image.open(baseline_path) as checked_baseline_image,
            Image.open(recaptured_path) as recaptured_image,
            Image.open(comparison_baseline_path) as baseline_image,
            Image.open(current_path) as current_image,
        ):
            baseline_changed, baseline_total = count_changed_pixels(
                checked_baseline_image, recaptured_image, policy["per_channel_tolerance"]
            )
            current_regions = current["metrics"]["allowedRegions"]
            baseline_regions = recaptured["metrics"]["allowedRegions"]
            registered_current, transformed_regions, approved_height_delta, spacing_residual = register_allowed_bands(
                current_image, baseline_image, current_regions, baseline_regions
            )
            maximum_size = baseline_image.size
            mask = region_mask(
                maximum_size,
                baseline_regions,
                transformed_regions,
            )
            full_changed, full_total = count_changed_pixels(
                baseline_image, registered_current, policy["per_channel_tolerance"]
            )
            protected_changed, protected_total = count_changed_pixels(
                baseline_image, registered_current, policy["per_channel_tolerance"], mask
            )
            dimension_delta = max(
                abs(baseline_image.width - current_image.width),
                abs(baseline_image.height - current_image.height),
            )
            residual_dimension_delta = max(
                abs(baseline_image.width - current_image.width),
                abs((current_image.height - baseline_image.height) - approved_height_delta),
                spacing_residual,
            )
        header_deltas = {
            key: abs(current["metrics"]["header"][key] - recaptured["metrics"]["header"][key])
            for key in ("x", "y", "width", "height")
        }
        geometry_deltas = {
            selector: {
                key: abs(current["metrics"]["protectedGeometry"][selector][key] - recaptured["metrics"]["protectedGeometry"][selector][key])
                for key in ("width", "height")
            }
            for selector in current["metrics"]["protectedGeometry"]
        }
        maximum_geometry_delta = max(
            value for deltas in geometry_deltas.values() for value in deltas.values()
        )
        result = {
            "width": width,
            "final": f"release-evidence/previews/index-{width}.jpg",
            "team": f"release-evidence/previews/team-{width}.jpg",
            "baselineReproductionDiffRatio": baseline_changed / baseline_total,
            "fullPagePixelDiffRatio": full_changed / full_total,
            "protectedPixelDiffRatio": protected_changed / protected_total,
            "dimensionDeltaPx": dimension_delta,
            "approvedRegionHeightDeltaPx": approved_height_delta,
            "unapprovedDimensionDeltaPx": residual_dimension_delta,
            "allowedRegions": {"final": current_regions, "baseline": baseline_regions},
            "headerDeltasPx": header_deltas,
            "protectedGeometryDeltasPx": geometry_deltas,
            "comparisonMode": "full-page-pixels" if width >= policy["full_page_raster_required_min_width"] else "protected-dom-geometry",
            "sha256": sha256(current_path),
        }
        failures = []
        if result["baselineReproductionDiffRatio"] > policy["protected_pixel_diff_ratio_max"]:
            failures.append("checked-in baseline cannot be reproduced")
        if width >= policy["full_page_raster_required_min_width"]:
            if result["fullPagePixelDiffRatio"] > policy["full_page_pixel_diff_ratio_max"]:
                failures.append("full-page visual diff exceeds policy")
            if result["protectedPixelDiffRatio"] > policy["protected_pixel_diff_ratio_max"]:
                failures.append("protected visual diff exceeds policy")
        elif maximum_geometry_delta > policy["responsive_protected_geometry_delta_px_max"]:
            failures.append("responsive protected DOM geometry exceeds policy")
        if residual_dimension_delta > policy["dimension_delta_px_max"]:
            failures.append("page dimension delta outside approved component regions exceeds policy")
        if width in (1440, 1280, 390) and max(header_deltas.values()) > policy["dimension_delta_px_max"]:
            failures.append("V2.27 header composition moved")
        if current["errors"] or recaptured["errors"]:
            failures.extend(current["errors"] + recaptured["errors"])
        result["status"] = "pass" if not failures else "fail"
        result["failures"] = failures
        results.append(result)
    return results


def static_page_records(repo: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for pathname in STATIC_PATHS:
        filename = repo / "index.html" if pathname == "/" else repo / pathname.strip("/") / "index.html"
        errors: list[str] = []
        if not filename.is_file():
            records.append({"pathname": pathname, "file": str(filename.relative_to(repo)), "errors": ["file is missing"]})
            continue
        html = filename.read_text(encoding="utf-8")
        title_match = re.search(r"<title>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
        tags = re.findall(r"<(?:meta|link)\s+[^>]*>", html, re.IGNORECASE)

        def attributes(tag: str) -> dict[str, str]:
            return {
                name.lower(): value
                for name, _quote, value in re.findall(r"([\w:-]+)\s*=\s*(['\"])(.*?)\2", tag, re.DOTALL)
            }

        parsed = [attributes(tag) for tag in tags]
        canonical = next((item.get("href") for item in parsed if item.get("rel") == "canonical"), None)
        meta = {item.get("property"): item.get("content") for item in parsed if item.get("property")}
        title = re.sub(r"\s+", " ", title_match.group(1)).strip() if title_match else ""
        if not title:
            errors.append("document title is empty")
        records.append({
            "pathname": pathname,
            "file": str(filename.relative_to(repo)),
            "metrics": {
                "title": title,
                "images": len(re.findall(r"<img\b", html, re.IGNORECASE)),
                "canonical": canonical,
                "ogTitle": meta.get("og:title"),
                "ogDescription": meta.get("og:description"),
                "ogImage": meta.get("og:image"),
            },
            "errors": errors,
        })
    return records


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path("."))
    parser.add_argument("--output", type=Path, default=Path("release-evidence/previews"))
    parser.add_argument("--report", type=Path, default=Path("release-evidence/qa/beta-visual-rehearsal.json"))
    args = parser.parse_args()
    repo = args.repo.resolve()
    output = args.output if args.output.is_absolute() else repo / args.output
    report = args.report if args.report.is_absolute() else repo / args.report
    output.mkdir(parents=True, exist_ok=True)
    report.parent.mkdir(parents=True, exist_ok=True)
    package = playwright_package()

    with tempfile.TemporaryDirectory(prefix="oknotika-v227-beta-") as directory:
        baseline_root = Path(directory)
        archive_baseline(repo, baseline_root)
        with StaticServer(repo) as final_server, StaticServer(baseline_root) as baseline_server:
            with tempfile.NamedTemporaryFile("w", suffix=".cjs", encoding="utf-8", delete=False) as script:
                script.write(BROWSER_SCRIPT)
                script_path = Path(script.name)
            try:
                result = subprocess.run(
                    [
                        "node", str(script_path), str(package), final_server.origin, baseline_server.origin,
                        str(output), PINNED_CHROMIUM, json.dumps(WIDTHS), json.dumps(STATIC_PATHS),
                    ],
                    check=True,
                    stdout=subprocess.PIPE,
                    text=True,
                    timeout=300,
                )
            finally:
                script_path.unlink(missing_ok=True)
    capture = json.loads(result.stdout)
    visual_results = compare_visuals(repo, output, capture)
    for path in output.glob(".baseline-*.jpg"):
        path.unlink()
    pages = static_page_records(repo)
    static_failures = [entry for entry in pages if entry["errors"]]
    article_previews = [
        entry for entry in pages
        if entry["pathname"].startswith("/articles/") and entry["pathname"] != "/articles/"
    ]
    for entry in article_previews:
        metrics = entry["metrics"]
        missing = [name for name in ("canonical", "ogTitle", "ogDescription", "ogImage") if not metrics[name]]
        if missing:
            entry["errors"].append(f"Telegram link-preview metadata missing: {', '.join(missing)}")
            static_failures.append(entry)
    payload = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "baselineCommit": PINNED_COMMIT,
        "playwright": capture["playwright"],
        "chromium": capture["chromium"],
        "visualPolicy": "release-evidence/baseline/visual-diff-policy.json",
        "visuals": visual_results,
        "staticPages": pages,
        "telegramLinkPreview": {
            "mode": "deterministic Open Graph simulation; live Telegram fetch remains a production gate",
            "status": "pass" if not any(entry["errors"] for entry in article_previews) else "fail",
        },
        "status": "pass" if not static_failures and all(item["status"] == "pass" for item in visual_results) else "fail",
    }
    report.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if payload["status"] != "pass":
        print(f"Beta visual rehearsal failed; see {report}")
        return 1
    print(f"Beta visual rehearsal passed: {len(WIDTHS)} responsive captures, {len(pages)} page checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
