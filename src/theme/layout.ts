import { space } from './tokens';

/** Inline padding of the control-bar read-out text inside its pill rect: the pill art's 3 pt rim
 * plus 6 pt of visible breathing room on each side of the text. */
export const PILL_TEXT_PAD = 9;

export type Rect = { x: number; y: number; width: number; height: number };
export type Circle = { cx: number; cy: number; r: number };

/**
 * The reel is the top of a giant prize wheel: numbers sit on a circle of radius `numberRadius`
 * around a pivot far below the screen top, so the visible band reads as a gentle arc.
 */
export type ArcGeometry = {
  cx: number;
  pivotY: number;
  /** Radius of the circle the number centres sit on. */
  numberRadius: number;
  /** Radial thickness of the segment band. */
  band: number;
  /** Top of the band at the pointer (screen y). */
  top: number;
  /** Angle between two neighbouring numbers (rad). */
  slotAngle: number;
  /** Beyond this |angle| a segment is fully hidden behind the frame / off screen. */
  maxAngle: number;
};

export type StageLayout = {
  width: number;
  height: number;
  /** Small logo row under the status bar. */
  topBar: Rect;
  arc: ArcGeometry;
  /** Gesture area of the wheel (also the region its glow may light). */
  reel: Rect;
  /** Arc length between two numbers on the wheel, in pt (drag → slots conversion). */
  slot: number;
  /** Board frame (outer edge) and its border thickness. */
  frame: Rect;
  frameT: number;
  grid: Rect;
  /** Key height — the board's unit size (glyphs, gems, effects scale from it). */
  cell: number;
  /** Key width: keys are a little wider than tall, like the reference (CELL_ASPECT). */
  cellW: number;
  gap: number;
  /** Hexagon result plate, overlapping the frame's bottom edge. */
  plate: Rect;
  /** Angled info banner ("NEW CELL CLAIMED!"). */
  banner: Rect;
  /** Big counter panel ("CELLS CLAIMED 12/100"). */
  panel: Rect;
  /** Bottom control bar; the SPIN button rises out of it (left of centre, like the reference). */
  bar: Rect;
  spin: Circle;
  /** Bounding square of the SPIN button (hit target). */
  button: Rect;
  /** Read-outs: ROUND left of SPIN, LAST and BEST right of it. */
  pills: { round: Rect; last: Rect; best: Rect };
  sound: Circle;
  haptics: Circle;
};

/**
 * Layout #4 "Royal Treasure", top to bottom (proportions taken from the approved mock-up):
 *   logo (left) + wheel pointer (centre) share the first row → big arc wheel with its own gold
 *   lower rim → framed 10×10 board starting just under that rim (no overlap) → result plate riding the frame's bottom edge →
 *   banner → counter panel → control bar: sound · ROUND · SPIN · LAST · BEST · haptics.
 * The lower stack is sized from the screen width like the mock-up; if a short phone can't fit
 * a full-width board under it, the stack shrinks (down to 80 %) before the board does.
 */
