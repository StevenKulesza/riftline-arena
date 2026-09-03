import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createSeededRandom } from '../../utils/random';
import { type LaunchRampSpec } from './FlowGeometry';
import { MONSOON_WORLD_SCALE, sampleMonsoonMeshHeight } from './MonsoonDivide';

/**
 * These structures are project-original procedural art. They use only the
 * requested multiplayer level-design traits: monumental facility silhouettes,
 * readable ground entrances, internal switchback circulation, intermediate
 * landings, and defensible roof overlooks.
 */
export const MONSOON_OUTPOST_TOWERS_SOURCE = 'Riftline project-original procedural storm-tech outpost kit';
export const MONSOON_OUTPOST_TOWERS_LICENSE = 'Riftline project original';

export type MonsoonOutpostColliderBox = Readonly<{
  name: string;
  box: THREE.Box3;
}>;

export type MonsoonOutpostPlatformSurface = Readonly<{
  name: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  y: number;
}>;

export type MonsoonOutpostStairRamp = Readonly<{
  name: string;
  spec: LaunchRampSpec;
}>;

export type MonsoonOutpostReviewView = Readonly<{
  name: string;
  camera: Readonly<{ x: number; y: number; z: number }>;
  target: Readonly<{ x: number; y: number; z: number }>;
}>;

export type MonsoonOutpostTowerPlacementDiagnostics = Readonly<{
  name: string;
  center: Readonly<{ x: number; y: number; z: number }>;
  footprint: Readonly<{ width: number; depth: number }>;
  architecturalHeight: number;
  roofHeight: number;
  entranceSide: 'north' | 'south';
  doorwayWidth: number;
  doorwayHeight: number;
  stairWidth: number;
  stairFlightCount: number;
  intermediateLandingCount: number;
}>;

export type MonsoonOutpostTowersDiagnostics = Readonly<{
  source: typeof MONSOON_OUTPOST_TOWERS_SOURCE;
  license: typeof MONSOON_OUTPOST_TOWERS_LICENSE;
  assetStrategy: 'deterministic-project-original-procedural-kit';
  seed: number;
  deterministic: true;
  collisionReady: true;
  towerCount: 2;
  towerNames: readonly string[];
  towers: readonly MonsoonOutpostTowerPlacementDiagnostics[];
  minimumCenterDistance: number;
  minimumKnownRelayClearance: number;
  colliderBoxCount: number;
  platformSurfaceCount: number;
  stairRampCount: number;
  visibleMeshCount: number;
  instancedMeshCount: 0;
  expectedVisibleDrawCalls: number;
  expectedShadowDrawCalls: number;
  geometryCount: number;
  materialCount: number;
  textureCount: 0;
  estimatedVisibleTriangles: number;
  addedTriangleBudget: 120_000;
}>;

export type MonsoonOutpostTowersBuild = {
  group: THREE.Group;
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
  textures: THREE.Texture[];
  colliderBoxes: MonsoonOutpostColliderBox[];
  platformSurfaces: MonsoonOutpostPlatformSurface[];
  stairRamps: MonsoonOutpostStairRamp[];
  diagnostics: MonsoonOutpostTowersDiagnostics;
  reviewViews: readonly [MonsoonOutpostReviewView, MonsoonOutpostReviewView];
};

type MaterialRole =
  | 'foundation'
  | 'shell'
  | 'deck'
  | 'trim'
  | 'glass'
  | 'cyanSignal'
  | 'amberSignal';

type TowerSpec = Readonly<{
  name: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  architecturalHeight: number;
  roofRise: number;
  entranceSide: 'north' | 'south';
  doorwayWidth: number;
  doorwayHeight: number;
  stairWidth: number;
  stairRun: number;
  stairLaneOffset: number;
  flightRise: number;
  flightCount: number;
  shellBias: 'west-sails' | 'east-cantilever';
}>;

type TowerRuntime = Readonly<{
  spec: TowerSpec;
  deckY: number;
  foundationBottomY: number;
  roofY: number;
}>;

type BuildContext = {
  seed: number;
  parts: Record<MaterialRole, THREE.BufferGeometry[]>;
  colliderBoxes: MonsoonOutpostColliderBox[];
  platformSurfaces: MonsoonOutpostPlatformSurface[];
  stairRamps: MonsoonOutpostStairRamp[];
  placementDiagnostics: MonsoonOutpostTowerPlacementDiagnostics[];
  reviewViews: MonsoonOutpostReviewView[];
};

const TOWER_SPECS: readonly [TowerSpec, TowerSpec] = [
  {
    name: 'West Tempest Bastion',
    x: -85 * MONSOON_WORLD_SCALE,
    z: 130 * MONSOON_WORLD_SCALE,
    width: 136,
    depth: 124,
    architecturalHeight: 184,
    roofRise: 160,
    entranceSide: 'south',
    doorwayWidth: 10,
    doorwayHeight: 8.5,
    stairWidth: 3.8,
    stairRun: 12.8,
    stairLaneOffset: 2.35,
    flightRise: 5,
    flightCount: 32,
    shellBias: 'west-sails',
  },
  {
    name: 'Southeast Breaker Spire',
    x: 95 * MONSOON_WORLD_SCALE,
    z: -120 * MONSOON_WORLD_SCALE,
    width: 126,
    depth: 138,
    architecturalHeight: 178,
    roofRise: 160,
    entranceSide: 'north',
    doorwayWidth: 10.5,
    doorwayHeight: 8.5,
    stairWidth: 3.6,
    stairRun: 13.8,
    stairLaneOffset: 2.2,
    flightRise: 5,
    flightCount: 32,
    shellBias: 'east-cantilever',
  },
] as const;

// Existing Monsoon relay/harvester centers, in world metres. Keeping this
// list local makes placement clearance measurable without coupling the kit to
// another art factory's private implementation details.
const KNOWN_RELAY_CENTERS: ReadonlyArray<readonly [number, number]> = [
  [-166 * MONSOON_WORLD_SCALE, 91 * MONSOON_WORLD_SCALE],
  [-43 * MONSOON_WORLD_SCALE, 148 * MONSOON_WORLD_SCALE],
  [103 * MONSOON_WORLD_SCALE, 125 * MONSOON_WORLD_SCALE],
  [158 * MONSOON_WORLD_SCALE, 78 * MONSOON_WORLD_SCALE],
  [150 * MONSOON_WORLD_SCALE, -108 * MONSOON_WORLD_SCALE],
  [-148 * MONSOON_WORLD_SCALE, -112 * MONSOON_WORLD_SCALE],
] as const;

const MATERIAL_ROLES: readonly MaterialRole[] = [
  'foundation',
  'shell',
  'deck',
  'trim',
  'glass',
  'cyanSignal',
  'amberSignal',
] as const;

function translationScaleMatrix(
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  depth: number,
  quaternion = new THREE.Quaternion(),
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    quaternion,
    new THREE.Vector3(width, height, depth),
  );
}

function axisAlignedBoundsFromUnitCube(matrix: THREE.Matrix4): THREE.Box3 {
  const points: THREE.Vector3[] = [];
  for (const x of [-0.5, 0.5]) {
    for (const y of [-0.5, 0.5]) {
      for (const z of [-0.5, 0.5]) {
        points.push(new THREE.Vector3(x, y, z).applyMatrix4(matrix));
      }
    }
  }
  return new THREE.Box3().setFromPoints(points);
}

function positionNormalGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const geometry = source.index ? source.toNonIndexed() : source.clone();
  source.dispose();
  for (const attributeName of Object.keys(geometry.attributes)) {
    if (attributeName !== 'position' && attributeName !== 'normal') geometry.deleteAttribute(attributeName);
  }
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  return geometry;
}

function addGeometry(
  context: BuildContext,
  role: MaterialRole,
  source: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
): void {
  const geometry = positionNormalGeometry(source);
  geometry.applyMatrix4(matrix);
  context.parts[role].push(geometry);
}

function addBox(
  context: BuildContext,
  role: MaterialRole,
  name: string,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  depth: number,
  options: Readonly<{
    quaternion?: THREE.Quaternion;
    collider?: boolean;
    platform?: boolean;
  }> = {},
): THREE.Box3 {
  const matrix = translationScaleMatrix(
    x,
    y,
    z,
    width,
    height,
    depth,
    options.quaternion,
  );
  addGeometry(context, role, new THREE.BoxGeometry(1, 1, 1), matrix);
  const bounds = axisAlignedBoundsFromUnitCube(matrix);
  if (options.collider) context.colliderBoxes.push({ name, box: bounds.clone() });
  if (options.platform) {
    context.platformSurfaces.push({
      name,
      minX: bounds.min.x,
      maxX: bounds.max.x,
      minZ: bounds.min.z,
      maxZ: bounds.max.z,
      y: bounds.max.y,
    });
  }
  return bounds;
}

function addColliderBoxOnly(
  context: BuildContext,
  name: string,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  depth: number,
  quaternion = new THREE.Quaternion(),
): void {
  context.colliderBoxes.push({
    name,
    box: axisAlignedBoundsFromUnitCube(translationScaleMatrix(
      x,
      y,
      z,
      width,
      height,
      depth,
      quaternion,
    )),
  });
}

