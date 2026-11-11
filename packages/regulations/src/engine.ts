/**
 * Camping / fire regulation checker. Pure and offline. The result is the
 * MOST RESTRICTIVE status among all applicable rules; unknown never becomes
 * "allowed".
 */
import type { CountryCode, LegalStatus, ProtectedAreaInfo, SleepType } from '@trailpack/shared';
import { RULES_REVIEWED_AT, rulesForCountry, type CampingRule, type RuleActivity, type RuleScope } from './rules';

export type LandType = 'forest' | 'open' | 'private' | 'designated_site' | 'unknown';

export interface CampingCheckInput {
  countryCode?: CountryCode;
  protectedAreas: ProtectedAreaInfo[];
  landType?: LandType;
  sleepType: SleepType;
  /** User intends to make an open fire. */
  campfire?: boolean;
  /** User intends to use a stove. */
  stove?: boolean;
  /** Legal status of the concrete place (e.g. a campsite record); used for designated sites. */
  placeLegalStatus?: LegalStatus;
  /** Planned date (ISO); reserved for seasonal fire-danger hints. */
  date?: string;
}

export interface ActivityResult {
  activity: RuleActivity | 'designated_stay';
  status: LegalStatus;
  rules: CampingRule[];
  /** Czech reasons. */
  reasons: string[];
}

export interface RegulationSource {
  name: string;
  url: string;
  reviewedAt: string;
}

export interface CampingCheckResult {
  overall: LegalStatus;
  activityResults: ActivityResult[];
  sources: RegulationSource[];
  /** Czech disclaimer, always shown with the result. */
  disclaimer: string;
  /** Czech list of information that was missing and made the result more conservative. */
  missingInfo: string[];
}

export const DISCLAIMER =
  'Informativní přehled sestavený bez přístupu k aktuálnímu znění předpisů – nenahrazuje právní poradenství. Pravidla se liší podle obce, správce území a aktuálních zákazů (např. požárních). Co není ověřeno, nepovažuj za povolené; před nocováním se ověř u správce území nebo vlastníka pozemku.';

/** Restrictiveness order: higher = more restrictive. 'unverified' outranks 'conditional' so uncertainty is never hidden. */
const RANK: Record<LegalStatus, number> = { verified_allowed: 0, conditional: 1, unverified: 2, prohibited: 3 };
export const moreRestrictive = (a: LegalStatus, b: LegalStatus): LegalStatus => (RANK[b] > RANK[a] ? b : a);
export const mostRestrictive = (list: LegalStatus[]): LegalStatus => list.reduce<LegalStatus>(moreRestrictive, 'verified_allowed');

const DESIGNATED: ReadonlySet<SleepType> = new Set<SleepType>(['shelter', 'emergency_hut', 'official_bivouac_site', 'campground', 'mountain_hut', 'paid_lodging']);

/** Map a sleeping style to the rule activity ('designated_site' for official places). */
export function sleepActivity(s: SleepType): RuleActivity | 'designated_site' {
  switch (s) {
    case 'open_air':
    case 'bivy_bag':
      return 'bivouac';
    case 'tarp':
      return 'tarp';
    case 'tent':
      return 'tent';
    case 'hammock':
      return 'hammock';
    default:
      return 'designated_site';
  }
}

const SCOPE_LABEL: Record<RuleScope, string> = {
  general: 'Volná krajina',
  forest: 'Les',
  national_park: 'Národní park',
  protected_landscape_area: 'Chráněná krajinná oblast',
  nature_reserve: 'Přírodní rezervace',
  natural_monument: 'Přírodní památka',
  private_land: 'Soukromý pozemek',
  designated_site: 'Vyhrazené místo',
};

const KIND_SCOPE: Partial<Record<ProtectedAreaInfo['kind'], RuleScope>> = {
  national_park: 'national_park',
  protected_landscape_area: 'protected_landscape_area',
  nature_reserve: 'nature_reserve',
  natural_monument: 'natural_monument',
};

const STATUS_CS: Record<LegalStatus, string> = {
  verified_allowed: 'povoleno',
  conditional: 'podmíněně',
  prohibited: 'zakázáno',
  unverified: 'neověřeno',
};

const isZoneOne = (z: string | undefined) => !!z && /^(i|1|první|i\.)$/i.test(z.trim());

