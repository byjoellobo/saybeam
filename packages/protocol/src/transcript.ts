/**
 * Transcript export: plain text, SubRip (.srt), WebVTT (.vtt) and JSON.
 *
 * Cue timing prefers the speaker-supplied startMs/endMs offsets. When those
 * are missing (Web Speech API engines do not report them) we estimate from the
 * server receive time, since a final arrives just after the words were spoken.
 */
import type { RoomMeta, Segment } from './messages';

export interface Cue {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Broadcast caption guidance: about 42 characters per line, 2 lines per cue. */
export const LINE_CHARS = 42;
export const CUE_CHARS = LINE_CHARS * 2;
const MS_PER_WORD = 400; // about 150 words per minute
const MIN_CUE_MS = 1000;

const visible = (segments: readonly Segment[]): Segment[] => segments.filter((s) => s.text.trim().length > 0);

// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
const CUE_CONTROL_RUN = /[\u0000-\u001f\u007f]+/g;

/** Text safe inside a subtitle cue: one line of plain text that cannot start a new cue. */
export function cueSafe(text: string): string {
  return text
    .replace(CUE_CONTROL_RUN, ' ')
    .replace(/-->/g, '->')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function estimateDurationMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(MIN_CUE_MS, words * MS_PER_WORD);
}

/** One timed cue per segment, monotonic and non-overlapping. */
export function segmentTimes(segments: readonly Segment[]): Cue[] {
  const segs = visible(segments);
  const first = segs[0];
  if (!first) return [];
  const t0 = first.ts - (first.startMs !== undefined && first.endMs !== undefined ? first.endMs - first.startMs : estimateDurationMs(first.text));
  let prevEnd = 0;
  return segs.map((s) => {
    const dur = s.startMs !== undefined && s.endMs !== undefined && s.endMs > s.startMs ? s.endMs - s.startMs : estimateDurationMs(s.text);
    const rawStart = s.startMs ?? Math.max(0, s.ts - t0 - dur);
    const start = Math.max(rawStart, prevEnd);
    const end = Math.max(s.endMs ?? rawStart + dur, start + 500);
    prevEnd = end;
    return { start, end, text: cueSafe(s.text) };
  });
}

/** Split text into chunks of at most `max` chars at word boundaries. */
export function chunkText(text: string, max: number = CUE_CHARS): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= max || !current) current = candidate;
    else {
      chunks.push(current);
      current = word;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Wrap a cue into at most two balanced lines. */
export function wrapLines(text: string, lineChars: number = LINE_CHARS): string {
  if (text.length <= lineChars) return text;
  const words = text.split(' ');
  let best = text;
  let bestScore = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const score = Math.max(a.length, b.length);
    if (score < bestScore) {
      bestScore = score;
      best = `${a}\n${b}`;
    }
  }
  return best;
}

/** Cues sized for reading: long segments are split with time shared by length. */
export function toCues(segments: readonly Segment[]): Cue[] {
  return segmentTimes(segments).flatMap((cue) => {
    const chunks = chunkText(cue.text);
    if (chunks.length <= 1) return [{ ...cue, text: wrapLines(chunks[0] ?? '') }];
    const total = chunks.reduce((n, c) => n + c.length, 0);
    let cursor = cue.start;
    return chunks.map((chunk, i) => {
      const share = Math.round(((cue.end - cue.start) * chunk.length) / total);
      const end = i === chunks.length - 1 ? cue.end : cursor + share;
      const out = { start: cursor, end, text: wrapLines(chunk) };
      cursor = end;
      return out;
    });
  });
}

export function formatTimestamp(ms: number, separator: ',' | '.'): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const milli = total % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(milli, 3)}`;
}

export function toSrt(segments: readonly Segment[]): string {
  return toCues(segments)
    .map((c, i) => `${i + 1}\n${formatTimestamp(c.start, ',')} --> ${formatTimestamp(c.end, ',')}\n${c.text}\n`)
    .join('\n');
}

export function toVtt(segments: readonly Segment[], meta?: Pick<RoomMeta, 'title'>): string {
  const header = meta?.title ? `WEBVTT - ${cueSafe(meta.title).replace(/->/g, '')}` : 'WEBVTT';
  const body = toCues(segments)
    .map((c) => `${formatTimestamp(c.start, '.')} --> ${formatTimestamp(c.end, '.')}\n${c.text}\n`)
    .join('\n');
  return `${header}\n\n${body}`;
}

export interface PlainTextOptions {
  /** Prefix paragraphs with [hh:mm:ss] offsets. */
  readonly timestamps?: boolean;
  /** Start a new paragraph after a pause this long, ms. */
  readonly paragraphGapMs?: number;
}

export function toPlainText(segments: readonly Segment[], opts: PlainTextOptions = {}): string {
  const gap = opts.paragraphGapMs ?? 4000;
  const cues = segmentTimes(segments);
  const paragraphs: { start: number; text: string }[] = [];
  let prevEnd = -Infinity;
  for (const cue of cues) {
    const last = paragraphs[paragraphs.length - 1];
    if (last && cue.start - prevEnd < gap) last.text = `${last.text} ${cue.text}`;
    else paragraphs.push({ start: cue.start, text: cue.text });
    prevEnd = cue.end;
  }
  return paragraphs.map((p) => (opts.timestamps ? `[${formatTimestamp(p.start, '.').slice(0, 8)}] ${p.text}` : p.text)).join('\n\n') + (paragraphs.length ? '\n' : '');
}

export function toJson(meta: RoomMeta | null, segments: readonly Segment[], room?: string): string {
  return JSON.stringify(
    {
      format: 'saybeam-transcript',
      version: 1,
      room: room ?? null,
      title: meta?.title ?? '',
      lang: meta?.lang ?? '',
      createdAt: meta ? new Date(meta.createdAt).toISOString() : null,
      exportedAt: new Date().toISOString(),
      segments: visible(segments).map((s) => ({
        seq: s.seq,
        text: s.text,
        at: new Date(s.ts).toISOString(),
        startMs: s.startMs ?? null,
        endMs: s.endMs ?? null,
        edited: Boolean(s.edited),
      })),
    },
    null,
    2,
  );
}

export type ExportFormat = 'txt' | 'srt' | 'vtt' | 'json';

export function exportTranscript(format: ExportFormat, segments: readonly Segment[], meta: RoomMeta | null, room?: string): { body: string; mime: string; ext: string } {
  switch (format) {
    case 'txt':
      return { body: toPlainText(segments, { timestamps: true }), mime: 'text/plain;charset=utf-8', ext: 'txt' };
    case 'srt':
      return { body: toSrt(segments), mime: 'application/x-subrip;charset=utf-8', ext: 'srt' };
    case 'vtt':
      return { body: toVtt(segments, meta ?? undefined), mime: 'text/vtt;charset=utf-8', ext: 'vtt' };
    case 'json':
      return { body: toJson(meta, segments, room), mime: 'application/json', ext: 'json' };
  }
}
