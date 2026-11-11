/**
 * Curated, deliberately conservative overnight-stay / fire rules.
 *
 * HONESTY NOTE: these entries were compiled from the curator's knowledge of
 * the statutes WITHOUT live access to the legislation portals. Section numbers
 * are given where the curator is confident; where a letter/point of a
 * paragraph is uncertain it is omitted and noted. Therefore every entry has
 * `reviewMethod: 'unconfirmed'` and must be re-checked against the linked
 * source before being treated as legal advice. Where unsure the status is
 * 'unverified'. 'verified_allowed' is used ONLY for scope 'designated_site'.
 */
import type { CountryCode, LegalStatus } from '@trailpack/shared';

export type RuleScope =
  | 'general'
  | 'forest'
  | 'national_park'
  | 'protected_landscape_area'
  | 'nature_reserve'
  | 'natural_monument'
  | 'private_land'
  | 'designated_site';

export type RuleActivity = 'bivouac' | 'tent' | 'tarp' | 'hammock' | 'campfire' | 'stove';
export type ReviewMethod = 'statute_text_desk_review' | 'official_guidance' | 'unconfirmed';
export type RuleConfidence = 'high' | 'medium' | 'low';

export interface CampingRule {
  /** Stable id: `<COUNTRY>-<scope>-<activity>`. */
  id: string;
  country: CountryCode | 'GENERIC';
  scope: RuleScope;
  activity: RuleActivity;
  status: LegalStatus;
  /** Czech summary shown to the user. */
  summary: string;
  /** Czech conditions that must be met for 'conditional'. */
  conditions: string[];
  legalBasis: string;
  sourceName: string;
  sourceUrl: string;
  /** ISO date the entry was last reviewed by the curator. */
  reviewedAt: string;
  reviewMethod: ReviewMethod;
  confidence: RuleConfidence;
  notes?: string;
}

export const RULES_REVIEWED_AT = '2026-11-11';

type Base = Omit<CampingRule, 'id' | 'country' | 'scope' | 'activity' | 'reviewedAt' | 'reviewMethod'> & { reviewMethod?: ReviewMethod };

function expand(country: CampingRule['country'], scope: RuleScope, activities: RuleActivity[], base: Base): CampingRule[] {
  return activities.map((activity) => ({
    ...base,
    id: `${country}-${scope}-${activity}`,
    country,
    scope,
    activity,
    reviewedAt: RULES_REVIEWED_AT,
    reviewMethod: base.reviewMethod ?? 'unconfirmed',
  }));
}

const SLEEP: RuleActivity[] = ['bivouac', 'tent', 'tarp', 'hammock'];
const SHELTERS: RuleActivity[] = ['tent', 'tarp', 'hammock'];
const VERIFY = 'Kurátor neměl při sestavení přístup k aktuálnímu znění předpisu; před použitím ověř ve zdroji.';

// ---------------------------------------------------------------------------
// Czech Republic
// ---------------------------------------------------------------------------
const CZ_FOREST_LAW = { legalBasis: 'zákon č. 289/1995 Sb., o lesích (lesní zákon), § 20 odst. 1 (zakázané činnosti v lese)', sourceName: 'zákon č. 289/1995 Sb. (zakonyprolidi.cz)', sourceUrl: 'https://www.zakonyprolidi.cz/cs/1995-289' };
const CZ_NATURE_LAW = { legalBasis: 'zákon č. 114/1992 Sb., o ochraně přírody a krajiny', sourceName: 'zákon č. 114/1992 Sb. (zakonyprolidi.cz)', sourceUrl: 'https://www.zakonyprolidi.cz/cs/1992-114' };

