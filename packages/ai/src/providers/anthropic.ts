/**
 * Anthropic Messages API transport (raw `fetch`, no SDK – works in Node,
 * browsers and React Native).
 *
 * Design notes for the current model generation:
 *  - Opus 5.5 always runs adaptive thinking: we never send `thinking`,
 *    `temperature`, `top_p` or `top_k` (all rejected with HTTP 400) and never
 *    prefill the assistant turn.
 *  - Depth of reasoning is controlled via `output_config.effort`.
 *  - Only `tool_choice: {type:'auto'}` is accepted, so it is the only one used.
 *  - Assistant turns are replayed verbatim (including thinking blocks) via
 *    `providerRaw` when the same provider+model continues the conversation.
 */
import { TrailPackError, type AiProviderId } from '@trailpack/shared';
import type { ChatMessage, ChatPart, ChatRequest, ChatResponse, ChatTransport, StopReason, ToolCallPart, Usage } from '../types';
import { badPayload, hasReplayableRaw, assertChatRequest, type DirectTransportOptions, type ModelInfo, type ModelListing } from './common';
import { callJson, DEFAULT_LIST_TIMEOUT_MS, isRecord, joinUrl, mapStatusError, resolveHttpOptions, type HttpFailure, type ResolvedHttpOptions } from './http';
import { estimateCost } from './pricing';

export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';
export const ANTHROPIC_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'] as const;
/** Models that support server-side refusal fallbacks. */
const FALLBACK_MODELS: ReadonlySet<string> = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2']);
const DEFAULT_MAX_TOKENS = 16_000;

export interface AnthropicTransportOptions extends DirectTransportOptions {
  apiKey: string;
  baseUrl?: string;
  /** Adds `anthropic-dangerous-direct-browser-access` (BYOK from a browser / Expo web). */
  browserDirect?: boolean;
  /** Ask Anthropic to fall back to another model on refusals (default true). */
  fallbacks?: boolean;
}

type AnthropicBlock = Record<string, unknown>;
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

/** {@link ChatTransport} for `POST /v1/messages`. */
export class AnthropicTransport implements ChatTransport, ModelListing {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly browserDirect: boolean;
  private readonly fallbacks: boolean;
  private readonly http: ResolvedHttpOptions;

  constructor(options: AnthropicTransportOptions) {
    if (!options.apiKey) throw new TrailPackError('not_configured', 'Chybí API klíč Anthropic.', { provider: 'anthropic' });
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? 'https://api.anthropic.com';
    this.browserDirect = options.browserDirect ?? false;
    this.fallbacks = options.fallbacks ?? true;
    this.http = resolveHttpOptions(options);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
      ...extra,
    };
    if (this.browserDirect) h['anthropic-dangerous-direct-browser-access'] = 'true';
    return h;
  }

  /** Build the JSON body for `/v1/messages` (exposed for tests). */
  buildBody(request: ChatRequest): Record<string, unknown> {
    const model = request.model || ANTHROPIC_DEFAULT_MODEL;
    const body: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: toAnthropicMessages(request.messages, model),
      output_config: { effort: request.effort ?? 'medium' },
    };
    if (request.system) body.system = request.system;
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      body.tool_choice = { type: 'auto' };
    }
    if (this.fallbacks && FALLBACK_MODELS.has(model)) body.fallbacks = 'default';
    return body;
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    assertChatRequest(request, 'anthropic');
    const model = request.model || ANTHROPIC_DEFAULT_MODEL;
    const body = this.buildBody({ ...request, model });
    const extra: Record<string, string> = body.fallbacks ? { 'anthropic-beta': ANTHROPIC_FALLBACK_BETA } : {};
    const { data } = await callJson<unknown>(this.http, {
      providerId: 'anthropic',
      providerLabel: 'Anthropic',
      url: joinUrl(this.baseUrl, '/v1/messages'),
      method: 'POST',
      headers: this.headers(extra),
      body,
      signal,
      mapError: mapAnthropicError,
      secrets: [this.apiKey],
    });
    return parseAnthropicResponse(data, model);
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const { data } = await callJson<unknown>(
      this.http,
      {
        providerId: 'anthropic',
        providerLabel: 'Anthropic',
        url: joinUrl(this.baseUrl, '/v1/models?limit=100'),
        method: 'GET',
        headers: this.headers(),
        signal,
        mapError: mapAnthropicError,
        secrets: [this.apiKey],
      },
      { timeoutMs: DEFAULT_LIST_TIMEOUT_MS },
    );
    const list = isRecord(data) && Array.isArray(data.data) ? data.data : [];
    return list.flatMap((m): ModelInfo[] =>
      isRecord(m) && typeof m.id === 'string' ? [{ id: m.id, displayName: typeof m.display_name === 'string' ? m.display_name : undefined }] : [],
    );
  }
}

