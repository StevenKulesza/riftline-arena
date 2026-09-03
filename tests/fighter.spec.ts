import { expect, test } from '@playwright/test';

test.describe('QuickSense Star Sparrow fighters', () => {
  test('boards, flies, fires, takes damage, rebuilds, and accepts an AI pilot', async ({ page }) => {
    test.setTimeout(240_000);
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto('/?map=quicksense&qa=visual', { waitUntil: 'commit' });
    await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__), null, { timeout: 240_000 });
    const pad = await page.evaluate(() => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      hooks.setReducedMotion(true);
      hooks.setState('active-play');
      const fighter = window.__THREE_GAME_DIAGNOSTICS__!.fighters[0];
      const position = { x: fighter.position.x, y: fighter.position.y, z: fighter.position.z };
      hooks.setPlayerKinematics(position, { x: 0, y: 0, z: 0 });
      return position;
    });

    await page.keyboard.press('r');
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(0.15));
    const padBoarded = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);
    const liveFighterIndex = padBoarded.fighters.findIndex((fighter) => fighter.pilot === 'player');
    expect(liveFighterIndex).toBeGreaterThanOrEqual(0);
    const padY = padBoarded.fighters[liveFighterIndex].position.y;

    await page.keyboard.down('w');
    await page.keyboard.down('Space');
    await page.keyboard.down('Shift');
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(1.25));
    await page.keyboard.up('Shift');
    await page.keyboard.up('Space');
    await page.keyboard.up('w');
    const liveTakeoff = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);
    expect(liveTakeoff.fighters[liveFighterIndex].position.y).toBeGreaterThan(padY + 1);
    expect(liveTakeoff.fighters[liveFighterIndex].speed).toBeGreaterThan(20);

    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.setState('quicksense-fighter-active'));

    const initial = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);
    expect(initial.fighters).toHaveLength(4);
    expect(initial.fighters.every((fighter) => fighter.modelReady && !fighter.loadError)).toBe(true);
    expect(initial.fighters.map((fighter) => fighter.pad)).toEqual([
      'NEXUS PAD N-W',
      'NEXUS PAD N-E',
      'NEXUS PAD S-W',
      'NEXUS PAD S-E',
    ]);
    expect(initial.fighters[2]).toMatchObject({ pilot: 'player', hull: 900, shield: 400, visible: false });
    expect(initial.viewMode).toBe('first-person');
    expect(initial.camera.distance).toBeLessThan(12);

    await page.evaluate(() => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      hooks.fireActiveFighterWeapon(false);
      hooks.fireActiveFighterWeapon(true);
      hooks.stepSimulation(0.02);
    });
    const fired = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);
    expect(fired.projectiles).toBeGreaterThanOrEqual(2);
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(0.48));
    const airborne = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);
    expect(airborne.fighters[2].physics.steps).toBeGreaterThan(0);
    expect(airborne.fighters[2].physics.collisionQueries).toBeGreaterThan(0);
    expect(airborne.fighters[2].position.z).toBeLessThan(initial.fighters[2].position.z);

    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.damageFighter('sparrow-south-west', 2_000));
    const destroyed = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);
    expect(destroyed.fighters[2]).toMatchObject({
      destroyed: true,
      hull: 0,
      pilot: null,
      visible: false,
      explosions: 1,
    });
    expect(destroyed.fighters[2].respawnSeconds).toBeCloseTo(12, 1);
    expect(destroyed.renderer.activeWeaponVfx).toBeGreaterThan(0);

    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(14.5));
    const rebuilt = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);
    expect(rebuilt.fighters[2]).toMatchObject({ destroyed: false, hull: 900, visible: true, explosions: 1 });
    expect(rebuilt.fighters[2].shield).toBeGreaterThan(0);
    expect(rebuilt.fighters[2].position.y).toBeCloseTo(pad.y, 1);

    const aiBoarded = await page.evaluate(() => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      hooks.setState('quicksense-fighter-ai-board');
      for (let attempt = 0; attempt < 12; attempt += 1) {
        hooks.stepSimulation(0.5);
        if (window.__THREE_GAME_DIAGNOSTICS__!.fighters.some((fighter) => typeof fighter.pilot === 'number')) break;
      }
      return window.__THREE_GAME_DIAGNOSTICS__!;
    });
    const aiVehicle = aiBoarded.fighters.find((fighter) => typeof fighter.pilot === 'number');
    expect(aiVehicle).toBeDefined();
    expect(aiVehicle?.ai?.state).toMatch(/launch|patrol|engage|evade/);

    const pairCollision = await page.evaluate(() => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      hooks.setState('quicksense-fighter-pads');
      hooks.setFighterKinematics('sparrow-north-west', { x: -8, y: 90, z: 0 }, { x: 45, y: 0, z: 0 });
      hooks.setFighterKinematics('sparrow-north-east', { x: 8, y: 90, z: 0 }, { x: -45, y: 0, z: 0 }, Math.PI);
      hooks.stepSimulation(0.18);
      return window.__THREE_GAME_DIAGNOSTICS__!;
    });
    expect(pairCollision.fighters[0].physics.collisionHits + pairCollision.fighters[1].physics.collisionHits).toBeGreaterThan(0);

    const doubledCeiling = await page.evaluate(() => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      hooks.setFighterKinematics('sparrow-north-west', { x: 0, y: 450, z: 0 }, { x: 0, y: 0, z: 0 });
      hooks.stepSimulation(0.02);
      const aboveOldCeiling = window.__THREE_GAME_DIAGNOSTICS__!.fighters[0].position.y;
      hooks.setFighterKinematics('sparrow-north-west', { x: 0, y: 700, z: 0 }, { x: 0, y: 20, z: 0 });
      hooks.stepSimulation(0.02);
      const diagnostics = window.__THREE_GAME_DIAGNOSTICS__!;
      return {
        aboveOldCeiling,
        clampedY: diagnostics.fighters[0].position.y,
        ceilingY: diagnostics.fighters[0].physics.ceilingY,
        mapAltitudeMax: diagnostics.map.altitudeRange.max,
      };
    });
    expect(doubledCeiling.aboveOldCeiling).toBeGreaterThan(440);
    expect(doubledCeiling.ceilingY).toBe(600);
    // The boundary contact clamps to 600, then its inward response advances a
    // few centimeters during the remaining fixed ticks. Assert containment
    // and proximity rather than requiring an unstable exact surface point.
    expect(doubledCeiling.clampedY).toBeLessThanOrEqual(600);
    expect(doubledCeiling.clampedY).toBeGreaterThan(599.8);
    expect(doubledCeiling.mapAltitudeMax).toBe(720);

    const terrainCollision = await page.evaluate(() => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      const floor = hooks.sampleFloorHeight(120, 100, 180)!;
      hooks.setFighterKinematics('sparrow-north-west', { x: 120, y: floor + 12, z: 100 }, { x: 0, y: -120, z: 0 });
      hooks.stepSimulation(0.25);
      return { floor, diagnostics: window.__THREE_GAME_DIAGNOSTICS__! };
    });
    expect(terrainCollision.diagnostics.fighters[0].physics.collisionHits).toBeGreaterThan(0);
    expect(terrainCollision.diagnostics.fighters[0].position.y).toBeGreaterThan(terrainCollision.floor + 0.5);

    const infantryCollision = await page.evaluate((padPosition) => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      hooks.setState('quicksense-fighter-pads');
      const x = padPosition.x;
      const z = padPosition.z;
      const floor = hooks.sampleFloorHeight(x, z, 60)!;
      hooks.setPlayerKinematics({ x, y: floor, z }, { x: 0, y: 0, z: 0 });
      hooks.stepSimulation(0.05);
      const position = window.__THREE_GAME_DIAGNOSTICS__!.player.position;
      return Math.hypot(position.x - x, position.z - z);
    }, pad);
    expect(infantryCollision).toBeGreaterThan(0.25);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
