import * as THREE from 'three';
import { expect, test } from '@playwright/test';
import { MONSOON_DIVIDE } from '../src/game/maps/MonsoonDivide';
import {
  MONSOON_DISTANT_WORLD_LICENSE,
  MONSOON_DISTANT_WORLD_SOURCE,
  buildMonsoonDistantWorld,
} from '../src/game/maps/MonsoonDistantWorld';

function geometryFingerprint(geometry: THREE.BufferGeometry): string {
  const positions = geometry.getAttribute('position');
  let hash = 0x811c9dc5;
  for (let index = 0; index < positions.count; index += 1) {
    const values = [positions.getX(index), positions.getY(index), positions.getZ(index)];
    for (const value of values) {
      const quantized = Math.round(value * 1_000);
      hash ^= quantized;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return `${positions.count}:${hash.toString(16).padStart(8, '0')}`;
}

function disposeBuild(build: ReturnType<typeof buildMonsoonDistantWorld>): void {
  build.geometries.forEach((geometry) => geometry.dispose());
  build.materials.forEach((material) => material.dispose());
  build.textures.forEach((texture) => texture.dispose());
}

test('Monsoon distant world is deterministic, project-original, visual-only, and budget bounded', () => {
  const first = buildMonsoonDistantWorld(MONSOON_DIVIDE.seed);
  const repeated = buildMonsoonDistantWorld(MONSOON_DIVIDE.seed);

  try {
    expect(first.diagnostics.source).toBe(MONSOON_DISTANT_WORLD_SOURCE);
    expect(first.diagnostics.license).toBe(MONSOON_DISTANT_WORLD_LICENSE);
    expect(first.diagnostics.assetStrategy).toBe('project-original-deterministic-procedural');
    expect(first.diagnostics.deterministic).toBe(true);
    expect(first.group.userData.source).toBe(MONSOON_DISTANT_WORLD_SOURCE);
    expect(first.group.userData.license).toBe(MONSOON_DISTANT_WORLD_LICENSE);
    expect(first.group.userData.assetSourcing).toContain('Project-original');

    expect(first.diagnostics.collision).toBe(false);
    expect(first.diagnostics.colliderBoxCount).toBe(0);
    expect(first.colliderBoxes).toEqual([]);
    expect(first.group.userData.collision).toBe(false);
    first.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      expect(object.userData.nonCollidable).toBe(true);
      expect(object.castShadow).toBe(false);
      expect(object.receiveShadow).toBe(false);
    });

    expect(first.diagnostics.layerNames).toEqual([
      'far-ridge',
      'mid-ridge',
      'sea-stack',
      'storm-collector',
      'mist-bank',
    ]);
    expect(first.diagnostics.instanceCounts).toEqual({
      'far-ridge': 7,
      'mid-ridge': 9,
      'sea-stack': 11,
      'storm-collector': 7,
      'mist-bank': 11,
      total: 45,
    });
    expect(first.diagnostics.visibleMeshCount).toBe(5);
    expect(first.diagnostics.instancedMeshCount).toBe(0);
    expect(first.diagnostics.expectedVisibleDrawCalls).toBeLessThanOrEqual(5);
    expect(first.diagnostics.expectedShadowDrawCalls).toBeLessThanOrEqual(2);
    expect(first.diagnostics.expectedShadowDrawCalls).toBe(0);
    expect(first.diagnostics.expectedDrawCalls).toBe(5);
    expect(first.diagnostics.geometryCount).toBe(5);
    expect(first.diagnostics.materialCount).toBe(5);
    expect(first.diagnostics.textureCount).toBe(0);
    expect(first.diagnostics.estimatedVisibleTriangles).toBeGreaterThan(1_000);
    expect(first.diagnostics.estimatedVisibleTriangles).toBeLessThanOrEqual(35_000);
    expect(first.diagnostics.hasWeatherUpdate).toBe(true);

    expect(first.diagnostics).toEqual(repeated.diagnostics);
    expect(first.geometries.map(geometryFingerprint)).toEqual(repeated.geometries.map(geometryFingerprint));
  } finally {
    disposeBuild(first);
    disposeBuild(repeated);
  }
});

