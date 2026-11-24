import { Group, Skia, type SkImage } from '@shopify/react-native-skia';
import { memo, useMemo } from 'react';
import { makeMutable, useFrameCallback, type SharedValue } from 'react-native-reanimated';

import { put, useSpriteData } from '../../engine/sprites/layer';
import { SpriteLayer } from '../../engine/sprites/SpriteLayer';
import type { SpinEngine } from '../../engine/useSpinEngine';
import { LINE_ANTI, LINE_DIAG, Phase, ResultKindCode, Reveal } from '../../engine/timeline';
import { indexAt, wrap } from '../../game/reelMath';
import type { StageLayout } from '../../theme/layout';
import { easeOutBack, hash, progress } from './anim';
import { CHEST } from '../../game/treasure';
import { BF, CHEST_FRAMES, FLIP_FRAMES, TILE, TREASURE_PX, type BoardAtlas } from './textures';
import { revealPeak, REVEAL_AT } from './TreasureReveal';

type Props = {
  layout: StageLayout;
  sv: SpinEngine['sv'];
  atlas: BoardAtlas;
  texture: SharedValue<SkImage | null>;
};

const N = 100;
const FLIP_MS = 420;

/**
 * The board system: 100 glossy keys rendered as four Atlas layers (halo light under the keys,
 * the Blender-rendered keys, their numbers, and rim/shine light on top) — 500 sprites, 4 draws.
 *
 * Everything a cell does is a pure function of the engine clock + a little UI-thread state:
 *  - intro:    keys cascade in along the diagonals with a springy pop
 *  - attract:  a glint sweeps diagonally across the board every 7 s while idle
 *  - scanner:  while the wheel turns, the cell under the pointer lights up and fades, so a
 *              sapphire comet races across the board in step with the reel — and crawls,
 *              cell by cell, as the reel brakes
 *  - target:   the destination key pulses while the number is in flight
 *  - claim:    hit-stop flash → 24-frame Blender flip: the vault lid opens into a gold setting,
 *              the hidden treasure rises out of it (TreasureReveal draws that hero moment) and
 *              is seated, the number shrinks into a corner badge → ripple through the board
 *  - shimmer:  claimed treasures catch the light one at a time
 *  - repeat:   the already-claimed key shakes its head
 *  - lines:    a completed row / column / diagonal fires a chase of light outwards from the hit
 *  - jackpot:  every key pops in a wave from the centre
 *  - new board: keys flip back gold → sapphire in a wave from the centre
 */
