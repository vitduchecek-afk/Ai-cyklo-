/** Small text helpers (diacritics-free matching) used across the gear package. */

/** Lower-case, strip diacritics, collapse whitespace. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/đ/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when `normalizedText` contains one of the keywords at a word start.
 * Short keywords (≤ 4 characters) must be a whole word with at most two
 * trailing letters (plural/case suffix), so `bot` matches "boty" but not
 * "bottle".
 */
export function matchesAnyKeyword(normalizedText: string, keywords: readonly string[]): boolean {
  for (const kw of keywords) {
    if (!kw) continue;
    const k = normalizeText(kw);
    let from = 0;
    for (;;) {
      const idx = normalizedText.indexOf(k, from);
      if (idx < 0) break;
      const before = idx === 0 ? ' ' : normalizedText.charAt(idx - 1);
      if (!/[a-z0-9]/.test(before)) {
        if (k.length > 4) return true;
        const rest = normalizedText.slice(idx + k.length);
        if (/^[a-z]{0,2}(?![a-z0-9])/.test(rest)) return true;
      }
      from = idx + 1;
    }
  }
  return false;
}

/** Tokens (≥ 3 chars) of a normalized string. */
export function tokens(s: string): string[] {
  return normalizeText(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}
