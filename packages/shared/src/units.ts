/** Unit conversion and formatting (metric default, imperial supported). */
import type { Units } from './models';

export const KM_PER_MILE = 1.609344;
export const M_PER_FT = 0.3048;
export const G_PER_OZ = 28.349523125;
export const G_PER_LB = 453.59237;

export function formatDistance(meters: number, units: Units = 'metric', locale = 'cs-CZ'): string {
  if (units === 'imperial') {
    const mi = meters / 1000 / KM_PER_MILE;
    return `${mi.toLocaleString(locale, { maximumFractionDigits: mi < 10 ? 1 : 0 })} mi`;
  }
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return `${km.toLocaleString(locale, { maximumFractionDigits: km < 100 ? 1 : 0 })} km`;
}

export function formatElevation(meters: number, units: Units = 'metric', locale = 'cs-CZ'): string {
  if (units === 'imperial') return `${Math.round(meters / M_PER_FT).toLocaleString(locale)} ft`;
  return `${Math.round(meters).toLocaleString(locale)} m`;
}

export function formatWeight(grams: number, units: Units = 'metric', locale = 'cs-CZ'): string {
  if (units === 'imperial') {
    if (grams < G_PER_LB) return `${(grams / G_PER_OZ).toLocaleString(locale, { maximumFractionDigits: 1 })} oz`;
    return `${(grams / G_PER_LB).toLocaleString(locale, { maximumFractionDigits: 2 })} lb`;
  }
  if (grams < 1000) return `${Math.round(grams).toLocaleString(locale)} g`;
  return `${(grams / 1000).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg`;
}

export function formatTemperature(c: number, units: Units = 'metric'): string {
  if (units === 'imperial') return `${Math.round((c * 9) / 5 + 32)} °F`;
  return `${Math.round(c)} °C`;
}

export function formatSpeed(kmh: number, units: Units = 'metric', locale = 'cs-CZ'): string {
  if (units === 'imperial') return `${(kmh / KM_PER_MILE).toLocaleString(locale, { maximumFractionDigits: 1 })} mph`;
  return `${kmh.toLocaleString(locale, { maximumFractionDigits: 1 })} km/h`;
}

export function formatVolume(liters: number, units: Units = 'metric', locale = 'cs-CZ'): string {
  if (units === 'imperial') return `${(liters * 33.814).toLocaleString(locale, { maximumFractionDigits: 0 })} fl oz`;
  return `${liters.toLocaleString(locale, { maximumFractionDigits: 1 })} l`;
}

/** Minutes -> "3 h 25 min" */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest} min`;
  if (rest === 0) return `${h} h`;
  return `${h} h ${rest} min`;
}

export function formatMoney(amount: number, currency = 'CZK', locale = 'cs-CZ'): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: currency === 'CZK' ? 0 : 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Decimal degrees -> "49.54613° N, 18.44751° E" */
export function formatCoordinates(lat: number, lon: number, decimals = 5): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(decimals)}° ${ns}, ${Math.abs(lon).toFixed(decimals)}° ${ew}`;
}

/** Decimal degrees -> DMS "49°32'46.1\"N 18°26'51.0\"E" */
export function formatDMS(lat: number, lon: number): string {
  const part = (v: number, pos: string, neg: string) => {
    const a = Math.abs(v);
    const d = Math.floor(a);
    const mFloat = (a - d) * 60;
    const m = Math.floor(mFloat);
    const s = (mFloat - m) * 60;
    return `${d}°${String(m).padStart(2, '0')}'${s.toFixed(1).padStart(4, '0')}"${v >= 0 ? pos : neg}`;
  };
  return `${part(lat, 'N', 'S')} ${part(lon, 'E', 'W')}`;
}

/**
 * Parse coordinates typed by a user: "49.546, 18.447", "49.546N 18.447E",
 * DMS "49°32'46\"N 18°26'51\"E". Returns null if not recognised.
 */
export function parseCoordinates(input: string): { lat: number; lon: number } | null {
  const s = input.trim().replace(/,(?=\d)/g, '.');
  const dms = /(\d{1,3})°\s*(\d{1,2})['′]\s*(\d{1,2}(?:\.\d+)?)["″]?\s*([NS])[\s,;]+(\d{1,3})°\s*(\d{1,2})['′]\s*(\d{1,2}(?:\.\d+)?)["″]?\s*([EW])/i.exec(s);
  if (dms) {
    const lat = (Number(dms[1]) + Number(dms[2]) / 60 + Number(dms[3]) / 3600) * (dms[4]!.toUpperCase() === 'S' ? -1 : 1);
    const lon = (Number(dms[5]) + Number(dms[6]) / 60 + Number(dms[7]) / 3600) * (dms[8]!.toUpperCase() === 'W' ? -1 : 1);
    return valid(lat, lon);
  }
  const dec = /^(-?\d{1,2}(?:\.\d+)?)\s*°?\s*([NS])?[\s,;]+(-?\d{1,3}(?:\.\d+)?)\s*°?\s*([EW])?$/i.exec(s);
  if (dec) {
    let lat = Number(dec[1]);
    let lon = Number(dec[3]);
    if (dec[2]?.toUpperCase() === 'S') lat = -Math.abs(lat);
    if (dec[4]?.toUpperCase() === 'W') lon = -Math.abs(lon);
    return valid(lat, lon);
  }
  return null;
}

const valid = (lat: number, lon: number) =>
  Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
