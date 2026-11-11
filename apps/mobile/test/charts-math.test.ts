import { describe, expect, it } from 'vitest';
import {
  areaPath,
  buildCalendarGrid,
  clampWindow,
  donutArcs,
  donutSegmentPath,
  downsample,
  extent,
  formatDistanceAxis,
  gradeColor,
  groupedBars,
  linePath,
  nearestIndex,
  niceDomain,
  niceStep,
  niceTicks,
  panWindow,
  polarToCartesian,
  scaleLinear,
  smoothPath,
  zoomWindow,
} from '../src/components/charts/math';

describe('scaleLinear', () => {
  it('maps and inverts', () => {
    const s = scaleLinear([0, 100], [10, 210]);
    expect(s(0)).toBe(10);
    expect(s(50)).toBe(110);
    expect(s.invert(210)).toBe(100);
  });
  it('handles a flat domain', () => {
    expect(scaleLinear([5, 5], [0, 100])(5)).toBe(50);
  });
});

describe('ticks', () => {
  it('nice step is 1/2/5 × 10^n', () => {
    expect(niceStep(100, 5)).toBe(20);
    expect(niceStep(7, 5)).toBe(2);
    expect(niceStep(0.9, 3)).toBe(0.5);
  });
  it('generates ticks inside the range', () => {
    expect(niceTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(430, 1180, 4)).toEqual([600, 800, 1000]);
  });
  it('handles degenerate input', () => {
    expect(niceTicks(3, 3)).toEqual([3]);
    expect(niceTicks(NaN, 3)).toEqual([]);
  });
  it('niceDomain expands outward', () => {
    expect(niceDomain(432, 1187, 4)).toEqual([400, 1200]);
  });
});

describe('paths', () => {
  const pts = [
    { x: 0, y: 10 },
    { x: 10, y: 20 },
    { x: 20, y: 5 },
  ];
  it('builds line and area paths', () => {
    expect(linePath(pts)).toBe('M0 10L10 20L20 5');
    expect(areaPath(pts, 30)).toBe('M0 10L10 20L20 5L20 30L0 30Z');
    expect(linePath([])).toBe('');
  });
  it('smooth path starts at first point and ends at last', () => {
    const d = smoothPath(pts);
    expect(d.startsWith('M0 10C')).toBe(true);
    expect(d.endsWith('20 5')).toBe(true);
  });
});

describe('donut', () => {
  it('polar conversion: 0° is 12 o’clock, 90° is 3 o’clock', () => {
    const top = polarToCartesian(100, 100, 50, 0);
    expect(top.x).toBeCloseTo(100);
    expect(top.y).toBeCloseTo(50);
    const right = polarToCartesian(100, 100, 50, 90);
    expect(right.x).toBeCloseTo(150);
    expect(right.y).toBeCloseTo(100);
  });
  it('arcs cover the circle minus gaps and skip zeros', () => {
    const arcs = donutArcs([1, 0, 3], 4);
    expect(arcs).toHaveLength(2);
    const covered = arcs.reduce((a, x) => a + (x.endDeg - x.startDeg), 0);
    expect(covered).toBeCloseTo(352);
    expect(arcs[1]?.fraction).toBeCloseTo(0.75);
    expect(donutArcs([0, 0])).toEqual([]);
  });
  it('single value makes a near-full ring path', () => {
    const [arc] = donutArcs([5]);
    expect(arc?.startDeg).toBe(0);
    expect(donutSegmentPath(50, 50, 40, 25, arc!.startDeg, arc!.endDeg)).toContain('A40 40 0 1 1');
  });
});

describe('nearestIndex', () => {
  const xs = [0, 100, 250, 400, 1000];
  it('finds the closest element', () => {
    expect(nearestIndex(xs, -50)).toBe(0);
    expect(nearestIndex(xs, 120)).toBe(1);
    expect(nearestIndex(xs, 330)).toBe(3);
    expect(nearestIndex(xs, 5000)).toBe(4);
    expect(nearestIndex([], 1)).toBe(-1);
    expect(nearestIndex([7], 1)).toBe(0);
  });
});

