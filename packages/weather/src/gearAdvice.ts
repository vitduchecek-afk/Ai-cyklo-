/**
 * Gear recommendations derived from the expected weather. Pure and
 * deterministic: it only reasons about the user's own gear list (names, tags,
 * categories and numeric specs) and the weather numbers passed in.
 */
import type { Advisory, GearItem, Severity, SleepType } from '@trailpack/shared';
import { WEATHER_SOURCE } from './risks';

export type GearAdvisory = Advisory & {
  /** Ids of the gear items the advice refers to. */
  itemIds?: string[];
  /** Short actionable suggestion (Czech). */
  suggestion: string;
};

export interface GearWeatherInput {
  items: GearItem[];
  /** Expected lowest night temperature at the camp (°C, already elevation-corrected). */
  nightMinC?: number;
  /** Expected highest daytime temperature (°C). */
  dayMaxC?: number;
  /** Lowest apparent ("feels like") temperature (°C); falls back to nightMinC. */
  apparentMinC?: number;
  /** Number of rainy hours (precipitation >= 0.2 mm/h) during moving time. */
  rainHours?: number;
  /** Total rain (mm). */
  rainMm?: number;
  /** Max wind gust (km/h). */
  maxGustKmh?: number;
  /** Hours spent on exposed terrain (ridges, above treeline). */
  exposureHours?: number;
  maxEleM?: number;
  sleepType: SleepType;
  /** Max UV index. */
  uvMax?: number;
  /** Length of the dark period (h, sunset to sunrise); used for headlamp advice. */
  nightHours?: number;
  /** Timestamp of the underlying forecast (ISO). */
  updatedAt?: string;
}

/** Sleep types where the user sleeps without a hut roof/heating (sleeping system matters). */
const OUTDOOR_SLEEP: ReadonlySet<SleepType> = new Set<SleepType>(['open_air', 'tarp', 'tent', 'hammock', 'bivy_bag', 'shelter', 'emergency_hut', 'official_bivouac_site', 'campground']);

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const text = (i: GearItem) => norm([i.name, i.brand, i.model, i.categoryKey, i.description, ...(i.tags ?? [])].filter(Boolean).join(' '));

const RE = {
  bagCover: /(plastenk\w*\s+(na|batoh)|pack\s*-?cover|rain\s*-?cover|raincover|obal\s+na\s+batoh|pokryvk\w*\s+na\s+batoh)/,
  dryBag: /(dry\s*-?bag|nepromok\w*\s+(pytel|vak)|vodotesn\w*\s+(pytel|vak)|pack\s*liner)/,
  poncho: /(plastenk|poncho|disposable|jednorazov)/,
  disposable: /(jednorazov|disposable|igelit)/,
  jacket: /(nepromok|waterproof|gore\s*-?tex|goretex|hardshell|rain\s*jacket|membran)/,
  windLayer: /(vetrovk|windshell|wind\s*jacket|windbreaker|softshell|hardshell|vetruodoln)/,
  insulation: /(perov|primaloft|izolac|insulat|\bdown\b|puffy|fleece|flis|mikina|svetr)/,
  gloves: /(rukavic|glove|palcak|mitt)/,
  hat: /(cepic|beanie|\bhat\b|celenk|kulich|buff)/,
  sunscreen: /(\bspf\b|opalovac|sunscreen|krem na opalovani)/,
  sunglasses: /(bryle|sunglasses|glacier)/,
  sunHat: /(kstilt|klobouk|sun\s*hat|\bcap\b|satek)/,
  headlamp: /(celovk|headlamp|head\s*lamp)/,
  underquilt: /(underquilt|podlozka\s+do\s+hamaky|hammock\s+insulation)/,
};

export interface GearEvaluationNote {
  comfortStatus?: 'ok' | 'tight' | 'below_comfort' | 'below_limit';
}

/**
 * Recommend gear changes for the expected weather.
 *
 * Sleeping bag rule: comfort rating should be at least 3 °C below the expected
 * night minimum (safety margin). Comfort = temperature at which a relaxed
 * "standard woman" sleeps comfortably; limit = lowest temperature for a "standard
 * man" in a curled position (EN 13537 / ISO 23537) – below comfort but above
 * limit means cold, restless sleep, below limit means risk of hypothermia.
 * Pad R-value targets: R >= 2 above 5 °C, >= 3 between -5 and 5 °C, >= 4.5 below -5 °C.
 */
