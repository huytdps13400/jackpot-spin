import { type SkImage } from '@shopify/react-native-skia';
import { memo } from 'react';
import { useFrameCallback, type SharedValue } from 'react-native-reanimated';

import { hideRange, put, useSpriteData } from '../../engine/sprites/layer';
import { SpriteLayer } from '../../engine/sprites/SpriteLayer';
import type { SpinEngine } from '../../engine/useSpinEngine';
import { ResultKindCode } from '../../engine/timeline';
import { TREASURE_TINT } from '../../game/treasure';
import { cellCenter, type StageLayout } from '../../theme/layout';
import { progress } from './anim';
import { PF, PILLAR_BASE, type Atlas } from './textures';
import { REVEAL_AT, revealPeak } from './TreasureReveal';

type Props = {
  layout: StageLayout;
  sv: SpinEngine['sv'];
  atlas: Atlas;
  texture: SharedValue<SkImage | null>;
};

/** The beam starts a beat before the treasure rises, so the light "lifts" it out of the cell. */
const START = REVEAL_AT - 60;
/** Shoot-up frames 0–3 (ms each), then the 8-frame loop (ms each). */
const SHOOT_MS = 32;
const LOOP_MS = 70;
/** Length of the beam in the Blender render, px. */
const BEAM_PX = 320;

/**
 * The loot beam: the "you got it" light pillar that rises from a claimed cell, as in an ARPG
 * drop. A Blender flipbook (scripts/blender/render_vfx.py → fx_pillar: soft volumetric column,
 * light pool, halo rings and motes climbing it) in white light, so it is tinted here with the
 * treasure's own colour, plus a white-hot core drawn untinted on top. Taller and wider for rarer
 * finds; it shoots up as the lid opens, loops while the treasure is presented, and fades as the
 * treasure is seated. A wide faint copy of the haze adds the outer scatter. Additive, one Atlas draw.
 */
export const LootBeam = memo(function LootBeam({ layout, sv, atlas, texture }: Props) {
  const beam = useSpriteData(3);
  const { cell } = layout;

  useFrameCallback(() => {
    'worklet';
    const r = sv.reveal.value;
    const idx = sv.winIdx.value;
    beam.modify((d) => {
      'worklet';
      if (idx < 0 || sv.kind.value === ResultKindCode.Repeat || r < START) {
        hideRange(d, 0, 3);
        return d;
      }
      const tIdx = sv.treasure.value[idx];
      const p = revealPeak(tIdx);
      const t = r - START;
      const end = p.landAt + 60 + 380;
      if (t >= end) {
        hideRange(d, 0, 3);
        return d;
      }
      const reduce = sv.reduceMotion.value;
      const frame = reduce ? 4 : t < 4 * SHOOT_MS ? Math.floor(t / SHOOT_MS) : 4 + (Math.floor((t - 4 * SHOOT_MS) / LOOP_MS) % 8);
      const len = cell * (4 + 0.8 * p.tier);
      const s = len / BEAM_PX;
      const c = cellCenter(layout, idx);
      // the pool of light sits on the cell, a little below its centre (the treasure's base)
      const baseY = c.y + cell * 0.12;
      const a = progress(t, 0, 60) * (1 - progress(t, p.fallAt + 60, end));
      // the treasure's light, lifted a little towards white so dark tints still glow
      const tr = 0.15 + 0.85 * TREASURE_TINT[tIdx * 3];
      const tg = 0.15 + 0.85 * TREASURE_TINT[tIdx * 3 + 1];
      const tb = 0.15 + 0.85 * TREASURE_TINT[tIdx * 3 + 2];
      // a wide, faint copy of the haze first (the light scattering further out), then the column, then the core
      const w = 1.7 * s;
      put(d, 0, c.x, baseY - PILLAR_BASE * w, w, 0, PF.pillar0 + frame, tr, tg, tb, a * 0.4);
      put(d, 1, c.x, baseY - PILLAR_BASE * s, s, 0, PF.pillar0 + frame, tr, tg, tb, a);
      put(d, 2, c.x, baseY - PILLAR_BASE * s, s, 0, PF.pillarCore0 + frame, 1, 1, 1, a * 0.8);
      return d;
    }, true);
  });

  return <SpriteLayer texture={texture} frames={atlas.frames} data={beam} capacity={3} blendMode="plus" />;
});
