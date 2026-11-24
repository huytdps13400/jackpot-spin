import {
  OVERSHOOT,
  QUICK_STOP_REPHASE_SPEED,
  handoffPosition,
  handoffVelocity,
  indexAt,
  nextAligned,
  planFlick,
  planQuickStop,
  planSpin,
  CRAWL_SLOTS,
  crawlStep,
  crawlVelocity,
  finalStruggle,
  settleOffset,
  spinCruise,
  spinCruiseVelocity,
  spinEase,
  spinEaseVelocity,
  wrap,
} from '../reelMath';

const sample = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n);

describe('wrap / indexAt / nextAligned', () => {
  it('wraps negatives into 0..99', () => {
    expect(wrap(-1)).toBe(99);
    expect(wrap(250)).toBe(50);
    expect(indexAt(-0.4)).toBe(0);
    expect(indexAt(199.6)).toBe(0);
  });

  it('finds the next position showing the target', () => {
    for (const from of [0, 0.3, 41.9, 142, -7.5]) {
      for (const target of [0, 42, 99]) {
        const f = nextAligned(from, target);
        expect(Number.isInteger(f)).toBe(true);
        expect(f).toBeGreaterThanOrEqual(from);
        expect(f - from).toBeLessThan(101);
        expect(indexAt(f)).toBe(target);
      }
    }
  });
});

describe('spinEase (Beta(2,5) velocity profile)', () => {
  it('starts and ends at rest', () => {
    expect(spinEase(0)).toBe(0);
    expect(spinEase(1)).toBeCloseTo(1, 12);
    expect(spinEaseVelocity(0)).toBe(0);
    expect(spinEaseVelocity(1)).toBe(0);
  });

  it('is monotonic and peaks early (u = 0.2)', () => {
    const us = sample(500);
    for (let i = 1; i < us.length; i++) {
      expect(spinEase(us[i])).toBeGreaterThanOrEqual(spinEase(us[i - 1]));
    }
    expect(spinEaseVelocity(0.2)).toBeGreaterThan(spinEaseVelocity(0.15));
    expect(spinEaseVelocity(0.2)).toBeGreaterThan(spinEaseVelocity(0.25));
  });

  it('has a long suspense tail: last 30% of time covers < 1% of the distance', () => {
    expect(1 - spinEase(0.7)).toBeLessThan(0.011);
  });
});

describe('handoff quintic', () => {
  it('matches boundary conditions', () => {
    const D = 40;
    const V = 70;
    expect(handoffPosition(0, D, V)).toBe(0);
    expect(handoffPosition(1, D, V)).toBeCloseTo(D, 10);
    expect(handoffVelocity(0, D, V)).toBe(V);
    expect(handoffVelocity(1, D, V)).toBeCloseTo(0, 10);
  });

  it.each([0, 0.5, 1, 2, 2.5])('never runs backwards for V = %p·D', (k) => {
    const D = 30;
    for (const s of sample(400)) {
      expect(handoffVelocity(s, D, k * D)).toBeGreaterThanOrEqual(-1e-9);
    }
  });
});

