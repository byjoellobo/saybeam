/**
 * Streaming resampler to 16 kHz for speech models.
 *
 * Downsampling averages every input sample inside each output sample's window
 * (a box filter), which is a cheap anti-alias filter that is plenty for ASR.
 * Upsampling (rare: 8 kHz Bluetooth headsets) uses linear interpolation.
 * State carries across chunks so there are no clicks at chunk boundaries.
 */
export const TARGET_RATE = 16_000;

export class Resampler {
  private readonly ratio: number;
  /** Position of the next output sample's centre, in input samples, relative to `carry[0]`. */
  private pos: number;
  private carry: Float32Array = new Float32Array(0);

  constructor(
    readonly inputRate: number,
    readonly outputRate: number = TARGET_RATE,
  ) {
    if (!(inputRate > 0) || !(outputRate > 0)) throw new Error('sample rates must be positive');
    this.ratio = inputRate / outputRate;
    this.pos = this.ratio > 1 ? this.ratio / 2 : 0;
  }

  process(input: Float32Array): Float32Array {
    if (this.ratio === 1) return input.slice();
    const buf = new Float32Array(this.carry.length + input.length);
    buf.set(this.carry, 0);
    buf.set(input, this.carry.length);
    return this.ratio > 1 ? this.down(buf) : this.up(buf);
  }

  private down(buf: Float32Array): Float32Array {
    const half = this.ratio / 2;
    const out: number[] = [];
    let c = this.pos;
    while (c + half <= buf.length) {
      const from = Math.max(0, Math.floor(c - half));
      const to = Math.min(buf.length, Math.ceil(c + half));
      let sum = 0;
      for (let i = from; i < to; i++) sum += buf[i] ?? 0;
      out.push(sum / Math.max(1, to - from));
      c += this.ratio;
    }
    const consumed = Math.max(0, Math.floor(c - half));
    this.carry = buf.slice(consumed);
    this.pos = c - consumed;
    return Float32Array.from(out);
  }

  private up(buf: Float32Array): Float32Array {
    const out: number[] = [];
    let c = this.pos;
    while (c + 1 < buf.length) {
      const i = Math.floor(c);
      const frac = c - i;
      out.push((buf[i] ?? 0) * (1 - frac) + (buf[i + 1] ?? 0) * frac);
      c += this.ratio;
    }
    const consumed = Math.floor(c);
    this.carry = buf.slice(consumed);
    this.pos = c - consumed;
    return Float32Array.from(out);
  }
}

/** Re-blocks a stream into fixed-size frames (Silero VAD wants 512 samples at 16 kHz). */
export class FrameChunker {
  private pending: Float32Array = new Float32Array(0);

  constructor(readonly size: number = 512) {}

  push(input: Float32Array): Float32Array[] {
    const buf = new Float32Array(this.pending.length + input.length);
    buf.set(this.pending, 0);
    buf.set(input, this.pending.length);
    const frames: Float32Array[] = [];
    let offset = 0;
    while (offset + this.size <= buf.length) {
      frames.push(buf.slice(offset, offset + this.size));
      offset += this.size;
    }
    this.pending = buf.slice(offset);
    return frames;
  }
}

/** Root-mean-square level, for the speaker's mic meter. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}
