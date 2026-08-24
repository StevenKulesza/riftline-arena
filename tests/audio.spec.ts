import { expect, test, type Page } from '@playwright/test';

async function audioSnapshot(page: Page) {
  return page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.audio);
}

async function startAndWaitForAudio(page: Page): Promise<NonNullable<Awaited<ReturnType<typeof audioSnapshot>>>> {
  await page.goto('/');
  await expect(page.locator('#start-button')).toBeVisible();
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_DIAGNOSTICS__ && window.__THREE_GAME_TEST_HOOKS__), null, { timeout: 30_000 });
  await page.locator('#start-button').click();
  await expect.poll(async () => (await audioSnapshot(page))?.unlocked, { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => {
    const audio = await audioSnapshot(page);
    return audio && !audio.loading && audio.loadedAssets + audio.missingAssets === audio.expectedAssets;
  }, { timeout: 150_000 }).toBe(true);
  const audio = await audioSnapshot(page);
  if (!audio) throw new Error('Audio diagnostics were not published.');
  return audio;
}

test('sample-backed audio survives combat, pause, visibility, mute, and restart lifecycle', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'The full audio lifecycle only needs one browser project.');
  // Decoding the complete 77-file ElevenLabs bank on headless Linux consumes
  // most of four minutes before lifecycle interactions begin. Keep every
  // assertion and reserve a separate two-minute window for the behavior pass.
  test.setTimeout(360_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const loaded = await startAndWaitForAudio(page);
  expect(loaded.expectedAssets).toBeGreaterThan(40);
  expect(loaded.loadedAssets).toBe(loaded.expectedAssets);
  expect(loaded.missingAssets).toBe(0);
  expect(loaded.fallbackMode).toBe(false);

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('combat'));
  const weaponCountBefore = (await audioSnapshot(page))?.playCounts['weapon.machine'] ?? 0;
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.fireWeapon());
  await expect.poll(async () => (await audioSnapshot(page))?.playCounts['weapon.machine'] ?? 0).toBeGreaterThan(weaponCountBefore);
  expect((await audioSnapshot(page))?.activeVoicesByPool['weapon.machine'] ?? 0).toBeLessThanOrEqual(7);

  const equipBefore = (await audioSnapshot(page))?.playCounts['equip.heavy'] ?? 0;
  await page.keyboard.press('Digit3');
  await expect.poll(async () => (await audioSnapshot(page))?.playCounts['equip.heavy'] ?? 0).toBeGreaterThan(equipBefore);

  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    hooks?.setState('combat');
    hooks?.setAmmo('machine', 0);
  });
  const emptyBefore = (await audioSnapshot(page))?.playCounts['weapon.empty'] ?? 0;
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.fireWeapon());
  const emptyAfter = (await audioSnapshot(page))?.playCounts['weapon.empty'] ?? 0;
  expect(emptyAfter - emptyBefore, 'one empty trigger produces one dry-fire cue').toBe(1);

  const heldEmptyBefore = emptyAfter;
  await page.keyboard.down('KeyF');
  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    hooks?.setPausedForScreenshot(true);
    hooks?.stepSimulation(0.56);
  });
  await page.keyboard.up('KeyF');
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot(false));
  const heldEmptyAfter = (await audioSnapshot(page))?.playCounts['weapon.empty'] ?? 0;
  expect(heldEmptyAfter - heldEmptyBefore, 'held dry fire is rate-limited by weapon cooldown').toBeGreaterThanOrEqual(2);
  expect(heldEmptyAfter - heldEmptyBefore, 'held dry fire must not emit once per simulation tick').toBeLessThanOrEqual(4);

  await page.keyboard.press('KeyM');
  await expect.poll(async () => (await audioSnapshot(page))?.muted).toBe(true);
  const mutedCount = (await audioSnapshot(page))?.playCounts['weapon.empty'] ?? 0;
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.fireWeapon());
  await page.waitForTimeout(300);
  expect((await audioSnapshot(page))?.playCounts['weapon.empty'] ?? 0).toBe(mutedCount);
  await page.keyboard.press('KeyM');
  await expect.poll(async () => (await audioSnapshot(page))?.muted).toBe(false);

  await page.keyboard.press('KeyP');
  await expect.poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.state)).toBe('paused');
  await expect.poll(async () => (await audioSnapshot(page))?.paused).toBe(true);
  await expect.poll(async () => (await audioSnapshot(page))?.contextState).toBe('suspended');
  const pausedCount = (await audioSnapshot(page))?.playCounts['weapon.empty'] ?? 0;
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.fireWeapon());
  await page.waitForTimeout(120);
  expect((await audioSnapshot(page))?.playCounts['weapon.empty'] ?? 0).toBe(pausedCount);
  await page.keyboard.press('KeyP');
  await expect.poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.state)).toBe('running');
  await expect.poll(async () => (await audioSnapshot(page))?.paused).toBe(false);
  await expect.poll(async () => (await audioSnapshot(page))?.contextState).toBe('running');

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(async () => (await audioSnapshot(page))?.visibilitySuspended).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(async () => (await audioSnapshot(page))?.visibilitySuspended).toBe(false);
  await expect.poll(async () => (await audioSnapshot(page))?.contextState).toBe('running');

  const resetsBefore = (await audioSnapshot(page))?.resets ?? 0;
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('complete'));
  await expect.poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.state)).toBe('complete');
  await expect(page.locator('#start-button')).toHaveText('RESTART MATCH');
  await expect.poll(async () => (await audioSnapshot(page))?.activeVoices).toBe(0);
  await page.locator('#start-button').click();
  await expect.poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.state)).toBe('running');
  await expect(page.locator('#start-overlay')).toBeHidden();
  const restarted = await audioSnapshot(page);
  expect(restarted?.paused).toBe(false);
  expect(restarted?.resets ?? 0).toBeGreaterThan(resetsBefore);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('lo-fi arena bed starts as one looping music voice', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'The music-loop contract only needs one browser project.');
  test.setTimeout(120_000);
  await page.route('**/assets/audio/**', (route) => {
    if (route.request().url().endsWith('/assets/audio/music/riftline-ambient-loop.mp3')) {
      void route.continue();
    } else {
      void route.fulfill({ status: 404, body: '' });
    }
  });

  const audio = await startAndWaitForAudio(page);
  expect(audio.loadedAssets).toBe(1);
  expect(audio.playCounts['music.arena-bed']).toBe(1);
  expect(audio.activeVoicesByPool['music.arena-bed']).toBe(1);
});

test('missing ElevenLabs files are reported without synthesizing fallback audio', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'The missing-asset contract only needs one browser project.');
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/assets/audio/**', (route) => route.fulfill({ status: 404, body: '' }));

  const audio = await startAndWaitForAudio(page);
  expect(audio.loadedAssets).toBe(0);
  expect(audio.missingAssets).toBe(audio.expectedAssets);
  expect(audio.fallbackMode).toBe(false);

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('combat'));
  const before = (await audioSnapshot(page))?.playCounts['weapon.machine'] ?? 0;
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.fireWeapon());
  await expect.poll(async () => (await audioSnapshot(page))?.playCounts['weapon.machine'] ?? 0).toBeGreaterThan(before);
  expect((await audioSnapshot(page))?.activeVoices).toBe(0);
  expect(
    consoleErrors.filter((message) => !message.includes('Failed to load resource: the server responded with a status of 404')),
  ).toEqual([]);
  expect(pageErrors).toEqual([]);
});