const CZ: CampingRule[] = [
  ...expand('CZ', 'forest', ['tent'], {
    ...CZ_FOREST_LAW,
    status: 'prohibited',
    summary: 'V lese je zakázáno táboření (stanování) mimo místa k tomu vyhrazená.',
    conditions: ['Povoleno jen na vyhrazených tábořištích nebo se souhlasem vlastníka/správce lesa.'],
    confidence: 'medium',
    notes: `Písmeno odstavce 1 není ověřeno. ${VERIFY}`,
  }),
  ...expand('CZ', 'forest', ['tarp', 'hammock'], {
    ...CZ_FOREST_LAW,
    status: 'prohibited',
    summary: 'Přenocování pod tarpem nebo v hamace v lese se obvykle posuzuje jako táboření, které je mimo vyhrazená místa zakázáno.',
    conditions: ['Pouze na vyhrazených místech nebo se souhlasem vlastníka/správce lesa.'],
    confidence: 'low',
    notes: `Jde o výklad pojmu „táboření“, zákon tarp ani hamaku výslovně nezmiňuje. ${VERIFY}`,
  }),
  ...expand('CZ', 'forest', ['bivouac'], {
    ...CZ_FOREST_LAW,
    status: 'conditional',
    summary: 'Nocování bez stanu (bivak) zákon výslovně neřeší, ale v lese je riziko výkladu jako táboření.',
    conditions: ['Bez stanu a bez ohně.', 'Nejvýše jedna noc, nic po sobě nezanechat.', 'Se souhlasem vlastníka, pokud je to možné.', 'Ne v NP, NPR, PR ani v I. zóně CHKO.'],
    confidence: 'low',
    notes: `Jde o výklad, nikoli výslovné povolení. ${VERIFY}`,
  }),
  ...expand('CZ', 'forest', ['campfire'], {
    ...CZ_FOREST_LAW,
    status: 'prohibited',
    summary: 'V lese a ve vzdálenosti menší než 50 m od okraje lesa je zakázáno rozdělávat nebo udržovat oheň mimo místa k tomu vyhrazená.',
    conditions: ['Pouze na vyhrazeném ohništi.', 'Při vyhlášeném zákazu/vysokém stupni požárního nebezpečí nikdy.'],
    confidence: 'medium',
    notes: `Písmeno odstavce 1 není ověřeno. ${VERIFY}`,
  }),
  ...expand('CZ', 'forest', ['stove'], {
    ...CZ_FOREST_LAW,
    status: 'conditional',
    summary: 'Uzavřený plynový/lihový vařič není otevřený oheň, ale lesní zákon zakazuje „oheň“ obecně a výklad není jednotný.',
    conditions: ['Pouze na nehořlavém podkladu, mimo suchý porost a s bezpečným odstupem.', 'Nikdy při vysokém stupni požárního nebezpečí nebo vyhlášeném zákazu.'],
    confidence: 'low',
    notes: `Jde o výklad. ${VERIFY}`,
  }),
  ...expand('CZ', 'national_park', [...SLEEP], {
    ...CZ_NATURE_LAW,
    legalBasis: 'zákon č. 114/1992 Sb., § 16 odst. 1 (národní parky) a návštěvní řád příslušného NP',
    status: 'prohibited',
    summary: 'V národních parcích je zakázáno tábořit mimo místa k tomu vyhrazená; nocování v přírodě (včetně bivaku) zde nepovažuj za dovolené.',
    conditions: ['Pouze vyhrazená tábořiště/kempy a zařízení uvedená v návštěvním řádu.'],
    confidence: 'medium',
    notes: `U bivaku jde o opatrný výklad. ${VERIFY}`,
  }),
  ...expand('CZ', 'national_park', ['campfire'], {
    ...CZ_NATURE_LAW,
    legalBasis: 'zákon č. 114/1992 Sb., § 16 odst. 1 (národní parky)',
    status: 'prohibited',
    summary: 'V národních parcích je zakázáno rozdělávat ohně mimo místa k tomu vyhrazená.',
    conditions: ['Pouze na vyhrazených ohništích.'],
    confidence: 'medium',
    notes: VERIFY,
  }),
  ...expand('CZ', 'national_park', ['stove'], {
    ...CZ_NATURE_LAW,
    legalBasis: 'zákon č. 114/1992 Sb., § 16 odst. 1 a návštěvní řád příslušného NP',
    status: 'unverified',
    summary: 'Použití vařiče v NP mimo vyhrazená místa neumíme potvrdit; řídí se návštěvním řádem konkrétního parku.',
    conditions: [],
    confidence: 'low',
    notes: VERIFY,
  }),
  ...expand('CZ', 'nature_reserve', [...SLEEP, 'campfire'], {
    ...CZ_NATURE_LAW,
    legalBasis: 'zákon č. 114/1992 Sb., § 34 (národní přírodní rezervace, přírodní rezervace) a vyhláška o zřízení rezervace',
    status: 'prohibited',
    summary: 'V NPR a PR jsou nocování mimo vyhrazená místa a rozdělávání ohně v ochranných podmínkách zakázány; vstup bývá omezen na značené cesty.',
    conditions: [],
    confidence: 'medium',
    notes: `Konkrétní podmínky stanoví předpis o vyhlášení dané rezervace. ${VERIFY}`,
  }),
  ...expand('CZ', 'nature_reserve', ['stove'], {
    ...CZ_NATURE_LAW,
    legalBasis: 'zákon č. 114/1992 Sb., § 34',
    status: 'unverified',
    summary: 'Použití vařiče v rezervaci neumíme potvrdit; počítej se zákazem.',
    conditions: [],
    confidence: 'low',
    notes: VERIFY,
  }),
  ...expand('CZ', 'natural_monument', [...SLEEP, 'campfire', 'stove'], {
    ...CZ_NATURE_LAW,
    legalBasis: 'zákon č. 114/1992 Sb., § 36 (přírodní památky) a vyhláška o zřízení památky',
    status: 'unverified',
    summary: 'Podmínky přírodní památky určuje akt o jejím vyhlášení; nocování ani oheň zde neumíme potvrdit.',
    conditions: [],
    confidence: 'low',
    notes: VERIFY,
  }),
  ...expand('CZ', 'protected_landscape_area', [...SLEEP], {
    ...CZ_NATURE_LAW,
    legalBasis: 'zákon č. 114/1992 Sb., § 25–26 (CHKO) a zonace/podmínky konkrétní CHKO',
    status: 'conditional',
    summary: 'CHKO samo o sobě nocování nezakazuje, ale platí lesní zákon i omezení dle zón; v I. zóně je režim nejpřísnější.',
    conditions: ['Mimo I. zónu CHKO a mimo rezervace a památky uvnitř CHKO.', 'V lese platí zákaz táboření (viz lesní zákon).', 'Souhlas vlastníka pozemku.'],
    confidence: 'low',
    notes: VERIFY,
  }),
  ...expand('CZ', 'protected_landscape_area', ['campfire', 'stove'], {
    ...CZ_NATURE_LAW,
    legalBasis: 'zákon č. 114/1992 Sb. a zákon č. 133/1985 Sb., o požární ochraně',
    status: 'conditional',
    summary: 'Mimo les (a nad 50 m od lesa) není oheň národně zakázán, ale v CHKO často platí omezení; při nebezpečí požáru je oheň nezodpovědný.',
    conditions: ['Mimo les a ≥ 50 m od okraje lesa.', 'Souhlas vlastníka, bezpečné ohniště, uhasit.', 'Ne při vyhlášeném zákazu/vysokém nebezpečí požáru.'],
    confidence: 'low',
    notes: VERIFY,
  }),
  ...expand('CZ', 'general', ['bivouac'], {
    legalBasis: 'výklad: žádný předpis nocování bez stanu mimo les a chráněná území výslovně nezakazuje; viz zákon č. 89/2012 Sb. (občanský zákoník, vlastnické právo)',
    sourceName: 'zákon č. 89/2012 Sb. (zakonyprolidi.cz)',
    sourceUrl: 'https://www.zakonyprolidi.cz/cs/2012-89',
    status: 'conditional',
    summary: 'Bivak (spaní bez stanu) mimo les a chráněná území není výslovně upraven – jde o výklad, nikoli o povolení.',
    conditions: ['Bez stanu, jedna noc, nic po sobě nezanechat (leave no trace).', 'S ohledem na práva vlastníka pozemku.', 'Ne v NP, NPR, PR ani v I. zóně CHKO, ne v lese.'],
    confidence: 'low',
    notes: `Interpretace – obecně závazná vyhláška obce může nocování omezit. ${VERIFY}`,
  }),
  ...expand('CZ', 'general', SHELTERS, {
    legalBasis: 'výklad: zákon č. 89/2012 Sb. (vlastnické právo) a případná obecně závazná vyhláška obce',
    sourceName: 'zákon č. 89/2012 Sb. (zakonyprolidi.cz)',
    sourceUrl: 'https://www.zakonyprolidi.cz/cs/2012-89',
    status: 'conditional',
    summary: 'Stanování na otevřené krajině je možné jen se souhlasem vlastníka pozemku a mimo chráněná území; obec může táboření omezit vyhláškou.',
    conditions: ['Souhlas vlastníka pozemku.', 'Mimo les, NP, NPR, PR a I. zónu CHKO.', 'Zkontrolovat vyhlášku obce.'],
    confidence: 'low',
    notes: VERIFY,
  }),
  ...expand('CZ', 'general', ['campfire', 'stove'], {
    legalBasis: 'zákon č. 133/1985 Sb., o požární ochraně, a zákon č. 289/1995 Sb. (vzdálenost 50 m od lesa)',
    sourceName: 'zákon č. 133/1985 Sb. (zakonyprolidi.cz)',
    sourceUrl: 'https://www.zakonyprolidi.cz/cs/1985-133',
    status: 'conditional',
    summary: 'Mimo les a více než 50 m od okraje lesa není oheň národně zakázán, ale vyžaduje souhlas vlastníka a bezpečný postup; vařič je bezpečnější než oheň.',
    conditions: ['≥ 50 m od okraje lesa.', 'Souhlas vlastníka, bezpečné ohniště, dohled a uhasit.', 'Ne při vyhlášeném zákazu/vysokém stupni požárního nebezpečí.'],
    confidence: 'low',
    notes: VERIFY,
  }),
  ...expand('CZ', 'private_land', [...SLEEP, 'campfire', 'stove'], {
    legalBasis: 'zákon č. 89/2012 Sb., občanský zákoník (vlastnické právo, § 1012 a násl.)',
    sourceName: 'zákon č. 89/2012 Sb. (zakonyprolidi.cz)',
    sourceUrl: 'https://www.zakonyprolidi.cz/cs/2012-89',
    status: 'conditional',
    summary: 'Na cizím pozemku je potřeba souhlas vlastníka.',
    conditions: ['Výslovný souhlas vlastníka nebo nájemce.'],
    confidence: 'medium',
    notes: VERIFY,
  }),
  ...expand('CZ', 'designated_site', SLEEP, {
    legalBasis: 'Řád a souhlas provozovatele místa (kemp, tábořiště, oficiální bivakovací místo, přístřešek)',
    sourceName: 'Lesy ČR – turistika v lesích',
    sourceUrl: 'https://www.lesycr.cz/',
    status: 'verified_allowed',
    summary: 'Na skutečně vyhrazeném místě (kemp, tábořiště, oficiální bivak) je nocování povoleno v rámci jeho řádu.',
    conditions: ['Místo musí být opravdu vyhrazené; dodržuj řád a případné poplatky.'],
    confidence: 'high',
    notes: 'Stav konkrétního místa určuje placeLegalStatus; toto pravidlo jen popisuje podmínky.',
  }),
  ...expand('CZ', 'designated_site', ['campfire', 'stove'], {
    legalBasis: 'Řád provozovatele místa',
    sourceName: 'Lesy ČR – turistika v lesích',
    sourceUrl: 'https://www.lesycr.cz/',
    status: 'conditional',
    summary: 'Oheň je povolen jen na vyhrazeném ohništi a jen pokud to řád místa a aktuální stupeň požárního nebezpečí dovolují.',
    conditions: ['Pouze vyhrazené ohniště.', 'Ne při zákazu rozdělávání ohně.'],
    confidence: 'medium',
  }),
];

