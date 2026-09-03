import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createSeededRandom } from '../../utils/random';
import { MONSOON_DIVIDE, MONSOON_WORLD_SCALE } from './MonsoonDivide';

export const MONSOON_DISTANT_WORLD_SOURCE = 'Riftline project-original procedural Monsoon macro-horizon';
export const MONSOON_DISTANT_WORLD_LICENSE = 'Riftline project original';

export type MonsoonDistantFeatureKind =
  | 'far-ridge'
  | 'mid-ridge'
  | 'sea-stack'
  | 'storm-collector'
  | 'mist-bank';

export type MonsoonDistantPlacementDiagnostics = Readonly<{
  name: string;
  kind: MonsoonDistantFeatureKind;
  center: readonly [x: number, y: number, z: number];
  bounds: Readonly<{
    min: readonly [x: number, y: number, z: number];
    max: readonly [x: number, y: number, z: number];
  }>;
  radialDistance: number;
  azimuthDegrees: number;
  playableBoundsClearance: number;
  outsidePlayableBounds: true;
}>;

export type MonsoonDistantWorldDiagnostics = Readonly<{
  source: typeof MONSOON_DISTANT_WORLD_SOURCE;
  license: typeof MONSOON_DISTANT_WORLD_LICENSE;
  seed: number;
  worldScale: number;
  assetStrategy: 'project-original-deterministic-procedural';
  deterministic: true;
  collision: false;
  colliderBoxCount: 0;
  layerNames: readonly MonsoonDistantFeatureKind[];
  instanceCounts: Readonly<Record<MonsoonDistantFeatureKind, number> & { total: number }>;
  placements: readonly MonsoonDistantPlacementDiagnostics[];
  minimumPlayableBoundsClearance: number;
  radialDistanceRange: readonly [minimum: number, maximum: number];
  visibleMeshCount: number;
  instancedMeshCount: 0;
  expectedVisibleDrawCalls: number;
  expectedShadowDrawCalls: 0;
  expectedDrawCalls: number;
  geometryCount: number;
  materialCount: number;
  textureCount: 0;
  estimatedVisibleTriangles: number;
  addedTriangleBudget: 35_000;
  hasWeatherUpdate: true;
}>;

export type MonsoonDistantWorldBuild = {
  group: THREE.Group;
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
  textures: THREE.Texture[];
  colliderBoxes: THREE.Box3[];
  diagnostics: MonsoonDistantWorldDiagnostics;
  /** Advance subtle mist drift and storm-response values. */
  update: (deltaSeconds: number, weatherSeverity: number) => void;
};

type RidgeSpec = Readonly<{
  name: string;
  x: number;
  z: number;
  yaw: number;
  length: number;
  depth: number;
  height: number;
}>;

type StackSpec = Readonly<{
  name: string;
  x: number;
  z: number;
  yaw: number;
  radius: number;
  height: number;
}>;

type CollectorSpec = Readonly<{
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  height: number;
}>;

type MistSpec = Readonly<{
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  length: number;
  height: number;
  depth: number;
}>;

type PreparedPart = Readonly<{
  geometry: THREE.BufferGeometry;
  placement: MonsoonDistantPlacementDiagnostics;
}>;

const LAYER_NAMES: readonly MonsoonDistantFeatureKind[] = [
  'far-ridge',
  'mid-ridge',
  'sea-stack',
  'storm-collector',
  'mist-bank',
];

// These are intentionally authored as broken arcs rather than a uniform ring.
// Varying radius, scale, and spacing leaves broad sky notches above the arena's
// route exits while replacing the rectangular terrain edge with deep parallax.
const FAR_RIDGES: readonly RidgeSpec[] = [
  { name: 'Tempest Wall', x: -500, z: -205, yaw: 0.42, length: 190, depth: 70, height: 94 },
  { name: 'Broken Crown', x: -355, z: 355, yaw: -0.52, length: 240, depth: 88, height: 120 },
  { name: 'Northwall Shelf', x: -60, z: 475, yaw: 0.12, length: 290, depth: 92, height: 136 },
  { name: 'Gale Teeth', x: 290, z: 405, yaw: -0.32, length: 225, depth: 74, height: 104 },
  { name: 'East Split Massif', x: 520, z: 95, yaw: 0.88, length: 205, depth: 80, height: 120 },
  { name: 'Sunderbank Ridge', x: 360, z: -405, yaw: 0.48, length: 260, depth: 82, height: 115 },
  { name: 'Black Squall Range', x: -130, z: -500, yaw: -0.08, length: 300, depth: 98, height: 132 },
];

