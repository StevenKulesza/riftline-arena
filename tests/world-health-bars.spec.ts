import { expect, test } from '@playwright/test';

test('people, drones, and fighters share compact instanced world health bars', async ({ page }) => {
  test.setTimeout(240_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/?map=quicksense&qa=visual', { waitUntil: 'commit' });
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__), null, { timeout: 240_000 });
  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setReducedMotion(true);
    hooks.setState('drone-encounter');
    hooks.setPausedForScreenshot(true);
  });
  await page.waitForFunction(() => (
    (window.__THREE_GAME_DIAGNOSTICS__?.worldHealthBars.visibleCount ?? 0) > 0
  ));

  const initial = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.worldHealthBars);
  expect(initial.targetCount).toBe(12);
  expect(initial.categories).toEqual({ person: 3, drone: 5, craft: 4 });
  expect(initial.drawCalls).toBe(1);
  expect(initial.visibleCount).toBeGreaterThan(0);
  expect(initial.entries.every((entry) => entry.ratio >= 0 && entry.ratio <= 1)).toBe(true);
  expect(initial.entries.find((entry) => entry.id === 'drone-1')).toMatchObject({
    kind: 'drone',
    ratio: 1,
  });
  expect(initial.entries.find((entry) => entry.id === 'bot-0')?.kind).toBe('person');
  expect(initial.entries.find((entry) => entry.id === 'sparrow-north-west')?.kind).toBe('craft');

  const damaged = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.damageDrone('drone-1', 45);
    hooks.damageFighter('sparrow-north-west', 200);
    return window.__THREE_GAME_DIAGNOSTICS__!.worldHealthBars;
  });
  expect(damaged.entries.find((entry) => entry.id === 'drone-1')?.ratio).toBeCloseTo(0.8, 4);
  expect(damaged.entries.find((entry) => entry.id === 'sparrow-north-west')?.ratio).toBeCloseTo(1100 / 1300, 4);

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.damageDrone('drone-1', 1_000));
  await page.waitForFunction(() => {
    const bar = window.__THREE_GAME_DIAGNOSTICS__?.worldHealthBars.entries
      .find((entry) => entry.id === 'drone-1');
    return bar?.ratio === 0 && bar.rendered === false;
  });

  // The separately developed Flamethrower GLB currently reports missing blob
  // textures while its loader is in progress. Keep this focused check strict
  // for every other browser error without conflating that asset-pipeline WIP.
  expect(consoleErrors.filter((message) => (
    !message.startsWith("THREE.GLTFLoader: Couldn't load texture blob:")
  ))).toEqual([]);
  expect(pageErrors).toEqual([]);
});
