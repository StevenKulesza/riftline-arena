import { expect, test } from '@playwright/test';

test('QuickSense drones leave walls cleanly and turn toward the shooter after a hit', async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/?qa=visual&map=quicksense', { waitUntil: 'commit' });
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__), null, { timeout: 120_000 });
  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setReducedMotion(true);
    hooks.seed(450600);
    hooks.setState('drone-encounter');
    hooks.setPausedForScreenshot(true);
  });

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepDrones(18));
  const flight = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);
  const flightMaxX = flight.map.bounds.width * 0.47 - 1.1;
  const flightMaxZ = flight.map.bounds.depth * 0.47 - 1.1;
  expect(flight.drones.every((drone) => (
    Math.abs(drone.position.x) <= flightMaxX
    && Math.abs(drone.position.z) <= flightMaxZ
    && Math.hypot(drone.velocity.x, drone.velocity.z) > 1
  ))).toBe(true);
  expect(flight.drones.every((drone) => drone.collisionHits < 30)).toBe(true);
  expect(flight.busterDrones.every((drone) => drone.avoidanceActivations < 60)).toBe(true);

  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('drone-encounter');
    hooks.setPausedForScreenshot(true);
    hooks.damageDrone('drone-1', 1);
  });
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(0.35));
  const flyingHit = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.drones[0]);
  expect(flyingHit.targetOwner).toBe('player');
  expect(flyingHit.state).toBe('evade');
  expect(Math.hypot(flyingHit.velocity.x, flyingHit.velocity.z)).toBeGreaterThan(1);

  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('flamethrower-encounter');
    hooks.setPausedForScreenshot(true);
    hooks.damageDrone('grenadier-2', 1);
  });
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(0.35));
  const groundHit = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.flamethrowerDrones[1]);
  expect(groundHit.targetOwner).toBe('player');
  expect(['patrol', 'stalk', 'attack-windup', 'attack-recover', 'jump-anticipation']).toContain(groundHit.state);
  expect(Math.hypot(groundHit.velocity.x, groundHit.velocity.z)).toBeGreaterThan(0.25);
  expect(pageErrors).toEqual([]);
});