function createChamferedPrismGeometry(
  width: number,
  height: number,
  depth: number,
  chamfer: number,
): THREE.BufferGeometry {
  const halfWidth = width * 0.5;
  const halfHeight = height * 0.5;
  const halfDepth = depth * 0.5;
  const c = Math.min(chamfer, halfWidth * 0.45, halfDepth * 0.45);
  const ring: ReadonlyArray<readonly [number, number]> = [
    [-halfWidth + c, -halfDepth],
    [halfWidth - c, -halfDepth],
    [halfWidth, -halfDepth + c],
    [halfWidth, halfDepth - c],
    [halfWidth - c, halfDepth],
    [-halfWidth + c, halfDepth],
    [-halfWidth, halfDepth - c],
    [-halfWidth, -halfDepth + c],
  ];
  const positions: number[] = [];
  for (const y of [-halfHeight, halfHeight]) {
    for (const [x, z] of ring) positions.push(x, y, z);
  }
  const indices: number[] = [];
  for (let index = 1; index < ring.length - 1; index += 1) {
    indices.push(0, index + 1, index);
    indices.push(8, 8 + index, 8 + index + 1);
  }
  for (let index = 0; index < ring.length; index += 1) {
    const next = (index + 1) % ring.length;
    indices.push(index, next, 8 + next, index, 8 + next, 8 + index);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createTaperedPierGeometry(
  bottomWidth: number,
  topWidth: number,
  height: number,
  bottomDepth: number,
  topDepth: number,
  topOffsetX = 0,
  topOffsetZ = 0,
): THREE.BufferGeometry {
  const y0 = -height * 0.5;
  const y1 = height * 0.5;
  const bottomX = bottomWidth * 0.5;
  const bottomZ = bottomDepth * 0.5;
  const topX = topWidth * 0.5;
  const topZ = topDepth * 0.5;
  const positions = new Float32Array([
    -bottomX, y0, -bottomZ,
    bottomX, y0, -bottomZ,
    bottomX, y0, bottomZ,
    -bottomX, y0, bottomZ,
    topOffsetX - topX, y1, topOffsetZ - topZ,
    topOffsetX + topX, y1, topOffsetZ - topZ,
    topOffsetX + topX, y1, topOffsetZ + topZ,
    topOffsetX - topX, y1, topOffsetZ + topZ,
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

function addTaperedPier(
  context: BuildContext,
  role: MaterialRole,
  name: string,
  x: number,
  y: number,
  z: number,
  bottomWidth: number,
  topWidth: number,
  height: number,
  bottomDepth: number,
  topDepth: number,
  topOffsetX: number,
  topOffsetZ: number,
  collider = true,
): void {
  addGeometry(
    context,
    role,
    createTaperedPierGeometry(
      bottomWidth,
      topWidth,
      height,
      bottomDepth,
      topDepth,
      topOffsetX,
      topOffsetZ,
    ),
    new THREE.Matrix4().makeTranslation(x, y, z),
  );
  if (collider) {
    const halfWidth = Math.max(bottomWidth, topWidth) * 0.5 + Math.abs(topOffsetX) * 0.5;
    const halfDepth = Math.max(bottomDepth, topDepth) * 0.5 + Math.abs(topOffsetZ) * 0.5;
    context.colliderBoxes.push({
      name,
      box: new THREE.Box3(
        new THREE.Vector3(x - halfWidth, y - height * 0.5, z - halfDepth),
        new THREE.Vector3(x + halfWidth, y + height * 0.5, z + halfDepth),
      ),
    });
  }
}

function addChamferedBlock(
  context: BuildContext,
  role: MaterialRole,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  depth: number,
  chamfer: number,
  quaternion = new THREE.Quaternion(),
): void {
  addGeometry(
    context,
    role,
    createChamferedPrismGeometry(width, height, depth, chamfer),
    new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      quaternion,
      new THREE.Vector3(1, 1, 1),
    ),
  );
}

function addCylinder(
  context: BuildContext,
  role: MaterialRole,
  x: number,
  y: number,
  z: number,
  radiusTop: number,
  radiusBottom: number,
  height: number,
  radialSegments: number,
  quaternion = new THREE.Quaternion(),
): void {
  addGeometry(
    context,
    role,
    new THREE.CylinderGeometry(radiusTop, radiusBottom, height, radialSegments, 1, false),
    new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      quaternion,
      new THREE.Vector3(1, 1, 1),
    ),
  );
}

function addTorus(
  context: BuildContext,
  role: MaterialRole,
  x: number,
  y: number,
  z: number,
  radius: number,
  tube: number,
  quaternion: THREE.Quaternion,
): void {
  addGeometry(
    context,
    role,
    new THREE.TorusGeometry(radius, tube, 6, 18),
    new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      quaternion,
      new THREE.Vector3(1, 1, 1),
    ),
  );
}

function addPlatformSlab(
  context: BuildContext,
  role: MaterialRole,
  name: string,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  topY: number,
  thickness: number,
): void {
  addBox(
    context,
    role,
    name,
    (minX + maxX) * 0.5,
    topY - thickness * 0.5,
    (minZ + maxZ) * 0.5,
    maxX - minX,
    thickness,
    maxZ - minZ,
    { collider: true, platform: true },
  );
}

function addDeckRing(
  context: BuildContext,
  tower: TowerRuntime,
  name: string,
  topY: number,
  shaftWidth: number,
  shaftDepth: number,
): void {
  const { spec } = tower;
  const inset = 2.4;
  const minX = spec.x - spec.width * 0.5 + inset;
  const maxX = spec.x + spec.width * 0.5 - inset;
  const minZ = spec.z - spec.depth * 0.5 + inset;
  const maxZ = spec.z + spec.depth * 0.5 - inset;
  const shaftMinX = spec.x - shaftWidth * 0.5;
  const shaftMaxX = spec.x + shaftWidth * 0.5;
  const shaftMinZ = spec.z - shaftDepth * 0.5;
  const shaftMaxZ = spec.z + shaftDepth * 0.5;
  const thickness = 0.42;
  addPlatformSlab(context, 'deck', `${name} west walk`, minX, shaftMinX, minZ, maxZ, topY, thickness);
  addPlatformSlab(context, 'deck', `${name} east walk`, shaftMaxX, maxX, minZ, maxZ, topY, thickness);
  addPlatformSlab(context, 'deck', `${name} north walk`, shaftMinX, shaftMaxX, shaftMaxZ, maxZ, topY, thickness);
  addPlatformSlab(context, 'deck', `${name} south walk`, shaftMinX, shaftMaxX, minZ, shaftMinZ, topY, thickness);
}

function quaternionAlongSegment(start: THREE.Vector3, end: THREE.Vector3): THREE.Quaternion {
  const direction = end.clone().sub(start).normalize();
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
}

function addBeamBetween(
  context: BuildContext,
  role: MaterialRole,
  name: string,
  start: THREE.Vector3,
  end: THREE.Vector3,
  width: number,
  height: number,
  collider: boolean,
): void {
  const center = start.clone().add(end).multiplyScalar(0.5);
  addBox(
    context,
    role,
    name,
    center.x,
    center.y,
    center.z,
    width,
    height,
    start.distanceTo(end),
    { quaternion: quaternionAlongSegment(start, end), collider },
  );
}

function addStairFlight(
  context: BuildContext,
  tower: TowerRuntime,
  flightIndex: number,
  startX: number,
  startZ: number,
  heading: number,
  startY: number,
): void {
  const { spec: towerSpec } = tower;
  const name = `${towerSpec.name} internal switchback flight ${flightIndex + 1}`;
  const spec: LaunchRampSpec = {
    origin: { x: startX, y: startY, z: startZ },
    heading,
    length: towerSpec.stairRun,
    width: towerSpec.stairWidth,
    rise: towerSpec.flightRise,
    curveExponent: 1,
    profile: 'power',
    longitudinalSegments: 12,
    lateralSegments: 2,
    solid: false,
  };
  context.stairRamps.push({ name, spec });

  const directionX = Math.sin(heading);
  const directionZ = Math.cos(heading);
  const sideX = Math.cos(heading);
  const sideZ = -Math.sin(heading);
  const stepCount = 13;
  const treadDepth = towerSpec.stairRun / stepCount * 1.04;
  const treadYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
  for (let stepIndex = 0; stepIndex < stepCount; stepIndex += 1) {
    const along = (stepIndex + 0.5) / stepCount * towerSpec.stairRun;
    const topY = startY + (stepIndex + 1) / stepCount * towerSpec.flightRise;
    addBox(
      context,
      'deck',
      `${name} tread ${stepIndex + 1}`,
      startX + directionX * along,
      topY - 0.11,
      startZ + directionZ * along,
      towerSpec.stairWidth,
      0.22,
      treadDepth,
      { quaternion: treadYaw },
    );
  }

  for (const side of [-1, 1]) {
    const sideOffset = towerSpec.stairWidth * 0.5 + 0.12;
    const railStart = new THREE.Vector3(
      startX + sideX * sideOffset,
      startY + 1.12,
      startZ + sideZ * sideOffset,
    );
    const railEnd = new THREE.Vector3(
      railStart.x + directionX * towerSpec.stairRun,
      railStart.y + towerSpec.flightRise,
      railStart.z + directionZ * towerSpec.stairRun,
    );
    const railSegments = 3;
    for (let segmentIndex = 0; segmentIndex < railSegments; segmentIndex += 1) {
      const a = railStart.clone().lerp(railEnd, segmentIndex / railSegments);
      const b = railStart.clone().lerp(railEnd, (segmentIndex + 1) / railSegments);
      addBeamBetween(
        context,
        'trim',
        `${name} ${side < 0 ? 'left' : 'right'} guard ${segmentIndex + 1}`,
        a,
        b,
        0.13,
        0.16,
        true,
      );
      if (segmentIndex < 2) {
        addBox(
          context,
          'trim',
          `${name} ${side < 0 ? 'left' : 'right'} post ${segmentIndex + 1}`,
          a.x,
          a.y - 0.52,
          a.z,
          0.13,
          1.12,
          0.13,
          { collider: false },
        );
      }
    }
  }

  for (const side of [-1, 1]) {
    const sideOffset = towerSpec.stairWidth * 0.5 - 0.2;
    const stringerStart = new THREE.Vector3(
      startX + sideX * sideOffset * side,
      startY - 0.16,
      startZ + sideZ * sideOffset * side,
    );
    const stringerEnd = new THREE.Vector3(
      stringerStart.x + directionX * towerSpec.stairRun,
      stringerStart.y + towerSpec.flightRise,
      stringerStart.z + directionZ * towerSpec.stairRun,
    );
    addBeamBetween(
      context,
      'foundation',
      `${name} ${side < 0 ? 'left' : 'right'} stringer`,
      stringerStart,
      stringerEnd,
      0.24,
      0.28,
      false,
    );
  }
}

function addLandingRails(
  context: BuildContext,
  name: string,
  centerX: number,
  centerZ: number,
  width: number,
  depth: number,
  y: number,
  openSide: 'north' | 'south',
  closeOuterEnd = true,
): void {
  const railY = y + 0.62;
  const westX = centerX - width * 0.5;
  const eastX = centerX + width * 0.5;
  addBox(context, 'trim', `${name} west rail`, westX, railY, centerZ, 0.14, 1.22, depth, { collider: true });
  addBox(context, 'trim', `${name} east rail`, eastX, railY, centerZ, 0.14, 1.22, depth, { collider: true });
  if (closeOuterEnd) {
    const closedZ = centerZ + (openSide === 'south' ? depth * 0.5 : -depth * 0.5);
    addBox(context, 'trim', `${name} end rail`, centerX, railY, closedZ, width, 1.22, 0.14, { collider: true });
  }
}

function addInternalCirculation(context: BuildContext, tower: TowerRuntime): void {
  const { spec } = tower;
  const shaftWidth = spec.stairLaneOffset * 2 + spec.stairWidth + 1.1;
  const shaftDepth = spec.stairRun + 3.8;
  const baseDirection = spec.entranceSide === 'south' ? 1 : -1;
  const firstHeading = baseDirection > 0 ? 0 : Math.PI;
  const lowZ = spec.z - baseDirection * spec.stairRun * 0.5;
  const highZ = spec.z + baseDirection * spec.stairRun * 0.5;

  for (let flightIndex = 0; flightIndex < spec.flightCount; flightIndex += 1) {
    const even = flightIndex % 2 === 0;
    const heading = even ? firstHeading : (firstHeading + Math.PI) % (Math.PI * 2);
    const laneSign = even ? -1 : 1;
    const startX = spec.x + laneSign * spec.stairLaneOffset;
    const startZ = even ? lowZ : highZ;
    const startY = tower.deckY + flightIndex * spec.flightRise;
    addStairFlight(context, tower, flightIndex, startX, startZ, heading, startY);

    const landingY = startY + spec.flightRise;
    const landingZ = even ? highZ : lowZ;
    const landingName = `${spec.name} ${even ? 'intermediate' : 'operations'} landing ${Math.floor(flightIndex / 2) + 1}`;
    const landingWidth = shaftWidth - 0.4;
    const landingDepth = 4;
    addPlatformSlab(
      context,
      'deck',
      landingName,
      spec.x - landingWidth * 0.5,
      spec.x + landingWidth * 0.5,
      landingZ - landingDepth * 0.5,
      landingZ + landingDepth * 0.5,
      landingY,
      0.36,
    );
    if (even) {
      addLandingRails(
        context,
        landingName,
        spec.x,
        landingZ,
        landingWidth,
        landingDepth,
        landingY,
        spec.entranceSide,
      );
    } else {
      // Operations-deck landings stay open toward both the ramp and the deck
      // ring, while their long sides still prevent a fall into the stairwell.
      addLandingRails(
        context,
        landingName,
        spec.x,
        landingZ,
        landingWidth,
        landingDepth,
        landingY,
        spec.entranceSide === 'south' ? 'north' : 'south',
        false,
      );
      addDeckRing(
        context,
        tower,
        flightIndex === spec.flightCount - 1
          ? `${spec.name} roof overlook`
          : `${spec.name} operations deck ${(flightIndex + 1) / 2}`,
        landingY,
        shaftWidth,
        shaftDepth,
      );
    }
  }
}

function addPerimeterRing(
  context: BuildContext,
  tower: TowerRuntime,
  name: string,
  y: number,
  beamHeight: number,
): void {
  const { spec } = tower;
  const beamDepth = 0.75;
  // Preserve the established edge-blocking contract without exposing a
  // repetitive office-floor ring on every storey. The authored armor and
  // selected landing collars below provide the visible massing.
  addColliderBoxOnly(context, `${name} north beam`, spec.x, y, spec.z + spec.depth * 0.5, spec.width, beamHeight, beamDepth);
  addColliderBoxOnly(context, `${name} south beam`, spec.x, y, spec.z - spec.depth * 0.5, spec.width, beamHeight, beamDepth);
  addColliderBoxOnly(context, `${name} west beam`, spec.x - spec.width * 0.5, y, spec.z, beamDepth, beamHeight, spec.depth);
  addColliderBoxOnly(context, `${name} east beam`, spec.x + spec.width * 0.5, y, spec.z, beamDepth, beamHeight, spec.depth);
}

function addDoorWall(
  context: BuildContext,
  tower: TowerRuntime,
): void {
  const { spec } = tower;
  const frontSign = spec.entranceSide === 'north' ? 1 : -1;
  const frontZ = spec.z + frontSign * spec.depth * 0.5;
  const wallDepth = 0.9;
  const sideWidth = (spec.width - spec.doorwayWidth) * 0.5;
  const leftX = spec.x - spec.doorwayWidth * 0.5 - sideWidth * 0.5;
  const rightX = spec.x + spec.doorwayWidth * 0.5 + sideWidth * 0.5;
  addColliderBoxOnly(context, `${spec.name} entrance left wall`, leftX, tower.deckY + spec.doorwayHeight * 0.5, frontZ, sideWidth, spec.doorwayHeight, wallDepth);
  addColliderBoxOnly(context, `${spec.name} entrance right wall`, rightX, tower.deckY + spec.doorwayHeight * 0.5, frontZ, sideWidth, spec.doorwayHeight, wallDepth);
  const wallModuleGap = 1.1;
  const wallModuleWidth = (sideWidth - wallModuleGap * 2) / 3;
  for (const wallSide of [-1, 1]) {
    const regionStartX = wallSide < 0
      ? spec.x - spec.doorwayWidth * 0.5 - sideWidth
      : spec.x + spec.doorwayWidth * 0.5;
    for (let moduleIndex = 0; moduleIndex < 3; moduleIndex += 1) {
      const moduleX = regionStartX + wallModuleWidth * (moduleIndex + 0.5) + wallModuleGap * moduleIndex;
      const moduleHeight = spec.doorwayHeight + (moduleIndex === 1 ? 2.4 : 0.8);
      addChamferedBlock(
        context,
        'shell',
        moduleX,
        tower.deckY + moduleHeight * 0.5,
        frontZ,
        wallModuleWidth,
        moduleHeight,
        2.2,
        1.1,
      );
      if (moduleIndex < 2) {
        addBox(
          context,
          wallSide < 0 ? 'cyanSignal' : 'amberSignal',
          `${spec.name} entrance facade ${wallSide < 0 ? 'west' : 'east'} seam ${moduleIndex + 1}`,
          regionStartX + wallModuleWidth * (moduleIndex + 1) + wallModuleGap * (moduleIndex + 0.5),
          tower.deckY + spec.doorwayHeight * 0.48,
          frontZ + frontSign * 1.14,
          0.32,
          spec.doorwayHeight * 0.68,
          0.12,
        );
      }
    }
  }
  const lintelHeight = Math.max(1.4, spec.flightRise * 2 - spec.doorwayHeight);
  addColliderBoxOnly(context, `${spec.name} entrance lintel`, spec.x, tower.deckY + spec.doorwayHeight + lintelHeight * 0.5, frontZ, spec.doorwayWidth, lintelHeight, wallDepth);

  const canopyY = tower.deckY + spec.doorwayHeight + 0.72;
  addChamferedBlock(
    context,
    'foundation',
    spec.x,
    canopyY,
    frontZ + frontSign * 1.3,
    spec.doorwayWidth + 18,
    1.3,
    8,
    1.4,
  );
  for (const side of [-1, 1]) {
    const finQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, side * -0.19));
    addBox(
      context,
      'shell',
      `${spec.name} recessed portico ${side < 0 ? 'west' : 'east'} angled fin`,
      spec.x + side * (spec.doorwayWidth * 0.5 + 2.6),
      tower.deckY + spec.doorwayHeight * 0.54,
      frontZ + frontSign * 0.9,
      2.2,
      spec.doorwayHeight + 5.2,
      6.2,
      { quaternion: finQuaternion },
    );
    addBox(
      context,
      'trim',
      `${spec.name} recessed portico ${side < 0 ? 'west' : 'east'} inner jamb`,
      spec.x + side * (spec.doorwayWidth * 0.5 + 0.22),
      tower.deckY + spec.doorwayHeight * 0.5,
      frontZ - frontSign * 0.62,
      0.26,
      spec.doorwayHeight,
      0.4,
    );
  }

  addBox(
    context,
    'cyanSignal',
    `${spec.name} recessed portico luminous header`,
    spec.x,
    tower.deckY + spec.doorwayHeight + 0.08,
    frontZ + frontSign * 2.18,
    spec.doorwayWidth + 12,
    0.58,
    0.15,
  );
  const glyphY = tower.deckY + spec.doorwayHeight + 1.52;
  const glyphZ = frontZ + frontSign * 2.2;
  addBeamBetween(
    context,
    'amberSignal',
    `${spec.name} portico route glyph west stroke`,
    new THREE.Vector3(spec.x - 1.7, glyphY + 0.55, glyphZ),
    new THREE.Vector3(spec.x, glyphY - 0.38, glyphZ),
    0.2,
    0.22,
    false,
  );
  addBeamBetween(
    context,
    'amberSignal',
    `${spec.name} portico route glyph east stroke`,
    new THREE.Vector3(spec.x, glyphY - 0.38, glyphZ),
    new THREE.Vector3(spec.x + 1.7, glyphY + 0.55, glyphZ),
    0.2,
    0.22,
    false,
  );

  const signalOffset = spec.doorwayWidth * 0.5 + 0.34;
  addBox(context, 'cyanSignal', `${spec.name} entrance cyan signal`, spec.x - signalOffset, tower.deckY + spec.doorwayHeight * 0.56, frontZ + frontSign * 0.7, 0.26, spec.doorwayHeight * 0.7, 0.13);
  addBox(context, 'amberSignal', `${spec.name} entrance amber signal`, spec.x + signalOffset, tower.deckY + spec.doorwayHeight * 0.56, frontZ + frontSign * 0.7, 0.26, spec.doorwayHeight * 0.7, 0.13);
}

