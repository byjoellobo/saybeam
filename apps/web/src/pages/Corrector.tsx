import { useEffect, useMemo } from 'preact/hooks';
import { formatRoomCode } from '@saybeam/protocol';
import { useRoom } from '../lib/use-room';
import { StatusPill } from '../components/StatusPill';
import { TranscriptEditor } from '../components/TranscriptEditor';
import { Icon } from '../components/Icon';
import { SiteHeader } from '../components/SiteHeader';

interface CorrectorProps {
  readonly code: string;
}

/** The token arrives in the URL fragment (never sent to servers); keep it for this tab only. */
function useCorrectorToken(code: string): string | null {
  return useMemo(() => {
    const key = `saybeam:corrector:${code}`;
    const fromHash = location.hash.slice(1);
    if (fromHash.length >= 16) {
      sessionStorage.setItem(key, fromHash);
      history.replaceState(null, '', location.pathname);
    }
    return sessionStorage.getItem(key);
  }, [code]);
}

export function Corrector({ code }: CorrectorProps) {
  const token = useCorrectorToken(code);
  const { client, snap } = useRoom({ code, role: 'corrector', token: token ?? undefined, enabled: Boolean(token) });
  const { view } = snap;

  useEffect(() => {
    document.title = `Correcting ${formatRoomCode(code)}, Saybeam`;
  }, [code]);

  if (!token) {
    return (
      <div class="page">
        <SiteHeader />
        <main class="narrow" id="main">
          <h1>Corrector link needed</h1>
          <p>Open the full corrector link the speaker shared with you. It ends with a long secret after a # sign.</p>
        </main>
      </div>
    );
  }

  return (
    <main class="corrector" id="main">
      <header class="speaker-bar">
        <span class="brand-small">
          <img src="/icons/icon.svg" alt="" width={30} height={30} />
          <span class="wordmark">Corrector</span>
        </span>
        <span class="bar-divider" aria-hidden="true" />
        <span class="room-code-small" title="Room code">
          {formatRoomCode(code)}
        </span>
        {view.meta?.title && <span class="title-text">{view.meta.title}</span>}
        <StatusPill connection={snap.connection} status={view.status} speakerOnline={view.presence.speaker} />
        <span class="listener-count">
          <Icon name="users" />
          {view.presence.listeners} following
        </span>
      </header>
      {snap.connection === 'closed' && snap.closeReason && (
        <div class="banner banner-error" role="alert">
          {snap.closeReason}
        </div>
      )}
      <p class="hint corrector-hint">
        Click a line (or Tab to it and press Enter) to fix it. Enter saves, Escape cancels. Clearing a line removes it for everyone. Fixes reach every phone instantly.
      </p>
      <section class="panel live-panel">
        <TranscriptEditor
          segments={view.segments}
          partial={view.partial}
          onCorrect={(seq, text) => client.correct(seq, text)}
          hasMore={view.hasMore}
          onLoadEarlier={() => client.loadEarlier()}
          emptyHint="Waiting for captions..."
        />
      </section>
    </main>
  );
}
