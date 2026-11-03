import { render } from 'preact';
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css';
import '@fontsource-variable/atkinson-hyperlegible-mono/wght.css';
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
