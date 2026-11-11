import { describe, expect, it } from 'vitest';
import { parseTripRequest } from '../src/planner/parse';

// Wednesday 2026-06-03 (local time)
const NOW = new Date(2026, 5, 3, 10, 0, 0);

describe('parseTripRequest', () => {
  it('parses the full Czech example', () => {
    const r = parseTripRequest(
      'Chci na čtyři dny přejít Beskydy. Denně maximálně 20 km, chci spát venku, mít základní hmotnost batohu pod 4 kg a vyhnout se dešti. Mám spacák s komfortem 0 °C, batoh 50 litrů a powerbanku 10 000 mAh. Naplánuj mi všechno.',
      NOW,
    );
    expect(r.fields).toMatchObject({
      days: 4,
      region: 'Beskydy',
      countryCode: 'CZ',
      maxDailyKm: 20,
      sleepType: 'open_air',
      targetBaseWeightG: 4000,
      avoidRain: true,
      weatherAware: true,
      gear: { sleepingBagComfortC: 0, packVolumeL: 50, powerbankMah: 10000 },
    });
    expect(r.missing.some((m) => m.includes('Kdy'))).toBe(true);
    expect(r.missing.some((m) => m.includes('oblasti'))).toBe(false);
    expect(r.confidence).toBeGreaterThan(0.7);
  });

  it('parses "třídenní trek v Jeseníkách … bez kempu"', () => {
    const r = parseTripRequest('Naplánuj mi třídenní trek v Jeseníkách s lehkým batohem, bez kempu a s maximálně 15 km denně.', NOW);
    expect(r.fields).toMatchObject({ days: 3, region: 'Jeseníky', maxDailyKm: 15, excludeCampgrounds: true, lightweight: true, activity: 'trekking' });
    expect(r.fields.sleepType).toBeUndefined();
    expect(r.missing.some((m) => m.includes('spát'))).toBe(true);
  });

  it('parses legal-only, weather-aware request with declined region', () => {
    const r = parseTripRequest(
      'Naplánuj mi třídenní výpravu do Beskyd s maximálně 18 km denně, s přespáváním na legálních místech, cílovou základní hmotností pod 4 kg a s ohledem na počasí.',
      NOW,
    );
    expect(r.fields).toMatchObject({ days: 3, region: 'Beskydy', maxDailyKm: 18, legalOnly: true, targetBaseWeightG: 4000, weatherAware: true });
    expect(r.fields.avoidRain).toBeUndefined();
  });

  it('parses "příští víkend" relative to now and asks for the region', () => {
    const r = parseTripRequest('Chci příští víkend na dvoudenní přechod, ale nechci zmoknout.', NOW);
    expect(r.fields).toMatchObject({ days: 2, startDate: '2026-06-06', endDate: '2026-06-07', avoidRain: true, activity: 'multi_day' });
    expect(r.fields.region).toBeUndefined();
    expect(r.missing[0]).toContain('oblasti');
  });

  it('handles numeric/English/Slovak variants', () => {
    expect(parseTripRequest('3 days in the Krkonoše, max 15 km/day, base weight under 4 kg, tent', NOW).fields).toMatchObject({ days: 3, region: 'Krkonoše', maxDailyKm: 15, targetBaseWeightG: 4000, sleepType: 'tent' });
    expect(parseTripRequest('na 3 dny v Nízkých Tatrách, do 20 km za den, na chatách', NOW).fields).toMatchObject({ days: 3, region: 'Nízké Tatry', maxDailyKm: 20, sleepType: 'mountain_hut', countryCode: 'SK' });
    expect(parseTripRequest('víkend na Šumavě v hamace', NOW).fields).toMatchObject({ days: 2, region: 'Šumava', sleepType: 'hammock' });
    expect(parseTripRequest('bikepacking po Jizerských horách, 5 dní', NOW).fields).toMatchObject({ days: 5, region: 'Jizerské hory', activity: 'bikepacking' });
  });

  it('parses explicit dates and falls back to a guessed region', () => {
    const r = parseTripRequest('Výlet od 12. 6. do 14. 6. v Pálavě, bivak', NOW);
    expect(r.fields).toMatchObject({ startDate: '2026-06-12', endDate: '2026-06-14', days: 3, sleepType: 'bivy_bag', region: 'Pálavě', regionSource: 'guess' });
    expect(r.missing.some((m) => m.includes('Pálavě'))).toBe(true);
    expect(parseTripRequest('od 1. 3.', NOW).fields.startDate).toBe('2027-03-01');
    expect(parseTripRequest('start 2026-07-04', NOW).fields.startDate).toBe('2026-07-04');
  });
});
