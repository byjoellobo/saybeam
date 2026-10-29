import { describe, expect, it } from 'vitest';
import { collapseRepeats, isLikelyHallucination } from '../src/engines/hallucination';
import { CaptionPipeline } from '../src/lib/caption-pipeline';
import { compileReplacements, parseReplacements } from '../src/lib/replacements';
import { parseRoute } from '../src/lib/router';
import { sanitizeListenerPrefs, DEFAULT_LISTENER_PREFS, vocabularyList } from '../src/lib/storage';
import { percentile, toCsv, PASSAGES, type BenchResult } from '../src/lib/bench';
import { findPreset, maxNewTokens, MODEL_PRESETS } from '../src/engines/models';
import { isEnglish, recommendEngine, whisperLanguage, type Capabilities } from '../src/engines/detect';

describe('hallucination filter', () => {
  it('drops stock phrases only when they are the whole segment', () => {
    expect(isLikelyHallucination('Thanks for watching!')).toBe(true);
    expect(isLikelyHallucination(' [Music] ')).toBe(true);
    expect(isLikelyHallucination('♪')).toBe(true);
    expect(isLikelyHallucination('Thank you, Priya, for the answer.')).toBe(false);
    expect(isLikelyHallucination('Thank you.')).toBe(false);
    expect(isLikelyHallucination('You')).toBe(true);
  });

  it('collapses runaway repeats but keeps natural doubles', () => {
    expect(collapseRepeats("I'm sorry. I'm sorry. I'm sorry. I'm sorry.")).toBe("I'm sorry.");
    expect(collapseRepeats('very very good')).toBe('very very good');
    expect(collapseRepeats('go go go go now')).toBe('go now');
    expect(collapseRepeats('x a b a b a b y')).toBe('x a b y');
  });
});

describe('CaptionPipeline', () => {
  const make = (rules = '', now = 1000) => {
    const sent: Array<[string, unknown]> = [];
    let n = 0;
    const p = new CaptionPipeline(
      { sendPartial: (id, text) => sent.push(['partial', { id, text }]), sendFinal: (f) => sent.push(['final', f]) },
      compileReplacements(parseReplacements(rules)),
      () => now,
      () => `run${++n}`,
    );
    return { p, sent };
  };

  it('prefixes ids per run, applies replacements, and offsets timings onto the room timeline', () => {
    const { p, sent } = make('foto => photo');
    p.beginRun();
    p.partialFromEngine('u1', 'a foto of');
    expect(p.localPartial).toEqual({ id: 'run2.u1', text: 'a photo of' });
    p.finalFromEngine('u1', 'A foto of the class.', { startMs: 100, endMs: 2100 });
    expect(p.localPartial).toBeNull();
    expect(sent).toEqual([
      ['partial', { id: 'run2.u1', text: 'a photo of' }],
      ['final', { id: 'run2.u1', text: 'A photo of the class.', startMs: 1100, endMs: 3100 }],
    ]);
    p.beginRun();
    expect(p.idFor('u1')).toBe('run3.u1');
  });

  it('turns empty finals into a partial clear and drops bad timings', () => {
    const { p, sent } = make('uh =>');
    p.beginRun();
    p.finalFromEngine('u1', 'uh', {});
    p.finalFromEngine('u2', 'Hello.', { startMs: 500, endMs: 100 });
    p.finalFromEngine('u3', 'World.', { startMs: Number.NaN });
    expect(sent).toEqual([
      ['partial', { id: 'run2.u1', text: '' }],
      ['final', { id: 'run2.u2', text: 'Hello.', startMs: 1500 }],
      ['final', { id: 'run2.u3', text: 'World.' }],
    ]);
  });

  it('notifies local partial listeners and clears on demand', () => {
    const { p, sent } = make();
    const seen: Array<string | null> = [];
    const off = p.onLocalPartial((x) => seen.push(x?.text ?? null));
    p.partialFromEngine('u1', 'hi');
    p.clearPartial();
    p.clearPartial();
    off();
    p.setReplacements(compileReplacements([{ from: 'hi', to: 'hello' }]));
    p.partialFromEngine('u2', 'hi');
    expect(seen).toEqual(['hi', null, null]);
    expect(sent[sent.length - 1]).toEqual(['partial', { id: expect.stringMatching(/\.u2$/), text: 'hello' }]);
  });
});

