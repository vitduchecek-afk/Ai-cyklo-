/**
 * Deterministic weather risk analysis. Produces Advisory[] with the data the
 * advice is based on, the source, an update timestamp and an uncertainty note.
 * Units: °C, km/h, mm, cm, m, J/kg.
 */
import type { ActivityType, Advisory, DailyWeather, HourlyWeather, Severity, SleepType, WeatherForecast } from '@trailpack/shared';
import { forecastConfidence, type ConfidenceLevel } from './horizon';
import type { WeatherSample } from './alongRoute';
import { LAPSE_RATE_C_PER_100M } from './alongRoute';
import { localHourOf, localToMs } from './time';

export const WEATHER_SOURCE = 'Open-Meteo';

/** Thresholds (documented in one place; tests pin them). */
export const THRESHOLDS = {
  gustWarningKmh: 50,
  gustDangerKmh: 75,
  gustRidgeWarningKmh: 40,
  gustRidgeDangerKmh: 60,
  capeStormJkg: 800,
  stormProbabilityPct: 40,
  frostWarningC: 0,
  frostDangerC: -5,
  heatWarningC: 30,
  heatDangerC: 35,
  rainDayMm: 10,
  rainHeavyDayMm: 30,
  rainyHours: 6,
  rainyHourMm: 0.2,
  uvWarning: 7,
  windChillApparentC: -10,
  windChillDangerC: -20,
} as const;

export interface RiskOptions {
  activity: ActivityType;
  /** Route contains exposed ridge/summit sections (stricter wind thresholds, storm advice). */
  exposedRidge?: boolean;
  /** Highest point of the route (m a.s.l.). */
  maxEleM?: number;
  nightCamp?: { eleM: number; sleepType: SleepType };
  arrivalAfterSunset?: boolean;
  /** Current time (for confidence); default Date.now(). */
  now?: number | Date;
}

interface Obs {
  where: string;
  time: string | null;
  hour: HourlyWeather;
  /** Temperature at the point of interest (lapse-corrected). */
  tempC: number | null;
  apparentC: number | null;
  /** Temperatures at the highest point (forecast input with maxEleM). */
  coldTempC: number | null;
  coldApparentC: number | null;
  isNight: boolean;
  campTempC: number | null;
  etaMs: number | null;
  updatedAt: string | undefined;
}
interface DayObs {
  where: string;
  date: string;
  sumMm: number;
  rainyHours: number | null;
}

const lapse = (dEle: number) => -(LAPSE_RATE_C_PER_100M / 100) * dEle;
const r1 = (n: number) => Math.round(n * 10) / 10;
const add = (v: number | null, o: number): number | null => (v === null ? null : r1(v + o));

function fmtTime(t: string | null): string {
  if (!t) return '';
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(t);
  return m ? `${Number(m[2])}. ${Number(m[1])}. ${m[3]}:${m[4]}` : t;
}

const isForecast = (x: WeatherSample[] | WeatherForecast): x is WeatherForecast => !Array.isArray(x);

function uncertaintyFor(levels: ConfidenceLevel[], convective = false): string {
  const order: ConfidenceLevel[] = ['high', 'medium', 'low', 'none'];
  const worst = levels.reduce<ConfidenceLevel>((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a), 'high');
  const base =
    worst === 'high'
      ? 'Krátkodobá předpověď (0–2 dny), nejistota je menší.'
      : worst === 'medium'
        ? 'Střednědobá předpověď (3–6 dní): načasování a intenzita se mohou posunout.'
        : 'Dlouhodobá předpověď (7+ dní): nízká spolehlivost, sleduj aktualizace.';
  return convective ? `${base} Bouřky a přeháňky jsou lokální a model je předpovídá hůře než teplotu.` : base;
}

/**
 * Analyse weather samples along a route (from {@link weatherAlongRoute}) or a
 * single forecast and return risk advisories (Czech). Samples beyond the
 * forecast horizon are ignored (never presented as forecast).
 */
