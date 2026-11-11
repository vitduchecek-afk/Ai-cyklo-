/**
 * Prompt-injection defences. Everything that did not come from the system
 * prompt or the current user turn (trip notes, POI names, web text, tool
 * output …) is wrapped in `<external_data>` so the model can tell data from
 * instructions; the system prompt tells it to never obey that content.
 */

const TRUNCATION_MARK = '…[zkráceno]';

/** Truncate without splitting a UTF-16 surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = Math.max(0, max);
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/**
 * Wrap untrusted text as `<external_data source="…">…</external_data>`.
 * Any tag-like `<external_data` / `</external_data` inside the text is
 * neutralised so it cannot close the block early; the text is truncated to
 * `maxChars` (default 8 000).
 */
export function wrapExternal(source: string, text: string, maxChars = 8000): string {
  const safeSource = source.replace(/[^\p{L}\p{N}_.:/-]+/gu, '_').slice(0, 64) || 'unknown';
  let body = text.replace(/<\s*(\/?)\s*external_data/gi, '‹$1external_data');
  body = body.replace(/\u0000/g, '');
  if (body.length > maxChars) body = cut(body, maxChars) + TRUNCATION_MARK;
  return `<external_data source="${safeSource}">\n${body}\n</external_data>`;
}

export interface InjectionScan {
  suspicious: boolean;
  /** Names of the patterns that matched (for logging; never shown to the model as instructions). */
  matches: string[];
}

const INJECTION_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['ignore_previous', /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,30}\b(instructions?|prompts?|rules?|context)\b/i],
  ['system_prompt', /\b(system|developer)\s+(prompt|message|instructions?)\b/i],
  ['reveal_prompt', /\b(reveal|show|print|repeat|leak)\b[^.\n]{0,30}\b(your|the)\b[^.\n]{0,20}\b(prompt|instructions?|rules)\b/i],
  ['role_override', /\byou\s+are\s+now\b|\bact\s+as\s+(?:if\s+you\s+(?:are|were)\s+)?(?:an?\s+)?(?:unrestricted|jailbroken|dan)\b/i],
  ['developer_mode', /\b(developer|debug|god|jailbreak|dan)\s+mode\b/i],
  ['new_instructions', /\bnew\s+instructions?\s*:/i],
  ['fake_tag', /<\s*\/?\s*(system|assistant|instructions?|tool_call|tool_result)\s*>/i],
  ['cs_ignore', /\b(zapome[nň]|ignoruj|ignorujte|p[řr]ehlédni|opome[nň])\b[^.\n]{0,40}\b(p[řr]edchoz[íi]\w*|v[šs]echn\w*|dosavadn[íi]\w*)\b[^.\n]{0,30}\b(instrukc\w*|pokyn\w*|pravidl\w*|zad[áa]n[íi])/i],
  ['cs_role', /\b(nyn[íi]\s+jsi|od\s+te[ďd]\s+jsi|chovej\s+se\s+jako)\b/i],
  ['cs_system_prompt', /\bsyst[ée]mov\w+\s+(prompt|zpr[áa]v\w*|instrukc\w*|pokyn\w*)/i],
  ['tool_abuse', /\b(call|invoke|run|execute|zavolej|spus[ťt])\b[^.\n]{0,30}\b(delete|remove|smaž|sma[zž]|vymaž)\w*\b[^.\n]{0,30}\b(trip|tool|n[áa]stroj|v[šs]echn\w*)/i],
  ['exfiltrate', /\b(send|post|upload|exfiltrate|odešli|pošli)\b[^.\n]{0,40}\b(api[\s_-]?key|password|token|heslo|kl[íi][čc])\b/i],
];

/** Heuristic scan for instruction-like text inside untrusted data. A hit is a signal, not proof. */
export function detectInjection(text: string): InjectionScan {
  const matches: string[] = [];
  const sample = text.length > 100_000 ? text.slice(0, 100_000) : text;
  for (const [name, re] of INJECTION_PATTERNS) if (re.test(sample)) matches.push(name);
  return { suspicious: matches.length > 0, matches };
}

/**
 * Serialise a tool result for the model: always a string, never throws
 * (circular references, BigInt, undefined), truncated to `maxChars`.
 */
export function sanitizeToolResult(value: unknown, maxChars = 12_000): string {
  let json: string;
  if (typeof value === 'string') {
    json = value;
  } else {
    const seen = new WeakSet<object>();
    try {
      json =
        JSON.stringify(value, (_k, v: unknown) => {
          if (typeof v === 'bigint') return v.toString();
          if (typeof v === 'object' && v !== null) {
            if (seen.has(v)) return '[circular]';
            seen.add(v);
          }
          if (typeof v === 'number' && !Number.isFinite(v)) return null;
          return v;
        }) ?? 'null';
    } catch {
      json = '"[neserializovatelný výsledek]"';
    }
  }
  json = json.replace(/\u0000/g, '');
  if (json.length <= maxChars) return json;
  return `${cut(json, Math.max(0, maxChars))}${TRUNCATION_MARK} (původně ${json.length} znaků)`;
}
