/**
 * Rule-based (offline, deterministic) parser of free-text trip requests in
 * Czech, Slovak and English. It extracts planning constraints and reports
 * what is still missing as Czech follow-up questions.
 */
import { addDays, type ActivityType, type SleepType } from '@trailpack/shared';

export interface ParsedTripFields {
  days?: number;
  maxDailyKm?: number;
  /** Target base weight in grams. */
  targetBaseWeightG?: number;
  sleepType?: SleepType;
  /** Other sleep types mentioned (fallbacks). */
  sleepAlternatives?: SleepType[];
  excludeCampgrounds?: boolean;
  avoidRain?: boolean;
  weatherAware?: boolean;
  legalOnly?: boolean;
  lightweight?: boolean;
  activity?: ActivityType;
  startDate?: string;
  endDate?: string;
  /** Canonical region name (e.g. "Beskydy"). */
  region?: string;
  /** Text to send to the geocoder. */
  regionQuery?: string;
  countryCode?: string;
  /** 'table' = known mountain range, 'guess' = heuristically extracted phrase. */
  regionSource?: 'table' | 'guess';
  people?: number;
  gear?: { sleepingBagComfortC?: number; packVolumeL?: number; powerbankMah?: number };
}

export interface ParsedTripRequest {
  fields: ParsedTripFields;
  /** Czech follow-up questions for what could not be determined. */
  missing: string[];
  /** 0..1 – share of the key facts that were recognised. */
  confidence: number;
}

const strip = (s: string): string => s.normalize('NFD').replace(/\p{M}/g, '').toLowerCase();

const NUM_WORDS: Record<string, number> = {
  jeden: 1, jedna: 1, jednu: 1, one: 1,
  dva: 2, dve: 2, dvou: 2, two: 2,
  tri: 3, three: 3, trech: 3,
  ctyri: 4, ctyr: 4, styri: 4, four: 4,
  pet: 5, peti: 5, pat: 5, five: 5,
  sest: 6, sesti: 6, six: 6,
  sedm: 7, sedmi: 7, seven: 7,
  osm: 8, osmi: 8, eight: 8,
  devet: 9, deveti: 9, nine: 9,
  deset: 10, deseti: 10, ten: 10,
  dvanact: 12, ctrnact: 14,
};
const NUM_WORD_RE = Object.keys(NUM_WORDS).sort((a, b) => b.length - a.length).join('|');

const num = (s: string): number => Number(s.replace(',', '.'));

interface RegionEntry {
  name: string;
  query: string;
  country: string;
  re: RegExp;
}

/** Order matters: specific names before generic ones (Nízké Tatry before Tatry). */
const REGIONS: RegionEntry[] = [
  { name: 'Nízké Tatry', query: 'Nízké Tatry', country: 'SK', re: /\bnizk\w+ tatr\w*|\blow tatra\w*/ },
  { name: 'Západní Tatry', query: 'Západné Tatry', country: 'SK', re: /\bzapadn\w+ tatr\w*/ },
  { name: 'Vysoké Tatry', query: 'Vysoké Tatry', country: 'SK', re: /\bvysok\w+ tatr\w*|\bhigh tatra\w*|\btatr(?:y|ach|ami|)\b|\btatr\w*/ },
  { name: 'Malá Fatra', query: 'Malá Fatra', country: 'SK', re: /\bmal\w+ fatr\w*/ },
  { name: 'Velká Fatra', query: 'Veľká Fatra', country: 'SK', re: /\bvelk\w+ fatr\w*|\bvel\w+ fatr\w*/ },
  { name: 'Krušné hory', query: 'Krušné hory', country: 'CZ', re: /\bkrusn\w+ hor\w*|\bkrusnohor\w*|\bore mountains/ },
  { name: 'Jizerské hory', query: 'Jizerské hory', country: 'CZ', re: /\bjizersk\w+ hor\w*|\bjizerk\w*/ },
  { name: 'Orlické hory', query: 'Orlické hory', country: 'CZ', re: /\borlick\w+ hor\w*/ },
  { name: 'Bílé Karpaty', query: 'Bílé Karpaty', country: 'CZ', re: /\bbil\w+ karpat\w*/ },
  { name: 'Novohradské hory', query: 'Novohradské hory', country: 'CZ', re: /\bnovohradsk\w+ hor\w*/ },
  { name: 'Beskydy', query: 'Beskydy', country: 'CZ', re: /\bbeskyd\w*/ },
  { name: 'Jeseníky', query: 'Jeseníky', country: 'CZ', re: /\bjesenik\w*|\bhruby jesenik\w*/ },
  { name: 'Krkonoše', query: 'Krkonoše', country: 'CZ', re: /\bkrkonos\w*|\bgiant mountains/ },
  { name: 'Šumava', query: 'Šumava', country: 'CZ', re: /\bsumav\w*/ },
  { name: 'Brdy', query: 'Brdy', country: 'CZ', re: /\bbrd(?:y|ech|ama|ske)\b/ },
  { name: 'Slovenský ráj', query: 'Slovenský raj', country: 'SK', re: /\bslovensk\w+ raj\w*/ },
  { name: 'Pieniny', query: 'Pieniny', country: 'PL', re: /\bpienin\w*/ },
  { name: 'Bieszczady', query: 'Bieszczady', country: 'PL', re: /\bbieszczad\w*|\bbukovsk\w+ vrch\w*/ },
  { name: 'Karkonosze', query: 'Karkonosze', country: 'PL', re: /\bkarkonosz\w*/ },
];

