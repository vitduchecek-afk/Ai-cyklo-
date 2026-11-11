/**
 * Open-Meteo forecast provider (https://open-meteo.com). Free, no key required
 * for non-commercial use; an optional `apiKey` switches to the commercial host.
 * All speeds are km/h, temperatures °C, precipitation mm, snow depth m,
 * snowfall cm, heights m.
 */
import {
  ENDPOINTS,
  TrailPackError,
  buildUrl,
  cacheKey,
  isTrailPackError,
  type DailyWeather,
  type HourlyWeather,
  type HttpClient,
  type KeyValueCache,
  type WeatherForecast,
} from '@trailpack/shared';

export const HOURLY_VARIABLES = [
  'temperature_2m',
  'apparent_temperature',
  'relative_humidity_2m',
  'dew_point_2m',
  'precipitation',
  'precipitation_probability',
  'wind_speed_10m',
  'wind_gusts_10m',
  'wind_direction_10m',
  'cloud_cover',
  'uv_index',
  'weather_code',
  'cape',
  'snow_depth',
  'snowfall',
  'freezing_level_height',
  'is_day',
] as const;

export const DAILY_VARIABLES = [
  'temperature_2m_min',
  'temperature_2m_max',
  'precipitation_sum',
  'precipitation_probability_max',
  'wind_speed_10m_max',
  'wind_gusts_10m_max',
  'uv_index_max',
  'sunrise',
  'sunset',
  'weather_code',
] as const;

/** Cache TTL for forecasts (60 min). */
export const FORECAST_TTL_MS = 60 * 60 * 1000;
/** Maximum number of coordinates per HTTP request. */
export const MULTI_BATCH_SIZE = 40;
const COMMERCIAL_ENDPOINT = 'https://customer-api.open-meteo.com/v1/forecast';

export interface ForecastRequest {
  lat: number;
  lon: number;
  /** Number of forecast days, integer 1-16 (day 0 = today in the location's timezone). */
  days: number;
  /** Override of the model grid elevation (m a.s.l.) for statistical downscaling of temperature. */
  elevationM?: number;
}

/** WeatherForecast plus cache metadata. `fetchedAt` is when the data was retrieved from Open-Meteo. */
export type ForecastResult = WeatherForecast & {
  /** true when the network failed and an expired cached forecast is returned. */
  stale: boolean;
  /** Offset of the location's timezone from UTC at the start of the forecast (s). */
  utcOffsetSeconds: number;
};

export interface OpenMeteoProviderOptions {
  http: HttpClient;
  cache?: KeyValueCache;
  /** Commercial API key (optional). */
  apiKey?: string;
}

type Raw = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (o: Raw | undefined, k: string): unknown[] => (o && Array.isArray(o[k]) ? (o[k] as unknown[]) : []);

