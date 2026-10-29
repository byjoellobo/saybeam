#!/usr/bin/env node
/**
 * Simulated speaker (and optional crowd of listeners) for demos and load tests.
 *
 *   node scripts/demo-speaker.mjs [baseUrl] [--listeners 200] [--loops 1] [--wpm 150]
 *
 * Creates a room, prints the listener link, then "speaks" a short lecture with
 * partial and final captions at a realistic pace. With --listeners N it opens
 * N extra WebSocket listeners and reports fan-out latency (speaker send to
 * listener receive) at the end, which is the number to watch for big halls.
 */
import WebSocket from 'ws';

const args = process.argv.slice(2);
const base = (args.find((a) => /^https?:\/\//.test(a)) ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const crowd = opt('listeners', 0);
const loops = opt('loops', 1);
const wpm = opt('wpm', 150);
const wsBase = base.replace(/^http/, 'ws');

const LECTURE = [
  'Good morning, everyone, and welcome back.',
  'Today we are going to talk about how sound travels through air.',
  'When I speak, my vocal cords vibrate and push the air molecules around them.',
  'Those molecules bump into their neighbours, and the wave moves outward.',
  'In air at room temperature, sound travels at roughly three hundred and forty metres per second.',
  'That is why you see lightning before you hear the thunder.',
  'Can everyone at the back hear me clearly?',
  'If not, open the captions on your phone and follow along there.',
  'Next, let us look at what happens when sound hits a wall.',
  'Some of it is absorbed, and some of it bounces back as an echo.',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const latencies = [];

function openSocket(code) {
  const ws = new WebSocket(`${wsBase}/ws/${code}`);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function main() {
  const res = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Demo lecture: how sound travels', lang: 'en-IN' }) });
  if (!res.ok) throw new Error(`could not create room: ${res.status} ${await res.text()}`);
  const room = await res.json();
  console.log(`Room ${room.code}`);
  console.log(`Listen:   ${base}/r/${room.code}`);
  console.log(`Corrector: ${base}/fix/${room.code}#${room.correctorToken}`);

  const speaker = await openSocket(room.code);
  speaker.send(JSON.stringify({ t: 'hello', role: 'speaker', token: room.speakerToken }));

  const listeners = [];
  for (let i = 0; i < crowd; i++) {
    const ws = await openSocket(room.code);
    ws.send(JSON.stringify({ t: 'hello', role: 'listener' }));
    ws.on('message', (data) => {
      const text = data.toString();
      if (!text.startsWith('{')) return;
      const msg = JSON.parse(text);
      if (msg.t === 'final') {
        const sentAt = Number(msg.seg.id.split('-').pop());
        if (Number.isFinite(sentAt)) latencies.push(Date.now() - sentAt);
      }
    });
    listeners.push(ws);
  }
  if (crowd) console.log(`${crowd} simulated listeners connected`);
  console.log('Speaking... (open the listen link now)');
  await sleep(crowd ? 2000 : 4000);

  const msPerWord = 60_000 / wpm;
  let n = 0;
  for (let loop = 0; loop < loops; loop++) {
    for (const sentence of LECTURE) {
      const words = sentence.split(' ');
      const key = `demo${n++}`;
      for (let w = 1; w < words.length; w++) {
        speaker.send(JSON.stringify({ t: 'partial', id: `${key}-p`, text: words.slice(0, w).join(' ').toLowerCase() }));
        await sleep(msPerWord);
      }
      // The send time rides in the id so listeners can measure fan-out latency.
      speaker.send(JSON.stringify({ t: 'final', id: `${key}-${Date.now()}`, text: sentence }));
      speaker.send(JSON.stringify({ t: 'partial', id: `${key}-p`, text: '' }));
      await sleep(600);
    }
  }
  await sleep(1500);

  if (latencies.length) {
    const sorted = [...latencies].sort((a, b) => a - b);
    const pick = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
    console.log(`Fan-out latency over ${sorted.length} deliveries: p50 ${pick(50)} ms, p95 ${pick(95)} ms, max ${sorted[sorted.length - 1]} ms`);
  }
  console.log(`Done. Room ${room.code} stays open for 24 hours.`);
  for (const ws of listeners) ws.close();
  speaker.close();
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
