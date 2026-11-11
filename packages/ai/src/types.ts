/**
 * Provider-neutral AI contracts (STABLE – used by apps/api and apps/mobile).
 *
 * The conversation format is normalised so that the same agent loop can run
 * against Anthropic, OpenAI, Gemini or an OpenAI-compatible local model, and
 * so that the TrailPack API server can proxy requests without ever exposing
 * provider keys to clients.
 */
import type { AiProviderId } from '@trailpack/shared';

export type ChatRole = 'user' | 'assistant' | 'tool';

export interface ImagePart {
  type: 'image';
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  /** base64 without data: prefix */
  data: string;
}

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ToolCallPart {
  type: 'tool_call';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultPart {
  type: 'tool_result';
  toolCallId: string;
  name: string;
  /** JSON-serialised result or error text */
  content: string;
  isError?: boolean;
}

export type ChatPart = TextPart | ImagePart | ToolCallPart | ToolResultPart;

export interface ChatMessage {
  role: ChatRole;
  parts: ChatPart[];
  /**
   * Provider-native content for assistant turns that must be replayed
   * verbatim (e.g. Anthropic thinking blocks). Only replayed to the same provider+model.
   */
  providerRaw?: { provider: AiProviderId; model: string; content: unknown };
}

/** JSON-schema tool definition sent to models. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12 subset) object */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  provider: AiProviderId;
  model: string;
  system: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  /** Reasoning effort hint for providers that support it. */
  effort?: 'low' | 'medium' | 'high';
  /** Base URL for openai_compatible providers (e.g. http://192.168.1.10:11434/v1). */
  baseUrl?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Estimated cost in USD based on the public price list in pricing.ts */
  costUsd: number;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'error';

export interface ChatResponse {
  message: ChatMessage;
  stopReason: StopReason;
  usage: Usage;
  model: string;
  provider: AiProviderId;
  /** Present when the provider declined (safety). */
  refusal?: { category?: string | null; explanation?: string | null };
}

/** Anything that can answer a ChatRequest: a direct provider adapter or the TrailPack API proxy. */
export interface ChatTransport {
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
}

export interface ProviderCredentials {
  apiKey?: string;
  baseUrl?: string;
}
