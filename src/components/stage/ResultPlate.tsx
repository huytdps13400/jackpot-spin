import {
  Group,
  LinearGradient,
  Path,
  Rect,
  Skia,
  SweepGradient,
  BlurMask,
  vec,
  type SkImage,
} from '@shopify/react-native-skia';
import { memo, useMemo } from 'react';
import { useDerivedValue, useFrameCallback, type SharedValue } from 'react-native-reanimated';

import { hideRange, put, useSpriteData } from '../../engine/sprites/layer';
import { SpriteLayer } from '../../engine/sprites/SpriteLayer';
import type { SpinEngine } from '../../engine/useSpinEngine';
import { ResultKindCode } from '../../engine/timeline';
import type { Rect as R, StageLayout } from '../../theme/layout';
import { easeOutBack, progress } from './anim';
import { RF, type ReelAtlas } from './textures';
import { TF, type TextAtlas } from './textAtlas';

type Props = {
  layout: StageLayout;
  sv: SpinEngine['sv'];
  atlas: ReelAtlas;
  texture: SharedValue<SkImage | null>;
  text: TextAtlas;
  textTexture: SharedValue<SkImage | null>;
};

/**
 * Cap height of the result number, as a fraction of the plate's height. The plate's gold face is
 * ~0.8 of its rect (the rest is rim and glow); at 0.56 the caps fill ~70% of the face, leaving the
 * extrusion and drop shadow room inside it instead of spilling onto the rim.
 */
export const PLATE_CAP = 0.56;
/** The gold face's centre sits this far (fraction of height) above the rect's centre (measured). */
const FACE_DY = -0.015;
/** Optical lift: the extruded side hangs below the caps, so the block's centre is ~6% of cap low. */
const LIFT = 0.06;

/** Digit sprites: [old bases ×3, old faces ×3, new bases ×3, new faces ×3]. */
const DIGITS = 12;

/** The painted plate's bevel outline, as a path (for the neon comet and the gloss clip). */
export function hexPath(r: R, inset: number) {
  const b = Skia.PathBuilder.Make();
  const cy = r.y + r.height / 2;
  const tip = r.height * 0.42;
  b.moveTo(r.x + inset, cy);
  b.lineTo(r.x + tip + inset * 0.6, r.y + inset);
  b.lineTo(r.x + r.width - tip - inset * 0.6, r.y + inset);
  b.lineTo(r.x + r.width - inset, cy);
  b.lineTo(r.x + r.width - tip - inset * 0.6, r.y + r.height - inset);
  b.lineTo(r.x + tip + inset * 0.6, r.y + r.height - inset);
  b.close();
  return b.build();
}

const COMET = ['rgba(0,0,0,0)', 'rgba(95,225,255,0)', '#5FE1FF', '#FFE592', '#FFFFFF', 'rgba(255,255,255,0)', 'rgba(0,0,0,0)'];
const COMET_POS = [0, 0.55, 0.72, 0.84, 0.9, 0.97, 1];

/**
 * Writes number `n` as composed digit sprites into slots [o, o + 3) (bases) and [o + 3, o + 6)
 * (faces). Bases go first so neighbouring outlines merge under the faces, like one word.
 */
function putNumber(
  d: number[],
  o: number,
  lay: number[],
  n: number,
  x: number,
  y: number,
  s: number,
  style: number,
  a: number,
) {
  'worklet';
  const len = n > 0 ? lay[n * 4] : 0;
  for (let k = 0; k < 3; k++) {
    if (k >= len || a <= 0) {
      hideRange(d, o + k, o + k + 1);
      hideRange(d, o + 3 + k, o + 4 + k);
      continue;
    }
    const digit = Math.floor(n / Math.pow(10, len - 1 - k)) % 10;
    const dx = x + lay[n * 4 + 1 + k] * s;
    put(d, o + k, dx, y, s, 0, TF.plate0 + style * 20 + digit, 1, 1, 1, a);
    put(d, o + 3 + k, dx, y, s, 0, TF.plate0 + style * 20 + 10 + digit, 1, 1, 1, a);
  }
}

