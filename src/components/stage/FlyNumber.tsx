import type { SkImage } from '@shopify/react-native-skia';
import { Group } from '@shopify/react-native-skia';
import { memo } from 'react';
import { useFrameCallback, type SharedValue } from 'react-native-reanimated';

import { hideRange, put, useSpriteData } from '../../engine/sprites/layer';
import { SpriteLayer } from '../../engine/sprites/SpriteLayer';
import type { SpinEngine } from '../../engine/useSpinEngine';
import { ResultKindCode, Reveal } from '../../engine/timeline';
import type { StageLayout } from '../../theme/layout';
import { progress } from './anim';
import { flightAt } from './flight';
import { RF, type ReelAtlas } from './textures';

type Props = {
  layout: StageLayout;
  sv: SpinEngine['sv'];
  atlas: ReelAtlas;
  texture: SharedValue<SkImage | null>;
};

/** Comet tail: soft light sprites sampled back along the path (one Atlas draw, additive). */
const TAIL = 18;
const GLOW = TAIL + 1;

/**
 * The seamless reel → cell transition: the winning number lifts out of the wheel window, charges
 * up, and is thrown along an arc into its cell. One crisp number (never duplicated) rides the head
 * of a comet of light — a tail of soft additive sprites sampled back along the same path, white-hot
 * at the head, cooling to gold then to the skin's accent at the tip — so it reads as one streak of
 * light, not as after-images. It lands 70 ms before the world resumes (hit-stop), then hands over
 * to the tile flip.
 */
export const FlyNumber = memo(function FlyNumber({ layout, sv, atlas, texture }: Props) {
  const glow = useSpriteData(GLOW);
  const num = useSpriteData(1);
  const s0 = atlas.scale * 1.06;
  const sLand = (layout.cell * 0.56) / atlas.capPx;
  const bulbS = (layout.cell * 1.1) / 48;

  useFrameCallback(() => {
    'worklet';
    const r = sv.reveal.value;
    const idx = sv.winIdx.value;
    const kind = sv.kind.value;
    const repeat = kind === ResultKindCode.Repeat;
    const end = repeat ? Reveal.DropEnd + 320 : Reveal.HitStopEnd;
    const active = idx >= 0 && r >= Reveal.FormStart && r < end;
    num.modify((nd) => {
      'worklet';
      glow.modify((gd) => {
        'worklet';
        if (!active) {
          hideRange(nd, 0, 1);
          hideRange(gd, 0, GLOW);
          return gd;
        }
        // the number in flight is the gold one from the window (frosted ice for a repeat)
        const frame = (repeat ? RF.glyph0 : RF.glyphGold0) + idx;
        const cr = repeat ? 0.9 : 1;
        const cg = repeat ? 0.9 : 1;
        const cb = 1;
        const head = flightAt(layout, idx, r);
        if (r >= Reveal.DropEnd) {
          // landed: squash into the cell (or dissolve, for an already-claimed number)
          const p = flightAt(layout, idx, r, 1);
          const u = progress(r, Reveal.DropEnd, end);
          const s = repeat ? sLand * (1.3 + 0.6 * u) : sLand * (1.5 - 0.35 * u);
          const a = repeat ? 1 - u : 1;
          hideRange(gd, 0, TAIL);
          put(nd, 0, p.x, p.y, s, 0, frame, cr, cg, cb, a);
          put(gd, TAIL, p.x, p.y, bulbS * (1.1 - 0.4 * u), 0, RF.bulb, 1, repeat ? 0.8 : 0.72, repeat ? 1 : 0.36, 0.35 * a * (1 - u));
          return gd;
        }
        // the tail only exists in flight; while charging, the head glow swells instead
        const flying = head.t > 0;
        // light per unit length: where the samples bunch up (launch, landing) each one dims, so the
        // tail never stacks into a saturated white disc
        let px = head.x;
        let py = head.y;
        for (let k = 0; k < TAIL; k++) {
          if (!flying) {
            gd[k * 9 + 8] = 0;
            continue;
          }
          const f = (k + 1) / TAIL; // 0 = right behind the head, 1 = tip of the tail
          const t = head.t - f * 0.3;
          if (t <= 0) {
            gd[k * 9 + 8] = 0;
            continue;
          }
          const p = flightAt(layout, idx, r, t);
          // cooling: white-hot → gold → accent (lavender for a repeat)
          const hot = 1 - f;
          const tr = repeat ? 0.75 + 0.2 * hot : 1;
          const tg = repeat ? 0.7 + 0.25 * hot : 0.42 + 0.5 * hot * hot + 0.08 * hot;
          const tb = repeat ? 1 : 0.62 - 0.5 * hot + 0.55 * hot * hot * hot;
          const size = bulbS * (0.95 - 0.78 * f) * (0.9 + 0.25 * head.lift);
          const gap = Math.hypot(p.x - px, p.y - py);
          px = p.x;
          py = p.y;
          const density = Math.min(1, gap / (size * 48 * 0.28));
          put(gd, k, p.x, p.y, size, 0, RF.bulb, tr, tg, tb, 0.55 * (1 - f) * (1 - f) * density);
        }
        // head: one crisp number, swelling as it hangs at the apex, on a hot core of light
        const e = Math.pow(head.t, 1.45);
        const bulge = 1 + 0.35 * Math.sin(Math.PI * head.t);
        const s = (s0 * (1 + 0.3 * head.lift) * (1 - e) + sLand * 1.5 * e) * bulge;
        const rot = 0.18 * Math.sin(Math.PI * head.t) * Math.sign(head.dx);
        const charge = flying ? 1 : head.lift;
        put(gd, TAIL, head.x, head.y, bulbS * (0.9 + 0.5 * charge) * bulge, 0, RF.bulb, 1, repeat ? 0.85 : 0.8, repeat ? 1 : 0.45, 0.6 * charge);
        put(nd, 0, head.x, head.y, s, rot, frame, cr, cg, cb, 1);
        return gd;
      }, true);
      return nd;
    }, true);
  });

  return (
    <Group>
      <SpriteLayer texture={texture} frames={atlas.frames} data={glow} capacity={GLOW} blendMode="plus" />
      <SpriteLayer texture={texture} frames={atlas.frames} data={num} capacity={1} />
    </Group>
  );
});
