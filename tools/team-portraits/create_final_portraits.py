#!/usr/bin/env python3
"""Build the approved July 2026 team portraits and visual evidence.

The raw input directory is deliberately untracked. Exact source hashes make a
changed approval frame a hard failure. Processing is limited to crop, uniform
resize and metadata-free JPEG/WebP encoding; no generative or facial edits are
performed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
import threading
from dataclasses import dataclass
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image, ImageOps, __version__ as PILLOW_VERSION


RELEASE = "2026-07"
APPROVED_AT = "2026-07-13T21:34:00Z"
APPROVER = "Саня"
REQUIRED_PILLOW = "12.2.0"
PINNED_PLAYWRIGHT = "1.58.2"
PINNED_CHROMIUM = "145.0.7632.6"
OUTPUT_SIZE = (800, 1000)
MAX_COMBINED_BYTES = 900_000


@dataclass(frozen=True)
class Portrait:
    name: str
    slug: str
    role: str
    raw_name: str
    raw_sha256: str
    crop: tuple[int, int, int, int]
    eye_line_y: int
    alt: str


PORTRAITS = (
    Portrait(
        "Александр Золотухин",
        "alexander-zolotukhin",
        "Директор по развитию",
        "alexander-zolotukhin.jpg",
        "8f9d0347785f14b835402e3bdbbcc33aece695a608d38f51407229792f223495",
        (30, 155, 900, 1125),
        443,
        "Александр Золотухин, директор по развитию ОКНОТИКИ",
    ),
    Portrait(
        "Евгений Жалнин",
        "evgeny-zhalnin",
        "Операционный директор",
        "evgeny-zhalnin.jpg",
        "06c01a9b7a0c71a0a2e925d62cd8c385b30fcfe3c0c0c64440f64797af3d84a2",
        (30, 140, 900, 1125),
        435,
        "Евгений Жалнин, операционный директор ОКНОТИКИ",
    ),
    Portrait(
        "Дмитрий Цветков",
        "dmitry-tsvetkov",
        "Коммерческий директор",
        "dmitry-tsvetkov.jpg",
        "5ef6b0cb2d82048b8aa16a2a0dd976368513db3eecf8907fa2434b427983195f",
        (80, 130, 800, 1000),
        390,
        "Дмитрий Цветков, коммерческий директор ОКНОТИКИ",
    ),
    Portrait(
        "Дмитрий Благочевский",
        "dmitry-blagochevsky",
        "Исполнительный директор",
        "dmitry-blagochevsky.jpg",
        "a6d8e581e383405b7518abec1857fd5173286d0009792dd42a0318735b9719e1",
        (120, 320, 640, 800),
        525,
        "Дмитрий Благочевский, исполнительный директор ОКНОТИКИ",
    ),
    Portrait(
        "Роман Водянов",
        "roman-vodyanov",
        "Руководитель проектов",
        "roman-vodyanov.jpg",
        "31193578a5606a387ed25d233df93b8279c6490ffb307c7a06be96db6ca8d8e3",
        (50, 205, 860, 1075),
        485,
        "Роман Водянов, руководитель проектов ОКНОТИКИ",
    ),
    Portrait(
        "Иван Рябоконь",
        "ivan-ryabokon",
        "Менеджер проектов",
        "ivan-ryabokon.jpg",
        "c70027ac4b2ea0c56acdc2de719940c8ce11223fbb35fbc66a7c8fc3c473bb2c",
        (150, 210, 700, 875),
        420,
        "Иван Рябоконь, менеджер проектов ОКНОТИКИ",
    ),
)

RETAINED = (
    {
        "name": "Сергей Бешенцев",
        "role": "Руководитель проекта «Умное окно»",
        "path": "img/team/beshentsev.jpg",
        "sha256": "4e60d8339bc4989be4d67fa4b7bee57a3794a72744c60a36b971cc8007e68939",
    },
    {
        "name": "Оксана Скопина",
        "role": "Главный бухгалтер",
        "path": "img/team/skopina.jpg",
        "sha256": "9c6fd867ddef00c97ad5e5b4b80ea5cd0df5922350d57639eca04c0ce381ec5f",
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
        raise RuntimeError(f"approved raw frame is missing: {path}")
    actual_hash = sha256(path)
    if actual_hash != portrait.raw_sha256:
        raise RuntimeError(
            f"approved raw frame changed for {portrait.name}: "
            f"expected {portrait.raw_sha256}, got {actual_hash}"
        )
    with Image.open(path) as image:
        if image.format != "JPEG" or image.size != (960, 1280):
            raise RuntimeError(f"unexpected raw format for {portrait.name}: {image.format} {image.size}")
        if image.getexif():
            raise RuntimeError(f"raw frame unexpectedly contains EXIF: {path}")


def render_portrait(raw: Path, portrait: Portrait, output_dir: Path) -> dict[str, object]:
    left, top, width, height = portrait.crop
    if width * 5 != height * 4:
        raise RuntimeError(f"crop is not 4:5 for {portrait.name}: {portrait.crop}")
    if not (0 <= left <= 960 - width and 0 <= top <= 1280 - height):
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

    output_eye_line = round((portrait.eye_line_y - top) / height, 4)
    return {
        "name": portrait.name,
        "role": portrait.role,
        "status": "approved_new_shoot",
        "approval": {
            "approver": APPROVER,
            "approved_at": APPROVED_AT,
            "method": "reaction to the private approval sheet; selection frozen in the project input set",
        },
        "raw": {
            "path": f".tmp-inputs/team-shoot/{portrait.raw_name}",
            "sha256": portrait.raw_sha256,
            "width": 960,
            "height": 1280,
            "exif": "absent",
        },
        "crop": {
            "x": left,
            "y": top,
            "width": width,
            "height": height,
            "eye_line_source_y": portrait.eye_line_y,
            "eye_line_output_ratio": output_eye_line,
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
            "jpeg": {
                "path": jpeg.relative_to(output_dir.parents[1]).as_posix(),
                "sha256": sha256(jpeg),
                "bytes": jpeg.stat().st_size,
            },
            "webp": {
                "path": webp.relative_to(output_dir.parents[1]).as_posix(),
                "sha256": sha256(webp),
                "bytes": webp.stat().st_size,
            },
        },
    }


CAPTURE_SCRIPT = r"""
const fs = require('fs');
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
      await context.addInitScript(() => localStorage.setItem('oknotika_cookie_ok', '1'));
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
      const filename = `team-${label}-${width}.jpg`;
      await page.locator('#team').screenshot({
        path: path.join(output, filename),
        type: 'jpeg',
        quality: 84,
      });
      const box = await page.locator('#team').boundingBox();
      captures.push({ filename, viewport_width: width, width: Math.round(box.width), height: Math.round(box.height) });
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
    resolved = Path(executable).resolve()
    package = resolved.parent
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
            result = subprocess.run(
                [
                    "node",
                    str(script_path),
                    str(playwright_package()),
                    f"http://127.0.0.1:{server.server_port}/index.html",
                    str(output),
                    PINNED_CHROMIUM,
                ],
                check=True,
                capture_output=True,
                text=True,
            )
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
    parser.add_argument("--raw-dir", type=Path, default=Path(".tmp-inputs/team-shoot"))
    parser.add_argument("--skip-approval-capture", action="store_true")
    args = parser.parse_args()
    repo = args.repo.resolve()
    raw_dir = args.raw_dir if args.raw_dir.is_absolute() else repo / args.raw_dir
    output_dir = repo / "img/team"

    if PILLOW_VERSION != REQUIRED_PILLOW:
        raise RuntimeError(f"Pillow {REQUIRED_PILLOW} required, got {PILLOW_VERSION}")

    records: list[dict[str, object]] = []
    for portrait in PORTRAITS:
        raw = raw_dir / portrait.raw_name
        verify_source(raw, portrait)
        records.append(render_portrait(raw, portrait, output_dir))

    for retained in RETAINED:
        retained_path = repo / str(retained["path"])
        actual = sha256(retained_path)
        if actual != retained["sha256"]:
            raise RuntimeError(f"retained V2.27 portrait changed: {retained['path']}")
        records.append(
            {
                **retained,
                "status": "retained_v227_unchanged",
                "baseline_sha256": retained["sha256"],
                "current_sha256": actual,
            }
        )

    combined_bytes = sum(
        int(output["bytes"])
        for record in records
        if record["status"] == "approved_new_shoot"
        for output in record["outputs"].values()  # type: ignore[union-attr]
    )
    if combined_bytes > MAX_COMBINED_BYTES:
        raise RuntimeError(f"combined JPEG/WebP size is {combined_bytes} bytes; maximum is {MAX_COMBINED_BYTES}")

    approval_output = repo / "release-evidence/team-approval"
    capture: dict[str, object] | None = None
    if not args.skip_approval_capture:
        capture = capture_approval(repo, approval_output)
        write_json(
            approval_output / "approval-sheet.json",
            {
                "schema_version": 1,
                "approval_record": {
                    "approver": APPROVER,
                    "approved_at": APPROVED_AT,
                    "source": "private approval-sheet reaction recorded in the implementation plan",
                    "raw_selection": "frozen by exact SHA-256 in team-release-evidence.json",
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
            "# Team approval evidence\n\n"
            "The two contact sheets render all eight public cards from the final site at "
            "1440 px and 390 px. The six selected shoot frames are locked by their raw "
            "SHA-256 values in `team-release-evidence.json`; changing a frame makes the "
            "generator fail closed. Сергей Бешенцев and Оксана Скопина retain their V2.27 "
            "assets byte-for-byte.\n\n"
            "Саня's approval is recorded at 2026-07-13T21:34:00Z, when the approved private "
            "input set was frozen for this release. The original private approval exchange "
            "and rights documents are intentionally not copied into Git or the release ZIP.\n\n"
            "Internal web-use confirmation covers publication of these six portraits on the "
            "ОКНОТИКА website. It does not transfer rights or permit unrelated reuse. The "
            "private supporting records remain outside the repository and deployment package.\n",
            encoding="utf-8",
        )

    manifest = {
        "schema_version": 1,
        "release": RELEASE,
        "generator": {
            "path": "tools/team-portraits/create_final_portraits.py",
            "pillow": PILLOW_VERSION,
            "operation": "approved crop, uniform resize and metadata-free encoding only",
        },
        "approval": {
            "approver": APPROVER,
            "approved_at": APPROVED_AT,
            "timestamp_basis": "approved private input set frozen for this release",
            "evidence": "release-evidence/team-approval/",
        },
        "web_use_rights": {
            "confirmed": True,
            "scope": "six approved portraits on the public ОКНОТИКА website",
            "recorded_at": APPROVED_AT,
            "private_documents": "retained outside Git, release ZIP and public document root",
        },
        "portrait_count": len(records),
        "new_portrait_count": len(PORTRAITS),
        "retained_portrait_count": len(RETAINED),
        "new_outputs_combined_bytes": combined_bytes,
        "new_outputs_max_bytes": MAX_COMBINED_BYTES,
        "portraits": records,
    }
    write_json(repo / "release-evidence/team-release-evidence.json", manifest)
    print(
        f"Generated {len(PORTRAITS)} approved portraits in JPEG/WebP "
        f"({combined_bytes} bytes combined) and verified {len(RETAINED)} retained portraits"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
