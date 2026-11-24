import { Group, Path, RadialGradient, Skia, vec, type SkImage } from '@shopify/react-native-skia';
import { memo, useMemo } from 'react';
import { useDerivedValue, useFrameCallback, type SharedValue } from 'react-native-reanimated';

import { hideRange, put, useSpriteData } from '../../engine/sprites/layer';
import { SpriteLayer } from '../../engine/sprites/SpriteLayer';
import type { SpinEngine } from '../../engine/useSpinEngine';
import { ResultKindCode, Reveal } from '../../engine/timeline';
import { CHEST, TREASURE_TIER, TREASURE_TINT, TREASURES } from '../../game/treasure';
import { cellCenter, type StageLayout } from '../../theme/layout';
import { easeOutCubic, progress } from './anim';
import { BF, CHEST_FRAMES, TREASURE_PX, type BoardAtlas } from './textures';

/** The lid is half-way through its flip: the treasure starts to rise out of the setting. */
export const REVEAL_AT = Reveal.HitStopEnd + 210;
const RISE = 190;
/** Drops back into the setting under gravity (ease-in), then lands with a squash-and-settle. */
const FALL = 230;
const LAND = 220;
/** Per tier (common → legendary): how big the treasure is presented, and for how long. */
const PEAK = [1.7, 2.1, 2.7, 3.3];
const HOLD = [60, 180, 360, 620];

/** Ray gradient per treasure: white-hot core fading into the treasure's light (built once). */
const RAY_COLORS = TREASURES.map(({ tint }) => {
  const [r, g, b] = tint.map((v) => Math.round(255 * v));
  return ['rgba(255,250,230,0.95)', `rgba(${r},${g},${b},0.55)`, `rgba(${r},${g},${b},0)`];
});

/** Timing of a treasure's reveal, relative to REVEAL_AT. */
export function revealPeak(treasure: number) {
  'worklet';
  const tier = TREASURE_TIER[treasure] ?? 0;
  const fallAt = RISE + HOLD[tier];
  return { tier, peak: PEAK[tier], hold: HOLD[tier], fallAt, landAt: fallAt + FALL, end: fallAt + FALL + LAND };
}

type Props = {
  layout: StageLayout;
  sv: SpinEngine['sv'];
  atlas: BoardAtlas;
  texture: SharedValue<SkImage | null>;
};

/** Starburst of `n` tapered rays around (0,0), radius 1. */
function raysPath(n: number) {
  const b = Skia.PathBuilder.Make();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const w = (Math.PI / n) * 0.36;
    b.moveTo(0, 0);
    b.lineTo(Math.cos(a - w), Math.sin(a - w));
    b.lineTo(Math.cos(a + w), Math.sin(a + w));
    b.close();
  }
  return b.build();
}

/**
 * The hero beat of a claim: the lid has flipped open and the hidden treasure rises out of its
 * gold setting toward the player — presented big for a moment (bigger and longer for rarer
 * treasures, with light rays behind epic and legendary finds), wobbling as it turns to the
 * light — then drops back and is seated in the cell, where the board's own layer takes over.
 * Drawn above the whole scene so the treasure can rise over the neighbouring keys.
 */
