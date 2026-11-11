import type { ChatResponse, ChatTransport } from '@trailpack/ai';
import { describe, expect, it, vi } from 'vitest';

import { createApp, isModelAllowed } from '../src/app';
import { loadConfig } from '../src/config';

const reply: ChatResponse = {
  message: { role: 'assistant', parts: [{ type: 'text', text: 'Ahoj' }] },
  stopReason: 'end',
  usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.6 },
  model: 'claude-sonnet-5-5',
  provider: 'anthropic',
};

function setup(env: Record<string, string> = {}) {
  const config = loadConfig({ ANTHROPIC_API_KEY: 'test-key', AI_MONTHLY_BUDGET_USD_PER_USER: '1', ...env });
  const chat = vi.fn(async () => reply);
  const transportFactory = vi.fn((): ChatTransport => ({ chat }));
  const app = createApp({ config, transportFactory });
  return { app, chat, transportFactory };
}

async function register(app: ReturnType<typeof createApp>) {
  const res = await app.request('/v1/auth/device', { method: 'POST' });
  expect(res.status).toBe(201);
  return (await res.json()) as { userId: string; token: string };
}

const chatBody = {
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  system: 'test',
  messages: [{ role: 'user', parts: [{ type: 'text', text: 'Ahoj' }] }],
};

describe('api', () => {
  it('health and meta never leak keys', async () => {
    const { app } = setup();
    expect((await app.request('/health')).status).toBe(200);
    const meta = await (await app.request('/v1/meta')).text();
    expect(meta).toContain('"anthropic":true');
    expect(meta).not.toContain('test-key');
  });

  it('requires a device token for the AI proxy', async () => {
    const { app } = setup();
    const res = await app.request('/v1/ai/chat', { method: 'POST', body: JSON.stringify(chatBody) });
    expect(res.status).toBe(401);
  });

  it('proxies chat with the server key and enforces the monthly budget', async () => {
    const { app, transportFactory } = setup();
    const { token } = await register(app);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const r1 = await app.request('/v1/ai/chat', { method: 'POST', headers, body: JSON.stringify(chatBody) });
    expect(r1.status).toBe(200);
    expect(transportFactory).toHaveBeenCalledWith('anthropic', { apiKey: 'test-key' });
    const r2 = await app.request('/v1/ai/chat', { method: 'POST', headers, body: JSON.stringify(chatBody) });
    expect(r2.status).toBe(200);
    const r3 = await app.request('/v1/ai/chat', { method: 'POST', headers, body: JSON.stringify(chatBody) });
    expect(r3.status).toBe(402);
    const usage = (await (await app.request('/v1/ai/usage', { headers })).json()) as { requests: number };
    expect(usage.requests).toBe(2);
  });

  it('rejects unconfigured providers, disallowed models and invalid bodies', async () => {
    const { app } = setup();
    const { token } = await register(app);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const gem = await app.request('/v1/ai/chat', { method: 'POST', headers, body: JSON.stringify({ ...chatBody, provider: 'gemini', model: 'x' }) });
    expect([403, 503]).toContain(gem.status);
    const bad = await app.request('/v1/ai/chat', { method: 'POST', headers, body: '{"provider":"nope"}' });
    expect(bad.status).toBe(400);
    const other = await app.request('/v1/ai/chat', { method: 'POST', headers, body: JSON.stringify({ ...chatBody, model: 'claude-fable-5-2' }) });
    expect(other.status).toBe(403);
  });

  it('matches allowed model patterns', () => {
    expect(isModelAllowed(['anthropic/claude-sonnet-5-5*'], 'anthropic', 'claude-sonnet-5-5')).toBe(true);
    expect(isModelAllowed(['anthropic/claude-sonnet-5-5*'], 'openai', 'gpt-x')).toBe(false);
    expect(isModelAllowed(['gpt-x'], 'openai', 'gpt-x')).toBe(true);
  });
});
