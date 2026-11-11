/**
 * Personal statistics over trips, recorded activities and routes.
 */
import type { GPSActivity, Route, Trip } from '@trailpack/shared';
import { daysBetweenInclusive } from '@trailpack/shared';
import { r } from './internal';

export interface StatsInput {
  trips: readonly Trip[];
  activities: readonly GPSActivity[];
  routes: readonly Route[];
  /** Base weight history of loadouts. */
  loadoutWeightsG?: ReadonlyArray<{ date: string; baseG: number }>;
}

export interface StatRecord {
  id: string;
  name: string;
  /** Calendar date `YYYY-MM-DD`. */
  date: string;
  distanceM: number;
  ascentM: number;
  /** Effort in km-equivalents: km + ascent/100. */
  effortKm: number;
}

export interface PeriodStats {
  distanceKm: number;
  ascentM: number;
  activities: number;
  days: number;
}

export interface Statistics {
  totals: {
    distanceKm: number;
    ascentM: number;
    trips: number;
    completedTrips: number;
    daysOutside: number;
    nightsOutside: number;
    longest: StatRecord | null;
    hardest: StatRecord | null;
    visitedPlaces: string[];
  };
  byMonth: Array<{ month: string } & PeriodStats>;
  byYear: Array<{ year: number } & PeriodStats>;
  avgBaseWeightG: number | null;
  weightTrend: { points: Array<{ date: string; baseG: number }>; deltaG: number; direction: 'down' | 'up' | 'flat' | 'unknown' };
  /** Czech notes about how the numbers were derived. */
  notes: string[];
}

const dateOf = (iso: string): string => iso.slice(0, 10);
const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);

function expandDates(start: string, end: string): string[] {
  const n = daysBetweenInclusive(start, end);
  const out: string[] = [];
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  for (let i = 0; i < Math.min(n, 400); i++) out.push(new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10));
  return out;
}

/**
 * Compute statistics. Distances come from finished GPS activities; completed
 * trips without any recorded activity fall back to the planned route.
 * Days outside = distinct dates of completed trips and finished activities;
 * nights outside = (days − 1) of completed multi-day trips.
 */
export function computeStatistics(input: StatsInput): Statistics {
  const notes: string[] = [];
  const trips = input.trips.filter((t) => !t.deletedAt);
  const finished = input.activities.filter((a) => !a.deletedAt && a.status === 'finished');
  const routeById = new Map(input.routes.filter((x) => !x.deletedAt).map((x) => [x.id, x]));
  const completed = trips.filter((t) => t.status === 'completed');

  const records: StatRecord[] = finished.map((a) => ({
    id: a.id,
    name: a.name,
    date: dateOf(a.startedAt),
    distanceM: a.distanceM,
    ascentM: a.ascentM,
    effortKm: a.distanceM / 1000 + a.ascentM / 100,
  }));
  const tripsWithActivity = new Set(finished.map((a) => a.tripId).filter((x): x is string => !!x));
  let fallback = 0;
  for (const t of completed) {
    if (tripsWithActivity.has(t.id)) continue;
    const route = t.routeId ? routeById.get(t.routeId) : undefined;
    if (!route || !t.startDate) continue;
    fallback++;
    records.push({
      id: `trip:${t.id}`,
      name: t.name,
      date: t.startDate,
      distanceM: route.distanceM,
      ascentM: route.ascentM,
      effortKm: route.distanceM / 1000 + route.ascentM / 100,
    });
  }
  if (fallback > 0) notes.push(`U ${fallback} dokončených výletů bez nahrávky byla použita plánovaná trasa.`);

  const days = new Set<string>();
  let nights = 0;
  for (const t of completed) {
    if (!t.startDate) continue;
    const end = t.endDate && t.endDate >= t.startDate ? t.endDate : t.startDate;
    for (const d of expandDates(t.startDate, end)) days.add(d);
    nights += Math.max(0, daysBetweenInclusive(t.startDate, end) - 1);
  }
  for (const a of finished) days.add(dateOf(a.startedAt));

  const longest = records.reduce<StatRecord | null>((b, x) => (!b || x.distanceM > b.distanceM ? x : b), null);
  const hardest = records.reduce<StatRecord | null>((b, x) => (!b || x.effortKm > b.effortKm ? x : b), null);
  const places = [...new Set(completed.map((t) => t.region?.trim()).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b, 'cs'));

  const month = new Map<string, PeriodStats & { dates: Set<string> }>();
  const year = new Map<number, PeriodStats & { dates: Set<string> }>();
  const add = <K>(map: Map<K, PeriodStats & { dates: Set<string> }>, key: K, rec: StatRecord) => {
    let p = map.get(key);
    if (!p) {
      p = { distanceKm: 0, ascentM: 0, activities: 0, days: 0, dates: new Set() };
      map.set(key, p);
    }
    p.distanceKm += rec.distanceM / 1000;
    p.ascentM += rec.ascentM;
    p.activities += 1;
    p.dates.add(rec.date);
  };
  for (const rec of records) {
    if (!isDate(rec.date)) continue;
    add(month, rec.date.slice(0, 7), rec);
    add(year, Number(rec.date.slice(0, 4)), rec);
  }
  const fin = ({ dates, ...p }: PeriodStats & { dates: Set<string> }): PeriodStats => ({
    distanceKm: r(p.distanceKm, 1),
    ascentM: r(p.ascentM),
    activities: p.activities,
    days: dates.size,
  });
  const byMonth = [...month.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => ({ month: k, ...fin(v) }));
  const byYear = [...year.entries()].sort(([a], [b]) => a - b).map(([k, v]) => ({ year: k, ...fin(v) }));

  const points = [...(input.loadoutWeightsG ?? [])].filter((p) => Number.isFinite(p.baseG)).sort((a, b) => a.date.localeCompare(b.date));
  const avg = points.length > 0 ? r(points.reduce((s, p) => s + p.baseG, 0) / points.length) : null;
  let deltaG = 0;
  let direction: 'down' | 'up' | 'flat' | 'unknown' = 'unknown';
  if (points.length >= 2) {
    deltaG = points[points.length - 1]!.baseG - points[0]!.baseG;
    direction = Math.abs(deltaG) < 50 ? 'flat' : deltaG < 0 ? 'down' : 'up';
  }

  return {
    totals: {
      distanceKm: r(records.reduce((s, x) => s + x.distanceM, 0) / 1000, 1),
      ascentM: r(records.reduce((s, x) => s + x.ascentM, 0)),
      trips: trips.length,
      completedTrips: completed.length,
      daysOutside: days.size,
      nightsOutside: nights,
      longest,
      hardest,
      visitedPlaces: places,
    },
    byMonth,
    byYear,
    avgBaseWeightG: avg,
    weightTrend: { points, deltaG, direction },
    notes,
  };
}

export interface HeatmapCell {
  date: string;
  count: number;
  /** 0 (none) – 4 (most active day). */
  level: 0 | 1 | 2 | 3 | 4;
}

/**
 * Activity heatmap (calendar-style). Accepts ISO dates or date-times; invalid
 * entries are ignored. Result is sorted by date, level scaled to the busiest day.
 */
export function activityHeatmap(dates: readonly string[]): HeatmapCell[] {
  const counts = new Map<string, number>();
  for (const raw of dates) {
    const d = typeof raw === 'string' ? dateOf(raw) : '';
    if (!isDate(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) continue;
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const max = Math.max(0, ...counts.values());
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count, level: Math.max(1, Math.ceil((4 * count) / max)) as 1 | 2 | 3 | 4 }));
}
