import { describe, expect, it } from 'vitest';
import { HttpClient, type ProtectedAreaInfo } from '@trailpack/shared';
import {
  COUNTRY_POLYGONS,
  COUNTRY_RULES,
  EMERGENCY_INFO,
  GENERIC_RULES,
  checkCampingRegulations,
  detectCountryOffline,
  detectCountryOnline,
  emergencyInfoFor,
  rulesForCountry,
} from '../src';

const np = (name = 'NP Šumava'): ProtectedAreaInfo => ({ name, kind: 'national_park', countryCode: 'CZ' });

describe('checkCampingRegulations', () => {
  it('NP prohibits tent and the most restrictive status wins overall', () => {
    const r = checkCampingRegulations({ countryCode: 'CZ', protectedAreas: [np()], landType: 'open', sleepType: 'tent', campfire: false });
    expect(r.activityResults[0]!.activity).toBe('tent');
    expect(r.activityResults[0]!.status).toBe('prohibited');
    expect(r.overall).toBe('prohibited');
    expect(r.activityResults[0]!.reasons.join(' ')).toMatch(/národní park/i);
  });

  it('most restrictive across activities: tolerated bivouac is conditional, campfire in forest makes overall prohibited', () => {
    const bivouacOnly = checkCampingRegulations({ countryCode: 'CZ', protectedAreas: [], landType: 'open', sleepType: 'open_air' });
    expect(bivouacOnly.overall).toBe('conditional');
    const withFire = checkCampingRegulations({ countryCode: 'CZ', protectedAreas: [], landType: 'forest', sleepType: 'open_air', campfire: true });
    expect(withFire.activityResults.map((a) => a.activity)).toEqual(['bivouac', 'campfire']);
    expect(withFire.activityResults[1]!.status).toBe('prohibited');
    expect(withFire.overall).toBe('prohibited');
  });

  it('unknown country -> unverified and never allowed', () => {
    const r = checkCampingRegulations({ protectedAreas: [], landType: 'open', sleepType: 'tent' });
    expect(r.overall).toBe('unverified');
    expect(r.missingInfo.join(' ')).toMatch(/Země není známa/);
    const fr = checkCampingRegulations({ countryCode: 'FR', protectedAreas: [], landType: 'open', sleepType: 'tent' });
    expect(fr.overall).toBe('unverified');
  });

  it('unknown land type is treated conservatively (forest) and reported as missing info', () => {
    const r = checkCampingRegulations({ countryCode: 'CZ', protectedAreas: [], sleepType: 'tent' });
    expect(r.overall).toBe('prohibited');
    expect(r.missingInfo.join(' ')).toMatch(/Typ pozemku/);
  });

  it('designated sites use placeLegalStatus and default to unverified', () => {
    const base = { countryCode: 'CZ', protectedAreas: [], landType: 'designated_site' as const, sleepType: 'campground' as const };
    expect(checkCampingRegulations({ ...base, placeLegalStatus: 'verified_allowed' }).overall).toBe('verified_allowed');
    expect(checkCampingRegulations({ ...base, placeLegalStatus: 'conditional' }).overall).toBe('conditional');
    expect(checkCampingRegulations({ ...base, placeLegalStatus: 'prohibited' }).overall).toBe('prohibited');
    expect(checkCampingRegulations(base).overall).toBe('unverified');
    // huts/lodging behave the same, even inside a national park
    const hut = checkCampingRegulations({ countryCode: 'CZ', protectedAreas: [np()], sleepType: 'mountain_hut', placeLegalStatus: 'verified_allowed' });
    expect(hut.overall).toBe('verified_allowed');
    expect(hut.activityResults[0]!.activity).toBe('designated_stay');
  });

  it('fire at an allowed designated site is still conditional', () => {
    const r = checkCampingRegulations({ countryCode: 'CZ', protectedAreas: [], sleepType: 'official_bivouac_site', placeLegalStatus: 'verified_allowed', campfire: true });
    expect(r.overall).toBe('conditional');
  });

  it('I. zone of a CHKO is not treated as allowed', () => {
    const chko: ProtectedAreaInfo = { name: 'CHKO Jeseníky', kind: 'protected_landscape_area', zone: 'I', countryCode: 'CZ' };
    const r = checkCampingRegulations({ countryCode: 'CZ', protectedAreas: [chko], landType: 'open', sleepType: 'open_air' });
    expect(['unverified', 'prohibited']).toContain(r.overall);
  });

  it('returns sources, disclaimer and review dates', () => {
    const r = checkCampingRegulations({ countryCode: 'PL', protectedAreas: [], landType: 'forest', sleepType: 'tent', stove: true });
    expect(r.sources.length).toBeGreaterThan(0);
    for (const s of r.sources) {
      expect(s.url).toMatch(/^https:\/\//);
      expect(s.reviewedAt).toBe('2026-11-11');
    }
    expect(r.disclaimer).toMatch(/nenahrazuje právní poradenství/);
    expect(r.activityResults.map((a) => a.activity)).toEqual(['tent', 'stove']);
  });
});

describe('rules data integrity', () => {
  const all = [...Object.values(COUNTRY_RULES).flat(), ...GENERIC_RULES];
  it('has unique ids, Czech-bearing summaries and https sources', () => {
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
    for (const r of all) {
      expect(r.summary.length).toBeGreaterThan(10);
      expect(r.sourceUrl).toMatch(/^https:\/\//);
      expect(r.reviewedAt).toBe('2026-11-11');
      expect(r.legalBasis.length).toBeGreaterThan(5);
    }
  });
  it("uses 'verified_allowed' only for designated sites", () => {
    expect(all.filter((r) => r.status === 'verified_allowed').every((r) => r.scope === 'designated_site')).toBe(true);
  });
  it('covers CZ, SK, PL, AT, DE, CH and falls back to unverified generic rules', () => {
    for (const c of ['CZ', 'SK', 'PL', 'AT', 'DE', 'CH']) expect(COUNTRY_RULES[c]!.length).toBeGreaterThan(5);
    expect(rulesForCountry('FR').every((r) => r.status === 'unverified')).toBe(true);
  });
  it('encodes the known Czech provisions', () => {
    const cz = COUNTRY_RULES.CZ!;
    expect(cz.find((r) => r.id === 'CZ-forest-campfire')!.status).toBe('prohibited');
    expect(cz.find((r) => r.id === 'CZ-forest-campfire')!.summary).toMatch(/50 m/);
    expect(cz.find((r) => r.id === 'CZ-national_park-tent')!.legalBasis).toMatch(/114\/1992/);
    expect(cz.find((r) => r.id === 'CZ-general-bivouac')!.notes).toMatch(/Interpretace/);
    expect(COUNTRY_RULES.PL!.find((r) => r.scope === 'designated_site' && r.activity === 'tent')!.status).toBe('conditional');
  });
});

describe('detectCountryOffline', () => {
  it.each([
    ['Praha', 50.0755, 14.4378, 'CZ'],
    ['Bratislava', 48.1486, 17.1077, 'SK'],
    ['Kraków', 50.0647, 19.945, 'PL'],
    ['Wien', 48.2082, 16.3738, 'AT'],
    ['München', 48.1351, 11.582, 'DE'],
    ['Zürich', 47.3769, 8.5417, 'CH'],
    ['Budapest', 47.4979, 19.0402, 'HU'],
    ['Ljubljana', 46.0569, 14.5058, 'SI'],
  ])('%s -> %s', (_n, lat, lon, cc) => {
    expect(detectCountryOffline(lat, lon).countryCode).toBe(cc);
  });

  it('is high confidence in the interior and low near a border', () => {
    expect(detectCountryOffline(49.8, 15.5).confidence).toBe('high'); // Czech interior
    expect(detectCountryOffline(50.0755, 14.4378).confidence).toBe('high');
    const border = detectCountryOffline(49.7466, 18.632); // Český Těšín / Cieszyn
    expect(border.confidence).toBe('low');
    expect(['CZ', 'PL']).toContain(border.countryCode);
    expect(detectCountryOffline(48.1486, 17.1077).confidence).toBe('low'); // Bratislava sits on the border
  });

  it('returns null / none far from supported countries', () => {
    expect(detectCountryOffline(40.4, -3.7)).toMatchObject({ countryCode: null, confidence: 'none' });
  });

  it('polygons have 30-80 vertices each', () => {
    for (const [code, ring] of Object.entries(COUNTRY_POLYGONS)) {
      expect(ring.length, code).toBeGreaterThanOrEqual(30);
      expect(ring.length, code).toBeLessThanOrEqual(80);
    }
  });
});

describe('detectCountryOnline', () => {
  it('reads address.country_code from Nominatim', async () => {
    const calls: string[] = [];
    const http = new HttpClient({
      minIntervalMsPerHost: {},
      fetch: async (url) => {
        calls.push(url);
        return new Response(JSON.stringify({ address: { country_code: 'cz' } }), { status: 200 });
      },
    });
    const r = await detectCountryOnline(http, 50.07, 14.43);
    expect(r).toMatchObject({ countryCode: 'CZ', confidence: 'high', source: 'nominatim' });
    expect(calls[0]).toContain('nominatim.openstreetmap.org/reverse');
  });
});

describe('emergency info', () => {
  it('has the confident mountain rescue numbers', () => {
    expect(EMERGENCY_INFO.CZ!.mountainRescue!.numbers).toContain('1210');
    expect(EMERGENCY_INFO.SK!.mountainRescue!.numbers).toContain('18 300');
    expect(EMERGENCY_INFO.PL!.mountainRescue!.numbers).toEqual(expect.arrayContaining(['985', '+48 601 100 300']));
    expect(EMERGENCY_INFO.AT!.mountainRescue!.numbers).toContain('140');
    expect(EMERGENCY_INFO.CH!.mountainRescue!.numbers).toContain('1414');
    expect(EMERGENCY_INFO.IT!.mountainRescue!.numbers).toContain('118');
    expect(EMERGENCY_INFO.DE!.generalNumber).toBe('112');
  });
  it('always carries guidance, review date and a verify note; unknown countries fall back to 112', () => {
    for (const e of Object.values(EMERGENCY_INFO)) {
      expect(e.whatToSay.length).toBeGreaterThan(2);
      expect(e.reviewedAt).toBe('2026-11-11');
      expect(e.verifyNote).toMatch(/ověř/);
    }
    expect(emergencyInfoFor('FR').generalNumber).toBe('112');
    expect(emergencyInfoFor(null).countryName).toBe('Neznámá země');
  });
});
