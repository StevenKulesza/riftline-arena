import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { MONSOON_DIVIDE } from '../src/game/maps/MonsoonDivide';
import { QUICKSENSE } from '../src/game/maps/QuickSenseArena';

const MAP_SEED = 450_600;

function desktopOnly(testInfo: TestInfo): void {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'Cover and LOS QA runs once on desktop Chromium.');
}

async function openMap(
  page: Page,
  map: 'monsoon' | 'quicksense',
): Promise<void> {
  const mapQuery = map === 'quicksense' ? '&map=quicksense' : '';
  page.once('pageerror', (error) => {
    console.log(`pageerror:${error.message}`);
  });
  await page.goto(`/?qa=physics&mapSeed=${MAP_SEED}${mapQuery}`, { timeout: 90_000 });
  await page.waitForFunction(() => (
    Boolean(window.__THREE_GAME_TEST_HOOKS__)
    && Boolean(window.__THREE_GAME_DIAGNOSTICS__?.map.ready)
  ), null, { timeout: 180_000 });
  await page.evaluate((seed) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.seed(seed);
    hooks.setReducedMotion(true);
    hooks.hideDebugUi(true);
    hooks.setPausedForScreenshot(true);
  }, MAP_SEED);
}

test('Monsoon spawn pairs break long rail sightlines behind cover', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  test.setTimeout(240_000);
  await openMap(page, 'monsoon');
  const result = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const spawns = hooks.getSpawnPoints();
    let blocked = 0;
    const pairCount = spawns.length * (spawns.length - 1) / 2;
    for (let first = 0; first < spawns.length; first += 1) {
      for (let second = first + 1; second < spawns.length; second += 1) {
        const clear = hooks.sampleLineOfSight(
          { x: spawns[first].x, y: spawns[first].y + 1.5, z: spawns[first].z },
          { x: spawns[second].x, y: spawns[second].y + 1.5, z: spawns[second].z },
        );
        if (!clear) blocked += 1;
      }
    }
    return { spawnCount: spawns.length, pairCount, blocked };
  });
  expect(result.spawnCount).toBe(15);
  expect(result.pairCount).toBe(105);
  expect(result.blocked, 'at least 8 of C(15,2) spawn pairs must lack eye-height LOS').toBeGreaterThanOrEqual(8);
  const shelf = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const spawns = hooks.getSpawnPoints();
    const west = spawns[4];
    const east = spawns[5];
    return {
      span: Math.hypot(east.x - west.x, east.z - west.z),
      clear: hooks.sampleLineOfSight(
        { x: west.x, y: west.y + 1.5, z: west.z },
        { x: east.x, y: east.y + 1.5, z: east.z },
      ),
    };
  });
  expect(shelf.span, 'west-ridge → east-ridge spawn pair is still the long shelf').toBeGreaterThan(560);
  expect(shelf.clear, 'eye-height LOS along spawn (−158, 90) → (153, 79) must hit cover').toBe(false);
  const eastSlope = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const spawns = hooks.getSpawnPoints();
    const west = spawns[4];
    const east = spawns[7];
    const skiLinePad = spawns.find((spawn) => Math.hypot(spawn.x - 250, spawn.z - (-208)) < 24);
    return {
      span: Math.hypot(east.x - west.x, east.z - west.z),
      eastX: east.x,
      eastZ: east.z,
      skiLinePad: skiLinePad ? { x: skiLinePad.x, z: skiLinePad.z } : null,
      clear: hooks.sampleLineOfSight(
        { x: west.x, y: west.y + 1.5, z: west.z },
        { x: east.x, y: east.y + 1.5, z: east.z },
      ),
    };
  });
  expect(eastSlope.skiLinePad, 'SE spawn must sit off ski corridor 1, not at (125, −104)').toBeNull();
  expect(eastSlope.span, 'west-ridge → east-slope spawn pair is still a long chord').toBeGreaterThan(560);
  expect(eastSlope.clear, 'eye-height LOS along spawn (−158, 90) → (160, −40) must hit terrain').toBe(false);
  const corridorTwo = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const spawns = hooks.getSpawnPoints();
    const northEast = spawns[5];
    const southWest = spawns[6];
    return {
      span: Math.hypot(southWest.x - northEast.x, southWest.z - northEast.z),
      clear: hooks.sampleLineOfSight(
        { x: northEast.x, y: northEast.y + 1.5, z: northEast.z },
        { x: southWest.x, y: southWest.y + 1.5, z: southWest.z },
      ),
    };
  });
  expect(corridorTwo.span, 'NE-ridge → SW-ridge spawn pair is still the long corridor-2 rail').toBeGreaterThan(600);
  expect(corridorTwo.clear, 'eye-height LOS along spawn (153, 79) → (−130, −101) must hit the in-lane nunatak').toBe(false);
  const northRim = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const spawns = hooks.getSpawnPoints();
    const north = spawns[9];
    const southWest = spawns[6];
    return {
      span: Math.hypot(southWest.x - north.x, southWest.z - north.z),
      clear: hooks.sampleLineOfSight(
        { x: north.x, y: north.y + 1.5, z: north.z },
        { x: southWest.x, y: southWest.y + 1.5, z: southWest.z },
      ),
    };
  });
  expect(northRim.span, 'north-rim → SW-ridge spawn pair is still the long rail').toBeGreaterThan(560);
  expect(northRim.clear, 'eye-height LOS along spawn (75, 130) → (−130, −101) must hit the north-rim cubby').toBe(false);
  const innerWest = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const spawns = hooks.getSpawnPoints();
    const northEast = spawns[5];
    const inner = spawns[14];
    const start = { x: northEast.x, y: northEast.y + 1.5, z: northEast.z };
    const end = { x: inner.x, y: inner.y + 1.5, z: inner.z };
    return {
      span: Math.hypot(inner.x - northEast.x, inner.z - northEast.z),
      clear: hooks.sampleLineOfSight(start, end),
    };
  });
  expect(innerWest.span, 'NE-ridge → inner-west spawn pair is still the long rail').toBeGreaterThan(500);
  expect(innerWest.clear, 'eye-height LOS along spawn (153, 79) → (−109, −22) must hit the inner-west cubby').toBe(false);
  const innerEast = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const spawns = hooks.getSpawnPoints();
    const inner = spawns[1];
    const southWest = spawns[6];
    const onGradePad = spawns.find((spawn) => Math.hypot(spawn.x - 178, spawn.z - 110) < 24);
    return {
      span: Math.hypot(inner.x - southWest.x, inner.z - southWest.z),
      innerX: inner.x,
      innerZ: inner.z,
      onGradePad: onGradePad ? { x: onGradePad.x, z: onGradePad.z } : null,
      clear: hooks.sampleLineOfSight(
        { x: inner.x, y: inner.y + 1.5, z: inner.z },
        { x: southWest.x, y: southWest.y + 1.5, z: southWest.z },
      ),
    };
  });
  expect(innerEast.onGradePad, 'inner-east spawn must sit off ski corridor 2, not at (89, 55)').toBeNull();
  expect(innerEast.span, 'inner-east → SW-ridge spawn pair is still the long rail').toBeGreaterThan(500);
  expect(innerEast.clear, 'eye-height LOS along spawn (89, 68) → (−130, −101) must hit the inner-east cubby').toBe(false);
  const innerSouth = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const spawns = hooks.getSpawnPoints();
    const south = spawns[3];
    const westRidge = spawns[4];
    return {
      span: Math.hypot(westRidge.x - south.x, westRidge.z - south.z),
      clear: hooks.sampleLineOfSight(
        { x: south.x, y: south.y + 1.5, z: south.z },
        { x: westRidge.x, y: westRidge.y + 1.5, z: westRidge.z },
      ),
    };
  });
  expect(innerSouth.span, 'inner-south → west-ridge spawn pair is still the long rail').toBeGreaterThan(500);
  expect(innerSouth.clear, 'eye-height LOS along spawn (51, −73) → (−158, 90) must hit the inner-south cubby').toBe(false);
  const northwest = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const spawns = hooks.getSpawnPoints();
    const west = spawns[0];
    const east = spawns[5];
    return {
      span: Math.hypot(east.x - west.x, east.z - west.z),
      clear: hooks.sampleLineOfSight(
        { x: west.x, y: west.y + 1.5, z: west.z },
        { x: east.x, y: east.y + 1.5, z: east.z },
      ),
    };
  });
  expect(northwest.span, 'northwest → east-ridge spawn pair is still the long rail').toBeGreaterThan(500);
  expect(northwest.clear, 'eye-height LOS along spawn (−99, 64) → (153, 79) must hit the northwest cubby').toBe(false);
  const innerEastRidge = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const spawns = hooks.getSpawnPoints();
    const inner = spawns[1];
    const westRidge = spawns[4];
    return {
      span: Math.hypot(westRidge.x - inner.x, westRidge.z - inner.z),
      clear: hooks.sampleLineOfSight(
        { x: inner.x, y: inner.y + 1.5, z: inner.z },
        { x: westRidge.x, y: westRidge.y + 1.5, z: westRidge.z },
      ),
    };
  });
  expect(innerEastRidge.span, 'inner-east → west-ridge spawn pair is still the long rail').toBeGreaterThan(480);
  expect(innerEastRidge.clear, 'eye-height LOS along spawn (89, 68) → (−158, 90) must hit the inner-east ridge cubby').toBe(false);
  const bunkers = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.getSpawnCubbyBunkerAudit());
  expect(bunkers?.count).toBe(6);
  expect(bunkers?.hullInstances).toBe(6);
  expect(bunkers?.trimInstances ?? 0).toBeGreaterThan(40);
  expect(bunkers?.signalInstances ?? 0).toBeGreaterThan(12);
  expect(bunkers?.names).toEqual(expect.arrayContaining([
    'spawn-north-east-cubby',
    'spawn-inner-west-cubby',
    'spawn-inner-east-cubby',
    'spawn-inner-east-ridge-cubby',
    'spawn-inner-south-cubby',
    'spawn-northwest-cubby',
  ]));
});

