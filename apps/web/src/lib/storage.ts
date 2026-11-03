/**
 * Local persistence: room secrets this browser created, and display and
 * speaker preferences. Everything is validated on read, because storage can
 * hold anything (older versions, manual edits, extensions).
 */
import type { EngineConfig } from '../engines/types';

const ROOMS_KEY = 'saybeam:rooms';
const LISTENER_KEY = 'saybeam:listener-prefs';
const SPEAKER_KEY = 'saybeam:speaker-prefs';

export interface SavedRoom {
  readonly code: string;
  readonly speakerToken: string;
  readonly correctorToken: string;
  /** Present only for private rooms: the audience QR link carries it. */
  readonly listenerToken?: string;
  readonly title: string;
  readonly createdAt: number;
}

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or full storage: preferences just will not persist.
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isSavedRoom(v: unknown): v is SavedRoom {
  return isObj(v) && typeof v.code === 'string' && typeof v.speakerToken === 'string' && typeof v.correctorToken === 'string';
}

export function listSavedRooms(): SavedRoom[] {
  const data = read(ROOMS_KEY);
  return Array.isArray(data) ? data.filter(isSavedRoom).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)) : [];
}

export function getSavedRoom(code: string): SavedRoom | null {
  return listSavedRooms().find((r) => r.code === code) ?? null;
}

export function saveRoom(room: SavedRoom): void {
  write(ROOMS_KEY, [room, ...listSavedRooms().filter((r) => r.code !== room.code)].slice(0, 20));
}

export function forgetRoom(code: string): void {
  write(
    ROOMS_KEY,
    listSavedRooms().filter((r) => r.code !== code),
  );
  try {
    localStorage.removeItem(`saybeam:outbox:${code}`); // unsent captions for that room
  } catch {
    // ignore
  }
}

/* ------------------------------ listener display ------------------------------ */

export type Theme = 'dark' | 'light' | 'yellow' | 'cream' | 'inverse';
export type FontChoice = 'hyperlegible' | 'system' | 'serif' | 'mono';
export type Layout = 'scroll' | 'stage';

export interface ListenerPrefs {
  readonly theme: Theme;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly font: FontChoice;
  readonly bold: boolean;
  readonly uppercase: boolean;
  readonly letterSpacing: number;
  readonly layout: Layout;
  readonly align: 'left' | 'center';
  readonly showPartial: boolean;
  readonly announce: boolean;
  readonly keepAwake: boolean;
  readonly showTimes: boolean;
}

export const DEFAULT_LISTENER_PREFS: ListenerPrefs = {
  theme: 'dark',
  fontSize: 34,
  lineHeight: 1.45,
  font: 'hyperlegible',
  bold: false,
  uppercase: false,
  letterSpacing: 0,
  layout: 'scroll',
  align: 'left',
  showPartial: true,
  announce: false,
  keepAwake: true,
  showTimes: false,
};

const clamp = (n: unknown, lo: number, hi: number, fallback: number): number => (typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback);
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

export function sanitizeListenerPrefs(v: unknown): ListenerPrefs {
  const d = DEFAULT_LISTENER_PREFS;
  if (!isObj(v)) return d;
  return {
    theme: oneOf(v.theme, ['dark', 'light', 'yellow', 'cream', 'inverse'] as const, d.theme),
    fontSize: clamp(v.fontSize, 16, 140, d.fontSize),
    lineHeight: clamp(v.lineHeight, 1.1, 2.2, d.lineHeight),
    font: oneOf(v.font, ['hyperlegible', 'system', 'serif', 'mono'] as const, d.font),
    bold: bool(v.bold, d.bold),
    uppercase: bool(v.uppercase, d.uppercase),
    letterSpacing: clamp(v.letterSpacing, 0, 0.2, d.letterSpacing),
    layout: oneOf(v.layout, ['scroll', 'stage'] as const, d.layout),
    align: oneOf(v.align, ['left', 'center'] as const, d.align),
    showPartial: bool(v.showPartial, d.showPartial),
    announce: bool(v.announce, d.announce),
    keepAwake: bool(v.keepAwake, d.keepAwake),
    showTimes: bool(v.showTimes, d.showTimes),
  };
}

export function loadListenerPrefs(): ListenerPrefs {
  return sanitizeListenerPrefs(read(LISTENER_KEY));
}

export function saveListenerPrefs(prefs: ListenerPrefs): void {
  write(LISTENER_KEY, prefs);
}

/* -------------------------------- speaker setup -------------------------------- */

export interface SpeakerPrefs {
  readonly engine: EngineConfig | null;
  readonly replacements: string;
  /** Names and jargon: used as Chrome on-device phrases and WhisperLive hotwords. */
  readonly vocabulary: string;
  readonly whisperLiveUrl: string;
  readonly whisperLiveModel: string;
}

export const DEFAULT_SPEAKER_PREFS: SpeakerPrefs = {
  engine: null,
  replacements: '',
  vocabulary: '',
  whisperLiveUrl: 'ws://localhost:9090',
  whisperLiveModel: 'small',
};

function sanitizeEngine(v: unknown): EngineConfig | null {
  if (!isObj(v)) return null;
  if (v.kind === 'local' && typeof v.modelId === 'string') {
    return {
      kind: 'local',
      modelId: v.modelId,
      device: oneOf(v.device, ['auto', 'webgpu', 'wasm'] as const, 'auto'),
      language: typeof v.language === 'string' ? v.language : null,
      partials: bool(v.partials, true),
      ...(typeof v.micId === 'string' ? { micId: v.micId } : {}),
    };
  }
  if (v.kind === 'webspeech' && typeof v.lang === 'string') {
    return {
      kind: 'webspeech',
      lang: v.lang,
      onDevice: bool(v.onDevice, false),
      phrases: Array.isArray(v.phrases) ? v.phrases.filter((p): p is string => typeof p === 'string') : [],
    };
  }
  if (v.kind === 'whisperlive' && typeof v.url === 'string' && typeof v.model === 'string') {
    return {
      kind: 'whisperlive',
      url: v.url,
      model: v.model,
      language: typeof v.language === 'string' ? v.language : null,
      ...(typeof v.micId === 'string' ? { micId: v.micId } : {}),
    };
  }
  return null;
}

export function loadSpeakerPrefs(): SpeakerPrefs {
  const v = read(SPEAKER_KEY);
  const d = DEFAULT_SPEAKER_PREFS;
  if (!isObj(v)) return d;
  return {
    engine: sanitizeEngine(v.engine),
    replacements: typeof v.replacements === 'string' ? v.replacements.slice(0, 20_000) : d.replacements,
    vocabulary: typeof v.vocabulary === 'string' ? v.vocabulary.slice(0, 10_000) : d.vocabulary,
    whisperLiveUrl: typeof v.whisperLiveUrl === 'string' ? v.whisperLiveUrl : d.whisperLiveUrl,
    whisperLiveModel: typeof v.whisperLiveModel === 'string' ? v.whisperLiveModel : d.whisperLiveModel,
  };
}

export function saveSpeakerPrefs(prefs: SpeakerPrefs): void {
  // Never persist WhisperLive API keys.
  const engine = prefs.engine?.kind === 'whisperlive' ? { ...prefs.engine, apiKey: undefined } : prefs.engine;
  write(SPEAKER_KEY, { ...prefs, engine });
}

/** Vocabulary textarea -> list of phrases. */
export function vocabularyList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].slice(0, 200);
}