const MID_RIDGES: readonly RidgeSpec[] = [
  { name: 'West Rainshadow', x: -370, z: 65, yaw: 1.12, length: 125, depth: 55, height: 75 },
  { name: 'Northwest Shear', x: -330, z: 270, yaw: 0.4, length: 100, depth: 50, height: 68 },
  { name: 'Needle Shelf', x: -135, z: 325, yaw: -0.5, length: 150, depth: 55, height: 83 },
  { name: 'Rainbreak Mesa', x: 80, z: 345, yaw: 0.28, length: 135, depth: 58, height: 74 },
  { name: 'Splitwater Teeth', x: 330, z: 245, yaw: -0.58, length: 112, depth: 52, height: 72 },
  { name: 'East Storm Gate', x: 385, z: -75, yaw: 1.15, length: 120, depth: 54, height: 78 },
  { name: 'Southeast Cutbank', x: 300, z: -285, yaw: 0.4, length: 140, depth: 50, height: 70 },
  { name: 'South Gale Shelf', x: 40, z: -345, yaw: -0.16, length: 175, depth: 58, height: 80 },
  { name: 'Southwest Rain Teeth', x: -270, z: -300, yaw: 0.7, length: 130, depth: 50, height: 73 },
];

const SEA_STACKS: readonly StackSpec[] = [
  { name: 'West Hook', x: -305, z: -40, yaw: 0.2, radius: 12, height: 55 },
  { name: 'West Watch', x: -292, z: 145, yaw: -0.45, radius: 15, height: 72 },
  { name: 'Northwest Needle', x: -210, z: 255, yaw: 0.18, radius: 18, height: 84 },
  { name: 'North Split Stack', x: -35, z: 285, yaw: -0.28, radius: 16, height: 70 },
  { name: 'North Gale Stack', x: 185, z: 285, yaw: 0.52, radius: 15, height: 77 },
  { name: 'East Crown Stack', x: 290, z: 170, yaw: -0.18, radius: 16, height: 88 },
  { name: 'East Needle', x: 315, z: 0, yaw: 0.36, radius: 18, height: 94 },
  { name: 'Southeast Fork', x: 290, z: -185, yaw: -0.6, radius: 14, height: 69 },
  { name: 'South Spire', x: 130, z: -285, yaw: 0.24, radius: 17, height: 82 },
  { name: 'Southwest Hook', x: -155, z: -280, yaw: -0.42, radius: 15, height: 76 },
  { name: 'West Squall Stack', x: -290, z: -175, yaw: 0.64, radius: 16, height: 79 },
];

const STORM_COLLECTORS: readonly CollectorSpec[] = [
  { name: 'Tempest Fork Array', x: -489, y: 72, z: -186, yaw: 0.2, height: 31 },
  { name: 'Broken Crown Rod', x: -344, y: 101, z: 340, yaw: -0.5, height: 36 },
  { name: 'Northwall Collector', x: -65, y: 116, z: 470, yaw: 0.08, height: 42 },
  { name: 'Gale Teeth Array', x: 300, y: 88, z: 400, yaw: -0.32, height: 34 },
  { name: 'East Split Rod', x: 515, y: 102, z: 95, yaw: 0.86, height: 40 },
  { name: 'Sunderbank Collector', x: 350, y: 94, z: -405, yaw: 0.45, height: 37 },
  { name: 'Black Squall Rod', x: -125, y: 110, z: -505, yaw: -0.1, height: 41 },
];

