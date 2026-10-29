import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run the real stack: the built PWA served by the Cloudflare
 * Worker and Durable Objects under `wrangler dev` (port 8791, separate from the
 * usual dev port). The `model` project runs real on-device speech recognition
 * from a fake microphone and needs E2E_AUDIO=<path to a 16 kHz WAV of speech>.
 */
const PORT = 8791;
const audio = process.env.E2E_AUDIO ?? '';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    // CI downloads the already-built app; locally, build first.
    command: `${process.env.CI ? '' : 'npm run build && '}npx wrangler dev --config apps/worker/wrangler.jsonc --port ${PORT} --ip 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/api/info`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: { WRANGLER_SEND_METRICS: 'false' },
  },
  projects: [
    { name: 'app', use: { ...devices['Desktop Chrome'] }, grepInvert: /@model|@screenshots/ },
    { name: 'docs', use: { ...devices['Desktop Chrome'] }, grep: /@screenshots/ },
    {
      name: 'model',
      grep: /@model/,
      timeout: 300_000,
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['microphone'],
        launchOptions: {
          args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...(audio ? [`--use-file-for-fake-audio-capture=${audio}`] : [])],
        },
      },
    },
  ],
});
