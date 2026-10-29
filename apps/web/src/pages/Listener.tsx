import { useCallback, useEffect, useState } from 'preact/hooks';
import { CLOSE, exportTranscript, formatRoomCode, type ExportFormat } from '@caption-room/protocol';
import { CaptionView } from '../components/CaptionView';
import { DisplaySettings } from '../components/DisplaySettings';
import { StatusPill } from '../components/StatusPill';
import { useRoom } from '../lib/use-room';
import { downloadText, safeFilename, useWakeLock } from '../lib/browser';
import { loadListenerPrefs, saveListenerPrefs, type ListenerPrefs } from '../lib/storage';
import { navigate } from '../lib/router';

interface ListenerProps {
  readonly code: string;
}

const FONT_STACKS: Record<ListenerPrefs['font'], string> = {
  hyperlegible: "'Atkinson Hyperlegible', system-ui, sans-serif",
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "Cascadia Mono", Menlo, monospace',
};

/**
 * A private room's listener secret arrives in the link fragment (#k=...), which
 * is never sent to servers. Keep it on this device and tidy the address bar.
 */
function useListenerToken(code: string): string | undefined {
  const read = useCallback((): string | undefined => {
    const key = `caption-room:listen:${code}`;
    const k = new URLSearchParams(location.hash.slice(1)).get('k');
    try {
      if (k && k.length >= 16) {
        localStorage.setItem(key, k);
        history.replaceState(null, '', location.pathname);
      }
      return localStorage.getItem(key) ?? undefined;
    } catch {
      // Storage blocked (private mode): keep the secret for this page only.
      return k && k.length >= 16 ? k : undefined;
    }
  }, [code]);
  const [token, setToken] = useState(read);
  // Pasting the full link into the address bar on this same page only changes the fragment.
  useEffect(() => {
    const onHash = () => setToken(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [read]);
  return token;
}

export function Listener({ code }: ListenerProps) {
  const token = useListenerToken(code);
  const { client, snap } = useRoom({ code, role: 'listener', token, maxSegments: 3000 });

  // A refused secret (the link was replaced) is useless: forget it so this device stops retrying it.
  useEffect(() => {
    if (snap.closeCode !== CLOSE.unauthorized) return;
    try {
      localStorage.removeItem(`caption-room:listen:${code}`);
    } catch {
      // ignore
    }
  }, [snap.closeCode, code]);
  const [prefs, setPrefs] = useState<ListenerPrefs>(loadListenerPrefs);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { view } = snap;

  useWakeLock(prefs.keepAwake && snap.connection === 'open' && view.status !== 'ended');

  useEffect(() => {
    document.title = view.meta?.title ? `${view.meta.title}, live captions` : `Captions ${formatRoomCode(code)}`;
  }, [view.meta?.title, code]);

  const update = (next: ListenerPrefs) => {
    setPrefs(next);
    saveListenerPrefs(next);
  };

  const download = async (format: ExportFormat) => {
    await client.loadAll(); // include lines from before this phone joined
    const v = client.snapshot.view;
    const { body, mime, ext } = exportTranscript(format, v.segments, v.meta, code);
    downloadText(`${safeFilename(v.meta?.title || `captions-${code}`)}.${ext}`, body, mime);
  };

  const style = {
    '--cap-size': `${prefs.fontSize}px`,
    '--cap-line': String(prefs.lineHeight),
    '--cap-font': FONT_STACKS[prefs.font],
    '--cap-weight': prefs.bold ? '700' : '400',
    '--cap-tracking': `${prefs.letterSpacing}em`,
    '--cap-transform': prefs.uppercase ? 'uppercase' : 'none',
  } as Record<string, string>;

  return (
    <main class={`listener theme-${prefs.theme}`} style={style} id="main">
      <header class="listener-bar">
        <div class="listener-title">
          <span class="room-code-small" title="Room code">
            {formatRoomCode(code)}
          </span>
          {view.meta?.title && <span class="title-text">{view.meta.title}</span>}
        </div>
        <StatusPill connection={snap.connection} status={view.status} speakerOnline={view.presence.speaker} />
        <button type="button" class="btn btn-bar" onClick={() => setSettingsOpen(true)} aria-haspopup="dialog">
          <span aria-hidden="true">Aa</span>
          <span class="sr-only">Display settings</span>
        </button>
      </header>

      {snap.connection === 'closed' && snap.closeReason && (
        <div class="banner banner-error" role="alert">
          {snap.closeReason}{' '}
          <button type="button" class="btn btn-small" onClick={() => navigate('/')}>
            Enter another code
          </button>
        </div>
      )}
      {view.status === 'paused' && <div class="banner">The speaker has paused captions.</div>}
      {view.status === 'ended' && (
        <div class="banner">
          This session has ended.
          {view.meta?.allowExport && view.segments.length > 0 && (
            <span class="row gap-sm wrap">
              <button type="button" class="btn btn-small" onClick={() => void download('txt')}>
                Save as text
              </button>
              <button type="button" class="btn btn-small" onClick={() => void download('srt')}>
                Save as SRT
              </button>
            </span>
          )}
        </div>
      )}

      <CaptionView segments={view.segments} partial={view.partial} prefs={prefs} hasMore={view.hasMore} onLoadEarlier={() => client.loadEarlier()} clockOffset={view.clockOffset} />

      <DisplaySettings open={settingsOpen} prefs={prefs} onChange={update} onClose={() => setSettingsOpen(false)}>
        {view.meta?.allowExport && view.segments.length > 0 && (
          <fieldset>
            <legend>Transcript</legend>
            <div class="row gap-sm wrap">
              <button type="button" class="btn btn-small" onClick={() => void download('txt')}>
                Save as text
              </button>
              <button type="button" class="btn btn-small" onClick={() => void download('srt')}>
                Save as SRT
              </button>
              <button type="button" class="btn btn-small" onClick={() => void download('vtt')}>
                Save as WebVTT
              </button>
            </div>
          </fieldset>
        )}
      </DisplaySettings>
    </main>
  );
}
