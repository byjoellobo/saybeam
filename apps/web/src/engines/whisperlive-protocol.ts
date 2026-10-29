/**
 * Pure helpers for collabora/WhisperLive's WebSocket protocol (v0.10).
 *
 * The server sends a sliding window: the last N completed segments plus at
 * most one trailing in-progress segment (`completed: false`). We turn that into
 * Caption Room partials and finals, never emitting the same final twice.
 */
export interface WhisperLiveConfigInput {
  readonly uid: string;
  readonly language: string | null;
  readonly model: string;
  readonly useVad?: boolean;
  readonly task?: 'transcribe' | 'translate';
  readonly initialPrompt?: string;
  readonly hotwords?: string;
}

export function buildConfig(input: WhisperLiveConfigInput): Record<string, unknown> {
  return {
    uid: input.uid,
    language: input.language,
    task: input.task ?? 'transcribe',
    model: input.model,
    use_vad: input.useVad ?? true,
    send_last_n_segments: 10,
    no_speech_thresh: 0.45,
    clip_audio: false,
    same_output_threshold: 10,
    ...(input.initialPrompt ? { initial_prompt: input.initialPrompt } : {}),
    ...(input.hotwords ? { hotwords: input.hotwords } : {}),
  };
}

export interface WlSegment {
  readonly start?: string | number;
  readonly end?: string | number;
  readonly text?: string;
  readonly completed?: boolean;
}

export type WlServerEvent =
  | { readonly kind: 'ready'; readonly backend: string }
  | { readonly kind: 'wait'; readonly minutes: number }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'warning'; readonly message: string }
  | { readonly kind: 'disconnect' }
  | { readonly kind: 'language'; readonly language: string; readonly probability: number }
  | { readonly kind: 'segments'; readonly segments: readonly WlSegment[] }
  | { readonly kind: 'unknown' };

export function parseServerMessage(raw: string, uid: string): WlServerEvent {
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { kind: 'unknown' };
    data = parsed as Record<string, unknown>;
  } catch {
    return { kind: 'unknown' };
  }
  if (data.uid !== undefined && data.uid !== uid) return { kind: 'unknown' };
  if (data.message === 'SERVER_READY') return { kind: 'ready', backend: String(data.backend ?? 'unknown') };
  if (data.message === 'DISCONNECT') return { kind: 'disconnect' };
  if (data.status === 'WAIT') return { kind: 'wait', minutes: Number(data.message) || 1 };
  if (data.status === 'ERROR') return { kind: 'error', message: String(data.message ?? 'Server error') };
  if (data.status === 'WARNING') return { kind: 'warning', message: String(data.message ?? '') };
  if (typeof data.language === 'string' && data.segments === undefined) {
    return { kind: 'language', language: data.language, probability: Number(data.language_prob) || 0 };
  }
  if (Array.isArray(data.segments)) return { kind: 'segments', segments: data.segments as WlSegment[] };
  return { kind: 'unknown' };
}

export interface MergeState {
  /** End time (s) of the last committed segment, in this connection's timeline. */
  readonly committedEnd: number;
  /** Recently committed segment keys, for dedupe. */
  readonly seen: readonly string[];
}

export const EMPTY_MERGE: MergeState = { committedEnd: -1, seen: [] };

export interface MergedFinal {
  readonly text: string;
  readonly startS: number | null;
  readonly endS: number | null;
}

export interface MergeResult {
  readonly state: MergeState;
  readonly finals: readonly MergedFinal[];
  /** Current in-progress text, or null when nothing is in progress. */
  readonly partial: string | null;
}

const SEEN_LIMIT = 64;

const num = (v: string | number | undefined): number | null => {
  if (v === undefined) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

export function mergeSegments(state: MergeState, segments: readonly WlSegment[]): MergeResult {
  let committedEnd = state.committedEnd;
  let seen = state.seen;
  const finals: MergedFinal[] = [];
  let partial: string | null = null;

  segments.forEach((seg, i) => {
    // The server is user-supplied: tolerate malformed entries rather than throwing.
    if (!seg || typeof seg !== 'object') return;
    const text = typeof seg.text === 'string' ? seg.text.trim() : '';
    const isLast = i === segments.length - 1;
    // TensorRT backends omit `completed`: treat everything but the last as done.
    const completed = seg.completed ?? !isLast;
    if (!completed) {
      if (isLast && text) partial = text;
      return;
    }
    if (!text) return;
    const startS = num(seg.start);
    const endS = num(seg.end);
    const key = `${startS ?? ''}|${endS ?? ''}|${text}`;
    if (seen.includes(key)) return;
    if (startS !== null && startS < committedEnd - 0.05) return;
    finals.push({ text, startS, endS });
    seen = [...seen, key].slice(-SEEN_LIMIT);
    if (endS !== null) committedEnd = Math.max(committedEnd, endS);
  });

  return { state: { committedEnd, seen }, finals, partial };
}

/** Browsers refuse ws:// from an https page unless the host is loopback. */
export function isMixedContentBlocked(serverUrl: string, pageProtocol: string): boolean {
  try {
    const url = new URL(serverUrl);
    if (pageProtocol !== 'https:' || url.protocol !== 'ws:') return false;
    return !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/** Float32 PCM bytes for the server (it reads little-endian float32). */
export function toWirePcm(samples: Float32Array): ArrayBuffer {
  const out = new Float32Array(samples.length);
  out.set(samples);
  return out.buffer;
}

export const END_OF_AUDIO = new TextEncoder().encode('END_OF_AUDIO');
