export type EngineKind = 'local' | 'webspeech' | 'whisperlive';

export type EnginePhase = 'idle' | 'loading' | 'ready' | 'listening' | 'error' | 'stopped';

export interface EngineStatus {
  readonly phase: EnginePhase;
  readonly message?: string;
  /** 0..1 while downloading models. */
  readonly progress?: number;
}

export interface EngineStats {
  /** e.g. "webgpu", "wasm (4 threads)", "Chrome cloud", "WhisperLive faster_whisper". */
  readonly backend?: string;
  /** Real-time factor of final transcriptions: compute time / audio time. Under 1 keeps up. */
  readonly rtf?: number;
  readonly lastAsrMs?: number;
  /** How far finals trail behind the end of speech, ms. */
  readonly lagMs?: number;
  readonly queue?: number;
  /** Current interval between partial updates, ms; 0 when partials are paused to keep up. */
  readonly partialEveryMs?: number;
  readonly finals?: number;
  readonly loadMs?: number;
}

export interface FinalTiming {
  /** ms since the engine started. */
  readonly startMs?: number;
  readonly endMs?: number;
}

export interface EngineCallbacks {
  onPartial(key: string, text: string): void;
  onFinal(key: string, text: string, timing: FinalTiming): void;
  onStatus(status: EngineStatus): void;
  onStats(stats: EngineStats): void;
  /** Mic level 0..1 for the meter. */
  onLevel(level: number): void;
  /** The engine's timeline (FinalTiming offsets) starts now. Called on every start. */
  onClockStart(): void;
}

export interface CaptionEngine {
  readonly kind: EngineKind;
  /** Load (if needed) and begin listening. */
  start(): Promise<void>;
  /** Stop listening and flush the utterance in progress. Keeps loaded models. */
  stop(): Promise<void>;
  /** Release everything (workers, models, sockets). */
  dispose(): void;
}

export type DevicePreference = 'auto' | 'webgpu' | 'wasm';

export interface LocalEngineConfig {
  readonly kind: 'local';
  readonly modelId: string;
  readonly device: DevicePreference;
  /** Whisper language code ("en", "hi") or null for auto-detect. Ignored by English-only models. */
  readonly language: string | null;
  readonly partials: boolean;
  readonly micId?: string;
}

export interface WebSpeechEngineConfig {
  readonly kind: 'webspeech';
  readonly lang: string;
  /** Chrome 139+ desktop: recognise on this device, works offline once the language pack is installed. */
  readonly onDevice: boolean;
  /** Contextual biasing phrases (on-device only, Chrome 142+). */
  readonly phrases: readonly string[];
}

export interface WhisperLiveEngineConfig {
  readonly kind: 'whisperlive';
  readonly url: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly language: string | null;
  readonly hotwords?: string;
  readonly micId?: string;
}

export type EngineConfig = LocalEngineConfig | WebSpeechEngineConfig | WhisperLiveEngineConfig;
