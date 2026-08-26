import { expect, test } from '@playwright/test';

const diagnostics = async (page: import('@playwright/test').Page) => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);

test('QuickSense loads as a second authored arena with layered flow geometry', async ({ page }) => {
  await page.goto('/?map=quicksense&qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));
  const result = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const layeredSpine = [-138, -100, -60, 0, 60, 100, 138].map((z) => hooks.sampleFloorHeight(0, z, 160));
    return {
      map: window.__THREE_GAME_DIAGNOSTICS__!.map,
      spawns: hooks.getSpawnPoints(),
      layeredSpine,
    };
  });

  expect(result.map.name).toBe('QuickSense');
  expect(result.map.bounds).toEqual({ width: 360, depth: 320 });
  expect(result.map.spawnCount).toBe(8);
  expect(result.map.jumpPadCount).toBe(5);
  expect(result.map.altitudeRange.max).toBeGreaterThanOrEqual(70);
  expect(result.map.skiRoutes).toBeGreaterThanOrEqual(8);
  expect(result.map.renderTriangles).toBeLessThan(31_000);
  expect(result.spawns.every((spawn) => Number.isFinite(spawn.x + spawn.y + spawn.z))).toBe(true);

  expect(result.layeredSpine.every((height) => height !== null)).toBe(true);
  const spine = result.layeredSpine as number[];
  expect(Math.max(...spine) - Math.min(...spine)).toBeGreaterThan(20);
});

test('QuickSense keeps the live movement contract on its floor and transfers', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/?map=quicksense&qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));
  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('view-0');
    hooks.setPausedForScreenshot(true);
  });
  const before = await diagnostics(page);
  await page.keyboard.down('KeyW');
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(0.32));
  await page.keyboard.up('KeyW');
  const after = await diagnostics(page);

  expect(before.map.name).toBe('QuickSense');
  expect(before.player.grounded).toBe(true);
  expect(after.player.grounded).toBe(true);
  expect(after.player.speed).toBeGreaterThan(13);
  expect(after.player.position.x !== before.player.position.x || after.player.position.z !== before.player.position.z).toBe(true);
  expect(after.physics.contacts).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});

test('QuickSense exposes pumpable rollers and a reciprocal two-way ramp profile', async ({ page }) => {
  await page.goto('/?map=quicksense&qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));

  const profiles = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setPausedForScreenshot(true);
    const outerCircuit = [
      [0, -144], [-60, -146], [-118, -124], [-150, -76], [-158, -14],
      [-150, 50], [-122, 102], [-72, 134], [-20, 140],
    ].map(([x, z]) => hooks.sampleFloorHeight(x, z, 160));
    const southLaunch = [-138, -124.4, -110.8, -97.2, -83.6, -70]
      .map((z) => hooks.sampleFloorHeight(0, z, 160));
    return { outerCircuit, southLaunch };
  });

  expect(profiles.outerCircuit.every((height) => height !== null)).toBe(true);
  const outer = profiles.outerCircuit as number[];
  const outerDeltas = outer.slice(1).map((height, index) => height - outer[index]);
  expect(outerDeltas.filter((delta) => delta > 1.5).length).toBeGreaterThanOrEqual(3);
  expect(outerDeltas.filter((delta) => delta < -1.5).length).toBeGreaterThanOrEqual(3);

  expect(profiles.southLaunch.every((height) => height !== null)).toBe(true);
  const launch = profiles.southLaunch as number[];
  const launchDeltas = launch.slice(1).map((height, index) => height - launch[index]);
  expect(launchDeltas.every((delta) => delta > 0)).toBe(true);
  expect(Math.max(...launchDeltas)).toBeGreaterThan(launchDeltas[0] * 3);
  expect(Math.abs(launchDeltas.at(-1)! - launchDeltas[0])).toBeLessThan(0.08);

  const downhillStart = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const y = hooks.sampleFloorHeight(-122, 102, 160) ?? 0;
    hooks.setPlayerKinematics(
      { x: -122, y, z: 102 },
      { x: -6.64, y: 0, z: -12.34 },
    );
    return window.__THREE_GAME_DIAGNOSTICS__!.player;
  });
  await page.keyboard.down('ShiftLeft');
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(1.5));
  await page.keyboard.up('ShiftLeft');
  const downhill = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.player);
  expect(downhill.skiing).toBe(true);
  expect(downhill.position.y).toBeLessThan(downhillStart.position.y - 3);
  expect(downhill.speed).toBeGreaterThan(downhillStart.speed + 3);
});