interface SleepRule {
  type: SleepType;
  re: RegExp;
}
const SLEEP_RULES: SleepRule[] = [
  { type: 'hammock', re: /hamak|hammock/ },
  { type: 'tarp', re: /\btarp\w*|plachtou|pod plachtu/ },
  { type: 'open_air', re: /spat venku|spani venku|pod sirou oblohou|open[- ]air|cowboy camp|bez stanu/ },
  { type: 'bivy_bag', re: /\bbivak\w*|\bbivy\b|\bbivouac\b/ },
  { type: 'tent', re: /\bve stanu\b|\bstan\b|\bstanem\b|\bstanovat\b|\bstanu\b|\btent\b/ },
  { type: 'mountain_hut', re: /\bna chat\w*|\bv chat\w*|\bchat(?:a|y|ach)\b|horsk\w+ bud\w*|mountain hut|\bhut\b/ },
  { type: 'campground', re: /\bv kemp\w*|\bkemp\b|\bcampground\b|\bcampsite\b/ },
  { type: 'paid_lodging', re: /penzion|hotel|ubytovani|hostel|lodging/ },
];

const ACTIVITY_RULES: { type: ActivityType; re: RegExp }[] = [
  { type: 'bikepacking', re: /bikepack\w*/ },
  { type: 'gravel', re: /\bgravel\w*/ },
  { type: 'mtb', re: /\bmtb\b|horsk\w+ kol\w*|mountain bik\w*/ },
  { type: 'road_cycling', re: /silnicn\w+ kol\w*|road bik\w*|road cycl\w*/ },
  { type: 'ridge_traverse', re: /hrebenov\w*|ridge/ },
  { type: 'ultralight', re: /ultralight|\bul\b/ },
  { type: 'trekking', re: /\btrek\w*/ },
  { type: 'multi_day', re: /\bprechod\w*|\bprejit\b|\bprejdi\b|\bprojit\b|traverse|crossing|\bvicedenn\w*/ },
  { type: 'hiking', re: /\bturistik\w*|\bpesi\b|\bhiking\b|\bhike\b|\bvylet\w*/ },
  { type: 'camping', re: /\bkempov\w*|\bcamping\b/ },
];

/** Prefixes before "denní"/"denni" -> number (tridenni, dvoudenni, ctyrdenni …). */
const DENNI_PREFIX: Record<string, number> = {
  jedno: 1, dvou: 2, tri: 3, ctyr: 4, peti: 5, sesti: 6, sedmi: 7, osmi: 8, deveti: 9, deseti: 10,
};

const dateIso = (y: number, m: number, d: number): string => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const localIso = (d: Date): string => dateIso(d.getFullYear(), d.getMonth() + 1, d.getDate());