export const TreasureReveal = memo(function TreasureReveal({ layout, sv, atlas, texture }: Props) {
  const glows = useSpriteData(3);
  const hero = useSpriteData(1);
  const { cell } = layout;
  const gemS = (cell * 0.7) / TREASURE_PX;
  /** BF.shine is a 96 px round glow. */
  const glowS = cell / 96;
  const rays = useMemo(() => raysPath(16), []);

  useFrameCallback(() => {
    'worklet';
    const r = sv.reveal.value;
    const idx = sv.winIdx.value;
    const kind = sv.kind.value;
    glows.modify((gd) => {
      'worklet';
      hero.modify((d) => {
        'worklet';
        if (idx < 0 || kind === ResultKindCode.Repeat || r < REVEAL_AT) {
          hideRange(d, 0, 1);
          hideRange(gd, 0, 3);
          return d;
        }
        const tIdx = sv.treasure.value[idx];
        const p = revealPeak(tIdx);
        const t = r - REVEAL_AT;
        if (t >= p.end) {
          hideRange(d, 0, 1);
          hideRange(gd, 0, 3);
          return d;
        }
        const c = cellCenter(layout, idx);
        const reduce = sv.reduceMotion.value;
        const lift = cell * (0.45 + 0.3 * p.tier);
        let s = 1;
        let y = c.y;
        let rot = 0;
        let bounce = 1; // landing pop (Atlas sprites scale uniformly)
        if (reduce) {
          s = 1;
        } else if (t < RISE) {
          // out of the setting toward the player, fast then easing into the hold
          const e = easeOutCubic(t / RISE);
          s = 0.35 + (p.peak - 0.35) * e;
          y = c.y - lift * e;
        } else if (t < p.fallAt) {
          // presented: a slow breath while it turns to the light
          s = p.peak * (1 + 0.035 * Math.sin((t - RISE) / 60));
          y = c.y - lift;
        } else if (t < p.landAt) {
          // seated: gravity pulls it back into the setting (ease-in, so it lands with weight)
          const u = (t - p.fallAt) / FALL;
          const e = u * u * u;
          s = p.peak + (1 - p.peak) * e;
          y = c.y - lift * (1 - e);
        } else {
          // landing: a quick damped bounce on the cell
          const u = (t - p.landAt) / 1000;
          bounce = 1 + 0.16 * Math.exp(-u * 18) * Math.cos(u * 40);
        }
        if (!reduce && t < p.landAt) rot = 0.32 * Math.sin(t / 48) * Math.exp(-t / 260);
        const tr = TREASURE_TINT[tIdx * 3];
        const tg = TREASURE_TINT[tIdx * 3 + 1];
        const tb = TREASURE_TINT[tIdx * 3 + 2];
        // glow follows the treasure up and fades as it falls; a white flash marks the landing
        const glowA = (1 - progress(t, p.fallAt, p.landAt)) * Math.min(1, t / 90);
        const land = t >= p.landAt ? 1 - progress(t, p.landAt, p.end) : 0;
        put(gd, 0, c.x, y, glowS * s * (1.9 + 0.3 * p.tier), 0, BF.shine, tr, tg, tb, 0.9 * glowA);
        put(gd, 1, c.x, y, glowS * s * 1.0, 0, BF.shine, 1, 0.97, 0.9, 0.6 * glowA);
        put(gd, 2, c.x, c.y, glowS * (1.2 + 1.4 * (1 - land)), 0, BF.shine, 1, 0.92, 0.7, 0.85 * land * land);
        // the chest throws its lid open (Blender, 16 frames) as it rises; everything else is a still
        const frame =
          tIdx === CHEST
            ? BF.chest0 + Math.min(CHEST_FRAMES - 1, Math.floor(progress(t, 40, RISE + 420) * CHEST_FRAMES))
            : BF.treasure0 + tIdx;
        put(d, 0, c.x, y - cell * 0.02, gemS * s * bounce, rot, frame, 1, 1, 1, 1);
        return d;
      }, true);
      return gd;
    }, true);
  });

  // light rays behind epic / legendary finds
  const rayState = useDerivedValue(() => {
    const r = sv.reveal.value;
    const idx = sv.winIdx.value;
    if (idx < 0 || sv.kind.value === ResultKindCode.Repeat || r < REVEAL_AT || sv.reduceMotion.value) return null;
    const tIdx = sv.treasure.value[idx];
    const p = revealPeak(tIdx);
    const t = r - REVEAL_AT;
    if (p.tier < 2 || t >= p.end) return null;
    const c = cellCenter(layout, idx);
    const lift = cell * (0.45 + 0.3 * p.tier);
    const rise = easeOutCubic(progress(t, 0, RISE));
    const fall = progress(t, p.fallAt, p.landAt);
    return { x: c.x, y: c.y - lift * rise * (1 - fall), t, a: rise * (1 - fall), tier: p.tier, tIdx };
  });
  const rayT = useDerivedValue(() => {
    const st = rayState.value;
    if (!st) return [{ scale: 0 }];
    return [{ translateX: st.x }, { translateY: st.y }, { rotate: st.t / 1400 }, { scale: cell * (1.6 + 0.9 * (st.tier - 1)) * (0.6 + 0.4 * st.a) }];
  });
  const rayOpacity = useDerivedValue(() => (rayState.value ? rayState.value.a * 0.9 : 0));
  const rayColors = useDerivedValue(() => RAY_COLORS[rayState.value ? rayState.value.tIdx : 0]);

  return (
    <Group>
      <Group opacity={rayOpacity} blendMode="plus">
        <Path path={rays} transform={rayT}>
          <RadialGradient c={vec(0, 0)} r={1} colors={rayColors} positions={[0, 0.35, 1]} />
        </Path>
      </Group>
      <SpriteLayer texture={texture} frames={atlas.frames} data={glows} capacity={3} blendMode="plus" />
      <SpriteLayer texture={texture} frames={atlas.frames} data={hero} capacity={1} />
    </Group>
  );
});
