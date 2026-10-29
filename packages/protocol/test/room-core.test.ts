import { describe, expect, it, beforeEach } from 'vitest';
import { RoomCore, cleanText, countPresence, type ConnState, type Outcome } from '../src/room-core';
import { MemoryRoomStore } from '../src/store';
import { hashToken } from '../src/codes';
import { CLOSE, LIMITS, type Presence, type ServerMsg, type WelcomeMsg } from '../src/messages';

const SPEAKER_TOKEN = 'speaker-token-0123456789abcdef';
const CORRECTOR_TOKEN = 'corrector-token-0123456789abcdef';
const NOBODY: Presence = { listeners: 0, correctors: 0, speaker: false };

let clock = 1_000_000;
const now = () => clock;

async function makeRoom(): Promise<{ core: RoomCore; store: MemoryRoomStore }> {
  const store = new MemoryRoomStore();
  const core = new RoomCore(store, now);
  core.initialize({
    code: 'ABCDEF',
    speakerTokenHash: await hashToken(SPEAKER_TOKEN),
    correctorTokenHash: await hashToken(CORRECTOR_TOKEN),
    title: '  Physics 101  ',
  });
  return { core, store };
}

const frame = (msg: object) => JSON.stringify(msg);
const msgs = (o: Outcome): ServerMsg[] => o.send.map((s) => s.msg);
const first = (o: Outcome): ServerMsg => {
  const m = o.send[0]?.msg;
  if (!m) throw new Error('no message');
  return m;
};

async function join(core: RoomCore, id: string, role: 'speaker' | 'listener' | 'corrector', extra: object = {}): Promise<{ conn: ConnState; welcome: WelcomeMsg; outcome: Outcome }> {
  const token = role === 'speaker' ? SPEAKER_TOKEN : role === 'corrector' ? CORRECTOR_TOKEN : undefined;
  const outcome = await core.handleFrame({ id, role: null }, frame({ t: 'hello', role, ...(token ? { token } : {}), ...extra }), NOBODY);
  const welcome = first(outcome);
  if (welcome.t !== 'welcome' || !outcome.conn) throw new Error(`join failed: ${JSON.stringify(welcome)}`);
  return { conn: outcome.conn, welcome, outcome };
}

async function speak(core: RoomCore, speaker: ConnState, id: string, text: string): Promise<Outcome> {
  clock += 1000;
  return core.handleFrame(speaker, frame({ t: 'final', id, text }), NOBODY);
}

