import { expect, test } from '@playwright/test';
import { JetpackEnergy } from '../src/game/JetpackEnergy';
import { MOVEMENT } from '../src/game/config';

const createEnergy = (): JetpackEnergy => new JetpackEnergy({
  burnSeconds: MOVEMENT.jetpackBurnSeconds,
  rechargeDelaySeconds: MOVEMENT.jetpackRechargeDelaySeconds,
  rechargeSeconds: MOVEMENT.jetpackRechargeSeconds,
  restartCharge: MOVEMENT.jetpackRestartCharge,
});

test('jetpack energy has finite burn and airborne recovery', () => {
  const energy = createEnergy();
  expect(energy.snapshot()).toMatchObject({ charge: 1, active: false, locked: false, phase: 'ready' });

  const firstBurn = energy.update(1, true, false);
  expect(firstBurn.active).toBe(true);
  expect(firstBurn.charge).toBeCloseTo(1 - 1 / MOVEMENT.jetpackBurnSeconds, 6);

  const depleted = energy.update(2, true, false);
  expect(depleted).toMatchObject({ charge: 0, active: false, locked: true, phase: 'depleted' });
  expect(energy.update(20, true, false)).toMatchObject({ charge: 0, active: false, locked: true, phase: 'depleted' });

  const airborneDelay = energy.update(0.8, false, false);
  expect(airborneDelay.charge).toBe(0);
  expect(airborneDelay.rechargeDelayRemaining).toBeCloseTo(0.05, 6);
  expect(airborneDelay.phase).toBe('depleted');

  energy.update(0.05, false, false);
  const belowRestart = energy.update(MOVEMENT.jetpackRechargeSeconds * (MOVEMENT.jetpackRestartCharge - 0.01), false, false);
  expect(belowRestart.charge).toBeCloseTo(MOVEMENT.jetpackRestartCharge - 0.01, 6);
  expect(belowRestart.locked).toBe(true);

  const restarted = energy.update(MOVEMENT.jetpackRechargeSeconds * 0.02, false, false);
  expect(restarted.charge).toBeGreaterThan(MOVEMENT.jetpackRestartCharge);
  expect(restarted.locked).toBe(false);
  expect(restarted.phase).toBe('recharging');

  expect(energy.update(10, false, false)).toMatchObject({ charge: 1, locked: false, phase: 'ready' });
});

test('airborne coasting replenishes at half the burn rate', () => {
  const energy = createEnergy();
  const burned = energy.update(1, true, false);
  const burnedCharge = 1 - burned.charge;
  energy.update(MOVEMENT.jetpackRechargeDelaySeconds, false, false);
  const recovered = energy.update(1, false, false);
  const recoveredCharge = recovered.charge - burned.charge;
  expect(recoveredCharge).toBeCloseTo(burnedCharge / 2, 8);
  expect(recovered.phase).toBe('recharging');
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
  await expect.poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.audio.unlocked)).toBe(true);
  const audioBefore = await page.evaluate(() => ({ ...window.__THREE_GAME_DIAGNOSTICS__!.audio.playCounts }));
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
  await expect(page.locator('#kill-feed > div', { hasText: 'JETPACK DEPLETED · COAST TO RECHARGE' })).toHaveCount(1);
  const depletedAudioCount = await page.evaluate(() => (
    window.__THREE_GAME_DIAGNOSTICS__!.audio.playCounts['movement.jetpack-cut'] ?? 0
  ));
  expect(depletedAudioCount - (audioBefore['movement.jetpack-cut'] ?? 0)).toBe(1);

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(0.5));
  expect(await page.evaluate(() => (
    window.__THREE_GAME_DIAGNOSTICS__!.audio.playCounts['movement.jetpack-cut'] ?? 0
  ))).toBe(depletedAudioCount);
  await expect(page.locator('#kill-feed > div', { hasText: 'JETPACK DEPLETED · COAST TO RECHARGE' })).toHaveCount(1);

  await page.evaluate((ground) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setPlayerKinematics(
      { x: ground.x, y: ground.y + 18, z: ground.z },
      { x: 0, y: 0, z: 0 },
    );
    hooks.stepSimulation(0.5);
  }, groundPosition);
  const fallingRecharge = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.player);
  expect(fallingRecharge.jetpackCharge).toBeGreaterThan(0);
  expect(fallingRecharge.jetpackLocked).toBe(true);
  expect(fallingRecharge.jetpackPhase).toBe('recharging');

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(0.8));
  const recovered = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.player);
  expect(recovered.jetpackCharge).toBeGreaterThan(MOVEMENT.jetpackRestartCharge);
  expect(recovered.jetpackLocked).toBe(false);
  expect(recovered.jetpackPhase).toBe('recharging');
  await expect(page.locator('#kill-feed > div', { hasText: 'JETPACK READY' })).toHaveCount(1);
  const readyAudioCount = await page.evaluate(() => (
    window.__THREE_GAME_DIAGNOSTICS__!.audio.playCounts['movement.jetpack-ready'] ?? 0
  ));
  expect(readyAudioCount - (audioBefore['movement.jetpack-ready'] ?? 0)).toBe(1);

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(0.5));
  expect(await page.evaluate(() => (
    window.__THREE_GAME_DIAGNOSTICS__!.audio.playCounts['movement.jetpack-ready'] ?? 0
  ))).toBe(readyAudioCount);
  await expect(page.locator('#kill-feed > div', { hasText: 'JETPACK READY' })).toHaveCount(1);
  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
});
