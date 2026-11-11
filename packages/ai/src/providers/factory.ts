/**
 * Builds the right {@link ChatTransport} for a configured provider.
 */
import { TrailPackError, type AiProviderId } from '@trailpack/shared';
import type { ChatTransport, ProviderCredentials } from '../types';
import type { FetchLike } from '@trailpack/shared';
import { ANTHROPIC_DEFAULT_MODEL, ANTHROPIC_MODELS, AnthropicTransport } from './anthropic';
import { GeminiTransport } from './gemini';
import { OpenAITransport } from './openai';
import { OpenAICompatibleTransport } from './openaiCompatible';

export interface ProviderTransportOptions {
  fetch?: FetchLike;
  /** Allow calling Anthropic straight from a browser (BYOK web builds). */
  browserDirect?: boolean;
}

/** Suggested models per provider (first = default). OpenAI/Gemini/local lists come from `listModels()`. */
export const PROVIDER_MODELS: Record<AiProviderId, { default?: string; models: readonly string[] }> = {
  anthropic: { default: ANTHROPIC_DEFAULT_MODEL, models: ANTHROPIC_MODELS },
  openai: { models: [] },
  gemini: { models: [] },
  openai_compatible: { models: [] },
};

const PROVIDER_LABEL: Record<AiProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  openai_compatible: 'lokální server',
};

/**
 * Create a direct transport. Throws `not_configured` (Czech message) when the
 * API key / base URL required by the provider is missing.
 */
export function createProviderTransport(provider: AiProviderId, creds: ProviderCredentials, opts: ProviderTransportOptions = {}): ChatTransport {
  const apiKey = creds.apiKey?.trim();
  const baseUrl = creds.baseUrl?.trim();
  const common = { fetch: opts.fetch };
  switch (provider) {
    case 'anthropic':
      if (!apiKey) throw notConfigured(provider, 'Chybí API klíč Anthropic. Zadejte ho v Nastavení › Asistent.');
      return new AnthropicTransport({ ...common, apiKey, baseUrl: baseUrl || undefined, browserDirect: opts.browserDirect });
    case 'openai':
      if (!apiKey) throw notConfigured(provider, 'Chybí API klíč OpenAI. Zadejte ho v Nastavení › Asistent.');
      return new OpenAITransport({ ...common, apiKey, baseUrl: baseUrl || undefined });
    case 'gemini':
      if (!apiKey) throw notConfigured(provider, 'Chybí API klíč Google Gemini. Zadejte ho v Nastavení › Asistent.');
      return new GeminiTransport({ ...common, apiKey, baseUrl: baseUrl || undefined });
    case 'openai_compatible':
      if (!baseUrl) throw notConfigured(provider, 'Chybí adresa lokálního serveru (např. http://192.168.1.10:11434/v1). Zadejte ji v Nastavení › Asistent.');
      return new OpenAICompatibleTransport({ ...common, baseUrl, apiKey: apiKey || undefined });
    default:
      throw new TrailPackError('invalid_input', `Neznámý poskytovatel AI: ${String(provider)}`);
  }
}

/** Human-readable (Czech) provider name. */
export const providerLabel = (provider: AiProviderId): string => PROVIDER_LABEL[provider];

function notConfigured(provider: AiProviderId, message: string): TrailPackError {
  return new TrailPackError('not_configured', message, { provider, retryable: false });
}
