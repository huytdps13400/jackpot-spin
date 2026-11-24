/* eslint-disable react-hooks/immutability --
 * Reanimated shared values are mutable cells by design. Every write below happens inside a
 * worklet on the UI thread (frame callback, gesture callbacks, scheduleOnUI), never during render.
 */
import { useEffect, useMemo } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';
import { useExclusiveGestures, usePanGesture, useTapGesture } from 'react-native-gesture-handler';
import {
  Easing,
  SensorType,
  useAnimatedSensor,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets';

import { feedback } from '../feedback/feedback';
import {
  CRAWL_SLOTS,
  crawlStep,
  finalStruggle,
  handoffPosition,
  indexAt,
  OVERSHOOT,
  planFlick,
  planQuickStop,
  planSpin,
  settleOffset,
  spinCruise,
  wrap,
} from '../game/reelMath';
import { useGameStore, type ResultKind } from '../game/store';
import { boardTreasures, TREASURES } from '../game/treasure';
import {
  completedLines,
  FLICK_MIN_SPEED,
  MIN_SPIN_BEFORE_STOP_MS,
  Phase,
  ResultKindCode,
  Reveal,
  SETTLE_MS,
  TICK_MAX_SPEED,
  TICK_MIN_GAP_MS,
  WINDUP_MS,
  WINDUP_SLOTS,
} from './timeline';

// ───────────────────────── JS-thread side effects ─────────────────────────
// The UI thread *schedules* these; it never waits for them.

const KIND_NAMES: ResultKind[] = ['new', 'repeat', 'complete'];
/** Strong ease-out for press feedback: the movement lands on the frame the finger does. */
const PRESS_EASE = Easing.bezier(0.23, 1, 0.32, 1);

function onSpinStart() {
  useGameStore.getState().startSpin();
}
function onTick(level: number) {
  feedback.tick(level);
}
function onNewBoard() {
  useGameStore.getState().resetBoard();
}
function onLock() {
  feedback.lock();
}
function onImpact(kind: number) {
  feedback.impact(KIND_NAMES[kind] ?? 'new');
}
function onCommit(n: number) {
  const store = useGameStore.getState();
  const found = TREASURES[boardTreasures(store.boardSeed)[n - 1]].name;
  const kind = store.commitResult(n);
  AccessibilityInfo.announceForAccessibility(
    kind === 'repeat'
      ? `${n}, already claimed`
      : kind === 'complete'
        ? `${n} claimed: ${found}. Board complete!`
        : `${n} claimed: ${found}`,
  );
}

export type SpinEngine = ReturnType<typeof useSpinEngine>;

/**
 * The game loop. A single `useFrameCallback` on the UI thread advances the reel state machine,
 * the reward timeline and the ambient clock. Rendering components only *derive* from these
 * shared values, so a whole spin (≈5 s, 300+ frames) causes zero React renders; the store is
 * written exactly once per spin, at `Reveal.Commit`.
 */
export function useSpinEngine(slot: number) {
  const reduceMotionPref = useReducedMotion();
  const initial = useMemo(() => {
    const { history, won, lastKind } = useGameStore.getState();
    const last = history.length ? history[history.length - 1] - 1 : -1;
    return {
      x: last >= 0 ? last : 0,
      winIdx: last,
      kind: lastKind === 'repeat' ? ResultKindCode.Repeat : lastKind === 'complete' ? ResultKindCode.Complete : ResultKindCode.New,
      claimed: won.length,
      segFrom: won.length >= 2 ? won[won.length - 2] - 1 : -1,
      segTo: won.length >= 1 ? won[won.length - 1] - 1 : -1,
    };
  }, []);

  // reel
  const phase = useSharedValue<number>(Phase.Idle);
  const x = useSharedValue(initial.x);
  const vel = useSharedValue(0);
  const t = useSharedValue(0);
  const p0 = useSharedValue(0);
  const dist = useSharedValue(0);
  const dur = useSharedValue(1);
  const vTerm = useSharedValue(0);
  const finalPos = useSharedValue(0);
  const target = useSharedValue(0);
  /** Tapped spin: cruise end-slope and the crawl hand-off that follows it (see planSpin). */
  const cruiseH = useSharedValue(0);
  /** Slots travelled in the crawl so far (see reelMath.crawlStep). */
  const crawlP = useSharedValue(0);
  /** QA only: forces the next result (set by the hidden "fill 99" helper). */
  const forcedTarget = useSharedValue(-1);
  const stopQueued = useSharedValue(false);
  const braking = useSharedValue(false);
  const locked = useSharedValue(true);
  const dragStart = useSharedValue(0);
  const lastTickIdx = useSharedValue(-1);
  const lastTickAt = useSharedValue(0);

  // reward timeline
  const reveal = useSharedValue<number>(initial.winIdx >= 0 ? Reveal.Steady : Reveal.None);
  const kind = useSharedValue<number>(initial.kind);
  /** Lines (bitmask, see timeline.ts) completed by the current result. */
  const lineHits = useSharedValue(0);
  /** Number shown on the result plate, the one it replaced, and when it swapped (clock ms). */
  const plateNum = useSharedValue(initial.winIdx + 1);
  const plateFrom = useSharedValue(0);
  const plateAt = useSharedValue(-10000);
  /** Claimed-cell count (updated at lock) and the odometer's displayed, rolling value. */
  const claimed = useSharedValue(initial.claimed);
  const countShown = useSharedValue(initial.claimed);
  const winIdx = useSharedValue(initial.winIdx);
  const segFrom = useSharedValue(initial.segFrom);
  const segTo = useSharedValue(initial.segTo);
  const segAnimated = useSharedValue(false);

  // board knowledge mirrored from the store (read on the UI thread at lock time)
  const wonMask = useSharedValue<number[]>(new Array(100).fill(0));
  /** Claimed cells (0-based) in the order they were won. Appended on the UI thread at lock
   * time so the constellation and hero tile never wait for the JS commit. */
  const order = useSharedValue<number[]>([]);
  /** Treasure index hidden under each cell (game/treasure.ts), and the previous board's while
   * the new-board wave closes its lids. */
  const treasure = useSharedValue<number[]>(boardTreasures(useGameStore.getState().boardSeed));
  const resetTreasure = useSharedValue<number[]>(new Array(100).fill(0));

  // presentation
  const clock = useSharedValue(0);
  const dim = useSharedValue(0);
  const morph = useSharedValue(0);
  const busy = useSharedValue(0);
  const chip = useSharedValue(initial.winIdx >= 0 ? 1 : 0);
  const speed = useSharedValue(0);
  /** Phase of the rail chase lights, in pt. Integrated so its speed can follow the reel. */
  const chase = useSharedValue(0);
  const pressed = useSharedValue(0);
  /** Press depth of the two side toggles (sound, haptics), 0..1. */
  const soundDown = useSharedValue(0);
  const hapticsDown = useSharedValue(0);
  const tilt = useSharedValue(0);
  /** Suspense 0..1: rises while the reel crawls through readable numbers, released at lock. */
  const tension = useSharedValue(0);
  /** Heartbeat phase (rad), integrated so its rate can climb with tension without jumping. */
  const beat = useSharedValue(0);
  /** Clock time of the last "new board" reset (-1: none) and the cells that were cleared. */
  const resetAt = useSharedValue(-1);
  const resetCells = useSharedValue<number[]>([]);
  const reduceMotion = useSharedValue(reduceMotionPref);

  // perf HUD
  const uiFps = useSharedValue(0);
  const dropped = useSharedValue(0);
  const fpsFrames = useSharedValue(0);
  const fpsTime = useSharedValue(0);
  const minDt = useSharedValue(1000);

  const gravity = useAnimatedSensor(SensorType.GRAVITY, { interval: 'auto' });

  useEffect(() => {
    reduceMotion.value = reduceMotionPref;
  }, [reduceMotionPref, reduceMotion]);

  // Mirror the persisted board into the UI runtime whenever it changes (once per spin).
  useEffect(() => {
    const sync = (won: number[]) => {
      const mask = new Array(100).fill(0);
      for (const n of won) mask[n - 1] = 1;
      wonMask.value = mask;
      order.value = won.map((n) => n - 1);
      claimed.value = won.length;
    };
    sync(useGameStore.getState().won);
    return useGameStore.subscribe((s, prev) => {
      if (s.boardSeed !== prev.boardSeed) {
        const next = boardTreasures(s.boardSeed);
        scheduleOnUI(() => {
          'worklet';
          resetTreasure.value = treasure.value;
          treasure.value = next;
        });
      }
      if (s.won !== prev.won) {
        sync(s.won);
        if (s.won.length === 0) {
          const cleared = prev.won.map((n) => n - 1);
          // new board: clear the overlays too, and play the coins back to bronze
          scheduleOnUI(() => {
            'worklet';
            resetCells.value = cleared;
            resetAt.value = cleared.length ? clock.value : -1;
            winIdx.value = -1;
            segFrom.value = -1;
            segTo.value = -1;
            reveal.value = Reveal.None;
            chip.value = 0;
            lineHits.value = 0;
            plateFrom.value = plateNum.value;
            plateNum.value = 0;
            plateAt.value = clock.value;
          });
        }
      }
    });
  }, [wonMask, order, winIdx, segFrom, segTo, reveal, chip, resetCells, resetAt, clock, claimed, lineHits, plateFrom, plateNum, plateAt, treasure, resetTreasure]);

  // ───────────────────────── UI-thread actions ─────────────────────────

  const flushReveal = () => {
    'worklet';
    // Starting a new spin mid-celebration: settle any outstanding beats immediately so the
    // result is never lost (celebrations are skippable, never blocking).
    const r = reveal.value;
    if (r >= 0 && r < Reveal.Commit) {
      if (r < Reveal.HitStopEnd) scheduleOnRN(onImpact, kind.value);
      scheduleOnRN(onCommit, target.value + 1);
    }
    if (r >= 0) reveal.value = Reveal.Steady;
  };

  const lock = () => {
    'worklet';
    locked.value = true;
    const idx = target.value;
    const mask = wonMask.value;
    let count = 0;
    for (let i = 0; i < 100; i++) count += mask[i];
    const isNew = mask[idx] === 0;
    kind.value = !isNew
      ? ResultKindCode.Repeat
      : count + 1 === 100
        ? ResultKindCode.Complete
        : ResultKindCode.New;
    if (isNew) {
      const ord = order.value;
      segFrom.value = ord.length ? ord[ord.length - 1] : -1;
      segTo.value = idx;
      segAnimated.value = true;
      order.value = [...ord, idx];
      const nextMask = mask.slice();
      nextMask[idx] = 1;
      wonMask.value = nextMask;
      claimed.value = count + 1;
      lineHits.value = completedLines(nextMask, idx);
    } else {
      lineHits.value = 0;
    }
    winIdx.value = idx;
    reveal.value = 0;
    scheduleOnRN(onLock);
  };

  const enterSettle = () => {
    'worklet';
    phase.value = Phase.Settle;
    t.value = 0;
    braking.value = false;
  };

  const startHandoff = (plan: {
    startX: number;
    final: number;
    duration: number;
    distance: number;
    velocityTerm: number;
  }) => {
    'worklet';
    x.value = plan.startX;
    p0.value = plan.startX;
    dist.value = plan.distance;
    dur.value = Math.max(plan.duration, 1);
    vTerm.value = plan.velocityTerm;
    finalPos.value = plan.final;
    phase.value = Phase.Handoff;
    t.value = 0;
  };

  const beginSpin = () => {
    'worklet';
    flushReveal();
    target.value = forcedTarget.value >= 0 ? forcedTarget.value : Math.floor(Math.random() * 100);
    forcedTarget.value = -1;
    stopQueued.value = false;
    braking.value = false;
    locked.value = false;
    scheduleOnRN(onSpinStart);
  };

  const startTapSpin = () => {
    'worklet';
    beginSpin();
    p0.value = x.value;
    phase.value = Phase.WindUp;
    t.value = 0;
  };

  const quickStop = () => {
    'worklet';
    stopQueued.value = false;
    braking.value = true;
    startHandoff(planQuickStop(x.value, vel.value, target.value, finalPos.value));
  };

  /** Single entry point for the SPIN button: spin / stop / skip depending on state. */
  const press = () => {
    'worklet';
    const ph = phase.value;
    if (ph === Phase.Idle || ph === Phase.Snap) {
      const r = reveal.value;
      if (r >= 0 && r < Reveal.DropEnd) {
        reveal.value = Reveal.DropEnd; // skip straight to the impact beat
        return;
      }
      // a full board can't produce anything but repeats: the same press deals a fresh board
      if (claimed.value >= 100) {
        scheduleOnRN(onNewBoard);
        return;
      }
      startTapSpin();
      return;
    }
    if ((ph === Phase.WindUp || ph === Phase.Spin || ph === Phase.Crawl || ph === Phase.Handoff) && !braking.value) {
      stopQueued.value = true;
    }
  };

  /** App went to background mid-spin: resolve to the result instead of freezing half-way. */
  const fastForward = () => {
    'worklet';
    const ph = phase.value;
    if (ph === Phase.WindUp) {
      finalPos.value = planSpin(x.value, target.value).final;
    }
    if (
      ph === Phase.WindUp ||
      ph === Phase.Spin ||
      ph === Phase.Crawl ||
      ph === Phase.Handoff ||
      ph === Phase.Settle
    ) {
      x.value = wrap(finalPos.value);
      phase.value = Phase.Idle;
      vel.value = 0;
      if (!locked.value) lock();
      reveal.value = Reveal.DropEnd;
    }
  };

  // ───────────────────────── the frame loop ─────────────────────────

  const timeScale = useSharedValue(1);

  useFrameCallback((info) => {
    'worklet';
    const rawDt = info.timeSincePreviousFrame ?? 16.7;
    // timeScale < 1 is a QA slow-motion (dev only) for frame-by-frame review of the beats
    const dt = Math.min(rawDt, 40) * timeScale.value;

    // perf sampling
    if (rawDt > 0 && rawDt < minDt.value) minDt.value = rawDt;
    if (rawDt > minDt.value * 1.6 && rawDt < 500) dropped.value += 1;
    fpsFrames.value += 1;
    fpsTime.value += rawDt;
    if (fpsTime.value >= 500) {
      uiFps.value = (fpsFrames.value * 1000) / fpsTime.value;
      fpsFrames.value = 0;
      fpsTime.value = 0;
    }

    const r = reveal.value;
    const inHitStop = r >= Reveal.DropEnd && r < Reveal.HitStopEnd;
    // Hit-stop: ambient time freezes for 70 ms on impact — a fighting-game trick that makes
    // the hit feel heavy.
    clock.value += inHitStop ? 0 : dt;

    const prevX = x.value;
    let rephase = 0;
    const ph = phase.value;

    if (ph === Phase.WindUp) {
      t.value += dt;
      const u = Math.min(t.value / WINDUP_MS, 1);
      // anticipation: the reel is pulled back before it launches
      x.value = p0.value - WINDUP_SLOTS * (0.5 - 0.5 * Math.cos(Math.PI * u));
      if (u >= 1) {
        const plan = planSpin(x.value, target.value);
        p0.value = x.value;
        dist.value = plan.cruise;
        dur.value = plan.duration;
        cruiseH.value = plan.h;
        finalPos.value = plan.final;
        phase.value = Phase.Spin;
        t.value = 0;
      }
    } else if (ph === Phase.Spin) {
      t.value += dt;
      const u = Math.min(t.value / dur.value, 1);
      // cruise: launch, blur, brake to a readable speed (see planSpin)
      x.value = p0.value + dist.value * spinCruise(u, cruiseH.value);
      if (stopQueued.value && t.value > MIN_SPIN_BEFORE_STOP_MS && u < 0.97) {
        const before = x.value;
        quickStop();
        rephase = x.value - before;
      } else if (u >= 1) {
        // …then the crawl: the last numbers tick past slower and slower
        p0.value = x.value;
        dist.value = finalPos.value + OVERSHOOT - x.value;
        crawlP.value = 0;
        phase.value = Phase.Crawl;
        t.value = 0;
      }
    } else if (ph === Phase.Crawl) {
      t.value += dt;
      crawlP.value = crawlStep(crawlP.value, dist.value, dt);
      const xs = p0.value + crawlP.value;
      // the last pins fight the pointer's flapper before slipping past
      x.value = xs + finalStruggle(xs, finalPos.value);
      if (stopQueued.value && !braking.value) {
        // impatient player: brake the rest of the way (the crawl is already slow, no re-phase)
        quickStop();
      } else if (crawlP.value >= dist.value) {
        enterSettle();
      }
    } else if (ph === Phase.Handoff) {
      t.value += dt;
      const s = Math.min(t.value / dur.value, 1);
      x.value = p0.value + handoffPosition(s, dist.value, vTerm.value);
      // the last pins fight the pointer's flapper before slipping past (not on a slam-stop)
      if (!braking.value) x.value += finalStruggle(x.value, finalPos.value);
      if (stopQueued.value && !braking.value && t.value > MIN_SPIN_BEFORE_STOP_MS && s < 0.95) {
        const before = x.value;
        quickStop();
        rephase = x.value - before;
      } else if (s >= 1) {
        if (braking.value || !locked.value) enterSettle();
        else phase.value = Phase.Idle;
      }
    } else if (ph === Phase.Settle) {
      t.value += dt;
      const off = settleOffset(t.value);
      x.value = finalPos.value + off;
      if (!locked.value && off <= 0) lock();
      if (t.value >= SETTLE_MS) {
        if (!locked.value) lock();
        x.value = wrap(finalPos.value); // keep the float small forever
        phase.value = Phase.Idle;
      }
    } else if (ph === Phase.Snap) {
      t.value += dt;
      const s = Math.min(t.value / dur.value, 1);
      x.value = p0.value + handoffPosition(s, dist.value, vTerm.value);
      if (s >= 1) {
        x.value = wrap(Math.round(x.value));
        phase.value = Phase.Idle;
      }
    }

    // velocity (slots/s), ignoring the integer re-phase jump of a quick-stop
    const instV = ((x.value - prevX - rephase) / Math.max(dt, 1)) * 1000;
    vel.value = ph === Phase.Idle ? 0 : vel.value * 0.35 + instV * 0.65;
    const absV = Math.abs(vel.value);

    // detent ticks while the reel is slow enough to read
    const idx = indexAt(x.value);
    if (idx !== lastTickIdx.value) {
      lastTickIdx.value = idx;
      const moving = ph === Phase.Spin || ph === Phase.Crawl || ph === Phase.Handoff || ph === Phase.Drag;
      if (moving && absV < TICK_MAX_SPEED && clock.value - lastTickAt.value > TICK_MIN_GAP_MS) {
        lastTickAt.value = clock.value;
        // Every pin is felt, and the pins get heavier the closer the wheel is to its stop, so the
        // hand counts down the last numbers: ratchet (selection) while braking from the blur →
        // light clicks through the crawl → medium knocks on the last three → a heavy thunk as
        // the winner's pin slips past. Drags/flicks use the plain ratchet.
        const left = ph === Phase.Spin || ph === Phase.Crawl ? finalPos.value - x.value : 99;
        scheduleOnRN(onTick, left < 0.6 ? 3 : left < 3.6 ? 2 : left < CRAWL_SLOTS + 0.6 ? 1 : 0);
      }
    }

    // reward timeline
    if (r >= 0 && r < Reveal.Steady) {
      const next = Math.min(r + dt, Reveal.Steady);
      if (r < Reveal.HitStopEnd && next >= Reveal.HitStopEnd) {
        scheduleOnRN(onImpact, kind.value);
        plateFrom.value = plateNum.value;
        plateNum.value = target.value + 1;
        plateAt.value = clock.value;
      }
      if (r < Reveal.Commit && next >= Reveal.Commit) scheduleOnRN(onCommit, target.value + 1);
      reveal.value = next;
    }

    // smoothed presentation channels (frame-rate independent exponential approach)
    const k = (tau: number) => 1 - Math.exp(-dt / tau);
    const spinning = ph === Phase.WindUp || ph === Phase.Spin || ph === Phase.Crawl || ph === Phase.Handoff;
    const revealPending = reveal.value >= 0 && reveal.value < Reveal.HitStopEnd;
    const dimTarget = spinning || ph === Phase.Settle || ph === Phase.Drag || revealPending ? 1 : 0;
    dim.value += (dimTarget - dim.value) * k(140);
    const morphTarget = spinning && !braking.value ? 1 : 0;
    morph.value += (morphTarget - morph.value) * k(90);
    const busyTarget = (spinning && braking.value) || ph === Phase.Settle || revealPending ? 1 : 0;
    busy.value += (busyTarget - busy.value) * k(90);
    const chipTarget =
      !spinning && ph !== Phase.Settle && reveal.value >= Reveal.ChipIn && winIdx.value >= 0
        ? 1
        : 0;
    chip.value += (chipTarget - chip.value) * k(chipTarget ? 120 : 60);
    speed.value += (Math.min(absV / 100, 1) - speed.value) * k(200);
    // odometer: holds the old count until the first collected coin lands, then rolls
    const pendingCount =
      reveal.value >= 0 && reveal.value < Reveal.CountStart && kind.value !== ResultKindCode.Repeat ? 1 : 0;
    const countTarget = claimed.value - pendingCount;
    const dc = countTarget - countShown.value;
    countShown.value = Math.abs(dc) < 0.004 ? countTarget : countShown.value + dc * k(dc > 0 ? 130 : 70);

    // Suspense. Honest by construction: it is a pure function of the reel's real speed, so
    // every spin builds the same way — it rises only after the velocity peak, as the numbers
    // become readable (≈9 → 2 slots/s), holds through the settle and snaps off at lock.
    let tensionTarget = 0;
    if (ph === Phase.Spin && t.value / dur.value > 0.35) tensionTarget = Math.min(1, Math.max(0, (9 - absV) / 7));
    else if (ph === Phase.Handoff || ph === Phase.Crawl) tensionTarget = Math.min(1, Math.max(0, (9 - absV) / 7));
    else if (ph === Phase.Settle && !locked.value) tensionTarget = 1;
    if (reduceMotion.value) tensionTarget *= 0.4;
    tension.value += (tensionTarget - tension.value) * k(tensionTarget > tension.value ? 260 : 90);
    // heartbeat: ~1 Hz at rest → 2.8 Hz at peak tension
    beat.value = (beat.value + (dt / 1000) * Math.PI * 2 * (1 + 1.8 * tension.value)) % (Math.PI * 2000);
    chase.value = (chase.value + (dt / 1000) * (24 + absV * slot * 0.5)) % 100000;
    const g = gravity.sensor.value;
    const rawTilt = Math.max(-1, Math.min(1, (g?.x ?? 0) / 9.81));
    tilt.value += (rawTilt - tilt.value) * k(160);
  });

  // ───────────────────────── gestures ─────────────────────────

  const pan = usePanGesture({
    activeOffsetX: [-8, 8],
    failOffsetY: [-14, 14],
    onActivate: () => {
      'worklet';
      const ph = phase.value;
      const r = reveal.value;
      if (ph !== Phase.Idle && ph !== Phase.Snap) return;
      if (r >= 0 && r < Reveal.HitStopEnd) return;
      phase.value = Phase.Drag;
      dragStart.value = x.value;
    },
    onUpdate: (e) => {
      'worklet';
      if (phase.value !== Phase.Drag) return;
      // a little resistance so the strip feels heavy under the finger
      x.value = dragStart.value - (e.translationX / slot) * 0.85;
    },
    onDeactivate: (e) => {
      'worklet';
      if (phase.value !== Phase.Drag) return;
      const v = -e.velocityX / slot;
      if (v > FLICK_MIN_SPEED && claimed.value >= 100) {
        scheduleOnRN(onNewBoard);
      } else if (v > FLICK_MIN_SPEED) {
        beginSpin();
        startHandoff(planFlick(x.value, v, target.value));
        return;
      }
      // too slow (or backwards): snap to the nearest notch, no spin
      const goal = Math.round(x.value);
      p0.value = x.value;
      dist.value = goal - x.value;
      dur.value = 260;
      vTerm.value = 0;
      phase.value = Phase.Snap;
      t.value = 0;
    },
  });

  // Tapping the reel itself is the same action as the button (spin / slam-stop / skip).
  // Exclusive: the tap only fires once the pan has failed to activate.
  const tap = useTapGesture({
    maxDuration: 260,
    onActivate: () => {
      'worklet';
      press();
    },
  });
  const reelGesture = useExclusiveGestures(pan, tap);

  // ───────────────────────── JS bridges ─────────────────────────

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') scheduleOnUI(fastForward);
    });
    return () => sub.remove();
    // fastForward only touches shared values, which are stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const api = useMemo(
    () => ({
      press: () => scheduleOnUI(press),
      /** QA helper: make the next spin land on `index` (0-based). */
      forceNext: (index: number) => {
        forcedTarget.value = index;
      },
      /** QA helper: slow motion (1 = real time). */
      setTimeScale: (k: number) => {
        timeScale.value = k;
      },
      // game-feel press: quick squash in (strong ease-out, so the sink starts on the touch frame),
      // springy release
      pressIn: () => {
        pressed.value = withTiming(1, { duration: 90, easing: PRESS_EASE });
      },
      pressOut: () => {
        pressed.value = withSpring(0, { damping: 11, stiffness: 420, mass: 0.6 });
      },
      /** Side toggles: feedback on touch-down, release a touch slower than the press. */
      toggleDown: (which: 'sound' | 'haptics', down: boolean) => {
        const v = which === 'sound' ? soundDown : hapticsDown;
        v.value = withTiming(down ? 1 : 0, { duration: down ? 100 : 160, easing: PRESS_EASE });
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const sv = {
    phase,
    x,
    vel,
    target,
    reveal,
    kind,
    lineHits,
    plateNum,
    plateFrom,
    plateAt,
    claimed,
    countShown,
    winIdx,
    segFrom,
    segTo,
    segAnimated,
    wonMask,
    order,
    treasure,
    resetTreasure,
    clock,
    dim,
    morph,
    busy,
    chip,
    speed,
    chase,
    pressed,
    soundDown,
    hapticsDown,
    tilt,
    tension,
    beat,
    resetAt,
    resetCells,
    reduceMotion,
    uiFps,
    dropped,
  };

  return { sv, reelGesture, ...api };
}