const MIST_BANKS: readonly MistSpec[] = [
  { name: 'West Low Squall', x: -430, y: 8, z: -35, yaw: 0.22, length: 170, height: 18, depth: 42 },
  { name: 'West Rain Veil', x: -405, y: 15, z: 225, yaw: -0.34, length: 140, height: 22, depth: 38 },
  { name: 'Northwest Mist Shelf', x: -245, y: 11, z: 315, yaw: 0.18, length: 125, height: 17, depth: 40 },
  { name: 'North Cloud Bank', x: -15, y: 18, z: 370, yaw: -0.08, length: 195, height: 25, depth: 44 },
  { name: 'Northeast Rain Veil', x: 245, y: 10, z: 325, yaw: 0.32, length: 130, height: 18, depth: 38 },
  { name: 'East Low Squall', x: 420, y: 14, z: 155, yaw: -0.2, length: 155, height: 23, depth: 42 },
  { name: 'East Storm Shelf', x: 430, y: 9, z: -125, yaw: 0.44, length: 145, height: 17, depth: 40 },
  { name: 'Southeast Mist Bank', x: 325, y: 16, z: -300, yaw: -0.4, length: 145, height: 24, depth: 42 },
  { name: 'South Rain Veil', x: 80, y: 10, z: -390, yaw: 0.1, length: 190, height: 18, depth: 44 },
  { name: 'Southwest Cloud Bank', x: -210, y: 17, z: -350, yaw: -0.24, length: 160, height: 25, depth: 42 },
  { name: 'Far West Spray', x: -490, y: 5, z: -265, yaw: 0.36, length: 120, height: 14, depth: 35 },
];

const WATERLINE_DESIGN_Y = MONSOON_DIVIDE.waterY / MONSOON_WORLD_SCALE;

function world(value: number): number {
  return value * MONSOON_WORLD_SCALE;
}

function geometryTriangleCount(geometry: THREE.BufferGeometry): number {
  const positions = geometry.getAttribute('position');
  return Math.round((geometry.index?.count ?? positions.count) / 3);
}

function hashSeed(seed: number, index: number, salt: number): number {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b1) ^ salt) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  return value >>> 0;
}

function placementMatrix(x: number, y: number, z: number, yaw: number): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(world(x), world(y), world(z)),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
    new THREE.Vector3(1, 1, 1),
  );
}

