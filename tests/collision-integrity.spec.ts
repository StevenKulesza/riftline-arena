import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { MOVEMENT } from '../src/game/config';
import { MONSOON_DIVIDE, MONSOON_WORLD_SCALE } from '../src/game/maps/MonsoonDivide';

const MAP_SEED = 450_600;

type Vec3 = { x: number; y: number; z: number };

type PhysicsSample = {
  position: Vec3;
  velocity: Vec3;
  grounded: boolean;
  wallContact: boolean;
  ceilingContact: boolean;
  contacts: number;
  ccd: { sweeps: number; wallHits: number; ceilingHits: number; boundaryHits: number };
};

function desktopOnly(testInfo: TestInfo): void {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'Deterministic collision QA runs once on desktop Chromium.');
}

async function openPhysicsMap(page: Page): Promise<{ consoleErrors: string[]; pageErrors: string[] }> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`/?qa=physics&mapSeed=${MAP_SEED}`);
  await page.waitForFunction(() => (
    Boolean(window.__THREE_GAME_TEST_HOOKS__)
    && Boolean(window.__THREE_GAME_DIAGNOSTICS__?.map.ready)
    && (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5
  ));
  await page.evaluate((seed) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.seed(seed);
    hooks.setReducedMotion(true);
    hooks.hideDebugUi(true);
    hooks.setState('movement-flat');
    hooks.setPausedForScreenshot(true);
  }, MAP_SEED);
  return { consoleErrors, pageErrors };
}

async function openNamedPhysicsMap(
  page: Page,
  map: 'monsoon' | 'quicksense',
): Promise<{ consoleErrors: string[]; pageErrors: string[] }> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const mapQuery = map === 'quicksense' ? '&map=quicksense' : '';
  await page.goto(`/?qa=physics&mapSeed=${MAP_SEED}${mapQuery}`);
  await page.waitForFunction(() => (
    Boolean(window.__THREE_GAME_TEST_HOOKS__)
    && Boolean(window.__THREE_GAME_DIAGNOSTICS__?.map.ready)
    && (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5
  ));
  await page.evaluate((seed) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.seed(seed);
    hooks.setReducedMotion(true);
    hooks.hideDebugUi(true);
    hooks.setPausedForScreenshot(true);
  }, MAP_SEED);
  return { consoleErrors, pageErrors };
}

async function floorHeight(page: Page, x: number, z: number, fromY = Number.POSITIVE_INFINITY): Promise<number> {
  const floor = await page.evaluate(({ x: px, z: pz, fromY: rayY }) => (
    window.__THREE_GAME_TEST_HOOKS__?.sampleFloorHeight(px, pz, rayY) ?? null
  ), { x, z, fromY });
  if (floor === null) throw new Error(`No collision floor at (${x}, ${z}) from ${fromY}.`);
  return floor;
}

async function sample(page: Page): Promise<PhysicsSample> {
  return page.evaluate(() => {
    const diagnostics = window.__THREE_GAME_DIAGNOSTICS__!;
    return {
      position: diagnostics.player.position,
      velocity: diagnostics.player.velocity,
      grounded: diagnostics.player.grounded,
      wallContact: diagnostics.player.wallContact,
      ceilingContact: diagnostics.player.ceilingContact,
      contacts: diagnostics.physics.contacts,
      ccd: diagnostics.physics.ccd,
    };
  });
}

async function driveKinematics(page: Page, position: Vec3, velocity: Vec3, seconds: number): Promise<PhysicsSample> {
  await page.evaluate(({ position: spawn, velocity: launch, seconds: duration }) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setPlayerKinematics(spawn, launch);
    hooks.stepSimulation(duration);
  }, { position, velocity, seconds });
  return sample(page);
}

