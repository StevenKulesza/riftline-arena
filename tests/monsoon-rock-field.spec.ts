import { expect, test } from '@playwright/test';
import * as THREE from 'three';
import { buildMonsoonRockField, createMonsoonRockGeometry, isMonsoonRockFootprintClear, ROCK_ARCHETYPES, ROCK_TIERS, type MonsoonRockFieldBuild } from '../src/game/maps/MonsoonRockField';
import { sampleMonsoonMeshHeight, sampleMonsoonMeshNormal } from '../src/game/maps/MonsoonDivide';
import { buildMonsoonWorldArt } from '../src/game/maps/MonsoonWorldArt';
import { buildMonsoonEncounterArt } from '../src/game/maps/MonsoonEncounterArt';
import { buildMonsoonOutpostTowers } from '../src/game/maps/MonsoonOutpostTowers';
import { buildLaunchRamp } from '../src/game/maps/FlowGeometry';

const dispose = (build: MonsoonRockFieldBuild): void => {
  build.group.traverse((object) => { if (object instanceof THREE.InstancedMesh) object.dispose(); });
  build.geometries.forEach((geometry) => geometry.dispose());
  build.textures.forEach((texture) => texture.dispose());
  build.material.dispose();
};

test('geological families have distinct authored proportions, finite surfaces, and bounded detail tiers', () => {
  const ratios: number[][] = [];
  for (let archetype = 0; archetype < ROCK_ARCHETYPES.length; archetype += 1) {
    const variants = [0, 1].map((variant) => createMonsoonRockGeometry(archetype, variant, 0));
    const geometry = variants[0];
    const size = geometry.boundingBox!.getSize(new THREE.Vector3());
    ratios.push([size.x / size.y, size.y / size.z]);
    expect(geometry.getAttribute('position').count / 3).toBe(500);
    expect([...geometry.getAttribute('position').array].every(Number.isFinite)).toBe(true);
    expect([...geometry.getAttribute('normal').array].every(Number.isFinite)).toBe(true);
    expect(geometry.getAttribute('color').count).toBe(geometry.getAttribute('position').count);
    expect([...geometry.getAttribute('position').array]).not.toEqual([...variants[1].getAttribute('position').array]);
    for (let tier = 1; tier < ROCK_TIERS.length; tier += 1) {
      const lod = createMonsoonRockGeometry(archetype, 0, tier);
      expect(lod.getAttribute('position').count / 3).toBe([500, 180, 80, 20][tier]);
      lod.dispose();
    }
    variants.forEach((item) => item.dispose());
  }
  expect(ratios[1][0], 'slab is broad and low').toBeGreaterThan(2.5);
  expect(ratios[2][1], 'fin has a tall silhouette').toBeGreaterThan(1.4);
  expect(new Set(ratios.map((ratio) => ratio.map((value) => value.toFixed(2)).join(','))).size).toBe(6);
});

test('rock fields compose reproducible primary/secondary/rubble hierarchy within the render budget', () => {
  const build = buildMonsoonRockField(450600);
  const repeat = buildMonsoonRockField(450600);
  try {
    console.log('Monsoon rock-field budget:', JSON.stringify(build.diagnostics));
    expect(build.diagnostics.clusterCount).toBe(56);
    expect(build.rocks).toHaveLength(1400);
    expect(build.diagnostics.tierCounts).toEqual({ anchor: 56, companion: 224, cobble: 392, rubble: 728 });
    expect(build.diagnostics.triangles).toBeLessThanOrEqual(115000);
    expect(build.diagnostics.drawCalls).toBeLessThanOrEqual(48);
    expect(build.diagnostics.shadowDrawCalls).toBeLessThanOrEqual(24);
    expect(build.diagnostics.diameterRange[1] / build.diagnostics.diameterRange[0]).toBeGreaterThan(90);
    expect(build.diagnostics).toEqual(repeat.diagnostics);
    expect(build.rocks.map(({ position, geometryIndex, scale }) => [position.toArray(), geometryIndex, scale.toArray()]))
      .toEqual(repeat.rocks.map(({ position, geometryIndex, scale }) => [position.toArray(), geometryIndex, scale.toArray()]));
    for (const mesh of build.group.children as THREE.InstancedMesh[]) {
      expect(mesh.material).toBe(build.material);
      expect(mesh.instanceMatrix.usage).toBe(THREE.StaticDrawUsage);
      expect(mesh.boundingSphere!.radius).toBeGreaterThan(0);
    }
  } finally { dispose(build); dispose(repeat); }
});