// ---------------------------------------------------------------------------
// Slovakia
// ---------------------------------------------------------------------------
const SK_FOREST = { legalBasis: 'zákon č. 326/2005 Z. z. o lesoch (ustanovenia o zákazoch činností v lese, cca § 28–29 – číslo paragrafu neoverené)', sourceName: 'zákon č. 326/2005 Z. z. (slov-lex.sk)', sourceUrl: 'https://www.slov-lex.sk/ezbierky/pravne-predpisy/SK/ZZ/2005/326/' };
const SK_NATURE = { legalBasis: 'zákon č. 543/2002 Z. z. o ochrane prírody a krajiny (stupne ochrany § 12–16) a návštevný poriadok územia', sourceName: 'zákon č. 543/2002 Z. z. (slov-lex.sk)', sourceUrl: 'https://www.slov-lex.sk/ezbierky/pravne-predpisy/SK/ZZ/2002/543/' };

const SK: CampingRule[] = [
  ...expand('SK', 'forest', ['campfire'], {
    ...SK_FOREST,
    status: 'prohibited',
    summary: 'Rozkladať oheň v lese a v jeho blízkosti (cca do 50 m) je zakázané mimo vyhradených miest.',
    conditions: ['Iba na vyhradenom ohnisku.', 'Nikdy pri vyhlásenom zákaze alebo vysokom nebezpečenstve požiaru.'],
    confidence: 'medium',
    notes: VERIFY,
  }),
  ...expand('SK', 'forest', [...SLEEP, 'stove'], {
    ...SK_FOREST,
    status: 'unverified',
    summary: 'Nocovanie a varenie v lese mimo vyhradených miest nevieme potvrdiť; vlastník/správca lesa môže vstup a nocovanie obmedziť.',
    conditions: [],
    confidence: 'low',
    notes: VERIFY,
  }),
  ...expand('SK', 'national_park', [...SLEEP, 'campfire'], {
    ...SK_NATURE,
    status: 'prohibited',
    summary: 'V národných parkoch (vyšší stupeň ochrany) je táborenie a rozkladanie ohňa mimo vyhradených miest zakázané; často platí aj zákaz vstupu mimo značených trás.',
    conditions: ['Iba vyhradené kempy/táboriská a zariadenia podľa návštevného poriadku.'],
    confidence: 'medium',
    notes: `Stupeň ochrany záleží od konkrétneho územia (TANAP má prísny režim, zimný bivak zvlášť upravený). ${VERIFY}`,
  }),
  ...expand('SK', 'national_park', ['stove'], { ...SK_NATURE, status: 'unverified', summary: 'Varič mimo vyhradených miest v NP nevieme potvrdiť.', conditions: [], confidence: 'low', notes: VERIFY }),
  ...expand('SK', 'nature_reserve', [...SLEEP, 'campfire', 'stove'], {
    ...SK_NATURE,
    status: 'prohibited',
    summary: 'V rezerváciách (vyšší stupeň ochrany) počítaj so zákazom táborenia, ohňa a vstupu mimo značených trás.',
    conditions: [],
    confidence: 'low',
    notes: VERIFY,
  }),
  ...expand('SK', 'protected_landscape_area', [...SLEEP, 'campfire', 'stove'], {
    ...SK_NATURE,
    status: 'unverified',
    summary: 'Režim chránenej krajinnej oblasti závisí od zóny a konkrétnej vyhlášky; nocovanie ani oheň nevieme potvrdiť.',
    conditions: [],
    confidence: 'low',
    notes: VERIFY,
  }),
  ...expand('SK', 'general', [...SLEEP, 'campfire', 'stove'], {
    legalBasis: 'neoverené – vlastnícke právo (Občiansky zákonník) a obecné nariadenia',
    sourceName: 'Slov-Lex – zbierka zákonov',
    sourceUrl: 'https://www.slov-lex.sk/',
    status: 'unverified',
    summary: 'Pravidlá pre nocovanie a oheň mimo lesov a chránených území na Slovensku nemáme overené.',
    conditions: [],
    confidence: 'low',
    notes: VERIFY,
  }),
  ...expand('SK', 'private_land', [...SLEEP, 'campfire', 'stove'], {
    legalBasis: 'vlastnícke právo (Občiansky zákonník)',
    sourceName: 'Slov-Lex – zbierka zákonov',
    sourceUrl: 'https://www.slov-lex.sk/',
    status: 'conditional',
    summary: 'Na cudzom pozemku je potrebný súhlas vlastníka.',
    conditions: ['Výslovný súhlas vlastníka.'],
    confidence: 'medium',
  }),
  ...expand('SK', 'designated_site', SLEEP, {
    legalBasis: 'Poriadok prevádzkovateľa miesta (kemp, táborisko, oficiálny bivak)',
    sourceName: 'Štátne lesy TANAP / správa lesov',
    sourceUrl: 'https://www.lesy.sk/',
    status: 'verified_allowed',
    summary: 'Na skutočne vyhradenom mieste je nocovanie povolené v rámci jeho poriadku.',
    conditions: ['Miesto musí byť naozaj vyhradené; dodržuj poriadok a poplatky.'],
    confidence: 'high',
    notes: 'Stav konkrétneho miesta určuje placeLegalStatus.',
  }),
  ...expand('SK', 'designated_site', ['campfire', 'stove'], {
    legalBasis: 'Poriadok prevádzkovateľa miesta',
    sourceName: 'Štátne lesy TANAP / správa lesov',
    sourceUrl: 'https://www.lesy.sk/',
    status: 'conditional',
    summary: 'Oheň iba na vyhradenom ohnisku, ak to poriadok a aktuálne nebezpečenstvo požiaru dovoľujú.',
    conditions: ['Iba vyhradené ohnisko.'],
    confidence: 'medium',
  }),
];

