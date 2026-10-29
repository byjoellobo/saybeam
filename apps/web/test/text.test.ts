import { describe, expect, it } from 'vitest';
import { charErrorRate, normalizeTokens, numberToWords, parseEquivalences, wordErrorRate } from '../src/lib/wer';
import { compileReplacements, parseReplacements } from '../src/lib/replacements';
import { buildConfig, EMPTY_MERGE, isMixedContentBlocked, mergeSegments, parseServerMessage, toWirePcm, END_OF_AUDIO } from '../src/engines/whisperlive-protocol';

describe('WER', () => {
  it('normalises case, punctuation, hyphens and curly quotes', () => {
    expect(normalizeTokens('Hello, World! It’s well-known.')).toEqual(['hello', 'world', "it's", 'well', 'known']);
    expect(normalizeTokens('नमस्ते दोस्तों!')).toEqual(['नमस्ते', 'दोस्तों']);
  });

  it('spells out numbers so formatting differences are not errors', () => {
    expect(numberToWords(0)).toBe('zero');
    expect(numberToWords(18)).toBe('eighteen');
    expect(numberToWords(40)).toBe('forty');
    expect(numberToWords(204)).toBe('two hundred four');
    expect(numberToWords(2500)).toBe('two thousand five hundred');
    expect(numberToWords(1_000_000)).toBeNull();
    expect(numberToWords(1.5)).toBeNull();
    expect(wordErrorRate('chapter four, questions twelve to eighteen', 'Chapter 4, questions 12 to 18').wer).toBe(0);
    expect(wordErrorRate('room two hundred and four', 'room 204').wer).toBe(0);
    expect(wordErrorRate('two thousand five hundred rupees', '2,500 rupees').wer).toBe(0);
    expect(wordErrorRate('chapter four', 'chapter 4', { spellNumbers: false }).wer).toBe(0.5);
  });

  it('scores a perfect match as zero', () => {
    expect(wordErrorRate('The cat sat.', 'the cat sat').wer).toBe(0);
  });

  it('counts substitutions, deletions and insertions', () => {
    const r = wordErrorRate('the cat sat on the mat', 'the bat sat on mat today');
    expect(r.substitutions).toBe(1);
    expect(r.deletions).toBe(1);
    expect(r.insertions).toBe(1);
    expect(r.wer).toBeCloseTo(3 / 6);
    expect(r.ops.map((o) => o.type)).toEqual(['ok', 'sub', 'ok', 'ok', 'del', 'ok', 'ins']);
  });

  it('applies equivalences for romanised Hindi spelling variants', () => {
    const eq = parseEquivalences('nahin = nahi\nOK = okay\nbad line');
    expect(eq).toEqual({ nahin: 'nahi', ok: 'okay' });
    expect(wordErrorRate('yeh nahi hai okay', 'yeh nahin hai ok', { equivalences: eq }).wer).toBe(0);
  });

  it('handles empty references and hypotheses', () => {
    expect(wordErrorRate('', '').wer).toBe(0);
    expect(wordErrorRate('', 'noise').wer).toBe(1);
    expect(wordErrorRate('words here', '').wer).toBe(1);
  });

  it('computes character error rate', () => {
    expect(charErrorRate('abcd', 'abed')).toBeCloseTo(0.25);
    expect(charErrorRate('', '')).toBe(0);
    expect(charErrorRate('', 'x')).toBe(1);
  });
});

describe('replacements', () => {
  it('parses rules in several arrow styles and skips comments', () => {
    expect(parseReplacements('# names\nJoel => Joël\nphoto synthesis -> photosynthesis\nuh =\n\nbad')).toEqual([
      { from: 'Joel', to: 'Joël' },
      { from: 'photo synthesis', to: 'photosynthesis' },
      { from: 'uh', to: '' },
    ]);
  });

  it('replaces whole words and phrases case-insensitively, longest first', () => {
    const r = compileReplacements(parseReplacements('photo synthesis => photosynthesis\nphoto => picture\nuh =>\nIIT => I.I.T.'));
    expect(r.count).toBe(4);
    expect(r.apply('Photo  Synthesis is cool, uh, see the photo at IIT.')).toBe('photosynthesis is cool, , see the picture at I.I.T..');
    expect(r.apply('photographs stay')).toBe('photographs stay');
  });

  it('is a no-op without rules', () => {
    expect(compileReplacements([]).apply(' same ')).toBe(' same ');
  });
});

