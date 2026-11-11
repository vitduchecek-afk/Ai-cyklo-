/**
 * Google Gemini (`generateContent`) transport using raw `fetch`.
 *
 * Model turns are kept verbatim in `providerRaw` (Gemini 3 requires the
 * `thoughtSignature` of function calls to be sent back unchanged).
 */
import { TrailPackError } from '@trailpack/shared';
import type { ChatMessage, ChatPart, ChatRequest, ChatResponse, ChatTransport, StopReason, ToolDefinition, Usage } from '../types';
import { assertChatRequest, badPayload, hasReplayableRaw, type DirectTransportOptions, type ModelInfo, type ModelListing } from './common';
import { callJson, DEFAULT_LIST_TIMEOUT_MS, extractApiError, isRecord, joinUrl, mapStatusError, randomId, resolveHttpOptions, type HttpFailure, type ResolvedHttpOptions } from './http';
import { estimateCost } from './pricing';

export interface GeminiTransportOptions extends DirectTransportOptions {
  apiKey: string;
  baseUrl?: string;
}

type GeminiPart = Record<string, unknown>;
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

const SYNTHETIC_ID_PREFIX = 'gemini_';

/** {@link ChatTransport} for `models/{model}:generateContent`. */
export class GeminiTransport implements ChatTransport, ModelListing {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly http: ResolvedHttpOptions;

  constructor(options: GeminiTransportOptions) {
    if (!options.apiKey) throw new TrailPackError('not_configured', 'Chybí API klíč Google Gemini.', { provider: 'gemini' });
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    this.http = resolveHttpOptions(options);
  }

  private headers(): Record<string, string> {
    return { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' };
  }

  /** Build the JSON body for `generateContent` (exposed for tests). */
  buildBody(request: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = { contents: toGeminiContents(request.messages, request.model) };
    if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };
    if (request.tools && request.tools.length > 0) body.tools = [{ functionDeclarations: request.tools.map(toFunctionDeclaration) }];
    if (request.maxTokens !== undefined) body.generationConfig = { maxOutputTokens: request.maxTokens };
    return body;
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    assertChatRequest(request, 'gemini');
    const modelPath = request.model.replace(/^models\//, '');
    const { data } = await callJson<unknown>(this.http, {
      providerId: 'gemini',
      providerLabel: 'Google Gemini',
      url: joinUrl(this.baseUrl, `/models/${encodeURIComponent(modelPath)}:generateContent`),
      method: 'POST',
      headers: this.headers(),
      body: this.buildBody({ ...request, model: modelPath }),
      signal,
      mapError: mapGeminiError,
      secrets: [this.apiKey],
    });
    return parseGeminiResponse(data, modelPath);
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const { data } = await callJson<unknown>(
      this.http,
      {
        providerId: 'gemini',
        providerLabel: 'Google Gemini',
        url: joinUrl(this.baseUrl, '/models?pageSize=1000'),
        method: 'GET',
        headers: this.headers(),
        signal,
        mapError: mapGeminiError,
        secrets: [this.apiKey],
      },
      { timeoutMs: DEFAULT_LIST_TIMEOUT_MS },
    );
    const list = isRecord(data) && Array.isArray(data.models) ? data.models : [];
    return list.flatMap((m): ModelInfo[] => {
      if (!isRecord(m) || typeof m.name !== 'string') return [];
      const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : ['generateContent'];
      if (!methods.includes('generateContent')) return [];
      return [{ id: m.name.replace(/^models\//, ''), displayName: typeof m.displayName === 'string' ? m.displayName : undefined }];
    });
  }
}

/** Google error envelope → TrailPackError (invalid key is reported as HTTP 400 `API_KEY_INVALID`). */
export function mapGeminiError(failure: HttpFailure): TrailPackError {
  const info = extractApiError(failure.body);
  if (failure.status === 400 && (info.reasons?.includes('API_KEY_INVALID') || /api key not valid/i.test(info.message ?? ''))) {
    return new TrailPackError('unauthorized', 'Neplatný API klíč Google Gemini.', { provider: 'gemini', status: 400, retryable: false });
  }
  return mapStatusError('gemini', 'Google Gemini', failure);
}

const SCHEMA_KEYS = new Set(['type', 'format', 'description', 'nullable', 'enum', 'properties', 'required', 'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'title', 'anyOf']);

/**
 * Reduce a JSON Schema to the OpenAPI subset Gemini accepts: unsupported
 * keywords (`additionalProperties`, `$schema`, `$ref`, `default` …) are dropped,
 * `const` becomes a one-value `enum` and `["x","null"]` types become `nullable`.
 */
export function sanitizeGeminiSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'const') {
      out.enum = [value];
    } else if (key === 'type' && Array.isArray(value)) {
      const types = value.filter((t): t is string => typeof t === 'string' && t !== 'null');
      if (types.length < value.length) out.nullable = true;
      if (types[0]) out.type = types[0];
    } else if (!SCHEMA_KEYS.has(key)) {
      continue;
    } else if (key === 'properties' && isRecord(value)) {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeGeminiSchema(v)]));
    } else if (key === 'items') {
      out.items = sanitizeGeminiSchema(value);
    } else if (key === 'anyOf' && Array.isArray(value)) {
      out.anyOf = value.map(sanitizeGeminiSchema);
    } else if (key === 'required' && Array.isArray(value)) {
      out.required = value.filter((r) => typeof r === 'string');
    } else {
      out[key] = value;
    }
  }
  return out;
}

