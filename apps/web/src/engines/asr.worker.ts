/// <reference lib="webworker" />
/**
 * On-device speech recognition worker: Silero VAD + Moonshine or Whisper via
 * transformers.js. Receives raw mic chunks, emits partial and final captions.
 *
 * Latency on low-end machines is the main risk, so the worker measures itself:
 * every final reports its compute time, and partial updates slow down (or
 * pause) automatically when transcription cannot keep up with speech.
 */
import { AutoModel, Tensor, env, pipeline } from '@huggingface/transformers';
import { FrameChunker, Resampler, TARGET_RATE } from './resample';
import { Segmenter, type SegmentEvent } from './segmenter';
import { VAD_MODEL, findPreset, maxNewTokens, type ModelPreset } from './models';
import { collapseRepeats, isLikelyHallucination } from './hallucination';
import type { DevicePreference } from './types';

export type WorkerIn =
  | { type: 'load'; modelId: string; device: DevicePreference; language: string | null; partials: boolean; localModels: boolean }
  | { type: 'audio'; samples: Float32Array; sampleRate: number }
  | { type: 'flush' }
  | { type: 'reset' }
  | { type: 'file'; samples: Float32Array };

export type WorkerOut =
  | { type: 'progress'; progress: number; loadedMb: number; totalMb: number }
  | { type: 'ready'; backend: string; loadMs: number }
  | { type: 'speech'; active: boolean }
  | { type: 'partial'; key: string; text: string }
  | { type: 'final'; key: string; text: string; startMs: number; endMs: number; asrMs: number }
  | { type: 'stats'; rtf: number; lastAsrMs: number; lagMs: number; queue: number; partialEveryMs: number }
  | { type: 'flushed' }
  | { type: 'file-done'; audioMs: number; asrMs: number; wallMs: number; segments: Array<{ text: string; startMs: number; endMs: number; asrMs: number }> }
  | { type: 'error'; message: string };

type Transcriber = (audio: Float32Array, options?: Record<string, unknown>) => Promise<{ text: string } | Array<{ text: string }>>;
type VadModel = (inputs: Record<string, Tensor>) => Promise<{ output: Tensor; stateN: Tensor }>;

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (msg: WorkerOut, transfer: Transferable[] = []): void => ctx.postMessage(msg, transfer);

let preset: ModelPreset | null = null;
let language: string | null = null;
let partialsWanted = true;
let transcriber: Transcriber | null = null;
let vadModel: VadModel | null = null;
let vadState: Tensor | null = null;
let vadSr: Tensor | null = null;

/** transformers.js runs one inference at a time; chain everything through one promise. */
let chain: Promise<unknown> = Promise.resolve();
const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
  const next = chain.then(job, job);
  chain = next.catch(() => undefined);
  return next;
};

let resampler: Resampler | null = null;
let chunker = new FrameChunker(512);
let segmenter = new Segmenter();
let frameQueue: Float32Array[] = [];
let pumping = false;

let utterance = 0;
let currentKey: string | null = null;
let streamStartWall = 0;
let pendingJobs = 0;
let partialBusy = false;
let lastPartialAt = 0;
let partialEveryMs = 700;
let rtfEma = 0;
/** Duration-weighted, decaying sums: short clips (mostly fixed overhead) do not dominate the RTF. */
let asrMsSum = 0;
let audioMsSum = 0;
let lastAsrMs = 0;
const finalJobs = new Set<Promise<void>>();

/* ---------------------------------- load ---------------------------------- */

