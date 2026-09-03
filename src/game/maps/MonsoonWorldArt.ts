import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createSeededRandom } from '../../utils/random';
import {
  MONSOON_ROUTE_SEGMENTS,
  MONSOON_WORLD_SCALE,
  sampleMonsoonMeshHeight as sampleMonsoonHeight,
} from './MonsoonDivide';

type AnchorKind = 'fork' | 'crown' | 'arc' | 'split' | 'turbine' | 'comb';

type LocalPlacement = Readonly<{
  position: readonly [number, number, number];
  rotation?: readonly [number, number, number];
  scale?: readonly [number, number, number];
}>;

type AnchorSpec = Readonly<{
  name: string;
  kind: AnchorKind;
  x: number;
  z: number;
  yawOffset: number;
  scale: number;
  collider: readonly [width: number, height: number, depth: number];
  details: ReadonlyArray<LocalPlacement>;
}>;

type AnchorRuntime = Readonly<{
  spec: AnchorSpec;
  matrix: THREE.Matrix4;
  baseY: number;
  scale: number;
}>;

type ColoredGeometryPart = {
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  color: THREE.ColorRepresentation;
};

type SignalPlacement = {
  matrix: THREE.Matrix4;
  color: THREE.ColorRepresentation;
};

export type MonsoonWorldArtDiagnostics = Readonly<{
  seed: number;
  worldScale: number;
  assetStrategy: 'procedural-one-file-kit';
  anchorCount: number;
  anchorNames: readonly string[];
  colliderBoxCount: number;
  instanceCounts: Readonly<{
    structuralDetails: number;
    basaltSpines: number;
    routeBeaconBodies: number;
    routeSignals: number;
    total: number;
  }>;
  basaltLayerCounts: Readonly<{
    near: number;
    mid: number;
    far: number;
  }>;
  visibleMeshCount: number;
  instancedMeshCount: number;
  expectedVisibleDrawCalls: number;
  expectedShadowDrawCalls: number;
  expectedDrawCalls: number;
  geometryCount: number;
  materialCount: number;
  textureCount: number;
  estimatedVisibleTriangles: number;
}>;

export type MonsoonWorldArtBuild = {
  group: THREE.Group;
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
  textures: THREE.Texture[];
  colliderBoxes: THREE.Box3[];
  diagnostics: MonsoonWorldArtDiagnostics;
};

const BODY_PRIMARY = 0x2b414b;
const BODY_SECONDARY = 0x536b76;
const BODY_CONTACT = 0x17262e;
const BODY_STORMWASH = 0x8799a2;
const CYAN_SIGNAL = 0x43e6ff;
const AMBER_SIGNAL = 0xffb13d;
const IDENTITY_MATRIX = new THREE.Matrix4();

const ANCHORS: ReadonlyArray<AnchorSpec> = [
  {
    name: 'West Fork Harvester',
    kind: 'fork',
    x: -166,
    z: 91,
    yawOffset: -0.12,
    scale: 1.05,
    collider: [7.1, 25, 6.1],
    details: [
      { position: [-2.8, 15.5, 2.2], rotation: [0.08, 0.2, -0.24], scale: [1.2, 1.8, 1] },
      { position: [2.5, 19.2, 2], rotation: [-0.05, -0.16, 0.19], scale: [0.9, 1.45, 0.85] },
      { position: [0.2, 9.2, -2.6], rotation: [0.18, Math.PI, 0], scale: [1.45, 0.8, 1] },
    ],
  },
  {
    name: 'North Crown Relay',
    kind: 'crown',
    x: -43,
    z: 148,
    yawOffset: 0.18,
    scale: 0.94,
    collider: [6.4, 28, 6.4],
    details: [
      { position: [0, 25.8, 3.6], rotation: [0.08, 0, 0], scale: [1.5, 2.1, 1] },
      { position: [-3.15, 24.8, -1.7], rotation: [0.06, -2.1, -0.2], scale: [1.25, 1.7, 0.9] },
      { position: [3.05, 23.7, -1.85], rotation: [-0.04, 2.08, 0.18], scale: [1.05, 1.45, 0.9] },
      { position: [0, 12, -2.55], rotation: [0.15, Math.PI, 0], scale: [1.3, 0.72, 1] },
    ],
  },
  {
    name: 'Northeast Arc Vane',
    kind: 'arc',
    x: 103,
    z: 125,
    yawOffset: -0.28,
    scale: 1.28,
    collider: [7.2, 18, 6.2],
    details: [
      { position: [-7.4, 18.5, 1.5], rotation: [0.05, -0.24, -0.62], scale: [1.15, 2.1, 1] },
      { position: [6.5, 19.7, 1], rotation: [-0.04, 0.34, 0.52], scale: [0.95, 1.6, 0.85] },
      { position: [0, 8.8, -2.8], rotation: [0.2, Math.PI, 0], scale: [1.35, 0.75, 1] },
    ],
  },
  {
    name: 'East Split Relay',
    kind: 'split',
    x: 158,
    z: 78,
    yawOffset: 0.1,
    scale: 1.08,
    collider: [8, 26, 6.4],
    details: [
      { position: [-3.4, 20.2, 2.35], rotation: [0.08, 0.1, -0.14], scale: [1.1, 1.55, 0.9] },
      { position: [3.1, 15.4, 2.45], rotation: [-0.05, -0.14, 0.18], scale: [0.9, 1.25, 0.8] },
      { position: [-0.8, 8.2, -2.7], rotation: [0.16, Math.PI, 0], scale: [1.5, 0.76, 1] },
    ],
  },
  {
    name: 'Southeast Turbine Harvester',
    kind: 'turbine',
    x: 150,
    z: -108,
    yawOffset: -0.16,
    scale: 0.98,
    collider: [7.4, 25, 6.3],
    details: [
      { position: [10.8, 22.1, 1.8], rotation: [0, 0.15, Math.PI * 0.5], scale: [1.35, 1.95, 1] },
      { position: [9.9, 22.1, -1.8], rotation: [0, Math.PI - 0.15, -Math.PI * 0.5], scale: [1.1, 1.65, 0.9] },
      { position: [-2.6, 15.4, 1.9], rotation: [0.04, -0.45, -0.2], scale: [1, 1.4, 0.9] },
      { position: [0, 8.5, -2.65], rotation: [0.18, Math.PI, 0], scale: [1.4, 0.72, 1] },
    ],
  },
  {
    name: 'Southwest Lightning Comb',
    kind: 'comb',
    x: -148,
    z: -112,
    yawOffset: 0.24,
    scale: 1.02,
    collider: [8.6, 21, 6.8],
    details: [
      { position: [-5.2, 16.8, 1.8], rotation: [0.06, 0.1, -0.22], scale: [1, 1.45, 0.9] },
      { position: [-0.5, 20.2, 2], rotation: [-0.04, -0.12, 0.08], scale: [1.1, 1.8, 1] },
      { position: [4.5, 14.6, 2.1], rotation: [0.04, 0.2, 0.26], scale: [0.9, 1.2, 0.82] },
      { position: [0.4, 7.8, -2.9], rotation: [0.2, Math.PI, 0], scale: [1.55, 0.78, 1] },
    ],
  },
] as const;

