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
    hooks.parkBotsForScreenshot();
    hooks.setReducedMotion(true);
    hooks.setPausedForScreenshot(true);
  });

  const reticleSignatures = new Set<string>();
  for (const weapon of ['machine', 'shotgun', 'rocket', 'plasma', 'laser', 'sniper', 'rail', 'disc'] as const) {
    await page.evaluate((id) => window.__THREE_GAME_TEST_HOOKS__!.setWeapon(id), weapon);
    await page.waitForFunction((id) => document.querySelector<HTMLElement>('#crosshair')?.dataset.weapon === id, weapon);
    const state = await page.evaluate(() => {
      const renderer = window.__THREE_GAME_DIAGNOSTICS__!.renderer;
      const crosshair = document.querySelector<HTMLElement>('#crosshair')!;
      const topArm = crosshair.querySelector<HTMLElement>('.reticle-arm--top')!;
      return {
        wear: {
          materials: renderer.weaponWearMaterials,
          textures: renderer.weaponWearTextures,
          source: renderer.weaponAssetSource,
          meshes: renderer.weaponModelMeshes,
          triangles: renderer.weaponModelTriangles,
        },
        reticle: {
          weapon: crosshair.dataset.weapon,
          arms: crosshair.querySelectorAll('.reticle-arm').length,
          centerElements: crosshair.querySelectorAll('i').length,
          centerBefore: getComputedStyle(crosshair, '::before').content,
          signature: [
            getComputedStyle(crosshair).width,
            getComputedStyle(crosshair).getPropertyValue('--reticle-gap'),
            getComputedStyle(crosshair).getPropertyValue('--reticle-length'),
            getComputedStyle(crosshair).getPropertyValue('--reticle-color'),
            getComputedStyle(topArm).display,
            getComputedStyle(topArm).transform,
          ].join('|'),
        },
      };
    });
    expect(state.wear.source).toBe('procedural');
    expect(state.wear.materials, `${weapon} must use the shared battle-wear material kit`).toBe(5);
    expect(state.wear.textures, `${weapon} must carry albedo, roughness, normal, and metalness maps`).toBe(4);
    expect(state.wear.meshes, `${weapon} needs an authored hard-surface part hierarchy`).toBeGreaterThan(20);
    expect(state.wear.triangles, `${weapon} needs enough geometry to hold its silhouette`).toBeGreaterThan(500);
    expect(state.reticle.weapon).toBe(weapon);
    expect(state.reticle.arms).toBe(4);
    expect(state.reticle.centerElements, `${weapon} must not render a center dot`).toBe(0);
    expect(state.reticle.centerBefore, `${weapon} must not render the old center ring`).toBe('none');
    reticleSignatures.add(state.reticle.signature);
  }
  expect(reticleSignatures.size, 'each weapon must own a distinct reticle profile').toBe(8);

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

  const killFeedback = await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__!.triggerHitMarker(true);
    const crosshair = document.querySelector<HTMLElement>('#crosshair')!;
    return {
      className: crosshair.className,
      ticks: crosshair.querySelectorAll('.hit-tick').length,
      centerElements: crosshair.querySelectorAll('i').length,
      centerBefore: getComputedStyle(crosshair, '::before').content,
    };
  });
  expect(killFeedback.className).toContain('kill');
  expect(killFeedback.ticks).toBe(4);
  expect(killFeedback.centerElements).toBe(0);
  expect(killFeedback.centerBefore).toBe('none');

  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('active-play');
    hooks.parkBotsForScreenshot();
    hooks.setReducedMotion(true);
    hooks.setPausedForScreenshot(true);
  });

  for (const weapon of ['rocket', 'plasma', 'disc'] as const) {
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

test('disc launcher uses swept ricochet physics and emits exactly one disc per primary or secondary shot', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/?qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));

  const primary = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('active-play');
    hooks.parkBotsForScreenshot();
    hooks.setReducedMotion(true);
    hooks.setWeapon('disc');
    hooks.setAmmo('disc', 12);
    hooks.setAim(0, -1.15);
    const pitchBefore = window.__THREE_GAME_DIAGNOSTICS__!.player.pitch;
    hooks.fireWeapon();
    const fired = window.__THREE_GAME_DIAGNOSTICS__!;
    hooks.stepSimulation(0.04);
    const simulated = window.__THREE_GAME_DIAGNOSTICS__!;
    return {
      lastShotWeapon: fired.combat.lastShotWeapon,
      projectileMuzzleOffset: fired.combat.projectileMuzzleOffset,
      recoilPitchKick: fired.player.pitch - pitchBefore,
      bounces: simulated.combat.discBounceCount,
      projectiles: simulated.projectiles,
    };
  });
  expect(primary.lastShotWeapon).toBe('disc');
  expect(primary.projectileMuzzleOffset ?? Number.POSITIVE_INFINITY).toBeLessThan(1e-5);
  expect(primary.recoilPitchKick, 'disc launch should have a heavy, shotgun-class kick').toBeGreaterThan(0.007);
  expect(primary.recoilPitchKick).toBeLessThan(0.0095);
  expect(primary.bounces, 'a downward disc must reflect from authored terrain').toBeGreaterThan(0);
  expect(primary.projectiles, 'the first terrain impact must ricochet instead of destroying the disc').toBe(1);

  const secondary = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setWeapon('disc');
    hooks.setAmmo('disc', 12);
    const before = window.__THREE_GAME_DIAGNOSTICS__!.projectiles;
    hooks.fireSecondary();
    return {
      before,
      after: window.__THREE_GAME_DIAGNOSTICS__!.projectiles,
      ability: window.__THREE_GAME_DIAGNOSTICS__!.combat.secondaryAbility,
      lastShotWeapon: window.__THREE_GAME_DIAGNOSTICS__!.combat.lastShotWeapon,
    };
  });
  expect(secondary.after - secondary.before).toBe(1);
  expect(secondary.ability).toBe('Overdrive ricochet');
  expect(secondary.lastShotWeapon).toBe('disc');
});

test('default player loadout makes all eight weapon slots immediately selectable', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/?qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.setState('active-play'));

  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.weapon)).toBe('disc');

  const expected = ['disc', 'machine', 'shotgun', 'rocket', 'plasma', 'laser', 'sniper', 'rail'] as const;
  for (let index = 0; index < expected.length; index += 1) {
    await page.keyboard.press(`Digit${index + 1}`);
    await page.waitForTimeout(60);
    const selected = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.weapon);
    expect(selected).toBe(expected[index]);
  }
});
