import type { RoomMeta, RoomStatus, Segment } from './messages';

/** Everything about a room except its segments. Small enough to rewrite on every change. */
export interface RoomRecord {
  readonly code: string;
  readonly meta: RoomMeta;
  readonly status: RoomStatus;
  readonly speakerTokenHash: string;
  readonly correctorTokenHash: string;
  /** Present only for private rooms. */
  readonly listenerTokenHash?: string;
  /** Bumped on every new final and every correction. */
  readonly rev: number;
  readonly lastSeq: number;
  readonly lastActivity: number;
  /** Total characters of stored caption text (absent in rooms created before it existed). */
  readonly chars?: number;
}

/**
 * Storage port for one room. The Durable Object implements it on SQLite;
 * tests use the in-memory version below. All methods are synchronous so a
 * handler can make several writes with no await in between, which keeps them
 * atomic inside a Durable Object.
 */
export interface RoomStore {
  loadRoom(): RoomRecord | null;
  saveRoom(room: RoomRecord): void;
  insertSegment(seg: Segment): void;
  replaceSegment(seg: Segment): void;
  getSegment(seq: number): Segment | null;
  findSegmentById(id: string): Segment | null;
  /** Number of segments whose rev is greater than `rev`. */
  countChangedSince(rev: number): number;
  /** Segments whose rev is greater than `rev`, ascending by seq. */
  changedSince(rev: number): Segment[];
  /** The newest `limit` segments, ascending by seq. */
  latest(limit: number): Segment[];
  /** Up to `limit` segments with seq < `before`, ascending by seq. */
  before(before: number, limit: number): Segment[];
  /** Lowest stored seq, or null when empty. */
  firstSeq(): number | null;
  /** Optional: run `fn` as one atomic transaction (rolled back if it throws). */
  transaction?(fn: () => void): void;
}

export class MemoryRoomStore implements RoomStore {
  private room: RoomRecord | null = null;
  private segments: Segment[] = [];

  loadRoom(): RoomRecord | null {
    return this.room;
  }

  saveRoom(room: RoomRecord): void {
    this.room = room;
  }

  insertSegment(seg: Segment): void {
    if (this.segments.some((s) => s.seq === seg.seq || s.id === seg.id)) {
      throw new Error(`duplicate segment ${seg.seq}/${seg.id}`);
    }
    this.segments = [...this.segments, seg].sort((a, b) => a.seq - b.seq);
  }

  replaceSegment(seg: Segment): void {
    this.segments = this.segments.map((s) => (s.seq === seg.seq ? seg : s));
  }

  getSegment(seq: number): Segment | null {
    return this.segments.find((s) => s.seq === seq) ?? null;
  }

  findSegmentById(id: string): Segment | null {
    return this.segments.find((s) => s.id === id) ?? null;
  }

  countChangedSince(rev: number): number {
    return this.segments.filter((s) => s.rev > rev).length;
  }

  changedSince(rev: number): Segment[] {
    return this.segments.filter((s) => s.rev > rev);
  }

  latest(limit: number): Segment[] {
    return this.segments.slice(Math.max(0, this.segments.length - limit));
  }

  before(before: number, limit: number): Segment[] {
    const older = this.segments.filter((s) => s.seq < before);
    return older.slice(Math.max(0, older.length - limit));
  }

  firstSeq(): number | null {
    return this.segments[0]?.seq ?? null;
  }
}
