import { expect, test } from '@playwright/test';
import { JetpackEnergy } from '../src/game/JetpackEnergy';
import { MOVEMENT } from '../src/game/config';

const createEnergy = (): JetpackEnergy => new JetpackEnergy({
  burnSeconds: MOVEMENT.jetpackBurnSeconds,
  rechargeDelaySeconds: MOVEMENT.jetpackRechargeDelaySeconds,
  rechargeSeconds: MOVEMENT.jetpackRechargeSeconds,
  restartCharge: MOVEMENT.jetpackRestartCharge,
});

test('jetpack energy has finite burn and grounded recovery', () => {
  const energy = createEnergy();
  expect(energy.snapshot()).toMatchObject({ charge: 1, active: false, locked: false, phase: 'ready' });

  const firstBurn = energy.update(1, true, false);
  expect(firstBurn.active).toBe(true);
  expect(firstBurn.charge).toBeCloseTo(1 - 1 / MOVEMENT.jetpackBurnSeconds, 6);

  const depleted = energy.update(2, true, false);
  expect(depleted).toMatchObject({ charge: 0, active: true, locked: true, phase: 'burning' });
  expect(energy.update(1 / 120, true, false)).toMatchObject({ charge: 0, active: false, locked: true, phase: 'depleted' });

  const airborneWait = energy.update(20, false, false);
  expect(airborneWait).toMatchObject({ charge: 0, locked: true, phase: 'depleted' });

  const landingDelay = energy.update(0.8, false, true);
  expect(landingDelay.charge).toBe(0);
  expect(landingDelay.rechargeDelayRemaining).toBeCloseTo(0.05, 6);
  expect(landingDelay.phase).toBe('cooldown');

  energy.update(0.05, false, true);
  const belowRestart = energy.update(MOVEMENT.jetpackRechargeSeconds * (MOVEMENT.jetpackRestartCharge - 0.01), false, true);
  expect(belowRestart.charge).toBeCloseTo(MOVEMENT.jetpackRestartCharge - 0.01, 6);
  expect(belowRestart.locked).toBe(true);

  const restarted = energy.update(MOVEMENT.jetpackRechargeSeconds * 0.02, false, true);
  expect(restarted.charge).toBeGreaterThan(MOVEMENT.jetpackRestartCharge);
  expect(restarted.locked).toBe(false);
  expect(restarted.phase).toBe('recharging');

  expect(energy.update(10, false, true)).toMatchObject({ charge: 1, locked: false, phase: 'ready' });
});

test('airborne feathering preserves but never replenishes charge', () => {
  const energy = createEnergy();
  const burned = energy.update(0.75, true, false);
  const waited = energy.update(60, false, false);
  expect(waited.charge).toBeCloseTo(burned.charge, 8);
  expect(waited.phase).toBe('available');
});

test('live jump input drains, locks, and recharges the player jetpack', async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/?qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));
  const groundPosition = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('movement-flat');
    hooks.setPausedForScreenshot(true);
    return window.__THREE_GAME_DIAGNOSTICS__!.player.position;
  });
  await page.evaluate((ground) => {
    window.__THREE_GAME_TEST_HOOKS__!.setPlayerKinematics(
      { x: ground.x, y: ground.y + 12, z: ground.z },
      { x: 0, y: 0, z: 0 },
    );
  }, groundPosition);

  await page.keyboard.down('Space');
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(0.5));
  const burning = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.player);
  expect(burning.jetpacking).toBe(true);
  expect(burning.jetpackPhase).toBe('burning');
  expect(burning.jetpackCharge).toBeGreaterThan(0.7);
  expect(burning.jetpackCharge).toBeLessThan(0.85);
  await expect.poll(() => page.locator('#jetpack-readout').getAttribute('data-state')).toBe('burning');

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(2.2));
  await page.keyboard.up('Space');
  const exhausted = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.player);
  expect(exhausted.jetpacking).toBe(false);
  expect(exhausted.jetpackCharge).toBe(0);
  expect(exhausted.jetpackLocked).toBe(true);
  expect(exhausted.jetpackPhase).toBe('depleted');
  await expect.poll(() => page.locator('#jetpack-value').textContent()).toBe('0');

  await page.evaluate((ground) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setPlayerKinematics(
      { x: ground.x, y: ground.y + 18, z: ground.z },
      { x: 0, y: 0, z: 0 },
    );
    hooks.stepSimulation(0.5);
  }, groundPosition);
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.player.jetpackCharge)).toBe(0);

  await page.evaluate((ground) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setPlayerKinematics(ground, { x: 0, y: 0, z: 0 });
    hooks.stepSimulation(0.8);
  }, groundPosition);
  const cooling = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.player);
  expect(cooling.jetpackCharge).toBe(0);
  expect(cooling.jetpackPhase).toBe('cooldown');

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(0.75));
  const recovered = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.player);
  expect(recovered.jetpackCharge).toBeGreaterThan(MOVEMENT.jetpackRestartCharge);
  expect(recovered.jetpackLocked).toBe(false);
  expect(recovered.jetpackPhase).toBe('recharging');
  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
});
