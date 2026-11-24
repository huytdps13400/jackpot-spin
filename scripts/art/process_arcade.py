#!/usr/bin/env python3
"""Post-process the generated arcade UI art into app-ready assets.

The painted chrome (board frame, result plate, banner, counter panel, pills, SPIN faces, icons,
JACKPOT! title, logo, background) was generated as transparent PNGs by an image model from
written briefs (see README -> "Assets"). The raw renders have generous transparent margins and
are far larger than the phone ever draws them, so this script:

  1. crops each painted piece to its alpha bounding box (icons keep their full canvas so every
     icon shares one optical size),
  2. resizes it with Lanczos to the exact pixel size the app's nine-slice / layout math expects
     (src/theme/art.ts `nine` insets are measured in these output pixels),
  3. writes assets/art/arcade/<name>.png (and the background as a quality-88 JPEG).

Usage:
  python3 scripts/art/process_arcade.py <raw_dir> [<raw_dir> ...] [--out assets/art/arcade]

Every <raw_dir> is searched for the file names below; missing ones are skipped with a note.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image

# name: (output width, output height, crop to alpha bbox?)
TARGETS: dict[str, tuple[int, int, bool]] = {
    "frame_board": (654, 651, True),
    "plate_hex": (564, 210, True),
    "banner_strip": (780, 142, True),
    "panel_counter": (553, 236, True),
    "pill": (359, 112, True),
    "jackpot_title": (1100, 502, True),
    "logo_small": (665, 84, True),
    "spin_idle": (330, 330, True),
    "spin_stop": (330, 330, True),
    "button_square": (140, 140, True),
    "icon_sound": (84, 84, False),
    "icon_sound_off": (84, 84, False),
    "icon_vibrate": (84, 84, False),
    "icon_flag": (84, 84, False),
    "icon_coins": (84, 84, False),
    "icon_crown": (84, 84, False),
}
BACKGROUND = ("bg_arcade", (1024, 1536))
ALPHA_FLOOR = 0  # any visible pixel (glows included) counts toward the bbox


def alpha_bbox(img: Image.Image) -> tuple[int, int, int, int]:
    alpha = img.getchannel("A").point(lambda a: 255 if a > ALPHA_FLOOR else 0)
    box = alpha.getbbox()
    if box is None:
        raise ValueError("image is fully transparent")
    return box


def find(raw_dirs: list[Path], name: str) -> Path | None:
    for d in raw_dirs:
        p = d / f"{name}.png"
        if p.exists():
            return p
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("raw_dirs", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, default=Path("assets/art/arcade"))
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    for name, (w, h, crop) in TARGETS.items():
        src = find(args.raw_dirs, name)
        if src is None:
            print(f"skip  {name}: not found", file=sys.stderr)
            continue
        img = Image.open(src).convert("RGBA")
        if crop:
            img = img.crop(alpha_bbox(img))
        out = img.resize((w, h), Image.Resampling.LANCZOS)
        out.save(args.out / f"{name}.png", optimize=True)
        print(f"wrote {name}.png {w}x{h}  (from {src.name} {Image.open(src).size})")

    bg_name, bg_size = BACKGROUND
    src = find(args.raw_dirs, bg_name)
    if src is None:
        print(f"skip  {bg_name}: not found", file=sys.stderr)
    else:
        Image.open(src).convert("RGB").resize(bg_size, Image.Resampling.LANCZOS).save(
            args.out / f"{bg_name}.jpg", quality=88, optimize=True
        )
        print(f"wrote {bg_name}.jpg {bg_size[0]}x{bg_size[1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
