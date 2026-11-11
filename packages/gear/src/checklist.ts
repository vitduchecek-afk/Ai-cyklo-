/**
 * Pre-trip checklist generation and merging. Auto items carry a stable
 * `autoKey`, so regeneration never duplicates them and never drops user items.
 */
import type { ChecklistCategory, Trip, TransportLeg } from '@trailpack/shared';
import { findMissingEssentials } from './packing';
import type { GearEntry } from './weight';

export interface ChecklistContext {
  trip: Trip;
  /** Trip length in days. */
  days: number;
  loadoutEntries?: readonly GearEntry[];
  hasRoute: boolean;
  offlineRegionReady: boolean;
  /** ISO timestamp of the last downloaded forecast. */
  forecastFetchedAt?: string;
  campsites?: ReadonlyArray<{ name?: string; reservation: 'required' | 'recommended' | 'no' | 'unknown' }>;
  transportLegs: readonly TransportLeg[];
  participants: number;
  emergencyContactsSet: boolean;
  powerPlanSufficient?: boolean;
  waterPlanReady?: boolean;
  mealPlanReady?: boolean;
  /** Reference time for forecast freshness (default: now). */
  now?: Date;
}

export interface GeneratedChecklistItem {
  /** Czech text. */
  text: string;
  category: ChecklistCategory;
  autoKey: string;
  done: boolean;
}

/** Forecast older than this is considered stale, hours. */
export const FORECAST_STALE_HOURS = 12;

const CATEGORY_ORDER: ChecklistCategory[] = ['gear', 'food', 'water', 'electronics', 'charging', 'offline_maps', 'forecast', 'permits', 'transport', 'safety', 'other'];