// ---------------------------------------------------------------------------
// Poland
// ---------------------------------------------------------------------------
const PL_FOREST = { legalBasis: 'ustawa z dnia 28 września 1991 r. o lasach, art. 30 (zakazy w lasach; numer ustępu/punktu niezweryfikowany)', sourceName: 'ustawa o lasach (isap.sejm.gov.pl)', sourceUrl: 'https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU19910610279' };
const PL_NATURE = { legalBasis: 'ustawa z dnia 16 kwietnia 2004 r. o ochronie przyrody, art. 15 ust. 1 (parki narodowe i rezerwaty przyrody)', sourceName: 'ustawa o ochronie przyrody (isap.sejm.gov.pl)', sourceUrl: 'https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU20040920880' };

const PL: CampingRule[] = [
  ...expand('PL', 'forest', SLEEP, {
    ...PL_FOREST,
    status: 'prohibited',
    summary: 'Nocování v lesích Státních lesů (Lasy Państwowe) mimo vyhrazená místa není bez souhlasu lesní správy dovoleno.',
    conditions: ['Pouze vyhrazená místa (např. program „Zanocuj w lesie“) nebo souhlas nadleśniczego (vedoucího lesní správy).'],
    confidence: 'medium',
    notes: `Opatrná interpretace. ${VERIFY}`,
  }),
  ...expand('PL', 'forest', ['campfire'], {
    ...PL_FOREST,
    status: 'prohibited',
    summary: 'Rozdělávání ohně v lese a v jeho těsné blízkosti je zakázáno mimo místa určená nadleśniczym.',
    conditions: ['Pouze vyhrazené ohniště.', 'Nikdy při zákazu vstupu do lesa / vysokém nebezpečí požáru.'],
    confidence: 'medium',
    notes: VERIFY,
  }),
  ...expand('PL', 'forest', ['stove'], {
    ...PL_FOREST,
    status: 'conditional',
    summary: 'Turistický vařič není otevřený oheň, ale v lese platí zákaz ohně; při vysokém požárním nebezpečí může být vstup do lesa zakázán.',
    conditions: ['Bezpečný nehořlavý podklad, bez suché vegetace.', 'Nikdy při zákazu vstupu do lesa nebo vysokém nebezpečí požáru.'],
    confidence: 'low',
    notes: VERIFY,
  }),
  ...expand('PL', 'designated_site', [...SLEEP], {
    legalBasis: 'regulamin programu „Zanocuj w lesie“ Lasów Państwowych / regulamin miejsca',
    sourceName: 'Lasy Państwowe – Zanocuj w lesie',
    sourceUrl: 'https://www.lasy.gov.pl/pl/informacje/turystyka/zanocuj-w-lesie',
    status: 'conditional',
    summary: 'Program „Zanocuj w lesie“ vymezuje lesní oblasti, kde je nocleg dovolen; platnost je třeba ověřit na oficiální mapě.',
    conditions: ['Zkontroluj oficiální mapu a pravidla programu (počet nocí, zákaz ohně, ochrana přírody).', 'Ohlas pobyt, pokud to pravidla vyžadují.', 'Ne v národním parku ani v rezervaci.'],
    confidence: 'medium',
    notes: `Konkrétní limity (počet nocí atd.) nejsou zde uvedeny, protože je kurátor nemohl ověřit. ${VERIFY}`,
  }),
  ...expand('PL', 'designated_site', ['campfire', 'stove'], {
    legalBasis: 'regulamin miejsca / programu „Zanocuj w lesie“',
    sourceName: 'Lasy Państwowe – Zanocuj w lesie',
    sourceUrl: 'https://www.lasy.gov.pl/pl/informacje/turystyka/zanocuj-w-lesie',
    status: 'conditional',
    summary: 'Oheň jen na vyhrazeném ohništi a jen pokud to pravidla a aktuální požární nebezpečí dovolují; vařič podle pravidel místa.',
    conditions: ['Pouze vyhrazené ohniště / podle pravidel místa.'],
    confidence: 'low',
  }),
  ...expand('PL', 'national_park', [...SLEEP, 'campfire'], {
    ...PL_NATURE,
    status: 'prohibited',
    summary: 'V národních parcích je zakázáno biwakování a rozdělávání ohně mimo vyhrazená místa; platí i zákaz opuštění značených cest.',
    conditions: ['Pouze vyhrazená místa dle řádu parku.'],
    confidence: 'medium',
    notes: `Číslo bodu v art. 15 ust. 1 neověřeno. ${VERIFY}`,
  }),
  ...expand('PL', 'national_park', ['stove'], { ...PL_NATURE, status: 'unverified', summary: 'Použití vařiče mimo vyhrazená místa v NP nelze potvrdit; řiď se řádem parku.', conditions: [], confidence: 'low', notes: VERIFY }),
  ...expand('PL', 'nature_reserve', [...SLEEP, 'campfire'], {
    ...PL_NATURE,
    status: 'prohibited',
    summary: 'V přírodních rezervacích platí zákaz biwakování a rozdělávání ohně (a často i vstup jen po značených cestách).',
    conditions: [],
    confidence: 'medium',
    notes: VERIFY,
  }),
  ...expand('PL', 'nature_reserve', ['stove'], { ...PL_NATURE, status: 'unverified', summary: 'Vařič v rezervaci nelze potvrdit; počítej se zákazem.', conditions: [], confidence: 'low', notes: VERIFY }),
  ...expand('PL', 'protected_landscape_area', [...SLEEP, 'campfire', 'stove'], {
    legalBasis: 'ustawa o ochronie przyrody, art. 17 (park krajobrazowy – zakazy ustanawia sejmik województwa)',
    sourceName: 'ustawa o ochronie przyrody (isap.sejm.gov.pl)',
    sourceUrl: 'https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU20040920880',
    status: 'unverified',
    summary: 'Zákazy v krajinném parku (park krajobrazowy) určuje usnesení sejmiku pro konkrétní park; nelze potvrdit.',
    conditions: [],
    confidence: 'low',
    notes: VERIFY,
  }),
  ...expand('PL', 'general', [...SLEEP, 'campfire', 'stove'], {
    legalBasis: 'neověřeno – právo vlastníka pozemku a gminné předpisy',
    sourceName: 'ISAP – Internetowy System Aktów Prawnych (Sejm)',
    sourceUrl: 'https://isap.sejm.gov.pl/',
    status: 'unverified',
    summary: 'Pravidla pro nocování mimo les a chráněná území v Polsku nemáme ověřena.',
    conditions: [],
    confidence: 'low',
    notes: VERIFY,
  }),
  ...expand('PL', 'private_land', [...SLEEP, 'campfire', 'stove'], {
    legalBasis: 'prawo własności (Kodeks cywilny)',
    sourceName: 'ISAP – Internetowy System Aktów Prawnych (Sejm)',
    sourceUrl: 'https://isap.sejm.gov.pl/',
    status: 'conditional',
    summary: 'Na cizím pozemku je potřeba souhlas vlastníka.',
    conditions: ['Výslovný souhlas vlastníka.'],
    confidence: 'medium',
  }),
];