test('Monsoon pickups have hard cover within 8 m', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  test.setTimeout(240_000);
  await openMap(page, 'monsoon');
  const uncovered = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const pickups = window.__THREE_GAME_DIAGNOSTICS__!.pickups;
    const cardinals: Array<{ x: number; z: number }> = [
      { x: 8, z: 0 },
      { x: -8, z: 0 },
      { x: 0, z: 8 },
      { x: 0, z: -8 },
    ];
    return pickups.filter((pickup) => {
      const floor = hooks.sampleFloorHeight(pickup.position.x, pickup.position.z, Number.POSITIVE_INFINITY);
      if (floor === null) return true;
      const origin = { x: pickup.position.x, y: floor + 1.0, z: pickup.position.z };
      return !cardinals.some((offset) => {
        const hit = hooks.sampleMovementHit(origin, {
          x: origin.x + offset.x,
          y: origin.y,
          z: origin.z + offset.z,
        });
        if (!hit) return false;
        const horizontal = Math.hypot(hit.point.x - origin.x, hit.point.z - origin.z);
        return horizontal <= 8 && hit.normal.y < 0.45;
      });
    }).map((pickup) => pickup.kind);
  });
  expect(uncovered, 'every ITEM position needs a wall/cover hit within 8 m at height 1.0').toEqual([]);
});

