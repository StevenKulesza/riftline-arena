import { expect, test } from '@playwright/test';

for (const map of [
  { label: 'Monsoon Divide', query: '' },
  { label: 'QuickSense', query: '&map=quicksense' },
] as const) {
  test(`${map.label} hosts authored combat drones with AI, lasers, health, explosions, and respawn`, async ({ page }) => {
    test.setTimeout(240_000);
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto(`/?qa=visual${map.query}`, { waitUntil: 'commit' });
    await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__), null, { timeout: 240_000 });
    await page.evaluate(() => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      hooks.setReducedMotion(true);
      hooks.seed(450600);
      hooks.setState('drone-encounter');
    });

    const initial = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);
    expect(initial.drones).toHaveLength(3);
    expect(initial.drones.every((drone) => drone.alive && drone.health === 225 && drone.maxHealth === 225)).toBe(true);
    expect(initial.drones.every((drone) => drone.modelReady && drone.loadError === null)).toBe(true);
    expect(initial.drones.every((drone) => drone.modelMeshCount === 4)).toBe(true);
    expect(initial.drones.every((drone) => (
      Math.abs(Math.max(drone.modelWidth, drone.modelHeight, drone.modelDepth) - 3.4) < 0.04
    ))).toBe(true);
    expect(initial.drones.every((drone) => drone.collisionRadius === 1.7)).toBe(true);

    const botDamage = await page.evaluate(() => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      const before = window.__THREE_GAME_DIAGNOSTICS__!.drones[0].health;
      hooks.fireBotAtDrone(0, 'drone-1', 'machine');
      return { before, after: window.__THREE_GAME_DIAGNOSTICS__!.drones[0].health };
    });
    expect(botDamage.after).toBeLessThan(botDamage.before);

    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(2.8));
    const active = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);
    expect(active.drones.some((drone) => drone.shotsFired > 0)).toBe(true);
    expect(active.drones.some((drone) => drone.beamActive && drone.beamVisible)).toBe(true);
    expect(active.drones.some((drone) => drone.beamUptimeSeconds > 0.5 && drone.beamDamageTicks > 0)).toBe(true);
    expect(active.drones.some((drone) => drone.state === 'engage' || drone.state === 'evade')).toBe(true);
    expect(active.drones.some((drone) => drone.targetedByBots > 0)).toBe(true);

    const destroyed = await page.evaluate(() => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      hooks.damageDrone('drone-1', 500);
      hooks.damageDrone('drone-2', 500);
      hooks.damageDrone('drone-3', 500);
      return window.__THREE_GAME_DIAGNOSTICS__!;
    });
    expect(destroyed.drones.every((drone) => !drone.alive && drone.health === 0)).toBe(true);
    expect(destroyed.drones.every((drone) => drone.explosions === 1)).toBe(true);
    // The live render loop continues between browser evaluations, so the
    // countdown may already have advanced slightly on software WebGL.
    expect(destroyed.drones.every((drone) => drone.respawnSeconds > 14)).toBe(true);

    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepDrones(18.5));
    const respawned = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);
    // Once rebuilt, live bots may immediately damage the drones again. Count
    // the completed lifecycle instead of assuming the airspace stays idle.
    expect(respawned.drones.every((drone) => drone.respawns >= 1)).toBe(true);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}
