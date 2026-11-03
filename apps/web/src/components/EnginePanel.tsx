import { useEffect, useState } from 'preact/hooks';
import { MODEL_PRESETS, findPreset } from '../engines/models';
import { listMicrophones } from '../engines/audio-capture';
import { installOnDevice, onDeviceAvailability, type OnDeviceState } from '../engines/web-speech-engine';
import { whisperLanguage, type Capabilities, type Recommendation } from '../engines/detect';
import type { DevicePreference, EngineConfig, EngineKind } from '../engines/types';

interface EnginePanelProps {
  readonly config: EngineConfig;
  readonly onChange: (cfg: EngineConfig) => void;
  readonly caps: Capabilities | null;
  readonly lang: string;
  readonly recommendation: Recommendation | null;
  readonly disabled: boolean;
  readonly whisperLiveUrl: string;
  readonly whisperLiveModel: string;
  readonly vocabulary: readonly string[];
}

const WHISPERLIVE_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo', 'distil-large-v3'];

export function defaultConfigFor(kind: EngineKind, lang: string, wlUrl: string, wlModel: string, vocabulary: readonly string[]): EngineConfig {
  switch (kind) {
    case 'local':
      return { kind: 'local', modelId: lang.startsWith('en') ? 'moonshine-tiny' : 'whisper-base', device: 'auto', language: whisperLanguage(lang), partials: true };
    case 'webspeech':
      return { kind: 'webspeech', lang, onDevice: false, phrases: vocabulary };
    case 'whisperlive':
      return { kind: 'whisperlive', url: wlUrl, model: wlModel, language: whisperLanguage(lang) };
  }
}

