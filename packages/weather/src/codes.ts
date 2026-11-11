/** WMO weather codes, wind direction names and the Beaufort scale (Czech labels). */

export type WeatherSeverity = 'ok' | 'caution' | 'warning' | 'danger';

export interface WeatherCodeInfo {
  code: number;
  /** Czech description. */
  label: string;
  /** Icon key (maps to the UI icon set). */
  icon: string;
  severity: WeatherSeverity;
}

const T = (label: string, icon: string, severity: WeatherSeverity) => ({ label, icon, severity });

const TABLE: Record<number, Omit<WeatherCodeInfo, 'code'>> = {
  0: T('Jasno', 'sun', 'ok'),
  1: T('Převážně jasno', 'sun', 'ok'),
  2: T('Polojasno', 'cloud-sun', 'ok'),
  3: T('Zataženo', 'cloud', 'ok'),
  45: T('Mlha', 'fog', 'caution'),
  48: T('Namrzající mlha', 'fog', 'warning'),
  51: T('Slabé mrholení', 'drizzle', 'caution'),
  53: T('Mrholení', 'drizzle', 'caution'),
  55: T('Silné mrholení', 'drizzle', 'caution'),
  56: T('Mrznoucí mrholení', 'drizzle', 'warning'),
  57: T('Silné mrznoucí mrholení', 'drizzle', 'warning'),
  61: T('Slabý déšť', 'rain', 'caution'),
  63: T('Mírný déšť', 'rain', 'caution'),
  65: T('Silný déšť', 'rain', 'warning'),
  66: T('Mrznoucí déšť', 'rain', 'danger'),
  67: T('Silný mrznoucí déšť', 'rain', 'danger'),
  71: T('Slabé sněžení', 'snow', 'caution'),
  73: T('Mírné sněžení', 'snow', 'warning'),
  75: T('Silné sněžení', 'snow', 'warning'),
  77: T('Sněhová zrna', 'snow', 'caution'),
  80: T('Slabé přeháňky', 'showers', 'caution'),
  81: T('Mírné přeháňky', 'showers', 'caution'),
  82: T('Prudké přeháňky', 'showers', 'warning'),
  85: T('Sněhové přeháňky', 'snow', 'warning'),
  86: T('Silné sněhové přeháňky', 'snow', 'warning'),
  95: T('Bouřka', 'storm', 'danger'),
  96: T('Bouřka s krupobitím', 'storm', 'danger'),
  99: T('Silná bouřka s krupobitím', 'storm', 'danger'),
};

/** Describe a WMO code; unknown codes yield a neutral fallback. */
export function describeWeatherCode(code: number | null | undefined): WeatherCodeInfo {
  if (code === null || code === undefined || !(code in TABLE)) return { code: code ?? -1, label: 'Neznámé počasí', icon: 'cloud', severity: 'ok' };
  return { code, ...TABLE[code]! };
}

const COMPASS = ['S', 'SV', 'V', 'JV', 'J', 'JZ', 'Z', 'SZ'] as const;

/** Czech compass abbreviation for a wind direction in degrees (direction the wind blows FROM). */
export function windDirectionLabel(deg: number): (typeof COMPASS)[number] {
  const n = ((deg % 360) + 360) % 360;
  return COMPASS[Math.round(n / 45) % 8]!;
}

export interface BeaufortInfo {
  force: number;
  label: string;
}

const BEAUFORT: Array<[number, string]> = [
  [1, 'bezvětří'],
  [6, 'vánek'],
  [12, 'slabý vítr'],
  [20, 'mírný vítr'],
  [29, 'dosti čerstvý vítr'],
  [39, 'čerstvý vítr'],
  [50, 'silný vítr'],
  [62, 'prudký vítr'],
  [75, 'bouřlivý vítr'],
  [89, 'vichřice'],
  [103, 'silná vichřice'],
  [118, 'mohutná vichřice'],
];

/** Beaufort force 0-12 for a wind speed in km/h (10 m height). */
export function beaufort(speedKmh: number): BeaufortInfo {
  for (let i = 0; i < BEAUFORT.length; i++) if (speedKmh < BEAUFORT[i]![0]) return { force: i, label: BEAUFORT[i]![1] };
  return { force: 12, label: 'orkán' };
}
