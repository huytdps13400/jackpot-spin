import { Canvas, Picture, Skia, createPicture, useTypeface, type SkFont } from '@shopify/react-native-skia';
import { memo, useMemo } from 'react';

import { PILL_TEXT_PAD, type Rect, type StageLayout } from '../../theme/layout';
import { fonts } from '../../theme/tokens';
import { TEXT_STYLE, capHeight, drawGameText, trackedWidth } from './gameText';

type Props = { layout: StageLayout; round: number; last: number | null; best: number };

const TRACKING = 0;
/** Inline padding inside a pill, each side (the layout sizes the pills with the same value). */
const PAD = PILL_TEXT_PAD;

/** "LABEL value" in one line of chrome lettering, centred under the pill's icon, shrunk to fit. */
function drawReadout(canvas: Parameters<Parameters<typeof createPicture>[0]>[0], r: Rect, text: string, font: SkFont) {
  const cap = capHeight(font);
  const w = trackedWidth(font, text, TRACKING);
  const room = r.width - PAD * 2;
  const k = Math.min(1, room / w);
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2 + 1; // the icon crowns the pill: a hair low reads as centred
  canvas.save();
  canvas.translate(cx, cy);
  canvas.scale(k, k);
  drawGameText(canvas, text, -w / 2, cap / 2, font, TEXT_STYLE.ice, { tracking: TRACKING, depth: 0.7, shadow: 0.6 });
  canvas.restore();
}

/**
 * The control bar's read-outs ("ROUND 7", "LAST 43", "BEST 12") in the same chrome arcade lettering
 * as the banner. A tiny canvas of its own: it re-records one Picture when a value changes (once
 * per spin), so the main scene never re-renders for it. Accessibility lives on the Hud's views.
 */
export const Readouts = memo(function Readouts({ layout, round, last, best }: Props) {
  const face = useTypeface(fonts.numeric);
  const { pills, bar, width } = layout;
  // a canvas just over the control bar, not the whole screen
  const top = bar.y - 12;
  // one type size for all three read-outs, chosen so each pill fits its usual widest value
  // ("ROUND 99", "LAST 99"): the size never jumps between spins or between pills; the rare
  // three-digit value (LAST 100, BEST 100, ROUND 100+) shrinks to fit its own pill
  const font = useMemo(() => {
    if (!face) return null;
    const probe = Skia.Font(face, 100);
    const em = (t: string) => trackedWidth(probe, t, TRACKING) / 100;
    const size = Math.min(
      13,
      (pills.round.width - PAD * 2) / em('ROUND 99'),
      (pills.last.width - PAD * 2) / em('LAST 88'),
      (pills.best.width - PAD * 2) / em('BEST 88'),
    );
    return Skia.Font(face, size);
  }, [face, pills]);
  const picture = useMemo(() => {
    if (!font) return null;
    return createPicture((canvas) => {
      canvas.translate(0, -top);
      drawReadout(canvas, pills.round, `ROUND ${round}`, font);
      drawReadout(canvas, pills.last, `LAST ${last ?? '–'}`, font);
      drawReadout(canvas, pills.best, `BEST ${best}`, font);
    }, Skia.XYWHRect(0, 0, width, bar.height + 24));
  }, [font, pills, round, last, best, width, bar, top]);
  if (!picture) return null;
  return (
    <Canvas style={{ position: 'absolute', left: 0, top, width, height: bar.height + 24 }} pointerEvents="none">
      <Picture picture={picture} />
    </Canvas>
  );
});
