/**
 * Pure chart helpers (scales, ticks, path builders, windowing). No React /
 * React Native imports so everything here is unit-testable under Node.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Scale {
  (v: number): number;
  invert(px: number): number;
  domain: [number, number];
  range: [number, number];
}

export function scaleLinear(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  const f = ((v: number) => (span === 0 ? (r0 + r1) / 2 : r0 + ((v - d0) / span) * (r1 - r0))) as Scale;
  f.invert = (px: number) => (r1 === r0 ? d0 : d0 + ((px - r0) / (r1 - r0)) * span);
  f.domain = domain;
  f.range = range;
  return f;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 1/2/5 × 10^n step close to `span / count`. */
export function niceStep(span: number, count: number): number {
  if (!(span > 0) || count <= 0) return 1;
  const raw = span / count;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * pow;
}

/** Tick values covering [min, max] (inclusive of nice bounds inside the range). */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const step = niceStep(max - min, count);
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

/** Expand [min,max] to nice outer bounds (for y-axes). */
export function niceDomain(min: number, max: number, count = 4): [number, number] {
  if (min === max) return [min - 1, max + 1];
  const step = niceStep(max - min, count);
  return [Math.floor(min / step) * step, Math.ceil(max / step) * step];
}

const f2 = (n: number) => (Math.round(n * 100) / 100).toString();

export function linePath(pts: Pt[]): string {
  if (pts.length === 0) return '';
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${f2(p.x)} ${f2(p.y)}`).join('');
}

export function areaPath(pts: Pt[], baselineY: number): string {
  if (pts.length === 0) return '';
  const first = pts[0] as Pt;
  const last = pts[pts.length - 1] as Pt;
  return `${linePath(pts)}L${f2(last.x)} ${f2(baselineY)}L${f2(first.x)} ${f2(baselineY)}Z`;
}

/** Catmull-Rom → cubic Bézier smooth path. */
export function smoothPath(pts: Pt[], tension = 0.5): string {
  if (pts.length < 3) return linePath(pts);
  let d = `M${f2((pts[0] as Pt).x)} ${f2((pts[0] as Pt).y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? (pts[i] as Pt);
    const p1 = pts[i] as Pt;
    const p2 = pts[i + 1] as Pt;
    const p3 = pts[i + 2] ?? p2;
    const t = tension / 3;
    d += `C${f2(p1.x + (p2.x - p0.x) * t)} ${f2(p1.y + (p2.y - p0.y) * t)} ${f2(p2.x - (p3.x - p1.x) * t)} ${f2(p2.y - (p3.y - p1.y) * t)} ${f2(p2.x)} ${f2(p2.y)}`;
  }
  return d;
}

/** Angle in degrees, 0 = 12 o'clock, clockwise. */
export function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number): Pt {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

export function donutSegmentPath(cx: number, cy: number, rOuter: number, rInner: number, startDeg: number, endDeg: number): string {
  const sweep = Math.min(endDeg - startDeg, 359.999);
  const end = startDeg + sweep;
  const large = sweep > 180 ? 1 : 0;
  const o0 = polarToCartesian(cx, cy, rOuter, startDeg);
  const o1 = polarToCartesian(cx, cy, rOuter, end);
  const i1 = polarToCartesian(cx, cy, rInner, end);
  const i0 = polarToCartesian(cx, cy, rInner, startDeg);
  return `M${f2(o0.x)} ${f2(o0.y)}A${rOuter} ${rOuter} 0 ${large} 1 ${f2(o1.x)} ${f2(o1.y)}L${f2(i1.x)} ${f2(i1.y)}A${rInner} ${rInner} 0 ${large} 0 ${f2(i0.x)} ${f2(i0.y)}Z`;
}

export interface DonutArc {
  index: number;
  value: number;
  fraction: number;
  startDeg: number;
  endDeg: number;
  midDeg: number;
}

export function donutArcs(values: number[], gapDeg = 2): DonutArc[] {
  const clean = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const total = clean.reduce((a, b) => a + b, 0);
  if (total <= 0) return [];
  const nonZero = clean.filter((v) => v > 0).length;
  const gap = nonZero > 1 ? gapDeg : 0;
  const avail = 360 - gap * nonZero;
  let cursor = 0;
  const arcs: DonutArc[] = [];
  clean.forEach((v, index) => {
    if (v <= 0) return;
    const fraction = v / total;
    const startDeg = cursor + gap / 2;
    const endDeg = startDeg + fraction * avail;
    arcs.push({ index, value: v, fraction, startDeg, endDeg, midDeg: (startDeg + endDeg) / 2 });
    cursor += fraction * avail + gap;
  });
  return arcs;
}

/** Index of the value in sorted `xs` closest to `x` (binary search). */
export function nearestIndex(xs: readonly number[], x: number): number {
  if (xs.length === 0) return -1;
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid] as number) <= x) lo = mid;
    else hi = mid;
  }
  return Math.abs((xs[lo] as number) - x) <= Math.abs((xs[hi] as number) - x) ? lo : hi;
}

