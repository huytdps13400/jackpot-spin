import {
  Circle,
  Glyphs,
  Group,
  Image,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  RoundedRect,
  Skia,
  vec,
  type SkFont,
  type SkImage,
} from '@shopify/react-native-skia';
import { memo, useMemo } from 'react';
import { useDerivedValue, useFrameCallback, type SharedValue } from 'react-native-reanimated';

import { hideRange, put, useSpriteData } from '../../engine/sprites/layer';
import { SpriteLayer } from '../../engine/sprites/SpriteLayer';

import type { SpinEngine } from '../../engine/useSpinEngine';
import { ResultKindCode, Reveal } from '../../engine/timeline';
import { cellCenter, type StageLayout } from '../../theme/layout';
import { lux } from '../../theme/tokens';
import { easeOutBack, easeOutCubic, progress, trackedGlyphs } from './anim';
import { PF, type Atlas } from './textures';

type PartProps = { layout: StageLayout; sv: SpinEngine['sv'] };

/** Starburst of `n` tapered rays around (0,0), radius 1 — scaled per use. */
function raysPath(n: number) {
  const b = Skia.PathBuilder.Make();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    // alternate long/short, fine shafts (not chunky spikes)
    const w = (Math.PI / n) * (i % 2 === 0 ? 0.16 : 0.09);
    const len = i % 2 === 0 ? 1 : 0.62 + 0.25 * ((i * 7) % 3) / 2;
    b.moveTo(0, 0);
    b.lineTo(Math.cos(a - w) * len, Math.sin(a - w) * len);
    b.lineTo(Math.cos(a + w) * len, Math.sin(a + w) * len);
    b.close();
  }
  return b.build();
}

/**
 * Suspense spotlight: while the reel crawls through readable numbers the whole stage dims
 * except the wheel window, so the eye has nowhere else to go. Opacity = the engine's honest
 * tension channel (a pure function of reel speed).
 */
export const Spotlight = memo(function Spotlight({ layout, sv }: PartProps) {
  const { width, height, arc } = layout;
  const c = vec(arc.cx, arc.pivotY - arc.numberRadius);
  const opacity = useDerivedValue(() => sv.tension.value * 0.45);
  return (
    <Rect x={0} y={0} width={width} height={height} opacity={opacity}>
      <RadialGradient
        c={c}
        r={height * 0.75}
        colors={['rgba(3,3,16,0)', 'rgba(3,3,16,0)', 'rgba(3,3,16,0.55)', 'rgba(3,3,16,0.8)']}
        positions={[0, 0.08, 0.3, 1]}
      />
    </Rect>
  );
});

/**
 * The release: on the lock frame a starburst blows out of the wheel window, then a full-screen
 * flash on impact. Both are tiered — quiet for an already-claimed number, huge for the jackpot —
 * so the big moment always has headroom above the normal one.
 */
export const Release = memo(function Release({ layout, sv, godrays }: PartProps & { godrays: SkImage }) {
  const { width, height, arc } = layout;
  const cx = arc.cx;
  const cy = arc.pivotY - arc.numberRadius;

  const rayT = useDerivedValue(() => progress(sv.reveal.value, 0, 650));
  const rayOpacity = useDerivedValue(() => {
    const r = sv.reveal.value;
    if (r < 0 || r > 650 || sv.reduceMotion.value) return 0;
    const tier = sv.kind.value === ResultKindCode.Repeat ? 0.18 : sv.kind.value === ResultKindCode.Complete ? 0.75 : 0.42;
    const t = rayT.value;
    // quick swell in, long soft fade: light blooming, not a strobe
    return tier * Math.min(1, t / 0.12) * (1 - t) * (1 - t);
  });
  // two layers of Blender light shafts turning against each other, so the beams shimmer and
  // cross instead of sliding as one rigid star
  const rayTransform = useDerivedValue(() => {
    const s = width * (0.2 + 0.8 * easeOutCubic(rayT.value));
    return [{ translateX: cx }, { translateY: cy }, { rotate: rayT.value * 0.35 }, { scale: s }];
  });
  const rayTransform2 = useDerivedValue(() => {
    const s = width * 0.78 * (0.25 + 0.75 * easeOutCubic(rayT.value));
    return [{ translateX: cx }, { translateY: cy }, { rotate: 0.9 - rayT.value * 0.5 }, { scale: s }];
  });
  const flashC = useDerivedValue(() => {
    const i = sv.winIdx.value;
    if (i < 0) return { x: width / 2, y: height / 2 };
    const c = cellCenter(layout, i);
    return { x: c.x, y: c.y };
  });
  const flash = useDerivedValue(() => {
    const r = sv.reveal.value;
    const k = sv.kind.value;
    if (r < Reveal.HitStopEnd || r > Reveal.HitStopEnd + 320 || k === ResultKindCode.Repeat) return 0;
    const peak = k === ResultKindCode.Complete ? 0.6 : 0.2;
    const p = progress(r, Reveal.HitStopEnd, Reveal.HitStopEnd + 320);
    return peak * (1 - p) * (1 - p);
  });

  return (
    <Group>
      <Group opacity={rayOpacity} blendMode="plus">
        {/* the shafts fade out at 0.85 of the image's half-size: size it so they reach radius 1 */}
        <Group transform={rayTransform}>
          <Image image={godrays} x={-1.18} y={-1.18} width={2.36} height={2.36} />
        </Group>
        <Group transform={rayTransform2} opacity={0.6}>
          <Image image={godrays} x={-1.18} y={-1.18} width={2.36} height={2.36} />
        </Group>
      </Group>
      {/* impact light: blooms out of the cell (not a flat full-screen strobe) */}
      <Rect x={0} y={0} width={width} height={height} opacity={flash} blendMode="plus">
        <RadialGradient
          c={flashC}
          r={height * 0.55}
          colors={['rgba(255,244,214,1)', 'rgba(255,206,140,0.42)', 'rgba(255,120,200,0.1)', 'rgba(255,120,200,0)']}
          positions={[0, 0.16, 0.55, 1]}
        />
      </Rect>
    </Group>
  );
});

