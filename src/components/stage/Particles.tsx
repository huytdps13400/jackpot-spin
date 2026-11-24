import { Group, type SkImage } from '@shopify/react-native-skia';
import { memo, useMemo } from 'react';
import { makeMutable, useFrameCallback, type SharedValue } from 'react-native-reanimated';

import { put, STRIDE, useSpriteData } from '../../engine/sprites/layer';
import { SpriteLayer } from '../../engine/sprites/SpriteLayer';
import type { SpinEngine } from '../../engine/useSpinEngine';
import { LINE_ANTI, LINE_DIAG, ResultKindCode, Reveal } from '../../engine/timeline';
import { cellCenter, type StageLayout } from '../../theme/layout';
import { easeOutBack, smoothstep } from './anim';
import { flightAt } from './flight';
import { BURST_FRAMES, COIN_FRAMES, GLINT_FRAMES, PF, type Atlas } from './textures';

type Props = {
  layout: StageLayout;
  sv: SpinEngine['sv'];
  atlas: Atlas;
  texture: SharedValue<SkImage | null>;
};

// particle kinds
const SPARK = 1;
const STAR = 2;
const DOT = 3;
const RING = 4;
const COIN = 5;
const CONFETTI = 6;
const PLUS = 7;
/** The Blender impact flare flipbook (pop → streaks → shockwave ring), played once. */
const BURST = 8;

/** Per-particle state: kind, x, y, vx, vy, age, life, size, rot, vrot, r, g, b, seed, hx, hy. */
const PS = 16;
const ADD_CAP = 220;
const SOLID_CAP = 130;
const COIN_HOP = 0.24; // s of ballistic pop before a coin homes in
const COIN_HOME = 0.42; // s of homing flight into the counter

/** Luxury confetti: mostly gold leaf, some champagne and white, a little ruby. */
const CONFETTI_COLORS = [
  [1, 0.82, 0.32],
  [1, 0.92, 0.62],
  [0.92, 0.66, 0.18],
  [1, 1, 1],
  [0.8, 0.08, 0.22],
  [1, 0.86, 0.45],
];

/**
 * The particle system. Two fixed pools (additive light / solid sprites) live in UI-thread
 * arrays; events on the reveal timeline spawn into them and one integrator moves everything.
 * Time comes from the engine clock, so particles freeze during the hit-stop with the rest of the
 * world. Two Atlas draws, whatever is on screen.
 */
