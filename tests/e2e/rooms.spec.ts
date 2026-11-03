import { createRoom, expect, expectAccessible, ScriptedClient, test } from './helpers';

test.describe('starting a room', () => {
  test('home page is accessible and creates a room with a QR code', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Saybeam' })).toBeVisible();
    await expectAccessible(page, 'home page');

    await page.getByLabel('Session name (optional)').fill('Physics 11B');
    await page.getByRole('button', { name: 'Create a room' }).click();
    await expect(page).toHaveURL(/\/speak\/[A-Z0-9]{6}$/);
    await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
    await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
    await expectAccessible(page, 'speaker console');
  });

  test('a private room hides its code-only entry and its title', async ({ page, request }) => {
    await page.goto('/');
    await page.getByLabel('Session name (optional)').fill('Staff meeting');
    await page.getByRole('checkbox', { name: /Private room/ }).check();
    await page.getByRole('button', { name: 'Create a room' }).click();
    await expect(page).toHaveURL(/\/speak\/([A-Z0-9]{6})$/);
    const code = page.url().split('/').pop() ?? '';
    await expect(page.getByText(/Private room: people need this QR code/)).toBeVisible();
    const summary = await (await request.get(`/api/rooms/${code}`)).json();
    expect(summary).toMatchObject({ private: true, title: '' });

    // Typing the code alone on the home page explains what to do instead.
    await page.goto('/');
    await page.locator('#room-code').fill(code);
    await page.getByRole('button', { name: 'Show captions' }).click();
    await expect(page.getByRole('alert')).toContainText('private room');
  });
});

test.describe('following captions', () => {
  test.use({ viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true });

  test('a listener sees partials and finals, scrolls back, and jumps to live', async ({ page, request, baseURL }) => {
    const room = await createRoom(request);
    await page.goto(`/r/${room.code}`);
    await expect(page.getByText('Waiting for the speaker to start')).toBeVisible();

    const speaker = await ScriptedClient.connect(baseURL ?? '', room.code, 'speaker', room.speakerToken);
    for (let i = 0; i < 12; i++) {
      await speaker.say(`e2e-${i}`, `Line number ${i} of the lecture about how sound travels through air and water.`);
    }
    await expect(page.getByText('Line number 11 of the lecture')).toBeVisible();
    await expectAccessible(page, 'listener view');

    // Layout changes alone never stop the captions following...
    const region = page.getByRole('region', { name: /Live captions/ });
    await expect(page.getByRole('button', { name: /Back to live/ })).toBeHidden();
    // ...but the reader scrolling back does, and new lines are counted.
    await region.hover();
    await page.mouse.wheel(0, -20_000);
    await speaker.say('e2e-new', 'A brand new line while the reader is scrolled up.');
    const jump = page.getByRole('button', { name: /Back to live \(1 new\)/ });
    await expect(jump).toBeVisible();
    await jump.click();
    await expect(jump).toBeHidden();
    speaker.close();
  });

  test('display settings change the theme and persist', async ({ page, request }) => {
    const room = await createRoom(request);
    await page.goto(`/r/${room.code}`);
    await page.getByRole('button', { name: 'Display settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Display' });
    await expect(dialog).toBeVisible();
    await expectAccessible(page, 'display settings');
    await dialog.getByRole('radio', { name: /Yellow on black/ }).check();
    await dialog.getByRole('button', { name: 'Larger' }).click();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('main.listener')).toHaveClass(/theme-yellow/);
    await page.reload();
    await expect(page.locator('main.listener')).toHaveClass(/theme-yellow/);
    await expect(page.locator('.captions')).toHaveCSS('font-size', '38px');
  });

  test('a corrector fixes a line and every listener sees it', async ({ page, browser, request, baseURL }) => {
    const room = await createRoom(request);
    await page.goto(`/r/${room.code}`);
    const speaker = await ScriptedClient.connect(baseURL ?? '', room.code, 'speaker', room.speakerToken);
    await speaker.say('c-1', 'The speed of sound is roughly three hundred metres per second.');
    await expect(page.getByText('three hundred metres')).toBeVisible();

    const correctorContext = await browser.newContext();
    const corrector = await correctorContext.newPage();
    await corrector.goto(`/fix/${room.code}#${room.correctorToken}`);
    await expect(corrector).toHaveURL(new RegExp(`/fix/${room.code}$`)); // secret removed from the address bar
    await corrector.getByRole('button', { name: /three hundred metres/ }).click();
    await corrector.getByRole('textbox', { name: /Edit caption/ }).fill('The speed of sound is roughly 343 metres per second.');
    await corrector.keyboard.press('Enter');
    await expectAccessible(corrector, 'corrector view');

    await expect(page.getByText('roughly 343 metres')).toBeVisible();
    await expect(page.getByText('three hundred metres')).toBeHidden();
    speaker.close();
    await correctorContext.close();
  });

  test('a listener catches up on captions missed while offline', async ({ page, context, request, baseURL }) => {
    const room = await createRoom(request);
    await page.goto(`/r/${room.code}`);
    const speaker = await ScriptedClient.connect(baseURL ?? '', room.code, 'speaker', room.speakerToken);
    await speaker.say('o-1', 'Before the network dropped.');
    await expect(page.getByText('Before the network dropped.')).toBeVisible();

    await context.setOffline(true);
    await speaker.say('o-2', 'Spoken while this phone was offline.');
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByText('Spoken while this phone was offline.')).toBeVisible({ timeout: 20_000 });
    speaker.close();
  });
});

test.describe('private rooms', () => {
  test('need the secret from the QR link, and a replaced link locks people out', async ({ page, request, baseURL }) => {
    const room = await createRoom(request, { private: true });
    expect(room.listenerToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await page.goto(`/r/${room.code}`);
    await expect(page.getByRole('alert')).toContainText('private room');

    await page.goto(`/r/${room.code}#k=${room.listenerToken}`);
    await expect(page).toHaveURL(new RegExp(`/r/${room.code}$`));
    const speaker = await ScriptedClient.connect(baseURL ?? '', room.code, 'speaker', room.speakerToken);
    await speaker.say('p-1', 'Only people with the link can read this.');
    await expect(page.getByText('Only people with the link can read this.')).toBeVisible();

    speaker.send({ t: 'rotate', target: 'listener' });
    await speaker.waitFor((m) => m.t === 'rotated');
    await expect(page.getByRole('alert')).toContainText('private room');
    speaker.close();
  });
});
