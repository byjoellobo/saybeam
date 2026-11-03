import { useEffect, useRef } from 'preact/hooks';
import { formatRoomCode } from '@saybeam/protocol';
import { qrSvg } from '../lib/browser';
import type { EngineStats, EngineStatus } from '../engines/types';

export function Meter({ level, active }: { readonly level: number; readonly active: boolean }) {
  return (
    <div class={`meter${active ? ' active' : ''}`} aria-hidden="true">
      <div class="meter-fill" style={{ transform: `scaleX(${Math.min(1, level)})` }} />
    </div>
  );
}

export function EngineStatusLine({ status }: { readonly status: EngineStatus }) {
  return (
    <div class={`engine-status phase-${status.phase}`} role="status" aria-live="polite">
      {status.message ?? ''}
      {status.phase === 'loading' && status.progress !== undefined && (
        <progress max={1} value={status.progress} aria-label="Model download progress">
          {Math.round(status.progress * 100)}%
        </progress>
      )}
    </div>
  );
}

interface DiagnosticsProps {
  readonly stats: EngineStats;
  readonly rttMs: number | null;
  readonly pending: number;
  readonly listeners: number;
}

const fmt = (n: number | undefined, unit = '', digits = 0) => (n === undefined ? 'n/a' : `${n.toFixed(digits)}${unit}`);

/** Live numbers for the "latency on low-end devices" risk test. */
export function Diagnostics({ stats, rttMs, pending, listeners }: DiagnosticsProps) {
  const struggling = (stats.rtf ?? 0) > 0.8 || (stats.lagMs ?? 0) > 4000;
  return (
    <div class="diagnostics">
      {struggling && (
        <p class="warn" role="alert">
          This device is falling behind. Try Moonshine Tiny, turn off live partial captions, or switch to the browser speech engine.
        </p>
      )}
      <dl>
        <dt>Engine</dt>
        <dd>{stats.backend ?? 'not started'}</dd>
        <dt>Model load</dt>
        <dd>{stats.loadMs ? `${(stats.loadMs / 1000).toFixed(1)} s` : 'n/a'}</dd>
        <dt>Real-time factor</dt>
        <dd title="Compute time divided by audio length. Below 1 keeps up; below 0.3 is comfortable.">{fmt(stats.rtf, '', 2)}</dd>
        <dt>Last transcription</dt>
        <dd>{fmt(stats.lastAsrMs, ' ms')}</dd>
        <dt>Caption lag</dt>
        <dd title="Time from the end of speech to the final caption.">{fmt(stats.lagMs, ' ms')}</dd>
        <dt>Queue</dt>
        <dd>{fmt(stats.queue)}</dd>
        <dt>Partial updates</dt>
        <dd>{stats.partialEveryMs === undefined ? 'n/a' : stats.partialEveryMs === 0 ? 'paused to keep up' : `every ${stats.partialEveryMs} ms`}</dd>
        <dt>Server round trip</dt>
        <dd>{fmt(rttMs ?? undefined, ' ms')}</dd>
        <dt>Unsent captions</dt>
        <dd>{pending}</dd>
        <dt>Listeners</dt>
        <dd>{listeners}</dd>
      </dl>
    </div>
  );
}

interface PresentProps {
  readonly code: string;
  readonly url: string;
  readonly title: string;
  /** Private rooms: the QR is the way in, so do not invite people to type the code. */
  readonly privateRoom?: boolean;
  readonly onClose: () => void;
}

/** Full-screen QR and code for the projector. */
export function PresentOverlay({ code, url, title, privateRoom = false, onClose }: PresentProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    // Clicking anywhere closes it for convenience at the projector; keyboard users have Escape and the Close button.
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape and the Close button are the keyboard equivalents
    <div class="present" role="dialog" aria-modal="true" aria-label="Join instructions" onClick={onClose}>
      <button type="button" class="present-close" ref={closeRef} onClick={onClose}>
        Close
      </button>
      <div class="present-inner">
        {title && <h2>{title}</h2>}
        <p class="present-lede">Live captions on your phone</p>
        <div class="present-qr" dangerouslySetInnerHTML={{ __html: qrSvg(url) }} />
        {privateRoom ? (
          <p class="present-code">Scan the code to join</p>
        ) : (
          <>
            <p class="present-url">{url.replace(/^https?:\/\//, '').replace(/\/r\/.*$/, '')}</p>
            <p class="present-code">
              Code <strong>{formatRoomCode(code)}</strong>
            </p>
          </>
        )}
        <p class="muted">Click anywhere or press Escape to close</p>
      </div>
      <div class="present-brand" aria-hidden="true">
        <img src="/icons/icon.svg" alt="" />
        Saybeam
      </div>
    </div>
  );
}
