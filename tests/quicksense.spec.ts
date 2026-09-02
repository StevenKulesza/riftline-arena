import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const diagnostics = async (page: import('@playwright/test').Page) => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);

test('QuickSense loads as a second authored arena with layered flow geometry', async ({ page }) => {
  await page.goto('/?map=quicksense&qa=physics');
  await page.waitForFunction(() => (
    Boolean(window.__THREE_GAME_TEST_HOOKS__)
    && Boolean(window.__THREE_GAME_DIAGNOSTICS__?.map.ready)
  ), null, { timeout: 180_000 });
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
  // The source-quality imported tower deliberately retains its architectural
  // stairs, railings and interior rather than substituting a decimated shell.
  // Keep a bounded full-map budget while preserving that traversal detail.
  expect(result.map.renderTriangles).toBeLessThan(450_000);
  expect(result.spawns.every((spawn) => Number.isFinite(spawn.x + spawn.y + spawn.z))).toBe(true);

  const pickupSupportChecks = await page.evaluate(() => {
    const diagnostics = window.__THREE_GAME_DIAGNOSTICS__!;
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    return diagnostics.pickups.map((pickup) => ({
      pickupY: pickup.position.y,
      supportY: hooks.sampleFloorHeight(pickup.position.x, pickup.position.z, pickup.position.y + 1),
    }));
  });
  expect(pickupSupportChecks.every(({ pickupY, supportY }) => (
    supportY !== null && Math.abs(pickupY - (supportY + 0.012)) < 0.05
  ))).toBe(true);
  expect(
    pickupSupportChecks.every(({ pickupY }) => pickupY < 70),
    'pickups must stay on the playable basin/tower layer, not floating-station roofs',
  ).toBe(true);

  expect(result.layeredSpine.every((height) => height !== null)).toBe(true);
  const spine = result.layeredSpine as number[];
  expect(Math.max(...spine) - Math.min(...spine)).toBeGreaterThan(20);
});

test('QuickSense projectile collision follows visible roads and mountain faces', async ({ page }) => {
  // Use a tiny same-origin document so this geometry-level test does not load
  // and render a second full arena behind the directly constructed fixture.
  await page.goto('/assets/ui/rift-logo.png');

  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/game/maps/QuickSenseArena.ts';
    const { QuickSenseArena } = await import(moduleUrl);
    const arena = new QuickSenseArena(450600);
    const point = (x: number, y: number, z: number) => arena.group.position.clone().set(x, y, z);
    const roadClearance = arena.segmentHitDetails(
      point(-28.59596010937328, 6.8, -147.84),
      point(-44.59596010937328, 6.8, -147.84),
    );
    const mountainRays = [
      [point(0, 64, 0), point(260, 64, 0)],
      [point(0, 64, 0), point(225.1666, 64, 130)],
    ].map(([start, end]) => arena.segmentHitDetails(start, end));
    const audit = arena.group.userData.staticWorldShotAudit as {
      engine: string;
      triangles: number;
      sourceMeshes: number;
      broadProxyFallbacks: number;
    };
    const response = {
      roadClearance: roadClearance ? { distance: roadClearance.distance, point: { ...roadClearance.point } } : null,
      mountainRays: mountainRays.map((hit) => hit ? { distance: hit.distance, point: { ...hit.point } } : null),
      audit,
    };
    arena.dispose();
    return response;
  });

  expect(result.audit.engine).toBe('visible-static-projectile-bvh');
  expect(result.audit.triangles).toBeGreaterThan(40_000);
  expect(result.audit.sourceMeshes).toBeGreaterThan(250);
  expect(result.audit.broadProxyFallbacks).toBe(0);
  expect(result.roadClearance, 'a shot above/outside the visible road must stay in open air').toBeNull();
  expect(result.mountainRays.every((hit) => hit !== null), 'every sampled visible mountain face must block shots').toBe(true);
  expect(result.mountainRays.every((hit) => hit!.distance > 160 && hit!.distance < 230)).toBe(true);
});