test('swept capsule contains dash-speed motion at structure walls, ceilings, ramp sides, and map bounds', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  test.setTimeout(180_000);
  const errors = await openPhysicsMap(page);
  const report: Record<string, PhysicsSample | number | boolean> = {};

  // West relay bunker: its back wall is centered at x=-289 and is 2.2m
  // thick. The capsule approaches from the playable interior/east side.
  // z=232 stays clear of the new roof service cabin so the top ray resolves
  // the bunker roof and the lower ray resolves its enterable interior floor.
  const westRoof = await floorHeight(page, -138 * MONSOON_WORLD_SCALE, 116 * MONSOON_WORLD_SCALE);
  const westFloor = await floorHeight(page, -138 * MONSOON_WORLD_SCALE, 116 * MONSOON_WORLD_SCALE, westRoof - 0.9);
  const westWall = await driveKinematics(
    page,
    { x: -285.8, y: westFloor + 0.006, z: 116 * MONSOON_WORLD_SCALE },
    { x: -60, y: 0, z: 0 },
    0.5,
  );
  report.westWall = westWall;
  expect(westWall.position.x, 'west bunker capsule must remain on the interior side of its back wall').toBeGreaterThan(-287.72);
  expect(westWall.velocity.x, 'wall impact must remove inward velocity instead of teleporting through').toBeGreaterThan(-0.05);

  // The same bunker roof must be solid from below. Historically box recovery
  // only chose X/Z faces, so upward jetpack motion could cross the ceiling.
  const roofSlabThickness = 0.62;
  const westCeiling = await driveKinematics(
    page,
    { x: -132 * MONSOON_WORLD_SCALE, y: westFloor + 0.006, z: 116 * MONSOON_WORLD_SCALE },
    { x: 0, y: 60, z: 0 },
    0.32,
  );
  report.westCeiling = westCeiling;
  expect(
    westCeiling.position.y + MOVEMENT.playerHeight,
    'capsule top must stay below the visible bunker roof underside',
  ).toBeLessThanOrEqual(westRoof - roofSlabThickness + 0.055);
  expect(westCeiling.velocity.y, 'ceiling CCD must cancel upward velocity').toBeLessThanOrEqual(0.05);
  expect(westCeiling.ccd.ceilingHits, 'ceiling traversal must exercise the swept roof guard').toBeGreaterThan(0);

  // Probe the southwest launch at mid-rise from the exposed positive-lateral
  // side. A player may ride the top, but cannot pass through its visible skirt.
  const rampStart = { x: -118 * MONSOON_WORLD_SCALE, z: -82 * MONSOON_WORLD_SCALE };
  const rampEnd = { x: -84 * MONSOON_WORLD_SCALE, z: -58 * MONSOON_WORLD_SCALE };
  const dx = rampEnd.x - rampStart.x;
  const dz = rampEnd.z - rampStart.z;
  const length = Math.hypot(dx, dz);
  const along = { x: dx / length, z: dz / length };
  const lateral = { x: along.z, z: -along.x };
  const midpoint = { x: (rampStart.x + rampEnd.x) * 0.5, z: (rampStart.z + rampEnd.z) * 0.5 };
  const outside = {
    x: midpoint.x + lateral.x * 17.2,
    z: midpoint.z + lateral.z * 17.2,
  };
  const outsideFloor = await floorHeight(page, outside.x, outside.z);
  const rampSide = await driveKinematics(
    page,
    { x: outside.x, y: outsideFloor + 0.006, z: outside.z },
    { x: -lateral.x * 48, y: 0, z: -lateral.z * 48 },
    0.08,
  );
  const rampLateral = (rampSide.position.x - rampStart.x) * lateral.x
    + (rampSide.position.z - rampStart.z) * lateral.z;
  report.rampSide = rampSide;
  report.rampLateral = rampLateral;
  expect(rampLateral, 'capsule must remain outside the raised ramp skirt').toBeGreaterThan(14 + MOVEMENT.playerRadius - 0.08);
  expect(
    rampSide.wallContact || rampSide.ccd.wallHits > westWall.ccd.wallHits,
    'ramp skirt must register either analytic or swept wall contact',
  ).toBe(true);

  // The generated terrain has a finite mesh. Keep the capsule on its playable
  // side so no speed/jetpack combination can leave the collision world.
  const halfWidth = MONSOON_DIVIDE.width * 0.5 - MOVEMENT.playerRadius - MOVEMENT.arenaBoundaryInset;
  const edgeFloor = await floorHeight(page, halfWidth - 1.2, 0);
  const boundary = await driveKinematics(
    page,
    // The finite mesh edge is ocean floor below killY. Probe containment in
    // the air so the death/respawn path cannot interrupt the boundary sweep.
    { x: halfWidth - 1.2, y: Math.max(edgeFloor + 0.006, 0), z: 0 },
    { x: 60, y: 0, z: 0 },
    0.08,
  );
  report.boundary = boundary;
  report.halfWidth = halfWidth;
  expect(boundary.position.x, 'player capsule must not leave the finite collision heightfield').toBeLessThanOrEqual(halfWidth + 1e-4);
  expect(boundary.ccd.boundaryHits, 'arena containment must report a deterministic boundary contact').toBeGreaterThan(0);

  await testInfo.attach('collision-integrity-telemetry', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  expect(errors.consoleErrors).toEqual([]);
  expect(errors.pageErrors).toEqual([]);
});