export const Particles = memo(function Particles({ layout, sv, atlas, texture }: Props) {
  const add = useSpriteData(ADD_CAP);
  const solid = useSpriteData(SOLID_CAP);
  const st = useMemo(
    () => ({
      addP: makeMutable(new Array(ADD_CAP * PS).fill(0)),
      solidP: makeMutable(new Array(SOLID_CAP * PS).fill(0)),
      addCur: makeMutable(0),
      solidCur: makeMutable(0),
      lastR: makeMutable(-1),
      lastClock: makeMutable(0),
    }),
    [],
  );
  const { panel, width, arc, cell } = layout;
  const coinTarget = { x: panel.x + panel.width * 0.66, y: panel.y + panel.height * 0.5 };
  const windowPt = { x: arc.cx, y: arc.pivotY - arc.numberRadius };
  const coinS = (cell * 0.62) / 128;

  useFrameCallback(() => {
    'worklet';
    const clock = sv.clock.value;
    const dt = Math.max(0, Math.min(40, clock - st.lastClock.value)) / 1000;
    st.lastClock.value = clock;
    const r = sv.reveal.value;
    const lastR = st.lastR.value;
    st.lastR.value = r;
    const reduce = sv.reduceMotion.value;
    const ap = st.addP.value;
    const sp = st.solidP.value;

    const spawn = (
      pool: number[],
      cap: number,
      solidPool: boolean,
      kind: number,
      x: number,
      y: number,
      vx: number,
      vy: number,
      life: number,
      size: number,
      cr: number,
      cg: number,
      cb: number,
      delay: number,
    ) => {
      const cur = solidPool ? st.solidCur : st.addCur;
      const i = cur.value;
      cur.value = (i + 1) % cap;
      const o = i * PS;
      pool[o] = kind;
      pool[o + 1] = x;
      pool[o + 2] = y;
      pool[o + 3] = vx;
      pool[o + 4] = vy;
      pool[o + 5] = -delay;
      pool[o + 6] = life;
      pool[o + 7] = size;
      pool[o + 8] = Math.random() * Math.PI * 2;
      pool[o + 9] = (Math.random() - 0.5) * 14;
      pool[o + 10] = cr;
      pool[o + 11] = cg;
      pool[o + 12] = cb;
      pool[o + 13] = Math.random();
      pool[o + 14] = 0;
      pool[o + 15] = 0;
    };
    const burst = (x: number, y: number, n: number, speed: number, life: number, sparkleMix: number) => {
      for (let k = 0; k < n; k++) {
        const a = Math.random() * Math.PI * 2;
        const v = speed * (0.35 + 0.65 * Math.random());
        const m = Math.random() < sparkleMix;
        // the cooling ramp supplies the gold; a few accent sparks carry the skin's magenta
        spawn(ap, ADD_CAP, false, SPARK, x, y, Math.cos(a) * v, Math.sin(a) * v - speed * 0.25, life * (0.6 + 0.4 * Math.random()), 0.5 + 0.5 * Math.random(), 1, m ? 0.62 : 1, m ? 0.92 : 1, 0);
      }
    };
    const fresh = (a: number) => lastR >= 0 && lastR < a && r >= a && r - a < 200;
    const idx = sv.winIdx.value;
    const kind = sv.kind.value;
    const repeat = kind === ResultKindCode.Repeat;
    const complete = kind === ResultKindCode.Complete;

    if (!reduce && idx >= 0) {
      // lock: sparks fly off the pointer window
      if (r >= 0 && r < 200 && (lastR < 0 || lastR > r)) {
        burst(windowPt.x, windowPt.y, 14, 380, 0.5, 0.5);
        spawn(ap, ADD_CAP, false, BURST, windowPt.x, windowPt.y, 0, 0, 0.5, (arc.band * 2.4) / PF.burstPx, 1, 0.92, 0.85, 0);
      }
      if (fresh(Reveal.FormEnd)) burst(windowPt.x, windowPt.y - 14, 10, 300, 0.45, 0.3);
      // the flight leaves a trail of embers
      if (r >= Reveal.FormEnd && r < Reveal.DropEnd) {
        const h = flightAt(layout, idx, r);
        for (let k = 0; k < 2; k++) {
          spawn(ap, ADD_CAP, false, k === 0 ? SPARK : DOT, h.x + (Math.random() - 0.5) * 8, h.y + (Math.random() - 0.5) * 8, -h.dx * 900 + (Math.random() - 0.5) * 80, -h.dy * 900 + (Math.random() - 0.5) * 80, 0.38, k === 0 ? 0.45 : 0.32, 1, 0.75, 0.35, 0);
        }
      }
      const c = cellCenter(layout, idx);
      if (fresh(Reveal.DropEnd)) {
        spawn(ap, ADD_CAP, false, RING, c.x, c.y, 0, 0, 0.45, repeat ? 0.8 : 1.0, 1, repeat ? 0.85 : 0.86, repeat ? 1 : 0.55, 0);
        if (repeat) {
          for (let k = 0; k < 14; k++) {
            const a = Math.random() * Math.PI * 2;
            spawn(ap, ADD_CAP, false, DOT, c.x, c.y, Math.cos(a) * 60, Math.sin(a) * 60 - 20, 0.8, 0.9 + Math.random() * 0.6, 0.62, 0.55, 0.9, 0);
          }
        }
      }
      if (fresh(Reveal.HitStopEnd) && !repeat) {
        // layered burst: fast sparks, slow embers that rise and flicker out, a few glints
        burst(c.x, c.y, complete ? 44 : 22, complete ? 760 : 580, 0.65, 0.22);
        for (let k = 0; k < (complete ? 30 : 16); k++) {
          const a = Math.random() * Math.PI * 2;
          const v = 40 + Math.random() * 120;
          spawn(ap, ADD_CAP, false, DOT, c.x + Math.cos(a) * cell * 0.3, c.y + Math.sin(a) * cell * 0.3, Math.cos(a) * v, Math.sin(a) * v - 70, 0.9 + Math.random() * 0.6, 0.16 + Math.random() * 0.16, 1, 0.86, 0.55, 0.05 + Math.random() * 0.15);
        }
        for (let k = 0; k < (complete ? 14 : 7); k++) {
          const a = Math.random() * Math.PI * 2;
          const rad = cell * (0.4 + Math.random() * 1.1);
          spawn(ap, ADD_CAP, false, STAR, c.x + Math.cos(a) * rad, c.y + Math.sin(a) * rad, 0, -12, 0.55 + Math.random() * 0.35, 0.45 + Math.random() * 0.4, 1, 1, 1, 0.04 + Math.random() * 0.3);
        }
        spawn(ap, ADD_CAP, false, BURST, c.x, c.y, 0, 0, complete ? 0.85 : 0.6, (cell * (complete ? 7 : 3.6)) / PF.burstPx, 1, 1, 1, 0);
        spawn(ap, ADD_CAP, false, RING, c.x, c.y, 0, 0, 0.65, complete ? 3.2 : 1.7, 1, 0.45, 0.85, 0.07);
        spawn(sp, SOLID_CAP, true, PLUS, c.x, c.y - cell * 0.3, 0, -90, 1.0, 1, 1, 1, 1, 0);
        // coins: a few hop straight into the counter (the physical eruption is CoinPhysics)
        const coins = complete ? 10 : 4;
        for (let k = 0; k < coins; k++) {
          const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
          const v = 260 + Math.random() * 260;
          spawn(sp, SOLID_CAP, true, COIN, c.x, c.y, Math.cos(a) * v, Math.sin(a) * v, COIN_HOP + COIN_HOME, 0.85 + Math.random() * 0.3, 1, 1, 1, (Reveal.CollectStart - Reveal.HitStopEnd) / 1000 + k * 0.028);
        }
      }
      // completed lines: sparks run along the line from the hit outwards
      const hits = repeat ? 0 : sv.lineHits.value;
      if (hits && fresh(Reveal.LineStart)) {
        const wr = Math.floor(idx / 10);
        const wc = idx % 10;
        for (let id = 0; id < 22; id++) {
          if (!(hits & (1 << id))) continue;
          for (let k = 0; k < 10; k++) {
            const cellIdx = id < 10 ? id * 10 + k : id < 20 ? k * 10 + (id - 10) : id === LINE_DIAG ? k * 11 : k * 10 + (9 - k);
            const p = cellCenter(layout, cellIdx);
            const dk = id < 10 ? Math.abs(k - wc) : Math.abs(k - wr);
            for (let m = 0; m < 3; m++) {
              const a = Math.random() * Math.PI * 2;
              spawn(ap, ADD_CAP, false, m === 0 ? STAR : SPARK, p.x, p.y, Math.cos(a) * 160, Math.sin(a) * 160 - 60, 0.6, m === 0 ? 0.35 : 0.5, 1, 0.9, 0.5, dk * 0.055);
            }
          }
          if (id === LINE_ANTI) break;
        }
      }
      // jackpot: confetti and a coin rain from the top of the screen
      if (complete && fresh(Reveal.LineStart)) {
        for (let k = 0; k < 90; k++) {
          const col = CONFETTI_COLORS[k % CONFETTI_COLORS.length];
          spawn(sp, SOLID_CAP, true, CONFETTI, Math.random() * width, -20 - Math.random() * 120, (Math.random() - 0.5) * 120, 80 + Math.random() * 160, 3.2, 0.7 + Math.random() * 0.6, col[0], col[1], col[2], Math.random() * 0.5);
        }
      }
    }

    // ── integrate ──
    const step = (pool: number[], cap: number) => {
      for (let i = 0; i < cap; i++) {
        const o = i * PS;
        const kind = pool[o];
        if (kind === 0) continue;
        pool[o + 5] += dt;
        const age = pool[o + 5];
        if (age < 0) continue;
        if (age > pool[o + 6]) {
          pool[o] = 0;
          continue;
        }
        let vx = pool[o + 3];
        let vy = pool[o + 4];
        if (kind === SPARK) {
          vy += 900 * dt;
          const d = Math.exp(-dt * 2.4);
          vx *= d;
          vy *= d;
        } else if (kind === STAR) {
          vy += 380 * dt;
          const d = Math.exp(-dt * 3);
          vx *= d;
          vy *= d;
        } else if (kind === DOT) {
          vy -= 30 * dt;
          const d = Math.exp(-dt * 2.6);
          vx *= d;
          vy *= d;
        } else if (kind === CONFETTI) {
          vy += 160 * dt;
          vx += Math.sin(age * 3.1 + pool[o + 13] * 9) * 90 * dt;
          const d = Math.exp(-dt * 1.3);
          vx *= d;
          vy *= d;
        } else if (kind === PLUS) {
          vy *= Math.exp(-dt * 1.6);
        } else if (kind === COIN) {
          if (age < COIN_HOP) {
            vy += 1500 * dt;
          } else {
            if (pool[o + 14] === 0) {
              pool[o + 14] = pool[o + 1];
              pool[o + 15] = pool[o + 2];
            }
            const u = Math.min(1, (age - COIN_HOP) / COIN_HOME);
            const e = u * u * (2.2 - 1.2 * u);
            const hx = pool[o + 14];
            const hy = pool[o + 15];
            const mx = (hx + coinTarget.x) / 2 + (pool[o + 13] - 0.5) * 120;
            const my = Math.min(hy, coinTarget.y) - 60;
            const a = 1 - e;
            pool[o + 1] = a * a * hx + 2 * a * e * mx + e * e * coinTarget.x;
            pool[o + 2] = a * a * hy + 2 * a * e * my + e * e * coinTarget.y;
            continue;
          }
        }
        pool[o + 3] = vx;
        pool[o + 4] = vy;
        pool[o + 1] += vx * dt;
        pool[o + 2] += vy * dt;
        pool[o + 8] += pool[o + 9] * dt;
      }
    };
    step(ap, ADD_CAP);
    step(sp, SOLID_CAP);

    // ── render ──
    add.modify((d) => {
      'worklet';
      for (let i = 0; i < ADD_CAP; i++) {
        const o = i * PS;
        const kind = ap[o];
        const age = ap[o + 5];
        if (kind === 0 || age < 0) {
          d[i * STRIDE + 8] = 0;
          continue;
        }
        const f = age / ap[o + 6];
        const size = ap[o + 7];
        const x = ap[o + 1];
        const y = ap[o + 2];
        // tint × a cooling ramp: white-hot → pale gold → gold → amber (light, not flat colour)
        let hg = 1;
        let hb = 1;
        if (f < 0.06) {
          const u = f / 0.06;
          hg = 1 - 0.06 * u;
          hb = 1 - 0.3 * u;
        } else if (f < 0.5) {
          const u = (f - 0.06) / 0.44;
          hg = 0.94 - 0.14 * u;
          hb = 0.7 - 0.36 * u;
        } else {
          const u = (f - 0.5) / 0.5;
          hg = 0.8 - 0.32 * u;
          hb = 0.34 - 0.2 * u;
        }
        const cr = ap[o + 10];
        const cg = ap[o + 11] * hg;
        const cb = ap[o + 12] * hb;
        const pop = Math.min(1, age / 0.035); // never appear from nothing in one frame
        const seed = ap[o + 13];
        if (kind === SPARK) {
          const vx = ap[o + 3];
          const vy = ap[o + 4];
          const sp2 = Math.hypot(vx, vy);
          const fade = (1 - f) * Math.sqrt(1 - f);
          // Blender streak (head leads along the velocity), stretched by speed
          put(d, i, x, y, size * pop * (0.13 + 0.3 * Math.min(1, sp2 / 650)) * (1 - 0.45 * f), Math.atan2(vy, vx), PF.flare, cr, cg, cb, fade);
        } else if (kind === STAR) {
          // glint: the Blender star flipbook (grows, turns 45°, fades) over the particle's life
          const gf = PF.glint0 + Math.min(GLINT_FRAMES - 1, Math.floor(f * GLINT_FRAMES));
          put(d, i, x, y, size * 0.5, seed * 0.6, gf, ap[o + 10], ap[o + 11] * 0.97, ap[o + 12] * 0.9, 1);
        } else if (kind === DOT) {
          // ember: shrinking, flickering, cooling
          const flick = 0.75 + 0.25 * Math.sin(age * 23 + seed * 40);
          put(d, i, x, y, size * pop * (0.6 + 0.45 * (1 - f)), 0, PF.ember, cr, cg, cb, (1 - f) * flick);
        } else if (kind === BURST) {
          const bf = PF.burst0 + Math.min(BURST_FRAMES - 1, Math.floor(f * BURST_FRAMES));
          put(d, i, x, y, size, seed * 0.5, bf, ap[o + 10], ap[o + 11], ap[o + 12], 1);
        } else if (kind === RING) {
          const e = 1 - (1 - f) * (1 - f) * (1 - f);
          put(d, i, x, y, size * (0.25 + 0.95 * e), 0, PF.ring, ap[o + 10], ap[o + 11], ap[o + 12], (1 - f) * (1 - f) * 0.6);
        } else {
          d[i * STRIDE + 8] = 0;
        }
      }
      return d;
    }, true);
    solid.modify((d) => {
      'worklet';
      for (let i = 0; i < SOLID_CAP; i++) {
        const o = i * PS;
        const kind = sp[o];
        const age = sp[o + 5];
        if (kind === 0 || age < 0) {
          d[i * STRIDE + 8] = 0;
          continue;
        }
        const f = age / sp[o + 6];
        const x = sp[o + 1];
        const y = sp[o + 2];
        if (kind === COIN) {
          const frame = PF.coin0 + (Math.floor(age * 30 + sp[o + 13] * COIN_FRAMES) % COIN_FRAMES);
          const homing = age > COIN_HOP ? (age - COIN_HOP) / COIN_HOME : 0;
          put(d, i, x, y, coinS * sp[o + 7] * (1 - 0.45 * homing), 0, frame, 1, 1, 1, 1 - smoothstep(0.88, 1, homing));
        } else if (kind === CONFETTI) {
          // fake 3D tumble: the chip flips edge-on and back as it spins
          const tumble = 0.35 + 0.65 * Math.abs(Math.cos(age * 6 + sp[o + 13] * 7));
          put(d, i, x, y, sp[o + 7] * tumble, sp[o + 8], PF.confetti, sp[o + 10], sp[o + 11], sp[o + 12], 1 - smoothstep(0.8, 1, f));
        } else if (kind === PLUS) {
          const pop = easeOutBack(Math.min(1, f / 0.22));
          put(d, i, x, y, (cell / 110) * (0.4 + 0.6 * pop) * 1.15, 0, PF.plusOne, 1, 1, 1, 1 - smoothstep(0.65, 1, f));
        } else {
          d[i * STRIDE + 8] = 0;
        }
      }
      return d;
    }, true);
  });

  return (
    <Group>
      <SpriteLayer texture={texture} frames={atlas.frames} data={add} capacity={ADD_CAP} blendMode="plus" />
      <SpriteLayer texture={texture} frames={atlas.frames} data={solid} capacity={SOLID_CAP} />
    </Group>
  );
});
