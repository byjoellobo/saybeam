/**
 * Glue between a speech engine and the room: applies word replacements, maps
 * engine utterance keys to globally unique segment ids, and puts timings on
 * the room's timeline (ms since the room was created) for SRT/VTT export.
 */
import type { FinalMsg } from '@caption-room/protocol';
import type { CompiledReplacements } from './replacements';
import type { FinalTiming } from '../engines/types';

export interface CaptionSink {
  sendPartial(id: string, text: string): void;
  sendFinal(final: Omit<FinalMsg, 't'>): void;
}

export interface LocalPartial {
  readonly id: string;
  readonly text: string;
}

const MAX_OFFSET_MS = 72 * 60 * 60 * 1000;

const randomNonce = (): string => Math.random().toString(36).slice(2, 8);

export class CaptionPipeline {
  private nonce: string;
  private runBaseMs = 0;
  private partial: LocalPartial | null = null;
  private readonly listeners = new Set<(p: LocalPartial | null) => void>();

  constructor(
    private readonly sink: CaptionSink,
    private replacements: CompiledReplacements,
    private readonly timelineNow: () => number,
    private readonly makeNonce: () => string = randomNonce,
  ) {
    this.nonce = makeNonce();
  }

  /** Call when an engine (re)starts: keys restart at zero, so ids need a fresh prefix. */
  beginRun(): void {
    this.nonce = this.makeNonce();
    this.runBaseMs = Math.max(0, this.timelineNow());
  }

  setReplacements(r: CompiledReplacements): void {
    this.replacements = r;
  }

  get localPartial(): LocalPartial | null {
    return this.partial;
  }

  onLocalPartial(fn: (p: LocalPartial | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  idFor(key: string): string {
    return `${this.nonce}.${key}`;
  }

  partialFromEngine(key: string, text: string): void {
    const id = this.idFor(key);
    const clean = this.replacements.apply(text);
    this.setPartial(clean ? { id, text: clean } : null);
    this.sink.sendPartial(id, clean);
  }

  finalFromEngine(key: string, text: string, timing: FinalTiming): void {
    const id = this.idFor(key);
    const clean = this.replacements.apply(text).trim();
    if (this.partial?.id === id) this.setPartial(null);
    if (!clean) {
      this.sink.sendPartial(id, '');
      return;
    }
    const startMs = this.offset(timing.startMs);
    const endMs = this.offset(timing.endMs);
    this.sink.sendFinal({ id, text: clean.slice(0, 2000), ...(startMs !== undefined ? { startMs } : {}), ...(endMs !== undefined && (startMs === undefined || endMs >= startMs) ? { endMs } : {}) });
  }

  clearPartial(): void {
    if (this.partial) this.sink.sendPartial(this.partial.id, '');
    this.setPartial(null);
  }

  private offset(ms: number | undefined): number | undefined {
    if (ms === undefined || !Number.isFinite(ms)) return undefined;
    return Math.min(MAX_OFFSET_MS, Math.max(0, Math.round(this.runBaseMs + ms)));
  }

  private setPartial(p: LocalPartial | null): void {
    this.partial = p;
    for (const fn of this.listeners) fn(p);
  }
}