export const Tiles = memo(function Tiles({ layout, sv, atlas, texture }: Props) {
  const { grid, cell, gap } = layout;
  const halo = useSpriteData(N);
  const tiles = useSpriteData(N);
  const gems = useSpriteData(N);
  const nums = useSpriteData(N);
  const shine = useSpriteData(N * 2);
  const state = useMemo(
    () => ({
      heat: makeMutable(new Array(N).fill(0)),
      lastClock: makeMutable(0),
      lastIdx: makeMutable(-1),
      resetMask: makeMutable(new Array(N).fill(0)),
      resetSeen: makeMutable(-1),
    }),
    [],
  );
  const tileS = (cell / TILE) * 1.05;
  const glyphS = atlas.glyphScale;
  const gemS = (cell * 0.7) / TREASURE_PX;
  const pitch = cell + gap;
  const pitchX = layout.cellW + gap;

  useFrameCallback(() => {
    'worklet';
    const clock = sv.clock.value;
    const dt = Math.max(0, Math.min(40, clock - state.lastClock.value));
    state.lastClock.value = clock;
    const reduce = sv.reduceMotion.value;
    const mask = sv.wonMask.value;
    const r = sv.reveal.value;
    const w = sv.winIdx.value;
    const kind = sv.kind.value;
    const repeat = kind === ResultKindCode.Repeat;
    const complete = kind === ResultKindCode.Complete;
    const live = w >= 0 && r >= 0 && r < Reveal.Steady;
    const claiming = live && !repeat;
    const hits = live && !repeat ? sv.lineHits.value : 0;
    const ph = sv.phase.value;
    const steady = ph === Phase.Idle || ph === Phase.Snap;
    const wr = w >= 0 ? Math.floor(w / 10) : 0;
    const wc = w >= 0 ? w % 10 : 0;

    // scanner heat: light the cell under the pointer (filling gaps at high speed), then decay
    const heat = state.heat.value;
    const decay = Math.exp(-dt / 230);
    for (let i = 0; i < N; i++) heat[i] *= decay;
    if (!steady && !reduce) {
      const idx = indexAt(sv.x.value);
      const last = state.lastIdx.value;
      const stepF = last < 0 ? 0 : wrap(idx - last);
      const stepB = last < 0 ? 0 : wrap(last - idx);
      if (stepF > 0 && stepF <= 4) for (let k = 1; k < stepF; k++) heat[wrap(last + k)] = Math.max(heat[wrap(last + k)], 0.75);
      else if (stepB > 0 && stepB <= 4) for (let k = 1; k < stepB; k++) heat[wrap(last - k)] = Math.max(heat[wrap(last - k)], 0.75);
      heat[idx] = 1;
      state.lastIdx.value = idx;
    } else {
      state.lastIdx.value = -1;
    }

    // new-board wave bookkeeping
    const resetAt = sv.resetAt.value;
    if (resetAt !== state.resetSeen.value) {
      state.resetSeen.value = resetAt;
      const rm = state.resetMask.value;
      for (let i = 0; i < N; i++) rm[i] = 0;
      const cells = sv.resetCells.value;
      for (let k = 0; k < cells.length; k++) rm[cells[k]] = 1;
    }
    const rmask = state.resetMask.value;
    const tre = sv.treasure.value;
    const oldTre = sv.resetTreasure.value;

    const attract = steady && !live && !reduce;
    const sweep = ((clock % 7000) - 900) / 1500;
    const impactT = claiming && r >= Reveal.HitStopEnd ? (r - Reveal.HitStopEnd) / 1000 : -1;

    gems.modify((gd) => {
      'worklet';
      halo.modify((hd) => {
        'worklet';
        tiles.modify((td) => {
          'worklet';
          nums.modify((nd) => {
            'worklet';
            shine.modify((sd) => {
              'worklet';
              for (let i = 0; i < N; i++) {
                const row = Math.floor(i / 10);
                const col = i % 10;
                let x = grid.x + col * pitchX + layout.cellW / 2;
                let y = grid.y + row * pitch + cell / 2;
                const seed = hash(i, 3.7);

                // ── intro cascade ──
                const it = clock - 250 - (row + col) * 30;
                const introS = reduce ? 1 : 0.55 + 0.45 * easeOutBack(progress(it, 0, 420));
                const introA = progress(it, 0, 140);

                // ── base face ──
                let claimed = mask[i] === 1;
                let frame = claimed ? BF.gold : BF.idle;
                let flip = -1; // 0..1 while flipping
                const isW = i === w;
                if (isW && claiming) {
                  if (r < Reveal.HitStopEnd) {
                    frame = BF.idle;
                    claimed = false;
                  } else {
                    const fp = progress(r, Reveal.HitStopEnd, Reveal.HitStopEnd + FLIP_MS);
                    if (fp < 1) {
                      flip = fp;
                      frame = BF.flip0 + Math.min(FLIP_FRAMES - 1, Math.floor(fp * FLIP_FRAMES));
                    }
                  }
                }
                let tIdx = tre[i];
                if (rmask[i] === 1 && resetAt >= 0) {
                  const dc = Math.hypot(row - 4.5, col - 4.5);
                  const tr = clock - resetAt - dc * 55;
                  if (tr < FLIP_MS) tIdx = oldTre[i];
                  if (tr < 0) {
                    frame = BF.gold;
                    claimed = true;
                  } else if (tr < FLIP_MS) {
                    const fp = tr / FLIP_MS;
                    flip = 1 - fp;
                    frame = BF.flip0 + Math.min(FLIP_FRAMES - 1, Math.floor((1 - fp) * FLIP_FRAMES));
                  }
                }

                // ── motion ──
                let s = introS;
                let rot = 0;
                if (impactT >= 0 && !reduce) {
                  const d = Math.hypot(row - wr, col - wc);
                  const tl = impactT - d * 0.032;
                  if (isW) {
                    s *= 1 + 0.32 * Math.exp(-impactT * 7) * Math.cos(impactT * 24);
                  } else if (tl > 0) {
                    const amp = (complete ? 9 : 6) * Math.sin(tl * 30) * Math.exp(-tl * 6.5) / (1 + d * 0.28);
                    x += ((col - wc) / d) * amp;
                    y += ((row - wr) / d) * amp;
                    s *= 1 + amp * 0.012;
                  }
                }
                if (isW && live && r >= Reveal.FormEnd && r < Reveal.DropEnd) {
                  // inhale before the hit
                  s *= 1 - 0.08 * progress(r, Reveal.DropEnd - 160, Reveal.DropEnd);
                }
                if (isW && live && repeat && r >= Reveal.DropEnd && !reduce) {
                  const tt = (r - Reveal.DropEnd) / 1000;
                  rot = 0.2 * Math.sin(tt * 46) * Math.exp(-tt * 7);
                }
                // jackpot: the whole board pops in a wave from the centre
                if (complete && live && r >= Reveal.LineStart && !reduce) {
                  const d0 = Math.hypot(row - 4.5, col - 4.5);
                  const tj = r - Reveal.LineStart - d0 * 70;
                  if (tj > 0 && tj < 380) s *= 1 + 0.18 * Math.sin((Math.PI * tj) / 380);
                }

                put(td, i, x, y, tileS * s, rot, frame, 1, 1, 1, introA);

                // ── treasure + number ──
                const faceGold = flip >= 0 ? flip >= 0.5 : claimed;
                const squash = flip >= 0 ? Math.abs(Math.cos(flip * Math.PI)) : 1;
                const newest = isW && !repeat && w >= 0 && (r < 0 || r >= Reveal.HitStopEnd);
                // the winner's treasure is drawn by TreasureReveal (above everything) until seated
                const heroActive = isW && claiming && r < REVEAL_AT + revealPeak(tIdx).end;
                let gemA = faceGold && !heroActive ? introA : 0;
                if (isW && claiming && r >= REVEAL_AT + revealPeak(tIdx).end) gemA = introA;
                const breathe = 1 + 0.03 * Math.sin(clock * 0.0021 + seed * 6.28);
                put(gd, i, x, y - cell * 0.02, gemS * s * squash * breathe, rot, tIdx === CHEST ? BF.chest0 + CHEST_FRAMES - 1 : BF.treasure0 + tIdx, 1, 1, 1, gemA);

                // the number: full size on a closed lid, a small gold badge in the corner once open
                const badgeK = faceGold
                  ? isW && claiming
                    ? progress(r, Reveal.HitStopEnd + FLIP_MS * 0.5, Reveal.HitStopEnd + FLIP_MS * 0.5 + 320)
                    : 1
                  : 0;
                const bk = easeOutBack(badgeK);
                // the badge sits inside the bezel with the same clearance right and below (measured
                // on device: 0.3 put the digits on the bottom bezel line)
                const nx = x + cell * 0.285 * bk;
                // the number's lit face sits on the key's optical centre (its extrusion hangs below)
                const ny = y - cell * 0.02 + cell * 0.3 * bk;
                // gold lettering on claimed keys (baked, untinted: a tint can't add its white-hot
                // top); older claims sit a touch dimmer than the newest
                const nk = faceGold && !newest ? 0.9 : 1;
                const face = faceGold ? BF.glyphGold0 : BF.glyph0;
                put(nd, i, nx, ny, glyphS * s * squash * (1 - 0.56 * bk), rot, face + i, nk, nk, nk, squash > 0.12 ? introA : 0);

                // ── light ──
                let ha = 0;
                let hr = 1;
                let hg = 0.55;
                let hb = 0.15;
                let hs = 1;
                if (faceGold) {
                  ha = 0.3 + 0.1 * Math.sin(clock * 0.0035 + seed * 6.28);
                  if (newest) {
                    ha = 0.7 + 0.25 * Math.sin(clock * 0.006);
                    hg = 0.7;
                    hb = 0.3;
                    hs = 1.12;
                  }
                }
                const ht = heat[i];
                if (ht > 0.02 && ht * 0.95 > ha) {
                  ha = ht * 0.95;
                  hr = 0.45 + 0.2 * ht;
                  hg = 0.72 + 0.15 * ht;
                  hb = 1;
                  hs = 1 + 0.12 * ht;
                }
                let edge = faceGold ? 0.3 + 0.2 * Math.sin(clock * 0.0047 + seed * 9.1) : 0;
                let spot = 0;
                let sr = 1;
                let sg = 1;
                let sb = 1;
                let spotS = 1;
                // target lock while the number is in flight
                if (isW && live && r >= Reveal.FormEnd && r < Reveal.DropEnd) {
                  const p = progress(r, Reveal.FormEnd, Reveal.DropEnd);
                  const pulse = 0.5 + 0.5 * Math.sin(r / 34);
                  edge = Math.max(edge, (0.35 + 0.65 * pulse) * p);
                  ha = Math.max(ha, 0.6 * p);
                  hr = 1;
                  hg = 0.82;
                  hb = 0.45;
                }
                // impact flash
                if (isW && live && r >= Reveal.DropEnd && r < Reveal.HitStopEnd + 260) {
                  const f = r < Reveal.HitStopEnd ? 1 : 1 - (r - Reveal.HitStopEnd) / 260;
                  // warm, not white: the cell glows gold from inside instead of blowing out
                  spot = Math.max(spot, (repeat ? 0.25 : 0.55) * f);
                  spotS = 1.45;
                  sg = 0.86;
                  sb = repeat ? 1 : 0.55;
                  edge = Math.max(edge, f);
                }
                // line chase
                if (hits) {
                  let dk = -1;
                  if (hits & (1 << row)) dk = Math.abs(col - wc);
                  if (hits & (1 << (10 + col))) dk = Math.max(dk, Math.abs(row - wr));
                  if (row === col && hits & (1 << LINE_DIAG)) dk = Math.max(dk, Math.abs(row - wr));
                  if (row + col === 9 && hits & (1 << LINE_ANTI)) dk = Math.max(dk, Math.abs(row - wr));
                  if (dk >= 0) {
                    for (let rep = 0; rep < 2; rep++) {
                      const tl = r - Reveal.LineStart - dk * 55 - rep * 520;
                      if (tl > 0 && tl < 420) {
                        const k = Math.sin((Math.PI * tl) / 420);
                        spot = Math.max(spot, k);
                        sr = 1;
                        sg = 0.92;
                        sb = 0.6;
                        spotS = 1.5;
                        edge = Math.max(edge, k);
                        ha = Math.max(ha, k);
                        hr = 1;
                        hg = 0.8;
                        hb = 0.35;
                      }
                    }
                  }
                }
                // claimed treasures catch the light, one at a time
                if (faceGold && !heroActive) {
                  const gt = (clock + seed * 9000) % 9000;
                  if (gt < 360) {
                    const g = Math.sin((Math.PI * gt) / 360);
                    spot = Math.max(spot, g * 0.55);
                    spotS = Math.max(spotS, 0.9);
                    sg = Math.min(sg, 0.95);
                    sb = Math.min(sb, 0.8);
                  }
                }
                // attract glint
                if (attract) {
                  const u = (row + col) / 18;
                  const g = Math.exp(-((u - sweep) * (u - sweep)) / 0.0045);
                  if (g > 0.01) {
                    spot = Math.max(spot, g * 0.45);
                    spotS = Math.max(spotS, 1.1);
                  }
                }
                put(hd, i, x, y, tileS * s * hs, 0, BF.halo, hr, hg, hb, ha * introA);
                put(sd, i, x, y, tileS * s, rot, BF.edge, 1, faceGold ? 0.86 : 0.7, faceGold ? 0.5 : 1, edge * introA);
                put(sd, N + i, x, y, (cell / 96) * spotS * s, 0, BF.shine, sr, sg, sb, spot * introA);
              }
              return sd;
            }, true);
            return nd;
          }, true);
          return td;
        }, true);
        return hd;
      }, true);
      return gd;
    }, true);
  });

  // The painted frame's opening has a ~8 pt inner corner radius whose centre sits ~8 pt in from the
  // grid's corner (measured on device); the keys' faces start ~1.7 pt inside the grid. A clip 1 pt
  // inside the grid with a 7 pt radius shares that centre, so the corner keys' outer corners turn
  // concentric with the gold (≈ 6 pt) while every straight key edge stays untouched.
  const wellClip = useMemo(
    () => Skia.RRectXY(Skia.XYWHRect(grid.x + 1, grid.y + 1, grid.width - 2, grid.height - 2), 7, 7),
    [grid.x, grid.y, grid.width, grid.height],
  );

  return (
    <Group>
      <SpriteLayer texture={texture} frames={atlas.frames} data={halo} capacity={N} blendMode="plus" />
      {/* the keys sit inside the frame's rounded opening: the corner keys follow its curve
          (concentric, ~1 pt inside the painted inner edge) instead of poking square corners
          over the gold */}
      <Group clip={wellClip}>
        <SpriteLayer texture={texture} frames={atlas.frames} data={tiles} capacity={N} />
        <SpriteLayer texture={texture} frames={atlas.frames} data={gems} capacity={N} />
        <SpriteLayer texture={texture} frames={atlas.frames} data={nums} capacity={N} />
        <SpriteLayer texture={texture} frames={atlas.frames} data={shine} capacity={N * 2} blendMode="plus" />
      </Group>
    </Group>
  );
});