// ---------------------------------------------------------------------------
// Austria
// ---------------------------------------------------------------------------
const AT_FOREST = { legalBasis: 'Forstgesetz 1975, § 33 (Betreten des Waldes zu Erholungszwecken) und §§ 40–41 (Feuer, Waldbrandgefahr); Paragraphen-Details nicht verifiziert', sourceName: 'Forstgesetz 1975 (ris.bka.gv.at)', sourceUrl: 'https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10010371' };

const AT: CampingRule[] = [
  ...expand('AT', 'forest', ['tent'], {
    ...AT_FOREST,
    status: 'conditional',
    summary: 'Odpočinkové vstupování do lesa je dovoleno, ale lagrování v noci a stanování v lese vyžaduje souhlas majitele lesa.',
    conditions: ['Souhlas majitele lesa.', 'Dodržet zemské předpisy (viz všeobecné pravidlo pro AT).'],
    confidence: 'medium',
    notes: VERIFY,
  }),
  ...expand('AT', 'forest', ['campfire'], {
    ...AT_FOREST,
    status: 'prohibited',
    summary: 'Oheň v lese a v jeho ohrožené zóně je zakázán; při vyhlášené nebezpečí požáru platí úplný zákaz.',
    conditions: ['Pouze vyhrazená ohniště se souhlasem majitele.'],
    confidence: 'medium',
    notes: VERIFY,
  }),
  ...expand('AT', 'general', [...SLEEP], {
    legalBasis: 'zemské zákony (Campinggesetze, Naturschutzgesetze jednotlivých spolkových zemí)',
    sourceName: 'Rechtsinformationssystem des Bundes (RIS)',
    sourceUrl: 'https://www.ris.bka.gv.at/',
    status: 'unverified',
    summary: 'V Rakousku řeší divoké kempování zemské právo; v řadě spolkových zemí je mimo kempy zakázáno. Obecně nelze považovat za povolené.',
    conditions: [],
    confidence: 'low',
    notes: `Výjimky se liší podle země a terénu (např. nouzový bivak). ${VERIFY}`,
  }),
  ...expand('AT', 'general', ['campfire', 'stove'], {
    legalBasis: 'zemské a obecní předpisy; Forstgesetz 1975',
    sourceName: 'Rechtsinformationssystem des Bundes (RIS)',
    sourceUrl: 'https://www.ris.bka.gv.at/',
    status: 'conditional',
    summary: 'Oheň mimo les je závislý na souhlasu majitele a na aktuálním zákazu (Brandschutz); vařič je bezpečnější.',
    conditions: ['Souhlas majitele pozemku.', 'Žádný zákaz ohně / vysoké nebezpečí požáru.'],
    confidence: 'low',
    notes: VERIFY,
  }),
  ...expand('AT', 'national_park', [...SLEEP, 'campfire', 'stove'], {
    legalBasis: 'Nationalparkgesetze der Länder a Verordnungen jednotlivých parků (Hohe Tauern, Gesäuse, Kalkalpen, Donau-Auen, Neusiedler See, Thayatal)',
    sourceName: 'Nationalparks Austria',
    sourceUrl: 'https://www.nationalparksaustria.at/',
    status: 'prohibited',
    summary: 'V rakouských národních parcích je kempování a oheň mimo vyhrazená místa obecně zakázán.',
    conditions: [],
    confidence: 'low',
    notes: `Opatrně nastaveno na zákaz; detaily určuje zemský zákon konkrétního parku. ${VERIFY}`,
  }),
  ...expand('AT', 'nature_reserve', [...SLEEP, 'campfire', 'stove'], {
    legalBasis: 'Naturschutzgesetze der Länder',
    sourceName: 'Rechtsinformationssystem des Bundes (RIS)',
    sourceUrl: 'https://www.ris.bka.gv.at/',
    status: 'unverified',
    summary: 'Přírodní rezervace (Naturschutzgebiet) mívají přísná omezení; nelze potvrdit.',
    conditions: [],
    confidence: 'low',
    notes: VERIFY,
  }),
  ...expand('AT', 'private_land', [...SLEEP, 'campfire', 'stove'], {
    legalBasis: 'Eigentumsrecht (ABGB)',
    sourceName: 'Rechtsinformationssystem des Bundes (RIS)',
    sourceUrl: 'https://www.ris.bka.gv.at/',
    status: 'conditional',
    summary: 'Na cizím pozemku je potřeba souhlas majitele.',
    conditions: ['Výslovný souhlas majitele.'],
    confidence: 'medium',
  }),
  ...expand('AT', 'designated_site', SLEEP, {
    legalBasis: 'Hausordnung des Betreibers (Campingplatz, Biwakplatz, Hütte)',
    sourceName: 'Österreichischer Alpenverein',
    sourceUrl: 'https://www.alpenverein.at/',
    status: 'verified_allowed',
    summary: 'Na skutečně vyhrazeném místě (kemp, oficiální bivakovací místo) je nocování povoleno v rámci jeho řádu.',
    conditions: ['Místo musí být opravdu vyhrazené; dodržuj řád a poplatky.'],
    confidence: 'high',
    notes: 'Stav konkrétního místa určuje placeLegalStatus.',
  }),
  ...expand('AT', 'designated_site', ['campfire', 'stove'], {
    legalBasis: 'Hausordnung des Betreibers',
    sourceName: 'Österreichischer Alpenverein',
    sourceUrl: 'https://www.alpenverein.at/',
    status: 'conditional',
    summary: 'Oheň jen na vyhrazeném ohništi podle řádu místa.',
    conditions: ['Pouze vyhrazené ohniště.'],
    confidence: 'low',
  }),
];

