/**
 * Saybeam Worker: a tiny HTTP API plus WebSocket routing. Static files
 * (the PWA) are served by Workers Static Assets before this code runs.
 */
import { generateRoomCode, generateToken, hashToken, isValidRoomCode, type CreateRoomResponse, type ServerInfo } from '@saybeam/protocol';
import { parseCreateRoom } from '@saybeam/protocol/schema';
import type { Env } from './env';
import { clientKey } from './client-key';

export { Room } from './room';

const MAX_BODY_BYTES = 4096;
const CREATE_ATTEMPTS = 5;

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

let warnedNoLimiter = false;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    let route = 'other';
    try {
      if (pathname === '/api/info' && request.method === 'GET') return info(env);
      if (pathname === '/api/rooms' && request.method === 'POST') {
        route = 'create';
        return await createRoom(request, env);
      }

      const roomMatch = /^\/api\/rooms\/([^/]+)$/.exec(pathname);
      if (roomMatch && request.method === 'GET') {
        route = 'describe';
        return await describeRoom(request, roomMatch[1] ?? '', env);
      }

      const wsMatch = /^\/ws\/([^/]+)$/.exec(pathname);
      if (wsMatch) {
        route = 'ws';
        return await connect(request, wsMatch[1] ?? '', env);
      }

      if (pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
      return env.ASSETS.fetch(request);
    } catch (err) {
      // Log the route, not the path: room codes are listener credentials.
      console.error('worker: unhandled error', { route, error: String(err) });
      return json({ error: 'Something went wrong. Please try again.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

function info(env: Env): Response {
  const body: ServerInfo = { mode: 'cloud', version: env.APP_VERSION ?? '0.0.0', publicBase: null, localModels: false };
  return json(body);
}

async function limited(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) {
    if (!warnedNoLimiter) console.warn('worker: rate limit binding missing; requests are not rate limited');
    warnedNoLimiter = true;
    return false;
  }
  const { success } = await limiter.limit({ key });
  return !success;
}

async function readLimitedText(request: Request, max: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

async function createRoom(request: Request, env: Env): Promise<Response> {
  // Requiring JSON forces a CORS preflight, so other sites cannot create rooms from a visitor's browser.
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return json({ error: 'Send JSON (content-type: application/json).' }, 415);
  }
  if (await limited(env.CREATE_LIMITER, `create:${clientKey(request.headers.get('cf-connecting-ip'))}`)) {
    return json({ error: 'Too many rooms created from this network. Wait a minute and try again.' }, 429);
  }
  const raw = await readLimitedText(request, MAX_BODY_BYTES);
  if (raw === null) return json({ error: 'Request too large.' }, 413);
  let body: unknown = {};
  if (raw.trim()) {
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'Body must be JSON.' }, 400);
    }
  }
  const parsed = parseCreateRoom(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const { private: isPrivate, ...options } = parsed.value;
  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
    const code = generateRoomCode();
    const speakerToken = generateToken();
    const correctorToken = generateToken();
    const listenerToken = isPrivate ? generateToken() : undefined;
    const created = await env.ROOMS.getByName(code).init({
      code,
      speakerTokenHash: await hashToken(speakerToken),
      correctorTokenHash: await hashToken(correctorToken),
      ...(listenerToken ? { listenerTokenHash: await hashToken(listenerToken) } : {}),
      ...options,
    });
    if (created) {
      const res: CreateRoomResponse = { code, speakerToken, correctorToken, ...(listenerToken ? { listenerToken } : {}) };
      return json(res, 201);
    }
  }
  console.error('worker: could not allocate a room code');
  return json({ error: 'Could not allocate a room code. Please try again.' }, 503);
}

async function describeRoom(request: Request, code: string, env: Env): Promise<Response> {
  if (await limited(env.JOIN_LIMITER, `join:${clientKey(request.headers.get('cf-connecting-ip'))}`)) {
    return json({ error: 'Too many requests from this network. Wait a minute and try again.' }, 429);
  }
  if (!isValidRoomCode(code)) return json({ error: 'No room with that code.' }, 404);
  const summary = await env.ROOMS.getByName(code).describe();
  return summary ? json(summary) : json({ error: 'No room with that code.' }, 404);
}

async function connect(request: Request, code: string, env: Env): Promise<Response> {
  if (request.method !== 'GET' || request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected a WebSocket upgrade', { status: 426 });
  }
  if (await limited(env.JOIN_LIMITER, `join:${clientKey(request.headers.get('cf-connecting-ip'))}`)) {
    return new Response('Too many connections from this network', { status: 429 });
  }
  if (!isValidRoomCode(code)) return new Response('Room not found', { status: 404 });
  return env.ROOMS.getByName(code).fetch(request);
}