test('loaded QuickSense keeps open-air road shots clear and mountain sightlines blocked', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'Collision integration capture runs once in desktop Chromium.');
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/?map=quicksense&qa=physics&mapSeed=450600');
  await page.waitForFunction(() => (
    Boolean(window.__THREE_GAME_TEST_HOOKS__)
    && window.__THREE_GAME_DIAGNOSTICS__?.map.name === 'QuickSense'
    && Boolean(window.__THREE_GAME_DIAGNOSTICS__?.map.ready)
  ));
  const collision = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const roadOpen = hooks.sampleLineOfSight(
      { x: -28.59596010937328, y: 6.8, z: -147.84 },
      { x: -44.59596010937328, y: 6.8, z: -147.84 },
    );
    const mountainBlocked = [
      hooks.sampleLineOfSight({ x: 0, y: 64, z: 0 }, { x: 260, y: 64, z: 0 }),
      hooks.sampleLineOfSight({ x: 0, y: 64, z: 0 }, { x: 225.1666, y: 64, z: 130 }),
    ].map((clear) => !clear);
    hooks.setState('quicksense-ramp');
    hooks.setPausedForScreenshot(true);
    return { roadOpen, mountainBlocked };
  });
  await page.waitForTimeout(150);
  const captureDirectory = 'artifacts/quicksense-projectile-collision';
  mkdirSync(captureDirectory, { recursive: true });
  await page.screenshot({
    path: `${captureDirectory}/road-mountain-verification.png`,
    animations: 'disabled',
  });

  expect(collision.roadOpen, 'the reported road-edge shot must remain in open air').toBe(true);
  expect(collision.mountainBlocked, 'both visible mountain faces must occlude projectiles').toEqual([true, true]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('QuickSense seats every route and ramp support below the deck underside', async ({ page }) => {
  await page.goto('/?map=quicksense&qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));

  const audit = await page.evaluate(async () => {
    const moduleUrl = '/src/game/maps/QuickSenseArena.ts';
    const { QuickSenseArena } = await import(moduleUrl);
    const arena = new QuickSenseArena(450600);
    const result = arena.group.userData.supportClearanceAudit as {
      samples: number;
      minimum: number | null;
      maximum: number | null;
      penetrations: number;
    };
    arena.dispose();
    return result;
  });

  expect(audit.samples).toBeGreaterThan(20);
  expect(audit.penetrations).toBe(0);
  expect(audit.minimum).not.toBeNull();
  expect(audit.maximum).not.toBeNull();
  expect(audit.minimum!).toBeGreaterThanOrEqual(0);
  expect(audit.maximum!).toBeLessThanOrEqual(0.005);
});

test('QuickSense exposes a unique authored identity for every major building', async ({ page }) => {
  await page.goto('/?map=quicksense&qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));

  const audit = await page.evaluate(async () => {
    const moduleUrl = '/src/game/maps/QuickSenseArena.ts';
    const { QuickSenseArena } = await import(moduleUrl);
    const arena = new QuickSenseArena(450600);
    const manifest = arena.group.userData.buildings as Array<{
      name: string;
      category: string;
      profile: string;
      accent: string;
      position: { x: number; y: number; z: number };
    }>;
    const markerNames: string[] = [];
    arena.group.traverse((object: { name: string; userData: Record<string, unknown> }) => {
      if (object.userData.kind === 'quicksense-building') markerNames.push(object.name);
    });
    const result = { manifest, markerNames };
    arena.dispose();
    return result;
  });

  expect(audit.manifest).toHaveLength(21);
  expect(new Set(audit.manifest.map(({ name }) => name)).size).toBe(21);
  expect(audit.markerNames).toHaveLength(21);
  expect(audit.manifest.filter(({ category }) => category === 'cliff-habitat')).toHaveLength(8);
  expect(audit.manifest.filter(({ category }) => category === 'floating-station')).toHaveLength(3);
  expect(new Set(
    audit.manifest
      .filter(({ category }) => category === 'cliff-habitat')
      .map(({ profile }) => profile),
  ).size).toBe(8);
  expect(new Set(
    audit.manifest
      .filter(({ category }) => category === 'floating-station')
      .map(({ profile }) => profile),
  ).size).toBe(3);
  expect(audit.manifest.every(({ profile, accent, position }) => (
    profile.length > 0
      && ['cyan', 'magenta', 'amber'].includes(accent)
      && Number.isFinite(position.x + position.y + position.z)
  ))).toBe(true);
});

test('QuickSense exposes one deterministic ground-connection review state per live structure', async ({ page }) => {
  await page.goto('/?map=quicksense&qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));

  const audit = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const structures = hooks.getStructureAudit();
    const views = structures.map((structure) => {
      hooks.setState(structure.state);
      const diagnostics = window.__THREE_GAME_DIAGNOSTICS__!;
      return {
        id: structure.id,
        state: structure.state,
        connection: structure.connection,
        camera: diagnostics.camera.position,
        player: diagnostics.player.position,
      };
    });
    return { structures, views };
  });

  // Loading the imported outpost replaces the four overlapping procedural
  // center structures, leaving seventeen authored facilities plus the tower.
  expect(audit.structures).toHaveLength(18);
  expect(new Set(audit.structures.map(({ id }) => id)).size).toBe(18);
  expect(audit.structures.filter(({ connection }) => connection === 'terrain-tethers')).toHaveLength(3);
  expect(audit.structures.filter(({ connection }) => connection === 'terrain-foundation')).toHaveLength(15);
  expect(audit.views.every(({ state, camera, player }) => (
    state.startsWith('quicksense-structure-')
      && Number.isFinite(camera.x + camera.y + camera.z)
      && Number.isFinite(player.x + player.y + player.z)
  ))).toBe(true);
});

test('QuickSense tower is player-scaled and supports one continuous terrain-to-interior stair climb', async ({ page }) => {
  await page.goto('/?map=quicksense&qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));

  const setup = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const tower = hooks.getOutpostTowerAudit();
    if (!tower?.grounding) throw new Error('Outpost tower traversal audit is unavailable.');
    const stairs = tower.grounding.accessStairs;
    const lowerFloorY = stairs[1].start.y;
    const targets = [
      { name: 'terrain access', ...stairs[0].end },
      { name: 'east doorway', x: 0, y: lowerFloorY, z: 0 },
      { name: 'lower hall turn', x: 7, y: lowerFloorY, z: 6 },
      { name: 'first stair foot', ...stairs[1].start },
      ...stairs.slice(1).map((stair, index) => ({ name: `stair ${index + 1}`, ...stair.end })),
    ];
    hooks.setPausedForScreenshot(true);
    hooks.setPlayerKinematics(stairs[0].start, { x: 0, y: 0, z: 0 });
    return {
      tower,
      pieces: hooks.getOutpostTowerPieceAudit(),
      targets,
      startY: stairs[0].start.y,
    };
  });

  // Counter-scaling the arena root resolves the source GLB at one source unit
  // per world metre, keeping its guard rails at player scale.
  expect(setup.tower!.habitableHeight).toBeGreaterThan(95);
  expect(setup.tower!.habitableHeight).toBeLessThan(110);
  expect(setup.tower!.height).toBeGreaterThan(140);
  expect(setup.pieces).toHaveLength(26);
  expect(setup.pieces.every((piece) => piece.uvVertices > 0)).toBe(true);
  expect(setup.tower!.collision.bodyTriangles).toBeGreaterThan(20_000);
  expect(setup.tower!.collision.walkableTriangles).toBeGreaterThan(20_000);

  const telemetry: Array<{
    name: string;
    reached: boolean;
    y: number;
    wallSamples: number;
  }> = [];
  for (const target of setup.targets) {
    await page.keyboard.down('KeyW');
    const leg = await page.evaluate((next) => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      let reached = false;
      let staleSamples = 0;
      let previousDistance = Number.POSITIVE_INFINITY;
      let wallSamples = 0;
      for (let sample = 0; sample < 180; sample += 1) {
        const diagnostics = window.__THREE_GAME_DIAGNOSTICS__!;
        const dx = next.x - diagnostics.player.position.x;
        const dz = next.z - diagnostics.player.position.z;
        const distance = Math.hypot(dx, dz);
        wallSamples += diagnostics.player.wallContact ? 1 : 0;
        if (distance < 1 && Math.abs(diagnostics.player.position.y - next.y) < 1.6) {
          reached = true;
          break;
        }
        staleSamples = previousDistance - distance < 0.008 ? staleSamples + 1 : 0;
        previousDistance = distance;
        hooks.setAim(Math.atan2(-dx, -dz), -0.04);
        hooks.stepSimulation(0.045);
        if (staleSamples > 35) break;
      }
      const diagnostics = window.__THREE_GAME_DIAGNOSTICS__!;
      return {
        name: next.name,
        reached,
        y: diagnostics.player.position.y,
        wallSamples,
      };
    }, target);
    await page.keyboard.up('KeyW');
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.stepSimulation(0.1));
    telemetry.push(leg);
    if (!leg.reached) break;
  }

  expect(telemetry.map(({ name, reached }) => ({ name, reached }))).toEqual(
    setup.targets.map(({ name }) => ({ name, reached: true })),
  );
  expect(telemetry.every(({ wallSamples }) => wallSamples === 0)).toBe(true);
  expect(telemetry.at(-1)!.y - setup.startY).toBeGreaterThan(18);
});

