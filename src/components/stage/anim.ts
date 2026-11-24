import type { SkFont } from '@shopify/react-native-skia';

/** Small worklet-safe animation helpers shared by the Skia layers. */

export function clamp01(v: number) {
  'worklet';
  return Math.min(1, Math.max(0, v));
}

/** Normalised progress of `v` through [a, b]. */
export function progress(v: number, a: number, b: number) {
  'worklet';
  return clamp01((v - a) / (b - a));
}

export function easeOutCubic(t: number) {
  'worklet';
  const u = 1 - t;
  return 1 - u * u * u;
}

export function easeInCubic(t: number) {
  'worklet';
  return t * t * t;
}

export function easeOutBack(t: number) {
  'worklet';
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

export function smoothstep(a: number, b: number, v: number) {
  'worklet';
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Deterministic 0..1 noise per (index, salt) — particles get stable "random" traits. */
export function hash(i: number, salt: number) {
  'worklet';
  const s = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Point on a cubic bezier. */
export function bezier(
  t: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
) {
  'worklet';
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * x0 + b * x1 + c * x2 + d * x3, y: a * y0 + b * y1 + c * y2 + d * y3 };
}

export type TextMetrics = {
  /** Horizontal offset from the pen position to the centre of the ink, per number 1..100. */
  inkCenter: number[];
  /** Baseline offset that vertically centres digits on a given y. */
  baselineOffset: number;
};

/** Pre-measure 1..100 once on the JS thread so worklets never call into font APIs. */
export function measureNumbers(font: SkFont): TextMetrics {
  const inkCenter: number[] = [];
  for (let n = 1; n <= 100; n++) {
    const m = font.measureText(String(n));
    inkCenter.push(m.x + m.width / 2);
  }
  const digit = font.measureText('0123456789');
  return { inkCenter, baselineOffset: -(digit.y + digit.height / 2) };
}

/** Letter-spaced glyph run (Skia Text has no tracking). */
export function trackedGlyphs(font: SkFont, text: string, tracking: number) {
  const ids = font.getGlyphIDs(text);
  const widths = font.getGlyphWidths(ids);
  let x = 0;
  const glyphs = ids.map((id, i) => {
    const g = { id, pos: { x, y: 0 } };
    x += widths[i] + tracking;
    return g;
  });
  const m = font.measureText(text);
  return { glyphs, width: x - tracking, baselineOffset: -(m.y + m.height / 2) };
}
