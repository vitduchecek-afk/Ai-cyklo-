import { describe, expect, it } from 'vitest';
import { TrailPackError } from '@trailpack/shared';
import {
  GeminiTransport,
  OpenAICompatibleTransport,
  OpenAITransport,
  ProxyTransport,
  createProviderTransport,
  sanitizeGeminiSchema,
  PROVIDER_MODELS,
} from '../src/providers';
import type { ChatMessage, ChatRequest } from '../src/types';
import { FAST, mockFetch } from './providers.fixtures';

const base = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  provider: 'openai',
  model: 'gpt-test',
  system: 'sys',
  messages: [{ role: 'user', parts: [{ type: 'text', text: 'Ahoj' }] }],
  ...over,
});

const toolHistory: ChatMessage[] = [
  { role: 'user', parts: [{ type: 'text', text: 'Počasí?' }, { type: 'image', mimeType: 'image/jpeg', data: 'QQ==' }] },
  {
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Zjišťuji' },
      { type: 'tool_call', id: 'c1', name: 'weather', arguments: { lat: 50 } },
      { type: 'tool_call', id: 'c2', name: 'poi', arguments: {} },
    ],
  },
  {
    role: 'tool',
    parts: [
      { type: 'tool_result', toolCallId: 'c1', name: 'weather', content: '{"t":5}' },
      { type: 'tool_result', toolCallId: 'c2', name: 'poi', content: 'err', isError: true },
    ],
  },
];

async function rejection(p: Promise<unknown>): Promise<TrailPackError> {
  try {
    await p;
  } catch (e) {
    return e as TrailPackError;
  }
  throw new Error('expected rejection');
}

describe('OpenAITransport', () => {
  const completion = (message: Record<string, unknown>, finish = 'stop', extra: Record<string, unknown> = {}) => ({
    id: 'chatcmpl-1',
    model: 'gpt-test',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
    usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } },
    ...extra,
  });

  it('maps messages, images, tools and tool results', async () => {
    const { fetch, calls } = mockFetch([{ body: completion({ content: 'ok' }) }]);
    const t = new OpenAITransport({ apiKey: 'sk-test-abcdef', fetch, ...FAST, reasoningEffort: true });
    const res = await t.chat(base({ messages: toolHistory, maxTokens: 500, effort: 'high', tools: [{ name: 'weather', description: 'w', parameters: { type: 'object' } }] }));
    const c = calls[0]!;
    expect(c.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(c.headers.authorization).toBe('Bearer sk-test-abcdef');
    expect(c.body.max_completion_tokens).toBe(500);
    expect(c.body.reasoning_effort).toBe('high');
    expect(c.body.tools[0]).toEqual({ type: 'function', function: { name: 'weather', description: 'w', parameters: { type: 'object' } } });
    const m = c.body.messages;
    expect(m[0]).toEqual({ role: 'system', content: 'sys' });
    expect(m[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QQ==' } });
    expect(m[2].tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"lat":50}' } },
      { id: 'c2', type: 'function', function: { name: 'poi', arguments: '{}' } },
    ]);
    expect(m[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"t":5}' });
    expect(m[4]).toEqual({ role: 'tool', tool_call_id: 'c2', content: 'err' });
    expect(res.usage).toMatchObject({ inputTokens: 100, outputTokens: 30, cacheReadTokens: 20, costUsd: 0 });
  });

  it('requires a model and omits reasoning_effort by default', async () => {
    const { fetch, calls } = mockFetch([{ body: completion({ content: 'ok' }) }]);
    const t = new OpenAITransport({ apiKey: 'k', fetch, ...FAST });
    expect((await rejection(t.chat(base({ model: '' })))).code).toBe('invalid_input');
    await t.chat(base({ effort: 'low' }));
    expect(calls[0]!.body).not.toHaveProperty('reasoning_effort');
  });

  it('parses tool calls and finish reasons', async () => {
    const t = (body: unknown) => new OpenAITransport({ apiKey: 'k', fetch: mockFetch([{ body }]).fetch, ...FAST });
    const r = await t(completion({ content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'weather', arguments: '{"a":1}' } }] }, 'tool_calls')).chat(base());
    expect(r.stopReason).toBe('tool_use');
    expect(r.message.parts).toEqual([{ type: 'tool_call', id: 'x', name: 'weather', arguments: { a: 1 } }]);
    expect((await t(completion({ content: 'a' }, 'length')).chat(base())).stopReason).toBe('max_tokens');
    const refused = await t(completion({ content: null, refusal: 'Nemohu.' }, 'stop')).chat(base());
    expect(refused.stopReason).toBe('refusal');
    expect(refused.refusal?.explanation).toBe('Nemohu.');
    expect((await t(completion({ content: '' }, 'content_filter')).chat(base())).stopReason).toBe('refusal');
  });

  it('maps 401/429/500', async () => {
    const run = (status: number, headers: Record<string, string> = {}) =>
      rejection(new OpenAITransport({ apiKey: 'sk-test-abcdef', fetch: mockFetch([{ status, body: { error: { message: 'bad sk-test-abcdef', code: 'x' } }, headers }]).fetch, ...FAST }).chat(base()));
    expect((await run(401)).code).toBe('unauthorized');
    const e429 = await run(429, { 'retry-after': '3' });
    expect(e429.code).toBe('rate_limited');
    const e500 = await run(500);
    expect(e500.code).toBe('provider_error');
    expect(e500.retryable).toBe(true);
    expect(JSON.stringify((await run(401)).details)).not.toContain('abcdef');
  });

  it('listModels', async () => {
    const { fetch, calls } = mockFetch([{ body: { data: [{ id: 'gpt-a' }, { id: 'gpt-b' }] } }]);
    expect(await new OpenAITransport({ apiKey: 'k', fetch }).listModels()).toEqual([{ id: 'gpt-a' }, { id: 'gpt-b' }]);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/models');
  });
});