const BASALT_RUNS = [
  {
    layer: 'near' as const,
    count: 4,
    points: [[-111, 52], [-137, 42], [-151, 17]] as ReadonlyArray<readonly [number, number]>,
    height: [4.5, 7.5] as const,
  },
  {
    layer: 'near' as const,
    count: 4,
    points: [[114, -48], [139, -59], [155, -82]] as ReadonlyArray<readonly [number, number]>,
    height: [4.2, 7.2] as const,
  },
  {
    layer: 'mid' as const,
    count: 7,
    points: [[-188, -112], [-160, -78], [-145, -28], [-153, 32], [-178, 99]] as ReadonlyArray<readonly [number, number]>,
    height: [6.5, 11] as const,
  },
  {
    layer: 'mid' as const,
    count: 7,
    points: [[171, 78], [145, 19], [153, -43], [181, -110]] as ReadonlyArray<readonly [number, number]>,
    height: [6.2, 10.5] as const,
  },
  {
    layer: 'far' as const,
    count: 8,
    points: [[-121, 126], [-55, 149], [48, 151], [103, 125]] as ReadonlyArray<readonly [number, number]>,
    height: [8, 13.5] as const,
  },
  {
    layer: 'far' as const,
    count: 9,
    points: [[-174, -104], [-126, -124], [-72, -135], [-18, -141], [39, -132], [91, -137], [151, -118]] as ReadonlyArray<readonly [number, number]>,
    height: [8.5, 14] as const,
  },
] as const;

function world(value: number): number {
  return value * MONSOON_WORLD_SCALE;
}

function transformMatrix(
  position: readonly [number, number, number],
  rotation: readonly [number, number, number] = [0, 0, 0],
  scale: readonly [number, number, number] = [1, 1, 1],
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(world(position[0]), world(position[1]), world(position[2])),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2])),
    new THREE.Vector3(scale[0], scale[1], scale[2]),
  );
}

function placedMatrix(
  x: number,
  y: number,
  z: number,
  yaw: number,
  scale = 1,
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
    new THREE.Vector3(scale, scale, scale),
  );
}

function createTaperedPrismGeometry(
  width: number,
  depth: number,
  height: number,
  topScaleX = 0.65,
  topScaleZ = 0.65,
  topOffsetX = 0,
  topOffsetZ = 0,
): THREE.BufferGeometry {
  const halfWidth = world(width) * 0.5;
  const halfDepth = world(depth) * 0.5;
  const y = world(height);
  const topHalfWidth = halfWidth * topScaleX;
  const topHalfDepth = halfDepth * topScaleZ;
  const offsetX = world(topOffsetX);
  const offsetZ = world(topOffsetZ);
  const positions = new Float32Array([
    -halfWidth, 0, -halfDepth,
    halfWidth, 0, -halfDepth,
    halfWidth, 0, halfDepth,
    -halfWidth, 0, halfDepth,
    offsetX - topHalfWidth, y, offsetZ - topHalfDepth,
    offsetX + topHalfWidth, y, offsetZ - topHalfDepth,
    offsetX + topHalfWidth, y, offsetZ + topHalfDepth,
    offsetX - topHalfWidth, y, offsetZ + topHalfDepth,
  ]);
  const indices = [
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createChamferedBlockGeometry(
  width: number,
  height: number,
  depth: number,
  chamfer: number,
): THREE.BufferGeometry {
  const halfWidth = world(width) * 0.5;
  const h = world(height);
  const c = Math.min(world(chamfer), halfWidth * 0.45, h * 0.45);
  const shape = new THREE.Shape();
  shape.moveTo(-halfWidth + c, 0);
  shape.lineTo(halfWidth - c, 0);
  shape.lineTo(halfWidth, c);
  shape.lineTo(halfWidth, h - c);
  shape.lineTo(halfWidth - c, h);
  shape.lineTo(-halfWidth + c, h);
  shape.lineTo(-halfWidth, h - c);
  shape.lineTo(-halfWidth, c);
  shape.closePath();
  const bevel = Math.max(world(0.04), c * 0.22);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: world(depth),
    steps: 1,
    curveSegments: 1,
    bevelEnabled: true,
    bevelSegments: 1,
    bevelSize: bevel,
    bevelThickness: bevel,
  });
  geometry.translate(0, 0, -world(depth) * 0.5);
  return geometry;
}

