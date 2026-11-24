import {
  BlurStyle,
  FilterMode,
  MipmapMode,
  PaintStyle,
  Picture,
  Skia,
  TileMode,
  createPicture,
  type SkCanvas,
  type SkFont,
  type SkImage,
} from '@shopify/react-native-skia';
import { memo, useMemo } from 'react';

import { nine } from '../../theme/art';
import type { Rect, StageLayout } from '../../theme/layout';
import { lux, space } from '../../theme/tokens';
import { TEXT_STYLE, capHeight, drawGameText, type TextFx } from './gameText';

/**
 * Static chrome, recorded once into two Skia Pictures (one draw each, re-recorded only when the
 * layout changes): the painted panels are nine-sliced so their bevels, glows and corner
 * ornaments keep the painted proportions at any phone size.
 */

type NineSpec = { center: readonly number[]; cap: number };

function paint() {
  const p = Skia.Paint();
  p.setAntiAlias(true);
  return p;
}

/** Nine-slice `img` into `dst`, drawn at `spec.cap / thickness` image px per point. */
function drawNine(canvas: SkCanvas, img: SkImage, spec: NineSpec, dst: Rect, thickness: number) {
  const k = spec.cap / thickness;
  const [x0, y0, x1, y1] = spec.center;
  canvas.save();
  canvas.scale(1 / k, 1 / k);
  canvas.drawImageNine(
    img,
    Skia.XYWHRect(x0, y0, x1 - x0, y1 - y0),
    Skia.XYWHRect(dst.x * k, dst.y * k, dst.width * k, dst.height * k),
    FilterMode.Linear,
    paint(),
  );
  canvas.restore();
}

function drawImageIn(canvas: SkCanvas, img: SkImage, x: number, y: number, w: number, h: number) {
  canvas.drawImageRectOptions(
    img,
    Skia.XYWHRect(0, 0, img.width(), img.height()),
    Skia.XYWHRect(x, y, w, h),
    FilterMode.Linear,
    MipmapMode.Linear,
    paint(),
  );
}

/** Italic lean of the panel's gold lettering (matches the plate and the banner). */
export const PANEL_SKEW = -0.06;

/** Gold display lettering in the arcade sticker style (see gameText.ts). */
export function drawGoldText(canvas: SkCanvas, text: string, x: number, baseline: number, font: SkFont, fx: TextFx = {}) {
  drawGameText(canvas, text, x, baseline, font, TEXT_STYLE.gold, { skew: PANEL_SKEW, ...fx });
  return font.measureText(text);
}

export type ChromeImages = {
  frame: SkImage;
  plate: SkImage;
  banner: SkImage;
  panel: SkImage;
  pill: SkImage;
  square: SkImage;
  logo: SkImage;
  flag: SkImage;
  coins: SkImage;
  crown: SkImage;
};

/** Where the counter's digits go (right-aligned to `right`, sharing `baseline`). */
export function counterGeometry(layout: StageLayout, digitFont: SkFont, smallFont: SkFont) {
  const { panel } = layout;
  const slash = smallFont.measureText('/100');
  // optically 24 pt in from the panel's edge, like the label on the left: the italic "/100"
  // advance already carries ~4 pt of trailing bearing
  const right = panel.x + panel.width - space[5] - slash.width - space[1];
  const digits = digitFont.measureText('0123456789');
  const baseline = panel.y + panel.height / 2 - (digits.y + digits.height / 2) + 1;
  return { right, baseline, slashX: right + space[1], capH: digits.height };
}

type BoardProps = { layout: StageLayout; images: ChromeImages };

/** Board well + painted frame (drawn above the wheel, which tucks behind its top edge). */
export const BoardChrome = memo(function BoardChrome({ layout, images }: BoardProps) {
  const picture = useMemo(() => {
    const { frame, grid, cell, cellW, gap, frameT, width, height } = layout;
    return createPicture((canvas) => {
      // the well: deep glass behind the keys
      const well = Skia.XYWHRect(grid.x - 7, grid.y - 7, grid.width + 14, grid.height + 14);
      const body = paint();
      body.setShader(
        Skia.Shader.MakeLinearGradient(
          { x: 0, y: well.y },
          { x: 0, y: well.y + well.height },
          ['#0B0A2A', '#110F36', '#06061C'].map((c) => Skia.Color(c)),
          [0, 0.4, 1],
          TileMode.Clamp,
        ),
      );
      canvas.drawRRect(Skia.RRectXY(well, 14, 14), body);
      // key sockets, so keys that pop or ripple reveal a recess under them
      const socket = paint();
      socket.setColor(Skia.Color('rgba(1,1,10,0.6)'));
      for (let i = 0; i < 100; i++) {
        const x = grid.x + (i % 10) * (cellW + gap);
        const y = grid.y + Math.floor(i / 10) * (cell + gap);
        canvas.drawRRect(Skia.RRectXY(Skia.XYWHRect(x + 1, y + 2, cellW - 2, cell - 2), cell * 0.18, cell * 0.18), socket);
      }
      drawNine(canvas, images.frame, nine.frame, frame, frameT + 4);
    }, Skia.XYWHRect(0, 0, width, height));
  }, [layout, images]);
  return <Picture picture={picture} />;
});

