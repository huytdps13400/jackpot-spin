import {
  Blur,
  Canvas,
  Group,
  Image,
  Mask,
  Morphology,
  RadialGradient,
  Rect,
  useImage,
  vec,
} from '@shopify/react-native-skia';
import { memo, useEffect } from 'react';
import {
  Easing,
  cancelAnimation,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useGameStore } from '../../game/store';
import { skins } from '../../theme/art';
import type { StageLayout } from '../../theme/layout';

type Props = { layout: StageLayout };

/** One lap of the light around the lettering. */
const LAP_MS = 3600;
/** Room around the logo for the rim and its glow. */
const PAD = 6;
/** Rim: a hairline hugging the outside of the lettering's outline, and a soft halo around it. */
const RIM = 1;
const HALO = 2;

/**
 * Two spots of light (white core → gold → clear) travel around the logo's bounding box at a
 * constant speed: along the top edge, down the end, back along the bottom, up the start. They
 * only show through a mask cut to the rim just outside the glyphs, so what you see is the light
 * *running along the outline* of "JACKPOT SPIN", lighting each letter's edge as it passes — a
 * marquee chase. Two spots half a lap apart, so the word is never fully dark.
 */
const SPOT = ['rgba(255,255,240,1)', 'rgba(255,226,120,0.85)', 'rgba(255,190,60,0.35)', 'rgba(255,190,60,0)'];
const SPOT_POS = [0, 0.25, 0.6, 1];

/** Point at fraction `p` (0..1) along the perimeter of a box, clockwise from its top-left. */
function perimeter(p: number, x0: number, y0: number, w: number, h: number) {
  'worklet';
  const L = 2 * (w + h);
  let s = (((p % 1) + 1) % 1) * L;
  if (s < w) return { x: x0 + s, y: y0 };
  s -= w;
  if (s < h) return { x: x0 + w, y: y0 + s };
  s -= h;
  if (s < w) return { x: x0 + w - s, y: y0 + h };
  s -= w;
  return { x: x0, y: y0 + h - s };
}

/**
 * Light running around the edge of the "JACKPOT SPIN" logo. Its own tiny canvas over the logo
 * (the logo itself stays baked in the chrome picture), so the running light costs one small
 * masked draw per frame. Off with Reduce Motion: the logo stays as painted.
 */
export const LogoShimmer = memo(function LogoShimmer({ layout }: Props) {
  const skin = useGameStore((s) => s.skin);
  const logo = useImage(skins[skin].logo);
  const reduceMotion = useReducedMotion();
  const lap = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) return;
    lap.value = 0;
    lap.value = withRepeat(withTiming(1, { duration: LAP_MS, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(lap);
  }, [lap, reduceMotion]);

  const { topBar } = layout;
  const h = topBar.height;
  const w = logo ? (logo.width() / logo.height()) * h : 0;
  // the path the spots ride: just inside the lettering's box (the glyphs are italic and the
  // painted logo carries a little shadow below them)
  const bx = PAD + h * 0.15;
  const by = PAD + h * 0.1;
  const bw = w - h * 0.3;
  const bh = h * 0.7;
  const r = h * 1.1;
  const spotA = useDerivedValue(() => {
    const q = perimeter(lap.value, bx, by, bw, bh);
    return vec(q.x, q.y);
  });
  const spotB = useDerivedValue(() => {
    const q = perimeter(lap.value + 0.5, bx, by, bw, bh);
    return vec(q.x, q.y);
  });

  if (!logo || reduceMotion) return null;

  const logoImg = (dilate: number, cut: boolean) => (
    <Group>
      <Image image={logo} x={PAD} y={PAD} width={w} height={h} fit="fill">
        <Morphology operator="dilate" radius={dilate} />
      </Image>
      {cut ? <Image image={logo} x={PAD} y={PAD} width={w} height={h} fit="fill" blendMode="dstOut" /> : null}
    </Group>
  );

  const light = (
    <Group blendMode="plus">
      <Rect x={0} y={0} width={w + PAD * 2} height={h + PAD * 2}>
        <RadialGradient c={spotA} r={r} colors={SPOT} positions={SPOT_POS} />
      </Rect>
      <Rect x={0} y={0} width={w + PAD * 2} height={h + PAD * 2} blendMode="plus">
        <RadialGradient c={spotB} r={r} colors={SPOT} positions={SPOT_POS} />
      </Rect>
    </Group>
  );

  return (
    <Canvas
      style={{ position: 'absolute', left: topBar.x - PAD, top: topBar.y - PAD, width: w + PAD * 2, height: h + PAD * 2 }}
      pointerEvents="none"
    >
      {/* soft halo: a wider rim, blurred, at half strength */}
      <Group opacity={0.5} blendMode="plus">
        <Mask mode="alpha" mask={<Group>{logoImg(HALO, true)}<Blur blur={2.5} /></Group>}>
          {light}
        </Mask>
      </Group>
      {/* the crisp running edge */}
      <Group blendMode="plus">
        <Mask mode="alpha" mask={logoImg(RIM, true)}>
          {light}
        </Mask>
      </Group>
    </Canvas>
  );
});
