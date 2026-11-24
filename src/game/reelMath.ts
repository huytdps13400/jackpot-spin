/**
 * Pure reel kinematics. Every function is a worklet so the same code runs in Jest (plain JS)
 * and on the UI thread inside the frame callback.
 *
 * Reel space: `x` is a continuous offset measured in "slots". The number under the centre
 * window is `wrap(round(x)) + 1`, so the strip is the infinite sequence 1..100, 1..100, ...
 */

export const REEL_SIZE = 100;

/** Euclidean modulo — always returns 0..m-1 even for negative input. */
export function wrap(value: number, m?: number) {
  'worklet';
  // default inlined: worklets do not capture identifiers used in parameter defaults
  const mod = m ?? 100;
  return ((value % mod) + mod) % mod;
}

/** 0-based index shown in the centre window for a reel offset. */
export function indexAt(x: number) {
  'worklet';
  return wrap(Math.round(x));
}

/**
 * Smallest integer position F >= from such that the reel shows `target` there.
 */
export function nextAligned(from: number, target: number) {
  'worklet';
  const base = Math.ceil(from);
  return base + wrap(target - wrap(base));
}

/**
 * The custom spin easing.
 *
 * Its velocity profile is a Beta(2, 5) curve v(u) = 30·u·(1-u)^4:
 *  - starts from rest (no jerk on launch),
 *  - peaks early at u = 0.2 (the reel "catches" quickly),
 *  - then decays with a 5th-order tail, which is what produces the long, suspenseful crawl
 *    over the last few numbers before the stop.
 * Integrated and normalised: E(u) = 15u² − 40u³ + 45u⁴ − 24u⁵ + 5u⁶, with E(0)=0, E(1)=1,
 * E'(0)=E'(1)=0 and E''(1)=0 (it arrives with zero velocity *and* zero acceleration).
 */
export function spinEase(u: number) {
  'worklet';
  const t = Math.min(1, Math.max(0, u));
  const t2 = t * t;
  return t2 * (15 + t * (-40 + t * (45 + t * (-24 + 5 * t))));
}

/** Derivative of spinEase w.r.t. u (used by tests and for peak-speed maths). */
export function spinEaseVelocity(u: number) {
  'worklet';
  const t = Math.min(1, Math.max(0, u));
  return 30 * t * Math.pow(1 - t, 4);
}

/**
 * Quintic hand-off curve used whenever motion must start from an existing velocity
 * (finger flick, quick-stop): position x(s) for s in [0,1] with
 * x(0)=0, x'(0)=V, x''(0)=0, x(1)=D, x'(1)=0, x''(1)=0.
 * `V` is the initial velocity expressed in "slots per whole duration" (v0 · T).
 * The curve is monotonic (never runs backwards) for 0 <= V <= 2.5·D.
 */
export function handoffPosition(s: number, D: number, V: number) {
  'worklet';
  const t = Math.min(1, Math.max(0, s));
  const c3 = 10 * D - 6 * V;
  const c4 = -15 * D + 8 * V;
  const c5 = 6 * D - 3 * V;
  return V * t + t * t * t * (c3 + t * (c4 + t * c5));
}

export function handoffVelocity(s: number, D: number, V: number) {
  'worklet';
  const t = Math.min(1, Math.max(0, s));
  const c3 = 10 * D - 6 * V;
  const c4 = -15 * D + 8 * V;
  const c5 = 6 * D - 3 * V;
  return V + t * t * (3 * c3 + t * (4 * c4 + t * 5 * c5));
}

/** Overshoot past the final notch, in slots, before the detent spring pulls the reel back. */
export const OVERSHOOT = 0.22;

/**
 * Detent settle: starts at +OVERSHOOT with zero velocity and rings down to 0
 * (under-damped spring, zeta 0.42, 3.4 Hz).
 */
export function settleOffset(ms: number) {
  'worklet';
  const zeta = 0.42;
  const omega = 2 * Math.PI * 3.4;
  const t = ms / 1000;
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const decay = Math.exp(-zeta * omega * t);
  return OVERSHOOT * decay * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
}

export type HandoffPlan = {
  /** Position to jump to before starting (differs from x only when the strip is re-phased). */
  startX: number;
  /** Integer position the reel will lock on. */
  final: number;
  /** Duration in ms. */
  duration: number;
  /** Distance to travel including overshoot (slots). */
  distance: number;
  /** v0·T in slots (see handoffPosition). */
  velocityTerm: number;
};

/**
 * Quick-stop ("slam stop") planner.
 *
 * The result was already decided when the spin started; quick-stop only shortens the time it
 * takes to get there. At high speed the numbers are a blur, so — exactly like video slot
 * machines — we re-phase the strip by an integer number of slots while it is unreadable. That
 * lets us brake in ~0.45 s regardless of where the target is on the strip, with a velocity-
 * continuous curve (no visible jerk). At low speed we simply brake to the next occurrence.
 */
export const QUICK_STOP_REPHASE_SPEED = 25; // slots/s — above this the digits are unreadable

export function planQuickStop(
  x: number,
  v: number,
  target: number,
  plannedFinal: number,
): HandoffPlan {
  'worklet';
  const speed = Math.max(0, v);
  if (speed > QUICK_STOP_REPHASE_SPEED) {
    const brakeSeconds = 0.45;
    const natural = (speed * brakeSeconds) / 2; // distance covered by the V = 2D profile
    const candidate = Math.ceil(x + natural - OVERSHOOT);
    const shift = wrap(target - wrap(candidate));
    const startX = x + shift;
    const final = candidate + shift;
    const distance = final + OVERSHOOT - startX;
    const duration = ((2 * distance) / speed) * 1000;
    return { startX, final, duration, distance, velocityTerm: (speed * duration) / 1000 };
  }
  // Slow tail: the planned stop is only a few slots away — just brake into it faster.
  const final =
    plannedFinal + OVERSHOOT > x + 0.05
      ? plannedFinal
      : nextAligned(x + 0.6 - OVERSHOOT, target);
  const distance = final + OVERSHOOT - x;
  const raw = speed > 0.5 ? ((2 * distance) / speed) * 1000 : 500;
  const duration = Math.min(Math.max(raw, 300), 900);
  const velocityTerm = Math.min((speed * duration) / 1000, 2.4 * distance);
  return { startX: x, final, duration, distance, velocityTerm };
}

