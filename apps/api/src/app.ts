/**
 * TrailPack API – minimal production core: health/meta, anonymous device
 * auth and the AI proxy (provider keys stay on the server). Sync and sharing
 * endpoints are the next step (see docs/STATUS.md); their client and domain
 * logic already exist in @trailpack/sync.
 *
 * State (device tokens, monthly AI usage) is kept in an injectable
 * `ApiState`; the default in-memory implementation is suitable for a single
 * instance (tokens are invalidated on restart, clients simply re-register).
 */
import type { ChatRequest, ChatTransport, ProviderCredentials } from '@trailpack/ai';
import { AiProviderIdSchema, isTrailPackError, type AiProviderId } from '@trailpack/shared';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { API_VERSION, type AppConfig } from './config';
import { hashToken, newId, newToken } from './crypto';
import { HttpError, badRequest, unauthorized } from './errors';
import { TokenBucketLimiter } from './rateLimit';

export interface ApiState {
  registerDevice(userId: string, tokenHash: string): Promise<void>;
  userForTokenHash(tokenHash: string): Promise<string | null>;
  addUsage(userId: string, month: string, costUsd: number, tokens: number): Promise<void>;
  usage(userId: string, month: string): Promise<{ costUsd: number; tokens: number; requests: number }>;
}

export class InMemoryApiState implements ApiState {
  private tokens = new Map<string, string>();
  private usageMap = new Map<string, { costUsd: number; tokens: number; requests: number }>();
  async registerDevice(userId: string, tokenHash: string) {
    this.tokens.set(tokenHash, userId);
  }
  async userForTokenHash(tokenHash: string) {
    return this.tokens.get(tokenHash) ?? null;
  }
  async addUsage(userId: string, month: string, costUsd: number, tokens: number) {
    const k = `${userId}:${month}`;
    const u = this.usageMap.get(k) ?? { costUsd: 0, tokens: 0, requests: 0 };
    this.usageMap.set(k, { costUsd: u.costUsd + costUsd, tokens: u.tokens + tokens, requests: u.requests + 1 });
  }
  async usage(userId: string, month: string) {
    return this.usageMap.get(`${userId}:${month}`) ?? { costUsd: 0, tokens: 0, requests: 0 };
  }
}

export interface AppDeps {
  config: AppConfig;
  state?: ApiState;
  transportFactory: (provider: AiProviderId, creds: ProviderCredentials) => ChatTransport;
  now?: () => number;
}

const PartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string().max(100_000) }),
  z.object({ type: z.literal('image'), mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']), data: z.string().max(7_000_000) }),
  z.object({ type: z.literal('tool_call'), id: z.string(), name: z.string(), arguments: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal('tool_result'), toolCallId: z.string(), name: z.string(), content: z.string().max(200_000), isError: z.boolean().optional() }),
]);

const ChatRequestSchema = z.object({
  provider: AiProviderIdSchema,
  model: z.string().min(1).max(100),
  system: z.string().max(50_000),
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant', 'tool']), parts: z.array(PartSchema).max(64), providerRaw: z.unknown().optional() }))
    .min(1)
    .max(200),
  tools: z.array(z.object({ name: z.string(), description: z.string(), parameters: z.record(z.string(), z.unknown()) })).max(64).optional(),
  maxTokens: z.number().int().min(1).max(64_000).optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
});

/** `provider/model`, bare `model` or prefix patterns ending in `*`. */
export function isModelAllowed(allowed: string[], provider: string, model: string): boolean {
  const full = `${provider}/${model}`;
  return allowed.some((p) => {
    if (p.endsWith('*')) {
      const pre = p.slice(0, -1);
      return full.startsWith(pre) || model.startsWith(pre);
    }
    return p === full || p === model;
  });
}

function credentialsFor(config: AppConfig, provider: AiProviderId): ProviderCredentials | null {
  switch (provider) {
    case 'anthropic':
      return config.ai.anthropicApiKey ? { apiKey: config.ai.anthropicApiKey } : null;
    case 'openai':
      return config.ai.openaiApiKey ? { apiKey: config.ai.openaiApiKey } : null;
    case 'gemini':
      return config.ai.geminiApiKey ? { apiKey: config.ai.geminiApiKey } : null;
    case 'openai_compatible':
      return config.ai.openaiCompatibleBaseUrl
        ? { baseUrl: config.ai.openaiCompatibleBaseUrl, apiKey: config.ai.openaiCompatibleApiKey }
        : null;
  }
}

const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

