import { Fill, Shader, Skia } from '@shopify/react-native-skia';
import { memo } from 'react';
import { useDerivedValue } from 'react-native-reanimated';

import type { SpinEngine } from '../../engine/useSpinEngine';
import { ResultKindCode } from '../../engine/timeline';
import { TREASURE_TINT } from '../../game/treasure';
import { cellCenter, type StageLayout } from '../../theme/layout';
import type { SkinId } from '../../theme/skin';
import { easeOutCubic, progress, smoothstep } from './anim';
import { REVEAL_AT, revealPeak } from './TreasureReveal';

type Props = {
  layout: StageLayout;
  sv: SpinEngine['sv'];
  skin: SkinId;
};

/**
 * The room, as one SkSL fragment shader (no painted backdrop, nothing baked: every pixel is lit
 * live). Layers, back to front:
 *  - a deep two-tone gradient with a soft lift of light behind the board;
 *  - drifting haze (two octaves of value noise flowing upward) that the beams light up, so the
 *    light reads as volume, not as a gradient;
 *  - four moving-head stage lights above the top edge, each a soft cone on a lazy pendulum; they
 *    sweep faster as the reel speeds up (driven by the engine's integrated chase phase), dim with
 *    the suspense, and on a reward all four swing onto the winning cell and take the treasure's
 *    colour;
 *  - two depth layers of bokeh (out-of-focus room lights) rising slowly and twinkling;
 *  - the reward light: a flash of the treasure's colour from the cell and a ring of light racing
 *    out across the room;
 *  - light pooling on the stage floor, a vignette, a soft filmic shoulder and a 1-LSB dither so
 *    the deep gradients never band.
 */
