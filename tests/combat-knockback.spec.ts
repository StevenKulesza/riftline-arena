import { expect, test } from '@playwright/test';
import { WEAPONS } from '../src/game/config';

test('rocket splash min knockback is Warsow minkb 35 scaled to wishSpeed 15', () => {
  const rocket = WEAPONS.find((weapon) => weapon.id === 'rocket');
  expect(rocket?.splashMinKnockback).toBeCloseTo(35 * 5 * (15 / 320), 1);
});

test('rocket firedef matches Warsow strong RL (80 / 950 ms / splash min 15)', () => {
  const rocket = WEAPONS.find((weapon) => weapon.id === 'rocket');
  expect(rocket?.damage).toBe(80);
  expect(rocket?.cooldown).toBeCloseTo(0.95, 5);
  expect(rocket?.splashMinDamage).toBe(15);
});

test('combat knockback, self rocket cost, holster, and hit markers match the Warsow bar', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__), { timeout: 90_000 });

  const rocketDirect = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('movement-flat');
    const player = window.__THREE_GAME_DIAGNOSTICS__!.player.position;
    const yaw = window.__THREE_GAME_DIAGNOSTICS__!.player.yaw;
    hooks.setCombatants(
      player,
      {
        x: player.x - Math.sin(yaw) * 6.2,
        y: player.y,
        z: player.z - Math.cos(yaw) * 6.2,
      },
      true,
      true,
    );
    const placed = window.__THREE_GAME_DIAGNOSTICS__!;
    const eye = {
      x: placed.player.position.x,
      y: placed.player.position.y + 54 / 56,
      z: placed.player.position.z,
    };
    const bot = placed.bots[0].position;
    const target = { x: bot.x, y: bot.y + 0.9, z: bot.z };
    const dx = target.x - eye.x;
    const dy = target.y - eye.y;
    const dz = target.z - eye.z;
    const length = Math.hypot(dx, dy, dz);
    hooks.setAim(Math.atan2(-dx, -dz), Math.asin(dy / Math.max(length, 1e-5)));
    hooks.setWeapon('rocket');
    hooks.setAmmo('rocket', 8);
    let peak = 0;
    hooks.fireWeapon();
    for (let step = 0; step < 72; step += 1) {
      hooks.stepSimulation(1 / 120);
      const velocity = window.__THREE_GAME_DIAGNOSTICS__!.bots[0].velocity;
      peak = Math.max(peak, Math.hypot(velocity.x, velocity.y, velocity.z));
    }
    return {
      peak,
      health: window.__THREE_GAME_DIAGNOSTICS__!.bots[0].health,
    };
  });
  expect(rocketDirect.health, 'rocket direct must connect').toBeLessThan(100);
  expect(rocketDirect.peak, 'rocket direct hit knockback must exceed 12 m/s').toBeGreaterThanOrEqual(12);

  const machine = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('movement-flat');
    const player = window.__THREE_GAME_DIAGNOSTICS__!.player.position;
    const yaw = window.__THREE_GAME_DIAGNOSTICS__!.player.yaw;
    hooks.setCombatants(
      player,
      {
        x: player.x - Math.sin(yaw) * 6.2,
        y: player.y,
        z: player.z - Math.cos(yaw) * 6.2,
      },
      true,
      true,
    );
    hooks.setWeapon('machine');
    hooks.setAmmo('machine', 40);
    const placed = window.__THREE_GAME_DIAGNOSTICS__!;
    const eye = {
      x: placed.player.position.x,
      y: placed.player.position.y + 54 / 56,
      z: placed.player.position.z,
    };
    const bot = placed.bots[0].position;
    const target = { x: bot.x, y: bot.y + 0.9, z: bot.z };
    const dx = target.x - eye.x;
    const dy = target.y - eye.y;
    const dz = target.z - eye.z;
    const length = Math.hypot(dx, dy, dz);
    hooks.setAim(Math.atan2(-dx, -dz), Math.asin(dy / Math.max(length, 1e-5)));
    let peak = 0;
    hooks.fireWeapon();
    for (let step = 0; step < 8; step += 1) {
      hooks.stepSimulation(1 / 120);
      const velocity = window.__THREE_GAME_DIAGNOSTICS__!.bots[0].velocity;
      peak = Math.max(peak, Math.hypot(velocity.x, velocity.y, velocity.z));
    }
    return {
      peak,
      lastHitDamage: window.__THREE_GAME_DIAGNOSTICS__!.combat.lastHitDamage,
      hitClass: document.querySelector('#crosshair')?.className ?? '',
      health: window.__THREE_GAME_DIAGNOSTICS__!.bots[0].health,
    };
  });
  expect(machine.health, 'machine gun must land').toBeLessThan(100);
  expect(machine.peak, 'MG knockback must exceed 1 m/s').toBeGreaterThan(1);
  expect(machine.lastHitDamage).toBeGreaterThan(0);
  expect(machine.hitClass).toContain('hit');

  const selfRocket = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('movement-flat');
    hooks.setWeapon('rocket');
    hooks.setAim(0, -1.2);
    const before = window.__THREE_GAME_DIAGNOSTICS__!;
    hooks.fireWeapon();
    hooks.stepSimulation(0.24);
    const after = window.__THREE_GAME_DIAGNOSTICS__!;
    return {
      healthBefore: before.health,
      armorBefore: before.armor,
      healthAfter: after.health,
      armorAfter: after.armor,
      vy: after.player.velocity.y,
      rocketJumpCount: after.player.rocketJumpCount - before.player.rocketJumpCount,
    };
  });
  expect(selfRocket.rocketJumpCount).toBe(1);
  expect(selfRocket.vy).toBeGreaterThan(10);
  expect(selfRocket.healthAfter < selfRocket.healthBefore || selfRocket.armorAfter < selfRocket.armorBefore).toBe(true);

  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('active-play');
    hooks.setWeapon('disc');
    hooks.setAmmo('disc', 12);
    hooks.setAmmo('machine', 40);
  });
  await page.keyboard.press('Digit2');
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(1 / 120));
  const afterSwitch = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(0.14));
  const ready = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.combat.weaponCooldown);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.fireWeapon());
  const holsterShot = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.combat.lastShotWeapon);
  expect(afterSwitch.weapon).toBe('machine');
  expect(afterSwitch.combat.weaponCooldown).toBeGreaterThan(0);
  expect(afterSwitch.combat.weaponCooldown).toBeLessThanOrEqual(0.11);
  expect(ready).toBeLessThanOrEqual(0);
  expect(holsterShot).toBe('machine');
});