describe('WhisperLive protocol', () => {
  it('builds the first message with required keys', () => {
    expect(buildConfig({ uid: 'u', language: 'en', model: 'small' })).toMatchObject({
      uid: 'u',
      language: 'en',
      task: 'transcribe',
      model: 'small',
      use_vad: true,
      send_last_n_segments: 10,
    });
    expect(buildConfig({ uid: 'u', language: null, model: 'small', hotwords: 'IIT,NCERT', initialPrompt: 'Physics' })).toMatchObject({
      hotwords: 'IIT,NCERT',
      initial_prompt: 'Physics',
      language: null,
    });
  });

  it('parses every server message kind and ignores other uids', () => {
    expect(parseServerMessage('{"uid":"u","message":"SERVER_READY","backend":"faster_whisper"}', 'u')).toEqual({ kind: 'ready', backend: 'faster_whisper' });
    expect(parseServerMessage('{"uid":"u","status":"WAIT","message":2.5}', 'u')).toEqual({ kind: 'wait', minutes: 2.5 });
    expect(parseServerMessage('{"uid":"u","status":"ERROR","message":"boom"}', 'u')).toEqual({ kind: 'error', message: 'boom' });
    expect(parseServerMessage('{"uid":"u","status":"WARNING","message":"meh"}', 'u')).toEqual({ kind: 'warning', message: 'meh' });
    expect(parseServerMessage('{"uid":"u","message":"DISCONNECT"}', 'u')).toEqual({ kind: 'disconnect' });
    expect(parseServerMessage('{"uid":"u","language":"hi","language_prob":0.9}', 'u')).toEqual({ kind: 'language', language: 'hi', probability: 0.9 });
    expect(parseServerMessage('{"uid":"u","segments":[]}', 'u')).toEqual({ kind: 'segments', segments: [] });
    expect(parseServerMessage('{"uid":"other","segments":[]}', 'u')).toEqual({ kind: 'unknown' });
    expect(parseServerMessage('nope', 'u')).toEqual({ kind: 'unknown' });
    expect(parseServerMessage('42', 'u')).toEqual({ kind: 'unknown' });
  });

  it('turns the sliding window into finals once each, plus a partial', () => {
    const m1 = mergeSegments(EMPTY_MERGE, [
      { start: '0.000', end: '2.000', text: ' Good morning.', completed: true },
      { start: '2.000', end: '3.100', text: ' Today we', completed: false },
    ]);
    expect(m1.finals).toEqual([{ text: 'Good morning.', startS: 0, endS: 2 }]);
    expect(m1.partial).toBe('Today we');
    const m2 = mergeSegments(m1.state, [
      { start: '0.000', end: '2.000', text: ' Good morning.', completed: true },
      { start: '2.000', end: '4.000', text: ' Today we study optics.', completed: true },
    ]);
    expect(m2.finals.map((f) => f.text)).toEqual(['Today we study optics.']);
    expect(m2.partial).toBeNull();
    // A revised earlier segment that overlaps committed time is ignored.
    const m3 = mergeSegments(m2.state, [{ start: '1.000', end: '2.500', text: 'Morning, today', completed: true }]);
    expect(m3.finals).toEqual([]);
  });

  it('handles TensorRT-style segments with text only', () => {
    const m = mergeSegments(EMPTY_MERGE, [{ text: 'one' }, { text: 'two' }]);
    expect(m.finals.map((f) => f.text)).toEqual(['one']);
    expect(m.partial).toBe('two');
    const again = mergeSegments(m.state, [{ text: 'one' }, { text: 'two' }, { text: '' }]);
    expect(again.finals.map((f) => f.text)).toEqual(['two']);
  });

  it('detects mixed-content blocking and encodes audio', () => {
    expect(isMixedContentBlocked('ws://192.168.1.5:9090', 'https:')).toBe(true);
    expect(isMixedContentBlocked('ws://localhost:9090', 'https:')).toBe(false);
    expect(isMixedContentBlocked('wss://asr.example.org', 'https:')).toBe(false);
    expect(isMixedContentBlocked('ws://192.168.1.5:9090', 'http:')).toBe(false);
    expect(isMixedContentBlocked('not a url', 'https:')).toBe(false);
    expect(toWirePcm(Float32Array.from([0.5])).byteLength).toBe(4);
    expect(new TextDecoder().decode(END_OF_AUDIO)).toBe('END_OF_AUDIO');
  });
});
