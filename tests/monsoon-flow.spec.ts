import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { MONSOON_WORLD_SCALE } from '../src/game/maps/MonsoonDivide';

const MAP_SEED = 450_600;
const FIXED_SAMPLE_SECONDS = 0.16;

type PlayerSample = {
  frame: number;
  state: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  speed: number;
  grounded: boolean;
  skiing: boolean;
  wallContact: boolean;
};

type Vec2 = { x: number; z: number };

function desktopOnly(testInfo: TestInfo): void {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'Deterministic keyboard physics runs once on desktop Chromium.');
}

async function samplePlayer(page: Page): Promise<PlayerSample> {
  return page.evaluate(() => {
    const diagnostics = window.__THREE_GAME_DIAGNOSTICS__;
    if (!diagnostics) throw new Error('Riftline diagnostics are unavailable.');
    return {
      frame: diagnostics.frame,
      state: diagnostics.state,
      x: diagnostics.player.position.x,
      y: diagnostics.player.position.y,
      z: diagnostics.player.position.z,
      vx: diagnostics.player.velocity.x,
      vy: diagnostics.player.velocity.y,
      vz: diagnostics.player.velocity.z,
      speed: diagnostics.player.speed,
      grounded: diagnostics.player.grounded,
      skiing: diagnostics.player.skiing,
      wallContact: diagnostics.player.wallContact,
    };
  });
}

async function openDeterministicMap(page: Page): Promise<{ consoleErrors: string[]; pageErrors: string[] }> {
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
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    if (!hooks) throw new Error('Riftline test hooks are unavailable.');
    hooks.seed(seed);
    hooks.setReducedMotion(true);
    hooks.hideDebugUi(true);
    hooks.setState('movement-flat');
    hooks.setPausedForScreenshot(true);
  }, MAP_SEED);
  return { consoleErrors, pageErrors };
}

async function setAimAlong(page: Page, direction: Vec2): Promise<void> {
  const length = Math.hypot(direction.x, direction.z);
  if (length < 1e-6) throw new Error('Aim direction must be non-zero.');
  const yaw = Math.atan2(-direction.x / length, -direction.z / length);
  await page.evaluate((value) => window.__THREE_GAME_TEST_HOOKS__?.setAim(value, -0.04), yaw);
}

async function floorHeight(page: Page, x: number, z: number, fromY = Number.POSITIVE_INFINITY): Promise<number> {
  const floor = await page.evaluate(({ px, pz, rayY }) => (
    window.__THREE_GAME_TEST_HOOKS__?.sampleFloorHeight(px, pz, rayY) ?? null
  ), { px: x, pz: z, rayY: fromY });
  if (floor === null) throw new Error(`No floor at (${x}, ${z}) from y=${fromY}.`);
  return floor;
}

async function placePlayer(page: Page, x: number, z: number, y: number, direction: Vec2): Promise<PlayerSample> {
  await page.evaluate(({ px, py, pz }) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    if (!hooks) throw new Error('Riftline test hooks are unavailable.');
    hooks.setState('movement-flat');
    hooks.setCombatants(
      { x: px, y: py + 0.012, z: pz },
      { x: 210, y: 80, z: 170 },
      false,
      true,
    );
    hooks.setPausedForScreenshot(true);
    hooks.stepSimulation(0.05);
  }, { px: x, py: y, pz: z });
  await setAimAlong(page, direction);
  return samplePlayer(page);
}

async function fixedSamples(page: Page, count: number, seconds = FIXED_SAMPLE_SECONDS): Promise<PlayerSample[]> {
  const samples: PlayerSample[] = [];
  for (let index = 0; index < count; index += 1) {
    await page.evaluate((step) => window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(step), seconds);
    samples.push(await samplePlayer(page));
  }
  return samples;
}

function normalized(direction: Vec2): Vec2 {
  const length = Math.hypot(direction.x, direction.z);
  return { x: direction.x / length, z: direction.z / length };
}

function projectedDistance(start: PlayerSample, end: PlayerSample, direction: Vec2): number {
  const unit = normalized(direction);
  return (end.x - start.x) * unit.x + (end.z - start.z) * unit.z;
}

function lateralDistance(start: PlayerSample, end: PlayerSample, direction: Vec2): number {
  const unit = normalized(direction);
  return Math.abs((end.x - start.x) * -unit.z + (end.z - start.z) * unit.x);
}

