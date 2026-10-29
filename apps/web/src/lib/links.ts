import { normalizeRoomCode } from '@caption-room/protocol';
import { paths } from './router';

/** The audience link: a private room's QR carries the listener secret in the fragment (never sent to servers). */
export function audienceUrl(base: string, code: string, listenerToken: string | undefined): string {
  return `${base}${paths.listen(code)}${listenerToken ? `#k=${listenerToken}` : ''}`;
}

/** What to show on screen for the audience link: never the secret. */
export function audienceDisplay(base: string, code: string, isPrivate: boolean): string {
  return `${base.replace(/^https?:\/\//, '')}${paths.listen(code)}${isPrivate ? ' (private link)' : ''}`;
}

export type JoinInput = { readonly kind: 'link'; readonly path: string } | { readonly kind: 'code'; readonly code: string } | { readonly kind: 'invalid' };

/**
 * Interpret what someone typed or pasted into the join box: a room code
 * ("abc-234"), or a full listener link, possibly with a trailing slash, a query
 * string and a private room's #k= secret.
 */
export function parseJoinInput(input: string): JoinInput {
  const text = input.trim();
  const link = /\/r\/([A-Za-z0-9]{6})\/?(?:\?[^#]*)?(#.*)?$/.exec(text);
  const linkCode = link?.[1] ? normalizeRoomCode(link[1]) : null;
  if (linkCode) {
    const hash = link?.[2] ?? '';
    // Keep only a well-formed secret fragment.
    const k = new URLSearchParams(hash.slice(1)).get('k');
    return { kind: 'link', path: `${paths.listen(linkCode)}${k && /^[A-Za-z0-9_-]{16,128}$/.test(k) ? `#k=${k}` : ''}` };
  }
  const code = normalizeRoomCode(text);
  return code ? { kind: 'code', code } : { kind: 'invalid' };
}
