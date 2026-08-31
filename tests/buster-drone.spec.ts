import { expect, test } from '@playwright/test';

test('QuickSense Busters use the authored rig, gaze-gated shards, damage, and respawn lifecycle', async ({ page }) => {
  test.setTimeout(240_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/?map=quicksense&qa=visual', { waitUntil: 'commit' });
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__), null, { timeout: 240_000 });
  const initial = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setReducedMotion(true);
    hooks.seed(450600);
    hooks.setState('buster-encounter');
    hooks.setPausedForScreenshot(true);
    return window.__THREE_GAME_DIAGNOSTICS__!;
  });

  expect(initial.busterDrones).toHaveLength(2);
  expect(initial.busterDrones.every((drone) => drone.kind === 'buster')).toBe(true);
  expect(initial.busterDrones.every((drone) => drone.healthMultiplier === 1.5)).toBe(true);
  expect(initial.busterDrones.every((drone) => drone.modelReady && drone.loadError === null)).toBe(true);
  expect(initial.busterDrones.every((drone) => drone.modelMeshCount >= 30)).toBe(true);
  expect(initial.busterDrones.every((drone) => drone.rigNodeCount > 20)).toBe(true);
  expect(initial.busterDrones.every((drone) => drone.animationClipName === 'Start_Liftoff')).toBe(true);
  expect(initial.busterDrones.every((drone) => drone.animationClipDuration > 20)).toBe(true);
  expect(initial.busterShardPool.capacity).toBe(36);
  expect(initial.busterShardPool.speed).toBe(68);
  expect(initial.busterShardPool.damage).toBe(17);

  const attack = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const staged = hooks.stageBusterAttack('buster-1', 'player');
    hooks.stepSimulation(1.1);
    return { staged, diagnostics: window.__THREE_GAME_DIAGNOSTICS__! };
  });
  const attacker = attack.diagnostics.busterDrones.find((drone) => drone.id === 'buster-1')!;
  expect(attack.staged).toBe(true);
  expect(attacker.lookingAtTarget).toBe(true);
  expect(attacker.gazeDot).toBeGreaterThanOrEqual(attacker.gazeThreshold);
  expect(attacker.shardsFired).toBeGreaterThan(0);
  expect(attacker.shardHits + attacker.shardWorldImpacts).toBeGreaterThan(0);
  expect(attack.diagnostics.busterShardPool.lastSourceId).toBe('buster-1');
  expect(attack.diagnostics.busterShardPool.lastTargetOwner).toBe('player');

  const lifecycle = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.damageDrone('buster-1', 1_000);
    const destroyed = window.__THREE_GAME_DIAGNOSTICS__!.busterDrones.find((drone) => drone.id === 'buster-1')!;
    hooks.stepDrones(24);
    const respawned = window.__THREE_GAME_DIAGNOSTICS__!.busterDrones.find((drone) => drone.id === 'buster-1')!;
    return { destroyed, respawned };
  });
  expect(lifecycle.destroyed).toMatchObject({ alive: false, health: 0, explosions: 1 });
  expect(lifecycle.respawned.alive).toBe(true);
  expect(lifecycle.respawned.respawns).toBeGreaterThanOrEqual(1);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
