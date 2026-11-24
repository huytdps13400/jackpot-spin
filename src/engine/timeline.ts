/** Reel phases (UI-thread state machine). Numbers, not strings: they live in shared values. */
export const Phase = {
  Idle: 0,
  WindUp: 1,
  Spin: 2,
  /** Velocity hand-off curve: finger flick or quick-stop. */
  Handoff: 3,
  /** Detent spring after the overshoot; the "lock" fires on the first notch crossing. */
  Settle: 4,
  Drag: 5,
  /** Small snap back to the nearest notch after a drag that was too slow to spin. */
  Snap: 6,
  /** The tapped spin's suspense tail: each number slower than the last, into the final pin. */
  Crawl: 7,
} as const;

export const WINDUP_MS = 200;
export const WINDUP_SLOTS = 0.32;
export const SETTLE_MS = 480;
/** Quick-stop is honoured only once the reel has visibly got going (slot-game convention). */
export const MIN_SPIN_BEFORE_STOP_MS = 420;
export const FLICK_MIN_SPEED = 5; // slots/s
/** Pin ticks (haptic + click) fire below this speed; above it the numbers are a blur. */
export const TICK_MAX_SPEED = 30; // slots/s
/** …and never closer than this: the Taptic Engine blurs faster pulses into a buzz. */
export const TICK_MIN_GAP_MS = 55;

/**
 * Reveal timeline, in ms after the reel locks. One clock drives every reward beat, so the
 * reel → gold drop → impact chain can never drift out of sync.
 */
export const Reveal = {
  None: -1,
  FormStart: 90, // the winning number lifts off the wheel and charges up
  FormEnd: 300, // …and launches along an arc towards its cell
  DropEnd: 780, // it lands → hit-stop begins
  HitStopEnd: 850, // world resumes: burst, shockwave, fill
  Commit: 870, // result written to the store (the only React render of the spin)
  ChipIn: 920,
  CollectStart: 950, // coins leave the cell for the counter
  SegmentStart: 1000,
  LineStart: 1000, // completed row / column / diagonal sweeps
  FillEnd: 1350,
  CountStart: 1560, // first coin reaches the counter → odometer rolls
  CollectEnd: 1900,
  SegmentEnd: 1700,
  Steady: 3000,
} as const;

export const ResultKindCode = { New: 0, Repeat: 1, Complete: 2 } as const;

/** Line ids for `lineHits` (bit i): rows 0–9, columns 10–19, diagonal 20, anti-diagonal 21. */
export const LINE_DIAG = 20;
export const LINE_ANTI = 21;

/** Cells (0-based) of a line id. */
export function lineCells(id: number) {
  'worklet';
  const out: number[] = [];
  for (let k = 0; k < 10; k++) {
    if (id < 10) out.push(id * 10 + k);
    else if (id < 20) out.push(k * 10 + (id - 10));
    else if (id === LINE_DIAG) out.push(k * 11);
    else out.push(k * 10 + (9 - k));
  }
  return out;
}

/** Bitmask of lines through `idx` that are complete in `mask`. */
export function completedLines(mask: number[], idx: number) {
  'worklet';
  const row = Math.floor(idx / 10);
  const col = idx % 10;
  let hits = 0;
  let r = 1;
  let c = 1;
  let d = row === col ? 1 : 0;
  let a = row + col === 9 ? 1 : 0;
  for (let k = 0; k < 10; k++) {
    r &= mask[row * 10 + k];
    c &= mask[k * 10 + col];
    if (d) d &= mask[k * 11];
    if (a) a &= mask[k * 10 + (9 - k)];
  }
  if (r) hits |= 1 << row;
  if (c) hits |= 1 << (10 + col);
  if (d) hits |= 1 << LINE_DIAG;
  if (a) hits |= 1 << LINE_ANTI;
  return hits;
}
