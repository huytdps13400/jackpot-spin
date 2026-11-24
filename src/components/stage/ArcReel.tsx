import {
  Blur,
  BlurMask,
  Group,
  LinearGradient,
  Paint,
  Path,
  RadialGradient,
  Rect,
  Skia,
  vec,
  type SkImage,
} from '@shopify/react-native-skia';
import { memo, useMemo } from 'react';
import { useDerivedValue, useFrameCallback, useSharedValue, type SharedValue } from 'react-native-reanimated';

import { put, useSpriteData } from '../../engine/sprites/layer';
import { SpriteLayer } from '../../engine/sprites/SpriteLayer';
import type { SpinEngine } from '../../engine/useSpinEngine';
import { Phase, ResultKindCode, Reveal } from '../../engine/timeline';
import { wrap } from '../../game/reelMath';
import type { StageLayout } from '../../theme/layout';
import { lux, type SkinTone } from '../../theme/tokens';
import { easeOutBack, progress, smoothstep } from './anim';
import { BLUR_DOWN, RF, sectorPath, type ReelAtlas } from './textures';

type Props = {
  layout: StageLayout;
  sv: SpinEngine['sv'];
  atlas: ReelAtlas;
  texture: SharedValue<SkImage | null>;
  tone: SkinTone;
};

/** Visible slots either side of the pointer (wheel angle covers ±maxAngle). */
const SIDE = 5;
const SLOTS = SIDE * 2 + 1;
/** Defocus (pt) of the wheel's far sides, where it dissolves into the room. */
const EDGE_BLUR = 5;
/** Sub-frame samples per number for the rotational motion blur. */
const GHOSTS = 7;
const BULBS = 34;
/** Shutter: fraction of a 60 Hz frame the "camera" exposes. */
const SHUTTER = 0.9 / 60;
/** Flapper: max bend (rad), contact zone (slots before a pin crosses), spring constants. */
const FLAP_MAX = 0.38;
const FLAP_CONTACT = 0.34;
const FLAP_W = 2 * Math.PI * 8.5;
const FLAP_K = FLAP_W * FLAP_W;
const FLAP_C = 2 * 0.16 * FLAP_W;
const SQ_W = 2 * Math.PI * 6;
const SQ_K = SQ_W * SQ_W;
const SQ_C = 2 * 0.28 * SQ_W;

/** Aperture of the wheel's depth of field: a little open at rest, fully open at speed. */
function lensOf(vel: number, reduce: boolean) {
  'worklet';
  return reduce ? 0.4 : Math.min(1, 0.66 + Math.abs(vel) * 0.02);
}

/** Blur (pt) a defocus amount 0..1 stands for: matches the two baked levels (1.6 / 4.6 pt). */
function sigmaOf(soft: number) {
  'worklet';
  return soft < 0.5 ? 3.2 * soft : 1.6 + 6 * (soft - 0.5);
}

/** Arcs of radius r about (cx, pivotY) for each [from, to] range of drum angle (rad, 0 = top). */
function arcsPath(cx: number, pivotY: number, r: number, ranges: [number, number][]) {
  const b = Skia.PathBuilder.Make();
  const rect = Skia.XYWHRect(cx - r, pivotY - r, r * 2, r * 2);
  for (const [a0, a1] of ranges) b.addArc(rect, -90 + (a0 * 180) / Math.PI, ((a1 - a0) * 180) / Math.PI);
  return b.build();
}

/**
 * The prize wheel. Numbers ride a circle around a pivot far below the screen, so they fan out
 * and tilt like the top of a real wheel; the board's frame hides the lower half.
 *
 * Motion blur is physically based rather than a blur filter: each number is drawn GHOSTS times
 * at sub-frame positions spread over the shutter interval along the *arc*, with weights that sum
 * to one. At rest the ghosts collapse into one sharp sprite; at 40 slots/s they smear into a
 * rotational streak. 77 number sprites + 11 plates + 34 bulbs = 3 Atlas draws (+4 for the soft levels).
 *
 * Depth of field, physically shaped: the drum curves away from the camera, so a slot's circle of
 * confusion grows with its depth, (1 − cos θ) — nothing in front, a touch on the neighbours, most
 * at the screen edges. The reel atlas holds two out-of-focus levels of the plate and of every
 * number (blurred once when the atlas is built, stored at half resolution) and each slot blends
 * sharp → slightly soft → fully soft along that curve, so no step between levels is ever more
 * than a small change in blur (one big sharp/blurred cross-fade reads as a ghost, not as focus).
 * The aperture opens with speed: a little at rest, fully once the wheel is moving fast, so the
 * eye stays on the slot under the pointer. The rims and the marquee bulbs follow the same curve
 * (blurred rim zones; bulbs swell into bokeh discs as they defocus).
 */
