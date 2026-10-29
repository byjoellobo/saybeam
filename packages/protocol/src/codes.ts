/**
 * Room codes and secrets.
 *
 * Codes use a 31-character alphabet with no 0/O, 1/I/L so they survive being
 * read aloud in a noisy hall or copied off a projector. Six characters give
 * about 887 million combinations, plenty for short-lived rooms.
 */

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

type RandomBytes = (n: number) => Uint8Array;

const defaultRandom: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

/** Uniformly random room code (rejection sampling avoids modulo bias). */
export function generateRoomCode(random: RandomBytes = defaultRandom): string {
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let out = '';
  while (out.length < CODE_LENGTH) {
    for (const byte of random(CODE_LENGTH * 2)) {
      if (byte < limit && out.length < CODE_LENGTH) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
  }
  return out;
}

/** Normalise user input ("abc-def", " abc def ") to a canonical code, or null if it cannot be one. */
export function normalizeRoomCode(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/[\s\-_.]/g, '');
  return isValidRoomCode(cleaned) ? cleaned : null;
}

export function isValidRoomCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/** "ABCDEF" -> "ABC DEF" for display. */
export function formatRoomCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

/** 32 random bytes, base64url encoded (43 chars). */
export function generateToken(random: RandomBytes = defaultRandom): string {
  return base64url(random(32));
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SHA-256 hex digest. We only ever store hashes of room secrets. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Length-checked constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