describe('planSpin (cruise + crawl)', () => {
  it('lands on the target after at least 110 slots, cruise within ~3 s', () => {
    for (const target of [0, 17, 42, 99]) {
      const p = planSpin(12.7, target);
      expect(indexAt(p.final)).toBe(target);
      expect(p.final - 12.7).toBeGreaterThanOrEqual(110);
      expect(p.distance).toBeCloseTo(p.final + OVERSHOOT - 12.7, 10);
      expect(p.cruise + CRAWL_SLOTS + OVERSHOOT).toBeCloseTo(p.distance, 10);
      expect(p.duration).toBeGreaterThanOrEqual(2100);
      expect(p.duration).toBeLessThan(3000);
      expect(p.h).toBeGreaterThan(0);
      expect(p.h).toBeLessThan(1);
    }
  });

  it('hands the cruise velocity to the crawl continuously, and both run forwards', () => {
    const p = planSpin(3.2, 42);
    const cruiseEndV = (spinCruiseVelocity(1, p.h) * p.cruise) / (p.duration / 1000);
    expect(cruiseEndV).toBeCloseTo(crawlVelocity(0, p.crawl), 8);
    expect(spinCruise(1, p.h)).toBeCloseTo(1, 12);
    for (const u of sample(400)) expect(spinCruiseVelocity(u, p.h)).toBeGreaterThanOrEqual(-1e-12);
    for (const s of sample(400)) expect(crawlVelocity(s * p.crawl, p.crawl)).toBeGreaterThanOrEqual(0);
  });

  /** Crossing times (ms) of each number in the crawl, at a given frame step. */
  const crawlCrossings = (frameMs: number) => {
    const p = planSpin(0, 42);
    const start = p.final - CRAWL_SLOTS;
    const out: number[] = [];
    let prev = Math.floor(start + 0.5);
    let c = 0;
    let ms = 0;
    while (c < p.crawl && ms < 20000) {
      c = crawlStep(c, p.crawl, frameMs);
      ms += frameMs;
      const xs = start + c;
      const n = Math.floor(xs + finalStruggle(xs, p.final) + 0.5);
      if (n !== prev) {
        out.push(ms);
        prev = n;
      }
    }
    return { out, total: ms, ended: c === p.crawl };
  };

  it('every number takes longer than the one before (no plateau), and the crawl ends at rest', () => {
    const { out, total, ended } = crawlCrossings(4);
    expect(ended).toBe(true);
    expect(out.length).toBe(CRAWL_SLOTS);
    const gaps = out.slice(1).map((c, i) => c - out[i]);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThan(gaps[i - 1]);
    expect(gaps[gaps.length - 1]).toBeGreaterThan(gaps[0] * 2);
    expect(total).toBeGreaterThan(3000);
    expect(total).toBeLessThan(5000);
    const d = planSpin(0, 42).crawl;
    expect(crawlVelocity(d, d)).toBe(0);
  });

  it('crawl timing does not depend on the frame rate', () => {
    const a = crawlCrossings(4);
    const b = crawlCrossings(16);
    expect(Math.abs(a.total - b.total)).toBeLessThanOrEqual(16);
  });

  it('the pin struggle never makes the reel run backwards', () => {
    const final = 120;
    let prev = -Infinity;
    for (let i = 0; i <= 4000; i++) {
      const xs = final - 3 + (i / 4000) * 3.22;
      const x = xs + finalStruggle(xs, final);
      expect(x).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = x;
    }
  });
});

describe('planQuickStop', () => {
  it('re-phases the strip at high speed and brakes in under half a second', () => {
    const x = 1234.37;
    const v = 95;
    for (const target of [0, 42, 99]) {
      const p = planQuickStop(x, v, target, 99999);
      expect(indexAt(p.final)).toBe(target);
      // only an integer re-phase (keeps the sub-slot phase, so no visual pop under blur)
      expect((p.startX - x) % 1).toBeCloseTo(0, 10);
      expect(p.duration).toBeLessThan(500);
      // velocity continuity: v0 at the start of the curve equals the current speed
      expect((p.velocityTerm / p.duration) * 1000).toBeCloseTo(v, 6);
      expect(p.velocityTerm).toBeLessThanOrEqual(2.5 * p.distance + 1e-9);
    }
  });

  it('brakes into the already-planned stop when slow', () => {
    const v = QUICK_STOP_REPHASE_SPEED - 5;
    const p = planQuickStop(240.2, v, 42, 242);
    expect(p.startX).toBe(240.2);
    expect(p.final).toBe(242);
    expect(p.duration).toBeLessThanOrEqual(900);
    expect(p.velocityTerm).toBeLessThanOrEqual(2.4 * p.distance + 1e-9);
  });
});

describe('planFlick', () => {
  it('keeps the hand-off monotonic for slow and fast flicks', () => {
    for (const v of [6, 20, 60, 140]) {
      const p = planFlick(10.4, v, 42);
      expect(indexAt(p.final)).toBe(42);
      expect(p.velocityTerm).toBeLessThanOrEqual(2.5 * p.distance);
      for (const s of sample(200)) {
        expect(handoffVelocity(s, p.distance, p.velocityTerm)).toBeGreaterThanOrEqual(-1e-9);
      }
    }
  });
});

describe('settleOffset (detent spring)', () => {
  it('starts at the overshoot, crosses the notch, and rings down', () => {
    expect(settleOffset(0)).toBeCloseTo(OVERSHOOT, 10);
    expect(settleOffset(120)).toBeLessThan(0);
    expect(Math.abs(settleOffset(450))).toBeLessThan(0.02);
  });
});
