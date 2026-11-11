/**
 * Day schedule builder: turns a moving time, breaks and optional segments
 * into a clock-time timeline (wake-up to sleep) and checks the arrival
 * against sunset.
 */
import type { Advisory, SleepType } from '@trailpack/shared';
import { formatLocalTime, parseLocalTime } from '@trailpack/shared';
import { advisory, invalid, r, requireNumber } from './internal';

export type ScheduleItemKind =
  | 'wake'
  | 'breakfast'
  | 'depart'
  | 'segment'
  | 'break'
  | 'water'
  | 'lunch'
  | 'arrive'
  | 'camp_setup'
  | 'dinner'
  | 'evening'
  | 'sleep';

export interface ScheduleItem {
  /** Local time `HH:MM`. */
  time: string;
  kind: ScheduleItemKind;
  /** Czech label. */
  label: string;
  detail?: string;
}

export interface DayScheduleInput {
  /** Local calendar date `YYYY-MM-DD`. */
  date: string;
  /** Departure, local `HH:MM`. */
  startTime: string;
  /** Total moving time, minutes. */
  movingMin: number;
  /** Total break time, minutes (distributed over the day). */
  breakMin: number;
  /** Optional named parts of the day; their moving minutes are laid out sequentially. */
  segments?: Array<{ label: string; movingMin: number }>;
  /** Water stops; `atMin` = moving minutes since departure. */
  waterStops?: Array<{ label: string; atMin: number }>;
  /** Sunset as ISO instant (UTC or with offset); null/undefined when unknown. */
  sunsetIso?: string | null;
  /** Local offset from UTC, minutes (e.g. 120 for CEST). */
  timezoneOffsetMin: number;
  /** Camp setup duration, minutes (default by sleep type). */
  campSetupMin?: number;
  /** Whether camping/overnighting at the destination is allowed. */
  campAllowed: boolean;
  sleepType: SleepType;
  /** Minutes between waking up and departure (default 60). */
  wakeBeforeDepartMin?: number;
}

export interface DaySchedule {
  items: ScheduleItem[];
  /** Local arrival time `HH:MM`. */
  arrivalTime: string;
  /** Minutes between arrival and sunset (negative = after sunset); null when sunset is unknown. */
  sunsetReserveMin: number | null;
  advisories: Advisory[];
}

const DEFAULT_SETUP_MIN: Record<SleepType, number> = {
  open_air: 10,
  tarp: 25,
  tent: 30,
  hammock: 20,
  bivy_bag: 15,
  shelter: 15,
  emergency_hut: 15,
  official_bivouac_site: 30,
  campground: 30,
  mountain_hut: 10,
  paid_lodging: 10,
};

interface Ev {
  pos: number;
  order: number;
  kind: ScheduleItemKind;
  label: string;
  detail?: string;
  breakLen?: number;
}

/**
 * Build a day timeline.
 * Arrival = departure + moving + breaks. Warns when arrival is less than 60
 * minutes before sunset (warning) or after sunset (danger). When
 * `campAllowed` is false no camp setup is planned.
 */