/** Convert one Open-Meteo response object (single location) to the shared WeatherForecast model. */
export function mapOpenMeteoResponse(raw: Raw, fetchedAtMs: number): WeatherForecast & { utcOffsetSeconds: number } {
  const hourlyRaw = (raw.hourly ?? {}) as Raw;
  const dailyRaw = (raw.daily ?? {}) as Raw;
  const times = arr(hourlyRaw, 'time') as string[];
  const col = (k: string) => arr(hourlyRaw, k);
  const hourly: HourlyWeather[] = times.map((time, i) => {
    const isDay = col('is_day')[i];
    return {
      time,
      temperatureC: num(col('temperature_2m')[i]),
      apparentTemperatureC: num(col('apparent_temperature')[i]),
      humidityPct: num(col('relative_humidity_2m')[i]),
      dewPointC: num(col('dew_point_2m')[i]),
      precipitationMm: num(col('precipitation')[i]),
      precipitationProbabilityPct: num(col('precipitation_probability')[i]),
      windSpeedKmh: num(col('wind_speed_10m')[i]),
      windGustsKmh: num(col('wind_gusts_10m')[i]),
      windDirectionDeg: num(col('wind_direction_10m')[i]),
      cloudCoverPct: num(col('cloud_cover')[i]),
      uvIndex: num(col('uv_index')[i]),
      weatherCode: num(col('weather_code')[i]),
      capeJkg: num(col('cape')[i]),
      snowDepthM: num(col('snow_depth')[i]),
      snowfallCm: num(col('snowfall')[i]),
      freezingLevelM: num(col('freezing_level_height')[i]),
      isDay: isDay === undefined || isDay === null ? null : Number(isDay) === 1,
    };
  });
  const dates = arr(dailyRaw, 'time') as string[];
  const d = (k: string) => arr(dailyRaw, k);
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const daily: DailyWeather[] = dates.map((date, i) => ({
    date,
    tempMinC: num(d('temperature_2m_min')[i]),
    tempMaxC: num(d('temperature_2m_max')[i]),
    precipitationSumMm: num(d('precipitation_sum')[i]),
    precipitationProbabilityMaxPct: num(d('precipitation_probability_max')[i]),
    windSpeedMaxKmh: num(d('wind_speed_10m_max')[i]),
    windGustsMaxKmh: num(d('wind_gusts_10m_max')[i]),
    uvIndexMax: num(d('uv_index_max')[i]),
    sunrise: str(d('sunrise')[i]),
    sunset: str(d('sunset')[i]),
    weatherCode: num(d('weather_code')[i]),
  }));
  const lat = num(raw.latitude);
  const lon = num(raw.longitude);
  if (lat === null || lon === null) throw new TrailPackError('parse_error', 'Open-Meteo: odpověď neobsahuje souřadnice', { provider: 'open-meteo' });
  return {
    lat,
    lon,
    eleM: num(raw.elevation),
    timezone: typeof raw.timezone === 'string' ? raw.timezone : 'UTC',
    provider: 'Open-Meteo',
    model: 'best_match',
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    hourly,
    daily,
    attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)',
    utcOffsetSeconds: num(raw.utc_offset_seconds) ?? 0,
  };
}

