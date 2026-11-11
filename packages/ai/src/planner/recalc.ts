/**
 * Incremental re-planning: apply one change to an existing plan and
 * recompute only the sections that depend on it.
 */
import { TrailPackError, type SleepType } from '@trailpack/shared';
import type { ToolPorts } from '../tools/ports';
import {
  finalizePlan,
  selectRoute,
  stepFood,
  stepGear,
  stepItinerary,
  stepNights,
  stepPower,
  stepStages,
  stepWater,
  stepWeather,
  type PlanContext,
} from './planner';
import type { ExpeditionPlan, PlanOptions } from './types';

export type PlanChange =
  | { type: 'daily_km'; value: number }
  | { type: 'days'; value: number }
  | { type: 'sleep_type'; value: SleepType }
  | { type: 'start_date'; value: string }
  | { type: 'loadout'; value: string }
  /** Add a via point; `index` is the position in the waypoint chain (default: before the last point). */
  | { type: 'waypoint'; value: { lat: number; lon: number; name?: string; index?: number } };

export interface RecalcResult {
  plan: ExpeditionPlan;
  /** Section names that were recomputed (finalization is always run). */
  recomputed: string[];
}

/**
 * Returns a new plan; the input plan is not mutated. Throws `invalid_input`
 * for out-of-range values.
 */
export async function recalculatePlan(
  plan: ExpeditionPlan,
  change: PlanChange,
  ports: ToolPorts,
  opts: Pick<PlanOptions, 'signal' | 'onProgress' | 'maxRouteOptions'> = {},
): Promise<RecalcResult> {
  const ctx: PlanContext = { ports, signal: opts.signal, onProgress: opts.onProgress, maxRouteOptions: opts.maxRouteOptions ?? 3 };
  const next: ExpeditionPlan = { ...plan, request: { ...plan.request }, cache: { ...plan.cache }, generatedAt: ports.now().toISOString() };
  const done: string[] = [];
  const invalid = (msg: string): never => {
    throw new TrailPackError('invalid_input', msg);
  };

  const rerouteIfNeeded = async (force: boolean): Promise<void> => {
    const req = next.request;
    const cap = req.days * req.maxDailyKm * 1000;
    const d = next.route?.distanceM;
    if (!force && d !== undefined && d <= cap * 1.1 && d >= cap * 0.6) return;
    const saved = { route: next.route, options: next.routeOptions, chosen: next.chosenOptionId, chain: next.chain };
    try {
      await selectRoute(next, ctx);
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      Object.assign(next, { route: saved.route, routeOptions: saved.options, chosenOptionId: saved.chosen, chain: saved.chain });
      return;
    }
    if (next.route !== saved.route) {
      next.cache.campsites = undefined;
      next.cache.waterSources = undefined;
      done.push('routing');
    }
  };

  const fromStages = async (): Promise<void> => {
    await stepStages(next, ctx);
    await stepNights(next, ctx);
    await stepWeather(next, ctx);
    await stepWater(next, ctx);
    await stepFood(next, ctx);
    await stepPower(next, ctx);
    await stepItinerary(next, ctx);
    done.push('stages', 'nights', 'weather', 'water', 'food', 'power', 'itinerary');
  };

  switch (change.type) {
    case 'daily_km':
      if (!Number.isFinite(change.value) || change.value < 3 || change.value > 200) invalid('Denní vzdálenost musí být mezi 3 a 200 km.');
      next.request.maxDailyKm = change.value;
      await rerouteIfNeeded(false);
      await fromStages();
      break;
    case 'days':
      if (!Number.isInteger(change.value) || change.value < 1 || change.value > 30) invalid('Počet dní musí být celé číslo od 1 do 30.');
      next.request.days = change.value;
      await rerouteIfNeeded(false);
      await fromStages();
      break;
    case 'sleep_type':
      next.request.sleepType = change.value;
      await stepNights(next, ctx);
      done.push('nights');
      break;
    case 'start_date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(change.value)) invalid('Datum musí mít tvar RRRR-MM-DD.');
      next.request.startDate = change.value;
      await stepWeather(next, ctx);
      await stepWater(next, ctx);
      await stepItinerary(next, ctx);
      done.push('weather', 'water', 'itinerary');
      break;
    case 'loadout':
      next.request.loadoutId = change.value;
      await stepGear(next, ctx);
      await stepFood(next, ctx);
      done.push('gear', 'food');
      break;
    case 'waypoint': {
      const chain = next.chain;
      if (!chain) invalid('Plán nemá trasu, do které by šlo přidat bod.');
      const wps = [...chain!.waypoints];
      const idx = change.value.index ?? Math.max(1, wps.length - 1);
      wps.splice(Math.min(Math.max(idx, 0), wps.length), 0, { lat: change.value.lat, lon: change.value.lon, name: change.value.name });
      await selectRoute(next, ctx, [{ kind: 'user', scale: chain!.scale, waypoints: wps }]);
      next.cache.campsites = undefined;
      next.cache.waterSources = undefined;
      done.push('routing');
      await fromStages();
      break;
    }
  }

  finalizePlan(next);
  return { plan: next, recomputed: done };
}
