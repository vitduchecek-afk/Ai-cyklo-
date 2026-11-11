/**
 * Environment based configuration, validated once at start-up. Invalid
 * configuration aborts the process with a message that names the offending
 * variables but never echoes their values (they may be secrets).
 */
import { z } from 'zod';

export const API_VERSION = '1.0.0';

/** Models proxied by default when `AI_ALLOWED_MODELS` is not set. */
export const DEFAULT_ALLOWED_MODELS = ['anthropic/claude-sonnet-5-5*', 'anthropic/claude-haiku-5-5*'];

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const bool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  HOST: z.string().min(1).default('127.0.0.1'),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'must start with postgres:// or postgresql://')
    .optional(),
  SQLITE_PATH: z.string().min(1).default('./data/trailpack.sqlite'),
  CORS_ORIGINS: csv,
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  OPENAI_COMPATIBLE_BASE_URL: z.string().url().optional(),
  OPENAI_COMPATIBLE_API_KEY: z.string().optional(),
  AI_ALLOWED_MODELS: csv,
  AI_MONTHLY_BUDGET_USD_PER_USER: z.coerce.number().nonnegative().default(5),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  AI_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  AUTH_RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(1).default(20),
  MAX_BODY_BYTES: z.coerce.number().int().min(1024).default(1024 * 1024),
  MAX_AI_BODY_BYTES: z.coerce.number().int().min(1024).default(8 * 1024 * 1024),
  TRUST_PROXY: bool,
});

export interface AppConfig {
  port: number;
  host: string;
  /** PostgreSQL connection string; SQLite is used when absent. */
  databaseUrl?: string;
  sqlitePath: string;
  corsOrigins: string[];
  ai: {
    openaiApiKey?: string;
    anthropicApiKey?: string;
    geminiApiKey?: string;
    openaiCompatibleBaseUrl?: string;
    openaiCompatibleApiKey?: string;
    /** `provider/model`, `model` or prefix patterns ending in `*`. */
    allowedModels: string[];
    monthlyBudgetUsdPerUser: number;
  };
  rateLimit: { perMinute: number; aiPerMinute: number; authPerHour: number };
  maxBodyBytes: number;
  maxAiBodyBytes: number;
  trustProxy: boolean;
}

/** Parse and validate an environment (default: `process.env`). */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  // Treat `FOO=` (empty) like an unset variable.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration – ${problems}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    sqlitePath: e.SQLITE_PATH,
    corsOrigins: e.CORS_ORIGINS,
    ai: {
      openaiApiKey: e.OPENAI_API_KEY?.trim(),
      anthropicApiKey: e.ANTHROPIC_API_KEY?.trim(),
      geminiApiKey: e.GEMINI_API_KEY?.trim(),
      openaiCompatibleBaseUrl: e.OPENAI_COMPATIBLE_BASE_URL,
      openaiCompatibleApiKey: e.OPENAI_COMPATIBLE_API_KEY?.trim(),
      allowedModels: e.AI_ALLOWED_MODELS.length ? e.AI_ALLOWED_MODELS : DEFAULT_ALLOWED_MODELS,
      monthlyBudgetUsdPerUser: e.AI_MONTHLY_BUDGET_USD_PER_USER,
    },
    rateLimit: { perMinute: e.RATE_LIMIT_PER_MINUTE, aiPerMinute: e.AI_RATE_LIMIT_PER_MINUTE, authPerHour: e.AUTH_RATE_LIMIT_PER_HOUR },
    maxBodyBytes: e.MAX_BODY_BYTES,
    maxAiBodyBytes: e.MAX_AI_BODY_BYTES,
    trustProxy: e.TRUST_PROXY,
  };
}