function expectFiniteRunning(samples: PlayerSample[], label: string): void {
  for (const [index, sample] of samples.entries()) {
    expect(sample.state, `${label} sample ${index} must stay in live play`).toBe('running');
    expect(
      [sample.x, sample.y, sample.z, sample.vx, sample.vy, sample.vz, sample.speed].every(Number.isFinite),
      `${label} sample ${index} telemetry must remain finite`,
    ).toBe(true);
  }
}

test('four broad Monsoon ski lanes preserve forward flow without softlock windows', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  test.setTimeout(120_000);
  const errors = await openDeterministicMap(page);
  const routes = [
    { name: 'northwest descent', start: { x: -148 * MONSOON_WORLD_SCALE, z: 76 * MONSOON_WORLD_SCALE }, end: { x: -119 * MONSOON_WORLD_SCALE, z: 58 * MONSOON_WORLD_SCALE } },
    { name: 'northeast descent', start: { x: 150 * MONSOON_WORLD_SCALE, z: 65 * MONSOON_WORLD_SCALE }, end: { x: 88 * MONSOON_WORLD_SCALE, z: 42 * MONSOON_WORLD_SCALE } },
    { name: 'southwest descent', start: { x: -150 * MONSOON_WORLD_SCALE, z: -100 * MONSOON_WORLD_SCALE }, end: { x: -78 * MONSOON_WORLD_SCALE, z: -58 * MONSOON_WORLD_SCALE } },
    { name: 'southeast descent', start: { x: 150 * MONSOON_WORLD_SCALE, z: -108 * MONSOON_WORLD_SCALE }, end: { x: 76 * MONSOON_WORLD_SCALE, z: -61 * MONSOON_WORLD_SCALE } },
  ];
  const report: Array<Record<string, number | string>> = [];

  for (const route of routes) {
    const direction = { x: route.end.x - route.start.x, z: route.end.z - route.start.z };
    const floor = await floorHeight(page, route.start.x, route.start.z);
    const start = await placePlayer(page, route.start.x, route.start.z, floor, direction);
    await page.keyboard.down('KeyW');
    // Enter ski mode with race momentum. Holding ski from a dead stop is not
    // the core verb and would mostly measure low-friction launch behavior.
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(0.55));
    await page.keyboard.down('ShiftLeft');
    const samples = await fixedSamples(page, 14);
    await page.keyboard.up('ShiftLeft');
    await page.keyboard.up('KeyW');

    const all = [start, ...samples];
    const forward = projectedDistance(start, samples.at(-1)!, direction);
    const lateral = lateralDistance(start, samples.at(-1)!, direction);
    let pinnedWindows = 0;
    let worstSpeedRetention = 1;
    for (let index = 1; index < all.length; index += 1) {
      const progress = projectedDistance(all[index - 1], all[index], direction);
      if (progress < 0.08 && all[index].frame > all[index - 1].frame) pinnedWindows += 1;
      if (all[index - 1].speed > 5) {
        worstSpeedRetention = Math.min(worstSpeedRetention, all[index].speed / all[index - 1].speed);
      }
    }

    report.push({ route: route.name, forward, lateral, pinnedWindows, worstSpeedRetention });
    await testInfo.attach(`route-${route.name.replaceAll(' ', '-')}`, {
      body: JSON.stringify({ start, samples, forward, lateral, pinnedWindows, worstSpeedRetention }, null, 2),
      contentType: 'application/json',
    });
    expectFiniteRunning(all, route.name);
    expect(samples.every((sample) => sample.skiing), `${route.name} must keep ski input engaged`).toBe(true);
    expect(forward, `${route.name} needs an uninterrupted race-width line`).toBeGreaterThan(25);
    expect(lateral, `${route.name} should not be pinched into forced lateral detours`).toBeLessThan(12);
    expect(pinnedWindows, `${route.name} must not produce repeated no-progress windows`).toBeLessThanOrEqual(1);
    expect(worstSpeedRetention, `${route.name} must not abruptly delete ski momentum`).toBeGreaterThan(0.58);
  }

  await testInfo.attach('monsoon-route-flow', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  expect(errors.consoleErrors, 'route run console errors').toEqual([]);
  expect(errors.pageErrors, 'route run page errors').toEqual([]);
});

