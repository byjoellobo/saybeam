import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { DEFAULT_LISTENER_PREFS, type FontChoice, type ListenerPrefs, type Theme } from '../lib/storage';

interface DisplaySettingsProps {
  readonly open: boolean;
  readonly prefs: ListenerPrefs;
  readonly onChange: (prefs: ListenerPrefs) => void;
  readonly onClose: () => void;
  /** Extra sections (e.g. transcript download). */
  readonly children?: ComponentChildren;
}

const THEMES: ReadonlyArray<{ id: Theme; label: string }> = [
  { id: 'dark', label: 'White on black' },
  { id: 'yellow', label: 'Yellow on black' },
  { id: 'light', label: 'Black on white' },
  { id: 'inverse', label: 'Black on yellow' },
  { id: 'cream', label: 'Low glare' },
];

const FONTS: ReadonlyArray<{ id: FontChoice; label: string }> = [
  { id: 'hyperlegible', label: 'Atkinson Hyperlegible Next' },
  { id: 'system', label: 'System sans' },
  { id: 'serif', label: 'Serif' },
  { id: 'mono', label: 'Atkinson Hyperlegible Mono' },
];

export function DisplaySettings({ open, prefs, onChange, onClose, children }: DisplaySettingsProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const set = <K extends keyof ListenerPrefs>(key: K, value: ListenerPrefs[K]) => onChange({ ...prefs, [key]: value });
  const toggle = (key: 'bold' | 'uppercase' | 'showPartial' | 'announce' | 'keepAwake' | 'showTimes', label: string, hint?: string) => (
    <label class="switch">
      <input type="checkbox" checked={prefs[key]} onChange={(e) => set(key, e.currentTarget.checked)} />
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );

  return (
    <dialog ref={ref} class="sheet" aria-labelledby="display-title" onClose={onClose} onCancel={onClose}>
      <div class="sheet-head">
        <h2 id="display-title">Display</h2>
        <button type="button" class="btn btn-small" onClick={onClose}>
          Done
        </button>
      </div>

      <fieldset>
        <legend>Text size</legend>
        <div class="size-row">
          <input type="range" min={16} max={140} step={2} value={prefs.fontSize} aria-label="Text size" onInput={(e) => set('fontSize', Number(e.currentTarget.value))} />
          <output>{prefs.fontSize}px</output>
        </div>
        <div class="size-buttons">
          <button type="button" class="btn" onClick={() => set('fontSize', Math.max(16, prefs.fontSize - 4))}>
            Smaller
          </button>
          <button type="button" class="btn" onClick={() => set('fontSize', Math.min(140, prefs.fontSize + 4))}>
            Larger
          </button>
        </div>
      </fieldset>

      <fieldset>
        <legend>Colours</legend>
        <div class="swatches" role="radiogroup" aria-label="Colour theme">
          {THEMES.map((t) => (
            <label key={t.id} class={`swatch theme-${t.id}${prefs.theme === t.id ? ' selected' : ''}`}>
              <input type="radio" name="theme" checked={prefs.theme === t.id} onChange={() => set('theme', t.id)} />
              <span class="swatch-sample">Aa</span>
              <span class="swatch-label">{t.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Font</legend>
        <select value={prefs.font} onChange={(e) => set('font', e.currentTarget.value as FontChoice)} aria-label="Font">
          {FONTS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
        <label class="slider">
          <span>Line spacing</span>
          <input type="range" min={1.1} max={2.2} step={0.05} value={prefs.lineHeight} onInput={(e) => set('lineHeight', Number(e.currentTarget.value))} />
        </label>
        <label class="slider">
          <span>Letter spacing</span>
          <input type="range" min={0} max={0.2} step={0.01} value={prefs.letterSpacing} onInput={(e) => set('letterSpacing', Number(e.currentTarget.value))} />
        </label>
      </fieldset>

      <fieldset>
        <legend>Layout</legend>
        <div class="segmented" role="radiogroup" aria-label="Layout">
          <label class={prefs.layout === 'scroll' ? 'selected' : ''}>
            <input type="radio" name="layout" checked={prefs.layout === 'scroll'} onChange={() => set('layout', 'scroll')} />
            Full transcript
          </label>
          <label class={prefs.layout === 'stage' ? 'selected' : ''}>
            <input type="radio" name="layout" checked={prefs.layout === 'stage'} onChange={() => set('layout', 'stage')} />
            Latest lines only
          </label>
        </div>
        <div class="segmented" role="radiogroup" aria-label="Alignment">
          <label class={prefs.align === 'left' ? 'selected' : ''}>
            <input type="radio" name="align" checked={prefs.align === 'left'} onChange={() => set('align', 'left')} />
            Left
          </label>
          <label class={prefs.align === 'center' ? 'selected' : ''}>
            <input type="radio" name="align" checked={prefs.align === 'center'} onChange={() => set('align', 'center')} />
            Centre
          </label>
        </div>
      </fieldset>

      <fieldset class="switches">
        <legend>Options</legend>
        {toggle('bold', 'Bold text')}
        {toggle('uppercase', 'ALL CAPS')}
        {toggle('showPartial', 'Show words as they are recognised', 'They may change for a moment before settling.')}
        {toggle('showTimes', 'Show times')}
        {toggle('keepAwake', 'Keep screen on')}
        {toggle('announce', 'Announce new captions to screen readers', 'For braille displays and screen reader users.')}
      </fieldset>

      {children}

      <button type="button" class="btn btn-ghost" onClick={() => onChange(DEFAULT_LISTENER_PREFS)}>
        Reset to defaults
      </button>
    </dialog>
  );
}
