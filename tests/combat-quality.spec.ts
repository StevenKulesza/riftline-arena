import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

test('long-range sniper, human aim variance, soft smoke, and continuous damage bearing stay coherent', async ({ page }) => {
  test.setTimeout(180_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const artifactDirectory = resolve('artifacts/combat-quality');
  await mkdir(artifactDirectory, { recursive: true });

  await page.goto('/?map=quicksense');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));

  const sightline = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('active-play');
    return hooks.getLongSightline();
  });
  expect(sightline, 'the authored map needs at least one real long-range combat lane').not.toBeNull();
  expect(sightline!.distance).toBeGreaterThan(58);

  const aimSamples = await page.evaluate((lane) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setCombatants(lane.player, lane.bot, true, true);
    const samples: Array<{ error: number; tracking: number; reaction: number }> = [];
    for (let index = 0; index < 8; index += 1) {
      hooks.stepSimulation(0.06);
      const bot = window.__THREE_GAME_DIAGNOSTICS__!.bots[0];
      samples.push({
        error: bot.aimErrorDegrees,
        tracking: bot.aimTracking,
        reaction: bot.reactionRemaining,
      });
    }
    return samples;
  }, sightline!);
  expect(Math.max(...aimSamples.map((sample) => sample.error))).toBeGreaterThan(0.01);
  expect(Math.max(...aimSamples.map((sample) => sample.error))).toBeLessThan(14);
  expect(aimSamples.at(-1)!.tracking).toBeGreaterThan(0.97);
  expect(aimSamples.at(-1)!.reaction).toBeLessThan(aimSamples[0].reaction);

  const playerSniper = await page.evaluate((lane) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setCombatants(lane.player, lane.bot, true, true);
    // Drain any bot shot created while sampling aim above so the visual proof
    // contains exactly one current player trajectory.
    hooks.stepVisualEffects(1);
    hooks.setWeapon('sniper');
    hooks.setAmmo('sniper', 8);
    hooks.toggleViewMode();
    const eye = { x: lane.player.x, y: lane.player.y + 54 / 56, z: lane.player.z };
    const target = { x: lane.bot.x, y: lane.bot.y + 0.92, z: lane.bot.z };
    const dx = target.x - eye.x;
    const dy = target.y - eye.y;
    const dz = target.z - eye.z;
    const length = Math.hypot(dx, dy, dz);
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.asin(dy / length);
    hooks.setAim(yaw, pitch);
    const before = window.__THREE_GAME_DIAGNOSTICS__!.bots[0].health;
    hooks.fireWeapon();
    hooks.stepVisualEffects(0.045);
    hooks.setAim(yaw + 0.045, pitch);
    hooks.setPausedForScreenshot(true);
    return {
      before,
      after: window.__THREE_GAME_DIAGNOSTICS__!.bots[0].health,
      smoke: window.__THREE_GAME_DIAGNOSTICS__!.renderer.activeSoftSmoke,
      smokeSource: window.__THREE_GAME_DIAGNOSTICS__!.renderer.smokeTextureSource,
      tracerSource: window.__THREE_GAME_DIAGNOSTICS__!.renderer.tracerTextureSource,
    };
  }, sightline!);
  expect(playerSniper.after).toBeLessThan(playerSniper.before);
  expect(playerSniper.smoke).toBeGreaterThan(0);
  expect(playerSniper.smokeSource).toBe('procedural-soft-density');
  expect(playerSniper.tracerSource).toBe('procedural-longitudinal-energy-ramp');
  await page.screenshot({ path: resolve(artifactDirectory, 'long-range-sniper.png') });

  const botSniper = await page.evaluate((lane) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setPausedForScreenshot(false);
    // Present the incoming-fire proof independently from the prior player
    // shot. Two legitimate opposing sniper paths overlap into a misleading
    // V-shape in a frozen frame even though they are separate events.
    hooks.stepVisualEffects(1);
    hooks.setCombatants(lane.player, lane.bot, true, true);
    const before = window.__THREE_GAME_DIAGNOSTICS__!.health;
    hooks.fireBotWeapon(0, 'sniper');
    const indicator = document.querySelector<HTMLElement>('#damage-direction-indicator');
    const bearingAnimation = indicator?.getAnimations()[0];
    if (bearingAnimation) {
      bearingAnimation.currentTime = 120;
      bearingAnimation.pause();
    }
    hooks.setPausedForScreenshot(true);
    return {
      before,
      after: window.__THREE_GAME_DIAGNOSTICS__!.health,
      direction: indicator?.dataset.direction ?? '',
      bearing: Number(indicator?.dataset.bearing ?? Number.NaN),
      showing: indicator?.classList.contains('show') ?? false,
      diagnosticsDirection: window.__THREE_GAME_DIAGNOSTICS__!.combat.lastDamageDirection,
      diagnosticsBearing: window.__THREE_GAME_DIAGNOSTICS__!.combat.lastDamageBearing,
    };
  }, sightline!);
  expect(botSniper.after).toBeLessThan(botSniper.before);
  expect(['front', 'back', 'left', 'right']).toContain(botSniper.direction);
  expect(botSniper.showing).toBe(true);
  expect(Number.isFinite(botSniper.bearing)).toBe(true);
  expect(botSniper.diagnosticsDirection).toBe(botSniper.direction);
  expect(Number.isFinite(botSniper.diagnosticsBearing)).toBe(true);
  await page.screenshot({ path: resolve(artifactDirectory, 'damage-bearing.png') });

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