function addGroundEntranceRamp(context: BuildContext, tower: TowerRuntime): void {
  const { spec } = tower;
  const direction = spec.entranceSide === 'south' ? 1 : -1;
  const heading = direction > 0 ? 0 : Math.PI;
  const endZ = spec.z - direction * spec.depth * 0.5;
  let length = 80;
  let startZ = endZ - direction * length;
  let terrainY = sampleMonsoonMeshHeight(spec.x, startZ, context.seed) + 0.08;
  for (let candidateLength = 24; candidateLength <= 80; candidateLength += 2) {
    const candidateZ = endZ - direction * candidateLength;
    const candidateY = sampleMonsoonMeshHeight(spec.x, candidateZ, context.seed) + 0.08;
    if (Math.abs(tower.deckY - candidateY) / candidateLength > 0.3) continue;
    length = candidateLength;
    startZ = candidateZ;
    terrainY = candidateY;
    break;
  }
  const ramp: LaunchRampSpec = {
    origin: { x: spec.x, y: terrainY, z: startZ },
    heading,
    length,
    width: Math.max(8.4, spec.doorwayWidth),
    rise: tower.deckY - terrainY,
    curveExponent: 1,
    profile: 'power',
    longitudinalSegments: Math.max(16, Math.ceil(length / 2)),
    lateralSegments: 2,
    solid: false,
  };
  const name = `${spec.name} terrain-to-ground entrance ramp`;
  if (Math.abs(ramp.rise) / ramp.length > 0.35) {
    throw new Error(`${name} exceeds the Monsoon base entrance grade budget.`);
  }
  context.stairRamps.push({ name, spec: ramp });

  const stepCount = Math.max(16, Math.ceil(length), Math.ceil(Math.abs(ramp.rise) / 0.36));
  for (let stepIndex = 0; stepIndex < stepCount; stepIndex += 1) {
    const along = (stepIndex + 0.5) / stepCount * length;
    const topY = terrainY + (stepIndex + 1) / stepCount * ramp.rise;
    addBox(
      context,
      'deck',
      `${name} tread ${stepIndex + 1}`,
      spec.x,
      topY - 0.12,
      startZ + direction * along,
      ramp.width,
      0.24,
      length / stepCount * 1.05,
    );
  }
  const end = new THREE.Vector3(spec.x, tower.deckY - 0.2, endZ);
  const start = new THREE.Vector3(spec.x, terrainY - 0.2, startZ);
  for (const side of [-1, 1]) {
    const sideStart = start.clone().add(new THREE.Vector3(side * (ramp.width * 0.5 - 0.22), 0, 0));
    const sideEnd = end.clone().add(new THREE.Vector3(side * (ramp.width * 0.5 - 0.22), 0, 0));
    addBeamBetween(context, 'foundation', `${name} support ${side < 0 ? 'west' : 'east'}`, sideStart, sideEnd, 0.26, 0.3, false);
  }
}

