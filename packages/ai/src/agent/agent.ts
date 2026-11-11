/**
 * The tool-using agent loop. Provider independent: it only needs a
 * {@link ChatTransport} and (optionally) a {@link ToolExecutor}.
 */
import { TrailPackError, isTrailPackError, toTrailPackError, type AiProviderId } from '@trailpack/shared';
import type { ChatMessage, ChatPart, ChatTransport, TextPart, ToolCallPart, ToolExecutor, ToolResultPart, Usage } from '../types';
import { detectInjection, sanitizeToolResult, wrapExternal } from './security';

export type AgentStopReason = 'end' | 'max_steps' | 'budget' | 'refusal' | 'aborted' | 'error';

export type AgentEvent =
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_call'; call: ToolCallPart; description: string }
  | { type: 'tool_result'; call: ToolCallPart; isError: boolean; preview: string }
  | { type: 'usage'; usage: Usage; total: Usage }
  | { type: 'confirmation_required'; call: ToolCallPart; description: string }
  | { type: 'error'; error: TrailPackError };

export interface RunAgentOptions {
  transport: ChatTransport;
  provider: AiProviderId;
  model: string;
  system: string;
  /** Earlier conversation (already trimmed by the caller if needed). */
  history: ChatMessage[];
  /** The new user message (may contain images). */
  input: ChatMessage;
  tools?: ToolExecutor;
  /** Maximum number of model calls. Default 8. */
  maxSteps?: number;
  /** Stop before the next model call once the summed cost reaches this amount. */
  maxCostUsd?: number;
  effort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  /** Asked before any call for which `needsConfirmation` is true. Without it such calls are declined. */
  confirm?: (call: ToolCallPart, description: string) => Promise<boolean>;
  /** Characters of a single tool result passed to the model. Default 12 000. */
  maxToolResultChars?: number;
}

export interface AgentResult {
  /** New turns produced by this run: the input, assistant messages and tool-result messages. */
  messages: ChatMessage[];
  /** Text of the last assistant message that contained text. */
  finalText: string;
  usage: Usage;
  /** Number of model calls made. */
  steps: number;
  stoppedBecause: AgentStopReason;
  error?: TrailPackError;
}

const DECLINED_TEXT = 'Uživatel akci nepotvrdil, nic nebylo změněno.';
const NO_CONFIRM_TEXT = 'Akce vyžaduje potvrzení uživatele, které nebylo možné získat. Nic nebylo změněno.';
const ABORTED_TEXT = 'Akce byla zrušena.';

const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });

function addUsage(total: Usage, u: Usage): void {
  total.inputTokens += u.inputTokens;
  total.outputTokens += u.outputTokens;
  total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0);
  total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0);
  total.costUsd += u.costUsd;
}

const textOf = (parts: ChatPart[]): string =>
  parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim();

/** Run the agent until the model finishes, a limit is hit, the user aborts or an error occurs. */
export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const { transport, tools, signal } = options;
  const maxSteps = Math.max(1, options.maxSteps ?? 8);
  const maxToolChars = options.maxToolResultChars ?? 12_000;
  const emit = (event: AgentEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // a faulty UI listener must not break the loop
    }
  };

  const conversation: ChatMessage[] = [...options.history, options.input];
  const produced: ChatMessage[] = [options.input];
  const total = emptyUsage();
  let finalText = '';
  let steps = 0;

  const finish = (stoppedBecause: AgentStopReason, error?: TrailPackError): AgentResult => {
    if (error) emit({ type: 'error', error });
    return { messages: produced, finalText, usage: total, steps, stoppedBecause, ...(error ? { error } : {}) };
  };
  const push = (m: ChatMessage) => {
    conversation.push(m);
    produced.push(m);
  };

  while (steps < maxSteps) {
    if (signal?.aborted) return finish('aborted');
    if (options.maxCostUsd !== undefined && total.costUsd >= options.maxCostUsd) {
      return finish('budget', new TrailPackError('budget_exceeded', 'Byl dosažen limit nákladů na AI pro tento požadavek.', { provider: options.provider }));
    }

    let response;
    steps++;
    try {
      response = await transport.chat(
        {
          provider: options.provider,
          model: options.model,
          system: options.system,
          messages: conversation,
          tools: tools && tools.definitions().length > 0 ? tools.definitions() : undefined,
          effort: options.effort,
          maxTokens: options.maxTokens,
        },
        signal,
      );
    } catch (e) {
      const error = toTrailPackError(e, options.provider);
      if (error.code === 'aborted' || signal?.aborted) return finish('aborted');
      return finish(error.code === 'budget_exceeded' ? 'budget' : 'error', error);
    }

    addUsage(total, response.usage);
    emit({ type: 'usage', usage: response.usage, total: { ...total } });
    push(response.message);
    const text = textOf(response.message.parts);
    if (text !== '') {
      finalText = text;
      emit({ type: 'assistant_text', text });
    }

    if (response.stopReason === 'refusal') return finish('refusal');
    if (response.stopReason === 'error') {
      return finish('error', new TrailPackError('provider_error', 'Model vrátil chybu při generování odpovědi.', { provider: options.provider }));
    }

    const calls = response.message.parts.filter((p): p is ToolCallPart => p.type === 'tool_call');
    if (calls.length === 0) return finish('end');
    if (response.stopReason === 'max_tokens') {
      return finish('error', new TrailPackError('provider_error', 'Odpověď modelu byla zkrácena uprostřed volání nástroje. Zkuste dotaz zjednodušit.', { provider: options.provider }));
    }

    const results = await executeCalls(calls, tools, {
      emit,
      confirm: options.confirm,
      signal,
      maxChars: maxToolChars,
    });
    push({ role: 'tool', parts: results });

    if (signal?.aborted) return finish('aborted');
  }
  return finish('max_steps');
}

