import { expect, test } from '@playwright/test';

test('humanoid assets, grounded pickups, route diversity, FOV, and BSP occlusion hold', async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.bots?.every((bot) => bot.modelReady), null, { timeout: 30_000 });
  // SwiftShader can spend several seconds compiling the nine skinned-mesh
  // material variants after GLTF parsing has completed. Verify a real render,
  // but give that separate GPU-readiness phase its own evidence window.
  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.bots?.every((bot) => bot.renderedMeshCount >= 4), null, { timeout: 45_000 });

  const assets = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
  expect(assets?.bots.every((bot) => bot.modelMeshCount >= 4 && bot.renderedMeshCount >= 4)).toBe(true);
  expect(assets?.bots.every((bot) => bot.modelHeight > 1.6 && bot.modelHeight < 2.05)).toBe(true);
  expect(assets?.bots.every((bot) => bot.modelWidth > 0.5 && bot.modelWidth < 1.2)).toBe(true);
  expect(assets?.pickups.every((pickup) => Math.abs(pickup.groundOffset) < 0.001)).toBe(true);
  expect(assets?.pickups.every((pickup) => pickup.modelName.endsWith('-grounded-pickup'))).toBe(true);
  expect(assets?.pickups.filter((pickup) => ['rail', 'rocket', 'plasma', 'shotgun', 'sniper', 'laser'].includes(pickup.kind)).every((pickup) => pickup.hasAuthoredWeapon)).toBe(true);

  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    hooks?.setReducedMotion(true);
    hooks?.setState('active-play');
    // Stop the real requestAnimationFrame simulation so every visibility and
    // reaction assertion advances only through deterministic fixed steps.
    hooks?.setPausedForScreenshot(true);
    hooks?.stepSimulation(0.25);
  });
  const routed = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.bots ?? []);
  const distinctRoutes = new Set(routed.map((bot) => `${bot.navigationTarget.x.toFixed(2)},${bot.navigationTarget.z.toFixed(2)}`));
  expect(distinctRoutes.size).toBeGreaterThanOrEqual(3);
  const starts = routed.map((bot) => bot.position);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(1.5));
  const moved = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.bots ?? []);
  const totalTravel = moved.reduce((sum, bot, index) => sum + Math.hypot(bot.position.x - starts[index].x, bot.position.z - starts[index].z), 0);
  expect(totalTravel).toBeGreaterThan(2);
  const shotsBeforeAway = moved[0]?.shotsFired ?? 0;

  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    hooks?.setState('combat');
    const diagnostics = window.__THREE_GAME_DIAGNOSTICS__!;
    hooks?.setCombatants(diagnostics.player.position, diagnostics.bots[0].position, false);
    hooks?.stepSimulation(0.12);
  });
  const turnedAway = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.bots[0]);
  expect(turnedAway?.facingDot).toBeLessThan(0.325);
  expect(turnedAway?.targetVisible).toBe(false);
  expect(turnedAway?.shotsFired).toBe(shotsBeforeAway);

  const clearPositions = await page.evaluate(() => {
    const diagnostics = window.__THREE_GAME_DIAGNOSTICS__!;
    return { player: diagnostics.player.position, bot: diagnostics.bots[0].position };
  });
  await page.evaluate(({ player, bot }) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    hooks?.setCombatants(player, bot, true);
    hooks?.stepSimulation(0.01);
  }, clearPositions);
  const facing = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.bots[0]);
  expect(facing?.facingDot).toBeGreaterThan(0.325);
  expect(facing?.targetVisible).toBe(true);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(0.22));
  const reacted = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.bots[0]);
  expect(reacted?.shotsFired ?? 0).toBeGreaterThan(shotsBeforeAway);

  const blockedPair = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const points = hooks.getSpawnPoints();
    for (let first = 0; first < points.length; first += 1) {
      for (let second = first + 1; second < points.length; second += 1) {
        const player = points[first];
        const bot = points[second];
        const clear = hooks.sampleLineOfSight(
          { x: player.x, y: player.y + 0.7, z: player.z },
          { x: bot.x, y: bot.y + 1.5, z: bot.z },
        );
        if (!clear) return { player, bot };
      }
    }
    throw new Error('Expected at least one BSP-occluded spawn pair.');
  });
  const shotsBeforeWall = reacted?.shotsFired ?? 0;
  await page.evaluate(({ player, bot }) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    hooks?.setCombatants(player, bot, true);
    hooks?.stepSimulation(0.5);
  }, blockedPair);
  const blocked = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.bots[0]);
  expect(blocked?.targetVisible).toBe(false);
  expect(blocked?.shotsFired).toBe(shotsBeforeWall);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