const SKSL = `
uniform float2 res;
uniform float time;
uniform float drive;
uniform float energy;
uniform float calm;
uniform float3 focus;
uniform float4 hit;
uniform float2 wave;
uniform float dark;
uniform float2 spot;
uniform float3 base0;
uniform float3 base1;
uniform float3 lightA;
uniform float3 lightB;

float hash21(float2 p) {
  p = fract(p * float2(233.34, 851.73));
  p += dot(p, p + 23.45);
  return fract(p.x * p.y);
}

float vnoise(float2 p) {
  float2 i = floor(p);
  float2 f = fract(p);
  float2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + float2(1.0, 0.0)), u.x),
             mix(hash21(i + float2(0.0, 1.0)), hash21(i + float2(1.0, 1.0)), u.x), u.y);
}

// a stage light at o aimed at angle ang (0 = straight down, + = towards +x): a soft cone that
// fades with distance and is dark right at the lamp
float cone(float2 p, float2 o, float ang, float w, float len) {
  float2 d = p - o;
  float r = length(d);
  float a = atan(d.x, d.y) - ang;
  return exp(-a * a / (w * w)) * exp(-r / len) * smoothstep(0.0, 90.0, r);
}

half4 main(float2 p) {
  float2 uv = p / res;
  float aspect = res.y / res.x;

  // room
  float3 col = mix(base0, base1, smoothstep(0.0, 0.7, uv.y));
  float2 q = (uv - float2(0.5, 0.42)) * float2(1.0, aspect * 0.62);
  col += base1 * 0.85 * exp(-dot(q, q) * 4.0);

  // haze the light travels through
  float hz = 0.62 * vnoise(p * 0.0045 + float2(time * 0.035, time * 0.06))
           + 0.38 * vnoise(p * 0.012 + float2(-time * 0.05, time * 0.09));

  // moving heads
  float3 beams = float3(0.0);
  float3 lamps = float3(0.0);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float2 o = float2(res.x * (0.08 + 0.28 * fi), -res.y * 0.05);
    float lean = 0.42 * (0.5 - fi / 3.0);
    float sweep = lean + 0.3 * sin(time * (0.11 + 0.03 * fi) + drive * (0.22 + 0.05 * fi) + fi * 1.9);
    float2 to = focus.xy - o;
    float ang = mix(sweep, atan(to.x, to.y), focus.z);
    float b = cone(p, o, ang, mix(0.095, 0.05, focus.z), res.y * mix(0.48, 0.8, focus.z));
    float3 c = mix(lightA, lightB, fract(fi * 0.5) * 2.0);
    c = mix(c, hit.rgb, focus.z * 0.85);
    beams += c * b;
    // the lamp itself, just above the screen: its bloom spills down over the top edge
    float2 lo = (p - o) / res.x;
    lamps += c * exp(-length(lo * float2(1.0, 1.6)) * 7.5);
  }
  float gain = (0.34 + 0.3 * energy + 0.6 * focus.z) * (1.0 - 0.65 * calm);
  float3 lit = beams * gain * (0.3 + 0.95 * hz);
  float3 lampLit = lamps * (0.3 + 0.2 * energy + 0.3 * focus.z) * (1.0 - 0.5 * calm);

  // bokeh: two depth layers of out-of-focus lights, rising
  for (int l = 0; l < 2; l++) {
    float fl = float(l);
    float cell = mix(62.0, 116.0, fl);
    float2 g = p / cell + float2(fl * 3.7, time * mix(0.07, 0.04, fl));
    float2 id = floor(g);
    float2 f = fract(g) - 0.5;
    float h = hash21(id + fl * 17.0);
    float2 off = (float2(hash21(id + 3.1), hash21(id + 8.3)) - 0.5) * 0.45;
    float rad = mix(0.1, 0.25, hash21(id + 5.7));
    float d = length(f - off);
    // a lens bokeh disc: flat, slightly brighter towards its rim, soft edge
    float disc = smoothstep(rad, rad * 0.8, d) * (0.75 + 0.25 * smoothstep(rad * 0.3, rad * 0.95, d));
    float tw = 0.55 + 0.45 * sin(time * (0.7 + 1.3 * h) + h * 31.0);
    float3 bc = mix(lightA, lightB, step(0.5, hash21(id + 9.9)));
    col += bc * disc * tw * step(0.62, h) * mix(0.15, 0.09, fl) * (1.0 - 0.5 * calm);
  }

  // house lights down: on a reward the room goes dark, and only the moving heads (now all on
  // the treasure) and the reward light are left
  col *= 1.0 - dark;
  col += lit * (1.0 - 0.3 * dark) + lampLit * (1.0 - dark);

  // reward light
  float dist = length(p - focus.xy);
  col += hit.rgb * hit.a * exp(-dist * dist / (res.x * res.x * 0.22));
  float wd = (dist - wave.x) / (14.0 + max(wave.x, 0.0) * 0.1);
  col += hit.rgb * wave.y * 0.45 * exp(-wd * wd);

  // stage floor
  col += lightA * 0.2 * (1.0 - dark) * smoothstep(0.8, 1.0, uv.y) * (0.75 + 0.25 * sin(time * 0.8 + uv.x * 5.0));

  // vignette, soft shoulder, dither
  float2 v = (uv - 0.5) * float2(1.15, 0.92);
  col *= 1.0 - 0.6 * smoothstep(0.32, 0.82, length(v));
  col = min(col, 0.75 + (col - 0.75) / (1.0 + max(col - 0.75, 0.0) * 3.0));
  col += (hash21(p + fract(time * 7.0)) - 0.5) / 255.0;
  return half4(half3(col), 1.0);
}
`;

const effect = Skia.RuntimeEffect.Make(SKSL);
if (!effect) throw new Error('Backdrop shader failed to compile');

/**
 * The same four moving heads, drawn a second time *over* the wheel and the board (screen blend),
 * so their light falls on the stage instead of only filling the room behind it. At rest it is a
 * faint wash where the cones cross the stage; on a reward the cones that converge on the cell
 * light the keys along their path, and a pool of the treasure's colour opens on the cell they
 * meet at. The cones use the backdrop's exact angles, so the two passes read as one light.
 */
