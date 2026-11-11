import { describe, expect, it } from 'vitest';
import { TrailPackError } from '@trailpack/shared';
import { AnthropicTransport, estimateCost, registerPricing} from '../src/providers';
import type { ChatMessage, ChatRequest } from '../src/types';
import { FAST, mockFetch } from './providers.fixtures';

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  system: 'Jsi asistent.',
  messages: [{ role: 'user', parts: [{ type: 'text', text: 'Ahoj' }] }],
  ...over,
});

const okBody = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content,
  stop_reason: 'end_turn',
  usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
  ...extra,
});

describe('AnthropicTransport request mapping', () => {
  it('sends the documented headers and a safe body', async () => {
    const { fetch, calls } = mockFetch([{ body: okBody([{ type: 'text', text: 'Ahoj!' }]) }]);
    const t = new AnthropicTransport({ apiKey: 'sk-ant-secret123', fetch, browserDirect: true, ...FAST });
    const res = await t.chat(req({ tools: [{ name: 'getWeather', description: 'w', parameters: { type: 'object', properties: {} } }] }));
    const c = calls[0]!;
    expect(c.url).toBe('https://api.anthropic.com/v1/messages');
    expect(c.headers['x-api-key']).toBe('sk-ant-secret123');
    expect(c.headers['anthropic-version']).toBe('2023-06-01');
    expect(c.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(c.headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(c.body.fallbacks).toBe('default');
    expect(c.body.system).toBe('Jsi asistent.');
    expect(c.body.max_tokens).toBe(16000);
    expect(c.body.output_config).toEqual({ effort: 'medium' });
    expect(c.body.tool_choice).toEqual({ type: 'auto' });
    expect(c.body.tools[0]).toEqual({ name: 'getWeather', description: 'w', input_schema: { type: 'object', properties: {} } });
    for (const k of ['temperature', 'top_p', 'top_k', 'thinking']) expect(c.body).not.toHaveProperty(k);
    expect(res.message.parts).toEqual([{ type: 'text', text: 'Ahoj!' }]);
    expect(res.stopReason).toBe('end');
    // 1000*4 + 500*20 + 2000*0.2 per million
    expect(res.usage.costUsd).toBeCloseTo((4000 + 10000 + 400) / 1e6, 10);
  });

  it('omits fallbacks for haiku and when disabled; no browser header by default', async () => {
    const a = mockFetch([{ body: okBody([]) }]);
    await new AnthropicTransport({ apiKey: 'k', fetch: a.fetch, ...FAST }).chat(req({ model: 'claude-haiku-5-5' }));
    expect(a.calls[0]!.body).not.toHaveProperty('fallbacks');
    expect(a.calls[0]!.headers['anthropic-beta']).toBeUndefined();
    expect(a.calls[0]!.headers['anthropic-dangerous-direct-browser-access']).toBeUndefined();
    const b = mockFetch([{ body: okBody([]) }]);
    await new AnthropicTransport({ apiKey: 'k', fetch: b.fetch, fallbacks: false, ...FAST }).chat(req());
    expect(b.calls[0]!.body).not.toHaveProperty('fallbacks');
  });

  it('maps images, tool calls and groups all tool results into ONE user message', async () => {
    const { fetch, calls } = mockFetch([{ body: okBody([{ type: 'text', text: 'ok' }]) }]);
    const messages: ChatMessage[] = [
      { role: 'user', parts: [{ type: 'text', text: 'Počasí?' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'tool_call', id: 't1', name: 'weather', arguments: { lat: 1 } },
          { type: 'tool_call', id: 't2', name: 'poi', arguments: {} },
        ],
      },
      {
        role: 'tool',
        parts: [
          { type: 'tool_result', toolCallId: 't1', name: 'weather', content: '{"t":5}' },
          { type: 'tool_result', toolCallId: 't2', name: 'poi', content: 'boom', isError: true },
        ],
      },
      { role: 'user', parts: [{ type: 'text', text: 'Díky' }] },
    ];
    await new AnthropicTransport({ apiKey: 'k', fetch, ...FAST }).chat(req({ messages }));
    const sent = calls[0]!.body.messages;
    expect(sent).toHaveLength(3);
    expect(sent[0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
    expect(sent[1].content[0]).toEqual({ type: 'tool_use', id: 't1', name: 'weather', input: { lat: 1 } });
    expect(sent[2].role).toBe('user');
    expect(sent[2].content.map((b: any) => b.type)).toEqual(['tool_result', 'tool_result', 'text']);
    expect(sent[2].content[0]).toEqual({ type: 'tool_result', tool_use_id: 't1', content: '{"t":5}' });
    expect(sent[2].content[1].is_error).toBe(true);
  });

  it('parses tool_use, keeps raw content incl. thinking, and replays it verbatim to the same model only', async () => {
    const thinking = { type: 'thinking', thinking: 'hmm', signature: 'SIG==' };
    const content = [thinking, { type: 'text', text: 'Zjistím to.' }, { type: 'tool_use', id: 'tu1', name: 'weather', input: { a: 1 } }];
    const first = mockFetch([{ body: okBody(content, { stop_reason: 'tool_use' }) }]);
    const t = new AnthropicTransport({ apiKey: 'k', fetch: first.fetch, ...FAST });
    const res = await t.chat(req());
    expect(res.stopReason).toBe('tool_use');
    expect(res.message.parts).toEqual([
      { type: 'text', text: 'Zjistím to.' },
      { type: 'tool_call', id: 'tu1', name: 'weather', arguments: { a: 1 } },
    ]);
    expect(res.message.providerRaw).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5', content });

    const history: ChatMessage[] = [
      ...req().messages,
      res.message,
      { role: 'tool', parts: [{ type: 'tool_result', toolCallId: 'tu1', name: 'weather', content: '{}' }] },
    ];
    const second = mockFetch([{ body: okBody([{ type: 'text', text: 'x' }]) }]);
    await new AnthropicTransport({ apiKey: 'k', fetch: second.fetch, ...FAST }).chat(req({ messages: history }));
    expect(second.calls[0]!.body.messages[1].content).toEqual(content);

    // different model -> rebuilt from parts, thinking dropped
    const third = mockFetch([{ body: okBody([{ type: 'text', text: 'x' }]) }]);
    await new AnthropicTransport({ apiKey: 'k', fetch: third.fetch, ...FAST }).chat(req({ model: 'claude-sonnet-5-5', messages: history }));
    const rebuilt = third.calls[0]!.body.messages[1].content;
    expect(rebuilt.map((b: any) => b.type)).toEqual(['text', 'tool_use']);
  });

  it('maps refusal with stop_details', async () => {
    const { fetch } = mockFetch([
      { body: okBody([], { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'nope' } }) },
    ]);
    const res = await new AnthropicTransport({ apiKey: 'k', fetch, ...FAST }).chat(req());
    expect(res.stopReason).toBe('refusal');
    expect(res.refusal).toEqual({ category: 'cyber', explanation: 'nope' });
  });

  it('maps max_tokens and pause_turn', async () => {
    const a = await new AnthropicTransport({ apiKey: 'k', fetch: mockFetch([{ body: okBody([], { stop_reason: 'max_tokens' }) }]).fetch, ...FAST }).chat(req());
    expect(a.stopReason).toBe('max_tokens');
    const b = await new AnthropicTransport({ apiKey: 'k', fetch: mockFetch([{ body: okBody([], { stop_reason: 'pause_turn' }) }]).fetch, ...FAST }).chat(req());
    expect(b.stopReason).toBe('end');
  });
});

describe('AnthropicTransport errors', () => {
  const run = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new AnthropicTransport({ apiKey: 'sk-ant-secret123', fetch: mockFetch([{ status, body, headers }]).fetch, ...FAST }).chat(req());
  const expectErr = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e as TrailPackError;
    }
    throw new Error('expected rejection');
  };

  it('401 -> unauthorized (Czech)', async () => {
    const e = await expectErr(run(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key sk-ant-secret123' } }));
    expect(e.code).toBe('unauthorized');
    expect(e.message).toContain('Neplatný API klíč Anthropic');
    expect(JSON.stringify(e.details)).not.toContain('secret123');
  });
  it('429 -> rate_limited with retry-after', async () => {
    const e = await expectErr(run(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow' } }, { 'retry-after': '7' }));
    expect(e.code).toBe('rate_limited');
    expect(e.retryable).toBe(true);
    expect(e.message).toContain('7 s');
  });
  it('529 and 500 -> retryable provider_error', async () => {
    for (const s of [529, 500]) {
      const e = await expectErr(run(s, { type: 'error', error: { type: 'overloaded_error', message: 'x' } }));
      expect(e.code).toBe('provider_error');
      expect(e.retryable).toBe(true);
    }
  });
  it('400 -> invalid_input with API message', async () => {
    const e = await expectErr(run(400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens too large' } }));
    expect(e.code).toBe('invalid_input');
    expect(e.message).toContain('max_tokens too large');
  });
  it('retries a 529 once and succeeds', async () => {
    const { fetch, calls } = mockFetch([{ status: 529, body: { error: { message: 'busy' } } }, { body: okBody([{ type: 'text', text: 'ok' }]) }]);
    const res = await new AnthropicTransport({ apiKey: 'k', fetch, retries: 2, retryBaseDelayMs: 0 }).chat(req());
    expect(calls).toHaveLength(2);
    expect(res.message.parts).toHaveLength(1);
  });
  it('abort -> aborted; missing key -> not_configured', async () => {
    const ac = new AbortController();
    ac.abort();
    const e = await expectErr(new AnthropicTransport({ apiKey: 'k', fetch: mockFetch([{ body: okBody([]) }]).fetch }).chat(req(), ac.signal));
    expect(e.code).toBe('aborted');
    expect(() => new AnthropicTransport({ apiKey: '' })).toThrow(/Chybí API klíč/);
  });
  it('listModels', async () => {
    const { fetch, calls } = mockFetch([{ body: { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }] } }]);
    const models = await new AnthropicTransport({ apiKey: 'k', fetch, ...FAST }).listModels();
    expect(models).toEqual([{ id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' }]);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toContain('/v1/models');
  });
});

describe('pricing', () => {
  it('knows Anthropic prices and not others', () => {
    expect(estimateCost('anthropic', 'claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toEqual({ costUsd: 12, priced: true });
    expect(estimateCost('anthropic', 'claude-fable-5-2', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }).costUsd).toBeCloseTo(0.2);
    expect(estimateCost('anthropic', 'claude-haiku-5-5-20261101', { inputTokens: 1_000_000, outputTokens: 0 }).costUsd).toBeCloseTo(0.1);
    expect(estimateCost('openai', 'some-model', { inputTokens: 5, outputTokens: 5 })).toEqual({ costUsd: 0, priced: false });
  });
  it('registerPricing', () => {
    registerPricing('openai', 'test-model-x', { input: 1, output: 2 });
    expect(estimateCost('openai', 'test-model-x', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toEqual({ costUsd: 3, priced: true });
    expect(() => registerPricing('openai', 'bad', { input: -1, output: 1 })).toThrow();
  });
});
