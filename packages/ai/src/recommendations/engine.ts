/**
 * Deterministic recommendation rules. Given an analysed trip (stages, weather,
 * water, food, power, gear) it produces Czech advisories that always state
 * their basis, a suggested action, alternatives and the uncertainty. No AI,
 * no network – the same input always yields the same output.
 */
import { parseLocalTime, type Advisory, type FitnessLevel, type LegalStatus, type Severity, type TripSettings } from '@trailpack/shared';

/** An advisory with concrete alternatives the user can choose from. */
export type RecommendationAdvisory = Advisory & { alternatives: string[] };

export interface TripAnalysisDay {
  index: number;
  distanceM: number;
  ascentM: number;
  movingMin: number;
  /** 'HH:MM' local */
  arrivalTime?: string;
  /** 'HH:MM' local */
  sunsetTime?: string;
  /** Overnight place at the end of this day (omit for the last day). */
  campsite?: { legalStatus: LegalStatus; name?: string };
  nightMinC?: number;
  waterCarryL?: number;
  waterSourcesCount?: number;
}

export interface TripAnalysisInput {
  settings: Pick<TripSettings, 'dailyDistanceKm' | 'maxDailyAscentM' | 'sleepType'> & Partial<TripSettings>;
  days: TripAnalysisDay[];
  fitness: FitnessLevel;
  packWeights?: { baseG: number; totalG: number; targetBaseG?: number; bodyWeightKg?: number };
  sleepingBagComfortC?: number;
  forecastRisks?: Advisory[];
  waterPlan?: { sufficient: boolean; deficitL?: number };
  food?: { plannedKcalPerDay: number; neededKcalPerDay: number };
  power?: { sufficient: boolean; reservePct: number };
  optimizerSavingsG?: number;
}

/** Km-effort (km + ascent/100) a person of the given fitness can sustain daily. */
export const EFFORT_LIMIT_BY_FITNESS: Record<FitnessLevel, number> = { low: 18, moderate: 28, good: 38, excellent: 48 };
export const MAX_MOVING_MIN = 9 * 60;
export const MIN_DAYLIGHT_RESERVE_MIN = 60;
export const MIN_BATTERY_RESERVE_PCT = 20;

const SEVERITY_RANK: Record<Severity, number> = { danger: 0, warning: 1, info: 2 };

const km = (m: number): string => (m / 1000).toFixed(1).replace('.', ',');
const hrs = (min: number): string => `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, '0')} min`;
const dayLabel = (d: TripAnalysisDay): string => `den ${d.index + 1}`;
const timeMin = (t: string | undefined): number | undefined => (t && /^\d{1,2}:\d{2}$/.test(t) ? parseLocalTime(t) : undefined);

function adv(
  code: string,
  severity: Severity,
  message: string,
  extra: { basis: string[]; action?: string; alternatives?: string[]; uncertainty?: string; params?: Advisory['params'] },
): RecommendationAdvisory {
  return {
    code,
    severity,
    message,
    params: extra.params ?? {},
    basis: extra.basis,
    action: extra.action,
    alternatives: extra.alternatives ?? [],
    uncertainty: extra.uncertainty,
    source: 'trailpack.recommendations',
  };
}

