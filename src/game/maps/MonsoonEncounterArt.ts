import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  MONSOON_DIVIDE,
  MONSOON_WORLD_SCALE,
  sampleMonsoonMeshHeight,
} from './MonsoonDivide';

export const MONSOON_ENCOUNTER_ART_SOURCE = 'Riftline project-original procedural Monsoon encounter kit';
export const MONSOON_ENCOUNTER_ART_LICENSE = 'Riftline project original';

export type MonsoonEncounterFamily = 'windbreak' | 'storm-drain' | 'relay-fin';

export type MonsoonEncounterPlacementDiagnostics = Readonly<{
  family: MonsoonEncounterFamily;
  x: number;
  terrainY: number;
  z: number;
  yaw: number;
  scale: number;
  openSkiLineClearance: number;
}>;

export type MonsoonEncounterArtDiagnostics = Readonly<{
  source: typeof MONSOON_ENCOUNTER_ART_SOURCE;
  license: typeof MONSOON_ENCOUNTER_ART_LICENSE;
  seed: number;
  worldScale: number;
  assetStrategy: 'project-original-procedural';
  terrainSampler: 'sampleMonsoonMeshHeight';
  familyCount: number;
  familyNames: readonly MonsoonEncounterFamily[];
  familyLabels: Readonly<Record<MonsoonEncounterFamily, string>>;
  familyInstanceCounts: Readonly<Record<MonsoonEncounterFamily, number>>;
  familyPrototypeTriangles: Readonly<Record<MonsoonEncounterFamily, number>>;
  placementCount: number;
  placements: readonly MonsoonEncounterPlacementDiagnostics[];
  minimumOpenSkiLineClearance: number;
  colliderBoxCount: number;
  visibleMeshCount: number;
  instancedMeshCount: number;
  expectedVisibleDrawCalls: number;
  expectedShadowDrawCalls: number;
  expectedDrawCalls: number;
  geometryCount: number;
  materialCount: number;
  textureCount: number;
  estimatedVisibleTriangles: number;
  addedTriangleBudget: 80_000;
}>;

export type MonsoonEncounterArtBuild = {
  group: THREE.Group;
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
  textures: THREE.Texture[];
  colliderBoxes: THREE.Box3[];
  diagnostics: MonsoonEncounterArtDiagnostics;
};

type PlacementSpec = Readonly<{
  x: number;
  z: number;
  yaw: number;
  scale: number;
}>;

type FamilyDefinition = Readonly<{
  label: string;
  collider: readonly [width: number, height: number, depth: number];
  signalPosition: readonly [number, number, number];
  signalRotation?: readonly [number, number, number];
  signalColor: THREE.ColorRepresentation;
  castShadow: boolean;
}>;

type GeometryPart = Readonly<{
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  color: THREE.ColorRepresentation;
}>;

const FAMILY_ORDER: readonly MonsoonEncounterFamily[] = ['windbreak', 'storm-drain', 'relay-fin'];

const FAMILY_DEFINITIONS: Readonly<Record<MonsoonEncounterFamily, FamilyDefinition>> = {
  windbreak: {
    label: 'ribbed windbreak barricades',
    collider: [10.6, 3.8, 1.2],
    signalPosition: [0.25, 2.18, 1.06],
    signalColor: 0xffbd55,
    castShadow: true,
  },
  'storm-drain': {
    label: 'storm-drain and vent clusters',
    collider: [5.7, 2.2, 4.55],
    signalPosition: [0, 0.68, 3.1],
    signalColor: 0x42e5ff,
    castShadow: false,
  },
  'relay-fin': {
    label: 'low arcing cover and relay fins',
    collider: [8.25, 3.55, 1.2],
    signalPosition: [0, 2.45, 1.02],
    signalColor: 0x63f4d1,
    castShadow: true,
  },
};

