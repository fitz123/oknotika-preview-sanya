#!/usr/bin/env python3
"""Build the six approved August 2026 team portrait derivatives and evidence.

Source media stays outside Git. Exact hashes freeze the task-supplied frames.
Processing is limited to a 4:5 crop, uniform resize, and metadata-free encoding;
no generative or facial edits are performed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import threading
from dataclasses import dataclass
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image, ImageOps, __version__ as PILLOW_VERSION


RELEASE = "2026-08"
APPROVED_ON = "2026-08-04"
APPROVER = "Саня"
REQUIRED_PILLOW = "12.2.0"
PINNED_PLAYWRIGHT = "1.58.2"
PINNED_CHROMIUM = "145.0.7632.6"
OUTPUT_SIZE = (800, 1000)
MAX_COMBINED_BYTES = 800_000


@dataclass(frozen=True)
class Portrait:
    name: str
    slug: str
    role: str
    raw_name: str
    raw_sha256: str
    raw_format: str
    raw_size: tuple[int, int]
    crop: tuple[int, int, int, int]
    eye_line_y: int
    alt: str
    approved_on: str = "2026-08-02"
    approval_method: str = "supplied by Sanya for the 2026-08-02 review-preview revision"


PORTRAITS = (
    Portrait(
        "Алексей Макаров",
        "alexey-makarov",
        "Генеральный директор",
        "alexey-makarov.png",
        "da3350710ddde0d77a60dffdc183b22871fa1925d7ce65387f88ca6ae11bb877",
        "PNG",
        (1023, 1537),
        (1, 80, 1020, 1275),
        405,
        "Алексей Макаров, генеральный директор ОКНОТИКИ",
    ),
    Portrait(
        "Андрей Свирида",
        "andrey-svirida",
        "Директор медианаправления",
        "andrey-svirida.jpg",
        "298182d3ea8ae44d5d65cfa5267d60b340b82103146c278c9e5af2af7e4081e1",
        "JPEG",
        (853, 1280),
        (66, 70, 720, 900),
        305,
        "Андрей Свирида, директор медианаправления ОКНОТИКИ",
    ),
    Portrait(
        "Оксана Скопина",
        "oksana-skopina",
        "Главный бухгалтер",
        "oksana-skopina.png",
        "e2181428ee5bc2346ea7249db6e52067a1900d7ae53952b199556b5ead6e70b2",
        "PNG",
        (1086, 1448),
        (1, 0, 1084, 1355),
        330,
        "Оксана Скопина, главный бухгалтер ОКНОТИКИ",
    ),
    Portrait(
        "Екатерина Рычкова",
        "ekaterina-rychkova",
        "Исполнительный бухгалтер",
        "ekaterina-rychkova.png",
        "0ea182fb44ebeb6d761f2d9e1d8ef1e0d743960b08493c95143f8c5124c94076",
        "PNG",
        (1023, 1537),
        (1, 70, 1020, 1275),
        400,
        "Екатерина Рычкова, исполнительный бухгалтер ОКНОТИКИ",
    ),
    Portrait(
        "Александр Золотухин",
        "alexander-zolotukhin",
        "Руководитель компании · директор по развитию",
        "alexander-zolotukhin.jpg",
        "5b519dd25accba112bcd822f7070ee1c65677cf2ac2eb57f15abeaa66f812858",
        "JPEG",
        (853, 1280),
        (1, 50, 852, 1065),
        314,
        "Александр Золотухин, руководитель компании и директор по развитию ОКНОТИКИ",
        approved_on="2026-08-04",
        approval_method="supplied by Sanya for the final Zhenya handoff on 2026-08-04",
    ),
    Portrait(
        "Дмитрий Благочевский",
        "dmitry-blagochevsky",
        "Исполнительный директор",
        "dmitry-blagochevsky.png",
        "e1c57884176910b94cdd43ed0f5d64bda46ea33038b635b7c73d89408579a2ec",
        "PNG",
        (1086, 1448),
        (1, 40, 1084, 1355),
        409,
        "Дмитрий Благочевский, исполнительный директор ОКНОТИКИ",
        approved_on="2026-08-04",
        approval_method="supplied by Sanya for the final Zhenya handoff on 2026-08-04",
    ),
)

RETAINED = (
    {
        "name": "Роман Водянов",
        "role": "Руководитель проектов",
        "alt": "Роман Водянов, руководитель проектов ОКНОТИКИ",
        "source_release": "2026-07 approved team shoot",
        "outputs": {
            "jpeg": ("img/team/roman-vodyanov-2026-07.jpg", "bddef216727b8d16baf254c5b6d82bad8f7de2b5504ef74b1dfbe918ea8099cb"),
            "webp": ("img/team/roman-vodyanov-2026-07.webp", "8ac16728156045ad8af03b399c6ebf750edc47d7c78774cfbbcf213aa95f3286"),
        },
    },
    {
        "name": "Иван Рябоконь",
        "role": "Руководитель направления «Умное окно»",
        "alt": "Иван Рябоконь, руководитель направления Умное окно ОКНОТИКИ",
        "source_release": "2026-07 approved team shoot",
        "outputs": {
            "jpeg": ("img/team/ivan-ryabokon-2026-07.jpg", "58b652aaf6adf9aadad7bb2a3d4c38bf3b9b55ebce5f14ee77069c5a01803261"),
            "webp": ("img/team/ivan-ryabokon-2026-07.webp", "4ac18ba9c2cad370108041dfee1d464c9455600bad67aa646d96269d52174df6"),
        },
    },
    {
        "name": "Ирина Благочевская",
        "role": "Менеджер тендерного отдела",
        "alt": "Ирина Благочевская, менеджер тендерного отдела ОКНОТИКИ",
        "source_release": "reviewed base feature/site-preview-full-20260802",
        "outputs": {
            "jpeg": ("img/team/irina-blagochevskaya-2026-08.jpg", "5182a3b37791101104706182ee113a1ea501e33c11445b3f36c3db9a1eef795a"),
        },
    },
)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def verify_source(path: Path, portrait: Portrait) -> None:
    if not path.is_file():
        raise RuntimeError(f"approved source is missing: {path}")
    actual_hash = sha256(path)
    if actual_hash != portrait.raw_sha256:
        raise RuntimeError(
            f"approved source changed for {portrait.name}: expected {portrait.raw_sha256}, got {actual_hash}"
        )
    with Image.open(path) as image:
        if image.format != portrait.raw_format or image.size != portrait.raw_size:
            raise RuntimeError(f"unexpected source for {portrait.name}: {image.format} {image.size}")


def render_portrait(raw: Path, portrait: Portrait, output_dir: Path) -> dict[str, object]:
    left, top, width, height = portrait.crop
    source_width, source_height = portrait.raw_size
    if width * 5 != height * 4:
        raise RuntimeError(f"crop is not 4:5 for {portrait.name}: {portrait.crop}")
    if not (0 <= left <= source_width - width and 0 <= top <= source_height - height):
        raise RuntimeError(f"crop escapes source for {portrait.name}: {portrait.crop}")

    with Image.open(raw) as source:
        clean = ImageOps.exif_transpose(source).convert("RGB")
        final = clean.crop((left, top, left + width, top + height)).resize(
            OUTPUT_SIZE,
            Image.Resampling.LANCZOS,
        )

    output_dir.mkdir(parents=True, exist_ok=True)
    jpeg = output_dir / f"{portrait.slug}-{RELEASE}.jpg"
    webp = output_dir / f"{portrait.slug}-{RELEASE}.webp"
    final.save(jpeg, format="JPEG", quality=82, optimize=True, progressive=True, exif=b"")
    final.save(webp, format="WEBP", quality=80, method=6, exact=True, exif=b"")

    return {
        "name": portrait.name,
        "role": portrait.role,
        "status": "approved_task_media",
        "approval": {
            "approver": APPROVER,
            "approved_on": portrait.approved_on,
            "method": portrait.approval_method,
        },
        "raw": {
            "path_env": f"${{OKNOTIKA_TASK_MEDIA_DIR}}/{portrait.raw_name}",
            "sha256": portrait.raw_sha256,
            "format": portrait.raw_format,
            "width": portrait.raw_size[0],
            "height": portrait.raw_size[1],
        },
        "crop": {
            "x": left,
            "y": top,
            "width": width,
            "height": height,
            "eye_line_source_y": portrait.eye_line_y,
            "eye_line_output_ratio": round((portrait.eye_line_y - top) / height, 4),
            "normalization": "crop and uniform resize only; identity and expression unchanged",
        },
        "html": {
            "alt": portrait.alt,
            "width": OUTPUT_SIZE[0],
            "height": OUTPUT_SIZE[1],
            "loading": "lazy",
            "decoding": "async",
        },
        "outputs": {
            "jpeg": output_record(jpeg, "JPEG", output_dir.parents[1]),
            "webp": output_record(webp, "WEBP", output_dir.parents[1]),
        },
    }


def output_record(path: Path, image_format: str, repo: Path) -> dict[str, object]:
    return {
        "path": path.relative_to(repo).as_posix(),
        "format": image_format,
        "sha256": sha256(path),
        "bytes": path.stat().st_size,
        "width": OUTPUT_SIZE[0],
        "height": OUTPUT_SIZE[1],
        "exif": "absent",
    }


def retained_record(repo: Path, retained: dict[str, object]) -> dict[str, object]:
    outputs: dict[str, dict[str, object]] = {}
    for format_name, values in retained["outputs"].items():  # type: ignore[union-attr]
        path_value, expected_hash = values
        path = repo / path_value
        if not path.is_file() or sha256(path) != expected_hash:
            raise RuntimeError(f"retained portrait changed: {path_value}")
        expected_format = "JPEG" if format_name == "jpeg" else "WEBP"
        with Image.open(path) as image:
            if image.format != expected_format or image.size != OUTPUT_SIZE or image.getexif():
                raise RuntimeError(f"retained portrait encoding changed: {path_value}")
        outputs[format_name] = output_record(path, expected_format, repo)
    return {
        "name": retained["name"],
        "role": retained["role"],
        "status": "retained_approved_derivative",
        "provenance": retained["source_release"],
        "html": {
            "alt": retained["alt"],
            "width": OUTPUT_SIZE[0],
            "height": OUTPUT_SIZE[1],
            "loading": "lazy",
            "decoding": "async",
        },
        "outputs": outputs,
    }


CAPTURE_SCRIPT = r"""
const path = require('path');
const { chromium } = require(process.argv[2]);