function toFunctionDeclaration(t: ToolDefinition): Record<string, unknown> {
  const parameters = sanitizeGeminiSchema(t.parameters);
  const props = parameters.properties;
  const decl: Record<string, unknown> = { name: t.name, description: t.description };
  // Gemini rejects OBJECT schemas without properties.
  if (isRecord(props) && Object.keys(props).length > 0) decl.parameters = parameters;
  return decl;
}

function parseJsonOrText(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/** Normalised conversation → Gemini `contents`. */
export function toGeminiContents(messages: ChatMessage[], model: string): GeminiContent[] {
  const out: GeminiContent[] = [];
  const push = (role: 'user' | 'model', parts: GeminiPart[]) => {
    if (parts.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else out.push({ role, parts: [...parts] });
  };
  for (const m of messages) {
    if (m.role === 'assistant') {
      const raw = m.providerRaw?.content;
      if (hasReplayableRaw(m, 'gemini', model) && isRecord(raw) && Array.isArray(raw.parts)) {
        push('model', raw.parts as GeminiPart[]);
      } else {
        push('model', m.parts.flatMap(partToGemini));
      }
    } else {
      push('user', m.parts.flatMap(partToGemini));
    }
  }
  return out;
}

function partToGemini(p: ChatPart): GeminiPart[] {
  switch (p.type) {
    case 'text':
      return p.text === '' ? [] : [{ text: p.text }];
    case 'image':
      return [{ inlineData: { mimeType: p.mimeType, data: p.data } }];
    case 'tool_call': {
      const fc: Record<string, unknown> = { name: p.name, args: p.arguments };
      if (!p.id.startsWith(SYNTHETIC_ID_PREFIX)) fc.id = p.id;
      return [{ functionCall: fc }];
    }
    case 'tool_result': {
      const fr: Record<string, unknown> = {
        name: p.name,
        response: p.isError ? { content: parseJsonOrText(p.content), error: true } : { content: parseJsonOrText(p.content) },
      };
      if (!p.toolCallId.startsWith(SYNTHETIC_ID_PREFIX)) fr.id = p.toolCallId;
      return [{ functionResponse: fr }];
    }
  }
}

const REFUSAL_FINISH = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'LANGUAGE']);

/** Parse a `generateContent` response body. */
export function parseGeminiResponse(data: unknown, requestedModel: string): ChatResponse {
  if (!isRecord(data)) throw badPayload('gemini', 'Google Gemini', 'tělo odpovědi není objekt');
  const model = typeof data.modelVersion === 'string' && data.modelVersion !== '' ? data.modelVersion : requestedModel;
  const usage = parseUsage(data.usageMetadata, model);
  const candidate = Array.isArray(data.candidates) && isRecord(data.candidates[0]) ? data.candidates[0] : undefined;

  if (!candidate) {
    const feedback = isRecord(data.promptFeedback) ? data.promptFeedback : {};
    if (typeof feedback.blockReason === 'string') {
      return {
        message: { role: 'assistant', parts: [] },
        stopReason: 'refusal',
        usage,
        model,
        provider: 'gemini',
        refusal: { category: feedback.blockReason, explanation: typeof feedback.blockReasonMessage === 'string' ? feedback.blockReasonMessage : null },
      };
    }
    throw badPayload('gemini', 'Google Gemini', 'chybí kandidát odpovědi');
  }

  const content = isRecord(candidate.content) ? candidate.content : { role: 'model', parts: [] };
  const rawParts = Array.isArray(content.parts) ? content.parts : [];
  const parts: ChatPart[] = [];
  for (const p of rawParts) {
    if (!isRecord(p) || p.thought === true) continue;
    if (typeof p.text === 'string') {
      if (p.text !== '') parts.push({ type: 'text', text: p.text });
    } else if (isRecord(p.functionCall) && typeof p.functionCall.name === 'string') {
      const fc = p.functionCall;
      parts.push({
        type: 'tool_call',
        id: typeof fc.id === 'string' && fc.id !== '' ? fc.id : randomId(SYNTHETIC_ID_PREFIX),
        name: fc.name as string,
        arguments: isRecord(fc.args) ? fc.args : {},
      });
    }
  }
  const finish = typeof candidate.finishReason === 'string' ? candidate.finishReason : 'STOP';
  const hasCalls = parts.some((p) => p.type === 'tool_call');
  let stopReason: StopReason;
  if (REFUSAL_FINISH.has(finish)) stopReason = 'refusal';
  else if (finish === 'MAX_TOKENS') stopReason = 'max_tokens';
  else if (finish === 'MALFORMED_FUNCTION_CALL' || finish === 'UNEXPECTED_TOOL_CALL') stopReason = 'error';
  else stopReason = hasCalls ? 'tool_use' : 'end';

  const response: ChatResponse = {
    message: { role: 'assistant', parts, providerRaw: { provider: 'gemini', model: requestedModel, content: { role: 'model', parts: rawParts } } },
    stopReason,
    usage,
    model,
    provider: 'gemini',
  };
  if (stopReason === 'refusal') {
    response.refusal = { category: finish, explanation: typeof candidate.finishMessage === 'string' ? candidate.finishMessage : null };
  }
  return response;
}

function parseUsage(u: unknown, model: string): Usage {
  const r = isRecord(u) ? u : {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const cached = num(r.cachedContentTokenCount);
  const usage = {
    inputTokens: Math.max(0, num(r.promptTokenCount) - cached),
    // thinking tokens are billed as output
    outputTokens: num(r.candidatesTokenCount) + num(r.thoughtsTokenCount),
    cacheReadTokens: cached,
  };
  return { ...usage, costUsd: estimateCost('gemini', model, usage).costUsd };
}