// Authored in Monsoon design coordinates. Every center is more than forty
// design metres from the two high-speed cross-island grades below. The broad
// center recovery bowl and its approach/exit vectors therefore remain open.
const FAMILY_PLACEMENTS: Readonly<Record<MonsoonEncounterFamily, readonly PlacementSpec[]>> = {
  windbreak: [
    { x: -176, z: 15, yaw: 0.14, scale: 1.03 },
    { x: 178, z: 5, yaw: -0.2, scale: 0.98 },
    { x: -104, z: 112, yaw: 1.08, scale: 0.96 },
    { x: 42, z: -116, yaw: -1.16, scale: 1.01 },
  ],
  'storm-drain': [
    { x: -46, z: 112, yaw: -0.38, scale: 1.02 },
    { x: 52, z: 116, yaw: 0.31, scale: 0.95 },
    { x: -52, z: -118, yaw: 2.72, scale: 0.98 },
    { x: 0, z: -128, yaw: Math.PI, scale: 1.04 },
  ],
  'relay-fin': [
    { x: -188, z: -8, yaw: Math.PI * 0.48, scale: 1.02 },
    { x: 0, z: 128, yaw: 0.04, scale: 0.97 },
    { x: -120, z: 10, yaw: Math.PI * 0.56, scale: 0.96 },
    { x: 120, z: -10, yaw: -Math.PI * 0.44, scale: 1.03 },
  ],
};

const OPEN_SKI_LINES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [
    [-176, 96], [-160, 82], [-132, 66], [-119, 58], [-88, 39], [-18, 10], [0, 0],
    [17, -10], [76, -61], [103, -77], [125, -91], [150, -108], [160, -118],
  ],
  [
    [174, 82], [158, 70], [138, 61], [116, 45], [88, 42], [18, 8], [0, 0],
    [-17, -10], [-78, -58], [-118, -82], [-132, -90], [-150, -100], [-169, -114],
  ],
];

const BODY_PRIMARY = 0x314751;
const BODY_SECONDARY = 0x68818a;
const BODY_CONTACT = 0x17262d;
const STORM_WASH = 0x9aabb0;
const AMBER_TRIM = 0xc98d39;
const IDENTITY_MATRIX = new THREE.Matrix4();

function world(value: number): number {
  return value * MONSOON_WORLD_SCALE;
}

function localMatrix(
  position: readonly [number, number, number] = [0, 0, 0],
  rotation: readonly [number, number, number] = [0, 0, 0],
  scale: readonly [number, number, number] = [1, 1, 1],
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(world(position[0]), world(position[1]), world(position[2])),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2])),
    new THREE.Vector3(scale[0], scale[1], scale[2]),
  );
}

function extrudeShape(shape: THREE.Shape, depth: number, bevel = 0.08): THREE.BufferGeometry {
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: world(depth),
    steps: 1,
    curveSegments: 3,
    bevelEnabled: bevel > 0,
    bevelSegments: 1,
    bevelSize: world(bevel),
    bevelThickness: world(bevel),
  });
  geometry.translate(0, 0, -world(depth) * 0.5);
  return geometry;
}

function extrudePolygon(
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
  return extrudeShape(shape, depth, bevel);
}

function addPart(
  parts: GeometryPart[],
  geometry: THREE.BufferGeometry,
  color: THREE.ColorRepresentation,
  matrix: THREE.Matrix4 = IDENTITY_MATRIX,
): void {
  parts.push({ geometry, color, matrix });
}

function mergeColoredParts(
  parts: GeometryPart[],
  name: string,
  family?: MonsoonEncounterFamily,
): THREE.BufferGeometry {
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
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      colors[vertex * 3] = color.r;
      colors[vertex * 3 + 1] = color.g;
      colors[vertex * 3 + 2] = color.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
  });
  const merged = mergeGeometries(prepared, false);
  prepared.forEach((geometry) => geometry.dispose());
  if (!merged) throw new Error(`Failed to merge ${name}.`);
  merged.name = name;
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  merged.userData = {
    construction: 'merged-beveled-extrusions',
    family,
    source: MONSOON_ENCOUNTER_ART_SOURCE,
    license: MONSOON_ENCOUNTER_ART_LICENSE,
  };
  return merged;
}

