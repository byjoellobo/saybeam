import { createRoom, expect, expectAccessible, ScriptedClient, test } from './helpers';

/**
 * The app follows the device's light or dark setting, and the listener view
 * has its own reader-chosen themes. Every combination must meet WCAG 2.1 AA.
 */
/** WCAG 1.4.10 Reflow: nothing may need sideways scrolling on a small phone. axe cannot see this. */
for (const width of [320, 390]) {
  test(`no page scrolls sideways at ${width}px`, async ({ browser, request }) => {
    const room = await createRoom(request);
    const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });
    await context.addInitScript((r) => {
      localStorage.setItem('saybeam:rooms', JSON.stringify([{ ...r, title: 'Physics 11B: how sound travels', createdAt: Date.now() }]));
    }, room);
    const page = await context.newPage();
    const pages = ['/', '/about', '/bench', `/r/${room.code}`, `/speak/${room.code}`, `/fix/${room.code}#${room.correctorToken}`];
    for (const path of pages) {
      await page.goto(path);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${path} is ${overflow}px wider than a ${width}px screen`).toBeLessThanOrEqual(0);
    }
    await context.close();
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} appearance`, () => {
    test.use({ colorScheme, reducedMotion: 'reduce' });

    test('site pages and the speaker console pass accessibility checks', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: /Live captions for everyone in the room/ })).toBeVisible();
      await expectAccessible(page, `home page (${colorScheme})`);

      await page.goto('/about');
      await expectAccessible(page, `about page (${colorScheme})`);
      await page.goto('/bench');
      await expectAccessible(page, `bench (${colorScheme})`);

      await page.goto('/');
      await page.getByRole('button', { name: 'Create a room' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
      await expectAccessible(page, `speaker console (${colorScheme})`);
    });

    test('every listener theme passes accessibility checks', async ({ page, request, baseURL }) => {
      const room = await createRoom(request);
      const speaker = await ScriptedClient.connect(baseURL ?? '', room.code, 'speaker', room.speakerToken);
      await speaker.say('theme-1', 'Captions in every colour theme stay readable.');
      await page.goto(`/r/${room.code}`);
      await expect(page.getByText('Captions in every colour theme stay readable.')).toBeVisible();

      for (const theme of [/White on black/, /Yellow on black/, /Black on white/, /Black on yellow/, /Low glare/]) {
        await page.getByRole('button', { name: 'Display settings' }).click();
        await page.getByRole('radio', { name: theme }).check();
        await expectAccessible(page, `display settings (${colorScheme}, ${theme.source})`);
        await page.getByRole('button', { name: 'Done' }).click();
        await expectAccessible(page, `listener view (${colorScheme}, ${theme.source})`);
      }
      speaker.close();
    });
  });
}
