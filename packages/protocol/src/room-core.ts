/**
 * Transport-agnostic room logic.
 *
 * The host (Durable Object, or a test) owns the sockets. It hands every
 * inbound frame to `handleFrame` and executes the returned Outcome: send
 * messages to targets, update the connection's stored state, close sockets.
 * The Rust relay mirrors these rules; docs/protocol.md is the shared spec.
 */
import {
  CLOSE,
  LIMITS,
  PROTOCOL_VERSION,
  type ClientMsg,
  type CorrectMsg,
  type ErrorCode,
  type FinalMsg,
  type HelloMsg,
  type HistoryMsg,
  type MetaMsg,
  type PartialCaption,
  type PartialMsg,
  type Presence,
  type Role,
  type RoomMeta,
  type Segment,
  type ServerMsg,
  type StatusMsg,
} from './messages';
import { hashToken, timingSafeEqual } from './codes';
import { parseClientFrame } from './schema';
import type { RoomRecord, RoomStore } from './store';

export interface ConnState {
  readonly id: string;
  /** null until the client has sent a valid hello. */
  readonly role: Role | null;
}

/** `others` means every connection except the sender. */
export type Target = 'self' | 'all' | 'others';

export interface Outbound {
  readonly to: Target;
  readonly msg: ServerMsg;
}

export interface Outcome {
  readonly send: readonly Outbound[];
  /** New state for the sending connection, when it changed. */
  readonly conn?: ConnState;
  readonly close?: { readonly code: number; readonly reason: string };
  /** Host must close every other speaker connection: the newest speaker wins. */
  readonly replaceOtherSpeakers?: boolean;
  /** Host should broadcast fresh presence counts (debounced). */
  readonly presenceChanged?: boolean;
  /** Room content changed; host may push back its expiry. */
  readonly activity?: boolean;
}

export interface InitRoomInput {
  readonly code: string;
  readonly speakerTokenHash: string;
  readonly correctorTokenHash: string;
  readonly title?: string;
  readonly lang?: string;
  readonly allowExport?: boolean;
}

interface Bucket {
  tokens: number;
  last: number;
}

const BUCKETS: Record<Role | 'pending', { capacity: number; perSecond: number }> = {
  speaker: { capacity: 60, perSecond: 30 },
  corrector: { capacity: 30, perSecond: 10 },
  listener: { capacity: 20, perSecond: 4 },
  pending: { capacity: 5, perSecond: 1 },
};

const STAFF_WELCOME_HISTORY = 2000;

const NONE: Outcome = { send: [] };

/** Presence of the other connections, or a function computing it (only needed for hello). */
export type PresenceSource = Presence | (() => Presence);

/**
 * Captions are plain text. Strip control characters (they could forge extra
 * cues in exported SRT/VTT files) and bidi overrides (they can spoof titles).
 */