test('Monsoon rocket-to-sniper and rail-to-sniper chords are blocked at eye height', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  test.setTimeout(240_000);
  await openMap(page, 'monsoon');
  const result = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const pickups = window.__THREE_GAME_DIAGNOSTICS__!.pickups;
    const eye = (pickup: { position: { x: number; y: number; z: number } }) => {
      // Highest surface at the pad (weather-station roof/cabin included). A
      // stand-height sample would miss the 297 m rail chord over those roofs.
      const floor = hooks.sampleFloorHeight(pickup.position.x, pickup.position.z, Number.POSITIVE_INFINITY)
        ?? pickup.position.y;
      return { x: pickup.position.x, y: floor + 1.5, z: pickup.position.z };
    };
    const rocket = pickups.find((pickup) => pickup.kind === 'rocket');
    const rail = pickups.find((pickup) => pickup.kind === 'rail');
    const sniper = pickups.find((pickup) => pickup.kind === 'sniper');
    if (!rocket || !rail || !sniper) return { missing: true, rocketClear: true, railClear: true, rocketSpan: 0, railSpan: 0 };
    return {
      missing: false,
      rocketClear: hooks.sampleLineOfSight(eye(rocket), eye(sniper)),
      railClear: hooks.sampleLineOfSight(eye(rail), eye(sniper)),
      rocketSpan: Math.hypot(sniper.position.x - rocket.position.x, sniper.position.z - rocket.position.z),
      railSpan: Math.hypot(sniper.position.x - rail.position.x, sniper.position.z - rail.position.z),
    };
  });
  expect(result.missing, 'rocket, rail, and sniper pickups must exist').toBe(false);
  expect(result.rocketSpan, 'the authored rocket chord is still the long diagonal').toBeGreaterThan(600);
  expect(result.railSpan, 'the authored rail chord is still the long east-west').toBeGreaterThan(560);
  expect(result.rocketClear, 'eye-height LOS along rocket → sniper must hit cover').toBe(false);
  expect(result.railClear, 'eye-height LOS along rail → sniper must hit cover').toBe(false);
});