function createWindCutRidgeGeometry(spec: RidgeSpec, seed: number): THREE.BufferGeometry {
  const random = createSeededRandom(seed);
  const alongSegments = 18;
  const crossFactors = [-0.52, -0.41, -0.29, -0.16, -0.02, 0.13, 0.27, 0.4, 0.52] as const;
  const heightFactors = [0.01, 0.3, 0.58, 0.83, 1, 0.76, 0.48, 0.24, 0.01] as const;
  const positions: number[] = [];
  const indices: number[] = [];

  for (let along = 0; along <= alongSegments; along += 1) {
    const t = along / alongSegments;
    const endFalloff = 0.16 + Math.pow(Math.sin(Math.PI * t), 0.58) * 0.84;
    const macroFold = Math.sin(t * Math.PI * 5.2 + seed * 0.000_013) * 0.055;
    const fractureStep = (Math.floor(t * 7) % 2 === 0 ? 1 : -1) * (0.025 + random() * 0.028);
    const terrace = 0.84 + random() * 0.2 + macroFold + fractureStep;
    const longitudinalCut = (random() - 0.5) * spec.depth * 0.11;
    for (let cross = 0; cross < crossFactors.length; cross += 1) {
      const edge = cross === 0 || cross === crossFactors.length - 1;
      const windShear = cross >= 4 ? (t - 0.5) * spec.depth * 0.16 : 0;
      const x = (t - 0.5) * spec.length + (edge ? 0 : (random() - 0.5) * spec.length * 0.026);
      const z = crossFactors[cross] * spec.depth + longitudinalCut + windShear;
      const shelfCut = cross === 2 || cross === 6 ? 0.9 : cross === 3 || cross === 7 ? 0.95 : 1;
      const chip = edge ? 0 : (random() - 0.5) * spec.height * 0.035;
      const y = -4 + spec.height * heightFactors[cross] * endFalloff * terrace * shelfCut + chip;
      positions.push(world(x), world(y), world(z));
    }
  }

  const rowWidth = crossFactors.length;
  for (let along = 0; along < alongSegments; along += 1) {
    for (let cross = 0; cross < rowWidth - 1; cross += 1) {
      const a = along * rowWidth + cross;
      const b = a + rowWidth;
      const diagonalFlip = (along + cross) % 2 === 0;
      if (diagonalFlip) indices.push(a, b, a + 1, a + 1, b, b + 1);
      else indices.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

function createSeaStackGeometry(spec: StackSpec, seed: number): THREE.BufferGeometry {
  const random = createSeededRandom(seed);
  const radialSegments = 9;
  const levels = [0, 0.14, 0.29, 0.44, 0.58, 0.72, 0.86, 1] as const;
  // Alternating inset and shelf levels read as storm-cut basalt strata from
  // the high overview cameras without requiring another material or draw.
  const radiusFactors = [1.04, 0.91, 0.97, 0.65, 0.72, 0.46, 0.34, 0.075] as const;
  const positions: number[] = [];
  const indices: number[] = [];
  const windX = (random() - 0.5) * spec.radius * 0.5;
  const windZ = (random() - 0.5) * spec.radius * 0.35;

  levels.forEach((level, levelIndex) => {
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const angle = (segment / radialSegments) * Math.PI * 2;
      const radialVariation = 0.79 + random() * 0.34;
      const radius = spec.radius * radiusFactors[levelIndex] * radialVariation;
      const cut = level > 0.44 && (segment + levelIndex) % 4 === 0 ? -spec.height * 0.05 : 0;
      positions.push(
        world(Math.cos(angle) * radius + windX * level + Math.sin(levelIndex * 1.7) * spec.radius * 0.025),
        world(-4 + spec.height * level + cut),
        world(Math.sin(angle) * radius + windZ * level + Math.cos(levelIndex * 1.3) * spec.radius * 0.022),
      );
    }
  });

  for (let level = 0; level < levels.length - 1; level += 1) {
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const next = (segment + 1) % radialSegments;
      const a = level * radialSegments + segment;
      const b = level * radialSegments + next;
      const c = (level + 1) * radialSegments + segment;
      const d = (level + 1) * radialSegments + next;
      indices.push(a, c, b, b, c, d);
    }
  }

  const topCenter = positions.length / 3;
  positions.push(world(windX), world(spec.height * 1.01), world(windZ));
  const topStart = (levels.length - 1) * radialSegments;
  for (let segment = 0; segment < radialSegments; segment += 1) {
    indices.push(topStart + segment, topCenter, topStart + ((segment + 1) % radialSegments));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

function cylinderBetween(
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
): THREE.BufferGeometry {
  const delta = end.clone().sub(start);
  const geometry = new THREE.CylinderGeometry(world(radius), world(radius * 1.28), delta.length(), 5, 1);
  const midpoint = start.clone().add(end).multiplyScalar(0.5);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    delta.clone().normalize(),
  );
  geometry.applyMatrix4(new THREE.Matrix4().compose(midpoint, quaternion, new THREE.Vector3(1, 1, 1)));
  return geometry;
}

function createStormCollectorGeometry(spec: CollectorSpec): THREE.BufferGeometry {
  const height = world(spec.height);
  const parts: THREE.BufferGeometry[] = [];
  const base = new THREE.CylinderGeometry(world(3.4), world(4.8), world(8), 6, 1);
  base.translate(0, world(4), 0);
  parts.push(base);
  const mast = new THREE.CylinderGeometry(world(0.55), world(1.05), height, 5, 1);
  mast.translate(0, world(8) + height * 0.5, 0);
  parts.push(mast);
  const crownY = world(8) + height;
  const forkTop = crownY + world(10);
  parts.push(
    cylinderBetween(new THREE.Vector3(0, crownY - world(2), 0), new THREE.Vector3(world(-5), forkTop, world(1.5)), 0.38),
    cylinderBetween(new THREE.Vector3(0, crownY - world(2), 0), new THREE.Vector3(world(5.8), forkTop - world(2), world(-1)), 0.38),
    cylinderBetween(new THREE.Vector3(0, crownY, 0), new THREE.Vector3(world(0.8), forkTop + world(4), world(0.5)), 0.3),
  );
  const collectorLoop = new THREE.TorusGeometry(world(4.2), world(0.34), 3, 10);
  collectorLoop.rotateX(Math.PI * 0.5);
  collectorLoop.rotateY(0.2);
  collectorLoop.translate(0, crownY + world(2.5), 0);
  parts.push(collectorLoop);

  const prepared = parts.map((part) => {
    const geometry = part.index ? part.toNonIndexed() : part.clone();
    part.dispose();
    for (const attribute of Object.keys(geometry.attributes)) {
      if (attribute !== 'position') geometry.deleteAttribute(attribute);
    }
    geometry.computeVertexNormals();
    return geometry;
  });
  const merged = mergeGeometries(prepared, false);
  prepared.forEach((part) => part.dispose());
  if (!merged) throw new Error(`Failed to merge distant storm collector ${spec.name}.`);
  return merged;
}

function createMistBankGeometry(spec: MistSpec, seed: number): THREE.BufferGeometry {
  const random = createSeededRandom(seed);
  const geometry = new THREE.SphereGeometry(1, 8, 4);
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const scallop = 0.9 + random() * 0.14;
    positions.setXYZ(
      index,
      world(x * spec.length * 0.5 * scallop),
      world((y * 0.5 + 0.42) * spec.height),
      world(z * spec.depth * 0.5 * (0.92 + random() * 0.12)),
    );
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

function boundsClearanceFromPlayable(bounds: THREE.Box3): number {
  const halfWidth = MONSOON_DIVIDE.width * 0.5;
  const halfDepth = MONSOON_DIVIDE.depth * 0.5;
  const dx = bounds.max.x < -halfWidth
    ? -halfWidth - bounds.max.x
    : bounds.min.x > halfWidth
      ? bounds.min.x - halfWidth
      : 0;
  const dz = bounds.max.z < -halfDepth
    ? -halfDepth - bounds.max.z
    : bounds.min.z > halfDepth
      ? bounds.min.z - halfDepth
      : 0;
  return Math.hypot(dx, dz);
}

function preparePart(
  source: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
  name: string,
  kind: MonsoonDistantFeatureKind,
  center: readonly [number, number, number],
  lowerColor: THREE.ColorRepresentation,
  upperColor: THREE.ColorRepresentation,
  surfaceSeed?: number,
): PreparedPart {
  const geometry = source.index ? source.toNonIndexed() : source.clone();
  source.dispose();
  for (const attribute of Object.keys(geometry.attributes)) {
    if (attribute !== 'position') geometry.deleteAttribute(attribute);
  }
  geometry.applyMatrix4(matrix);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox!.clone();
  const lower = new THREE.Color(lowerColor);
  const upper = new THREE.Color(upperColor);
  const yRange = Math.max(1, bounds.max.y - bounds.min.y);
  const positions = geometry.getAttribute('position');
  const colors = new Float32Array(positions.count * 3);
  const isRock = kind === 'far-ridge' || kind === 'mid-ridge' || kind === 'sea-stack';
  if (isRock && surfaceSeed !== undefined) {
    const random = createSeededRandom(surfaceSeed);
    const edgeA = new THREE.Vector3();
    const edgeB = new THREE.Vector3();
    const faceNormal = new THREE.Vector3();
    const windDirection = new THREE.Vector3(0.72, 0.08, -0.69).normalize();
    const strataCount = kind === 'sea-stack' ? 12 : kind === 'mid-ridge' ? 10 : 8;
    const strataPhase = random() * Math.PI * 2;

    // Non-indexed triangles intentionally share one color per face. The
    // resulting broad facets, alternating strata, and windward/leeward values
    // survive distance fog far better than high-frequency texture detail.
    for (let triangle = 0; triangle < positions.count; triangle += 3) {
      const ax = positions.getX(triangle);
      const ay = positions.getY(triangle);
      const az = positions.getZ(triangle);
      const bx = positions.getX(triangle + 1);
      const by = positions.getY(triangle + 1);
      const bz = positions.getZ(triangle + 1);
      const cx = positions.getX(triangle + 2);
      const cy = positions.getY(triangle + 2);
      const cz = positions.getZ(triangle + 2);
      edgeA.set(bx - ax, by - ay, bz - az);
      edgeB.set(cx - ax, cy - ay, cz - az);
      faceNormal.crossVectors(edgeA, edgeB).normalize();

      const faceY = (ay + by + cy) / 3;
      const heightMix = THREE.MathUtils.clamp((faceY - bounds.min.y) / yRange, 0, 1);
      const upward = THREE.MathUtils.clamp(faceNormal.y, 0, 1);
      const windward = THREE.MathUtils.clamp(faceNormal.dot(windDirection) * 0.5 + 0.5, 0, 1);
      const strataWave = Math.sin(heightMix * strataCount * Math.PI * 2 + strataPhase);
      const darkSeam = strataWave < -0.58 ? 0.78 : strataWave > 0.72 ? 1.08 : 0.94;
      const fractureTone = 0.91 + random() * 0.18;
      const value = THREE.MathUtils.clamp(
        (0.7 + upward * 0.2 + windward * 0.12) * darkSeam * fractureTone,
        0.55,
        1.14,
      );
      const color = lower.clone().lerp(upper, 0.16 + heightMix * 0.7 + upward * 0.1);
      color.multiplyScalar(value);
      color.offsetHSL((random() - 0.5) * 0.018, (random() - 0.5) * 0.055, 0);

      for (let vertex = triangle; vertex < triangle + 3; vertex += 1) {
        colors[vertex * 3] = color.r;
        colors[vertex * 3 + 1] = color.g;
        colors[vertex * 3 + 2] = color.b;
      }
    }
  } else {
    for (let index = 0; index < positions.count; index += 1) {
      const heightMix = THREE.MathUtils.clamp((positions.getY(index) - bounds.min.y) / yRange, 0, 1);
      const color = lower.clone().lerp(upper, 0.12 + heightMix * 0.88);
      colors[index * 3] = color.r;
      colors[index * 3 + 1] = color.g;
      colors[index * 3 + 2] = color.b;
    }
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.userData = {
    name,
    kind,
    source: MONSOON_DISTANT_WORLD_SOURCE,
    license: MONSOON_DISTANT_WORLD_LICENSE,
    nonCollidable: true,
  };
  const clearance = boundsClearanceFromPlayable(bounds);
  if (clearance <= 0) throw new Error(`${name} overlaps the Monsoon playable bounds.`);
  const worldCenter: readonly [number, number, number] = [world(center[0]), world(center[1]), world(center[2])];
  const placement: MonsoonDistantPlacementDiagnostics = {
    name,
    kind,
    center: worldCenter,
    bounds: {
      min: bounds.min.toArray() as [number, number, number],
      max: bounds.max.toArray() as [number, number, number],
    },
    radialDistance: Math.hypot(worldCenter[0], worldCenter[2]),
    azimuthDegrees: THREE.MathUtils.radToDeg(Math.atan2(worldCenter[2], worldCenter[0])),
    playableBoundsClearance: clearance,
    outsidePlayableBounds: true,
  };
  return { geometry, placement };
}

function mergeLayer(parts: PreparedPart[], name: string, kind: MonsoonDistantFeatureKind): THREE.BufferGeometry {
  const merged = mergeGeometries(parts.map((part) => part.geometry), false);
  parts.forEach((part) => part.geometry.dispose());
  if (!merged) throw new Error(`Failed to merge Monsoon distant ${kind} layer.`);
  merged.name = name;
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  merged.userData = {
    kind,
    source: MONSOON_DISTANT_WORLD_SOURCE,
    license: MONSOON_DISTANT_WORLD_LICENSE,
    nonCollidable: true,
  };
  return merged;
}

function createLayerMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  name: string,
  kind: MonsoonDistantFeatureKind,
  renderOrder: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = renderOrder;
  mesh.userData = {
    kind,
    layer: 'macro-horizon',
    source: MONSOON_DISTANT_WORLD_SOURCE,
    license: MONSOON_DISTANT_WORLD_LICENSE,
    nonCollidable: true,
  };
  return mesh;
}

/**
 * Builds a visual-only macro horizon around Monsoon Divide. Every triangle is
 * outside the playable rectangle, so this group must never be inserted into a
 * collision BVH. The caller owns and disposes all returned resources.
 */
export function buildMonsoonDistantWorld(
  seed: number = MONSOON_DIVIDE.seed,
): MonsoonDistantWorldBuild {
  const normalizedSeed = seed >>> 0;
  const group = new THREE.Group();
  group.name = 'MonsoonDivideDistantWorld';

  const placements: MonsoonDistantPlacementDiagnostics[] = [];
  const farParts = FAR_RIDGES.map((spec, index) => preparePart(
    createWindCutRidgeGeometry(spec, hashSeed(normalizedSeed, index, 0xf4a721)),
    placementMatrix(spec.x, WATERLINE_DESIGN_Y - 3.5, spec.z, spec.yaw),
    spec.name,
    'far-ridge',
    [spec.x, WATERLINE_DESIGN_Y - 3.5, spec.z],
    0x0b1b24,
    0x506d7a,
    hashSeed(normalizedSeed, index, 0x8fc3a1),
  ));
  const midParts = MID_RIDGES.map((spec, index) => preparePart(
    createWindCutRidgeGeometry(spec, hashSeed(normalizedSeed, index, 0x71d9b5)),
    placementMatrix(spec.x, WATERLINE_DESIGN_Y - 2.6, spec.z, spec.yaw),
    spec.name,
    'mid-ridge',
    [spec.x, WATERLINE_DESIGN_Y - 2.6, spec.z],
    0x0c2029,
    0x67828c,
    hashSeed(normalizedSeed, index, 0xa16d72),
  ));
  const stackParts = SEA_STACKS.map((spec, index) => preparePart(
    createSeaStackGeometry(spec, hashSeed(normalizedSeed, index, 0x5ea57ac)),
    placementMatrix(spec.x, WATERLINE_DESIGN_Y - 2, spec.z, spec.yaw),
    spec.name,
    'sea-stack',
    [spec.x, WATERLINE_DESIGN_Y - 2, spec.z],
    0x091b24,
    0x76919b,
    hashSeed(normalizedSeed, index, 0x36be94),
  ));
  const collectorParts = STORM_COLLECTORS.map((spec) => preparePart(
    createStormCollectorGeometry(spec),
    placementMatrix(spec.x, spec.y, spec.z, spec.yaw),
    spec.name,
    'storm-collector',
    [spec.x, spec.y, spec.z],
    0x17272f,
    0x8baab1,
  ));
  const mistParts = MIST_BANKS.map((spec, index) => preparePart(
    createMistBankGeometry(spec, hashSeed(normalizedSeed, index, 0xc10dbaa)),
    placementMatrix(spec.x, spec.y, spec.z, spec.yaw),
    spec.name,
    'mist-bank',
    [spec.x, spec.y, spec.z],
    0x819da4,
    0xb8cbd0,
  ));
  [farParts, midParts, stackParts, collectorParts, mistParts].forEach((parts) => {
    placements.push(...parts.map((part) => part.placement));
  });

  const farGeometry = mergeLayer(farParts, 'MonsoonDistantFarWindCutRidges', 'far-ridge');
  const midGeometry = mergeLayer(midParts, 'MonsoonDistantMidStormCarvedRidges', 'mid-ridge');
  const stackGeometry = mergeLayer(stackParts, 'MonsoonDistantSeaStackArchipelago', 'sea-stack');
  const collectorGeometry = mergeLayer(collectorParts, 'MonsoonDistantStormCollectors', 'storm-collector');
  const mistGeometry = mergeLayer(mistParts, 'MonsoonDistantLowMistBanks', 'mist-bank');
  const geometries = [farGeometry, midGeometry, stackGeometry, collectorGeometry, mistGeometry];

  const farMaterial = new THREE.MeshStandardMaterial({
    name: 'MonsoonDistantFarBasalt',
    color: 0x8299a1,
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    flatShading: true,
    fog: true,
  });
  const midMaterial = new THREE.MeshStandardMaterial({
    name: 'MonsoonDistantMidWetBasalt',
    color: 0x8da4aa,
    vertexColors: true,
    roughness: 0.97,
    metalness: 0.015,
    flatShading: true,
    fog: true,
  });
  const stackMaterial = new THREE.MeshStandardMaterial({
    name: 'MonsoonDistantNearWetSeaStacks',
    color: 0x91a8ad,
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.025,
    flatShading: true,
    fog: true,
  });
  const collectorMaterial = new THREE.MeshStandardMaterial({
    name: 'MonsoonDistantConductiveCollectors',
    color: 0xd9e7e9,
    vertexColors: true,
    roughness: 0.43,
    metalness: 0.72,
    emissive: 0x16343d,
    emissiveIntensity: 0.22,
    flatShading: true,
    fog: true,
  });
  const mistMaterial = new THREE.MeshBasicMaterial({
    name: 'MonsoonDistantWindDrivenMist',
    color: 0xc0d2d5,
    vertexColors: true,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  const materials: THREE.Material[] = [
    farMaterial,
    midMaterial,
    stackMaterial,
    collectorMaterial,
    mistMaterial,
  ];
  const textures: THREE.Texture[] = [];
  const colliderBoxes: THREE.Box3[] = [];

  const farMesh = createLayerMesh(farGeometry, farMaterial, 'Far broken storm-wall silhouettes', 'far-ridge', -5);
  const midMesh = createLayerMesh(midGeometry, midMaterial, 'Mid storm-carved archipelago ridges', 'mid-ridge', -4);
  const stackMesh = createLayerMesh(stackGeometry, stackMaterial, 'Near layered sea-stack silhouettes', 'sea-stack', -3);
  const collectorMesh = createLayerMesh(collectorGeometry, collectorMaterial, 'Distant lightning collector skyline', 'storm-collector', -2);
  const mistMesh = createLayerMesh(mistGeometry, mistMaterial, 'Low wind-driven horizon mist banks', 'mist-bank', -1);
  group.add(farMesh, midMesh, stackMesh, collectorMesh, mistMesh);

  const instanceCounts: Record<MonsoonDistantFeatureKind, number> & { total: number } = {
    'far-ridge': FAR_RIDGES.length,
    'mid-ridge': MID_RIDGES.length,
    'sea-stack': SEA_STACKS.length,
    'storm-collector': STORM_COLLECTORS.length,
    'mist-bank': MIST_BANKS.length,
    total: placements.length,
  };
  const radialDistances = placements.map((placement) => placement.radialDistance);
  const estimatedVisibleTriangles = geometries.reduce(
    (total, geometry) => total + geometryTriangleCount(geometry),
    0,
  );
  const diagnostics: MonsoonDistantWorldDiagnostics = {
    source: MONSOON_DISTANT_WORLD_SOURCE,
    license: MONSOON_DISTANT_WORLD_LICENSE,
    seed: normalizedSeed,
    worldScale: MONSOON_WORLD_SCALE,
    assetStrategy: 'project-original-deterministic-procedural',
    deterministic: true,
    collision: false,
    colliderBoxCount: 0,
    layerNames: [...LAYER_NAMES],
    instanceCounts,
    placements,
    minimumPlayableBoundsClearance: Math.min(...placements.map((placement) => placement.playableBoundsClearance)),
    radialDistanceRange: [Math.min(...radialDistances), Math.max(...radialDistances)],
    visibleMeshCount: group.children.length,
    instancedMeshCount: 0,
    expectedVisibleDrawCalls: group.children.length,
    expectedShadowDrawCalls: 0,
    expectedDrawCalls: group.children.length,
    geometryCount: geometries.length,
    materialCount: materials.length,
    textureCount: 0,
    estimatedVisibleTriangles,
    addedTriangleBudget: 35_000,
    hasWeatherUpdate: true,
  };

  let elapsed = 0;
  const update = (deltaSeconds: number, weatherSeverity: number): void => {
    elapsed += THREE.MathUtils.clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 0, 0, 0.25);
    const storm = THREE.MathUtils.clamp(Number.isFinite(weatherSeverity) ? weatherSeverity : 0, 0, 1);
    mistMaterial.opacity = THREE.MathUtils.lerp(0.12, 0.27, storm);
    mistMaterial.color.set(0xc0d2d5).lerp(new THREE.Color(0x8fa8ae), storm * 0.62);
    mistMesh.position.set(
      Math.sin(elapsed * 0.032) * world(2.8),
      Math.sin(elapsed * 0.047 + 0.8) * world(0.65),
      Math.cos(elapsed * 0.026) * world(1.6),
    );
    collectorMaterial.emissiveIntensity = THREE.MathUtils.lerp(0.16, 0.52, storm);
    farMaterial.color.set(0x8299a1).lerp(new THREE.Color(0x536d78), storm * 0.44);
    midMaterial.color.set(0x8da4aa).lerp(new THREE.Color(0x5c7780), storm * 0.4);
    stackMaterial.color.set(0x91a8ad).lerp(new THREE.Color(0x607d84), storm * 0.34);
  };

  group.userData = {
    source: MONSOON_DISTANT_WORLD_SOURCE,
    license: MONSOON_DISTANT_WORLD_LICENSE,
    mapSeed: normalizedSeed,
    deterministic: true,
    collision: false,
    nonCollidable: true,
    assetSourcing: 'Project-original deterministic procedural geometry; no imported assets or sidecar files',
    artDirection: 'Asymmetric storm-carved archipelago, wind-cut shelves, sea stacks, collector forks, and low rain mist',
    sightlinePolicy: 'All geometry remains outside the playable rectangle with low mist and broken sky notches',
    renderBudget: 'Five merged visible batches, zero shadow batches, zero textures, <=35k triangles',
    diagnostics,
  };

  return { group, geometries, materials, textures, colliderBoxes, diagnostics, update };
}
