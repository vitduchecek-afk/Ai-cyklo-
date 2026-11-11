/**
 * Compare candidate trip dates by their forecast. Candidates beyond the
 * 16-day horizon are never scored; they are returned in `beyondHorizon`.
 */
import type { LatLon, WeatherForecast } from '@trailpack/shared';
import { forecastConfidence, type ConfidenceLevel } from './horizon';
import { THRESHOLDS } from './risks';
import { localDateOf, toMs } from './time';

export interface DateCandidate {
  id: string;
  label: string;
  /** First day of the trip, "YYYY-MM-DD". */
  dateIso: string;
  /** Trip length in days (>= 1). */
  days: number;
  /** Route sample points (informational; the forecast per candidate is supplied in `forecasts`). */
  points?: LatLon[];
}

export interface DatePreferences {
  avoidRain: boolean;
  /** Maximum acceptable wind gust (km/h). */
  maxGustKmh?: number;
  /** Minimum acceptable temperature (°C). */
  minTempC?: number;
  /** Maximum acceptable temperature (°C). */
  maxTempC?: number;
}

export interface RankedDate {
  id: string;
  label: string;
  dateIso: string;
  /** 0-100, higher is better. Low-confidence forecasts are pulled toward 50. */
  score: number;
  /** Total precipitation over the evaluated days (mm). */
  rainMm: number;
  /** Rainy hours (>= 0.2 mm/h) between 06:00 and 21:00. */
  rainHours: number;
  /** Max wind gust (km/h). */
  maxGust: number;
  tempRange: { minC: number | null; maxC: number | null };
  /** Number of hours with thunderstorm risk. */
  storms: number;
  confidence: ConfidenceLevel;
  /** Number of trip days actually covered by the forecast. */
  evaluatedDays: number;
  reasons: string[];
}

export interface BeyondHorizonDate {
  id: string;
  label: string;
  dateIso: string;
  reason: 'horizon' | 'past' | 'no_data';
  message: string;
}

