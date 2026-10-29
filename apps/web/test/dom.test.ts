// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { ApiError, createRoom, describeRoom, fetchInfo, publicBase } from '../src/lib/api';
import { copyText, downloadText, qrSvg, safeFilename, useReconnectNudges, useWakeLock } from '../src/lib/browser';
import { forgetRoom, getSavedRoom, listSavedRooms, loadListenerPrefs, loadSpeakerPrefs, saveListenerPrefs, saveRoom, saveSpeakerPrefs, DEFAULT_LISTENER_PREFS, DEFAULT_SPEAKER_PREFS } from '../src/lib/storage';
import { loadResults, storeResults, type BenchResult } from '../src/lib/bench';
import { navigate, useRoute, type Route } from '../src/lib/router';
import { useRoom } from '../src/lib/use-room';
import { RoomClient } from '../src/lib/room-client';

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('api', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates and describes rooms and surfaces server errors', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/rooms' && init?.method === 'POST') return jsonResponse({ code: 'ABCDEF', speakerToken: 's', correctorToken: 'c' }, 201);
      if (url === '/api/rooms/ABCDEF') return jsonResponse({ code: 'ABCDEF', status: 'live', title: 'T' });
      if (url === '/api/rooms/ZZZZZZ') return jsonResponse({ error: 'No room with that code.' }, 404);
      return new Response('not json', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(createRoom({ title: 'T' })).resolves.toMatchObject({ code: 'ABCDEF' });
    await expect(describeRoom('ABCDEF')).resolves.toMatchObject({ status: 'live' });
    await expect(describeRoom('ZZZZZZ')).rejects.toMatchObject({ status: 404, message: 'No room with that code.' });
    const err = await describeRoom('BROKEN').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toMatch(/500/);
  });

  it('reports network failures in plain words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    await expect(describeRoom('ABCDEF')).rejects.toMatchObject({ status: 0, message: expect.stringMatching(/Could not reach/) });
  });

  it('falls back to cloud info when /api/info fails, and builds public links', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    const info = await fetchInfo();
    expect(info.mode).toBe('cloud');
    expect(publicBase({ mode: 'lan', version: '1', publicBase: 'http://10.0.0.5:7300/', localModels: true })).toBe('http://10.0.0.5:7300');
    expect(publicBase(null)).toBe(location.origin);
  });
});

describe('storage', () => {
  beforeEach(() => localStorage.clear());

  it('saves, lists, finds and forgets rooms', () => {
    saveRoom({ code: 'AAAAAA', speakerToken: 's1', correctorToken: 'c1', title: 'One', createdAt: 1 });
    saveRoom({ code: 'BBBBBB', speakerToken: 's2', correctorToken: 'c2', title: 'Two', createdAt: 2 });
    saveRoom({ code: 'AAAAAA', speakerToken: 's1b', correctorToken: 'c1', title: 'One again', createdAt: 3 });
    expect(listSavedRooms().map((r) => r.code)).toEqual(['AAAAAA', 'BBBBBB']);
    expect(getSavedRoom('AAAAAA')?.speakerToken).toBe('s1b');
    forgetRoom('AAAAAA');
    expect(getSavedRoom('AAAAAA')).toBeNull();
    localStorage.setItem('caption-room:rooms', '{bad json');
    expect(listSavedRooms()).toEqual([]);
  });

  it('round-trips listener and speaker prefs and never stores API keys', () => {
    expect(loadListenerPrefs()).toEqual(DEFAULT_LISTENER_PREFS);
    saveListenerPrefs({ ...DEFAULT_LISTENER_PREFS, fontSize: 60, theme: 'yellow' });
    expect(loadListenerPrefs()).toMatchObject({ fontSize: 60, theme: 'yellow' });

    expect(loadSpeakerPrefs()).toEqual(DEFAULT_SPEAKER_PREFS);
    saveSpeakerPrefs({ ...DEFAULT_SPEAKER_PREFS, replacements: 'a => b', engine: { kind: 'whisperlive', url: 'ws://x:9090', model: 'small', language: 'en', apiKey: 'secret' } });
    expect(localStorage.getItem('caption-room:speaker-prefs')).not.toContain('secret');
    expect(loadSpeakerPrefs().engine).toMatchObject({ kind: 'whisperlive', url: 'ws://x:9090' });

    saveSpeakerPrefs({ ...DEFAULT_SPEAKER_PREFS, engine: { kind: 'local', modelId: 'moonshine-tiny', device: 'wasm', language: null, partials: false, micId: 'm1' } });
    expect(loadSpeakerPrefs().engine).toMatchObject({ kind: 'local', device: 'wasm', partials: false, micId: 'm1' });
    saveSpeakerPrefs({ ...DEFAULT_SPEAKER_PREFS, engine: { kind: 'webspeech', lang: 'hi-IN', onDevice: true, phrases: ['IIT'] } });
    expect(loadSpeakerPrefs().engine).toMatchObject({ kind: 'webspeech', lang: 'hi-IN', onDevice: true, phrases: ['IIT'] });
    localStorage.setItem('caption-room:speaker-prefs', JSON.stringify({ engine: { kind: 'evil' }, replacements: 7 }));
    expect(loadSpeakerPrefs()).toEqual(DEFAULT_SPEAKER_PREFS);
  });

  it('stores bench results and ignores corrupt data', () => {
    storeResults([{ id: 'r1' } as BenchResult]);
    expect(loadResults().map((r) => r.id)).toEqual(['r1']);
    localStorage.setItem('caption-room:bench-results', 'nope');
    expect(loadResults()).toEqual([]);
  });
});