/** Convert a failed HTTP call into a TrailPackError carrying Open-Meteo's own reason. */
function mapError(e: unknown): TrailPackError {
  if (isTrailPackError(e)) {
    if (e.status !== undefined && typeof e.details === 'string') {
      try {
        const body = JSON.parse(e.details) as { reason?: unknown };
        if (typeof body.reason === 'string') {
          const code = e.status === 400 ? 'invalid_input' : e.code;
          return new TrailPackError(code, `Open-Meteo: ${body.reason}`, { provider: 'open-meteo', status: e.status, retryable: e.retryable, details: body, cause: e });
        }
      } catch {
        /* details were not JSON */
      }
    }
    return e.provider ? e : new TrailPackError(e.code, e.message, { provider: 'open-meteo', status: e.status, retryable: e.retryable, details: e.details, cause: e });
  }
  return new TrailPackError('unknown', e instanceof Error ? e.message : String(e), { provider: 'open-meteo', cause: e });
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

export class OpenMeteoProvider {
  private readonly http: HttpClient;
  private readonly cache?: KeyValueCache;
  private readonly apiKey?: string;

  constructor(opts: OpenMeteoProviderOptions) {
    this.http = opts.http;
    this.cache = opts.cache;
    this.apiKey = opts.apiKey;
  }

  /** Forecast for one location (cached 60 min, stale-if-error). */
  async getForecast(req: ForecastRequest): Promise<ForecastResult> {
    const [r] = await this.getForecastMulti([req]);
    if (!r) throw new TrailPackError('provider_error', 'Open-Meteo: prázdná odpověď', { provider: 'open-meteo' });
    return r;
  }

  /**
   * Forecasts for many locations; result order matches `points`. Locations are
   * fetched in batches of {@link MULTI_BATCH_SIZE} per request; each location is
   * cached separately so repeated plans reuse fresh entries.
   */
  async getForecastMulti(points: ForecastRequest[]): Promise<ForecastResult[]> {
    for (const p of points) this.validate(p);
    const now = Date.now();
    const out: Array<ForecastResult | undefined> = new Array(points.length).fill(undefined);
    const keys = points.map((p) => cacheKey('open-meteo', { lat: round4(p.lat), lon: round4(p.lon), days: p.days, ele: p.elevationM ?? null }));
    const staleFallback = new Map<number, ForecastResult>();
    const missing: number[] = [];

    for (let i = 0; i < points.length; i++) {
      const hit = this.cache ? await this.cache.get<ForecastResult>(keys[i]!) : undefined;
      if (hit && hit.expiresAt > now) out[i] = { ...hit.value, stale: false };
      else {
        missing.push(i);
        if (hit) staleFallback.set(i, { ...hit.value, stale: true });
      }
    }

    // group by (days, has elevation override) so each request uses uniform parameters
    const groups = new Map<string, number[]>();
    for (const i of missing) {
      const p = points[i]!;
      const g = `${p.days}|${p.elevationM !== undefined}`;
      groups.set(g, [...(groups.get(g) ?? []), i]);
    }
    for (const idxs of groups.values()) {
      for (let s = 0; s < idxs.length; s += MULTI_BATCH_SIZE) {
        const batch = idxs.slice(s, s + MULTI_BATCH_SIZE);
        try {
          const results = await this.fetchBatch(batch.map((i) => points[i]!));
          for (let k = 0; k < batch.length; k++) {
            const i = batch[k]!;
            const value = results[k]!;
            out[i] = value;
            if (this.cache) await this.cache.set(keys[i]!, value, FORECAST_TTL_MS);
          }
        } catch (e) {
          // stale-if-error: serve expired cache for the whole batch or fail
          if (batch.every((i) => staleFallback.has(i))) for (const i of batch) out[i] = staleFallback.get(i);
          else throw e;
        }
      }
    }
    return out.map((r) => {
      if (!r) throw new TrailPackError('provider_error', 'Open-Meteo: chybí data pro některý bod', { provider: 'open-meteo' });
      return r;
    });
  }

  private validate(p: ForecastRequest): void {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) {
      throw new TrailPackError('invalid_input', 'Neplatné souřadnice pro předpověď', { provider: 'open-meteo' });
    }
    if (!Number.isInteger(p.days) || p.days < 1 || p.days > 16) {
      throw new TrailPackError('invalid_input', 'Počet dní předpovědi musí být celé číslo 1–16', { provider: 'open-meteo' });
    }
  }

  private async fetchBatch(batch: ForecastRequest[]): Promise<ForecastResult[]> {
    const days = batch[0]!.days;
    const withEle = batch[0]!.elevationM !== undefined;
    const url = buildUrl(this.apiKey ? COMMERCIAL_ENDPOINT : ENDPOINTS.openMeteoForecast, {
      latitude: batch.map((p) => round4(p.lat)),
      longitude: batch.map((p) => round4(p.lon)),
      elevation: withEle ? batch.map((p) => Math.round(p.elevationM ?? 0)) : undefined,
      hourly: [...HOURLY_VARIABLES],
      daily: [...DAILY_VARIABLES],
      timezone: 'auto',
      forecast_days: days,
      wind_speed_unit: 'kmh',
      temperature_unit: 'celsius',
      precipitation_unit: 'mm',
      apikey: this.apiKey,
    });
    let body: unknown;
    try {
      body = await this.http.json<unknown>(url, { provider: 'open-meteo' });
    } catch (e) {
      throw mapError(e);
    }
    const fetchedAt = Date.now();
    if (body && !Array.isArray(body) && (body as Raw).error === true) {
      throw new TrailPackError('invalid_input', `Open-Meteo: ${String((body as Raw).reason ?? 'neznámá chyba')}`, { provider: 'open-meteo', status: 400 });
    }
    const list = (Array.isArray(body) ? body : [body]) as Raw[];
    if (list.length !== batch.length) {
      throw new TrailPackError('parse_error', `Open-Meteo vrátilo ${list.length} míst místo ${batch.length}`, { provider: 'open-meteo' });
    }
    return list.map((raw) => ({ ...mapOpenMeteoResponse(raw, fetchedAt), stale: false }));
  }
}
