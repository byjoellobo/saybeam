/**
 * Microphone capture through an AudioWorklet at the device's native rate.
 * Echo cancellation, noise suppression and auto gain are on: in halls and
 * classrooms the mic is often far from the speaker.
 */
import { TARGET_RATE } from './resample';

export interface CaptureHandle {
  readonly sampleRate: number;
  stop(): Promise<void>;
}

export interface CaptureOptions {
  readonly deviceId?: string;
}

export async function startCapture(onChunk: (samples: Float32Array, sampleRate: number) => void, opts: CaptureOptions = {}): Promise<CaptureHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser cannot use the microphone here. Use HTTPS, or open the page on localhost.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  try {
    await ctx.audioWorklet.addModule('/audio/capture-worklet.js');
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'caption-room-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    node.port.onmessage = (e: MessageEvent<Float32Array>) => onChunk(e.data, ctx.sampleRate);
    source.connect(node);
    if (ctx.state === 'suspended') await ctx.resume();
    return {
      sampleRate: ctx.sampleRate,
      async stop() {
        node.port.onmessage = null;
        source.disconnect();
        node.disconnect();
        for (const t of stream.getTracks()) t.stop();
        await ctx.close().catch(() => undefined);
      },
    };
  } catch (err) {
    for (const t of stream.getTracks()) t.stop();
    await ctx.close().catch(() => undefined);
    throw err;
  }
}

export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}

/** Decode any browser-supported audio file to 16 kHz mono (for the bench). */
export async function decodeToMono16k(file: Blob): Promise<Float32Array> {
  const bytes = await file.arrayBuffer();
  const probe = new AudioContext();
  try {
    const decoded = await probe.decodeAudioData(bytes);
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * TARGET_RATE), TARGET_RATE);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0).slice();
  } finally {
    await probe.close().catch(() => undefined);
  }
}

/** Encode 16 kHz mono float samples as a WAV blob (so bench recordings can be saved and re-run). */
export function encodeWav(samples: Float32Array, sampleRate = TARGET_RATE): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i] ?? 0)) * 0x7fff, true);
  return new Blob([buffer], { type: 'audio/wav' });
}