async function pickDevice(pref: DevicePreference): Promise<'webgpu' | 'wasm'> {
  if (pref === 'wasm') return 'wasm';
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return 'wasm';
  try {
    return (await gpu.requestAdapter()) ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

function configureEnv(localModels: boolean): void {
  if (localModels) {
    // LAN relay: models and the ONNX Runtime wasm are served from /models/ so classrooms work offline.
    env.allowLocalModels = true;
    env.localModelPath = '/models/';
    const wasm = env.backends.onnx.wasm;
    if (wasm) wasm.wasmPaths = { mjs: '/models/ort/ort-wasm-simd-threaded.asyncify.mjs', wasm: '/models/ort/ort-wasm-simd-threaded.asyncify.wasm' };
  }
}

async function load(msg: Extract<WorkerIn, { type: 'load' }>): Promise<void> {
  const started = performance.now();
  preset = findPreset(msg.modelId);
  language = msg.language;
  partialsWanted = msg.partials;
  configureEnv(msg.localModels);
  segmenter = new Segmenter({ maxSegmentMs: preset.maxSegmentMs });

  const progress_callback = (info: { status: string; progress?: number; loaded?: number; total?: number }): void => {
    if (info.status === 'progress_total' && typeof info.progress === 'number') {
      post({ type: 'progress', progress: info.progress / 100, loadedMb: (info.loaded ?? 0) / 1e6, totalMb: (info.total ?? 0) / 1e6 });
    }
  };

  vadModel = (await AutoModel.from_pretrained(VAD_MODEL.repo, {
    revision: VAD_MODEL.revision,
    config: { model_type: 'custom' } as never,
    dtype: 'fp32',
  })) as unknown as VadModel;
  vadSr = new Tensor('int64', [BigInt(TARGET_RATE)], []);
  vadState = new Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);

  let device = await pickDevice(msg.device);
  try {
    transcriber = await createTranscriber(preset, device, progress_callback);
  } catch (err) {
    if (device !== 'webgpu') throw err;
    // Some GPUs advertise WebGPU but fail on these kernels: fall back to CPU.
    device = 'wasm';
    transcriber = await createTranscriber(preset, device, progress_callback);
  }

  // Warm up (compiles WebGPU shaders) so the first caption is not slow.
  await transcriber(new Float32Array(TARGET_RATE), generationOptions(1));
  const threads = env.backends.onnx.wasm?.numThreads;
  const backend = device === 'webgpu' ? 'WebGPU' : `WASM${self.crossOriginIsolated ? ` (${threads ?? 'auto'} threads)` : ' (1 thread)'}`;
  post({ type: 'ready', backend, loadMs: Math.round(performance.now() - started) });
}

async function createTranscriber(p: ModelPreset, device: 'webgpu' | 'wasm', progress_callback: (info: never) => void): Promise<Transcriber> {
  const asr = await pipeline('automatic-speech-recognition', p.repo, {
    revision: p.revision,
    device,
    dtype: p.dtype[device] as never,
    progress_callback: progress_callback as never,
  });
  return asr as unknown as Transcriber;
}

function generationOptions(audioSeconds: number): Record<string, unknown> {
  if (!preset) return {};
  const opts: Record<string, unknown> = { max_new_tokens: maxNewTokens(preset.family, audioSeconds) };
  if (preset.family === 'whisper' && !preset.englishOnly) {
    opts.task = 'transcribe';
    if (language) opts.language = language;
  }
  return opts;
}

/* ---------------------------------- audio ---------------------------------- */

async function vad(frame: Float32Array): Promise<number> {
  const model = vadModel;
  if (!model || !vadSr || !vadState) return 0;
  const input = new Tensor('float32', frame, [1, frame.length]);
  const { output, stateN } = await enqueue(() => model({ input, sr: vadSr as Tensor, state: vadState as Tensor }));
  vadState = stateN;
  return Number(output.data[0] ?? 0);
}

async function transcribe(audio: Float32Array): Promise<{ text: string; ms: number }> {
  const run = transcriber;
  if (!run) return { text: '', ms: 0 };
  return enqueue(async () => {
    const t0 = performance.now();
    const out = await run(audio, generationOptions(audio.length / TARGET_RATE));
    const result = Array.isArray(out) ? out[0] : out;
    return { text: cleanText(result?.text ?? ''), ms: performance.now() - t0 };
  });
}

function cleanText(raw: string): string {
  const text = collapseRepeats(raw.replace(/\s+/g, ' ').trim());
  if (preset?.family === 'whisper' && isLikelyHallucination(text)) return '';
  return text;
}

function onAudio(samples: Float32Array, sampleRate: number): void {
  if (!resampler || resampler.inputRate !== sampleRate) resampler = new Resampler(sampleRate);
  if (!streamStartWall) streamStartWall = performance.now();
  for (const frame of chunker.push(resampler.process(samples))) frameQueue.push(frame);
  void pump();
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (frameQueue.length) {
      const frame = frameQueue.shift() as Float32Array;
      const prob = await vad(frame);
      for (const ev of segmenter.push(frame, prob)) handleSegmentEvent(ev, true);
      maybePartial();
    }
  } catch (err) {
    frameQueue = []; // do not retry the frame that failed forever
    post({ type: 'error', message: `Speech recognition failed: ${String(err)}` });
  } finally {
    pumping = false;
  }
}

function handleSegmentEvent(ev: SegmentEvent, live: boolean): void {
  if (ev.type === 'start') {
    utterance += 1;
    currentKey = `u${utterance}`;
    if (live) post({ type: 'speech', active: true });
    return;
  }
  if (ev.type === 'discard') {
    if (currentKey && live) post({ type: 'partial', key: currentKey, text: '' });
    currentKey = null;
    if (live) post({ type: 'speech', active: false });
    return;
  }
  const key = currentKey ?? `u${++utterance}`;
  if (!ev.forced) {
    currentKey = null;
    if (live) post({ type: 'speech', active: false });
  }
  const job = finalize(key, ev.audio, ev.startMs, ev.endMs);
  finalJobs.add(job);
  void job.finally(() => finalJobs.delete(job));
}

