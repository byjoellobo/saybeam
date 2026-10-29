/**
 * Browser speech engine (Web Speech API). Chrome and Edge send audio to the
 * vendor's cloud unless on-device recognition is enabled (Chrome 139+ desktop);
 * Safari uses Apple's recogniser. Sessions end on their own after silence, so
 * we restart them, as Web Captioner did.
 */
import type { CaptionEngine, EngineCallbacks, WebSpeechEngineConfig } from './types';

interface SRAlternative {
  readonly transcript: string;
}
interface SRResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SRAlternative;
}
interface SRResultList {
  readonly length: number;
  readonly [index: number]: SRResult;
}
interface SREvent {
  readonly resultIndex: number;
  readonly results: SRResultList;
}
interface SRErrorEvent {
  readonly error: string;
  readonly message?: string;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  processLocally?: boolean;
  phrases?: unknown[];
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: SRErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface RecognitionCtor {
  new (): Recognition;
  available?: (opts: { langs: string[]; processLocally?: boolean }) => Promise<'available' | 'downloadable' | 'downloading' | 'unavailable'>;
  install?: (opts: { langs: string[]; processLocally?: boolean }) => Promise<boolean>;
}
type PhraseCtor = new (phrase: string, boost?: number) => unknown;

const w = globalThis as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor; SpeechRecognitionPhrase?: PhraseCtor };

