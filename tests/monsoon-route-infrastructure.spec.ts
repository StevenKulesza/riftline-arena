import * as THREE from 'three';
import { expect, test } from '@playwright/test';
import { MONSOON_DIVIDE } from '../src/game/maps/MonsoonDivide';
import {
  MONSOON_ROUTE_INFRA_LICENSE,
  MONSOON_ROUTE_INFRA_SOURCE,
  buildMonsoonRouteInfrastructure,
} from '../src/game/maps/MonsoonRouteInfrastructure';

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

function dispose(build: ReturnType<typeof buildMonsoonRouteInfrastructure>): void {
  build.geometries.forEach((geometry) => geometry.dispose());
  build.materials.forEach((material) => material.dispose());
}

test('Monsoon route infrastructure is deterministic, original, non-colliding, and budget bounded', () => {
  const first = buildMonsoonRouteInfrastructure(MONSOON_DIVIDE.seed);
  const repeated = buildMonsoonRouteInfrastructure(MONSOON_DIVIDE.seed);
  try {
    expect(first.diagnostics.source).toBe(MONSOON_ROUTE_INFRA_SOURCE);
    expect(first.diagnostics.license).toBe(MONSOON_ROUTE_INFRA_LICENSE);
    expect(first.diagnostics.deterministic).toBe(true);
    expect(first.diagnostics.collision).toBe(false);
    expect(first.colliderBoxes).toEqual([]);
    expect(first.textures).toEqual([]);
    expect(first.diagnostics.routeCount).toBe(7);
    expect(new Set(first.diagnostics.routeNames).size).toBe(7);
    expect(first.diagnostics.routeSampleCount).toBeGreaterThan(120);
    expect(first.diagnostics.curbInstanceCount).toBeGreaterThan(200);
    expect(first.diagnostics.gatewayInstanceCount).toBe(10);
    expect(first.diagnostics.signalInstanceCount).toBeGreaterThan(35);
    expect(first.diagnostics.visibleMeshCount).toBe(4);
    expect(first.diagnostics.instancedMeshCount).toBe(3);
    expect(first.diagnostics.expectedVisibleDrawCalls).toBeLessThanOrEqual(4);
    expect(first.diagnostics.expectedShadowDrawCalls).toBeLessThanOrEqual(2);
    expect(first.diagnostics.estimatedVisibleTriangles).toBeLessThanOrEqual(90_000);
    expect(first.group.userData.assetSourcing).toContain('Project-original');
    first.group.traverse((object) => {
      if (object instanceof THREE.Mesh) expect(object.userData.nonCollidable).toBe(true);
    });
    expect(first.diagnostics).toEqual(repeated.diagnostics);
    expect(first.geometries.map(fingerprint)).toEqual(repeated.geometries.map(fingerprint));
  } finally {
    dispose(first);
    dispose(repeated);
  }
});

test('connected route batches occupy the playable footprint without altering collision ownership', () => {
  const build = buildMonsoonRouteInfrastructure(450_600);
  try {
    const channels = build.group.getObjectByName('Connected stormwater ski route channels') as THREE.Mesh;
    const curbs = build.group.getObjectByName('Connected ribbed route curbs') as THREE.InstancedMesh;
    const gateways = build.group.getObjectByName('Arcing storm-pressure route gateways') as THREE.InstancedMesh;
    expect(channels).toBeTruthy();
    expect(curbs.count).toBe(build.diagnostics.curbInstanceCount);
    expect(gateways.count).toBe(build.diagnostics.gatewayInstanceCount);
    expect(channels.geometry.boundingBox).toBeTruthy();
    const bounds = channels.geometry.boundingBox!;
    expect(bounds.min.x).toBeGreaterThan(-MONSOON_DIVIDE.width * 0.5);
    expect(bounds.max.x).toBeLessThan(MONSOON_DIVIDE.width * 0.5);
    expect(bounds.min.z).toBeGreaterThan(-MONSOON_DIVIDE.depth * 0.5);
    expect(bounds.max.z).toBeLessThan(MONSOON_DIVIDE.depth * 0.5);
    expect(build.colliderBoxes).toHaveLength(0);
  } finally {
    dispose(build);
  }
});
