import { describe, expect, it } from 'vitest';
import { planExpedition, recalculatePlan, requestFromParsed, parseTripRequest, summarizePlan, type ExpeditionRequest } from '../src';
import { NOW, makeCampsite, makeFakePorts } from './tools.fakes';

const request = (over: Partial<ExpeditionRequest> = {}): ExpeditionRequest => ({
  region: { name: 'Beskydy', query: 'Beskydy', countryCode: 'CZ' },
  days: 4,
  maxDailyKm: 20,
  activity: 'trekking',
  sleepType: 'tent',
  startDate: '2026-06-06',
  targetBaseWeightG: 4000,
  avoidRain: true,
  gear: { sleepingBagComfortC: 0, powerbankMah: 10000 },
  devices: [{ name: 'telefon', batteryMah: 4000 }],
  bodyWeightKg: 75,
  ...over,
});

describe('planExpedition', () => {
  it('plans a feasible expedition end to end', async () => {
    const ports = makeFakePorts({ baseWeightG: 3000 });
    const steps: string[] = [];
    const plan = await planExpedition(request(), ports, { onProgress: (p) => steps.push(p.step) });

    expect(plan.region.status).toBe('ok');
    expect(plan.routeOptions.length).toBeGreaterThanOrEqual(2);
    expect(plan.routeOptions.filter((o) => o.chosen)).toHaveLength(1);
    expect(plan.chosenOptionId).toBeDefined();
    expect(plan.stages.status === 'ok' && plan.stages.data).toHaveLength(4);
    const totalKm = plan.route!.distanceM / 1000;
    expect(totalKm).toBeGreaterThan(48);
    expect(totalKm).toBeLessThanOrEqual(84);
    expect(plan.nights.status === 'ok' && plan.nights.data).toHaveLength(3);
    expect(plan.nights.status === 'ok' && plan.nights.data.every((n) => n.acceptable)).toBe(true);
    expect(plan.weather.status).toBe('ok');
    expect(plan.water.status).toBe('ok');
    expect(plan.gear.status === 'ok' && plan.gear.data.baseWeightG).toBe(3000);
    expect(plan.food.status).toBe('ok');
    expect(plan.power.status).toBe('ok');
    expect(plan.itinerary.status === 'ok' && plan.itinerary.data[0]?.sunset).toBe('21:05');
    expect(plan.feasible).toBe(true);
    expect(plan.draft?.days).toHaveLength(4);
    expect(plan.draft?.startDate).toBe('2026-06-06');
    expect(plan.draft?.endDate).toBe('2026-06-09');
    expect(plan.draft?.settings.sleepType).toBe('tent');
    expect(plan.daySummaries[0]).toMatch(/^Den 1: /);
    expect(plan.checklist.length).toBeGreaterThan(3);
    // weather: night 2 is 2 °C, bag comfort 0 °C -> no bag warning; day 3 rain -> advisory
    expect(plan.advisories.some((a) => a.code === 'weather.rain')).toBe(true);
    expect(steps[0]).toBe('region');
    expect(steps).toContain('finalize');
    expect(JSON.stringify(summarizePlan(plan)).length).toBeLessThan(9000);
  });

  it('continues when weather fails', async () => {
    const plan = await planExpedition(request(), makeFakePorts({ failWeather: true }));
    expect(plan.weather).toMatchObject({ status: 'unavailable', code: 'provider_error' });
    expect(plan.feasible).toBe(true);
    expect(plan.itinerary.status).toBe('ok');
    expect(plan.uncertainties.some((u) => u.startsWith('Počasí: nedostupné'))).toBe(true);
  });

  it('says the forecast is unavailable when the trip is beyond the horizon', async () => {
    const ports = makeFakePorts();
    const plan = await planExpedition(request({ startDate: '2026-09-01' }), ports);
    expect(plan.weather).toMatchObject({ status: 'skipped' });
    expect(plan.weather.status === 'skipped' && plan.weather.reason).toContain('Předpověď zatím není k dispozici');
    expect(ports.calls['weather']).toBeUndefined();
  });

  it('flags nights without a legal option, sets feasible=false and offers alternatives', async () => {
    const ports = makeFakePorts({
      regulation: (i) => (i.sleepType === 'bivy_bag' ? 'verified_allowed' : 'prohibited'),
    });
    const plan = await planExpedition(request({ legalOnly: true }), ports);
    expect(plan.feasible).toBe(false);
    expect(plan.nights.status === 'ok' && plan.nights.data.every((n) => n.noLegalOption)).toBe(true);
    const n0 = plan.nights.status === 'ok' ? plan.nights.data[0]! : undefined;
    expect(n0?.alternatives.some((a) => a.kind === 'other_sleep_type' && a.sleepType === 'bivy_bag')).toBe(true);
    expect(plan.explanation).toContain('legální místo');
    expect(plan.alternatives.length).toBeGreaterThan(0);
    expect(plan.alternatives.join(' ')).toContain('kemp');
    expect(plan.advisories.some((a) => a.code === 'camp.prohibited' && a.severity === 'danger')).toBe(true);
  });

  it('prefers a verified official site near the stage end when the wild spot is only conditional', async () => {
    const probe = await planExpedition(request(), makeFakePorts());
    const end0 = probe.stages.status === 'ok' ? probe.stages.data[0]!.endKm * 1000 : 0;
    const ports = makeFakePorts({ campsites: [makeCampsite('c1', 18.5, 'bivouac_site', 'verified_allowed', end0 + 200)] });
    const plan = await planExpedition(request(), ports);
    const n0 = plan.nights.status === 'ok' ? plan.nights.data[0]! : undefined;
    expect(n0?.place?.id).toBe('c1');
    expect(n0?.legalStatus).toBe('verified_allowed');
  });

  it('re-routes when the route is far off the target and stays resilient without peaks/routes', async () => {
    const plan = await planExpedition(request({ days: 2, maxDailyKm: 10 }), makeFakePorts());
    expect(plan.route!.distanceM / 1000).toBeLessThanOrEqual(23);
    const noPeaks = await planExpedition(request(), makeFakePorts({ noPeaks: true }));
    expect(noPeaks.route).toBeDefined();
    expect(noPeaks.routeOptions[0]?.kind).toBe('axis');
    const failing = await planExpedition(request(), makeFakePorts({ failRoute: true }));
    expect(failing.feasible).toBe(false);
    expect(failing.route).toBeUndefined();
    expect(failing.explanation).toContain('trasu');
    expect(failing.stages.status).toBe('skipped');
    const nowhere = await planExpedition(request({ region: { name: 'nikde' } }), makeFakePorts());
    expect(nowhere.region.status).toBe('unavailable');
    expect(nowhere.feasible).toBe(false);
  });

  it('builds a request from parsed text', async () => {
    const parsed = parseTripRequest('Chci na čtyři dny přejít Beskydy. Denně maximálně 20 km, chci spát venku, základní hmotnost pod 4 kg.', NOW);
    const req = requestFromParsed(parsed, { loadoutId: undefined });
    expect(req).toMatchObject({ days: 4, maxDailyKm: 20, sleepType: 'open_air', targetBaseWeightG: 4000, region: { name: 'Beskydy' } });
  });
});

