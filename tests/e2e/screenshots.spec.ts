import { createRoom, expect, ScriptedClient, test } from './helpers';

/**
 * Regenerates the README screenshots in docs/images. Run with:
 *
 *   npm run screenshots
 */
const LECTURE = [
  'Good morning, everyone, and welcome back.',
  'Today we are going to talk about how sound travels through air.',
  'When I speak, my vocal cords vibrate and push the air molecules around them.',
  'Those molecules bump into their neighbours, and the wave moves outward.',
  'In air at room temperature, sound travels at roughly 343 metres per second.',
  'That is why you see lightning before you hear the thunder.',
];

test('@screenshots README images', async ({ browser, request, baseURL }) => {
  const room = await createRoom(request, { title: 'Physics 11B: how sound travels' });

  const phone = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const listener = await phone.newPage();
  await listener.goto(`/r/${room.code}`);

  const speaker = await ScriptedClient.connect(baseURL ?? '', room.code, 'speaker', room.speakerToken);
  for (const [i, line] of LECTURE.entries()) await speaker.say(`shot-${i}`, line);
  speaker.send({ t: 'partial', id: 'shot-next', text: 'Can everyone at the back hear me' });
  await expect(listener.getByText('Can everyone at the back hear me')).toBeVisible();
  await listener.screenshot({ path: 'docs/images/listener.png' });

  await listener.getByRole('button', { name: 'Display settings' }).click();
  await listener.getByRole('radio', { name: /Yellow on black/ }).check();
  await listener.screenshot({ path: 'docs/images/settings.png' });
  speaker.close();
  await phone.close();

  const desktop = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 });
  const console = await desktop.newPage();
  await console.addInitScript((r) => {
    localStorage.setItem('saybeam:rooms', JSON.stringify([{ ...r, title: 'Physics 11B: how sound travels', createdAt: Date.now() }]));
  }, room);
  await console.goto(`/speak/${room.code}`);
  await expect(console.getByText('343 metres per second')).toBeVisible();
  await expect(console.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
  await console.screenshot({ path: 'docs/images/speaker.png' });
  await desktop.close();
});