describe('RoomCore', () => {
  beforeEach(() => {
    clock = 1_000_000;
  });

  describe('initialize', () => {
    it('creates once and trims the title', async () => {
      const { core, store } = await makeRoom();
      expect(core.exists()).toBe(true);
      expect(store.loadRoom()?.meta.title).toBe('Physics 101');
      expect(core.initialize({ code: 'ABCDEF', speakerTokenHash: 'x', correctorTokenHash: 'y' })).toBe(false);
      expect(core.lastActivity()).toBe(1_000_000);
    });
  });

  describe('hello', () => {
    it('lets listeners join without a token and counts them in presence', async () => {
      const { core } = await makeRoom();
      const { welcome, outcome } = await join(core, 'l1', 'listener');
      expect(welcome.role).toBe('listener');
      expect(welcome.mode).toBe('replace');
      expect(welcome.meta.title).toBe('Physics 101');
      expect(welcome.presence.listeners).toBe(1);
      expect(outcome.presenceChanged).toBe(true);
      expect(outcome.replaceOtherSpeakers).toBe(false);
    });

    it('rejects a speaker with a wrong token and closes 4003', async () => {
      const { core } = await makeRoom();
      const out = await core.handleFrame({ id: 's', role: null }, frame({ t: 'hello', role: 'speaker', token: 'wrong-token-wrong-token' }), NOBODY);
      expect(first(out)).toMatchObject({ t: 'error', code: 'unauthorized' });
      expect(out.close?.code).toBe(CLOSE.unauthorized);
    });

    it('rejects a speaker with no token', async () => {
      const { core } = await makeRoom();
      const out = await core.handleFrame({ id: 's', role: null }, frame({ t: 'hello', role: 'speaker' }), NOBODY);
      expect(out.close?.code).toBe(CLOSE.unauthorized);
    });

    it('does not let the corrector token act as speaker', async () => {
      const { core } = await makeRoom();
      const out = await core.handleFrame({ id: 's', role: null }, frame({ t: 'hello', role: 'speaker', token: CORRECTOR_TOKEN }), NOBODY);
      expect(out.close?.code).toBe(CLOSE.unauthorized);
    });

    it('lets the speaker token join as corrector', async () => {
      const { core } = await makeRoom();
      const out = await core.handleFrame({ id: 'c', role: null }, frame({ t: 'hello', role: 'corrector', token: SPEAKER_TOKEN }), NOBODY);
      expect(first(out)).toMatchObject({ t: 'welcome', role: 'corrector' });
    });

    it('asks the host to replace older speakers', async () => {
      const { core } = await makeRoom();
      const { outcome } = await join(core, 's1', 'speaker');
      expect(outcome.replaceOtherSpeakers).toBe(true);
    });

    it('closes 4004 when the room does not exist', async () => {
      const core = new RoomCore(new MemoryRoomStore(), now);
      const out = await core.handleFrame({ id: 'x', role: null }, frame({ t: 'hello', role: 'listener' }), NOBODY);
      expect(first(out)).toMatchObject({ t: 'error', code: 'not-found' });
      expect(out.close?.code).toBe(CLOSE.notFound);
    });

    it('requires hello before anything else and refuses a second hello', async () => {
      const { core } = await makeRoom();
      const out = await core.handleFrame({ id: 'x', role: null }, frame({ t: 'ping', ts: 1 }), NOBODY);
      expect(first(out)).toMatchObject({ t: 'error', code: 'hello-required' });
      const { conn } = await join(core, 'l', 'listener');
      const again = await core.handleFrame(conn, frame({ t: 'hello', role: 'listener' }), NOBODY);
      expect(first(again)).toMatchObject({ t: 'error', code: 'invalid' });
    });

    it('rejects malformed frames', async () => {
      const { core } = await makeRoom();
      expect(first(await core.handleFrame({ id: 'x', role: null }, 'not json', NOBODY))).toMatchObject({ code: 'bad-frame' });
      expect(first(await core.handleFrame({ id: 'y', role: null }, new ArrayBuffer(4), NOBODY))).toMatchObject({ code: 'bad-frame' });
      expect(first(await core.handleFrame({ id: 'z', role: null }, frame({ t: 'final', id: 'bad id!', text: 'x' }), NOBODY))).toMatchObject({ code: 'bad-frame' });
    });
  });

  describe('captions', () => {
    it('broadcasts partials to others only and throttles bursts', async () => {
      const { core } = await makeRoom();
      const { conn: speaker } = await join(core, 's', 'speaker');
      const p1 = await core.handleFrame(speaker, frame({ t: 'partial', id: 'a', text: 'hello' }), NOBODY);
      expect(p1.send).toEqual([{ to: 'others', msg: { t: 'partial', id: 'a', text: 'hello' } }]);
      clock += 10;
      const p2 = await core.handleFrame(speaker, frame({ t: 'partial', id: 'a', text: 'hello wor' }), NOBODY);
      expect(p2.send).toEqual([]);
      clock += LIMITS.partialMinIntervalMs;
      const p3 = await core.handleFrame(speaker, frame({ t: 'partial', id: 'a', text: 'hello world' }), NOBODY);
      expect(msgs(p3)).toEqual([{ t: 'partial', id: 'a', text: 'hello world' }]);
      // Identical text is a no-op.
      clock += 1000;
      expect((await core.handleFrame(speaker, frame({ t: 'partial', id: 'a', text: 'hello world' }), NOBODY)).send).toEqual([]);
      // A late joiner sees the stored partial.
      const { welcome } = await join(core, 'l', 'listener');
      expect(welcome.partial).toEqual({ id: 'a', text: 'hello world' });
    });

    it('clears the partial with an empty partial', async () => {
      const { core } = await makeRoom();
      const { conn: speaker } = await join(core, 's', 'speaker');
      await core.handleFrame(speaker, frame({ t: 'partial', id: 'a', text: 'hi' }), NOBODY);
      const cleared = await core.handleFrame(speaker, frame({ t: 'partial', id: 'a', text: '  ' }), NOBODY);
      expect(msgs(cleared)).toEqual([{ t: 'partial', id: 'a', text: '' }]);
      expect((await core.handleFrame(speaker, frame({ t: 'partial', id: 'a', text: '' }), NOBODY)).send).toEqual([]);
    });

    it('stores finals with increasing seq and rev and broadcasts to all', async () => {
      const { core, store } = await makeRoom();
      const { conn: speaker } = await join(core, 's', 'speaker');
      await core.handleFrame(speaker, frame({ t: 'partial', id: 'a', text: 'good morn' }), NOBODY);
      const f1 = await core.handleFrame(speaker, frame({ t: 'final', id: 'a', text: ' Good morning. ', startMs: 0, endMs: 1500 }), NOBODY);
      expect(f1.send[0]?.to).toBe('all');
      expect(first(f1)).toMatchObject({ t: 'final', seg: { seq: 1, id: 'a', text: 'Good morning.', rev: 1, startMs: 0, endMs: 1500 } });
      expect(f1.activity).toBe(true);
      const f2 = await speak(core, speaker, 'b', 'Second.');
      expect(first(f2)).toMatchObject({ seg: { seq: 2, rev: 2 } });
      expect(store.loadRoom()).toMatchObject({ lastSeq: 2, rev: 2 });
      // The partial was cleared by its final.
      const { welcome } = await join(core, 'l', 'listener');
      expect(welcome.partial).toBeNull();
    });

    it('treats a repeated final id as idempotent and replies only to the sender', async () => {
      const { core } = await makeRoom();
      const { conn: speaker } = await join(core, 's', 'speaker');
      await speak(core, speaker, 'a', 'Once.');
      const dup = await speak(core, speaker, 'a', 'Once again?');
      expect(dup.send).toEqual([{ to: 'self', msg: expect.objectContaining({ t: 'final', seg: expect.objectContaining({ seq: 1, text: 'Once.' }) }) }]);
    });

    it('rejects empty finals and captions from non-speakers', async () => {
      const { core } = await makeRoom();
      const { conn: speaker } = await join(core, 's', 'speaker');
      const { conn: listener } = await join(core, 'l', 'listener');
      expect(first(await core.handleFrame(speaker, frame({ t: 'final', id: 'a', text: '   ' }), NOBODY))).toMatchObject({ code: 'invalid' });
      expect(first(await core.handleFrame(listener, frame({ t: 'final', id: 'a', text: 'x' }), NOBODY))).toMatchObject({ code: 'forbidden' });
      expect(first(await core.handleFrame(listener, frame({ t: 'partial', id: 'a', text: 'x' }), NOBODY))).toMatchObject({ code: 'forbidden' });
    });
  });

  describe('corrections', () => {
    it('lets correctors edit, bumps rev, and broadcasts', async () => {
      const { core, store } = await makeRoom();
      const { conn: speaker } = await join(core, 's', 'speaker');
      const { conn: corrector } = await join(core, 'c', 'corrector');
      await speak(core, speaker, 'a', 'The quantum of solace.');
      const out = await core.handleFrame(corrector, frame({ t: 'correct', seq: 1, text: 'The quantum of action.' }), NOBODY);
      expect(out.send).toEqual([{ to: 'all', msg: { t: 'correct', seq: 1, text: 'The quantum of action.', rev: 2, by: 'corrector' } }]);
      expect(store.getSegment(1)).toMatchObject({ text: 'The quantum of action.', rev: 2, edited: true });
    });

    it('ignores no-op corrections and unknown seqs, forbids listeners', async () => {
      const { core } = await makeRoom();
      const { conn: speaker } = await join(core, 's', 'speaker');
      const { conn: listener } = await join(core, 'l', 'listener');
      await speak(core, speaker, 'a', 'Same.');
      expect((await core.handleFrame(speaker, frame({ t: 'correct', seq: 1, text: 'Same.' }), NOBODY)).send).toEqual([]);
      expect(first(await core.handleFrame(speaker, frame({ t: 'correct', seq: 9, text: 'x' }), NOBODY))).toMatchObject({ code: 'not-found' });
      expect(first(await core.handleFrame(listener, frame({ t: 'correct', seq: 1, text: 'x' }), NOBODY))).toMatchObject({ code: 'forbidden' });
    });

    it('allows removing a segment with empty text', async () => {
      const { core } = await makeRoom();
      const { conn: speaker } = await join(core, 's', 'speaker');
      await speak(core, speaker, 'a', 'Thanks for watching!');
      const out = await core.handleFrame(speaker, frame({ t: 'correct', seq: 1, text: '' }), NOBODY);
      expect(first(out)).toMatchObject({ t: 'correct', seq: 1, text: '', by: 'speaker' });
    });
  });

  describe('resume', () => {
    it('sends only changed segments when resuming with since', async () => {
      const { core } = await makeRoom();
      const { conn: speaker } = await join(core, 's', 'speaker');
      await speak(core, speaker, 'a', 'One.');
      await speak(core, speaker, 'b', 'Two.');
      const { welcome: w1 } = await join(core, 'l1', 'listener');
      expect(w1.rev).toBe(2);
      await speak(core, speaker, 'c', 'Three.');
      await core.handleFrame(speaker, frame({ t: 'correct', seq: 1, text: 'Uno.' }), NOBODY);
      const { welcome: w2 } = await join(core, 'l2', 'listener', { since: w1.rev });
      expect(w2.mode).toBe('append');
      expect(w2.segments.map((s) => [s.seq, s.text])).toEqual([
        [1, 'Uno.'],
        [3, 'Three.'],
      ]);
    });

    it('falls back to replace when since is ahead of the room', async () => {
      const { core } = await makeRoom();
      const { conn: speaker } = await join(core, 's', 'speaker');
      await speak(core, speaker, 'a', 'One.');
      const { welcome } = await join(core, 'l', 'listener', { since: 99 });
      expect(welcome.mode).toBe('replace');
      expect(welcome.segments).toHaveLength(1);
    });

    it('caps listener history and reports hasMore, then pages with history', async () => {
      const { core } = await makeRoom();
      const { conn: speaker } = await join(core, 's', 'speaker');
      for (let i = 1; i <= LIMITS.welcomeHistory + 5; i++) await speak(core, speaker, `id${i}`, `Line ${i}.`);
      const { conn, welcome } = await join(core, 'l', 'listener');
      expect(welcome.segments).toHaveLength(LIMITS.welcomeHistory);
      expect(welcome.hasMore).toBe(true);
      const firstSeq = welcome.segments[0]?.seq ?? 0;
      expect(firstSeq).toBe(6);
      const page = await core.handleFrame(conn, frame({ t: 'history', before: firstSeq, limit: 3 }), NOBODY);
      expect(first(page)).toMatchObject({ t: 'history', hasMore: true });
      const page2 = first(await core.handleFrame(conn, frame({ t: 'history', before: 3 }), NOBODY));
      expect(page2).toMatchObject({ t: 'history', hasMore: false });
      if (page2.t === 'history') expect(page2.segments.map((s) => s.seq)).toEqual([1, 2]);
    });
  });

  describe('status and meta', () => {
    it('pauses, clears the partial, and ends', async () => {
      const { core } = await makeRoom();
      const { conn: speaker } = await join(core, 's', 'speaker');
      await core.handleFrame(speaker, frame({ t: 'partial', id: 'a', text: 'mid sentence' }), NOBODY);
      const paused = await core.handleFrame(speaker, frame({ t: 'status', status: 'paused' }), NOBODY);
      expect(msgs(paused)).toEqual([
        { t: 'status', status: 'paused' },
        { t: 'partial', id: 'a', text: '' },
      ]);
      expect((await core.handleFrame(speaker, frame({ t: 'status', status: 'paused' }), NOBODY)).send).toEqual([]);
      const ended = await core.handleFrame(speaker, frame({ t: 'end' }), NOBODY);
      expect(msgs(ended)).toEqual([{ t: 'status', status: 'ended' }]);
      expect((await core.handleFrame(speaker, frame({ t: 'end' }), NOBODY)).send).toEqual([]);
      expect(first(await speak(core, speaker, 'z', 'Too late.'))).toMatchObject({ code: 'room-ended' });
      expect(first(await core.handleFrame(speaker, frame({ t: 'partial', id: 'z', text: 'x' }), NOBODY))).toMatchObject({ code: 'room-ended' });
      expect(first(await core.handleFrame(speaker, frame({ t: 'status', status: 'live' }), NOBODY))).toMatchObject({ code: 'room-ended' });
    });

    it('updates meta for the speaker only', async () => {
      const { core } = await makeRoom();
      const { conn: speaker } = await join(core, 's', 'speaker');
      const { conn: listener } = await join(core, 'l', 'listener');
      const out = await core.handleFrame(speaker, frame({ t: 'meta', title: 'Chemistry', allowExport: false, lang: 'en-IN' }), NOBODY);
      expect(first(out)).toMatchObject({ t: 'meta', meta: { title: 'Chemistry', allowExport: false, lang: 'en-IN' } });
      expect(first(await core.handleFrame(listener, frame({ t: 'meta', title: 'x' }), NOBODY))).toMatchObject({ code: 'forbidden' });
      expect(first(await core.handleFrame(listener, frame({ t: 'end' }), NOBODY))).toMatchObject({ code: 'forbidden' });
      expect(first(await core.handleFrame(listener, frame({ t: 'status', status: 'paused' }), NOBODY))).toMatchObject({ code: 'forbidden' });
    });

    it('answers json pings with server time', async () => {
      const { core } = await makeRoom();
      const { conn } = await join(core, 'l', 'listener');
      expect(first(await core.handleFrame(conn, frame({ t: 'ping', ts: 42 }), NOBODY))).toEqual({ t: 'pong', ts: 42, serverTime: clock });
    });
  });

  describe('limits and disconnects', () => {
    it('rate limits a flooding listener', async () => {
      const { core } = await makeRoom();
      const { conn } = await join(core, 'l', 'listener');
      const results: string[] = [];
      for (let i = 0; i < 40; i++) {
        const out = await core.handleFrame(conn, frame({ t: 'ping', ts: i }), NOBODY);
        results.push(first(out).t === 'error' ? 'limited' : 'ok');
      }
      expect(results.filter((r) => r === 'limited').length).toBeGreaterThan(10);
      clock += 10_000;
      expect(first(await core.handleFrame(conn, frame({ t: 'ping', ts: 0 }), NOBODY)).t).toBe('pong');
    });

    it('clears the partial when the speaker disconnects', async () => {
      const { core } = await makeRoom();
      const { conn: speaker } = await join(core, 's', 'speaker');
      await core.handleFrame(speaker, frame({ t: 'partial', id: 'a', text: 'half' }), NOBODY);
      const out = core.handleDisconnect(speaker);
      expect(out.send).toEqual([{ to: 'others', msg: { t: 'partial', id: 'a', text: '' } }]);
      expect(out.presenceChanged).toBe(true);
      expect(core.handleDisconnect({ id: 'p', role: null })).toEqual({ send: [] });
      const { conn: listener } = await join(core, 'l', 'listener');
      expect(core.handleDisconnect(listener)).toEqual({ send: [], presenceChanged: true });
    });

    it('closes on oversized frames and after repeated rejected frames', async () => {
      const { core } = await makeRoom();
      const big = await core.handleFrame({ id: 'x', role: null }, 'x'.repeat(LIMITS.maxFrameBytes + 1), NOBODY);
      expect(big.close?.code).toBe(CLOSE.badFrame);
      let last: Outcome = { send: [] };
      for (let i = 0; i < LIMITS.maxStrikes; i++) {
        clock += 2000; // stay inside the rate limit so only bad frames count
        last = await core.handleFrame({ id: 'y', role: null }, '{nope', NOBODY);
      }
      expect(last.close?.code).toBe(CLOSE.badFrame);
    });

    it('charges history requests more than ordinary frames', async () => {
      const { core } = await makeRoom();
      const { conn } = await join(core, 'l', 'listener');
      const a = await core.handleFrame(conn, frame({ t: 'history', before: 5 }), NOBODY);
      const b = await core.handleFrame(conn, frame({ t: 'history', before: 5 }), NOBODY);
      const c = await core.handleFrame(conn, frame({ t: 'history', before: 5 }), NOBODY);
      // 20-token listener bucket, 10 tokens per page: a burst of two, then wait.
      expect([first(a).t, first(b).t]).toEqual(['history', 'history']);
      expect(first(c)).toMatchObject({ code: 'rate-limited' });
    });

    it('limits listener history when the speaker turns transcript access off', async () => {
      const { core } = await makeRoom();
      const { conn: speaker } = await join(core, 's', 'speaker');
      const { conn: listener } = await join(core, 'l', 'listener');
      await core.handleFrame(speaker, frame({ t: 'meta', allowExport: false }), NOBODY);
      expect(first(await core.handleFrame(listener, frame({ t: 'history', before: 5 }), NOBODY))).toMatchObject({ code: 'forbidden' });
      expect(first(await core.handleFrame(speaker, frame({ t: 'history', before: 5 }), NOBODY)).t).toBe('history');
    });

    it('caps stored characters per room', async () => {
      const store = new MemoryRoomStore();
      const core = new RoomCore(store, now);
      core.initialize({ code: 'ABCDEF', speakerTokenHash: await hashToken(SPEAKER_TOKEN), correctorTokenHash: 'x' });
      const room = store.loadRoom();
      if (!room) throw new Error('no room');
      store.saveRoom({ ...room, chars: LIMITS.maxRoomChars - 3 });
      const fresh = new RoomCore(store, now);
      const { conn } = await join(fresh, 's', 'speaker');
      expect(first(await speak(fresh, conn, 'a', 'Hi.'))).toMatchObject({ t: 'final' });
      expect(first(await speak(fresh, conn, 'b', 'More.'))).toMatchObject({ code: 'room-full' });
      expect(fresh.createdAt()).toBe(store.loadRoom()?.meta.createdAt);
    });

    it('strips control and bidi characters from captions and titles', async () => {
      expect(cleanText('a\n\n2\n00:00 --> 99:00\nFAKE')).toBe('a 2 00:00 --> 99:00 FAKE');
      expect(cleanText('‮evil‬ title\t')).toBe('evil title');
      const { core } = await makeRoom();
      const { conn } = await join(core, 's', 'speaker');
      const out = await speak(core, conn, 'a', 'line one\r\nline two');
      expect(first(out)).toMatchObject({ seg: { text: 'line one line two' } });
    });

    it('only computes presence for hello', async () => {
      const { core } = await makeRoom();
      let calls = 0;
      const lazy = () => {
        calls++;
        return NOBODY;
      };
      const { conn } = await join(core, 's', 'speaker');
      await core.handleFrame(conn, frame({ t: 'partial', id: 'a', text: 'x' }), lazy);
      expect(calls).toBe(0);
      await core.handleFrame({ id: 'n', role: null }, frame({ t: 'hello', role: 'listener' }), lazy);
      expect(calls).toBe(1);
    });

    it('counts presence', () => {
      expect(
        countPresence([
          { id: '1', role: 'listener' },
          { id: '2', role: 'listener' },
          { id: '3', role: 'corrector' },
          { id: '4', role: 'speaker' },
          { id: '5', role: null },
        ]),
      ).toEqual({ listeners: 2, correctors: 1, speaker: true });
    });
  });
});
