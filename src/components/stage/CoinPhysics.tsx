import { Group, type SkImage } from '@shopify/react-native-skia';
import { memo } from 'react';
import { useFrameCallback, useSharedValue, type SharedValue } from 'react-native-reanimated';

import { hideRange, put, useSpriteData } from '../../engine/sprites/layer';
import { SpriteLayer } from '../../engine/sprites/SpriteLayer';
import type { SpinEngine } from '../../engine/useSpinEngine';
import { ResultKindCode, Reveal } from '../../engine/timeline';
import { COIN_BURST, COIN_JACKPOT } from '../../game/physics/coinSims';
import { cellCenter, type StageLayout } from '../../theme/layout';
import { PF, type Atlas } from './textures';

type Props = {
  layout: StageLayout;
  sv: SpinEngine['sv'];
  atlas: Atlas;
  texture: SharedValue<SkImage | null>;
};

const CAP = COIN_JACKPOT.coins;
/** How the coin's height above the board reads on screen (a 3/4 camera cheat), in cells per cell. */
const LIFT = 0.85;
/** Seconds after the sim ends before the coins melt into light, and how long that takes. */
const HOLD = 0.25;
const MELT = 0.45;
const UNSEEN = -1e9;

const smooth = (t: number) => {
  'worklet';
  const u = Math.min(1, Math.max(0, t));
  return u * u * (3 - 2 * u);
};

/**
 * Gold coins with real physics: Blender rigid-body (Bullet) sims baked to keyframes by
 * scripts/blender/bake_coin_physics.py (src/game/physics/coinSims.ts) and played back on the UI
 * thread, interpolated to the display rate. A new cell erupts 14 coins that arc, hit the board,
 * bounce, skid and settle; the jackpot throws a 48-coin fountain from the board's centre.
 *
 * Each coin is the Blender-rendered coin sheet (frame from the coin's tilt, rotated by its roll so
 * the foreshortening follows the real spin axis), its height lifts it up the screen, a contact
 * shadow stays on the board and shrinks as it rises, and a glint flares whenever its face swings
 * square to the light. When the sim ends the coins melt into sparks. Three Atlas draws.
 */