/** Run every rule and return prioritised advisories. */
export function analyzeTrip(input: TripAnalysisInput): RecommendationAdvisory[] {
  const out: RecommendationAdvisory[] = [];
  const { settings, days, fitness } = input;
  const effortLimit = EFFORT_LIMIT_BY_FITNESS[fitness];
  const lastIdx = days.length - 1;

  for (const d of days) {
    const distKm = d.distanceM / 1000;
    const label = dayLabel(d);
    const day = d.index + 1;

    if (distKm > settings.dailyDistanceKm * 1.15) {
      out.push(
        adv('stage.too_long', 'warning', `Etapa (${label}) má ${km(d.distanceM)} km, což je víc než váš limit ${settings.dailyDistanceKm} km denně.`, {
          basis: [`Délka etapy ${km(d.distanceM)} km`, `Limit ${settings.dailyDistanceKm} km/den`],
          action: 'Posuňte konec etapy blíž, nebo přidejte den.',
          alternatives: ['Přidat jeden den a rozložit vzdálenost', 'Zkrátit trasu vynecháním odbočky', 'Zvýšit denní limit, pokud to dovoluje kondice'],
          params: { day, distanceKm: Math.round(distKm * 10) / 10, limitKm: settings.dailyDistanceKm },
        }),
      );
    }

    const effort = distKm + d.ascentM / 100;
    if (effort > effortLimit) {
      const sev: Severity = effort > effortLimit * 1.3 ? 'danger' : 'warning';
      out.push(
        adv('stage.too_demanding', sev, `Etapa (${label}) je na vaši kondici náročná: ${km(d.distanceM)} km a +${Math.round(d.ascentM)} m (zátěžový index ${Math.round(effort)} z doporučených ${effortLimit}).`, {
          basis: [`km + převýšení/100 = ${Math.round(effort)}`, `Kondice: ${fitness}`],
          action: 'Rozdělte etapu, nebo zvolte trasu s menším stoupáním.',
          alternatives: ['Přidat den', 'Vybrat trasu s menším převýšením', 'Přespat dřív a další den navázat'],
          uncertainty: 'Index je zjednodušený odhad; skutečná náročnost závisí na terénu, váze batohu a počasí.',
          params: { day, effort: Math.round(effort), limit: effortLimit },
        }),
      );
    }

    if (settings.maxDailyAscentM && d.ascentM > settings.maxDailyAscentM * 1.1) {
      out.push(
        adv('stage.ascent_over_limit', 'warning', `Převýšení v etapě (${label}) je +${Math.round(d.ascentM)} m, váš limit je ${settings.maxDailyAscentM} m.`, {
          basis: [`Stoupání ${Math.round(d.ascentM)} m`, `Limit ${settings.maxDailyAscentM} m`],
          action: 'Zvolte jiné rozdělení etap nebo jednodušší variantu trasy.',
          params: { day },
        }),
      );
    }

    if (d.movingMin > MAX_MOVING_MIN) {
      out.push(
        adv('time.long_day', d.movingMin > 11 * 60 ? 'danger' : 'warning', `Čistý čas pohybu v etapě (${label}) je ${hrs(d.movingMin)}, což přesahuje 9 hodin.`, {
          basis: [`Pohyb ${hrs(d.movingMin)}`, 'Doporučený strop 9 h'],
          action: 'Zkraťte etapu nebo vyrazte dřív.',
          alternatives: ['Přidat den', 'Přespat v půli etapy'],
          uncertainty: 'Čas je odhad podle tempa; zdržení (pauzy, navigace, počasí) se do něj nepočítají.',
          params: { day, movingMin: Math.round(d.movingMin) },
        }),
      );
    }

    const arrival = timeMin(d.arrivalTime);
    const sunset = timeMin(d.sunsetTime);
    if (arrival !== undefined && sunset !== undefined) {
      const reserve = sunset - arrival;
      if (reserve < 0) {
        out.push(
          adv('daylight.after_sunset', 'danger', `Příchod do cíle etapy (${label}) v ${d.arrivalTime} je po západu slunce (${d.sunsetTime}).`, {
            basis: [`Příchod ${d.arrivalTime}`, `Západ slunce ${d.sunsetTime}`],
            action: 'Vyrazte dřív, zkraťte etapu, nebo mějte čelovku a znalost terénu.',
            alternatives: ['Posunout start o hodinu dřív', 'Zkrátit etapu', 'Přespat dřív'],
            params: { day, reserveMin: Math.round(reserve) },
          }),
        );
      } else if (reserve < MIN_DAYLIGHT_RESERVE_MIN) {
        out.push(
          adv('daylight.low_reserve', 'warning', `Rezerva denního světla v etapě (${label}) je jen ${Math.round(reserve)} min.`, {
            basis: [`Příchod ${d.arrivalTime}`, `Západ slunce ${d.sunsetTime}`],
            action: 'Počítejte s dřívějším startem nebo kratší etapou.',
            params: { day, reserveMin: Math.round(reserve) },
          }),
        );
      }
    }

    if (d.waterSourcesCount === 0 && distKm > 10) {
      out.push(
        adv('water.no_sources', 'warning', `Na etapě (${label}) nejsou v datech žádné zdroje vody.`, {
          basis: ['0 zdrojů vody podél trasy', `Délka ${km(d.distanceM)} km`],
          action: 'Naplánujte načerpání před startem a nést zásobu na celou etapu.',
          uncertainty: 'Chybějící zdroj v datech neznamená, že voda není; mapová data nejsou úplná.',
          params: { day },
        }),
      );
    }
    if (d.waterCarryL !== undefined && d.waterCarryL > 4) {
      out.push(
        adv('water.heavy_carry', 'info', `Na etapě (${label}) je potřeba nést až ${d.waterCarryL.toFixed(1).replace('.', ',')} l vody (${d.waterCarryL.toFixed(1).replace('.', ',')} kg navíc).`, {
          basis: [`Nejdelší úsek bez vody vyžaduje ${d.waterCarryL.toFixed(1)} l`],
          action: 'Zvažte jiné místo nočního tábora blíž ke zdroji.',
          params: { day, carryL: Math.round(d.waterCarryL * 10) / 10 },
        }),
      );
    }

    if (d.campsite) {
      const name = d.campsite.name ? ` „${d.campsite.name}“` : '';
      if (d.campsite.legalStatus === 'prohibited') {
        out.push(
          adv('camp.prohibited', 'danger', `Nocleh po ${label}${name} je na tomto místě zakázaný.`, {
            basis: ['Právní kontrola: zakázáno'],
            action: 'Vyberte jiné místo, oficiální kemp nebo chatu.',
            alternatives: ['Oficiální kemp nebo chata v okolí', 'Jiný druh přenocování, který je zde povolen', 'Posunout konec etapy'],
            params: { day },
          }),
        );
      } else if (d.campsite.legalStatus === 'unverified') {
        out.push(
          adv('camp.unverified', 'warning', `Legálnost noclehu po ${label}${name} se nepodařilo ověřit.`, {
            basis: ['Pravidla pro tuto lokalitu nejsou v datech jednoznačná'],
            action: 'Ověřte pravidla u správy území, nebo zvolte oficiální místo.',
            uncertainty: 'Zákaz může platit i bez značení; za dodržení pravidel odpovídáte vy.',
            params: { day },
          }),
        );
      } else if (d.campsite.legalStatus === 'conditional') {
        out.push(
          adv('camp.conditional', 'info', `Nocleh po ${label}${name} je povolen jen za podmínek.`, {
            basis: ['Právní kontrola: podmíněně povoleno'],
            action: 'Přečtěte si podmínky (zóna, rozdělávání ohně, počet nocí).',
            params: { day },
          }),
        );
      }
    } else if (d.index < lastIdx) {
      out.push(
        adv('camp.missing', 'warning', `Pro noc po ${label} není vybrané místo k přespání.`, {
          basis: ['Žádné místo k přespání nebylo přiřazeno'],
          action: 'Vyberte tábořiště nebo chatu v dosahu konce etapy.',
          params: { day },
        }),
      );
    }
  }

  // Sleeping bag vs. coldest night
  if (input.sleepingBagComfortC !== undefined) {
    let coldest: TripAnalysisDay | undefined;
    for (const d of days) if (d.nightMinC !== undefined && (!coldest || d.nightMinC < coldest.nightMinC!)) coldest = d;
    if (coldest && coldest.nightMinC !== undefined) {
      const night = coldest.nightMinC;
      const comfort = input.sleepingBagComfortC;
      const basis = [`Předpovězená noční minima ${night} °C (${dayLabel(coldest)})`, `Komfortní teplota spacáku ${comfort} °C`];
      const unc = 'Teplota na místě tábora může být o několik stupňů nižší (údolí, vítr, vlhkost).';
      if (night < comfort - 5) {
        out.push(adv('sleep.bag_insufficient', 'danger', `Spacák s komfortem ${comfort} °C nestačí na noc s ${night} °C – hrozí podchlazení.`, { basis, action: 'Vezměte teplejší spacák nebo vložku a izolační vrstvy.', alternatives: ['Teplejší spacák', 'Spaní v chatě', 'Posunout termín'], uncertainty: unc, params: { night, comfort } }));
      } else if (night < comfort) {
        out.push(adv('sleep.bag_insufficient', 'warning', `Noční minimum ${night} °C je pod komfortem spacáku (${comfort} °C).`, { basis, action: 'Přidejte vložku, teplé spaní oblečení a izolační podložku.', alternatives: ['Teplejší spacák', 'Vložka do spacáku'], uncertainty: unc, params: { night, comfort } }));
      } else if (night - comfort < 3) {
        out.push(adv('sleep.bag_marginal', 'info', `Rezerva spacáku je malá: noc ${night} °C proti komfortu ${comfort} °C.`, { basis, action: 'Počítejte s teplým spaním oblečením.', uncertainty: unc, params: { night, comfort } }));
      }
    }
  }

  if (input.waterPlan && !input.waterPlan.sufficient) {
    const deficit = input.waterPlan.deficitL;
    out.push(
      adv('water.deficit', deficit !== undefined && deficit > 2 ? 'danger' : 'warning', `Plán vody nestačí${deficit !== undefined ? ` – chybí asi ${deficit.toFixed(1).replace('.', ',')} l` : ''}.`, {
        basis: ['Výpočet potřeby vody vs. zdroje podél trasy'],
        action: 'Naplánujte doplnění vody, nebo nést větší zásobu (případně filtr na povrchovou vodu).',
        alternatives: ['Přidat zdroj vody u tábora', 'Větší zásoba na úsecích bez vody', 'Filtr / tablety na povrchovou vodu'],
        uncertainty: 'Potřeba vody je odhad podle teploty a převýšení; sezónní prameny mohou vysychat.',
        params: { deficitL: deficit ?? null },
      }),
    );
  }

  if (input.food) {
    const { plannedKcalPerDay: planned, neededKcalPerDay: needed } = input.food;
    if (needed > 0) {
      const ratio = planned / needed;
      if (ratio < 0.9) {
        out.push(adv('food.deficit', ratio < 0.75 ? 'danger' : 'warning', `Plánované jídlo pokryje jen ${Math.round(ratio * 100)} % denní potřeby (${Math.round(planned)} z ${Math.round(needed)} kcal).`, {
          basis: [`Plán ${Math.round(planned)} kcal/den`, `Odhad potřeby ${Math.round(needed)} kcal/den`],
          action: 'Přidejte kalorické jídlo (ořechy, olej, čokoláda, těstoviny).',
          uncertainty: 'Spotřeba energie je odhad; individuální rozdíly bývají ±20 %.',
          params: { ratioPct: Math.round(ratio * 100) },
        }));
      } else if (ratio > 1.25) {
        out.push(adv('food.surplus', 'info', `Jídla je o ${Math.round((ratio - 1) * 100)} % víc než odhadovaná potřeba – zbytečná váha.`, {
          basis: [`Plán ${Math.round(planned)} kcal/den`, `Odhad potřeby ${Math.round(needed)} kcal/den`],
          action: 'Zvažte ubrat část zásob, ponechte rezervu na jeden den.',
          params: { ratioPct: Math.round(ratio * 100) },
        }));
      }
    }
  }

  if (input.packWeights) {
    const { baseG, totalG, targetBaseG, bodyWeightKg } = input.packWeights;
    if (targetBaseG !== undefined && baseG > targetBaseG) {
      out.push(adv('pack.over_target', 'warning', `Základní hmotnost batohu je ${(baseG / 1000).toFixed(2).replace('.', ',')} kg, cíl je ${(targetBaseG / 1000).toFixed(2).replace('.', ',')} kg (o ${Math.round(baseG - targetBaseG)} g víc).`, {
        basis: [`Základní hmotnost ${Math.round(baseG)} g`, `Cíl ${Math.round(targetBaseG)} g`],
        action: 'Použijte návrhy optimalizace vybavení.',
        alternatives: ['Lehčí stan/tarp nebo spacák', 'Vynechat nepodstatné vybavení', 'Slevit z cílové hmotnosti'],
        params: { overG: Math.round(baseG - targetBaseG) },
      }));
    }
    if (bodyWeightKg && bodyWeightKg > 0) {
      const share = totalG / 1000 / bodyWeightKg;
      if (share > 0.2) {
        out.push(adv('pack.heavy_for_body', share > 0.25 ? 'danger' : 'warning', `Batoh s jídlem a vodou váží ${(totalG / 1000).toFixed(1).replace('.', ',')} kg, tedy ${Math.round(share * 100)} % tělesné hmotnosti (doporučeno do 20 %).`, {
          basis: [`Celková hmotnost ${Math.round(totalG)} g`, `Tělesná hmotnost ${bodyWeightKg} kg`],
          action: 'Snižte váhu vybavení nebo jídla, případně zvolte kratší výpravu mezi zásobovacími body.',
          params: { sharePct: Math.round(share * 100) },
        }));
      }
    }
  }

  if (input.power) {
    if (!input.power.sufficient) {
      out.push(adv('power.insufficient', 'danger', 'Kapacita powerbank nepokryje elektroniku po celou výpravu.', {
        basis: ['Výpočet napájení: nedostatečná kapacita'],
        action: 'Vezměte větší powerbanku, solární panel, nebo omezte používání displeje.',
        alternatives: ['Větší powerbanka', 'Solární panel', 'Režim letadlo a stahování map předem'],
      }));
    } else if (input.power.reservePct < MIN_BATTERY_RESERVE_PCT) {
      out.push(adv('power.low_reserve', 'warning', `Rezerva baterií je jen ${Math.round(input.power.reservePct)} % (doporučeno aspoň ${MIN_BATTERY_RESERVE_PCT} %).`, {
        basis: [`Rezerva ${Math.round(input.power.reservePct)} %`],
        action: 'Přidejte kapacitu nebo omezte spotřebu.',
        uncertainty: 'Za chladu kapacita baterií klesá.',
        params: { reservePct: Math.round(input.power.reservePct) },
      }));
    }
  }

  if (input.optimizerSavingsG !== undefined && input.optimizerSavingsG >= 300) {
    out.push(adv('gear.savings_potential', 'info', `Optimalizace vybavení by mohla ušetřit až ${Math.round(input.optimizerSavingsG)} g.`, {
      basis: ['Návrhy optimalizátoru vybavení'],
      action: 'Projděte návrhy v sekci vybavení.',
      params: { savingG: Math.round(input.optimizerSavingsG) },
    }));
  }

  // Weather-driven advisories are passed through, plus one summary when serious.
  const risks = input.forecastRisks ?? [];
  for (const r of risks) out.push({ ...r, alternatives: (r as Partial<RecommendationAdvisory>).alternatives ?? [] });
  if (risks.some((r) => r.severity !== 'info')) {
    const dangerous = risks.some((r) => r.severity === 'danger');
    out.push(adv('weather.consider_changes', dangerous ? 'danger' : 'warning', dangerous ? 'Předpověď obsahuje nebezpečné jevy – zvažte změnu termínu nebo trasy.' : 'Předpověď přináší rizika, která stojí za úpravu plánu.', {
      basis: risks.filter((r) => r.severity !== 'info').map((r) => r.message),
      action: 'Zkontrolujte předpověď těsně před odchodem.',
      alternatives: ['Posunout termín o den či dva', 'Zkrátit etapy a přespat v chatě', 'Zvolit nižší trasu mimo hřeben'],
      uncertainty: 'Předpověď se mění; čím dál je termín, tím je méně jistá.',
    }));
  }

  return prioritize(out);
}

/** Sort by severity (danger first), keep stable order within a severity, drop duplicates (same code + day + message). */
export function prioritize<T extends Advisory>(advisories: readonly T[]): T[] {
  const seen = new Set<string>();
  const unique: { a: T; i: number }[] = [];
  advisories.forEach((a, i) => {
    const key = `${a.code}|${String(a.params?.['day'] ?? '')}|${a.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    unique.push({ a, i });
  });
  return unique.sort((x, y) => SEVERITY_RANK[x.a.severity] - SEVERITY_RANK[y.a.severity] || x.i - y.i).map((u) => u.a);
}
