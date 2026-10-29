import { beforeEach, describe, expect, it } from 'vitest';
import { RoomClient, type KeyValueStore, type SocketLike, type Timers } from '../src/lib/room-client';
import type { ServerMsg, WelcomeMsg } from '@caption-room/protocol';

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  recv(msg: ServerMsg | string) {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }
  json() {
    return this.sent.filter((s) => s.startsWith('{')).map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

class FakeTimers implements Timers {
  t = 0;
  private seq = 0;
  private tasks = new Map<number, { at: number; fn: () => void; every?: number }>();
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(h: unknown) {
    this.tasks.delete(h as number);
  }
  setInterval(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.t + ms, fn, every: ms });
    return id;
  }
  clearInterval(h: unknown) {
    this.tasks.delete(h as number);
  }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = [...this.tasks.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, task] = next;
      this.t = task.at;
      if (task.every) task.at += task.every;
      else this.tasks.delete(id);
      task.fn();
    }
    this.t = end;
  }
}

class MemStore implements KeyValueStore {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

const welcome = (over: Partial<WelcomeMsg> = {}): WelcomeMsg => ({
  t: 'welcome',
  v: 1,
  room: 'ABCDEF',
  role: 'speaker',
  meta: { title: '', lang: 'en-US', allowExport: true, createdAt: 0, private: false },
  status: 'live',
  mode: 'replace',
  segments: [],
  partial: null,
  hasMore: false,
  rev: 0,
  presence: { listeners: 0, correctors: 0, speaker: true },
  serverTime: 0,
  ...over,
});

let timers: FakeTimers;
let sockets: FakeSocket[];
let store: MemStore;

function make(role: 'speaker' | 'listener' = 'speaker') {
  return new RoomClient({
    code: 'ABCDEF',
    role,
    ...(role === 'speaker' ? { token: 'secret-token-1234567890' } : {}),
    wsBase: 'ws://test',
    socketFactory: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    storage: store,
    timers,
    now: () => timers.t,
    random: () => 1,
  });
}

const last = () => {
  const s = sockets[sockets.length - 1];
  if (!s) throw new Error('no socket');
  return s;
};

describe('RoomClient', () => {
  beforeEach(() => {
    timers = new FakeTimers();
    sockets = [];
    store = new MemStore();
  });

  it('connects, says hello with the token, and becomes open on welcome', () => {
    const c = make();
    const states: string[] = [];
    c.subscribe((s) => states.push(s.connection));
    c.connect();
    expect(last().url).toBe('ws://test/ws/ABCDEF');
    last().open();
    expect(last().json()[0]).toEqual({ t: 'hello', role: 'speaker', token: 'secret-token-1234567890', v: 1 });
    last().recv(welcome());
    expect(c.snapshot.connection).toBe('open');
    expect(states).toContain('connecting');
  });

  it('throttles partials to one per 150 ms, latest wins', () => {
    const c = make();
    c.connect();
    last().open();
    last().recv(welcome());
    c.sendPartial('a', 'he');
    c.sendPartial('a', 'hel');
    timers.advance(0);
    c.sendPartial('a', 'hell');
    c.sendPartial('a', 'hello');
    timers.advance(149);
    expect(
      last()
        .json()
        .filter((m) => m.t === 'partial')
        .map((m) => m.text),
    ).toEqual(['hel']);
    timers.advance(1);
    expect(
      last()
        .json()
        .filter((m) => m.t === 'partial')
        .map((m) => m.text),
    ).toEqual(['hel', 'hello']);
  });

  it('keeps finals in a persisted outbox until echoed, and redelivers after reconnect', () => {
    const c = make();
    c.connect();
    last().open();
    last().recv(welcome());
    c.sendFinal({ id: 'a', text: 'One.' });
    expect(c.snapshot.pending).toHaveLength(1);
    expect(store.getItem('caption-room:outbox:ABCDEF')).toContain('One.');

    last().drop();
    expect(c.snapshot.connection).toBe('reconnecting');
    c.sendFinal({ id: 'b', text: 'Spoken offline.' });
    expect(c.snapshot.pending.map((p) => p.id)).toEqual(['a', 'b']);

    timers.advance(500);
    expect(sockets).toHaveLength(2);
    last().open();
    last().recv(welcome({ mode: 'append', rev: 0 }));
    expect(
      last()
        .json()
        .filter((m) => m.t === 'final')
        .map((m) => m.id),
    ).toEqual(['a', 'b']);

    last().recv({ t: 'final', seg: { seq: 1, id: 'a', text: 'One.', ts: 1, rev: 1 } });
    last().recv({ t: 'final', seg: { seq: 2, id: 'b', text: 'Spoken offline.', ts: 2, rev: 2 } });
    expect(c.snapshot.pending).toHaveLength(0);
    expect(store.getItem('caption-room:outbox:ABCDEF')).toBeNull();
    expect(c.snapshot.view.segments).toHaveLength(2);
  });

  it('restores the outbox from storage on a fresh page load', () => {
    store.setItem('caption-room:outbox:ABCDEF', JSON.stringify([{ t: 'final', id: 'z', text: 'Saved.' }, { junk: true }]));
    const c = make();
    expect(c.snapshot.pending.map((p) => p.id)).toEqual(['z']);
    store.setItem('caption-room:outbox:ABCDEF', '{not json');
    expect(make().snapshot.pending).toEqual([]);
  });

  it('resumes with since after a drop', () => {
    const c = make('listener');
    c.connect();
    last().open();
    last().recv(welcome({ role: 'listener', rev: 7, segments: [{ seq: 1, id: 'a', text: 'x', ts: 0, rev: 7 }] }));
    last().drop();
    timers.advance(1000);
    last().open();
    expect(last().json()[0]).toEqual({ t: 'hello', role: 'listener', since: 7, v: 1 });
  });

  it('stops on fatal close codes with a readable reason', () => {
    const c = make();
    c.connect();
    last().open();
    last().drop(4001);
    expect(c.snapshot.connection).toBe('closed');
    expect(c.snapshot.closeReason).toMatch(/another tab/);
    timers.advance(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('backs off exponentially and nudge reconnects immediately', () => {
    const c = make('listener');
    c.connect();
    last().drop();
    timers.advance(499);
    expect(sockets).toHaveLength(1);
    timers.advance(1);
    expect(sockets).toHaveLength(2);
    last().drop();
    timers.advance(999);
    expect(sockets).toHaveLength(2);
    c.nudge();
    expect(sockets).toHaveLength(3);
  });

  it('sends keepalives and reconnects when the line goes silent', () => {
    const c = make('listener');
    c.connect();
    last().open();
    last().recv(welcome({ role: 'listener' }));
    timers.advance(20_000);
    expect(last().sent).toContain('ping');
    last().recv('pong'); // traffic at t=20s
    timers.advance(75_000); // watchdog sees >70 s of silence at t=95s
    expect(sockets[0]?.closedWith?.code).toBe(4000);
    expect(c.snapshot.connection).toBe('reconnecting');
  });

  it('measures RTT for speakers and exposes other actions', () => {
    const c = make();
    c.connect();
    last().open();
    last().recv(welcome({ segments: [{ seq: 5, id: 'e', text: 'x', ts: 0, rev: 1 }], hasMore: true }));
    timers.advance(15_000);
    const ping = last()
      .json()
      .find((m) => m.t === 'ping');
    expect(ping).toBeDefined();
    timers.advance(40);
    last().recv({ t: 'pong', ts: Number(ping?.ts), serverTime: 0 });
    expect(c.snapshot.rttMs).toBe(40);
    c.correct(5, 'y');
    c.setMeta({ title: 'T' });
    c.setStatus('paused');
    c.loadEarlier(50);
    c.end();
    expect(
      last()
        .json()
        .map((m) => m.t),
    ).toEqual(expect.arrayContaining(['correct', 'meta', 'status', 'history', 'end']));
    last().recv({ t: 'error', code: 'room-ended', message: 'x' });
    c.close();
    expect(c.snapshot.connection).toBe('closed');
  });

  it('redelivers a long outage backlog in paced batches and retries unconfirmed finals', () => {
    const c = make();
    c.connect();
    last().drop();
    for (let i = 0; i < 20; i++) c.sendFinal({ id: `f${i}`, text: `Line ${i}.` });
    timers.advance(500);
    last().open();
    last().recv(welcome());
    const finals = () =>
      last()
        .json()
        .filter((m) => m.t === 'final')
        .map((m) => m.id);
    expect(finals()).toHaveLength(15);
    timers.advance(1000);
    expect(finals()).toHaveLength(20);
    // Nothing confirmed: after RESEND_AFTER the oldest batch goes again.
    timers.advance(3000);
    expect(finals().length).toBeGreaterThan(20);
  });

  it('gives up on a final the server keeps rejecting', () => {
    const c = make();
    c.connect();
    last().open();
    last().recv(welcome());
    c.sendFinal({ id: 'bad', text: 'x' });
    timers.advance(60_000);
    expect(c.snapshot.pending).toHaveLength(0);
    expect(
      last()
        .json()
        .filter((m) => m.t === 'final'),
    ).toHaveLength(12);
  });

  it('queues speaker actions taken offline and replays them on reconnect', () => {
    const c = make();
    c.connect();
    last().open();
    last().recv(welcome());
    last().drop();
    c.setStatus('paused');
    c.setMeta({ title: 'A' });
    c.setMeta({ allowExport: false });
    c.correct(3, 'fixed');
    c.correct(3, 'fixed again');
    expect(c.queuedActions).toBe(3);
    timers.advance(500);
    last().open();
    last().recv(welcome({ mode: 'append' }));
    const sent = last()
      .json()
      .filter((m) => m.t !== 'hello');
    expect(sent).toEqual(
      expect.arrayContaining([
        { t: 'status', status: 'paused' },
        { t: 'meta', title: 'A', allowExport: false },
        { t: 'correct', seq: 3, text: 'fixed again' },
      ]),
    );
    expect(c.queuedActions).toBe(0);
  });

  it('closes the old socket when reconnecting early', () => {
    const c = make('listener');
    c.connect();
    const first = last();
    first.drop();
    c.nudge();
    c.nudge();
    expect(sockets.filter((s) => s.closedWith === null && s.readyState !== 3)).toHaveLength(1);
  });

  it('sends rotate requests and exposes the new secret once', () => {
    const c = make();
    c.connect();
    expect(c.rotate('corrector')).toBe(false); // offline
    last().open();
    last().recv(welcome());
    expect(c.rotate('corrector')).toBe(true);
    expect(
      last()
        .json()
        .find((m) => m.t === 'rotate'),
    ).toEqual({ t: 'rotate', target: 'corrector' });
    last().recv({ t: 'rotated', target: 'corrector', token: 'new-secret-new-secret-new-secret-new-secre' });
    expect(c.snapshot.rotation).toEqual({ target: 'corrector', token: 'new-secret-new-secret-new-secret-new-secre' });
  });

  it('explains private rooms to listeners refused with 4003', () => {
    const c = make('listener');
    c.connect();
    last().open();
    last().drop(4003);
    expect(c.snapshot.closeReason).toMatch(/private room/);
  });

  it('ignores garbage frames', () => {
    const c = make('listener');
    c.connect();
    last().open();
    last().recv('{oops');
    last().onmessage?.({ data: new ArrayBuffer(2) });
    expect(c.snapshot.view.room).toBeNull();
  });
});
