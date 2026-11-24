import { useMemo } from 'react';
import { makeMutable, type SharedValue } from 'react-native-reanimated';

/**
 * Sprite engine — data side.
 *
 * Every animated layer of the scene is a flat struct-of-sprites array that lives on the UI
 * thread: [x, y, scale, rotation, frame, r, g, b, a] per sprite. "Systems" (one per layer) run
 * inside a frame callback and overwrite that array in place; the renderer (`SpriteLayer`) turns
 * it into the three Skia Atlas buffers. One layer = one draw call, whatever its sprite count, and
 * nothing is allocated per frame.
 */
export const STRIDE = 9;
export const X = 0;
export const Y = 1;
export const SCALE = 2;
export const ROT = 3;
export const FRAME = 4;
export const R = 5;
export const G = 6;
export const B = 7;
export const A = 8;

export type SpriteData = SharedValue<number[]>;

/** Allocates a layer's sprite array once (stable across renders). */
export function useSpriteData(capacity: number): SpriteData {
  return useMemo(() => makeMutable(new Array(capacity * STRIDE).fill(0)), [capacity]);
}

/** Writes one sprite. `scale` maps texture pixels → points. */
export function put(
  d: number[],
  i: number,
  x: number,
  y: number,
  scale: number,
  rot: number,
  frame: number,
  r: number,
  g: number,
  b: number,
  a: number,
) {
  'worklet';
  const o = i * STRIDE;
  d[o] = x;
  d[o + 1] = y;
  d[o + 2] = scale;
  d[o + 3] = rot;
  d[o + 4] = frame;
  d[o + 5] = r;
  d[o + 6] = g;
  d[o + 7] = b;
  d[o + 8] = a;
}

export function hide(d: number[], i: number) {
  'worklet';
  d[i * STRIDE + 8] = 0;
}

/** Hides sprites [from, to). */
export function hideRange(d: number[], from: number, to: number) {
  'worklet';
  for (let i = from; i < to; i++) d[i * STRIDE + 8] = 0;
}

/** Frame table: flat [x, y, w, h] per frame, in texture pixels. */
export type Frames = number[];

export class FrameBuilder {
  frames: Frames = [];
  add(x: number, y: number, w: number, h: number) {
    this.frames.push(x, y, w, h);
    return this.frames.length / 4 - 1;
  }
  /** `count` cells of a regular grid (row-major) starting at (x0, y0). Returns the first index. */
  grid(x0: number, y0: number, cw: number, ch: number, cols: number, count: number) {
    const first = this.frames.length / 4;
    for (let i = 0; i < count; i++) {
      this.add(x0 + (i % cols) * cw, y0 + Math.floor(i / cols) * ch, cw, ch);
    }
    return first;
  }
}