function parseDays(t: string): number | undefined {
  let m = new RegExp(`\\b(${Object.keys(DENNI_PREFIX).join('|')})denn\\w*`).exec(t);
  if (m) return DENNI_PREFIX[m[1]!];
  m = /\b(\d{1,2})\s*-?\s*(?:dn[yiu]|dni|den|days?|day|nocich|noci|nights?)\b/.exec(t);
  if (m) return Number(m[1]);
  m = /(\d{1,2})-?\s*(?:denn\w*|day)\b/.exec(t);
  if (m) return Number(m[1]);
  m = new RegExp(`\\b(${NUM_WORD_RE})\\s+(?:dn[yiu]|dni|den|days?|day)\\b`).exec(t);
  if (m) return NUM_WORDS[m[1]!];
  if (/\bvikend\w*|\bweekend\b/.test(t)) return 2;
  return undefined;
}

function parseMaxDailyKm(t: string): number | undefined {
  const re = /(\d+(?:[.,]\d+)?)\s*km\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const before = t.slice(Math.max(0, m.index - 28), m.index);
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 16);
    const dailyAfter = /^\s*(?:\/|za|na|per|a)?\s*(?:den\b|dne\b|denne|day\b|denni|daily)/.test(after);
    const dailyBefore = /denne|denni|daily|per day|a day|za den|each day|every day/.test(before);
    if (dailyAfter || dailyBefore) return num(m[1]!);
  }
  return undefined;
}

function parseBaseWeight(t: string): number | undefined {
  const m =
    /(?:zakladni hmotnost\w*|base ?weight|hmotnost\w* batohu|vaha batohu|pack weight)(?:\s+\w+){0,3}?\s*(?:pod|do|under|below|max\w*|<|na|of)?\s*(\d+(?:[.,]\d+)?)\s*(kg|g)\b/.exec(t);
  if (!m) return undefined;
  const v = num(m[1]!);
  return Math.round(m[2] === 'kg' ? v * 1000 : v);
}

function parseSleep(t: string): { type?: SleepType; alts: SleepType[]; excludeCampgrounds: boolean } {
  const excludeCampgrounds = /bez kemp\w*|mimo kemp\w*|nechci kemp\w*|no campground\w*|not in campground\w*|bez kempovani/.test(t);
  const cleaned = t.replace(/bez kemp\w*|mimo kemp\w*|nechci kemp\w*|no campground\w*|bez kempovani/g, ' ');
  const found = SLEEP_RULES.filter((r) => r.re.test(cleaned)).map((r) => r.type);
  // "bez stanu" means open air/tarp, not tent
  const hasNoTent = /bez stanu/.test(cleaned);
  const list = hasNoTent ? found.filter((f) => f !== 'tent') : found;
  return { type: list[0], alts: list.slice(1), excludeCampgrounds };
}

