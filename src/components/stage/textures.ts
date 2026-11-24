import {
  BlurStyle,
  FilterMode,
  MipmapMode,
  PaintStyle,
  Skia,
  TileMode,
  createPicture,
  type SkCanvas,
  type SkFont,
  type SkImage,
  type SkPicture,
} from '@shopify/react-native-skia';

import { FrameBuilder, type Frames } from '../../engine/sprites/layer';
import type { StageLayout } from '../../theme/layout';
import type { SkinTone } from '../../theme/tokens';
import { TEXT_PAD, TEXT_STYLE, capHeight, drawGameText, type GameTextStyle, type TextFx } from './gameText';

/**
 * Texture atlases, recorded once as Skia Pictures on the JS thread and rasterised to GPU
 * textures on the UI thread (`usePictureAsTexture`). Every sprite the game animates lives in one
 * of three atlases, so each animated layer is a single Atlas draw call.
 */
export type Atlas = {
  picture: SkPicture;
  size: { width: number; height: number };
  frames: Frames;
};

const white = Skia.Color('#FFFFFF');

function fillPaint(color = white) {
  const p = Skia.Paint();
  p.setAntiAlias(true);
  p.setColor(color);
  return p;
}

function blurPaint(sigma: number, color = white) {
  const p = fillPaint(color);
  p.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, sigma, true));
  return p;
}

function radialPaint(cx: number, cy: number, r: number, colors: string[], pos: number[]) {
  const p = fillPaint();
  p.setShader(
    Skia.Shader.MakeRadialGradient(
      { x: cx, y: cy },
      r,
      colors.map((c) => Skia.Color(c)),
      pos,
      TileMode.Clamp,
    ),
  );
  return p;
}

/** Atlas cell for the numbers 1..100 drawn with `drawGameText` (room for every effect). */
function numberCell(font: SkFont, skew = 0) {
  const em = font.getSize();
  const cap = capHeight(font);
  let w = 0;
  for (let n = 1; n <= 100; n++) w = Math.max(w, font.measureText(String(n)).width);
  return {
    cw: Math.ceil(w + 2 * TEXT_PAD.side * em + Math.abs(skew) * cap),
    ch: Math.ceil(cap + 2 * TEXT_PAD.bottom * em),
  };
}

/**
 * Numbers 1..100 into a grid of cells, each centred on its cell (ink centre x, mid-cap y) in the
 * arcade sticker style (see gameText.ts). The ice set is tinted at draw time with `modulate`
 * (dimmed on turning wheel plates, cooled for repeats); the gold set is drawn untinted, because a
 * multiplied tint can only darken — it can never add the white-hot top or the orange base.
 */
function drawNumberGrid(
  canvas: SkCanvas,
  font: SkFont,
  x0: number,
  y0: number,
  cw: number,
  ch: number,
  style: GameTextStyle,
  fx: TextFx,
) {
  const cap = capHeight(font);
  for (let n = 1; n <= 100; n++) {
    const i = n - 1;
    const cx = x0 + (i % 10) * cw + cw / 2;
    const cy = y0 + Math.floor(i / 10) * ch + ch / 2;
    const text = String(n);
    const m = font.measureText(text);
    drawGameText(canvas, text, cx - (m.x + m.width / 2), cy + cap / 2, font, style, fx);
  }
}

// ───────────────────────── board ─────────────────────────

export const TILE = 128;
export const HALO = 176;
/** Treasure symbols are packed as squares of this many texture px. */
export const TREASURE_PX = 160;
/** Board atlas frame indices. */
export const BF = {
  idle: 0,
  gold: 1,
  flip0: 2, // 24 frames: sapphire vault lid → open gold setting
  halo: 26,
  edge: 27,
  shine: 28,
  glyph0: 29, // + (n - 1)
  treasure0: 129, // + treasure index (game/treasure.ts)
  chest0: 138, // + 16 frames: the Blender treasure chest opening
  glyphGold0: 154, // + (n - 1): gold numbers for claimed tiles
} as const;
export const FLIP_FRAMES = 24;
export const CHEST_FRAMES = 16;
/** Source cell size of assets/sprites/chest_open_sheet.png (4×4 grid). */
const CHEST_SRC = 256;

