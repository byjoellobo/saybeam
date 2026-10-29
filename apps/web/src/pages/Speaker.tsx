import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { exportTranscript, formatRoomCode, type ExportFormat, type ServerInfo } from '@caption-room/protocol';
import { useRoom } from '../lib/use-room';
import { fetchInfo, publicBase } from '../lib/api';
import { CaptionPipeline, type LocalPartial } from '../lib/caption-pipeline';
import { compileReplacements, parseReplacements } from '../lib/replacements';
import { copyText, downloadText, safeFilename, useWakeLock } from '../lib/browser';
import { getSavedRoom, loadSpeakerPrefs, saveRoom, saveSpeakerPrefs, vocabularyList, type SavedRoom, type SpeakerPrefs } from '../lib/storage';
import { navigate, paths } from '../lib/router';
import { createEngine, describeEngine, type CaptionEngine } from '../engines';
import { detectCapabilities, recommendEngine, type Capabilities } from '../engines/detect';
import type { EngineConfig, EngineStats, EngineStatus } from '../engines/types';
import { EnginePanel } from '../components/EnginePanel';
import { QrShare } from '../components/QrShare';
import { StatusPill } from '../components/StatusPill';
import { TranscriptEditor } from '../components/TranscriptEditor';
import { Diagnostics, EngineStatusLine, Meter, PresentOverlay } from '../components/SpeakerBits';

interface SpeakerProps {
  readonly code: string;
}

/** Room secrets: from this browser's storage, or from a hand-off link (#k=token). */
function useSpeakerKey(code: string): SavedRoom | null {
  return useMemo(() => {
    const hash = new URLSearchParams(location.hash.slice(1));
    const k = hash.get('k');
    const c = hash.get('c');
    if (k && k.length >= 16) {
      const room: SavedRoom = { code, speakerToken: k, correctorToken: c ?? '', title: '', createdAt: Date.now() };
      saveRoom({ ...(getSavedRoom(code) ?? room), speakerToken: k, ...(c ? { correctorToken: c } : {}) });
      history.replaceState(null, '', location.pathname); // keep the secret out of the address bar
    }
    return getSavedRoom(code);
  }, [code]);
}

export function Speaker({ code }: SpeakerProps) {
  const saved = useSpeakerKey(code);
  if (!saved) {
    return (
      <main class="narrow" id="main">
        <h1>This browser is not the speaker for {formatRoomCode(code)}</h1>
        <p>The speaker key lives in the browser that created the room. To caption from another device, open the hand-off link from the original speaker console.</p>
        <p class="row gap-sm wrap">
          <button type="button" class="btn btn-primary" onClick={() => navigate(paths.listen(code))}>
            Follow the captions instead
          </button>
          <button type="button" class="btn" onClick={() => navigate('/')}>
            Start a new room
          </button>
        </p>
      </main>
    );
  }
  return <SpeakerConsole code={code} room={saved} />;
}