/** Generate the auto checklist for a trip. Pure. */
export function generateTripChecklist(ctx: ChecklistContext): GeneratedChecklistItem[] {
  const out: GeneratedChecklistItem[] = [];
  const add = (category: ChecklistCategory, autoKey: string, text: string, done = false): void => {
    out.push({ text, category, autoKey, done });
  };
  const now = ctx.now ?? new Date();
  const multiDay = ctx.days > 1;
  const sleeps = multiDay && ctx.trip.settings.sleepType !== 'mountain_hut' && ctx.trip.settings.sleepType !== 'paid_lodging';
  const entries = ctx.loadoutEntries;

  // gear
  if (!entries || entries.length === 0) {
    add('gear', 'gear:loadout', 'Vytvořte nebo vyberte seznam vybavení pro tento výlet');
  } else {
    const missing = findMissingEssentials(entries, { dayTrip: !multiDay });
    for (const m of missing) add('gear', `gear:missing:${m.role}`, `Chybí v seznamu vybavení: ${m.label}`);
    const unpacked = entries.filter((e) => e.entry.carryMode !== 'worn' && !e.entry.packed).length;
    add('gear', 'gear:packed-all', unpacked === 0 ? 'Veškeré vybavení je zabaleno' : `Zabalte vybavení (zbývá ${unpacked} položek)`, unpacked === 0);
    const unconfirmed = entries.filter((e) => !e.item.weightConfirmed).length;
    if (unconfirmed > 0) add('gear', 'gear:confirm-weights', `Zvažte a potvrďte odhadované váhy (${unconfirmed} položek)`);
  }
  add('gear', 'gear:check-condition', 'Zkontrolujte stav vybavení (stan, karimatka, vařič, baterie, zipy)');
  if (sleeps) add('gear', 'gear:shelter-test', 'Zkontrolujte, že máte celý přístřešek včetně tyčí, kolíků a šňůr');

  // food
  add('food', 'food:meal-plan', multiDay ? 'Připravte jídelníček a nákup na celý výlet' : 'Připravte jídlo a svačiny na cestu', ctx.mealPlanReady === true);
  if (multiDay) add('food', 'food:reserve', 'Vezměte nouzovou zásobu jídla na minimálně jeden den navíc');
  if (ctx.trip.settings.stoveType !== 'none' && ctx.trip.settings.stoveType !== 'cold_soak') add('food', 'food:fuel', 'Zkontrolujte palivo a zapalování pro vařič');

  // water
  add('water', 'water:plan', 'Naplánujte zdroje vody podél trasy a kapacitu lahví', ctx.waterPlanReady === true);
  add('water', 'water:treatment', 'Vezměte úpravu vody (filtr, tablety) a zkontrolujte, že filtr funguje');

  // electronics & charging
  add('electronics', 'electronics:devices', 'Zkontrolujte telefon, čelovku, GPS a hodinky včetně kabelů');
  add('electronics', 'electronics:phone-ready', 'Nastavte telefon na úsporný režim a stáhněte potřebné aplikace offline');
  const chargeText =
    ctx.powerPlanSufficient === false ? 'Napájení nestačí – přidejte powerbanku nebo naplánujte dobíjení' : 'Nabijte všechna zařízení a powerbanku na 100 %';
  add('charging', 'charging:power-plan', chargeText);

  // offline maps
  add('offline_maps', 'offline:route', ctx.hasRoute ? 'Trasa je uložena v zařízení' : 'Vytvořte nebo importujte trasu výletu', ctx.hasRoute);
  add('offline_maps', 'offline:region', 'Stáhněte offline mapy oblasti (včetně okolí trasy pro případ úniku)', ctx.offlineRegionReady);
  add('offline_maps', 'offline:gpx-backup', 'Uložte si GPX trasy také mimo aplikaci (záloha)');

  // forecast
  const fetched = ctx.forecastFetchedAt ? Date.parse(ctx.forecastFetchedAt) : NaN;
  const ageH = Number.isNaN(fetched) ? Infinity : (now.getTime() - fetched) / 3_600_000;
  const fresh = ageH <= FORECAST_STALE_HOURS;
  add(
    'forecast',
    'forecast:fresh',
    Number.isNaN(fetched) ? 'Stáhněte předpověď počasí pro trasu' : fresh ? 'Předpověď počasí je aktuální' : `Aktualizujte předpověď (stará ${Math.round(ageH)} h)`,
    fresh,
  );
  add('forecast', 'forecast:check-before-start', 'Těsně před startem znovu zkontrolujte předpověď a výstrahy (ČHMÚ / SHMÚ / IMGW)');

  // permits & reservations
  let reservationNeeded = false;
  (ctx.campsites ?? []).forEach((c, i) => {
    if (c.reservation === 'required' || c.reservation === 'recommended') {
      reservationNeeded = true;
      const label = c.name ?? `místo ${i + 1}`;
      add('permits', `permits:reserve:${i}`, c.reservation === 'required' ? `Zarezervujte nocleh: ${label} (rezervace nutná)` : `Zvažte rezervaci noclehu: ${label}`);
    }
  });
  if (sleeps) add('permits', 'permits:rules', 'Ověřte pravidla pro nocování, oheň a vstup v dané oblasti (NP, CHKO, rezervace)');
  if (!reservationNeeded && multiDay) add('permits', 'permits:accommodation-check', 'Ověřte, zda nocleh na trase nevyžaduje rezervaci nebo poplatek');

  // transport
  if (ctx.transportLegs.length === 0) {
    add('transport', 'transport:plan', 'Naplánujte dopravu na start a z cíle');
  } else {
    for (const leg of ctx.transportLegs) {
      add('transport', `transport:leg:${leg.id}`, `Potvrďte spoj / dopravu: ${leg.from} → ${leg.to}`, leg.confirmed);
      if (leg.mode === 'car' && !leg.parking) add('transport', `transport:parking:${leg.id}`, `Ověřte parkování: ${leg.to}`);
    }
    if (!ctx.transportLegs.some((l) => l.direction === 'return')) add('transport', 'transport:return', 'Naplánujte cestu zpět');
  }

  // safety
  add('safety', 'safety:share-plan', 'Sdělte blízké osobě trasu, plánovaný čas návratu a kdy se ozvete');
  add('safety', 'safety:emergency-contacts', 'Nastavte nouzové kontakty a zdravotní informace', ctx.emergencyContactsSet);
  add('safety', 'safety:emergency-number', 'Zkontrolujte, že víte, jak volat 112 (případně tísňovou aplikaci Záchranka)');
  add('safety', 'safety:turnaround', 'Určete si zpáteční čas a únikové varianty trasy');
  if (ctx.participants > 1) add('safety', 'safety:group', `Domluvte ve skupině (${ctx.participants} osob) místo srazu a rozdělení společné výbavy`);

  return out.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
}

/** Minimal shape needed for merging; extra fields (id, sortOrder, …) are preserved. */
export interface MergeableChecklistItem {
  text: string;
  category: ChecklistCategory;
  done: boolean;
  autoKey?: string;
}

/**
 * Merge regenerated items into an existing checklist.
 * - user items (no autoKey) are untouched,
 * - existing auto items keep their done state (a generated `done: true` can complete them),
 *   text/category are refreshed,
 * - new generated items are appended,
 * - stale auto items (no longer generated) are removed unless already done.
 */
export function mergeChecklist<T extends MergeableChecklistItem>(existing: readonly T[], generated: readonly GeneratedChecklistItem[]): Array<T | GeneratedChecklistItem> {
  const gen = new Map(generated.map((g) => [g.autoKey, g]));
  const out: Array<T | GeneratedChecklistItem> = [];
  const seen = new Set<string>();
  for (const e of existing) {
    if (!e.autoKey) {
      out.push(e);
      continue;
    }
    if (seen.has(e.autoKey)) continue;
    seen.add(e.autoKey);
    const g = gen.get(e.autoKey);
    if (g) out.push({ ...e, text: g.text, category: g.category, done: e.done || g.done });
    else if (e.done) out.push(e);
  }
  for (const g of generated) {
    if (!seen.has(g.autoKey)) out.push(g);
  }
  return out;
}