export type BoardAtlas = Atlas & { glyphScale: number };

export function buildBoardAtlas(
  img: { idle: SkImage; gold: SkImage; flip: SkImage; treasures: SkImage[]; chest: SkImage },
  font: SkFont,
  dpr: number,
  /** Key width ÷ height (layout.cellW / layout.cell): keys and their lights are baked this wide. */
  aspect = 1,
): BoardAtlas {
  const fb = new FrameBuilder();
  const TW = Math.round(TILE * aspect);
  const HW = HALO + (TW - TILE);
  // tiles: 2 singles + the 6×4 flip sheet below them
  fb.add(0, 0, TW, TILE);
  fb.add(TW, 0, TW, TILE);
  fb.grid(0, TILE, TW, TILE, 6, FLIP_FRAMES);
  // glows (right of the tiles)
  const gx = 6 * TW + 8;
  fb.add(gx, 0, HW, HALO); // halo
  fb.add(gx, HALO + 8, HW, HALO); // edge light
  fb.add(gx, (HALO + 8) * 2, 96, 96); // shine
  // glyphs
  const { cw, ch } = numberCell(font);
  const gy = 5 * TILE + 16;
  fb.grid(0, gy, cw, ch, 10, 100);
  // treasure symbols: one row under the glyphs
  const ty = gy + ch * 10 + 8;
  fb.grid(0, ty, TREASURE_PX, TREASURE_PX, img.treasures.length, img.treasures.length);
  // chest opening: two rows of 8 under the treasures
  const cy0 = ty + TREASURE_PX;
  fb.grid(0, cy0, TREASURE_PX, TREASURE_PX, 8, CHEST_FRAMES);
  // gold numbers: under the chest frames
  const gyGold = cy0 + TREASURE_PX * 2 + 8;
  fb.grid(0, gyGold, cw, ch, 10, 100);
  const width = Math.max(gx + HW + 4, cw * 10, TREASURE_PX * img.treasures.length, TREASURE_PX * 8);
  const height = gyGold + ch * 10;

  const picture = createPicture(
    (canvas) => {
      const p = fillPaint();
      const src = (im: SkImage) => Skia.XYWHRect(0, 0, im.width(), im.height());
      img.treasures.forEach((t, i) => {
        canvas.drawImageRectOptions(
          t,
          src(t),
          Skia.XYWHRect(i * TREASURE_PX, ty, TREASURE_PX, TREASURE_PX),
          FilterMode.Linear,
          MipmapMode.None,
          p,
        );
      });
      for (let k = 0; k < CHEST_FRAMES; k++) {
        canvas.drawImageRectOptions(
          img.chest,
          Skia.XYWHRect((k % 4) * CHEST_SRC, Math.floor(k / 4) * CHEST_SRC, CHEST_SRC, CHEST_SRC),
          Skia.XYWHRect((k % 8) * TREASURE_PX, cy0 + Math.floor(k / 8) * TREASURE_PX, TREASURE_PX, TREASURE_PX),
          FilterMode.Linear,
          MipmapMode.None,
          p,
        );
      }
      canvas.drawImageRectOptions(
        img.idle,
        src(img.idle),
        Skia.XYWHRect(0, 0, TW, TILE),
        FilterMode.Linear,
        MipmapMode.None,
        p,
      );
      canvas.drawImageRectOptions(
        img.gold,
        src(img.gold),
        Skia.XYWHRect(TW, 0, TW, TILE),
        FilterMode.Linear,
        MipmapMode.None,
        p,
      );
      canvas.drawImageRectOptions(
        img.flip,
        src(img.flip),
        Skia.XYWHRect(0, TILE, 6 * TW, 4 * TILE),
        FilterMode.Linear,
        MipmapMode.None,
        p,
      );

      // halo: soft light spilling around a tile-sized rounded square
      const k = 118;
      const o = (HALO - k) / 2;
      canvas.drawRRect(Skia.RRectXY(Skia.XYWHRect(gx + o, o, k + TW - TILE, k), 22, 22), blurPaint(11));
      // edge light: a bright rim that hugs the tile border
      const edge = blurPaint(3.2);
      edge.setStyle(PaintStyle.Stroke);
      edge.setStrokeWidth(7);
      canvas.drawRRect(Skia.RRectXY(Skia.XYWHRect(gx + o + 2, HALO + 8 + o + 2, k - 4 + TW - TILE, k - 4), 18, 18), edge);
      // shine: radial highlight
      const sy = (HALO + 8) * 2;
      canvas.drawCircle(
        gx + 48,
        sy + 48,
        48,
        radialPaint(gx + 48, sy + 48, 48, ['#FFFFFF', 'rgba(255,255,255,0.35)', 'rgba(255,255,255,0)'], [0, 0.35, 1]),
      );

      const small: TextFx = { weight: 0.85, depth: 0.5, shadow: 0.6 };
      drawNumberGrid(canvas, font, 0, gy, cw, ch, TEXT_STYLE.ice, small);
      drawNumberGrid(canvas, font, 0, gyGold, cw, ch, TEXT_STYLE.gold, small);
    },
    Skia.XYWHRect(0, 0, width, height),
  );
  return { picture, size: { width, height }, frames: fb.frames, glyphScale: 1 / dpr };
}

