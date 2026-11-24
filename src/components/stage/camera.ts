import { useDerivedValue, useFrameCallback, useSharedValue } from 'react-native-reanimated';

import type { SpinEngine } from '../../engine/useSpinEngine';
import { ResultKindCode, Reveal } from '../../engine/timeline';
import { indexAt } from '../../game/reelMath';
import { cellCenter, type StageLayout } from '../../theme/layout';
import { easeOutCubic, progress } from './anim';

/** Zoom the camera leans in by at full suspense (1 → 1.06): enough to feel, never crops the board. */
const PUSH = 0.06;
/** Per tier (repeat, new, jackpot): crash zoom on lock, zoom held on arrival, impact punch. */
const CRASH = [0, 0.025, 0.05];
const ARRIVE = [0, 0.035, 0.06];
const PUNCH = [0.01, 0.03, 0.06];
/** Impact trauma per tier; shake amplitude is trauma², so small hits stay small. */
const TRAUMA = [0.3, 0.62, 1];
/** Impact spring (rad/s, damping ratio): one firm overshoot, settled in ≈ 0.5 s. */
const OMEGA = 15;
const ZETA = 0.6;
const OMEGA_D = OMEGA * Math.sqrt(1 - ZETA * ZETA);
/** Max shake at trauma 1: px offset, rad roll. */
const SHAKE_PX = 7;
const SHAKE_ROT = 0.018;
/** The backdrop sits "far away": it gets this share of the camera's zoom and shake. */
const PARALLAX = 0.35;
/** Backdrop overscan, so its edges never show under shake or roll. */
const OVERSCAN = 1.035;

