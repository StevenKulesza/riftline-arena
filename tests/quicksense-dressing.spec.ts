import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'meshoptimizer';
import { QuickSenseArena, QUICK_HORIZONTAL_SCALE, QUICK_VERTICAL_SCALE } from '../src/game/maps/QuickSenseArena';

async function productionArena(seed = 450600): Promise<QuickSenseArena> {
  const source = await readFile(new URL('../public/assets/models/outpost-tower-fxb.glb', import.meta.url));
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const tower = await loader.parseAsync(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength), '');
  return new QuickSenseArena(seed, undefined, tower.scene);
}

// No raster claims: the fixture bypasses only Canvas2D painting, leaving the
// production terrain, placements, geometry, transforms and collision intact.
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
test.beforeAll(() => {
  const noop = () => undefined;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
          createLinearGradient: () => ({ addColorStop: noop }),
          createRadialGradient: () => ({ addColorStop: noop }),
          fillRect: noop, strokeRect: noop, beginPath: noop, closePath: noop,
          moveTo: noop, lineTo: noop, arc: noop, ellipse: noop, fill: noop,
          stroke: noop, fillText: noop, putImageData: noop,
        }),
      }),
    },
  });
});
test.afterAll(() => {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
});

test('production map places a distributed desert hierarchy with the real imported tower', async () => {
  const arena = await productionArena();
  try {
    const dressing = arena.group.userData.desertDressing;
    console.log('QuickSense dressing:', JSON.stringify(dressing));
    console.log('QuickSense outcrops:', JSON.stringify(dressing.outcropLayout));
    console.log('QuickSense budgets:', JSON.stringify({
      triangles: arena.mapInfo.renderTriangles,
      collision: arena.group.userData.desertCollisionAudit,
      towerBounds: arena.group.userData.outpostTowerAudit.bounds,
    }));
    expect(arena.group.userData.outpostTowerAudit).toBeDefined();
    expect(dressing.anchors).toBeGreaterThanOrEqual(8);
    expect(dressing.outcropClusters).toBeGreaterThanOrEqual(8);
    expect(dressing.companionRocks).toBeGreaterThanOrEqual(25);
    expect(dressing.scrubTufts).toBeGreaterThanOrEqual(35);
    expect(dressing.cactusClusters).toBeGreaterThanOrEqual(10);
    expect(dressing.dustPatches).toBeGreaterThanOrEqual(10);
    expect(arena.mapInfo.renderTriangles).toBeLessThan(750_000);
    const quadrants = new Set<string>();
    const matrix = new THREE.Matrix4();
    const center = new THREE.Vector3();
    arena.group.traverse((object) => {
      const mesh = object as THREE.InstancedMesh;
      if (!mesh.isInstancedMesh || !/outcrop/.test(mesh.name)) return;
      for (let instance = 0; instance < mesh.count; instance += 1) {
        mesh.getMatrixAt(instance, matrix);
        center.setFromMatrixPosition(matrix);
        quadrants.add(`${Math.sign(center.x)},${Math.sign(center.z)}`);
      }
    });
    expect(quadrants.size, 'outcrops must frame all four map quadrants').toBe(4);
  } finally { arena.dispose(); }
});

test('boulder and outcrop triangles remain closed after deformation', () => {
  const factory = Object.create(QuickSenseArena.prototype) as {
    createDesertBoulderGeometry(variant: number): THREE.BufferGeometry;
    createDesertOutcropGeometry(variant: number): THREE.BufferGeometry;
  };
  for (const geometry of [0, 1].flatMap((variant) => [
    factory.createDesertBoulderGeometry(variant), factory.createDesertOutcropGeometry(variant),
  ])) {
    try {
      const positions = geometry.getAttribute('position');
      const key = (vertex: number) => [positions.getX(vertex), positions.getY(vertex), positions.getZ(vertex)]
        .map((value) => Math.round(value * 100_000)).join(',');
      const edges = new Map<string, number>();
      for (let face = 0; face < positions.count; face += 3) {
        for (let corner = 0; corner < 3; corner += 1) {
          const edge = [key(face + corner), key(face + (corner + 1) % 3)].sort().join('|');
          edges.set(edge, (edges.get(edge) ?? 0) + 1);
        }
      }
      expect([...edges.values()].filter((count) => count !== 2), 'each geometric edge must belong to exactly two faces').toEqual([]);
      expect([...positions.array].every(Number.isFinite)).toBe(true);
    } finally { geometry.dispose(); }
  }
});