// ───────────────────────── wheel ─────────────────────────

/** Wheel atlas frame indices. */
export const RF = {
  segment: 0,
  bulb: 1,
  glyph0: 2,
  /**
   * Out-of-focus copies for the wheel's depth of field, two levels (slightly / fully out of focus).
   * Same centres as the sharp frames, but stored at 1/BLUR_DOWN resolution (a blurred image has no
   * detail to lose): draw them at BLUR_DOWN × the sharp scale.
   */
  segmentBlur: 102,
  glyphBlur0: 103,
  /** Gold numbers: the result resting under the pointer, and the number in flight. */
  glyphGold0: 203,
  segmentBlur2: 303,
  glyphBlur2_0: 304,
} as const;

/** Downscale of the out-of-focus wheel frames (see RF). */
export const BLUR_DOWN = 2;
/** Blur of the two out-of-focus levels, in pt: plates, and glyphs per pt of font size. */
const SEG_SIGMA = [1.6, 4.6] as const;
const GLYPH_SIGMA = [0.035, 0.1] as const;

export type ReelAtlas = Atlas & {
  /** texture px → pt */
  scale: number;
  /** Cap height of a glyph, in texture px. */
  capPx: number;
};

/** Annular sector of the wheel band, in local coordinates where the number centre is (0,0). */
export function sectorPath(Rn: number, band: number, half: number, inset: number) {
  const ro = Rn + band / 2 - inset;
  const ri = Rn - band / 2 + inset;
  const a0 = -half + inset / Rn;
  const a1 = half - inset / Rn;
  const b = Skia.PathBuilder.Make();
  const steps = 10;
  for (let k = 0; k <= steps; k++) {
    const a = a0 + ((a1 - a0) * k) / steps;
    const x = ro * Math.sin(a);
    const y = Rn - ro * Math.cos(a);
    if (k === 0) b.moveTo(x, y);
    else b.lineTo(x, y);
  }
  for (let k = steps; k >= 0; k--) {
    const a = a0 + ((a1 - a0) * k) / steps;
    b.lineTo(ri * Math.sin(a), Rn - ri * Math.cos(a));
  }
  b.close();
  return b.build();
}

