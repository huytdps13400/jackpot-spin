import { Group, LinearGradient, Paint, Rect, vec, type SkImage } from '@shopify/react-native-skia';
import { memo, useMemo } from 'react';
import { makeMutable, useDerivedValue, useFrameCallback, type SharedValue } from 'react-native-reanimated';

import { hide, put, useSpriteData } from '../../engine/sprites/layer';
import { SpriteLayer } from '../../engine/sprites/SpriteLayer';
import type { SpinEngine } from '../../engine/useSpinEngine';
import { Phase, ResultKindCode, Reveal } from '../../engine/timeline';
import type { StageLayout } from '../../theme/layout';
import { easeOutCubic, progress } from './anim';
import { GlyphShine } from './GlyphShine';
import { TF, type TextAtlas } from './textAtlas';

type Props = {
  layout: StageLayout;
  sv: SpinEngine['sv'];
  atlas: TextAtlas;
  texture: SharedValue<SkImage | null>;
};

const TREASURE_MSG = 10;

/** Which line the banner should say right now (pure function of the engine state). */
function pick(sv: SpinEngine['sv']) {
  'worklet';
  const ph = sv.phase.value;
  const r = sv.reveal.value;
  // A reveal clamps at Steady and a new spin flushes the old one to Steady, so r ∈ [0, Steady)
  // means "this spin's result is locked in"; anything else while the wheel moves is pre-lock.
  const fresh = r >= 0 && r < Reveal.Steady;
  if (!fresh && ph !== Phase.Idle && ph !== Phase.Snap) return sv.tension.value > 0.45 ? 2 : 1;
  if (fresh && r < Reveal.ChipIn) return -1; // hold the current line through the hit
  if (sv.winIdx.value < 0) return sv.resetAt.value >= 0 ? 8 : 0;
  const kind = sv.kind.value;
  if (kind === ResultKindCode.Repeat) return 4;
  if (kind === ResultKindCode.Complete) return fresh ? 7 : 9;
  const hits = sv.lineHits.value;
  if (hits && (r < 0 || r >= Reveal.LineStart)) {
    let n = 0;
    for (let i = 0; i < 22; i++) if (hits & (1 << i)) n++;
    return n > 1 ? 6 : 5;
  }
  const t = sv.treasure.value[sv.winIdx.value];
  return t === undefined ? 3 : TREASURE_MSG + t;
}

/**
 * The info banner. Every message is a pre-lit sprite in the text atlas (see textAtlas.ts);
 * switching lines is a cross-slide (old one exits left, new one slides in from the right with a
 * small scale-up) that writes itself on left → right behind a soft edge, then a shine band masked
 * by the letters themselves (GlyphShine) — all on the UI thread, one Atlas draw,
 * no React render per message.
 */
export const Banner = memo(function Banner({ layout, sv, atlas, texture }: Props) {
  const { banner } = layout;
  const st = useMemo(
    () => ({ cur: makeMutable(-1), prev: makeMutable(-1), at: makeMutable(-10000) }),
    [],
  );
  const lines = useSpriteData(2);
  const cy = banner.y + banner.height / 2;
  const cx = banner.x + banner.width / 2;
  // lines wider than the glass shrink to fit it
  const fit = useMemo(() => {
    const room = banner.width * 0.84;
    return atlas.bannerWidth.map((w) => atlas.scale * Math.min(1, room / w));
  }, [atlas, banner.width]);

  useFrameCallback(() => {
    'worklet';
    const m = pick(sv);
    if (m >= 0 && m !== st.cur.value) {
      st.prev.value = st.cur.value;
      st.cur.value = m;
      st.at.value = sv.clock.value;
    }
    const t = sv.clock.value - st.at.value;
    const cur = st.cur.value;
    const prev = st.prev.value;
    lines.modify((d) => {
      'worklet';
      if (prev >= 0 && prev !== cur) {
        const out = progress(t, 0, 110);
        put(d, 0, cx - 30 * out, cy, fit[prev], 0, TF.banner0 + prev, 1, 1, 1, 1 - out);
      } else hide(d, 0);
      if (cur >= 0) {
        const p = easeOutCubic(progress(t, 70, 360));
        put(d, 1, cx + 36 * (1 - p), cy, fit[cur] * (0.92 + 0.08 * p), 0, TF.banner0 + cur, 1, 1, 1, progress(t, 70, 220));
      } else hide(d, 1);
      return d;
    }, true);
  });

  const intro = useDerivedValue(() => progress(sv.clock.value, 850, 1150));
  // the new line writes itself on left → right behind a soft edge (a staggered-letter reveal
  // for a line that is one sprite), riding the slide-in
  const EDGE = 56;
  const wipeT = useDerivedValue(() => {
    const p = sv.reduceMotion.value ? 1 : easeOutCubic(progress(sv.clock.value - st.at.value, 60, 460));
    return [{ translateX: banner.x - EDGE + (banner.width + EDGE * 2) * p }];
  });
  const box = useMemo(
    () => ({ x: banner.x + banner.width * 0.1, y: banner.y + banner.height * 0.2, width: banner.width * 0.8, height: banner.height * 0.6 }),
    [banner],
  );

  return (
    <Group opacity={intro}>
      <Group clip={{ x: banner.x + 8, y: banner.y + 2, width: banner.width - 16, height: banner.height - 4 }}>
        <Group layer={<Paint />}>
          <SpriteLayer texture={texture} frames={atlas.frames} data={lines} capacity={2} />
          <Group transform={wipeT}>
            <Rect x={-banner.width * 2} y={banner.y} width={banner.width * 2 + EDGE} height={banner.height} blendMode="dstIn">
              <LinearGradient
                start={vec(banner.width * -2, 0)}
                end={vec(EDGE, 0)}
                colors={['#000', '#000', 'rgba(0,0,0,0)']}
                positions={[0, (banner.width * 2) / (banner.width * 2 + EDGE), 1]}
              />
            </Rect>
          </Group>
        </Group>
        {/* the light catches the letters themselves (the line's own sprite is the mask) */}
        <GlyphShine sv={sv} piece={1} box={box}>
          <SpriteLayer texture={texture} frames={atlas.frames} data={lines} capacity={2} />
        </GlyphShine>
      </Group>
    </Group>
  );
});
