"""
Crops and resizes the image-model renders for the "Royal Treasure" skin into assets/art/lux:

    python3 scripts/art/process_lux.py <raw_dir>... --out assets/art/lux

Transparent art is trimmed to its alpha bounding box (plus a small margin) and fitted into the
target box; treasure symbols are centred on square canvases so every symbol shares one sprite
size in the board atlas. The background is re-encoded as JPEG.
"""

import argparse
import os

from PIL import Image

# name -> (max width, max height, square canvas?)
TARGETS = {
    "crown_lux": (440, 380, False),
    "ribbon_ruby": (900, 300, False),
    "star_gold": (200, 200, True),
    "t_coin": (160, 160, True),
    "t_bars": (160, 160, True),
    "t_emerald": (160, 160, True),
    "t_sapphire": (160, 160, True),
    "t_amethyst": (160, 160, True),
    "t_ruby": (160, 160, True),
    "t_crown": (160, 160, True),
    "t_diamond": (160, 160, True),
    "t_chest": (160, 160, True),
}
MARGIN = 0.03


def trim(im):
    bbox = im.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    return im.crop(bbox) if bbox else im


def fit(im, w, h, square):
    im = trim(im)
    inner_w, inner_h = w * (1 - 2 * MARGIN), h * (1 - 2 * MARGIN)
    s = min(inner_w / im.width, inner_h / im.height)
    im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)
    if not square:
        canvas = Image.new("RGBA", (round(im.width / (1 - 2 * MARGIN)), round(im.height / (1 - 2 * MARGIN))), (0, 0, 0, 0))
    else:
        canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    canvas.alpha_composite(im, ((canvas.width - im.width) // 2, (canvas.height - im.height) // 2))
    return canvas


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("raw", nargs="+")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    for d in args.raw:
        for f in sorted(os.listdir(d)):
            name, ext = os.path.splitext(f)
            src = os.path.join(d, f)
            if name == "bg_lux":
                Image.open(src).convert("RGB").resize((1024, 1536), Image.LANCZOS).save(
                    os.path.join(args.out, "bg_lux.jpg"), quality=86, optimize=True
                )
                print("bg_lux.jpg")
            elif name in TARGETS and ext.lower() == ".png":
                w, h, square = TARGETS[name]
                out = fit(Image.open(src).convert("RGBA"), w, h, square)
                out.save(os.path.join(args.out, name + ".png"), optimize=True)
                print(f"{name}.png {out.size}")


if __name__ == "__main__":
    main()
