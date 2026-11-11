/**
 * Time helpers. Open-Meteo (timezone=auto) returns LOCAL wall-clock times
 * without an offset ("2026-11-11T14:00"); these helpers convert them to UTC
 * epoch milliseconds using the IANA timezone of the forecast.
 */

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(timeZone, f);
  }
  return f;
}

/** Offset (ms) of `timeZone` from UTC at the instant `ms` (positive east of Greenwich). */
export function tzOffsetMs(ms: number, timeZone: string): number {
  try {
    const parts = formatter(timeZone).formatToParts(new Date(ms));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return asUtc - Math.floor(ms / 1000) * 1000;
  } catch {
    return 0;
  }
}

/** Parse "YYYY-MM-DDTHH:mm" (or date only) as wall-clock time in `timeZone` -> UTC epoch ms. */
export function localToMs(local: string, timeZone: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(local);
  if (!m) return Number.NaN;
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
  const first = naive - tzOffsetMs(naive, timeZone);
  return naive - tzOffsetMs(first, timeZone);
}

/** Local calendar date "YYYY-MM-DD" of the instant `ms` in `timeZone`. */
export function localDateOf(ms: number, timeZone: string): string {
  const d = new Date(ms + tzOffsetMs(ms, timeZone));
  return d.toISOString().slice(0, 10);
}

/** Local hour 0-23 of the instant `ms` in `timeZone`. */
export function localHourOf(ms: number, timeZone: string): number {
  return new Date(ms + tzOffsetMs(ms, timeZone)).getUTCHours();
}

/** Whole calendar days between two "YYYY-MM-DD" strings (b - a). */
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

export const toMs = (t: number | Date | string): number => (typeof t === 'number' ? t : t instanceof Date ? t.getTime() : Date.parse(t));
