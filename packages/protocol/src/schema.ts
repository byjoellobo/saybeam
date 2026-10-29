/**
 * Runtime validation for frames coming from untrusted clients.
 * Kept in its own entry point so the listener bundle does not pull in zod.
 */
import { z } from 'zod';
import { LIMITS, type ClientMsg, type CreateRoomRequest } from './messages';

const id = z
  .string()
  .min(1)
  .max(LIMITS.maxIdChars)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const text = z.string().max(LIMITS.maxTextChars);
const ms = z
  .number()
  .int()
  .min(0)
  .max(1000 * 60 * 60 * 72);
const role = z.enum(['speaker', 'listener', 'corrector']);
const lang = z
  .string()
  .min(2)
  .max(LIMITS.maxLangChars)
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/);
const title = z.string().max(LIMITS.maxTitleChars);

export const clientMsgSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    role,
    token: z.string().min(16).max(128).optional(),
    since: z.number().int().min(0).optional(),
    v: z.number().int().min(1).optional(),
  }),
  z.object({ t: z.literal('partial'), id, text }),
  z.object({ t: z.literal('final'), id, text, startMs: ms.optional(), endMs: ms.optional() }),
  z.object({ t: z.literal('correct'), seq: z.number().int().min(1), text }),
  z.object({ t: z.literal('meta'), title: title.optional(), lang: lang.optional(), allowExport: z.boolean().optional() }),
  z.object({ t: z.literal('status'), status: z.enum(['live', 'paused']) }),
  z.object({ t: z.literal('history'), before: z.number().int().min(1), limit: z.number().int().min(1).max(LIMITS.historyPage).optional() }),
  z.object({ t: z.literal('end') }),
  z.object({ t: z.literal('ping'), ts: z.number() }),
  z.object({ t: z.literal('rotate'), target: z.enum(['corrector', 'listener']) }),
]);

export const createRoomSchema = z.object({
  title: title.optional(),
  lang: lang.optional(),
  allowExport: z.boolean().optional(),
  private: z.boolean().optional(),
});

export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** Parse a raw WebSocket frame into a validated client message. */
export function parseClientFrame(raw: string | ArrayBuffer): ParseResult<ClientMsg> {
  if (typeof raw !== 'string') return { ok: false, error: 'binary frames are not supported' };
  if (raw.length > LIMITS.maxFrameBytes) return { ok: false, error: 'frame too large' };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'frame is not valid JSON' };
  }
  const result = clientMsgSchema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    return { ok: false, error: first ? `${first.path.join('.') || 'frame'}: ${first.message}` : 'invalid frame' };
  }
  return { ok: true, value: result.data as ClientMsg };
}

export function parseCreateRoom(data: unknown): ParseResult<CreateRoomRequest> {
  const result = createRoomSchema.safeParse(data ?? {});
  if (!result.success) return { ok: false, error: result.error.issues[0]?.message ?? 'invalid request' };
  return { ok: true, value: result.data };
}
