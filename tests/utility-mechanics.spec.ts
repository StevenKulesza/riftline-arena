import { expect, test } from '@playwright/test';

test('grapple anchors, frag grenade follows a three-second fuse, and machine tracers stick', async ({ page }) => {
  test.setTimeout(90_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/?qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));
  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('active-play');
    hooks.setReducedMotion(true);
    hooks.setPausedForScreenshot(true);
  });

  await page.keyboard.down('KeyG');
  const anchored = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    for (let pitch = -0.65; pitch <= 0.5; pitch += 0.15) {
      for (let index = 0; index < 24; index += 1) {
        hooks.setAim((index / 24) * Math.PI * 2 - Math.PI, pitch);
        hooks.toggleGrapple();
        const grapple = window.__THREE_GAME_DIAGNOSTICS__?.grapple;
        if (grapple?.active) return grapple;
      }
    }
    return null;
  });
  expect(anchored).not.toBeNull();
  if (!anchored) throw new Error('Grapple did not find a test surface.');
  expect(anchored.length).toBeGreaterThan(1.35);
  expect(anchored.length).toBeLessThanOrEqual(22.86);
  await page.keyboard.up('KeyG');
  await page.waitForTimeout(80);
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.grapple.active)).toBe(false);

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.throwGrenade());
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.grenades)).toBe(1);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(2.9));
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.grenades)).toBe(1);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(0.2));
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.grenades)).toBe(0);

  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('combat');
    hooks.setWeapon('machine');
    hooks.fireWeapon();
  });
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.tracers)).toBeGreaterThan(0);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
