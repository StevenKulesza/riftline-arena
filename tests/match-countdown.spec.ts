import { expect, test } from '@playwright/test';

test('Ready–3–2–1 locks weapons and releases fire only after the final cue', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'The countdown state contract only needs one browser project.');
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  // State timing is independent from Chromium's unusually slow headless MP3
  // decoder. The real files are verified separately; 404s still settle the
  // priority loader and exercise every announcer trigger exactly once.
  await page.route('**/assets/audio/**', (route) => void route.fulfill({ status: 404, body: '' }));

  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot(true));
  const ammoBefore = Number(await page.locator('#ammo-value').textContent());

  await page.locator('#start-button').click();
  await expect.poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.state)).toBe('countdown');
  await expect(page.locator('#countdown-overlay')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.countdown.armed)).toBe(true);
  await expect(page.locator('#countdown-value')).toHaveText('READY');
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.countdown.weaponsLocked)).toBe(true);

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.fireWeapon());
  expect(Number(await page.locator('#ammo-value').textContent())).toBe(ammoBefore);
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.combat.lastShotWeapon)).toBeNull();

  for (const cue of ['3', '2', '1'] as const) {
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(1.01));
    await expect(page.locator('#countdown-value')).toHaveText(cue);
  }

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(1.01));
  await expect.poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.state)).toBe('running');
  await expect(page.locator('#countdown-overlay')).toBeHidden();
  const announcerCounts = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.audio.playCounts);
  expect(announcerCounts?.['announcer.ready']).toBe(1);
  expect(announcerCounts?.['announcer.three']).toBe(1);
  expect(announcerCounts?.['announcer.two']).toBe(1);
  expect(announcerCounts?.['announcer.one']).toBe(1);

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.fireWeapon());
  expect(Number(await page.locator('#ammo-value').textContent())).toBe(ammoBefore - 1);
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.combat.lastShotWeapon)).toBe('machine');
  expect(pageErrors).toEqual([]);
});