describe('browser helpers', () => {
  it('builds safe filenames and QR SVGs', () => {
    expect(safeFilename('Physics: Class 11/B!')).toBe('Physics-Class-11B');
    expect(safeFilename('***')).toBe('captions');
    expect(qrSvg('http://example.org/r/ABCDEF')).toMatch(/^<svg/);
  });

  it('downloads text through a temporary link', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    downloadText('a.txt', 'hello', 'text/plain');
    expect(click).toHaveBeenCalledOnce();
    click.mockRestore();
  });

  it('copies text and reports failure', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
    expect(await copyText('x')).toBe(true);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) }, configurable: true });
    expect(await copyText('x')).toBe(false);
  });

  it('holds a wake lock while active and nudges on online/visible', async () => {
    const release = vi.fn(async () => undefined);
    const request = vi.fn(async () => ({ release }));
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
    const nudge = vi.fn();
    const root = document.createElement('div');
    function Probe({ active }: { active: boolean }) {
      useWakeLock(active);
      useReconnectNudges(nudge);
      return null;
    }
    await act(async () => render(h(Probe, { active: true }), root));
    expect(request).toHaveBeenCalledWith('screen');
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(nudge).toHaveBeenCalled();
    await act(async () => render(null, root));
    expect(release).toHaveBeenCalled();
  });
});

describe('router hook', () => {
  it('follows navigate() and back/forward', async () => {
    const seen: Route[] = [];
    function Probe() {
      seen.push(useRoute());
      return null;
    }
    const root = document.createElement('div');
    history.replaceState(null, '', '/');
    await act(async () => render(h(Probe, null), root));
    await act(async () => navigate('/r/ABC234'));
    await act(async () => navigate('/bench', true));
    expect(seen.map((r) => r.name)).toEqual(['home', 'listen', 'bench']);
    await act(async () => render(null, root));
  });
});

class FakeWs {
  static last: FakeWs | null = null;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(readonly url: string) {
    FakeWs.last = this;
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
}

describe('useRoom and loadAll', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('connects a client for the component lifetime', async () => {
    vi.stubGlobal('WebSocket', FakeWs);
    const states: string[] = [];
    function Probe() {
      const { snap } = useRoom({ code: 'ABCDEF', role: 'listener' });
      states.push(snap.connection);
      return null;
    }
    const root = document.createElement('div');
    await act(async () => render(h(Probe, null), root));
    expect(FakeWs.last?.url).toMatch(/\/ws\/ABCDEF$/);
    await act(async () => render(null, root));
    expect(states).toContain('connecting');
  });

  it('pages in older history until nothing is left', async () => {
    let socket: { sent: string[]; deliver: (m: unknown) => void } | null = null;
    const client = new RoomClient({
      code: 'ABCDEF',
      role: 'speaker',
      token: 'token-token-token-token',
      wsBase: 'ws://t',
      socketFactory: () => {
        const s = {
          readyState: 1,
          sent: [] as string[],
          send(d: string) {
            this.sent.push(d);
            const msg = JSON.parse(d) as { t: string; before?: number };
            if (msg.t === 'history') {
              const before = msg.before ?? 1;
              const seg = { seq: before - 1, id: `i${before - 1}`, text: 'x', ts: 0, rev: 1 };
              queueMicrotask(() => s.onmessage?.({ data: JSON.stringify({ t: 'history', segments: [seg], hasMore: before - 1 > 1 }) }));
            }
          },
          close() {},
          onopen: null as null | ((e: unknown) => void),
          onmessage: null as null | ((e: { data: unknown }) => void),
          onclose: null,
          onerror: null,
          deliver: (m: unknown) => s.onmessage?.({ data: JSON.stringify(m) }),
        };
        socket = s;
        return s;
      },
      storage: null,
    });
    client.connect();
    const s = socket as unknown as { onopen: (e: unknown) => void; deliver: (m: unknown) => void };
    s.onopen({});
    s.deliver({ t: 'welcome', v: 1, room: 'ABCDEF', role: 'speaker', meta: { title: '', lang: 'en', allowExport: true, createdAt: 0 }, status: 'live', mode: 'replace', segments: [{ seq: 4, id: 'i4', text: 'x', ts: 0, rev: 1 }], partial: null, hasMore: true, rev: 1, presence: { listeners: 0, correctors: 0, speaker: true }, serverTime: 0 });
    await client.loadAll();
    expect(client.snapshot.view.segments.map((x) => x.seq)).toEqual([1, 2, 3, 4]);
    expect(client.snapshot.view.hasMore).toBe(false);
    client.close();
  });
});