export function buildReelAtlas(layout: StageLayout, font: SkFont, dpr: number, tone: SkinTone): ReelAtlas {
  const { numberRadius: Rn, band, slotAngle } = layout.arc;
  const half = slotAngle / 2;
  const ro = Rn + band / 2;
  const segW = Math.ceil((2 * ro * Math.sin(half) + 6) * dpr);
  const sag = Rn - (Rn - band / 2) * Math.cos(half) - band / 2;
  const segH = Math.ceil((band + 2 * sag + 6) * dpr);
  const D = BLUR_DOWN;
  // out-of-focus frames: padded for their soft edge (3 sigma of the stronger level) on every side,
  // then stored at 1/D resolution
  const pad = Math.ceil(SEG_SIGMA[1] * 3 * dpr);
  const segWB = Math.ceil((segW + pad * 2) / D);
  const segHB = Math.ceil((segH + pad * 2) / D);
  const fb = new FrameBuilder();
  fb.add(0, 0, segW, segH);
  fb.add(segW + 8, 0, 48, 48);
  const size = font.getSize();
  const { cw, ch } = numberCell(font);
  const gPad = Math.ceil(size * GLYPH_SIGMA[1] * 3);
  const cwB = Math.ceil((cw + gPad * 2) / D);
  const chB = Math.ceil((ch + gPad * 2) / D);
  const gy = Math.max(segH, segHB) + 8;
  fb.grid(0, gy, cw, ch, 10, 100);
  const bx0 = segW + 64;
  const bx1 = bx0 + segWB + 8;
  fb.add(bx0, 0, segWB, segHB);
  const gyG = gy + ch * 10 + 8;
  const gyB = gyG + ch * 10 + 8;
  const gxB2 = cwB * 10 + 8;
  fb.grid(0, gyB, cwB, chB, 10, 100);
  fb.grid(0, gyG, cw, ch, 10, 100);
  fb.add(bx1, 0, segWB, segHB);
  fb.grid(gxB2, gyB, cwB, chB, 10, 100);
  const width = Math.max(cw * 10, bx1 + segWB, gxB2 + cwB * 10);
  const height = gyB + chB * 10;

  const picture = createPicture(
    (canvas) => {
      // segment plate: the skin's lacquer, lighter towards the rim, gold-lit edges
      const drawPlate = () => {
        const sector = sectorPath(Rn, band, half, 1.2);
        const body = fillPaint();
        body.setShader(
          Skia.Shader.MakeLinearGradient(
            { x: 0, y: -band / 2 },
            { x: 0, y: band / 2 + sag },
            tone.plate.map((c) => Skia.Color(c)),
            [0, 0.18, 0.62, 1],
            TileMode.Clamp,
          ),
        );
        canvas.drawPath(sector, body);
        // glass highlight on the upper third
        const gloss = fillPaint();
        gloss.setShader(
          Skia.Shader.MakeLinearGradient(
            { x: 0, y: -band / 2 },
            { x: 0, y: 0 },
            [Skia.Color('rgba(255,255,255,0.28)'), Skia.Color('rgba(255,255,255,0)')],
            [0, 1],
            TileMode.Clamp,
          ),
        );
        canvas.drawPath(sector, gloss);
        // seams: one dark groove between plates (the rims cover top and bottom), then a hairline
        // of light on the bevel inside it — not a gold bar per plate edge, which doubled up
        const rim = fillPaint(Skia.Color('rgba(8,4,26,0.72)'));
        rim.setStyle(PaintStyle.Stroke);
        rim.setStrokeWidth(2);
        canvas.drawPath(sector, rim);
        const inner = fillPaint(Skia.Color(tone.plateEdge));
        inner.setStyle(PaintStyle.Stroke);
        inner.setStrokeWidth(0.8);
        canvas.drawPath(sectorPath(Rn, band, half, 3.4), inner);
      };
      canvas.save();
      canvas.translate(segW / 2, segH / 2);
      canvas.scale(dpr, dpr);
      drawPlate();
      canvas.restore();
      // …and its two out-of-focus twins, baked once at 1/D resolution (no blur layer at runtime).
      // The blur is applied in the layer's own (1/D) space, so sigma is scaled to match.
      const lens = (sigma: number, draw: () => void) => {
        const lp = Skia.Paint();
        lp.setImageFilter(Skia.ImageFilter.MakeBlur(sigma, sigma, TileMode.Decal, null));
        canvas.saveLayer(lp);
        draw();
        canvas.restore();
      };
      [bx0, bx1].forEach((bx, level) =>
        lens((SEG_SIGMA[level] * dpr) / D, () => {
          canvas.save();
          canvas.translate(bx + segWB / 2, segHB / 2);
          canvas.scale(dpr / D, dpr / D);
          drawPlate();
          canvas.restore();
        }),
      );

      // bulb
      const bx = segW + 8 + 24;
      canvas.drawCircle(
        bx,
        24,
        24,
        radialPaint(bx, 24, 24, ['#FFFFFF', 'rgba(255,255,255,0.55)', 'rgba(255,255,255,0)'], [0, 0.28, 1]),
      );

      drawNumberGrid(canvas, font, 0, gy, cw, ch, TEXT_STYLE.ice, {});
      drawNumberGrid(canvas, font, 0, gyG, cw, ch, TEXT_STYLE.gold, {});
      [0, gxB2].forEach((gx, level) =>
        lens((size * GLYPH_SIGMA[level]) / D, () => {
          canvas.save();
          canvas.translate(gx, gyB);
          canvas.scale(1 / D, 1 / D);
          drawNumberGrid(canvas, font, 0, 0, cwB * D, chB * D, TEXT_STYLE.ice, {});
          canvas.restore();
        }),
      );
    },
    Skia.XYWHRect(0, 0, width, height),
  );
  return { picture, size: { width, height }, frames: fb.frames, scale: 1 / dpr, capPx: capHeight(font) };
}

