/**
 * OpenAI Chat Completions transport (raw `fetch`). The wire mapping is shared
 * with the OpenAI-compatible transport (Ollama, LM Studio, vLLM …) through
 * {@link OpenAIStyleTransport}.
 */
import { TrailPackError, type AiProviderId } from '@trailpack/shared';
import type { ChatMessage, ChatPart, ChatRequest, ChatResponse, ChatTransport, StopReason, Usage } from '../types';
import { assertChatRequest, badPayload, imageDataUrl, parseToolArguments, type DirectTransportOptions, type ModelInfo, type ModelListing } from './common';
import { callJson, DEFAULT_LIST_TIMEOUT_MS, isRecord, joinUrl, mapStatusError, randomId, resolveHttpOptions, type HttpFailure, type ResolvedHttpOptions } from './http';
import { estimateCost } from './pricing';

export interface OpenAIStyleConfig extends DirectTransportOptions {
  providerId: AiProviderId;
  /** Name used in Czech error messages. */
  label: string;
  baseUrl: string;
  apiKey?: string;
  /** Name of the token-limit parameter (`max_completion_tokens` for OpenAI, `max_tokens` for local servers). */
  maxTokensParam: 'max_completion_tokens' | 'max_tokens';
  /** Send `reasoning_effort` derived from `ChatRequest.effort`. */
  reasoningEffort: boolean;
}

/** Shared implementation of the Chat Completions wire format. */
export class OpenAIStyleTransport implements ChatTransport, ModelListing {
  protected readonly http: ResolvedHttpOptions;

  constructor(protected readonly config: OpenAIStyleConfig) {
    this.http = resolveHttpOptions(config);
  }

  protected headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.apiKey) h.authorization = `Bearer ${this.config.apiKey}`;
    return h;
  }

  /** Build the JSON body for `/chat/completions` (exposed for tests). */
  buildBody(request: ChatRequest, options: { omitTools?: boolean } = {}): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAIMessages(request.system, request.messages),
    };
    if (request.maxTokens !== undefined) body[this.config.maxTokensParam] = request.maxTokens;
    if (this.config.reasoningEffort && request.effort) body.reasoning_effort = request.effort;
    if (!options.omitTools && request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    return body;
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    return this.send(request, signal, {});
  }

  protected async send(request: ChatRequest, signal: AbortSignal | undefined, options: { omitTools?: boolean }): Promise<ChatResponse> {
    assertChatRequest(request, this.config.providerId);
    const { data } = await callJson<unknown>(this.http, {
      providerId: this.config.providerId,
      providerLabel: this.config.label,
      url: joinUrl(this.config.baseUrl, '/chat/completions'),
      method: 'POST',
      headers: this.headers(),
      body: this.buildBody(request, options),
      signal,
      mapError: (f) => mapOpenAIError(this.config.providerId, this.config.label, f),
      secrets: [this.config.apiKey],
    });
    return parseOpenAIResponse(data, this.config.providerId, request.model);
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const { data } = await callJson<unknown>(
      this.http,
      {
        providerId: this.config.providerId,
        providerLabel: this.config.label,
        url: joinUrl(this.config.baseUrl, '/models'),
        method: 'GET',
        headers: this.headers(),
        signal,
        mapError: (f) => mapOpenAIError(this.config.providerId, this.config.label, f),
        secrets: [this.config.apiKey],
      },
      { timeoutMs: DEFAULT_LIST_TIMEOUT_MS },
    );
    const list = isRecord(data) && Array.isArray(data.data) ? data.data : [];
    return list.flatMap((m): ModelInfo[] => (isRecord(m) && typeof m.id === 'string' ? [{ id: m.id }] : []));
  }
}

export interface OpenAITransportOptions extends DirectTransportOptions {
  apiKey: string;
  baseUrl?: string;
  /** Send `reasoning_effort` (only for reasoning models; others reject it). */
  reasoningEffort?: boolean;
}

/** {@link ChatTransport} for the OpenAI Chat Completions API. */
export class OpenAITransport extends OpenAIStyleTransport {
  constructor(options: OpenAITransportOptions) {
    if (!options.apiKey) throw new TrailPackError('not_configured', 'Chybí API klíč OpenAI.', { provider: 'openai' });
    super({
      ...options,
      providerId: 'openai',
      label: 'OpenAI',
      baseUrl: options.baseUrl ?? 'https://api.openai.com/v1',
      maxTokensParam: 'max_completion_tokens',
      reasoningEffort: options.reasoningEffort ?? false,
    });
  }
}

