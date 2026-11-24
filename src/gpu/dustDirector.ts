import { REVEAL_AT, revealPeak } from '../components/stage/TreasureReveal';
import { ResultKindCode, Reveal } from '../engine/timeline';
import { TREASURE_TIER, TREASURES } from '../game/treasure';
import type { StageLayout } from '../theme/layout';
import { makeFrameScratch, type FrameScratch } from './dustGpu';
import {
  AMBIENT,
  COUNT,
  EMITTER_FLOATS,
  HEADER_FLOATS,
  MAX_EMIT,
  Pal,
  PARAM_FLOATS,
  POOL,
  Prog,
  PROG_MAX_LIFE,
} from './dustShaders';

/**
 * The light layer's director (UI thread). Turns engine state (reveal clock, result kind, winning
 * cell, suspense, reel velocity) into GPU spawn requests and the per-frame uniform block. It
 * never touches particle data: every spawn is a 12-float emitter record in the uniform buffer,
 * and the compute shader initialises its own slice of the ring pool from it.
 */

export type DustState = {
  /** uniform block scratch (header + emitter records), uploaded once per frame */
  f: Float32Array;
  /** emitter records written this frame */
  n: number;
  /** ring allocator over the burst pool [AMBIENT, COUNT) */
  cursor: number;
  /** high-water mark: particles [0, hw) may be alive; compute and draw cover only that */
  hw: number;
  clock: number;
  lastClock: number;
  lastR: number;
  /** engine clock (ms) after which every burst particle is dead */
  /** simulated time (ms): the engine clock advanced by the same clamped dt the GPU integrates with */
  sim: number;
  burstUntil: number;
  /** canvas holds something that would need clearing */
  armed: boolean;
  /** ambient motes fade (0..1) */
  amb: number;
  streamAcc: number;
  sparkleAcc: number;
  rainAcc: number;
  lootAcc: number;
  /** ms since the jackpot fireworks started (-1: none) */
  fwT: number;
  /** QA replay (globalThis.__gpu.burst) */
  qaSeq: number;
  qaR: number;
  qaKind: number;
  qaCell: number;
  /** outputs for the encoder */
  bursts: boolean;
  motes: boolean;
  scratch: FrameScratch;
};

export function makeDustState(): DustState {
  'worklet';
  return {
    f: new Float32Array(PARAM_FLOATS),
    n: 0,
    cursor: AMBIENT,
    hw: AMBIENT,
    clock: 0,
    lastClock: -1,
    lastR: -1,
    sim: 0,
    burstUntil: -1,
    armed: false,
    amb: 0,
    streamAcc: 0,
    sparkleAcc: 0,
    rainAcc: 0,
    lootAcc: 0,
    fwT: -1,
    qaSeq: -1,
    qaR: -1,
    qaKind: 0,
    qaCell: 0,
    bursts: false,
    motes: false,
    scratch: makeFrameScratch(),
  };
}

/** Loot-beam mote colour per treasure (gold for gold things, the stone's own light for gems). */
const LOOT_PAL: readonly number[] = TREASURES.map((t) =>
  t.id === 'emerald'
    ? Pal.Emerald
    : t.id === 'sapphire'
      ? Pal.Azure
      : t.id === 'amethyst'
        ? Pal.Lavender
        : t.id === 'ruby'
          ? Pal.Rose
          : t.id === 'diamond'
            ? Pal.Ice
            : Pal.Gold,
);

/** Stream of motes from the cell into the counter: emitted CollectStart → STREAM_END. */
const STREAM_END = 1320;
const BLOOM_GAIN = 0.45;

// ── jackpot fireworks: shells rise from the board and pop into ring bursts ──
/** launch time (ms after the impact), flight time (s) */
const SHELL_AT = [120, 380, 640, 940, 1240, 1640];
const SHELL_T = [0.78, 0.72, 0.86, 0.7, 0.8, 0.92];
/** launch x (fraction of the board width) → burst point (fraction of the screen) */
const SHELL_FX = [0.2, 0.8, 0.5, 0.32, 0.68, 0.5];
const SHELL_BX = [0.24, 0.76, 0.5, 0.35, 0.65, 0.5];
const SHELL_BY = [0.17, 0.21, 0.1, 0.28, 0.15, 0.19];
/** outer ring palette, inner ring palette, ring speed (pt/s) */
const SHELL_PAL = [Pal.Gold, Pal.Rose, Pal.Ice, Pal.Gold, Pal.Rose, Pal.Gold];
const SHELL_PAL2 = [Pal.Ice, Pal.Gold, Pal.Gold, Pal.Rose, Pal.Ice, Pal.Rose];
const SHELL_SPEED = [230, 215, 255, 200, 235, 300];
const SHELL_G = 420;
const RAIN_START = 1100;
const RAIN_END = 4100;
const FW_END = RAIN_END + 200;

