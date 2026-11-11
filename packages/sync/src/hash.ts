import { stableStringify } from '@trailpack/shared';

/** 53-bit non-cryptographic string hash (cyrb53). Pure JS so it bundles everywhere. */
export function hashString(input: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * Hash of an entity's meaningful content: ignores `updatedAt` and reduces
 * `deletedAt` to a flag, so the same edit made on two devices compares equal.
 */
export function contentHash(entity: Record<string, unknown>): string {
  const { updatedAt: _updatedAt, deletedAt, ...rest } = entity;
  return hashString(stableStringify({ ...rest, deleted: !!deletedAt }));
}