function createWindbreakGeometry(): THREE.BufferGeometry {
  const parts: GeometryPart[] = [];
  const shell = new THREE.Shape();
  shell.moveTo(world(-6), 0);
  shell.lineTo(world(-5.78), world(2.55));
  shell.quadraticCurveTo(world(-4.65), world(3.72), world(-2.7), world(4.08));
  shell.quadraticCurveTo(world(-0.3), world(4.52), world(1.62), world(4.02));
  shell.quadraticCurveTo(world(4.12), world(3.38), world(5.72), world(2.22));
  shell.lineTo(world(6), 0);
  shell.closePath();
  addPart(parts, extrudeShape(shell, 1.08, 0.13), BODY_PRIMARY);

  const ribXs = [-4.85, -2.45, 0, 2.4, 4.72] as const;
  const ribHeights = [3.42, 4.18, 4.52, 3.86, 2.86] as const;
  ribXs.forEach((x, index) => {
    addPart(
      parts,
      extrudePolygon([[-0.24, 0], [0.24, 0], [0.18, ribHeights[index]], [-0.16, ribHeights[index] + 0.22]], 1.72, 0.06),
      STORM_WASH,
      localMatrix([x, 0.04, 0.02], [0, 0, index % 2 === 0 ? -0.018 : 0.018]),
    );
  });

  const railCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(world(-5.7), world(2.78), 0),
    new THREE.Vector3(world(-2.7), world(4.18), 0),
    new THREE.Vector3(world(0.1), world(4.56), 0),
    new THREE.Vector3(world(2.9), world(3.72), 0),
    new THREE.Vector3(world(5.68), world(2.38), 0),
  ], false, 'centripetal', 0.35);
  addPart(parts, new THREE.TubeGeometry(railCurve, 20, world(0.15), 5, false), AMBER_TRIM);

  [-4.35, 0, 4.15].forEach((x) => {
    addPart(
      parts,
      extrudePolygon([[-0.72, 0], [0.72, 0], [0.48, 0.48], [-0.46, 0.48]], 3.05, 0.08),
      BODY_CONTACT,
      localMatrix([x, 0, 0]),
    );
  });
  return mergeColoredParts(parts, 'MonsoonEncounterRibbedWindbreak', 'windbreak');
}

function createVentCowlGeometry(): THREE.BufferGeometry {
  const cowl = new THREE.Shape();
  cowl.moveTo(world(-1.28), 0);
  cowl.lineTo(world(1.28), 0);
  cowl.lineTo(world(1.18), world(0.86));
  cowl.quadraticCurveTo(world(0.84), world(1.95), world(-0.18), world(2.32));
  cowl.quadraticCurveTo(world(-1.13), world(2.18), world(-1.28), world(1.18));
  cowl.closePath();
  return extrudeShape(cowl, 2.1, 0.11);
}

function createStormDrainGeometry(): THREE.BufferGeometry {
  const parts: GeometryPart[] = [];
  addPart(
    parts,
    new THREE.CylinderGeometry(world(3.7), world(4.12), world(0.56), 8, 1, false),
    BODY_CONTACT,
    localMatrix([0, 0.28, 0], [0, Math.PI * 0.125, 0]),
  );

  const cowls = [
    { position: [-2.05, 0.5, -0.42] as const, yaw: 0.16, scale: [0.88, 0.92, 0.86] as const },
    { position: [0.02, 0.5, 0.35] as const, yaw: -0.08, scale: [1.08, 1.08, 1.02] as const },
    { position: [2.18, 0.5, -0.12] as const, yaw: -0.24, scale: [0.82, 0.84, 0.88] as const },
  ];
  cowls.forEach((cowl, cowlIndex) => {
    const cowlMatrix = localMatrix(cowl.position, [0, cowl.yaw, 0], cowl.scale);
    addPart(parts, createVentCowlGeometry(), cowlIndex === 1 ? BODY_SECONDARY : BODY_PRIMARY, cowlMatrix);
    addPart(
      parts,
      extrudePolygon([[-0.73, 0], [0.72, 0], [0.62, 0.72], [-0.45, 0.94], [-0.72, 0.62]], 0.1, 0.025),
      BODY_CONTACT,
      cowlMatrix.clone().multiply(localMatrix([0, 0.78, 1.08])),
    );
    [0.86, 1.1, 1.34].forEach((height) => {
      addPart(
        parts,
        extrudePolygon([[-0.62, 0], [0.62, 0], [0.58, 0.095], [-0.58, 0.095]], 0.14, 0.018),
        STORM_WASH,
        cowlMatrix.clone().multiply(localMatrix([0, height, 1.15])),
      );
    });
  });

  const drainPipe = new THREE.CatmullRomCurve3([
    new THREE.Vector3(world(-2.82), world(0.66), world(-1.72)),
    new THREE.Vector3(world(-1.2), world(0.94), world(-2.05)),
    new THREE.Vector3(world(1.18), world(0.92), world(-2.02)),
    new THREE.Vector3(world(2.92), world(0.64), world(-1.64)),
  ], false, 'centripetal', 0.35);
  addPart(parts, new THREE.TubeGeometry(drainPipe, 14, world(0.14), 5, false), AMBER_TRIM);
  return mergeColoredParts(parts, 'MonsoonEncounterStormDrainCluster', 'storm-drain');
}