describe('router', () => {
  it('parses every route and normalises codes', () => {
    expect(parseRoute('/')).toEqual({ name: 'home' });
    expect(parseRoute('/bench')).toEqual({ name: 'bench' });
    expect(parseRoute('/about')).toEqual({ name: 'about' });
    expect(parseRoute('/r/abc234')).toEqual({ name: 'listen', code: 'ABC234' });
    expect(parseRoute('/speak/ABC234')).toEqual({ name: 'speak', code: 'ABC234' });
    expect(parseRoute('/fix/ABC234')).toEqual({ name: 'fix', code: 'ABC234' });
    expect(parseRoute('/ABC-234')).toEqual({ name: 'listen', code: 'ABC234' });
    expect(parseRoute('/r/ABC230')).toEqual({ name: 'not-found' });
    expect(parseRoute('/x/ABC234')).toEqual({ name: 'not-found' });
    expect(parseRoute('/nope')).toEqual({ name: 'not-found' });
  });
});

describe('storage validation', () => {
  it('clamps and defaults untrusted listener prefs', () => {
    expect(sanitizeListenerPrefs(null)).toEqual(DEFAULT_LISTENER_PREFS);
    const p = sanitizeListenerPrefs({ theme: 'neon', fontSize: 999, lineHeight: 'x', bold: true, layout: 'stage' });
    expect(p.theme).toBe('dark');
    expect(p.fontSize).toBe(140);
    expect(p.lineHeight).toBe(DEFAULT_LISTENER_PREFS.lineHeight);
    expect(p.bold).toBe(true);
    expect(p.layout).toBe('stage');
  });

  it('splits vocabulary and dedupes', () => {
    expect(vocabularyList('NCERT, Rutherford\nNCERT\n\n Priya ')).toEqual(['NCERT', 'Rutherford', 'Priya']);
  });
});

describe('bench helpers', () => {
  it('computes nearest-rank percentiles', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
  });

  it('escapes CSV cells', () => {
    const row = { id: '1', at: 'now', deviceLabel: 'Redmi, 2 GB', speakerLabel: 'say "hi"', hypothesis: 'line\nbreak', wer: 0.1 } as unknown as BenchResult;
    const csv = toCsv([row]);
    expect(csv).toContain('"Redmi, 2 GB"');
    expect(csv).toContain('"say ""hi"""');
    expect(csv.split('\n')[0]).toContain('deviceLabel');
  });

  it('ships passages for every risk scenario', () => {
    expect(PASSAGES.map((p) => p.id)).toEqual(expect.arrayContaining(['classroom-en-in', 'hinglish', 'hindi']));
  });
});

describe('models and recommendations', () => {
  const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
    webgpu: false,
    gpuName: null,
    crossOriginIsolated: true,
    cores: 8,
    memoryGb: 8,
    webSpeech: true,
    webSpeechOnDevice: false,
    webSpeechPhrases: false,
    mobile: false,
    iosStandalone: false,
    secureContext: true,
    userAgent: 'test',
    ...over,
  });

  it('gives Moonshine enough tokens for short clips', () => {
    expect(maxNewTokens('moonshine', 0.4)).toBeGreaterThanOrEqual(12);
    expect(maxNewTokens('moonshine', 10)).toBe(76);
    expect(maxNewTokens('whisper', 100)).toBe(224);
    expect(findPreset('nope')).toBe(MODEL_PRESETS[0]);
  });

  it('maps languages', () => {
    expect(whisperLanguage('hi-IN')).toBe('hi');
    expect(isEnglish('en-IN')).toBe(true);
    expect(isEnglish('hi-IN')).toBe(false);
  });

  it('recommends by device and language', () => {
    expect(recommendEngine(caps({ webgpu: true }), 'en-IN').config).toMatchObject({ kind: 'local', modelId: 'moonshine-base', device: 'webgpu' });
    expect(recommendEngine(caps(), 'en-US').config).toMatchObject({ kind: 'local', modelId: 'moonshine-tiny', device: 'wasm' });
    expect(recommendEngine(caps({ cores: 2, memoryGb: 2 }), 'en-IN').config).toMatchObject({ kind: 'webspeech' });
    expect(recommendEngine(caps({ cores: 2, webSpeech: false }), 'en-IN').config).toMatchObject({ kind: 'local', partials: false });
    expect(recommendEngine(caps({ iosStandalone: true }), 'en-US').config).toMatchObject({ kind: 'local', modelId: 'moonshine-tiny' });
    expect(recommendEngine(caps({ webgpu: true }), 'hi-IN').config).toMatchObject({ kind: 'local', modelId: 'whisper-base', language: 'hi' });
    expect(recommendEngine(caps(), 'hi-IN').config).toMatchObject({ kind: 'webspeech', lang: 'hi-IN' });
    expect(recommendEngine(caps({ webSpeech: false }), 'hi-IN').config).toMatchObject({ kind: 'local', modelId: 'whisper-base', partials: false });
  });
});
