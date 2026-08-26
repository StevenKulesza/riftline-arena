import { expect, test } from '@playwright/test';

const diagnostics = async (page: import('@playwright/test').Page) => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);

test('QuickSense loads as a second authored arena with layered flow geometry', async ({ page }) => {
  await page.goto('/?map=quicksense&qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));
  const result = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const layeredSpine = [-138, -100, -60, 0, 60, 100, 138].map((z) => hooks.sampleFloorHeight(0, z, 160));
    return {
      map: window.__THREE_GAME_DIAGNOSTICS__!.map,
      spawns: hooks.getSpawnPoints(),
      layeredSpine,
    };
  });

  expect(result.map.name).toBe('QuickSense');
  expect(result.map.bounds).toEqual({ width: 360, depth: 320 });
  expect(result.map.spawnCount).toBe(8);
  expect(result.map.jumpPadCount).toBe(5);
  expect(result.map.altitudeRange.max).toBeGreaterThanOrEqual(70);
  expect(result.map.skiRoutes).toBeGreaterThanOrEqual(8);
  expect(result.map.renderTriangles).toBeLessThan(25_000);
  expect(result.spawns.every((spawn) => Number.isFinite(spawn.x + spawn.y + spawn.z))).toBe(true);

  expect(result.layeredSpine.every((height) => height !== null)).toBe(true);
  const spine = result.layeredSpine as number[];
  expect(Math.max(...spine) - Math.min(...spine)).toBeGreaterThan(20);
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

test('QuickSense exposes pumpable rollers and a progressive launch profile', async ({ page }) => {
  await page.goto('/?map=quicksense&qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));

  const profiles = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setPausedForScreenshot(true);
    const outerCircuit = [
      [0, -144], [-60, -146], [-118, -124], [-150, -76], [-158, -14],
      [-150, 50], [-122, 102], [-72, 134], [-20, 140],
    ].map(([x, z]) => hooks.sampleFloorHeight(x, z, 160));
    const southLaunch = [-138, -126, -114, -102, -90, -78]
      .map((z) => hooks.sampleFloorHeight(0, z, 160));
    return { outerCircuit, southLaunch };
  });

  expect(profiles.outerCircuit.every((height) => height !== null)).toBe(true);
  const outer = profiles.outerCircuit as number[];
  const outerDeltas = outer.slice(1).map((height, index) => height - outer[index]);
  expect(outerDeltas.filter((delta) => delta > 1.5).length).toBeGreaterThanOrEqual(3);
  expect(outerDeltas.filter((delta) => delta < -1.5).length).toBeGreaterThanOrEqual(3);

  expect(profiles.southLaunch.every((height) => height !== null)).toBe(true);
  const launch = profiles.southLaunch as number[];
  const launchDeltas = launch.slice(1).map((height, index) => height - launch[index]);
  expect(launchDeltas.every((delta) => delta > 0)).toBe(true);
  expect(launchDeltas.at(-1)!).toBeGreaterThan(launchDeltas[0] * 2.5);

  const downhillStart = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const y = hooks.sampleFloorHeight(-122, 102, 160) ?? 0;
    hooks.setPlayerKinematics(
      { x: -122, y, z: 102 },
      { x: -6.64, y: 0, z: -12.34 },
    );
    return window.__THREE_GAME_DIAGNOSTICS__!.player;
  });
  await page.keyboard.down('ShiftLeft');
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(1.5));
  await page.keyboard.up('ShiftLeft');
  const downhill = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.player);
  expect(downhill.skiing).toBe(true);
  expect(downhill.position.y).toBeLessThan(downhillStart.position.y - 3);
  expect(downhill.speed).toBeGreaterThan(downhillStart.speed + 3);
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