const STAGE_SKSL = `
uniform float2 res;
uniform float time;
uniform float drive;
uniform float energy;
uniform float calm;
uniform float3 focus;
uniform float4 hit;
uniform float2 wave;
uniform float dark;
uniform float2 spot;
uniform float3 base0;
uniform float3 base1;
uniform float3 lightA;
uniform float3 lightB;

float hash21(float2 p) {
  p = fract(p * float2(233.34, 851.73));
  p += dot(p, p + 23.45);
  return fract(p.x * p.y);
}

float vnoise(float2 p) {
  float2 i = floor(p);
  float2 f = fract(p);
  float2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + float2(1.0, 0.0)), u.x),
             mix(hash21(i + float2(0.0, 1.0)), hash21(i + float2(1.0, 1.0)), u.x), u.y);
}

float cone(float2 p, float2 o, float ang, float w, float len) {
  float2 d = p - o;
  float r = length(d);
  float a = atan(d.x, d.y) - ang;
  return exp(-a * a / (w * w)) * exp(-r / len) * smoothstep(0.0, 90.0, r);
}

half4 main(float2 p) {
  float3 beams = float3(0.0);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float2 o = float2(res.x * (0.08 + 0.28 * fi), -res.y * 0.05);
    float lean = 0.42 * (0.5 - fi / 3.0);
    float sweep = lean + 0.3 * sin(time * (0.11 + 0.03 * fi) + drive * (0.22 + 0.05 * fi) + fi * 1.9);
    float2 to = focus.xy - o;
    float ang = mix(sweep, atan(to.x, to.y), focus.z);
    // a touch wider than in the room: on the stage the cone is a pool of light, not a shaft
    float b = cone(p, o, ang, mix(0.095, 0.065, focus.z), res.y * mix(0.48, 0.9, focus.z));
    float3 c = mix(lightA, lightB, fract(fi * 0.5) * 2.0);
    c = mix(c, hit.rgb, focus.z * 0.85);
    beams += c * b;
  }
  // aimed at the treasure, the cones end on it: no light spilling on past it over the HUD
  beams *= mix(1.0, smoothstep(focus.y + res.y * 0.16, focus.y, p.y), focus.z);
  // a little dust in the light, so the shafts over the keys are not flat
  float dust = 0.75 + 0.25 * vnoise(p * 0.02 + float2(time * 0.05, time * 0.11));
  float gain = (0.06 + 0.06 * energy) * (1.0 - 0.7 * calm) * (1.0 - dark) + 0.7 * focus.z;
  float3 light = beams * gain * dust;
  // where the lights meet: a soft elliptical pool on the stage (wider than tall, like a spot on a floor)
  float2 d = (p - focus.xy) * float2(1.0, 1.35);
  light += hit.rgb * focus.z * 0.5 * exp(-dot(d, d) / (res.x * res.x * 0.02));
  return half4(half3(light), 1.0);
}
`;

/**
 * House lights down, over the stage: black, with a soft spotlight hole on the treasure. The HUD
 * below the board dims less, so the banner can still name the find.
 */
const DIM_SKSL = `
uniform float2 res;
uniform float time;
uniform float drive;
uniform float energy;
uniform float calm;
uniform float3 focus;
uniform float4 hit;
uniform float2 wave;
uniform float dark;
uniform float2 spot;
uniform float3 base0;
uniform float3 base1;
uniform float3 lightA;
uniform float3 lightB;

half4 main(float2 p) {
  float2 d = (p - focus.xy) * float2(1.0, 1.1);
  float hole = smoothstep(spot.x * 0.4, spot.x * 1.0, length(d));
  float hud = mix(1.0, 0.88, smoothstep(spot.y - 10.0, spot.y + 40.0, p.y));
  float a = dark * hole * hud;
  return half4(0.0, 0.0, 0.0, a);
}
`;

const dimEffect = Skia.RuntimeEffect.Make(DIM_SKSL);
if (!dimEffect) throw new Error('Stage dim shader failed to compile');

const stageEffect = Skia.RuntimeEffect.Make(STAGE_SKSL);
if (!stageEffect) throw new Error('Stage light shader failed to compile');

/** Per skin: room gradient (top, centre) and the two light colours. */
const ROOM: Record<SkinId, { base0: number[]; base1: number[]; lightA: number[]; lightB: number[] }> = {
  neon: { base0: [0.1, 0.02, 0.22], base1: [0.2, 0.04, 0.38], lightA: [1.0, 0.32, 0.8], lightB: [1.0, 0.74, 0.32] },
  royal: { base0: [0.015, 0.025, 0.1], base1: [0.04, 0.07, 0.24], lightA: [0.38, 0.6, 1.0], lightB: [1.0, 0.76, 0.36] },
};

