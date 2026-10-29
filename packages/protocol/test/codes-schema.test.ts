import { describe, expect, it } from 'vitest';
import { CODE_ALPHABET, formatRoomCode, generateRoomCode, generateToken, hashToken, isValidRoomCode, normalizeRoomCode, timingSafeEqual } from '../src/codes';
import { parseClientFrame, parseCreateRoom } from '../src/schema';

describe('room codes', () => {
  it('generates valid codes', () => {
    for (let i = 0; i < 200; i++) expect(isValidRoomCode(generateRoomCode())).toBe(true);
  });

  it('avoids modulo bias by rejecting high bytes', () => {
    // 255 is above the rejection limit; 0 maps to 'A'.
    let call = 0;
    const code = generateRoomCode((n) => {
      call++;
      return new Uint8Array(n).fill(call === 1 ? 255 : 0);
    });
    expect(code).toBe('AAAAAA');
  });

  it('normalises user input', () => {
    expect(normalizeRoomCode(' abc-def ')).toBe('ABCDEF');
    expect(normalizeRoomCode('abc def')).toBe('ABCDEF');
    expect(normalizeRoomCode('ABCDE0')).toBeNull();
    expect(normalizeRoomCode('ABC')).toBeNull();
    expect(isValidRoomCode('ABCDEFG')).toBe(false);
    expect(CODE_ALPHABET).not.toMatch(/[01OIL]/);
  });

  it('formats for display', () => {
    expect(formatRoomCode('ABCDEF')).toBe('ABC DEF');
  });
});

describe('tokens', () => {
  it('generates 43-char base64url tokens', () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(t);
  });

  it('hashes with sha-256 hex', async () => {
    expect(await hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('compares in constant time', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('parseClientFrame', () => {
  it('accepts valid frames', () => {
    expect(parseClientFrame('{"t":"hello","role":"listener","since":3}')).toEqual({ ok: true, value: { t: 'hello', role: 'listener', since: 3 } });
    expect(parseClientFrame('{"t":"final","id":"abc-1","text":"Hi","startMs":0,"endMs":10}').ok).toBe(true);
    expect(parseClientFrame('{"t":"meta","lang":"en-IN"}').ok).toBe(true);
  });

  it('rejects oversize, binary, non-json, unknown and invalid frames', () => {
    expect(parseClientFrame('x'.repeat(9000))).toEqual({ ok: false, error: 'frame too large' });
    expect(parseClientFrame(new ArrayBuffer(1)).ok).toBe(false);
    expect(parseClientFrame('{oops').ok).toBe(false);
    expect(parseClientFrame('{"t":"nope"}').ok).toBe(false);
    expect(parseClientFrame(JSON.stringify({ t: 'final', id: 'a', text: 'x'.repeat(2001) })).ok).toBe(false);
    expect(parseClientFrame('{"t":"meta","lang":"english please"}').ok).toBe(false);
    expect(parseClientFrame('{"t":"history","before":0}').ok).toBe(false);
    const bad = parseClientFrame('{"t":"hello","role":"admin"}');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('role');
  });
});

describe('parseCreateRoom', () => {
  it('validates the create body', () => {
    expect(parseCreateRoom(undefined)).toEqual({ ok: true, value: {} });
    expect(parseCreateRoom({ title: 'Assembly', lang: 'hi-IN', allowExport: false }).ok).toBe(true);
    expect(parseCreateRoom({ title: 'x'.repeat(121) }).ok).toBe(false);
  });
});