/** OpenAI / compatible error envelope → TrailPackError. */
export function mapOpenAIError(providerId: string, label: string, failure: HttpFailure): TrailPackError {
  const err = mapStatusError(providerId, label, failure);
  const code = (err.details as { code?: string } | undefined)?.code;
  if (failure.status === 429 && code === 'insufficient_quota') {
    return new TrailPackError('rate_limited', `Na účtu ${label} došel kredit nebo kvóta. Doplňte prostředky v nastavení účtu.`, {
      provider: providerId,
      status: 429,
      retryable: false,
      details: err.details,
    });
  }
  return err;
}

/** Normalised conversation → Chat Completions messages (system first, tool results as separate `tool` messages). */
export function toOpenAIMessages(system: string, messages: ChatMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'tool') {
      for (const p of m.parts) {
        if (p.type === 'tool_result') out.push({ role: 'tool', tool_call_id: p.toolCallId, content: p.content });
      }
    } else if (m.role === 'assistant') {
      const text = m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');
      const calls = m.parts.flatMap((p) =>
        p.type === 'tool_call' ? [{ id: p.id, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.arguments) } }] : [],
      );
      if (text === '' && calls.length === 0) continue;
      const msg: Record<string, unknown> = { role: 'assistant', content: text === '' ? null : text };
      if (calls.length > 0) msg.tool_calls = calls;
      out.push(msg);
    } else {
      const blocks = m.parts.flatMap((p): Record<string, unknown>[] => {
        if (p.type === 'text') return p.text === '' ? [] : [{ type: 'text', text: p.text }];
        if (p.type === 'image') return [{ type: 'image_url', image_url: { url: imageDataUrl(p.mimeType, p.data) } }];
        return [];
      });
      if (blocks.length === 0) continue;
      const onlyText = blocks.every((b) => b.type === 'text');
      out.push({ role: 'user', content: onlyText ? blocks.map((b) => b.text as string).join('\n') : blocks });
    }
  }
  return out;
}

function mapFinishReason(reason: unknown, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return 'tool_use';
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end';
  }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.flatMap((c) => (isRecord(c) && typeof c.text === 'string' ? [c.text] : [])).join('');
  }
  return '';
}

/** Parse a Chat Completions response body. */
export function parseOpenAIResponse(data: unknown, providerId: AiProviderId, requestedModel: string): ChatResponse {
  const label = providerId === 'openai' ? 'OpenAI' : 'lokální server';
  if (!isRecord(data) || !Array.isArray(data.choices) || !isRecord(data.choices[0])) throw badPayload(providerId, label, 'chybí choices');
  const choice = data.choices[0];
  const msg = isRecord(choice.message) ? choice.message : {};
  const parts: ChatPart[] = [];
  const text = contentText(msg.content);
  if (text !== '') parts.push({ type: 'text', text });
  const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  for (const c of rawCalls) {
    if (!isRecord(c) || !isRecord(c.function) || typeof c.function.name !== 'string') continue;
    parts.push({
      type: 'tool_call',
      id: typeof c.id === 'string' && c.id !== '' ? c.id : randomId('call_'),
      name: c.function.name,
      arguments: parseToolArguments(c.function.arguments),
    });
  }
  const hasCalls = parts.some((p) => p.type === 'tool_call');
  const model = typeof data.model === 'string' && data.model !== '' ? data.model : requestedModel;
  let stopReason = mapFinishReason(choice.finish_reason, hasCalls);
  const refusalText = typeof msg.refusal === 'string' && msg.refusal !== '' ? msg.refusal : undefined;
  if (refusalText !== undefined && !hasCalls) stopReason = 'refusal';
  const response: ChatResponse = { message: { role: 'assistant', parts }, stopReason, usage: parseUsage(data.usage, providerId, model), model, provider: providerId };
  if (stopReason === 'refusal') {
    response.refusal = { category: choice.finish_reason === 'content_filter' ? 'content_filter' : null, explanation: refusalText ?? null };
  }
  return response;
}

function parseUsage(u: unknown, providerId: AiProviderId, model: string): Usage {
  const r = isRecord(u) ? u : {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const details = isRecord(r.prompt_tokens_details) ? r.prompt_tokens_details : {};
  const cached = num(details.cached_tokens);
  const usage = { inputTokens: Math.max(0, num(r.prompt_tokens) - cached), outputTokens: num(r.completion_tokens), cacheReadTokens: cached };
  return { ...usage, costUsd: estimateCost(providerId, model, usage).costUsd };
}
