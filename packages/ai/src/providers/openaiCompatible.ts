/**
 * Transport for OpenAI-compatible servers running on the user's own hardware
 * (Ollama, LM Studio, vLLM, llama.cpp server …). Reuses the OpenAI wire format.
 */
import { TrailPackError } from '@trailpack/shared';
import type { ChatRequest, ChatResponse } from '../types';
import type { DirectTransportOptions } from './common';
import { OpenAIStyleTransport } from './openai';

export interface OpenAICompatibleTransportOptions extends DirectTransportOptions {
  /** e.g. `http://192.168.1.10:11434/v1` */
  baseUrl: string;
  /** Optional – most local servers need none. */
  apiKey?: string;
}

/** Shown to the user when the local model could not be given tools. */
export const NO_TOOLS_NOTE = 'Poznámka: tento lokální model nepodporuje volání nástrojů, odpověď vznikla bez nich (bez ověřených dat z aplikace).';

const TOOLS_REJECTED = /\btools?\b|function[ _]call|tool_calls?/i;

/** {@link ChatTransport} for OpenAI-compatible local servers. */
export class OpenAICompatibleTransport extends OpenAIStyleTransport {
  constructor(options: OpenAICompatibleTransportOptions) {
    if (!options.baseUrl) throw new TrailPackError('not_configured', 'Chybí adresa lokálního serveru (OpenAI-compatible).', { provider: 'openai_compatible' });
    super({
      ...options,
      providerId: 'openai_compatible',
      label: 'lokální server',
      maxTokensParam: 'max_tokens',
      reasoningEffort: false,
    });
  }

  override async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const hasTools = (request.tools?.length ?? 0) > 0;
    try {
      return await this.send(request, signal, {});
    } catch (e) {
      if (!hasTools || !(e instanceof TrailPackError) || e.code !== 'invalid_input' || e.status !== 400) throw e;
      const api = (e.details as { apiMessage?: string } | undefined)?.apiMessage ?? e.message;
      if (!TOOLS_REJECTED.test(api)) throw e;
      const res = await this.send(request, signal, { omitTools: true });
      res.message.parts.push({ type: 'text', text: `\n\n${NO_TOOLS_NOTE}` });
      return res;
    }
  }
}
