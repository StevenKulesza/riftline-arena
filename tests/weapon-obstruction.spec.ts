import { expect, test } from '@playwright/test';

const WEAPONS = ['disc', 'machine', 'shotgun', 'rocket', 'plasma', 'laser', 'sniper', 'rail'] as const;

test('first-person weapons retract at walls without reacting to terrain traversal', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'View-model obstruction QA runs once in desktop Chromium.');
  test.setTimeout(180_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/?qa=physics&mapSeed=450600');
  await page.waitForFunction(() => (
    Boolean(window.__THREE_GAME_TEST_HOOKS__)
    && Boolean(window.__THREE_GAME_DIAGNOSTICS__?.map.ready)
    && (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5
  ));
  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('movement-flat');
    hooks.parkBotsForScreenshot();
    hooks.setReducedMotion(true);
    hooks.setPausedForScreenshot(true);
  });

  for (const weapon of WEAPONS) {
    const ground = await page.evaluate((id) => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      hooks.setWeapon(id);
      hooks.resetWeaponCaptureState();
      const yaw = window.__THREE_GAME_DIAGNOSTICS__!.player.yaw;
      hooks.setAim(yaw, -1.25);
      return window.__THREE_GAME_DIAGNOSTICS__!.renderer;
    }, weapon);
    expect(ground.weaponObstructionDistance, `${weapon} terrain must not register as a wall`).toBeGreaterThan(3.2);
    expect(ground.weaponTuck, `${weapon} must not retract when looking down at terrain`).toBeLessThan(0.04);
  }

  const sampleTraversalTuck = async (state: 'movement-slope' | 'view-0', key: 'ShiftLeft' | 'KeyW') => {
    await page.evaluate((stateName) => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      hooks.setState(stateName);
      hooks.setWeapon('sniper');
      hooks.resetWeaponCaptureState();
      hooks.setReducedMotion(true);
      hooks.setPausedForScreenshot(false);
    }, state);
    await page.keyboard.down(key);
    const samples = await page.evaluate(() => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      const values: number[] = [];
      for (let index = 0; index < 120; index += 1) {
        hooks.stepSimulation(1 / 120);
        values.push(window.__THREE_GAME_DIAGNOSTICS__!.renderer.weaponTuck);
      }
      return values;
    });
    await page.keyboard.up(key);
    return {
      minimum: Math.min(...samples),
      maximum: Math.max(...samples),
    };
  };

  const slopeTuck = await sampleTraversalTuck('movement-slope', 'ShiftLeft');
  expect(slopeTuck.maximum, 'skiing a mountain/ramp must not trigger wall tuck').toBeLessThan(0.05);

  const stairTuck = await sampleTraversalTuck('view-0', 'KeyW');
  expect(stairTuck.maximum, 'walking stairs must not trigger wall tuck').toBeLessThan(0.05);

  const bunkerFloor = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const roof = hooks.sampleFloorHeight(-138, 116, Number.POSITIVE_INFINITY);
    if (roof === null) return null;
    return hooks.sampleFloorHeight(-138, 116, roof - 0.9);
  });
  expect(bunkerFloor).not.toBeNull();
  await page.evaluate((floor) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setPlayerKinematics(
      { x: -143.25, y: floor ?? 0, z: 116 },
      { x: 0, y: 0, z: 0 },
    );
    hooks.setAim(Math.PI * 0.5, 0);
  }, bunkerFloor);

  const wallSamples: Array<{ weapon: typeof WEAPONS[number]; renderer: ThreeGameDiagnostics['renderer'] }> = [];
  for (const weapon of WEAPONS) {
    const wall = await page.evaluate((id) => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      hooks.setWeapon(id);
      hooks.resetWeaponCaptureState();
      hooks.setAim(Math.PI * 0.5, 0);
      return window.__THREE_GAME_DIAGNOSTICS__!.renderer;
    }, weapon);
    expect(wall.weaponObstructionDistance, `${weapon} test lane must see the bunker wall`).toBeLessThan(2.25);
    expect(wall.weaponTuck, `${weapon} should retract immediately at the wall`).toBeGreaterThan(0.2);
    wallSamples.push({ weapon, renderer: wall });
  }
  expect(
    wallSamples.filter(({ renderer }) => renderer.weaponMuzzleOccluded),
    `every muzzle must remain behind the wall: ${JSON.stringify(wallSamples)}`,
  ).toEqual([]);

  // Exercise the player's real keyboard path at speed, not only deterministic
  // transform hooks. The weapon must enter tuck on the same frame the capsule
  // reaches the bunker wall and remain clear after the movement key releases.
  await page.evaluate((floor) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setWeapon('sniper');
    hooks.setPlayerKinematics(
      { x: -140.5, y: floor ?? 0, z: 116 },
      { x: 0, y: 0, z: 0 },
    );
    hooks.setAim(Math.PI * 0.5, 0);
    hooks.setPausedForScreenshot(false);
  }, bunkerFloor);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(850);
  await page.keyboard.up('KeyW');
  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setPausedForScreenshot(true);
    const aim = window.__THREE_GAME_DIAGNOSTICS__!.player;
    hooks.setAim(aim.yaw, aim.pitch);
  });
  const sprinted = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);
  expect(sprinted.player.position.x, 'real W input must be contained on the playable side of the wall').toBeGreaterThan(-143.74);
  expect(sprinted.renderer.weaponTuck, 'wall sprint should produce a strong weapon tuck').toBeGreaterThan(0.75);
  expect(sprinted.renderer.weaponMuzzleOccluded, 'sprinted weapon must not clip through the wall').toBe(false);

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.setPausedForScreenshot(false));
  await page.keyboard.down('KeyS');
  await page.waitForTimeout(1_000);
  await page.keyboard.up('KeyS');
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setPausedForScreenshot(true);
    const aim = window.__THREE_GAME_DIAGNOSTICS__!.player;
    hooks.setAim(aim.yaw, aim.pitch);
  });
  const retreated = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);
  expect(retreated.player.position.x, 'real S input must move the player away from the wall').toBeGreaterThan(-140.5);
  expect(retreated.renderer.weaponObstructionDistance, 'retreat must restore clear view-model space').toBeGreaterThan(3.2);
  expect(retreated.renderer.weaponTuck, 'weapon must fully return after wall clearance').toBeLessThan(0.04);
  expect(retreated.renderer.weaponMuzzleOccluded, 'restored weapon must remain clear of geometry').toBe(false);

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