function createRelayFinGeometry(): THREE.BufferGeometry {
  const parts: GeometryPart[] = [];
  const arch = new THREE.Shape();
  arch.moveTo(world(-5), 0);
  arch.bezierCurveTo(world(-4.65), world(2.45), world(-2.25), world(4.46), 0, world(4.62));
  arch.bezierCurveTo(world(2.36), world(4.38), world(4.62), world(2.42), world(5), 0);
  arch.closePath();
  const opening = new THREE.Path();
  opening.moveTo(world(3.42), world(0.28));
  opening.bezierCurveTo(world(3.06), world(1.75), world(1.46), world(3.02), 0, world(3.15));
  opening.bezierCurveTo(world(-1.48), world(3.02), world(-3.02), world(1.72), world(-3.42), world(0.28));
  opening.lineTo(world(3.42), world(0.28));
  opening.closePath();
  arch.holes.push(opening);
  addPart(parts, extrudeShape(arch, 1.08, 0.1), BODY_PRIMARY);

  const crownCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(world(-4.72), world(1.58), 0),
    new THREE.Vector3(world(-2.62), world(3.92), 0),
    new THREE.Vector3(0, world(4.72), 0),
    new THREE.Vector3(world(2.7), world(3.82), 0),
    new THREE.Vector3(world(4.72), world(1.5), 0),
  ], false, 'centripetal', 0.35);
  addPart(parts, new THREE.TubeGeometry(crownCurve, 20, world(0.13), 5, false), STORM_WASH);

  addPart(
    parts,
    extrudePolygon([[-0.9, 0], [0.76, 0], [0.38, 5.38], [-0.16, 4.82]], 0.52, 0.07),
    BODY_SECONDARY,
    localMatrix([1.45, 0.18, -0.92], [0, -0.08, -0.04]),
  );
  [-3.72, 3.72].forEach((x, index) => {
    addPart(
      parts,
      extrudePolygon([[-0.74, 0], [0.74, 0], [0.47, 0.52], [-0.48, 0.52]], 3, 0.08),
      BODY_CONTACT,
      localMatrix([x, 0, index === 0 ? -0.12 : 0.12], [0, index === 0 ? 0.08 : -0.08, 0]),
    );
  });
  return mergeColoredParts(parts, 'MonsoonEncounterArcingRelayFin', 'relay-fin');
}

function createSignalGeometry(): THREE.BufferGeometry {
  const geometry = extrudePolygon([
    [-0.82, -0.32], [0, 0.16], [0.82, -0.32], [0.82, 0.2], [0, 0.7], [-0.82, 0.2],
  ], 0.1, 0.035);
  geometry.name = 'MonsoonEncounterSharedSignalChevron';
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData = {
    construction: 'beveled-extruded-signal',
    source: MONSOON_ENCOUNTER_ART_SOURCE,
    license: MONSOON_ENCOUNTER_ART_LICENSE,
  };
  return geometry;
}

function deterministicUnit(seed: number, salt: number): number {
  let value = (seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97) >>> 0;
  return ((value ^ (value >>> 15)) >>> 0) / 4_294_967_296;
}

function distanceToSegment(
  x: number,
  z: number,
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const lengthSquared = dx * dx + dz * dz || 1;
  const t = THREE.MathUtils.clamp(((x - a[0]) * dx + (z - a[1]) * dz) / lengthSquared, 0, 1);
  return Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
}

function openSkiLineClearance(x: number, z: number): number {
  let minimum = Number.POSITIVE_INFINITY;
  OPEN_SKI_LINES.forEach((line) => {
    for (let index = 0; index < line.length - 1; index += 1) {
      minimum = Math.min(minimum, distanceToSegment(x, z, line[index], line[index + 1]));
    }
  });
  return world(minimum);
}

