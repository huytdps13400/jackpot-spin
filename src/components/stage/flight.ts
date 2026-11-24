import { Reveal } from '../../engine/timeline';
import { cellCenter, type StageLayout } from '../../theme/layout';
import { bezier, easeOutCubic, progress } from './anim';

/**
 * The reel → cell hand-off path, shared by the flying number, its spark trail and the target
 * cell's anticipation glow, so all three agree to the pixel.
 *
 * FormStart→FormEnd: the number lifts out of the wheel window and swells (charging).
 * FormEnd→DropEnd:   it launches up and over in a cubic arc and accelerates into its cell
 *                    (eased with t^1.45 — it hangs at the apex, then *drops*, like a thrown coin).
 */
export function flightAt(layout: StageLayout, idx: number, r: number, tOverride?: number) {
  'worklet';
  const sx = layout.arc.cx;
  const sy = layout.arc.pivotY - layout.arc.numberRadius;
  const lift = easeOutCubic(progress(r, Reveal.FormStart, Reveal.FormEnd));
  const ly = sy - 16 * lift;
  const d = cellCenter(layout, idx);
  const t = tOverride !== undefined ? tOverride : progress(r, Reveal.FormEnd, Reveal.DropEnd);
  if (t <= 0) return { x: sx, y: ly, t: 0, lift, dx: 0, dy: -1 };
  const e = Math.pow(t, 1.45);
  const apex = Math.max(70, (d.y - ly) * 0.35);
  const p = bezier(e, sx, ly, sx + (d.x - sx) * 0.18, ly - apex, d.x, d.y - apex * 1.6, d.x, d.y);
  const q = bezier(Math.min(1, e + 0.01), sx, ly, sx + (d.x - sx) * 0.18, ly - apex, d.x, d.y - apex * 1.6, d.x, d.y);
  return { x: p.x, y: p.y, t, lift, dx: q.x - p.x, dy: q.y - p.y };
}