test('every rock is seated, leaves route/base margins, and smaller debris predominantly trails downhill', () => {
  const build = buildMonsoonRockField(450600);
  try {
    let downhill = 0;
    let samples = 0;
    for (const rock of build.rocks) {
      expect(isMonsoonRockFootprintClear(rock.position.x, rock.position.z, rock.footprintRadius, 450600, () => false)).toBe(true);
      const ground = sampleMonsoonMeshHeight(rock.position.x, rock.position.z, 450600);
      expect(rock.bounds.min.y).toBeLessThan(ground);
      expect(rock.bounds.max.y).toBeGreaterThan(ground);
      if (rock.tier === 'anchor' || rock.tier === 'companion') continue;
      const anchor = build.rocks.find((candidate) => candidate.cluster === rock.cluster && candidate.tier === 'anchor')!;
      const normal = sampleMonsoonMeshNormal(anchor.position.x, anchor.position.z, new THREE.Vector3(), 450600);
      if (Math.hypot(normal.x, normal.z) < 0.04) continue;
      downhill += Number((rock.position.x - anchor.position.x) * normal.x + (rock.position.z - anchor.position.z) * normal.z > 0);
      samples += 1;
    }
    expect(downhill / samples).toBeGreaterThan(0.85);
    for (const { box } of build.colliderBoxes) expect(box.isEmpty()).toBe(false);
  } finally { dispose(build); }
});

test('unplaceable rocks are omitted, never hidden under the map or forced through structures', () => {
  const build = buildMonsoonRockField(450600, () => true);
  try {
    expect(build.rocks).toHaveLength(0);
    expect(build.colliderBoxes).toHaveLength(0);
    expect(build.diagnostics.placedCount).toBe(0);
  } finally { dispose(build); }
});

test('actual outposts, stairs, and world-art footprints retain clear approaches and the full rock hierarchy', () => {
  const world = buildMonsoonWorldArt(450600);
  const encounters = buildMonsoonEncounterArt(450600);
  const towers = buildMonsoonOutpostTowers(450600);
  const ramps = towers.stairRamps.map(({ spec }) => buildLaunchRamp(spec).geometry);
  const boxes = [
    ...world.colliderBoxes, ...encounters.colliderBoxes, ...towers.colliderBoxes.map(({ box }) => box),
    ...ramps.map((geometry) => geometry.boundingBox!),
    ...towers.platformSurfaces.map((platform) => new THREE.Box3(
      new THREE.Vector3(platform.minX, 0, platform.minZ), new THREE.Vector3(platform.maxX, 0, platform.maxZ),
    )),
  ];
  const blocked = (x: number, z: number, radius: number): boolean => boxes.some((box) => Math.hypot(
    x - THREE.MathUtils.clamp(x, box.min.x - 3, box.max.x + 3),
    z - THREE.MathUtils.clamp(z, box.min.z - 3, box.max.z + 3),
  ) <= radius);
  const build = buildMonsoonRockField(450600, blocked);
  try {
    expect(build.rocks).toHaveLength(1400);
    expect(build.diagnostics.clusterCount).toBe(56);
    for (const rock of build.rocks) {
      expect(blocked(rock.position.x, rock.position.z, rock.footprintRadius + 2.5)).toBe(false);
      const matrix = new THREE.Matrix4().compose(new THREE.Vector3(), rock.quaternion, rock.scale);
      const points = build.geometries[rock.geometryIndex].getAttribute('position');
      const point = new THREE.Vector3();
      let radius = 0;
      for (let index = 0; index < points.count; index += 1) {
        point.fromBufferAttribute(points, index).applyMatrix4(matrix);
        radius = Math.max(radius, Math.hypot(point.x, point.z));
      }
      expect(radius).toBeLessThanOrEqual(rock.footprintRadius);
    }
  } finally {
    dispose(build);
    ramps.forEach((geometry) => geometry.dispose());
    for (const kit of [world, encounters, towers]) {
      kit.group.traverse((object) => { if (object instanceof THREE.InstancedMesh) object.dispose(); });
      kit.geometries.forEach((geometry) => geometry.dispose());
      kit.materials.forEach((material) => material.dispose());
      kit.textures.forEach((texture) => texture.dispose());
    }
  }
});