export function analyzeWeatherRisks(input: WeatherSample[] | WeatherForecast, opts: RiskOptions): Advisory[] {
  const nowMs = opts.now === undefined ? Date.now() : typeof opts.now === 'number' ? opts.now : opts.now.getTime();
  const obs: Obs[] = [];
  const dayObs: DayObs[] = [];
  const dailies: Array<{ where: string; d: DailyWeather }> = [];
  let updatedAt: string | undefined;
  const levelOf = (o: Obs): ConfidenceLevel => {
    const when = o.etaMs ?? (o.time ? Date.parse(`${o.time.slice(0, 10)}T12:00:00Z`) : nowMs);
    return forecastConfidence(new Date(when), nowMs).level;
  };

  if (isForecast(input)) {
    updatedAt = input.fetchedAt;
    const grid = input.eleM ?? null;
    const coldOffset = opts.maxEleM !== undefined && grid !== null ? lapse(opts.maxEleM - grid) : 0;
    const campOffset = opts.nightCamp && grid !== null ? lapse(opts.nightCamp.eleM - grid) : 0;
    for (const h of input.hourly) {
      const ms = localToMs(h.time, input.timezone);
      const hr = localHourOf(ms, input.timezone);
      const night = h.isDay === false || hr >= 21 || hr < 6;
      obs.push({
        where: 'Předpověď',
        time: h.time,
        hour: h,
        tempC: h.temperatureC,
        apparentC: h.apparentTemperatureC,
        coldTempC: add(h.temperatureC, coldOffset),
        coldApparentC: add(h.apparentTemperatureC, coldOffset),
        isNight: night,
        campTempC: opts.nightCamp ? add(h.temperatureC, campOffset) : null,
        etaMs: null,
        updatedAt,
      });
    }
    const byDate = new Map<string, HourlyWeather[]>();
    for (const h of input.hourly) byDate.set(h.time.slice(0, 10), [...(byDate.get(h.time.slice(0, 10)) ?? []), h]);
    for (const [date, hs] of byDate) {
      const sum = hs.reduce((s, h) => s + (h.precipitationMm ?? 0), 0);
      const daily = input.daily.find((d) => d.date === date);
      dayObs.push({ where: 'Předpověď', date, sumMm: Math.max(r1(sum), daily?.precipitationSumMm ?? 0), rainyHours: hs.filter((h) => (h.precipitationMm ?? 0) >= THRESHOLDS.rainyHourMm).length });
    }
    for (const d of input.daily) dailies.push({ where: 'Předpověď', d });
  } else {
    const fetched = input.map((s) => s.fetchedAt).filter((x): x is string => !!x).sort();
    updatedAt = fetched[0];
    for (const s of input) {
      if (s.beyondHorizon || !s.hourly) continue;
      const night = s.hourly.isDay === false;
      obs.push({
        where: s.label,
        time: s.hourly.time,
        hour: s.hourly,
        tempC: s.temperatureC,
        apparentC: s.apparentTemperatureC,
        coldTempC: s.temperatureC,
        coldApparentC: s.apparentTemperatureC,
        isNight: night,
        campTempC: s.kind === 'campsite' || (opts.nightCamp && night) ? s.temperatureC : null,
        etaMs: s.etaMs,
        updatedAt: s.fetchedAt ?? undefined,
      });
      if (s.daily) {
        dailies.push({ where: s.label, d: s.daily });
        dayObs.push({ where: s.label, date: s.daily.date, sumMm: s.daily.precipitationSumMm ?? 0, rainyHours: null });
      }
    }
  }
  const out: Advisory[] = [];
  const upd = updatedAt ?? new Date(nowMs).toISOString();
  const mk = (code: string, severity: Severity, message: string, params: Advisory['params'], basis: string[], action: string, levels: ConfidenceLevel[], convective = false) =>
    out.push({ code, severity, message, params, basis, action, uncertainty: uncertaintyFor(levels.length ? levels : ['high'], convective), source: WEATHER_SOURCE, updatedAt: upd });
  if (obs.length === 0 && dailies.length === 0) return out;

  const ridgeLike = !!opts.exposedRidge || opts.activity === 'ridge_traverse';

  // ---- thunderstorm
  const storms = obs.filter((o) => {
    const c = o.hour.weatherCode ?? -1;
    return (c >= 95 && c <= 99) || ((o.hour.capeJkg ?? 0) > THRESHOLDS.capeStormJkg && (o.hour.precipitationProbabilityPct ?? 0) >= THRESHOLDS.stormProbabilityPct);
  });
  if (storms.length) {
    const first = storms[0]!;
    const hail = storms.some((o) => o.hour.weatherCode === 96 || o.hour.weatherCode === 99);
    const maxCape = Math.max(...storms.map((o) => o.hour.capeJkg ?? 0));
    mk(
      'weather.thunderstorm',
      hail || ridgeLike ? 'danger' : 'warning',
      `Hrozí bouřky (první ${fmtTime(first.time)}${first.where !== 'Předpověď' ? `, ${first.where}` : ''}${hail ? ', možné krupobití' : ''}).`,
      { hours: storms.length, firstTime: first.time, maxCapeJkg: Math.round(maxCape), hail },
      [`WMO kód bouřky 95–99 nebo CAPE > ${THRESHOLDS.capeStormJkg} J/kg se šancí srážek ≥ ${THRESHOLDS.stormProbabilityPct} %`, `${storms.length} hodin s rizikem bouřky, max. CAPE ${Math.round(maxCape)} J/kg`],
      'Hřebeny a vrcholy opusť nejpozději do poledne – bouřky se nejčastěji rozvíjejí odpoledne. Vyhni se osamělým stromům, hřebenům a kovovým předmětům; při bouřce neskrývej stan na vrcholu ani v prohlubni s tekoucí vodou.',
      storms.map(levelOf),
      true,
    );
  }

  // ---- wind
  const gustLimits = ridgeLike ? { w: THRESHOLDS.gustRidgeWarningKmh, d: THRESHOLDS.gustRidgeDangerKmh } : { w: THRESHOLDS.gustWarningKmh, d: THRESHOLDS.gustDangerKmh };
  const gustObs = obs.filter((o) => o.hour.windGustsKmh !== null);
  const worstGust = gustObs.reduce<Obs | undefined>((a, o) => (!a || o.hour.windGustsKmh! > a.hour.windGustsKmh! ? o : a), undefined);
  const dailyGust = Math.max(0, ...dailies.map((x) => x.d.windGustsMaxKmh ?? 0));
  const maxGust = Math.max(worstGust?.hour.windGustsKmh ?? 0, dailyGust);
  if (maxGust >= gustLimits.w) {
    const danger = maxGust >= gustLimits.d;
    mk(
      'weather.wind',
      danger ? 'danger' : 'warning',
      `${danger ? 'Nebezpečný vítr' : 'Silný vítr'}: nárazy až ${Math.round(maxGust)} km/h${worstGust ? ` (${fmtTime(worstGust.time)})` : ''}${ridgeLike ? ' – na exponovaném hřebeni platí přísnější limit' : ''}.`,
      { maxGustKmh: Math.round(maxGust), thresholdKmh: danger ? gustLimits.d : gustLimits.w, ridge: ridgeLike },
      [`Nárazy větru ve 10 m: ${Math.round(maxGust)} km/h`, `Limit ${danger ? 'nebezpečí' : 'varování'}: ${danger ? gustLimits.d : gustLimits.w} km/h${ridgeLike ? ' (hřeben)' : ''}`],
      danger ? 'Odlož nebo zkrať trasu, vyhni se hřebenům a otevřeným planinám; stan stavěj v závětří a řádně ho zajisti.' : 'Počítej s menším tempem, na hřebenech buď opatrný; pevně zajisti stan/tarp a lehké vybavení.',
      gustObs.length ? [levelOf(worstGust ?? gustObs[0]!)] : [],
    );
  }

  // ---- frost (temperature at the coldest relevant point)
  const cold = obs.filter((o) => o.coldTempC !== null);
  const minObs = cold.reduce<Obs | undefined>((a, o) => (!a || o.coldTempC! < a.coldTempC! ? o : a), undefined);
  const dailyMin = dailies.reduce<number | null>((a, x) => (x.d.tempMinC === null ? a : a === null ? x.d.tempMinC : Math.min(a, x.d.tempMinC)), null);
  const minT = minObs?.coldTempC ?? (opts.nightCamp ? null : dailyMin);
  if (minT !== null && minT <= THRESHOLDS.frostWarningC) {
    const danger = minT <= THRESHOLDS.frostDangerC;
    mk(
      'weather.frost',
      danger ? 'danger' : 'warning',
      `${danger ? 'Silný mráz' : 'Mráz'}: teplota klesne až na ${minT} °C${minObs ? ` (${fmtTime(minObs.time)})` : ''}.`,
      { minTempC: minT },
      [`Min. teplota ${minT} °C`, opts.maxEleM !== undefined ? `přepočteno na nejvyšší bod ${Math.round(opts.maxEleM)} m (−${LAPSE_RATE_C_PER_100M} °C/100 m)` : 'teplota podle modelu / přepočtená na výšku bodů trasy'],
      danger ? 'Vezmi zimní spacák/oblečení a izolaci od země, hlídej omrzliny a zamrzlou vodu; zvaž zkrácení trasy.' : 'Počítej s námrazou na stezkách a zamrzlou vodou; přibal čepici, rukavice a teplou vrstvu na večer.',
      minObs ? [levelOf(minObs)] : [],
    );
  }

  // ---- night at campsite
  if (opts.nightCamp) {
    const nightTemps = obs.filter((o) => o.isNight && o.campTempC !== null).map((o) => o.campTempC!);
    const dailyCamp =
      isForecast(input) && input.eleM !== null && input.eleM !== undefined && dailyMin !== null ? r1(dailyMin + lapse(opts.nightCamp.eleM - input.eleM)) : null;
    const campMin = nightTemps.length ? Math.min(...nightTemps) : dailyCamp;
    if (campMin !== null && campMin <= 3) {
      mk(
        'weather.camp_cold_night',
        campMin <= THRESHOLDS.frostDangerC ? 'danger' : campMin <= 0 ? 'warning' : 'info',
        `Noc v táboře (${Math.round(opts.nightCamp.eleM)} m): očekávej kolem ${campMin} °C.`,
        { campMinC: campMin, campEleM: Math.round(opts.nightCamp.eleM), sleepType: opts.nightCamp.sleepType },
        [`Noční minimum ${campMin} °C po přepočtu na výšku tábora`, `Spaní: ${opts.nightCamp.sleepType}`],
        'Zkontroluj komfortní teplotu spacáku a R-hodnotu karimatky; na noc si vezmi suché oblečení.',
        obs.filter((o) => o.isNight).map(levelOf),
      );
    }
  }

  // ---- heat
  const hot = obs.filter((o) => o.tempC !== null);
  const maxObs = hot.reduce<Obs | undefined>((a, o) => (!a || o.tempC! > a.tempC! ? o : a), undefined);
  const maxT = Math.max(maxObs?.tempC ?? -99, ...dailies.map((x) => x.d.tempMaxC ?? -99));
  if (maxT >= THRESHOLDS.heatWarningC) {
    mk(
      'weather.heat',
      maxT >= THRESHOLDS.heatDangerC ? 'danger' : 'warning',
      `Horko: teploty až ${r1(maxT)} °C.`,
      { maxTempC: r1(maxT) },
      [`Max. teplota ${r1(maxT)} °C (limit ${THRESHOLDS.heatWarningC} °C)`],
      'Plánuj přesuny na ráno a večer, v poledne odpočívej ve stínu; vezmi víc vody (min. 0,5 l/h) a elektrolyty, chraň se před sluncem.',
      maxObs ? [levelOf(maxObs)] : [],
    );
  }

  // ---- rain
  const rainy = dayObs.filter((d) => d.sumMm >= THRESHOLDS.rainDayMm || (d.rainyHours ?? 0) >= THRESHOLDS.rainyHours);
  if (rainy.length) {
    const worst = rainy.reduce((a, b) => (b.sumMm > a.sumMm ? b : a));
    mk(
      'weather.rain',
      worst.sumMm >= THRESHOLDS.rainHeavyDayMm ? 'danger' : 'warning',
      `Vydatný nebo dlouhotrvající déšť: ${r1(worst.sumMm)} mm${worst.rainyHours !== null ? `, ${worst.rainyHours} deštivých hodin` : ''} (${worst.date.slice(8, 10)}. ${worst.date.slice(5, 7).replace(/^0/, '')}.).`,
      { rainMm: worst.sumMm, rainyHours: worst.rainyHours, date: worst.date, rainyDays: rainy.length },
      [`Denní úhrn ≥ ${THRESHOLDS.rainDayMm} mm nebo ≥ ${THRESHOLDS.rainyHours} deštivých hodin`, `${rainy.length} takových dní`],
      'Přibal nepromokavou bundu a ochranu batohu (pláštěnka na batoh, pytle na výbavu); počítej s kluzkým terénem a zvýšenými hladinami potoků.',
      [forecastConfidence(`${worst.date}`, nowMs).level],
      true,
    );
  }

  // ---- snow
  const snowHours = obs.filter((o) => (o.hour.snowfallCm ?? 0) > 0 || [71, 73, 75, 77, 85, 86].includes(o.hour.weatherCode ?? -1));
  const snowSum = r1(snowHours.reduce((s, o) => s + (o.hour.snowfallCm ?? 0), 0));
  const maxDepth = Math.max(0, ...obs.map((o) => o.hour.snowDepthM ?? 0));
  if (snowHours.length || maxDepth >= 0.1) {
    const sev: Severity = snowSum >= 15 ? 'danger' : snowSum >= 3 || maxDepth >= 0.3 ? 'warning' : 'info';
    const first = snowHours[0];
    mk(
      'weather.snow',
      sev,
      snowHours.length ? `Sněžení${first?.time ? ` od ${fmtTime(first.time)}` : ''}: celkem ${snowSum} cm nového sněhu${maxDepth > 0 ? `, sněhová pokrývka až ${Math.round(maxDepth * 100)} cm` : ''}.` : `Ležící sníh: až ${Math.round(maxDepth * 100)} cm.`,
      { snowfallCm: snowSum, snowDepthM: r1(maxDepth), hours: snowHours.length },
      [`Úhrn sněžení ${snowSum} cm`, `Max. výška sněhu ${Math.round(maxDepth * 100)} cm`],
      'Zpomal tempo, vezmi zimní obuv/návleky a ověř sjízdnost/schůdnost trasy; na kole zvaž alternativu.',
      snowHours.length ? snowHours.map(levelOf) : obs.map(levelOf),
    );
  }

  // ---- freezing level below max elevation
  if (opts.maxEleM !== undefined) {
    const fl = obs.filter((o) => o.hour.freezingLevelM !== null && o.hour.freezingLevelM !== undefined && o.hour.freezingLevelM < opts.maxEleM!);
    if (fl.length) {
      const lowest = fl.reduce((a, o) => (o.hour.freezingLevelM! < a.hour.freezingLevelM! ? o : a));
      const wet = fl.some((o) => (o.hour.precipitationMm ?? 0) >= THRESHOLDS.rainyHourMm);
      mk(
        'weather.freezing_level',
        wet ? 'warning' : 'info',
        `Hladina nuly klesne až na ${Math.round(lowest.hour.freezingLevelM!)} m, pod nejvyšší bod trasy (${Math.round(opts.maxEleM)} m)${wet ? ' – hrozí náledí a sníh' : ''}.`,
        { freezingLevelM: Math.round(lowest.hour.freezingLevelM!), maxEleM: Math.round(opts.maxEleM), hours: fl.length, withPrecipitation: wet },
        [`Hladina nuly (model) min. ${Math.round(lowest.hour.freezingLevelM!)} m`, `Nejvyšší bod ${Math.round(opts.maxEleM)} m`],
        'Ve výšce nad hladinou nuly počítej s námrazou a ledem na kamenech a kořenech; vezmi mačky/hrotky podle terénu.',
        fl.map(levelOf),
      );
    }
  }

  // ---- UV
  const uv = Math.max(0, ...obs.map((o) => o.hour.uvIndex ?? 0), ...dailies.map((x) => x.d.uvIndexMax ?? 0));
  if (uv >= THRESHOLDS.uvWarning) {
    mk('weather.uv', uv >= 11 ? 'danger' : 'warning', `Vysoké UV záření (index ${r1(uv)}).`, { uvIndex: r1(uv) }, [`UV index ${r1(uv)} (limit ${THRESHOLDS.uvWarning})`], 'Použij krém SPF 30+ (ve výšce 50), brýle, pokrývku hlavy a vyhni se slunci kolem poledne.', obs.map(levelOf));
  }

  // ---- fog
  const fog = obs.filter((o) => o.hour.weatherCode === 45 || o.hour.weatherCode === 48);
  if (fog.length) {
    mk(
      'weather.fog',
      ridgeLike ? 'warning' : 'info',
      `Mlha${fog.some((o) => o.hour.weatherCode === 48) ? ' (i namrzající)' : ''}: snížená viditelnost (první ${fmtTime(fog[0]!.time)}).`,
      { hours: fog.length, rime: fog.some((o) => o.hour.weatherCode === 48) },
      [`WMO kód 45/48 v ${fog.length} hodinách`],
      'Stáhni offline mapu a trasu do GPS, na rozcestích kontroluj polohu; na hřebenech nepodceňuj orientaci.',
      fog.map(levelOf),
    );
  }

  // ---- wind chill
  const chill = obs.filter((o) => o.coldApparentC !== null);
  const worstChill = chill.reduce<Obs | undefined>((a, o) => (!a || o.coldApparentC! < a.coldApparentC! ? o : a), undefined);
  if (worstChill && worstChill.coldApparentC! < THRESHOLDS.windChillApparentC) {
    mk(
      'weather.wind_chill',
      worstChill.coldApparentC! < THRESHOLDS.windChillDangerC ? 'danger' : 'warning',
      `Pocitová teplota klesne až na ${worstChill.coldApparentC} °C (vítr + mráz).`,
      { apparentTempC: worstChill.coldApparentC },
      [`Pocitová teplota ${worstChill.coldApparentC} °C (limit ${THRESHOLDS.windChillApparentC} °C)`],
      'Zakryj odkrytou kůži, vezmi větruodolnou vrstvu, čepici a rukavice; pravidelně jez a pij teplé.',
      [levelOf(worstChill)],
    );
  }

  // ---- arrival after sunset
  if (opts.arrivalAfterSunset) {
    const sunset = dailies.find((x) => x.d.sunset)?.d.sunset ?? null;
    mk(
      'weather.arrival_after_dark',
      'info',
      `Do cíle dorazíš po západu slunce${sunset ? ` (${fmtTime(sunset)})` : ''}.`,
      { sunset },
      [sunset ? `Západ slunce ${fmtTime(sunset)}` : 'Odhad příchodu je po setmění'],
      'Vezmi čelovku s čerstvými bateriemi a rezervní zdroj světla; zvaž dřívější start nebo kratší etapu.',
      [],
    );
  }
  return out;
}
