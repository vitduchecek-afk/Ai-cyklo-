/**
 * Public list prices (USD per million tokens) used to estimate the cost of a
 * call. Only prices that are known for certain are built in; for any other
 * model the cost is reported as 0 with `priced: false` so the UI can say
 * "cena neznámá" instead of showing a made-up number. Apps may add prices at
 * runtime with {@link registerPricing} (e.g. for OpenAI / Gemini models).
 */
import type { AiProviderId } from '@trailpack/shared';

/** USD per 1 000 000 tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  /** Cache read price; defaults to 10 % of `input`. */
  cacheRead?: number;
  /** Cache write price; defaults to 125 % of `input`. */
  cacheWrite?: number;
}

/** Token counts. `inputTokens` excludes cache reads/writes (billed separately). */
export interface PricedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CostEstimate {
  costUsd: number;
  /** False when no price is known for the model (cost is then 0). */
  priced: boolean;
}

const BUILTIN: Record<string, ModelPrice> = {
  'anthropic/claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'anthropic/claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'anthropic/claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'anthropic/claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
};

const registry = new Map<string, ModelPrice>(Object.entries(BUILTIN));

const keyOf = (provider: AiProviderId | string, model: string) => `${provider}/${model}`;

/** Add or override the price of a model. */
export function registerPricing(provider: AiProviderId | string, model: string, price: ModelPrice): void {
  for (const v of [price.input, price.output, price.cacheRead ?? 0, price.cacheWrite ?? 0]) {
    if (!Number.isFinite(v) || v < 0) throw new RangeError('Price must be a non-negative finite number');
  }
  registry.set(keyOf(provider, model), { ...price });
}

/** Look up a price; dated snapshots (`claude-opus-5-5-20261001`) match their base model. */
export function getPricing(provider: AiProviderId | string, model: string): ModelPrice | undefined {
  const exact = registry.get(keyOf(provider, model));
  if (exact) return exact;
  let best: { len: number; price: ModelPrice } | undefined;
  const prefix = `${provider}/`;
  for (const [k, price] of registry) {
    if (!k.startsWith(prefix)) continue;
    const name = k.slice(prefix.length);
    if (model.startsWith(`${name}-`) && (!best || name.length > best.len)) best = { len: name.length, price };
  }
  return best?.price;
}

/** Estimate the USD cost of one call. Unknown models cost 0 with `priced: false`. */
export function estimateCost(provider: AiProviderId | string, model: string, usage: PricedUsage): CostEstimate {
  const price = getPricing(provider, model);
  if (!price) return { costUsd: 0, priced: false };
  const read = price.cacheRead ?? price.input * 0.1;
  const write = price.cacheWrite ?? price.input * 1.25;
  const cost =
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      (usage.cacheReadTokens ?? 0) * read +
      (usage.cacheWriteTokens ?? 0) * write) /
    1_000_000;
  return { costUsd: cost, priced: true };
}
