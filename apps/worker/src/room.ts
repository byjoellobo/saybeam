/**
 * One Durable Object per room. It owns the WebSockets (with hibernation, so an
 * idle lecture costs almost nothing) and delegates every rule to RoomCore.
 */
import { DurableObject } from 'cloudflare:workers';
import { CLOSE, KEEPALIVE_PING, KEEPALIVE_PONG, LIMITS, type RoomStatus } from '@caption-room/protocol';
import { RoomCore, countPresence, type ConnState, type InitRoomInput, type Outcome } from '@caption-room/protocol/room';
import { SqlRoomStore, hasSchema, migrate } from './sql-store';
import type { Env } from './env';

/** Rooms are deleted this long after the last caption, correction or end. */
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const PRESENCE_DEBOUNCE_MS = 1500;
/** Avoid rewriting the alarm on every caption. */
const ALARM_BUMP_EVERY_MS = 10 * 60 * 1000;
/** A single room can hold a very large hall, but not unbounded sockets. */
const MAX_SOCKETS = 5000;
/** Close sockets that never send hello. */
const HELLO_TIMEOUT_MS = 20_000;

export interface RoomSummary {
  readonly code: string;
  readonly status: RoomStatus;
  readonly title: string;
}

export class Room extends DurableObject<Env> {
  private core: RoomCore;
  /** False until init(): guessed codes must not create storage. */
  private ready: boolean;
  /** Socket -> connection state, rebuilt from attachments after hibernation. */
  private readonly conns = new Map<WebSocket, ConnState>();
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAlarmBump = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = hasSchema(ctx.storage.sql);
    this.core = new RoomCore(new SqlRoomStore(ctx.storage));
    for (const ws of ctx.getWebSockets()) this.conns.set(ws, readAttachment(ws));
    // Keepalive pings are answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(KEEPALIVE_PING, KEEPALIVE_PONG));
  }

  /** RPC: create the room. False if this code is already taken. */
  async init(input: InitRoomInput): Promise<boolean> {
    if (!this.ready) {
      migrate(this.ctx.storage.sql);
      this.ready = true;
    }
    const created = this.core.initialize(input);
    if (created) await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    return created;
  }

  /** RPC: public summary for the join screen. Never writes storage. */
  async describe(): Promise<RoomSummary | null> {
    if (!this.ready) return null;
    const room = new SqlRoomStore(this.ctx.storage).loadRoom();
    return room ? { code: room.code, status: room.status, title: room.meta.title } : null;
  }

  override async fetch(request: Request): Promise<Response> {
    if (!this.ready || !this.core.exists()) return new Response('Room not found', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 });
    if (this.conns.size >= MAX_SOCKETS) return new Response('This room is at capacity', { status: 503 });

    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    const conn: ConnState = { id: crypto.randomUUID(), role: null };
    this.setConn(server, conn);
    setTimeout(() => {
      if (this.conns.get(server)?.role === null) safeClose(server, 1008, 'send hello first');
    }, HELLO_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const conn = this.connOf(ws);
    // Presence is only needed for hello, so count it lazily.
    const others = () => countPresence([...this.conns].filter(([peer]) => peer !== ws).map(([, c]) => c));
    try {
      const outcome = await this.core.handleFrame(conn, message, others);
      this.apply(ws, outcome);
    } catch (err) {
      console.error('room: message handler failed', { error: String(err) });
      safeSend(ws, JSON.stringify({ t: 'error', code: 'invalid', message: 'Server error handling that message.' }));
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.disconnect(ws);
    safeClose(ws, code, reason);
  }

  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.warn('room: socket error', { error: String(error) });
    this.disconnect(ws);
  }

  override async alarm(): Promise<void> {
    const last = this.core.lastActivity();
    const created = this.core.createdAt();
    const now = Date.now();
    if (last !== null && created !== null) {
      const expiresAt = Math.min(last + ROOM_TTL_MS, created + LIMITS.maxRoomAgeMs);
      if (now < expiresAt) {
        await this.ctx.storage.setAlarm(expiresAt);
        return;
      }
    }
    for (const ws of this.ctx.getWebSockets()) safeClose(ws, CLOSE.expired, 'room expired');
    this.conns.clear();
    await this.ctx.storage.deleteAll();
    // Leave the object empty: no tables until someone creates a room with this code again.
    this.ready = false;
    this.core = new RoomCore(new SqlRoomStore(this.ctx.storage));
  }

  /* ------------------------------------------------------------------------- */

  private disconnect(ws: WebSocket): void {
    const conn = this.connOf(ws);
    this.conns.delete(ws);
    const speakerRemains = conn.role === 'speaker' && [...this.conns.values()].some((c) => c.role === 'speaker');
    this.apply(ws, this.core.handleDisconnect(conn, speakerRemains));
  }

  private apply(ws: WebSocket, outcome: Outcome): void {
    if (outcome.conn) this.setConn(ws, outcome.conn);

    for (const { to, msg } of outcome.send) {
      const data = JSON.stringify(msg);
      if (to === 'self') {
        safeSend(ws, data);
        continue;
      }
      for (const [peer, c] of this.conns) {
        if (to === 'others' && peer === ws) continue;
        if (c.role === null) continue; // not joined yet: their welcome will carry this state
        safeSend(peer, data);
      }
    }

    if (outcome.replaceOtherSpeakers) {
      for (const [peer, c] of this.conns) {
        if (peer !== ws && c.role === 'speaker') safeClose(peer, CLOSE.replaced, 'replaced by a newer speaker connection');
      }
    }
    if (outcome.close) safeClose(ws, outcome.close.code, outcome.close.reason);
    if (outcome.presenceChanged) this.schedulePresence();
    if (outcome.activity) void this.bumpExpiry();
  }

  /** Coalesce join/leave storms (a whole lecture hall scanning a QR code) into one broadcast. */
  private schedulePresence(): void {
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      const data = JSON.stringify({ t: 'presence', presence: countPresence(this.conns.values()) });
      for (const [peer, c] of this.conns) if (c.role !== null) safeSend(peer, data);
    }, PRESENCE_DEBOUNCE_MS);
  }

  private async bumpExpiry(): Promise<void> {
    const now = Date.now();
    if (now - this.lastAlarmBump < ALARM_BUMP_EVERY_MS) return;
    this.lastAlarmBump = now;
    const created = this.core.createdAt() ?? now;
    await this.ctx.storage.setAlarm(Math.min(now + ROOM_TTL_MS, created + LIMITS.maxRoomAgeMs));
  }

  private connOf(ws: WebSocket): ConnState {
    const known = this.conns.get(ws);
    if (known) return known;
    const conn = readAttachment(ws);
    this.conns.set(ws, conn);
    return conn;
  }

  private setConn(ws: WebSocket, conn: ConnState): void {
    ws.serializeAttachment(conn);
    this.conns.set(ws, conn);
  }
}

function readAttachment(ws: WebSocket): ConnState {
  return (ws.deserializeAttachment() as ConnState | null) ?? { id: crypto.randomUUID(), role: null };
}

function safeSend(ws: WebSocket, data: string): void {
  try {
    ws.send(data);
  } catch {
    // The socket is closing; its close handler will clean up.
  }
}

function safeClose(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed: the runtime auto-replies to close frames on recent compatibility dates.
  }
}