function SpeakerConsole({ code, room }: { readonly code: string; readonly room: SavedRoom }) {
  const { client, snap } = useRoom({ code, role: 'speaker', token: room.speakerToken });
  const { view } = snap;
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [prefs, setPrefs] = useState<SpeakerPrefs>(loadSpeakerPrefs);
  const [config, setConfig] = useState<EngineConfig | null>(prefs.engine);
  const [status, setStatus] = useState<EngineStatus>({ phase: 'idle', message: 'Not listening' });
  const [stats, setStats] = useState<EngineStats>({});
  const [level, setLevel] = useState(0);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState<LocalPartial | null>(null);
  const [presenting, setPresenting] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const engineRef = useRef<{ engine: CaptionEngine; key: string } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const lang = view.meta?.lang ?? 'en-US';
  const recommendation = useMemo(() => (caps ? recommendEngine(caps, lang) : null), [caps, lang]);
  const listenUrl = `${publicBase(info)}${paths.listen(code)}`;

  useEffect(() => {
    void fetchInfo().then(setInfo);
    void detectCapabilities().then(setCaps);
  }, []);

  useEffect(() => {
    if (!config && recommendation) setConfig(recommendation.config);
  }, [config, recommendation]);

  useEffect(() => {
    document.title = `Speaker ${formatRoomCode(code)}, Caption Room`;
  }, [code]);

  const replacements = useMemo(() => compileReplacements(parseReplacements(prefs.replacements)), [prefs.replacements]);
  const pipeline = useMemo(
    () =>
      new CaptionPipeline(client, replacements, () => {
        const v = viewRef.current;
        return v.meta ? Date.now() + v.clockOffset - v.meta.createdAt : 0;
      }),
    // The pipeline lives as long as the room client; replacements are swapped in below.
    [client],
  );
  useEffect(() => pipeline.setReplacements(replacements), [pipeline, replacements]);
  useEffect(() => pipeline.onLocalPartial(setPartial), [pipeline]);

  const updatePrefs = (next: SpeakerPrefs) => {
    setPrefs(next);
    saveSpeakerPrefs(next);
  };

  const chooseConfig = (next: EngineConfig) => {
    setConfig(next);
    updatePrefs({ ...prefs, engine: next, ...(next.kind === 'whisperlive' ? { whisperLiveUrl: next.url, whisperLiveModel: next.model } : {}) });
  };

  useWakeLock(running);

  // An engine that dies mid-session must not look like it is still captioning.
  useEffect(() => {
    if (!running || status.phase !== 'error') return;
    setRunning(false);
    pipeline.clearPartial();
    void engineRef.current?.engine.stop().catch(() => undefined);
    client.setStatus('paused');
  }, [running, status.phase, pipeline, client]);

  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [running]);

  useEffect(
    () => () => {
      engineRef.current?.engine.dispose();
      engineRef.current = null;
    },
    [],
  );

  const engineFor = useCallback(
    (cfg: EngineConfig): CaptionEngine => {
      const withVocab: EngineConfig = cfg.kind === 'webspeech' ? { ...cfg, phrases: vocabularyList(prefs.vocabulary) } : cfg.kind === 'whisperlive' ? { ...cfg, hotwords: vocabularyList(prefs.vocabulary).join(',') } : cfg;
      const key = JSON.stringify([withVocab, info?.localModels ?? false]);
      if (engineRef.current?.key === key) return engineRef.current.engine;
      engineRef.current?.engine.dispose();
      const engine = createEngine(
        withVocab,
        {
          onPartial: (k, t) => pipeline.partialFromEngine(k, t),
          onFinal: (k, t, timing) => pipeline.finalFromEngine(k, t, timing),
          onStatus: setStatus,
          onStats: setStats,
          onLevel: setLevel,
          // Captions are timed from the moment the engine's own clock starts.
          onClockStart: () => pipeline.beginRun(),
        },
        { localModels: info?.localModels ?? false },
      );
      engineRef.current = { engine, key };
      return engine;
    },
    [pipeline, prefs.vocabulary, info?.localModels],
  );

  const start = async () => {
    if (!config || busy || !info) return;
    setBusy(true);
    try {
      const engine = engineFor(config);
      await engine.start();
      setRunning(true);
      if (view.status === 'paused') client.setStatus('live');
    } catch (err) {
      setStatus({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const pause = async () => {
    setBusy(true);
    try {
      await engineRef.current?.engine.stop();
      pipeline.clearPartial();
      setRunning(false);
      client.setStatus('paused');
    } finally {
      setBusy(false);
    }
  };

  const endSession = async () => {
    if (!confirm('End this session for everyone? Listeners keep what they have, and you can still download the transcript.')) return;
    if (running) await pause();
    client.end();
  };

  const exportAs = async (format: ExportFormat) => {
    await client.loadAll();
    const v = client.snapshot.view;
    const { body, mime, ext } = exportTranscript(format, v.segments, v.meta, code);
    downloadText(`${safeFilename(v.meta?.title || `captions-${code}`)}.${ext}`, body, mime);
  };

  const copy = async (label: string, text: string) => {
    if (await copyText(text)) {
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    }
  };

  const correctorUrl = room.correctorToken ? `${publicBase(info)}${paths.fix(code, room.correctorToken)}` : null;
  const handoffUrl = `${publicBase(info)}${paths.speak(code)}#k=${room.speakerToken}${room.correctorToken ? `&c=${room.correctorToken}` : ''}`;
  const ended = view.status === 'ended';

  return (
    <main class="speaker" id="main">
      <header class="speaker-bar">
        <a
          class="brand-small"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            if (!running || confirm('Leave the speaker console? Captioning will stop.')) navigate('/');
          }}
        >
          <img src="/icons/icon.svg" alt="" width={28} height={28} />
          <span>Caption Room</span>
        </a>
        <span class="room-code-small">{formatRoomCode(code)}</span>
        <StatusPill connection={snap.connection} status={view.status} liveLabel={running ? 'Captioning' : 'Connected'} />
        <span class="listener-count" aria-live="polite">
          {view.presence.listeners} {view.presence.listeners === 1 ? 'person' : 'people'} following
          {view.presence.correctors > 0 ? `, ${view.presence.correctors} correcting` : ''}
        </span>
        <button type="button" class="btn btn-small" onClick={() => setPresenting(true)}>
          Show QR on screen
        </button>
      </header>

      {snap.connection === 'closed' && snap.closeReason && (
        <div class="banner banner-error" role="alert">
          {snap.closeReason}
        </div>
      )}
      {snap.connection === 'reconnecting' && running && <div class="banner">Connection lost. Keep talking: captions are saved here and sent when the connection returns.</div>}

      <div class="speaker-grid">
        <section class="panel live-panel" aria-labelledby="live-title">
          <div class="live-head">
            <h1 id="live-title" class="sr-only">
              Live captions
            </h1>
            {!running ? (
              <button type="button" class="btn btn-primary btn-mic" disabled={busy || !config || !info || ended || snap.connection === 'closed'} onClick={start}>
                {busy ? 'Starting...' : view.segments.length ? 'Resume captioning' : 'Start captioning'}
              </button>
            ) : (
              <button type="button" class="btn btn-mic btn-stop" disabled={busy} onClick={pause}>
                {busy ? 'Pausing...' : 'Pause'}
              </button>
            )}
            <div class="live-meta">
              <Meter level={level} active={running} />
              <EngineStatusLine status={status} />
              {config && <small class="muted">{describeEngine(config)}</small>}
            </div>
          </div>
          <TranscriptEditor
            segments={view.segments}
            pending={snap.pending}
            partial={partial}
            onCorrect={(seq, text) => client.correct(seq, text)}
            hasMore={view.hasMore}
            onLoadEarlier={() => client.loadEarlier()}
            emptyHint={ended ? 'This session has ended.' : 'Press Start captioning and speak. Click any line to fix it.'}
          />
        </section>

        <aside class="side" aria-label="Room controls">
          <details class="panel" open>
            <summary>Invite the audience</summary>
            <QrShare code={code} url={listenUrl} title={view.meta?.title ?? ''} />
            {info?.mode === 'lan' && <p class="hint">Phones must be on the same Wi-Fi as this laptop.</p>}
          </details>

          <details class="panel" open={!running}>
            <summary>Speech engine</summary>
            {config ? (
              <EnginePanel
                config={config}
                onChange={chooseConfig}
                caps={caps}
                lang={lang}
                recommendation={recommendation}
                disabled={running || busy}
                whisperLiveUrl={prefs.whisperLiveUrl}
                whisperLiveModel={prefs.whisperLiveModel}
                vocabulary={vocabularyList(prefs.vocabulary)}
              />
            ) : (
              <p class="muted">Checking what this device can do...</p>
            )}
            {running && <p class="hint">Pause to change the engine.</p>}
          </details>

          <details class="panel">
            <summary>Performance</summary>
            <Diagnostics stats={stats} rttMs={snap.rttMs} pending={snap.pending.length} listeners={view.presence.listeners} />
          </details>

          <details class="panel">
            <summary>Words and names</summary>
            <label class="field">
              <span>Word replacements</span>
              <textarea
                rows={5}
                value={prefs.replacements}
                placeholder={'one per line, for example:\nfoto synthesis => photosynthesis\nmister sharma => Mr Sharma'}
                onInput={(e) => updatePrefs({ ...prefs, replacements: e.currentTarget.value })}
              />
              <small>{replacements.count} active. Applied before captions leave this device.</small>
            </label>
            <label class="field">
              <span>Vocabulary</span>
              <textarea rows={3} value={prefs.vocabulary} placeholder="Names and jargon, comma or line separated" onInput={(e) => updatePrefs({ ...prefs, vocabulary: e.currentTarget.value })} />
              <small>Boosts recognition with Chrome on-device speech and WhisperLive (hotwords). Takes effect next time you start.</small>
            </label>
          </details>

          <details class="panel">
            <summary>Helpers and devices</summary>
            {correctorUrl && (
              <div class="field">
                <span>Corrector link</span>
                <small>Anyone with this link can fix captions live. Share it only with your helper.</small>
                <button type="button" class="btn btn-small" onClick={() => copy('corrector', correctorUrl)}>
                  {copied === 'corrector' ? 'Copied' : 'Copy corrector link'}
                </button>
              </div>
            )}
            <div class="field">
              <span>Caption from another device</span>
              <small>Opens this console elsewhere (for example a phone near the speaker). Treat it like a password.</small>
              <button type="button" class="btn btn-small" onClick={() => copy('handoff', handoffUrl)}>
                {copied === 'handoff' ? 'Copied' : 'Copy hand-off link'}
              </button>
            </div>
          </details>

          <details class="panel">
            <summary>Session</summary>
            <label class="field">
              <span>Session name</span>
              <input
                value={view.meta?.title ?? ''}
                maxLength={120}
                onChange={(e) => client.setMeta({ title: e.currentTarget.value })}
                placeholder="Shown to listeners"
              />
            </label>
            <label class="switch">
              <input type="checkbox" checked={view.meta?.allowExport ?? true} onChange={(e) => client.setMeta({ allowExport: e.currentTarget.checked })} />
              <span>Let listeners download the transcript</span>
            </label>
            <div class="field">
              <span>Download transcript</span>
              <div class="row gap-sm wrap">
                {(['txt', 'srt', 'vtt', 'json'] as const).map((f) => (
                  <button key={f} type="button" class="btn btn-small" disabled={!view.segments.length} onClick={() => void exportAs(f)}>
                    {f.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <button type="button" class="btn btn-danger" disabled={ended} onClick={() => void endSession()}>
              {ended ? 'Session ended' : 'End session for everyone'}
            </button>
            <p class="hint">Rooms and transcripts are deleted from the server 24 hours after the last caption.</p>
          </details>
        </aside>
      </div>

      {presenting && <PresentOverlay code={code} url={listenUrl} title={view.meta?.title ?? ''} onClose={() => setPresenting(false)} />}
    </main>
  );
}