export function buildDaySchedule(input: DayScheduleInput): DaySchedule {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) invalid(`Neplatné datum „${input.date}“.`);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.startTime)) invalid(`Neplatný čas startu „${input.startTime}“ (očekáváno HH:MM).`);
  const movingMin = requireNumber('movingMin', input.movingMin);
  const breakMin = requireNumber('breakMin', input.breakMin);
  const tz = requireNumber('timezoneOffsetMin', input.timezoneOffsetMin, -840, 840);
  const wakeBefore = requireNumber('wakeBeforeDepartMin', input.wakeBeforeDepartMin ?? 60, 0, 600);
  const setupMin = requireNumber('campSetupMin', input.campSetupMin ?? DEFAULT_SETUP_MIN[input.sleepType], 0, 240);

  const depart = parseLocalTime(input.startTime);
  const items: ScheduleItem[] = [];
  const advisories: Advisory[] = [];
  const t = (min: number) => formatLocalTime(min);

  // Morning
  const wake = depart - wakeBefore;
  items.push({ time: t(wake), kind: 'wake', label: 'Vstávání' });
  if (wakeBefore >= 30) items.push({ time: t(wake + Math.min(15, wakeBefore - 15)), kind: 'breakfast', label: 'Snídaně a balení' });
  items.push({ time: t(depart), kind: 'depart', label: 'Odchod' });

  // Moving-axis events
  const events: Ev[] = [];
  let pos = 0;
  (input.segments ?? []).forEach((s, i) => {
    requireNumber(`segments[${i}].movingMin`, s.movingMin);
    events.push({ pos, order: 0, kind: 'segment', label: s.label, detail: `cca ${r(s.movingMin)} min pohybu` });
    pos += s.movingMin;
  });
  const segSum = pos;
  if (segSum > 0 && Math.abs(segSum - movingMin) > 1) {
    advisories.push(
      advisory('schedule_segments_mismatch', 'info', `Součet úseků (${r(segSum)} min) se liší od celkového času pohybu (${r(movingMin)} min); časy úseků jsou orientační.`, {
        params: { segmentsMin: r(segSum), movingMin: r(movingMin) },
      }),
    );
  }
  (input.waterStops ?? []).forEach((w, i) => {
    requireNumber(`waterStops[${i}].atMin`, w.atMin, 0, 1440);
    if (w.atMin <= movingMin) events.push({ pos: w.atMin, order: 1, kind: 'water', label: w.label, detail: 'doplnění vody' });
  });

  // Breaks: one per hour of movement, the one closest to the middle becomes lunch.
  const breakPos: number[] = [];
  if (breakMin > 0 && movingMin > 0) {
    for (let p = 60; p < movingMin - 15; p += 60) breakPos.push(p);
    if (breakPos.length === 0) breakPos.push(movingMin / 2);
  }
  if (breakPos.length > 0) {
    let lunchIdx = -1;
    if (movingMin >= 240) {
      let bestD = Infinity;
      breakPos.forEach((p, i) => {
        const d = Math.abs(p - movingMin / 2);
        if (d < bestD) {
          bestD = d;
          lunchIdx = i;
        }
      });
    }
    const n = breakPos.length;
    const lunchLen = lunchIdx >= 0 ? (n === 1 ? breakMin : Math.min(Math.max(30, breakMin / n), breakMin * 0.6)) : 0;
    const otherLen = n - (lunchIdx >= 0 ? 1 : 0) > 0 ? (breakMin - lunchLen) / (n - (lunchIdx >= 0 ? 1 : 0)) : 0;
    breakPos.forEach((p, i) => {
      const isLunch = i === lunchIdx;
      const len = isLunch ? lunchLen : otherLen;
      events.push({
        pos: p,
        order: 2,
        kind: isLunch ? 'lunch' : 'break',
        label: isLunch ? 'Oběd' : 'Odpočinek',
        detail: `cca ${r(len)} min`,
        breakLen: len,
      });
    });
  }
  events.sort((a, b) => a.pos - b.pos || a.order - b.order);

  let breaksSoFar = 0;
  for (const e of events) {
    items.push({ time: t(depart + e.pos + breaksSoFar), kind: e.kind, label: e.label, detail: e.detail });
    if (e.breakLen) breaksSoFar += e.breakLen;
  }

  // Arrival
  const arrival = depart + movingMin + breakMin;
  const arrivalTime = t(arrival);
  items.push({ time: arrivalTime, kind: 'arrive', label: 'Příchod do cíle', detail: arrival >= 1440 ? 'po půlnoci (následující den)' : undefined });

  // Sunset check
  let reserve: number | null = null;
  if (input.sunsetIso) {
    const sunMs = Date.parse(input.sunsetIso);
    if (Number.isNaN(sunMs)) invalid(`Neplatný čas západu slunce „${input.sunsetIso}“.`);
    const [y, m, d] = input.date.split('-').map(Number) as [number, number, number];
    const midnightUtc = Date.UTC(y, m - 1, d);
    const sunsetLocalMin = (sunMs - midnightUtc) / 60000 + tz;
    reserve = r(sunsetLocalMin - arrival);
    const basis = [`západ slunce ${t(sunsetLocalMin)}`, `příchod ${arrivalTime}`];
    if (reserve < 0) {
      advisories.push(
        advisory('arrival_after_sunset', 'danger', `Příchod (${arrivalTime}) je po západu slunce (${t(sunsetLocalMin)}). Počítejte s chůzí potmě.`, {
          params: { reserveMin: reserve },
          basis,
          action: 'Vyjděte dříve, zkraťte etapu nebo naplánujte čelovku a bezpečnější cíl.',
          uncertainty: 'Čas příchodu je odhad; skutečná doba pohybu se může lišit o 20 % i více.',
        }),
      );
    } else if (reserve < 60) {
      advisories.push(
        advisory('arrival_near_sunset', 'warning', `Příchod (${arrivalTime}) je jen ${reserve} min před západem slunce (${t(sunsetLocalMin)}); rezerva je menší než 60 min.`, {
          params: { reserveMin: reserve },
          basis,
          action: 'Zvažte dřívější odchod nebo kratší etapu, ať stihnete postavit tábor za světla.',
          uncertainty: 'Čas příchodu je odhad; skutečná doba pohybu se může lišit o 20 % i více.',
        }),
      );
    }
  }

  // Evening
  let cursor = arrival;
  if (input.campAllowed) {
    items.push({ time: t(cursor), kind: 'camp_setup', label: 'Zřízení tábora', detail: `cca ${r(setupMin)} min` });
    cursor += setupMin;
  } else {
    advisories.push(
      advisory('camp_not_allowed', 'warning', 'Na cílovém místě není nocování povolené nebo ověřené, proto plán nezahrnuje zřízení tábora.', {
        action: 'Vyberte legální nocleh (kemp, chata, oficiální tábořiště) nebo zjistěte místní pravidla.',
        uncertainty: 'Právní status místa se může lišit podle sezóny a správce území.',
      }),
    );
  }
  items.push({ time: t(cursor), kind: 'dinner', label: 'Večeře', detail: input.campAllowed ? undefined : 'nocleh mimo tento plán' });
  const eveningAt = cursor + 45;
  items.push({ time: t(eveningAt), kind: 'evening', label: 'Večer: údržba vybavení, doplnění vody, plán na zítřek' });
  const sleepAt = Math.max(21 * 60 + 30, eveningAt + 30);
  items.push({ time: t(sleepAt), kind: 'sleep', label: 'Spánek' });

  return { items, arrivalTime, sunsetReserveMin: reserve, advisories };
}
