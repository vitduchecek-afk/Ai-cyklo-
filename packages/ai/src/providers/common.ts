/**
 * Helpers shared by the provider adapters.
 */
import { TrailPackError } from '@trailpack/shared';
import type { ChatMessage, ChatPart, ChatRequest, ToolCallPart, ToolResultPart } from '../types';
import { isRecord, type TransportHttpOptions } from './http';

/** A model offered by a provider's `/models` endpoint. */
export interface ModelInfo {
  id: string;
  displayName?: string;
}

/** Transports that can enumerate the models available to the configured key. */
export interface ModelListing {
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
}

/** Options accepted by every direct provider transport. */
export type DirectTransportOptions = TransportHttpOptions;

/** Parse tool-call arguments emitted as a JSON string; malformed input yields `{}`. */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** `data:` URL for an inline image part. */
export function imageDataUrl(mimeType: string, data: string): string {
  return `data:${mimeType};base64,${data}`;
}

/** Concatenate the text parts of a message. */
export function textOf(parts: ChatPart[]): string {
  return parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');
}

export const toolCallsOf = (parts: ChatPart[]): ToolCallPart[] => parts.filter((p): p is ToolCallPart => p.type === 'tool_call');
export const toolResultsOf = (parts: ChatPart[]): ToolResultPart[] => parts.filter((p): p is ToolResultPart => p.type === 'tool_result');

/** Fail early (before any network traffic) on requests no provider can answer. */
export function assertChatRequest(request: ChatRequest, providerId: string): void {
  if (!request.model || request.model.trim() === '') {
    throw new TrailPackError('invalid_input', 'Není vybrán žádný model.', { provider: providerId });
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new TrailPackError('invalid_input', 'Konverzace neobsahuje žádnou zprávu.', { provider: providerId });
  }
}

/** True when the message is an assistant turn whose raw content may be replayed to this provider+model. */
export function hasReplayableRaw(message: ChatMessage, provider: string, model: string): boolean {
  const raw = message.providerRaw;
  return message.role === 'assistant' && raw !== undefined && raw.provider === provider && raw.model === model && raw.content !== undefined;
}

/** Malformed provider payload. */
export function badPayload(providerId: string, label: string, detail: string): TrailPackError {
  return new TrailPackError('provider_error', `Služba ${label} vrátila neočekávanou odpověď (${detail}).`, { provider: providerId, retryable: false });
}
