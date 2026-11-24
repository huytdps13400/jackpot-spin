import { Skia, createPicture, type SkFont } from '@shopify/react-native-skia';

import { FrameBuilder } from '../../engine/sprites/layer';
import type { Atlas } from './textures';
import { TEXT_PAD, TEXT_STYLE, capHeight, drawGameText, trackedWidth } from './gameText';

/** Info-banner lines. The order is the index `Banner` picks (see `pick` there). */
export const BANNER_MESSAGES = [
  { text: 'TAP SPIN TO PLAY', gold: false },
  { text: 'GOOD LUCK!', gold: false },
  { text: 'HERE IT COMES…', gold: false },
  { text: 'NEW CELL CLAIMED!', gold: false },
  { text: 'ALREADY CLAIMED', gold: false },
  { text: 'LINE COMPLETE!', gold: true },
  { text: 'DOUBLE LINE!', gold: true },
  { text: 'BOARD COMPLETE!', gold: true },
  { text: 'NEW BOARD · SPIN!', gold: false },
  { text: 'SPIN FOR A NEW BOARD', gold: true },
  // 10 + treasure index (game/treasure.ts): what the opened vault held
  { text: 'GOLD COIN FOUND', gold: false },
  { text: 'GOLD BARS FOUND', gold: false },
  { text: 'EMERALD FOUND!', gold: false },
  { text: 'SAPPHIRE FOUND!', gold: false },
  { text: 'AMETHYST FOUND!', gold: false },
  { text: 'RARE RUBY!', gold: true },
  { text: 'ROYAL CROWN!', gold: true },
  { text: 'LEGENDARY DIAMOND!', gold: true },
  { text: 'TREASURE CHEST!', gold: true },
] as const;

/** Italic lean of the display lettering (plate digits, banner). */
const SKEW = -0.06;
const PLATE_TRACKING = -0.035;
const BANNER_TRACKING = 0.02;

/**
 * Text atlas frame layout:
 *   plate digits — `plate0 + style * 20 + part * 10 + digit`, style 0 = gold / 1 = ice,
 *                  part 0 = base (shadow, extrusion, rim, outline) / 1 = face;
 *   banner lines — `banner0 + message index`.
 */
export const TF = { plate0: 0, banner0: 40 } as const;

export type TextAtlas = Atlas & {
  /** texture px → pt */
  scale: number;
  /** Plate digits: cap height in texture px. */
  plateCapPx: number;
  /** Per number n (1..100): digit count at [n * 4] and the digits' x offsets from the number's
   * centre (texture px) at [n * 4 + 1 + k]. Flat, so worklets can index it without allocating. */
  plateLayout: number[];
  /** Per banner line: width in pt at scale 1 (for fitting). */
  bannerWidth: number[];
};

/**
 * Display lettering baked once into one texture: the result plate's digits (two layers each, so
 * a composed number's outlines merge), and every info-banner line, pre-shaped and pre-lit. At run
 * time each is one sprite — slams, slides and fades are just sprite transforms on the UI thread.
 */
export function buildTextAtlas(plateFont: SkFont, bannerFont: SkFont, dpr: number): TextAtlas {
  const fb = new FrameBuilder();

  // ── plate digits ──
  const pem = plateFont.getSize();
  const pcap = capHeight(plateFont);
  const adv = plateFont.getGlyphWidths(plateFont.getGlyphIDs('0123456789'));
  const dw = Math.ceil(Math.max(...adv) + 2 * TEXT_PAD.side * pem + Math.abs(SKEW) * pcap);
  const dh = Math.ceil(pcap + 2 * TEXT_PAD.bottom * pem);
  fb.grid(0, 0, dw, dh, 10, 40);

  const plateLayout = new Array(101 * 4).fill(0);
  for (let n = 1; n <= 100; n++) {
    const s = String(n);
    const ws = Array.from(s).map((c) => adv[Number(c)]);
    const total = ws.reduce((a, b) => a + b, 0) + PLATE_TRACKING * pem * (ws.length - 1);
    plateLayout[n * 4] = ws.length;
    let x = -total / 2;
    ws.forEach((w, k) => {
      plateLayout[n * 4 + 1 + k] = x + w / 2;
      x += w + PLATE_TRACKING * pem;
    });
  }

  // ── banner lines: shelf-packed under the digits ──
  const bem = bannerFont.getSize();
  const bcap = capHeight(bannerFont);
  const bh = Math.ceil(bcap + 2 * TEXT_PAD.bottom * bem);
  const shelfW = dw * 10;
  const banner = BANNER_MESSAGES.map((m) => {
    const w = trackedWidth(bannerFont, m.text, BANNER_TRACKING);
    return { ...m, adv: w, cell: Math.ceil(w + 2 * TEXT_PAD.side * bem + Math.abs(SKEW) * bcap) };
  });
  let bx = 0;
  let by = dh * 4 + 8;
  const at: { x: number; y: number }[] = [];
  for (const b of banner) {
    if (bx + b.cell > shelfW) {
      bx = 0;
      by += bh + 4;
    }
    at.push({ x: bx, y: by });
    fb.add(bx, by, b.cell, bh);
    bx += b.cell + 4;
  }
  const width = Math.max(shelfW, ...banner.map((b) => b.cell));
  const height = by + bh;

  const picture = createPicture(
    (canvas) => {
      const styles = [TEXT_STYLE.gold, TEXT_STYLE.ice];
      styles.forEach((style, si) => {
        for (let part = 0; part < 2; part++) {
          for (let d = 0; d < 10; d++) {
            const f = si * 20 + part * 10 + d;
            const cx = (f % 10) * dw + dw / 2;
            const cy = Math.floor(f / 10) * dh + dh / 2;
            drawGameText(canvas, String(d), cx - adv[d] / 2, cy + pcap / 2, plateFont, style, {
              skew: SKEW,
              weight: 0.9,
              part: part === 0 ? 'base' : 'face',
            });
          }
        }
      });
      banner.forEach((b, i) => {
        const { x, y } = at[i];
        drawGameText(
          canvas,
          b.text,
          x + b.cell / 2 - b.adv / 2,
          y + bh / 2 + bcap / 2,
          bannerFont,
          b.gold ? TEXT_STYLE.gold : TEXT_STYLE.ice,
          { skew: SKEW, tracking: BANNER_TRACKING, depth: 0.8 },
        );
      });
    },
    Skia.XYWHRect(0, 0, width, height),
  );

  return {
    picture,
    size: { width, height },
    frames: fb.frames,
    scale: 1 / dpr,
    plateCapPx: pcap,
    plateLayout,
    bannerWidth: banner.map((b) => b.cell / dpr),
  };
}
