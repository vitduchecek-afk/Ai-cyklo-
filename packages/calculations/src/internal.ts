/**
 * Internal helpers shared by the calculation modules (not re-exported from
 * the package index).
 */
import { TrailPackError } from '@trailpack/shared';
import type { Advisory, Severity } from '@trailpack/shared';

/** Throw a Czech-worded `invalid_input` error. */
export function invalid(message: string, details?: unknown): never {
  throw new TrailPackError('invalid_input', message, { details });
}

/** Require a finite number >= min (default 0). Returns the value. */
export function requireNumber(name: string, v: unknown, min = 0, max = Number.POSITIVE_INFINITY): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    invalid(`Neplatná hodnota „${name}“: ${String(v)} (očekáváno číslo v rozsahu ${min}–${max}).`, { name, value: v });
  }
  return v;
}

/** Require a positive integer. */
export function requireInt(name: string, v: unknown, min = 1, max = 100000): number {
  const n = requireNumber(name, v, min, max);
  if (!Number.isInteger(n)) invalid(`Hodnota „${name}“ musí být celé číslo.`, { name, value: v });
  return n;
}

export const ADVISORY_SOURCE = '@trailpack/calculations';

/** Build an Advisory with the package source filled in. */
export function advisory(
  code: string,
  severity: Severity,
  message: string,
  extra: {
    params?: Advisory['params'];
    basis?: string[];
    action?: string;
    uncertainty?: string;
  } = {},
): Advisory {
  return {
    code,
    severity,
    message,
    params: extra.params ?? {},
    basis: extra.basis ?? [],
    action: extra.action,
    uncertainty: extra.uncertainty,
    source: ADVISORY_SOURCE,
  };
}

/** Round to a given number of decimals. */
export const r = (v: number, d = 0): number => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

/** Linear interpolation over a sorted table of [x, y] pairs (clamped at the ends). */
export function interpolate(table: ReadonlyArray<readonly [number, number]>, x: number): number {
  const first = table[0]!;
  const last = table[table.length - 1]!;
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 0; i < table.length - 1; i++) {
    const a = table[i]!;
    const b = table[i + 1]!;
    if (x >= a[0] && x <= b[0]) {
      const t = (x - a[0]) / (b[0] - a[0]);
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return last[1];
}
