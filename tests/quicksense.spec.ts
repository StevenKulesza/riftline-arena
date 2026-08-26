import { expect, test } from '@playwright/test';

const diagnostics = async (page: import('@playwright/test').Page) => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);

test('QuickSense loads as a second authored arena with layered flow geometry', async ({ page }) => {
  await page.goto('/?map=quicksense&qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));
  const result = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const centralSpine = [-54, -45, -30, 0, 30, 55].map((z) => hooks.sampleFloorHeight(0, z, 100));
    return {
      map: window.__THREE_GAME_DIAGNOSTICS__!.map,
      spawns: hooks.getSpawnPoints(),
      centralSpine,
    };
  });

  expect(result.map.name).toBe('QuickSense');
  expect(result.map.bounds).toEqual({ width: 180, depth: 160 });
  expect(result.map.spawnCount).toBe(8);
  expect(result.map.jumpPadCount).toBe(5);
  expect(result.map.skiRoutes).toBeGreaterThanOrEqual(6);
  expect(result.map.renderTriangles).toBeLessThan(10_000);
  expect(result.spawns.every((spawn) => Number.isFinite(spawn.x + spawn.y + spawn.z))).toBe(true);

  const spine = result.centralSpine.map((height) => height ?? Number.NEGATIVE_INFINITY);
  expect(spine[0]).toBeLessThan(spine[1]);
  expect(spine[1]).toBeLessThan(spine[2]);
  expect(spine[2]).toBeLessThan(spine[3]);
  expect(spine[3]).toBeLessThan(spine[4]);
  expect(spine[4]).toBeLessThan(spine[5]);
});

test('QuickSense keeps the live movement contract on its floor and transfers', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/?map=quicksense&qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));
  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('view-0');
    hooks.setPausedForScreenshot(true);
  });
  const before = await diagnostics(page);
  await page.keyboard.down('KeyW');
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(0.32));
  await page.keyboard.up('KeyW');
  const after = await diagnostics(page);

  expect(before.map.name).toBe('QuickSense');
  expect(before.player.grounded).toBe(true);
  expect(after.player.grounded).toBe(true);
  expect(after.player.speed).toBeGreaterThan(13);
  expect(after.player.position.x !== before.player.position.x || after.player.position.z !== before.player.position.z).toBe(true);
  expect(after.physics.contacts).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});

test('QuickSense exposes a working grapple anchor and bounce launch', async ({ page }) => {
  await page.goto('/?map=quicksense&qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));

  const grapple = await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__!.setState('quicksense-grapple');
    return window.__THREE_GAME_DIAGNOSTICS__!.grapple;
  });
  expect(grapple.active).toBe(true);
  expect(grapple.length).toBeGreaterThan(1.35);
  expect(grapple.length).toBeLessThanOrEqual(grapple.maxLength + 0.1);

  const bounce = await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__!.setState('quicksense-bounce');
    const player = window.__THREE_GAME_DIAGNOSTICS__!.player;
    return { speed: player.speed, verticalVelocity: player.velocity.y };
  });
  expect(bounce.speed).toBeGreaterThan(10);
  expect(bounce.verticalVelocity).toBeGreaterThan(12);
});