function addArmoredCoreEnvelope(context: BuildContext, tower: TowerRuntime): void {
  const { spec } = tower;
  const lowerY = tower.deckY + spec.flightRise * 2 - 0.2;
  const upperY = tower.roofY - 1.15;
  const height = upperY - lowerY;
  const centerY = (lowerY + upperY) * 0.5;
  const bottomWidth = spec.width - 3.2;
  const bottomDepth = spec.depth - 3.2;
  const topWidth = spec.width * (spec.shellBias === 'west-sails' ? 0.69 : 0.74);
  const topDepth = spec.depth * (spec.shellBias === 'west-sails' ? 0.75 : 0.68);
  const xSetback = (bottomWidth - topWidth) * 0.5;
  const zSetback = (bottomDepth - topDepth) * 0.5;

  for (const side of [-1, 1]) {
    for (const end of [-1, 1]) {
      addTaperedPier(
        context,
        'shell',
        `${spec.name} monolithic ${side < 0 ? 'west' : 'east'} ${end < 0 ? 'south' : 'north'} core armor`,
        spec.x + side * bottomWidth * 0.5,
        centerY,
        spec.z + end * bottomDepth * 0.28,
        1.3,
        0.82,
        height,
        bottomDepth * 0.34,
        topDepth * 0.28,
        -side * xSetback,
        -end * zSetback * 0.54,
        false,
      );
      addTaperedPier(
        context,
        'shell',
        `${spec.name} monolithic ${end < 0 ? 'south' : 'north'} ${side < 0 ? 'west' : 'east'} core armor`,
        spec.x + side * bottomWidth * 0.28,
        centerY,
        spec.z + end * bottomDepth * 0.5,
        bottomWidth * 0.34,
        topWidth * 0.28,
        height,
        1.3,
        0.82,
        -side * xSetback * 0.54,
        -end * zSetback,
        false,
      );
    }

    addTaperedPier(
      context,
      'glass',
      `${spec.name} ${side < 0 ? 'west' : 'east'} full-height stair reveal`,
      spec.x + side * (bottomWidth * 0.5 + 0.06),
      centerY,
      spec.z,
      0.22,
      0.16,
      height * 0.84,
      bottomDepth * 0.24,
      topDepth * 0.2,
      -side * xSetback,
      0,
      false,
    );
    addTaperedPier(
      context,
      'glass',
      `${spec.name} ${side < 0 ? 'south' : 'north'} full-height landing reveal`,
      spec.x,
      centerY,
      spec.z + side * (bottomDepth * 0.5 + 0.06),
      bottomWidth * 0.24,
      topWidth * 0.2,
      height * 0.84,
      0.22,
      0.16,
      0,
      -side * zSetback,
      false,
    );
  }

  // Broad, overlapping face plates turn the internal stair machine into a
  // believable hardened facility. They start above the entrance storey, leave
  // deliberate vertical reveals, and taper toward the command crown instead
  // of exposing a stack of identical floor slabs like an office block.
  const signalRole: MaterialRole = spec.shellBias === 'west-sails' ? 'cyanSignal' : 'amberSignal';
  for (const end of [-1, 1]) {
    const faceZ = spec.z + end * (spec.depth * 0.5 + 2.4);
    for (const side of [-1, 1]) {
      const panelX = spec.x + side * bottomWidth * 0.245;
      addTaperedPier(
        context,
        'shell',
        `${spec.name} ${end < 0 ? 'south' : 'north'} ${side < 0 ? 'west' : 'east'} fortress face plate`,
        panelX,
        centerY,
        faceZ,
        bottomWidth * 0.49,
        topWidth * 0.48,
        height,
        5.2,
        3.6,
        -side * xSetback * 0.46,
        -end * zSetback,
        false,
      );
    }
    addBox(
      context,
      signalRole,
      `${spec.name} ${end < 0 ? 'south' : 'north'} full-height faction channel`,
      spec.x + (spec.shellBias === 'west-sails' ? -4.8 : 4.8),
      centerY,
      faceZ + end * 2.66,
      1.15,
      height * 0.78,
      0.2,
    );
    for (const band of [0.24, 0.52, 0.78]) {
      addChamferedBlock(
        context,
        'foundation',
        spec.x + (band === 0.52 ? (spec.shellBias === 'west-sails' ? -7 : 7) : 0),
        lowerY + height * band,
        faceZ + end * 1.2,
        bottomWidth * (band === 0.52 ? 0.68 : 0.82),
        2.6,
        4.8,
        1.2,
      );
    }
  }

  for (const side of [-1, 1]) {
    const faceX = spec.x + side * (spec.width * 0.5 + 2.4);
    for (const end of [-1, 1]) {
      const panelZ = spec.z + end * bottomDepth * 0.245;
      addTaperedPier(
        context,
        'shell',
        `${spec.name} ${side < 0 ? 'west' : 'east'} ${end < 0 ? 'south' : 'north'} fortress flank plate`,
        faceX,
        centerY,
        panelZ,
        5.2,
        3.6,
        height,
        bottomDepth * 0.49,
        topDepth * 0.48,
        -side * xSetback,
        -end * zSetback * 0.46,
        false,
      );
    }
    addBox(
      context,
      signalRole,
      `${spec.name} ${side < 0 ? 'west' : 'east'} flank identity channel`,
      faceX + side * 2.66,
      lowerY + height * 0.58,
      spec.z + (spec.shellBias === 'west-sails' ? -5 : 5),
      0.2,
      height * 0.54,
      1.05,
    );
  }

  const facadeSign = spec.entranceSide === 'south' ? -1 : 1;
  const facadeZ = spec.z + facadeSign * (bottomDepth * 0.5 + 0.72);
  const diagonalLean = spec.width * (spec.shellBias === 'west-sails' ? 0.23 : 0.2);
  addBeamBetween(
    context,
    'shell',
    `${spec.name} primary facade diagonal armor`,
    new THREE.Vector3(spec.x - diagonalLean, lowerY + 1.2, facadeZ),
    new THREE.Vector3(spec.x + diagonalLean * 0.55, upperY - 2.4, facadeZ - facadeSign * zSetback),
    5.2,
    2.2,
    false,
  );
  addBeamBetween(
    context,
    'trim',
    `${spec.name} primary facade diagonal armor edge`,
    new THREE.Vector3(spec.x - diagonalLean - 0.28, lowerY + 1.2, facadeZ + facadeSign * 0.16),
    new THREE.Vector3(spec.x + diagonalLean * 0.55 - 0.28, upperY - 2.4, facadeZ - facadeSign * zSetback + facadeSign * 0.16),
    0.62,
    0.76,
    false,
  );
  addBeamBetween(
    context,
    'shell',
    `${spec.name} secondary facade diagonal armor`,
    new THREE.Vector3(spec.x + diagonalLean * 0.92, lowerY + height * 0.18, facadeZ),
    new THREE.Vector3(spec.x + diagonalLean * 0.1, upperY - height * 0.24, facadeZ - facadeSign * zSetback * 0.72),
    3.8,
    1.75,
    false,
  );

  const shoulderY = tower.roofY - 4.2;
  const shoulderBias = spec.shellBias === 'west-sails' ? -1 : 1;
  addChamferedBlock(
    context,
    'shell',
    spec.x + shoulderBias * 3.6,
    shoulderY,
    spec.z - facadeSign * 1.8,
    topWidth + 16,
    7.2,
    topDepth + 11,
    3.2,
  );
  addBox(
    context,
    'glass',
    `${spec.name} upper command shoulder glazing`,
    spec.x + shoulderBias * 3.6,
    shoulderY + 0.3,
    spec.z + facadeSign * ((topDepth + 11) * 0.5 + 0.1) - facadeSign * 1.8,
    topWidth * 0.68,
    3.2,
    0.22,
  );
}

function addSlopedFoundationArmor(context: BuildContext, tower: TowerRuntime): void {
  const { spec } = tower;
  const lowerY = Math.min(tower.deckY - 0.5, tower.foundationBottomY);
  const upperY = tower.deckY + 11.5;
  const height = upperY - lowerY;
  const centerY = (lowerY + upperY) * 0.5;
  const cornerInset = 3.15;
  for (const xSign of [-1, 1]) {
    for (const zSign of [-1, 1]) {
      addTaperedPier(
        context,
        'foundation',
        `${spec.name} armored foundation ${xSign < 0 ? 'west' : 'east'} ${zSign < 0 ? 'south' : 'north'} batter`,
        spec.x + xSign * (spec.width * 0.5 - cornerInset),
        centerY,
        spec.z + zSign * (spec.depth * 0.5 - cornerInset),
        12.5,
        5.2,
        height,
        12.5,
        5.2,
        -xSign * 0.35,
        -zSign * 0.35,
        false,
      );
    }
  }

  for (const side of [-1, 1]) {
    for (const end of [-1, 1]) {
      addTaperedPier(
        context,
        'shell',
        `${spec.name} ${side < 0 ? 'west' : 'east'} ${end < 0 ? 'south' : 'north'} lower counterfort`,
        spec.x + side * (spec.width * 0.5 + 0.55),
        tower.deckY + 8.6,
        spec.z + end * spec.depth * 0.27,
        11.5,
        4.4,
        17.2,
        22,
        9.2,
        -side * 1.1,
        -end * 0.7,
        false,
      );
    }
  }

  const entranceSign = spec.entranceSide === 'south' ? -1 : 1;
  const rearZ = spec.z - entranceSign * (spec.depth * 0.5 + 0.35);
  addTaperedPier(
    context,
    'shell',
    `${spec.name} rear armored lower spine`,
    spec.x,
    tower.deckY + 7.2,
    rearZ,
    21,
    10,
    14.4,
    7.2,
    3.1,
    0,
    entranceSign * 0.8,
    false,
  );

  const braceTargetY = tower.deckY + spec.roofRise * 0.53;
  for (const side of [-1, 1]) {
    for (const endSign of [-1, 1]) {
      const start = new THREE.Vector3(
        spec.x + side * (spec.width * 0.5 + 5.2),
        tower.deckY + 1.2,
        spec.z + endSign * spec.depth * 0.29,
      );
      const end = new THREE.Vector3(
        spec.x + side * (spec.width * 0.5 - 2.4),
        braceTargetY + endSign * 5,
        spec.z + endSign * spec.depth * 0.18,
      );
      addBeamBetween(context, 'trim', `${spec.name} ${side < 0 ? 'west' : 'east'} ${endSign < 0 ? 'south' : 'north'} exterior storm brace`, start, end, 0.76, 1.05, false);
    }
  }
}