function createExtrudedShapeGeometry(
  points: ReadonlyArray<readonly [number, number]>,
  depth: number,
  bevel = 0.08,
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  points.forEach(([x, y], index) => {
    if (index === 0) shape.moveTo(world(x), world(y));
    else shape.lineTo(world(x), world(y));
  });
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: world(depth),
    steps: 1,
    curveSegments: 1,
    bevelEnabled: bevel > 0,
    bevelSegments: 1,
    bevelSize: world(bevel),
    bevelThickness: world(bevel),
  });
  geometry.translate(0, 0, -world(depth) * 0.5);
  return geometry;
}

function mergeColoredParts(parts: ColoredGeometryPart[], name: string): THREE.BufferGeometry {
  const prepared = parts.map((part) => {
    const geometry = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone();
    part.geometry.dispose();
    for (const attribute of Object.keys(geometry.attributes)) {
      if (attribute !== 'position' && attribute !== 'normal') geometry.deleteAttribute(attribute);
    }
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    geometry.applyMatrix4(part.matrix);
    const color = new THREE.Color(part.color);
    const vertexCount = geometry.getAttribute('position').count;
    const colors = new Float32Array(vertexCount * 3);
    for (let index = 0; index < vertexCount; index += 1) {
      colors[index * 3] = color.r;
      colors[index * 3 + 1] = color.g;
      colors[index * 3 + 2] = color.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
  });
  const merged = mergeGeometries(prepared, false);
  for (const geometry of prepared) geometry.dispose();
  if (!merged) throw new Error(`Failed to merge ${name}.`);
  merged.name = name;
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

function addAnchorPart(
  parts: ColoredGeometryPart[],
  anchorMatrix: THREE.Matrix4,
  geometry: THREE.BufferGeometry,
  position: readonly [number, number, number],
  color: THREE.ColorRepresentation,
  rotation: readonly [number, number, number] = [0, 0, 0],
  scale: readonly [number, number, number] = [1, 1, 1],
): void {
  parts.push({
    geometry,
    matrix: anchorMatrix.clone().multiply(transformMatrix(position, rotation, scale)),
    color,
  });
}

function anchorTerrainHeight(
  x: number,
  z: number,
  seed: number,
): number {
  // Ridge anchors are deliberate skyline objects. Seating to the lowest
  // footprint corner buried cliff-edge silhouettes by tens of metres; the
  // exact center triangle is the authored support and the broad dark plinth
  // visually bridges small crossfall around it.
  return sampleMonsoonHeight(world(x), world(z), seed) - world(0.22);
}

function createAnchorRuntimes(seed: number): AnchorRuntime[] {
  const random = createSeededRandom((seed ^ 0x77726c64) >>> 0);
  return ANCHORS.map((spec) => {
    const scale = spec.scale * (0.98 + random() * 0.04);
    const baseY = anchorTerrainHeight(spec.x, spec.z, seed);
    const heading = Math.atan2(-spec.x, -spec.z) + spec.yawOffset + (random() - 0.5) * 0.055;
    return {
      spec,
      matrix: placedMatrix(world(spec.x), baseY, world(spec.z), heading, scale),
      baseY,
      scale,
    };
  });
}

function addCommonAnchorFoundation(parts: ColoredGeometryPart[], anchor: AnchorRuntime): void {
  addAnchorPart(
    parts,
    anchor.matrix,
    createChamferedBlockGeometry(9.4, 2.4, 7.8, 0.7),
    [0, 0, 0],
    BODY_CONTACT,
  );
  addAnchorPart(
    parts,
    anchor.matrix,
    createTaperedPrismGeometry(7.2, 6.2, 4, 0.82, 0.76, 0.45, -0.12),
    [0, 1.8, 0],
    BODY_SECONDARY,
  );
  addAnchorPart(
    parts,
    anchor.matrix,
    createExtrudedShapeGeometry([[-4.4, 0], [4.4, 0], [3.2, 1.1], [-3.7, 0.72]], 0.72, 0.12),
    [0, 1, 4.15],
    BODY_STORMWASH,
    [-Math.PI * 0.5, 0, 0],
  );
}

function addForkAnchor(parts: ColoredGeometryPart[], anchor: AnchorRuntime): void {
  addAnchorPart(parts, anchor.matrix, createTaperedPrismGeometry(4.2, 4.5, 18, 0.5, 0.58, 0.8, -0.2), [0, 5.2, 0], BODY_PRIMARY);
  addAnchorPart(parts, anchor.matrix, createTaperedPrismGeometry(2.4, 2.7, 19.5, 0.32, 0.46, -0.7, 0.2), [-3.25, 14.1, 0.1], BODY_SECONDARY, [0.03, -0.08, -0.17]);
  addAnchorPart(parts, anchor.matrix, createTaperedPrismGeometry(1.9, 2.35, 23, 0.25, 0.4, 0.9, -0.25), [3.05, 12.4, -0.15], BODY_PRIMARY, [-0.02, 0.12, 0.13]);
  addAnchorPart(parts, anchor.matrix, createChamferedBlockGeometry(8.2, 1.55, 2, 0.38), [0.2, 22.8, 0], BODY_STORMWASH, [0, 0.04, -0.06]);
}

function addCrownAnchor(parts: ColoredGeometryPart[], anchor: AnchorRuntime): void {
  addAnchorPart(parts, anchor.matrix, createTaperedPrismGeometry(5.2, 5.2, 25, 0.4, 0.4, -0.35, 0.25), [0, 5.2, 0], BODY_PRIMARY, [0.02, 0, -0.025]);
  addAnchorPart(parts, anchor.matrix, new THREE.CylinderGeometry(world(4.8), world(3.3), world(2.6), 7, 1), [0, 27.6, 0], BODY_SECONDARY, [0, 0.18, 0]);
  addAnchorPart(parts, anchor.matrix, new THREE.TorusGeometry(world(5), world(0.52), 5, 18), [0, 29.1, 0], BODY_STORMWASH, [Math.PI * 0.5, 0.1, 0]);
  addAnchorPart(parts, anchor.matrix, createTaperedPrismGeometry(2.1, 2.1, 5.2, 0.15, 0.15, 0.2, -0.2), [0, 28.5, 0], BODY_PRIMARY);
}

function addArcAnchor(parts: ColoredGeometryPart[], anchor: AnchorRuntime): void {
  addAnchorPart(parts, anchor.matrix, createTaperedPrismGeometry(5.8, 5, 14, 0.58, 0.5, 0.55, 0), [0, 5, 0], BODY_PRIMARY, [0.02, 0, -0.04]);
  addAnchorPart(parts, anchor.matrix, new THREE.TorusGeometry(world(9), world(1.05), 6, 28, Math.PI * 1.42), [0, 17.5, 0], BODY_SECONDARY, [0, 0, -Math.PI * 0.71]);
  addAnchorPart(parts, anchor.matrix, createExtrudedShapeGeometry([[-1.7, 0], [1.7, 0], [0.85, 7.5], [-0.4, 10.5], [-1.15, 6]], 2.2, 0.18), [7.1, 13.8, 0], BODY_STORMWASH, [0, 0.08, 0.42]);
  addAnchorPart(parts, anchor.matrix, createChamferedBlockGeometry(8.5, 1.6, 2.2, 0.35), [0, 9.7, 0], BODY_CONTACT, [0, 0, 0.12]);
}

function addSplitAnchor(parts: ColoredGeometryPart[], anchor: AnchorRuntime): void {
  addAnchorPart(parts, anchor.matrix, createTaperedPrismGeometry(3.8, 4.8, 27, 0.36, 0.55, -1.05, 0.2), [-2.6, 4.8, 0], BODY_PRIMARY, [0.015, -0.1, -0.08]);
  addAnchorPart(parts, anchor.matrix, createTaperedPrismGeometry(4.3, 4.1, 21, 0.46, 0.44, 0.8, -0.2), [2.8, 5, -0.15], BODY_SECONDARY, [-0.02, 0.14, 0.1]);
  addAnchorPart(parts, anchor.matrix, createChamferedBlockGeometry(7.6, 1.5, 2.1, 0.34), [0.2, 16.2, 0.2], BODY_STORMWASH, [0, 0, 0.07]);
  addAnchorPart(parts, anchor.matrix, createExtrudedShapeGeometry([[-2.6, 0], [2.6, 0], [1.3, 3.2], [-1.8, 2.4]], 1.7, 0.14), [0.8, 24.1, -0.1], BODY_PRIMARY, [0, 0.12, -0.05]);
}

function addTurbineAnchor(parts: ColoredGeometryPart[], anchor: AnchorRuntime): void {
  addAnchorPart(parts, anchor.matrix, createTaperedPrismGeometry(5.1, 5.5, 23, 0.42, 0.46, -0.6, 0.2), [0, 5.1, 0], BODY_PRIMARY, [0, -0.04, 0.025]);
  addAnchorPart(parts, anchor.matrix, createChamferedBlockGeometry(15.5, 2.4, 2.8, 0.5), [4.4, 21.4, 0], BODY_SECONDARY, [0, 0.035, -0.035]);
  addAnchorPart(parts, anchor.matrix, new THREE.CylinderGeometry(world(4.2), world(3.5), world(3.3), 10, 1), [10.3, 22.6, 0], BODY_STORMWASH, [Math.PI * 0.5, 0, Math.PI * 0.5]);
  addAnchorPart(parts, anchor.matrix, new THREE.TorusGeometry(world(3.15), world(0.62), 6, 16), [10.3, 22.6, 1.75], BODY_CONTACT, [0, 0, 0]);
  addAnchorPart(parts, anchor.matrix, createExtrudedShapeGeometry([[-1.1, 0], [1.1, 0], [0.6, 7.4], [-0.4, 9.6]], 1.5, 0.12), [-4.3, 14.1, 0], BODY_SECONDARY, [0, 0.12, -0.28]);
}

function addCombAnchor(parts: ColoredGeometryPart[], anchor: AnchorRuntime): void {
  addAnchorPart(parts, anchor.matrix, createExtrudedShapeGeometry([[-5.6, 0], [5.7, 0], [4.8, 5.6], [-3.2, 12.5], [-5.3, 8]], 4.3, 0.3), [0, 4.5, 0], BODY_PRIMARY, [0, -0.08, 0]);
  addAnchorPart(parts, anchor.matrix, createTaperedPrismGeometry(2.5, 2.2, 15.5, 0.25, 0.4, -0.5, 0), [-4.3, 11.4, 0], BODY_SECONDARY, [0, 0, -0.19]);
  addAnchorPart(parts, anchor.matrix, createTaperedPrismGeometry(2.2, 2.1, 21, 0.2, 0.38, 0.35, -0.2), [-0.2, 10.6, 0], BODY_STORMWASH, [0.02, 0.1, 0.055]);
  addAnchorPart(parts, anchor.matrix, createTaperedPrismGeometry(1.8, 1.9, 13.2, 0.18, 0.34, 0.6, 0.15), [4, 10.8, 0], BODY_SECONDARY, [-0.02, -0.12, 0.2]);
  addAnchorPart(parts, anchor.matrix, createChamferedBlockGeometry(11.5, 1.35, 1.8, 0.3), [0, 18.2, 0], BODY_CONTACT, [0, 0.04, 0.09]);
}

function addStormwallCollectorComplex(parts: ColoredGeometryPart[], seed: number): void {
  const towers = [
    { x: 110, z: 75, width: 9.4, depth: 7.2, height: 49, lean: -0.35 },
    { x: 109, z: 93, width: 9.4, depth: 7.2, height: 37, lean: 0.28 },
    { x: 109, z: 81, width: 9.6, depth: 7.2, height: 53, lean: 0.18 },
    { x: 110.5, z: 52, width: 6.2, depth: 6.2, height: 37, lean: -0.22 },
  ] as const;
  const bases = towers.map((tower) => sampleMonsoonHeight(world(tower.x), world(tower.z), seed) - world(0.18));
  towers.forEach((tower, index) => {
    const root = placedMatrix(world(tower.x), bases[index], world(tower.z), 0.03 * (index - 1.5));
    addAnchorPart(
      parts,
      root,
      createTaperedPrismGeometry(tower.width, tower.depth, tower.height, 0.91, 0.88, tower.lean, -0.12),
      [0, 0, 0],
      index % 2 === 0 ? BODY_PRIMARY : BODY_SECONDARY,
    );
    addAnchorPart(
      parts,
      root,
      createExtrudedShapeGeometry([
        [-tower.width * 0.56, 0],
        [tower.width * 0.56, 0],
        [tower.width * 0.42, 1.15],
        [-tower.width * 0.46, 0.78],
      ], 0.78, 0.1),
      [0, tower.height * 0.34, tower.depth * 0.52],
      BODY_STORMWASH,
      [-Math.PI * 0.5, 0, 0],
    );
    addAnchorPart(
      parts,
      root,
      createChamferedBlockGeometry(tower.width * 1.22, 1.1, tower.depth * 1.15, 0.32),
      [0, tower.height * 0.68, 0],
      BODY_CONTACT,
      [0, 0.02 * index, index % 2 === 0 ? 0.035 : -0.035],
    );
  });

  const bridgeBaseY = Math.max(bases[0], bases[1], bases[2]);
  const bridgeRoot = placedMatrix(world(109.3), bridgeBaseY, world(84), 0);
  addAnchorPart(
    parts,
    bridgeRoot,
    createExtrudedShapeGeometry([
      [-5.4, 0], [5.4, 0], [4.6, 1.2], [1.2, 1.6], [0, 3.1], [-1.2, 1.6], [-4.6, 1.2],
    ], 20.5, 0.16),
    [0, 31, 0],
    BODY_SECONDARY,
    [0, Math.PI * 0.5, 0],
  );
  addAnchorPart(
    parts,
    bridgeRoot,
    new THREE.TorusGeometry(world(7.6), world(0.62), 6, 24, Math.PI * 1.28),
    [0, 43, -1.2],
    BODY_STORMWASH,
    [0, 0, -Math.PI * 0.64],
  );
}

function createAnchorShellGeometry(anchors: AnchorRuntime[], seed: number): THREE.BufferGeometry {
  const parts: ColoredGeometryPart[] = [];
  for (const anchor of anchors) {
    addCommonAnchorFoundation(parts, anchor);
    switch (anchor.spec.kind) {
      case 'fork': addForkAnchor(parts, anchor); break;
      case 'crown': addCrownAnchor(parts, anchor); break;
      case 'arc': addArcAnchor(parts, anchor); break;
      case 'split': addSplitAnchor(parts, anchor); break;
      case 'turbine': addTurbineAnchor(parts, anchor); break;
      case 'comb': addCombAnchor(parts, anchor); break;
    }
  }
  addStormwallCollectorComplex(parts, seed);
  return mergeColoredParts(parts, 'MonsoonWorldArtAnchorShells');
}

function createStructuralDetailGeometry(): THREE.BufferGeometry {
  const geometry = createExtrudedShapeGeometry([
    [-0.55, 0], [0.55, 0], [0.46, 2.9], [0.12, 4.2], [-0.34, 3.35],
  ], 0.52, 0.09);
  geometry.name = 'MonsoonWorldArtStormRib';
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function createBasaltShardGeometry(): THREE.BufferGeometry {
  const sides = 6;
  const positions: number[] = [];
  const bottomRadii = [1, 0.76, 1.08, 0.82, 1.02, 0.7];
  const middleRadii = [0.56, 0.44, 0.58, 0.39, 0.52, 0.43];
  for (let index = 0; index < sides; index += 1) {
    const angle = index / sides * Math.PI * 2;
    positions.push(
      Math.cos(angle) * world(0.72) * bottomRadii[index],
      0,
      Math.sin(angle) * world(0.72) * bottomRadii[index],
    );
  }
  for (let index = 0; index < sides; index += 1) {
    const angle = index / sides * Math.PI * 2 + 0.12;
    positions.push(
      world(0.12) + Math.cos(angle) * world(0.72) * middleRadii[index],
      world(0.64),
      world(-0.07) + Math.sin(angle) * world(0.72) * middleRadii[index],
    );
  }
  positions.push(world(0.31), world(1), world(-0.18));
  positions.push(0, 0, 0);
  const tip = sides * 2;
  const bottomCenter = tip + 1;
  const indices: number[] = [];
  for (let index = 0; index < sides; index += 1) {
    const next = (index + 1) % sides;
    indices.push(index, next, sides + next, index, sides + next, sides + index);
    indices.push(sides + index, sides + next, tip);
    indices.push(bottomCenter, next, index);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.name = 'MonsoonWorldArtFacetedBasaltShard';
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function createBeaconBodyGeometry(): THREE.BufferGeometry {
  return mergeColoredParts([
    {
      geometry: createChamferedBlockGeometry(1.45, 0.42, 1.05, 0.18),
      matrix: IDENTITY_MATRIX,
      color: BODY_CONTACT,
    },
    {
      geometry: createTaperedPrismGeometry(0.72, 0.62, 1.75, 0.64, 0.72, 0.08, 0.06),
      matrix: transformMatrix([0, 0.34, 0]),
      color: BODY_PRIMARY,
    },
    {
      geometry: createChamferedBlockGeometry(1.12, 0.5, 0.7, 0.16),
      matrix: transformMatrix([0, 1.92, 0.14], [-0.16, 0, 0]),
      color: BODY_STORMWASH,
    },
    {
      geometry: createExtrudedShapeGeometry([[-0.42, 0], [0.42, 0], [0.22, 0.8], [-0.18, 1.08]], 0.28, 0.04),
      matrix: transformMatrix([0, 0.82, -0.43], [0.08, Math.PI, 0]),
      color: BODY_SECONDARY,
    },
  ], 'MonsoonWorldArtRouteBeaconBody');
}

function createChevronGeometry(): THREE.BufferGeometry {
  const geometry = createExtrudedShapeGeometry([
    [-0.68, -0.55], [0, -0.08], [0.68, -0.55], [0.68, -0.08],
    [0, 0.48], [-0.68, -0.08],
  ], 0.09, 0.035);
  geometry.name = 'MonsoonWorldArtRouteChevron';
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function samplePolyline(
  points: ReadonlyArray<readonly [number, number]>,
  t: number,
): { x: number; z: number; tangentX: number; tangentZ: number } {
  const lengths: number[] = [];
  let total = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const length = Math.hypot(points[index + 1][0] - points[index][0], points[index + 1][1] - points[index][1]);
    lengths.push(length);
    total += length;
  }
  let remaining = THREE.MathUtils.clamp(t, 0, 1) * total;
  for (let index = 0; index < lengths.length; index += 1) {
    if (remaining <= lengths[index] || index === lengths.length - 1) {
      const segmentT = lengths[index] > 0 ? remaining / lengths[index] : 0;
      const [ax, az] = points[index];
      const [bx, bz] = points[index + 1];
      const inverseLength = lengths[index] > 0 ? 1 / lengths[index] : 0;
      return {
        x: THREE.MathUtils.lerp(ax, bx, segmentT),
        z: THREE.MathUtils.lerp(az, bz, segmentT),
        tangentX: (bx - ax) * inverseLength,
        tangentZ: (bz - az) * inverseLength,
      };
    }
    remaining -= lengths[index];
  }
  const [x, z] = points[points.length - 1];
  return { x, z, tangentX: 0, tangentZ: 1 };
}

function setStaticBounds(mesh: THREE.InstancedMesh): void {
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingBox();
  mesh.computeBoundingSphere();
}

function geometryTriangleCount(geometry: THREE.BufferGeometry): number {
  return (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;
}

export function buildMonsoonWorldArt(seed: number): MonsoonWorldArtBuild {
  const normalizedSeed = seed >>> 0;
  const group = new THREE.Group();
  group.name = 'MonsoonDivideWorldArt';

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];
  const colliderBoxes: THREE.Box3[] = [];
  const anchors = createAnchorRuntimes(normalizedSeed);

  const anchorShellGeometry = createAnchorShellGeometry(anchors, normalizedSeed);
  const structuralDetailGeometry = createStructuralDetailGeometry();
  const basaltGeometry = createBasaltShardGeometry();
  const beaconGeometry = createBeaconBodyGeometry();
  const signalGeometry = createChevronGeometry();
  geometries.push(anchorShellGeometry, structuralDetailGeometry, basaltGeometry, beaconGeometry, signalGeometry);

  const anchorMaterial = new THREE.MeshPhysicalMaterial({
    clearcoat: 0.42,
    clearcoatRoughness: 0.3,
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.46,
    metalness: 0.48,
  });
  anchorMaterial.name = 'MonsoonWorldArtWetHarvesterShell';
  const structuralMaterial = new THREE.MeshPhysicalMaterial({
    clearcoat: 0.5,
    clearcoatRoughness: 0.22,
    color: 0x93a8b0,
    roughness: 0.28,
    metalness: 0.82,
  });
  structuralMaterial.name = 'MonsoonWorldArtConductiveTrim';
  const basaltMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0.035,
    flatShading: true,
  });
  basaltMaterial.name = 'MonsoonWorldArtStormbreakBasalt';
  const beaconMaterial = new THREE.MeshPhysicalMaterial({
    clearcoat: 0.34,
    clearcoatRoughness: 0.28,
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.52,
    metalness: 0.6,
  });
  beaconMaterial.name = 'MonsoonWorldArtRouteBeaconShell';
  const signalMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  signalMaterial.name = 'MonsoonWorldArtCyanAmberSignal';
  materials.push(anchorMaterial, structuralMaterial, basaltMaterial, beaconMaterial, signalMaterial);

  const anchorShells = new THREE.Mesh(anchorShellGeometry, anchorMaterial);
  anchorShells.name = 'Monsoon silhouette-distinct harvester anchor shells';
  anchorShells.castShadow = true;
  anchorShells.receiveShadow = true;
  anchorShells.userData.layer = 'outer-ridge-anchors';
  group.add(anchorShells);

  const detailMatrices: THREE.Matrix4[] = [];
  for (const anchor of anchors) {
    for (const detail of anchor.spec.details) {
      detailMatrices.push(anchor.matrix.clone().multiply(transformMatrix(
        detail.position,
        detail.rotation,
        detail.scale,
      )));
    }
    const [width, height, depth] = anchor.spec.collider;
    const halfWidth = world(width * anchor.scale * 0.5);
    const halfDepth = world(depth * anchor.scale * 0.5);
    const minimumY = anchor.baseY + world(0.18 * anchor.scale);
    colliderBoxes.push(new THREE.Box3(
      new THREE.Vector3(world(anchor.spec.x) - halfWidth, minimumY, world(anchor.spec.z) - halfDepth),
      new THREE.Vector3(
        world(anchor.spec.x) + halfWidth,
        anchor.baseY + world(height * anchor.scale),
        world(anchor.spec.z) + halfDepth,
      ),
    ));
  }
  const structuralDetails = new THREE.InstancedMesh(
    structuralDetailGeometry,
    structuralMaterial,
    detailMatrices.length,
  );
  structuralDetails.name = 'Monsoon instanced conductive vanes and storm ribs';
  detailMatrices.forEach((matrix, index) => structuralDetails.setMatrixAt(index, matrix));
  structuralDetails.castShadow = false;
  structuralDetails.receiveShadow = true;
  structuralDetails.userData.layer = 'anchor-secondary-tertiary';
  setStaticBounds(structuralDetails);
  group.add(structuralDetails);

  const basaltRandom = createSeededRandom((normalizedSeed ^ 0xba5a17) >>> 0);
  const basaltPlacements: Array<{ matrix: THREE.Matrix4; color: THREE.Color }> = [];
  const basaltLayerCounts = { near: 0, mid: 0, far: 0 };
  const basaltDark = new THREE.Color(0x1c2c34);
  const basaltLight = new THREE.Color(0x405866);
  for (const run of BASALT_RUNS) {
    for (let index = 0; index < run.count; index += 1) {
      const t = (index + 0.38 + basaltRandom() * 0.24) / run.count;
      const point = samplePolyline(run.points, t);
      const lateralJitter = (basaltRandom() - 0.5) * (run.layer === 'near' ? 5 : 8);
      const x = point.x - point.tangentZ * lateralJitter;
      const z = point.z + point.tangentX * lateralJitter;
      const terrainY = sampleMonsoonHeight(world(x), world(z), normalizedSeed);
      const height = THREE.MathUtils.lerp(run.height[0], run.height[1], basaltRandom());
      const width = (run.layer === 'far' ? 4.6 : 3.7) + basaltRandom() * 2.8;
      const depth = width * (0.58 + basaltRandom() * 0.34);
      const yaw = Math.atan2(point.tangentX, point.tangentZ) + (basaltRandom() - 0.5) * 0.72;
      const matrix = new THREE.Matrix4().compose(
        new THREE.Vector3(world(x), terrainY - world(0.05), world(z)),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(
          (basaltRandom() - 0.5) * 0.08,
          yaw,
          (basaltRandom() - 0.5) * 0.24,
        )),
        new THREE.Vector3(width, height, depth),
      );
      basaltPlacements.push({
        matrix,
        color: basaltDark.clone().lerp(basaltLight, 0.18 + basaltRandom() * 0.58),
      });
      basaltLayerCounts[run.layer] += 1;
    }
  }
  const basaltSpines = new THREE.InstancedMesh(basaltGeometry, basaltMaterial, basaltPlacements.length);
  basaltSpines.name = 'Monsoon instanced asymmetrical basalt stormbreak spines';
  basaltPlacements.forEach((placement, index) => {
    basaltSpines.setMatrixAt(index, placement.matrix);
    basaltSpines.setColorAt(index, placement.color);
  });
  basaltSpines.castShadow = true;
  basaltSpines.receiveShadow = true;
  basaltSpines.userData.layerCounts = basaltLayerCounts;
  setStaticBounds(basaltSpines);
  group.add(basaltSpines);

  const routeRandom = createSeededRandom((normalizedSeed ^ 0xc7a4beac) >>> 0);
  const beaconMatrices: THREE.Matrix4[] = [];
  const signalPlacements: SignalPlacement[] = [];
  const routeSamples = [0.16, 0.39, 0.63, 0.86] as const;
  MONSOON_ROUTE_SEGMENTS.forEach(([ax, az, bx, bz], segmentIndex) => {
    const dx = bx - ax;
    const dz = bz - az;
    const length = Math.hypot(dx, dz) || 1;
    const forwardX = dx / length;
    const forwardZ = dz / length;
    const heading = Math.atan2(forwardX, forwardZ);
    const signalColor = segmentIndex % 2 === 0 ? CYAN_SIGNAL : AMBER_SIGNAL;
    routeSamples.forEach((t, sampleIndex) => {
      const side = (segmentIndex + sampleIndex) % 2 === 0 ? -1 : 1;
      const offset = side * (11.5 + routeRandom() * 2.5);
      const x = THREE.MathUtils.lerp(ax, bx, t) - forwardZ * offset;
      const z = THREE.MathUtils.lerp(az, bz, t) + forwardX * offset;
      const baseY = sampleMonsoonHeight(world(x), world(z), normalizedSeed) - world(0.1);
      const scale = 0.9 + routeRandom() * 0.16;
      const bodyMatrix = placedMatrix(world(x), baseY, world(z), heading, scale);
      beaconMatrices.push(bodyMatrix);
      signalPlacements.push({
        matrix: bodyMatrix.clone().multiply(transformMatrix([0, 2.08, 0.38], [0, 0, 0], [0.56, 0.56, 0.56])),
        color: signalColor,
      });
      signalPlacements.push({
        matrix: placedMatrix(world(x), baseY + world(0.19), world(z), heading, scale)
          .multiply(transformMatrix([0, 0, 1.6], [Math.PI * 0.5, 0, 0], [0.82, 0.82, 0.82])),
        color: signalColor,
      });
    });
  });
  anchors.forEach((anchor, anchorIndex) => {
    const color = anchorIndex % 2 === 0 ? CYAN_SIGNAL : AMBER_SIGNAL;
    signalPlacements.push({
      matrix: anchor.matrix.clone().multiply(transformMatrix([0, 7.4, 3.95], [0, 0, 0], [1.15, 1.15, 1.15])),
      color,
    });
    signalPlacements.push({
      matrix: anchor.matrix.clone().multiply(transformMatrix([0, 12.2, 3.2], [0, 0, Math.PI], [0.72, 0.72, 0.72])),
      color,
    });
  });

  const routeBeacons = new THREE.InstancedMesh(beaconGeometry, beaconMaterial, beaconMatrices.length);
  routeBeacons.name = 'Monsoon instanced compact route beacon housings';
  beaconMatrices.forEach((matrix, index) => routeBeacons.setMatrixAt(index, matrix));
  routeBeacons.castShadow = false;
  routeBeacons.receiveShadow = true;
  routeBeacons.userData.nonCollidable = true;
  setStaticBounds(routeBeacons);
  group.add(routeBeacons);

  const routeSignals = new THREE.InstancedMesh(signalGeometry, signalMaterial, signalPlacements.length);
  routeSignals.name = 'Monsoon instanced cyan and amber route chevrons';
  signalPlacements.forEach((placement, index) => {
    routeSignals.setMatrixAt(index, placement.matrix);
    routeSignals.setColorAt(index, new THREE.Color(placement.color));
  });
  routeSignals.castShadow = false;
  routeSignals.receiveShadow = false;
  routeSignals.renderOrder = 2;
  routeSignals.userData.nonCollidable = true;
  setStaticBounds(routeSignals);
  group.add(routeSignals);

  const estimatedVisibleTriangles = Math.round(
    geometryTriangleCount(anchorShellGeometry)
    + geometryTriangleCount(structuralDetailGeometry) * detailMatrices.length
    + geometryTriangleCount(basaltGeometry) * basaltPlacements.length
    + geometryTriangleCount(beaconGeometry) * beaconMatrices.length
    + geometryTriangleCount(signalGeometry) * signalPlacements.length,
  );
  const totalInstances = detailMatrices.length
    + basaltPlacements.length
    + beaconMatrices.length
    + signalPlacements.length;
  const diagnostics: MonsoonWorldArtDiagnostics = {
    seed: normalizedSeed,
    worldScale: MONSOON_WORLD_SCALE,
    assetStrategy: 'procedural-one-file-kit',
    anchorCount: anchors.length,
    anchorNames: anchors.map((anchor) => anchor.spec.name),
    colliderBoxCount: colliderBoxes.length,
    instanceCounts: {
      structuralDetails: detailMatrices.length,
      basaltSpines: basaltPlacements.length,
      routeBeaconBodies: beaconMatrices.length,
      routeSignals: signalPlacements.length,
      total: totalInstances,
    },
    basaltLayerCounts,
    visibleMeshCount: group.children.length,
    instancedMeshCount: 4,
    expectedVisibleDrawCalls: 5,
    expectedShadowDrawCalls: 2,
    expectedDrawCalls: 7,
    geometryCount: geometries.length,
    materialCount: materials.length,
    textureCount: textures.length,
    estimatedVisibleTriangles,
  };
  group.userData = {
    source: 'Riftline project original procedural Monsoon world-art kit',
    mapSeed: normalizedSeed,
    worldScale: MONSOON_WORLD_SCALE,
    assetSourcing: 'Procedural by explicit one-file/no-sidecar-assets task boundary',
    artDirection: 'Storm-dark authored industrial anchors, fractured basalt scale layers, compact cyan/amber route grammar',
    renderBudget: 'Five visible batches, two silhouette-critical shadow batches, shared resources, no textures',
    diagnostics,
  };

  return { group, geometries, materials, textures, colliderBoxes, diagnostics };
}