test('downhill skiing retains speed continuously instead of snagging on terrain seams', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  test.setTimeout(90_000);
  const errors = await openDeterministicMap(page);
  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('movement-slope');
    hooks.setPausedForScreenshot(true);
  });
  const start = await samplePlayer(page);
  await page.keyboard.down('ShiftLeft');
  const samples = await fixedSamples(page, 24, 0.12);
  await page.keyboard.up('ShiftLeft');
  const all = [start, ...samples];
  let minimumRetention = 1;
  let noMotionWindows = 0;
  for (let index = 1; index < all.length; index += 1) {
    const moved = Math.hypot(all[index].x - all[index - 1].x, all[index].z - all[index - 1].z);
    if (moved < 0.08) noMotionWindows += 1;
    if (all[index - 1].speed > 8) {
      minimumRetention = Math.min(minimumRetention, all[index].speed / all[index - 1].speed);
    }
  }
  const distance = all.slice(1).reduce((total, current, index) => (
    total + Math.hypot(current.x - all[index].x, current.z - all[index].z)
  ), 0);

  await testInfo.attach('downhill-ski-telemetry', {
    body: JSON.stringify({ start, samples, distance, minimumRetention, noMotionWindows }, null, 2),
    contentType: 'application/json',
  });
  expectFiniteRunning(all, 'movement-slope');
  expect(samples.every((sample) => sample.skiing), 'ski state must remain active through the full descent').toBe(true);
  expect(Math.max(...samples.map((sample) => sample.speed)), 'slope gravity must build race speed').toBeGreaterThan(15.2);
  expect(minimumRetention, 'terrain seams must not erase more than 38% of speed in one fixed window').toBeGreaterThan(0.62);
  expect(distance, 'the downhill state must cover meaningful map distance').toBeGreaterThan(28);
  expect(noMotionWindows, 'downhill traversal must not pin the capsule').toBe(0);
  expect(errors.consoleErrors).toEqual([]);
  expect(errors.pageErrors).toEqual([]);
});

test('southwest concrete launch ramp is traversable at race speed and produces airtime', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  test.setTimeout(90_000);
  const errors = await openDeterministicMap(page);
  const rampStart = { x: -118 * MONSOON_WORLD_SCALE, z: -82 * MONSOON_WORLD_SCALE };
  const endPoint = { x: -84 * MONSOON_WORLD_SCALE, z: -58 * MONSOON_WORLD_SCALE };
  const direction = { x: endPoint.x - rampStart.x, z: endPoint.z - rampStart.z };
  const unit = normalized(direction);
  // The jump is intentionally not reachable from a short flat sprint. Start
  // from the authored shoulder and bank the downhill energy the route promises.
  const startPoint = { x: -150 * MONSOON_WORLD_SCALE, z: -100 * MONSOON_WORLD_SCALE };
  const rampLength = Math.hypot(direction.x, direction.z);
  const runupDistance = (
    (rampStart.x - startPoint.x) * unit.x
    + (rampStart.z - startPoint.z) * unit.z
  );
  const rampFloor = await floorHeight(page, rampStart.x, rampStart.z);
  const floor = await floorHeight(page, startPoint.x, startPoint.z);
  const start = await placePlayer(page, startPoint.x, startPoint.z, floor, direction);

  await page.keyboard.down('KeyW');
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(0.45));
  await page.keyboard.down('ShiftLeft');
  const samples = await fixedSamples(page, 52, 0.1);
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');

  const progress = samples.map((sample) => projectedDistance(start, sample, direction));
  const lipDistance = rampLength + runupDistance;
  const crossedLip = samples.findIndex((sample, index) => progress[index] > lipDistance + 0.8 && !sample.grounded);
  const airborneAfterLip = samples.filter((sample, index) => progress[index] > lipDistance - 0.4 && !sample.grounded).length;
  const peakRampRise = Math.max(...samples
    .filter((_, index) => progress[index] > runupDistance && progress[index] < lipDistance + 2)
    .map((sample) => sample.y)) - rampFloor;
  const entrySpeed = Math.max(...samples
    .filter((_, index) => progress[index] > runupDistance - 3 && progress[index] < runupDistance + 1)
    .map((sample) => sample.speed));
  const raceSpeedOnRamp = samples
    .filter((_, index) => (
      progress[index] > runupDistance + rampLength * 0.25
      && progress[index] < runupDistance + rampLength * 0.95
    ))
    .map((sample) => sample.speed);

  expectFiniteRunning([start, ...samples], 'southwest launch');
  await testInfo.attach('southwest-launch-telemetry', {
    body: JSON.stringify({
      start,
      samples,
      progress,
      runupDistance,
      rampLength,
      lipDistance,
      entrySpeed,
      crossedLip,
      airborneAfterLip,
      peakRampRise,
    }, null, 2),
    contentType: 'application/json',
  });
  expect(entrySpeed, 'terrain velocity must cross 70 km/h before the jump').toBeGreaterThan(70 / 3.6);
  expect(progress.at(-1)!, 'the route must carry through and beyond the ramp lip').toBeGreaterThan(lipDistance + 3);
  expect(peakRampRise, 'the controller must climb the authored ramp rise').toBeGreaterThan(14.4);
  expect(crossedLip, 'the raised lip must launch the player, not end in a sticky step').toBeGreaterThanOrEqual(0);
  expect(airborneAfterLip, 'the launch must produce readable multi-sample airtime').toBeGreaterThanOrEqual(2);
  expect(Math.min(...raceSpeedOnRamp), 'ski speed must survive the concrete transition').toBeGreaterThan(10);
  expect(errors.consoleErrors).toEqual([]);
  expect(errors.pageErrors).toEqual([]);
});