function addLandingDeckFascias(context: BuildContext, tower: TowerRuntime): void {
  const { spec } = tower;
  const storeyHeight = spec.flightRise * 2;
  const levels = spec.shellBias === 'west-sails' ? [2, 7, 12, 16] : [3, 8, 13, 16];
  for (const level of levels) {
    const y = tower.deckY + level * storeyHeight - 0.62;
    if (spec.shellBias === 'west-sails') {
      const width = spec.width + (level === 12 ? 18 : 10);
      const depth = spec.depth + 4.8;
      addChamferedBlock(context, 'deck', spec.x + (level === 12 ? 4.2 : -2), y, spec.z + depth * 0.5 - 3.2, width, 1.35, 6.4, 1.5);
      addChamferedBlock(context, 'deck', spec.x - (level === 12 ? 4.2 : -2), y, spec.z - depth * 0.5 + 3.2, width * 0.8, 1.35, 6.4, 1.5);
      addBox(context, 'cyanSignal', `${spec.name} level ${level} landing edge beacon`, spec.x, y - 0.18, spec.z + depth * 0.5 + 0.03, width * 0.42, 0.18, 0.14);
    } else {
      const width = level === 3 ? 8.4 : 6.2;
      const depth = spec.depth + (level === 3 ? 10.5 : 6.8);
      const side = level === 3 ? -1 : 1;
      const centerX = spec.x + side * (spec.width * 0.5 + width * 0.22);
      addChamferedBlock(context, 'deck', centerX, y, spec.z + (level === 1 ? -2.4 : 1.4), width, 1.15, depth, 1.2);
      addBox(context, 'amberSignal', `${spec.name} level ${level} landing edge beacon`, centerX + side * width * 0.5, y - 0.16, spec.z, 0.14, 0.2, depth * 0.56);
    }
  }
}

function addExteriorRouteStrips(context: BuildContext, tower: TowerRuntime): void {
  const { spec } = tower;
  const frontSign = spec.entranceSide === 'south' ? -1 : 1;
  const frontZ = spec.z + frontSign * (spec.depth * 0.5 + 0.72);
  const xBias = spec.shellBias === 'west-sails' ? -7.2 : 7.1;
  const segmentCount = spec.flightCount / 2;
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const y = tower.deckY + 7.5 + segment * spec.flightRise * 2;
    addBox(
      context,
      'foundation',
      `${spec.name} exterior route channel recess ${segment + 1}`,
      spec.x + xBias,
      y,
      frontZ - frontSign * 0.16,
      1.7,
      8.8,
      0.32,
    );
    addBox(
      context,
      segment === 2 ? 'amberSignal' : 'cyanSignal',
      `${spec.name} exterior vertical route strip ${segment + 1}`,
      spec.x + xBias,
      y,
      frontZ,
      segment === 2 ? 0.82 : 0.62,
      8.05,
      0.18,
    );
    for (const railSide of [-1, 1]) {
      addBox(
        context,
        'trim',
        `${spec.name} exterior route strip armored channel ${segment + 1} ${railSide < 0 ? 'west' : 'east'} rail`,
        spec.x + xBias + railSide * 0.69,
        y,
        frontZ + frontSign * 0.04,
        0.16,
        8.5,
        0.13,
      );
    }
  }

  const secondaryX = spec.x - xBias * 0.64;
  for (let segment = 0; segment < Math.ceil(segmentCount * 0.5); segment += 1) {
    const y = tower.deckY + 15.2 + segment * spec.flightRise * 2;
    addBox(
      context,
      spec.shellBias === 'west-sails' ? 'amberSignal' : 'cyanSignal',
      `${spec.name} secondary command channel ${segment + 1}`,
      secondaryX,
      y,
      frontZ,
      0.42,
      6.4,
      0.16,
    );
  }
}

function addCourtyardPad(
  context: BuildContext,
  name: string,
  x: number,
  z: number,
  width: number,
  depth: number,
): number {
  let minimumTerrain = Number.POSITIVE_INFINITY;
  let maximumTerrain = Number.NEGATIVE_INFINITY;
  for (const xFactor of [-0.5, -0.25, 0, 0.25, 0.5]) {
    for (const zFactor of [-0.5, -0.25, 0, 0.25, 0.5]) {
      const terrainY = sampleMonsoonMeshHeight(
        x + width * xFactor,
        z + depth * zFactor,
        context.seed,
      );
      minimumTerrain = Math.min(minimumTerrain, terrainY);
      maximumTerrain = Math.max(maximumTerrain, terrainY);
    }
  }
  const topY = maximumTerrain + 0.32;
  const bottomY = minimumTerrain - 0.7;
  const foundationHeight = topY - bottomY;
  addChamferedBlock(
    context,
    'foundation',
    x,
    bottomY + foundationHeight * 0.5,
    z,
    width,
    foundationHeight,
    depth,
    2.4,
  );
  addChamferedBlock(context, 'deck', x, topY - 0.2, z, width - 1.2, 0.4, depth - 1.2, 1.8);
  context.colliderBoxes.push({
    name,
    box: new THREE.Box3(
      new THREE.Vector3(x - width * 0.5, bottomY, z - depth * 0.5),
      new THREE.Vector3(x + width * 0.5, topY, z + depth * 0.5),
    ),
  });
  context.platformSurfaces.push({
    name,
    minX: x - width * 0.5,
    maxX: x + width * 0.5,
    minZ: z - depth * 0.5,
    maxZ: z + depth * 0.5,
    y: topY,
  });
  return topY;
}

type CourtyardApproachEdge = 'north' | 'south' | 'east' | 'west';

function addCourtyardApproach(
  context: BuildContext,
  name: string,
  padX: number,
  padZ: number,
  padWidth: number,
  padDepth: number,
  padTopY: number,
  edge: CourtyardApproachEdge,
  width: number,
  signalRole: MaterialRole,
): void {
  let heading = 0;
  let endX = padX;
  let endZ = padZ;
  if (edge === 'north') {
    heading = Math.PI;
    endZ += padDepth * 0.5;
  } else if (edge === 'south') {
    heading = 0;
    endZ -= padDepth * 0.5;
  } else if (edge === 'east') {
    heading = -Math.PI * 0.5;
    endX += padWidth * 0.5;
  } else {
    heading = Math.PI * 0.5;
    endX -= padWidth * 0.5;
  }

  const forwardX = Math.sin(heading);
  const forwardZ = Math.cos(heading);
  let length = 120;
  let startX = endX - forwardX * length;
  let startZ = endZ - forwardZ * length;
  let startY = sampleMonsoonMeshHeight(startX, startZ, context.seed);
  for (let candidateLength = 24; candidateLength <= 120; candidateLength += 2) {
    const candidateX = endX - forwardX * candidateLength;
    const candidateZ = endZ - forwardZ * candidateLength;
    const candidateY = sampleMonsoonMeshHeight(candidateX, candidateZ, context.seed);
    if (Math.abs(padTopY - candidateY) / candidateLength > 0.3) continue;
    length = candidateLength;
    startX = candidateX;
    startZ = candidateZ;
    startY = candidateY;
    break;
  }
  const rise = padTopY - startY;
  if (Math.abs(rise) / length > 0.35) {
    throw new Error(`${name} exceeds the Monsoon courtyard approach grade budget.`);
  }

  const spec: LaunchRampSpec = {
    origin: { x: startX, y: startY, z: startZ },
    heading,
    length,
    width,
    rise,
    curveExponent: 1,
    profile: 'power',
    longitudinalSegments: Math.max(12, Math.ceil(length / 2)),
    lateralSegments: 3,
    solid: false,
  };
  context.stairRamps.push({ name, spec });

  const start = new THREE.Vector3(startX, startY - 0.24, startZ);
  const end = new THREE.Vector3(endX, padTopY - 0.24, endZ);
  addBeamBetween(context, 'deck', `${name} broad anti-slip deck`, start, end, width, 0.48, false);
  const sideX = Math.cos(heading);
  const sideZ = -Math.sin(heading);
  for (const side of [-1, 1]) {
    const lateral = width * 0.5 - 0.32;
    const trimStart = start.clone().add(new THREE.Vector3(sideX * lateral * side, 0.18, sideZ * lateral * side));
    const trimEnd = end.clone().add(new THREE.Vector3(sideX * lateral * side, 0.18, sideZ * lateral * side));
    addBeamBetween(
      context,
      'trim',
      `${name} ${side < 0 ? 'left' : 'right'} armored edge`,
      trimStart,
      trimEnd,
      0.52,
      0.36,
      false,
    );
    addBeamBetween(
      context,
      signalRole,
      `${name} ${side < 0 ? 'left' : 'right'} team route channel`,
      trimStart.clone().add(new THREE.Vector3(0, 0.22, 0)),
      trimEnd.clone().add(new THREE.Vector3(0, 0.22, 0)),
      0.25,
      0.16,
      false,
    );
  }
}

