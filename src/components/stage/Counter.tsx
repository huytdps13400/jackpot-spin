import { Circle, Group, Picture, RadialGradient, createPicture, rect, Skia, vec, type SkFont } from '@shopify/react-native-skia';
import { memo, useMemo } from 'react';
import { useDerivedValue } from 'react-native-reanimated';

import type { SpinEngine } from '../../engine/useSpinEngine';
import type { StageLayout } from '../../theme/layout';
import { counterGeometry, drawGoldText } from './Chrome';

type Props = { layout: StageLayout; sv: SpinEngine['sv']; font: SkFont; smallFont: SkFont };

/**
 * Mechanical odometer for "CELLS CLAIMED". Each place is a strip of gold digits (one Picture)
 * scrolled behind a clip. A higher place only turns during the last unit of the place below
 * — exactly like a real counter's carry — so 9 → 10 rolls both wheels together, and a new board
 * spins 100 → 0 like a reset counter. The roll itself is driven by `countShown`, which the
 * engine releases only when the first collected coin reaches the panel.
 */
export const Counter = memo(function Counter({ layout, sv, font, smallFont }: Props) {
  const g = useMemo(() => counterGeometry(layout, font, smallFont), [layout, font, smallFont]);
  // proportional digits, set tight like the reference ("12", not "1 2"): each place is as wide
  // as the digit it shows (interpolated while it rolls), so the number closes up around a "1"
  const { colW, adv } = useMemo(() => {
    const adv: number[] = [];
    for (let d = 0; d < 10; d++) adv.push(font.measureText(String(d)).width - font.getSize() * 0.01);
    return { colW: Math.ceil(Math.max(...adv) + font.getSize() * 0.4), adv };
  }, [font]);
  const lineH = Math.ceil(g.capH * 2.1);
  const strip = useMemo(
    () =>
      createPicture((canvas) => {
        for (let d = 0; d <= 10; d++) {
          const t = String(d % 10);
          const m = font.measureText(t);
          drawGoldText(canvas, t, colW / 2 - (m.x + m.width / 2), d * lineH, font);
        }
      }, Skia.XYWHRect(-10, -lineH, colW + 20, lineH * 12)),
    [font, colW, lineH],
  );
  const span = Math.max(...adv) * 3;
  const clip = rect(g.right - span - 24, g.baseline - g.capH - 10, span + 40, g.capH + 32);
  const cy = g.baseline - g.capH / 2;
  const cx = g.right - span / 3;

  // NB: each derived value reads `sv.countShown` itself — Reanimated only subscribes to shared
  // values it can see in the worklet's own closure, not inside helper functions it calls.
  const pos = (v: number, place: number) => {
    'worklet';
    const whole = Math.floor(v / place);
    return whole + Math.max(0, v - whole * place - (place - 1));
  };
  /** Width of a place whose wheel sits at fractional position p. */
  const width = (p: number) => {
    'worklet';
    const i = Math.floor(p);
    const f = p - i;
    return adv[i % 10] * (1 - f) + adv[(i + 1) % 10] * f;
  };
  const onesT = useDerivedValue(() => {
    const p = pos(sv.countShown.value, 1);
    return [{ translateX: g.right - width(p) / 2 - colW / 2 }, { translateY: g.baseline - (p % 10) * lineH }];
  });
  // Pictures ignore paint opacity, so an unused place is parked outside the clip instead of faded
  const tensT = useDerivedValue(() => {
    const v = sv.countShown.value;
    const w1 = width(pos(v, 1));
    const p = pos(v, 10);
    return [
      { translateX: g.right - w1 - width(p) / 2 - colW / 2 },
      { translateY: v > 9.02 ? g.baseline - (p % 10) * lineH : -10000 },
    ];
  });
  const hundT = useDerivedValue(() => {
    const v = sv.countShown.value;
    const w12 = width(pos(v, 1)) + width(pos(v, 10));
    const p = pos(v, 100);
    return [
      { translateX: g.right - w12 - width(p) / 2 - colW / 2 },
      { translateY: v > 99.02 ? g.baseline - (p % 10) * lineH : -10000 },
    ];
  });
  // the number punches up while a wheel is between digits
  const bump = useDerivedValue(() => {
    const v = sv.countShown.value;
    const f = v - Math.floor(v);
    return f > 0.001 ? Math.sin(Math.PI * f) : 0;
  });
  const punch = useDerivedValue(() => {
    const s = 1 + 0.16 * bump.value;
    return [{ translateX: cx }, { translateY: cy }, { scale: s }, { translateX: -cx }, { translateY: -cy }];
  });
  const glowOpacity = useDerivedValue(() => bump.value * 0.9);

  return (
    <Group>
      <Group blendMode="plus" opacity={glowOpacity}>
        <Circle c={vec(cx, cy)} r={g.capH * 2.2}>
          <RadialGradient
            c={vec(cx, cy)}
            r={g.capH * 2.2}
            colors={['rgba(255,214,120,0.85)', 'rgba(255,120,60,0.25)', 'rgba(255,120,60,0)']}
          />
        </Circle>
      </Group>
      <Group transform={punch} clip={clip}>
        <Group transform={hundT}>
          <Picture picture={strip} />
        </Group>
        <Group transform={tensT}>
          <Picture picture={strip} />
        </Group>
        <Group transform={onesT}>
          <Picture picture={strip} />
        </Group>
      </Group>
    </Group>
  );
});
