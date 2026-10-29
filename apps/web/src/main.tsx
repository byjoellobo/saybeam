import { render } from 'preact';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import './styles/base.css';
import './styles/listener.css';
import './styles/speaker.css';
import { App } from './app';

const root = document.getElementById('app');
if (root) render(<App />, root);

// Offline-capable app shell. Skipped in dev so hot reload is not cached.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true })).catch(() => undefined);
}