function addCtfBaseCourtyard(context: BuildContext, tower: TowerRuntime): void {
  const { spec } = tower;
  const frontSign = spec.entranceSide === 'south' ? -1 : 1;
  const teamSignal: MaterialRole = spec.shellBias === 'west-sails' ? 'cyanSignal' : 'amberSignal';
  const captureWidth = 76;
  const captureDepth = 56;
  const captureZ = spec.z + frontSign * (spec.depth * 0.5 + 45);
  const captureY = addCourtyardPad(
    context,
    `${spec.name} central capture plaza`,
    spec.x,
    captureZ,
    captureWidth,
    captureDepth,
  );
  const spawnWidth = 50;
  const spawnDepth = 40;
  const spawnOffsetX = spec.width * 0.5 + 38;
  const spawnZ = spec.z - frontSign * 12;
  const westSpawnY = addCourtyardPad(
    context,
    `${spec.name} protected west spawn apron`,
    spec.x - spawnOffsetX,
    spawnZ,
    spawnWidth,
    spawnDepth,
  );
  const eastSpawnY = addCourtyardPad(
    context,
    `${spec.name} protected east spawn apron`,
    spec.x + spawnOffsetX,
    spawnZ,
    spawnWidth,
    spawnDepth,
  );

  const frontEdge: CourtyardApproachEdge = frontSign < 0 ? 'south' : 'north';
  addCourtyardApproach(
    context,
    `${spec.name} capture plaza frontal attack approach`,
    spec.x,
    captureZ,
    captureWidth,
    captureDepth,
    captureY,
    frontEdge,
    14,
    teamSignal,
  );
  addCourtyardApproach(
    context,
    `${spec.name} capture plaza west flank approach`,
    spec.x,
    captureZ,
    captureWidth,
    captureDepth,
    captureY,
    'west',
    13,
    teamSignal,
  );
  addCourtyardApproach(
    context,
    `${spec.name} capture plaza east flank approach`,
    spec.x,
    captureZ,
    captureWidth,
    captureDepth,
    captureY,
    'east',
    13,
    teamSignal,
  );
  addCourtyardApproach(
    context,
    `${spec.name} protected west spawn terrain approach`,
    spec.x - spawnOffsetX,
    spawnZ,
    spawnWidth,
    spawnDepth,
    westSpawnY,
    frontEdge,
    12,
    teamSignal,
  );
  addCourtyardApproach(
    context,
    `${spec.name} protected east spawn terrain approach`,
    spec.x + spawnOffsetX,
    spawnZ,
    spawnWidth,
    spawnDepth,
    eastSpawnY,
    frontEdge,
    12,
    teamSignal,
  );

  const plinthRadius = 10;
  const plinthHeight = 1.6;
  addCylinder(context, 'shell', spec.x, captureY + plinthHeight * 0.5, captureZ, plinthRadius * 0.76, plinthRadius, plinthHeight, 12);
  context.colliderBoxes.push({
    name: `${spec.name} flag capture plinth`,
    box: new THREE.Box3(
      new THREE.Vector3(spec.x - plinthRadius, captureY, captureZ - plinthRadius),
      new THREE.Vector3(spec.x + plinthRadius, captureY + plinthHeight, captureZ + plinthRadius),
    ),
  });
  context.platformSurfaces.push({
    name: `${spec.name} flag capture plinth`,
    minX: spec.x - plinthRadius,
    maxX: spec.x + plinthRadius,
    minZ: captureZ - plinthRadius,
    maxZ: captureZ + plinthRadius,
    y: captureY + plinthHeight,
  });
  addTorus(
    context,
    teamSignal,
    spec.x,
    captureY + plinthHeight + 0.12,
    captureZ,
    plinthRadius - 0.8,
    0.32,
    new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI * 0.5, 0, 0)),
  );
  addCylinder(context, 'trim', spec.x, captureY + plinthHeight + 5.2, captureZ, 0.22, 0.34, 10.4, 8);
  addBox(
    context,
    teamSignal,
    `${spec.name} team flag identity blade`,
    spec.x + 2.5,
    captureY + plinthHeight + 7.5,
    captureZ,
    5,
    4.1,
    0.18,
  );
  addBox(
    context,
    teamSignal,
    `${spec.name} capture-status pylon`,
    spec.x,
    captureY + plinthHeight + 0.75,
    captureZ,
    1.5,
    1.5,
    1.5,
  );

  const rearZ = spec.z - frontSign * (spec.depth * 0.5 + 9);
  const rearGroundY = sampleMonsoonMeshHeight(spec.x, rearZ, context.seed) + 0.08;
  const wallHeight = 7.2;
  for (const side of [-1, 1]) {
    addBox(
      context,
      'shell',
      `${spec.name} rear courtyard blast wall ${side < 0 ? 'west' : 'east'}`,
      spec.x + side * 45,
      rearGroundY + wallHeight * 0.5,
      rearZ,
      58,
      wallHeight,
      2.4,
      { collider: true },
    );
    const sideX = spec.x + side * (spawnOffsetX + spawnWidth * 0.5 + 4);
    const sidePadY = side < 0 ? westSpawnY : eastSpawnY;
    addBox(
      context,
      'shell',
      `${spec.name} ${side < 0 ? 'west' : 'east'} spawn blast wall`,
      sideX,
      sidePadY + wallHeight * 0.5,
      spawnZ - frontSign * 1.5,
      2.4,
      wallHeight,
      spawnDepth + 4,
      { collider: true },
    );
    addTaperedPier(
      context,
      'foundation',
      `${spec.name} ${side < 0 ? 'west' : 'east'} courtyard shield buttress`,
      sideX,
      sidePadY + 5.2,
      spawnZ + frontSign * 11,
      5.6,
      2.6,
      10.4,
      7.2,
      3.4,
      -side * 0.5,
      -frontSign * 0.4,
      false,
    );
  }

  const approachWallZ = captureZ + frontSign * (captureDepth * 0.5 + 3.5);
  for (const side of [-1, 1]) {
    addBox(
      context,
      'foundation',
      `${spec.name} capture approach wing ${side < 0 ? 'west' : 'east'}`,
      spec.x + side * 49,
      captureY + 2.65,
      approachWallZ,
      34,
      5.3,
      2.2,
      { collider: true },
    );
    addBox(
      context,
      teamSignal,
      `${spec.name} capture approach signal ${side < 0 ? 'west' : 'east'}`,
      spec.x + side * 34,
      captureY + 3.1,
      approachWallZ - frontSign * 1.16,
      3.4,
      0.42,
      0.12,
    );
  }
}

function addShell(context: BuildContext, tower: TowerRuntime, random: () => number): void {
  const { spec } = tower;
  const shellHeight = spec.roofRise + 1.8;
  const pierY = tower.deckY + shellHeight * 0.5;
  const inset = 3.3;
  for (const xSign of [-1, 1]) {
    for (const zSign of [-1, 1]) {
      const x = spec.x + xSign * (spec.width * 0.5 - inset);
      const z = spec.z + zSign * (spec.depth * 0.5 - inset);
      addTaperedPier(
        context,
        'shell',
        `${spec.name} ${xSign < 0 ? 'west' : 'east'} ${zSign < 0 ? 'south' : 'north'} storm pier`,
        x,
        pierY,
        z,
        12.5,
        6.2,
        shellHeight,
        12.5,
        6.2,
        xSign * 4.8,
        zSign * 3.6,
      );
    }
  }

  addDoorWall(context, tower);
  const rearZ = spec.z + (spec.entranceSide === 'north' ? -spec.depth * 0.5 : spec.depth * 0.5);
  addBox(context, 'shell', `${spec.name} ground rear wall`, spec.x, tower.deckY + spec.flightRise, rearZ, spec.width - 10, spec.flightRise * 2, 1.4, { collider: true });
  addBox(context, 'shell', `${spec.name} ground west wall`, spec.x - spec.width * 0.5, tower.deckY + spec.flightRise, spec.z, 1.4, spec.flightRise * 2, spec.depth - 10, { collider: true });
  addBox(context, 'shell', `${spec.name} ground east wall`, spec.x + spec.width * 0.5, tower.deckY + spec.flightRise, spec.z, 1.4, spec.flightRise * 2, spec.depth - 10, { collider: true });

  addSlopedFoundationArmor(context, tower);
  addArmoredCoreEnvelope(context, tower);
  addLandingDeckFascias(context, tower);
  addExteriorRouteStrips(context, tower);

  // The foundation itself supplies the base ring. Beginning one storey up
  // keeps the full doorway width free of an ankle-high perimeter beam.
  const storeyCount = spec.flightCount / 2;
  for (let story = 1; story <= storeyCount; story += 1) {
    addPerimeterRing(
      context,
      tower,
      `${spec.name} structural ring ${story}`,
      tower.deckY + story * spec.flightRise * 2 + 0.46,
      story === storeyCount ? 1.3 : 0.82,
    );
  }

  const revealStoreys = [2, 5, 8, 10].filter((story) => story < storeyCount);
  for (const story of revealStoreys) {
    const levelY = tower.deckY + story * spec.flightRise * 2 - spec.flightRise;
    const panelHeight = spec.flightRise * 1.18;
    const panelWidth = Math.min(15.5, spec.width * 0.27);
    const side = (story + (spec.shellBias === 'west-sails' ? 0 : 1)) % 2 === 0 ? -1 : 1;
    const panelX = spec.x + side * spec.width * 0.5;
    const panelZ = spec.z + (story % 2 === 0 ? -1 : 1) * spec.depth * 0.18;
    addBox(context, 'glass', `${spec.name} level ${story} storm screen`, panelX, levelY, panelZ, 0.44, panelHeight, panelWidth, { collider: true });
    addBox(context, 'cyanSignal', `${spec.name} level ${story} route light`, panelX - side * 0.36, levelY, panelZ, 0.13, panelHeight * 0.72, panelWidth * 0.72);
  }

  // Four overhanging fascia beams preserve the open stairwell instead of
  // turning the roof into a solid cap over the final switchback flight.
  const roofThickness = 0.72;
  const roofWidth = spec.width + 8;
  const roofDepth = spec.depth + 8;
  const fasciaWidth = 4.2;
  addBox(context, 'foundation', `${spec.name} roof north fascia`, spec.x, tower.roofY - roofThickness * 0.5, spec.z + roofDepth * 0.5 - fasciaWidth * 0.5, roofWidth, roofThickness, fasciaWidth, { collider: true });
  addBox(context, 'foundation', `${spec.name} roof south fascia`, spec.x, tower.roofY - roofThickness * 0.5, spec.z - roofDepth * 0.5 + fasciaWidth * 0.5, roofWidth, roofThickness, fasciaWidth, { collider: true });
  addBox(context, 'foundation', `${spec.name} roof west fascia`, spec.x - roofWidth * 0.5 + fasciaWidth * 0.5, tower.roofY - roofThickness * 0.5, spec.z, fasciaWidth, roofThickness, roofDepth - fasciaWidth * 2, { collider: true });
  addBox(context, 'foundation', `${spec.name} roof east fascia`, spec.x + roofWidth * 0.5 - fasciaWidth * 0.5, tower.roofY - roofThickness * 0.5, spec.z, fasciaWidth, roofThickness, roofDepth - fasciaWidth * 2, { collider: true });

  const cabinWidth = spec.shellBias === 'west-sails' ? 38 : 34;
  const cabinDepth = spec.shellBias === 'west-sails' ? 27 : 36;
  const cabinOffsetMagnitude = spec.width * 0.5 - cabinWidth * 0.5 - 5;
  const cabinOffsetX = spec.shellBias === 'west-sails' ? cabinOffsetMagnitude : -cabinOffsetMagnitude;
  addBox(context, 'shell', `${spec.name} roof storm cabin`, spec.x + cabinOffsetX, tower.roofY + 6, spec.z, cabinWidth, 12, cabinDepth, { collider: true });
  addBox(context, 'glass', `${spec.name} roof cabin observation glass`, spec.x + cabinOffsetX, tower.roofY + 6.6, spec.z + (spec.entranceSide === 'south' ? cabinDepth * 0.5 + 0.08 : -cabinDepth * 0.5 - 0.08), cabinWidth * 0.76, 4.8, 0.24);

  const railInset = 1.1;
  const railY = tower.roofY + 0.7;
  addBox(context, 'trim', `${spec.name} roof north safety rail`, spec.x, railY, spec.z + roofDepth * 0.5 - railInset, roofWidth - 2.2, 1.35, 0.18, { collider: true });
  addBox(context, 'trim', `${spec.name} roof south safety rail`, spec.x, railY, spec.z - roofDepth * 0.5 + railInset, roofWidth - 2.2, 1.35, 0.18, { collider: true });
  addBox(context, 'trim', `${spec.name} roof west safety rail`, spec.x - roofWidth * 0.5 + railInset, railY, spec.z, 0.18, 1.35, roofDepth - 2.2, { collider: true });
  addBox(context, 'trim', `${spec.name} roof east safety rail`, spec.x + roofWidth * 0.5 - railInset, railY, spec.z, 0.18, 1.35, roofDepth - 2.2, { collider: true });

  const mastHeight = spec.architecturalHeight - spec.roofRise;
  const mastX = spec.x + (spec.shellBias === 'west-sails' ? -5.4 : 4.8);
  const mastZ = spec.z + (random() - 0.5) * 2.4;
  addTaperedPier(
    context,
    'trim',
    `${spec.name} lightning mast`,
    mastX,
    tower.roofY + mastHeight * 0.5,
    mastZ,
    1.1,
    0.22,
    mastHeight,
    1.1,
    0.22,
    (random() - 0.5) * 0.5,
    (random() - 0.5) * 0.5,
  );
  addBox(context, 'cyanSignal', `${spec.name} mast signal`, mastX, tower.deckY + spec.architecturalHeight - 0.5, mastZ, 0.46, 1.2, 0.46);
}