// ---------------------------------------------------------------------------
// Germany
// ---------------------------------------------------------------------------
const DE_FOREST = { legalBasis: 'Bundeswaldgesetz § 14 (Betreten des Waldes) a Landeswaldgesetze; Camping a Feuer upravují zemské zákony', sourceName: 'Bundeswaldgesetz (gesetze-im-internet.de)', sourceUrl: 'https://www.gesetze-im-internet.de/bwaldg/' };
const DE_NATURE = { legalBasis: 'Bundesnaturschutzgesetz §§ 23–24, 59 a zemské zákony / Schutzgebietsverordnungen', sourceName: 'Bundesnaturschutzgesetz (gesetze-im-internet.de)', sourceUrl: 'https://www.gesetze-im-internet.de/bnatschg_2009/' };

const DE: CampingRule[] = [
  ...expand('DE', 'general', SHELTERS, {
    ...DE_FOREST,
    status: 'prohibited',
    summary: 'Divoké kempování (stan, tarp, hamaka) je v Německu zpravidla zakázáno nebo vyžaduje svolení majitele/úřadu; zemské výjimky existují.',
    conditions: ['Souhlas majitele pozemku/lesa nebo úřadu.', 'Použít Trekkingplätze nebo kempy.'],
    confidence: 'medium',
    notes: `Přesné podmínky určuje spolková země. ${VERIFY}`,
  }),
  ...expand('DE', 'general', ['bivouac'], {
    ...DE_FOREST,
    status: 'unverified',
    summary: 'Bivak (jedna noc bez stanu) není jednotně upraven; zemské zákony a majitelé se liší. Nepovažuj za povolené.',
    conditions: [],
    confidence: 'low',
    notes: VERIFY,
  }),
  ...expand('DE', 'forest', [...SLEEP], {
    ...DE_FOREST,
    status: 'prohibited',
    summary: 'Nocování v lese mimo vyhrazená místa je podle většiny zemských lesních zákonů bez souhlasu majitele zakázáno.',
    conditions: ['Souhlas majitele lesa.'],
    confidence: 'low',
    notes: VERIFY,
  }),
  ...expand('DE', 'forest', ['campfire'], {
    ...DE_FOREST,
    status: 'prohibited',
    summary: 'Oheň v lese a v jeho blízkosti je podle zemských lesních zákonů zakázán; při Waldbrandgefahr platí úplný zákaz.',
    conditions: ['Pouze vyhrazená ohniště se souhlasem majitele.'],
    confidence: 'medium',
    notes: VERIFY,
  }),
  ...expand('DE', 'general', ['campfire', 'stove'], {
    ...DE_FOREST,
    status: 'conditional',
    summary: 'Oheň a vařič v krajině jsou omezeny zemskými předpisy a aktuálním Waldbrandgefahr; vyžaduje souhlas majitele.',
    conditions: ['Souhlas majitele.', 'Žádný zákaz ohně / vysoká požární hrozba.'],
    confidence: 'low',
    notes: VERIFY,
  }),
  ...expand('DE', 'national_park', [...SLEEP, 'campfire', 'stove'], {
    ...DE_NATURE,
    status: 'prohibited',
    summary: 'V národních parcích a přírodních rezervacích je nocování mimo vyhrazená místa a oheň zakázán.',
    conditions: [],
    confidence: 'medium',
    notes: VERIFY,
  }),
  ...expand('DE', 'nature_reserve', [...SLEEP, 'campfire', 'stove'], {
    ...DE_NATURE,
    status: 'prohibited',
    summary: 'V Naturschutzgebiet je nocování a oheň zpravidla zakázán a často je omezen i pohyb mimo cesty.',
    conditions: [],
    confidence: 'medium',
    notes: VERIFY,
  }),
  ...expand('DE', 'private_land', [...SLEEP, 'campfire', 'stove'], {
    legalBasis: 'Eigentumsrecht (BGB)',
    sourceName: 'Bundeswaldgesetz (gesetze-im-internet.de)',
    sourceUrl: 'https://www.gesetze-im-internet.de/bwaldg/',
    status: 'conditional',
    summary: 'Na cizím pozemku je potřeba souhlas majitele.',
    conditions: ['Výslovný souhlas majitele.'],
    confidence: 'medium',
  }),
  ...expand('DE', 'designated_site', SLEEP, {
    legalBasis: 'Platzordnung (Campingplatz, Trekkingplatz)',
    sourceName: 'Bundeswaldgesetz (gesetze-im-internet.de)',
    sourceUrl: 'https://www.gesetze-im-internet.de/bwaldg/',
    status: 'verified_allowed',
    summary: 'Na skutečně vyhrazeném místě (kemp, Trekkingplatz) je nocování povoleno v rámci jeho řádu.',
    conditions: ['Místo musí být opravdu vyhrazené; často nutná rezervace.'],
    confidence: 'high',
    notes: 'Stav konkrétního místa určuje placeLegalStatus.',
  }),
  ...expand('DE', 'designated_site', ['campfire', 'stove'], {
    legalBasis: 'Platzordnung',
    sourceName: 'Bundeswaldgesetz (gesetze-im-internet.de)',
    sourceUrl: 'https://www.gesetze-im-internet.de/bwaldg/',
    status: 'conditional',
    summary: 'Oheň jen na vyhrazeném ohništi podle řádu místa.',
    conditions: ['Pouze vyhrazené ohniště.'],
    confidence: 'low',
  }),
];