/** Check overnight-stay and fire rules for a place. */
export function checkCampingRegulations(input: CampingCheckInput): CampingCheckResult {
  const missing: string[] = [];
  const country = input.countryCode;
  const sleepAct = sleepActivity(input.sleepType);
  const designated = sleepAct === 'designated_site' || input.landType === 'designated_site' || DESIGNATED.has(input.sleepType);
  const rules = rulesForCountry(country);
  const results: ActivityResult[] = [];

  if (!country) missing.push('Země není známa – použita obecná (neověřená) pravidla; zjisti zemi z polohy nebo ji zadej ručně.');
  else if (rules.every((r) => r.country === 'GENERIC')) missing.push(`Pro zemi ${country} nemáme kurátorovaná pravidla – výsledek je obecně „neověřeno“.`);
  if (!designated && (input.landType === undefined || input.landType === 'unknown')) missing.push('Typ pozemku (les / volná krajina / soukromý) není znám – zohledněna nejpřísnější možnost (les).');
  if (input.protectedAreas.length === 0 && !designated) missing.push('Nejsou k dispozici data o chráněných územích – nelze vyloučit národní park, rezervaci nebo I. zónu CHKO.');
  if (!input.date && (input.campfire || input.stove)) missing.push('Datum není zadáno – aktuální stupeň požárního nebezpečí a vyhlášené zákazy ohně nelze zohlednit.');

  const scopesFor = (): RuleScope[] => {
    switch (input.landType) {
      case 'forest':
        return ['forest'];
      case 'open':
        return ['general'];
      case 'private':
        return ['private_land', 'general'];
      default:
        return ['forest', 'general'];
    }
  };

  const evaluate = (activity: RuleActivity): ActivityResult => {
    const reasons: string[] = [];
    const applied: CampingRule[] = [];
    let status: LegalStatus = 'verified_allowed';
    const apply = (scope: RuleScope, label: string) => {
      const found = rules.filter((r) => r.scope === scope && r.activity === activity);
      if (found.length === 0) {
        status = moreRestrictive(status, 'unverified');
        reasons.push(`${label}: pro tuto činnost nemáme kurátorované pravidlo – neověřeno.`);
        return;
      }
      for (const r of found) {
        applied.push(r);
        status = moreRestrictive(status, r.status);
        const doubt = r.confidence === 'low' ? ' (nízká jistota, výklad)' : '';
        reasons.push(`${label}: ${r.summary}${doubt}`);
        if (r.conditions.length && r.status === 'conditional') reasons.push(`Podmínky: ${r.conditions.join(' ')}`);
      }
    };

    if (designated) {
      // Official places: the place's own legal status decides; never upgraded by generic rules.
      const placeStatus = input.placeLegalStatus ?? 'unverified';
      status = placeStatus;
      reasons.push(
        input.placeLegalStatus
          ? `Vyhrazené místo: stav „${STATUS_CS[placeStatus]}“ podle záznamu místa.`
          : 'Vyhrazené místo: právní stav konkrétního místa není ověřen – neověřeno.',
      );
      const siteRules = rules.filter((r) => r.scope === 'designated_site' && r.activity === activity);
      applied.push(...siteRules);
      for (const r of siteRules) if (r.conditions.length) reasons.push(`Podmínky místa: ${r.conditions.join(' ')}`);
      if (activity === 'campfire' || activity === 'stove') {
        if (placeStatus === 'verified_allowed') status = 'conditional';
        reasons.push('Oheň a vařič jsou i na vyhrazeném místě podmíněné řádem místa a aktuálním požárním nebezpečím.');
      }
      return { activity, status, rules: applied, reasons };
    }

    for (const scope of scopesFor()) apply(scope, SCOPE_LABEL[scope]);
    for (const area of input.protectedAreas) {
      const areaCountry = area.countryCode ?? country;
      if (areaCountry && country && areaCountry !== country) continue;
      const scope = KIND_SCOPE[area.kind];
      if (!scope) {
        reasons.push(`${area.name}: Natura 2000 / jiné označení samo o sobě nocování neurčuje – ověř návštěvní řád území.`);
        continue;
      }
      apply(scope, `${SCOPE_LABEL[scope]} ${area.name}`);
      if (scope === 'protected_landscape_area' && isZoneOne(area.zone)) {
        status = moreRestrictive(status, 'unverified');
        reasons.push(`${area.name}: I. zóna CHKO má nejpřísnější režim – nocování zde nepovažuj za dovolené.`);
      }
    }
    if (input.placeLegalStatus === 'prohibited') {
      status = 'prohibited';
      reasons.push('Záznam místa uvádí zákaz.');
    }
    if (activity === 'campfire' || activity === 'stove') reasons.push('Při vyhlášeném zákazu rozdělávání ohně nebo vysokém stupni požárního nebezpečí je oheň (a často i vařič) zakázán bez ohledu na výše uvedené.');
    if (applied.some((r) => r.country === 'GENERIC')) status = moreRestrictive(status, 'unverified');
    return { activity, status, rules: applied, reasons };
  };

  const sleepRuleActivity: RuleActivity = sleepAct === 'designated_site' ? 'bivouac' : sleepAct;
  // For designated places the "sleep" row is keyed on the real sleeping style (tent etc.) where meaningful.
  const first = evaluate(sleepRuleActivity);
  results.push(designated ? { ...first, activity: 'designated_stay' } : first);
  if (input.campfire) results.push(evaluate('campfire'));
  if (input.stove) results.push(evaluate('stove'));

  let overall = mostRestrictive(results.map((r) => r.status));
  if (!country) overall = 'unverified';

  const seen = new Map<string, RegulationSource>();
  for (const r of results.flatMap((x) => x.rules)) if (!seen.has(r.sourceUrl)) seen.set(r.sourceUrl, { name: r.sourceName, url: r.sourceUrl, reviewedAt: r.reviewedAt });
  const sources = [...seen.values()];
  if (sources.length === 0) sources.push({ name: 'Oficiální úřad dané země / správa lesů a parků', url: 'https://europa.eu/youreurope/', reviewedAt: RULES_REVIEWED_AT });

  return { overall, activityResults: results, sources, disclaimer: DISCLAIMER, missingInfo: missing };
}