function addWestStormSails(context: BuildContext, tower: TowerRuntime): void {
  const { spec } = tower;
  const x = spec.x - spec.width * 0.5 - 2.4;
  for (let index = 0; index < 3; index += 1) {
    const height = 45 - index * 5.2;
    const y = tower.deckY + 35 + index * 55;
    const z = spec.z + (index - 1) * 24;
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -0.2 - index * 0.035));
    addTaperedPier(
      context,
      'shell',
      `${spec.name} west armored storm vane ${index + 1}`,
      x - 0.25 - index * 0.35,
      y,
      z,
      3.8,
      1.7,
      height + 2.4,
      9.2,
      6.2,
      0.7,
      index === 1 ? 0.65 : -0.35,
      false,
    );
    addBox(context, 'shell', `${spec.name} west storm sail ${index + 1}`, x - index * 0.35, y, z, 1.15, height, 7.6, { quaternion, collider: true });
    addBox(context, 'amberSignal', `${spec.name} west storm sail signal ${index + 1}`, x - 0.64 - index * 0.35, y, z, 0.1, height * 0.66, 5.8, { quaternion });
    addBox(context, 'trim', `${spec.name} west storm vane cap ${index + 1}`, x - 0.48 - index * 0.35, y + height * 0.38, z, 0.28, height * 0.23, 7.2, { quaternion });
  }

  const podX = spec.x + spec.width * 0.5 + 12;
  const podY = tower.deckY + spec.roofRise * 0.7;
  const podZ = spec.z + 3.8;
  addChamferedBlock(context, 'foundation', podX, podY - 7.1, podZ, 50, 1.8, 30, 3.2);
  addChamferedBlock(context, 'shell', podX, podY, podZ, 42, 13, 25, 3.1);
  addBox(context, 'glass', `${spec.name} command pod east observation face`, podX + 21.12, podY + 0.65, podZ, 0.24, 6.2, 18.5);
  addBox(context, 'glass', `${spec.name} command pod north observation face`, podX, podY + 0.65, podZ + 12.62, 30, 6.2, 0.24);
  addBox(context, 'glass', `${spec.name} command pod south observation face`, podX, podY + 0.65, podZ - 12.62, 23, 6.2, 0.24);
  addBox(context, 'cyanSignal', `${spec.name} command pod command-status bar`, podX + 21.26, podY - 3.8, podZ, 0.16, 0.72, 20);
  addBeamBetween(
    context,
    'foundation',
    `${spec.name} command pod lower diagonal brace`,
    new THREE.Vector3(spec.x + spec.width * 0.5 - 0.8, tower.deckY + spec.roofRise * 0.46, podZ - 3.6),
    new THREE.Vector3(podX + 19, podY - 8, podZ - 10),
    1.35,
    1.55,
    false,
  );
  addBeamBetween(
    context,
    'foundation',
    `${spec.name} command pod upper diagonal brace`,
    new THREE.Vector3(spec.x + spec.width * 0.5 - 0.8, tower.deckY + spec.roofRise * 0.88, podZ + 3.6),
    new THREE.Vector3(podX + 19, podY + 6, podZ + 10),
    1.05,
    1.25,
    false,
  );

  const commandBridgeY = tower.roofY + 5;
  addChamferedBlock(context, 'foundation', spec.x, tower.roofY + 0.8, spec.z - 3, 70, 1.6, 34, 3.8);
  addChamferedBlock(context, 'shell', spec.x, commandBridgeY, spec.z - 3, 62, 8.5, 28, 3.4);
  addBox(context, 'glass', `${spec.name} crown command bridge north glass`, spec.x, commandBridgeY + 0.4, spec.z + 11.12, 46, 4.2, 0.24);
  addBox(context, 'glass', `${spec.name} crown command bridge east glass`, spec.x + 31.12, commandBridgeY + 0.4, spec.z - 3, 0.24, 4.2, 19);
  addBox(context, 'cyanSignal', `${spec.name} crown command bridge horizon bar`, spec.x, commandBridgeY - 2.55, spec.z + 11.26, 50, 0.58, 0.14);

  const crownBaseY = tower.roofY + 8;
  for (const [index, xOffset] of [-9, 0, 9].entries()) {
    const tineHeight = index === 1 ? 16 : 12;
    addTaperedPier(
      context,
      'trim',
      `${spec.name} forked crown tine ${index + 1}`,
      spec.x + xOffset,
      crownBaseY + tineHeight * 0.5,
      spec.z - 2.8,
      index === 1 ? 1.05 : 0.78,
      0.18,
      tineHeight,
      index === 1 ? 1.05 : 0.78,
      0.18,
      xOffset * 0.05,
      -0.35,
      false,
    );
    addCylinder(context, index === 1 ? 'cyanSignal' : 'amberSignal', spec.x + xOffset, crownBaseY + tineHeight - 0.35, spec.z - 2.8, 0.34, 0.34, 0.7, 8);
  }
  addBox(context, 'shell', `${spec.name} forked crown crossbar`, spec.x, crownBaseY + 5.5, spec.z - 2.8, 28, 1.3, 2.1);
  addTorus(
    context,
    'cyanSignal',
    spec.x,
    crownBaseY + 8,
    spec.z - 2.9,
    8.5,
    0.36,
    new THREE.Quaternion(),
  );
}

function addEastCantilever(context: BuildContext, tower: TowerRuntime): void {
  const { spec } = tower;
  const topY = tower.deckY + spec.flightRise * 22;
  const minX = spec.x + spec.width * 0.5 - 2.2;
  const maxX = minX + 10.5;
  const minZ = spec.z - 7.2;
  const maxZ = spec.z + 7.2;
  addPlatformSlab(context, 'deck', `${spec.name} east cantilever overlook`, minX, maxX, minZ, maxZ, topY, 0.5);
  addBox(context, 'trim', `${spec.name} cantilever north rail`, (minX + maxX) * 0.5, topY + 0.68, maxZ, maxX - minX, 1.34, 0.15, { collider: true });
  addBox(context, 'trim', `${spec.name} cantilever south rail`, (minX + maxX) * 0.5, topY + 0.68, minZ, maxX - minX, 1.34, 0.15, { collider: true });
  addBox(context, 'trim', `${spec.name} cantilever east rail`, maxX, topY + 0.68, (minZ + maxZ) * 0.5, 0.15, 1.34, maxZ - minZ, { collider: true });
  const braceStart = new THREE.Vector3(spec.x + spec.width * 0.5 - 0.5, topY - 0.4, spec.z);
  const braceEnd = new THREE.Vector3(maxX - 0.8, topY - 8.2, spec.z);
  addBeamBetween(context, 'foundation', `${spec.name} cantilever storm brace`, braceStart, braceEnd, 0.65, 0.65, true);
  addBox(context, 'cyanSignal', `${spec.name} cantilever edge signal`, maxX + 0.08, topY - 0.08, spec.z, 0.12, 0.22, maxZ - minZ - 1.2);

  const podX = spec.x - spec.width * 0.5 - 12;
  const podY = topY + 7;
  const podZ = spec.z - 3.8;
  const podYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -0.08);
  addChamferedBlock(context, 'shell', podX, podY, podZ, 42, 13, 28, 3.2, podYaw);
  addChamferedBlock(context, 'foundation', podX - 0.5, topY + 1.5, podZ, 50, 1.6, 33, 3.5, podYaw);
  addBox(context, 'glass', `${spec.name} cantilever command pod west glass`, podX - 21.12, podY + 0.6, podZ, 0.24, 6, 21, { quaternion: podYaw });
  addBox(context, 'glass', `${spec.name} cantilever command pod south glass`, podX, podY + 0.6, podZ - 14.12, 30, 6, 0.24, { quaternion: podYaw });
  addBox(context, 'glass', `${spec.name} cantilever command pod north glass`, podX, podY + 0.6, podZ + 14.12, 23, 6, 0.24, { quaternion: podYaw });
  addBox(context, 'amberSignal', `${spec.name} cantilever command pod alert blade`, podX - 21.26, podY - 3.8, podZ, 0.16, 0.72, 22, { quaternion: podYaw });
  addBeamBetween(
    context,
    'trim',
    `${spec.name} command pod dorsal brace`,
    new THREE.Vector3(spec.x - spec.width * 0.5 + 1, topY + 10.2, spec.z + 4.2),
    new THREE.Vector3(podX - 19, podY + 6, podZ + 11),
    1.05,
    1.25,
    false,
  );

  addBeamBetween(
    context,
    'foundation',
    `${spec.name} command pod ventral brace`,
    new THREE.Vector3(spec.x - spec.width * 0.5 + 0.8, topY - 7.4, spec.z - 4.8),
    new THREE.Vector3(podX - 19, topY + 0.7, podZ - 11),
    1.35,
    1.5,
    false,
  );

  addChamferedBlock(context, 'foundation', spec.x + 3, tower.roofY + 0.8, spec.z + 2.5, 54, 1.6, 40, 4);
  addChamferedBlock(context, 'shell', spec.x + 3, tower.roofY + 4.2, spec.z + 2.5, 46, 7, 34, 3.5);
  addBox(context, 'glass', `${spec.name} radar control canopy`, spec.x + 3, tower.roofY + 4.6, spec.z - 14.62, 33, 3.6, 0.24);
  const crownY = tower.roofY + 8;
  addCylinder(context, 'shell', spec.x + 5, tower.roofY + 4.5, spec.z + 3, 3.2, 4.2, 9, 12);
  addCylinder(context, 'trim', spec.x + 5, crownY, spec.z + 3, 0.95, 1.35, 2.1, 12);
  const radarTilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.18, 0.32, 0.12));
  addTorus(context, 'trim', spec.x + 5, crownY, spec.z + 3, 10, 0.56, radarTilt);
  addTorus(context, 'cyanSignal', spec.x + 5, crownY, spec.z + 3, 7.8, 0.3, radarTilt);
  for (const angle of [-0.72, 0, 0.72]) {
    const bladeQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, angle, -0.16));
    addChamferedBlock(
      context,
      'shell',
      spec.x + 5 + Math.sin(angle) * 5.2,
      crownY,
      spec.z + 3 + Math.cos(angle) * 1.4,
      0.5,
      14,
      2.8,
      0.16,
      bladeQuaternion,
    );
  }
  addCylinder(context, 'amberSignal', spec.x + 5, crownY, spec.z + 3, 0.82, 0.82, 1.15, 12, radarTilt);
}

