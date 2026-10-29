import { describe, expect, it } from 'vitest';
import { applyServerMsg, EMPTY_VIEW, upsertMany, visibleSegments, type RoomView } from '../src/client-state';
import type { Segment, WelcomeMsg } from '../src/messages';

const seg = (seq: number, text = `line ${seq}`, rev = seq): Segment => ({ seq, id: `id${seq}`, text, ts: 1000 * seq, rev });

const welcome = (over: Partial<WelcomeMsg> = {}): WelcomeMsg => ({
  t: 'welcome',
  v: 1,
  room: 'ABCDEF',
  role: 'listener',
  meta: { title: 'T', lang: 'en-US', allowExport: true, createdAt: 0, private: false },
  status: 'live',
  mode: 'replace',
  segments: [seg(1), seg(2)],
  partial: null,
  hasMore: false,
  rev: 2,
  presence: { listeners: 1, correctors: 0, speaker: true },
  serverTime: 5000,
  ...over,
});

describe('applyServerMsg', () => {
  it('applies a welcome and computes the clock offset', () => {
    const v = applyServerMsg(EMPTY_VIEW, welcome(), { now: 4000 });
    expect(v.room).toBe('ABCDEF');
    expect(v.segments).toHaveLength(2);
    expect(v.clockOffset).toBe(1000);
    expect(v.rev).toBe(2);
  });

  it('merges an append welcome and replaces on replace', () => {
    const v1 = applyServerMsg(EMPTY_VIEW, welcome());
    const v2 = applyServerMsg(v1, welcome({ mode: 'append', segments: [seg(1, 'fixed', 4), seg(3, 'three', 3)], rev: 4 }));
    expect(v2.segments.map((s) => s.text)).toEqual(['fixed', 'line 2', 'three']);
    const v3 = applyServerMsg(v2, welcome({ mode: 'replace', segments: [seg(9)], hasMore: true }));
    expect(v3.segments.map((s) => s.seq)).toEqual([9]);
    expect(v3.hasMore).toBe(true);
  });

  it('does not open a gap when a resume carries a correction older than what we hold', () => {
    const v1 = applyServerMsg(EMPTY_VIEW, welcome({ segments: [seg(801), seg(802)], hasMore: true, rev: 900 }));
    const v2 = applyServerMsg(v1, welcome({ mode: 'append', segments: [seg(300, 'fixed', 901), seg(802, 'patched', 902), seg(803, 'new', 903)], rev: 903 }));
    expect(v2.segments.map((s) => [s.seq, s.text])).toEqual([
      [801, 'line 801'],
      [802, 'patched'],
      [803, 'new'],
    ]);
    expect(v2.hasMore).toBe(true);
  });

  it('replaces local segments when the room code changes', () => {
    const v1 = applyServerMsg(EMPTY_VIEW, welcome());
    const v2 = applyServerMsg(v1, welcome({ room: 'ZZZZZZ', mode: 'append', segments: [seg(1, 'other')] }));
    expect(v2.segments.map((s) => s.text)).toEqual(['other']);
  });

  it('tracks partials and clears them on the matching final', () => {
    let v: RoomView = applyServerMsg(EMPTY_VIEW, welcome());
    v = applyServerMsg(v, { t: 'partial', id: 'id3', text: 'thr' });
    expect(v.partial).toEqual({ id: 'id3', text: 'thr' });
    v = applyServerMsg(v, { t: 'final', seg: seg(3, 'Three.') });
    expect(v.partial).toBeNull();
    expect(v.rev).toBe(3);
    v = applyServerMsg(v, { t: 'partial', id: 'id4', text: 'fo' });
    v = applyServerMsg(v, { t: 'partial', id: 'other', text: '' });
    expect(v.partial?.id).toBe('id4');
    v = applyServerMsg(v, { t: 'partial', id: 'id4', text: '' });
    expect(v.partial).toBeNull();
  });

  it('applies corrections, meta, status, history, presence, error, pong', () => {
    let v: RoomView = applyServerMsg(EMPTY_VIEW, welcome({ hasMore: true, segments: [seg(5), seg(6)] }));
    v = applyServerMsg(v, { t: 'correct', seq: 5, text: 'five', rev: 7, by: 'corrector' });
    expect(v.segments[0]).toMatchObject({ text: 'five', edited: true, rev: 7 });
    expect(v.rev).toBe(7);
    v = applyServerMsg(v, { t: 'meta', meta: { title: 'New', lang: 'hi-IN', allowExport: false, createdAt: 0, private: false } });
    expect(v.meta?.title).toBe('New');
    v = applyServerMsg(v, { t: 'partial', id: 'x', text: 'hey' });
    v = applyServerMsg(v, { t: 'status', status: 'paused' });
    expect(v.status).toBe('paused');
    expect(v.partial).toBeNull();
    v = applyServerMsg(v, { t: 'history', segments: [seg(3), seg(4)], hasMore: false });
    expect(v.segments.map((s) => s.seq)).toEqual([3, 4, 5, 6]);
    expect(v.hasMore).toBe(false);
    v = applyServerMsg(v, { t: 'partial', id: 'y', text: 'again' });
    v = applyServerMsg(v, { t: 'presence', presence: { listeners: 3, correctors: 1, speaker: false } });
    expect(v.presence.listeners).toBe(3);
    expect(v.partial).toBeNull();
    v = applyServerMsg(v, { t: 'error', code: 'rate-limited', message: 'slow' });
    expect(v.lastError?.code).toBe('rate-limited');
    v = applyServerMsg(v, { t: 'pong', ts: 0, serverTime: 10_000 }, { now: 9000 });
    expect(v.clockOffset).toBe(1000);
  });

  it('caps the number of segments kept in memory', () => {
    const v = applyServerMsg(EMPTY_VIEW, welcome({ segments: [seg(1), seg(2), seg(3)] }), { maxSegments: 2 });
    expect(v.segments.map((s) => s.seq)).toEqual([2, 3]);
    expect(v.hasMore).toBe(true);
    const v2 = applyServerMsg(v, { t: 'final', seg: seg(4) }, { maxSegments: 2 });
    expect(v2.segments.map((s) => s.seq)).toEqual([3, 4]);
  });
});

describe('upsertMany', () => {
  it('appends quickly, dedupes, keeps higher revs and sorts', () => {
    expect(upsertMany([], [])).toEqual([]);
    expect(upsertMany([seg(1)], [seg(3), seg(2), seg(2, 'newer', 9)]).map((s) => s.text)).toEqual(['line 1', 'newer', 'line 3']);
    const merged = upsertMany([seg(1), seg(2, 'kept', 5)], [seg(2, 'stale', 2), seg(0)]);
    expect(merged.map((s) => s.text)).toEqual(['line 0', 'line 1', 'kept']);
    expect(upsertMany([seg(5)], [seg(6, 'a', 1), seg(6, 'b', 0)]).map((s) => s.text)).toEqual(['line 5', 'a']);
  });

  it('hides removed segments', () => {
    expect(visibleSegments([seg(1), seg(2, '')]).map((s) => s.seq)).toEqual([1]);
  });
});
