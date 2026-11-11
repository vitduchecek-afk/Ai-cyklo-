/**
 * Weather along a route: choose representative sample points (start, end,
 * every N km, summits, stage ends, campsites), fetch forecasts for the
 * deduplicated grid cells and pick the hour in which the hiker/rider arrives.
 */
import { cumulativeDistances, eleOf } from '@trailpack/calculations';
import { TrailPackError, type DailyWeather, type HourlyWeather, type Position } from '@trailpack/shared';
import { forecastConfidence, type ForecastConfidence } from './horizon';
import type { ForecastRequest, ForecastResult } from './openMeteo';
import { dayDiff, localDateOf, localToMs } from './time';

export type SampleKind = 'start' | 'end' | 'interval' | 'summit' | 'stage_end' | 'campsite';

export interface SamplePoint {
  /** Czech label, e.g. "Vrchol (1 602 m)". */
  label: string;
  kind: SampleKind;
  /** Index into the route geometry. */
  idx: number;
  lat: number;
  lon: number;
  /** Elevation from the route geometry (m a.s.l.). */
  eleM?: number;
  /** Estimated arrival time (UTC epoch ms). */
  etaMs: number;
}

export interface SampleOptions {
  /** Geometry indices where a stage ends. */
  stageEnds?: number[];
  campsites?: Array<{ idx: number; name: string }>;
  /** Spacing of regular samples in km (default 8). */
  everyKm?: number;
  /** Add local maxima with at least {@link SUMMIT_PROMINENCE_M} prominence. */
  includeSummits?: boolean;
}

/** Minimum prominence (m) for a summit sample. */
export const SUMMIT_PROMINENCE_M = 80;

const PRIORITY: Record<SampleKind, number> = { campsite: 6, stage_end: 5, summit: 4, start: 3, end: 3, interval: 1 };

/** Indices of local maxima along the route with prominence >= `minProminenceM` (zig-zag detection, reversal threshold = prominence). */
export function findSummits(line: readonly Position[], minProminenceM = SUMMIT_PROMINENCE_M): number[] {
  const eles = line.map((p) => eleOf(p));
  if (eles.some((e) => e === undefined) || line.length < 3) return [];
  const e = eles as number[];
  const peaks: number[] = [];
  let lastValley = e[0]!;
  let candidate = -1; // index of current high
  let low = e[0]!; // running min since last confirmed peak (before a candidate exists)
  for (let i = 1; i < e.length; i++) {
    const v = e[i]!;
    if (candidate < 0) {
      if (v < low) low = v;
      if (v - low >= minProminenceM) candidate = i;
    } else {
      if (v > e[candidate]!) candidate = i;
      else if (e[candidate]! - v >= minProminenceM) {
        peaks.push(candidate);
        lastValley = v;
        low = v;
        candidate = -1;
      }
    }
  }
  void lastValley;
  return peaks;
}

/** Choose sample points along a route. `passTimesMs[i]` is the arrival time (epoch ms) at geometry vertex i. */
export function selectSamplePoints(geometry: readonly Position[], passTimesMs: readonly number[], opts: SampleOptions = {}): SamplePoint[] {
  if (geometry.length < 2) throw new TrailPackError('invalid_input', 'Trasa musí mít alespoň 2 body', { provider: 'weather' });
  if (passTimesMs.length < geometry.length) throw new TrailPackError('invalid_input', 'Chybí časy průchodu pro některé body trasy', { provider: 'weather' });
  const cum = cumulativeDistances(geometry);
  const total = cum[cum.length - 1] ?? 0;
  const everyM = Math.max(500, (opts.everyKm ?? 8) * 1000);
  const chosen = new Map<number, SamplePoint>();
  const add = (idx: number, kind: SampleKind, label: string) => {
    if (idx < 0 || idx >= geometry.length) return;
    const prev = chosen.get(idx);
    if (prev && PRIORITY[prev.kind] >= PRIORITY[kind]) return;
    const p = geometry[idx]!;
    chosen.set(idx, { label, kind, idx, lat: p[1], lon: p[0], eleM: eleOf(p), etaMs: passTimesMs[idx]! });
  };
  const fmtEle = (e: number | undefined) => (e === undefined ? '' : ` (${Math.round(e)} m)`);

  (opts.campsites ?? []).forEach((c) => add(c.idx, 'campsite', `Nocleh: ${c.name}`));
  (opts.stageEnds ?? []).forEach((idx, n) => add(idx, 'stage_end', `Konec etapy ${n + 1}`));
  add(0, 'start', 'Start');
  add(geometry.length - 1, 'end', 'Cíl');
  if (opts.includeSummits) for (const idx of findSummits(geometry)) add(idx, 'summit', `Vrchol${fmtEle(eleOf(geometry[idx]!))}`);

  const special = [...chosen.values()].map((s) => cum[s.idx]!);
  for (let t = everyM; t < total; t += everyM) {
    let idx = cum.findIndex((c) => c >= t);
    if (idx < 0) idx = geometry.length - 1;
    if (special.some((c) => Math.abs(c - cum[idx]!) < everyM * 0.4)) continue;
    add(idx, 'interval', `km ${Math.round(cum[idx]! / 1000)}`);
  }
  return [...chosen.values()].sort((a, b) => a.idx - b.idx);
}

/** Minimal provider contract (satisfied by OpenMeteoProvider). */
export interface MultiForecastProvider {
  getForecastMulti(points: ForecastRequest[]): Promise<ForecastResult[]>;
}

