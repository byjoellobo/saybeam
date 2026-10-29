import { describe, expect, it } from 'vitest';
import { FrameChunker, Resampler, rms } from '../src/engines/resample';
import { Segmenter, concat } from '../src/engines/segmenter';

const tone = (n: number, rate: number, hz = 220): Float32Array => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate));

describe('Resampler', () => {
  it('passes 16 kHz through unchanged', () => {
    const r = new Resampler(16_000);
    const input = tone(160, 16_000);
    expect(Array.from(r.process(input))).toEqual(Array.from(input));
  });

  it('downsamples 48 kHz to a third of the samples across chunk boundaries', () => {
    const r = new Resampler(48_000);
    let total = 0;
    for (let i = 0; i < 10; i++) total += r.process(tone(4800, 48_000)).length;
    expect(Math.abs(total - 16_000)).toBeLessThanOrEqual(2);
  });

  it('handles non-integer ratios (44.1 kHz) without drift', () => {
    const r = new Resampler(44_100);
    let total = 0;
    for (let i = 0; i < 100; i++) total += r.process(tone(441, 44_100)).length;
    expect(Math.abs(total - 16_000)).toBeLessThanOrEqual(2);
  });

  it('averages within the window (acts as a low-pass)', () => {
    const r = new Resampler(48_000);
    const alternating = Float32Array.from({ length: 4800 }, (_, i) => (i % 2 ? 1 : -1));
    const out = r.process(alternating);
    const peak = Math.max(...Array.from(out, Math.abs));
    expect(peak).toBeLessThan(0.5);
  });

  it('upsamples 8 kHz by interpolation', () => {
    const r = new Resampler(8_000);
    const out = r.process(Float32Array.from([0, 1, 0, -1, 0, 1, 0, -1]));
    expect(out.length).toBeGreaterThanOrEqual(13);
    expect(out[1]).toBeCloseTo(0.5);
  });

  it('rejects bad rates', () => {
    expect(() => new Resampler(0)).toThrow();
  });
});

describe('FrameChunker and rms', () => {
  it('re-blocks into fixed frames and keeps the remainder', () => {
    const c = new FrameChunker(4);
    expect(c.push(Float32Array.from([1, 2, 3]))).toHaveLength(0);
    const frames = c.push(Float32Array.from([4, 5, 6, 7, 8, 9]));
    expect(frames.map((f) => Array.from(f))).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
  });

  it('computes rms', () => {
    expect(rms(new Float32Array(0))).toBe(0);
    expect(rms(Float32Array.from([1, -1, 1, -1]))).toBe(1);
  });
});

describe('Segmenter', () => {
  const F = 512; // 32 ms frames at 16 kHz
  const frame = (v = 0.1) => new Float32Array(F).fill(v);
  const run = (seg: Segmenter, probs: number[]) => probs.flatMap((p) => seg.push(frame(p), p));

  it('emits start then a segment after 400 ms of silence, with preroll and padding', () => {
    const seg = new Segmenter();
    const silence = Array(5).fill(0.01);
    const speech = Array(20).fill(0.9); // 640 ms
    const tail = Array(13).fill(0.01); // 416 ms
    const events = run(seg, [...silence, ...speech, ...tail]);
    expect(events[0]).toEqual({ type: 'start', startMs: 64 }); // 3 preroll frames before frame 5
    const done = events.find((e) => e.type === 'segment');
    if (done?.type !== 'segment') throw new Error('no segment');
    expect(done.forced).toBe(false);
    // 3 preroll + 20 speech + 3 pad frames
    expect(done.audio.length).toBe(26 * F);
    expect(done.startMs).toBe(64);
    expect(done.endMs).toBe(64 + Math.round((26 * F) / 16));
    expect(seg.isRecording).toBe(false);
  });

  it('keeps recording through short pauses and the exit threshold', () => {
    const seg = new Segmenter();
    const events = run(seg, [0.9, 0.9, 0.05, 0.05, 0.15, 0.15, 0.9, 0.9]);
    expect(events.filter((e) => e.type === 'segment')).toHaveLength(0);
    expect(seg.isRecording).toBe(true);
    expect(seg.currentAudio()?.length).toBe(8 * F);
    expect(seg.currentMs).toBe(256);
  });

  it('discards blips shorter than 250 ms', () => {
    const seg = new Segmenter();
    const events = run(seg, [0.9, 0.9, ...Array(13).fill(0.01)]);
    expect(events.map((e) => e.type)).toEqual(['start', 'discard']);
  });

  it('splits long monologues at the quietest recent frame and keeps going', () => {
    const seg = new Segmenter({ maxSegmentMs: 3200 }); // 100 frames
    const probs = Array.from({ length: 100 }, (_, i) => (i === 85 ? 0.12 : 0.9));
    const events = run(seg, probs);
    const split = events.find((e) => e.type === 'segment');
    if (split?.type !== 'segment') throw new Error('expected a forced split');
    expect(split.forced).toBe(true);
    expect(split.audio.length).toBe(86 * F);
    expect(events[events.length - 1]).toEqual({ type: 'start', startMs: split.endMs });
    expect(seg.isRecording).toBe(true);
    expect(seg.currentAudio()?.length).toBe(14 * F);
  });

  it('flushes a pending utterance on stop', () => {
    const seg = new Segmenter();
    expect(seg.flush()).toEqual([]);
    run(seg, Array(20).fill(0.9));
    const out = seg.flush();
    expect(out[0]?.type).toBe('segment');
    expect(seg.currentAudio()).toBeNull();
  });

  it('concatenates chunks', () => {
    expect(Array.from(concat([Float32Array.from([1]), Float32Array.from([2, 3])]))).toEqual([1, 2, 3]);
  });
});
