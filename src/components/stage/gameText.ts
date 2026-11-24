import {
  BlurStyle,
  PaintStyle,
  PathOp,
  Skia,
  StrokeJoin,
  TileMode,
  type SkCanvas,
  type SkFont,
  type SkPath,
} from '@shopify/react-native-skia';

/**
 * Arcade display lettering, matched to the reference art (zoomed and read layer by layer):
 *
 *   - type: a heavy geometric grotesque (Montserrat Black / Black Italic): flat terminals, closed
 *     "4", flagged "1" — not a rounded bubble face;
 *   - a *coloured extrusion*: the letter is a 3D block whose side shows below and slightly right
 *     of the face (burnt orange under gold, indigo under chrome), ~0.08 em deep;
 *   - a thin dark outline wrapping face + side together (~0.04 em visible), never a fat sticker
 *     stroke;
 *   - the face: gold runs pale lemon → gold → amber top to bottom; chrome is white on top with a
 *     hard horizon break to a cool lavender-blue reflection just under mid-height;
 *   - a crisp inner bevel (bright top-edge sliver, shaded bottom-edge sliver) and a soft shadow.
 *
 * Every layer is derived from one glyph outline path, sized in em, so the same recipe works from
 * a 12 pt board number to the 200 px result plate. The bevel slivers are boolean path
 * differences (glyph − glyph shifted), not blurs: crisp at any scale. All of it is baked once into
 * Pictures / atlas textures — never per frame.
 *
 * `base` / `face` split the layers so several glyphs can be composed (result-plate digits): draw
 * every base first, then every face, and neighbouring outlines merge instead of overlapping a face.
 */
export type GameTextStyle = {
  /** Face gradient, top of the caps → baseline. */
  fill: readonly string[];
  stops: readonly number[];
  outline: string;
  /** Extruded side: colour at the face edge → at the far edge. */
  side: readonly [string, string];
  /** Inner bevel: top-edge light / bottom-edge shade. */
  hi: string;
  lo: string;
  shadow: string;
};

export const TEXT_STYLE = {
  /** Polished gold: pale-lemon top, gold body, amber base; burnt-orange side, chocolate outline. */
  gold: {
    fill: ['#FFFDE4', '#FFF3A2', '#FFE064', '#FFC93A', '#F5A51C', '#E88A12'],
    stops: [0, 0.22, 0.45, 0.62, 0.85, 1],
    outline: '#3E1500',
    side: ['#E3901E', '#9A4A08'],
    hi: 'rgba(255,255,240,0.95)',
    lo: 'rgba(196,96,6,0.55)',
    shadow: 'rgba(20,0,30,0.55)',
  },
  /** Chrome: white top, hard horizon break, lavender-blue reflection; indigo side, midnight outline. */
  ice: {
    fill: ['#FFFFFF', '#FFFFFF', '#EEF2FF', '#BACBEE', '#D2DEFA', '#AFC2F0'],
    stops: [0, 0.3, 0.5, 0.53, 0.78, 1],
    outline: '#0C0A36',
    side: ['#3A3C9A', '#17165A'],
    hi: 'rgba(255,255,255,0.95)',
    lo: 'rgba(70,84,170,0.45)',
    shadow: 'rgba(4,2,22,0.55)',
  },
} as const satisfies Record<string, GameTextStyle>;

export type TextFx = {
  /** Letter spacing in em. */
  tracking?: number;
  /** Italic lean (canvas skew, negative = leans right). Pivot is mid-cap, so centring holds. */
  skew?: number;
  /** Outline weight multiplier. */
  weight?: number;
  /** Extrusion depth multiplier (0 = flat). */
  depth?: number;
  /** Drop-shadow multiplier (0 = none). */
  shadow?: number;
  part?: 'all' | 'base' | 'face';
};

/** Cap height of the digits/capitals, in px (font units of `font`). */
export function capHeight(font: SkFont) {
  return font.measureText('0123456789HE').height;
}

/** Advance width of `text` with tracking (em), matching what `drawGameText` lays out. */
export function trackedWidth(font: SkFont, text: string, tracking = 0) {
  const ids = font.getGlyphIDs(text);
  const w = font.getGlyphWidths(ids);
  return w.reduce((a, b) => a + b, 0) + tracking * font.getSize() * Math.max(0, ids.length - 1);
}

