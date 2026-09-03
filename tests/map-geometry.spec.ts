import { expect, test } from '@playwright/test';
import {
  MONSOON_DIVIDE,
  MONSOON_WORLD_SCALE,
  buildMonsoonTerrainGeometry,
  sampleMonsoonHeight,
  sampleMonsoonMasks,
  sampleMonsoonNormal,
  toMonsoonWorld,
} from '../src/game/maps/MonsoonDivide';

test('Monsoon Divide is deterministic, bounded, and low-poly', () => {
  const canonical = buildMonsoonTerrainGeometry(MONSOON_DIVIDE.seed);
  const repeated = buildMonsoonTerrainGeometry(MONSOON_DIVIDE.seed);
  const alternate = buildMonsoonTerrainGeometry(450_600);
  const positions = canonical.geometry.getAttribute('position');

  expect(canonical.triangleCount).toBe(24_000);
  expect(positions.count).toBe(72_000);
  expect(canonical.topologyHash).toBe(repeated.topologyHash);
  expect(alternate.topologyHash).not.toBe(canonical.topologyHash);
  expect(MONSOON_DIVIDE.width).toBe(960);
  expect(MONSOON_DIVIDE.depth).toBe(800);
  expect(MONSOON_WORLD_SCALE).toBe(2);
  expect(canonical.altitudeRange.min).toBeLessThan(MONSOON_DIVIDE.waterY - 7);
  expect(canonical.altitudeRange.max).toBeGreaterThan(160);

  canonical.geometry.computeBoundingBox();
  expect(canonical.geometry.boundingBox?.min.x).toBeCloseTo(-MONSOON_DIVIDE.width / 2, 4);
  expect(canonical.geometry.boundingBox?.max.x).toBeCloseTo(MONSOON_DIVIDE.width / 2, 4);
  expect(canonical.geometry.boundingBox?.min.z).toBeCloseTo(-MONSOON_DIVIDE.depth / 2, 4);
  expect(canonical.geometry.boundingBox?.max.z).toBeCloseTo(MONSOON_DIVIDE.depth / 2, 4);

  let invalidCoordinates = 0;
  let minimumArea = Number.POSITIVE_INFINITY;
  for (let vertex = 0; vertex < positions.count; vertex += 3) {
    const ax = positions.getX(vertex);
    const ay = positions.getY(vertex);
    const az = positions.getZ(vertex);
    const abx = positions.getX(vertex + 1) - ax;
    const aby = positions.getY(vertex + 1) - ay;
    const abz = positions.getZ(vertex + 1) - az;
    const acx = positions.getX(vertex + 2) - ax;
    const acy = positions.getY(vertex + 2) - ay;
    const acz = positions.getZ(vertex + 2) - az;
    const area2 = Math.hypot(
      aby * acz - abz * acy,
      abz * acx - abx * acz,
      abx * acy - aby * acx,
    );
    if (!Number.isFinite(ax + ay + az)) invalidCoordinates += 1;
    minimumArea = Math.min(minimumArea, area2);
  }
  expect(invalidCoordinates).toBe(0);
  expect(minimumArea).toBeGreaterThan(0.01);

  canonical.geometry.dispose();
  repeated.geometry.dispose();
  alternate.geometry.dispose();
});

test('Monsoon Divide has layered mountain descents, recovery bowls, broad ski routes, and walkable dry land', () => {
  const heightAt = (x: number, z: number): number => {
    const world = toMonsoonWorld(x, z);
    return sampleMonsoonHeight(world.x, world.z);
  };
  const masksAt = (x: number, z: number) => {
    const world = toMonsoonWorld(x, z);
    return sampleMonsoonMasks(world.x, world.z);
  };
  const center = heightAt(0, 0);
  const mountainRuns = [
    [[-148, 76], [-119, 58], [-88, 39]],
    [[150, 65], [116, 45], [88, 42]],
    [[-150, -100], [-118, -82], [-78, -58]],
    [[150, -108], [103, -77], [76, -61]],
  ].map((run) => run.map(([x, z]) => heightAt(x, z)));
  const peaks = [
    ...mountainRuns.map((run) => run[0]),
    heightAt(-43, 148),
    heightAt(47, -146),
  ];
  expect(Math.min(...peaks) - center, 'every mountain range needs meaningful relief above the central bowl').toBeGreaterThan(38);
  expect(Math.max(...peaks) - Math.min(...peaks), 'massifs should remain asymmetric rather than cloned cones').toBeGreaterThan(28);
  for (const [peak, shoulder, recovery] of mountainRuns) {
    expect(peak, 'the outer crown must stand above its secondary shoulder').toBeGreaterThan(shoulder + 10);
    expect(shoulder, 'the secondary shoulder must retain depth above the recovery lane').toBeGreaterThan(recovery + 10);
    expect(peak - recovery, 'each primary ski descent needs a substantial vertical run').toBeGreaterThan(30);
  }

  const routeSamples = [
    masksAt(-88, 39).route,
    masksAt(88, 42).route,
    masksAt(-78, -58).route,
    masksAt(76, -61).route,
  ];
  expect(Math.min(...routeSamples)).toBeGreaterThan(0.85);

  let drySamples = 0;
  let walkableSamples = 0;
  for (let z = -352; z <= 352; z += 16) {
    for (let x = -432; x <= 432; x += 16) {
      const height = sampleMonsoonHeight(x, z);
      if (height <= MONSOON_DIVIDE.waterY + 2) continue;
      drySamples += 1;
      if (sampleMonsoonNormal(x, z).y >= 0.574) walkableSamples += 1;
    }
  }
  expect(drySamples).toBeGreaterThan(1_500);
  expect(walkableSamples / drySamples, 'at least four fifths of sampled dry land remains walkable despite the hero ridges').toBeGreaterThan(0.8);
});