/**
 * Result plate: the latest number slams in (scale 1.5 → 1 with overshoot) while the previous one
 * drops away, a gloss sweep crosses the plate, and a neon comet chases round its bevel. The
 * number is molten-gold arcade lettering composed from per-digit sprites (frosted ice for a
 * repeat), sized from the plate, not from the wheel's glyphs.
 */
export const ResultPlate = memo(function ResultPlate({ layout, sv, atlas, texture, text, textTexture }: Props) {
  const { plate } = layout;
  const cx = plate.x + plate.width / 2;
  const cy = plate.y + plate.height * (0.5 + FACE_DY) - plate.height * PLATE_CAP * LIFT;
  const glow = useSpriteData(1);
  const nums = useSpriteData(DIGITS);
  const sBase = (plate.height * PLATE_CAP) / text.plateCapPx;
  const lay = text.plateLayout;

  useFrameCallback(() => {
    'worklet';
    const t = sv.clock.value - sv.plateAt.value;
    const n = sv.plateNum.value;
    const old = sv.plateFrom.value;
    const repeat = sv.kind.value === ResultKindCode.Repeat;
    const intro = progress(sv.clock.value, 800, 1100);
    const breathe = 1 + 0.015 * Math.sin(sv.clock.value / 480);
    glow.modify((d) => {
      'worklet';
      // glow behind the new number
      const flash = 1 - progress(t, 0, 600);
      put(d, 0, cx, cy, (plate.height / 48) * (1.4 + flash), 0, RF.bulb, 1, 0.72, 0.3, n > 0 ? (0.25 + 0.6 * flash) * intro : 0);
      return d;
    }, true);
    nums.modify((d) => {
      'worklet';
      const tOut = progress(t, 0, 170);
      putNumber(d, 0, lay, old, cx, cy + 12 * tOut, sBase * (1 - 0.25 * tOut), 0, old > 0 ? 1 - tOut : 0);
      const tIn = progress(t, 0, 340);
      const s = sBase * (1.55 - 0.55 * easeOutBack(tIn)) * breathe;
      putNumber(d, 6, lay, n, cx, cy, s, repeat ? 1 : 0, n > 0 ? progress(t, 0, 90) * intro : 0);
      return d;
    }, true);
  });

  const hex = useMemo(() => hexPath(plate, 3), [plate]);
  const comet = useDerivedValue(() => [{ rotate: (sv.clock.value / 2400) * Math.PI * 2 }]);
  const cometOpacity = useDerivedValue(() => {
    const t = sv.clock.value - sv.plateAt.value;
    return (0.55 + 0.45 * (1 - progress(t, 0, 900))) * progress(sv.clock.value, 900, 1200);
  });
  const sweepX = useDerivedValue(() => {
    const t = sv.clock.value - sv.plateAt.value;
    return plate.x - 60 + (plate.width + 120) * progress(t, 120, 620);
  });
  const sweepT = useDerivedValue(() => [{ translateX: sweepX.value }, { skewX: -0.5 }]);

  return (
    <Group>
      <Group clip={hex}>
        <Group transform={sweepT} blendMode="plus">
          <Rect x={0} y={plate.y} width={34} height={plate.height}>
            <LinearGradient
              start={vec(0, 0)}
              end={vec(34, 0)}
              colors={['rgba(255,255,255,0)', 'rgba(255,250,220,0.75)', 'rgba(255,255,255,0)']}
            />
          </Rect>
        </Group>
      </Group>
      <SpriteLayer texture={texture} frames={atlas.frames} data={glow} capacity={1} />
      <SpriteLayer texture={textTexture} frames={text.frames} data={nums} capacity={DIGITS} />
      <Group opacity={cometOpacity}>
        <Path path={hex} style="stroke" strokeWidth={4}>
          <SweepGradient c={vec(cx, cy)} colors={COMET} positions={COMET_POS} transform={comet} origin={vec(cx, cy)} />
          <BlurMask blur={4} style="normal" />
        </Path>
        <Path path={hex} style="stroke" strokeWidth={1.6}>
          <SweepGradient c={vec(cx, cy)} colors={COMET} positions={COMET_POS} transform={comet} origin={vec(cx, cy)} />
        </Path>
      </Group>
    </Group>
  );
});
