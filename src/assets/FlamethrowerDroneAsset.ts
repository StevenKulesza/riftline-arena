import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export type FlamethrowerDronePart =
  | 'body'
  | `${'front' | 'rear'}-${'left' | 'right'}-${'upper' | 'lower'}`;

export type FlamethrowerDroneAssetPart = Readonly<{
  region: FlamethrowerDronePart;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}>;

export type FlamethrowerDroneAsset = Readonly<{
  parts: readonly FlamethrowerDroneAssetPart[];
  bounds: THREE.Box3;
  triangles: number;
  sourceMeshCount: number;
  sourceAnimationCount: number;
  sourceSkinCount: number;
}>;

const MODEL_URL = '/assets/models/flamethrower-drone.glb';
const TARGET_HORIZONTAL_SPAN = 5;
let assetPromise: Promise<FlamethrowerDroneAsset> | null = null;

type PartBuilder = {
  region: FlamethrowerDronePart;
  material: THREE.Material;
  positions: number[];
  normals: number[];
  uvs: number[];
};

class DisjointSet {
  private readonly parent: Int32Array;

  constructor(count: number) {
    this.parent = new Int32Array(count);
    for (let index = 0; index < count; index += 1) this.parent[index] = index;
  }

  find(value: number): number {
    let root = value;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[value] !== value) {
      const next = this.parent[value];
      this.parent[value] = root;
      value = next;
    }
    return root;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent[rightRoot] = leftRoot;
  }
}

function materialForTriangle(mesh: THREE.Mesh, triangleOffset: number): THREE.Material {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const group = mesh.geometry.groups.find((candidate) => (
    triangleOffset >= candidate.start && triangleOffset < candidate.start + candidate.count
  ));
  return materials[group?.materialIndex ?? 0] ?? materials[0];
}

function classifyComponent(center: THREE.Vector3, minimumY: number): FlamethrowerDronePart {
  // The Sketchfab source is a single hard-surface export, but each plate and
  // limb shell remains a disconnected island. Spatially grouping those islands
  // creates a rigid mechanical rig without deforming armor panels.
  const isLeg = Math.abs(center.x) > 1.22 && center.y < 0.95 && minimumY < 0.35;
  if (!isLeg) return 'body';
  const row = center.z < 2.15 ? 'front' : 'rear';
  const side = center.x < 0 ? 'left' : 'right';
  const segment = center.y < -0.72 ? 'lower' : 'upper';
  return `${row}-${side}-${segment}`;
}

function collectMeshParts(mesh: THREE.Mesh, builders: Map<string, PartBuilder>): number {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  if (!position) return 0;
  const normal = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv');
  const index = geometry.index;
  const vertexCount = position.count;
  const triangleCount = Math.floor((index?.count ?? vertexCount) / 3);
  const sets = new DisjointSet(vertexCount);
  const vertexAt = (offset: number): number => index ? index.getX(offset) : offset;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const offset = triangle * 3;
    const a = vertexAt(offset);
    const b = vertexAt(offset + 1);
    const c = vertexAt(offset + 2);
    sets.union(a, b);
    sets.union(a, c);
  }

  type Component = { sum: THREE.Vector3; count: number; minimumY: number };
  const components = new Map<number, Component>();
  const sample = new THREE.Vector3();
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const root = sets.find(vertex);
    sample.fromBufferAttribute(position, vertex).applyMatrix4(mesh.matrixWorld);
    const component = components.get(root) ?? { sum: new THREE.Vector3(), count: 0, minimumY: Number.POSITIVE_INFINITY };
    component.sum.add(sample);
    component.count += 1;
    component.minimumY = Math.min(component.minimumY, sample.y);
    components.set(root, component);
  }

  const regionByRoot = new Map<number, FlamethrowerDronePart>();
  for (const [root, component] of components) {
    regionByRoot.set(root, classifyComponent(component.sum.multiplyScalar(1 / component.count), component.minimumY));
  }

  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const worldPosition = new THREE.Vector3();
  const worldNormal = new THREE.Vector3();
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const offset = triangle * 3;
    const firstVertex = vertexAt(offset);
    const region = regionByRoot.get(sets.find(firstVertex)) ?? 'body';
    const material = materialForTriangle(mesh, offset);
    const key = `${region}:${material.uuid}`;
    const builder = builders.get(key) ?? {
      region,
      material,
      positions: [],
      normals: [],
      uvs: [],
    };
    builders.set(key, builder);
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = vertexAt(offset + corner);
      worldPosition.fromBufferAttribute(position, vertex).applyMatrix4(mesh.matrixWorld);
      builder.positions.push(worldPosition.x, worldPosition.y, worldPosition.z);
      if (normal) {
        worldNormal.fromBufferAttribute(normal, vertex).applyMatrix3(normalMatrix).normalize();
        builder.normals.push(worldNormal.x, worldNormal.y, worldNormal.z);
      }
      if (uv) builder.uvs.push(uv.getX(vertex), uv.getY(vertex));
    }
  }
  return triangleCount;
}

async function createAsset(): Promise<FlamethrowerDroneAsset> {
  const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
  gltf.scene.updateMatrixWorld(true);
  const builders = new Map<string, PartBuilder>();
  let triangles = 0;
  let sourceMeshCount = 0;
  let sourceSkinCount = 0;
  gltf.scene.traverse((object) => {
    if (object.name.toLowerCase().includes('ground')) return;
    if (!(object instanceof THREE.Mesh)) return;
    sourceMeshCount += 1;
    if (object instanceof THREE.SkinnedMesh) sourceSkinCount += 1;
    triangles += collectMeshParts(object, builders);
  });
  if (builders.size === 0) throw new Error('Flamethrower drone body contained no renderable mesh data.');

  const parts: FlamethrowerDroneAssetPart[] = [];
  const bounds = new THREE.Box3();
  for (const builder of builders.values()) {
    if (builder.positions.length === 0) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(builder.positions, 3));
    if (builder.normals.length === builder.positions.length) {
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(builder.normals, 3));
    } else {
      geometry.computeVertexNormals();
    }
    if (builder.uvs.length * 3 === builder.positions.length * 2) {
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(builder.uvs, 2));
    }
    geometry.computeBoundingBox();
    bounds.union(geometry.boundingBox!);
    parts.push({ region: builder.region, geometry, material: builder.material });
  }

  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const scale = TARGET_HORIZONTAL_SPAN / Math.max(size.x, size.z);
  const normalize = new THREE.Matrix4().makeTranslation(-center.x, -bounds.min.y, -center.z);
  normalize.premultiply(new THREE.Matrix4().makeScale(scale, scale, scale));
  bounds.makeEmpty();
  for (const part of parts) {
    part.geometry.applyMatrix4(normalize);
    part.geometry.computeBoundingBox();
    part.geometry.computeBoundingSphere();
    bounds.union(part.geometry.boundingBox!);
  }
  return {
    parts,
    bounds,
    triangles,
    sourceMeshCount,
    sourceAnimationCount: gltf.animations.length,
    sourceSkinCount,
  };
}

export function loadFlamethrowerDroneAsset(): Promise<FlamethrowerDroneAsset> {
  assetPromise ??= createAsset();
  return assetPromise;
}