export function speechRecognitionCtor(): RecognitionCtor | null {
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface WebSpeechSupport {
  readonly available: boolean;
  readonly onDeviceApi: boolean;
  readonly phrasesApi: boolean;
}

export function webSpeechSupport(): WebSpeechSupport {
  const ctor = speechRecognitionCtor();
  return { available: Boolean(ctor), onDeviceApi: typeof ctor?.available === 'function', phrasesApi: typeof w.SpeechRecognitionPhrase === 'function' };
}

export type OnDeviceState = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported';

export async function onDeviceAvailability(lang: string): Promise<OnDeviceState> {
  const ctor = speechRecognitionCtor();
  if (!ctor?.available) return 'unsupported';
  try {
    return await ctor.available({ langs: [lang], processLocally: true });
  } catch {
    return 'unavailable';
  }
}

/** Must be called from a click: Chrome needs a user gesture to download a language pack. */
export async function installOnDevice(lang: string): Promise<boolean> {
  const ctor = speechRecognitionCtor();
  if (!ctor?.install) return false;
  try {
    return await ctor.install({ langs: [lang], processLocally: true });
  } catch {
    return false;
  }
}

const ANDROID = /Android/i.test(globalThis.navigator?.userAgent ?? '');

const FATAL = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported', 'phrases-not-supported', 'audio-capture']);

export class WebSpeechEngine implements CaptionEngine {
  readonly kind = 'webspeech' as const;
  private rec: Recognition | null = null;
  private wanted = false;
  private counter = 0;
  private emitted = new Set<number>();
  private startedAt = 0;
  private utteranceStart: number | null = null;
  private lastFinal = { text: '', at: 0 };
  private networkErrors = 0;
  private finals = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly cfg: WebSpeechEngineConfig,
    private readonly cb: EngineCallbacks,
  ) {}

  async start(): Promise<void> {
    const ctor = speechRecognitionCtor();
    if (!ctor) throw new Error('This browser has no built-in speech recognition. Use Chrome, Edge or Safari, or pick an on-device model.');
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    try {
      this.rec?.abort(); // never run two recognisers at once
    } catch {
      // not running
    }
    this.wanted = true;
    this.startedAt = performance.now();
    this.cb.onClockStart();
    this.cb.onStats({ backend: this.cfg.onDevice ? 'Browser, on-device' : 'Browser speech service', finals: this.finals });
    this.run(ctor);
  }

  async stop(): Promise<void> {
    this.wanted = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    // stop() (not abort) lets the browser deliver the final result for what was just said.
    try {
      this.rec?.stop();
    } catch {
      // not running
    }
    this.cb.onStatus({ phase: 'stopped', message: 'Paused' });
  }

  dispose(): void {
    this.wanted = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    try {
      this.rec?.abort();
    } catch {
      // ignore
    }
    this.rec = null;
  }

  private run(ctor: RecognitionCtor): void {
    const rec = new ctor();
    this.rec = rec;
    this.emitted = new Set();
    rec.lang = this.cfg.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    if (this.cfg.onDevice && 'processLocally' in rec) rec.processLocally = true;
    if (this.cfg.onDevice && this.cfg.phrases.length && w.SpeechRecognitionPhrase) {
      const Phrase = w.SpeechRecognitionPhrase;
      rec.phrases = this.cfg.phrases.slice(0, 200).map((p) => new Phrase(p, 3));
    }

    // Ignore late events from a previous recogniser (after a quick pause and resume).
    const current = () => this.rec === rec;
    rec.onstart = () => {
      if (!current()) return;
      this.networkErrors = 0;
      this.cb.onStatus({ phase: 'listening', message: this.cfg.onDevice ? 'Listening (on-device)' : 'Listening (browser speech service)' });
    };
    rec.onresult = (e) => current() && this.onResult(e);
    rec.onerror = (e) => {
      if (!current()) return;
      if (FATAL.has(e.error)) {
        this.wanted = false;
        this.cb.onStatus({ phase: 'error', message: explainError(e.error) });
      } else if (e.error === 'network') {
        this.networkErrors++;
        this.cb.onStatus({ phase: 'listening', message: 'Network hiccup, reconnecting to the speech service...' });
      }
    };
    rec.onend = () => {
      if (!current()) return;
      this.flushInterimAsFinal();
      if (!this.wanted) return;
      // Back off when the speech service is unreachable; otherwise restart quickly.
      const delay = this.networkErrors ? Math.min(10_000, 500 * 2 ** this.networkErrors) : 150;
      this.restartTimer = setTimeout(() => this.wanted && this.run(ctor), delay);
    };
    try {
      rec.start();
    } catch (err) {
      this.cb.onStatus({ phase: 'error', message: `Could not start speech recognition: ${String(err)}` });
    }
  }

  private pendingInterim = '';

  private onResult(e: SREvent): void {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      if (!result) continue;
      const text = result[0]?.transcript ?? '';
      if (result.isFinal) {
        if (!this.emitted.has(i)) {
          this.emitted.add(i);
          this.emitFinal(text);
        }
      } else {
        interim += text;
      }
    }
    this.pendingInterim = interim.trim();
    if (this.pendingInterim) {
      this.utteranceStart ??= performance.now() - this.startedAt;
      this.cb.onPartial(this.key(), this.pendingInterim);
    }
  }

  private emitFinal(raw: string): void {
    const text = raw.trim();
    const now = performance.now();
    // Android Chrome sometimes repeats the previous final verbatim; elsewhere a repeat is real speech.
    if (!text || (ANDROID && text === this.lastFinal.text && now - this.lastFinal.at < 1500)) {
      this.cb.onPartial(this.key(), '');
      return;
    }
    this.lastFinal = { text, at: now };
    const endMs = Math.round(now - this.startedAt);
    const startMs = Math.round(this.utteranceStart ?? Math.max(0, endMs - 2000));
    this.cb.onFinal(this.key(), text, { startMs, endMs });
    this.finals++;
    this.counter++;
    this.utteranceStart = null;
    this.pendingInterim = '';
  }

  /** If a session ends mid-sentence, keep the words rather than losing them. */
  private flushInterimAsFinal(): void {
    if (this.pendingInterim) this.emitFinal(this.pendingInterim);
  }

  private key(): string {
    return `w${this.counter}`;
  }
}

function explainError(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone or speech service blocked. Allow the microphone for this site and try again.';
    case 'language-not-supported':
      return 'This language is not available for on-device recognition yet. Install it, or turn off on-device mode.';
    case 'phrases-not-supported':
      return 'Custom vocabulary needs on-device mode in this browser.';
    case 'audio-capture':
      return 'No microphone found.';
    default:
      return `Speech recognition stopped: ${code}`;
  }
}