export const CoinPhysics = memo(function CoinPhysics({ layout, sv, atlas, texture }: Props) {
  const shadows = useSpriteData(CAP);
  const coins = useSpriteData(CAP);
  const glints = useSpriteData(CAP);
  const pitch = layout.cell + layout.gap;
  const pitchX = layout.cellW + layout.gap;
  const coinS = (pitch * 0.6) / 128;
  const shadowS = (pitch * 0.62) / 64;
  const glintS = (pitch * 1.1) / 128;
  const board = {
    x: layout.grid.x + layout.grid.width / 2,
    y: layout.grid.y + layout.grid.height / 2,
  };
  const burst = COIN_BURST;
  const jackpot = COIN_JACKPOT;
  // sim time runs on the world clock from the impact (the reveal timeline stops at Steady, the
  // jackpot fountain outlasts it)
  const startAt = useSharedValue(-1);
  const lastR = useSharedValue(UNSEEN);
  const hidden = useSharedValue(false);

  useFrameCallback(() => {
    'worklet';
    const r = sv.reveal.value;
    const prev = lastR.value;
    lastR.value = r;
    // only a live impact starts the sim: not a reveal that was already over when this mounted
    if (prev !== UNSEEN && r >= Reveal.HitStopEnd && (prev < Reveal.HitStopEnd || prev > r)) startAt.value = sv.clock.value;
    if (r < Reveal.HitStopEnd) startAt.value = -1;
    const idx = sv.winIdx.value;
    const kind = sv.kind.value;
    const complete = kind === ResultKindCode.Complete;
    const live = idx >= 0 && kind !== ResultKindCode.Repeat && startAt.value >= 0 && !sv.reduceMotion.value;
    const sim = complete ? jackpot : burst;
    const t = (sv.clock.value - startAt.value) / 1000;
    const simEnd = (sim.frames - 1) / sim.fps;
    const done = !live || t > simEnd + HOLD + MELT + 0.1;
    // idle: hidden once, then no per-frame work at all
    if (done && hidden.value) return;
    hidden.value = done;
    coins.modify((cd) => {
      'worklet';
      shadows.modify((sd) => {
        'worklet';
        glints.modify((gd) => {
          'worklet';
          if (done) {
            hideRange(cd, 0, CAP);
            hideRange(sd, 0, CAP);
            hideRange(gd, 0, CAP);
            return gd;
          }
          const o = complete ? board : cellCenter(layout, idx);
          const fr = Math.min(t, simEnd) * sim.fps;
          const f0 = Math.min(sim.frames - 1, Math.floor(fr));
          const f1 = Math.min(sim.frames - 1, f0 + 1);
          const w = fr - f0;
          const data = sim.data;
          for (let c = 0; c < CAP; c++) {
            if (c >= sim.coins) {
              cd[c * 9 + 8] = 0;
              sd[c * 9 + 8] = 0;
              gd[c * 9 + 8] = 0;
              continue;
            }
            const a0 = (f0 * sim.coins + c) * 5;
            const a1 = (f1 * sim.coins + c) * 5;
            const x = data[a0] + (data[a1] - data[a0]) * w;
            const y = data[a0 + 1] + (data[a1 + 1] - data[a0 + 1]) * w;
            const z = data[a0 + 2] + (data[a1 + 2] - data[a0 + 2]) * w;
            const tilt = data[a0 + 3] + (data[a1 + 3] - data[a0 + 3]) * w;
            const roll = data[a0 + 4] + (data[a1 + 4] - data[a0 + 4]) * w;
            const h = z + 0.26 * Math.sin(tilt) + 0.035 * Math.cos(tilt);
            // melt: staggered per coin, each shrinks into a flash of light
            const m = smooth((t - simEnd - HOLD - (c % 7) * 0.035) / MELT);
            const gx = o.x + x * pitchX;
            const gy = o.y + y * pitch;
            const sx = gx;
            const sy = gy - h * pitch * LIFT;
            const persp = 1 + 0.07 * h;
            // half the coins show the sheet's far side (frames 8–12: lit warmer), so the pile isn't
            // one flat shade; the face-on render is blown out pale, so it is toned down to gold
            const back = c % 2 === 1;
            const frame = PF.coin0 + (back ? 8 : 0) + Math.min(4, Math.max(0, Math.round((tilt / (Math.PI / 2)) * 4)));
            const ct = Math.cos(tilt);
            const flat = ct * ct * ct * ct * (back ? 0.5 : 1);
            put(cd, c, sx, sy, coinS * persp * (1 - m), roll, frame, 1, 1 - 0.13 * flat, 1 - 0.45 * flat, 1 - m * m);
            const hs = Math.min(h, 4);
            put(sd, c, gx, gy + pitch * 0.06, shadowS * (1 - 0.12 * hs) * (1 - m), 0, PF.dot, 0, 0, 0, 0.5 * (1 - hs / 6) * (1 - m));
            // glint: the face catches the light as it swings square to the camera (and as it melts)
            // (only while tumbling in the air, and only near exactly face-on: a brief flash, not a glow)
            const face = Math.pow(Math.max(0, Math.cos(tilt)), 40) * smooth((h - 0.15) / 0.3);
            const melt = Math.sin(Math.PI * m);
            const gl = Math.max(face * 0.55, melt * 0.8);
            // the Blender glint's growth frames double as its intensity ramp (frame 5 = peak)
            const gf = PF.glint0 + Math.round(gl * 5);
            put(gd, c, sx + pitch * 0.08, sy - pitch * 0.1, glintS, 0.4 + t * 2, gf, 1, 0.95, 0.8, Math.min(1, gl * 1.4));
          }
          return gd;
        }, true);
        return sd;
      }, true);
      return cd;
    }, true);
  });

  return (
    <Group>
      <SpriteLayer texture={texture} frames={atlas.frames} data={shadows} capacity={CAP} />
      <SpriteLayer texture={texture} frames={atlas.frames} data={coins} capacity={CAP} />
      <SpriteLayer texture={texture} frames={atlas.frames} data={glints} capacity={CAP} blendMode="plus" />
    </Group>
  );
});
