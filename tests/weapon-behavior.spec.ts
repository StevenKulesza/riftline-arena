import { expect, test } from '@playwright/test';

test('player shots originate at authored muzzle sockets and laser remains continuous while aim bends', async ({ page }) => {
  test.setTimeout(90_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/?qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));
  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('active-play');
    hooks.setReducedMotion(true);
    hooks.setPausedForScreenshot(true);
  });

  for (const weapon of ['machine', 'shotgun', 'rocket', 'plasma', 'laser', 'sniper', 'rail'] as const) {
    const wear = await page.evaluate((id) => {
      window.__THREE_GAME_TEST_HOOKS__!.setWeapon(id);
      const renderer = window.__THREE_GAME_DIAGNOSTICS__!.renderer;
      return { materials: renderer.weaponWearMaterials, textures: renderer.weaponWearTextures };
    }, weapon);
    expect(wear.materials, `${weapon} must use the shared battle-wear material kit`).toBe(5);
    expect(wear.textures, `${weapon} must carry independent albedo and roughness maps`).toBe(2);
  }

  const combatFeedback = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('combat');
    hooks.setWeapon('machine');
    const pitchBefore = window.__THREE_GAME_DIAGNOSTICS__!.player.pitch;
    hooks.fireWeapon();
    return {
      pitchBefore,
      pitchAfter: window.__THREE_GAME_DIAGNOSTICS__!.player.pitch,
      crosshairClass: document.querySelector('#crosshair')?.className ?? '',
      hitTicks: document.querySelectorAll('#crosshair .hit-tick').length,
    };
  });
  expect(combatFeedback.crosshairClass).toContain('hit');
  expect(combatFeedback.hitTicks).toBe(4);
  expect(combatFeedback.pitchAfter - combatFeedback.pitchBefore, 'machine gun gets a restrained upward kick').toBeGreaterThan(0.0005);
  expect(combatFeedback.pitchAfter - combatFeedback.pitchBefore).toBeLessThan(0.002);

  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('active-play');
    hooks.setReducedMotion(true);
    hooks.setPausedForScreenshot(true);
  });

  for (const weapon of ['rocket', 'plasma'] as const) {
    await page.evaluate((id) => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      hooks.setWeapon(id);
      hooks.fireWeapon();
    }, weapon);
    const combat = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.combat);
    expect(combat.lastShotWeapon).toBe(weapon);
    expect(combat.muzzleOffset).toBeLessThan(1e-5);
    expect(combat.projectileMuzzleOffset).not.toBeNull();
    expect(combat.projectileMuzzleOffset ?? Number.POSITIVE_INFINITY).toBeLessThan(1e-5);
  }

  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setWeapon('shotgun');
    hooks.fireWeapon();
  });
  const shotgun = await page.evaluate(() => ({
    combat: window.__THREE_GAME_DIAGNOSTICS__!.combat,
    activeVfx: window.__THREE_GAME_DIAGNOSTICS__!.renderer.activeWeaponVfx,
  }));
  expect(shotgun.combat.lastShotWeapon).toBe('shotgun');
  expect(shotgun.combat.lastPelletCount).toBe(14);
  expect(shotgun.combat.lastPelletSpread).toBeGreaterThan(0.075);
  expect(shotgun.combat.lastPelletSpread).toBeLessThan(0.1);
  expect(shotgun.activeVfx).toBeGreaterThanOrEqual(14);
  expect(shotgun.combat.muzzleOffset).toBeLessThan(1e-5);
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.renderer.activeSurfaceMarks)).toBeGreaterThan(0);

  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setWeapon('laser');
    hooks.setAim(-2.35, -0.08);
    hooks.fireWeapon();
  });
  const straight = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.combat);
  expect(straight.continuousLaserActive).toBe(true);
  expect(straight.lastShotWeapon).toBe('laser');

  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setAim(-1.55, 0.12);
    hooks.fireWeapon();
  });
  const bent = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.combat);
  expect(bent.continuousLaserActive).toBe(true);
  expect(bent.continuousLaserBend).toBeGreaterThan(0.12);
  expect(bent.muzzleOffset).toBeLessThan(1e-5);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
