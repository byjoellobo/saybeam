import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import WebSocket from 'ws';

/**
 * Each test (and each retry) looks like a different client network, so the
 * Worker's per-network room-creation limit (10 a minute) cannot make the suite
 * flaky. Only local wrangler dev honours this header: in production Cloudflare
 * sets cf-connecting-ip itself and clients cannot override it.
 */
export const test = base.extend({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures must destructure their first argument
  extraHTTPHeaders: async ({}, use, testInfo) => {
    let h = testInfo.retry * 7919;
    for (const ch of testInfo.testId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    await use({ 'cf-connecting-ip': `198.18.${(h >>> 8) % 256}.${(h % 254) + 1}` });
  },
});

export { expect };

export interface Room {
  readonly code: string;
  readonly speakerToken: string;
  readonly correctorToken: string;
  readonly listenerToken?: string;
}

export async function createRoom(request: APIRequestContext, body: Record<string, unknown> = {}): Promise<Room> {
  const res = await request.post('/api/rooms', { data: { title: 'E2E lecture', lang: 'en-IN', ...body } });
  expect(res.status()).toBe(201);
  return (await res.json()) as Room;
}

/** A scripted speaker (or corrector) connection, standing in for a real microphone. */
export class ScriptedClient {
  private constructor(
    private readonly ws: WebSocket,
    private readonly inbox: Array<Record<string, unknown>>,
  ) {}

  static async connect(baseURL: string, code: string, role: 'speaker' | 'corrector', token: string): Promise<ScriptedClient> {
    const ws = new WebSocket(`${baseURL.replace(/^http/, 'ws')}/ws/${code}`);
    const inbox: Array<Record<string, unknown>> = [];
    ws.on('message', (data) => {
      const text = data.toString();
      if (text.startsWith('{')) inbox.push(JSON.parse(text) as Record<string, unknown>);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const client = new ScriptedClient(ws, inbox);
    client.send({ t: 'hello', role, token });
    await client.waitFor((m) => m.t === 'welcome');
    return client;
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Say a sentence the way an engine would: growing partials, then a final. */
  async say(id: string, text: string): Promise<void> {
    const words = text.split(' ');
    for (let i = 1; i < words.length; i++) {
      this.send({ t: 'partial', id, text: words.slice(0, i).join(' ') });
      await new Promise((r) => setTimeout(r, 120));
    }
    this.send({ t: 'final', id, text });
    await this.waitFor((m) => m.t === 'final' && (m.seg as { id?: string })?.id === id);
  }

  async waitFor(pred: (m: Record<string, unknown>) => boolean, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const start = Date.now();
    for (;;) {
      const i = this.inbox.findIndex(pred);
      if (i >= 0) return this.inbox.splice(i, 1)[0] as Record<string, unknown>;
      if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for a server message');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  close(): void {
    this.ws.close();
  }
}

/** Fail on serious or critical WCAG 2.1 AA problems. */
export async function expectAccessible(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`),
    `${label} has accessibility violations`,
  ).toEqual([]);
}