type BannerProps = PartProps & {
  title: SkImage;
  crown: SkImage;
  ribbon: SkImage;
  star: SkImage;
  godrays: SkImage;
  font: SkFont;
  fx: Atlas;
  fxTexture: SharedValue<SkImage | null>;
};

const BANNER_IN = Reveal.HitStopEnd + 160;
const BANNER_OUT = Reveal.Steady - 60;
const BULBS = 40;
const WARM_MS = 350;

/** Points evenly spaced along a rounded rect's perimeter (centred on 0,0). */
function marqueePoints(w: number, h: number, r: number, n: number) {
  const straightW = w - 2 * r;
  const straightH = h - 2 * r;
  const arc = (Math.PI / 2) * r;
  const total = 2 * straightW + 2 * straightH + 4 * arc;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    let d = (i / n) * total;
    const segs: [number, (u: number) => { x: number; y: number }][] = [
      [straightW, (u) => ({ x: -w / 2 + r + u, y: -h / 2 })],
      [arc, (u) => { const a = -Math.PI / 2 + u / r; return { x: w / 2 - r + Math.cos(a) * r, y: -h / 2 + r + Math.sin(a) * r }; }],
      [straightH, (u) => ({ x: w / 2, y: -h / 2 + r + u })],
      [arc, (u) => { const a = u / r; return { x: w / 2 - r + Math.cos(a) * r, y: h / 2 - r + Math.sin(a) * r }; }],
      [straightW, (u) => ({ x: w / 2 - r - u, y: h / 2 })],
      [arc, (u) => { const a = Math.PI / 2 + u / r; return { x: -w / 2 + r + Math.cos(a) * r, y: h / 2 - r + Math.sin(a) * r }; }],
      [straightH, (u) => ({ x: -w / 2, y: h / 2 - r - u })],
      [arc, (u) => { const a = Math.PI + u / r; return { x: -w / 2 + r + Math.cos(a) * r, y: -h / 2 + r + Math.sin(a) * r }; }],
    ];
    for (const [len, at] of segs) {
      if (d <= len) {
        pts.push(at(d));
        break;
      }
      d -= len;
    }
  }
  return pts;
}

/**
 * Board complete — the royal jackpot sign. Beat by beat (from the hit):
 *   scrim + turning gold sunburst → a midnight marquee plaque slams in with the painted
 *   "JACKPOT!" title → its 40 bulbs light up and start chasing → a ruby ribbon unfurls from the
 *   centre under the title ("BOARD COMPLETE") → the jewelled crown drops onto the sign with a
 *   bounce → three gold stars pop round it, spinning into place.
 * Everything runs off the engine's reveal clock on the UI thread; tap NEW ends it early.
 */