export function cleanText(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[‪-‮⁦-⁩]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

export class RoomCore {
  private partial: PartialCaption | null = null;
  private lastPartialAt = 0;
  private cached: RoomRecord | null = null;
  private readonly buckets = new Map<string, Bucket>();
  private readonly strikes = new Map<string, number>();

  constructor(
    private readonly store: RoomStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Create the room record. Returns false when the room already exists. */
  initialize(input: InitRoomInput): boolean {
    if (this.room()) return false;
    const t = this.now();
    const meta: RoomMeta = {
      title: cleanText(input.title ?? '').slice(0, LIMITS.maxTitleChars),
      lang: input.lang ?? 'en-US',
      allowExport: input.allowExport ?? true,
      createdAt: t,
    };
    this.save({
      code: input.code,
      meta,
      status: 'live',
      speakerTokenHash: input.speakerTokenHash,
      correctorTokenHash: input.correctorTokenHash,
      rev: 0,
      lastSeq: 0,
      lastActivity: t,
    });
    return true;
  }

  exists(): boolean {
    return this.room() !== null;
  }

  lastActivity(): number | null {
    return this.room()?.lastActivity ?? null;
  }

  createdAt(): number | null {
    return this.room()?.meta.createdAt ?? null;
  }

  /**
   * Handle one raw frame from a connection.
   * @param others presence counted over every connection except this one.
   */
  async handleFrame(conn: ConnState, raw: string | ArrayBuffer, others: PresenceSource): Promise<Outcome> {
    if (typeof raw === 'string' && raw.length > LIMITS.maxFrameBytes) {
      return { send: [{ to: 'self', msg: error('bad-frame', 'frame too large') }], close: { code: CLOSE.badFrame, reason: 'frame too large' } };
    }
    if (!this.charge(conn, 1)) return this.strike(conn, error('rate-limited', 'Slow down: too many messages.'));
    const parsed = parseClientFrame(raw);
    if (!parsed.ok) return this.strike(conn, error('bad-frame', parsed.error));
    // A history page can be large, so it costs more than an ordinary frame.
    if (parsed.value.t === 'history' && !this.charge(conn, LIMITS.historyCost - 1)) {
      return this.strike(conn, error('rate-limited', 'Slow down: too many history requests.'));
    }
    return this.handle(conn, parsed.value, others);
  }

  async handle(conn: ConnState, msg: ClientMsg, others: PresenceSource): Promise<Outcome> {
    if (msg.t === 'hello') return this.hello(conn, msg, typeof others === 'function' ? others() : others);
    if (conn.role === null) return reply(error('hello-required', 'Send hello first.'));
    const room = this.room();
    if (!room) return { send: [{ to: 'self', msg: error('not-found', 'This room no longer exists.') }], close: { code: CLOSE.notFound, reason: 'room not found' } };

    switch (msg.t) {
      case 'partial':
        return this.onPartial(conn, room, msg);
      case 'final':
        return this.onFinal(conn, room, msg);
      case 'correct':
        return this.onCorrect(conn, room, msg);
      case 'meta':
        return this.onMeta(conn, room, msg);
      case 'status':
        return this.onStatus(conn, room, msg);
      case 'end':
        return this.onEnd(conn, room);
      case 'history':
        return this.onHistory(conn, room, msg);
      case 'ping':
        return reply({ t: 'pong', ts: msg.ts, serverTime: this.now() });
    }
  }

  /**
   * A connection went away.
   * @param speakerRemains another speaker connection is still open (this one was replaced).
   */
  handleDisconnect(conn: ConnState, speakerRemains = false): Outcome {
    this.buckets.delete(conn.id);
    this.strikes.delete(conn.id);
    if (conn.role === null) return NONE;
    if (conn.role === 'speaker' && this.partial && !speakerRemains) {
      const cleared = this.partial;
      this.partial = null;
      return { send: [{ to: 'others', msg: { t: 'partial', id: cleared.id, text: '' } }], presenceChanged: true };
    }
    return { send: [], presenceChanged: true };
  }

  /* --------------------------------- handlers --------------------------------- */

  private async hello(conn: ConnState, msg: HelloMsg, others: Presence): Promise<Outcome> {
    if (conn.role !== null) return reply(error('invalid', 'Already joined.'));
    if (!this.room()) {
      return { send: [{ to: 'self', msg: error('not-found', 'No room with that code. Check the code and try again.') }], close: { code: CLOSE.notFound, reason: 'room not found' } };
    }
    if (msg.role !== 'listener') {
      const authorized = msg.token ? await this.checkToken(msg.role, msg.token) : false;
      if (!authorized) {
        return { send: [{ to: 'self', msg: error('unauthorized', 'This link is not valid for that role.') }], close: { code: CLOSE.unauthorized, reason: 'unauthorized' } };
      }
    }
    // Re-read after the await: another handler may have written meanwhile.
    const room = this.room();
    if (!room) return reply(error('not-found', 'This room no longer exists.'));

    const role = msg.role;
    // Start the role's own rate-limit bucket fresh instead of inheriting the pre-hello one.
    this.buckets.delete(conn.id);
    const snapshot = this.snapshot(room, msg.since ?? 0, role);
    const presence = withRole(others, role);
    return {
      send: [
        {
          to: 'self',
          msg: {
            t: 'welcome',
            v: PROTOCOL_VERSION,
            room: room.code,
            role,
            meta: room.meta,
            status: room.status,
            mode: snapshot.mode,
            segments: snapshot.segments,
            partial: this.partial,
            hasMore: snapshot.hasMore,
            rev: room.rev,
            presence,
            serverTime: this.now(),
          },
        },
      ],
      conn: { ...conn, role },
      presenceChanged: true,
      replaceOtherSpeakers: role === 'speaker',
    };
  }

  private onPartial(conn: ConnState, room: RoomRecord, msg: PartialMsg): Outcome {
    if (conn.role !== 'speaker') return reply(error('forbidden', 'Only the speaker can send captions.'));
    if (room.status === 'ended') return reply(error('room-ended', 'This session has ended.'));
    const text = cleanText(msg.text);
    if (!text) {
      // Only clear the partial this id refers to; a late clear must not wipe a newer one.
      if (!this.partial || this.partial.id !== msg.id) return NONE;
      this.partial = null;
      return { send: [{ to: 'others', msg: { t: 'partial', id: msg.id, text: '' } }] };
    }
    if (this.partial && this.partial.id === msg.id && this.partial.text === text) return NONE;
    this.partial = { id: msg.id, text };
    const t = this.now();
    if (t - this.lastPartialAt < LIMITS.partialMinIntervalMs) return NONE;
    this.lastPartialAt = t;
    return { send: [{ to: 'others', msg: { t: 'partial', id: msg.id, text } }] };
  }

  private onFinal(conn: ConnState, room: RoomRecord, msg: FinalMsg): Outcome {
    if (conn.role !== 'speaker') return reply(error('forbidden', 'Only the speaker can send captions.'));
    if (room.status === 'ended') return reply(error('room-ended', 'This session has ended.'));
    const text = cleanText(msg.text);
    if (!text) return reply(error('invalid', 'Empty caption.'));

    // Idempotent: a speaker resending after a reconnect gets the stored copy back.
    const existing = this.store.findSegmentById(msg.id);
    if (existing) return reply({ t: 'final', seg: existing });
    const chars = room.chars ?? 0;
    if (room.lastSeq >= LIMITS.maxSegments || chars + text.length > LIMITS.maxRoomChars) return reply(error('room-full', 'This room is full. Start a new session.'));

    const t = this.now();
    const seg: Segment = {
      seq: room.lastSeq + 1,
      id: msg.id,
      text,
      ts: t,
      rev: room.rev + 1,
      ...(msg.startMs !== undefined ? { startMs: msg.startMs } : {}),
      ...(msg.endMs !== undefined ? { endMs: msg.endMs } : {}),
    };
    this.atomically(() => {
      this.store.insertSegment(seg);
      this.save({ ...room, lastSeq: seg.seq, rev: seg.rev, lastActivity: t, chars: chars + text.length });
    });
    if (this.partial?.id === msg.id) this.partial = null;
    return { send: [{ to: 'all', msg: { t: 'final', seg } }], activity: true };
  }

  private onCorrect(conn: ConnState, room: RoomRecord, msg: CorrectMsg): Outcome {
    if (conn.role !== 'speaker' && conn.role !== 'corrector') return reply(error('forbidden', 'Only the speaker or a corrector can edit captions.'));
    const seg = this.store.getSegment(msg.seq);
    if (!seg) return reply(error('not-found', `No caption #${msg.seq}.`));
    const text = cleanText(msg.text);
    if (text === seg.text) return NONE;
    const chars = (room.chars ?? 0) + text.length - seg.text.length;
    if (text.length > seg.text.length && chars > LIMITS.maxRoomChars) return reply(error('room-full', 'This room is full. Start a new session.'));
    const rev = room.rev + 1;
    this.atomically(() => {
      this.store.replaceSegment({ ...seg, text, rev, edited: true });
      this.save({ ...room, rev, lastActivity: this.now(), chars });
    });
    return { send: [{ to: 'all', msg: { t: 'correct', seq: seg.seq, text, rev, by: conn.role } }], activity: true };
  }

  private onMeta(conn: ConnState, room: RoomRecord, msg: MetaMsg): Outcome {
    if (conn.role !== 'speaker') return reply(error('forbidden', 'Only the speaker can change room settings.'));
    const meta: RoomMeta = {
      ...room.meta,
      ...(msg.title !== undefined ? { title: cleanText(msg.title) } : {}),
      ...(msg.lang !== undefined ? { lang: msg.lang } : {}),
      ...(msg.allowExport !== undefined ? { allowExport: msg.allowExport } : {}),
    };
    this.save({ ...room, meta });
    return { send: [{ to: 'all', msg: { t: 'meta', meta } }] };
  }

  private onStatus(conn: ConnState, room: RoomRecord, msg: StatusMsg): Outcome {
    if (conn.role !== 'speaker') return reply(error('forbidden', 'Only the speaker can pause captions.'));
    if (room.status === 'ended') return reply(error('room-ended', 'This session has ended.'));
    if (room.status === msg.status) return NONE;
    this.save({ ...room, status: msg.status });
    const send: Outbound[] = [{ to: 'all', msg: { t: 'status', status: msg.status } }];
    if (msg.status === 'paused' && this.partial) {
      send.push({ to: 'others', msg: { t: 'partial', id: this.partial.id, text: '' } });
      this.partial = null;
    }
    return { send };
  }

  private onEnd(conn: ConnState, room: RoomRecord): Outcome {
    if (conn.role !== 'speaker') return reply(error('forbidden', 'Only the speaker can end the session.'));
    if (room.status === 'ended') return NONE;
    this.save({ ...room, status: 'ended', lastActivity: this.now() });
    this.partial = null;
    return { send: [{ to: 'all', msg: { t: 'status', status: 'ended' } }], activity: true };
  }

  private onHistory(conn: ConnState, room: RoomRecord, msg: HistoryMsg): Outcome {
    // With downloads off, listeners keep the live window only (the welcome's recent lines).
    if (conn.role === 'listener' && !room.meta.allowExport) return reply(error('forbidden', 'The speaker has turned off transcript access.'));
    const limit = Math.min(msg.limit ?? LIMITS.welcomeHistory, LIMITS.historyPage);
    const segments = this.store.before(msg.before, limit);
    return reply({ t: 'history', segments, hasMore: this.olderExist(segments) });
  }

  /* --------------------------------- helpers --------------------------------- */

  private snapshot(room: RoomRecord, since: number, role: Role): { mode: 'append' | 'replace'; segments: Segment[]; hasMore: boolean } {
    if (since > 0 && since <= room.rev && this.store.countChangedSince(since) <= LIMITS.resumeLimit) {
      return { mode: 'append', segments: this.store.changedSince(since), hasMore: false };
    }
    const segments = this.store.latest(role === 'listener' ? LIMITS.welcomeHistory : STAFF_WELCOME_HISTORY);
    return { mode: 'replace', segments, hasMore: this.olderExist(segments) };
  }

  private olderExist(segments: readonly Segment[]): boolean {
    const first = this.store.firstSeq();
    const shown = segments[0];
    return first !== null && shown !== undefined && first < shown.seq;
  }

  private async checkToken(role: Role, token: string): Promise<boolean> {
    const room = this.room();
    if (!room) return false;
    const hash = await hashToken(token);
    if (timingSafeEqual(hash, room.speakerTokenHash)) return true; // the speaker can do everything
    return role === 'corrector' && timingSafeEqual(hash, room.correctorTokenHash);
  }

  /** Token bucket per connection. */
  private charge(conn: ConnState, cost: number): boolean {
    const spec = BUCKETS[conn.role ?? 'pending'];
    const t = this.now();
    const prev = this.buckets.get(conn.id) ?? { tokens: spec.capacity, last: t };
    const tokens = Math.min(spec.capacity, prev.tokens + ((t - prev.last) / 1000) * spec.perSecond);
    if (tokens < cost) {
      this.buckets.set(conn.id, { tokens, last: t });
      return false;
    }
    this.buckets.set(conn.id, { tokens: tokens - cost, last: t });
    return true;
  }

  /** Reply with an error, and disconnect clients that keep sending rejected frames. */
  private strike(conn: ConnState, msg: ServerMsg): Outcome {
    const count = (this.strikes.get(conn.id) ?? 0) + 1;
    this.strikes.set(conn.id, count);
    if (count >= LIMITS.maxStrikes) return { send: [{ to: 'self', msg }], close: { code: CLOSE.badFrame, reason: 'too many rejected messages' } };
    return reply(msg);
  }

  private room(): RoomRecord | null {
    if (!this.cached) this.cached = this.store.loadRoom();
    return this.cached;
  }

  /** Persist first, cache second. */
  private save(room: RoomRecord): void {
    this.store.saveRoom(room);
    this.cached = room;
  }

  /** Run related writes as one transaction; on failure, drop the cache so the next read is fresh. */
  private atomically(fn: () => void): void {
    try {
      if (this.store.transaction) this.store.transaction(fn);
      else fn();
    } catch (err) {
      this.cached = null;
      throw err;
    }
  }
}

function reply(msg: ServerMsg): Outcome {
  return { send: [{ to: 'self', msg }] };
}

function error(code: ErrorCode, message: string): ServerMsg {
  return { t: 'error', code, message };
}

function withRole(p: Presence, role: Role): Presence {
  switch (role) {
    case 'speaker':
      return { ...p, speaker: true };
    case 'corrector':
      return { ...p, correctors: p.correctors + 1 };
    case 'listener':
      return { ...p, listeners: p.listeners + 1 };
  }
}

/** Count presence over a set of connection states. */
export function countPresence(conns: Iterable<ConnState>): Presence {
  let listeners = 0;
  let correctors = 0;
  let speaker = false;
  for (const c of conns) {
    if (c.role === 'listener') listeners++;
    else if (c.role === 'corrector') correctors++;
    else if (c.role === 'speaker') speaker = true;
  }
  return { listeners, correctors, speaker };
}
