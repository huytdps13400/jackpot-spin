import { Group, LinearGradient, Paint, Rect, vec } from '@shopify/react-native-skia';
import type { ReactNode } from 'react';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';

import type { SpinEngine } from '../../engine/useSpinEngine';
import { Reveal, ResultKindCode } from '../../engine/timeline';
import type { Rect as R } from '../../theme/layout';

/**
 * Shared clock for the HUD lettering's light: the result plate (0), the banner (1) and the
 * claimed counter (2) each get a pass of light across their letters — a glyph-masked shine band
 * (GlyphShine) with star glints popping behind it (TextShimmer).
 *
 * Rhythm (game UI: the eye should land on the text at the moments that matter, not be pulled at
 * all the time): an idle pass every 5.2 s, staggered plate → banner → counter; on a new cell an
 * extra, stronger pass on each piece at its own beat (plate on impact, banner as the find is
 * named, counter as the odometer rolls). Nothing while the wheel spins or during the intro. Off
 * with Reduce Motion.
 */
export const SHINE_PERIOD = 5200;
export const SHINE_STAGGER = 220;
/** One pass of light across the lettering, left to right (ms). */
export const SHINE_SWEEP = 820;
/** How long a star glint lives (ms). */
export const GLINT_LIFE = 520;
const BEATS = [Reveal.HitStopEnd, Reveal.ChipIn + 60, Reveal.CountStart];

/** [ms into piece i's current pass or -1, strength 0..1, seed]. */
export function shinePass(sv: SpinEngine['sv'], i: number): [number, number, number] {
  'worklet';
  if (sv.reduceMotion.value) return [-1, 0, 0];
  const r = sv.reveal.value;
  // (the reveal clock parks at Steady once a reveal is over: only a running reveal counts)
  if (r >= 0 && r < Reveal.Steady && sv.kind.value !== ResultKindCode.Repeat && sv.winIdx.value >= 0) {
    const t = r - BEATS[i];
    if (t >= 0 && t < SHINE_SWEEP + GLINT_LIFE * 2) return [t, 1, Math.floor(r / 97) + i * 13];
  }
  if (sv.clock.value < 2400 || sv.busy.value > 0.5 || sv.speed.value > 0.02 || (r >= 0 && r < Reveal.Steady)) return [-1, 0, 0];
  const c = sv.clock.value + SHINE_PERIOD - i * SHINE_STAGGER;
  return [c % SHINE_PERIOD, 0.9, Math.floor(c / SHINE_PERIOD) * 3 + i];
}

function easeInOut(t: number) {
  'worklet';
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Where the band's centre is, as a fraction across the lettering box (-0.3 → 1.3 over a pass),
 * and how bright it is right now; `u` is NaN when no pass is running.
 */
export function shineAt(sv: SpinEngine['sv'], i: number) {
  'worklet';
  const [t, k] = shinePass(sv, i);
  if (t < 0 || t > SHINE_SWEEP) return { u: NaN, a: 0 };
  const p = t / SHINE_SWEEP;
  return { u: -0.3 + 1.6 * easeInOut(p), a: k * Math.sin(Math.PI * p) };
}

/** Shine-wave lift of a glyph at fraction `x` across the box: 0 → 1 as the band passes over it. */
export function waveAt(u: number, x: number) {
  'worklet';
  if (u !== u) return 0;
  const d = Math.abs(u - x) / 0.22;
  return d < 1 ? 0.5 + 0.5 * Math.cos(d * Math.PI) : 0;
}

type Props = {
  sv: SpinEngine['sv'];
  /** Which piece of lettering (0 plate, 1 banner, 2 counter). */
  piece: number;
  /** The lettering's box: the band travels across it. */
  box: R;
  /** The glyphs, drawn again as the mask (only their alpha matters). */
  children: ReactNode;
};

/**
 * Light on the letters, not on a box: the glyphs are drawn into a layer, a skewed gradient band
 * is kept only where they are (srcIn — Skia's MaskedView), and the layer is added on top (plus).
 * After Native Bloom's "Shimmer wave text" (Reacticx), which masks a gradient by its text.
 */
export function GlyphShine({ sv, piece, box, children }: Props) {
  const w = box.height * 1.4;
  const band = useDerivedValue(() => {
    // read the clock here so this re-runs every frame (helpers' reads do not subscribe)
    void sv.clock.value;
    return shineAt(sv, piece);
  });
  const opacity = useDerivedValue(() => band.value.a);
  const transform = useDerivedValue(() => {
    const u = band.value.u;
    const x = u === u ? box.x + box.width * u - w / 2 : -9999;
    return [{ translateX: x }, { translateY: box.y + box.height / 2 }, { skewX: -0.4 }];
  });
  return (
    <Group layer={<Paint blendMode="plus" opacity={opacity as SharedValue<number>} />}>
      {children}
      <Group transform={transform}>
        <Rect x={0} y={-box.height} width={w} height={box.height * 2} blendMode="srcIn">
          <LinearGradient
            start={vec(0, 0)}
            end={vec(w, 0)}
            colors={['rgba(255,240,200,0)', 'rgba(255,240,200,0.55)', 'rgba(255,252,240,0.8)', 'rgba(255,240,200,0.55)', 'rgba(255,240,200,0)']}
            positions={[0, 0.3, 0.5, 0.7, 1]}
          />
        </Rect>
      </Group>
    </Group>
  );
}