function cellX(L: StageLayout, i: number) {
  'worklet';
  return L.grid.x + (i % 10) * (L.cellW + L.gap) + L.cellW / 2;
}

function cellY(L: StageLayout, i: number) {
  'worklet';
  return L.grid.y + Math.floor(i / 10) * (L.cell + L.gap) + L.cell / 2;
}

/** Where the gold lands: the odometer digits of the "CELLS CLAIMED" panel (same as the Skia coins). */
function counterX(L: StageLayout) {
  'worklet';
  return L.panel.x + L.panel.width * 0.66;
}

function counterY(L: StageLayout) {
  'worklet';
  return L.panel.y + L.panel.height * 0.5;
}

/**
 * Queues one spawn request: `count` particles of program `prog` at (x, y).
 * b2/b3, pal, size, life, extra are program parameters (see SIM_WGSL `spawn`).
 */
function emit(
  st: DustState,
  prog: number,
  count: number,
  x: number,
  y: number,
  b2: number,
  b3: number,
  pal: number,
  size: number,
  life: number,
  extra: number,
) {
  'worklet';
  const n = Math.min(Math.floor(count), POOL);
  if (st.n >= MAX_EMIT || n < 1) return;
  let start = st.cursor;
  if (start + n > COUNT) start = AMBIENT;
  st.cursor = start + n;
  if (st.cursor > st.hw) st.hw = st.cursor;
  const o = HEADER_FLOATS + st.n * EMITTER_FLOATS;
  const f = st.f;
  f[o] = start;
  f[o + 1] = n;
  f[o + 2] = prog;
  f[o + 3] = Math.random();
  f[o + 4] = x;
  f[o + 5] = y;
  f[o + 6] = b2;
  f[o + 7] = b3;
  f[o + 8] = pal;
  f[o + 9] = size;
  f[o + 10] = life;
  f[o + 11] = extra;
  st.n += 1;
  const until = st.sim + PROG_MAX_LIFE[prog] * life * 1000 + 120;
  if (until > st.burstUntil) st.burstUntil = until;
}

/** New cell: fine spark ring + gold dust on the curl flow + lingering glitter. No central flash (Skia owns the impact flare). */
function burst(st: DustState, L: StageLayout, x: number, y: number, complete: boolean, reduce: boolean) {
  'worklet';
  const c = L.cell;
  if (reduce) {
    emit(st, Prog.Ember, complete ? 40 : 24, x, y, 0.3, c * 0.15, Pal.Gold, 1, 1, 0);
    emit(st, Prog.Glitter, complete ? 30 : 12, x, y, 0.25, c * 0.2, Pal.Gold, 1, 1, 0);
    return;
  }
  emit(st, Prog.Spark, complete ? 260 : 160, x, y, complete ? 1.3 : 1, c * 0.14, Pal.Gold, 1, 1, 0);
  emit(st, Prog.Ember, complete ? 280 : 180, x, y, complete ? 1.25 : 1, c * 0.16, Pal.Gold, 1, 1, 0);
  emit(st, Prog.Glitter, complete ? 160 : 90, x, y, complete ? 1.2 : 1, c * 0.2, Pal.Gold, 1, 1, 0);
}

/** Repeat (already claimed): a small soft lavender/silver puff, nothing more. */
function puff(st: DustState, L: StageLayout, x: number, y: number, reduce: boolean) {
  'worklet';
  emit(st, Prog.Puff, reduce ? 10 : 36, x, y, reduce ? 0.5 : 1, L.cell * 0.35, Pal.Lavender, 1, 1, 0);
}

