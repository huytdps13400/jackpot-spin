"""Packs the Blender renders into the runtime sprites (run after render_coins.py / render_tiles.py /
render_chest.py / render_vfx.py). Only sprites whose raw frames exist in <raw_dir> are written, so each render set
can be packed on its own without touching the others.

    python3 scripts/blender/pack_sprites.py <raw_dir> assets/sprites
"""
import glob
import os
import sys

from PIL import Image

raw, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
S = 128  # ~105 px cell at @3x; one size for every board sprite keeps the Atlas math trivial


def load(path, size=S):
    return Image.open(path).convert("RGBA").resize((size, size), Image.LANCZOS)


for single in ("coin_gold", "coin_socket", "tile_idle", "tile_gold"):
    src = os.path.join(raw, single + ".png")
    if os.path.exists(src):
        load(src).save(os.path.join(out, single + ".png"), optimize=True)
# additive light VFX from render_vfx.py: already final size (non-square), copied as-is
for single in ("fx_spark", "fx_ember", "fx_godrays"):
    src = os.path.join(raw, single + ".png")
    if os.path.exists(src):
        Image.open(src).convert("RGBA").save(os.path.join(out, single + ".png"), optimize=True)
# (raw frame prefix, columns, cell px); frames are row-major, frame 0 top-left
SHEETS = (
    ("coin_flip", 6, S),
    ("coin_spin", 4, S),
    ("tile_flip", 6, S),
    ("chest_open", 4, 256),  # jackpot chest: 16 frames rendered at 512, shown large -> 256 cells
    ("fx_burst", 4, 256),  # impact flare, additive on black (render_vfx.py)
    ("fx_glint", 4, 128),  # sparkle glint twinkle, additive on black (render_vfx.py)
)
for name, cols, cell in SHEETS:
    frames = sorted(glob.glob(os.path.join(raw, f"{name}_*.png")))
    if not frames:
        continue
    rows = (len(frames) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * cell, rows * cell), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        sheet.alpha_composite(load(f, cell), ((i % cols) * cell, (i // cols) * cell))
    sheet.save(os.path.join(out, f"{name}_sheet.png"), optimize=True)
    print(name, len(frames), "frames", sheet.size)

# loot beam (render_vfx.py): non-square 96 x 384 cells, the tintable haze row then the white core row
haze = sorted(glob.glob(os.path.join(raw, "fx_pillar_[0-9]*.png")))
core = sorted(glob.glob(os.path.join(raw, "fx_pillarcore_*.png")))
if haze and core:
    PW, PH = 96, 384
    sheet = Image.new("RGBA", (len(haze) * PW, 2 * PH), (0, 0, 0, 255))
    for row, frames in enumerate((haze, core)):
        for i, f in enumerate(frames):
            sheet.paste(Image.open(f).convert("RGBA"), (i * PW, row * PH))
    sheet.save(os.path.join(out, "fx_pillar_sheet.png"), optimize=True)
    print("fx_pillar", len(haze), "+", len(core), "frames", sheet.size)
