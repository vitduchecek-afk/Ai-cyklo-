/**
 * Internal XML helpers shared by the GPX and KML parsers.
 *
 * Security model (XXE / billion laughs):
 * - documents containing `<!ENTITY` declarations are rejected outright,
 * - entity processing in fast-xml-parser is disabled; only the five
 *   predefined XML entities and numeric character references are decoded by
 *   our own decoder (no recursion, no external resources),
 * - the input size is checked before any parsing happens.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { TrailPackError, escapeXml } from '@trailpack/shared';

/** Default maximum accepted file size: 20 MB. */
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

/** A node produced by fast-xml-parser (attributes prefixed with `@_`, text in `#text`). */
export type XmlNode = Record<string, unknown>;

/** UTF-8 byte length of a string without allocating for small inputs. */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

const formatMb = (bytes: number): string => (bytes / (1024 * 1024)).toLocaleString('cs-CZ', { maximumFractionDigits: 1 });

/** Throws `too_large` when the content exceeds `maxBytes`. */
export function assertMaxSize(content: string, maxBytes: number = DEFAULT_MAX_BYTES): void {
  // Fast path: every UTF-16 unit is at most 3 UTF-8 bytes.
  if (content.length * 3 <= maxBytes) return;
  const size = utf8ByteLength(content);
  if (size > maxBytes) {
    throw new TrailPackError('too_large', `Soubor je příliš velký (${formatMb(size)} MB, limit je ${formatMb(maxBytes)} MB).`, {
      details: { sizeBytes: size, maxBytes },
    });
  }
}

/** Removes a UTF-8 byte order mark. */
export const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decodes the predefined XML entities and numeric character references. Unknown entities are kept verbatim. */
export function decodeXmlEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

// XML 1.0 forbids most C0 control characters even when escaped.
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

/** Escapes text for XML output and removes characters that are illegal in XML 1.0. */
export function xmlText(s: string): string {
  return escapeXml(s.replace(INVALID_XML_CHARS, ''));
}

export interface ParseXmlOptions {
  maxBytes?: number;
  /** Human readable format name used in Czech error messages, e.g. 'GPX'. */
  formatLabel: string;
}

/**
 * Validates and parses an XML document into plain objects.
 * Namespace prefixes are removed (`gpx:trkpt` → `trkpt`, `gx:Track` → `Track`).
 */
export function parseXmlDocument(xml: string, opts: ParseXmlOptions): XmlNode {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  assertMaxSize(xml, maxBytes);
  const content = stripBom(xml).trim();
  if (content.length === 0) {
    throw new TrailPackError('invalid_input', `Soubor ${opts.formatLabel} je prázdný.`);
  }
  if (/<!(?:ENTITY|DOCTYPE)/i.test(content)) {
    throw new TrailPackError(
      'parse_error',
      `Soubor ${opts.formatLabel} obsahuje definice entit (DOCTYPE/ENTITY), které z bezpečnostních důvodů nepodporujeme.`,
    );
  }
  const validation = XMLValidator.validate(content, { allowBooleanAttributes: true });
  if (validation !== true) {
    const { line, col, msg } = validation.err;
    throw new TrailPackError('parse_error', `Soubor ${opts.formatLabel} není platné XML (řádek ${line}, sloupec ${col}): ${msg}`, {
      details: validation.err,
    });
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    processEntities: false,
    htmlEntities: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    ignoreDeclaration: true,
    ignorePiTags: true,
    allowBooleanAttributes: true,
    maxNestedTags: 200,
  });
  let doc: unknown;
  try {
    doc = parser.parse(content);
  } catch (e) {
    throw new TrailPackError('parse_error', `Soubor ${opts.formatLabel} se nepodařilo přečíst: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    });
  }
  if (!doc || typeof doc !== 'object') {
    throw new TrailPackError('parse_error', `Soubor ${opts.formatLabel} se nepodařilo přečíst.`);
  }
  return doc as XmlNode;
}

/** Normalises a single node / array / missing value to an array of nodes. */
export function asArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Child elements named `key` (always an array). */
export function children(node: unknown, key: string): XmlNode[] {
  if (!node || typeof node !== 'object') return [];
  return asArray((node as XmlNode)[key]).map((c) => (c !== null && typeof c === 'object' ? (c as XmlNode) : { '#text': c }));
}

/** First child element named `key`. */
export function child(node: unknown, key: string): XmlNode | undefined {
  return children(node, key)[0];
}

/** Text content of a node (decoded), or undefined when empty. */
export function textOf(node: unknown): string | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    const s = decodeXmlEntities(String(node)).trim();
    return s.length ? s : undefined;
  }
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === 'object') {
    const t = (node as XmlNode)['#text'];
    return t === undefined ? undefined : textOf(t);
  }
  return undefined;
}

/** Text content of the first child named `key`. */
export function childText(node: unknown, key: string): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const v = (node as XmlNode)[key];
  return textOf(Array.isArray(v) ? v[0] : v);
}

/** Attribute value (decoded). */
export function attr(node: unknown, name: string): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const v = (node as XmlNode)[`@_${name}`];
  if (v === undefined || v === null) return undefined;
  const s = decodeXmlEntities(String(v)).trim();
  return s.length ? s : undefined;
}

/** Parses a finite number or returns undefined. */
export function num(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(s.trim().replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}

/** Parses an ISO date-time to epoch milliseconds. */
export function parseTime(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

/** Valid WGS84 latitude/longitude? */
export const isValidLatLon = (lat: number | undefined, lon: number | undefined): boolean =>
  lat !== undefined && lon !== undefined && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