/** Glyph outlines of `text` with its baseline at y = 0 and pen starting at x = 0. */
export function glyphPath(font: SkFont, text: string, tracking = 0): SkPath {
  if (!tracking) return Skia.Path.MakeFromText(text, 0, 0, font) ?? Skia.Path.Make();
  const b = Skia.PathBuilder.Make();
  const chars = Array.from(text);
  const widths = font.getGlyphWidths(font.getGlyphIDs(text));
  let x = 0;
  chars.forEach((c, i) => {
    const p = Skia.Path.MakeFromText(c, x, 0, font);
    if (p) b.addPath(p);
    x += (widths[i] ?? 0) + tracking * font.getSize();
  });
  return b.build();
}

function shifted(path: SkPath, dx: number, dy: number) {
  return Skia.PathBuilder.Make().addPath(path, Skia.Matrix().translate(dx, dy)).build();
}

function paint(color: string) {
  const p = Skia.Paint();
  p.setAntiAlias(true);
  p.setColor(Skia.Color(color));
  return p;
}

function stroke(color: string, width: number) {
  const p = paint(color);
  p.setStyle(PaintStyle.Stroke);
  p.setStrokeWidth(width);
  p.setStrokeJoin(StrokeJoin.Round);
  return p;
}

/**
 * Draws `text` with its pen at (x, baseline). Returns the advance width (tracked).
 */
export function drawGameText(
  canvas: SkCanvas,
  text: string,
  x: number,
  baseline: number,
  font: SkFont,
  style: GameTextStyle,
  fx: TextFx = {},
) {
  const { tracking = 0, skew = 0, weight = 1, depth = 1, shadow = 1, part = 'all' } = fx;
  const em = font.getSize();
  const cap = capHeight(font);
  const path = glyphPath(font, text, tracking);
  const ow = em * 0.08 * weight;
  const dz = em * 0.085 * depth;
  const dx = dz * 0.28;

  canvas.save();
  // italic lean pivots on the middle of the caps, so a centred word stays centred
  canvas.translate(x, baseline - cap / 2);
  if (skew) canvas.skew(skew, 0);
  canvas.translate(0, cap / 2);

  if (part !== 'face') {
    // the block: face copies stepped down-right to the extrusion depth
    const steps = dz > 0 ? Math.max(2, Math.ceil(dz / 1.2)) : 0;
    const block = Skia.PathBuilder.Make().addPath(path);
    for (let k = 1; k <= steps; k++) block.addPath(path, Skia.Matrix().translate((dx * k) / steps, (dz * k) / steps));
    const solid = block.build();
    if (shadow > 0) {
      const sp = paint(style.shadow);
      sp.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, em * 0.03 * shadow, true));
      canvas.drawPath(shifted(solid, dx * 0.5, em * 0.06 * shadow), sp);
          }
    // one outline around face + side together
    canvas.drawPath(solid, stroke(style.outline, ow * 1.1));
    if (steps > 0) {
      const sideP = Skia.Paint();
      sideP.setAntiAlias(true);
      sideP.setShader(
        Skia.Shader.MakeLinearGradient(
          { x: 0, y: -cap * 0.2 },
          { x: 0, y: dz },
          style.side.map((c) => Skia.Color(c)),
          [0, 1],
          TileMode.Clamp,
        ),
      );
      canvas.drawPath(solid, sideP);
    }
    // the face's own edge: a hairline that separates it from its side
    canvas.drawPath(path, stroke(style.outline, ow * 0.5));
  }

  if (part !== 'base') {
    const face = Skia.Paint();
    face.setAntiAlias(true);
    face.setShader(
      Skia.Shader.MakeLinearGradient(
        { x: 0, y: -cap },
        { x: 0, y: 0 },
        style.fill.map((c) => Skia.Color(c)),
        [...style.stops],
        TileMode.Clamp,
      ),
    );
    canvas.drawPath(path, face);
    const b = Math.max(1, em * 0.04);
    const hi = Skia.Path.MakeFromOp(path, shifted(path, 0, b), PathOp.Difference);
    if (hi) canvas.drawPath(hi, paint(style.hi));
    const lo = Skia.Path.MakeFromOp(path, shifted(path, 0, -b * 0.9), PathOp.Difference);
    if (lo) canvas.drawPath(lo, paint(style.lo));
  }
  canvas.restore();
  return trackedWidth(font, text, tracking);
}

/** Space the effects need around the caps box, in em (for atlas cells). */
export const TEXT_PAD = { top: 0.12, bottom: 0.3, side: 0.2 } as const;