export function createApp(deps: AppDeps) {
  const { config } = deps;
  const state = deps.state ?? new InMemoryApiState();
  const now = deps.now ?? Date.now;
  const general = new TokenBucketLimiter(config.rateLimit.perMinute, 60_000, now);
  const aiLimiter = new TokenBucketLimiter(config.rateLimit.aiPerMinute, 60_000, now);
  const authLimiter = new TokenBucketLimiter(config.rateLimit.authPerHour, 3_600_000, now);
  const app = new Hono<{ Variables: { userId: string } }>();

  const clientIp = (c: Context) =>
    (config.trustProxy ? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() : undefined) ?? c.req.header('x-real-ip') ?? 'local';

  const limit = (limiter: TokenBucketLimiter, key: string) => {
    const r = limiter.take(key);
    if (!r.ok) {
      throw new HttpError(429, 'rate_limited', 'Příliš mnoho požadavků, zkuste to za chvíli.', undefined, { 'Retry-After': String(r.retryAfterSec) });
    }
  };

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      for (const [k, v] of Object.entries(err.headers ?? {})) c.header(k, v);
      return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    }
    if (isTrailPackError(err)) {
      const status = err.code === 'unauthorized' ? 502 : err.code === 'rate_limited' ? 429 : err.code === 'invalid_input' ? 400 : 502;
      return c.json({ error: { code: err.code, message: err.message } }, status as 400);
    }
    console.error('[api] unhandled error', err instanceof Error ? err.message : err);
    return c.json({ error: { code: 'unknown', message: 'Interní chyba serveru.' } }, 500);
  });

  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin))) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
      c.header('Access-Control-Allow-Headers', 'authorization, content-type');
      c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    const maxBytes = c.req.path.startsWith('/v1/ai/') ? config.maxAiBodyBytes : config.maxBodyBytes;
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > maxBytes) throw new HttpError(413, 'too_large', 'Požadavek je příliš velký.');
    limit(general, clientIp(c));
    await next();
  });

  const auth = async (c: Context<{ Variables: { userId: string } }>, next: () => Promise<void>) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw unauthorized();
    const userId = await state.userForTokenHash(hashToken(token));
    if (!userId) throw unauthorized();
    c.set('userId', userId);
    await next();
  };

  app.get('/health', (c) => c.json({ ok: true, version: API_VERSION }));

  app.get('/v1/meta', (c) =>
    c.json({
      version: API_VERSION,
      ai: {
        anthropic: Boolean(config.ai.anthropicApiKey),
        openai: Boolean(config.ai.openaiApiKey),
        gemini: Boolean(config.ai.geminiApiKey),
        openai_compatible: Boolean(config.ai.openaiCompatibleBaseUrl),
        allowedModels: config.ai.allowedModels,
        monthlyBudgetUsdPerUser: config.ai.monthlyBudgetUsdPerUser,
      },
      sync: false,
    }),
  );

  app.post('/v1/auth/device', async (c) => {
    limit(authLimiter, clientIp(c));
    const userId = newId();
    const token = newToken();
    await state.registerDevice(userId, hashToken(token));
    return c.json({ userId, token }, 201);
  });

  app.get('/v1/ai/usage', auth, async (c) => {
    const month = monthOf(now());
    const u = await state.usage(c.get('userId'), month);
    return c.json({ month, ...u, budgetUsd: config.ai.monthlyBudgetUsdPerUser });
  });

  app.post('/v1/ai/chat', auth, async (c) => {
    const userId = c.get('userId');
    limit(aiLimiter, userId);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw badRequest('Tělo požadavku není platný JSON.');
    }
    const parsed = ChatRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest('Neplatný požadavek na AI.', parsed.error.issues.slice(0, 5));
    const req = parsed.data as ChatRequest;
    if (!isModelAllowed(config.ai.allowedModels, req.provider, req.model)) {
      throw new HttpError(403, 'forbidden', `Model ${req.provider}/${req.model} není na tomto serveru povolen.`);
    }
    const creds = credentialsFor(config, req.provider);
    if (!creds) throw new HttpError(503, 'not_configured', 'Tento poskytovatel AI není na serveru nakonfigurován.');
    const month = monthOf(now());
    const used = await state.usage(userId, month);
    if (used.costUsd >= config.ai.monthlyBudgetUsdPerUser) {
      throw new HttpError(402, 'budget_exceeded', 'Měsíční rozpočet na AI byl vyčerpán.');
    }
    const transport = deps.transportFactory(req.provider, creds);
    const response = await transport.chat(req, c.req.raw.signal);
    await state.addUsage(userId, month, response.usage.costUsd, response.usage.inputTokens + response.usage.outputTokens);
    return c.json(response);
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Endpoint neexistuje.' } }, 404));
  return app;
}
