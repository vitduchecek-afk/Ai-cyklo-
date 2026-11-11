import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';

/** SHA-256 hex digest of an access token – the only form in which tokens are stored. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 32 random bytes, base64url encoded (43 characters). */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export const newId = (): string => randomUUID();

/** Unambiguous alphabet (no 0/O/1/I/L) for invite codes. */
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newInviteCode(length = 8): string {
  let out = '';
  for (let i = 0; i < length; i++) out += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  return out;
}

/** Normalise user typed invite codes (case, spaces, dashes). */
export function normalizeInviteCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}