interface ExecContext {
  emit: (e: AgentEvent) => void;
  confirm?: RunAgentOptions['confirm'];
  signal?: AbortSignal;
  maxChars: number;
}

/**
 * Execute the tool calls of one assistant turn. Read-only calls run
 * concurrently, then calls that mutate data or need confirmation run one at a
 * time. Results are returned in the original call order.
 */
async function executeCalls(calls: ToolCallPart[], tools: ToolExecutor | undefined, ctx: ExecContext): Promise<ToolResultPart[]> {
  const byId = new Map<ToolCallPart, ToolResultPart>();
  const describe = (call: ToolCallPart): string => {
    try {
      return tools?.describeCall(call) ?? call.name;
    } catch {
      return call.name;
    }
  };
  const finishCall = (call: ToolCallPart, content: unknown, isError: boolean): ToolResultPart => {
    const part = toResultPart(call, content, isError, ctx.maxChars);
    ctx.emit({ type: 'tool_result', call, isError, preview: part.content.slice(0, 200) });
    return part;
  };

  for (const call of calls) ctx.emit({ type: 'tool_call', call, description: describe(call) });

  if (!tools) {
    for (const call of calls) byId.set(call, finishCall(call, 'Nástroje nejsou v této konverzaci dostupné.', true));
    return calls.map((c) => byId.get(c) as ToolResultPart);
  }

  const safe = (fn: () => boolean, fallback: boolean): boolean => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  const sequential = calls.filter((c) => safe(() => tools.isMutating(c.name), true) || safe(() => tools.needsConfirmation(c), true));
  const concurrent = calls.filter((c) => !sequential.includes(c));

  const run = async (call: ToolCallPart): Promise<ToolResultPart> => {
    if (ctx.signal?.aborted) return finishCall(call, ABORTED_TEXT, true);
    try {
      const r = await tools.execute(call, ctx.signal);
      return finishCall(call, r.content, r.isError === true);
    } catch (e) {
      if (ctx.signal?.aborted) return finishCall(call, ABORTED_TEXT, true);
      return finishCall(call, `Nástroj ${call.name} selhal: ${isTrailPackError(e) ? e.message : e instanceof Error ? e.message : String(e)}`, true);
    }
  };

  const parallelResults = await Promise.all(concurrent.map(run));
  concurrent.forEach((c, i) => byId.set(c, parallelResults[i] as ToolResultPart));

  for (const call of sequential) {
    if (ctx.signal?.aborted) {
      byId.set(call, finishCall(call, ABORTED_TEXT, true));
      continue;
    }
    if (safe(() => tools.needsConfirmation(call), true)) {
      const description = describe(call);
      ctx.emit({ type: 'confirmation_required', call, description });
      if (!ctx.confirm) {
        byId.set(call, finishCall(call, NO_CONFIRM_TEXT, true));
        continue;
      }
      let approved: boolean;
      try {
        approved = (await ctx.confirm(call, description)) === true;
      } catch {
        approved = false;
      }
      if (!approved) {
        byId.set(call, finishCall(call, DECLINED_TEXT, true));
        continue;
      }
    }
    byId.set(call, await run(call));
  }
  return calls.map((c) => byId.get(c) as ToolResultPart);
}

function toResultPart(call: ToolCallPart, content: unknown, isError: boolean, maxChars: number): ToolResultPart {
  let text = sanitizeToolResult(content, maxChars);
  // Tool output can embed third-party text (POI names, notes); fence it when it looks like an instruction.
  if (!isError && detectInjection(text).suspicious) text = wrapExternal(`tool:${call.name}`, text, maxChars);
  const part: ToolResultPart = { type: 'tool_result', toolCallId: call.id, name: call.name, content: text };
  if (isError) part.isError = true;
  return part;
}