/** The light rig's uniforms, shared by the room (behind the stage) and the stage lights (over it). */
function useLightRig({ layout, sv, skin }: Props) {
  const { width, height } = layout;
  const room = ROOM[skin];
  const home = { x: width / 2, y: layout.grid.y + layout.grid.height / 2 };
  const hudTop = layout.frame.y + layout.frame.height;

  return useDerivedValue(() => {
    const reduce = sv.reduceMotion.value;
    const r = sv.reveal.value;
    const idx = sv.winIdx.value;
    const kind = sv.kind.value;
    let fx = home.x;
    let fy = home.y;
    let aim = 0;
    let dark = 0;
    let spotR = layout.cell * 1.5;
    let flash = 0;
    let waveR = -1;
    let waveA = 0;
    let tr = 1;
    let tg = 0.85;
    let tb = 0.45;
    if (idx >= 0 && r >= 0 && kind !== ResultKindCode.Repeat) {
      const tIdx = sv.treasure.value[idx];
      const p = revealPeak(tIdx);
      const complete = kind === ResultKindCode.Complete;
      const c = complete ? home : cellCenter(layout, idx);
      fx = c.x;
      fy = c.y;
      const t = r - REVEAL_AT;
      // Lights down: just after the impact the house lights cut (a 120 ms cut, like a
      // switch), so the treasure rises in the dark. The moving heads then swing slowly onto it
      // (≈ 0.7 s) and become the only light in the room. Once the treasure is seated the house
      // comes back up, slower than it went down. Rarer finds get a darker room and a longer hold.
      const hold = complete ? 2600 : p.end + 150;
      const back = 1 - smoothstep(hold, hold + 850, t);
      dark = easeOutCubic(progress(t, -240, -120)) * back * (complete ? 1 : 0.95 + 0.0167 * p.tier) * (reduce ? 0.7 : 1);
      aim = reduce ? 0 : smoothstep(-200, 520, t) * back * (complete ? 0.9 : 0.72 + 0.07 * p.tier);
      if (complete) spotR = layout.grid.width * 0.42;
      if (t >= 0) {
        flash = Math.exp(-t / 420) * (complete ? 0.8 : 0.42 + 0.12 * p.tier) * (reduce ? 0.5 : 1);
        if (!reduce) {
          waveR = t * 1.1;
          waveA = Math.exp(-t / 620) * (complete ? 1 : 0.55 + 0.15 * p.tier);
        }
      }
      tr = TREASURE_TINT[tIdx * 3];
      tg = TREASURE_TINT[tIdx * 3 + 1];
      tb = TREASURE_TINT[tIdx * 3 + 2];
    }
    return {
      res: [width, height],
      time: reduce ? 0 : sv.clock.value / 1000,
      drive: reduce ? 0 : sv.chase.value / 1000,
      energy: sv.speed.value,
      calm: sv.tension.value,
      focus: [fx, fy, aim],
      hit: [tr, tg, tb, flash],
      wave: [waveR, waveA],
      dark,
      spot: [spotR, hudTop],
      base0: room.base0,
      base1: room.base1,
      lightA: room.lightA,
      lightB: room.lightB,
    };
  });
}

export const Backdrop = memo(function Backdrop(props: Props) {
  const uniforms = useLightRig(props);
  return (
    <Fill>
      <Shader source={effect} uniforms={uniforms} />
    </Fill>
  );
});

/**
 * The stage at a reward: house lights down over everything drawn so far (wheel, board, HUD),
 * with a spotlight hole on the treasure, then the moving heads' light on top. Draw it in world
 * space after the HUD and before the reward effects (flying number, particles, loot beam,
 * treasure), so those burn bright in the dark.
 */
export const StageLights = memo(function StageLights(props: Props) {
  const uniforms = useLightRig(props);
  return (
    <>
      <Fill>
        <Shader source={dimEffect} uniforms={uniforms} />
      </Fill>
      <Fill blendMode="screen">
        <Shader source={stageEffect} uniforms={uniforms} />
      </Fill>
    </>
  );
});