describe('recalculatePlan', () => {
  it('recomputes route, stages and dependents after a daily_km change without mutating the input', async () => {
    const ports = makeFakePorts();
    const plan = await planExpedition(request(), ports);
    const before = plan.route!.distanceM;
    const { plan: next, recomputed } = await recalculatePlan(plan, { type: 'daily_km', value: 12 }, ports);
    expect(recomputed).toEqual(expect.arrayContaining(['routing', 'stages', 'nights', 'itinerary']));
    expect(recomputed).not.toContain('gear');
    expect(plan.request.maxDailyKm).toBe(20);
    expect(plan.route!.distanceM).toBe(before);
    expect(next.request.maxDailyKm).toBe(12);
    expect(next.route!.distanceM).toBeLessThan(before);
    expect(next.stages.status === 'ok' && next.stages.data.every((s) => s.distanceM <= 12 * 1100)).toBe(true);
    expect(next.feasible).toBe(true);
  });

  it('becomes infeasible when the route cannot be shortened (no re-route available)', async () => {
    const ports = makeFakePorts();
    const plan = await planExpedition(request(), ports);
    const failing = makeFakePorts({ failRoute: true });
    const { plan: next } = await recalculatePlan(plan, { type: 'daily_km', value: 8 }, { ...failing, gear: ports.gear, calc: ports.calc } as typeof ports);
    expect(next.feasible).toBe(false);
    expect(next.explanation).toContain('nelze splnit');
  });

  it('recomputes only the dependent sections for other change types', async () => {
    const ports = makeFakePorts({ loadouts: 2 });
    const plan = await planExpedition(request(), ports);
    const sleep = await recalculatePlan(plan, { type: 'sleep_type', value: 'hammock' }, ports);
    expect(sleep.recomputed).toEqual(['nights']);
    expect(sleep.plan.draft?.settings.sleepType).toBe('hammock');
    const date = await recalculatePlan(plan, { type: 'start_date', value: '2026-06-08' }, ports);
    expect(date.recomputed).toEqual(['weather', 'water', 'itinerary']);
    expect(date.plan.draft?.startDate).toBe('2026-06-08');
    const gear = await recalculatePlan(plan, { type: 'loadout', value: 'l2' }, ports);
    expect(gear.recomputed).toEqual(['gear', 'food']);
    expect(gear.plan.gear.status === 'ok' && gear.plan.gear.data.loadoutId).toBe('l2');
    const wp = await recalculatePlan(plan, { type: 'waypoint', value: { lat: 49.6, lon: 18.7, name: 'Radhošť' } }, ports);
    expect(wp.recomputed).toContain('routing');
    expect(wp.plan.chain?.waypoints.some((w) => w.name === 'Radhošť')).toBe(true);
    await expect(recalculatePlan(plan, { type: 'days', value: 0 }, ports)).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
