import {
  Atlas,
  FilterMode,
  MipmapMode,
  useColorBuffer,
  useRSXformBuffer,
  useRectBuffer,
  type SkImage,
} from '@shopify/react-native-skia';
import { memo } from 'react';
import type { SharedValue } from 'react-native-reanimated';

import { STRIDE, type Frames, type SpriteData } from './layer';

type Props = {
  texture: SharedValue<SkImage | null>;
  frames: Frames;
  data: SpriteData;
  capacity: number;
  blendMode?: 'plus' | 'screen' | 'srcOver';
};

const SAMPLING = { filter: FilterMode.Linear, mipmap: MipmapMode.None } as const;

/**
 * Sprite engine — render side. Turns a layer's sprite array into Atlas buffers. The three
 * mappers re-run only when the system publishes a new frame (`data.modify`), on the UI thread.
 * A sprite with alpha 0 gets a zero transform, so a fixed-capacity layer costs nothing for its
 * unused slots.
 */
export const SpriteLayer = memo(function SpriteLayer({ texture, frames, data, capacity, blendMode }: Props) {
  const sprites = useRectBuffer(capacity, (r, i) => {
    'worklet';
    const f = data.value[i * STRIDE + 4] * 4;
    r.setXYWH(frames[f], frames[f + 1], frames[f + 2], frames[f + 3]);
  });
  const transforms = useRSXformBuffer(capacity, (t, i) => {
    'worklet';
    const d = data.value;
    const o = i * STRIDE;
    const s = d[o + 2];
    if (d[o + 8] <= 0.002 || s <= 0) {
      t.set(0, 0, -4096, -4096);
      return;
    }
    const f = d[o + 4] * 4;
    const w = frames[f + 2];
    const h = frames[f + 3];
    const rot = d[o + 3];
    const sc = rot === 0 ? s : s * Math.cos(rot);
    const ss = rot === 0 ? 0 : s * Math.sin(rot);
    // anchor = sprite centre
    t.set(sc, ss, d[o] - (sc * w * 0.5 - ss * h * 0.5), d[o + 1] - (ss * w * 0.5 + sc * h * 0.5));
  });
  const colors = useColorBuffer(capacity, (c, i) => {
    'worklet';
    const d = data.value;
    const o = i * STRIDE;
    c[0] = d[o + 5];
    c[1] = d[o + 6];
    c[2] = d[o + 7];
    c[3] = d[o + 8];
  });
  return (
    <Atlas
      image={texture}
      sprites={sprites}
      transforms={transforms}
      colors={colors}
      colorBlendMode="modulate"
      blendMode={blendMode}
      sampling={SAMPLING}
    />
  );
});