test('QuickSense mountainous terrain and live structures retain exact drop support', async ({ page }) => {
  await page.goto('/?map=quicksense&qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));

  const failures = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setPausedForScreenshot(true);
    const mountainSamples = [
      [-150, -100], [-150, 0], [-150, 100], [-120, 140], [-60, 145],
      [0, 145], [60, 145], [120, 140], [150, 100], [150, 0],
      [150, -100], [90, -135], [0, -145], [-90, -135],
    ];
    const structureSamples = hooks.getStructureAudit().map((structure) => (
      [structure.position.x, structure.position.z] as [number, number]
    ));
    const problems: string[] = [];
    for (const [x, z] of [...mountainSamples, ...structureSamples]) {
      const floor = hooks.sampleFloorHeight(x, z, 240);
      if (floor === null) {
        problems.push(`missing support at ${x.toFixed(1)},${z.toFixed(1)}`);
        continue;
      }
      hooks.setPlayerKinematics(
        { x, y: floor + 8, z },
        { x: 0, y: -28, z: 0 },
      );
      hooks.stepSimulation(0.65);
      const player = window.__THREE_GAME_DIAGNOSTICS__!.player;
      const support = hooks.sampleFloorHeight(
        player.position.x,
        player.position.z,
        player.position.y + 1.2,
      );
      if (support === null || player.position.y < support - 0.003) {
        problems.push(
          `fell through ${x.toFixed(1)},${z.toFixed(1)}: ${player.position.y.toFixed(3)} / ${support?.toFixed(3) ?? 'null'}`,
        );
      }
    }
    return problems;
  });

  expect(failures).toEqual([]);
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
    const southLaunch = [-126, -114.8, -103.6, -92.4, -81.2, -70]
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
      { name: 'west transfer', start: [-142, -36], end: [-84, -36], width: 19, fromY: 45 },
      { name: 'east transfer', start: [142, 36], end: [76, 36], width: 19, fromY: 45 },
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

test('QuickSense reciprocal ramp handoffs have no height cracks or overlapping deck steps', async ({ page }) => {
  await page.goto('/?map=quicksense&qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));

  const seams = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setPausedForScreenshot(true);
    const sample = (x: number, z: number) => hooks.sampleFloorHeight(x, z, 160);
    return [
      { name: 'south crest', heights: [sample(0, -70.02), sample(0, -69.98)] },
      { name: 'west receiver', heights: [sample(-84.02, -36), sample(-83.98, -36)] },
      { name: 'east receiver', heights: [sample(76.02, 36), sample(75.98, 36)] },
      { name: 'center spine', heights: [sample(0, -20.42), sample(0, -20.38)] },
      { name: 'north inner merge', heights: [sample(0, 70.02), sample(0, 69.98)] },
      { name: 'north outer merge', heights: [sample(0, 137.98), sample(0, 138.02)] },
    ];
  });

  for (const seam of seams) {
    expect(seam.heights[0], `${seam.name} inside surface`).not.toBeNull();
    expect(seam.heights[1], `${seam.name} outside surface`).not.toBeNull();
    expect(
      Math.abs(seam.heights[0]! - seam.heights[1]!),
      `${seam.name} must remain a seated reciprocal handoff`,
    ).toBeLessThan(0.05);
  }
});

