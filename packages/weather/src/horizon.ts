import { dayDiff, toMs } from './time';

export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'none';

export interface ForecastConfidence {
  level: ConfidenceLevel;
  /** Whole days from `now` (UTC calendar date) to the target date; negative = past. */
  daysAhead: number;
  /** Czech explanation suitable for the UI. */
  explanation: string;
}

/** Open-Meteo provides at most 16 forecast days (index 0..15). */
export const MAX_FORECAST_DAYS = 16;

/**
 * How far can a forecast for `targetDate` be trusted?
 * 0-2 days: high, 3-6: medium, 7-15: low, 16+ or past: none (no forecast must be shown).
 * @param targetDate ISO date ("YYYY-MM-DD"), ISO datetime, Date or epoch ms.
 * @param now current time (Date, epoch ms or ISO string).
 */
export function forecastConfidence(targetDate: string | number | Date, now: number | Date | string): ForecastConfidence {
  const nowIso = new Date(toMs(now)).toISOString().slice(0, 10);
  const targetIso = typeof targetDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(targetDate) ? targetDate.slice(0, 10) : new Date(toMs(targetDate)).toISOString().slice(0, 10);
  const d = dayDiff(nowIso, targetIso);
  if (d < 0) return { level: 'none', daysAhead: d, explanation: 'Datum je v minulosti, předpověď se nezobrazuje.' };
  if (d <= 2) return { level: 'high', daysAhead: d, explanation: 'Krátkodobá předpověď (0–2 dny) je poměrně spolehlivá; srážky a bouřky se ale i tak mohou lokálně lišit.' };
  if (d <= 6) return { level: 'medium', daysAhead: d, explanation: `Předpověď na ${d} dny dopředu je orientační; čas a intenzita srážek či bouřek se může výrazně posunout.` };
  if (d < MAX_FORECAST_DAYS) return { level: 'low', daysAhead: d, explanation: `Předpověď na ${d} dní dopředu má nízkou spolehlivost – ber ji jen jako trend (teplotní pásmo, celkově suché/mokré období).` };
  return { level: 'none', daysAhead: d, explanation: `Za horizontem předpovědi (max. ${MAX_FORECAST_DAYS} dní). Počasí na toto datum zatím nelze předpovědět; zobrazit lze jen klimatický průměr, nikoli předpověď.` };
}