(async () => {
  const url = process.argv[3];
  const output = process.argv[4];
  const expectedVersion = process.argv[5];
  const browser = await chromium.launch({ headless: true });
  try {
    if (browser.version() !== expectedVersion) {
      throw new Error(`Chromium ${expectedVersion} required, got ${browser.version()}`);
    }
    const captures = [];
    for (const [label, width] of [['desktop', 1440], ['mobile', 390]]) {
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
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.addStyleTag({ content: `
        *, *::before, *::after { animation: none !important; transition: none !important; }
        .reveal { opacity: 1 !important; transform: none !important; }
        .site-header { display: none !important; }
      ` });
      await page.locator('#team').scrollIntoViewIfNeeded();
      await page.evaluate(async () => {
        const images = Array.from(document.querySelectorAll('#team img'));
        images.forEach((image) => { image.loading = 'eager'; });
        await Promise.all(images.map((image) => image.decode().catch(() => {})));
        if (document.fonts?.ready) await document.fonts.ready;
      });
      const metrics = await page.evaluate(() => {
        const grid = document.querySelector('#team .team-grid');
        const cards = Array.from(document.querySelectorAll('#team .person'));
        const portraits = Array.from(document.querySelectorAll('#team .person__portrait'));
        return {
          card_count: cards.length,
          column_count: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
          client_width: document.documentElement.clientWidth,
          scroll_width: document.documentElement.scrollWidth,
          images_ready: cards.every((card) => {
            const image = card.querySelector('img');
            return image && image.complete && image.naturalWidth === 800 && image.naturalHeight === 1000;
          }),
          portrait_boxes_are_4_by_5: portraits.every((portrait) => {
            const box = portrait.getBoundingClientRect();
            return Math.abs(box.width / box.height - 0.8) < 0.005;
          }),
        };
      });
      const expectedColumns = width === 390 ? 1 : 3;
      if (metrics.card_count !== 9 || metrics.column_count !== expectedColumns ||
          metrics.scroll_width > metrics.client_width + 1 || !metrics.images_ready ||
          !metrics.portrait_boxes_are_4_by_5) {
        throw new Error(`invalid team layout at ${width}px: ${JSON.stringify(metrics)}`);
      }
      const filename = `team-${label}-${width}.jpg`;
      await page.locator('#team').screenshot({
        path: path.join(output, filename),
        type: 'jpeg',
        quality: 84,
      });
      captures.push({ filename, viewport_width: width, metrics });
      await context.close();
    }
    process.stdout.write(JSON.stringify({ chromium: browser.version(), captures }));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
"""


def playwright_package() -> Path:
    executable = shutil.which("playwright")
    if executable is None:
        raise RuntimeError("Playwright CLI is required to capture the approval sheet")
    package = Path(executable).resolve().parent
    version = subprocess.run(
        [executable, "--version"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip().removeprefix("Version ")
    if version != PINNED_PLAYWRIGHT:
        raise RuntimeError(f"Playwright {PINNED_PLAYWRIGHT} required, got {version}")
    return package


def capture_approval(repo: Path, output: Path) -> dict[str, object]:
    output.mkdir(parents=True, exist_ok=True)
    handler = partial(QuietHandler, directory=str(repo))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".cjs", encoding="utf-8", delete=False) as script:
            script.write(CAPTURE_SCRIPT)
            script_path = Path(script.name)
        try:
            command = [
                "node",
                str(script_path),
                str(playwright_package()),
                f"http://127.0.0.1:{server.server_port}/index.html",
                str(output),
                PINNED_CHROMIUM,
            ]
            result = subprocess.run(command, capture_output=True, text=True)
            if result.returncode:
                raise RuntimeError(f"approval capture failed: {result.stderr.strip()}")
            capture = json.loads(result.stdout)
        finally:
            script_path.unlink(missing_ok=True)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    for item in capture["captures"]:
        screenshot = output / item["filename"]
        with Image.open(screenshot) as image:
            item["width"], item["height"] = image.size
        item["sha256"] = sha256(screenshot)
        item["bytes"] = screenshot.stat().st_size
    return capture


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path("."))
    parser.add_argument("--raw-dir", type=Path)
    parser.add_argument("--skip-approval-capture", action="store_true")
    args = parser.parse_args()
    repo = args.repo.resolve()
    configured_raw_dir = args.raw_dir or (Path(os.environ["OKNOTIKA_TASK_MEDIA_DIR"]) if "OKNOTIKA_TASK_MEDIA_DIR" in os.environ else None)
    if configured_raw_dir is None:
        raise RuntimeError("set OKNOTIKA_TASK_MEDIA_DIR or pass --raw-dir")
    raw_dir = configured_raw_dir if configured_raw_dir.is_absolute() else repo / configured_raw_dir
    output_dir = repo / "img/team"

    if PILLOW_VERSION != REQUIRED_PILLOW:
        raise RuntimeError(f"Pillow {REQUIRED_PILLOW} required, got {PILLOW_VERSION}")

    records: list[dict[str, object]] = []
    for portrait in PORTRAITS:
        raw = raw_dir / portrait.raw_name
        verify_source(raw, portrait)
        records.append(render_portrait(raw, portrait, output_dir))
    records.extend(retained_record(repo, retained) for retained in RETAINED)

    new_bytes = sum(
        int(output["bytes"])
        for record in records
        if record["status"] == "approved_task_media"
        for output in record["outputs"].values()  # type: ignore[union-attr]
    )
    if new_bytes > MAX_COMBINED_BYTES:
        raise RuntimeError(f"combined JPEG/WebP size is {new_bytes} bytes; maximum is {MAX_COMBINED_BYTES}")

    approval_output = repo / "release-evidence/team-approval"
    if not args.skip_approval_capture:
        capture = capture_approval(repo, approval_output)
        write_json(
            approval_output / "approval-sheet.json",
            {
                "schema_version": 2,
                "approval_record": {
                    "approver": APPROVER,
                    "approved_on": APPROVED_ON,
                    "source": "task media supplied by Sanya for the reviewed site and final Zhenya handoff",
                    "raw_selection": "frozen by exact SHA-256 in team-release-evidence.json",
                    "scope": "production-candidate handoff; deployment remains separately gated",
                },
                "capture": {
                    "playwright": PINNED_PLAYWRIGHT,
                    "chromium": capture["chromium"],
                    "page": "/index.html#team",
                    "animations": "disabled; reveal nodes forced visible",
                    "screenshots": capture["captures"],
                },
            },
        )
        (approval_output / "README.md").write_text(
            "# Team review evidence\n\n"
            "The two contact sheets render all nine public cards at 1440 px and 390 px. "
            "The six replacement frames supplied by Саня are frozen by their SHA-256 values "
            "in `team-release-evidence.json`; the other three approved derivatives are verified "
            "byte-for-byte.\n\n"
            "Processing is limited to 4:5 crop, uniform resize and metadata-free JPEG/WebP "
            "encoding. Faces, expressions and identity are unchanged. Raw media and private "
            "supporting records stay outside Git and the deployment package.\n\n"
            "Captured layout metrics verify nine decoded 800×1000 images, three desktop "
            "columns, one mobile column, 4:5 boxes and no horizontal overflow.\n\n"
            "This evidence covers the production-candidate handoff to Женя. Deployment remains "
            "separately gated by package validation, credentials, DNS/TLS and live smoke checks.\n",
            encoding="utf-8",
        )

    manifest = {
        "schema_version": 2,
        "release": RELEASE,
        "generator": {
            "path": "tools/team-portraits/create_final_portraits.py",
            "pillow": PILLOW_VERSION,
            "operation": "approved 4:5 crop, uniform resize and metadata-free encoding only",
        },
        "approval": {
            "approver": APPROVER,
            "approved_on": APPROVED_ON,
            "basis": "six replacement frames supplied by Sanya across the reviewed site and final handoff",
            "scope": "production-candidate handoff",
            "evidence": "release-evidence/team-approval/",
        },
        "portrait_count": len(records),
        "task_media_portrait_count": len(PORTRAITS),
        "retained_portrait_count": len(RETAINED),
        "task_media_outputs_combined_bytes": new_bytes,
        "task_media_outputs_max_bytes": MAX_COMBINED_BYTES,
        "portraits": records,
    }
    write_json(repo / "release-evidence/team-release-evidence.json", manifest)
    print(
        f"Generated {len(PORTRAITS)} approved portrait pairs ({new_bytes} bytes) "
        f"and verified {len(RETAINED)} retained portraits"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