test('QuickSense route crossings are grade-separated instead of interpenetrating', async ({ page }) => {
  await page.goto('/?map=quicksense&qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));

  const crossings = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setPausedForScreenshot(true);
    return [
      // The lower decks are 2.5 m deep, so 6.5 m deck-top separation retains
      // more than two player heights of open underside clearance.
      { name: 'west lower underpass', x: -100, z: -54, minimumClearance: 6.5 },
      { name: 'east lower underpass', x: 100, z: -54, minimumClearance: 6.5 },
      { name: 'east upper overpass', x: 54.5, z: 38.5, minimumClearance: 12 },
      { name: 'west upper overpass', x: -54.5, z: 38.5, minimumClearance: 6.5 },
    ].map((crossing) => {
      const upper = hooks.sampleFloorHeight(crossing.x, crossing.z, 160);
      const lower = upper === null
        ? null
        : hooks.sampleFloorHeight(crossing.x, crossing.z, upper - 0.5);
      return { ...crossing, upper, lower };
    });
  });

  for (const crossing of crossings) {
    expect(crossing.upper, `${crossing.name} upper deck`).not.toBeNull();
    expect(crossing.lower, `${crossing.name} lower deck`).not.toBeNull();
    expect(
      crossing.upper! - crossing.lower!,
      `${crossing.name} must retain visible player-height clearance`,
    ).toBeGreaterThan(crossing.minimumClearance);
  }
});