test('enterable bunker walls contain dash-speed movement and release cleanly', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  test.setTimeout(90_000);
  const errors = await openDeterministicMap(page);
  // z=116 stays inside the bunker while clearing the roof service cabin and
  // parapets added by the structural-detail pass.
  const interior = { x: -138 * MONSOON_WORLD_SCALE, z: 116 * MONSOON_WORLD_SCALE };
  const roof = await floorHeight(page, interior.x, interior.z);
  const buildingFloor = await floorHeight(page, interior.x, interior.z, roof - 0.9);
  const start = await placePlayer(page, interior.x, interior.z, buildingFloor, { x: -1, z: 0 });
  const wallOccludes = await page.evaluate(({ inside, outside, eyeY }) => (
    window.__THREE_GAME_TEST_HOOKS__?.sampleLineOfSight(
      { x: inside.x, y: eyeY, z: inside.z },
      { x: outside.x, y: eyeY, z: outside.z },
    ) ?? true
  ), { inside: interior, outside: { x: -151 * MONSOON_WORLD_SCALE, z: 111 * MONSOON_WORLD_SCALE }, eyeY: buildingFloor + 1.4 });

  await page.keyboard.down('KeyW');
  await page.keyboard.press('KeyE');
  const impactSamples = await fixedSamples(page, 12, 0.12);
  await page.keyboard.up('KeyW');
  const minimumX = Math.min(...impactSamples.map((sample) => sample.x));
  expectFiniteRunning([start, ...impactSamples], 'west bunker wall impact');
  expect(wallOccludes, 'the authored bunker back wall must exist in the static collision BVH').toBe(false);
  expect(minimumX, 'capsule center must remain inside the west bunker back wall').toBeGreaterThan(-287.64);

  await setAimAlong(page, { x: 1, z: 0 });
  const blocked = await samplePlayer(page);
  await page.keyboard.down('KeyW');
  const releaseSamples = await fixedSamples(page, 8, 0.12);
  await page.keyboard.up('KeyW');
  const released = releaseSamples.at(-1)!;
  expect(released.x - blocked.x, 'turning away from a wall must immediately recover movement').toBeGreaterThan(5);
  expect(releaseSamples.filter((sample) => sample.wallContact).length, 'wall state must clear after leaving contact').toBeLessThan(4);
  expect(errors.consoleErrors).toEqual([]);
  expect(errors.pageErrors).toEqual([]);
});

test('deterministic rock collider probes prevent tunneling', async () => {
  test.skip(
    true,
    'Required hook API: getStaticColliderProbes(): Array<{ id: string; kind: "rock" | "structure"; aabb: { min: {x,y,z}; max: {x,y,z} }; approach: { position: {x,y,z}; direction: {x,y,z} } }>. Current hooks expose no stable rock identity or bounds, so a strict rock-tunneling assertion would depend on private procedural coordinates.',
  );
});
