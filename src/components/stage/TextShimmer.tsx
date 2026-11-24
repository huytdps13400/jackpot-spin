import { type SkImage } from '@shopify/react-native-skia';
import { memo, useMemo } from 'react';
import { useFrameCallback, type SharedValue } from 'react-native-reanimated';

import { hideRange, put, useSpriteData } from '../../engine/sprites/layer';
import { SpriteLayer } from '../../engine/sprites/SpriteLayer';
import type { SpinEngine } from '../../engine/useSpinEngine';
import type { Rect as LRect, StageLayout } from '../../theme/layout';
import { hash, progress } from './anim';
import { GLINT_LIFE, SHINE_SWEEP as SWEEP, shinePass } from './GlyphShine';
import { GLINT_FRAMES, PF, type Atlas } from './textures';

type Props = {
  layout: StageLayout;
  sv: SpinEngine['sv'];
  atlas: Atlas;
  texture: SharedValue<SkImage | null>;
};

/** Star glints that pop on the lettering behind the sweep: per piece, per pass. */
const GLINTS = 4;
const GLINT_PX = 128;

/** Where the lettering visibly sits inside each painted piece (fractions of the rect). */
function textBox(r: LRect, fx: number, fy: number, fw: number, fh: number): LRect {
  return { x: r.x + r.width * fx, y: r.y + r.height * fy, width: r.width * fw, height: r.height * fh };
}

/**
 * Sparkle on the HUD lettering (result number, banner line, claimed counter): four-point star
 * glints pop across each piece left to right, just behind the glyph-masked shine each piece
 * draws itself (GlyphShine), like light catching polished metal. Both run off `shinePass`.
 *
 * Rhythm (game UI: the eye should land on the text at the moments that matter, not be pulled at
 * all the time): an idle pass every 5.2 s, staggered across the three pieces; on a new cell an
 * extra pass on each piece at its own beat (plate on impact, banner as the find is named, counter
 * as the odometer rolls). Nothing during the spin. Off with Reduce Motion.
 */
export const TextShimmer = memo(function TextShimmer({ layout, sv, atlas, texture }: Props) {
  const boxes = useMemo(
    () => [
      textBox(layout.plate, 0.22, 0.2, 0.56, 0.6),
      textBox(layout.banner, 0.1, 0.24, 0.8, 0.58),
      textBox(layout.panel, 0.08, 0.18, 0.84, 0.64),
    ],
    [layout],
  );
  const passOf = (i: number) => {
    'worklet';
    return shinePass(sv, i);
  };

  const glints = useSpriteData(boxes.length * GLINTS);
  useFrameCallback(() => {
    'worklet';
    glints.modify((d) => {
      'worklet';
      hideRange(d, 0, boxes.length * GLINTS);
      for (let i = 0; i < boxes.length; i++) {
        const [t, k, seed] = passOf(i);
        if (t < 0) continue;
        const box = boxes[i];
        for (let g = 0; g < GLINTS; g++) {
          // each glint pops just behind the band, where it has just passed
          const start = SWEEP * (0.12 + 0.22 * g);
          const u = progress(t, start, start + GLINT_LIFE);
          if (u <= 0 || u >= 1) continue;
          const fx = 0.08 + 0.84 * (0.12 + 0.24 * g + (hash(seed, g + 1) - 0.5) * 0.14);
          const x = box.x + box.width * fx;
          const y = box.y + box.height * (0.2 + 0.6 * hash(seed, g + 7));
          const size = box.height * (0.8 + 0.35 * hash(seed, g + 3)) * (0.85 + 0.15 * k);
          const frame = PF.glint0 + Math.min(GLINT_FRAMES - 1, Math.floor(u * GLINT_FRAMES));
          put(d, i * GLINTS + g, x, y, size / GLINT_PX, u * 0.6, frame, 1, 0.95, 0.82, k);
        }
      }
      return d;
    }, true);
  });

  return (
    <SpriteLayer texture={texture} frames={atlas.frames} data={glints} capacity={boxes.length * GLINTS} blendMode="plus" />
  );
});