describe('OpenAICompatibleTransport', () => {
  it('works without key, uses max_tokens and reports provider', async () => {
    const { fetch, calls } = mockFetch([{ body: { model: 'llama3', choices: [{ message: { content: 'Ahoj' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } } }]);
    const t = new OpenAICompatibleTransport({ baseUrl: 'http://192.168.1.10:11434/v1/', fetch, ...FAST });
    const res = await t.chat(base({ provider: 'openai_compatible', model: 'llama3', maxTokens: 100 }));
    expect(calls[0]!.url).toBe('http://192.168.1.10:11434/v1/chat/completions');
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.body.max_tokens).toBe(100);
    expect(res.provider).toBe('openai_compatible');
    expect(res.usage.costUsd).toBe(0);
  });

  it('retries once without tools and adds a Czech note', async () => {
    const { fetch, calls } = mockFetch([
      { status: 400, body: { error: { message: 'registry.ollama.ai/library/gemma does not support tools' } } },
      { body: { model: 'gemma', choices: [{ message: { content: 'Odpověď' }, finish_reason: 'stop' }] } },
    ]);
    const t = new OpenAICompatibleTransport({ baseUrl: 'http://x/v1', fetch, ...FAST });
    const res = await t.chat(base({ model: 'gemma', tools: [{ name: 'a', description: 'd', parameters: {} }] }));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.tools).toBeDefined();
    expect(calls[1]!.body).not.toHaveProperty('tools');
    const text = res.message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    expect(text).toContain('Odpověď');
    expect(text).toContain('nepodporuje volání nástrojů');
  });

  it('does not retry unrelated 400s', async () => {
    const { fetch, calls } = mockFetch([{ status: 400, body: { error: 'model not found' } }]);
    const e = await rejection(new OpenAICompatibleTransport({ baseUrl: 'http://x/v1', fetch, ...FAST }).chat(base({ tools: [{ name: 'a', description: 'd', parameters: {} }] })));
    expect(e.code).toBe('invalid_input');
    expect(calls).toHaveLength(1);
  });
});

