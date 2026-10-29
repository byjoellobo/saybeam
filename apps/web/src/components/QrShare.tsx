import { useMemo, useState } from 'preact/hooks';
import { formatRoomCode } from '@caption-room/protocol';
import { copyText, qrSvg } from '../lib/browser';

interface QrShareProps {
  readonly code: string;
  readonly url: string;
  readonly title?: string;
  readonly large?: boolean;
}

export function QrShare({ code, url, title, large }: QrShareProps) {
  const svg = useMemo(() => qrSvg(url), [url]);
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator.share === 'function';
  return (
    <div class={`qr-share${large ? ' qr-large' : ''}`}>
      {/* The SVG is generated locally from our own URL, never from user HTML. */}
      <div class="qr" role="img" aria-label={`QR code for ${url}`} dangerouslySetInnerHTML={{ __html: svg }} />
      <div class="qr-meta">
        <div class="qr-code-label">Room code</div>
        <div class="room-code" aria-label={`Room code ${code.split('').join(' ')}`}>
          {formatRoomCode(code)}
        </div>
        <div class="qr-url">{url.replace(/^https?:\/\//, '')}</div>
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
            <button type="button" class="btn btn-small" onClick={() => navigator.share({ title: title || 'Live captions', text: 'Follow the live captions on your phone', url }).catch(() => undefined)}>
              Share
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
