/**
 * Pure, immutable reducer for what a client knows about a room.
 * Speaker, listener and corrector views all fold server messages through it.
 */
import type { ErrorCode, PartialCaption, Presence, Role, RoomMeta, RoomStatus, Segment, ServerMsg } from './messages';

export interface RoomView {
  readonly room: string | null;
  readonly role: Role | null;
  readonly meta: RoomMeta | null;
  readonly status: RoomStatus;
  /** Ascending by seq, no duplicates. */
  readonly segments: readonly Segment[];
  readonly partial: PartialCaption | null;
  /** Older segments exist on the server that are not in `segments`. */
  readonly hasMore: boolean;
  /** Highest room revision applied. Sent as `since` when reconnecting. */
  readonly rev: number;
  readonly presence: Presence;
  /** serverTime minus local time at the last welcome or pong, ms. */
  readonly clockOffset: number;
  readonly lastError: { readonly code: ErrorCode; readonly message: string } | null;
}

export const EMPTY_VIEW: RoomView = {
  room: null,
  role: null,
  meta: null,
  status: 'live',
  segments: [],
  partial: null,
  hasMore: false,
  rev: 0,
  presence: { listeners: 0, correctors: 0, speaker: false },
  clockOffset: 0,
  lastError: null,
};

export interface ApplyOptions {
  /** Local clock, ms. */
  readonly now?: number;
  /** Keep at most this many segments in memory (oldest dropped, hasMore set). */
  readonly maxSegments?: number;
}

export function applyServerMsg(view: RoomView, msg: ServerMsg, opts: ApplyOptions = {}): RoomView {
  const now = opts.now ?? Date.now();
  switch (msg.t) {
    case 'welcome': {
      const fresh = msg.mode === 'replace' || view.room !== msg.room;
      const base = fresh ? [] : view.segments;
      // A resume delta can include corrections to segments older than anything we
      // hold. Merging those would leave a gap that "load earlier" could never fill,
      // so only patch segments we have or that are newer than our oldest.
      const oldest = base[0]?.seq;
      const held = new Set(base.map((s) => s.seq));
      const incoming = fresh || oldest === undefined ? msg.segments : msg.segments.filter((s) => s.seq >= oldest || held.has(s.seq));
      const merged = upsertMany(base, incoming);
      const hasMore = msg.mode === 'replace' || view.room !== msg.room ? msg.hasMore : view.hasMore;
      return cap(
        {
          ...view,
          room: msg.room,
          role: msg.role,
          meta: msg.meta,
          status: msg.status,
          segments: merged,
          partial: msg.partial,
          hasMore,
          rev: msg.rev,
          presence: msg.presence,
          clockOffset: msg.serverTime - now,
          lastError: null,
        },
        opts.maxSegments,
      );
    }
    case 'partial':
      return { ...view, partial: msg.text ? { id: msg.id, text: msg.text } : view.partial?.id === msg.id ? null : view.partial };
    case 'final':
      return cap(
        {
          ...view,
          segments: upsertMany(view.segments, [msg.seg]),
          partial: view.partial?.id === msg.seg.id ? null : view.partial,
          rev: Math.max(view.rev, msg.seg.rev),
        },
        opts.maxSegments,
      );
    case 'correct':
      return {
        ...view,
        segments: view.segments.map((s) => (s.seq === msg.seq ? { ...s, text: msg.text, rev: msg.rev, edited: true } : s)),
        rev: Math.max(view.rev, msg.rev),
      };
    case 'meta':
      return { ...view, meta: msg.meta };
    case 'status':
      return { ...view, status: msg.status, partial: msg.status === 'live' ? view.partial : null };
    case 'history':
      return {
        ...view,
        segments: upsertMany(view.segments, msg.segments),
        hasMore: msg.hasMore,
      };
    case 'presence':
      return { ...view, presence: msg.presence, partial: msg.presence.speaker ? view.partial : null };
    case 'error':
      return { ...view, lastError: { code: msg.code, message: msg.message } };
    case 'pong':
      return { ...view, clockOffset: msg.serverTime - now };
    case 'rotated':
      // The new secret is the speaker's business (see RoomClient), not room state.
      return view;
  }
}

/** Merge segments by seq, keeping ascending order. Fast path for appends. */
export function upsertMany(existing: readonly Segment[], incoming: readonly Segment[]): readonly Segment[] {
  if (incoming.length === 0) return existing;
  const last = existing[existing.length - 1];
  const sortedIncoming = [...incoming].sort((a, b) => a.seq - b.seq);
  const firstIncoming = sortedIncoming[0];
  if (!last || (firstIncoming && firstIncoming.seq > last.seq)) return [...existing, ...dedupe(sortedIncoming)];

  const bySeq = new Map<number, Segment>();
  for (const s of existing) bySeq.set(s.seq, s);
  for (const s of sortedIncoming) {
    const prev = bySeq.get(s.seq);
    if (!prev || s.rev >= prev.rev) bySeq.set(s.seq, s);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function dedupe(sorted: readonly Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.seq === s.seq) out[out.length - 1] = s.rev >= prev.rev ? s : prev;
    else out.push(s);
  }
  return out;
}

function cap(view: RoomView, max: number | undefined): RoomView {
  if (!max || view.segments.length <= max) return view;
  return { ...view, segments: view.segments.slice(view.segments.length - max), hasMore: true };
}

/** Segments a reader should see (corrector-removed segments are hidden). */
export function visibleSegments(segments: readonly Segment[]): readonly Segment[] {
  return segments.filter((s) => s.text.length > 0);
}
