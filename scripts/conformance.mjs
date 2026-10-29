#!/usr/bin/env node
/**
 * Protocol conformance check. Drives a live server through the scenarios in
 * docs/protocol.md and reports pass/fail. Works against both implementations:
 *
 *   node scripts/conformance.mjs http://127.0.0.1:8787   # wrangler dev (Durable Object)
 *   node scripts/conformance.mjs http://127.0.0.1:7300   # Rust LAN relay
 */
import WebSocket from 'ws';

const base = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const wsBase = base.replace(/^http/, 'ws');
let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

function client(code) {
  const ws = new WebSocket(`${wsBase}/ws/${code}`);
  const inbox = [];
  const waiters = [];
  let closeInfo = null;
  const closed = new Promise((resolve) => {
    ws.on('close', (c, r) => {
      closeInfo = { code: c, reason: r.toString() };
      resolve(closeInfo);
    });
  });
  ws.on('message', (data) => {
    const text = data.toString();
    const msg = text === 'pong' ? { t: '__pong' } : JSON.parse(text);
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  return {
    ws,
    opened,
    closed,
    get closeInfo() {
      return closeInfo;
    },
    send: (obj) => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)),
    /** Resolve with the first message matching pred, or null after timeout. */
    next(pred = () => true, timeout = 3000) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          const j = waiters.indexOf(w);
          if (j >= 0) {
            waiters.splice(j, 1);
            resolve(null);
          }
        }, timeout);
      });
    },
    drain: () => inbox.splice(0, inbox.length),
    close: () => ws.close(),
  };
}

