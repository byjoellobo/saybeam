/**
 * WebSocket client for one room, built for flaky school and venue Wi-Fi:
 * - reconnects with jittered exponential backoff and resumes with `since`,
 * - detects dead connections (no traffic for 45 s) and reconnects,
 * - keeps the speaker's finals in a persisted outbox until the server echoes
 *   them, so captions spoken during an outage are delivered afterwards.
 */
import {
  applyServerMsg,
  CLOSE,
  EMPTY_VIEW,
  KEEPALIVE_PING,
  KEEPALIVE_PONG,
  type ClientMsg,
  type FinalMsg,
  type LinkTarget,
  type MetaMsg,
  type Role,
  type RoomView,
  type ServerMsg,
} from '@saybeam/protocol';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ClientSnapshot {
  readonly view: RoomView;
  readonly connection: ConnectionState;
  /** Human-readable reason when connection is 'closed'. */
  readonly closeReason: string | null;
  /** WebSocket close code when connection is 'closed' for good (e.g. 4003). */
  readonly closeCode: number | null;
  /** Finals spoken but not yet confirmed by the server. */
  readonly pending: readonly FinalMsg[];
  readonly rttMs: number | null;
  /** The latest link secret the speaker received after a rotate. */
  readonly rotation: { readonly target: LinkTarget; readonly token: string } | null;
}

export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface RoomClientOptions {
  readonly code: string;
  readonly role: Role;
  readonly token?: string;
  /** e.g. wss://captions.example.org. Defaults to the page origin. */
  readonly wsBase?: string;
  readonly socketFactory?: (url: string) => SocketLike;
  readonly storage?: KeyValueStore | null;
  readonly maxSegments?: number;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly timers?: Timers;
}

const OPEN = 1;
const KEEPALIVE_MS = 20_000;
// Generous enough that throttled background tabs (timers about once a minute) do not flap.
const DEAD_AFTER_MS = 70_000;
const WATCHDOG_MS = 5_000;
const RTT_EVERY_MS = 15_000;
const PARTIAL_EVERY_MS = 150;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 10_000;
/** Redeliver unconfirmed finals in small batches so a long outage does not trip the server's rate limit. */
const OUTBOX_BATCH = 15;
const OUTBOX_EVERY_MS = 1000;
const RESEND_AFTER_MS = 4000;
const MAX_SEND_ATTEMPTS = 12;

const FATAL: Record<number, string> = {
  [CLOSE.replaced]: 'Captioning moved to another tab or device. This one has stopped sending.',
  [CLOSE.unauthorized]: 'This link is not valid any more. Ask the organiser for a fresh one.',
  [CLOSE.notFound]: 'There is no room with that code. Check the code and try again.',
  [CLOSE.expired]: 'This room has expired.',
};

const PRIVATE_ROOM = 'This is a private room. Scan the QR code or open the full link from the organiser.';

const browserTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
};

export function defaultWsBase(): string {
  return location.origin.replace(/^http/, 'ws');
}

export class RoomClient {
  private socket: SocketLike | null = null;
  private state: ClientSnapshot;
  private readonly listeners = new Set<(s: ClientSnapshot) => void>();
  private attempts = 0;
  private reconnectTimer: unknown = null;
  private keepaliveTimer: unknown = null;
  private watchdogTimer: unknown = null;
  private rttTimer: unknown = null;
  private outboxTimer: unknown = null;
  private partialTimer: unknown = null;
  private readonly sentAt = new Map<string, number>();
  private readonly sendCount = new Map<string, number>();
  /** Speaker and corrector actions made while offline, replayed on reconnect (latest wins per key). */
  private readonly controls = new Map<string, ClientMsg>();
  private queuedPartial: { id: string; text: string } | null = null;
  private lastPartialSentAt = Number.NEGATIVE_INFINITY;
  private lastTrafficAt = 0;
  private stopped = false;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly timers: Timers;
  private readonly outboxKey: string;

