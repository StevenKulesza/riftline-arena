import { expect, test } from '@playwright/test';
import * as THREE from 'three';
import {
  CTF_FLAG_GEOMETRY_SIGNATURE,
  CTF_FLAG_MODEL_ID,
  CtfFlagVisual,
} from '../src/assets/CtfFlagVisual';

const geometryProfile = (flag: CtfFlagVisual) => {
  const profile: Array<{ name: string; type: string; vertices: number; indices: number }> = [];
  for (const root of [flag.root, flag.baseRoot]) {
    root.traverse((object) => {
      const drawable = object as THREE.Mesh | THREE.LineSegments;
      if (!drawable.geometry) return;
      profile.push({
        name: object.name,
        type: object.type,
        vertices: drawable.geometry.getAttribute('position')?.count ?? 0,
        indices: drawable.geometry.index?.count ?? 0,
      });
    });
  }
  return profile;
};

test('both factions use the same authored flag model and cloth topology', () => {
  const azure = new CtfFlagVisual('azure', 0x2ea8ff);
  const crimson = new CtfFlagVisual('crimson', 0xff4d62);

  expect(azure.modelId).toBe(CTF_FLAG_MODEL_ID);
  expect(crimson.modelId).toBe(CTF_FLAG_MODEL_ID);
  expect(azure.root.userData.modelId).toBe(crimson.root.userData.modelId);
  expect(azure.geometrySignature).toBe(CTF_FLAG_GEOMETRY_SIGNATURE);
  expect(crimson.geometrySignature).toBe(CTF_FLAG_GEOMETRY_SIGNATURE);
  expect(geometryProfile(crimson)).toEqual(geometryProfile(azure));
  expect(azure.root.getObjectByName('ctf-faction-pennant')).toBeTruthy();
  expect(crimson.root.getObjectByName('ctf-faction-pennant')).toBeTruthy();
  expect(azure.diagnostics()).toMatchObject({
    engine: 'custom-verlet-cloth',
    clothVertices: 77,
    bodyCount: 1,
    colliderCount: 1,
  });
  expect(crimson.diagnostics().clothConstraints).toBe(azure.diagnostics().clothConstraints);

  const origin = new THREE.Vector3(0, 0, 0);
  azure.resetAt(origin);
  crimson.resetAt(origin);
  for (let frame = 0; frame < 48; frame += 1) {
    azure.updatePresentation(1 / 60, { x: 0.28, z: 0.96 }, 0.58, false);
    crimson.updatePresentation(1 / 60, { x: 0.28, z: 0.96 }, 0.58, false);
  }
  const azureCloth = azure.root.getObjectByName('ctf-faction-pennant') as THREE.Mesh;
  const crimsonCloth = crimson.root.getObjectByName('ctf-faction-pennant') as THREE.Mesh;
  expect(Array.from(
    (crimsonCloth.geometry.getAttribute('position') as THREE.BufferAttribute).array,
  )).toEqual(Array.from(
    (azureCloth.geometry.getAttribute('position') as THREE.BufferAttribute).array,
  ));
  expect(crimson.diagnostics().maxClothDeflection).toBe(azure.diagnostics().maxClothDeflection);

  azure.dispose();
  crimson.dispose();
});

test('flag cloth reacts to wind and a dropped flag bounces before settling', () => {
  const flag = new CtfFlagVisual('azure', 0x2ea8ff);
  flag.resetAt(new THREE.Vector3(0, 0, 0));
  for (let frame = 0; frame < 150; frame += 1) {
    flag.updatePresentation(1 / 60, { x: 0.35, z: 0.94 }, 1, false);
  }
  expect(flag.diagnostics().maxClothDeflection).toBeGreaterThan(0.04);
  expect(flag.diagnostics().maxClothDeflection).toBeLessThan(0.8);

  flag.dropAt(new THREE.Vector3(0, 3.5, 0), new THREE.Vector3(5, -2, 1.5));
  for (let step = 0; step < 720; step += 1) {
    flag.stepDropped(1 / 120, () => 0);
  }

  const settled = flag.diagnostics();
  expect(settled.mode).toBe('dropped');
  expect(settled.bounces).toBeGreaterThan(0);
  expect(settled.bounces).toBeLessThanOrEqual(3);
  expect(settled.grounded).toBe(true);
  expect(flag.root.position.y).toBeCloseTo(0, 5);
  expect(flag.root.position.x).toBeGreaterThan(0.25);
  expect(Math.abs(settled.velocity.y)).toBeLessThan(0.001);

  flag.dispose();
});

test('carried flag follows with bounded inertial lag', () => {
  const flag = new CtfFlagVisual('crimson', 0xff4d62);
  const target = new THREE.Vector3(0, 1.72, 0);
  const velocity = new THREE.Vector3(18, 0, -7);
  flag.beginCarry(target, velocity);

  for (let step = 0; step < 120; step += 1) {
    target.addScaledVector(velocity, 1 / 120);
    flag.stepCarried(1 / 120, target, velocity);
  }

  const carried = flag.diagnostics();
  expect(carried.mode).toBe('carried');
  expect(carried.grounded).toBe(false);
  expect(flag.root.position.distanceTo(target)).toBeLessThanOrEqual(1.051);
  expect(Math.abs(flag.root.rotation.x) + Math.abs(flag.root.rotation.z)).toBeGreaterThan(0.02);

  flag.dispose();
});
