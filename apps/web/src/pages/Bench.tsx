import { useEffect, useRef, useState } from 'preact/hooks';
import type { ServerInfo } from '@caption-room/protocol';
import { fetchInfo } from '../lib/api';
import { downloadText } from '../lib/browser';
import { charErrorRate, parseEquivalences, wordErrorRate, type WerResult } from '../lib/wer';
import { PASSAGES, loadResults, percentile, storeResults, toCsv, type BenchResult } from '../lib/bench';
import { createEngine, describeEngine, type CaptionEngine } from '../engines';
import type { LocalEngine } from '../engines/local-engine';
import { decodeToMono16k } from '../engines/audio-capture';
import { detectCapabilities, recommendEngine, type Capabilities } from '../engines/detect';
import type { EngineConfig, EngineStats, EngineStatus } from '../engines/types';
import { EnginePanel } from '../components/EnginePanel';
import { EngineStatusLine, Meter } from '../components/SpeakerBits';
import { AppLink } from '../components/AppLink';

export function Bench() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [config, setConfig] = useState<EngineConfig | null>(null);
  const [passageId, setPassageId] = useState(PASSAGES[0]?.id ?? 'custom');
  const [reference, setReference] = useState(PASSAGES[0]?.text ?? '');
  const [equivalences, setEquivalences] = useState('nahin = nahi\nok = okay\nyeh = ye');
  const [deviceLabel, setDeviceLabel] = useState('');
  const [speakerLabel, setSpeakerLabel] = useState('');
  const [status, setStatus] = useState<EngineStatus>({ phase: 'idle', message: 'Choose an engine, then record or load a file.' });
  const [stats, setStats] = useState<EngineStats>({});
  const [level, setLevel] = useState(0);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hypothesis, setHypothesis] = useState('');
  const [partial, setPartial] = useState('');
  const [score, setScore] = useState<WerResult | null>(null);
  const [results, setResults] = useState<BenchResult[]>(loadResults);
  const engineRef = useRef<CaptionEngine | null>(null);
  const finals = useRef<string[]>([]);
  const statsRef = useRef<EngineStats>({});
  statsRef.current = stats;

  const passage = PASSAGES.find((p) => p.id === passageId);
  const lang = passage?.lang ?? 'en-IN';

  useEffect(() => {
    void fetchInfo().then(setInfo);
    void detectCapabilities().then((c) => {
      setCaps(c);
      setConfig(recommendEngine(c, 'en-IN').config);
      setDeviceLabel(`${c.mobile ? 'Phone' : 'Computer'}, ${c.cores} cores${c.memoryGb ? `, ${c.memoryGb} GB` : ''}${c.gpuName ? `, ${c.gpuName}` : ''}`);
    });
    return () => engineRef.current?.dispose();
  }, []);

  const callbacks = {
    onPartial: (_k: string, t: string) => setPartial(t),
    onFinal: (_k: string, t: string) => {
      finals.current = [...finals.current, t];
      setHypothesis(finals.current.join(' '));
      setPartial('');
    },
    onStatus: setStatus,
    onStats: setStats,
    onLevel: setLevel,
    onClockStart: () => undefined,
  };

  const freshEngine = (cfg: EngineConfig): CaptionEngine => {
    engineRef.current?.dispose();
    const e = createEngine(cfg, callbacks, { localModels: info?.localModels ?? false });
    engineRef.current = e;
    return e;
  };

  const record = async () => {
    if (!config) return;
    finals.current = [];
    setHypothesis('');
    setScore(null);
    setBusy(true);
    try {
      await freshEngine(config).start();
      setRecording(true);
    } catch (err) {
      setStatus({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    await engineRef.current?.stop();
    setRecording(false);
    setBusy(false);
    const hyp = finals.current.join(' ');
    const s = statsRef.current;
    save('live', hyp, { rtf: s.rtf ?? null, loadMs: s.loadMs ?? null, backend: s.backend ?? '', audioSec: null, asrSec: null, p50Ms: null, p95Ms: null });
  };

  const runFile = async (file: File) => {
    if (config?.kind !== 'local') {
      setStatus({ phase: 'error', message: 'File tests need an on-device model. Choose "On this device".' });
      return;
    }
    setBusy(true);
    setScore(null);
    finals.current = [];
    try {
      setStatus({ phase: 'loading', message: `Decoding ${file.name}...` });
      const samples = await decodeToMono16k(file);
      const engine = freshEngine(config) as LocalEngine;
      await engine.ensureLoaded();
      setStatus({ phase: 'listening', message: `Transcribing ${(samples.length / 16000).toFixed(1)} s of audio...` });
      const out = await engine.transcribeFile(samples);
      const hyp = out.segments
        .map((s) => s.text)
        .filter(Boolean)
        .join(' ');
      finals.current = [hyp];
      setHypothesis(hyp);
      const segTimes = out.segments.map((s) => s.asrMs);
      const audioSec = out.audioMs / 1000;
      const asrSec = out.asrMs / 1000;
      setStatus({ phase: 'ready', message: `Done: ${audioSec.toFixed(1)} s of audio in ${(out.wallMs / 1000).toFixed(1)} s.` });
      save('file', hyp, {
        rtf: audioSec ? asrSec / audioSec : null,
        loadMs: statsRef.current.loadMs ?? null,
        backend: statsRef.current.backend ?? '',
        audioSec,
        asrSec,
        p50Ms: percentile(segTimes, 50),
        p95Ms: percentile(segTimes, 95),
      });
    } catch (err) {
      setStatus({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const save = (mode: 'live' | 'file', hyp: string, perf: Pick<BenchResult, 'rtf' | 'loadMs' | 'backend' | 'audioSec' | 'asrSec' | 'p50Ms' | 'p95Ms'>) => {
    const eq = parseEquivalences(equivalences);
    const w = reference.trim() ? wordErrorRate(reference, hyp, { equivalences: eq }) : null;
    setScore(w);
    if (!config || !caps) return;
    const result: BenchResult = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      deviceLabel,
      speakerLabel,
      engine: describeEngine(config),
      mode,
      passage: passageId,
      ...perf,
      wer: w ? Number(w.wer.toFixed(4)) : null,
      cer: reference.trim() ? Number(charErrorRate(reference, hyp, { equivalences: eq }).toFixed(4)) : null,
      refWords: w?.refWords ?? null,
      hypothesis: hyp,
      cores: caps.cores,
      memoryGb: caps.memoryGb,
      gpu: caps.gpuName,
      userAgent: caps.userAgent,
    };
    const next = [...results, result];
    setResults(next);
    storeResults(next);
  };

  return (
    <main class="bench narrow-wide" id="main">
      <header class="bench-head">
        <AppLink href="/" class="brand-small">
          <img src="/icons/icon.svg" alt="" width={28} height={28} />
          <span>Caption Room</span>
        </AppLink>
        <h1>Field-test bench</h1>
        <p class="lede">
          Measure how fast and how accurately each speech engine works on this device and with your voice. Results stay in this browser until you export them. See{' '}
          <code>docs/risk-tests.md</code> for the full two-week test plan.
        </p>
      </header>

      <section class="card">
        <h2>This device</h2>
        {caps ? (
          <dl class="kv">
            <dt>Processor threads</dt>
            <dd>{caps.cores}</dd>
            <dt>Memory</dt>
            <dd>{caps.memoryGb ? `${caps.memoryGb} GB or more` : 'not reported'}</dd>
            <dt>GPU (WebGPU)</dt>
            <dd>{caps.webgpu ? caps.gpuName || 'available' : 'not available'}</dd>
            <dt>Multi-threaded WASM</dt>
            <dd>{caps.crossOriginIsolated ? 'yes' : 'no (single thread)'}</dd>
            <dt>Browser speech</dt>
            <dd>{caps.webSpeech ? (caps.webSpeechOnDevice ? 'yes, with on-device option' : 'yes (cloud)') : 'no'}</dd>
          </dl>
        ) : (
          <p class="muted">Checking...</p>
        )}
        <div class="row gap wrap">
          <label class="field">
            <span>Device label</span>
            <input value={deviceLabel} onInput={(e) => setDeviceLabel(e.currentTarget.value)} placeholder="Redmi 9A, 2 GB" />
          </label>
          <label class="field">
            <span>Speaker label</span>
            <input value={speakerLabel} onInput={(e) => setSpeakerLabel(e.currentTarget.value)} placeholder="Tamil Nadu, female, 30s" />
          </label>
        </div>
      </section>

      <section class="card">
        <h2>Engine</h2>
        {config ? (
          <EnginePanel
            config={config}
            onChange={setConfig}
            caps={caps}
            lang={lang}
            recommendation={null}
            disabled={recording || busy}
            whisperLiveUrl="ws://localhost:9090"
            whisperLiveModel="small"
            vocabulary={[]}
          />
        ) : (
          <p class="muted">Checking what this device can do...</p>
        )}
      </section>

      <section class="card">
        <h2>Reference text</h2>
        <label class="field">
          <span>Passage</span>
          <select
            value={passageId}
            onChange={(e) => {
              const id = e.currentTarget.value;
              setPassageId(id);
              setReference(PASSAGES.find((p) => p.id === id)?.text ?? '');
            }}
          >
            {PASSAGES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value="custom">My own text</option>
          </select>
        </label>
        {passage?.note && <p class="hint">{passage.note}</p>}
        <label class="field">
          <span>Read this aloud (or paste the transcript of your audio file)</span>
          <textarea class="reading" rows={6} value={reference} onInput={(e) => setReference(e.currentTarget.value)} />
        </label>
        <details>
          <summary>Spelling equivalences</summary>
          <textarea rows={4} value={equivalences} onInput={(e) => setEquivalences(e.currentTarget.value)} />
          <small>One "variant = canonical" per line. Applied to both texts before scoring.</small>
        </details>
      </section>

      <section class="card">
        <h2>Run</h2>
        <div class="row gap wrap">
          {!recording ? (
            <button type="button" class="btn btn-primary" disabled={!config || busy} onClick={() => void record()}>
              Record and read aloud
            </button>
          ) : (
            <button type="button" class="btn btn-stop" disabled={busy} onClick={() => void stop()}>
              Stop and score
            </button>
          )}
          <label class={`btn${config?.kind !== 'local' || busy || recording ? ' disabled' : ''}`}>
            Transcribe an audio file
            <input
              type="file"
              accept="audio/*,video/*"
              class="sr-only"
              disabled={config?.kind !== 'local' || busy || recording}
              onChange={(e) => {
                const f = e.currentTarget.files?.[0];
                if (f) void runFile(f);
                e.currentTarget.value = '';
              }}
            />
          </label>
          <Meter level={level} active={recording} />
        </div>
        <EngineStatusLine status={status} />
        {(hypothesis || partial) && (
          <div class="hypothesis">
            <h3>Heard</h3>
            <p>
              {hypothesis} <span class="partial">{partial}</span>
            </p>
          </div>
        )}
        {score && <ScoreView score={score} />}
      </section>

      <section class="card">
        <div class="row space-between wrap">
          <h2>Results ({results.length})</h2>
          <div class="row gap-sm wrap">
            <button type="button" class="btn btn-small" disabled={!results.length} onClick={() => downloadText('caption-room-bench.csv', toCsv(results), 'text/csv')}>
              Export CSV
            </button>
            <button
              type="button"
              class="btn btn-small"
              disabled={!results.length}
              onClick={() => downloadText('caption-room-bench.json', JSON.stringify(results, null, 2), 'application/json')}
            >
              Export JSON
            </button>
            <button
              type="button"
              class="btn btn-small btn-ghost"
              disabled={!results.length}
              onClick={() => {
                if (!confirm('Delete all saved results from this browser?')) return;
                setResults([]);
                storeResults([]);
              }}
            >
              Clear
            </button>
          </div>
        </div>
        {results.length > 0 && (
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Engine</th>
                  <th>Passage</th>
                  <th>Speaker</th>
                  <th>WER</th>
                  <th>RTF</th>
                  <th>p95 ms</th>
                </tr>
              </thead>
              <tbody>
                {[...results].reverse().map((r) => (
                  <tr key={r.id}>
                    <td>{new Date(r.at).toLocaleString()}</td>
                    <td>{r.engine}</td>
                    <td>{r.passage}</td>
                    <td>{r.speakerLabel || 'n/a'}</td>
                    <td>{r.wer === null ? 'n/a' : `${(r.wer * 100).toFixed(1)}%`}</td>
                    <td>{r.rtf === null ? 'n/a' : r.rtf.toFixed(2)}</td>
                    <td>{r.p95Ms ?? 'n/a'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function ScoreView({ score }: { readonly score: WerResult }) {
  return (
    <div class="score">
      <p class="score-head">
        <strong>Word error rate {(score.wer * 100).toFixed(1)}%</strong> ({score.substitutions} substituted, {score.deletions} missed, {score.insertions} extra, out of{' '}
        {score.refWords} words)
      </p>
      <p class="diff">
        <span class="sr-only">Alignment of what was said and what was heard. Struck-through words were missed or misheard; underlined words were heard instead. </span>
        {score.ops.map((op, i) => {
          if (op.type === 'ok') return <span key={i}>{op.ref} </span>;
          if (op.type === 'sub')
            return (
              <span key={i} class="diff-sub" title={`said "${op.ref}", heard "${op.hyp}"`}>
                <del>{op.ref}</del> <ins>{op.hyp}</ins>{' '}
              </span>
            );
          if (op.type === 'del')
            return (
              <del key={i} class="diff-del" title="missed">
                {op.ref}{' '}
              </del>
            );
          return (
            <ins key={i} class="diff-ins" title="extra">
              {op.hyp}{' '}
            </ins>
          );
        })}
      </p>
    </div>
  );
}