// ───────────────────────── particles ─────────────────────────

/** Particle atlas frame indices. */
export const COIN_FRAMES = 16;
export const BURST_FRAMES = 16;
export const GLINT_FRAMES = 16;
const BURST_CELL = 192;
export const PILLAR_FRAMES = 12;
/** Loot-beam cell (px) and where the beam's base sits in it (px from the cell centre, down). */
export const PILLAR_W = 96;
export const PILLAR_H = 384;
export const PILLAR_BASE = 150;
export const PF = {
  spark: 0,
  star: 1,
  dot: 2,
  ring: 3,
  plusOne: 4,
  confetti: 5,
  coin0: 6,
  // Blender light effects (additive only: they sit on black)
  burst0: 6 + COIN_FRAMES,
  glint0: 6 + COIN_FRAMES + BURST_FRAMES,
  flare: 6 + COIN_FRAMES + BURST_FRAMES + GLINT_FRAMES,
  ember: 7 + COIN_FRAMES + BURST_FRAMES + GLINT_FRAMES,
  /** Loot beam (Blender): 12 tintable haze frames, then 12 white-core frames, 96 × 384 px. */
  pillar0: 8 + COIN_FRAMES + BURST_FRAMES + GLINT_FRAMES,
  pillarCore0: 8 + COIN_FRAMES + BURST_FRAMES + GLINT_FRAMES + PILLAR_FRAMES,
  /** Cell size of the burst flipbook in the atlas (px). */
  burstPx: BURST_CELL,
} as const;

export type VfxImages = { burst: SkImage; glint: SkImage; spark: SkImage; ember: SkImage; pillar: SkImage };

const blit = (canvas: SkCanvas, img: SkImage, x: number, y: number, w: number, h: number) =>
  canvas.drawImageRectOptions(
    img,
    Skia.XYWHRect(0, 0, img.width(), img.height()),
    Skia.XYWHRect(x, y, w, h),
    FilterMode.Linear,
    MipmapMode.None,
    null,
  );

