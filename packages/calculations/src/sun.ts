/**
 * Sunrise / sunset / civil twilight using the NOAA solar calculator
 * algorithm (Meeus-based). Accuracy is typically within 1–2 minutes for
 * latitudes up to about ±72°; atmospheric refraction is fixed at the
 * standard value, so real times vary slightly with weather and horizon.
 */
import { IsoDateSchema, LatSchema, LonSchema } from '@trailpack/shared';
import { invalid } from './internal';

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Zenith angle of the sunrise/sunset event incl. refraction and solar radius, degrees. */
const ZENITH_SUNRISE = 90.833;
/** Zenith angle of civil twilight, degrees. */
const ZENITH_CIVIL = 96;

interface SolarPosition {
  declRad: number;
  eqTimeMin: number;
}

function solarPosition(jd: number): SolarPosition {
  const t = (jd - 2451545) / 36525;
  const l0 = (((280.46646 + t * (36000.76983 + t * 0.0003032)) % 360) + 360) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const mr = rad(m);
  const c =
    Math.sin(mr) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * mr) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * mr) * 0.000289;
  const trueLong = l0 + c;
  const omega = 125.04 - 1934.136 * t;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(omega));
  const decl = Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda)));
  const y = Math.tan(rad(eps) / 2) ** 2;
  const l0r = rad(l0);
  const eq =
    y * Math.sin(2 * l0r) -
    2 * e * Math.sin(mr) +
    4 * e * y * Math.sin(mr) * Math.cos(2 * l0r) -
    0.5 * y * y * Math.sin(4 * l0r) -
    1.25 * e * e * Math.sin(2 * mr);
  return { declRad: decl, eqTimeMin: 4 * deg(eq) };
}

/** Hour angle (degrees) for a zenith, or a marker when the sun never crosses it. */
function hourAngle(latDeg: number, declRad: number, zenithDeg: number): number | 'always_up' | 'always_down' {
  const lat = rad(latDeg);
  const cosH = (Math.cos(rad(zenithDeg)) - Math.sin(lat) * Math.sin(declRad)) / (Math.cos(lat) * Math.cos(declRad));
  if (cosH < -1) return 'always_up';
  if (cosH > 1) return 'always_down';
  return deg(Math.acos(cosH));
}

/** Sun events of one day. `null` means the event does not occur (polar day / night). */
export interface SunTimes {
  sunrise: Date | null;
  sunset: Date | null;
  civilDawn: Date | null;
  civilDusk: Date | null;
  solarNoon: Date;
}

function parseDate(dateIso: string, lat: number, lon: number): { jd0: number; ms0: number } {
  if (!IsoDateSchema.safeParse(dateIso).success) invalid(`Neplatné datum „${dateIso}“ (očekáváno RRRR-MM-DD).`);
  if (!LatSchema.safeParse(lat).success || !LonSchema.safeParse(lon).success) invalid('Neplatné souřadnice.');
  const [y, m, d] = dateIso.split('-').map(Number) as [number, number, number];
  const ms0 = Date.UTC(y, m - 1, d);
  if (Number.isNaN(ms0) || new Date(ms0).toISOString().slice(0, 10) !== dateIso) invalid(`Neplatné datum „${dateIso}“.`);
  return { jd0: ms0 / 86400000 + 2440587.5, ms0 };
}

/**
 * Sun events for a calendar date at a location.
 * @param dateIso local calendar date `YYYY-MM-DD` (interpreted at the location's solar day)
 * @param lat latitude, degrees
 * @param lon longitude, degrees (east positive)
 * @returns UTC instants; `null` for events that do not occur (polar day/night)
 */
export function sunTimes(dateIso: string, lat: number, lon: number): SunTimes {
  const { jd0, ms0 } = parseDate(dateIso, lat, lon);
  // Solar noon, refined twice.
  let noonMin = 720 - 4 * lon;
  for (let i = 0; i < 2; i++) noonMin = 720 - 4 * lon - solarPosition(jd0 + noonMin / 1440).eqTimeMin;
  const toDate = (min: number) => new Date(ms0 + Math.round(min * 60000));
  const event = (zenith: number, rising: boolean): Date | null => {
    let guess = noonMin;
    for (let i = 0; i < 3; i++) {
      const pos = solarPosition(jd0 + guess / 1440);
      const ha = hourAngle(lat, pos.declRad, zenith);
      if (typeof ha === 'string') return null;
      const eq = pos.eqTimeMin;
      const offset = 4 * ha;
      guess = 720 - 4 * lon - eq + (rising ? -offset : offset);
    }
    return toDate(guess);
  };
  return {
    sunrise: event(ZENITH_SUNRISE, true),
    sunset: event(ZENITH_SUNRISE, false),
    civilDawn: event(ZENITH_CIVIL, true),
    civilDusk: event(ZENITH_CIVIL, false),
    solarNoon: toDate(noonMin),
  };
}

/**
 * Length of daylight (sunrise to sunset) in minutes. Returns 1440 for polar
 * day and 0 for polar night.
 */
export function daylightMinutes(dateIso: string, lat: number, lon: number): number {
  const t = sunTimes(dateIso, lat, lon);
  if (t.sunrise && t.sunset) return Math.round((t.sunset.getTime() - t.sunrise.getTime()) / 60000);
  const { jd0 } = parseDate(dateIso, lat, lon);
  const pos = solarPosition(jd0 + (720 - 4 * lon) / 1440);
  return hourAngle(lat, pos.declRad, ZENITH_SUNRISE) === 'always_up' ? 1440 : 0;
}
