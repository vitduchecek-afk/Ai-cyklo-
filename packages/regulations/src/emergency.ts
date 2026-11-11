/**
 * Emergency numbers and guidance. Only numbers the curator is confident about
 * are included; everything else defaults to the pan-European 112.
 */
export interface MountainRescue {
  name: string;
  /** Dialable number(s). */
  numbers: string[];
  website: string;
  note?: string;
}

export interface EmergencyInfo {
  countryCode: string;
  /** Czech country name. */
  countryName: string;
  /** Universal emergency number. */
  generalNumber: string;
  /** Other relevant numbers, e.g. ambulance/police. */
  otherNumbers: Array<{ label: string; number: string }>;
  mountainRescue: MountainRescue | null;
  /** Official emergency apps that send your location (if any). */
  apps: string[];
  /** Czech: what to say on the phone. */
  whatToSay: string[];
  reviewedAt: string;
  /** Czech verification reminder. */
  verifyNote: string;
}

const REVIEWED = '2026-11-11';
const VERIFY = 'Čísla ověř před cestou na oficiálním webu záchranné služby; kurátor je nemohl zkontrolovat online.';

export const WHAT_TO_SAY: string[] = [
  'Řekni, kdo jsi a z jakého čísla voláš; neukončuj hovor, dokud ti to dispečink neřekne.',
  'Přesná poloha: GPS souřadnice (z aplikace/telefonu), název místa, nadmořská výška, nejbližší cesta/rozcestí/chata.',
  'Co se stalo, kolik je zraněných, jejich stav (při vědomí, dýchá, krvácí) a jak dlouho se to děje.',
  'Terén a počasí (mlha, vítr, bouřka) – rozhodují o tom, zda může letět vrtulník.',
  'Nech telefon zapnutý a po hovoru ho šetři (letecký režim, jen občas zapnout); nesmí zůstat bez signálu v kapse.',
];

/** Offline safety checklist shown with every trip (Czech). */
export const OFFLINE_SAFETY_CHECKLIST: string[] = [
  'Stáhni offline mapy a trasu (GPX) předem, ověř, že fungují v letovém režimu.',
  'Řekni někomu blízkému trasu, plánované nocleghy a čas, kdy se ozveš; domluv, kdy má volat pomoc.',
  'Nabij telefon a powerbanku, v mrazu drž telefon u těla; zapni úsporný režim.',
  'Ulož si čísla tísňových linek a svoje GPS souřadnice si umíš zjistit offline.',
  'Přibal lékárničku, píšťalku, čelovku s rezervními bateriemi a nouzovou fólii.',
  'Zjisti předpověď počasí těsně před startem a měj plán B (kratší cesta, chata, sestup).',
  'V horách dodržuj zásadu „včas se otočit“ – při zhoršení počasí nebo únavě sestup.',
  'Číslo 112 funguje i bez SIM nebo při jiném operátorovi, pokud je dostupná jakákoli síť; SMS může projít i při slabém signálu.',
];

const E = (countryCode: string, countryName: string, o: Partial<Omit<EmergencyInfo, 'countryCode' | 'countryName'>>): EmergencyInfo => ({
  countryCode,
  countryName,
  generalNumber: '112',
  otherNumbers: [],
  mountainRescue: null,
  apps: [],
  whatToSay: WHAT_TO_SAY,
  reviewedAt: REVIEWED,
  verifyNote: VERIFY,
  ...o,
});

export const EMERGENCY_INFO: Record<string, EmergencyInfo> = {
  CZ: E('CZ', 'Česko', {
    otherNumbers: [
      { label: 'Zdravotnická záchranná služba', number: '155' },
      { label: 'Policie ČR', number: '158' },
    ],
    mountainRescue: { name: 'Horská služba ČR', numbers: ['1210'], website: 'https://www.horskasluzba.cz/', note: 'V horách lze volat i 112.' },
    apps: ['Záchranka'],
  }),
  SK: E('SK', 'Slovensko', {
    otherNumbers: [
      { label: 'Záchranná zdravotná služba', number: '155' },
      { label: 'Policajný zbor', number: '158' },
    ],
    mountainRescue: { name: 'Horská záchranná služba (HZS)', numbers: ['18 300'], website: 'https://www.hzs.sk/', note: 'V horách lze volat i 112.' },
    apps: ['Záchranka'],
  }),
  PL: E('PL', 'Polsko', {
    otherNumbers: [
      { label: 'Pogotowie ratunkowe', number: '999' },
      { label: 'Policja', number: '997' },
    ],
    mountainRescue: { name: 'GOPR / TOPR (Tatry)', numbers: ['985', '+48 601 100 300'], website: 'https://www.topr.pl/', note: 'GOPR: https://www.gopr.pl/. V horách lze volat i 112; aplikace Ratunek odešle polohu.' },
    apps: ['Ratunek'],
  }),
  AT: E('AT', 'Rakousko', {
    otherNumbers: [
      { label: 'Rettung (záchranná služba)', number: '144' },
      { label: 'Polizei', number: '133' },
    ],
    mountainRescue: { name: 'Alpinnotruf / Bergrettung', numbers: ['140'], website: 'https://www.bergrettung.at/', note: 'Alpinnotruf 140; 112 funguje také.' },
  }),
  DE: E('DE', 'Německo', {
    otherNumbers: [{ label: 'Polizei', number: '110' }],
    mountainRescue: { name: 'Bergwacht (přes tísňovou linku 112)', numbers: ['112'], website: 'https://www.bergwacht.de/', note: 'Bergwacht se aktivuje přes 112. Aplikace nora (Notruf-App) odešle polohu.' },
    apps: ['nora'],
  }),
  CH: E('CH', 'Švýcarsko', {
    otherNumbers: [
      { label: 'Sanität (záchranka)', number: '144' },
      { label: 'Polizei', number: '117' },
      { label: 'Feuerwehr (hasiči)', number: '118' },
    ],
    mountainRescue: { name: 'Rega (letecká záchranka)', numbers: ['1414'], website: 'https://www.rega.ch/', note: 'Z hor volej Rega 1414 (nebo 144/112); aplikace Rega odešle polohu.' },
    apps: ['Rega'],
  }),
  IT: E('IT', 'Itálie', {
    otherNumbers: [{ label: 'Emergenza sanitaria (záchranka)', number: '118' }],
    mountainRescue: { name: 'CNSAS (Soccorso Alpino) – přes 118/112', numbers: ['118'], website: 'https://www.cnsas.it/', note: 'V horách volej 118 (zdravotní nouze, aktivuje horskou záchranu) nebo 112.' },
  }),
  HU: E('HU', 'Maďarsko', {}),
  SI: E('SI', 'Slovinsko', { mountainRescue: null }),
};

/** Emergency information for a country; falls back to the universal 112. */
export function emergencyInfoFor(countryCode: string | null | undefined): EmergencyInfo {
  const cc = countryCode?.toUpperCase();
  return (cc && EMERGENCY_INFO[cc]) || E(cc ?? '??', 'Neznámá země', {});
}