test('QuickSense spawns sit above killY with broken spawn-to-spawn lanes', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  test.setTimeout(240_000);
  await openMap(page, 'quicksense');
  const result = await page.evaluate((killY) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const spawns = hooks.getSpawnPoints();
    let blocked = 0;
    for (let first = 0; first < spawns.length; first += 1) {
      for (let second = first + 1; second < spawns.length; second += 1) {
        const clear = hooks.sampleLineOfSight(
          { x: spawns[first].x, y: spawns[first].y + 1.5, z: spawns[first].z },
          { x: spawns[second].x, y: spawns[second].y + 1.5, z: spawns[second].z },
        );
        if (!clear) blocked += 1;
      }
    }
    const pickups = window.__THREE_GAME_DIAGNOSTICS__!.pickups;
    const health = pickups.filter((pickup) => pickup.kind === 'health');
    const rail = pickups.find((pickup) => pickup.kind === 'rail');
    return {
      spawnCount: spawns.length,
      blocked,
      lowestY: Math.min(...spawns.map((spawn) => spawn.y)),
      highestY: Math.max(...spawns.map((spawn) => spawn.y)),
      healthHeights: health.map((pickup) => pickup.position.y),
      railY: rail?.position.y ?? Number.NaN,
      killY,
    };
  }, QUICKSENSE.killY);
  expect(result.spawnCount).toBeGreaterThanOrEqual(8);
  expect(result.lowestY).toBeGreaterThan(QUICKSENSE.killY + 1);
  expect(result.highestY, 'spawns must stay on the basin layer, not floating-station roofs').toBeLessThan(140);
  expect(result.blocked, 'at least 4 QuickSense spawn pairs must lack LOS').toBeGreaterThanOrEqual(4);
  expect(result.railY, 'rail must sit on the north road, not the Command Ark roof').toBeLessThan(140);
  expect(Math.max(...result.healthHeights) - Math.min(...result.healthHeights), 'mirrored health packs must share a playable height band').toBeLessThan(24);
  const westRail = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const spawns = hooks.getSpawnPoints();
    const west = spawns.reduce((best, spawn) => (
      Math.hypot(spawn.x - (-288), spawn.z - 10) < Math.hypot(best.x - (-288), best.z - 10) ? spawn : best
    ));
    const southEast = spawns.reduce((best, spawn) => (
      Math.hypot(spawn.x - 178, spawn.z - (-202)) < Math.hypot(best.x - 178, best.z - (-202)) ? spawn : best
    ));
    return {
      span: Math.hypot(southEast.x - west.x, southEast.z - west.z),
      clear: hooks.sampleLineOfSight(
        { x: west.x, y: west.y + 1.5, z: west.z },
        { x: southEast.x, y: southEast.y + 1.5, z: southEast.z },
      ),
    };
  });
  expect(westRail.span, 'west → southeast spawn pair is still the long 256 m rail').toBeGreaterThan(250);
  expect(westRail.clear, 'eye-height LOS along spawn (−144, 5) → (89, −101) must hit the west-pad cubby').toBe(false);
  const bunkers = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.getSpawnCubbyBunkerAudit());
  expect(bunkers?.count, 'west pad plus tower cubby when the outpost is present').toBeGreaterThanOrEqual(1);
  expect(bunkers?.trimInstances ?? 0).toBeGreaterThan(6);
  expect(bunkers?.signalInstances ?? 0).toBeGreaterThan(2);
  expect(bunkers?.names.some((name) => name.includes('west spawn'))).toBe(true);
});

test('jump pads launch from a 0.05 s kinematic step on both maps', async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  test.setTimeout(300_000);
  const maps: Array<{ id: 'monsoon' | 'quicksense'; killY: number }> = [
    { id: 'quicksense', killY: QUICKSENSE.killY },
    { id: 'monsoon', killY: MONSOON_DIVIDE.killY },
  ];

  for (const map of maps) {
    await openMap(page, map.id);
    const samples = await page.evaluate(() => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      const pads = hooks.getJumpPads();
      return pads.map((pad) => {
        hooks.setPlayerKinematics(
          { x: pad.x, y: pad.y + 0.16, z: pad.z },
          { x: 0, y: 0, z: 0 },
        );
        hooks.stepSimulation(0.05);
        const player = window.__THREE_GAME_DIAGNOSTICS__!.player;
        return { x: pad.x, y: player.position.y, z: pad.z, vy: player.velocity.y };
      });
    });
    expect(samples.length, `${map.id} must expose live jump pads`).toBeGreaterThan(0);
    for (const sample of samples) {
      expect(
        sample.y,
        `${map.id} pad (${sample.x.toFixed(1)}, ${sample.z.toFixed(1)}) must stay above killY`,
      ).toBeGreaterThan(map.killY + 1);
      expect(
        sample.vy,
        `${map.id} pad (${sample.x.toFixed(1)}, ${sample.z.toFixed(1)}) must launch`,
      ).toBeGreaterThan(2);
    }
  }
});
