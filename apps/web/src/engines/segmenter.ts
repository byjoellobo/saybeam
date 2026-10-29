/**
 * Turns a stream of (frame, speech probability) pairs into utterances.
 *
 * Thresholds follow the transformers.js moonshine-web example (Apache-2.0):
 * speech starts above 0.3, continues while >= 0.1, ends after 400 ms of
 * silence, 80 ms padding, utterances under 250 ms are dropped. Two additions
 * for live captions: a max utterance length (lecturers rarely pause) that
 * splits at the quietest recent frame instead of mid-word, and sample-accurate
 * start/end offsets for SRT/VTT export.
 */
export interface SegmenterOptions {
  readonly sampleRate?: number;
  readonly speechThreshold?: number;
  readonly exitThreshold?: number;
  readonly minSilenceMs?: number;
  readonly speechPadMs?: number;
  readonly minSpeechMs?: number;
  readonly maxSegmentMs?: number;
}

export type SegmentEvent =
  | { readonly type: 'start'; readonly startMs: number }
  | { readonly type: 'segment'; readonly audio: Float32Array; readonly startMs: number; readonly endMs: number; readonly forced: boolean }
  | { readonly type: 'discard' };

const DEFAULTS = {
  sampleRate: 16_000,
  speechThreshold: 0.3,
  exitThreshold: 0.1,
  minSilenceMs: 400,
  speechPadMs: 80,
  minSpeechMs: 250,
  maxSegmentMs: 15_000,
};

export class Segmenter {
  private readonly o: typeof DEFAULTS;
  private recording = false;
  private frames: Float32Array[] = [];
  private probs: number[] = [];
  private preroll: Float32Array[] = [];
  private silentFrames = 0;
  private samplesSeen = 0;
  private segStartSample = 0;

  constructor(opts: SegmenterOptions = {}) {
    this.o = { ...DEFAULTS, ...opts };
  }

  get isRecording(): boolean {
    return this.recording;
  }

  /** Duration of the utterance in progress, ms. */
  get currentMs(): number {
    return (this.sampleCount(this.frames) / this.o.sampleRate) * 1000;
  }

  push(frame: Float32Array, prob: number): SegmentEvent[] {
    const frameStart = this.samplesSeen;
    this.samplesSeen += frame.length;
    const isSpeech = prob > this.o.speechThreshold || (this.recording && prob >= this.o.exitThreshold);

    if (!this.recording) {
      if (!isSpeech) {
        this.preroll = [...this.preroll, frame].slice(-this.padFrames(frame.length));
        return [];
      }
      const prerollSamples = this.sampleCount(this.preroll);
      this.recording = true;
      this.frames = [...this.preroll, frame];
      this.probs = [...this.preroll.map(() => 0), prob];
      this.preroll = [];
      this.silentFrames = 0;
      this.segStartSample = frameStart - prerollSamples;
      return [{ type: 'start', startMs: this.toMs(this.segStartSample) }];
    }

    this.frames.push(frame);
    this.probs.push(prob);
    this.silentFrames = isSpeech ? 0 : this.silentFrames + 1;

    const silenceMs = this.toMs(this.silentFrames * frame.length);
    if (silenceMs >= this.o.minSilenceMs) return this.endUtterance(frame.length);
    if (this.currentMs >= this.o.maxSegmentMs) return this.splitLongUtterance();
    return [];
  }

  /** Audio of the utterance in progress (for partial transcripts), or null. */
  currentAudio(): Float32Array | null {
    return this.recording ? concat(this.frames) : null;
  }

  /** Force out whatever is buffered (stop button, end of file). */
  flush(): SegmentEvent[] {
    if (!this.recording) return [];
    const speechFrames = this.frames.length - this.silentFrames;
    const keep = Math.min(this.frames.length, speechFrames + this.padFrames(this.frames[0]?.length ?? 512));
    return this.emit(keep, false, true);
  }

  private endUtterance(frameLen: number): SegmentEvent[] {
    const speechFrames = this.frames.length - this.silentFrames;
    const keep = Math.min(this.frames.length, speechFrames + this.padFrames(frameLen));
    const tail = this.frames.slice(-this.padFrames(frameLen));
    const events = this.emit(keep, false, true);
    this.preroll = tail;
    return events;
  }

  /** Split at the quietest frame in the last 30% so we do not cut through a word. */
  private splitLongUtterance(): SegmentEvent[] {
    const n = this.frames.length;
    const from = Math.floor(n * 0.7);
    let split = n - 1;
    let best = Infinity;
    for (let i = from; i < n - 1; i++) {
      const p = this.probs[i] ?? 1;
      if (p < best) {
        best = p;
        split = i + 1;
      }
    }
    const remainderFrames = this.frames.slice(split);
    const remainderProbs = this.probs.slice(split);
    const events = this.emit(split, true, false);
    const startSample = this.segStartSample;
    // Keep recording: the remainder starts the next utterance.
    this.recording = true;
    this.frames = remainderFrames;
    this.probs = remainderProbs;
    this.silentFrames = 0;
    this.segStartSample = startSample;
    return [...events, { type: 'start', startMs: this.toMs(this.segStartSample) }];
  }

  private emit(keepFrames: number, forced: boolean, resetAfter: boolean): SegmentEvent[] {
    const kept = this.frames.slice(0, keepFrames);
    const audio = concat(kept);
    const startMs = this.toMs(this.segStartSample);
    const endMs = this.toMs(this.segStartSample + audio.length);
    const speechSamples = this.sampleCount(this.frames.slice(0, this.frames.length - this.silentFrames));
    const nextStart = this.segStartSample + audio.length;
    if (resetAfter) this.reset();
    else this.segStartSample = nextStart;
    if (!forced && this.toMs(speechSamples) < this.o.minSpeechMs) return [{ type: 'discard' }];
    return [{ type: 'segment', audio, startMs, endMs, forced }];
  }

  private reset(): void {
    this.recording = false;
    this.frames = [];
    this.probs = [];
    this.silentFrames = 0;
  }

  private padFrames(frameLen: number): number {
    return Math.max(1, Math.ceil(((this.o.speechPadMs / 1000) * this.o.sampleRate) / frameLen));
  }

  private sampleCount(frames: readonly Float32Array[]): number {
    return frames.reduce((n, f) => n + f.length, 0);
  }

  private toMs(samples: number): number {
    return Math.round((samples / this.o.sampleRate) * 1000);
  }
}

export function concat(chunks: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