test('QuickSense has no non-seam route or junction volume overlaps', async ({ page }) => {
  await page.goto('/?map=quicksense&qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));

  const audit = await page.evaluate(async () => {
    const moduleUrl = '/src/game/maps/QuickSenseArena.ts';
    const { QuickSenseArena } = await import(moduleUrl);
    const arena = new QuickSenseArena(450600) as unknown as {
      pathSurfaces: Array<{ name: string; heightAt(x: number, z: number): number | null }>;
      rampSurfaces: Array<{ name: string; flow: { heightAt(x: number, z: number): number | null } }>;
      platformSurfaces: Array<{
        name: string;
        minX: number;
        maxX: number;
        minZ: number;
        maxZ: number;
        y: number;
      }>;
      group: {
        scale: { x: number };
        traverse(callback: (object: {
          name: string;
          scale: { x: number };
          geometry?: {
            boundingBox: { min: { x: number }; max: { x: number } } | null;
            computeBoundingBox(): void;
          };
        }) => void): void;
      };
      jumpPads: Array<{ radius: number }>;
      dispose(): void;
    };
    const routes = [
      ...arena.pathSurfaces.map((path) => ({ name: path.name, heightAt: (x: number, z: number) => path.heightAt(x, z) })),
      ...arena.rampSurfaces.map((ramp) => ({ name: ramp.name, heightAt: (x: number, z: number) => ramp.flow.heightAt(x, z) })),
    ];
    const failures: string[] = [];
    const isAllowedSeam = (a: string, b: string, x: number, z: number): boolean => {
      const names = new Set([a, b]);
      if (names.has('South progressive launch') && names.has('Center crest downslope')) return Math.abs(z + 35) < 0.001;
      if (names.has('Central clear-span spine') && names.has('North return launch')) return Math.abs(z - 35) < 0.001;
      if (names.has('Cyan west transfer receiver') && names.has('West transfer ramp')) return Math.abs(x + 42) < 0.001;
      if (names.has('Magenta east transfer receiver') && names.has('East transfer ramp')) return Math.abs(x - 38) < 0.001;
      return false;
    };

    for (let x = -86; x <= 86; x += 0.5) {
      for (let z = -76; z <= 76; z += 0.5) {
        const hits = routes
          .map((route) => ({ route, y: route.heightAt(x, z) }))
          .filter((hit): hit is { route: typeof routes[number]; y: number } => hit.y !== null);
        for (let left = 0; left < hits.length; left += 1) {
          for (let right = left + 1; right < hits.length; right += 1) {
            const a = hits[left];
            const b = hits[right];
            if (Math.abs(a.y - b.y) >= 3.5 || isAllowedSeam(a.route.name, b.route.name, x, z)) continue;
            failures.push(`${a.route.name} intersects ${b.route.name} at ${x},${z}`);
          }
        }
      }
    }

    const junctions = arena.platformSurfaces.filter((platform) => platform.name.includes('junction'));
    for (const junction of junctions) {
      for (let x = junction.minX + 0.25; x < junction.maxX; x += 0.25) {
        for (let z = junction.minZ + 0.25; z < junction.maxZ; z += 0.25) {
          for (const route of routes) {
            const y = route.heightAt(x, z);
            if (y !== null && Math.abs(y - junction.y) < 3.5) {
              failures.push(`${route.name} penetrates ${junction.name} at ${x},${z}`);
            }
          }
        }
      }
    }
    let maximumShellDiameter = 0;
    arena.group.traverse((object) => {
      if (object.name !== 'QuickSense jump pad' || !object.geometry) return;
      object.geometry.computeBoundingBox();
      const bounds = object.geometry.boundingBox;
      if (!bounds) return;
      maximumShellDiameter = Math.max(
        maximumShellDiameter,
        (bounds.max.x - bounds.min.x) * object.scale.x * arena.group.scale.x,
      );
    });
    const maximumTriggerDiameter = Math.max(...arena.jumpPads.map((pad) => pad.radius * 2));
    arena.dispose();
    return {
      problems: failures.slice(0, 24),
      maximumShellDiameter,
      maximumTriggerDiameter,
    };
  });

  expect(audit.problems).toEqual([]);
  expect(audit.maximumShellDiameter, 'jump-pad shell must stay subordinate to route width').toBeLessThanOrEqual(7);
  expect(audit.maximumTriggerDiameter, 'jump-pad trigger must not read as a giant platform').toBeLessThanOrEqual(7);
});

test('QuickSense major ramps carry 60 m/s ski traversal in both directions without false CCD walls', async ({ page }) => {
  await page.goto('/?map=quicksense&qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));
  await page.keyboard.down('ShiftLeft');

  const failures = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setPausedForScreenshot(true);
    const routes = [
      { name: 'south launch', start: [0, -124], end: [0, -72], lateralLimit: 10, fromY: 140 },
      { name: 'north return', start: [0, 124], end: [0, 72], lateralLimit: 10, fromY: 140 },
      { name: 'west transfer', start: [-140, -36], end: [-84, -36], lateralLimit: 10, fromY: 140 },
      // The exact static-floor BVH also exposes a facility roof above this
      // route. Start the traversal ray below that roof to select the transfer.
      { name: 'east transfer', start: [140, 36], end: [76, 36], lateralLimit: 10, fromY: 80 },
      { name: 'center transition', start: [0, -55], end: [0, -22], lateralLimit: 8, fromY: 140 },
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
        const y = hooks.sampleFloorHeight(start[0], start[1], route.fromY);
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