export function recommendGearForWeather(input: GearWeatherInput): GearAdvisory[] {
  const out: GearAdvisory[] = [];
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const push = (code: string, severity: Severity, message: string, suggestion: string, basis: string[], params: Advisory['params'], itemIds?: string[], uncertainty?: string) =>
    out.push({
      code,
      severity,
      message,
      suggestion,
      action: suggestion,
      params,
      basis,
      itemIds: itemIds && itemIds.length ? itemIds : undefined,
      uncertainty: uncertainty ?? 'Doporučení vychází z předpovědi a může se změnit; nejistota roste se vzdáleností termínu. Teplotu na tvém místě ovlivní terén (inverze, závětří, vlhkost).',
      source: WEATHER_SOURCE,
      updatedAt,
    });
  const items = input.items.filter((i) => i.condition !== 'retired');
  const withText = items.map((i) => ({ i, t: text(i) }));
  const find = (re: RegExp) => withText.filter((x) => re.test(x.t)).map((x) => x.i);
  const outdoor = OUTDOOR_SLEEP.has(input.sleepType);
  const night = input.nightMinC;

  // ---------------- sleeping bag / quilt
  if (night !== undefined && outdoor) {
    const bags = items.filter((i) => i.categoryKey === 'sleeping_bags' || i.categoryKey === 'quilts' || /(spacak|sleeping\s*bag|quilt)/.test(text(i)));
    const rated = bags.filter((b) => b.comfortTempC !== undefined || b.limitTempC !== undefined);
    if (bags.length === 0) {
      push('gear.sleep_system_missing', night <= 5 ? 'warning' : 'info', `V seznamu nemáš spacák ani quilt, ale noc má být kolem ${night} °C.`, 'Přidej spacák/quilt s komfortní teplotou alespoň o 3 °C nižší, než je noční minimum.', [`Noční minimum ${night} °C`, `Spaní: ${input.sleepType}`], { nightMinC: night });
    } else if (rated.length) {
      // warmest bag = lowest comfort (fallback limit)
      const key = (b: GearItem) => b.comfortTempC ?? (b.limitTempC !== undefined ? b.limitTempC + 5 : 99);
      const best = rated.reduce((a, b) => (key(b) < key(a) ? b : a));
      const comfort = best.comfortTempC;
      const limit = best.limitTempC;
      const estimated = comfort === undefined;
      const c = comfort ?? key(best);
      const base = [`Noční minimum ${night} °C (rezerva 3 °C → cíl komfort ≤ ${night - 3} °C)`, comfort !== undefined ? `${best.name}: komfort ${comfort} °C` : `${best.name}: komfortní teplota není zadána`, limit !== undefined ? `limit ${limit} °C` : 'limitní teplota není zadána'];
      const ids = [best.id];
      if (limit !== undefined && limit > night) {
        push('gear.sleeping_bag_too_cold', 'danger', `Spacák „${best.name}“ má limitní teplotu ${limit} °C, ale noc má být kolem ${night} °C – hrozí podchlazení.`, 'Vezmi teplejší spacák/quilt, vložku, péřovou bundu na spaní a lepší izolaci od země, nebo přesuň spaní do chaty/nižší polohy.', base, { nightMinC: night, comfortC: comfort ?? null, limitC: limit }, ids);
      } else if (c > night) {
        push('gear.sleeping_bag_below_comfort', 'warning', `Noc kolem ${night} °C je pod komfortní teplotou spacáku „${best.name}“${comfort !== undefined ? ` (${comfort} °C)` : ''}${limit !== undefined ? `; limit ${limit} °C ještě stačí na přežití, ale spaní bude studené` : ''}.`, 'Spi v péřové bundě a čepici, přidej vložku do spacáku nebo teplejší spacák; zvaž nižší polohu tábora.', base, { nightMinC: night, comfortC: comfort ?? null, limitC: limit ?? null, estimated }, ids);
      } else if (c > night - 3) {
        push('gear.sleeping_bag_tight', 'info', `Spacák „${best.name}“ vyhovuje jen těsně (komfort ${c} °C, noc ${night} °C) – bez rezervy 3 °C.`, 'Počítej s oblečením na spaní a dobrou izolací od země; předpověď může být o pár stupňů chladnější.', base, { nightMinC: night, comfortC: c, marginC: r1(night - c) }, ids);
      }
    }
    if (input.sleepType === 'hammock' && night < 15 && find(RE.underquilt).length === 0) {
      push('gear.hammock_underinsulation', night < 5 ? 'warning' : 'info', `V hamace chladí zespodu i při ${night} °C a spacák pod tebou se stlačí.`, 'Přidej underquilt nebo karimatku do hamaky.', [`Noční minimum ${night} °C`, 'V seznamu není underquilt'], { nightMinC: night });
    }

    // ---------------- sleeping pad
    const pads = items.filter((i) => i.categoryKey === 'sleeping_pads' || /(karimatk|sleeping\s*pad|nafukovac\w*\s+podlozk)/.test(text(i)));
    const need = night > 5 ? 2 : night >= -5 ? 3 : 4.5;
    if (pads.length === 0) {
      if (input.sleepType !== 'hammock') push('gear.pad_missing', night <= 10 ? 'warning' : 'info', `V seznamu není karimatka; k zemi je při ${night} °C potřeba izolace (R ≥ ${need}).`, `Přidej karimatku s R-hodnotou alespoň ${need}.`, [`Odhad teploty země ≈ noční minimum ${night} °C`, `Cílová R-hodnota ≥ ${need}`], { nightMinC: night, requiredR: need });
    } else {
      const withR = pads.filter((p) => p.rValue !== undefined);
      if (withR.length) {
        const total = r1(withR.reduce((s, p) => s + (p.rValue ?? 0), 0));
        if (total < need) {
          push('gear.pad_rvalue_low', total < need - 1 ? 'warning' : 'info', `Karimatka má R ${total}, ale při ${night} °C se doporučuje R ≥ ${need}. Země bude odvádět teplo víc než vzduch.`, `Přidej druhou (pěnovou) podložku pod nafukovací, nebo vezmi karimatku s R ≥ ${need}. R-hodnoty se sčítají.`, [`Odhad teploty země ≈ ${night} °C`, `Součet R-hodnot ${total} (ASTM F3340)`], { nightMinC: night, rValue: total, requiredR: need }, withR.map((p) => p.id));
        }
      }
    }
  }

  // ---------------- rain protection
  const rainHours = input.rainHours ?? 0;
  const rainMm = input.rainMm ?? 0;
  const gust = input.maxGustKmh ?? 0;
  const longRain = rainHours >= 3 || rainMm >= 5;
  if (longRain) {
    const jackets = withText.filter((x) => (x.i.categoryKey === 'clothing' || /bunda|jacket|shell/.test(x.t)) && (x.i.waterproof === true || RE.jacket.test(x.t)) && !RE.poncho.test(x.t) && !RE.bagCover.test(x.t)).map((x) => x.i);
    const ponchos = withText.filter((x) => RE.poncho.test(x.t) && !RE.bagCover.test(x.t) && !RE.jacket.test(x.t)).map((x) => x.i);
    const packProtection = [...find(RE.bagCover), ...find(RE.dryBag)];
    const strong = rainHours >= 6 || rainMm >= 10 || gust >= 40 || (input.exposureHours ?? 0) >= 3;
    const basis = [`Déšť: ${rainHours} h, ${r1(rainMm)} mm`, `Nárazy větru až ${Math.round(gust)} km/h`, input.exposureHours !== undefined ? `Čas v exponovaném terénu ${input.exposureHours} h` : 'Čas v exponovaném terénu neznámý'];
    if (jackets.length === 0 && ponchos.length > 0) {
      const dis = ponchos.some((p) => RE.disposable.test(text(p)));
      const lead = gust >= 30 ? 'Na trase hrozí dlouhodobý déšť a silnější vítr.' : 'Na trase hrozí dlouhodobý déšť.';
      push(
        'gear.rain_poncho_insufficient',
        strong ? 'warning' : 'info',
        `${lead} Tvoje lehká ${dis ? 'jednorázová ' : ''}pláštěnka nemusí poskytovat dostatečnou ochranu. Doporučuji nepromokavou bundu a ochranu batohu.`,
        'Přibal nepromokavou bundu (hardshell) a pláštěnku nebo vodotěsný vak na batoh.',
        basis,
        { rainHours, rainMm: r1(rainMm), maxGustKmh: Math.round(gust), disposable: dis },
        ponchos.map((p) => p.id),
      );
    } else if (jackets.length === 0) {
      push('gear.rain_protection_missing', strong ? 'warning' : 'info', 'Na trase hrozí dlouhodobý déšť a v seznamu nemáš nepromokavou bundu ani pláštěnku.', 'Přibal nepromokavou bundu a ochranu batohu (pláštěnka na batoh nebo pytle na výbavu).', basis, { rainHours, rainMm: r1(rainMm) });
    } else if (packProtection.length === 0) {
      push('gear.pack_rain_protection', 'info', 'Máš nepromokavou bundu, ale nic na ochranu batohu před deštěm – spacák a oblečení musí zůstat suché.', 'Přidej pláštěnku na batoh nebo vodotěsný vak (dry bag) na spacák a oblečení.', basis, { rainHours, rainMm: r1(rainMm) }, jackets.map((j) => j.id));
    }
  }

  // ---------------- wind layer
  if (gust >= 40) {
    const wind = find(RE.windLayer);
    const shell = withText.filter((x) => x.i.waterproof === true || RE.jacket.test(x.t)).map((x) => x.i);
    if (wind.length === 0 && shell.length === 0) {
      push('gear.wind_layer_missing', gust >= 60 ? 'warning' : 'info', `Nárazy větru až ${Math.round(gust)} km/h a v seznamu není větrovka ani bunda s membránou.`, 'Přibal lehkou větrovku nebo softshell – vítr výrazně zvyšuje pocitový chlad.', [`Nárazy větru až ${Math.round(gust)} km/h`], { maxGustKmh: Math.round(gust) });
    }
  }

  // ---------------- insulation
  const lowDay = input.dayMaxC !== undefined && input.dayMaxC <= 10;
  const lowNight = night !== undefined && night <= 5;
  if (lowDay || lowNight) {
    const ins = find(RE.insulation);
    if (ins.length === 0) {
      const cold = (night ?? 99) <= 0 || (input.dayMaxC ?? 99) <= 3;
      push('gear.insulation_missing', cold ? 'warning' : 'info', `Čekají tě nízké teploty (${input.dayMaxC !== undefined ? `přes den max. ${input.dayMaxC} °C` : ''}${input.dayMaxC !== undefined && night !== undefined ? ', ' : ''}${night !== undefined ? `v noci ${night} °C` : ''}) a v seznamu nemáš izolační vrstvu.`, 'Přibal péřovou/syntetickou bundu nebo fleece na zastávky a večer.', ['Teploty z předpovědi', 'V seznamu chybí péřová bunda / fleece'], { dayMaxC: input.dayMaxC ?? null, nightMinC: night ?? null });
    }
  }

  // ---------------- gloves / hat
  const feels = input.apparentMinC ?? night;
  if (feels !== undefined && feels < 5) {
    const missing: string[] = [];
    if (find(RE.gloves).length === 0) missing.push('rukavice');
    if (find(RE.hat).length === 0) missing.push('čepici');
    if (missing.length) {
      push('gear.gloves_hat_missing', feels < -5 ? 'warning' : 'info', `Pocitová teplota klesne na ${feels} °C a v seznamu chybí: ${missing.join(', ')}.`, `Přibal ${missing.join(' a ')} – ztráta tepla hlavou a rukama je při chladu rychlá.`, [`Pocitová teplota ${feels} °C (limit 5 °C)`], { apparentMinC: feels });
    }
  }

  // ---------------- sun
  if ((input.uvMax ?? 0) >= 6) {
    const miss: string[] = [];
    if (find(RE.sunscreen).length === 0) miss.push('opalovací krém');
    if (find(RE.sunglasses).length === 0) miss.push('sluneční brýle');
    if (find(RE.sunHat).length === 0 && find(RE.hat).length === 0) miss.push('pokrývku hlavy');
    if (miss.length) {
      const high = (input.uvMax ?? 0) >= 8 || (input.maxEleM ?? 0) >= 2000;
      push('gear.sun_protection', high ? 'warning' : 'info', `UV index dosáhne ${input.uvMax}${(input.maxEleM ?? 0) >= 1500 ? ` a ve výšce ${Math.round(input.maxEleM ?? 0)} m je záření ještě silnější` : ''}; chybí: ${miss.join(', ')}.`, `Přibal ${miss.join(', ')}.`, [`UV index ${input.uvMax} (limit 6)`], { uvMax: input.uvMax ?? null });
    }
  }

  // ---------------- headlamp
  if ((input.nightHours ?? 0) >= 12 && outdoor) {
    const lamps = find(RE.headlamp);
    if (lamps.length === 0) {
      push('gear.headlamp_missing', 'warning', `Tma potrvá asi ${Math.round(input.nightHours ?? 0)} h a v seznamu není čelovka.`, 'Přibal čelovku a rezervní baterie.', [`Délka noci ≈ ${Math.round(input.nightHours ?? 0)} h`], { nightHours: input.nightHours ?? null });
    } else {
      const cold = night !== undefined && night <= 0;
      push('gear.headlamp_batteries', 'info', `Dlouhá noc (≈ ${Math.round(input.nightHours ?? 0)} h)${cold ? ' a mráz, který rychle vybíjí baterie' : ''}: zkontroluj kapacitu čelovky.`, 'Vezmi rezervní baterie nebo powerbanku; v mrazu je nos u těla (kapsa u těla) a vypínej zbytečné světlo.', [`Délka noci ≈ ${Math.round(input.nightHours ?? 0)} h`, cold ? `Mráz ${night} °C snižuje kapacitu baterií` : 'Plánovaná spotřeba: 3–5 h denně'], { nightHours: input.nightHours ?? null }, lamps.map((l) => l.id));
    }
  }
  return out;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