export function EnginePanel({ config, onChange, caps, lang, recommendation, disabled, whisperLiveUrl, whisperLiveModel, vocabulary }: EnginePanelProps) {
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [onDevice, setOnDevice] = useState<OnDeviceState>('unsupported');
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    void listMicrophones()
      .then(setMics)
      .catch(() => setMics([]));
  }, [config.kind]);

  const speechLang = config.kind === 'webspeech' ? config.lang : lang;
  useEffect(() => {
    if (config.kind !== 'webspeech') return;
    void onDeviceAvailability(speechLang).then(setOnDevice);
  }, [config.kind, speechLang]);

  const pick = (kind: EngineKind) => {
    if (kind === config.kind) return;
    if (recommendation?.config.kind === kind) onChange(recommendation.config);
    else onChange(defaultConfigFor(kind, lang, whisperLiveUrl, whisperLiveModel, vocabulary));
  };

  const micSelect = (micId: string | undefined, set: (id: string | undefined) => void) =>
    mics.length > 1 && (
      <label class="field">
        <span>Microphone</span>
        <select value={micId ?? ''} disabled={disabled} onChange={(e) => set(e.currentTarget.value || undefined)}>
          <option value="">System default</option>
          {mics.map((m, i) => (
            <option key={m.deviceId || i} value={m.deviceId}>
              {m.label || `Microphone ${i + 1}`}
            </option>
          ))}
        </select>
      </label>
    );

  return (
    <div class="engine-panel">
      <div class="segmented" role="radiogroup" aria-label="Speech engine">
        {(
          [
            ['local', 'On this device'],
            ['webspeech', 'Browser speech'],
            ['whisperlive', 'WhisperLive server'],
          ] as const
        ).map(([kind, label]) => (
          <label key={kind} class={config.kind === kind ? 'selected' : ''}>
            <input type="radio" name="engine" disabled={disabled} checked={config.kind === kind} onChange={() => pick(kind)} />
            {label}
          </label>
        ))}
      </div>

      {recommendation && (
        <p class="hint">
          <strong>Suggested for this device:</strong> {recommendation.reason}
        </p>
      )}

      {config.kind === 'local' && (
        <>
          <label class="field">
            <span>Model</span>
            <select value={config.modelId} disabled={disabled} onChange={(e) => onChange({ ...config, modelId: e.currentTarget.value })}>
              {MODEL_PRESETS.filter((p) => !p.needsGpu || caps?.webgpu).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} (about {caps?.webgpu ? p.sizeMb.webgpu : p.sizeMb.wasm} MB)
                </option>
              ))}
            </select>
            <small>{findPreset(config.modelId).note}</small>
          </label>
          {findPreset(config.modelId).englishOnly && !lang.startsWith('en') && <p class="warn">This model only understands English. Choose Whisper Base for {lang}.</p>}
          <div class="row gap wrap">
            <label class="field">
              <span>Runs on</span>
              <select value={config.device} disabled={disabled} onChange={(e) => onChange({ ...config, device: e.currentTarget.value as DevicePreference })}>
                <option value="auto">Automatic</option>
                <option value="webgpu" disabled={!caps?.webgpu}>
                  GPU (WebGPU)
                </option>
                <option value="wasm">CPU (WebAssembly)</option>
              </select>
            </label>
            {!findPreset(config.modelId).englishOnly && (
              <label class="field">
                <span>Language</span>
                <input
                  type="text"
                  value={config.language ?? ''}
                  disabled={disabled}
                  placeholder="auto"
                  size={6}
                  onInput={(e) => onChange({ ...config, language: e.currentTarget.value.trim().toLowerCase() || null })}
                />
              </label>
            )}
          </div>
          <label class="switch">
            <input type="checkbox" checked={config.partials} disabled={disabled} onChange={(e) => onChange({ ...config, partials: e.currentTarget.checked })} />
            <span>
              Live partial captions
              <small>Shows words while you speak. Turns itself off if the device falls behind.</small>
            </span>
          </label>
          {micSelect(config.micId, (micId) => onChange({ ...config, ...(micId ? { micId } : { micId: undefined }) }))}
          {caps && !caps.crossOriginIsolated && !caps.webgpu && <p class="warn">This page is not cross-origin isolated, so the CPU model runs on one thread and will be slow.</p>}
        </>
      )}

      {config.kind === 'webspeech' && (
        <>
          {!caps?.webSpeech && <p class="warn">This browser has no built-in speech recognition. Use Chrome, Edge or Safari.</p>}
          {caps?.iosStandalone && <p class="warn">iOS does not allow speech recognition in home-screen apps. Open Saybeam in Safari instead.</p>}
          <label class="field">
            <span>Language</span>
            <input type="text" value={config.lang} disabled={disabled} size={8} onInput={(e) => onChange({ ...config, lang: e.currentTarget.value.trim() || lang })} />
            <small>Use en-IN for Indian English, hi-IN for Hindi.</small>
          </label>
          {caps?.webSpeechOnDevice && onDevice !== 'unsupported' && (
            <div class="on-device">
              <label class="switch">
                <input
                  type="checkbox"
                  checked={config.onDevice}
                  disabled={disabled || onDevice === 'unavailable'}
                  onChange={(e) => onChange({ ...config, onDevice: e.currentTarget.checked, phrases: vocabulary })}
                />
                <span>
                  Recognise on this device
                  <small>{onDeviceText(onDevice)}</small>
                </span>
              </label>
              {onDevice === 'downloadable' && (
                <button
                  type="button"
                  class="btn btn-small"
                  disabled={installing}
                  onClick={async () => {
                    setInstalling(true);
                    const ok = await installOnDevice(config.lang);
                    setInstalling(false);
                    setOnDevice(ok ? 'available' : await onDeviceAvailability(config.lang));
                  }}
                >
                  {installing ? 'Downloading...' : 'Download language pack'}
                </button>
              )}
              {config.onDevice && caps.webSpeechPhrases && vocabulary.length > 0 && <p class="hint">Boosting {vocabulary.length} vocabulary words.</p>}
            </div>
          )}
          {!config.onDevice && <p class="hint">Audio is sent to your browser's speech service (Google for Chrome, Microsoft for Edge, Apple for Safari) and needs internet.</p>}
        </>
      )}

      {config.kind === 'whisperlive' && (
        <>
          <label class="field">
            <span>Server address</span>
            <input
              type="url"
              value={config.url}
              disabled={disabled}
              placeholder="ws://localhost:9090"
              onInput={(e) => onChange({ ...config, url: e.currentTarget.value.trim() })}
            />
            <small>A self-hosted collabora/WhisperLive server. Use wss:// when this page is on https.</small>
          </label>
          <div class="row gap wrap">
            <label class="field">
              <span>Model</span>
              <input
                type="text"
                list="wl-models"
                value={config.model}
                disabled={disabled}
                size={12}
                onInput={(e) => onChange({ ...config, model: e.currentTarget.value.trim() })}
              />
              <datalist id="wl-models">
                {WHISPERLIVE_MODELS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
            <label class="field">
              <span>Language</span>
              <input
                type="text"
                value={config.language ?? ''}
                placeholder="auto"
                disabled={disabled}
                size={6}
                onInput={(e) => onChange({ ...config, language: e.currentTarget.value.trim().toLowerCase() || null })}
              />
            </label>
            <label class="field">
              <span>API key (optional)</span>
              <input
                type="password"
                value={config.apiKey ?? ''}
                autocomplete="off"
                disabled={disabled}
                size={14}
                onInput={(e) => onChange({ ...config, apiKey: e.currentTarget.value || undefined })}
              />
            </label>
          </div>
          {/^ws:\/\//i.test(config.url) && !/^ws:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(config.url) && (
            <p class="warn">This address is not encrypted: audio{config.apiKey ? ' and the API key' : ''} will cross the network in the clear. Use wss:// where you can.</p>
          )}
          {micSelect(config.micId, (micId) => onChange({ ...config, ...(micId ? { micId } : { micId: undefined }) }))}
        </>
      )}
    </div>
  );
}

function onDeviceText(state: OnDeviceState): string {
  switch (state) {
    case 'available':
      return 'Ready. Works offline and keeps audio on this computer.';
    case 'downloadable':
      return 'Needs a one-time language download.';
    case 'downloading':
      return 'Language pack downloading...';
    case 'unavailable':
      return 'Not available for this language in this browser.';
    default:
      return '';
  }
}