export const ArcReel = memo(function ArcReel({ layout, sv, atlas, texture, tone }: Props) {
  const { arc } = layout;
  const { cx, pivotY, numberRadius: Rn, band, slotAngle, maxAngle } = arc;
  const numberY = pivotY - Rn;
  const plates = useSpriteData(SLOTS);
  const platesSoft = useSpriteData(SLOTS);
  const platesSoft2 = useSpriteData(SLOTS);
  const numbers = useSpriteData(SLOTS * GHOSTS);
  const numbersSoft = useSpriteData(SLOTS * GHOSTS);
  const numbersSoft2 = useSpriteData(SLOTS * GHOSTS);
  const bulbs = useSpriteData(BULBS);
  const glyphScale = atlas.scale * 1.02;
  const plateScale = atlas.scale;
  const bulbR = Rn + band / 2 - 4;
  // circle of confusion (0..1) at drum angle th: depth (1 − cos th), past a small in-focus zone
  // around the pointer, normalised so the screen edges reach 1
  const cocNear = 1 - Math.cos(slotAngle * 0.6);
  const cocFar = 1 - Math.cos(maxAngle * 0.82);
  const coc = (th: number) => {
    'worklet';
    return Math.min(1, Math.max(0, (1 - Math.cos(th) - cocNear) / (cocFar - cocNear)));
  };

  useFrameCallback(() => {
    'worklet';
    const clock = sv.clock.value;
    const x = sv.x.value;
    const vel = sv.vel.value;
    const reduce = sv.reduceMotion.value;
    // intro: the wheel swings in from the left on a spring
    const swing = reduce ? 0 : (1 - easeOutBack(progress(clock, 150, 950))) * -0.7;
    const introA = progress(clock, 150, 450);
    const base = Math.floor(x);
    const omega = vel * slotAngle; // rad/s
    const smear = reduce ? 0 : Math.min(Math.abs(omega) * SHUTTER, slotAngle * 0.7);
    const ph = sv.phase.value;
    const steady = ph === Phase.Idle || ph === Phase.Snap;
    const kind = sv.kind.value;
    const repeat = kind === ResultKindCode.Repeat;
    // the winning number physically lifts out of the window (FlyNumber carries it), so the slot
    // empties while it flies and refills once it has landed — never two copies on screen
    const rv = sv.reveal.value;
    const lifted =
      rv >= 0 && rv < Reveal.HitStopEnd + 260
        ? smoothstep(Reveal.FormStart, Reveal.FormStart + 60, rv) *
          (1 - smoothstep(Reveal.HitStopEnd, Reveal.HitStopEnd + 260, rv))
        : 0;

    // depth of field (see above): aperture opens with speed
    const lens = lensOf(vel, reduce);
    platesSoft2.modify((q2) => {
      'worklet';
      numbersSoft2.modify((m2) => {
        'worklet';
        platesSoft.modify((qd) => {
          'worklet';
          numbersSoft.modify((md) => {
            'worklet';
            plates.modify((pd) => {
              'worklet';
              numbers.modify((nd) => {
                'worklet';
                for (let s = 0; s < SLOTS; s++) {
                  const i = base + s - SIDE;
                  const off = i - x;
                  const th = off * slotAngle + swing;
                  const vis = (1 - smoothstep(maxAngle * 0.72, maxAngle, Math.abs(th))) * introA;
                  // depth: plates turning away from the camera fall into shadow (reads as a curved drum)
                  const shade = 1 - 0.42 * smoothstep(slotAngle * 0.6, maxAngle, Math.abs(th));
                  const px = cx + Rn * Math.sin(th);
                  const py = pivotY - Rn * Math.cos(th);
                  const soft = lens * coc(th);
                  // three focus levels, weights w0 + w1 + w2 = 1, only two ever non-zero
                  const w0 = Math.max(0, 1 - 2 * soft);
                  const w2 = Math.max(0, 2 * soft - 1);
                  const w1 = 1 - w0 - w2;
                  // plates are opaque: the softest level underneath at full strength, each sharper one
                  // laid over it at its share of what is left, so the result is exactly the weighted mix
                  put(q2, s, px, py, plateScale * BLUR_DOWN, th, RF.segmentBlur2, shade, shade, shade, vis);
                  put(qd, s, px, py, plateScale * BLUR_DOWN, th, RF.segmentBlur, shade, shade, shade, vis * (w0 + w1));
                  put(pd, s, px, py, plateScale, th, RF.segment, shade, shade, shade, w0 + w1 > 0 ? (vis * w0) / (w0 + w1) : 0);
                  const n = wrap(i);
                  const inWindow = Math.abs(off) < 0.5;
                  // gold under the pointer once the reel rests, cool silver while it travels
                  const lit = inWindow && steady ? 1 : 0;
                  const gold = lit && !repeat;
                  const r = (gold ? 1 : lit ? 0.88 : 0.92) * shade;
                  const g = (gold ? 1 : lit ? 0.88 : 0.95) * shade;
                  const b = (gold ? 1 : lit ? 0.97 : 1.0) * shade;
                  const face = gold ? RF.glyphGold0 : RF.glyph0;
                  const scale = glyphScale * (inWindow ? 1.06 : 0.96);
                  const leave = inWindow ? 1 - lifted : 1;
                  for (let k = 0; k < GHOSTS; k++) {
                    // ghosts trail *behind* the motion (towards where the number came from)
                    const f = k / (GHOSTS - 1);
                    const tk = th + Math.sign(omega) * smear * f;
                    const w = smear > 0.002 ? (k === 0 ? 0.42 : 0.58 / (GHOSTS - 1)) * (1.15 - 0.3 * f) : k === 0 ? 1 : 0;
                    const gx = cx + Rn * Math.sin(tk);
                    const gy = pivotY - Rn * Math.cos(tk);
                    const a = Math.min(1, w) * vis * leave;
                    put(nd, s * GHOSTS + k, gx, gy, scale, tk, face + n, r, g, b, a * w0);
                    put(md, s * GHOSTS + k, gx, gy, scale * BLUR_DOWN, tk, RF.glyphBlur0 + n, r, g, b, a * w1);
                    put(m2, s * GHOSTS + k, gx, gy, scale * BLUR_DOWN, tk, RF.glyphBlur2_0 + n, r, g, b, a * w2);
                  }
                }
                return nd;
              }, true);
              return pd;
            }, true);
            return md;
          }, true);
          return qd;
        }, true);
        return m2;
      }, true);
      return q2;
    }, true);

    // marquee bulbs on the rim: they turn with the wheel and chase faster as it speeds up
    const tension = sv.tension.value;
    const r0 = sv.reveal.value;
    const lockFlash = r0 >= 0 && r0 < 420 ? 1 - r0 / 420 : 0;
    const step = slotAngle / 3;
    const phase0 = (x * slotAngle) / step;
    const pb = Math.floor(phase0);
    const chase = Math.floor(sv.chase.value / 18);
    const strobe = tension > 0.05 ? 0.5 + 0.5 * Math.sin(sv.beat.value * 2) : 0;
    bulbs.modify((bd) => {
      'worklet';
      for (let j = 0; j < BULBS; j++) {
        const gj = pb + j - BULBS / 2;
        const th = (gj - phase0) * step + swing;
        const vis = (1 - smoothstep(maxAngle * 0.7, maxAngle, Math.abs(th))) * introA;
        const on = ((gj % 3) + 3 + chase) % 3 === 0 ? 1 : 0.28;
        const lvl = Math.min(1, on * (1 - tension * 0.6) + tension * strobe * 0.9 + lockFlash);
        const isGold = (gj & 1) === 0;
        // out of focus, a point of light spreads into a bigger, dimmer bokeh disc
        const spread = 1 + 1.5 * lens * coc(th);
        put(
          bd,
          j,
          cx + bulbR * Math.sin(th),
          pivotY - bulbR * Math.cos(th),
          (0.22 + 0.1 * lvl) * spread,
          0,
          RF.bulb,
          1,
          isGold ? 0.78 : 0.45,
          isGold ? 0.35 : 0.85,
          (vis * (0.35 + 0.65 * lvl)) / Math.pow(spread, 1.3),
        );
      }
      return bd;
    }, true);
  });

  // ── static window + pointer (Skia vector) ──
  const sectorInner = useMemo(() => sectorPath(Rn, band, slotAngle / 2, 3), [Rn, band, slotAngle]);
  const windowT = useMemo(() => [{ translateX: cx }, { translateY: numberY }], [cx, numberY]);
  // the pointer: a cut-gold arrowhead set with a jewel (pivot = top centre, so it swings)
  const PW = 21;
  const PH = 30;
  const pointer = useMemo(() => {
    const b = Skia.PathBuilder.Make();
    b.moveTo(-PW, 0);
    b.quadTo(0, -4, PW, 0);
    b.quadTo(PW * 0.34, PH * 0.42, 0, PH);
    b.quadTo(-PW * 0.34, PH * 0.42, -PW, 0);
    b.close();
    return b.build();
  }, []);
  const pointerY = arc.top - 19;
  const facet = useMemo(() => {
    const b = Skia.PathBuilder.Make();
    b.moveTo(-PW + 3, 1.5);
    b.lineTo(0, 1);
    b.lineTo(0, PH - 3);
    b.quadTo(-6, PH * 0.4, -PW + 3, 1.5);
    b.close();
    return b.build();
  }, []);
  const gem = useMemo(() => {
    const b = Skia.PathBuilder.Make();
    b.moveTo(-9, 5);
    b.lineTo(9, 5);
    b.lineTo(0, 19);
    b.close();
    return b.build();
  }, []);
  const gemFacet = useMemo(() => {
    const b = Skia.PathBuilder.Make();
    b.moveTo(-9, 5);
    b.lineTo(0, 5);
    b.lineTo(0, 19);
    b.close();
    return b.build();
  }, []);
  // the wheel's lower rim (a gold moulding that finishes the band above the board) and its crown
  // moulding along the top edge, where the bulbs sit. Each is cut into three depth zones — in
  // focus round the pointer, then slightly and fully out of focus towards the edges — so the gold
  // lines defocus with the plates; every softer zone runs a little under the sharper one, so the
  // joins never show a gap.
  const Z1 = slotAngle * 0.95;
  const Z2 = slotAngle * 1.75;
  const rimOf = (r: number) => {
    const half = Math.asin(Math.min(1, (layout.width / 2 + 12) / r));
    const ov = 6 / r;
    return {
      path: arcsPath(cx, pivotY, r, [[-half, half]]),
      zones: [
        arcsPath(cx, pivotY, r, [[-Z1, Z1]]),
        arcsPath(cx, pivotY, r, [
          [-Z2, -Z1 + ov],
          [Z1 - ov, Z2],
        ]),
        arcsPath(cx, pivotY, r, [
          [-half, -Z2 + ov],
          [Z2 - ov, half],
        ]),
      ],
      y: pivotY - r,
    };
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rim = useMemo(() => rimOf(Rn - band / 2), [Rn, band, cx, pivotY, layout.width, slotAngle]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const crownRim = useMemo(() => rimOf(Rn + band / 2), [Rn, band, cx, pivotY, layout.width, slotAngle]);
  // zone blur follows the same circle-of-confusion curve as the plates, at each zone's middle
  const zoneMid = [(Z1 + Z2) / 2, (Z2 + maxAngle) / 2];
  const blurMid = useDerivedValue(() => Math.max(0.2, sigmaOf(lensOf(sv.vel.value, sv.reduceMotion.value) * coc(zoneMid[0]))));
  const blurFar = useDerivedValue(() => Math.max(0.2, sigmaOf(lensOf(sv.vel.value, sv.reduceMotion.value) * coc(zoneMid[1]))));

  // ── the pointer's flapper: a torsional spring the pins push and release (UI-thread sim) ──
  const flapTh = useSharedValue(0); // bend (rad)
  const flapOm = useSharedValue(0); // angular velocity (rad/s)
  const squash = useSharedValue(0); // >0 squashed, <0 stretched
  const squashV = useSharedValue(0);
  const flash = useSharedValue(0);
  const lastPin = useSharedValue(0);
  const lastR = useSharedValue(-1);
  useFrameCallback((info) => {
    'worklet';
    const dt = Math.min(info.timeSincePreviousFrame ?? 16.7, 34) / 1000;
    const xx = sv.x.value;
    const v = sv.vel.value;
    const av = Math.abs(v);
    const dir = v >= 0 ? 1 : -1;
    const ten = sv.tension.value;
    let th = flapTh.value;
    let om = flapOm.value;
    // free spring: ~8.5 Hz, lightly damped, so a released flapper twangs back with a wobble
    om += (-FLAP_K * th - FLAP_C * om) * dt;
    th += om * dt;
    const pin = Math.floor(xx + 0.5);
    if (av >= 18) {
      // blur speed: pins outrun the spring — the flapper rides bent back, rattling
      const target = -dir * FLAP_MAX * (0.5 + 0.06 * Math.sin(sv.clock.value * 0.09));
      th += (target - th) * (1 - Math.exp(-dt / 0.05));
      om = 0;
    } else if (av > 0.02) {
      // a pin in the contact zone bends the flapper further the closer it gets to slipping past
      const p = xx + 0.5;
      let ahead = dir > 0 ? Math.ceil(p) - p : p - Math.floor(p);
      if (ahead <= 1e-6) ahead = 1;
      if (ahead < FLAP_CONTACT) {
        const push = -dir * FLAP_MAX * Math.pow(1 - ahead / FLAP_CONTACT, 0.8);
        if (dir * th > dir * push) {
          om = Math.max(-60, Math.min(60, (push - flapTh.value) / Math.max(dt, 0.001)));
          th = push;
        }
      }
    }
    if (pin !== lastPin.value) {
      lastPin.value = pin;
      if (av > 0.02 && av < 18) {
        // the pin slips off the tip: the pointer flinches and flashes, harder as suspense builds
        squashV.value += 4 + 7 * ten;
        flash.value = Math.max(flash.value, 0.35 + 0.65 * ten);
      }
    }
    // lock: the pointer slams down on the number
    const r = sv.reveal.value;
    if (r >= 0 && r < 120 && (lastR.value < 0 || lastR.value > r)) {
      squashV.value += 16;
      flash.value = 1.6;
      om += -dir * 9;
    }
    lastR.value = r;
    // squash & stretch spring (~6 Hz)
    let sqv = squashV.value;
    let sq = squash.value;
    sqv += (-SQ_K * sq - SQ_C * sqv) * dt;
    sq += sqv * dt;
    squash.value = Math.max(-0.25, Math.min(0.3, sq));
    squashV.value = sqv;
    flash.value *= Math.exp(-dt / 0.14);
    flapTh.value = Math.max(-0.62, Math.min(0.62, th));
    flapOm.value = om;
  });

  const glow = useDerivedValue(() => {
    const r = sv.reveal.value;
    const lockFlash = r >= 0 && r < 360 ? 1 - r / 360 : 0;
    const beat = 0.5 + 0.5 * Math.sin(sv.beat.value);
    const intro = progress(sv.clock.value, 600, 1000);
    return Math.min(1.6, (0.45 + 0.25 * beat + sv.tension.value * 0.5 * beat + lockFlash + flash.value * 0.6) * intro);
  });
  const pointerT = useDerivedValue(() => {
    const clock = sv.clock.value;
    const ten = sv.tension.value;
    const intro = (1 - easeOutBack(progress(clock, 700, 1100))) * 1.2;
    // nerves: a fine tremble once the result is close; a slow bob at rest
    const nerves = Math.max(0, ten - 0.45) * 1.8;
    const tremble = nerves * 1.1 * Math.sin(clock * 0.083) * Math.sin(clock * 0.031 + 1.7);
    const bob = (1 - ten) * 1.2 * Math.sin(clock / 640);
    const sq = squash.value;
    return [
      { translateX: cx + tremble },
      { translateY: pointerY + bob },
      { rotate: flapTh.value + intro },
      { scaleX: 1 + 0.55 * sq },
      { scaleY: 1 - sq },
    ];
  });
  const pointerOpacity = useDerivedValue(() => progress(sv.clock.value, 600, 800));
  // the window's bezel stands proud of both rims, so the rims tuck under it instead of meeting
  // its corners edge to edge
  const bezel = useMemo(() => sectorPath(Rn, band + 10, slotAngle / 2 + 2.5 / Rn, 0), [Rn, band, slotAngle]);
  const bezelInner = useMemo(() => sectorPath(Rn, band + 10, slotAngle / 2 + 2.5 / Rn, 4.2), [Rn, band, slotAngle]);

  const wheel = (
    <>
      <SpriteLayer texture={texture} frames={atlas.frames} data={platesSoft2} capacity={SLOTS} />
      <SpriteLayer texture={texture} frames={atlas.frames} data={platesSoft} capacity={SLOTS} />
      <SpriteLayer texture={texture} frames={atlas.frames} data={plates} capacity={SLOTS} />
      {/* crown moulding (under the bulbs) */}
      <Path path={crownRim.path} style="stroke" strokeWidth={10} color="rgba(3,3,16,0.5)">
        <BlurMask blur={5} style="normal" />
      </Path>
      {[2, 1, 0].map((z) => (
        <Group
          key={`crown${z}`}
          layer={
            z > 0 ? (
              <Paint>
                <Blur blur={z === 1 ? blurMid : blurFar} mode="decal" />
              </Paint>
            ) : undefined
          }
        >
          <Path path={crownRim.zones[z]} style="stroke" strokeWidth={6} color={lux.outline} />
          <Path path={crownRim.zones[z]} style="stroke" strokeWidth={4}>
            <LinearGradient
              start={vec(0, crownRim.y - 4)}
              end={vec(0, crownRim.y + 40)}
              colors={[lux.gold50, lux.gold400, lux.gold600, lux.gold800]}
            />
          </Path>
          <Path path={crownRim.zones[z]} style="stroke" strokeWidth={1} color="rgba(255,250,225,0.75)" />
        </Group>
      ))}
      <SpriteLayer texture={texture} frames={atlas.frames} data={bulbs} capacity={BULBS} blendMode="plus" />
      <Path path={rim.path} style="stroke" strokeWidth={9} color="rgba(3,3,16,0.55)">
        <BlurMask blur={5} style="normal" />
      </Path>
      {[2, 1, 0].map((z) => (
        <Group
          key={`rim${z}`}
          layer={
            z > 0 ? (
              <Paint>
                <Blur blur={z === 1 ? blurMid : blurFar} mode="decal" />
              </Paint>
            ) : undefined
          }
        >
          <Path path={rim.zones[z]} style="stroke" strokeWidth={4.5} color={lux.outline} />
          <Path path={rim.zones[z]} style="stroke" strokeWidth={2.6}>
            <LinearGradient start={vec(0, rim.y - 3)} end={vec(0, rim.y + 30)} colors={[lux.gold50, lux.gold400, lux.gold600]} />
          </Path>
        </Group>
      ))}
    </>
  );
  const numbersLayer = (
    <>
      <SpriteLayer texture={texture} frames={atlas.frames} data={numbersSoft2} capacity={SLOTS * GHOSTS} />
      <SpriteLayer texture={texture} frames={atlas.frames} data={numbersSoft} capacity={SLOTS * GHOSTS} />
      <SpriteLayer texture={texture} frames={atlas.frames} data={numbers} capacity={SLOTS * GHOSTS} />
    </>
  );

  // Depth of field at both sides: a progressive (tilt-shift) blur rather than a cut at the
  // screen edge. The wheel and its numbers are drawn twice: a copy blurred by EDGE_BLUR pt, kept
  // only towards the sides, under the sharp copy, which fades out over the outer ~24 % of each
  // side. The blurred copy itself melts into the room over the last few points, so the far
  // plates dissolve like out-of-focus bokeh instead of ending on a hard edge.
  const mask = (colors: string[], positions: number[]) => (
    <Rect x={0} y={0} width={layout.width} height={layout.height} blendMode="dstIn">
      <LinearGradient start={vec(0, 0)} end={vec(layout.width, 0)} colors={colors} positions={positions} />
    </Rect>
  );
  const sharpMask = mask(
    ['rgba(0,0,0,0)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0.3)', 'rgba(0,0,0,0.78)', '#000', '#000', 'rgba(0,0,0,0.78)', 'rgba(0,0,0,0.3)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0)'],
    [0, 0.05, 0.12, 0.19, 0.25, 0.75, 0.81, 0.88, 0.95, 1],
  );
  const softMask = mask(
    ['rgba(0,0,0,0)', 'rgba(0,0,0,0.55)', '#000', '#000', 'rgba(0,0,0,0)', 'rgba(0,0,0,0)', '#000', '#000', 'rgba(0,0,0,0.55)', 'rgba(0,0,0,0)'],
    [0, 0.025, 0.07, 0.2, 0.3, 0.7, 0.8, 0.93, 0.975, 1],
  );

  return (
    <Group>
      <Group
        layer={
          <Paint>
            <Blur blur={EDGE_BLUR} mode="decal" />
          </Paint>
        }
      >
        {wheel}
        {numbersLayer}
        {softMask}
      </Group>
      <Group layer={<Paint />}>
        {wheel}
        {sharpMask}
      </Group>
      {/* the window: a lit jewel slot under the pointer (magenta in Neon, ruby in Royal) */}
      <Group transform={windowT} opacity={pointerOpacity}>
        <Path path={sectorInner}>
          <LinearGradient
            start={vec(0, -band / 2)}
            end={vec(0, band / 2)}
            colors={tone.window.map((c) => c)}
            positions={[0, 0.3, 0.72, 1]}
          />
        </Path>
        {/* inner light: the jewel glows from within, breathing with the heartbeat */}
        <Group opacity={glow} blendMode="plus">
          <Path path={sectorInner}>
            <RadialGradient
              c={vec(0, band * 0.05)}
              r={band * 0.75}
              colors={['rgba(255,236,250,0.55)', 'rgba(255,120,210,0.22)', 'rgba(255,90,190,0)']}
              positions={[0, 0.45, 1]}
            />
          </Path>
        </Group>
        {/* glass: a soft specular band across the top third */}
        <Path path={sectorInner}>
          <LinearGradient
            start={vec(0, -band / 2)}
            end={vec(0, -band * 0.05)}
            colors={['rgba(255,255,255,0.34)', 'rgba(255,255,255,0)']}
          />
        </Path>
      </Group>
      <Group layer={<Paint />}>
        {numbersLayer}
        {sharpMask}
      </Group>
      {/* the bezel: a cut-gold frame that stands proud of both rims */}
      <Group transform={windowT} opacity={pointerOpacity}>
        <Path path={bezel} style="stroke" strokeWidth={8} color={tone.windowGlow} opacity={glow}>
          <BlurMask blur={8} style="normal" />
        </Path>
        <Path path={bezel} style="stroke" strokeWidth={8.5} color={lux.outline} strokeJoin="round" />
        <Path path={bezel} style="stroke" strokeWidth={6} strokeJoin="round">
          <LinearGradient
            start={vec(0, -band / 2 - 5)}
            end={vec(0, band / 2 + 5)}
            colors={[lux.gold50, lux.gold200, lux.gold400, lux.gold600, lux.gold800, lux.gold400]}
            positions={[0, 0.12, 0.35, 0.62, 0.86, 1]}
          />
        </Path>
        {/* bevel lines: a bright lip outside, a dark groove where the gold meets the jewel */}
        <Path path={bezel} style="stroke" strokeWidth={1} color="rgba(255,250,225,0.8)" strokeJoin="round" />
        <Path path={bezelInner} style="stroke" strokeWidth={1.4} color="rgba(40,10,30,0.7)" strokeJoin="round" />
        <Path path={sectorInner} style="stroke" strokeWidth={1} color="rgba(255,240,200,0.45)" />
      </Group>
      <Group transform={pointerT} opacity={pointerOpacity}>
        <Path path={pointer} color={tone.windowGlow} opacity={glow}>
          <BlurMask blur={10} style="normal" />
        </Path>
        <Path path={pointer} style="stroke" strokeWidth={3.6} color={lux.outline} strokeJoin="round" />
        <Path path={pointer}>
          <LinearGradient
            start={vec(0, -2)}
            end={vec(0, PH)}
            colors={[lux.gold200, lux.gold400, lux.gold600, lux.gold800]}
            positions={[0, 0.3, 0.7, 1]}
          />
        </Path>
        <Path path={pointer} style="stroke" strokeWidth={1} color="rgba(255,248,220,0.7)" strokeJoin="round" />
        {/* bevel: the left facet catches the light */}
        <Path path={facet} color="rgba(255,250,225,0.42)" />
        {/* the jewel */}
        <Path path={gem} style="stroke" strokeWidth={1.6} color={lux.gold900} />
        <Path path={gem}>
          <LinearGradient start={vec(0, 5)} end={vec(0, 19)} colors={tone.gem.map((c) => c)} />
        </Path>
        <Path path={gemFacet} color="rgba(255,255,255,0.32)" />
        {/* a white-hot flash on every pin */}
        <Path path={pointer} color="#FFF6D8" opacity={flash} blendMode="plus" />
      </Group>
    </Group>
  );
});