/** Reveal-timeline beats for one result (engine spin or QA replay), from rPrev → r (ms after lock). */
function beats(
  st: DustState,
  L: StageLayout,
  rPrev: number,
  r: number,
  kind: number,
  cell: number,
  treasure: number,
  reduce: boolean,
  dtSec: number,
) {
  'worklet';
  if (cell < 0 || cell > 99) return;
  const x = cellX(L, cell);
  const y = cellY(L, cell);
  const repeat = kind === ResultKindCode.Repeat;
  const complete = kind === ResultKindCode.Complete;
  // a jump of the reveal clock (skip / new spin flushing the old one) never replays stale beats
  const step = r - rPrev;
  if (step <= 0 || step > 200) return;

  if (rPrev < Reveal.HitStopEnd && r >= Reveal.HitStopEnd) {
    st.streamAcc = 0;
    st.sparkleAcc = 0;
    if (repeat) {
      puff(st, L, x, y, reduce);
    } else {
      burst(st, L, x, y, complete, reduce);
      if (complete && !reduce) {
        st.fwT = 0;
        st.rainAcc = 0;
      }
    }
  }
  if (repeat || reduce) return;

  // loot beam (Skia LootBeam): motes in the treasure's colour climb it while the treasure is
  // presented; a first handful is thrown up fast as the beam shoots
  const tier = treasure >= 0 ? TREASURE_TIER[treasure] : 1;
  const pal = treasure >= 0 ? LOOT_PAL[treasure] : Pal.Gold;
  const lootEnd = REVEAL_AT + (treasure >= 0 ? revealPeak(treasure).fallAt : 380);
  const by = y + L.cell * 0.12;
  if (rPrev < REVEAL_AT && r >= REVEAL_AT) {
    st.lootAcc = 0;
    emit(st, Prog.Rise, 28 + 18 * tier, x, by, 1.7, L.cell * 0.2, pal, 1.15, 0.8, 0);
  }
  if (r >= REVEAL_AT && rPrev < lootEnd) {
    st.lootAcc += (70 + 45 * tier) * dtSec;
    const n = Math.floor(st.lootAcc);
    if (n > 0) {
      st.lootAcc -= n;
      emit(st, Prog.Rise, n, x, by, 1, L.cell * (0.26 + 0.05 * tier), pal, 1 + 0.12 * tier, 1, 0);
    }
  }

  const tx = counterX(L);
  const ty = counterY(L);
  // the gold pours into the counter: motes leave the cell on a curved path and arrive between
  // CountStart (first one) and CollectEnd (last one)
  if (r >= Reveal.CollectStart && rPrev < STREAM_END) {
    st.streamAcc += (complete ? 420 : 300) * dtSec;
    const n = Math.floor(st.streamAcc);
    if (n > 0) {
      st.streamAcc -= n;
      const s = Math.min(r, STREAM_END);
      const arrive =
        Reveal.CountStart +
        ((s - Reveal.CollectStart) * (Reveal.CollectEnd - Reveal.CountStart)) / (STREAM_END - Reveal.CollectStart);
      const travel = Math.max(0.25, (arrive - r) / 1000);
      // bulge outwards (away from the screen centre line), so the stream reads as an arc
      const side = x <= tx ? 1 : -1;
      emit(st, Prog.Stream, n, x, y, 0, L.cell * 0.5, Pal.Gold, 1, travel, side * 0.3);
    }
  }
  if (rPrev < Reveal.CountStart && r >= Reveal.CountStart) {
    emit(st, Prog.Ember, 50, tx, ty, 0.5, 18, Pal.Gold, 0.9, 0.7, 0);
  }
  if (r >= Reveal.CountStart && rPrev < Reveal.CollectEnd) {
    st.sparkleAcc += 200 * dtSec;
    const n = Math.floor(st.sparkleAcc);
    if (n > 0) {
      st.sparkleAcc -= n;
      emit(st, Prog.Sparkle, n, tx, ty, 1, L.panel.width * 0.22, Pal.Gold, 1, 1, 0);
    }
  }
}

/** Jackpot fireworks + glitter rain, on their own clock (they outlast the reveal timeline). */
function fireworks(st: DustState, L: StageLayout, dtMs: number) {
  'worklet';
  if (st.fwT < 0 || dtMs <= 0) return;
  const prev = st.fwT;
  const now = prev + dtMs;
  st.fwT = now;
  const dtSec = dtMs / 1000;
  const y0 = L.grid.y + L.grid.height;
  for (let i = 0; i < SHELL_AT.length; i++) {
    const at = SHELL_AT[i];
    const T = SHELL_T[i];
    const end = at + T * 1000;
    if (now < at || prev >= end) continue;
    const x0 = L.grid.x + L.grid.width * SHELL_FX[i];
    const xb = L.width * SHELL_BX[i];
    const yb = L.height * SHELL_BY[i];
    // exact ballistic solve: reach (xb, yb) after T seconds under gravity
    const vx = (xb - x0) / T;
    const vy = (yb - y0) / T - 0.5 * SHELL_G * T;
    if (prev < at) emit(st, Prog.Shell, 1, x0, y0, vx, vy, Pal.Gold, 1.6, T, SHELL_G);
    if (now < end) {
      const tau = (now - at) / 1000;
      const n = Math.floor(dtSec * 120 + Math.random());
      if (n > 0) {
        emit(st, Prog.Trail, n, x0 + vx * tau, y0 + vy * tau + 0.5 * SHELL_G * tau * tau, 0, 0, Pal.Gold, 1, 1, 0);
      }
    } else {
      const big = i === SHELL_AT.length - 1;
      const pal = SHELL_PAL[i];
      emit(st, Prog.Flash, 1, xb, yb, 0, 0, pal, big ? 12 : 9, 1, big ? 0.45 : 0.32);
      emit(st, Prog.Flare, big ? 380 : 260, xb, yb, 1, SHELL_PAL2[i], pal, 1, 1, SHELL_SPEED[i]);
      emit(st, Prog.Glitter, big ? 90 : 50, xb, yb, 0.5, 6, pal, 0.8, 1.1, 0);
    }
  }
  if (now >= RAIN_START && prev < RAIN_END) {
    st.rainAcc += 380 * dtSec;
    const n = Math.floor(st.rainAcc);
    if (n > 0) {
      st.rainAcc -= n;
      emit(st, Prog.Rain, n, 0, 0, 0, 0, Pal.Mixed, 1, 1, 0);
    }
  }
  if (now > FW_END) st.fwT = -1;
}

