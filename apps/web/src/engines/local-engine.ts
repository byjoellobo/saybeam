/**
 * On-device engine: mic -> worklet -> ASR worker (Silero VAD + Moonshine or
 * Whisper). Nothing leaves the device except the caption text.
 */
import { rms } from './resample';
import { startCapture, type CaptureHandle } from './audio-capture';
import type { CaptionEngine, EngineCallbacks, LocalEngineConfig } from './types';
import type { WorkerIn, WorkerOut } from './asr.worker';

export interface LocalEngineOptions {
  /** Serve models from the LAN relay's /models/ folder. */
  readonly localModels: boolean;
}

export class LocalEngine implements CaptionEngine {
  readonly kind = 'local' as const;
  private worker: Worker | null = null;
  private capture: CaptureHandle | null = null;
  private ready: Promise<void> | null = null;
  private starting: Promise<void> | null = null;
  private disposed = false;
  private finals = 0;
  private backend = '';
  private loadMs = 0;
  private flushWaiters: Array<() => void> = [];

  constructor(
    private readonly cfg: LocalEngineConfig,
    private readonly cb: EngineCallbacks,
    private readonly opts: LocalEngineOptions,
  ) {}

  start(): Promise<void> {
    this.starting ??= this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    await this.ensureLoaded();
    if (this.capture || this.disposed) return;
    // New run: the worker's clock restarts at zero together with ours.
    this.send({ type: 'reset' });
    this.cb.onClockStart();
    const capture = await startCapture((samples, sampleRate) => {
      this.cb.onLevel(Math.min(1, rms(samples) * 4));
      this.send({ type: 'audio', samples, sampleRate }, [samples.buffer]);
    }, this.cfg.micId ? { deviceId: this.cfg.micId } : {});
    if (this.disposed) {
      // dispose() ran while the microphone prompt was open: do not leave the mic on.
      await capture.stop();
      return;
    }
    this.capture = capture;
    this.cb.onStatus({ phase: 'listening', message: `Listening (${this.backend})` });
  }

  async stop(): Promise<void> {
    await this.starting?.catch(() => undefined);
    const cap = this.capture;
    this.capture = null;
    await cap?.stop();
    this.cb.onLevel(0);
    if (this.worker) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 8000);
        this.flushWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
        this.send({ type: 'flush' });
      });
    }
    this.cb.onStatus({ phase: 'stopped', message: 'Paused' });
  }

  dispose(): void {
    this.disposed = true;
    void this.capture?.stop();
    this.capture = null;
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    this.flushWaiters.splice(0).forEach((fn) => fn());
  }

  /** Load models without starting the mic (used by the bench and a "prepare" button). */
  ensureLoaded(): Promise<void> {
    if (this.ready) return this.ready;
    this.cb.onStatus({ phase: 'loading', message: 'Loading speech model...', progress: 0 });
    const worker = new Worker(new URL('./asr.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    this.ready = new Promise<void>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<WorkerOut>) => {
        const msg = e.data;
        if (msg.type === 'ready') {
          this.backend = msg.backend;
          this.loadMs = msg.loadMs;
          this.cb.onStatus({ phase: 'ready', message: `Model ready (${msg.backend})` });
          this.cb.onStats({ backend: msg.backend, loadMs: msg.loadMs, finals: this.finals });
          resolve();
        } else if (msg.type === 'error' && !this.backend) {
          reject(new Error(msg.message));
        }
        this.onWorkerMessage(msg);
      };
      // Covers load failures and crashes later on (for example running out of memory).
      worker.onerror = (e) => {
        const message = e.message || 'The speech worker crashed.';
        if (!this.backend) reject(new Error(message));
        else this.fail(`Speech recognition stopped: ${message}. Try a smaller model.`);
      };
      worker.onmessageerror = () => this.fail('Speech recognition stopped: the worker sent an unreadable message.');
    });
    this.ready.catch((err: unknown) => {
      this.cb.onStatus({ phase: 'error', message: friendlyLoadError(err) });
      this.dispose();
    });
    this.send({ type: 'load', modelId: this.cfg.modelId, device: this.cfg.device, language: this.cfg.language, partials: this.cfg.partials, localModels: this.opts.localModels });
    return this.ready;
  }

  /** Bench: transcribe a 16 kHz recording and resolve with timing. */
  async transcribeFile(samples: Float32Array): Promise<Extract<WorkerOut, { type: 'file-done' }>> {
    await this.ensureLoaded();
    const worker = this.worker;
    if (!worker) throw new Error('Model is not loaded.');
    return new Promise((resolve, reject) => {
      const prev = worker.onmessage;
      worker.onmessage = (e: MessageEvent<WorkerOut>) => {
        if (e.data.type === 'file-done') {
          worker.onmessage = prev;
          resolve(e.data);
        } else if (e.data.type === 'error') {
          worker.onmessage = prev;
          reject(new Error(e.data.message));
        }
      };
      this.send({ type: 'file', samples }, [samples.buffer]);
    });
  }

  private fail(message: string): void {
    this.cb.onStatus({ phase: 'error', message });
    void this.capture?.stop();
    this.capture = null;
    this.cb.onLevel(0);
  }

  private onWorkerMessage(msg: WorkerOut): void {
    switch (msg.type) {
      case 'progress':
        this.cb.onStatus({ phase: 'loading', message: `Downloading model ${msg.loadedMb.toFixed(0)} / ${msg.totalMb.toFixed(0)} MB`, progress: msg.progress });
        break;
      case 'partial':
        this.cb.onPartial(msg.key, msg.text);
        break;
      case 'final':
        this.finals++;
        if (msg.text) this.cb.onFinal(msg.key, msg.text, { startMs: msg.startMs, endMs: msg.endMs });
        else this.cb.onPartial(msg.key, '');
        break;
      case 'stats':
        this.cb.onStats({ backend: this.backend, loadMs: this.loadMs, rtf: msg.rtf, lastAsrMs: msg.lastAsrMs, lagMs: msg.lagMs, queue: msg.queue, partialEveryMs: msg.partialEveryMs, finals: this.finals });
        break;
      case 'flushed':
        this.flushWaiters.splice(0).forEach((fn) => fn());
        break;
      case 'error':
        // Per-segment errors are recoverable; show them without stopping.
        if (this.backend) this.cb.onStatus({ phase: 'listening', message: msg.message });
        break;
      default:
        break;
    }
  }

  private send(msg: WorkerIn, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer);
  }
}

function friendlyLoadError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/fetch|network|Failed to load|404/i.test(text)) return `Could not download the speech model. Check the internet connection (or use LAN mode with local models). Details: ${text}`;
  if (/memory|allocation|OOM/i.test(text)) return 'This device ran out of memory loading the model. Try Moonshine Tiny or the browser speech engine.';
  return `Could not start the speech model: ${text}`;
}