function easeInOutCubic(t: number) {
  'worklet';
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Released damped spring (step response from 1 to 0, zero start velocity). */
function springRelease(t: number) {
  'worklet';
  return Math.exp(-ZETA * OMEGA * t) * (Math.cos(OMEGA_D * t) + ((ZETA * OMEGA) / OMEGA_D) * Math.sin(OMEGA_D * t));
}

/**
 * Smooth, non-repeating camera noise in [-1, 1] (three incommensurate sines, 4–9 Hz). Low enough
 * that the frame reads as a heavy camera rolling with the hit, not a 20 Hz buzz that strobes at
 * 60 fps.
 */
function noise(t: number, salt: number) {
  'worklet';
  return (
    0.5 * Math.sin(t * 26 + salt * 1.7) + 0.3 * Math.sin(t * 41 + salt * 4.1) + 0.2 * Math.sin(t * 57 + salt * 2.3)
  );
}

/** Settle times (s) of the camera's critically damped follow, per channel. */
const FOLLOW = { zoom: 0.07, pan: 0.09, sway: 0.06 };

/**
 * One step of a critically damped spring towards `target` (Game Programming Gems 4, "smooth
 * damp"): it carries velocity, so a target that changes direction (the suspense push giving way
 * to the crash zoom, a pin kick, a spin cutting into a reveal) bends the motion instead of
 * kinking it, and it never overshoots. `v` is the channel's velocity, updated in place.
 */
function follow(cur: number, target: number, v: { value: number }, smooth: number, dt: number) {
  'worklet';
  const omega = 2 / smooth;
  const x = omega * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (v.value + omega * change) * dt;
  v.value = (v.value - omega * temp) * e;
  return target + (change + temp) * e;
}

/**
 * The camera director. One virtual camera frames the whole world (wheel, board, flying number,
 * particles); the HUD (panel, banner, counter, controls) is screen-space and never moves, so
 * every touch target stays where the finger expects it.
 *
 * Shot list, all derived from engine state (no timers of its own):
 *  - suspense: as the reel crawls through readable numbers the camera dollies in on the pointer
 *    (up to 1.06×), each pin that passes the pointer bumps it, a heartbeat breathes in the zoom
 *    and a slight handheld sway makes the frame feel alive;
 *  - lock: crash zoom (+2.5 %, +5 % for the jackpot) while the number charges up;
 *  - flight: the camera pans with the number, from the pointer to its cell;
 *  - impact: an extra punch-in snaps on during the 70 ms hit-stop (the frozen impact frame), then
 *    a damped spring releases the camera back to 1× while trauma-based shake rolls the frame.
 *
 * Returns two transforms: the world's, and a parallax one for the far backdrop.
 */
export function useCamera(layout: StageLayout, sv: SpinEngine['sv']) {
  const { arc, width, height } = layout;
  const wx = arc.cx;
  const wy = arc.pivotY - arc.numberRadius;
  const cZ = useSharedValue(0);
  const cPx = useSharedValue(wx);
  const cPy = useSharedValue(wy);
  const cOx = useSharedValue(0);
  const cOy = useSharedValue(0);
  const cRot = useSharedValue(0);
  const cLockZ = useSharedValue(0);
  const cWasActive = useSharedValue(false);
  const cKick = useSharedValue(0);
  const cLastIdx = useSharedValue(-1);
  // follow velocities (units/s) and the smoothed hand-held sway (shake is added on top, unsmoothed)
  const vZ = useSharedValue(0);
  const vPx = useSharedValue(0);
  const vPy = useSharedValue(0);
  const vOx = useSharedValue(0);
  const vOy = useSharedValue(0);
  const vRot = useSharedValue(0);
  const swayX = useSharedValue(0);
  const swayY = useSharedValue(0);
  const swayR = useSharedValue(0);

  useFrameCallback((info) => {
    'worklet';
    const dt = Math.min(40, info.timeSincePreviousFrame ?? 16.7);
    const k = (tau: number) => 1 - Math.exp(-dt / tau);
    if (sv.reduceMotion.value) {
      cZ.value += (0 - cZ.value) * k(60);
      cOx.value = 0;
      cOy.value = 0;
      cRot.value = 0;
      vZ.value = 0;
      return;
    }
    const sec = dt / 1000;
    const clock = sv.clock.value;
    const r = sv.reveal.value;
    const idx = sv.winIdx.value;
    const kind = sv.kind.value;
    const ten = sv.tension.value;
    const active = r >= 0 && r < Reveal.Steady && idx >= 0;

    // ── suspense ──
    const e = ten * ten * (3 - 2 * ten);
    let z = PUSH * e;
    let px = wx;
    let py = wy;
    // pins clunking past the pointer: each one bumps the camera
    const pin = indexAt(sv.x.value);
    if (pin !== cLastIdx.value) {
      cLastIdx.value = pin;
      if (ten > 0.05) cKick.value = 1;
    }
    cKick.value *= Math.exp(-dt / 80);
    const kick = cKick.value * ten;
    const heart = Math.pow(0.5 + 0.5 * Math.sin(sv.beat.value), 10) * ten;
    z += 0.008 * kick + 0.006 * heart;
    const sx = 1.6 * ten * Math.sin(clock / 430);
    const sy = 1.2 * ten * Math.sin(clock / 370 + 1) + 2.2 * kick;
    const sr = 0.003 * ten * Math.sin(clock / 510);
    // impact shake, added raw on top of the smoothed sway
    let ox = 0;
    let oy = 0;
    let rot = 0;

    // ── reveal ──
    if (active && !cWasActive.value) cLockZ.value = cZ.value;
    cWasActive.value = active;
    let snap = false;
    if (active) {
      const tier = kind === ResultKindCode.Complete ? 2 : kind === ResultKindCode.Repeat ? 0 : 1;
      const c = cellCenter(layout, idx);
      const zl = cLockZ.value;
      const crash = zl + CRASH[tier] * easeOutCubic(progress(r, 0, 110));
      if (r < Reveal.FormEnd) {
        z = tier === 0 ? zl * (1 - easeOutCubic(progress(r, 0, 500))) : crash;
      } else if (r < Reveal.DropEnd) {
        const u = easeInOutCubic(progress(r, Reveal.FormEnd, Reveal.DropEnd));
        const from = tier === 0 ? zl * (1 - easeOutCubic(progress(r, 0, 500))) : crash;
        z = from + (ARRIVE[tier] - from) * u;
        px = wx + (c.x - wx) * u;
        py = wy + (c.y - wy) * u;
      } else {
        px = c.x;
        py = c.y;
        const peak = ARRIVE[tier] + PUNCH[tier];
        if (r < Reveal.HitStopEnd) {
          z = peak; // the frozen impact frame
          snap = true;
        } else {
          const t = (r - Reveal.HitStopEnd) / 1000;
          z = peak * springRelease(t);
          const trauma = TRAUMA[tier] * Math.exp(-t * 4.5);
          const a = trauma * trauma;
          const nt = clock / 1000;
          ox += SHAKE_PX * a * noise(nt, 1);
          oy += SHAKE_PX * 0.8 * a * noise(nt, 2);
          rot += SHAKE_ROT * a * noise(nt, 3);
        }
      }
    }

    // every channel follows its target on a critically damped spring, so the shot list joins
    // without a kink in velocity (suspense → crash → pan → release, or a spin cutting into a
    // reveal); only the impact frame cuts, on purpose
    const zt = Math.max(-0.006, z);
    if (snap) {
      // the frozen impact frame: zoom and pivot lock onto the cell exactly
      cZ.value = zt;
      cPx.value = px;
      cPy.value = py;
      vZ.value = 0;
      vPx.value = 0;
      vPy.value = 0;
    } else {
      cZ.value = follow(cZ.value, zt, vZ, FOLLOW.zoom, sec);
      cPx.value = follow(cPx.value, px, vPx, FOLLOW.pan, sec);
      cPy.value = follow(cPy.value, py, vPy, FOLLOW.pan, sec);
    }
    swayX.value = follow(swayX.value, sx, vOx, FOLLOW.sway, sec);
    swayY.value = follow(swayY.value, sy, vOy, FOLLOW.sway, sec);
    swayR.value = follow(swayR.value, sr, vRot, FOLLOW.sway, sec);
    cOx.value = swayX.value + ox;
    cOy.value = swayY.value + oy;
    cRot.value = swayR.value + rot;
  });

  const world = useDerivedValue(() => {
    const s = 1 + cZ.value;
    const px = cPx.value;
    const py = cPy.value;
    return [
      { translateX: px + cOx.value },
      { translateY: py + cOy.value },
      { rotate: cRot.value },
      { scale: s },
      { translateX: -px },
      { translateY: -py },
    ];
  });
  const far = useDerivedValue(() => {
    const s = OVERSCAN * (1 + PARALLAX * cZ.value);
    const cx = width / 2;
    const cy = height / 2;
    return [
      { translateX: cx + PARALLAX * cOx.value },
      { translateY: cy + PARALLAX * cOy.value },
      { rotate: PARALLAX * cRot.value },
      { scale: s },
      { translateX: -cx },
      { translateY: -cy },
    ];
  });
  return { world, far };
}
