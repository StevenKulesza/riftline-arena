import { expect, test } from '@playwright/test';

for (const map of [
  { label: 'Monsoon Divide', query: '' },
  { label: 'QuickSense', query: '&map=quicksense' },
] as const) {
  test(`${map.label} has three articulated walking grenadiers with lobs, jumps, combat, and respawn`, async ({ page }) => {
    test.setTimeout(240_000);
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto(`/?qa=visual${map.query}`, { waitUntil: 'commit' });
    await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__), null, { timeout: 240_000 });
    await page.waitForFunction(() => (
      window.__THREE_GAME_DIAGNOSTICS__?.flamethrowerDrones.every((drone) => drone.modelReady && drone.loadError === null) === true
    ), null, { timeout: 60_000 });
    const initial = await page.evaluate(() => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      hooks.seed(450600);
      hooks.setState('flamethrower-encounter');
      hooks.setPausedForScreenshot(true);
      return window.__THREE_GAME_DIAGNOSTICS__!;
    });

    expect(initial.flamethrowerDrones).toHaveLength(3);
    expect(initial.flamethrowerDrones.every((drone) => (
      drone.kind === 'grenadier'
      && drone.alive
      && drone.health === 280
      && drone.maxHealth === 280
      && drone.modelReady
      && drone.loadError === null
    ))).toBe(true);
    expect(initial.flamethrowerDrones.every((drone) => (
      drone.sourceTriangles === 165_472
      && drone.sourceAnimationCount === 0
      && drone.sourceSkinCount === 0
      && drone.animationSource === 'runtime-rigid'
      && drone.rigNodeCount === 10
      && drone.partCount >= 5
    ))).toBe(true);
    expect(initial.flamethrowerDrones.every((drone) => drone.collisionRadius === 1.48)).toBe(true);

    const botDamage = await page.evaluate(() => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      const before = window.__THREE_GAME_DIAGNOSTICS__!.flamethrowerDrones[0].health;
      hooks.stageFlamethrowerAttack('grenadier-1', 0);
      hooks.fireBotAtDrone(0, 'grenadier-1', 'machine');
      return {
        before,
        after: window.__THREE_GAME_DIAGNOSTICS__!.flamethrowerDrones[0].health,
      };
    });
    expect(botDamage.after).toBeLessThan(botDamage.before);

    const botGrenade = await page.evaluate(() => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      hooks.parkBotsForScreenshot();
      const initialBot = window.__THREE_GAME_DIAGNOSTICS__!.bots[0];
      const before = initialBot.health + initialBot.armor;
      const shotsBefore = window.__THREE_GAME_DIAGNOSTICS__!.flamethrowerDrones[0].shotsFired;
      const hitsBefore = window.__THREE_GAME_DIAGNOSTICS__!.flamethrowerGrenade.botHits;
      const staged = hooks.stageFlamethrowerAttack('grenadier-1', 0);
      hooks.stepSimulation(3.2);
      const diagnostics = window.__THREE_GAME_DIAGNOSTICS__!;
      return {
        staged,
        before,
        after: diagnostics.bots[0].health + diagnostics.bots[0].armor,
        shotsBefore,
        shotsAfter: diagnostics.flamethrowerDrones[0].shotsFired,
        hitsBefore,
        hitsAfter: diagnostics.flamethrowerGrenade.botHits,
        explosions: diagnostics.flamethrowerGrenade.explosions,
        lastBotHit: diagnostics.flamethrowerGrenade.lastBotHit,
        lastExplosionPosition: diagnostics.flamethrowerGrenade.lastExplosionPosition,
        botPosition: diagnostics.bots[0].position,
      };
    });
    expect(botGrenade.staged).toBe(true);
    expect(botGrenade.shotsAfter).toBeGreaterThan(botGrenade.shotsBefore);
    expect(botGrenade.hitsAfter, JSON.stringify(botGrenade)).toBeGreaterThan(botGrenade.hitsBefore);
    expect(botGrenade.after, JSON.stringify(botGrenade)).toBeLessThan(botGrenade.before);

    const launched = await page.evaluate(() => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      hooks.setState('flamethrower-encounter');
      hooks.setPausedForScreenshot(true);
      const staged = hooks.stageFlamethrowerAttack('grenadier-1', 'player');
      const healthBefore = window.__THREE_GAME_DIAGNOSTICS__!.health;
      hooks.stepSimulation(0.82);
      return { staged, healthBefore, diagnostics: window.__THREE_GAME_DIAGNOSTICS__! };
    });
    expect(launched.staged).toBe(true);
    expect(launched.diagnostics.flamethrowerDrones[0].shotsFired).toBeGreaterThan(0);
    expect(launched.diagnostics.grenadeStates.some((grenade) => grenade.owner === 'drone')).toBe(true);
    expect(launched.diagnostics.flamethrowerGrenade.sourceId).toBe('grenadier-1');
    expect(launched.diagnostics.flamethrowerGrenade.targetOwner).toBe('player');
    expect(launched.diagnostics.flamethrowerGrenade.velocity.y).toBeGreaterThan(0);

    const exploded = await page.evaluate(() => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      hooks.stepSimulation(2.4);
      return window.__THREE_GAME_DIAGNOSTICS__!;
    });
    expect(exploded.health).toBeLessThan(launched.healthBefore);

    const locomotion = await page.evaluate(() => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      hooks.stepSimulation(11.5);
      return window.__THREE_GAME_DIAGNOSTICS__!;
    });
    expect(locomotion.flamethrowerDrones.some((drone) => drone.distanceWalked > 1)).toBe(true);
    expect(locomotion.flamethrowerDrones.some((drone) => drone.jumps > 0)).toBe(true);
    expect(locomotion.flamethrowerDrones.some((drone) => drone.landings > 0)).toBe(true);

    const lifecycle = await page.evaluate(() => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      hooks.setState('flamethrower-encounter');
      hooks.setPausedForScreenshot(true);
      hooks.damageDrone('grenadier-1', 1_000);
      const destroyed = window.__THREE_GAME_DIAGNOSTICS__!.flamethrowerDrones[0];
      hooks.stepDrones(21.5);
      const respawned = window.__THREE_GAME_DIAGNOSTICS__!.flamethrowerDrones[0];
      return { destroyed, respawned };
    });
    expect(lifecycle.destroyed).toMatchObject({ alive: false, health: 0, state: 'destroyed' });
    expect(lifecycle.destroyed.respawnSeconds).toBeGreaterThan(19);
    expect(lifecycle.respawned.alive).toBe(true);
    expect(lifecycle.respawned.health).toBe(280);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}
