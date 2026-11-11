import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HttpClient, type FetchLike, type HourlyWeather, type DailyWeather, type WeatherForecast } from '@trailpack/shared';

export const fixture = (name: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));

export interface MockFetch {
  fetch: FetchLike;
  calls: string[];
}

/** fetch mock returning a fixed JSON body with the given status. */
export function mockFetch(body: unknown, status = 200): MockFetch {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

export const clientFor = (m: MockFetch) => new HttpClient({ fetch: m.fetch, minIntervalMsPerHost: {}, retries: 0 });

export const hour = (time: string, o: Partial<HourlyWeather> = {}): HourlyWeather => ({
  time,
  temperatureC: 10,
  apparentTemperatureC: 10,
  humidityPct: 60,
  dewPointC: 3,
  precipitationMm: 0,
  precipitationProbabilityPct: 0,
  windSpeedKmh: 10,
  windGustsKmh: 15,
  windDirectionDeg: 270,
  cloudCoverPct: 20,
  uvIndex: 1,
  weatherCode: 1,
  capeJkg: 0,
  snowDepthM: 0,
  snowfallCm: 0,
  freezingLevelM: 3000,
  isDay: true,
  ...o,
});

export const day = (date: string, o: Partial<DailyWeather> = {}): DailyWeather => ({
  date,
  tempMinC: 5,
  tempMaxC: 15,
  precipitationSumMm: 0,
  precipitationProbabilityMaxPct: 5,
  windSpeedMaxKmh: 15,
  windGustsMaxKmh: 25,
  uvIndexMax: 2,
  sunrise: `${date}T07:00`,
  sunset: `${date}T16:30`,
  weatherCode: 1,
  ...o,
});

/** Synthetic forecast: `hours` for the first day, mild defaults. */
export function forecastOf(hours: HourlyWeather[], daily: DailyWeather[], eleM: number | null = 500): WeatherForecast {
  return { lat: 50, lon: 15, eleM, timezone: 'Europe/Prague', provider: 'Open-Meteo', fetchedAt: '2026-11-11T08:00:00.000Z', hourly: hours, daily, attribution: 'Open-Meteo' };
}

export const NOW = Date.parse('2026-11-11T08:00:00Z');