function terrainExtrema(spec: TowerSpec, seed: number): { minimum: number; maximum: number } {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const xFactor of [-0.46, 0, 0.46]) {
    for (const zFactor of [-0.46, 0, 0.46]) {
      const height = sampleMonsoonMeshHeight(
        spec.x + spec.width * xFactor,
        spec.z + spec.depth * zFactor,
        seed,
      );
      minimum = Math.min(minimum, height);
      maximum = Math.max(maximum, height);
    }
  }
  return { minimum, maximum };
}

function buildTower(context: BuildContext, spec: TowerSpec, towerIndex: number): void {
  const terrain = terrainExtrema(spec, context.seed);
  const deckY = terrain.maximum + 0.55;
  const foundationBottomY = terrain.minimum - 0.8;
  const tower: TowerRuntime = {
    spec,
    deckY,
    foundationBottomY,
    roofY: deckY + spec.roofRise,
  };
  const random = createSeededRandom((context.seed ^ Math.imul(towerIndex + 1, 0x9e3779b1)) >>> 0);
  const foundationHeight = deckY - foundationBottomY;
  addGeometry(
    context,
    'foundation',
    createChamferedPrismGeometry(spec.width, foundationHeight, spec.depth, 2.6),
    new THREE.Matrix4().makeTranslation(spec.x, foundationBottomY + foundationHeight * 0.5, spec.z),
  );
  context.colliderBoxes.push({
    name: `${spec.name} terrain-sealed foundation`,
    box: new THREE.Box3(
      new THREE.Vector3(spec.x - spec.width * 0.5, foundationBottomY, spec.z - spec.depth * 0.5),
      new THREE.Vector3(spec.x + spec.width * 0.5, deckY, spec.z + spec.depth * 0.5),
    ),
  });
  context.platformSurfaces.push({
    name: `${spec.name} ground operations floor`,
    minX: spec.x - spec.width * 0.5,
    maxX: spec.x + spec.width * 0.5,
    minZ: spec.z - spec.depth * 0.5,
    maxZ: spec.z + spec.depth * 0.5,
    y: deckY,
  });

  addCtfBaseCourtyard(context, tower);
  addInternalCirculation(context, tower);
  addShell(context, tower, random);
  addGroundEntranceRamp(context, tower);
  if (spec.shellBias === 'west-sails') addWestStormSails(context, tower);
  else addEastCantilever(context, tower);

  context.placementDiagnostics.push({
    name: spec.name,
    center: { x: spec.x, y: deckY, z: spec.z },
    footprint: { width: spec.width, depth: spec.depth },
    architecturalHeight: spec.architecturalHeight,
    roofHeight: spec.roofRise,
    entranceSide: spec.entranceSide,
    doorwayWidth: spec.doorwayWidth,
    doorwayHeight: spec.doorwayHeight,
    stairWidth: spec.stairWidth,
    stairFlightCount: spec.flightCount,
    intermediateLandingCount: spec.flightCount - 1,
  });
  const cameraDirection = towerIndex === 0 ? 1 : -1;
  context.reviewViews.push({
    name: `${spec.name} exterior and circulation review`,
    camera: {
      x: spec.x + cameraDirection * 420,
      y: deckY + 160,
      z: spec.z + cameraDirection * 420,
    },
    target: { x: spec.x, y: deckY + spec.roofRise * 0.52, z: spec.z },
  });
}

function createMaterials(): Record<MaterialRole, THREE.Material> {
  const foundation = new THREE.MeshStandardMaterial({
    name: 'Monsoon outpost dark load-bearing basalt',
    color: 0x17252c,
    roughness: 0.88,
    metalness: 0.18,
  });
  const shell = new THREE.MeshStandardMaterial({
    name: 'Monsoon outpost storm-washed armor',
    color: 0x38505a,
    roughness: 0.62,
    metalness: 0.52,
  });
  const deck = new THREE.MeshStandardMaterial({
    name: 'Monsoon outpost wet anti-slip deck',
    color: 0x526870,
    roughness: 0.48,
    metalness: 0.34,
  });
  const trim = new THREE.MeshStandardMaterial({
    name: 'Monsoon outpost conductive edge trim',
    color: 0x8da2a8,
    roughness: 0.3,
    metalness: 0.78,
  });
  const glass = new THREE.MeshPhysicalMaterial({
    name: 'Monsoon outpost smoked storm glass',
    color: 0x244b55,
    roughness: 0.2,
    metalness: 0.18,
    clearcoat: 0.72,
    clearcoatRoughness: 0.22,
    transparent: true,
    opacity: 0.82,
  });
  const cyanSignal = new THREE.MeshStandardMaterial({
    name: 'Monsoon outpost cyan route signal',
    color: 0x4de7ef,
    emissive: 0x159eb2,
    emissiveIntensity: 2.35,
    roughness: 0.24,
    metalness: 0.12,
    toneMapped: false,
  });
  const amberSignal = new THREE.MeshStandardMaterial({
    name: 'Monsoon outpost amber storm signal',
    color: 0xffb65a,
    emissive: 0xb95a18,
    emissiveIntensity: 2.15,
    roughness: 0.28,
    metalness: 0.1,
    toneMapped: false,
  });
  return { foundation, shell, deck, trim, glass, cyanSignal, amberSignal };
}

function minimumCenterDistance(): number {
  return Math.min(...TOWER_SPECS.map((spec) => Math.hypot(spec.x, spec.z)));
}

function minimumKnownRelayClearance(): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const tower of TOWER_SPECS) {
    for (const [relayX, relayZ] of KNOWN_RELAY_CENTERS) {
      minimum = Math.min(minimum, Math.hypot(tower.x - relayX, tower.z - relayZ));
    }
  }
  return minimum;
}

export function buildMonsoonOutpostTowers(seed: number): MonsoonOutpostTowersBuild {
  const context: BuildContext = {
    seed,
    parts: {
      foundation: [],
      shell: [],
      deck: [],
      trim: [],
      glass: [],
      cyanSignal: [],
      amberSignal: [],
    },
    colliderBoxes: [],
    platformSurfaces: [],
    stairRamps: [],
    placementDiagnostics: [],
    reviewViews: [],
  };
  TOWER_SPECS.forEach((spec, index) => buildTower(context, spec, index));

  const group = new THREE.Group();
  group.name = 'Monsoon Divide monumental traversable outpost towers';
  group.userData = {
    source: MONSOON_OUTPOST_TOWERS_SOURCE,
    license: MONSOON_OUTPOST_TOWERS_LICENSE,
    deterministicSeed: seed,
    projectOriginal: true,
  };
  const materialByRole = createMaterials();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  let expectedShadowDrawCalls = 0;
  for (const role of MATERIAL_ROLES) {
    const parts = context.parts[role];
    if (parts.length === 0) continue;
    const geometry = mergeGeometries(parts, false);
    parts.forEach((part) => part.dispose());
    if (!geometry) throw new Error(`Failed to merge Monsoon outpost ${role} geometry.`);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    geometry.userData = { family: `monsoon-outpost-${role}`, collisionProvidedSeparately: true };
    const material = materialByRole[role];
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `Monsoon outpost towers ${role}`;
    mesh.castShadow = role === 'foundation' || role === 'shell' || role === 'deck';
    mesh.receiveShadow = role !== 'cyanSignal' && role !== 'amberSignal';
    if (mesh.castShadow) expectedShadowDrawCalls += 1;
    group.add(mesh);
    geometries.push(geometry);
    materials.push(material);
  }

  const estimatedVisibleTriangles = geometries.reduce((total, geometry) => (
    total + geometry.getAttribute('position').count / 3
  ), 0);
  if (group.children.length > 8) throw new Error('Monsoon outpost visible draw-call budget exceeded.');
  if (estimatedVisibleTriangles > 120_000) throw new Error('Monsoon outpost triangle budget exceeded.');
  if (context.reviewViews.length !== 2) throw new Error('Monsoon outpost review view contract requires two views.');

  const diagnostics: MonsoonOutpostTowersDiagnostics = {
    source: MONSOON_OUTPOST_TOWERS_SOURCE,
    license: MONSOON_OUTPOST_TOWERS_LICENSE,
    assetStrategy: 'deterministic-project-original-procedural-kit',
    seed,
    deterministic: true,
    collisionReady: true,
    towerCount: 2,
    towerNames: TOWER_SPECS.map((spec) => spec.name),
    towers: context.placementDiagnostics,
    minimumCenterDistance: minimumCenterDistance(),
    minimumKnownRelayClearance: minimumKnownRelayClearance(),
    colliderBoxCount: context.colliderBoxes.length,
    platformSurfaceCount: context.platformSurfaces.length,
    stairRampCount: context.stairRamps.length,
    visibleMeshCount: group.children.length,
    instancedMeshCount: 0,
    expectedVisibleDrawCalls: group.children.length,
    expectedShadowDrawCalls,
    geometryCount: geometries.length,
    materialCount: materials.length,
    textureCount: 0,
    estimatedVisibleTriangles,
    addedTriangleBudget: 120_000,
  };

  return {
    group,
    geometries,
    materials,
    textures: [],
    colliderBoxes: context.colliderBoxes,
    platformSurfaces: context.platformSurfaces,
    stairRamps: context.stairRamps,
    diagnostics,
    reviewViews: context.reviewViews as [MonsoonOutpostReviewView, MonsoonOutpostReviewView],
  };
}