export function computeLayout(
  width: number,
  height: number,
  insets: { top: number; bottom: number },
): StageLayout {
  // screen gutter: the board frame's painted edge sits exactly on it
  const margin = space[3];
  const frameT = 11;
  const pad = space[1];

  // the logo row sits right under the status bar; the wheel keeps a clear gap below it (the crown
  // rim, its bulbs' glow and the camera's lean-in all reach up into that gap)
  const topBar: Rect = { x: margin, y: insets.top, width: width - margin * 2, height: 17 };

  // ── bottom-up: control bar and SPIN button ──
  // One gap rhythm through the whole bar: edge · sound · ROUND · SPIN · LAST · BEST · haptics,
  // every neighbour `G_BAR` apart and every chip the same height. SPIN sits left of centre (as
  // in the reference) so the right side has room for two read-outs that each fit "LAST 100" at
  // the same type size as ROUND.
  const barBottom = height - Math.max(insets.bottom, 10) - 2;
  const barH = 56;
  const G_BAR = space[1];
  // every full-width element of the lower stack has its *visible* edge on the gutter; `ART_X`
  // is how far inside its rect each painted strip visibly starts (measured on device)
  const edge = margin;
  const ART_X = { banner: 5, bar: 3 };
  const bar: Rect = { x: edge - ART_X.bar, y: barBottom - barH, width: width - (edge - ART_X.bar) * 2, height: barH };
  const chipH = barH - space[2] * 2;
  const sideR = chipH / 2;
  // reference: the SPIN medallion is ~0.2 of the screen wide (rim included); r + SPIN_OUT ≈ 0.115 w
  const spinR = Math.round(Math.min(46, width * 0.105));
  // The bar is laid out on what the eye sees, not on rects: the pill art starts PILL_IN inside
  // its rect, the SPIN rim reaches SPIN_OUT past r. Then every visible neighbour gap — tray edge ·
  // sound · ROUND · SPIN · LAST · BEST · haptics · tray edge — is exactly G_BAR.
  const PILL_IN = 3;
  const SPIN_OUT = 5;
  // ROUND's text box is em("ROUND 99") / em("LAST 88") = 1.28× LAST/BEST's (Montserrat Black), so
  // at the shared type size all three get the same side padding (PILL_TEXT_PAD).
  const TEXT_RATIO = 1.28;
  const PAD = PILL_TEXT_PAD;
  const avail = width - edge * 2 - G_BAR * 2;
  const pillW =
    (avail - sideR * 4 - (spinR + SPIN_OUT) * 2 - G_BAR * 5 + PILL_IN * 6 - PAD * 2 + PAD * 2 * TEXT_RATIO) /
    (TEXT_RATIO + 2);
  const roundW = TEXT_RATIO * (pillW - PAD * 2) + PAD * 2;
  let x = edge + G_BAR; // running visible edge
  const sound: Circle = { cx: x + sideR, cy: bar.y + barH / 2, r: sideR };
  x += sideR * 2 + G_BAR;
  const roundX = x - PILL_IN;
  x += roundW - PILL_IN * 2 + G_BAR;
  const spin: Circle = { cx: x + spinR + SPIN_OUT, cy: bar.y + barH / 2 - 7, r: spinR };
  x += (spinR + SPIN_OUT) * 2 + G_BAR;
  const button: Rect = { x: spin.cx - spinR, y: spin.cy - spinR, width: spinR * 2, height: spinR * 2 };
  const lastX = x - PILL_IN;
  x += pillW - PILL_IN * 2 + G_BAR;
  const bestX = x - PILL_IN;
  const haptics: Circle = { cx: width - edge - G_BAR - sideR, cy: bar.y + barH / 2, r: sideR };
  const chipY = bar.y + (barH - chipH) / 2;
  const pills = {
    round: { x: roundX, y: chipY, width: roundW, height: chipH },
    last: { x: lastX, y: chipY, width: pillW, height: chipH },
    best: { x: bestX, y: chipY, width: pillW, height: chipH },
  };

  // ── top-down: wheel ──
  const band = Math.round(Math.min(84, Math.max(60, height * 0.09)));
  // the pointer hangs from the logo row into the window; the band starts just below that row
  const arcTop = topBar.y + topBar.height + space[2];
  // a flatter arc than a real wheel: its lower rim must clear the board's top corners
  const numberRadius = width * 1.7;
  const outer = numberRadius + band / 2;
  const slot = Math.round(Math.min(104, width * 0.23));
  const slotAngle = slot / numberRadius;
  const arc: ArcGeometry = {
    cx: width / 2,
    pivotY: arcTop + outer,
    numberRadius,
    band,
    top: arcTop,
    slotAngle,
    maxAngle: Math.asin(Math.min(1, (width / 2 + slot) / outer)),
  };

  // ── board: whatever height is left between the wheel and the lower stack ──
  // As in the reference, the wheel tucks *behind* the board: the frame's top edge clears the
  // rim at the centre (under the pointer) and its top corners ride over the rim where it dips,
  // instead of the whole board dropping below the rim's lowest point (which cost ~26 pt).
  const rimR = numberRadius - band / 2;
  const half = width / 2 - margin;
  const rimDip = rimR - Math.sqrt(rimR * rimR - half * half);
  const frameY = Math.round(arcTop + band + rimDip * 0.22 + 4);
  /** How far the plate rides up over the frame: its border only, never the bottom row. */
  const plateRise = frameT + pad - 2;
  const spinTop = spin.cy - spinR;
  const chrome = (frameT + pad) * 2;

  // board keys are wider than tall (reference ≈ 1.13 : 1); the height saved goes to the HUD
  const CELL_ASPECT = 1.12;
  const gapOf = (w: number) => (w < 300 ? 3 : space[1]);
  const gridHOf = (w: number) => {
    const g = gapOf(w);
    return (((w - g * 9) / 10) * 10) / CELL_ASPECT + g * 9;
  };

  // Lower stack, sized from the width (plate 0.19 w, banner 0.115 w, panel 0.22 w, times k) with
  // ONE visible gap (space[2], more if there is height to spare) between plate, banner, panel and
  // the SPIN ring. The painted art does not fill
  // its rect evenly (the plate's glow fades early, the banner strip has a transparent top), so
  // each rect edge is offset by how far inside it the art visibly starts (fractions of height,
  // measured on device).
  // spinTop is in pt: how far the SPIN ring's painted rim (incl. its breathing pulse) rises above r
  const VIS = { plateBottom: 0.007, bannerTop: 0.155, bannerBottom: 0.08, panelBottom: 0.008, spinTop: 6 };
  const GAP = space[2];
  /** Height the stack needs at scale k with visible gap g (frame bottom → SPIN top). */
  const stackH = (k: number, g: number) => {
    const ph = width * 0.19 * k;
    const bh = width * 0.115 * k;
    const nh = width * 0.22 * k;
    return (
      -plateRise + ph - VIS.plateBottom * ph + g - VIS.bannerTop * bh + bh - VIS.bannerBottom * bh + g +
      nh - VIS.panelBottom * nh + g + VIS.spinTop
    );
  };
  const maxByWidth = width - margin * 2 - chrome;
  let gridW = maxByWidth;
  const room = (w: number) => spinTop - frameY - chrome - gridHOf(w);
  // largest k (0.8 … 1.1) the full-width board leaves room for; below 0.8 the board shrinks instead
  const kFor = (w: number) => {
    const r = room(w);
    const base = stackH(0, GAP);
    const unit = stackH(1, GAP) - base;
    return (r - base) / unit;
  };
  let k = kFor(gridW);
  if (k < 0.8) {
    k = 0.8;
    while (gridW > 200 && room(gridW) < stackH(k, GAP)) gridW -= 1;
  }
  k = Math.min(1.1, k);
  // any height left at the cap widens the gaps evenly (never the board, never the art)
  const g = Math.max(GAP, (room(gridW) - stackH(k, 0)) / 3);

  const gap = gapOf(gridW);
  const cellW = (gridW - gap * 9) / 10;
  const cell = cellW / CELL_ASPECT;
  const gridH = cell * 10 + gap * 9;
  const frame: Rect = { x: (width - gridW - chrome) / 2, y: frameY, width: gridW + chrome, height: gridH + chrome };
  const grid: Rect = { x: frame.x + frameT + pad, y: frame.y + frameT + pad, width: gridW, height: gridH };

  const plateH = Math.round(width * 0.19 * k);
  const bannerH = Math.round(width * 0.115 * k);
  const panelH = Math.round(width * 0.22 * k);
  const frameBottom = frame.y + frame.height;
  // a taller, narrower hex (reference: ~0.46 w × 0.19 w), so the number can be big
  const plateW = Math.min(width * 0.5, 224);
  const plate: Rect = { x: (width - plateW) / 2, y: frameBottom - plateRise, width: plateW, height: plateH };
  const banner: Rect = {
    x: edge - ART_X.banner,
    y: plate.y + plateH * (1 - VIS.plateBottom) + g - VIS.bannerTop * bannerH,
    width: width - (edge - ART_X.banner) * 2,
    height: bannerH,
  };
  const panel: Rect = {
    x: edge,
    y: banner.y + bannerH * (1 - VIS.bannerBottom) + g,
    width: width - edge * 2,
    height: panelH,
  };

  const reel: Rect = { x: 0, y: topBar.y + topBar.height, width, height: frame.y + frameT - (topBar.y + topBar.height) };

  return {
    width,
    height,
    topBar,
    arc,
    reel,
    slot,
    frame,
    frameT,
    grid,
    cell,
    cellW,
    gap,
    plate,
    banner,
    panel,
    bar,
    spin,
    button,
    pills,
    sound,
    haptics,
  };
}

/** Top-left corner of a 0-based cell index in reading order. */
export function cellOrigin(layout: StageLayout, index: number) {
  'worklet';
  const col = index % 10;
  const row = Math.floor(index / 10);
  return {
    x: layout.grid.x + col * (layout.cellW + layout.gap),
    y: layout.grid.y + row * (layout.cell + layout.gap),
  };
}

/** Centre of a 0-based cell. */
export function cellCenter(layout: StageLayout, index: number) {
  'worklet';
  const o = cellOrigin(layout, index);
  return { x: o.x + layout.cellW / 2, y: o.y + layout.cell / 2 };
}
