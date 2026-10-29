/**
 * What can this speaker device do, and which engine should we suggest?
 */
import { webSpeechSupport } from './web-speech-engine';
import type { EngineConfig } from './types';

export interface Capabilities {
  readonly webgpu: boolean;
  readonly gpuName: string | null;
  readonly crossOriginIsolated: boolean;
  readonly cores: number;
  readonly memoryGb: number | null;
  readonly webSpeech: boolean;
  readonly webSpeechOnDevice: boolean;
  readonly webSpeechPhrases: boolean;
  readonly mobile: boolean;
  readonly iosStandalone: boolean;
  readonly secureContext: boolean;
  readonly userAgent: string;
}

interface GpuAdapterLike {
  readonly info?: { readonly vendor?: string; readonly architecture?: string; readonly description?: string };
}

export async function detectCapabilities(): Promise<Capabilities> {
  const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<GpuAdapterLike | null> }; deviceMemory?: number; standalone?: boolean; userAgentData?: { mobile?: boolean } };
  let webgpu = false;
  let gpuName: string | null = null;
  if (nav.gpu) {
    try {
      const adapter = await nav.gpu.requestAdapter();
      webgpu = Boolean(adapter);
      const info = adapter?.info;
      gpuName = info ? [info.vendor, info.architecture || info.description].filter(Boolean).join(' ') || null : null;
    } catch {
      webgpu = false;
    }
  }
  const speech = webSpeechSupport();
  const ua = navigator.userAgent;
  const mobile = nav.userAgentData?.mobile ?? /Android|iPhone|iPad|Mobile/i.test(ua);
  return {
    webgpu,
    gpuName,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    cores: navigator.hardwareConcurrency || 2,
    memoryGb: nav.deviceMemory ?? null,
    webSpeech: speech.available,
    webSpeechOnDevice: speech.onDeviceApi && !mobile,
    webSpeechPhrases: speech.phrasesApi && !mobile,
    mobile,
    iosStandalone: nav.standalone === true,
    secureContext: globalThis.isSecureContext === true,
    userAgent: ua,
  };
}

export interface Recommendation {
  readonly config: EngineConfig;
  readonly reason: string;
}

/** Whisper language code from a BCP-47 tag ("hi-IN" -> "hi"). */
export function whisperLanguage(lang: string): string {
  return lang.split('-')[0]?.toLowerCase() || 'en';
}

export function isEnglish(lang: string): boolean {
  return whisperLanguage(lang) === 'en';
}

export function recommendEngine(caps: Capabilities, lang: string): Recommendation {
  const english = isEnglish(lang);
  const weakDevice = caps.cores < 4 || (caps.memoryGb !== null && caps.memoryGb < 4);

  if (!english) {
    if (caps.webgpu && !weakDevice) {
      return { config: { kind: 'local', modelId: 'whisper-base', device: 'webgpu', language: whisperLanguage(lang), partials: true }, reason: 'Moonshine is English-only, so this uses multilingual Whisper on your GPU. Audio stays on this device.' };
    }
    if (caps.webSpeech) {
      return { config: { kind: 'webspeech', lang, onDevice: false, phrases: [] }, reason: 'Your browser\'s speech service handles this language well on modest hardware. It needs internet and sends audio to the browser vendor.' };
    }
    return { config: { kind: 'local', modelId: 'whisper-base', device: 'auto', language: whisperLanguage(lang), partials: false }, reason: 'Multilingual Whisper on this device. It may be slow here, so live partial captions are off.' };
  }

  if (caps.iosStandalone && !caps.webgpu) {
    return { config: { kind: 'local', modelId: 'moonshine-tiny', device: 'wasm', language: null, partials: false }, reason: 'iPhone home-screen apps cannot use Safari speech recognition, so this uses a small on-device model.' };
  }
  if (caps.webgpu && !weakDevice) {
    return { config: { kind: 'local', modelId: 'moonshine-base', device: 'webgpu', language: null, partials: true }, reason: 'Your GPU can run Moonshine Base quickly. Audio never leaves this device, and it works offline once downloaded.' };
  }
  if (!weakDevice) {
    return { config: { kind: 'local', modelId: 'moonshine-tiny', device: 'wasm', language: null, partials: true }, reason: 'Moonshine Tiny runs well on this CPU. Audio never leaves this device.' };
  }
  if (caps.webSpeech) {
    return { config: { kind: 'webspeech', lang, onDevice: false, phrases: [] }, reason: 'This device is light on CPU or memory, so the browser\'s speech service is the most responsive choice. It needs internet.' };
  }
  return { config: { kind: 'local', modelId: 'moonshine-tiny', device: 'wasm', language: null, partials: false }, reason: 'Moonshine Tiny with live partials off, to keep up on this device.' };
}