function geometryTriangleCount(geometry: THREE.BufferGeometry): number {
  return (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;
}

function setStaticBounds(mesh: THREE.InstancedMesh): void {
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingBox();
  mesh.computeBoundingSphere();
}

function conservativeColliderBox(
  family: MonsoonEncounterFamily,
  x: number,
  terrainY: number,
  z: number,
  yaw: number,
  scale: number,
): THREE.Box3 {
  const [width, height, depth] = FAMILY_DEFINITIONS[family].collider;
  const halfWidth = world(width) * scale * 0.5;
  const halfDepth = world(depth) * scale * 0.5;
  const cosine = Math.abs(Math.cos(yaw));
  const sine = Math.abs(Math.sin(yaw));
  const extentX = halfWidth * cosine + halfDepth * sine;
  const extentZ = halfWidth * sine + halfDepth * cosine;
  return new THREE.Box3(
    new THREE.Vector3(x - extentX, terrainY, z - extentZ),
    new THREE.Vector3(x + extentX, terrainY + world(height) * scale, z + extentZ),
  );
}

/**
 * Builds a self-owned, deterministic encounter-prop kit. All dimensions are
 * authored in Monsoon design space and seated at the exact rendered terrain
 * triangle height; callers own and dispose every returned resource.
 */
export function buildMonsoonEncounterArt(
  seed: number = MONSOON_DIVIDE.seed,
): MonsoonEncounterArtBuild {
  const normalizedSeed = seed >>> 0;
  const group = new THREE.Group();
  group.name = 'MonsoonDivideEncounterArt';

  const familyGeometries: Record<MonsoonEncounterFamily, THREE.BufferGeometry> = {
    windbreak: createWindbreakGeometry(),
    'storm-drain': createStormDrainGeometry(),
    'relay-fin': createRelayFinGeometry(),
  };
  const signalGeometry = createSignalGeometry();
  const geometries = [...FAMILY_ORDER.map((family) => familyGeometries[family]), signalGeometry];

  const shellMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.46,
    metalness: 0.52,
    clearcoat: 0.72,
    clearcoatRoughness: 0.22,
  });
  shellMaterial.name = 'MonsoonEncounterWetStructuralShell';
  shellMaterial.userData = {
    role: 'bodyPrimary/bodySecondary/trim/contact via vertex color',
    source: MONSOON_ENCOUNTER_ART_SOURCE,
    license: MONSOON_ENCOUNTER_ART_LICENSE,
  };
  const signalMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  signalMaterial.name = 'MonsoonEncounterSharedCyanAmberSignal';
  signalMaterial.userData = {
    role: 'emissiveSignal',
    source: MONSOON_ENCOUNTER_ART_SOURCE,
    license: MONSOON_ENCOUNTER_ART_LICENSE,
  };
  const materials: THREE.Material[] = [shellMaterial, signalMaterial];
  const textures: THREE.Texture[] = [];
  const colliderBoxes: THREE.Box3[] = [];
  const placementDiagnostics: MonsoonEncounterPlacementDiagnostics[] = [];
  const signalMatrices: THREE.Matrix4[] = [];
  const signalColors: THREE.Color[] = [];

  let placementSalt = 0;
  FAMILY_ORDER.forEach((family) => {
    const definition = FAMILY_DEFINITIONS[family];
    const specs = FAMILY_PLACEMENTS[family];
    const mesh = new THREE.InstancedMesh(familyGeometries[family], shellMaterial, specs.length);
    mesh.name = `Monsoon encounter ${definition.label}`;
    mesh.castShadow = definition.castShadow;
    mesh.receiveShadow = true;
    mesh.userData = {
      family,
      label: definition.label,
      collisionProxy: 'conservative axis-aligned Box3 returned separately',
      source: MONSOON_ENCOUNTER_ART_SOURCE,
      license: MONSOON_ENCOUNTER_ART_LICENSE,
    };

    specs.forEach((spec, instanceIndex) => {
      const yaw = spec.yaw + (deterministicUnit(normalizedSeed, placementSalt) - 0.5) * 0.07;
      const scale = spec.scale * (0.985 + deterministicUnit(normalizedSeed, placementSalt + 37) * 0.03);
      placementSalt += 1;
      const x = world(spec.x);
      const z = world(spec.z);
      const terrainY = sampleMonsoonMeshHeight(x, z, normalizedSeed);
      const matrix = new THREE.Matrix4().compose(
        new THREE.Vector3(x, terrainY, z),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
        new THREE.Vector3(scale, scale, scale),
      );
      mesh.setMatrixAt(instanceIndex, matrix);
      const coolVariation = deterministicUnit(normalizedSeed, placementSalt + 73);
      mesh.setColorAt(
        instanceIndex,
        new THREE.Color(0xe9f2f4).lerp(new THREE.Color(0xb9d2d8), coolVariation * 0.22),
      );
      colliderBoxes.push(conservativeColliderBox(family, x, terrainY, z, yaw, scale));
      placementDiagnostics.push({
        family,
        x,
        terrainY,
        z,
        yaw,
        scale,
        openSkiLineClearance: openSkiLineClearance(spec.x, spec.z),
      });
      signalMatrices.push(matrix.clone().multiply(localMatrix(
        definition.signalPosition,
        definition.signalRotation,
      )));
      signalColors.push(new THREE.Color(definition.signalColor));
    });
    setStaticBounds(mesh);
    group.add(mesh);
  });

  const signals = new THREE.InstancedMesh(signalGeometry, signalMaterial, signalMatrices.length);
  signals.name = 'Monsoon encounter shared instanced signal chevrons';
  signalMatrices.forEach((matrix, index) => {
    signals.setMatrixAt(index, matrix);
    signals.setColorAt(index, signalColors[index]);
  });
  signals.castShadow = false;
  signals.receiveShadow = false;
  signals.renderOrder = 2;
  signals.userData = {
    family: 'shared-signals',
    nonCollidable: true,
    source: MONSOON_ENCOUNTER_ART_SOURCE,
    license: MONSOON_ENCOUNTER_ART_LICENSE,
  };
  setStaticBounds(signals);
  group.add(signals);

  const familyInstanceCounts = Object.fromEntries(
    FAMILY_ORDER.map((family) => [family, FAMILY_PLACEMENTS[family].length]),
  ) as Record<MonsoonEncounterFamily, number>;
  const familyPrototypeTriangles = Object.fromEntries(
    FAMILY_ORDER.map((family) => [family, geometryTriangleCount(familyGeometries[family])]),
  ) as Record<MonsoonEncounterFamily, number>;
  const estimatedVisibleTriangles = FAMILY_ORDER.reduce(
    (total, family) => total + familyPrototypeTriangles[family] * familyInstanceCounts[family],
    geometryTriangleCount(signalGeometry) * signalMatrices.length,
  );
  const visibleMeshes = group.children.filter((child) => child instanceof THREE.Mesh);
  const expectedShadowDrawCalls = visibleMeshes.filter((mesh) => mesh.castShadow).length;
  const diagnostics: MonsoonEncounterArtDiagnostics = {
    source: MONSOON_ENCOUNTER_ART_SOURCE,
    license: MONSOON_ENCOUNTER_ART_LICENSE,
    seed: normalizedSeed,
    worldScale: MONSOON_WORLD_SCALE,
    assetStrategy: 'project-original-procedural',
    terrainSampler: 'sampleMonsoonMeshHeight',
    familyCount: FAMILY_ORDER.length,
    familyNames: [...FAMILY_ORDER],
    familyLabels: Object.fromEntries(
      FAMILY_ORDER.map((family) => [family, FAMILY_DEFINITIONS[family].label]),
    ) as Record<MonsoonEncounterFamily, string>,
    familyInstanceCounts,
    familyPrototypeTriangles,
    placementCount: placementDiagnostics.length,
    placements: placementDiagnostics,
    minimumOpenSkiLineClearance: Math.min(...placementDiagnostics.map((placement) => placement.openSkiLineClearance)),
    colliderBoxCount: colliderBoxes.length,
    visibleMeshCount: visibleMeshes.length,
    instancedMeshCount: visibleMeshes.filter((mesh) => mesh instanceof THREE.InstancedMesh).length,
    expectedVisibleDrawCalls: visibleMeshes.length,
    expectedShadowDrawCalls,
    expectedDrawCalls: visibleMeshes.length + expectedShadowDrawCalls,
    geometryCount: geometries.length,
    materialCount: materials.length,
    textureCount: textures.length,
    estimatedVisibleTriangles,
    addedTriangleBudget: 80_000,
  };

  group.userData = {
    source: MONSOON_ENCOUNTER_ART_SOURCE,
    license: MONSOON_ENCOUNTER_ART_LICENSE,
    mapSeed: normalizedSeed,
    terrainSampler: 'sampleMonsoonMeshHeight',
    assetSourcing: 'Project-original procedural geometry; no external assets or sidecar files',
    artDirection: 'Storm-washed ribbed barricades, clustered drain cowls, and low arcing relay cover',
    renderBudget: 'Four visible instanced batches, two shadow batches, no textures, <=80k added triangles',
    diagnostics,
  };

  return { group, geometries, materials, textures, colliderBoxes, diagnostics };
}
