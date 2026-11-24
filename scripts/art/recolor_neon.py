"""Neon Royale violet pass, in OKLCH, to match the Neon skin's concept art:

 - board tiles: the Blender-rendered sapphire tiles (assets/sprites/tile_*.png) re-lit as violet
   lacquer. Only the blue lacquer moves (weighted by how close a pixel's hue is to the
   sapphire's); the gold rims and the claimed tile's bronze face keep their exact colour, so a
   flip from idle to claimed still lands on the same gold.
 - result plate: the orange enamel of assets/art/arcade/plate_hex.png becomes deep violet, so
   the gold number sits on violet inside a gold bezel; the gold rim and magenta glow stay.

Run from the repo root:

    python3 scripts/art/recolor_neon.py
"""
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from oklab import oklch_to_srgb, srgb_to_oklch  # noqa: E402

TARGET_H = 300.0  # violet


def tile(L, C, H):
    """Sapphire lacquer (hue ~272°) → lit violet."""
    dh = np.abs(((H - 272.0) + 180) % 360 - 180)
    w = np.clip(1 - (dh - 25) / 30, 0, 1) * np.clip((C - 0.008) / 0.03, 0, 1)
    return w, np.minimum(0.86, L * 1.32 + 0.045), np.minimum(0.2, C * 2.1 + 0.01)


def plate(L, C, H):
    """Orange enamel (hue 30–45°) → deep violet; the gold rim (hue ~70°) is left alone."""
    dh = np.abs(((H - 38.0) + 180) % 360 - 180)
    w = np.clip(1 - (dh - 16) / 10, 0, 1) * np.clip((C - 0.05) / 0.05, 0, 1)
    return w, L * 0.56, np.minimum(0.19, C * 0.95)


JOBS = [
    ('assets/sprites/tile_idle.png', 'assets/sprites/tile_idle_neon.png', tile),
    ('assets/sprites/tile_flip_sheet.png', 'assets/sprites/tile_flip_sheet_neon.png', tile),
    ('assets/art/arcade/plate_hex.png', 'assets/art/arcade/plate_hex_violet.png', plate),
]


def recolor(path_in: str, path_out: str, rule) -> None:
    im = np.asarray(Image.open(path_in).convert('RGBA')).astype(np.float64) / 255
    rgb, a = im[..., :3], im[..., 3:]
    L, C, H = srgb_to_oklch(rgb)
    w, L2, C2 = rule(L, C, H)
    H2 = np.full_like(H, TARGET_H)
    out = oklch_to_srgb(L + (L2 - L) * w, C + (C2 - C) * w, H + (((H2 - H) + 180) % 360 - 180) * w)
    Image.fromarray((np.concatenate([out, a], axis=-1) * 255).round().astype(np.uint8), 'RGBA').save(path_out)
    print(path_out)


if __name__ == '__main__':
    for a, b, rule in JOBS:
        recolor(a, b, rule)
