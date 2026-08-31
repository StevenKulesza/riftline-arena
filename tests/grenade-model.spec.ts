import { expect, test } from '@playwright/test';

test('imported grenade remains collision-bounded until its fuse expires', async ({ page }) => {
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
    hooks.throwGrenade();
  });

  const spawned = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.grenadeStates[0]);
  expect(spawned.modelName).toBe('a-star-wars-grenade');
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.grenades)).toBe(1);

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(2.9));
  const beforeFuse = await page.evaluate(() => {
    const diagnostics = window.__THREE_GAME_DIAGNOSTICS__!;
    return {
      grenade: diagnostics.grenadeStates[0],
      bounds: diagnostics.map.bounds,
      minimumY: diagnostics.map.altitudeRange.min,
    };
  });
  expect(beforeFuse.grenade.bounces).toBeGreaterThan(0);
  expect(beforeFuse.grenade.position.y).toBeGreaterThan(beforeFuse.minimumY - 1);
  expect(Math.abs(beforeFuse.grenade.position.x)).toBeLessThan(beforeFuse.bounds.width * 0.5 + 1);
  expect(Math.abs(beforeFuse.grenade.position.z)).toBeLessThan(beforeFuse.bounds.depth * 0.5 + 1);
  expect(Math.hypot(
    beforeFuse.grenade.velocity.x,
    beforeFuse.grenade.velocity.y,
    beforeFuse.grenade.velocity.z,
  )).toBeLessThan(22);

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(0.2));
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.grenades)).toBe(0);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