// ---------------------------------------------------------------------------
// Switzerland
// ---------------------------------------------------------------------------
const CH: CampingRule[] = [
  ...expand('CH', 'forest', [...SLEEP], {
    legalBasis: 'ZGB Art. 699 (Zutritt zu Wald und Weide) a kantonální předpisy (WaG Art. 14)',
    sourceName: 'Schweizerisches Zivilgesetzbuch (fedlex.admin.ch)',
    sourceUrl: 'https://www.fedlex.admin.ch/eli/cc/24/233_245_233/de',
    status: 'unverified',
    summary: 'Vstup do lesa je v rozumné míře volný, ale nocování a stany upravují kantony; nepovažuj za povolené.',
    conditions: [],
    confidence: 'low',
    notes: VERIFY,
  }),
  ...expand('CH', 'forest', ['campfire'], {
    legalBasis: 'kantonální předpisy (Waldgesetze, Feuerverbote)',
    sourceName: 'WaldSchweiz',
    sourceUrl: 'https://www.waldschweiz.ch/',
    status: 'conditional',
    summary: 'Oheň v lese je obvykle jen na oficiálních ohništích a při vyhlášeném Feuerverbot je zakázán.',
    conditions: ['Pouze oficiální ohniště.', 'Zkontrolovat kantonální Feuerverbot.'],
    confidence: 'low',
    notes: VERIFY,
  }),
  ...expand('CH', 'general', [...SLEEP, 'campfire', 'stove'], {
    legalBasis: 'kantonální předpisy a ZGB Art. 699',
    sourceName: 'Schweizerisches Zivilgesetzbuch (fedlex.admin.ch)',
    sourceUrl: 'https://www.fedlex.admin.ch/eli/cc/24/233_245_233/de',
    status: 'unverified',
    summary: 'Divoké kempování řeší kantony a obce (od tolerance po pokuty); nepovažuj za povolené.',
    conditions: [],
    confidence: 'low',
    notes: VERIFY,
  }),
  ...expand('CH', 'national_park', [...SLEEP, 'campfire', 'stove'], {
    legalBasis: 'Bundesgesetz über den Schweizerischen Nationalpark a Parkordnung',
    sourceName: 'Schweizerischer Nationalpark',
    sourceUrl: 'https://www.nationalpark.ch/',
    status: 'prohibited',
    summary: 'Ve Švýcarském národním parku je kempování, bivak a oheň zakázán; povolené jsou jen značené cesty a vyhrazená místa.',
    conditions: [],
    confidence: 'medium',
    notes: VERIFY,
  }),
  ...expand('CH', 'nature_reserve', [...SLEEP, 'campfire', 'stove'], {
    legalBasis: 'kantonální Banngebiete / Naturschutzverordnungen',
    sourceName: 'Bundesamt für Umwelt (BAFU)',
    sourceUrl: 'https://www.bafu.admin.ch/',
    status: 'unverified',
    summary: 'Chráněná území a Wildruhezonen mají zvláštní omezení; nepovažuj za povolené.',
    conditions: [],
    confidence: 'low',
    notes: VERIFY,
  }),
  ...expand('CH', 'private_land', [...SLEEP, 'campfire', 'stove'], {
    legalBasis: 'Eigentumsrecht (ZGB)',
    sourceName: 'Schweizerisches Zivilgesetzbuch (fedlex.admin.ch)',
    sourceUrl: 'https://www.fedlex.admin.ch/eli/cc/24/233_245_233/de',
    status: 'conditional',
    summary: 'Na cizím pozemku je potřeba souhlas majitele.',
    conditions: ['Výslovný souhlas majitele.'],
    confidence: 'medium',
  }),
  ...expand('CH', 'designated_site', SLEEP, {
    legalBasis: 'Platzordnung (Camping, SAC-Hütten, offizielle Biwakplätze)',
    sourceName: 'Schweizer Alpen-Club SAC',
    sourceUrl: 'https://www.sac-cas.ch/',
    status: 'verified_allowed',
    summary: 'Na skutečně vyhrazeném místě (kemp, oficiální bivak) je nocování povoleno v rámci jeho řádu.',
    conditions: ['Místo musí být opravdu vyhrazené; dodržuj řád a poplatky.'],
    confidence: 'high',
    notes: 'Stav konkrétního místa určuje placeLegalStatus.',
  }),
  ...expand('CH', 'designated_site', ['campfire', 'stove'], {
    legalBasis: 'Platzordnung',
    sourceName: 'Schweizer Alpen-Club SAC',
    sourceUrl: 'https://www.sac-cas.ch/',
    status: 'conditional',
    summary: 'Oheň jen na vyhrazeném ohništi a mimo Feuerverbot.',
    conditions: ['Pouze vyhrazené ohniště.'],
    confidence: 'low',
  }),
];

