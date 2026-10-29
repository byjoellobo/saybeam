import { LocalEngine } from './local-engine';
import { WebSpeechEngine } from './web-speech-engine';
import { WhisperLiveEngine } from './whisperlive-engine';
import type { CaptionEngine, EngineCallbacks, EngineConfig } from './types';

export interface EngineEnvironment {
  /** Running behind the LAN relay with models in its /models/ folder. */
  readonly localModels: boolean;
}

export function createEngine(cfg: EngineConfig, cb: EngineCallbacks, envInfo: EngineEnvironment): CaptionEngine {
  switch (cfg.kind) {
    case 'local':
      return new LocalEngine(cfg, cb, { localModels: envInfo.localModels });
    case 'webspeech':
      return new WebSpeechEngine(cfg, cb);
    case 'whisperlive':
      return new WhisperLiveEngine(cfg, cb);
  }
}

export function describeEngine(cfg: EngineConfig): string {
  switch (cfg.kind) {
    case 'local':
      return `${cfg.modelId} on this device`;
    case 'webspeech':
      return `Browser speech (${cfg.lang}${cfg.onDevice ? ', on-device' : ''})`;
    case 'whisperlive':
      return `WhisperLive ${cfg.model} at ${cfg.url}`;
  }
}

export type { CaptionEngine, EngineCallbacks, EngineConfig } from './types';