function parseDates(t: string, now: Date): { start?: string; end?: string; weekendRel?: boolean } {
  const iso = [...t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)];
  if (iso.length) return { start: iso[0]![0], end: iso[1]?.[0] };

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yearFor = (mo: number, d: number, explicit?: number): number => {
    if (explicit) return explicit;
    const cand = new Date(today.getFullYear(), mo - 1, d);
    return cand < today ? today.getFullYear() + 1 : today.getFullYear();
  };
  const from = /\b(?:od|from)\s+(\d{1,2})\.\s*(\d{1,2})\.(?:\s*(\d{4}))?/.exec(t);
  if (from) {
    const [d, mo] = [Number(from[1]), Number(from[2])];
    const start = dateIso(yearFor(mo, d, from[3] ? Number(from[3]) : undefined), mo, d);
    const to = /\b(?:do|to|until)\s+(\d{1,2})\.\s*(\d{1,2})\.(?:\s*(\d{4}))?/.exec(t);
    let end: string | undefined;
    if (to) {
      const [d2, mo2] = [Number(to[1]), Number(to[2])];
      end = dateIso(yearFor(mo2, d2, to[3] ? Number(to[3]) : undefined), mo2, d2);
      if (end < start) end = undefined;
    }
    return { start, end };
  }
  const lone = /\b(?:dne|ve dnech|dnes|on)\s+(\d{1,2})\.\s*(\d{1,2})\.(?:\s*(\d{4}))?/.exec(t);
  if (lone) {
    const [d, mo] = [Number(lone[1]), Number(lone[2])];
    return { start: dateIso(yearFor(mo, d, lone[3] ? Number(lone[3]) : undefined), mo, d) };
  }
  const dow = today.getDay(); // 0 = Sunday
  if (/pristi vikend|next weekend/.test(t)) {
    const delta = ((6 - dow + 7) % 7) || 7; // strictly after today
    return { start: localIso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + delta)), weekendRel: true };
  }
  if (/tento vikend|this weekend|o vikendu|nejblizsi vikend/.test(t)) {
    const delta = dow === 0 ? 0 : (6 - dow + 7) % 7;
    const start = dow === 0 ? addDays(localIso(today), -1) : localIso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + delta));
    return { start: dow === 0 ? localIso(today) : start, weekendRel: true };
  }
  if (/\bzitra\b|\btomorrow\b/.test(t)) return { start: addDays(localIso(today), 1) };
  if (/pristi tyden|next week\b/.test(t)) {
    const delta = ((1 - dow + 7) % 7) || 7;
    return { start: localIso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + delta)) };
  }
  return {};
}

function parseRegion(raw: string, t: string): Pick<ParsedTripFields, 'region' | 'regionQuery' | 'countryCode' | 'regionSource'> {
  for (const r of REGIONS) {
    if (r.re.test(t)) return { region: r.name, regionQuery: r.query, countryCode: r.country, regionSource: 'table' };
  }
  // Fallback: capitalised phrase after a preposition / traverse verb ("v Pálavě", "přejít Brdy").
  const m = /(?:^|[\s,.;])(?:v|ve|do|na|po|přes|pres|přejít|prejit|projít|projit|projdi|přejdi|prejdi|across|in|through)\s+(\p{Lu}[\p{L}-]{2,}(?:\s+\p{Lu}[\p{L}-]{2,})?)/u.exec(raw);
  if (m) {
    const phrase = m[1]!;
    return { region: phrase, regionQuery: phrase, regionSource: 'guess' };
  }
  return {};
}

function parseGear(t: string): ParsedTripFields['gear'] | undefined {
  const gear: NonNullable<ParsedTripFields['gear']> = {};
  const bag = /(?:spacak\w*|sleeping bag|quilt)(?:\s+\S+){0,4}?\s*(-?\d+(?:[.,]\d+)?)\s*(?:°|stupn\w*)?\s*c\b/.exec(t);
  if (bag) gear.sleepingBagComfortC = num(bag[1]!);
  const pack = /(?:batoh\w*|backpack|pack|rucksack)(?:\s+(?:o objemu|objem|of))?\s*(\d{2,3})\s*(?:l\b|litr\w*|liters?|litres?)/.exec(t);
  if (pack) gear.packVolumeL = Number(pack[1]);
  const pb = /(?:powerbank\w*|power bank|externi bateri\w*)(?:\s+\S+){0,2}?\s*(\d{1,3}(?:[\s.]\d{3})+|\d{3,6})\s*mah/.exec(t);
  if (pb) gear.powerbankMah = Number(pb[1]!.replace(/[\s.]/g, ''));
  return Object.keys(gear).length ? gear : undefined;
}

function parsePeople(t: string): number | undefined {
  let m = /(\d{1,2})\s*(?:lidi|osob\w*|people|persons|pratel|kamarad\w*)/.exec(t);
  if (m) return Number(m[1]);
  m = /\bve (dvou|trech|ctyrech)\b/.exec(t);
  if (m) return { dvou: 2, trech: 3, ctyrech: 4 }[m[1]!];
  if (/s pritelkyni|s pritelem|s partner\w*|s manzel\w*|with my (?:wife|husband|partner)/.test(t)) return 2;
  if (/\bsam\b|\bsama\b|\bsolo\b|\balone\b/.test(t)) return 1;
  return undefined;
}

