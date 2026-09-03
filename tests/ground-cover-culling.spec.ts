import { expect, test } from '@playwright/test';
import * as THREE from 'three';
import { GroundCoverCulling, partitionGroundCover } from '../src/systems/GroundCoverCulling';

const placement = (x: number, z: number): number[] => [x, 2, z, 0.8, 1, 2, 3, 0xaabbcc];
const makeMesh = (x: number, z: number): THREE.InstancedMesh => {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 4, 2), new THREE.MeshBasicMaterial(), 1);
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(x, 2, z));
  mesh.computeBoundingBox();
  mesh.computeBoundingSphere();
  return mesh;
};

test('ground-cover partition preserves every transform and color, including negative coordinates', () => {
  const original = [placement(-1, -1), placement(-127, -80), placement(0, 0), placement(127, 127), placement(128, 0)];
  const buckets = [original.slice(0, 3).flat(), original.slice(3).flat()];
  const before = JSON.stringify(buckets);
  const cells = partitionGroundCover(buckets);
  expect(cells).toHaveLength(3);
  expect(cells.map((cell) => cell.length / 8)).toEqual([2, 2, 1]);
  expect(cells.flat()).toEqual(original.flat());
  expect(JSON.stringify(buckets)).toBe(before);
});

test('distance culling preserves nearby plants, rejects distant batches, and restores them on return', () => {
  const culling = new GroundCoverCulling();
  const parent = new THREE.Group();
  const near = makeMesh(0, -20);
  const far = makeMesh(0, -900);
  culling.add(near, parent, 'fern');
  culling.add(far, parent, 'fern');
  const versions = [near.instanceMatrix.version, far.instanceMatrix.version];
  const camera = new THREE.PerspectiveCamera(80);
  culling.update(camera);
  expect(near.parent!.visible).toBe(true);
  expect(far.parent!.visible).toBe(false);
  expect(culling.snapshot()).toMatchObject({ cells: 2, visibleCells: 1 });
  camera.position.z = -900;
  culling.update(camera);
  expect(far.parent!.visible).toBe(true);
  expect(near.parent!.visible).toBe(false);
  expect([near.instanceMatrix.version, far.instanceMatrix.version]).toEqual(versions);
  expect(near.count + far.count).toBe(2);
  culling.clear();
  expect(culling.snapshot().cells).toBe(0);
});

test('scoping extends detail distance and vertical separation participates in culling', () => {
  const culling = new GroundCoverCulling();
  const parent = new THREE.Group();
  const mesh = makeMesh(0, -900);
  culling.add(mesh, parent, 'fern');
  const camera = new THREE.PerspectiveCamera(80);
  culling.update(camera);
  expect(mesh.parent!.visible).toBe(false);
  camera.fov = 24;
  culling.update(camera);
  expect(mesh.parent!.visible).toBe(true);
  camera.fov = 80;
  camera.position.set(0, 1_000, -900);
  culling.update(camera);
  expect(mesh.parent!.visible).toBe(false);
});

test('cell bounds preserve edge plants until after their complete fade distance', () => {
  const culling = new GroundCoverCulling();
  const parent = new THREE.Group();
  const first = makeMesh(0, -20);
  const edge = makeMesh(127, -20);
  culling.add(first, parent, 'grass');
  culling.add(edge, parent, 'grass');
  expect(first.parent).toBe(edge.parent);
  const camera = new THREE.PerspectiveCamera(80);
  camera.position.set(346, 2, -20);
  culling.update(camera);
  expect(edge.parent!.visible).toBe(true);
  camera.position.x = 352;
  culling.update(camera);
  expect(edge.parent!.visible).toBe(false);
});

test('shader fade composes with existing wind and does not add transparency to opaque foliage', () => {
  const culling = new GroundCoverCulling();
  const material = new THREE.MeshStandardMaterial();
  material.customProgramCacheKey = () => 'fern-wind';
  const wind = { value: 1 };
  material.onBeforeCompile = (shader) => { shader.uniforms.uWind = wind; };
  culling.configureMaterial(material, 'fern');
  const shader = {
    uniforms: {},
    vertexShader: '#include <common>\nvoid main(){\n#include <project_vertex>\n}',
    fragmentShader: '#include <common>\nvoid main(){\n#include <alphatest_fragment>\n}',
  } as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  expect(shader.uniforms.uWind).toBe(wind);
  expect(shader.vertexShader).toContain('instanceMatrix * groundCoverRoot');
  expect(shader.vertexShader).toContain('400.0 * uGroundCoverDistanceScale');
  expect(shader.fragmentShader).toContain('discard');
  expect(material.transparent).toBe(false);
  expect(material.customProgramCacheKey()).toBe('fern-wind|ground-cover-distance-v1:fern');
  const camera = new THREE.PerspectiveCamera(24);
  culling.update(camera);
  expect(shader.uniforms.uGroundCoverDistanceScale.value).toBeGreaterThan(3);
});