/**
 * One director step. `clock` is the engine clock (ms; scaled by QA slow-motion, frozen during the
 * hit-stop, like the Skia layer). Fills `st.f` and sets `st.bursts` / `st.motes`.
 */
export function stepDirector(
  st: DustState,
  L: StageLayout,
  clock: number,
  reveal: number,
  kind: number,
  winIdx: number,
  tension: number,
  vel: number,
  reduce: boolean,
  qaSeq: number,
  qaKind: number,
  qaCell: number,
  camX: number,
  camY: number,
  camRot: number,
  camZoom: number,
  pivotX: number,
  pivotY: number,
  /** treasure index under the winning cell (-1: none) */
  treasure: number,
) {
  'worklet';
  const first = st.lastClock < 0;
  const dtMs = first ? 0 : Math.max(0, Math.min(40, clock - st.lastClock));
  const dtSec = dtMs / 1000;
  st.lastClock = clock;
  st.clock = clock;
  st.sim += dtMs;
  st.n = 0;

  // engine timeline
  if (!first) beats(st, L, st.lastR, reveal, kind, winIdx, treasure, reduce, dtSec);
  st.lastR = reveal;

  // QA replay: the same beats, on a private reveal clock starting just before the impact
  if (first) st.qaSeq = qaSeq;
  if (qaSeq !== st.qaSeq) {
    st.qaSeq = qaSeq;
    st.qaKind = qaKind;
    st.qaCell = qaCell;
    st.qaR = Reveal.HitStopEnd - 1;
  }
  if (st.qaR >= 0 && dtMs > 0) {
    const prev = st.qaR;
    st.qaR = Math.min(prev + dtMs, Reveal.Steady);
    beats(st, L, prev, st.qaR, st.qaKind, st.qaCell, -1, reduce, dtSec);
    if (st.qaR >= Reveal.Steady) st.qaR = -1;
  }

  if (reduce) st.fwT = -1;
  fireworks(st, L, dtMs);

  // ambient motes join the celebration only while a burst lives, then fade out and the GPU layer
  // goes fully idle — no per-frame presents at rest or during the spin (battery; a Metal layer
  // presenting for seconds on end also starves the iOS simulator's screen capture). The spin's
  // ambient sparkle is the Skia bokeh in the backdrop.
  const busy = st.sim < st.burstUntil;
  st.amb += ((reduce || !busy ? 0 : 1) - st.amb) * (1 - Math.exp(-dtMs / (busy ? 500 : 900)));
  const ten = Math.max(0, Math.min(1, tension));
  const wind = Math.max(-520, Math.min(520, -vel * L.slot * 0.24));

  const f = st.f;
  f[0] = (clock / 1000) % 1000;
  f[1] = dtSec;
  f[2] = L.width;
  f[3] = L.height;
  f[4] = 0.42 + 0.58 * ten;
  f[5] = st.amb * (0.8 + 1.1 * ten);
  f[6] = wind;
  f[7] = L.arc.pivotY;
  f[8] = L.arc.cx;
  f[9] = L.arc.numberRadius;
  f[10] = L.arc.band;
  f[11] = 0;
  f[12] = counterX(L);
  f[13] = counterY(L);
  f[14] = L.grid.x;
  f[15] = L.grid.y;
  f[16] = L.grid.x + L.grid.width;
  f[17] = L.grid.y + L.grid.height;
  f[18] = st.n;
  f[19] = BLOOM_GAIN;
  f[20] = camX;
  f[21] = camY;
  f[22] = camRot;
  f[23] = camZoom;
  f[24] = pivotX;
  f[25] = pivotY;
  f[26] = 0;
  f[27] = 0;

  st.bursts = st.sim < st.burstUntil;
  st.motes = st.amb > 0.003;
  if (!st.bursts) {
    // every burst particle is dead: restart the ring so the next burst draws a short range
    st.cursor = AMBIENT;
    st.hw = AMBIENT;
  }
}