describe('downsample (LTTB)', () => {
  const pts = Array.from({ length: 1000 }, (_, i) => ({ x: i, y: Math.sin(i / 20) * 100 + (i === 500 ? 400 : 0) }));
  it('returns the requested count, keeps endpoints and the spike', () => {
    const out = downsample(pts, 100);
    expect(out).toHaveLength(100);
    expect(out[0]).toEqual(pts[0]);
    expect(out.at(-1)).toEqual(pts.at(-1));
    expect(Math.max(...out.map((p) => p.y))).toBeGreaterThan(380);
  });
  it('returns a copy when already small', () => {
    expect(downsample(pts.slice(0, 10), 100)).toHaveLength(10);
  });
});

describe('gradeColor / formatting', () => {
  it('ramps from blue to red', () => {
    expect(gradeColor(-12)).toBe('#2C7FB8');
    expect(gradeColor(0)).toBe('#6BAF5B');
    expect(gradeColor(6)).toBe('#E0B93A');
    expect(gradeColor(12)).toBe('#E8832A');
    expect(gradeColor(25)).toBe('#C8352B');
  });
  it('formats distance axis labels', () => {
    expect(formatDistanceAxis(450)).toBe('450 m');
    expect(formatDistanceAxis(2000)).toBe('2 km');
    expect(formatDistanceAxis(2500)).toBe('2.5 km');
    expect(formatDistanceAxis(42000)).toBe('42 km');
  });
});

describe('window zoom / pan', () => {
  const bounds: [number, number] = [0, 10000];
  it('clamps inside bounds', () => {
    expect(clampWindow([-500, 1500], bounds, 200)).toEqual([0, 2000]);
    expect(clampWindow([9000, 12000], bounds, 200)).toEqual([7000, 10000]);
  });
  it('zooms around a center and enforces min span', () => {
    const w = zoomWindow([0, 10000], 2, 2500, bounds, 500);
    expect(w[1] - w[0]).toBe(5000);
    expect(w[0]).toBeCloseTo(1250);
    const tight = zoomWindow([0, 600], 10, 300, bounds, 500);
    expect(tight[1] - tight[0]).toBe(500);
  });
  it('pans without leaving bounds', () => {
    expect(panWindow([1000, 3000], 500, bounds)).toEqual([1500, 3500]);
    expect(panWindow([8000, 10000], 5000, bounds)).toEqual([8000, 10000]);
  });
});

describe('groupedBars', () => {
  it('lays bars out proportionally', () => {
    const rects = groupedBars([[10, 5], [20, 0]], { width: 200, height: 100 }, 20);
    expect(rects).toHaveLength(4);
    expect(rects[2]?.height).toBe(100);
    expect(rects[0]?.height).toBe(50);
    expect(rects[3]?.height).toBe(0);
    expect(rects[1]!.x).toBeGreaterThan(rects[0]!.x);
  });
});

describe('buildCalendarGrid', () => {
  it('builds Monday-first columns ending at the end date', () => {
    // 2026-11-11 is a Wednesday
    const cells = buildCalendarGrid({ '2026-11-10': 5, '2026-11-02': 10 }, '2026-11-11', 3);
    const last = cells.at(-1)!;
    expect(last.date).toBe('2026-11-11');
    expect(last.row).toBe(2);
    expect(last.col).toBe(2);
    expect(cells[0]!.date).toBe('2026-10-26');
    expect(cells.find((c) => c.date === '2026-11-02')?.level).toBe(1);
    expect(cells.find((c) => c.date === '2026-11-10')?.level).toBe(0.5);
    expect(cells).toHaveLength(7 + 7 + 3);
  });
});

describe('extent', () => {
  it('returns min/max or a default', () => {
    expect(extent([3, 1, 9])).toEqual([1, 9]);
    expect(extent([])).toEqual([0, 1]);
  });
});