type PanelProps = { layout: StageLayout; images: ChromeImages; labelFont: SkFont; smallFont: SkFont; digitFont: SkFont };

/** Logo, result plate, banner, counter panel (with its static lettering) and the control bar. */
export const PanelChrome = memo(function PanelChrome({ layout, images, labelFont, smallFont, digitFont }: PanelProps) {
  const picture = useMemo(() => {
    const { plate, banner, panel, bar, pills, spin, sound, haptics, topBar, width, height } = layout;
    return createPicture((canvas) => {
      // logo
      const lh = topBar.height;
      drawImageIn(canvas, images.logo, topBar.x, topBar.y, (images.logo.width() / images.logo.height()) * lh, lh);

      drawNine(canvas, images.plate, nine.plate, plate, plate.height);
      drawNine(canvas, images.banner, nine.banner, banner, banner.height);
      drawNine(canvas, images.panel, nine.panel, panel, panel.height);
      // a fine gold inlay inside the plaque's bevel, like a jeweller's frame
      const inlay = paint();
      inlay.setStyle(PaintStyle.Stroke);
      inlay.setStrokeWidth(1.2);
      inlay.setShader(
        Skia.Shader.MakeLinearGradient(
          { x: panel.x, y: 0 },
          { x: panel.x + panel.width, y: 0 },
          [lux.gold800, lux.gold400, lux.gold50, lux.gold400, lux.gold800].map((c) => Skia.Color(c)),
          [0, 0.25, 0.5, 0.75, 1],
          TileMode.Clamp,
        ),
      );
      canvas.drawRRect(Skia.RRectXY(Skia.XYWHRect(panel.x + 9, panel.y + 8, panel.width - 18, panel.height - 16), 12, 12), inlay);

      // counter lettering: "CELLS / CLAIMED" stacked on the left, "/100" after the digits
      const lx = panel.x + space[6];
      const ly = panel.y + panel.height / 2;
      const cap = capHeight(labelFont);
      const lead = cap * 0.12;
      drawGoldText(canvas, 'CELLS', lx, ly - lead, labelFont, { depth: 0.8 });
      drawGoldText(canvas, 'CLAIMED', lx, ly + cap + lead, labelFont, { depth: 0.8 });
      const g = counterGeometry(layout, digitFont, smallFont);
      drawGoldText(canvas, '/100', g.slashX, g.baseline, smallFont, { depth: 0.8 });

      // control bar: midnight glass with a polished gold top edge
      const barR = Skia.RRectXY(Skia.XYWHRect(bar.x, bar.y, bar.width, bar.height), 16, 16);
      const glass = paint();
      glass.setShader(
        Skia.Shader.MakeLinearGradient(
          { x: 0, y: bar.y },
          { x: 0, y: bar.y + bar.height },
          ['#1A1650', '#0E0C30', '#07061C'].map((c) => Skia.Color(c)),
          [0, 0.5, 1],
          TileMode.Clamp,
        ),
      );
      canvas.drawRRect(barR, glass);
      const edge = paint();
      edge.setStyle(PaintStyle.Stroke);
      edge.setStrokeWidth(1.8);
      edge.setShader(
        Skia.Shader.MakeLinearGradient(
          { x: bar.x, y: 0 },
          { x: bar.x + bar.width, y: 0 },
          [lux.gold900, lux.gold600, lux.gold50, lux.gold600, lux.gold900].map((c) => Skia.Color(c)),
          [0, 0.28, 0.5, 0.72, 1],
          TileMode.Clamp,
        ),
      );
      const glow = edge.copy();
      glow.setStrokeWidth(5);
      glow.setAlphaf(0.5);
      glow.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, 4, true));
      canvas.drawRRect(barR, glow);
      canvas.drawRRect(barR, edge);

      // read-out pills, each crowned by its icon peeking over the top edge (as in the mock-up)
      const iconS = 24;
      const pillIcons: [Rect, SkImage][] = [
        [pills.round, images.flag],
        [pills.last, images.coins],
        [pills.best, images.crown],
      ];
      for (const [r, icon] of pillIcons) {
        drawNine(canvas, images.pill, nine.pill, r, r.height);
        drawImageIn(canvas, icon, r.x + r.width / 2 - iconS / 2, r.y - iconS * 0.62, iconS, iconS);
      }
      for (const c of [sound, haptics]) {
        const sz = c.r * 2 + 2;
        drawImageIn(canvas, images.square, c.cx - sz / 2, c.cy - sz / 2, sz, sz);
      }

      // SPIN socket: a recessed ring the button sits in
      const socket = paint();
      socket.setShader(
        Skia.Shader.MakeRadialGradient(
          { x: spin.cx, y: spin.cy + 3 },
          spin.r + 9,
          ['#02020A', '#0B0A26', 'rgba(11,10,38,0)'].map((c) => Skia.Color(c)),
          [0, 0.86, 1],
          TileMode.Clamp,
        ),
      );
      canvas.drawCircle(spin.cx, spin.cy + 3, spin.r + 9, socket);
    }, Skia.XYWHRect(0, 0, width, height));
  }, [layout, images, labelFont, smallFont, digitFont]);
  return <Picture picture={picture} />;
});