const byType = (t) => (m) => m.t === t;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Conformance against ${base}`);

  const info = await fetch(`${base}/api/info`).then((r) => r.json());
  check('GET /api/info has mode and version', ['cloud', 'lan'].includes(info.mode) && typeof info.version === 'string', JSON.stringify(info));

  const bad = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x'.repeat(200) }) });
  check('POST /api/rooms rejects a 200-char title', bad.status === 400, `status ${bad.status}`);

  const res = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Conformance', lang: 'en-IN' }) });
  const room = await res.json();
  check('POST /api/rooms creates a room', res.status === 201 && /^[A-HJ-KM-NP-Z2-9]{6}$/.test(room.code), JSON.stringify(room));
  check('tokens are 43-char base64url', /^[A-Za-z0-9_-]{43}$/.test(room.speakerToken) && /^[A-Za-z0-9_-]{43}$/.test(room.correctorToken));

  const summary = await fetch(`${base}/api/rooms/${room.code}`);
  const summaryBody = await summary.json();
  check('GET /api/rooms/:code describes the room', summary.status === 200 && summaryBody.title === 'Conformance' && summaryBody.status === 'live', JSON.stringify(summaryBody));
  check('GET /api/rooms/:code is 404 for an unknown code', (await fetch(`${base}/api/rooms/ZZZZZZ`)).status === 404);

  const badWs = client('NOPE0');
  const badResult = await badWs.opened.then(
    () => 'opened',
    (e) => e.message,
  );
  check('WS to an invalid code is refused', badResult !== 'opened', badResult);

  // Speaker joins.
  const speaker = client(room.code);
  await speaker.opened;
  speaker.send({ t: 'partial', id: 'x', text: 'too early' });
  const early = await speaker.next(byType('error'));
  check('frames before hello get hello-required', early?.code === 'hello-required', JSON.stringify(early));
  speaker.send({ t: 'hello', role: 'speaker', token: room.speakerToken });
  const sw = await speaker.next(byType('welcome'));
  check('speaker gets welcome', sw?.role === 'speaker' && sw.mode === 'replace' && sw.rev === 0 && sw.meta?.lang === 'en-IN', JSON.stringify(sw));

  // Listener joins.
  const listener = client(room.code);
  await listener.opened;
  listener.send({ t: 'hello', role: 'listener' });
  const lw = await listener.next(byType('welcome'));
  check('listener welcome counts itself and sees the speaker', lw?.presence?.listeners === 1 && lw.presence.speaker === true, JSON.stringify(lw?.presence));

  listener.send('ping');
  check('literal ping gets literal pong', (await listener.next(byType('__pong'))) !== null);
  listener.send({ t: 'ping', ts: 123 });
  const pong = await listener.next(byType('pong'));
  check('json ping gets pong with serverTime', pong?.ts === 123 && typeof pong.serverTime === 'number');

  // Partial and final fan-out.
  speaker.drain();
  speaker.send({ t: 'partial', id: 'seg-1', text: 'good morn' });
  const lp = await listener.next(byType('partial'));
  check('listener receives partial', lp?.text === 'good morn' && lp.id === 'seg-1', JSON.stringify(lp));
  check('speaker does not receive its own partial', (await speaker.next(byType('partial'), 400)) === null);

  speaker.send({ t: 'final', id: 'seg-1', text: ' Good morning, everyone. ', startMs: 0, endMs: 1800 });
  const lf = await listener.next(byType('final'));
  const sf = await speaker.next(byType('final'));
  check(
    'final reaches listener, trimmed, seq 1 rev 1',
    lf?.seg?.seq === 1 && lf.seg.rev === 1 && lf.seg.text === 'Good morning, everyone.' && lf.seg.startMs === 0,
    JSON.stringify(lf),
  );
  check('final reaches speaker too', sf?.seg?.seq === 1);

  speaker.send({ t: 'final', id: 'seg-1', text: 'resent after reconnect' });
  const dup = await speaker.next(byType('final'));
  check('duplicate final id returns stored copy to sender', dup?.seg?.seq === 1 && dup.seg.text === 'Good morning, everyone.', JSON.stringify(dup));
  check('duplicate final is not rebroadcast', (await listener.next(byType('final'), 400)) === null);

  listener.send({ t: 'final', id: 'evil', text: 'hijack' });
  check('listener cannot send finals', (await listener.next(byType('error')))?.code === 'forbidden');

  // Corrector auth.
  const intruder = client(room.code);
  await intruder.opened;
  intruder.send({ t: 'hello', role: 'corrector', token: 'not-the-right-token-at-all' });
  const deny = await intruder.next(byType('error'));
  const denyClose = await Promise.race([intruder.closed, sleep(3000).then(() => null)]);
  check('bad corrector token: unauthorized then close 4003', deny?.code === 'unauthorized' && denyClose?.code === 4003, JSON.stringify({ deny, denyClose }));

  const corrector = client(room.code);
  await corrector.opened;
  corrector.send({ t: 'hello', role: 'corrector', token: room.correctorToken });
  const cw = await corrector.next(byType('welcome'));
  check('corrector joins and sees history', cw?.role === 'corrector' && cw.segments?.length === 1);
  corrector.send({ t: 'correct', seq: 1, text: 'Good morning, everybody.' });
  const lc = await listener.next(byType('correct'));
  check('correction broadcast with new rev', lc?.seq === 1 && lc.text === 'Good morning, everybody.' && lc.rev === 2 && lc.by === 'corrector', JSON.stringify(lc));

  // Resume with since.
  const lastRev = lc?.rev ?? 2;
  listener.close();
  await listener.closed;
  speaker.send({ t: 'final', id: 'seg-2', text: 'Second line.' });
  await speaker.next(byType('final'));
  const back = client(room.code);
  await back.opened;
  back.send({ t: 'hello', role: 'listener', since: lastRev });
  const bw = await back.next(byType('welcome'));
  check('reconnect with since gets append delta', bw?.mode === 'append' && bw.segments?.length === 1 && bw.segments[0].seq === 2, JSON.stringify(bw?.segments));

  back.send({ t: 'history', before: 2, limit: 10 });
  const hist = await back.next(byType('history'));
  check('history returns older segments', hist?.segments?.length === 1 && hist.segments[0].seq === 1 && hist.hasMore === false, JSON.stringify(hist));

  const pres = await speaker.next(byType('presence'), 4000);
  check('speaker receives a presence update', pres?.presence && typeof pres.presence.listeners === 'number', JSON.stringify(pres));

  // Pause clears partial.
  speaker.send({ t: 'partial', id: 'seg-3', text: 'half a thou' });
  await back.next(byType('partial'));
  speaker.send({ t: 'status', status: 'paused' });
  const ps = await back.next(byType('status'));
  const pc = await back.next((m) => m.t === 'partial' && m.text === '');
  check('pause broadcasts status and clears the partial', ps?.status === 'paused' && pc !== null);
  speaker.send({ t: 'status', status: 'live' });
  await back.next(byType('status'));

  // Newest speaker wins.
  const speaker2 = client(room.code);
  await speaker2.opened;
  speaker2.send({ t: 'hello', role: 'speaker', token: room.speakerToken, since: 3 });
  const s2w = await speaker2.next(byType('welcome'));
  const replaced = await Promise.race([speaker.closed, sleep(3000).then(() => null)]);
  check('second speaker joins', s2w?.role === 'speaker');
  check('first speaker is closed with 4001', replaced?.code === 4001, JSON.stringify(replaced));

  // End.
  speaker2.send({ t: 'end' });
  const ended = await back.next(byType('status'));
  check('end broadcasts ended', ended?.status === 'ended');
  speaker2.send({ t: 'final', id: 'seg-9', text: 'after the end' });
  check('finals after end are refused', (await speaker2.next(byType('error')))?.code === 'room-ended');

  speaker2.send('{not json');
  check('malformed JSON gets bad-frame', (await speaker2.next(byType('error')))?.code === 'bad-frame');

  for (const c of [speaker2, back, corrector]) c.close();

  // Private rooms and link rotation.
  const privRes = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Secret', private: true }) });
  const priv = await privRes.json();
  check('private room returns a listener token', privRes.status === 201 && /^[A-Za-z0-9_-]{43}$/.test(priv.listenerToken ?? ''), JSON.stringify(Object.keys(priv)));
  check('public rooms have no listener token', room.listenerToken === undefined);
  const psum = await fetch(`${base}/api/rooms/${priv.code}`).then((r) => r.json());
  check('describe hides a private title', psum.private === true && psum.title === '', JSON.stringify(psum));
  check('describe reports public rooms as not private', summaryBody.private === false, JSON.stringify(summaryBody));

  const stranger = client(priv.code);
  await stranger.opened;
  stranger.send({ t: 'hello', role: 'listener' });
  const sDeny = await stranger.next(byType('error'));
  const sClose = await Promise.race([stranger.closed, sleep(3000).then(() => null)]);
  check('private room refuses a listener without the secret (4003)', sDeny?.code === 'unauthorized' && sClose?.code === 4003, JSON.stringify({ sDeny, sClose }));

  const insider = client(priv.code);
  await insider.opened;
  insider.send({ t: 'hello', role: 'listener', token: priv.listenerToken });
  const iw = await insider.next(byType('welcome'));
  check('private room admits a listener with the secret', iw?.meta?.private === true && iw.meta.title === 'Secret', JSON.stringify(iw?.meta));

  const pspeaker = client(priv.code);
  await pspeaker.opened;
  pspeaker.send({ t: 'hello', role: 'speaker', token: priv.speakerToken });
  await pspeaker.next(byType('welcome'));
  const pcorr = client(priv.code);
  await pcorr.opened;
  pcorr.send({ t: 'hello', role: 'corrector', token: priv.correctorToken });
  await pcorr.next(byType('welcome'));

  pspeaker.send({ t: 'rotate', target: 'corrector' });
  const rot = await pspeaker.next(byType('rotated'));
  const corrClosed = await Promise.race([pcorr.closed, sleep(3000).then(() => null)]);
  check('rotate corrector returns a new secret to the speaker', rot?.target === 'corrector' && /^[A-Za-z0-9_-]{43}$/.test(rot?.token ?? ''), JSON.stringify(rot));
  check('rotate corrector disconnects correctors with 4003', corrClosed?.code === 4003, JSON.stringify(corrClosed));
  const oldCorr = client(priv.code);
  await oldCorr.opened;
  oldCorr.send({ t: 'hello', role: 'corrector', token: priv.correctorToken });
  check('the old corrector link stops working', (await oldCorr.next(byType('error')))?.code === 'unauthorized');

  pspeaker.send({ t: 'rotate', target: 'listener' });
  const lrot = await pspeaker.next(byType('rotated'));
  const insiderClosed = await Promise.race([insider.closed, sleep(3000).then(() => null)]);
  check('rotate listener disconnects listeners with 4003', lrot?.target === 'listener' && insiderClosed?.code === 4003, JSON.stringify({ lrot, insiderClosed }));

  const pubSpeaker = client(room.code);
  await pubSpeaker.opened;
  pubSpeaker.send({ t: 'hello', role: 'speaker', token: room.speakerToken });
  await pubSpeaker.next(byType('welcome'));
  pubSpeaker.send({ t: 'rotate', target: 'listener' });
  check('rotating the listener link of a public room is invalid', (await pubSpeaker.next(byType('error')))?.code === 'invalid');

  for (const c of [pspeaker, oldCorr, pubSpeaker]) c.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('conformance run crashed:', err);
  process.exit(2);
});