test('QuickSense ramp centerlines and shoulders remain clear in both travel directions', async ({ page }) => {
  await page.goto('/?map=quicksense&qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));

  const failures = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setPausedForScreenshot(true);
    const routes = [
      { name: 'south launch', start: [0, -138], end: [0, -78], width: 22, fromY: 30 },
      { name: 'north return', start: [0, 138], end: [0, 78], width: 22, fromY: 45 },
      { name: 'west transfer', start: [-152, -36], end: [-90, -36], width: 19, fromY: 45 },
      { name: 'east transfer', start: [152, 36], end: [90, 36], width: 19, fromY: 45 },
      { name: 'center transition', start: [0, -56], end: [0, -20.4], width: 18, fromY: 22 },
    ] as const;
    const problems: string[] = [];
    for (const route of routes) {
      const dx = route.end[0] - route.start[0];
      const dz = route.end[1] - route.start[1];
      const length = Math.hypot(dx, dz);
      const lateralX = dz / length;
      const lateralZ = -dx / length;
      for (const direction of [-1, 1]) {
        for (const shoulder of [-0.42, 0, 0.42]) {
          for (let sample = 1; sample <= 6; sample += 1) {
            const t = sample / 7;
            const x = route.start[0] + dx * t + lateralX * route.width * shoulder;
            const z = route.start[1] + dz * t + lateralZ * route.width * shoulder;
            const y = hooks.sampleFloorHeight(x, z, route.fromY);
            if (y === null) {
              problems.push(`${route.name}: missing floor at ${t.toFixed(2)} shoulder ${shoulder}`);
              continue;
            }
            hooks.setPlayerKinematics(
              { x, y, z },
              { x: direction * dx / length * 6, y: 0, z: direction * dz / length * 6 },
            );
            const seated = window.__THREE_GAME_DIAGNOSTICS__!;
            const horizontalDisplacement = Math.hypot(
              seated.player.position.x - x,
              seated.player.position.z - z,
            );
            if (horizontalDisplacement > 0.03 || seated.player.wallContact) {
              problems.push(
                `${route.name}: seated ${horizontalDisplacement.toFixed(3)} from request at ${t.toFixed(2)} shoulder ${shoulder}`,
              );
            }
            hooks.stepSimulation(0.025);
            const diagnostics = window.__THREE_GAME_DIAGNOSTICS__!;
            if (diagnostics.player.wallContact) {
              problems.push(`${route.name}: wall contact at ${t.toFixed(2)} direction ${direction} shoulder ${shoulder}`);
            }
            if (!Number.isFinite(
              diagnostics.player.position.x
              + diagnostics.player.position.y
              + diagnostics.player.position.z,
            )) {
              problems.push(`${route.name}: non-finite capsule state`);
            }
          }
        }
      }
    }
    return problems;
  });

  expect(failures).toEqual([]);
});

test('QuickSense major ramps carry 60 m/s ski traversal in both directions without false CCD walls', async ({ page }) => {
  await page.goto('/?map=quicksense&qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));
  await page.keyboard.down('ShiftLeft');

  const failures = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setPausedForScreenshot(true);
    const routes = [
      { name: 'south launch', start: [0, -136], end: [0, -72], lateralLimit: 10 },
      { name: 'north return', start: [0, 136], end: [0, 72], lateralLimit: 10 },
      { name: 'west transfer', start: [-152, -36], end: [-86, -36], lateralLimit: 10 },
      { name: 'east transfer', start: [152, 36], end: [86, 36], lateralLimit: 10 },
      { name: 'center transition', start: [0, -55], end: [0, -22], lateralLimit: 8 },
    ] as const;
    const problems: string[] = [];

    for (const route of routes) {
      for (const direction of [-1, 1]) {
        const start = direction > 0 ? route.start : route.end;
        const end = direction > 0 ? route.end : route.start;
        const dx = end[0] - start[0];
        const dz = end[1] - start[1];
        const length = Math.hypot(dx, dz);
        const tangentX = dx / length;
        const tangentZ = dz / length;
        const y = hooks.sampleFloorHeight(start[0], start[1], 140);
        if (y === null) {
          problems.push(`${route.name}: missing start floor in direction ${direction}`);
          continue;
        }
        const wallHitsBefore = window.__THREE_GAME_DIAGNOSTICS__!.physics.ccd.wallHits;
        hooks.setPlayerKinematics(
          { x: start[0], y, z: start[1] },
          { x: tangentX * 60, y: 0, z: tangentZ * 60 },
        );
        let progress = 0;
        let maximumLateralError = 0;
        let touchedWall = false;
        for (let step = 0; step < 180 && progress < length - 1; step += 1) {
          hooks.stepSimulation(0.025);
          const diagnostics = window.__THREE_GAME_DIAGNOSTICS__!;
          const offsetX = diagnostics.player.position.x - start[0];
          const offsetZ = diagnostics.player.position.z - start[1];
          progress = offsetX * tangentX + offsetZ * tangentZ;
          maximumLateralError = Math.max(
            maximumLateralError,
            Math.abs(offsetX * tangentZ - offsetZ * tangentX),
          );
          touchedWall ||= diagnostics.player.wallContact;
          if (!Number.isFinite(
            diagnostics.player.position.x
            + diagnostics.player.position.y
            + diagnostics.player.position.z
            + diagnostics.player.speed,
          )) {
            problems.push(`${route.name}: non-finite state in direction ${direction}`);
            break;
          }
        }
        const after = window.__THREE_GAME_DIAGNOSTICS__!;
        if (progress < length - 1) {
          problems.push(`${route.name}: only traversed ${progress.toFixed(1)} / ${length.toFixed(1)} m in direction ${direction}`);
        }
        if (maximumLateralError > route.lateralLimit) {
          problems.push(`${route.name}: drifted ${maximumLateralError.toFixed(1)} m in direction ${direction}`);
        }
        if (touchedWall || after.physics.ccd.wallHits !== wallHitsBefore) {
          problems.push(`${route.name}: false wall contact in direction ${direction}`);
        }
      }
    }
    return problems;
  });

  await page.keyboard.up('ShiftLeft');
  expect(failures).toEqual([]);
});

test('QuickSense exposes a working grapple anchor and bounce launch', async ({ page }) => {
  await page.goto('/?map=quicksense&qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));

  const grapple = await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__!.setState('quicksense-grapple');
    return window.__THREE_GAME_DIAGNOSTICS__!.grapple;
  });
  expect(grapple.active).toBe(true);
  expect(grapple.length).toBeGreaterThan(1.35);
  expect(grapple.length).toBeLessThanOrEqual(grapple.maxLength + 0.1);

  const bounce = await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__!.setState('quicksense-bounce');
    const player = window.__THREE_GAME_DIAGNOSTICS__!.player;
    return { speed: player.speed, verticalVelocity: player.velocity.y };
  });
  expect(bounce.speed).toBeGreaterThan(10);
  expect(bounce.verticalVelocity).toBeGreaterThan(12);
});
