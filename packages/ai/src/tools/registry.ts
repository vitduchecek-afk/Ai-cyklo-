/**
 * Tool registry: `defineTool` + `createToolExecutor`. Validates model-supplied
 * arguments with zod, enforces confirmation metadata and returns compact JSON.
 */
import { z } from 'zod';
import { isTrailPackError } from '@trailpack/shared';
import type { ToolCallPart, ToolDefinition, ToolExecutor } from '../types';
import type { RouteOption, ToolPorts } from './ports';

/** A route computed by `calculateRoute`, kept executor-side so geometry never travels through the model. */
export interface CachedRoute {
  id: string;
  option: RouteOption;
  activity: string;
  name?: string;
  /** Set once the route has been persisted (createTrip) – needed for GPX export. */
  persistedRouteId?: string;
  createdAt: string;
}

/** Per-executor route cache (short ids -> geometry). */
export class RouteCache {
  private readonly map = new Map<string, CachedRoute>();
  private counter = 0;

  add(option: RouteOption, activity: string, createdAt: string, name?: string): CachedRoute {
    this.counter += 1;
    const id = `rt${this.counter.toString(36)}`;
    const cached: CachedRoute = { id, option, activity, name, createdAt };
    this.map.set(id, cached);
    return cached;
  }
  get(id: string): CachedRoute | undefined {
    return this.map.get(id);
  }
  require(id: string): CachedRoute {
    const r = this.map.get(id);
    if (!r) throw new ToolInputError(`Trasa "${id}" není v paměti. Nejprve ji spočítejte nástrojem calculateRoute.`);
    return r;
  }
  list(): CachedRoute[] {
    return [...this.map.values()];
  }
}

export interface ToolContext {
  routes: RouteCache;
  /** ISO timestamp of the call (from ports.now()). */
  nowIso: string;
}

/** Raised by tools for caller mistakes (reported as isError with a readable message). */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export interface ToolSpec<S extends z.ZodType = z.ZodType> {
  name: string;
  /** English, precise, says when to use the tool. */
  description: string;
  schema: S;
  mutating: boolean;
  /** Whether this particular call needs user confirmation (default: every mutating call). */
  confirm?: (args: z.output<S>) => boolean;
  /** Czech one-liner for confirmation dialogs. */
  describe: (args: z.output<S>) => string;
  run: (args: z.output<S>, ports: ToolPorts, signal: AbortSignal | undefined, ctx: ToolContext) => Promise<unknown>;
}

/** Identity helper that preserves schema inference. */
export function defineTool<S extends z.ZodType>(spec: ToolSpec<S>): ToolSpec<S> {
  return spec;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolSpec = ToolSpec<any>;

const MAX_ARRAY = 40;
const MAX_STRING = 600;
const GEO_KEYS = new Set(['lat', 'lon', 'latitude', 'longitude']);
const KEEP_KEYS = new Set(['source', 'retrievedAt', 'estimated', 'fetchedAt', 'provider', 'disclaimer']);

/**
 * Makes a result model-friendly: rounds numbers (5 decimals for coordinates,
 * 2 otherwise), caps arrays and strings, drops null/undefined. Fields named
 * `source`, `retrievedAt`, `estimated` … are never dropped or truncated.
 */
export function compact(value: unknown, key = '', depth = 0): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    const d = GEO_KEYS.has(key) ? 5 : 2;
    const f = 10 ** d;
    return Math.round(value * f) / f;
  }
  if (typeof value === 'string') return KEEP_KEYS.has(key) || value.length <= MAX_STRING ? value : `${value.slice(0, MAX_STRING)}…`;
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth > 8) return undefined;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((v) => compact(v, key, depth + 1));
    if (value.length > MAX_ARRAY) items.push(`… a ${value.length - MAX_ARRAY} dalších`);
    return items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const c = compact(v, k, depth + 1);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return undefined;
}

function issueSummary(error: z.ZodError): string[] {
  return error.issues.slice(0, 8).map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
}

export interface ToolExecutorOptions {
  /** Restrict to these tool names (default: all). */
  enabled?: readonly string[];
}

export type RegistryExecutor = ToolExecutor & { routes: RouteCache };

/** Build an executor over an explicit tool list (see `createToolExecutor` in definitions.ts for the default set). */
export function buildToolExecutor(ports: ToolPorts, tools: readonly AnyToolSpec[], opts: ToolExecutorOptions = {}): RegistryExecutor {
  const active = opts.enabled ? tools.filter((t) => opts.enabled!.includes(t.name)) : [...tools];
  const byName = new Map(active.map((t) => [t.name, t]));
  const routes = new RouteCache();

  const parse = (call: ToolCallPart) => {
    const tool = byName.get(call.name);
    if (!tool) return { tool: undefined, parsed: undefined } as const;
    return { tool, parsed: tool.schema.safeParse(call.arguments ?? {}) } as const;
  };

  return {
    routes,
    definitions(): ToolDefinition[] {
      return active.map((t) => {
        const json = z.toJSONSchema(t.schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
        delete json['$schema'];
        return { name: t.name, description: t.description, parameters: json };
      });
    },
    isMutating(name) {
      return byName.get(name)?.mutating ?? false;
    },
    needsConfirmation(call) {
      const { tool, parsed } = parse(call);
      if (!tool || !tool.mutating) return false;
      if (!parsed?.success) return false; // execution will fail validation anyway
      return tool.confirm ? tool.confirm(parsed.data) : true;
    },
    describeCall(call) {
      const { tool, parsed } = parse(call);
      if (!tool) return `Neznámý nástroj ${call.name}`;
      if (!parsed?.success) return `${call.name} (neplatné argumenty)`;
      try {
        return tool.describe(parsed.data);
      } catch {
        return call.name;
      }
    },
    async execute(call, signal) {
      const { tool, parsed } = parse(call);
      if (!tool || !parsed) return { content: { error: `Neznámý nástroj: ${call.name}` }, isError: true };
      if (!parsed.success) {
        return { content: { error: 'Neplatné argumenty', issues: issueSummary(parsed.error) }, isError: true };
      }
      if (signal?.aborted) return { content: { error: 'Přerušeno uživatelem', code: 'aborted' }, isError: true };
      try {
        const result = await tool.run(parsed.data, ports, signal, { routes, nowIso: ports.now().toISOString() });
        return { content: compact(result) ?? {} };
      } catch (e) {
        if (e instanceof ToolInputError) return { content: { error: e.message }, isError: true };
        if (isTrailPackError(e)) {
          return { content: { error: e.message, code: e.code, provider: e.provider, retryable: e.retryable }, isError: true };
        }
        return { content: { error: e instanceof Error ? e.message : String(e) }, isError: true };
      }
    },
  };
}