test('every distant feature is beyond the playable footprint and the horizon spacing is irregular', () => {
  const build = buildMonsoonDistantWorld(MONSOON_DIVIDE.seed);
  const halfWidth = MONSOON_DIVIDE.width * 0.5;
  const halfDepth = MONSOON_DIVIDE.depth * 0.5;

  try {
    expect(build.diagnostics.placements).toHaveLength(build.diagnostics.instanceCounts.total);
    expect(build.diagnostics.minimumPlayableBoundsClearance).toBeGreaterThan(40);
    for (const placement of build.diagnostics.placements) {
      const [minX, , minZ] = placement.bounds.min;
      const [maxX, , maxZ] = placement.bounds.max;
      const overlapsPlayableX = minX < halfWidth && maxX > -halfWidth;
      const overlapsPlayableZ = minZ < halfDepth && maxZ > -halfDepth;
      expect(overlapsPlayableX && overlapsPlayableZ, `${placement.name} intrudes into play`).toBe(false);
      expect(placement.outsidePlayableBounds).toBe(true);
      expect(placement.playableBoundsClearance).toBeGreaterThan(40);
      expect(placement.radialDistance).toBeGreaterThan(Math.min(halfWidth, halfDepth));
    }

    const solidPlacements = build.diagnostics.placements.filter((placement) => placement.kind !== 'mist-bank');
    const roundedRadii = new Set(solidPlacements.map((placement) => Math.round(placement.radialDistance / 20)));
    const roundedAzimuths = new Set(solidPlacements.map((placement) => Math.round(placement.azimuthDegrees / 5)));
    expect(roundedRadii.size).toBeGreaterThan(10);
    expect(roundedAzimuths.size).toBeGreaterThan(18);
    expect(build.diagnostics.radialDistanceRange[1] - build.diagnostics.radialDistanceRange[0]).toBeGreaterThan(350);

    const names = build.diagnostics.placements.map((placement) => placement.name);
    expect(new Set(names).size).toBe(names.length);
  } finally {
    disposeBuild(build);
  }
});

test('weather update remains deterministic, bounded, and changes only visual horizon state', () => {
  const first = buildMonsoonDistantWorld(MONSOON_DIVIDE.seed);
  const repeated = buildMonsoonDistantWorld(MONSOON_DIVIDE.seed);

  try {
    first.update(1 / 60, 0.85);
    repeated.update(1 / 60, 0.85);
    first.update(0.2, 1.4);
    repeated.update(0.2, 1.4);

    const firstMist = first.group.getObjectByName('Low wind-driven horizon mist banks') as THREE.Mesh;
    const repeatedMist = repeated.group.getObjectByName('Low wind-driven horizon mist banks') as THREE.Mesh;
    const firstMistMaterial = firstMist.material as THREE.MeshBasicMaterial;
    const repeatedMistMaterial = repeatedMist.material as THREE.MeshBasicMaterial;
    const firstCollector = first.group.getObjectByName('Distant lightning collector skyline') as THREE.Mesh;
    const firstCollectorMaterial = firstCollector.material as THREE.MeshStandardMaterial;

    expect(firstMist.position.toArray()).toEqual(repeatedMist.position.toArray());
    expect(firstMistMaterial.opacity).toBe(repeatedMistMaterial.opacity);
    expect(firstMistMaterial.color.getHex()).toBe(repeatedMistMaterial.color.getHex());
    expect(firstMistMaterial.opacity).toBeGreaterThanOrEqual(0.12);
    expect(firstMistMaterial.opacity).toBeLessThanOrEqual(0.27);
    expect(firstMist.position.length()).toBeLessThan(8);
    expect(firstCollectorMaterial.emissiveIntensity).toBeLessThanOrEqual(0.52);
    expect(first.colliderBoxes).toEqual([]);
    expect(first.diagnostics.collision).toBe(false);
  } finally {
    disposeBuild(first);
    disposeBuild(repeated);
  }
});
