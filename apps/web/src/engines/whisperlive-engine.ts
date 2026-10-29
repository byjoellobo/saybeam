/**
 * Self-hosted WhisperLive server (github.com/collabora/WhisperLive). The
 * browser streams 16 kHz float32 PCM; the server returns a sliding window of
 * segments. WhisperLive closes connections after max_connection_time (300 s
 * by default), so we reconnect seamlessly and keep one timeline.
 */
import { startCapture, type CaptureHandle } from './audio-capture';
import { Resampler, TARGET_RATE, rms } from './resample';
import { buildConfig, EMPTY_MERGE, END_OF_AUDIO, isMixedContentBlocked, mergeSegments, parseServerMessage, toWirePcm, type MergeState, type WlSegment } from './whisperlive-protocol';
import type { CaptionEngine, EngineCallbacks, WhisperLiveEngineConfig } from './types';

const READY_TIMEOUT_MS = 180_000; // first connection may download the model
const MAX_BACKLOG_SAMPLES = TARGET_RATE * 20;

/** Only ws:// and wss:// addresses are accepted. */
export function validateServerUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Enter the WhisperLive address, for example ws://localhost:9090');
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('The WhisperLive address must start with ws:// or wss://');
  return url;
}

export class WhisperLiveEngine implements CaptionEngine {
  readonly kind = 'whisperlive' as const;
  private ws: WebSocket | null = null;
  private capture: CaptureHandle | null = null;
  private resampler: Resampler | null = null;
  private wanted = false;
  private ready = false;
  private backlog: Float32Array[] = [];
  private merge: MergeState = EMPTY_MERGE;
  private offsetMs = 0;
  private startedAt = 0;
  private counter = 0;
  private partial = '';
  private attempts = 0;
  private finals = 0;
  private waitUntil = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly cfg: WhisperLiveEngineConfig,
    private readonly cb: EngineCallbacks,
  ) {}

  async start(): Promise<void> {
    validateServerUrl(this.cfg.url);
    if (isMixedContentBlocked(this.cfg.url, location.protocol)) {
      throw new Error('Browsers block ws:// connections from an https page. Put WhisperLive behind a TLS proxy (wss://), run it on this computer (ws://localhost), or use LAN mode.');
    }
    this.wanted = true;
    this.startedAt = performance.now();
    this.backlog = [];
    this.cb.onClockStart();
    this.connect();
    try {
      this.capture = await startCapture((samples, rate) => this.onAudio(samples, rate), this.cfg.micId ? { deviceId: this.cfg.micId } : {});
    } catch (err) {
      // No microphone: do not leave a socket and a reconnect loop running.
      this.wanted = false;
      this.closeSocket();
      throw err;
    }
    if (!this.wanted) {
      await this.capture.stop();
      this.capture = null;
    }
  }

  async stop(): Promise<void> {
    this.wanted = false;
    await this.capture?.stop();
    this.capture = null;
    this.cb.onLevel(0);
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(END_OF_AUDIO);
      await new Promise((r) => setTimeout(r, 1500)); // let the last segments arrive
    }
    this.promotePartial();
    this.closeSocket();
    this.backlog = [];
    this.cb.onStatus({ phase: 'stopped', message: 'Paused' });
  }

  dispose(): void {
    this.wanted = false;
    void this.capture?.stop();
    this.capture = null;
    this.closeSocket();
    this.backlog = [];
  }

  private connect(): void {
    this.closeSocket(); // one connection at a time
    this.ready = false;
    this.merge = EMPTY_MERGE;
    const uid = crypto.randomUUID();
    this.cb.onStatus({ phase: 'loading', message: `Connecting to ${this.cfg.url}...` });
    let ws: WebSocket;
    try {
      ws = this.cfg.apiKey ? new WebSocket(this.cfg.url, ['bearer', this.cfg.apiKey]) : new WebSocket(this.cfg.url);
    } catch (err) {
      this.cb.onStatus({ phase: 'error', message: `Bad WhisperLive address: ${String(err)}` });
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    const current = () => this.ws === ws;
    ws.onopen = () => {
      if (!current()) return;
      ws.send(JSON.stringify(buildConfig({ uid, language: this.cfg.language, model: this.cfg.model, ...(this.cfg.hotwords ? { hotwords: this.cfg.hotwords } : {}) })));
      this.cb.onStatus({ phase: 'loading', message: 'Waiting for the server to load the model...' });
      this.readyTimer = setTimeout(() => {
        this.cb.onStatus({ phase: 'error', message: 'WhisperLive did not get ready in time. Check the server logs.' });
        ws.close();
      }, READY_TIMEOUT_MS);
    };
    ws.onmessage = (e) => {
      if (!current() || typeof e.data !== 'string') return;
      const ev = parseServerMessage(e.data, uid);
      switch (ev.kind) {
        case 'ready':
          this.onReady(ws, ev.backend);
          break;
        case 'segments':
          this.onSegments(ev.segments);
          break;
        case 'wait':
          // The server is full and will close this socket; do not retry before it asks.
          this.waitUntil = Date.now() + Math.min(300_000, ev.minutes * 60_000);
          this.cb.onStatus({ phase: 'loading', message: `Server is full. Retrying in about ${Math.ceil(ev.minutes)} min.` });
          break;
        case 'error':
          this.wanted = false;
          this.cb.onStatus({ phase: 'error', message: `WhisperLive: ${ev.message}` });
          void this.capture?.stop();
          this.capture = null;
          break;
        case 'warning':
          this.cb.onStatus({ phase: this.ready ? 'listening' : 'loading', message: `WhisperLive: ${ev.message}` });
          break;
        case 'disconnect':
          // Connection time limit reached; keep the words and reconnect on close.
          this.promotePartial();
          break;
        default:
          break;
      }
    };
    ws.onclose = () => {
      if (!current()) return;
      this.ws = null;
      this.clearTimers();
      this.promotePartial();
      if (!this.wanted) return;
      this.attempts++;
      const backoff = Math.min(10_000, 500 * 2 ** this.attempts);
      this.cb.onStatus({ phase: 'loading', message: 'Reconnecting to WhisperLive...' });
      this.retryTimer = setTimeout(() => this.wanted && this.connect(), Math.max(backoff, this.waitUntil - Date.now()));
    };
  }

  private onReady(ws: WebSocket, backend: string): void {
    this.ready = true;
    this.attempts = 0;
    this.waitUntil = 0;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.cb.onStatus({ phase: 'listening', message: `Listening (WhisperLive, ${backend})` });
    this.cb.onStats({ backend: `WhisperLive ${backend}`, finals: this.finals });
    // This connection's audio clock starts at the first buffered sample.
    const buffered = this.backlog.splice(0);
    const bufferedMs = (buffered.reduce((n, c) => n + c.length, 0) / TARGET_RATE) * 1000;
    this.offsetMs = performance.now() - this.startedAt - bufferedMs;
    for (const chunk of buffered) ws.send(toWirePcm(chunk));
  }

  private onAudio(samples: Float32Array, rate: number): void {
    this.cb.onLevel(Math.min(1, rms(samples) * 4));
    if (!this.wanted) return;
    if (!this.resampler || this.resampler.inputRate !== rate) this.resampler = new Resampler(rate);
    const pcm = this.resampler.process(samples);
    const ws = this.ws;
    if (ws && this.ready && ws.readyState === WebSocket.OPEN) {
      ws.send(toWirePcm(pcm));
      return;
    }
    // Hold a little audio while (re)connecting so the first words are not lost.
    this.backlog.push(pcm);
    let total = this.backlog.reduce((n, c) => n + c.length, 0);
    while (total > MAX_BACKLOG_SAMPLES && this.backlog.length) total -= (this.backlog.shift() as Float32Array).length;
  }

  private onSegments(segments: readonly WlSegment[]): void {
    const result = mergeSegments(this.merge, segments);
    this.merge = result.state;
    for (const f of result.finals) {
      const key = `l${this.counter++}`;
      const startMs = f.startS !== null ? Math.round(this.offsetMs + f.startS * 1000) : undefined;
      const endMs = f.endS !== null ? Math.round(this.offsetMs + f.endS * 1000) : undefined;
      this.cb.onFinal(key, f.text, { ...(startMs !== undefined ? { startMs } : {}), ...(endMs !== undefined ? { endMs } : {}) });
      this.finals++;
    }
    const next = result.partial ?? '';
    if (next !== this.partial || result.finals.length) this.cb.onPartial(`l${this.counter}`, next);
    this.partial = next;
  }

  private promotePartial(): void {
    if (!this.partial) return;
    const endMs = Math.round(performance.now() - this.startedAt);
    this.cb.onFinal(`l${this.counter++}`, this.partial, { endMs });
    this.finals++;
    this.partial = '';
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.retryTimer = this.readyTimer = null;
  }

  private closeSocket(): void {
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // ignore
    }
  }
}