test('capsule feet recover above supporting floors and remain seated while skiing', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  test.setTimeout(240_000);
  const report: Record<string, unknown> = {};

  for (const scenario of [
    { map: 'monsoon' as const, x: -100, z: -60 },
    { map: 'quicksense' as const, x: -122, z: 102 },
  ]) {
    const errors = await openNamedPhysicsMap(page, scenario.map);
    const recovery = await page.evaluate(({ x, z }) => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      const floor = hooks.sampleFloorHeight(x, z, 240);
      if (floor === null) throw new Error(`Missing recovery floor at (${x}, ${z}).`);
      // Model the failure state produced when a steep ramp transition or a
      // lateral wall correction moves the capsule beyond the ordinary ground
      // snap window. Recovery must be immediate; gravity may never continue
      // pulling the player's feet through a known supporting surface.
      hooks.setPlayerKinematics(
        { x, y: floor - 0.65, z },
        { x: 0, y: -5, z: 0 },
      );
      hooks.stepSimulation(0.05);
      const player = window.__THREE_GAME_DIAGNOSTICS__!.player;
      const supportingFloor = hooks.sampleFloorHeight(
        player.position.x,
        player.position.z,
        player.position.y + 1.2,
      );
      return { floor, supportingFloor, player };
    }, scenario);

    report[`${scenario.map}Recovery`] = recovery;
    expect(recovery.supportingFloor, `${scenario.map} recovery must retain a valid supporting floor`).not.toBeNull();
    expect(
      recovery.player.position.y,
      `${scenario.map} player feet must never remain below the recovered floor`,
    ).toBeGreaterThanOrEqual((recovery.supportingFloor ?? 0) - 0.003);
    expect(recovery.player.grounded, `${scenario.map} recovery must restore grounded state`).toBe(true);
    expect(errors.consoleErrors).toEqual([]);
    expect(errors.pageErrors).toEqual([]);
  }

  await page.goto(`/?qa=physics&map=quicksense&mapSeed=${MAP_SEED}`);
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));
  const routeFloor = await floorHeight(page, -122, 102, 240);
  await page.evaluate(({ floor }) => {
    window.__THREE_GAME_TEST_HOOKS__!.setPlayerKinematics(
      { x: -122, y: floor, z: 102 },
      { x: -6.64, y: 0, z: -12.34 },
    );
  }, { floor: routeFloor });
  await page.keyboard.down('ShiftLeft');
  const skiTelemetry = await page.evaluate(({ fixedStep, playerHeight }) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    let minimumFootClearance = Number.POSITIVE_INFINITY;
    let groundedSamples = 0;
    for (let index = 0; index < 180; index += 1) {
      hooks.stepSimulation(fixedStep);
      const player = window.__THREE_GAME_DIAGNOSTICS__!.player;
      const floor = hooks.sampleFloorHeight(
        player.position.x,
        player.position.z,
        player.position.y + playerHeight,
      );
      if (floor !== null) minimumFootClearance = Math.min(minimumFootClearance, player.position.y - floor);
      if (player.grounded) groundedSamples += 1;
    }
    return {
      minimumFootClearance,
      groundedSamples,
      player: window.__THREE_GAME_DIAGNOSTICS__!.player,
    };
  }, { fixedStep: MOVEMENT.fixedStep, playerHeight: MOVEMENT.playerHeight });
  await page.keyboard.up('ShiftLeft');
  report.quicksenseSki = skiTelemetry;
  expect(skiTelemetry.minimumFootClearance, 'skiing feet must stay on or above every sampled floor').toBeGreaterThanOrEqual(-0.003);
  expect(skiTelemetry.groundedSamples, 'the downhill route must retain meaningful ground contact').toBeGreaterThan(90);

  await testInfo.attach('floor-invariant-telemetry', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
});