export interface DateComparison {
  ranked: RankedDate[];
  beyondHorizon: BeyondHorizonDate[];
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Compare candidate dates. `now` is epoch ms, Date or ISO string. */
export function compareDates(args: {
  candidates: DateCandidate[];
  forecasts: Record<string, WeatherForecast | null>;
  preferences: DatePreferences;
  now: number | Date | string;
}): DateComparison {
  const nowMs = toMs(args.now);
  const pref = args.preferences;
  const ranked: RankedDate[] = [];
  const beyond: BeyondHorizonDate[] = [];

  for (const c of args.candidates) {
    const startConf = forecastConfidence(c.dateIso, nowMs);
    if (startConf.level === 'none') {
      const past = startConf.daysAhead < 0;
      beyond.push({
        id: c.id,
        label: c.label,
        dateIso: c.dateIso,
        reason: past ? 'past' : 'horizon',
        message: past ? `${c.label}: termín je v minulosti.` : `${c.label}: termín je za horizontem předpovědi (max. 16 dní) – počasí zatím nelze předpovědět, takže termín nelze porovnat.`,
      });
      continue;
    }
    const f = args.forecasts[c.id];
    if (!f) {
      beyond.push({ id: c.id, label: c.label, dateIso: c.dateIso, reason: 'no_data', message: `${c.label}: předpověď se nepodařilo načíst (offline nebo chyba služby).` });
      continue;
    }
    const dates = Array.from({ length: Math.max(1, c.days) }, (_, i) => addDays(c.dateIso, i)).filter((d) => forecastConfidence(d, nowMs).level !== 'none' && f.daily.some((x) => x.date === d));
    if (dates.length === 0) {
      beyond.push({ id: c.id, label: c.label, dateIso: c.dateIso, reason: 'no_data', message: `${c.label}: stažená předpověď tento termín nepokrývá.` });
      continue;
    }
    const set = new Set(dates);
    const daily = f.daily.filter((d) => set.has(d.date));
    const hours = f.hourly.filter((h) => set.has(h.time.slice(0, 10)));
    const day = hours.filter((h) => {
      const hr = Number(h.time.slice(11, 13));
      return hr >= 6 && hr <= 21;
    });
    const hourlySum = day.reduce((s, h) => s + (h.precipitationMm ?? 0), 0);
    const dailySum = daily.reduce((s, d) => s + (d.precipitationSumMm ?? 0), 0);
    const rainMm = Math.round(Math.max(hourlySum, dailySum) * 10) / 10;
    const rainHours = day.filter((h) => (h.precipitationMm ?? 0) >= THRESHOLDS.rainyHourMm).length;
    const maxGust = Math.round(Math.max(0, ...daily.map((d) => d.windGustsMaxKmh ?? 0), ...hours.map((h) => h.windGustsKmh ?? 0)));
    const mins = daily.map((d) => d.tempMinC).filter((x): x is number => x !== null);
    const maxs = daily.map((d) => d.tempMaxC).filter((x): x is number => x !== null);
    const tempRange = { minC: mins.length ? Math.min(...mins) : null, maxC: maxs.length ? Math.max(...maxs) : null };
    const storms = hours.filter((h) => (h.weatherCode ?? 0) >= 95 || ((h.capeJkg ?? 0) > THRESHOLDS.capeStormJkg && (h.precipitationProbabilityPct ?? 0) >= THRESHOLDS.stormProbabilityPct)).length;

    const order: ConfidenceLevel[] = ['high', 'medium', 'low'];
    const confidence = dates.map((d) => forecastConfidence(d, nowMs).level).reduce<ConfidenceLevel>((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a), 'high');

    let score = 100;
    const reasons: string[] = [];
    const w = pref.avoidRain ? 1.5 : 0.5;
    const rainPenalty = Math.min(40, rainMm * 2 * w) + Math.min(15, rainHours * w);
    score -= rainPenalty;
    if (rainMm >= 1 || rainHours > 0) reasons.push(`Srážky ${rainMm} mm, ${rainHours} deštivých hodin${rainPenalty >= 20 ? ' – výrazně zhoršuje hodnocení' : ''}.`);
    else reasons.push('Bez významnějších srážek.');
    if (storms > 0) {
      score -= Math.min(30, storms * 10);
      reasons.push(`Riziko bouřek v ${storms} hodinách.`);
    }
    const gustLimit = pref.maxGustKmh ?? THRESHOLDS.gustWarningKmh;
    if (maxGust > gustLimit) {
      score -= Math.min(25, 5 + (maxGust - gustLimit));
      reasons.push(`Nárazy větru až ${maxGust} km/h překračují limit ${gustLimit} km/h.`);
    } else reasons.push(`Nárazy větru max. ${maxGust} km/h.`);
    if (pref.minTempC !== undefined && tempRange.minC !== null && tempRange.minC < pref.minTempC) {
      score -= Math.min(20, (pref.minTempC - tempRange.minC) * 3);
      reasons.push(`Noční minimum ${tempRange.minC} °C je pod tvým limitem ${pref.minTempC} °C.`);
    }
    if (pref.maxTempC !== undefined && tempRange.maxC !== null && tempRange.maxC > pref.maxTempC) {
      score -= Math.min(20, (tempRange.maxC - pref.maxTempC) * 3);
      reasons.push(`Denní maximum ${tempRange.maxC} °C je nad tvým limitem ${pref.maxTempC} °C.`);
    }
    if (tempRange.minC !== null && tempRange.maxC !== null) reasons.push(`Teploty ${tempRange.minC} až ${tempRange.maxC} °C.`);
    score = Math.max(0, Math.min(100, score));
    if (confidence !== 'high') {
      const factor = confidence === 'medium' ? 0.85 : 0.6;
      score = 50 + (score - 50) * factor;
      reasons.push(confidence === 'medium' ? 'Střednědobá předpověď (3–6 dní): skóre je mírně přitaženo k průměru.' : 'Nízká spolehlivost předpovědi (7+ dní): skóre je orientační.');
    }
    if (dates.length < c.days) reasons.push(`Předpověď pokrývá jen ${dates.length} z ${c.days} dní trasy – zbytek je za horizontem.`);
    ranked.push({ id: c.id, label: c.label, dateIso: c.dateIso, score: Math.round(score), rainMm, rainHours, maxGust, tempRange, storms, confidence, evaluatedDays: dates.length, reasons });
  }
  const rank: Record<ConfidenceLevel, number> = { high: 0, medium: 1, low: 2, none: 3 };
  ranked.sort((a, b) => b.score - a.score || rank[a.confidence] - rank[b.confidence] || a.dateIso.localeCompare(b.dateIso));
  return { ranked, beyondHorizon: beyond };
}

/** The upcoming Saturday and Sunday (today counts if it is Saturday; on Sunday the next weekend is returned). Dates are Europe/Prague local dates. */
export function nextWeekendDates(now: number | Date | string): { saturday: string; sunday: string } {
  const ms = toMs(now);
  const today = localDateOf(ms, 'Europe/Prague');
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const toSat = dow === 0 ? 6 : (6 - dow + 7) % 7;
  const saturday = addDays(today, toSat);
  return { saturday, sunday: addDays(saturday, 1) };
}