describe('GeminiTransport', () => {
  const gBody = (parts: unknown[], finishReason = 'STOP') => ({
    candidates: [{ content: { role: 'model', parts }, finishReason }],
    usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, thoughtsTokenCount: 5, cachedContentTokenCount: 10 },
    modelVersion: 'gemini-test',
  });

  it('maps request: systemInstruction, contents, tools, header', async () => {
    const { fetch, calls } = mockFetch([{ body: gBody([{ text: 'ok' }]) }]);
    const t = new GeminiTransport({ apiKey: 'AIzaSyFakeKey123456', fetch, ...FAST });
    const tools = [
      {
        name: 'weather',
        description: 'w',
        parameters: { $schema: 'x', type: 'object', additionalProperties: false, properties: { lat: { type: 'number', default: 1 }, tag: { type: ['string', 'null'] } }, required: ['lat'] },
      },
      { name: 'noargs', description: 'n', parameters: { type: 'object', properties: {}, additionalProperties: false } },
    ];
    const res = await t.chat(base({ provider: 'gemini', model: 'gemini-test', messages: toolHistory, tools, maxTokens: 99 }));
    const c = calls[0]!;
    expect(c.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
    expect(c.headers['x-goog-api-key']).toBe('AIzaSyFakeKey123456');
    expect(c.body.systemInstruction).toEqual({ parts: [{ text: 'sys' }] });
    expect(c.body.generationConfig).toEqual({ maxOutputTokens: 99 });
    expect(c.body.contents[0].parts[1]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'QQ==' } });
    expect(c.body.contents[1].role).toBe('model');
    expect(c.body.contents[1].parts[1].functionCall).toMatchObject({ name: 'weather', args: { lat: 50 }, id: 'c1' });
    expect(c.body.contents[2].role).toBe('user');
    expect(c.body.contents[2].parts).toEqual([
      { functionResponse: { name: 'weather', id: 'c1', response: { content: { t: 5 } } } },
      { functionResponse: { name: 'poi', id: 'c2', response: { content: 'err', error: true } } },
    ]);
    const decl = c.body.tools[0].functionDeclarations;
    expect(decl[0].parameters).toEqual({ type: 'object', properties: { lat: { type: 'number' }, tag: { type: 'string', nullable: true } }, required: ['lat'] });
    expect(decl[1]).not.toHaveProperty('parameters');
    expect(res.usage).toMatchObject({ inputTokens: 40, outputTokens: 15, cacheReadTokens: 10 });
  });

  it('parses function calls with thoughtSignature and replays raw verbatim', async () => {
    const rawParts = [{ functionCall: { name: 'weather', args: { lat: 1 } }, thoughtSignature: 'SIG' }, { text: 'hmm', thought: true }];
    const first = mockFetch([{ body: gBody(rawParts) }]);
    const res = await new GeminiTransport({ apiKey: 'k', fetch: first.fetch, ...FAST }).chat(base({ provider: 'gemini', model: 'gemini-test' }));
    expect(res.stopReason).toBe('tool_use');
    expect(res.message.parts).toHaveLength(1);
    const call = res.message.parts[0]!;
    expect(call.type === 'tool_call' && call.id.startsWith('gemini_')).toBe(true);

    const toolMsg: ChatMessage = { role: 'tool', parts: [{ type: 'tool_result', toolCallId: (call as { id: string }).id, name: 'weather', content: '{}' }] };
    const second = mockFetch([{ body: gBody([{ text: 'hotovo' }]) }]);
    await new GeminiTransport({ apiKey: 'k', fetch: second.fetch, ...FAST }).chat(base({ provider: 'gemini', model: 'gemini-test', messages: [...base().messages, res.message, toolMsg] }));
    const sent = second.calls[0]!.body.contents;
    expect(sent[1].parts).toEqual(rawParts);
    expect(sent[2].parts[0].functionResponse).not.toHaveProperty('id'); // synthetic ids are never sent
  });

  it('maps SAFETY to refusal and prompt blocks', async () => {
    const t = (body: unknown) => new GeminiTransport({ apiKey: 'k', fetch: mockFetch([{ body }]).fetch, ...FAST });
    const r = await t(gBody([], 'SAFETY')).chat(base({ model: 'gemini-test' }));
    expect(r.stopReason).toBe('refusal');
    const blocked = await t({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }).chat(base({ model: 'gemini-test' }));
    expect(blocked.stopReason).toBe('refusal');
    expect(blocked.refusal?.category).toBe('PROHIBITED_CONTENT');
    expect((await t(gBody([{ text: 'a' }], 'MAX_TOKENS')).chat(base({ model: 'gemini-test' }))).stopReason).toBe('max_tokens');
  });

  it('maps errors (invalid key arrives as 400)', async () => {
    const run = (status: number, body: unknown) => rejection(new GeminiTransport({ apiKey: 'AIzaSyFakeKey123456', fetch: mockFetch([{ status, body }]).fetch, ...FAST }).chat(base({ model: 'm' })));
    const e = await run(400, { error: { code: 400, message: 'API key not valid. key=AIzaSyFakeKey123456', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } });
    expect(e.code).toBe('unauthorized');
    expect((await run(429, { error: { message: 'quota' } })).code).toBe('rate_limited');
    expect((await run(503, { error: { message: 'down' } })).code).toBe('provider_error');
  });

  it('listModels filters generateContent models', async () => {
    const { fetch } = mockFetch([
      { body: { models: [{ name: 'models/gemini-a', displayName: 'A', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed', supportedGenerationMethods: ['embedContent'] }] } },
    ]);
    expect(await new GeminiTransport({ apiKey: 'k', fetch }).listModels()).toEqual([{ id: 'gemini-a', displayName: 'A' }]);
  });

  it('sanitizeGeminiSchema converts const and drops unsupported keys', () => {
    expect(sanitizeGeminiSchema({ type: 'object', $id: 'x', properties: { a: { const: 'v', type: 'string' }, b: { type: 'array', items: { type: 'integer', exclusiveMinimum: 0 } } } })).toEqual({
      type: 'object',
      properties: { a: { enum: ['v'], type: 'string' }, b: { type: 'array', items: { type: 'integer' } } },
    });
  });
});

describe('ProxyTransport', () => {
  const resp = { message: { role: 'assistant', parts: [{ type: 'text', text: 'hi' }] }, stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 }, model: 'm', provider: 'anthropic' };

  it('posts with bearer token and returns the response', async () => {
    const { fetch, calls } = mockFetch([{ body: resp }]);
    const t = new ProxyTransport({ baseUrl: 'https://api.trailpack.test/', getToken: async () => 'tok-123456789', fetch, ...FAST });
    const res = await t.chat(base({ provider: 'anthropic' }));
    expect(calls[0]!.url).toBe('https://api.trailpack.test/v1/ai/chat');
    expect(calls[0]!.headers.authorization).toBe('Bearer tok-123456789');
    expect(calls[0]!.body.model).toBe('gpt-test');
    expect(res.usage.costUsd).toBe(0.01);
  });

  it('maps {error:{code,message}} to TrailPackError', async () => {
    const run = (status: number, body: unknown) => rejection(new ProxyTransport({ baseUrl: 'https://x', getToken: () => 't', fetch: mockFetch([{ status, body }]).fetch, ...FAST }).chat(base()));
    const budget = await run(402, { error: { code: 'budget_exceeded', message: 'Měsíční limit vyčerpán' } });
    expect(budget.code).toBe('budget_exceeded');
    expect(budget.message).toBe('Měsíční limit vyčerpán');
    expect((await run(429, { error: { code: 'rate_limited', message: 'moc' } })).code).toBe('rate_limited');
    expect((await run(401, {})).code).toBe('unauthorized');
    expect((await run(502, { error: { code: 'weird', message: 'x' } })).code).toBe('provider_error');
  });

  it('fails with unauthorized when signed out', async () => {
    const e = await rejection(new ProxyTransport({ baseUrl: 'https://x', getToken: () => null, fetch: mockFetch([{ body: resp }]).fetch }).chat(base()));
    expect(e.code).toBe('unauthorized');
  });
});

describe('createProviderTransport', () => {
  it('creates transports', () => {
    expect(createProviderTransport('anthropic', { apiKey: 'k' })).toBeDefined();
    expect(createProviderTransport('openai', { apiKey: 'k' })).toBeInstanceOf(OpenAITransport);
    expect(createProviderTransport('gemini', { apiKey: 'k' })).toBeInstanceOf(GeminiTransport);
    expect(createProviderTransport('openai_compatible', { baseUrl: 'http://h/v1' })).toBeInstanceOf(OpenAICompatibleTransport);
  });
  it('throws not_configured with Czech messages', () => {
    for (const [p, creds] of [['anthropic', {}], ['openai', { apiKey: ' ' }], ['gemini', {}], ['openai_compatible', { apiKey: 'x' }]] as const) {
      try {
        createProviderTransport(p, creds);
        throw new Error('should throw');
      } catch (e) {
        expect((e as TrailPackError).code).toBe('not_configured');
        expect((e as TrailPackError).message).toMatch(/Chybí/);
      }
    }
  });
  it('lists anthropic models', () => {
    expect(PROVIDER_MODELS.anthropic.default).toBe('claude-opus-5-5');
    expect(PROVIDER_MODELS.anthropic.models).toContain('claude-fable-5-2');
  });
});
