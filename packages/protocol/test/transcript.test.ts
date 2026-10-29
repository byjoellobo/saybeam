import { describe, expect, it } from 'vitest';
import { chunkText, estimateDurationMs, exportTranscript, formatTimestamp, segmentTimes, toCues, toJson, toPlainText, toSrt, toVtt, wrapLines } from '../src/transcript';
import type { RoomMeta, Segment } from '../src/messages';

const meta: RoomMeta = { title: 'Lecture 1', lang: 'en-IN', allowExport: true, createdAt: Date.UTC(2026, 0, 1) };
const timed = (seq: number, text: string, startMs: number, endMs: number): Segment => ({ seq, id: `s${seq}`, text, ts: 1_000_000 + endMs, rev: seq, startMs, endMs });

describe('timestamps', () => {
  it('formats SRT and VTT times', () => {
    expect(formatTimestamp(0, ',')).toBe('00:00:00,000');
    expect(formatTimestamp(3_723_004, '.')).toBe('01:02:03.004');
    expect(formatTimestamp(-5, ',')).toBe('00:00:00,000');
  });

  it('estimates duration from word count with a floor', () => {
    expect(estimateDurationMs('hi')).toBe(1000);
    expect(estimateDurationMs('one two three four five')).toBe(2000);
  });
});

describe('segmentTimes', () => {
  it('uses speaker offsets when present and skips removed segments', () => {
    const cues = segmentTimes([timed(1, 'Hello there.', 0, 1200), { ...timed(2, '', 1300, 1400) }, timed(3, 'General Kenobi.', 1500, 3000)]);
    expect(cues).toEqual([
      { start: 0, end: 1200, text: 'Hello there.' },
      { start: 1500, end: 3000, text: 'General Kenobi.' },
    ]);
  });

  it('estimates from receive times when offsets are missing and never overlaps', () => {
    const segs: Segment[] = [
      { seq: 1, id: 'a', text: 'one two three', ts: 10_000, rev: 1 },
      { seq: 2, id: 'b', text: 'four', ts: 10_500, rev: 2 },
    ];
    const cues = segmentTimes(segs);
    expect(cues[0]?.start).toBe(0);
    expect(cues[1]?.start).toBeGreaterThanOrEqual(cues[0]?.end ?? Infinity);
    expect(segmentTimes([])).toEqual([]);
  });
});

describe('chunking and wrapping', () => {
  it('chunks long text at word boundaries', () => {
    const chunks = chunkText('a '.repeat(100).trim(), 20);
    expect(chunks.every((c) => c.length <= 20)).toBe(true);
    expect(chunks.join(' ')).toBe('a '.repeat(100).trim());
    expect(chunkText('supercalifragilisticexpialidocious', 5)).toEqual(['supercalifragilisticexpialidocious']);
  });

  it('wraps into two balanced lines', () => {
    expect(wrapLines('short')).toBe('short');
    const wrapped = wrapLines('the quick brown fox jumps over the lazy dog and keeps running far away');
    const lines = wrapped.split('\n');
    expect(lines).toHaveLength(2);
    expect(Math.abs((lines[0]?.length ?? 0) - (lines[1]?.length ?? 0))).toBeLessThan(12);
  });

  it('splits long segments into several cues sharing the time', () => {
    const long = 'word '.repeat(60).trim();
    const cues = toCues([timed(1, long, 0, 12_000)]);
    expect(cues.length).toBeGreaterThan(1);
    expect(cues[0]?.start).toBe(0);
    expect(cues[cues.length - 1]?.end).toBe(12_000);
    for (let i = 1; i < cues.length; i++) expect(cues[i]?.start).toBe(cues[i - 1]?.end);
  });
});

describe('formats', () => {
  const segs = [timed(1, 'Good morning, everyone.', 0, 1800), timed(2, 'Today we cover optics.', 2000, 4000), timed(3, 'Next topic.', 12_000, 13_000)];

  it('writes SRT', () => {
    expect(toSrt(segs)).toBe(
      '1\n00:00:00,000 --> 00:00:01,800\nGood morning, everyone.\n\n2\n00:00:02,000 --> 00:00:04,000\nToday we cover optics.\n\n3\n00:00:12,000 --> 00:00:13,000\nNext topic.\n',
    );
  });

  it('cannot be tricked into extra cues by newlines or arrows in caption text', () => {
    const evil = timed(1, 'x\n\n2\n00:00:00,000 --> 99:00:00,000\nFAKE', 0, 1000);
    const srt = toSrt([evil]);
    expect(srt.match(/-->/g)).toHaveLength(1);
    expect(srt).not.toContain('\n\n2\n');
    expect(toVtt([evil]).match(/-->/g)).toHaveLength(1);
  });

  it('writes VTT with a safe title header', () => {
    const vtt = toVtt(segs, { title: 'A --> B\nC' });
    expect(vtt.startsWith('WEBVTT - A  B C\n\n00:00:00.000 --> 00:00:01.800\n')).toBe(true);
    expect(toVtt([])).toBe('WEBVTT\n\n');
  });

  it('writes paragraphs split on pauses', () => {
    expect(toPlainText(segs)).toBe('Good morning, everyone. Today we cover optics.\n\nNext topic.\n');
    expect(toPlainText(segs, { timestamps: true })).toBe('[00:00:00] Good morning, everyone. Today we cover optics.\n\n[00:00:12] Next topic.\n');
    expect(toPlainText([])).toBe('');
  });

  it('writes JSON', () => {
    const parsed = JSON.parse(toJson(meta, segs, 'ABCDEF')) as { room: string; segments: unknown[]; title: string };
    expect(parsed.room).toBe('ABCDEF');
    expect(parsed.title).toBe('Lecture 1');
    expect(parsed.segments).toHaveLength(3);
    const empty = JSON.parse(toJson(null, [])) as { room: null; createdAt: null };
    expect(empty.room).toBeNull();
    expect(empty.createdAt).toBeNull();
  });

  it('exports every format with the right extension', () => {
    expect(exportTranscript('txt', segs, meta).ext).toBe('txt');
    expect(exportTranscript('srt', segs, meta).mime).toContain('subrip');
    expect(exportTranscript('vtt', segs, null).body.startsWith('WEBVTT')).toBe(true);
    expect(exportTranscript('json', segs, meta, 'ABCDEF').ext).toBe('json');
  });
});
