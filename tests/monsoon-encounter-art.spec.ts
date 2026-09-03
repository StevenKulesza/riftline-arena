import * as THREE from 'three';
import { expect, test } from '@playwright/test';
import { MONSOON_DIVIDE, sampleMonsoonMeshHeight } from '../src/game/maps/MonsoonDivide';
import {
  MONSOON_ENCOUNTER_ART_LICENSE,
  MONSOON_ENCOUNTER_ART_SOURCE,
  buildMonsoonEncounterArt,
} from '../src/game/maps/MonsoonEncounterArt';

function serializeInstances(group: THREE.Group): Array<{ name: string; matrices: number[][] }> {
  const matrix = new THREE.Matrix4();
  return group.children.map((child) => {
    expect(child).toBeInstanceOf(THREE.InstancedMesh);
    const mesh = child as THREE.InstancedMesh;
    const matrices: number[][] = [];
    for (let index = 0; index < mesh.count; index += 1) {
      mesh.getMatrixAt(index, matrix);
      matrices.push(matrix.toArray());
    }
    return { name: mesh.name, matrices };
  });
}

function disposeBuild(build: ReturnType<typeof buildMonsoonEncounterArt>): void {
  build.geometries.forEach((geometry) => geometry.dispose());
  build.materials.forEach((material) => material.dispose());
  build.textures.forEach((texture) => texture.dispose());
}

test('Monsoon encounter art is deterministic, authored, terrain-seated, and draw-call bounded', () => {
  const first = buildMonsoonEncounterArt(MONSOON_DIVIDE.seed);
  const repeated = buildMonsoonEncounterArt(MONSOON_DIVIDE.seed);

  try {
    expect(first.diagnostics.source).toBe(MONSOON_ENCOUNTER_ART_SOURCE);
    expect(first.diagnostics.license).toBe(MONSOON_ENCOUNTER_ART_LICENSE);
    expect(first.group.userData.source).toBe(MONSOON_ENCOUNTER_ART_SOURCE);
    expect(first.group.userData.license).toBe(MONSOON_ENCOUNTER_ART_LICENSE);
    expect(first.diagnostics.assetStrategy).toBe('project-original-procedural');
    expect(first.diagnostics.terrainSampler).toBe('sampleMonsoonMeshHeight');

    expect(first.diagnostics.familyCount).toBe(3);
    expect(first.diagnostics.familyNames).toEqual(['windbreak', 'storm-drain', 'relay-fin']);
    expect(new Set(Object.values(first.diagnostics.familyLabels)).size).toBe(3);
    expect(first.diagnostics.familyInstanceCounts).toEqual({
      windbreak: 4,
      'storm-drain': 4,
      'relay-fin': 4,
    });
    expect(first.diagnostics.placementCount).toBe(12);
    expect(first.colliderBoxes).toHaveLength(12);

    expect(first.diagnostics.visibleMeshCount).toBe(4);
    expect(first.diagnostics.instancedMeshCount).toBe(4);
    expect(first.diagnostics.expectedVisibleDrawCalls).toBeLessThanOrEqual(6);
    expect(first.diagnostics.expectedShadowDrawCalls).toBeLessThanOrEqual(3);
    expect(first.diagnostics.expectedVisibleDrawCalls).toBe(4);
    expect(first.diagnostics.expectedShadowDrawCalls).toBe(2);
    expect(first.diagnostics.estimatedVisibleTriangles).toBeLessThanOrEqual(80_000);
    expect(first.diagnostics.estimatedVisibleTriangles).toBeGreaterThan(1_000);
    expect(first.diagnostics.geometryCount).toBe(4);
    expect(first.diagnostics.materialCount).toBe(2);
    expect(first.diagnostics.textureCount).toBe(0);

    const familyMeshes = first.group.children.slice(0, 3) as THREE.InstancedMesh[];
    familyMeshes.forEach((mesh, index) => {
      expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
      expect(mesh.count).toBe(4);
      expect(mesh.geometry.userData.construction).toBe('merged-beveled-extrusions');
      expect(mesh.geometry.userData.family).toBe(first.diagnostics.familyNames[index]);
    });
    const shadowCasters = first.group.children.filter(
      (child) => child instanceof THREE.Mesh && child.castShadow,
    );
    expect(shadowCasters).toHaveLength(2);

    const silhouetteSizes = familyMeshes.map((mesh) => {
      mesh.geometry.computeBoundingBox();
      return mesh.geometry.boundingBox!.getSize(new THREE.Vector3());
    });
    expect(silhouetteSizes[0].x).toBeGreaterThan(silhouetteSizes[1].x * 1.25);
    expect(silhouetteSizes[1].z).toBeGreaterThan(silhouetteSizes[0].z * 1.8);
    expect(silhouetteSizes[2].y).toBeGreaterThan(silhouetteSizes[1].y * 1.45);
    expect(new Set(silhouetteSizes.map((size) => size.toArray().map((value) => value.toFixed(2)).join(':'))).size).toBe(3);

    expect(first.diagnostics.minimumOpenSkiLineClearance).toBeGreaterThan(80);
    first.diagnostics.placements.forEach((placement, index) => {
      expect(placement.terrainY).toBe(
        sampleMonsoonMeshHeight(placement.x, placement.z, MONSOON_DIVIDE.seed),
      );
      expect(placement.openSkiLineClearance).toBeGreaterThan(80);
      const collider = first.colliderBoxes[index];
      expect(collider.min.y).toBe(placement.terrainY);
      expect(collider.max.y).toBeGreaterThan(collider.min.y);
      expect(collider.min.x).toBeGreaterThan(-MONSOON_DIVIDE.width * 0.5);
      expect(collider.max.x).toBeLessThan(MONSOON_DIVIDE.width * 0.5);
      expect(collider.min.z).toBeGreaterThan(-MONSOON_DIVIDE.depth * 0.5);
      expect(collider.max.z).toBeLessThan(MONSOON_DIVIDE.depth * 0.5);
    });

    expect(first.diagnostics).toEqual(repeated.diagnostics);
    expect(serializeInstances(first.group)).toEqual(serializeInstances(repeated.group));
    expect(first.colliderBoxes.map((box) => [...box.min.toArray(), ...box.max.toArray()])).toEqual(
      repeated.colliderBoxes.map((box) => [...box.min.toArray(), ...box.max.toArray()]),
    );
  } finally {
    disposeBuild(first);
    disposeBuild(repeated);
  }
});