/**
 * Flick planner: hands the finger's velocity to the reel "motor". Distance is chosen so the
 * quintic stays monotonic (V <= 2.2·D) and the spin lasts long enough to feel like a spin.
 */
export function planFlick(x: number, v: number, target: number): HandoffPlan {
  'worklet';
  const durationS = 3.2;
  const V = Math.max(0, v) * durationS;
  const minDistance = Math.max(V / 2.2, 90);
  const final = nextAligned(x + minDistance - OVERSHOOT, target);
  const distance = final + OVERSHOOT - x;
  return { startX: x, final, duration: durationS * 1000, distance, velocityTerm: V };
}

/**
 * A tapped spin is two stages joined with matching velocity:
 *  1. **cruise** (`spinCruise`): launch, blur and brake over all but the last CRAWL_SLOTS slots,
 *     arriving at a readable CRAWL_SPEED instead of stopping;
 *  2. **crawl** (`crawlVelocity` / `crawlStep`): the suspense. Speed is a function of the
 *     distance already crawled, decaying exponentially, so each number takes a fixed ratio
 *     (~1.13×) longer than the one before: 190 → 210 → 240 → 280 → 320 → 360 → 410 → 470 ms…,
 *     never a plateau. A terminal factor only bites over the last slot, bringing the reel to
 *     rest exactly at the overshoot point; the pin struggle (`finalStruggle`) rides on top, so
 *     the reel nearly stalls on the pin before the winner and then tips over.
 */
export const CRAWL_SLOTS = 10;
export const CRAWL_SPEED = 6; // slots/s at the hand-off: every number is readable
/** Exponential decay of crawl speed per slot travelled: e^0.12 ≈ 1.13× slower per number. */
export const CRAWL_DECAY = 0.12;
/** How late the terminal brake starts (higher = later, sharper). */
const CRAWL_END = 16;

/** Crawl speed (slots/s) after `p` slots of a crawl that ends (at rest) after `D` slots. */
export function crawlVelocity(p: number, D: number) {
  'worklet';
  const r = Math.max(0, 1 - Math.pow(Math.max(0, p) / D, CRAWL_END));
  return CRAWL_SPEED * Math.exp(-CRAWL_DECAY * p) * Math.sqrt(r);
}

/**
 * Advances the crawl by `dtMs` (fixed 4 ms sub-steps, so the timing doesn't depend on the frame
 * rate). Reaches `D` in finite time and returns exactly `D` there.
 */
export function crawlStep(p: number, D: number, dtMs: number) {
  'worklet';
  let q = p;
  let left = dtMs;
  while (left > 0) {
    const h = Math.min(4, left);
    q += (crawlVelocity(q, D) * h) / 1000;
    if (D - q < 1e-3) return D;
    left -= h;
  }
  return q;
}

/**
 * Cruise easing: spinEase blended with u²(2−u), which ends with slope 1, so the curve leaves
 * at velocity h (in "distance per duration") instead of zero. Monotonic for 0 ≤ h ≤ 1.
 */
export function spinCruise(u: number, h: number) {
  'worklet';
  const t = Math.min(1, Math.max(0, u));
  const t2 = t * t;
  return (1 - h) * t2 * (15 + t * (-40 + t * (45 + t * (-24 + 5 * t)))) + h * t2 * (2 - t);
}

export function spinCruiseVelocity(u: number, h: number) {
  'worklet';
  const t = Math.min(1, Math.max(0, u));
  return (1 - h) * 30 * t * Math.pow(1 - t, 4) + h * t * (4 - 3 * t);
}

/** Plan for a tapped spin after the wind-up (cruise, then crawl into the final notch). */
export function planSpin(x: number, target: number) {
  'worklet';
  const final = nextAligned(x + 110, target);
  const distance = final + OVERSHOOT - x;
  const crawl = CRAWL_SLOTS + OVERSHOOT;
  const cruise = distance - crawl;
  const duration = 2100 + (distance - 110) * 6; // cruise: 2.1 s .. ~2.7 s
  const h = (CRAWL_SPEED * duration) / 1000 / cruise;
  return { final, distance, cruise, duration, h, crawl };
}

/**
 * The pin struggle. Near the last pins the wheel presses against the pointer's flapper, nearly
 * stalls, then the pin slips past and the wheel lurches on. A displacement added to the reel
 * position: a Gaussian dip centred just before the pin, so the reel lags behind its curve on
 * the approach and catches up right after. Slope stays above −1 (A/σ < 1.16), so the reel never
 * runs backwards. `p` = reel position relative to the pin, in slots.
 */
export function pinStruggle(p: number, amplitude: number) {
  'worklet';
  const sigma = 0.2;
  const q = (p + 0.06) / sigma;
  return -amplitude * Math.exp(-q * q);
}

/** Struggle at the last two pins before `final` (the last one hardest). */
export function finalStruggle(x: number, final: number) {
  'worklet';
  return pinStruggle(x - (final - 0.5), 0.22) + pinStruggle(x - (final - 1.5), 0.09);
}