export function buildFxAtlas(coinSheet: SkImage, font: SkFont, vfx: VfxImages): Atlas {
  const fb = new FrameBuilder();
  fb.add(0, 0, 96, 24); // spark
  fb.add(100, 0, 96, 96); // star
  fb.add(200, 0, 64, 64); // dot
  fb.add(268, 0, 128, 128); // ring
  fb.add(400, 0, 170, 110); // +1
  fb.add(574, 0, 24, 14); // confetti
  fb.grid(0, 132, 128, 128, 4, COIN_FRAMES);
  // Blender light effects, right of and below the procedural sprites
  fb.grid(640, 0, BURST_CELL, BURST_CELL, 4, BURST_FRAMES);
  fb.grid(0, 648, 128, 128, 4, GLINT_FRAMES);
  fb.add(640, 772, 128, 32); // flare
  fb.add(772, 772, 64, 64); // ember
  fb.grid(0, 1164, PILLAR_W, PILLAR_H, PILLAR_FRAMES, PILLAR_FRAMES * 2); // loot beam: haze row, core row
  const width = Math.max(640 + 4 * BURST_CELL, PILLAR_W * PILLAR_FRAMES);
  const height = 1164 + 2 * PILLAR_H;

  const picture = createPicture(
    (canvas) => {
      // spark: an elongated hot streak
      canvas.save();
      canvas.translate(48, 12);
      canvas.scale(1, 0.25);
      canvas.drawCircle(
        0,
        0,
        48,
        radialPaint(0, 0, 48, ['#FFFFFF', 'rgba(255,255,255,0.6)', 'rgba(255,255,255,0)'], [0, 0.25, 1]),
      );
      canvas.restore();
      // star: four-point glint
      const sb = Skia.PathBuilder.Make();
      const cx = 148;
      const cy = 48;
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4 - Math.PI / 2;
        const r = k % 2 === 0 ? 46 : 9;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (k === 0) sb.moveTo(x, y);
        else sb.lineTo(x, y);
      }
      sb.close();
      canvas.drawPath(
        sb.build(),
        radialPaint(cx, cy, 46, ['#FFFFFF', 'rgba(255,255,255,0.7)', 'rgba(255,255,255,0.1)'], [0, 0.3, 1]),
      );
      canvas.drawCircle(cx, cy, 14, radialPaint(cx, cy, 14, ['#FFFFFF', 'rgba(255,255,255,0)'], [0, 1]));
      // dot
      canvas.drawCircle(
        232,
        32,
        32,
        radialPaint(232, 32, 32, ['#FFFFFF', 'rgba(255,255,255,0.45)', 'rgba(255,255,255,0)'], [0, 0.3, 1]),
      );
      // ring
      const ring = blurPaint(2.4);
      ring.setStyle(PaintStyle.Stroke);
      ring.setStrokeWidth(6);
      canvas.drawCircle(332, 64, 54, ring);
      // +1
      const label = '+1';
      const m = font.measureText(label);
      drawGameText(canvas, label, 485 - (m.x + m.width / 2), 55 + capHeight(font) / 2 - 8, font, TEXT_STYLE.gold, {
        skew: -0.06,
      });
      // confetti chip
      canvas.drawRRect(Skia.RRectXY(Skia.XYWHRect(574, 0, 24, 14), 3, 3), fillPaint());
      // coins (Blender)
      blit(canvas, coinSheet, 0, 132, 512, 512);
      // light effects (Blender)
      blit(canvas, vfx.burst, 640, 0, 4 * BURST_CELL, 4 * BURST_CELL);
      blit(canvas, vfx.glint, 0, 648, 512, 512);
      blit(canvas, vfx.spark, 640, 772, 128, 32);
      blit(canvas, vfx.ember, 772, 772, 64, 64);
      blit(canvas, vfx.pillar, 0, 1164, PILLAR_W * PILLAR_FRAMES, 2 * PILLAR_H);
    },
    Skia.XYWHRect(0, 0, width, height),
  );
  return { picture, size: { width, height }, frames: fb.frames };
}