export const JackpotBanner = memo(function JackpotBanner({ layout, sv, title, crown, ribbon, star, godrays, font, fx, fxTexture }: BannerProps) {
  const { width, grid } = layout;
  const cx = width / 2;
  const cy = grid.y + grid.height * 0.47;
  const rays = useMemo(() => raysPath(22), []);
  const tw = Math.min(width * 0.78, 330);
  const th = (title.height() / title.width()) * tw;
  // marquee plaque around the title
  const pw = tw * 1.08;
  const ph = th * 1.18;
  const plaque = useMemo(() => Skia.RRectXY(Skia.XYWHRect(cx - pw / 2, cy - ph / 2, pw, ph), 22, 22), [cx, cy, pw, ph]);
  const bulbPts = useMemo(() => marqueePoints(pw - 10, ph - 10, 17, BULBS), [pw, ph]);
  const bulbs = useSpriteData(BULBS);
  // ribbon under the plaque, crown on top
  const rw = tw * 1.12;
  const rh = (ribbon.height() / ribbon.width()) * rw;
  const ry = cy + ph / 2 - rh * 0.28;
  const cw = tw * 0.42;
  const ch = (crown.height() / crown.width()) * cw;
  const crownRestY = cy - ph / 2 - ch * 0.62;
  const ss = tw * 0.16;
  const stars = [
    { x: cx - cw * 0.95, y: crownRestY + ch * 0.55, s: 0.78, at: 520 },
    { x: cx + cw * 0.95, y: crownRestY + ch * 0.55, s: 0.78, at: 600 },
    { x: cx, y: ry + rh * 0.86, s: 0.62, at: 680 },
  ];
  const text = useMemo(() => trackedGlyphs(font, 'BOARD COMPLETE', 0.8), [font]);

  // GPU warm-up: for the first few hundred ms after launch the whole sign is drawn mid-sequence
  // at an invisible opacity, so its shaders and textures are ready before the first jackpot
  // (without this the first jackpot of a session dropped frames; later ones never did)
  const warm = useDerivedValue(() => sv.clock.value < WARM_MS);
  const t = useDerivedValue(() => {
    if (warm.value) return 900;
    const r = sv.reveal.value;
    if (sv.kind.value !== ResultKindCode.Complete || r < BANNER_IN || r > BANNER_OUT) return -1;
    return r - BANNER_IN;
  });
  const opacity = useDerivedValue(() => {
    if (warm.value) return 0.004;
    if (t.value < 0) return 0;
    const out = 1 - progress(sv.reveal.value, BANNER_OUT - 240, BANNER_OUT);
    return Math.min(1, t.value / 110) * out;
  });
  const slam = useDerivedValue(() => {
    const p = progress(t.value, 0, 380);
    const out = progress(sv.reveal.value, BANNER_OUT - 240, BANNER_OUT);
    const s = sv.reduceMotion.value ? 1 : 1.6 - 0.6 * easeOutBack(p) + 0.08 * out;
    const wob = sv.reduceMotion.value ? 0 : Math.sin(t.value / 90) * 0.03 * (1 - p);
    return [{ translateX: cx }, { translateY: cy }, { scale: s }, { rotate: wob }, { translateX: -cx }, { translateY: -cy }];
  });
  const sunburst = useDerivedValue(() => [
    { translateX: cx },
    { translateY: cy },
    { rotate: sv.clock.value / 2400 },
    { scale: width * 0.85 },
  ]);
  // soft Blender light shafts turning the other way behind the hard sunburst
  const shafts = useDerivedValue(() => [
    { translateX: cx },
    { translateY: cy },
    { rotate: -sv.clock.value / 3100 },
    { scale: width * 0.8 },
  ]);
  const scrim = useDerivedValue(() => opacity.value * 0.6);

  // bulbs: light up one by one round the sign, then chase in threes
  useFrameCallback(() => {
    'worklet';
    const tt = t.value;
    bulbs.modify((d) => {
      'worklet';
      if (tt < 0) {
        hideRange(d, 0, BULBS);
        return d;
      }
      const step = Math.floor(sv.clock.value / 110);
      for (let i = 0; i < BULBS; i++) {
        const on = progress(tt, 120 + i * 9, 200 + i * 9);
        const chase = tt > 560 && !sv.reduceMotion.value ? ((i + step) % 3 === 0 ? 1 : 0.25) : 1;
        const p = bulbPts[i];
        put(d, i, cx + p.x, cy + p.y, (0.2 + 0.1 * chase) * on, 0, PF.dot, 1, 0.92, 0.7, on * (0.45 + 0.55 * chase));
      }
      return d;
    }, true);
  });

  const ribbonClip = useDerivedValue(() => {
    const p = sv.reduceMotion.value ? 1 : easeOutCubic(progress(t.value, 140, 520));
    const half = (rw / 2) * p;
    return Skia.XYWHRect(cx - half, ry - 4, half * 2, rh + 8);
  });
  const textOpacity = useDerivedValue(() => progress(t.value, 380, 560));
  const crownT = useDerivedValue(() => {
    if (sv.reduceMotion.value) return [{ translateY: 0 }, { rotate: 0 }];
    const p = progress(t.value, 300, 760);
    const dy = -140 * (1 - easeOutBack(p));
    const tilt = 0.18 * Math.sin(p * 9) * (1 - p);
    return [{ translateX: cx }, { translateY: crownRestY + ch / 2 + dy }, { rotate: tilt }, { translateX: -cx }, { translateY: -(crownRestY + ch / 2) }];
  });
  const crownOpacity = useDerivedValue(() => progress(t.value, 300, 380));
  const crownGlow = useDerivedValue(() => {
    const k = progress(t.value, 700, 820) * (1 - progress(t.value, 820, 1300));
    return k * 0.9;
  });

  return (
    <Group opacity={opacity}>
      <Rect x={grid.x - 8} y={grid.y - 8} width={grid.width + 16} height={grid.height + 16} color={lux.night} opacity={scrim} />
      <Group blendMode="plus" opacity={0.75}>
        <Group transform={shafts}>
          <Image image={godrays} x={-1.18} y={-1.18} width={2.36} height={2.36} />
        </Group>
        <Path path={rays} transform={sunburst}>
          <RadialGradient
            c={vec(0, 0)}
            r={1}
            colors={['rgba(255,240,190,0.85)', 'rgba(247,180,72,0.32)', 'rgba(120,80,20,0)']}
            positions={[0, 0.4, 1]}
          />
        </Path>
      </Group>
      <Group transform={slam}>
        {/* the marquee plaque: midnight lacquer, gold rim, chasing bulbs */}
        <RoundedRect rect={plaque}>
          <LinearGradient start={vec(0, cy - ph / 2)} end={vec(0, cy + ph / 2)} colors={['#2A2378', '#15113F', '#0A0824']} />
        </RoundedRect>
        <RoundedRect rect={plaque} style="stroke" strokeWidth={5}>
          <LinearGradient
            start={vec(cx - pw / 2, cy - ph / 2)}
            end={vec(cx + pw / 2, cy + ph / 2)}
            colors={[lux.gold200, lux.gold600, lux.gold50, lux.gold600, lux.gold900]}
          />
        </RoundedRect>
        <SpriteLayer texture={fxTexture} frames={fx.frames} data={bulbs} capacity={BULBS} blendMode="plus" />
        <Image image={title} x={cx - tw / 2} y={cy - th / 2} width={tw} height={th} />
        {/* the ruby ribbon unfurls from the centre */}
        <Group clip={ribbonClip}>
          <Image image={ribbon} x={cx - rw / 2} y={ry} width={rw} height={rh} />
        </Group>
        <Group opacity={textOpacity}>
          <Glyphs font={font} glyphs={text.glyphs} x={cx - text.width / 2} y={ry + rh * 0.45 + text.baselineOffset + 1.5} style="stroke" strokeWidth={4} strokeJoin="round" color={lux.ruby900} />
          <Glyphs font={font} glyphs={text.glyphs} x={cx - text.width / 2} y={ry + rh * 0.45 + text.baselineOffset}>
            <LinearGradient
              start={vec(0, ry + rh * 0.3)}
              end={vec(0, ry + rh * 0.55)}
              colors={[lux.gold50, lux.gold200, lux.gold400]}
            />
          </Glyphs>
        </Group>
      </Group>
      {/* the crown drops onto the sign and flashes as it lands */}
      <Group transform={crownT} opacity={crownOpacity}>
        <Group blendMode="plus" opacity={crownGlow}>
          <Circle cx={cx} cy={crownRestY + ch * 0.55} r={cw * 0.75}>
            <RadialGradient c={vec(cx, crownRestY + ch * 0.55)} r={cw * 0.75} colors={['rgba(255,246,210,0.9)', 'rgba(247,201,72,0.35)', 'rgba(247,201,72,0)']} />
          </Circle>
        </Group>
        <Image image={crown} x={cx - cw / 2} y={crownRestY} width={cw} height={ch} />
      </Group>
      {stars.map((st, i) => (
        <PopStar key={i} sv={sv} t={t} image={star} x={st.x} y={st.y} size={ss * st.s} at={st.at} />
      ))}
    </Group>
  );
});

type PopStarProps = {
  sv: SpinEngine['sv'];
  t: SharedValue<number>;
  image: SkImage;
  x: number;
  y: number;
  size: number;
  at: number;
};

/** A gold star that pops in spinning, then idles with a slow twinkle. */
const PopStar = memo(function PopStar({ sv, t, image, x, y, size, at }: PopStarProps) {
  const transform = useDerivedValue(() => {
    const p = progress(t.value, at, at + 420);
    const s = sv.reduceMotion.value ? 1 : 0.3 + 0.7 * easeOutBack(p);
    const tw = 1 + 0.06 * Math.sin((t.value - at) / 150);
    const rot = sv.reduceMotion.value ? 0 : -2.2 * (1 - easeOutCubic(p));
    return [{ translateX: x }, { translateY: y }, { scale: s * tw }, { rotate: rot }];
  });
  const opacity = useDerivedValue(() => progress(t.value, at, at + 90));
  return (
    <Group transform={transform} opacity={opacity}>
      <Image image={image} x={-size / 2} y={-size / 2} width={size} height={size} />
    </Group>
  );
});