  constructor(private readonly opts: RoomClientOptions) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.timers = opts.timers ?? browserTimers;
    this.outboxKey = `saybeam:outbox:${opts.code}`;
    this.state = { view: EMPTY_VIEW, connection: 'idle', closeReason: null, closeCode: null, pending: this.loadOutbox(), rttMs: null, rotation: null };
  }

  get snapshot(): ClientSnapshot {
    return this.state;
  }

  subscribe(fn: (s: ClientSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  /** Reconnect right away (e.g. the browser came back online). */
  nudge(): void {
    if (this.stopped || this.state.connection === 'open' || this.state.connection === 'connecting') return;
    this.timers.clearTimeout(this.reconnectTimer);
    this.attempts = 0;
    this.open();
  }

  close(): void {
    this.stopped = true;
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    s?.close(1000, 'bye');
    this.update({ connection: 'closed' });
  }

  /* -------------------------------- speaker -------------------------------- */

  /** Latest-wins, at most one partial per 150 ms. */
  sendPartial(id: string, text: string): void {
    this.queuedPartial = { id, text };
    if (this.partialTimer) return;
    const wait = Math.max(0, this.lastPartialSentAt + PARTIAL_EVERY_MS - this.now());
    this.partialTimer = this.timers.setTimeout(() => {
      this.partialTimer = null;
      const p = this.queuedPartial;
      this.queuedPartial = null;
      if (p && this.send({ t: 'partial', id: p.id, text: p.text })) this.lastPartialSentAt = this.now();
    }, wait);
  }

  sendFinal(final: Omit<FinalMsg, 't'>): void {
    const msg: FinalMsg = { t: 'final', ...final };
    if (this.queuedPartial?.id === final.id) this.queuedPartial = null;
    this.setPending([...this.state.pending.filter((p) => p.id !== msg.id), msg]);
    this.sendPending(msg);
  }

  correct(seq: number, text: string): void {
    this.control(`correct:${seq}`, { t: 'correct', seq, text });
  }

  setMeta(meta: Omit<MetaMsg, 't'>): void {
    const queued = this.controls.get('meta');
    this.control('meta', { ...(queued?.t === 'meta' ? queued : {}), t: 'meta', ...meta });
  }

  setStatus(status: 'live' | 'paused'): void {
    this.control('status', { t: 'status', status });
  }

  end(): void {
    this.control('end', { t: 'end' });
  }

  /** Replace the corrector or (private rooms) audience link. Returns false when offline. */
  rotate(target: LinkTarget): boolean {
    return this.send({ t: 'rotate', target });
  }

  /** Actions waiting for the connection to come back. */
  get queuedActions(): number {
    return this.controls.size;
  }

  /** Ask for older segments than the oldest we hold. */
  loadEarlier(limit = 200): void {
    const first = this.state.view.segments[0];
    if (first) this.send({ t: 'history', before: first.seq, limit });
  }

  /** Page in every older segment (before exporting a full transcript). */
  async loadAll(maxPages = 200): Promise<void> {
    for (let page = 0; page < maxPages && this.state.view.hasMore && this.state.connection === 'open'; page++) {
      const before = this.state.view.segments[0]?.seq;
      const done = new Promise<void>((resolve) => {
        let settled = false;
        let unsubscribe: () => void = () => undefined;
        const finish = () => {
          if (settled) return;
          settled = true;
          unsubscribe();
          resolve();
        };
        const timer = this.timers.setTimeout(finish, 5000);
        unsubscribe = this.subscribe((s) => {
          if (s.view.segments[0]?.seq !== before || !s.view.hasMore) {
            this.timers.clearTimeout(timer);
            queueMicrotask(finish);
          }
        });
      });
      this.loadEarlier(500);
      await done;
      if (this.state.view.segments[0]?.seq === before) return; // no progress: stop rather than spin
    }
  }

  /* ------------------------------- internals ------------------------------- */

  private open(): void {
    this.clearTimers();
    this.detachSocket();
    this.update({ connection: this.attempts === 0 && this.state.view.room === null ? 'connecting' : 'reconnecting', closeReason: null });
    const url = `${this.opts.wsBase ?? defaultWsBase()}/ws/${this.opts.code}`;
    let socket: SocketLike;
    try {
      socket = this.opts.socketFactory ? this.opts.socketFactory(url) : (new WebSocket(url) as unknown as SocketLike);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.lastTrafficAt = this.now();
      this.send({
        t: 'hello',
        role: this.opts.role,
        ...(this.opts.token ? { token: this.opts.token } : {}),
        ...(this.state.view.rev > 0 ? { since: this.state.view.rev } : {}),
        v: 1,
      });
      this.startTimers();
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.lastTrafficAt = this.now();
      if (typeof ev.data !== 'string' || ev.data === KEEPALIVE_PONG) return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data) as ServerMsg;
      } catch {
        return;
      }
      this.onServerMsg(msg);
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimers();
      const fatal = ev.code === CLOSE.unauthorized && this.opts.role === 'listener' ? PRIVATE_ROOM : FATAL[ev.code];
      if (fatal) {
        this.stopped = true;
        this.update({ connection: 'closed', closeReason: fatal, closeCode: ev.code });
        return;
      }
      if (!this.stopped) this.scheduleReconnect();
    };
    socket.onerror = () => {
      // onclose follows and handles reconnection.
    };
  }

  private onServerMsg(msg: ServerMsg): void {
    const view = applyServerMsg(this.state.view, msg, { now: this.now(), ...(this.opts.maxSegments ? { maxSegments: this.opts.maxSegments } : {}) });
    let pending = this.state.pending;
    let rttMs = this.state.rttMs;
    if (msg.t === 'welcome') {
      this.attempts = 0;
      this.update({ view, connection: 'open' });
      // Replay offline actions, then redeliver unsent finals in paced batches (the server dedupes by id).
      for (const [key, queued] of [...this.controls]) if (this.send(queued)) this.controls.delete(key);
      this.sentAt.clear();
      this.pumpOutbox();
      return;
    }
    if (msg.t === 'final') {
      pending = pending.filter((p) => p.id !== msg.seg.id);
      this.sentAt.delete(msg.seg.id);
      this.sendCount.delete(msg.seg.id);
    }
    if (msg.t === 'error' && (msg.code === 'room-ended' || msg.code === 'room-full')) pending = [];
    if (msg.t === 'pong') rttMs = Math.max(0, this.now() - msg.ts);
    if (msg.t === 'rotated') {
      this.update({ rotation: { target: msg.target, token: msg.token } });
      return;
    }
    if (pending !== this.state.pending) this.persistOutbox(pending);
    this.update({ view, pending, rttMs });
  }

  private send(msg: ClientMsg): boolean {
    const s = this.socket;
    if (!s || s.readyState !== OPEN) return false;
    if (msg.t !== 'hello' && this.state.connection !== 'open') return false;
    try {
      s.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private control(key: string, msg: ClientMsg): void {
    if (this.send(msg)) this.controls.delete(key);
    else this.controls.set(key, msg);
  }

  private sendPending(msg: FinalMsg): void {
    const count = (this.sendCount.get(msg.id) ?? 0) + 1;
    if (count > MAX_SEND_ATTEMPTS) {
      // The server keeps rejecting it (for example it was invalid): give up rather than retry forever.
      this.setPending(this.state.pending.filter((p) => p.id !== msg.id));
      this.sendCount.delete(msg.id);
      this.sentAt.delete(msg.id);
      return;
    }
    if (this.send(msg)) {
      this.sendCount.set(msg.id, count);
      this.sentAt.set(msg.id, this.now());
    }
  }

  private pumpOutbox(): void {
    const due = this.state.pending.filter((p) => this.now() - (this.sentAt.get(p.id) ?? Number.NEGATIVE_INFINITY) >= RESEND_AFTER_MS).slice(0, OUTBOX_BATCH);
    for (const p of due) this.sendPending(p);
  }

  private detachSocket(): void {
    const old = this.socket;
    this.socket = null;
    if (!old) return;
    old.onopen = old.onmessage = old.onclose = old.onerror = null;
    try {
      old.close(1000, 'reconnecting');
    } catch {
      // ignore
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempts) * (0.5 + this.random() * 0.5);
    this.attempts++;
    this.update({ connection: 'reconnecting' });
    this.reconnectTimer = this.timers.setTimeout(() => this.open(), delay);
  }

  private startTimers(): void {
    this.keepaliveTimer = this.timers.setInterval(() => {
      try {
        if (this.socket?.readyState === OPEN) this.socket.send(KEEPALIVE_PING);
      } catch {
        // handled by watchdog
      }
    }, KEEPALIVE_MS);
    this.watchdogTimer = this.timers.setInterval(() => {
      if (this.now() - this.lastTrafficAt > DEAD_AFTER_MS) {
        const s = this.socket;
        this.socket = null;
        this.clearTimers();
        try {
          s?.close(4000, 'no traffic');
        } catch {
          // ignore
        }
        this.scheduleReconnect();
      }
    }, WATCHDOG_MS);
    if (this.opts.role === 'speaker') {
      this.rttTimer = this.timers.setInterval(() => this.send({ t: 'ping', ts: this.now() }), RTT_EVERY_MS);
      this.outboxTimer = this.timers.setInterval(() => {
        if (this.state.connection === 'open' && this.state.pending.length) this.pumpOutbox();
      }, OUTBOX_EVERY_MS);
    }
  }

  private clearTimers(): void {
    this.timers.clearTimeout(this.reconnectTimer);
    this.timers.clearInterval(this.keepaliveTimer);
    this.timers.clearInterval(this.watchdogTimer);
    this.timers.clearInterval(this.rttTimer);
    this.timers.clearInterval(this.outboxTimer);
    this.reconnectTimer = this.keepaliveTimer = this.watchdogTimer = this.rttTimer = this.outboxTimer = null;
  }

  private setPending(pending: readonly FinalMsg[]): void {
    this.persistOutbox(pending);
    this.update({ pending });
  }

  private loadOutbox(): readonly FinalMsg[] {
    if (this.opts.role !== 'speaker' || !this.opts.storage) return [];
    try {
      const raw = this.opts.storage.getItem(this.outboxKey);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? (parsed as FinalMsg[]).filter((p) => p && p.t === 'final' && typeof p.id === 'string') : [];
    } catch {
      return [];
    }
  }

  private persistOutbox(pending: readonly FinalMsg[]): void {
    if (this.opts.role !== 'speaker' || !this.opts.storage) return;
    try {
      if (pending.length) this.opts.storage.setItem(this.outboxKey, JSON.stringify(pending));
      else this.opts.storage.removeItem(this.outboxKey);
    } catch {
      // Storage full or blocked: the in-memory outbox still works.
    }
  }

  private update(patch: Partial<ClientSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }
}
