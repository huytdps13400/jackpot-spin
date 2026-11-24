"""
Re-grades the painted arcade chrome (assets/art/arcade) into the "Royal Treasure" luxury palette:

    python3 scripts/art/recolor_luxury.py assets/art/arcade assets/art/lux

The painted art keeps its exact geometry and alpha (so the nine-slice metadata in
src/theme/art.ts stays valid); only colour moves, in OKLCH so lightness and chroma stay
perceptually even:
  - violet structure      → midnight sapphire / royal indigo, darker
  - hot magenta / pink    → per asset: ruby (SPIN face, ribbons) or royal plaque purple
  - electric-blue neon    → softened cyan or gold light
  - gold / orange / white → untouched (gold is the hero; it must stay rich)
Highlights (L > ~0.8) are protected so the bevels keep their sparkle.
"""

import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from oklab import oklch_to_srgb, srgb_to_oklch  # noqa: E402

# source hue bands (OKLCH degrees): centre, half-width
BANDS = {"blue": (232, 30), "violet": (290, 22), "magenta": (342, 26)}
FEATHER = 14.0

# dst hue, chroma scale, lightness scale (shadows/midtones; highlights are protected)
NAVY = (268, 0.62, 0.58)
ROYAL = (276, 0.62, 0.68)
PLAQUE = (283, 0.66, 0.58)
RUBY = (14, 0.92, 0.82)
CYAN = (222, 0.55, 0.92)
GOLDLIGHT = (80, 0.55, 1.0)
# big flat plaques read louder than small parts at the same chroma: calmer, deeper
PLAQUE_DEEP = (268, 0.28, 0.46)
# neon edge light → warm gold light
GOLDEDGE = (78, 0.75, 1.0)

PRESETS = {
    "frame_board.png": {"violet": ROYAL, "magenta": (78, 0.75, 1.0), "blue": CYAN},
    "plate_hex.png": {"violet": NAVY, "magenta": (78, 0.75, 1.0), "blue": CYAN},
    "banner_strip.png": {"violet": PLAQUE_DEEP, "magenta": GOLDEDGE, "blue": GOLDEDGE},
    "panel_counter.png": {"violet": PLAQUE_DEEP, "magenta": PLAQUE_DEEP, "blue": GOLDEDGE},
    "pill.png": {"violet": NAVY, "magenta": ROYAL, "blue": GOLDLIGHT},
    "button_square.png": {"violet": NAVY, "magenta": ROYAL, "blue": GOLDLIGHT},
    "spin_idle.png": {"violet": RUBY, "magenta": RUBY, "blue": GOLDLIGHT},
    "spin_stop.png": {"violet": NAVY, "magenta": RUBY, "blue": GOLDLIGHT},
    "jackpot_title.png": {"violet": NAVY, "magenta": RUBY, "blue": CYAN},
    "logo_small.png": {"violet": NAVY, "magenta": RUBY, "blue": CYAN},
    "icon_vibrate.png": {"violet": NAVY, "magenta": RUBY, "blue": CYAN},
}
DEFAULT = {"violet": NAVY, "magenta": RUBY, "blue": CYAN}
# the luxury skin has its own background (bg_lux.jpg, see process_lux.py)
SKIP = {"bg_arcade.jpg"}


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def angdist(h, c):
    d = np.abs(h - c) % 360
    return np.minimum(d, 360 - d)


def regrade(rgb, preset):
    L, C, H = srgb_to_oklch(rgb)
    # Lab of the original, for blending without hue wrap-around problems
    a0, b0 = C * np.cos(np.radians(H)), C * np.sin(np.radians(H))
    acc_w = np.zeros_like(L)
    acc_L = np.zeros_like(L)
    acc_a = np.zeros_like(L)
    acc_b = np.zeros_like(L)
    chroma_gate = smoothstep(0.012, 0.045, C)
    protect = smoothstep(0.72, 0.97, L)
    for band, (centre, half) in BANDS.items():
        dst_h, ck, lk = preset[band]
        w = np.clip(1 - (angdist(H, centre) - half) / FEATHER, 0, 1) * chroma_gate
        if not np.any(w > 0):
            continue
        signed = ((H - centre + 180) % 360) - 180
        nh = dst_h + signed * 0.25
        nc = C * ck
        nl = L * (lk + (1 - lk) * protect)
        acc_w += w
        acc_L += w * nl
        acc_a += w * nc * np.cos(np.radians(nh))
        acc_b += w * nc * np.sin(np.radians(nh))
    total = np.maximum(acc_w, 1e-6)
    k = np.clip(acc_w, 0, 1)
    Ln = L * (1 - k) + (acc_L / total) * k
    an = a0 * (1 - k) + (acc_a / total) * k
    bn = b0 * (1 - k) + (acc_b / total) * k
    Cn = np.hypot(an, bn)
    Hn = (np.degrees(np.arctan2(bn, an)) + 360) % 360
    return oklch_to_srgb(Ln, Cn, Hn)


def process(src, dst):
    name = os.path.basename(src)
    im = Image.open(src)
    has_alpha = im.mode in ("RGBA", "LA", "P")
    im = im.convert("RGBA")
    arr = np.asarray(im).astype(np.float64) / 255.0
    out = regrade(arr[..., :3], PRESETS.get(name, DEFAULT))
    rgba = np.concatenate([out, arr[..., 3:4]], axis=-1)
    img = Image.fromarray((np.clip(rgba, 0, 1) * 255 + 0.5).astype(np.uint8), "RGBA")
    if name.endswith(".jpg"):
        img.convert("RGB").save(dst, quality=88, optimize=True)
    else:
        img.save(dst, optimize=True) if has_alpha else img.convert("RGB").save(dst, optimize=True)
    print(f"{name}: {im.size[0]}x{im.size[1]}")


def main():
    src_dir, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    for name in sorted(os.listdir(src_dir)):
        if name.lower().endswith((".png", ".jpg")) and name not in SKIP:
            process(os.path.join(src_dir, name), os.path.join(out_dir, name))


if __name__ == "__main__":
    main()
