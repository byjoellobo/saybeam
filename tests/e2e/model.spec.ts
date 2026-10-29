import { expect, test } from '@playwright/test';

/**
 * The whole pipeline with real on-device speech recognition: a fake microphone
 * plays E2E_AUDIO into the speaker console, Moonshine Tiny transcribes it in a
 * Web Worker, and a listener page shows the captions. Downloads the model
 * (about 55 MB) on first run. Run with:
 *
 *   E2E_AUDIO=/path/to/speech-16k.wav npm run e2e:model
 */
test('@model speech from the microphone reaches a listener as captions', async ({ page, browser }) => {
  test.skip(!process.env.E2E_AUDIO, 'set E2E_AUDIO to a WAV file of speech');

  await page.addInitScript(() => {
    localStorage.setItem(
      'caption-room:speaker-prefs',
      JSON.stringify({ engine: { kind: 'local', modelId: 'moonshine-tiny', device: 'wasm', language: null, partials: true }, replacements: '', vocabulary: '' }),
    );
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a room' }).click();
  await expect(page).toHaveURL(/\/speak\/([A-Z0-9]{6})$/);
  const code = page.url().split('/').pop() ?? '';

  const listener = await browser.newPage();
  await listener.goto(`/r/${code}`);

  await page.getByRole('button', { name: 'Start captioning' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Captioning' })).toBeVisible({ timeout: 180_000 });

  // Any recognised words prove the chain works; the bench measures accuracy.
  await expect(listener.locator('.caption-para .seg').first()).toBeVisible({ timeout: 120_000 });
  const wordCount = async () => ((await listener.locator('.caption-para').allTextContents()).join(' ').match(/\S+/g) ?? []).length;
  await expect.poll(wordCount, { timeout: 120_000 }).toBeGreaterThan(10);
});