test('solid detail stays off routes and spawn points, and dust follows the terrain normal', async () => {
  const arena = await productionArena();
  const terrain = arena as unknown as {
    terrainNormalAt(x: number, z: number, target: THREE.Vector3): THREE.Vector3;
    pathSurfaces: Array<{ name: string; contains(x: number, z: number): boolean; heightAt(x: number, z: number): number | null }>;
  };
  try {
    const instanceMatrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const normal = new THREE.Vector3();
    let solids = 0;
    let decoration = 0;
    let solidTriangles = 0;
    arena.group.traverse((object) => {
      const mesh = object as THREE.InstancedMesh;
      if (!mesh.isInstancedMesh || !mesh.userData.desertDressing) return;
      if (mesh.userData.decorationOnly) decoration += mesh.count;
      if (mesh.userData.desertSolid) {
        solids += mesh.count;
        solidTriangles += (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3 * mesh.count;
      }
      for (let instance = 0; instance < mesh.count; instance += 1) {
        mesh.getMatrixAt(instance, instanceMatrix);
        position.setFromMatrixPosition(instanceMatrix);
        if (mesh.name.includes('dust patches')) {
          normal.set(0, 0, 1).transformDirection(instanceMatrix);
          expect(normal.dot(terrain.terrainNormalAt(position.x, position.z, new THREE.Vector3()))).toBeGreaterThan(0.9999);
        }
        if (!mesh.userData.desertSolid) continue;
        for (const spawn of arena.spawnPoints) {
          const distance = Math.hypot(position.x - spawn.x / QUICK_HORIZONTAL_SCALE, position.z - spawn.z / QUICK_HORIZONTAL_SCALE);
          expect(distance, `${mesh.name} must not occupy a spawn`).toBeGreaterThan(3);
        }
        const vertices = mesh.geometry.getAttribute('position');
        for (let index = 0; index < vertices.count; index += 1) {
          const point = new THREE.Vector3().fromBufferAttribute(vertices, index).applyMatrix4(instanceMatrix);
          for (const path of terrain.pathSurfaces) {
            if (!path.contains(point.x, point.z)) continue;
            const routeY = path.heightAt(point.x, point.z);
            expect(routeY, `${mesh.name}: missing path height`).not.toBeNull();
            expect(
              routeY! - point.y,
              `${mesh.name} instance ${instance} vertex ${index} at (${point.x.toFixed(2)}, ${point.y.toFixed(2)}, ${point.z.toFixed(2)}): insufficient clearance beneath ${path.name}`,
            ).toBeGreaterThan(2.25);
          }
        }
      }
    });
    expect(solids).toBeGreaterThan(70);
    expect(decoration).toBeGreaterThan(50);
    expect(arena.group.userData.desertCollisionAudit.triangles).toBe(solidTriangles);
    expect(arena.group.userData.desertCollisionAudit.instances).toBe(solids);
  } finally { arena.dispose(); }
});

test('projectiles and player capsules contact the visible rock surface', async () => {
  const arena = await productionArena();
  try {
    const mesh = arena.group.getObjectByName('QuickSense foreground boulder anchors') as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(0, matrix);
    const worldMatrix = mesh.matrixWorld.clone().multiply(matrix);
    const bounds = mesh.geometry.boundingBox!.clone().applyMatrix4(worldMatrix);
    const center = bounds.getCenter(new THREE.Vector3());
    const rayOrigin = center.clone().setX(bounds.max.x + 2);
    const ray = new THREE.Raycaster(rayOrigin, new THREE.Vector3(-1, 0, 0));
    const visibleHit = ray.intersectObject(mesh).find((hit) => hit.instanceId === 0);
    expect(visibleHit).toBeDefined();
    const point = visibleHit!.point;
    const normal = visibleHit!.face!.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(worldMatrix));
    expect(Math.abs(normal.y), 'fixture must test a lateral or sloped rock face').toBeLessThan(0.9);
    const shotHit = arena.segmentHitDetails(point.clone().addScaledVector(normal, 0.3), point.clone().addScaledVector(normal, -0.3));
    expect(shotHit).not.toBeNull();
    expect(shotHit!.point.distanceTo(point), 'shot should hit visible stone, not a proxy box').toBeLessThan(0.025);

    const radius = 0.55;
    const position = point.clone().addScaledVector(normal, radius * 0.35);
    position.y -= radius;
    const before = position.clone();
    const velocity = normal.clone().multiplyScalar(-3);
    const contact = arena.resolveCapsule(position, velocity, radius, radius * 2);
    expect(contact.contacts).toBeGreaterThan(0);
    expect(position.distanceTo(before)).toBeGreaterThan(0.08);
    expect(velocity.dot(normal), 'inward velocity must be removed at rock contact').toBeGreaterThan(-0.2);
    expect([position.x, position.y, position.z, velocity.x, velocity.y, velocity.z].every(Number.isFinite)).toBe(true);
    expect(position.y / QUICK_VERTICAL_SCALE).toBeGreaterThan(-50);
  } finally { arena.dispose(); }
});

test('fallback map retains the desert hierarchy for another seed', () => {
  const arena = new QuickSenseArena(9032026);
  try {
    const dressing = arena.group.userData.desertDressing;
    expect(dressing.anchors + dressing.outcropClusters).toBeGreaterThanOrEqual(16);
    expect(dressing.outcropClusters).toBeGreaterThanOrEqual(10);
    expect(dressing.cactusClusters).toBeGreaterThanOrEqual(10);
    expect(arena.mapInfo.renderTriangles).toBeLessThan(750_000);
  } finally { arena.dispose(); }
});