/** Largest-Triangle-Three-Buckets downsampling (keeps visual shape, first and last points). */
export function downsample(points: Pt[], maxPoints: number): Pt[] {
  const n = points.length;
  if (maxPoints >= n || maxPoints < 3) return points.slice();
  const out: Pt[] = [points[0] as Pt];
  const every = (n - 2) / (maxPoints - 2);
  let a = 0;
  for (let i = 0; i < maxPoints - 2; i++) {
    const rs = Math.floor((i + 1) * every) + 1;
    const re = Math.min(Math.floor((i + 2) * every) + 1, n);
    let avgX = 0;
    let avgY = 0;
    for (let j = rs; j < re; j++) {
      avgX += (points[j] as Pt).x;
      avgY += (points[j] as Pt).y;
    }
    const len = Math.max(1, re - rs);
    avgX /= len;
    avgY /= len;
    const rs0 = Math.floor(i * every) + 1;
    const re0 = Math.floor((i + 1) * every) + 1;
    const pa = points[a] as Pt;
    let maxArea = -1;
    let next = rs0;
    for (let j = rs0; j < re0; j++) {
      const pj = points[j] as Pt;
      const area = Math.abs((pa.x - avgX) * (pj.y - pa.y) - (pa.x - pj.x) * (avgY - pa.y)) * 0.5;
      if (area > maxArea) {
        maxArea = area;
        next = j;
      }
    }
    out.push(points[next] as Pt);
    a = next;
  }
  out.push(points[n - 1] as Pt);
  return out;
}

/** Grade colour ramp (% slope → hex). */
export function gradeColor(gradePct: number): string {
  const g = gradePct;
  if (g <= -10) return '#2C7FB8';
  if (g <= -4) return '#5AB4AC';
  if (g < 4) return '#6BAF5B';
  if (g < 9) return '#E0B93A';
  if (g < 15) return '#E8832A';
  return '#C8352B';
}

/** Distance label: metres below 1 km, else km with sensible decimals. */
export function formatDistanceAxis(meters: number, unitKm = 'km', unitM = 'm'): string {
  if (Math.abs(meters) < 1000) return `${Math.round(meters)} ${unitM}`;
  const km = meters / 1000;
  return `${Number.isInteger(km) ? km : km.toFixed(km < 10 ? 1 : 0)} ${unitKm}`;
}

export type Window = [number, number];

/** Keep window inside `bounds` and at least `minSpan` wide. */
export function clampWindow(win: Window, bounds: Window, minSpan: number): Window {
  const total = bounds[1] - bounds[0];
  const span = clamp(win[1] - win[0], Math.min(minSpan, total), total);
  const start = clamp(win[0], bounds[0], bounds[1] - span);
  return [start, start + span];
}

/** Zoom by `factor` (>1 zooms in) around `center` (domain units). */
export function zoomWindow(win: Window, factor: number, center: number, bounds: Window, minSpan: number): Window {
  const span = (win[1] - win[0]) / factor;
  const t = win[1] === win[0] ? 0.5 : (center - win[0]) / (win[1] - win[0]);
  const start = center - span * t;
  return clampWindow([start, start + span], bounds, minSpan);
}

export function panWindow(win: Window, delta: number, bounds: Window): Window {
  return clampWindow([win[0] + delta, win[1] + delta], bounds, win[1] - win[0]);
}

export interface BarRect {
  group: number;
  series: number;
  x: number;
  y: number;
  width: number;
  height: number;
  value: number;
}

/** Grouped bar layout in a plot box. `values[group][series]`. */
export function groupedBars(
  values: number[][],
  plot: { width: number; height: number },
  yMax: number,
  opts: { groupPadding?: number; barGap?: number } = {},
): BarRect[] {
  const groups = values.length;
  if (groups === 0) return [];
  const groupPadding = opts.groupPadding ?? 0.28;
  const barGap = opts.barGap ?? 3;
  const groupW = plot.width / groups;
  const rects: BarRect[] = [];
  values.forEach((row, g) => {
    const inner = groupW * (1 - groupPadding);
    const n = row.length;
    const bw = Math.max(2, (inner - barGap * (n - 1)) / Math.max(1, n));
    const x0 = g * groupW + (groupW - inner) / 2;
    row.forEach((v, s) => {
      const h = yMax > 0 ? clamp(v / yMax, 0, 1) * plot.height : 0;
      rects.push({ group: g, series: s, x: x0 + s * (bw + barGap), y: plot.height - h, width: bw, height: h, value: v });
    });
  });
  return rects;
}

export interface HeatCell {
  date: string;
  value: number;
  /** 0 = Monday … 6 = Sunday */
  row: number;
  col: number;
  /** 0..1 intensity relative to max (0 when no data) */
  level: number;
}

const DAY = 86_400_000;
const parseDate = (s: string) => {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};
const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Calendar heatmap grid ending at `endDate` (YYYY-MM-DD), `weeks` columns, Monday-first. */
export function buildCalendarGrid(data: Record<string, number>, endDate: string, weeks: number): HeatCell[] {
  const end = parseDate(endDate);
  const endDow = (new Date(end).getUTCDay() + 6) % 7; // Monday=0
  const startOfLastWeek = end - endDow * DAY;
  const start = startOfLastWeek - (weeks - 1) * 7 * DAY;
  let max = 0;
  for (const v of Object.values(data)) max = Math.max(max, v);
  const cells: HeatCell[] = [];
  for (let col = 0; col < weeks; col++) {
    for (let row = 0; row < 7; row++) {
      const ms = start + (col * 7 + row) * DAY;
      if (ms > end) continue;
      const date = fmtDate(ms);
      const value = data[date] ?? 0;
      cells.push({ date, value, row, col, level: max > 0 ? value / max : 0 });
    }
  }
  return cells;
}

/** Nearest-rank percentile helper for sparkline domains. */
export function extent(values: readonly number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return Number.isFinite(lo) ? [lo, hi] : [0, 1];
}