async function finalize(key: string, audio: Float32Array, startMs: number, endMs: number): Promise<void> {
  pendingJobs++;
  try {
    const { text, ms } = await transcribe(audio);
    lastAsrMs = ms;
    const audioMs = (audio.length / TARGET_RATE) * 1000;
    asrMsSum = asrMsSum * 0.8 + ms;
    audioMsSum = audioMsSum * 0.8 + audioMs;
    rtfEma = asrMsSum / Math.max(1, audioMsSum);
    adaptPartials();
    post({ type: 'final', key, text, startMs, endMs, asrMs: Math.round(ms) });
  } catch (err) {
    post({ type: 'error', message: `Could not transcribe a segment: ${String(err)}` });
  } finally {
    pendingJobs--;
  }
  const lagMs = streamStartWall ? performance.now() - streamStartWall - endMs : 0;
  post({ type: 'stats', rtf: rtfEma, lastAsrMs: Math.round(lastAsrMs), lagMs: Math.max(0, Math.round(lagMs)), queue: pendingJobs, partialEveryMs: partialsActive() ? partialEveryMs : 0 });
}

/** Partials cost a full transcription each, so space them by how fast the device is. */
function adaptPartials(): void {
  partialEveryMs = Math.min(3000, Math.max(500, lastAsrMs * 2.5));
}

function partialsActive(): boolean {
  // When finals alone take most of real time, partials would make captions fall behind.
  return partialsWanted && rtfEma < 0.6 && pendingJobs === 0;
}

function maybePartial(): void {
  if (!partialsActive() || partialBusy || !segmenter.isRecording || !currentKey) return;
  if (segmenter.currentMs < 600) return;
  const now = performance.now();
  if (now - lastPartialAt < partialEveryMs) return;
  const audio = segmenter.currentAudio();
  if (!audio) return;
  const key = currentKey;
  partialBusy = true;
  lastPartialAt = now;
  void transcribe(audio)
    .then(({ text, ms }) => {
      lastAsrMs = Math.max(lastAsrMs * 0.5, ms);
      adaptPartials();
      if (key === currentKey && text) post({ type: 'partial', key, text });
    })
    .catch(() => undefined)
    .finally(() => {
      partialBusy = false;
    });
}

async function flush(): Promise<void> {
  // Let queued frames run through VAD first (pump drains the queue or drops it on error),
  // then force out the open utterance and wait for every final to be posted.
  for (let i = 0; i < 500 && (pumping || frameQueue.length); i++) {
    if (!pumping) await pump();
    else await new Promise((r) => setTimeout(r, 20));
  }
  frameQueue = [];
  for (const ev of segmenter.flush()) handleSegmentEvent(ev, true);
  await Promise.all([...finalJobs]);
  post({ type: 'flushed' });
}

/** Start a new run: the stream clock restarts at zero, matching the caption timeline. */
function reset(): void {
  frameQueue = [];
  chunker = new FrameChunker(512);
  lastPartialAt = 0;
  segmenter = new Segmenter({ maxSegmentMs: preset?.maxSegmentMs ?? 15_000 });
  vadState = new Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);
  currentKey = null;
  streamStartWall = 0;
  resampler = null;
}

/** Bench mode: run a whole recording as fast as possible and time it. */
async function runFile(samples: Float32Array): Promise<void> {
  reset();
  const wall0 = performance.now();
  const fileSegmenter = new Segmenter({ maxSegmentMs: preset?.maxSegmentMs ?? 15_000 });
  const jobs: Array<Promise<{ text: string; startMs: number; endMs: number; asrMs: number }>> = [];
  const take = (ev: SegmentEvent): void => {
    if (ev.type !== 'segment') return;
    const { audio, startMs, endMs } = ev;
    jobs.push(transcribe(audio).then(({ text, ms }) => ({ text, startMs, endMs, asrMs: Math.round(ms) })));
  };
  const frames = new FrameChunker(512).push(samples);
  for (const frame of frames) {
    const prob = await vad(frame);
    fileSegmenter.push(frame, prob).forEach(take);
  }
  fileSegmenter.flush().forEach(take);
  const segments = await Promise.all(jobs);
  post({
    type: 'file-done',
    audioMs: Math.round((samples.length / TARGET_RATE) * 1000),
    asrMs: segments.reduce((n, s) => n + s.asrMs, 0),
    wallMs: Math.round(performance.now() - wall0),
    segments,
  });
}

ctx.onmessage = (event: MessageEvent<WorkerIn>) => {
  const msg = event.data;
  const fail = (err: unknown): void => post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  switch (msg.type) {
    case 'load':
      load(msg).catch(fail);
      break;
    case 'audio':
      onAudio(msg.samples, msg.sampleRate);
      break;
    case 'flush':
      flush().catch(fail);
      break;
    case 'reset':
      reset();
      break;
    case 'file':
      runFile(msg.samples).catch(fail);
      break;
  }
};
