import * as THREE from 'three';
import { expect, test } from '@playwright/test';
import {
  MONSOON_DIVIDE,
  MONSOON_OUTER_LOOP_SAMPLES,
  MONSOON_WORLD_SCALE,
} from '../src/game/maps/MonsoonDivide';
import {
  MONSOON_OUTPOST_TOWERS_LICENSE,
  MONSOON_OUTPOST_TOWERS_SOURCE,
  buildMonsoonOutpostTowers,
} from '../src/game/maps/MonsoonOutpostTowers';

function fingerprint(geometry: THREE.BufferGeometry): string {
  const positions = geometry.getAttribute('position');
  let hash = 0x811c9dc5;
  for (let index = 0; index < positions.count; index += 1) {
    for (const value of [positions.getX(index), positions.getY(index), positions.getZ(index)]) {
      hash ^= Math.round(value * 1_000);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return `${positions.count}:${hash.toString(16).padStart(8, '0')}`;
}

function dispose(build: ReturnType<typeof buildMonsoonOutpostTowers>): void {
  build.geometries.forEach((geometry) => geometry.dispose());
  build.materials.forEach((material) => material.dispose());
  build.textures.forEach((texture) => texture.dispose());
}

function distanceToOuterLoop(x: number, z: number): number {
  return Math.min(...MONSOON_OUTER_LOOP_SAMPLES.map(([loopX, loopZ]) => (
    Math.hypot(x - loopX * MONSOON_WORLD_SCALE, z - loopZ * MONSOON_WORLD_SCALE)
  )));
}

test('Monsoon outposts are deterministic, original, collision-ready, and budget bounded', () => {
  const first = buildMonsoonOutpostTowers(MONSOON_DIVIDE.seed);
  const repeated = buildMonsoonOutpostTowers(MONSOON_DIVIDE.seed);
  try {
    expect(first.diagnostics.source).toBe(MONSOON_OUTPOST_TOWERS_SOURCE);
    expect(first.diagnostics.license).toBe(MONSOON_OUTPOST_TOWERS_LICENSE);
    expect(first.diagnostics.assetStrategy).toBe('deterministic-project-original-procedural-kit');
    expect(first.diagnostics.deterministic).toBe(true);
    expect(first.diagnostics.collisionReady).toBe(true);
    expect(first.group.userData.projectOriginal).toBe(true);
    expect(first.diagnostics.towerCount).toBe(2);
    expect(new Set(first.diagnostics.towerNames).size).toBe(2);
    expect(first.diagnostics.visibleMeshCount).toBeLessThanOrEqual(8);
    expect(first.diagnostics.expectedVisibleDrawCalls).toBeLessThanOrEqual(8);
    expect(first.diagnostics.expectedShadowDrawCalls).toBeGreaterThanOrEqual(2);
    expect(first.diagnostics.expectedShadowDrawCalls).toBeLessThanOrEqual(4);
    expect(first.diagnostics.estimatedVisibleTriangles).toBeGreaterThan(20_000);
    expect(first.diagnostics.estimatedVisibleTriangles).toBeLessThanOrEqual(120_000);
    expect(first.diagnostics.colliderBoxCount).toBe(first.colliderBoxes.length);
    expect(first.diagnostics.platformSurfaceCount).toBe(first.platformSurfaces.length);
    expect(first.diagnostics.stairRampCount).toBe(first.stairRamps.length);
    expect(first.diagnostics).toEqual(repeated.diagnostics);
    expect(first.geometries.map(fingerprint)).toEqual(repeated.geometries.map(fingerprint));
    expect(first.colliderBoxes.map(({ name, box }) => [name, ...box.min.toArray(), ...box.max.toArray()])).toEqual(
      repeated.colliderBoxes.map(({ name, box }) => [name, ...box.min.toArray(), ...box.max.toArray()]),
    );
  } finally {
    dispose(first);
    dispose(repeated);
  }
});

test('both monumental towers retain player-scale doors, switchbacks, landings, and roof exits', () => {
  const build = buildMonsoonOutpostTowers(450_600);
  try {
    expect(build.reviewViews).toHaveLength(2);
    expect(build.stairRamps.length).toBeGreaterThanOrEqual(76);
    expect(build.diagnostics.minimumCenterDistance).toBeGreaterThan(1_200);
    expect(build.diagnostics.minimumKnownRelayClearance).toBeGreaterThan(350);

    for (const tower of build.diagnostics.towers) {
      expect(tower.architecturalHeight).toBeGreaterThanOrEqual(175);
      expect(tower.architecturalHeight).toBeLessThanOrEqual(190);
      expect(tower.footprint.width).toBeGreaterThanOrEqual(120);
      expect(tower.footprint.width).toBeLessThanOrEqual(150);
      expect(tower.footprint.depth).toBeGreaterThanOrEqual(120);
      expect(tower.footprint.depth).toBeLessThanOrEqual(150);
      expect(tower.doorwayWidth).toBeGreaterThanOrEqual(10);
      expect(tower.doorwayHeight).toBeGreaterThanOrEqual(8);
      expect(tower.stairWidth).toBeGreaterThanOrEqual(3.4);
      expect(tower.stairWidth).toBeLessThanOrEqual(3.8);
      expect(tower.stairFlightCount).toBe(32);
      expect(tower.intermediateLandingCount).toBe(31);

      const flights = build.stairRamps.filter(({ name }) => (
        name.startsWith(`${tower.name} internal switchback flight`)
      ));
      const entrance = build.stairRamps.find(({ name }) => (
        name === `${tower.name} terrain-to-ground entrance ramp`
      ));
      expect(flights).toHaveLength(tower.stairFlightCount);
      expect(entrance).toBeTruthy();
      expect(entrance!.spec.width).toBeGreaterThanOrEqual(tower.doorwayWidth);
      expect(entrance!.spec.rise).toBeGreaterThanOrEqual(0);
      expect(Math.abs(entrance!.spec.rise) / entrance!.spec.length, 'ground approach stays comfortably walkable').toBeLessThanOrEqual(0.35);

      flights.forEach(({ spec }, index) => {
        expect(spec.width).toBe(tower.stairWidth);
        expect(spec.rise / 13, 'step risers stay below 0.42 m').toBeLessThanOrEqual(0.42);
        expect(spec.length / 13, 'step treads stay at least 0.98 m deep').toBeGreaterThanOrEqual(0.98);
        expect(spec.origin.y).toBeCloseTo(tower.center.y + index * spec.rise, 5);
        if (index > 0) expect(Math.abs(spec.heading - flights[index - 1].spec.heading)).toBeCloseTo(Math.PI, 5);
      });
      const roofExitY = flights.at(-1)!.spec.origin.y + flights.at(-1)!.spec.rise;
      expect(roofExitY).toBeCloseTo(tower.center.y + tower.roofHeight, 5);
      expect(build.platformSurfaces.some(({ name, y }) => (
        name.startsWith(`${tower.name} roof overlook`) && Math.abs(y - roofExitY) < 1e-5
      ))).toBe(true);
      expect(build.platformSurfaces.some(({ name }) => name === `${tower.name} central capture plaza`)).toBe(true);
      expect(build.platformSurfaces.some(({ name }) => name === `${tower.name} protected west spawn apron`)).toBe(true);
      expect(build.platformSurfaces.some(({ name }) => name === `${tower.name} protected east spawn apron`)).toBe(true);
      expect(build.platformSurfaces.some(({ name }) => name === `${tower.name} flag capture plinth`)).toBe(true);

      const halfWidth = MONSOON_DIVIDE.width * 0.5;
      const halfDepth = MONSOON_DIVIDE.depth * 0.5;
      expect(Math.abs(tower.center.x) + tower.footprint.width * 0.5).toBeLessThan(halfWidth);
      expect(Math.abs(tower.center.z) + tower.footprint.depth * 0.5).toBeLessThan(halfDepth);

      const outerLoopClearance = distanceToOuterLoop(tower.center.x, tower.center.z);
      expect(outerLoopClearance, 'tower remains visible and reachable from the outer traversal loop').toBeLessThan(120);
      expect(outerLoopClearance, 'tower leaves a player-scale shoulder beside the high-speed outer traversal line').toBeGreaterThan(
        Math.max(tower.footprint.width, tower.footprint.depth) * 0.5 + 6,
      );
    }

    const colliderNames = build.colliderBoxes.map(({ name }) => name);
    const platformNames = build.platformSurfaces.map(({ name }) => name);
    expect(new Set(colliderNames).size).toBe(colliderNames.length);
    expect(new Set(platformNames).size).toBe(platformNames.length);
  } finally {
    dispose(build);
  }
});

test('all internal flights and ground approaches are live walkable collision surfaces', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'Runtime tower collision QA runs once on desktop Chromium.');
  test.setTimeout(180_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/?qa=physics&mapSeed=450600');
  await page.waitForFunction(() => (
    Boolean(window.__THREE_GAME_TEST_HOOKS__?.getMonsoonOutpostTowerAudit())
    && Boolean(window.__THREE_GAME_DIAGNOSTICS__?.map.ready)
  ));

  const samples = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const audit = hooks.getMonsoonOutpostTowerAudit()!;
    return {
      integrationClearanceConflicts: audit.integrationClearanceConflicts,
      stairRampCount: audit.stairRamps.length,
      flights: audit.stairRamps.map(({ name, spec }) => {
        const forwardX = Math.sin(spec.heading);
        const forwardZ = Math.cos(spec.heading);
        const x = spec.origin.x + forwardX * spec.length * 0.5;
        const z = spec.origin.z + forwardZ * spec.length * 0.5;
        const expectedY = spec.origin.y + spec.rise * 0.5;
        const floorY = hooks.sampleFloorHeight(x, z, expectedY + 0.2);
        const placement = hooks.sampleCapsulePlacement({ x, y: expectedY - 0.025, z });
        return { name, expectedY, floorY, placement };
      }),
    };
  });

  expect(samples.integrationClearanceConflicts).toEqual([]);
  expect(samples.flights).toHaveLength(samples.stairRampCount);
  expect(samples.flights.length).toBeGreaterThanOrEqual(76);
  for (const sample of samples.flights) {
    expect(sample.floorY, `${sample.name} supplies its authored mid-flight support`).toBeCloseTo(sample.expectedY, 4);
    expect(sample.placement.grounded, `${sample.name} seats the player capsule`).toBe(true);
    if (sample.name.includes('internal switchback') || sample.name.includes('terrain-to-ground entrance')) {
      expect(sample.placement.position.y, `${sample.name} resolves feet onto the stair slope`).toBeCloseTo(sample.expectedY, 4);
    } else {
      expect(sample.placement.position.y, `${sample.name} remains a grounded courtyard approach`).toBeGreaterThanOrEqual(sample.expectedY - 0.02);
      expect(sample.placement.position.y - sample.expectedY, `${sample.name} does not disappear far beneath terrain`).toBeLessThan(1.5);
    }
  }
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
