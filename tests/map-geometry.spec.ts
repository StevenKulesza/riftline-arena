import * as THREE from 'three';
import { expect, test } from '@playwright/test';
import {
  MONSOON_DIVIDE,
  MONSOON_WORLD_SCALE,
  buildMonsoonTerrainGeometry,
  sampleMonsoonHeight,
  sampleMonsoonMeshHeight,
  sampleMonsoonMeshNormal,
  sampleMonsoonMasks,
  sampleMonsoonNormal,
  toMonsoonWorld,
} from '../src/game/maps/MonsoonDivide';

test('Monsoon Divide is deterministic, bounded, and low-poly', () => {
  const canonical = buildMonsoonTerrainGeometry(MONSOON_DIVIDE.seed);
  const repeated = buildMonsoonTerrainGeometry(MONSOON_DIVIDE.seed);
  const alternate = buildMonsoonTerrainGeometry(450_600);
  const positions = canonical.geometry.getAttribute('position');

  expect(canonical.triangleCount).toBe(96_000);
  expect(positions.count).toBe(288_000);
  expect(canonical.topologyHash).toBe(repeated.topologyHash);
  expect(alternate.topologyHash).not.toBe(canonical.topologyHash);
  expect(MONSOON_DIVIDE.width).toBe(3_840);
  expect(MONSOON_DIVIDE.depth).toBe(3_200);
  expect(MONSOON_WORLD_SCALE).toBe(8);
  expect(canonical.altitudeRange.min).toBeLessThan(MONSOON_DIVIDE.waterY - 14);
  expect(canonical.altitudeRange.max).toBeGreaterThan(320);

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

test('Monsoon gameplay sampling matches every rendered terrain triangle', () => {
  const terrain = buildMonsoonTerrainGeometry(MONSOON_DIVIDE.seed);
  const positions = terrain.geometry.getAttribute('position');
  let maximumHeightError = 0;
  let minimumNormalAgreement = 1;
  const triangleNormal = new THREE.Vector3();
  const sampledNormal = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  for (let vertex = 0; vertex < positions.count; vertex += 3) {
    a.fromBufferAttribute(positions, vertex);
    b.fromBufferAttribute(positions, vertex + 1);
    c.fromBufferAttribute(positions, vertex + 2);
    triangleNormal.crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
    const x = a.x * 0.23 + b.x * 0.31 + c.x * 0.46;
    const z = a.z * 0.23 + b.z * 0.31 + c.z * 0.46;
    const expectedHeight = a.y * 0.23 + b.y * 0.31 + c.y * 0.46;
    maximumHeightError = Math.max(maximumHeightError, Math.abs(sampleMonsoonMeshHeight(x, z) - expectedHeight));
    sampleMonsoonMeshNormal(x, z, sampledNormal);
    minimumNormalAgreement = Math.min(minimumNormalAgreement, sampledNormal.dot(triangleNormal));
  }

  // The analytic sampler works in Float64 while the 3.84 km render mesh is
  // uploaded as Float32. Keep agreement sub-millimetre at this world scale.
  expect(maximumHeightError).toBeLessThan(0.000_5);
  expect(minimumNormalAgreement).toBeGreaterThan(0.999_99);
  terrain.geometry.dispose();
});

test('Monsoon Divide has layered mountain descents, recovery rifts, broad ski routes, and walkable dry land', () => {
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
  expect(Math.max(...peaks) - Math.min(...peaks), 'massifs should remain asymmetric rather than cloned cones').toBeGreaterThan(45);
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

  let totalSamples = 0;
  let landSamples = 0;
  let drySamples = 0;
  let walkableSamples = 0;
  let routeSamplesCount = 0;
  let walkableRouteSamples = 0;
  let boundaryDrySamples = 0;
  const dryRowWidths: number[] = [];
  for (let z = -200; z <= 200; z += 8) {
    let dryRowWidth = 0;
    for (let x = -240; x <= 240; x += 8) {
      totalSamples += 1;
      const world = toMonsoonWorld(x, z);
      const masks = sampleMonsoonMasks(world.x, world.z);
      const height = sampleMonsoonHeight(world.x, world.z);
      if (masks.island > 0.5) landSamples += 1;
      if (height <= MONSOON_DIVIDE.waterY + 2) continue;
      drySamples += 1;
      dryRowWidth += 1;
      if (Math.abs(x) === 240 || Math.abs(z) === 200) boundaryDrySamples += 1;
      const walkable = sampleMonsoonNormal(world.x, world.z).y >= 0.574;
      if (walkable) walkableSamples += 1;
      if (masks.route > 0.7) {
        routeSamplesCount += 1;
        if (walkable) walkableRouteSamples += 1;
      }
    }
    dryRowWidths.push(dryRowWidth);
  }
  expect(landSamples / totalSamples, 'the expanded continent must dominate the playable rectangle').toBeGreaterThan(0.7);
  expect(landSamples / totalSamples).toBeLessThan(0.86);
  expect(drySamples / totalSamples).toBeGreaterThan(0.74);
  expect(boundaryDrySamples, 'the coastline must close before the rectangular terrain boundary').toBeLessThanOrEqual(8);
  expect(
    Math.max(...dryRowWidths) - Math.min(...dryRowWidths),
    'deep bays and unequal headlands must prevent a circular or oval silhouette',
  ).toBeGreaterThan(30);
  expect(walkableSamples / drySamples, 'most dry land remains walkable despite the hero ridges').toBeGreaterThan(0.7);
  expect(walkableRouteSamples / routeSamplesCount, 'the marked CTF/ski network must stay broadly traversable').toBeGreaterThan(0.86);

  for (const [baseX, baseZ] of [[-85, 130], [95, -120]] as const) {
    for (const [offsetX, offsetZ] of [[0, 0], [-35, 0], [35, 0], [0, -30], [0, 30]] as const) {
      const world = toMonsoonWorld(baseX + offsetX, baseZ + offsetZ);
      expect(sampleMonsoonMasks(world.x, world.z).island, 'each CTF base needs a broad dry territorial shoulder').toBeGreaterThan(0.98);
      expect(sampleMonsoonHeight(world.x, world.z)).toBeGreaterThan(MONSOON_DIVIDE.waterY + 80);
    }
  }
});