/**
 * Parse a trip request. `now` anchors relative dates ("příští víkend",
 * "od 12. 6." without year). Pure and deterministic.
 */
export function parseTripRequest(text: string, now: Date): ParsedTripRequest {
  const t = strip(text);
  const f: ParsedTripFields = {};

  const days = parseDays(t);
  if (days !== undefined) f.days = days;
  const km = parseMaxDailyKm(t);
  if (km !== undefined) f.maxDailyKm = km;
  const bw = parseBaseWeight(t);
  if (bw !== undefined) f.targetBaseWeightG = bw;

  const sleep = parseSleep(t);
  if (sleep.type) f.sleepType = sleep.type;
  if (sleep.alts.length) f.sleepAlternatives = sleep.alts;
  if (sleep.excludeCampgrounds) f.excludeCampgrounds = true;

  if (/vyhnout se desti|vyhnu se desti|vyhnout dest\w*|nechci zmokn\w*|nechci moknout|bez desti|nemoknout|avoid rain|stay dry|nechci pr[sš]et/.test(t)) {
    f.avoidRain = true;
    f.weatherAware = true;
  }
  if (/s ohledem na pocasi|podle pocasi|dle pocasi|zohledn\w* pocasi|weather[- ]aware|according to (?:the )?weather|check the weather/.test(t)) f.weatherAware = true;
  if (/na legalnich mistech|legalne|legalni\w* (?:mist|spani|nocl|pren)|pouze legal\w*|only legal|legally|within the law/.test(t)) f.legalOnly = true;
  if (/lehk\w+ batoh\w*|lehkym|ultralight|\bul\b|light(?:weight)? pack/.test(t)) f.lightweight = true;

  for (const r of ACTIVITY_RULES) {
    if (r.re.test(t)) {
      f.activity = r.type;
      break;
    }
  }

  const dates = parseDates(t, now);
  if (dates.start) f.startDate = dates.start;
  if (dates.end) f.endDate = dates.end;
  if (f.startDate && f.endDate && f.days === undefined) {
    f.days = Math.round((Date.parse(`${f.endDate}T00:00:00Z`) - Date.parse(`${f.startDate}T00:00:00Z`)) / 86400000) + 1;
  }
  if (f.startDate && !f.endDate && f.days !== undefined) f.endDate = addDays(f.startDate, f.days - 1);

  Object.assign(f, parseRegion(text, t));
  const gear = parseGear(t);
  if (gear) f.gear = gear;
  const people = parsePeople(t);
  if (people !== undefined) f.people = people;

  const missing: string[] = [];
  if (!f.region) missing.push('V jaké oblasti (pohoří) nebo mezi jakými místy chcete trasu naplánovat?');
  else if (f.regionSource === 'guess') missing.push(`Mám správně, že oblast je „${f.region}“? Případně upřesněte pohoří nebo startovní místo.`);
  if (f.days === undefined) missing.push('Na kolik dní výpravu plánujete?');
  if (f.maxDailyKm === undefined) missing.push('Kolik kilometrů denně chcete maximálně ujít (nebo ujet)?');
  if (!f.startDate) missing.push('Kdy chcete vyrazit? Podle data zahrnu předpověď počasí a čas západu slunce.');
  if (!f.sleepType) missing.push('Kde chcete spát (stan, tarp, spaní venku, chata, kemp)?');
  if (!f.activity) missing.push('Půjdete pěšky, nebo pojedete na kole (bikepacking, gravel, MTB)?');

  const weights: [boolean, number][] = [
    [!!f.region, 0.3],
    [f.days !== undefined, 0.2],
    [f.maxDailyKm !== undefined, 0.15],
    [!!f.sleepType || !!f.excludeCampgrounds, 0.1],
    [f.targetBaseWeightG !== undefined || !!f.lightweight, 0.05],
    [!!f.startDate, 0.1],
    [!!f.activity, 0.05],
    [!!f.avoidRain || !!f.weatherAware || !!f.legalOnly, 0.05],
  ];
  const confidence = Math.round(weights.reduce((s, [ok, w]) => s + (ok ? w : 0), 0) * 100) / 100;

  return { fields: f, missing, confidence };
}
