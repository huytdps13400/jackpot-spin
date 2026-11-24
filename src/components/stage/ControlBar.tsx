import { BlurMask, Circle, Group, Image, RadialGradient, SweepGradient, vec, type SkImage } from '@shopify/react-native-skia';
import { memo } from 'react';
import { useDerivedValue } from 'react-native-reanimated';

import type { SpinEngine } from '../../engine/useSpinEngine';
import { Phase } from '../../engine/timeline';
import type { StageLayout } from '../../theme/layout';
import { easeOutBack, progress } from './anim';

type Props = {
  layout: StageLayout;
  sv: SpinEngine['sv'];
  idle: SkImage;
  stop: SkImage;
  sound: SkImage;
  soundOff: SkImage;
  vibrate: SkImage;
  soundOn: boolean;
  hapticsOn: boolean;
  boardComplete: boolean;
};

const RING = ['rgba(215,154,43,0)', 'rgba(215,154,43,0)', '#D79A2B', '#FFE592', '#FFFFFF', 'rgba(255,255,255,0)'];
const RING_POS = [0, 0.5, 0.75, 0.9, 0.95, 1];

/**
 * The SPIN button and the two side toggles. The button is two painted faces (SPIN / STOP) that
 * cross-dissolve on the engine's `morph` channel, a light comet that orbits its rim (idle: a slow
 * invitation; spinning: a blur of light), a breathing gold halo, and a press that sinks the
 * face into its socket.
 */
export const ControlBar = memo(function ControlBar({
  layout,
  sv,
  idle,
  stop,
  sound,
  soundOff,
  vibrate,
  soundOn,
  hapticsOn,
  boardComplete,
}: Props) {
  const { spin } = layout;
  const { cx, cy, r } = spin;
  const c = vec(cx, cy);
  const face = r * 2 + 10;

  const ready = useDerivedValue(() => {
    const ph = sv.phase.value;
    return (ph === Phase.Idle || ph === Phase.Snap) && sv.busy.value < 0.5 ? 1 : 0;
  });
  // side toggles: press to 0.96 around their own centre
  const soundT = useDerivedValue(() => {
    const k = 1 - 0.04 * sv.soundDown.value;
    const { cx: x, cy: y } = layout.sound;
    return [{ translateX: x }, { translateY: y }, { scale: k }, { translateX: -x }, { translateY: -y }];
  });
  const hapticsT = useDerivedValue(() => {
    const k = 1 - 0.04 * sv.hapticsDown.value;
    const { cx: x, cy: y } = layout.haptics;
    return [{ translateX: x }, { translateY: y }, { scale: k }, { translateX: -x }, { translateY: -y }];
  });
  const transform = useDerivedValue(() => {
    const intro = sv.reduceMotion.value ? 1 : 0.6 + 0.4 * easeOutBack(progress(sv.clock.value, 950, 1350));
    const breathe = 1 + 0.025 * ready.value * Math.sin(sv.clock.value / 420);
    const s = intro * breathe * (1 - 0.07 * sv.pressed.value);
    return [
      { translateX: cx },
      { translateY: cy + 3 * sv.pressed.value },
      { scale: s },
      { translateX: -cx },
      { translateY: -cy },
    ];
  });
  const introA = useDerivedValue(() => progress(sv.clock.value, 950, 1150));
  const idleOpacity = useDerivedValue(() => 1 - sv.morph.value);
  const stopOpacity = useDerivedValue(() => sv.morph.value);
  const ringT = useDerivedValue(() => [{ rotate: sv.chase.value / 40 }]);
  // a full board makes the button call harder: the halo breathes deeper and faster
  const halo = useDerivedValue(() => {
    const k = 0.5 + 0.5 * Math.sin(sv.clock.value / (boardComplete ? 240 : 420));
    return (0.35 + (boardComplete ? 0.6 : 0.35) * k * ready.value + 0.3 * sv.pressed.value) * introA.value;
  });
  const ringOpacity = useDerivedValue(() => (0.55 + 0.45 * sv.speed.value) * introA.value);

  const iconS = layout.sound.r * 1.25;
  return (
    <Group>
      <Group opacity={halo} blendMode="plus">
        <Circle c={c} r={r * 1.9}>
          <RadialGradient
            c={c}
            r={r * 1.9}
            colors={['rgba(255,196,96,0.7)', 'rgba(226,58,110,0.22)', 'rgba(226,58,110,0)']}
            positions={[0.35, 0.65, 1]}
          />
        </Circle>
      </Group>
      <Group transform={transform} opacity={introA}>
        <Image image={idle} x={cx - face / 2} y={cy - face / 2} width={face} height={face} opacity={idleOpacity} />
        <Image image={stop} x={cx - face / 2} y={cy - face / 2} width={face} height={face} opacity={stopOpacity} />
        <Group opacity={ringOpacity} blendMode="plus">
          <Circle c={c} r={r + 2.5} style="stroke" strokeWidth={4}>
            <SweepGradient c={c} colors={RING} positions={RING_POS} transform={ringT} origin={c} />
            <BlurMask blur={3} style="normal" />
          </Circle>
        </Group>
      </Group>
      <Group transform={soundT}>
        <Image
          image={soundOn ? sound : soundOff}
          x={layout.sound.cx - iconS / 2}
          y={layout.sound.cy - iconS / 2}
          width={iconS}
          height={iconS}
          opacity={soundOn ? 1 : 0.6}
        />
      </Group>
      <Group transform={hapticsT}>
        <Image
          image={vibrate}
          x={layout.haptics.cx - iconS / 2}
          y={layout.haptics.cy - iconS / 2}
          width={iconS}
          height={iconS}
          opacity={hapticsOn ? 1 : 0.35}
        />
      </Group>
    </Group>
  );
});