export interface WeatherSample extends SamplePoint {
  /** Hourly record nearest to the ETA (null when beyond the horizon / not covered). */
  hourly: HourlyWeather | null;
  daily: DailyWeather | null;
  /** Temperature corrected from model grid elevation to the sample elevation (°C). */
  temperatureC: number | null;
  apparentTemperatureC: number | null;
  /** Applied correction in °C (negative when the point lies above the model grid elevation). */
  lapseCorrectionC: number;
  /** Elevation of the model grid cell (m). */
  gridEleM: number | null;
  confidence: ForecastConfidence;
  /** true when the ETA is outside the 16-day forecast horizon (or in the past); no data is attached. */
  beyondHorizon: boolean;
  fetchedAt: string | null;
  stale: boolean;
  timezone: string | null;
}

export interface WeatherAlongRoute {
  samples: WeatherSample[];
  /** Statement of how temperatures were adjusted. */
  correctionNote: string;
  /** Number of distinct forecast requests (after 0.05° deduplication). */
  forecastCount: number;
  stale: boolean;
  fetchedAt: string | null;
}

/** Standard-atmosphere lapse rate used for elevation correction (°C per 100 m). */
export const LAPSE_RATE_C_PER_100M = 0.65;
export const LAPSE_NOTE = `Teploty jsou přepočteny z nadmořské výšky mřížky modelu na výšku bodu trasy gradientem −${LAPSE_RATE_C_PER_100M} °C na 100 m (standardní atmosféra); skutečný průběh (inverze, závětří) se může lišit.`;

const cellKey = (lat: number, lon: number) => `${Math.round(lat / 0.05)}:${Math.round(lon / 0.05)}`;

function nearestHour(f: ForecastResult, etaMs: number): HourlyWeather | null {
  let best: HourlyWeather | null = null;
  let bestD = Infinity;
  for (const h of f.hourly) {
    const d = Math.abs(localToMs(h.time, f.timezone) - etaMs);
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return bestD <= 90 * 60_000 ? best : null;
}

/**
 * Forecast for every sample point of the route at its arrival time.
 * Samples closer than 0.05° share one forecast request. Samples beyond the
 * 16-day horizon are returned WITHOUT weather data (`beyondHorizon`).
 */
export async function weatherAlongRoute(args: {
  provider: MultiForecastProvider;
  geometry: readonly Position[];
  passTimesMs: readonly number[];
  stageEnds?: number[];
  campsites?: Array<{ idx: number; name: string }>;
  everyKm?: number;
  includeSummits?: boolean;
  now: number | Date;
}): Promise<WeatherAlongRoute> {
  const nowMs = typeof args.now === 'number' ? args.now : args.now.getTime();
  const base = selectSamplePoints(args.geometry, args.passTimesMs, args);
  const nowDate = new Date(nowMs).toISOString().slice(0, 10);
  const confs = base.map((s) => forecastConfidence(new Date(s.etaMs), nowMs));
  const inHorizon = base.filter((_, i) => confs[i]!.level !== 'none');

  // dedupe by 0.05° grid
  const cells = new Map<string, { lat: number; lon: number }>();
  let maxAhead = 0;
  for (const s of inHorizon) {
    const k = cellKey(s.lat, s.lon);
    if (!cells.has(k)) cells.set(k, { lat: s.lat, lon: s.lon });
    maxAhead = Math.max(maxAhead, dayDiff(nowDate, new Date(s.etaMs).toISOString().slice(0, 10)));
  }
  // +1 day safety: local date may differ from UTC date near midnight
  const days = Math.min(16, maxAhead + 2);
  const keys = [...cells.keys()];
  const results = keys.length ? await args.provider.getForecastMulti(keys.map((k) => ({ ...cells.get(k)!, days }))) : [];
  const byCell = new Map<string, ForecastResult>();
  keys.forEach((k, i) => byCell.set(k, results[i]!));

  const samples: WeatherSample[] = base.map((s, i) => {
    const confidence = confs[i]!;
    const f = confidence.level === 'none' ? undefined : byCell.get(cellKey(s.lat, s.lon));
    const hourly = f ? nearestHour(f, s.etaMs) : null;
    const daily = f ? (f.daily.find((d) => d.date === localDateOf(s.etaMs, f.timezone)) ?? null) : null;
    const beyondHorizon = confidence.level === 'none' || !f || !hourly;
    const grid = f?.eleM ?? null;
    const corr = s.eleM !== undefined && grid !== null ? -(LAPSE_RATE_C_PER_100M / 100) * (s.eleM - grid) : 0;
    const adj = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round((v + corr) * 10) / 10);
    return {
      ...s,
      hourly: beyondHorizon ? null : hourly,
      daily: beyondHorizon ? null : daily,
      temperatureC: beyondHorizon ? null : adj(hourly?.temperatureC),
      apparentTemperatureC: beyondHorizon ? null : adj(hourly?.apparentTemperatureC),
      lapseCorrectionC: beyondHorizon ? 0 : Math.round(corr * 10) / 10,
      gridEleM: grid,
      confidence,
      beyondHorizon,
      fetchedAt: f?.fetchedAt ?? null,
      stale: f?.stale ?? false,
      timezone: f?.timezone ?? null,
    };
  });
  const fetched = results.map((r) => r.fetchedAt).sort();
  return {
    samples,
    correctionNote: LAPSE_NOTE,
    forecastCount: keys.length,
    stale: results.some((r) => r.stale),
    fetchedAt: fetched[0] ?? null,
  };
}
