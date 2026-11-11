/**
 * Conversation size management.
 */
import type { ChatMessage, ChatPart } from '../types';

/** Rough token estimate (≈3.5 characters per token; Czech text tokenises worse than English). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

const IMAGE_COST_CHARS = 4000;

function partChars(p: ChatPart): number {
  switch (p.type) {
    case 'text':
      return p.text.length;
    case 'image':
      return IMAGE_COST_CHARS;
    case 'tool_call':
      return p.name.length + JSON.stringify(p.arguments).length;
    case 'tool_result':
      return p.content.length;
  }
}

/** Approximate size of a message in characters (images count as a fixed cost). */
export function messageChars(m: ChatMessage): number {
  return m.parts.reduce((n, p) => n + partChars(p), 0);
}

export interface TrimOptions {
  /** Budget in characters for the returned history (the first message is always kept). */
  maxChars: number;
  /** Language of the inserted note. Default Czech. */
  note?: (droppedCount: number) => string;
}

const defaultNote = (n: number) => `[Starší část konverzace (${n} zpráv) byla kvůli délce vynechána. Pokud potřebuješ detail z ní, zeptej se uživatele.]`;

/**
 * Keep the first user message and as many recent messages as fit in
 * `maxChars`. A tool message is never separated from the assistant message
 * holding its tool calls, and a short note replaces the dropped middle.
 * The most recent message is always kept, even when it alone exceeds the budget.
 */
export function trimHistory(messages: ChatMessage[], options: TrimOptions): ChatMessage[] {
  const total = messages.reduce((n, m) => n + messageChars(m), 0);
  if (total <= options.maxChars || messages.length <= 2) return messages;

  const headIdx = Math.max(0, messages.findIndex((m) => m.role === 'user'));
  const head = messages[headIdx];
  if (!head) return messages;

  let budget = options.maxChars - messageChars(head);
  let start = messages.length;
  for (let i = messages.length - 1; i > headIdx; i--) {
    const m = messages[i];
    if (!m) continue;
    const size = messageChars(m);
    if (size > budget && start < messages.length) break;
    budget -= size;
    start = i;
  }
  // Never begin the kept tail with a tool result: extend backwards to its tool call.
  while (start > headIdx + 1 && messages[start]?.role === 'tool') start--;
  if (messages[start]?.role === 'tool') start = Math.min(messages.length, headIdx + 1);

  if (start <= headIdx + 1) return messages;
  const dropped = start - headIdx - 1;
  const note: ChatMessage = { role: 'user', parts: [{ type: 'text', text: (options.note ?? defaultNote)(dropped) }] };
  return [...messages.slice(0, headIdx + 1), note, ...messages.slice(start)];
}