/** Generic fallback for countries without curated rules: nothing is assumed allowed. */
export const GENERIC_RULES: CampingRule[] = [
  ...expand('GENERIC', 'general', [...SLEEP, 'campfire', 'stove'], {
    legalBasis: 'Pro tuto zemi nemáme kurátorovaná pravidla.',
    sourceName: 'Oficiální úřad dané země / správa lesů a parků',
    sourceUrl: 'https://europa.eu/youreurope/',
    status: 'unverified',
    summary: 'Pravidla pro nocování a oheň v této zemi nemáme ověřena – nepovažuj nocování za povolené.',
    conditions: [],
    confidence: 'low',
    notes: 'Zeptej se místního správce území / obce.',
  }),
];

/** Curated rules per ISO country code. */
export const COUNTRY_RULES: Record<string, CampingRule[]> = { CZ, SK, PL, AT, DE, CH };

export const SUPPORTED_RULE_COUNTRIES: readonly string[] = Object.keys(COUNTRY_RULES);

/** Rules for a country; generic fallback (all 'unverified') for countries without curated rules. */
export function rulesForCountry(code: string | undefined): CampingRule[] {
  if (!code) return GENERIC_RULES;
  return COUNTRY_RULES[code.toUpperCase()] ?? GENERIC_RULES;
}
