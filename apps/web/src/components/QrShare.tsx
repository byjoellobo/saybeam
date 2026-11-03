import { useMemo, useState } from 'preact/hooks';
import { formatRoomCode } from '@saybeam/protocol';
import { copyText, qrSvg } from '../lib/browser';

interface QrShareProps {
  readonly code: string;
  /** Full link (may carry a private room's secret in the fragment). */
  readonly url: string;
  /** What to show on screen instead of the full link. */
  readonly displayUrl?: string;
  readonly title?: string;
  readonly large?: boolean;
  /** False for private rooms: the code alone does not let anyone in. */
  readonly codeAlone?: boolean;
}

export function QrShare({ code, url, displayUrl, title, large, codeAlone = true }: QrShareProps) {
  const svg = useMemo(() => qrSvg(url), [url]);
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator.share === 'function';
  return (
    <div class={`qr-share${large ? ' qr-large' : ''}`}>
      {/* The SVG is generated locally from our own URL, never from user HTML. */}
      {/* The label uses the display text: a private room's URL carries a secret that must not be read aloud. */}
      <div class="qr" role="img" aria-label={`QR code to join: ${displayUrl ?? url.replace(/^https?:\/\//, '').replace(/#.*$/, '')}`} dangerouslySetInnerHTML={{ __html: svg }} />
      <div class="qr-meta">
        <div class="qr-code-label">{codeAlone ? 'Room code' : 'Room code (QR or link needed)'}</div>
        <div class="room-code">
          <span aria-hidden="true">{formatRoomCode(code)}</span>
          {/* Screen readers spell the code out letter by letter. */}
          <span class="sr-only">{code.split('').join(' ')}</span>
        </div>
        <div class="qr-url">{displayUrl ?? url.replace(/^https?:\/\//, '')}</div>
        <div class="row gap-sm wrap">
          <button
            type="button"
            class="btn btn-small"
            onClick={async () => {
              setCopied(await copyText(url));
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
          {canShare && (
            <button
              type="button"
              class="btn btn-small"
              onClick={() => navigator.share({ title: title || 'Live captions', text: 'Follow the live captions on your phone', url }).catch(() => undefined)}
            >
              Share
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