/** Anthropic error envelope → TrailPackError (401 / 429 / 529 / 5xx / 400 …). */
export function mapAnthropicError(failure: HttpFailure): TrailPackError {
  return mapStatusError('anthropic', 'Anthropic', failure);
}

/**
 * Convert normalised messages into Anthropic messages: consecutive same-role
 * turns are merged, all tool results of one turn end up in ONE user message
 * (tool_result blocks first), and assistant turns from the same provider+model
 * are replayed verbatim from `providerRaw`.
 */
export function toAnthropicMessages(messages: ChatMessage[], model: string): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const m of messages) {
    if (m.role === 'assistant') {
      if (hasReplayableRaw(m, 'anthropic', model) && Array.isArray(m.providerRaw?.content)) {
        push('assistant', m.providerRaw.content as AnthropicBlock[]);
      } else {
        push('assistant', m.parts.flatMap(partToBlock));
      }
    } else {
      push('user', m.parts.flatMap(partToBlock));
    }
  }
  for (const msg of out) {
    if (msg.role === 'user') {
      // The API requires tool_result blocks to precede any other content.
      msg.content.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'));
    }
  }
  return out;
}

function partToBlock(p: ChatPart): AnthropicBlock[] {
  switch (p.type) {
    case 'text':
      return p.text.trim() === '' ? [] : [{ type: 'text', text: p.text }];
    case 'image':
      return [{ type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.data } }];
    case 'tool_call':
      return [{ type: 'tool_use', id: p.id, name: p.name, input: p.arguments }];
    case 'tool_result': {
      const block: AnthropicBlock = { type: 'tool_result', tool_use_id: p.toolCallId, content: p.content };
      if (p.isError) block.is_error = true;
      return [block];
    }
  }
}

function mapStopReason(reason: unknown): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      // end_turn, stop_sequence, pause_turn and anything new
      return 'end';
  }
}

/** Parse a `/v1/messages` response body. */
export function parseAnthropicResponse(data: unknown, requestedModel: string): ChatResponse {
  if (!isRecord(data) || !Array.isArray(data.content)) throw badPayload('anthropic', 'Anthropic', 'chybí obsah zprávy');
  const raw = data.content as unknown[];
  const parts: ChatPart[] = [];
  for (const b of raw) {
    if (!isRecord(b)) continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      if (b.text !== '') parts.push({ type: 'text', text: b.text });
    } else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
      const call: ToolCallPart = { type: 'tool_call', id: b.id, name: b.name, arguments: isRecord(b.input) ? b.input : {} };
      parts.push(call);
    }
    // thinking / redacted_thinking / fallback blocks are kept only in providerRaw.
  }
  const model = typeof data.model === 'string' ? data.model : requestedModel;
  const stopReason = mapStopReason(data.stop_reason);
  // After a server-side refusal fallback the blocks belong to another model; only replay them to that model.
  const rawModel = model === requestedModel || model.startsWith(`${requestedModel}-`) ? requestedModel : model;
  const response: ChatResponse = {
    message: { role: 'assistant', parts, providerRaw: { provider: 'anthropic' as AiProviderId, model: rawModel, content: raw } },
    stopReason,
    usage: parseUsage(data.usage, model),
    model,
    provider: 'anthropic',
  };
  if (stopReason === 'refusal') {
    const d = isRecord(data.stop_details) ? data.stop_details : {};
    response.refusal = {
      category: typeof d.category === 'string' ? d.category : null,
      explanation: typeof d.explanation === 'string' ? d.explanation : null,
    };
  }
  return response;
}

function parseUsage(u: unknown, model: string): Usage {
  const r = isRecord(u) ? u : {};
  const num = (k: string) => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? (r[k] as number) : 0);
  const usage = {
    inputTokens: num('input_tokens'),
    outputTokens: num('output_tokens'),
    cacheReadTokens: num('cache_read_input_tokens'),
    cacheWriteTokens: num('cache_creation_input_tokens'),
  };
  return { ...usage, costUsd: estimateCost('anthropic', model, usage).costUsd };
}
