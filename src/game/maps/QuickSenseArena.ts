import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'meshoptimizer';
import { MeshBVH } from 'three-mesh-bvh';
import { assetUrl } from '../../assets/assetUrl';
import type { WeatherGameplaySnapshot, WeatherPhase } from '../../systems/WeatherGameplaySystem';
import { MOVEMENT } from '../config';
import type {
  ArenaMapInfo,
  ArenaRuntime,
  ArenaSurface,
  ArenaWeatherVisualDiagnostics,
  CapsuleContact,
  JumpPad,
  SurfaceHit,
} from '../Arena';
import {
  buildLaunchRamp,
  sampleLaunchRampHeight,
  sampleLaunchRampProfile,
  type FlowSurfaceBuild,
  type LaunchRampSpec,
} from './FlowGeometry';
import {
  applyGroundedCelDepth,
  createQuickSenseSurfaceTextures,
} from './QuickSenseSurfaceTextures';

export const QUICKSENSE = {
  id: 'quicksense',
  name: 'QuickSense',
  generationVersion: 6,
  width: 360,
  depth: 320,
  killY: -24,
} as const;

type PathPoint = { x: number; y: number; z: number };

type PathSurface = {
  name: string;
  points: PathPoint[];
  vertexNormals: PathPoint[];
  width: number;
  bank: number;
  banks: number[];
  closed: boolean;
  contains(x: number, z: number): boolean;
  heightAt(x: number, z: number): number | null;
  normalAt(x: number, z: number, target?: THREE.Vector3): THREE.Vector3 | null;
};

type PlatformSurface = {
  name: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  y: number;
};

type QuickCollider = {
  box: THREE.Box3;
  name: string;
  blocksMovement: boolean;
};

type RampSurface = {
  name: string;
  spec: LaunchRampSpec;
  flow: FlowSurfaceBuild;
};

type BuildingEntryRampSurface = {
  name: string;
  start: THREE.Vector3;
  end: THREE.Vector3;
  width: number;
};

type AnimatedProp = {
  object: THREE.Object3D;
  baseY: number;
  phase: number;
  spin: number;
};

type InstanceTransform = {
  position: THREE.Vector3;
  scale: THREE.Vector3;
  yaw?: number;
  rotation?: THREE.Euler;
};

type AccentRole = 'cyan' | 'magenta' | 'amber';

type HabitatFamily = 'foundry' | 'observatory' | 'relay';
type HabitatSignature =
  | 'twin-stack'
  | 'bridge-crane'
  | 'halo-dome'
  | 'split-dish'
  | 'fork-mast'
  | 'signal-spire'
  | 'cross-array'
  | 'split-fin';
type FloatingBuildingProfile = 'skydock' | 'needle' | 'command';

type BuildingAuditEntry = {
  name: string;
  category: 'cliff-habitat' | 'floating-station' | 'citadel' | 'grapple-tower' | 'gateway';
  profile: string;
  accent: AccentRole;
  position: { x: number; y: number; z: number };
};

type GroundBuildingSpec = {
  name: string;
  family: HabitatFamily;
  signature: HabitatSignature;
  x: number;
  z: number;
  roofY: number;
  width: number;
  depth: number;
  height: number;
  yaw: number;
  accent: AccentRole;
};

type FloatingBuildingSpec = {
  name: string;
  profile: FloatingBuildingProfile;
  x: number;
  z: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  yaw: number;
  accent: AccentRole;
};

// One source of truth drives the rendered facilities, mountain excavations,
// terrain approaches, audit metadata, and collision.  Keeping a second set of
// approximate mountain slots allowed the cliff to drift into the buildings as
// their silhouettes evolved.
const CLIFF_HABITAT_SPECS: ReadonlyArray<GroundBuildingSpec> = [
  { name: 'Southwest Forge', family: 'foundry', signature: 'twin-stack', x: -67, z: -86, roofY: 31, width: 34, depth: 22, height: 13, yaw: Math.PI, accent: 'cyan' },
  { name: 'Southeast Smelter', family: 'foundry', signature: 'bridge-crane', x: 67, z: -86, roofY: 34, width: 36, depth: 22, height: 14, yaw: Math.PI, accent: 'magenta' },
  { name: 'Northwest Lens', family: 'observatory', signature: 'halo-dome', x: -55, z: 86, roofY: 39, width: 34, depth: 22, height: 14, yaw: 0, accent: 'cyan' },
  { name: 'Northeast Array', family: 'observatory', signature: 'split-dish', x: 55, z: 86, roofY: 42, width: 36, depth: 22, height: 15, yaw: 0, accent: 'magenta' },
  { name: 'West Scar Relay', family: 'relay', signature: 'fork-mast', x: -99, z: -39, roofY: 36, width: 30, depth: 22, height: 13, yaw: -Math.PI * 0.5, accent: 'cyan' },
  { name: 'West Crown Habitat', family: 'relay', signature: 'signal-spire', x: -99, z: 40, roofY: 44, width: 38, depth: 22, height: 16, yaw: -Math.PI * 0.5, accent: 'amber' },
  { name: 'East Crown Habitat', family: 'relay', signature: 'cross-array', x: 99, z: -40, roofY: 45, width: 38, depth: 22, height: 16, yaw: Math.PI * 0.5, accent: 'amber' },
  { name: 'East Scar Relay', family: 'relay', signature: 'split-fin', x: 99, z: 39, roofY: 38, width: 32, depth: 22, height: 14, yaw: Math.PI * 0.5, accent: 'magenta' },
] as const;

const CLIFF_HABITAT_APPROACHES = CLIFF_HABITAT_SPECS.map((spec) => {
  const localFront = -spec.depth * 0.5;
  const facesNorthSouth = Math.abs(Math.cos(spec.yaw)) > 0.5;
  return {
    x: spec.x + localFront * Math.sin(spec.yaw),
    z: spec.z + localFront * Math.cos(spec.yaw),
    radiusX: facesNorthSouth ? spec.width * 0.62 : 15,
    radiusZ: facesNorthSouth ? 16 : spec.width * 0.58,
    threshold: spec.roofY - spec.height - 0.5,
  };
});

// The four entry houses sit inside the central basin's raised north/south
// shoulders.  Keep a small authored shelf around each footprint so their
// lower shells meet terrain instead of being swallowed by the mountain mesh.
const ENTRY_GATEHOUSE_APPROACHES = [
  { x: -10.6, z: 61, yaw: 0.08, width: 10.2, depth: 15, threshold: 2.9 },
  { x: 10.6, z: 61, yaw: -0.08, width: 10.2, depth: 15, threshold: 2.9 },
  { x: -10.6, z: -61, yaw: -0.05, width: 10.2, depth: 15, threshold: 0.4 },
  { x: 10.6, z: -61, yaw: 0.05, width: 10.2, depth: 15, threshold: 0.4 },
] as const;

function habitatPortalOffset(signature: HabitatSignature): number {
  switch (signature) {
    case 'twin-stack': return -0.2;
    case 'bridge-crane': return 0.22;
    case 'fork-mast': return -0.14;
    case 'signal-spire': return 0.18;
    case 'split-fin': return -0.12;
    default: return 0;
  }
}

const EPSILON = 0.0001;
const QUICK_LOCAL_WIDTH = 180;
const QUICK_LOCAL_DEPTH = 160;
const QUICK_HORIZONTAL_SCALE = 2;
const QUICK_VERTICAL_SCALE = 1.6;
const QUICK_WEATHER_DIRECTION = new THREE.Vector2(0.82, 0.28).normalize();
const RAMP_POINT_VISUAL_LIFT = 0.2;
const SUPPORT_CONTACT_EPSILON = 0.002;

function pathDeckBottomDepth(name: string): number {
  if (name.includes('outer basin')) return 1.88;
  if (name.includes('inner momentum')) return 1.56;
  return 1.72;
}
// The arena root is deliberately non-uniformly scaled. Counter-scale the
// imported source so one source unit resolves to one world metre; the previous
// 1.28x/1.44x world scale put ordinary guard rails above the player's view.
const OUTPOST_TOWER_MODEL_SCALE_XZ = 1 / QUICK_HORIZONTAL_SCALE;
const OUTPOST_TOWER_MODEL_SCALE_Y = 1 / QUICK_VERTICAL_SCALE;

// Player-scale support laid directly over the imported tower's visible stair
// chain. Coordinates remain in the GLB's source space and are transformed with
// the model at runtime, so later scale/seat changes cannot desynchronise the
// smooth collision route from the rendered treads.
const OUTPOST_TOWER_SOURCE_SMOOTH_ROUTES = [
  { name: 'east lower stair', start: [13.28125, 0.00496, 12.10938], end: [18.75, 3.08274, 11.71875], width: 3.51563 },
  { name: 'east mid stair', start: [18.75, 3.08274, 11.32813], end: [18.75, 5.88274, 5.85938], width: 3.51563 },
  { name: 'east upper stair', start: [18.75, 5.88274, 5.85938], end: [18.75, 7.13829, -4.29688], width: 3.51563 },
  { name: 'east deck stair', start: [17.96875, 7.56051, -4.6875], end: [11.25, 10.12718, -5.07813], width: 4.375 },
  { name: 'interior stair one', start: [11.32813, 10.12718, -4.29688], end: [11.32813, 11.07162, -2.34375], width: 2.96875 },
  { name: 'interior stair two', start: [11.32813, 11.07162, -2.34375], end: [9.375, 12.00496, -0.39063], width: 2.96875 },
  { name: 'interior stair three', start: [9.375, 12.00496, -0.39063], end: [7.42188, 13.06051, 0], width: 2.96875 },
  { name: 'interior stair four', start: [7.42188, 13.06051, 0], end: [5.46875, 14.09385, 0.78125], width: 2.96875 },
  { name: 'interior stair five', start: [5.46875, 14.09385, 0.78125], end: [2.73438, 15.56051, 3.51563], width: 2.96875 },
] as const;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothPulse(value: number): number {
  const clamped = clamp01(value);
  return clamped * clamped * (3 - clamped * 2);
}

function smootherPulse(value: number): number {
  const clamped = clamp01(value);
  return clamped * clamped * clamped * (clamped * (clamped * 6 - 15) + 10);
}

function linearSwaleDepth(
  x: number,
  z: number,
  startX: number,
  startZ: number,
  endX: number,
  endZ: number,
): number {
  const dx = endX - startX;
  const dz = endZ - startZ;
  const lengthSquared = dx * dx + dz * dz;
  const t = clamp01(((x - startX) * dx + (z - startZ) * dz) / lengthSquared);
  const centerX = startX + dx * t;
  const centerZ = startZ + dz * t;
  const lateralDistance = Math.hypot(x - centerX, z - centerZ);
  const halfWidth = 10.5;
  const coreHalfWidth = 3.8;
  if (lateralDistance >= halfWidth) return 0;
  const envelope = lateralDistance <= coreHalfWidth
    ? 1
    : smootherPulse((halfWidth - lateralDistance) / (halfWidth - coreHalfWidth));
  const wave = Math.sin(Math.PI * 3 * t) ** 4;
  return 6.4 * wave * envelope;
}

function ellipseInfluence(
  x: number,
  z: number,
  centerX: number,
  centerZ: number,
  radiusX: number,
  radiusZ: number,
): number {
  const nx = (x - centerX) / radiusX;
  const nz = (z - centerZ) / radiusZ;
  const distance = Math.sqrt(nx * nx + nz * nz);
  return distance >= 1 ? 0 : 1 - smoothPulse(distance);
}

function ellipsePoints(
  centerX: number,
  centerZ: number,
  radiusX: number,
  radiusZ: number,
  segments: number,
  y: number,
  phase = 0,
): PathPoint[] {
  return Array.from({ length: segments }, (_, index) => {
    const angle = phase + index / segments * Math.PI * 2;
    return {
      x: centerX + Math.cos(angle) * radiusX,
      y,
      z: centerZ + Math.sin(angle) * radiusZ,
    };
  });
}

function rollerEllipsePoints(
  centerX: number,
  centerZ: number,
  radiusX: number,
  radiusZ: number,
  segments: number,
  baseY: number,
  amplitude: number,
  waves: number,
  phase = 0,
): PathPoint[] {
  return ellipsePoints(centerX, centerZ, radiusX, radiusZ, segments, baseY, phase).map((point, index) => ({
    ...point,
    y: baseY + Math.sin(index / segments * Math.PI * 2 * waves + phase) * amplitude,
  }));
}

function splinePoints(controlPoints: PathPoint[], samples: number): PathPoint[] {
  const curve = new THREE.CatmullRomCurve3(
    controlPoints.map((point) => new THREE.Vector3(point.x, point.y, point.z)),
    false,
    'centripetal',
    0.45,
  );
  // The old 8–26 segment routes exposed their control polygon at curb height,
  // producing boxy silhouettes and small normal changes under a fast skier.
  // Keep the authored controls but tessellate the spline densely enough that
  // both render geometry and analytic collision follow one continuous curve.
  const sampled = curve.getPoints(Math.max(48, samples * 3));
  if (sampled.length >= 4) {
    const startLength = sampled[0].distanceTo(sampled[1]);
    const startDirection = new THREE.Vector3(
      controlPoints[1].x - controlPoints[0].x,
      controlPoints[1].y - controlPoints[0].y,
      controlPoints[1].z - controlPoints[0].z,
    ).normalize();
    sampled[1].copy(sampled[0]).addScaledVector(startDirection, startLength);

    const lastIndex = sampled.length - 1;
    const endLength = sampled[lastIndex].distanceTo(sampled[lastIndex - 1]);
    const endDirection = new THREE.Vector3(
      controlPoints.at(-1)!.x - controlPoints.at(-2)!.x,
      controlPoints.at(-1)!.y - controlPoints.at(-2)!.y,
      controlPoints.at(-1)!.z - controlPoints.at(-2)!.z,
    ).normalize();
    sampled[lastIndex - 1].copy(sampled[lastIndex]).addScaledVector(endDirection, -endLength);
  }
  return sampled.map((point) => ({ x: point.x, y: point.y, z: point.z }));
}

function closestSegment(
  points: PathPoint[],
  closed: boolean,
  x: number,
  z: number,
): { index: number; t: number; lateral: number; distanceSquared: number } | null {
  let best: { index: number; t: number; lateral: number; distanceSquared: number } | null = null;
  const segmentCount = closed ? points.length : points.length - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSquared = dx * dx + dz * dz;
    if (lengthSquared <= EPSILON) continue;
    const t = clamp01(((x - a.x) * dx + (z - a.z) * dz) / lengthSquared);
    const pointX = a.x + dx * t;
    const pointZ = a.z + dz * t;
    const length = Math.sqrt(lengthSquared);
    const lateral = ((x - pointX) * dz - (z - pointZ) * dx) / length;
    const distanceSquared = (x - pointX) ** 2 + (z - pointZ) ** 2;
    if (!best || distanceSquared < best.distanceSquared) {
      best = { index, t, lateral, distanceSquared };
    }
  }
  return best;
}

function isWithinOpenPathCaps(points: PathPoint[], x: number, z: number): boolean {
  if (points.length < 2) return false;
  const first = points[0];
  const second = points[1];
  const startDx = second.x - first.x;
  const startDz = second.z - first.z;
  const startLength = Math.hypot(startDx, startDz) || 1;
  const startProjection = ((x - first.x) * startDx + (z - first.z) * startDz) / startLength;
  if (startProjection < -EPSILON) return false;

  const last = points.at(-1)!;
  const beforeLast = points.at(-2)!;
  const endDx = last.x - beforeLast.x;
  const endDz = last.z - beforeLast.z;
  const endLength = Math.hypot(endDx, endDz) || 1;
  const endProjection = ((x - last.x) * endDx + (z - last.z) * endDz) / endLength;
  return endProjection <= EPSILON;
}

function pathHeightAt(path: PathSurface, x: number, z: number): number | null {
  if (!path.closed && !isWithinOpenPathCaps(path.points, x, z)) return null;
  const nearest = closestSegment(path.points, path.closed, x, z);
  if (!nearest || nearest.distanceSquared > (path.width * 0.5 + 0.08) ** 2) return null;
  const a = path.points[nearest.index];
  const b = path.points[(nearest.index + 1) % path.points.length];
  const bank = THREE.MathUtils.lerp(
    path.banks[nearest.index],
    path.banks[(nearest.index + 1) % path.banks.length],
    nearest.t,
  );
  return THREE.MathUtils.lerp(a.y, b.y, nearest.t) + nearest.lateral * bank;
}

function pathNormalAt(path: PathSurface, x: number, z: number, target: THREE.Vector3): THREE.Vector3 | null {
  if (!path.closed && !isWithinOpenPathCaps(path.points, x, z)) return null;
  const nearest = closestSegment(path.points, path.closed, x, z);
  if (!nearest || nearest.distanceSquared > (path.width * 0.5 + 0.08) ** 2) return null;
  const a = path.vertexNormals[nearest.index];
  const b = path.vertexNormals[(nearest.index + 1) % path.vertexNormals.length];
  return target.set(
    THREE.MathUtils.lerp(a.x, b.x, nearest.t),
    THREE.MathUtils.lerp(a.y, b.y, nearest.t),
    THREE.MathUtils.lerp(a.z, b.z, nearest.t),
  ).normalize();
}

function buildPathVertexNormals(points: PathPoint[], closed: boolean, banks: number[]): PathPoint[] {
  const segmentCount = closed ? points.length : points.length - 1;
  const segmentNormals = Array.from({ length: segmentCount }, (_, index) => {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz) || 1;
    const tx = dx / length;
    const tz = dz / length;
    const slope = (b.y - a.y) / length;
    const bank = (banks[index] + banks[(index + 1) % banks.length]) * 0.5;
    const dHeightDx = slope * tx + bank * tz;
    const dHeightDz = slope * tz - bank * tx;
    const inverseLength = 1 / Math.hypot(dHeightDx, 1, dHeightDz);
    return { x: -dHeightDx * inverseLength, y: inverseLength, z: -dHeightDz * inverseLength };
  });
  return points.map((_, index) => {
    const previousIndex = closed ? (index - 1 + segmentCount) % segmentCount : Math.max(0, index - 1);
    const nextIndex = closed ? index % segmentCount : Math.min(segmentCount - 1, index);
    const previous = segmentNormals[previousIndex];
    const next = segmentNormals[nextIndex];
    const inverseLength = 1 / Math.hypot(previous.x + next.x, previous.y + next.y, previous.z + next.z);
    return {
      x: (previous.x + next.x) * inverseLength,
      y: (previous.y + next.y) * inverseLength,
      z: (previous.z + next.z) * inverseLength,
    };
  });
}

export class QuickSenseArena implements ArenaRuntime {
  readonly group = new THREE.Group();
  readonly skyTexture?: THREE.Texture;
  readonly seed: number;
  readonly killY = QUICKSENSE.killY;
  readonly jumpPads: JumpPad[] = [];
  readonly collisionTriangles: number;
  readonly corePosition: THREE.Vector3;
  readonly spawnPoints: THREE.Vector3[];
  readonly itemPoints: Record<string, THREE.Vector3>;
  readonly mapInfo: ArenaMapInfo;

  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly textures: THREE.Texture[] = [];
  private readonly colliders: QuickCollider[] = [];
  private readonly pathSurfaces: PathSurface[] = [];
  private readonly pathSafetyGeometries: THREE.BufferGeometry[] = [];
  private readonly pathFactionGeometries = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private readonly platformSurfaces: PlatformSurface[] = [];
  private readonly rampSurfaces: RampSurface[] = [];
  private readonly buildingEntryRamps: BuildingEntryRampSurface[] = [];
  private readonly shotBoxes: THREE.Box3[] = [];
  private readonly animatedProps: AnimatedProp[] = [];
  private readonly pulseMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly buildingManifest: BuildingAuditEntry[] = [];
  private supportClearanceSamples = 0;
  private supportClearanceMinimum = Number.POSITIVE_INFINITY;
  private supportClearanceMaximum = Number.NEGATIVE_INFINITY;
  private supportPenetrations = 0;
  private outpostTowerCoreLocal: THREE.Vector3 | null = null;
  private outpostTowerBoundsTree: MeshBVH | null = null;
  private outpostTowerSurfaceBoundsTree: MeshBVH | null = null;
  private outpostTowerFloorBoundsTree: MeshBVH | null = null;
  private readonly outpostTowerCollisionBounds = new THREE.Box3();
  private outpostTowerCollisionTriangleCount = 0;
  private outpostTowerBodyTriangleCount = 0;
  private outpostTowerFloorTriangleCount = 0;
  private staticWorldFloorBoundsTree: MeshBVH | null = null;
  private readonly staticWorldFloorBounds = new THREE.Box3();
  private staticWorldFloorTriangleCount = 0;
  private staticWorldShotBoundsTree: MeshBVH | null = null;
  private staticWorldShotTriangleCount = 0;
  private readonly outpostTowerFloorRay = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
  private readonly outpostTowerCapsuleSegment = new THREE.Line3();
  private readonly outpostTowerCapsuleBounds = new THREE.Box3();
  private readonly outpostTowerTrianglePoint = new THREE.Vector3();
  private readonly outpostTowerCapsulePoint = new THREE.Vector3();
  private readonly outpostTowerCollisionNormal = new THREE.Vector3();
  private readonly outpostTowerCollisionResult = { contacts: 0, corrected: false, wallContact: false };
  private readonly floorNormal = new THREE.Vector3(0, 1, 0);
  private readonly contactNormal = new THREE.Vector3(0, 1, 0);
  private readonly correction = new THREE.Vector3();
  private readonly wallNormal = new THREE.Vector3();
  private readonly rampNormal = new THREE.Vector3();
  private readonly localPosition = new THREE.Vector3();
  private readonly localVelocity = new THREE.Vector3();
  private readonly localStart = new THREE.Vector3();
  private readonly localEnd = new THREE.Vector3();
  private readonly segmentDirection = new THREE.Vector3();
  private readonly segmentRay = new THREE.Ray();
  private readonly segmentPoint = new THREE.Vector3();
  private readonly segmentClosestPoint = new THREE.Vector3();
  private readonly segmentClosestNormal = new THREE.Vector3();
  private readonly localSurfaceHit: SurfaceHit = {
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    distance: 0,
    surface: 'concrete',
  };
  private readonly worldSurfaceHit: SurfaceHit = {
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    distance: 0,
    surface: 'concrete',
  };
  private readonly localContactResults: CapsuleContact[] = Array.from({ length: 8 }, () => ({
    grounded: false,
    contactNormal: new THREE.Vector3(0, 1, 0),
    wallContact: false,
    wallNormal: new THREE.Vector3(),
    correction: new THREE.Vector3(),
    contacts: 0,
  }));
  private readonly worldContactResults: CapsuleContact[] = Array.from({ length: 8 }, () => ({
    grounded: false,
    contactNormal: new THREE.Vector3(0, 1, 0),
    wallContact: false,
    wallNormal: new THREE.Vector3(),
    correction: new THREE.Vector3(),
    contacts: 0,
  }));
  private localContactCursor = 0;
  private worldContactCursor = 0;
  private readonly floorSurface = { height: 0, normal: this.floorNormal };
  private readonly playerInfluence = new THREE.Vector3(0, -100, 0);
  private weatherGameplaySnapshot: WeatherGameplaySnapshot | null = null;
  private readonly weatherVisualDiagnostics: {
    source: 'autonomous' | 'gameplay';
    phase: WeatherPhase | 'autonomous';
    label: string;
    severity: number;
    rainIntensity: number;
    visualWindStrength: number;
    windDirection: { x: number; z: number };
    visibilityMultiplier: number;
  } = {
    source: 'autonomous',
    phase: 'autonomous',
    label: 'QUICKSENSE CLEAR SKY',
    severity: 0,
    rainIntensity: 0,
    visualWindStrength: 0.24,
    windDirection: { x: QUICK_WEATHER_DIRECTION.x, z: QUICK_WEATHER_DIRECTION.y },
    visibilityMultiplier: 1,
  };

  static async load(seed: number): Promise<QuickSenseArena> {
    const skyPromise = new THREE.TextureLoader()
      .loadAsync(assetUrl('assets/maps/quicksense-panorama-v1/quicksense-equirect-v3.png'))
      .then((texture) => {
        texture.name = 'QuickSenseEquirectangularSkyV3';
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.mapping = THREE.EquirectangularReflectionMapping;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        return texture;
      })
      .catch((error): undefined => {
        console.warn('QuickSense sky panorama unavailable; using procedural fallback.', error);
        return undefined;
      });

    const towerPromise = (async (): Promise<THREE.Group | undefined> => {
      try {
        const loader = new GLTFLoader();
        loader.setMeshoptDecoder(MeshoptDecoder);
        const gltf = await loader.loadAsync(assetUrl('assets/models/outpost-tower-fxb.glb'));
        return gltf.scene;
      } catch (error) {
        console.warn('QuickSense outpost tower unavailable; using the authored tower fallback.', error);
        return undefined;
      }
    })();

    const [skyTexture, outpostTower] = await Promise.all([skyPromise, towerPromise]);
    return new QuickSenseArena(seed, skyTexture, outpostTower);
  }

  constructor(seed: number, skyTexture?: THREE.Texture, outpostTower?: THREE.Group) {
    this.seed = seed;
    this.skyTexture = skyTexture;
    if (skyTexture) this.textures.push(skyTexture);
    this.group.name = 'QuickSenseProceduralArena';
    this.group.userData.source = 'Authored low-poly flow layout';
    this.group.userData.license = 'Riftline project original';
    this.group.userData.mapSeed = seed;
    this.group.userData.horizontalScale = QUICK_HORIZONTAL_SCALE;
    this.group.userData.verticalScale = QUICK_VERTICAL_SCALE;
    this.group.scale.set(QUICK_HORIZONTAL_SCALE, QUICK_VERTICAL_SCALE, QUICK_HORIZONTAL_SCALE);
    const hasOutpostTower = Boolean(outpostTower);

    const surfaceTextures = createQuickSenseSurfaceTextures();
    const panelTexture = surfaceTextures.panelAlbedo;
    const panelNormal = surfaceTextures.panelNormal;
    const panelRoughness = surfaceTextures.panelRoughness;
    this.textures.push(...surfaceTextures.all);
    const groundMaterial = this.material('QuickSense sandstone basin floor', 0xffffff, 0.01, 0.94);
    const groundFoundationMaterial = this.material('QuickSense umber terrain foundation', 0x46382e, 0.01, 0.99);
    const deckMaterial = this.material('QuickSense graphite panels', 0x858e92, 0.14, 0.72, panelTexture);
    const sideMaterial = this.material('QuickSense chamfered deck structure', 0x354147, 0.18, 0.78);
    const structureMaterial = this.material('QuickSense panelled architectural shells', 0x69757a, 0.2, 0.7, panelTexture);
    const rockMaterial = this.material('QuickSense volcanic cliffs', 0xffffff, 0.0, 0.96);
    const rockHighlightMaterial = this.material('QuickSense iron-sandstone cliff faces', 0x856548, 0.0, 0.94);
    const mossCapMaterial = this.material('QuickSense dry scrub cliff caps', 0x756a4c, 0.01, 1);
    const cyanMaterial = this.emissiveMaterial('QuickSense cyan route', 0x28b9d5, 0x16b9e4);
    const magentaMaterial = this.emissiveMaterial('QuickSense terracotta route', 0xa85e3d, 0x7a3928);
    const amberMaterial = this.emissiveMaterial('QuickSense amber safety', 0xd18b28, 0xb96b0d);
    const whiteMaterial = this.material('QuickSense gunmetal structure trim', 0xa0aaad, 0.3, 0.6);
    groundMaterial.vertexColors = true;
    rockMaterial.vertexColors = true;
    rockMaterial.side = THREE.DoubleSide;

    groundMaterial.map = surfaceTextures.terrainAlbedo;
    groundMaterial.normalMap = surfaceTextures.terrainNormal;
    groundMaterial.normalScale.set(0.34, 0.34);
    groundMaterial.roughnessMap = surfaceTextures.terrainRoughness;
    groundFoundationMaterial.normalMap = surfaceTextures.rockNormal;
    groundFoundationMaterial.normalScale.set(0.2, 0.2);
    groundFoundationMaterial.roughnessMap = surfaceTextures.rockRoughness;

    deckMaterial.flatShading = false;
    deckMaterial.normalMap = panelNormal;
    deckMaterial.normalScale.set(0.38, 0.38);
    deckMaterial.roughnessMap = panelRoughness;
    sideMaterial.flatShading = false;
    sideMaterial.map = panelTexture;
    sideMaterial.normalMap = panelNormal;
    sideMaterial.normalScale.set(0.3, 0.3);
    sideMaterial.roughnessMap = panelRoughness;
    structureMaterial.flatShading = false;
    structureMaterial.normalMap = panelNormal;
    structureMaterial.normalScale.set(0.32, 0.32);
    structureMaterial.roughnessMap = panelRoughness;
    whiteMaterial.flatShading = false;
    whiteMaterial.normalMap = panelNormal;
    whiteMaterial.normalScale.set(0.2, 0.2);
    whiteMaterial.roughnessMap = panelRoughness;

    rockMaterial.map = surfaceTextures.rockAlbedo;
    rockHighlightMaterial.map = surfaceTextures.rockAlbedo;
    for (const material of [rockMaterial, rockHighlightMaterial, mossCapMaterial]) {
      material.normalMap = surfaceTextures.rockNormal;
      material.roughnessMap = surfaceTextures.rockRoughness;
    }
    rockMaterial.normalScale.set(0.4, 0.4);
    rockHighlightMaterial.normalScale.set(0.34, 0.34);
    mossCapMaterial.normalScale.set(0.2, 0.2);

    applyGroundedCelDepth(groundMaterial, 0.1, 8);
    applyGroundedCelDepth(deckMaterial, 0.14, 7);
    applyGroundedCelDepth(sideMaterial, 0.1, 8);
    applyGroundedCelDepth(structureMaterial, 0.13, 7);
    applyGroundedCelDepth(whiteMaterial, 0.09, 9);
    applyGroundedCelDepth(rockMaterial, 0.075, 8);
    applyGroundedCelDepth(rockHighlightMaterial, 0.07, 8);
    applyGroundedCelDepth(mossCapMaterial, 0.055, 9);

    this.createPath(
      'Cyan outer basin south circuit',
      splinePoints([
        { x: -14, y: 3.05, z: -69 }, { x: -20, y: 3.05, z: -69 }, { x: -30, y: 7.8, z: -73 },
        { x: -59, y: 14.6, z: -62 }, { x: -75, y: 5.2, z: -38 }, { x: -77, y: 11.5, z: -30 },
        { x: -77, y: 14.5, z: -24 },
      ], 20),
      9.2,
      0.28,
      deckMaterial,
      sideMaterial,
      cyanMaterial,
      amberMaterial,
      false,
    );
    this.createPath(
      'Cyan outer basin north circuit',
      splinePoints([
        { x: -77, y: 14.5, z: -12 }, { x: -77, y: 17.6, z: -7 }, { x: -75, y: 7.2, z: 25 },
        { x: -61, y: 22.0, z: 51 }, { x: -36, y: 12.6, z: 67 }, { x: -20, y: 24.0, z: 69 },
        { x: -14, y: 27.7, z: 69 },
      ], 22),
      9.2,
      0.28,
      deckMaterial,
      sideMaterial,
      cyanMaterial,
      amberMaterial,
      false,
    );
    this.createPath(
      'Magenta outer basin south circuit',
      splinePoints([
        { x: 14, y: 3.05, z: -69 }, { x: 20, y: 3.05, z: -69 }, { x: 30, y: 7.8, z: -73 },
        { x: 59, y: 14.6, z: -62 }, { x: 75, y: 5.2, z: -38 }, { x: 79, y: 17.6, z: -7 },
        { x: 77, y: 11.2, z: 6 }, { x: 77, y: 8.5, z: 12 },
      ], 22),
      9.2,
      -0.28,
      deckMaterial,
      sideMaterial,
      magentaMaterial,
      amberMaterial,
      false,
    );
    this.createPath(
      'Magenta outer basin north circuit',
      splinePoints([
        { x: 77, y: 8.5, z: 24 }, { x: 77, y: 7.2, z: 30 }, { x: 61, y: 22.0, z: 51 },
        { x: 36, y: 12.6, z: 67 }, { x: 20, y: 24.0, z: 69 }, { x: 14, y: 27.7, z: 69 },
      ], 20),
      9.2,
      -0.28,
      deckMaterial,
      sideMaterial,
      magentaMaterial,
      amberMaterial,
      false,
    );
    this.createPath(
      'Cyan inner momentum inbound',
      splinePoints([
        { x: -10, y: 3.0, z: -59 }, { x: -24, y: 10.0, z: -52 }, { x: -44, y: 4.2, z: -39 },
        { x: -56, y: 12.5, z: -17 }, { x: -53, y: 5.7, z: 8 }, { x: -45, y: 16.5, z: 24 },
        { x: -45, y: 20.5, z: 30 },
      ], 26),
      7.8,
      0.24,
      deckMaterial,
      sideMaterial,
      cyanMaterial,
      amberMaterial,
      false,
    );
    this.createPath(
      'Cyan inner momentum outbound',
      splinePoints([
        { x: -34, y: 20.5, z: 42 }, { x: -34, y: 18.5, z: 45 },
        { x: -19, y: 9.5, z: 46 }, { x: -10, y: 22.0, z: 43 },
      ], 12),
      7.8,
      0.24,
      deckMaterial,
      sideMaterial,
      cyanMaterial,
      amberMaterial,
      false,
    );
    this.createPath(
      'Magenta inner momentum inbound',
      splinePoints([
        { x: 10, y: 3.0, z: -59 }, { x: 24, y: 10.0, z: -52 }, { x: 44, y: 4.2, z: -39 },
        { x: 56, y: 12.5, z: -17 }, { x: 53, y: 5.7, z: 8 }, { x: 43, y: 12.5, z: 18 },
        { x: 45, y: 15.0, z: 24 }, { x: 45, y: 20.5, z: 30 },
      ], 26),
      7.8,
      -0.24,
      deckMaterial,
      sideMaterial,
      magentaMaterial,
      amberMaterial,
      false,
    );
    this.createPath(
      'Magenta inner momentum outbound',
      splinePoints([
        { x: 34, y: 20.5, z: 42 }, { x: 34, y: 18.5, z: 45 },
        { x: 19, y: 9.5, z: 46 }, { x: 10, y: 22.0, z: 43 },
      ], 12),
      7.8,
      -0.24,
      deckMaterial,
      sideMaterial,
      magentaMaterial,
      amberMaterial,
      false,
    );
    this.createPath(
      'Cyan west transfer receiver',
      splinePoints([
        { x: -42, y: 26.3, z: -18 }, { x: -38, y: 26.3, z: -18 },
        { x: -33, y: 25.0, z: -4 }, { x: -33, y: 22.8, z: 17 }, { x: -36, y: 21.6, z: 24 },
        { x: -36, y: 20.5, z: 30 },
      ], 10),
      5.6,
      0.12,
      deckMaterial,
      sideMaterial,
      cyanMaterial,
      amberMaterial,
      false,
    );
    this.createPath(
      'Magenta east transfer receiver',
      splinePoints([
        { x: 38, y: 23.3, z: 18 }, { x: 35.5, y: 23.3, z: 18 },
        { x: 34, y: 22.8, z: 20 }, { x: 36, y: 21.6, z: 24 },
        { x: 36, y: 20.5, z: 30 },
      ], 8),
      5.6,
      -0.12,
      deckMaterial,
      sideMaterial,
      magentaMaterial,
      amberMaterial,
      false,
    );
    if (!hasOutpostTower) {
      this.createPath(
        'Central clear-span spine',
        splinePoints([
          { x: 0, y: 12.22, z: -10.2 }, { x: 0, y: 12.22, z: 0 },
          { x: 0, y: 13.1, z: 9 }, { x: 0, y: 17.2, z: 18 },
          { x: 0, y: 25.2, z: 27 }, { x: 0, y: 22, z: 35 },
        ], 24),
        // The launch pieces own the north and south spine footprints. Keeping
        // only this clear-span connector removes the prior ramp-on-ramp mesh
        // penetration while preserving one continuous, reciprocal ski line.
        4.8,
        0,
        deckMaterial,
        sideMaterial,
        amberMaterial,
        amberMaterial,
        false,
      );
      this.createPath(
        'Flux Core orbital transfer',
        rollerEllipsePoints(0, 7, 28, 22, 48, 14.6, 4.4, 2, Math.PI * 0.5),
        7.2,
        0.09,
        deckMaterial,
        sideMaterial,
        amberMaterial,
        amberMaterial,
        true,
      );
    }

    this.flushPathTrimMeshes(amberMaterial);
    this.createRamps(deckMaterial, sideMaterial, cyanMaterial, magentaMaterial, amberMaterial, !hasOutpostTower);
    this.createRouteJunctionDecks(deckMaterial);
    this.createGround(groundMaterial, groundFoundationMaterial, rockMaterial, rockHighlightMaterial, mossCapMaterial);
    this.createBoundaryArchitecture(sideMaterial, amberMaterial);

    if (!hasOutpostTower) {
      this.addPlatform('Flux Core central dais', 0, 0, 12.2, 24, 3.2, 20, deckMaterial, false);
      for (const side of [-1, 1]) {
        this.registerBoxCollision(
          'Flux Core split dais collision',
          new THREE.Vector3(side * 8.75, 10.6, 0),
          new THREE.Vector3(6.5, 3.2, 20),
        );
      }
    }
    this.addPlatform('North grapple west roof', -10.6, 61, 21.4, 8.4, 3.0, 13, deckMaterial, true);
    this.addPlatform('North grapple east roof', 10.6, 61, 21.4, 8.4, 3.0, 13, deckMaterial, true);
    this.addPlatform('South launch west roof', -10.6, -61, 7.1, 8.4, 2.4, 13, deckMaterial, true);
    this.addPlatform('South launch east roof', 10.6, -61, 7.1, 8.4, 2.4, 13, deckMaterial, true);

    this.createEntryGatehouses(structureMaterial, cyanMaterial, magentaMaterial, amberMaterial);
    if (!hasOutpostTower) {
      this.createCentralStructures(structureMaterial, whiteMaterial, cyanMaterial, magentaMaterial, amberMaterial);
    }
    this.createIntegratedCliffHabitats(
      structureMaterial,
      whiteMaterial,
      cyanMaterial,
      magentaMaterial,
      amberMaterial,
      rockHighlightMaterial,
      mossCapMaterial,
    );
    this.createFloatingStructures(structureMaterial, whiteMaterial, cyanMaterial, magentaMaterial, amberMaterial);
    this.createSkylineGateways(structureMaterial, cyanMaterial, magentaMaterial, amberMaterial);
    this.createRouteSupports(sideMaterial, whiteMaterial, cyanMaterial, magentaMaterial);
    this.group.userData.supportClearanceAudit = {
      samples: this.supportClearanceSamples,
      minimum: Number.isFinite(this.supportClearanceMinimum) ? this.supportClearanceMinimum : null,
      maximum: Number.isFinite(this.supportClearanceMaximum) ? this.supportClearanceMaximum : null,
      penetrations: this.supportPenetrations,
    };
    if (outpostTower) this.createOutpostTower(outpostTower, panelTexture, panelNormal, panelRoughness);
    this.createStaticWorldShotCollision();
    this.createStaticWorldFloorCollision();

    const cyanPad = this.createJumpPad(this.localPointOnFloor(-42, -54, 0.18), new THREE.Vector3(0.22, 0.76, 0.6), cyanMaterial, sideMaterial);
    const magentaPad = this.createJumpPad(this.localPointOnFloor(42, 54, 0.18), new THREE.Vector3(-0.22, 0.76, -0.6), magentaMaterial, sideMaterial);
    const centerPadPosition = hasOutpostTower ? new THREE.Vector2(30, -4) : new THREE.Vector2(0, 0);
    const centerPad = this.createJumpPad(
      this.localPointOnFloor(centerPadPosition.x, centerPadPosition.y, 0.18),
      new THREE.Vector3(0, 0.88, 0.47),
      amberMaterial,
      sideMaterial,
    );
    const westPad = this.createJumpPad(this.localPointOnFloor(-62, 0, 0.18), new THREE.Vector3(0.78, 0.45, 0), cyanMaterial, sideMaterial);
    const eastPad = this.createJumpPad(this.localPointOnFloor(62, 0, 0.18), new THREE.Vector3(-0.78, 0.45, 0), magentaMaterial, sideMaterial);
    this.jumpPads.push(cyanPad, magentaPad, centerPad, westPad, eastPad);

    // Most of QuickSense is authored from unique architectural pieces. Keep
    // that silhouette/detail, but submit nearby static pieces that share the
    // exact same material and vertex layout as one spatial batch. Collision
    // has already been baked above, so this is render-only and cannot change
    // traversal. Spatial cells retain useful frustum culling, unlike one
    // arena-wide mega mesh.
    this.batchStaticMapMeshes();

    this.corePosition = this.localToWorld(this.outpostTowerCoreLocal ?? new THREE.Vector3(0, 19.6, 0));
    this.spawnPoints = [
      this.pointOnFloor(0, -66),
      this.pointOnFloor(42, 47),
      this.pointOnFloor(-69, 0),
      this.pointOnFloor(69, 0),
      this.pointOnFloor(-42, 48),
      this.pointOnFloor(42, -48),
      this.pointOnFloor(-42, -47),
      this.pointOnFloor(0, 66),
    ];
    this.itemPoints = {
      'health-a': this.pointOnFloor(-61, -21, 0.8),
      'health-b': this.pointOnFloor(61, 21, 0.8),
      armor: this.pointOnFloor(-24, 31, 0.8),
      damage: this.corePosition.clone().add(new THREE.Vector3(0, 0.9, 0)),
      speed: this.pointOnFloor(24, -31, 0.8),
      rail: this.pointOnFloor(0, 61, 0.8),
      rocket: this.pointOnFloor(-42, 0, 0.8),
      plasma: this.pointOnFloor(42, 0, 0.8),
      shotgun: this.pointOnFloor(-24, -31, 0.8),
      sniper: this.pointOnFloor(0, -61, 0.8),
      laser: this.pointOnFloor(24, 31, 0.8),
    };

    let renderTriangles = 0;
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) return;
      const geometry = mesh.geometry;
      const position = geometry.getAttribute('position');
      if (!position) return;
      const triangleCount = geometry.index ? geometry.index.count / 3 : position.count / 3;
      const instanceCount = (mesh as THREE.InstancedMesh).isInstancedMesh
        ? (mesh as THREE.InstancedMesh).count
        : 1;
      renderTriangles += triangleCount * instanceCount;
    });
    this.collisionTriangles = Math.round(
      this.colliders.length * 12
      + this.rampSurfaces.length * 72
      + this.pathSurfaces.length * 48
      + this.outpostTowerCollisionTriangleCount
      + this.staticWorldShotTriangleCount
      + this.staticWorldFloorTriangleCount,
    );
    this.mapInfo = {
      name: QUICKSENSE.name,
      seed,
      generationVersion: QUICKSENSE.generationVersion,
      ready: true,
      topologyHash: `quicksense-${seed.toString(16)}-habitat-flow-v12`,
      bounds: { width: QUICKSENSE.width, depth: QUICKSENSE.depth },
      // Keep the authored sky volume 20% above the fighter's hard 300 m
      // ceiling, matching the former 150/180 safety and visual headroom.
      altitudeRange: { min: 0, max: 360 },
      renderTriangles: Math.round(renderTriangles),
      collisionTriangles: this.collisionTriangles,
      spawnCount: this.spawnPoints.length,
      pickupCount: Object.keys(this.itemPoints).length,
      jumpPadCount: this.jumpPads.length,
      skiRoutes: 12,
    };
  }

  update(elapsed: number, reducedMotion: boolean): void {
    const time = reducedMotion ? 0 : elapsed;
    for (const prop of this.animatedProps) {
      prop.object.rotation.y = prop.phase + time * prop.spin;
      prop.object.position.y = prop.baseY + (reducedMotion ? 0 : Math.sin(time * 1.8 + prop.phase) * 0.16);
    }
    const pulse = reducedMotion ? 0.42 : 0.46 + Math.sin(time * 2.8) * 0.09;
    for (const material of this.pulseMaterials) material.emissiveIntensity = pulse;
    const weather = this.weatherGameplaySnapshot;
    if (weather) {
      this.weatherVisualDiagnostics.source = 'gameplay';
      this.weatherVisualDiagnostics.phase = weather.phase;
      this.weatherVisualDiagnostics.label = weather.label;
      this.weatherVisualDiagnostics.severity = THREE.MathUtils.clamp(weather.severity, 0, 1);
      this.weatherVisualDiagnostics.visibilityMultiplier = THREE.MathUtils.clamp(
        weather.multipliers.visibilityMultiplier,
        0,
        1,
      );
      this.weatherVisualDiagnostics.rainIntensity = weather.severity * 0.15;
      this.weatherVisualDiagnostics.visualWindStrength = weather.windStrength * 0.3;
      this.weatherVisualDiagnostics.windDirection.x = weather.windDirection.x;
      this.weatherVisualDiagnostics.windDirection.z = weather.windDirection.z;
    }
  }

  setWeatherGameplaySnapshot(snapshot: WeatherGameplaySnapshot | null): void {
    this.weatherGameplaySnapshot = snapshot;
  }

  getWeatherVisualDiagnostics(): ArenaWeatherVisualDiagnostics {
    return {
      ...this.weatherVisualDiagnostics,
      windDirection: { ...this.weatherVisualDiagnostics.windDirection },
    };
  }

  setPlayerInfluence(position: THREE.Vector3): void {
    this.worldToLocal(position, this.playerInfluence);
  }

  resolvePlayerCapsule(position: THREE.Vector3, velocity: THREE.Vector3): CapsuleContact {
    return this.resolveCapsule(position, velocity, MOVEMENT.playerRadius, MOVEMENT.playerHeight);
  }

  resolveCapsule(
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    radius: number,
    height: number,
  ): CapsuleContact {
    this.worldToLocal(position, this.localPosition);
    this.worldVectorToLocal(velocity, this.localVelocity);
    const localContact = this.resolveLocalCapsule(
      this.localPosition,
      this.localVelocity,
      radius / QUICK_HORIZONTAL_SCALE,
      height / QUICK_VERTICAL_SCALE,
    );
    this.localToWorld(this.localPosition, position);
    this.localVectorToWorld(this.localVelocity, velocity);
    const result = this.worldContactResults[this.worldContactCursor];
    this.worldContactCursor = (this.worldContactCursor + 1) % this.worldContactResults.length;
    result.grounded = localContact.grounded;
    this.localNormalToWorld(localContact.contactNormal, result.contactNormal);
    result.wallContact = localContact.wallContact;
    this.localNormalToWorld(localContact.wallNormal, result.wallNormal);
    this.localVectorToWorld(localContact.correction, result.correction);
    result.contacts = localContact.contacts;
    return result;
  }

  private resolveLocalCapsule(
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    radius: number,
    height: number,
  ): CapsuleContact {
    this.correction.set(0, 0, 0);
    this.wallNormal.set(0, 0, 0);
    let grounded = false;
    let wallContact = false;
    let contacts = 0;
    const localGroundSnap = MOVEMENT.groundSnapDistance / QUICK_VERTICAL_SCALE;
    const localRecoveryReach = Math.max(
      localGroundSnap + 0.08 / QUICK_VERTICAL_SCALE,
      Math.min(
        Math.max(0, height - MOVEMENT.collisionSkin / QUICK_VERTICAL_SCALE),
        localGroundSnap
          + (MOVEMENT.stepHeight + MOVEMENT.maxSubstepDistance + 0.08) / QUICK_VERTICAL_SCALE,
      ),
    );
    let floorFlags = this.resolveLocalFloorContact(
      position,
      velocity,
      localGroundSnap,
      localRecoveryReach,
    );
    if ((floorFlags & 1) !== 0) contacts += 1;
    grounded = (floorFlags & 2) !== 0;

    // Resolve neighbouring proxy corners to convergence. The second pass is
    // conditional, so open traversal retains the single-pass hot path.
    let solidCorrected = false;
    for (let pass = 0; pass < 2; pass += 1) {
      let passCorrected = false;
      const capsuleMinY = position.y;
      const capsuleMaxY = position.y + height;
      for (const collider of this.colliders) {
        if (!collider.blocksMovement) continue;
        const box = collider.box;
        if (capsuleMaxY <= box.min.y || capsuleMinY >= box.max.y) continue;
        const minX = box.min.x - radius;
        const maxX = box.max.x + radius;
        const minZ = box.min.z - radius;
        const maxZ = box.max.z + radius;
        if (position.x <= minX || position.x >= maxX || position.z <= minZ || position.z >= maxZ) continue;
        let depth = position.x - minX;
        let normalX = -1;
        let normalZ = 0;
        if (maxX - position.x < depth) {
          depth = maxX - position.x;
          normalX = 1;
        }
        if (position.z - minZ < depth) {
          depth = position.z - minZ;
          normalX = 0;
          normalZ = -1;
        }
        if (maxZ - position.z < depth) {
          depth = maxZ - position.z;
          normalX = 0;
          normalZ = 1;
        }
        const correction = depth + 0.001;
        position.x += normalX * correction;
        position.z += normalZ * correction;
        this.correction.x += normalX * correction;
        this.correction.z += normalZ * correction;
        const intoSurface = velocity.x * normalX + velocity.z * normalZ;
        if (intoSurface < 0) {
          velocity.x -= normalX * intoSurface;
          velocity.z -= normalZ * intoSurface;
        }
        this.wallNormal.set(normalX, 0, normalZ);
        wallContact = true;
        passCorrected = true;
        contacts += 1;
      }

      for (const ramp of this.rampSurfaces) {
        const contact = this.rampSolidContact(ramp, position, radius, height);
        if (!contact) continue;
        position.addScaledVector(contact.normal, contact.depth + 0.001);
        this.correction.addScaledVector(contact.normal, contact.depth + 0.001);
        const intoSurface = velocity.dot(contact.normal);
        if (intoSurface < 0) velocity.addScaledVector(contact.normal, -intoSurface);
        this.wallNormal.copy(contact.normal);
        wallContact = true;
        passCorrected = true;
        contacts += 1;
      }
      const towerContact = this.resolveOutpostTowerCapsule(position, velocity, radius, height);
      if (towerContact.corrected) {
        passCorrected = true;
        contacts += towerContact.contacts;
        if (towerContact.wallContact) wallContact = true;
      }
      if (!passCorrected) break;
      solidCorrected = true;
    }

    if (solidCorrected) {
      floorFlags = this.resolveLocalFloorContact(
        position,
        velocity,
        localGroundSnap,
        localRecoveryReach,
      );
      grounded = (floorFlags & 2) !== 0;
      if ((floorFlags & 1) !== 0) contacts += 1;
    }

    const result = this.localContactResults[this.localContactCursor];
    this.localContactCursor = (this.localContactCursor + 1) % this.localContactResults.length;
    result.grounded = grounded;
    result.contactNormal.copy(this.contactNormal);
    result.wallContact = wallContact;
    result.wallNormal.copy(this.wallNormal);
    result.correction.copy(this.correction);
    result.contacts = contacts;
    return result;
  }

  private resolveOutpostTowerCapsule(
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    radius: number,
    height: number,
  ): { contacts: number; corrected: boolean; wallContact: boolean } {
    const result = this.outpostTowerCollisionResult;
    result.contacts = 0;
    result.corrected = false;
    result.wallContact = false;
    const boundsTree = this.outpostTowerBoundsTree;
    if (!boundsTree) return result;
    const bounds = this.outpostTowerCollisionBounds;
    if (
      position.x + radius < bounds.min.x
      || position.x - radius > bounds.max.x
      || position.z + radius < bounds.min.z
      || position.z - radius > bounds.max.z
      || position.y + height < bounds.min.y
      || position.y > bounds.max.y
    ) return result;

    const segment = this.outpostTowerCapsuleSegment;
    segment.start.set(position.x, position.y + radius, position.z);
    segment.end.set(position.x, position.y + Math.max(radius, height - radius), position.z);
    const capsuleBounds = this.outpostTowerCapsuleBounds;
    capsuleBounds.makeEmpty();
    capsuleBounds.expandByPoint(segment.start);
    capsuleBounds.expandByPoint(segment.end);
    capsuleBounds.expandByScalar(radius + 0.02);

    boundsTree.shapecast({
      intersectsBounds: (box) => box.intersectsBox(capsuleBounds),
      intersectsTriangle: (triangle) => {
        const distance = triangle.closestPointToSegment(
          segment,
          this.outpostTowerTrianglePoint,
          this.outpostTowerCapsulePoint,
        );
        if (distance >= radius - 0.0005) return false;
        const normal = this.outpostTowerCollisionNormal.copy(this.outpostTowerCapsulePoint)
          .sub(this.outpostTowerTrianglePoint);
        if (normal.lengthSq() <= EPSILON) triangle.getNormal(normal);
        else normal.multiplyScalar(1 / Math.max(EPSILON, distance));
        const depth = radius - distance + 0.0008;
        segment.start.addScaledVector(normal, depth);
        segment.end.addScaledVector(normal, depth);
        capsuleBounds.min.addScaledVector(normal, depth);
        capsuleBounds.max.addScaledVector(normal, depth);
        this.correction.addScaledVector(normal, depth);
        const intoSurface = velocity.dot(normal);
        if (intoSurface < 0) velocity.addScaledVector(normal, -intoSurface);
        if (normal.y < MOVEMENT.maxSlopeCosine) {
          this.wallNormal.copy(normal);
          result.wallContact = true;
        }
        result.contacts += 1;
        result.corrected = true;
        return false;
      },
    });
    if (result.corrected) {
      position.set(segment.start.x, segment.start.y - radius, segment.start.z);
    }
    return result;
  }

  /** Bit 0 = floor contact, bit 1 = walkable grounded contact. */
  private resolveLocalFloorContact(
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    localGroundSnap: number,
    recoveryReach: number,
  ): number {
    const floor = this.floorSurfaceAt(
      position.x,
      position.z,
      position.y + recoveryReach,
    );
    if (!floor) return 0;
    this.contactNormal.copy(floor.normal);
    const gap = position.y - floor.height;
    const snap = velocity.y <= 0.5
      && gap <= localGroundSnap + 0.025 / QUICK_VERTICAL_SCALE;
    if (gap > 0.015 / QUICK_VERTICAL_SCALE && !snap) return 0;
    const correctionY = floor.height - position.y;
    position.y = floor.height;
    this.correction.y += correctionY;
    const intoSurface = velocity.dot(this.contactNormal);
    if (intoSurface < 0) velocity.addScaledVector(this.contactNormal, -intoSurface);
    const grounded = this.contactNormal.y >= MOVEMENT.maxSlopeCosine && intoSurface <= 1.2;
    return grounded ? 3 : 1;
  }

  floorHeightAt(x: number, z: number, fromY = 96): number | null {
    const local = this.floorSurfaceAt(
      x / QUICK_HORIZONTAL_SCALE,
      z / QUICK_HORIZONTAL_SCALE,
      fromY / QUICK_VERTICAL_SCALE,
    );
    return local ? local.height * QUICK_VERTICAL_SCALE : null;
  }

  surfaceNormalAt(x: number, z: number, fromY = Number.POSITIVE_INFINITY): THREE.Vector3 | null {
    const local = this.floorSurfaceAt(
      x / QUICK_HORIZONTAL_SCALE,
      z / QUICK_HORIZONTAL_SCALE,
      fromY / QUICK_VERTICAL_SCALE,
    );
    if (!local) return null;
    return this.localNormalToWorld(local.normal);
  }

  surfaceAt(x: number, z: number, fromY = Number.POSITIVE_INFINITY): ArenaSurface {
    const localX = x / QUICK_HORIZONTAL_SCALE;
    const localZ = z / QUICK_HORIZONTAL_SCALE;
    const floor = this.floorSurfaceAt(localX, localZ, fromY / QUICK_VERTICAL_SCALE);
    if (!floor) return 'water';
    if (this.isConcretePoint(localX, localZ, floor.height)) return 'concrete';
    return 'grass';
  }

  segmentHitDetails(start: THREE.Vector3, end: THREE.Vector3): SurfaceHit | null {
    this.worldToLocal(start, this.localStart);
    this.worldToLocal(end, this.localEnd);
    const localHit = this.localSegmentHitDetails(this.localStart, this.localEnd, false);
    if (!localHit) return null;
    const result = this.worldSurfaceHit;
    this.localToWorld(localHit.point, result.point);
    this.localNormalToWorld(localHit.normal, result.normal);
    result.distance = result.point.distanceTo(start);
    result.surface = localHit.surface;
    return result;
  }

  movementSegmentHitDetails(start: THREE.Vector3, end: THREE.Vector3): SurfaceHit | null {
    this.worldToLocal(start, this.localStart);
    this.worldToLocal(end, this.localEnd);
    const localHit = this.localSegmentHitDetails(this.localStart, this.localEnd, true);
    if (!localHit) return null;
    const result = this.worldSurfaceHit;
    this.localToWorld(localHit.point, result.point);
    this.localNormalToWorld(localHit.normal, result.normal);
    result.distance = result.point.distanceTo(start);
    result.surface = localHit.surface;
    return result;
  }

  private localSegmentHitDetails(
    start: THREE.Vector3,
    end: THREE.Vector3,
    movementOnly: boolean,
  ): SurfaceHit | null {
    const direction = this.segmentDirection.copy(end).sub(start);
    const distance = direction.length();
    if (distance < EPSILON) return null;
    direction.multiplyScalar(1 / distance);
    const ray = this.segmentRay.set(start, direction);
    let closestDistance = Number.POSITIVE_INFINITY;
    const considerBox = (box: THREE.Box3): void => {
      const hit = ray.intersectBox(box, this.segmentPoint);
      if (!hit) return;
      const hitDistance = hit.distanceTo(start);
      if (hitDistance > distance || hitDistance >= closestDistance) return;
      closestDistance = hitDistance;
      this.segmentClosestPoint.copy(hit);
      this.boxNormal(box, hit, direction, this.segmentClosestNormal);
    };
    if (movementOnly) {
      for (const collider of this.colliders) {
        if (collider.blocksMovement) considerBox(collider.box);
      }
    } else {
      const staticHit = this.staticWorldShotBoundsTree?.raycastFirst(
        ray,
        THREE.DoubleSide,
        0,
        distance,
      );
      if (staticHit) {
        closestDistance = staticHit.distance;
        this.segmentClosestPoint.copy(staticHit.point);
        if (staticHit.face?.normal) this.segmentClosestNormal.copy(staticHit.face.normal);
        else this.segmentClosestNormal.copy(direction).negate();
        if (this.segmentClosestNormal.dot(direction) > 0) this.segmentClosestNormal.negate();
      } else if (!this.staticWorldShotBoundsTree) {
        // Construction should always provide the exact visible-mesh BVH. Keep
        // the legacy proxies only as a defensive fallback for malformed maps;
        // they are never consulted during a normal QuickSense match.
        for (const box of this.shotBoxes) considerBox(box);
      }
    }
    const towerHit = this.outpostTowerSurfaceBoundsTree?.raycastFirst(
      ray,
      THREE.DoubleSide,
      0,
      Math.min(distance, closestDistance),
    );
    if (towerHit && towerHit.distance < closestDistance) {
      closestDistance = towerHit.distance;
      this.segmentClosestPoint.copy(towerHit.point);
      if (towerHit.face?.normal) this.segmentClosestNormal.copy(towerHit.face.normal);
      else this.segmentClosestNormal.copy(direction).negate();
      if (this.segmentClosestNormal.dot(direction) > 0) this.segmentClosestNormal.negate();
    }
    if (!Number.isFinite(closestDistance)) return null;
    const result = this.localSurfaceHit;
    result.point.copy(this.segmentClosestPoint);
    result.normal.copy(this.segmentClosestNormal);
    result.distance = closestDistance;
    result.surface = 'concrete';
    return result;
  }

  segmentHit(start: THREE.Vector3, end: THREE.Vector3): THREE.Vector3 | null {
    return this.segmentHitDetails(start, end)?.point ?? null;
  }

  hasLineOfSight(start: THREE.Vector3, end: THREE.Vector3, endTolerance = 0.12): boolean {
    const hit = this.segmentHitDetails(start, end);
    return hit === null || hit.point.distanceToSquared(end) <= endTolerance * endTolerance;
  }

  safeSpawnPoint(candidate: THREE.Vector3, radius = MOVEMENT.playerRadius, height = MOVEMENT.playerHeight): THREE.Vector3 | null {
    const localCandidate = this.worldToLocal(candidate);
    const localRadius = radius / QUICK_HORIZONTAL_SCALE;
    const localHeight = height / QUICK_VERTICAL_SCALE;
    const floor = this.floorSurfaceAt(localCandidate.x, localCandidate.z, Number.POSITIVE_INFINITY)?.height ?? null;
    if (floor === null) return null;
    for (let index = 0; index < 8; index += 1) {
      const angle = index / 8 * Math.PI * 2;
      const sample = this.floorSurfaceAt(
        localCandidate.x + Math.cos(angle) * (localRadius + 0.06),
        localCandidate.z + Math.sin(angle) * (localRadius + 0.06),
        Number.POSITIVE_INFINITY,
      )?.height ?? null;
      if (sample === null || Math.abs(sample - floor) > 1.2 / QUICK_VERTICAL_SCALE) return null;
    }
    const seated = new THREE.Vector3(localCandidate.x, floor, localCandidate.z);
    const capsuleBox = new THREE.Box3(
      new THREE.Vector3(seated.x - localRadius, seated.y + 0.02, seated.z - localRadius),
      new THREE.Vector3(seated.x + localRadius, seated.y + localHeight, seated.z + localRadius),
    );
    if (this.colliders.some((collider) => collider.blocksMovement && collider.box.intersectsBox(capsuleBox))) return null;
    const contact = this.resolveLocalCapsule(seated, new THREE.Vector3(0, -0.1, 0), localRadius, localHeight);
    return contact.grounded && !contact.wallContact ? this.localToWorld(seated) : null;
  }

  isTraversablePoint(candidate: THREE.Vector3, fromY = candidate.y + 4): boolean {
    const local = this.worldToLocal(candidate);
    const floor = this.floorSurfaceAt(local.x, local.z, fromY / QUICK_VERTICAL_SCALE);
    return floor !== null && this.localNormalToWorld(floor.normal).y >= MOVEMENT.maxSlopeCosine;
  }

  addFootTrack(_position: THREE.Vector3, _movement: THREE.Vector3, _elapsed: number): void {
    // QuickSense intentionally keeps the authored route surfaces visually clean.
  }

  registerSurfaceImpact(_position: THREE.Vector3, _normal: THREE.Vector3, _energy: number, _elapsed: number): void {
    // Combat impact decals are omitted from the low-poly map contract.
  }

  dispose(): void {
    this.group.traverse((object) => {
      if ((object as THREE.SkinnedMesh).isSkinnedMesh) (object as THREE.SkinnedMesh).skeleton.dispose();
    });
    for (const geometry of new Set(this.geometries)) geometry.dispose();
    for (const material of new Set(this.materials)) material.dispose();
    for (const texture of new Set(this.textures)) texture.dispose();
  }

  private readonly material = (
    name: string,
    color: number,
    metalness: number,
    roughness: number,
    map?: THREE.Texture,
  ): THREE.MeshStandardMaterial => {
    const parameters: THREE.MeshStandardMaterialParameters = {
      name,
      color,
      metalness,
      roughness,
      flatShading: true,
    };
    if (map) parameters.map = map;
    const material = new THREE.MeshStandardMaterial(parameters);
    this.materials.push(material);
    return material;
  };

  private readonly emissiveMaterial = (name: string, color: number, emissive: number): THREE.MeshStandardMaterial => {
    const material = this.material(name, color, 0.42, 0.38);
    material.emissive.setHex(emissive);
    material.emissiveIntensity = 0.46;
    this.pulseMaterials.push(material);
    return material;
  };

  private addMesh(
    geometry: THREE.BufferGeometry,
    material: THREE.Material | THREE.Material[],
    name: string,
    position?: THREE.Vector3,
  ): THREE.Mesh {
    this.trackGeometry(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    if (position) mesh.position.copy(position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }

  private trackGeometry(geometry: THREE.BufferGeometry): void {
    if (!this.geometries.includes(geometry)) this.geometries.push(geometry);
  }

  private batchStaticMapMeshes(): void {
    const animated = new Set(this.animatedProps.map((prop) => prop.object));
    const batches = new Map<string, {
      material: THREE.Material;
      castShadow: boolean;
      receiveShadow: boolean;
      renderOrder: number;
      meshes: THREE.Mesh[];
    }>();
    const retiredGeometries = new Set<THREE.BufferGeometry>();
    const groupInverse = this.group.matrixWorld.clone().invert();
    const localTransform = new THREE.Matrix4();
    const sourceToGroup = new THREE.Matrix4();
    const instanceTransform = new THREE.Matrix4();
    const localCenter = new THREE.Vector3();
    // QuickSense's prior zero-anchored 112-unit grid split nearly every shared
    // route material once on each side of x/z=0. That preserved culling for a
    // map which is already visible almost end-to-end, but doubled or quadrupled
    // the dominant deck/side submissions (and their shadow submissions). A
    // centered 224-unit cell keeps the playable bowl in one batch per material
    // while leaving distant architecture in adjacent cullable cells.
    const cellSize = 224;
    const hasImportedTowerAncestor = (object: THREE.Object3D): boolean => {
      let ancestor: THREE.Object3D | null = object;
      while (ancestor && ancestor !== this.group) {
        if (ancestor.name === 'QuickSense imported outpost tower') return true;
        ancestor = ancestor.parent;
      }
      return false;
    };

    this.group.updateMatrixWorld(true);
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (
        !mesh.isMesh
        || !mesh.visible
        || Array.isArray(mesh.material)
        || mesh.children.length > 0
        || animated.has(mesh)
        || hasImportedTowerAncestor(mesh)
        || mesh.name === 'QuickSense jump pad'
        || mesh.name === 'QuickSense jump pad core'
        || mesh.material.transparent
        || mesh.material.opacity < 1
      ) return;
      const position = mesh.geometry.getAttribute('position');
      if (!position) return;
      if (Object.values(mesh.geometry.attributes).some((attribute) => (
        'isInterleavedBufferAttribute' in attribute && attribute.isInterleavedBufferAttribute
      ))) return;
      mesh.geometry.computeBoundingSphere();
      localCenter.copy(mesh.geometry.boundingSphere?.center ?? mesh.position)
        .applyMatrix4(mesh.matrixWorld)
        .applyMatrix4(groupInverse);
      const cellX = Math.round(localCenter.x / cellSize);
      const cellY = Math.round(localCenter.y / cellSize);
      const cellZ = Math.round(localCenter.z / cellSize);
      const key = [
        mesh.material.uuid,
        mesh.castShadow ? 'cast' : 'no-cast',
        mesh.receiveShadow ? 'receive' : 'no-receive',
        mesh.renderOrder,
        cellX,
        cellY,
        cellZ,
      ].join(';');
      const batch = batches.get(key) ?? {
        material: mesh.material,
        castShadow: mesh.castShadow,
        receiveShadow: mesh.receiveShadow,
        renderOrder: mesh.renderOrder,
        meshes: [],
      };
      batch.meshes.push(mesh);
      batches.set(key, batch);
    });

    let batchIndex = 0;
    for (const batch of batches.values()) {
      if (batch.meshes.length < 2) continue;
      const transformed: THREE.BufferGeometry[] = [];
      const normalizedClone = (source: THREE.BufferGeometry): THREE.BufferGeometry => {
        const geometry = source.index ? source.toNonIndexed() : source.clone();
        const keepColor = Boolean((batch.material as THREE.MeshStandardMaterial).vertexColors);
        for (const attribute of Object.keys(geometry.attributes)) {
          if (!['position', 'normal', 'uv'].includes(attribute) && !(keepColor && attribute === 'color')) {
            geometry.deleteAttribute(attribute);
          }
        }
        if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
        if (!geometry.getAttribute('uv')) {
          const positions = geometry.getAttribute('position');
          geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(positions.count * 2), 2));
        }
        if (keepColor && !geometry.getAttribute('color')) {
          const positions = geometry.getAttribute('position');
          const colors = new Float32Array(positions.count * 3);
          colors.fill(1);
          geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        }
        for (const attributeName of Object.keys(geometry.attributes)) {
          const attribute = geometry.getAttribute(attributeName);
          if (attribute.array instanceof Float32Array && !attribute.normalized) continue;
          const values = new Float32Array(attribute.count * attribute.itemSize);
          for (let index = 0; index < attribute.count; index += 1) {
            const offset = index * attribute.itemSize;
            values[offset] = attribute.getX(index);
            if (attribute.itemSize > 1) values[offset + 1] = attribute.getY(index);
            if (attribute.itemSize > 2) values[offset + 2] = attribute.getZ(index);
            if (attribute.itemSize > 3) values[offset + 3] = attribute.getW(index);
          }
          geometry.setAttribute(attributeName, new THREE.Float32BufferAttribute(values, attribute.itemSize));
        }
        return geometry;
      };
      for (const mesh of batch.meshes) {
        sourceToGroup.multiplyMatrices(groupInverse, mesh.matrixWorld);
        const instanced = mesh as THREE.InstancedMesh;
        if (instanced.isInstancedMesh) {
          for (let instance = 0; instance < instanced.count; instance += 1) {
            instanced.getMatrixAt(instance, instanceTransform);
            localTransform.multiplyMatrices(sourceToGroup, instanceTransform);
            transformed.push(normalizedClone(mesh.geometry).applyMatrix4(localTransform));
          }
        } else {
          transformed.push(normalizedClone(mesh.geometry).applyMatrix4(sourceToGroup));
        }
      }
      const baselineAttributes = transformed[0].attributes;
      const compatible = Object.keys(baselineAttributes).every((name) => {
        const baseline = baselineAttributes[name] as THREE.BufferAttribute;
        return transformed.every((geometry) => {
          const attribute = geometry.getAttribute(name) as THREE.BufferAttribute;
          return attribute.array.constructor === baseline.array.constructor
            && attribute.itemSize === baseline.itemSize
            && attribute.normalized === baseline.normalized
            && (attribute as THREE.BufferAttribute & { gpuType?: number }).gpuType
              === (baseline as THREE.BufferAttribute & { gpuType?: number }).gpuType;
        });
      });
      if (!compatible) {
        for (const geometry of transformed) geometry.dispose();
        continue;
      }
      const merged = mergeGeometries(transformed, false);
      for (const geometry of transformed) geometry.dispose();
      if (!merged) continue;
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      this.trackGeometry(merged);
      const mesh = new THREE.Mesh(merged, batch.material);
      mesh.name = `QuickSense static spatial batch ${++batchIndex}`;
      mesh.castShadow = batch.castShadow;
      mesh.receiveShadow = batch.receiveShadow;
      mesh.renderOrder = batch.renderOrder;
      mesh.userData.sourceMeshCount = batch.meshes.length;
      this.group.add(mesh);
      for (const source of batch.meshes) {
        retiredGeometries.add(source.geometry);
        source.removeFromParent();
      }
    }
    const retainedGeometries = new Set<THREE.BufferGeometry>();
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) retainedGeometries.add(mesh.geometry);
    });
    for (const geometry of retiredGeometries) {
      if (retainedGeometries.has(geometry)) continue;
      geometry.dispose();
      const index = this.geometries.indexOf(geometry);
      if (index >= 0) this.geometries.splice(index, 1);
    }
    this.group.userData.staticRenderBatches = batchIndex;
  }

  /**
   * Build projectile, hitscan, grapple, and LOS collision from the same opaque
   * triangles the player can see. The previous per-segment AABBs filled the
   * empty volume above curved roads, while mountains were omitted entirely.
   * Keeping this mesh separate from movement collision preserves the smooth
   * analytic ski solver without sacrificing exact combat occlusion.
   */
  private createStaticWorldShotCollision(): void {
    this.group.updateMatrixWorld(true);
    const groupInverse = this.group.matrixWorld.clone().invert();
    const positions: number[] = [];
    const animated = new Set(this.animatedProps.map((prop) => prop.object));
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const meshToLocal = new THREE.Matrix4();
    const instanceMatrix = new THREE.Matrix4();
    let sourceMeshes = 0;
    let ignoredMeshes = 0;

    const hasAncestor = (object: THREE.Object3D, predicate: (ancestor: THREE.Object3D) => boolean): boolean => {
      let ancestor: THREE.Object3D | null = object;
      while (ancestor && ancestor !== this.group) {
        if (predicate(ancestor)) return true;
        ancestor = ancestor.parent;
      }
      return false;
    };
    const appendGeometry = (mesh: THREE.Mesh, transform: THREE.Matrix4): void => {
      const attribute = mesh.geometry.getAttribute('position');
      if (!attribute) return;
      const index = mesh.geometry.getIndex();
      const count = index?.count ?? attribute.count;
      let appended = false;
      for (let offset = 0; offset + 2 < count; offset += 3) {
        const ia = index ? index.getX(offset) : offset;
        const ib = index ? index.getX(offset + 1) : offset + 1;
        const ic = index ? index.getX(offset + 2) : offset + 2;
        a.fromBufferAttribute(attribute, ia).applyMatrix4(transform);
        b.fromBufferAttribute(attribute, ib).applyMatrix4(transform);
        c.fromBufferAttribute(attribute, ic).applyMatrix4(transform);
        ab.subVectors(b, a);
        ac.subVectors(c, a);
        if (ab.cross(ac).lengthSq() < 1e-10) continue;
        positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
        appended = true;
      }
      if (appended) sourceMeshes += 1;
    };

    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) return;
      const importedTower = hasAncestor(mesh, (ancestor) => ancestor.name === 'QuickSense imported outpost tower');
      const animatedMesh = hasAncestor(mesh, (ancestor) => animated.has(ancestor));
      const label = mesh.name.toLowerCase();
      const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]);
      const hasOpaqueSurface = materials.some((material) => (
        material.visible && !material.transparent && material.opacity >= 0.92
      ));
      if (importedTower || animatedMesh || !hasOpaqueSurface || /particle|weather/.test(label)) {
        ignoredMeshes += 1;
        return;
      }

      meshToLocal.multiplyMatrices(groupInverse, mesh.matrixWorld);
      const instanced = mesh as THREE.InstancedMesh;
      if (instanced.isInstancedMesh) {
        const baseMatrix = meshToLocal.clone();
        for (let instance = 0; instance < instanced.count; instance += 1) {
          instanced.getMatrixAt(instance, instanceMatrix);
          meshToLocal.multiplyMatrices(baseMatrix, instanceMatrix);
          appendGeometry(mesh, meshToLocal);
        }
      } else {
        appendGeometry(mesh, meshToLocal);
      }
    });

    if (positions.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    this.trackGeometry(geometry);
    this.staticWorldShotBoundsTree = new MeshBVH(geometry, { maxLeafSize: 20 });
    this.staticWorldShotTriangleCount = positions.length / 9;
    this.group.userData.staticWorldShotAudit = {
      engine: 'visible-static-projectile-bvh',
      triangles: this.staticWorldShotTriangleCount,
      sourceMeshes,
      ignoredMeshes,
      broadProxyFallbacks: 0,
    };
  }

  /**
   * Build exact support from the visible static scene. The analytic terrain,
   * route, and platform surfaces remain the fast baseline, while this BVH
   * seals authored roofs, mountain shelves, foundations, and irregular decks
   * that previously had no floor contract and could be fallen through.
   */
  private createStaticWorldFloorCollision(): void {
    this.group.updateMatrixWorld(true);
    const groupInverse = this.group.matrixWorld.clone().invert();
    const positions: number[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const cross = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const meshToLocal = new THREE.Matrix4();
    const instanceMatrix = new THREE.Matrix4();
    const appendGeometry = (mesh: THREE.Mesh, transform: THREE.Matrix4): void => {
      const attribute = mesh.geometry.getAttribute('position');
      if (!attribute) return;
      const index = mesh.geometry.getIndex();
      const count = index?.count ?? attribute.count;
      for (let offset = 0; offset < count; offset += 3) {
        const ia = index ? index.getX(offset) : offset;
        const ib = index ? index.getX(offset + 1) : offset + 1;
        const ic = index ? index.getX(offset + 2) : offset + 2;
        a.fromBufferAttribute(attribute, ia).applyMatrix4(transform);
        b.fromBufferAttribute(attribute, ib).applyMatrix4(transform);
        c.fromBufferAttribute(attribute, ic).applyMatrix4(transform);
        cross.subVectors(b, a).cross(ac.subVectors(c, a));
        const doubledArea = cross.length();
        if (doubledArea < 0.004 || cross.y / doubledArea < MOVEMENT.maxSlopeCosine) continue;
        positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      }
    };
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) return;
      const hierarchyNames: string[] = [];
      let ancestor: THREE.Object3D | null = mesh;
      while (ancestor && ancestor !== this.group) {
        hierarchyNames.push(ancestor.name.toLowerCase());
        ancestor = ancestor.parent;
      }
      const label = hierarchyNames.join(' ');
      if (label.includes('quicksense imported outpost tower')) return;
      if (/signal|centerline|edge trim|window light|cable|halo|banner|moss|particle|weather|jump pad|command console/.test(label)) return;
      meshToLocal.multiplyMatrices(groupInverse, mesh.matrixWorld);
      const instanced = mesh as THREE.InstancedMesh;
      if (instanced.isInstancedMesh) {
        const baseMatrix = meshToLocal.clone();
        for (let instance = 0; instance < instanced.count; instance += 1) {
          instanced.getMatrixAt(instance, instanceMatrix);
          meshToLocal.multiplyMatrices(baseMatrix, instanceMatrix);
          appendGeometry(mesh, meshToLocal);
        }
      } else {
        appendGeometry(mesh, meshToLocal);
      }
    });
    if (positions.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    this.trackGeometry(geometry);
    this.staticWorldFloorBoundsTree = new MeshBVH(geometry, { maxLeafSize: 16 });
    this.staticWorldFloorBounds.copy(geometry.boundingBox!);
    this.staticWorldFloorTriangleCount = positions.length / 9;
    this.group.userData.staticWorldFloorAudit = {
      engine: 'visible-static-floor-bvh',
      triangles: this.staticWorldFloorTriangleCount,
    };
  }

  private createOutpostTower(
    model: THREE.Group,
    panelTexture: THREE.Texture,
    panelNormal: THREE.Texture,
    panelRoughness: THREE.Texture,
  ): void {
    const texturedMaterial = (
      name: string,
      color: number,
      metalness: number,
      roughness: number,
      normalScale = 0.32,
      celDepth = true,
    ): THREE.MeshStandardMaterial => {
      const material = this.material(name, color, metalness, roughness, panelTexture);
      material.flatShading = false;
      material.roughnessMap = panelRoughness;
      material.normalMap = panelNormal;
      material.normalScale.set(normalScale, normalScale);
      material.side = THREE.DoubleSide;
      material.shadowSide = THREE.FrontSide;
      material.envMapIntensity = 0.82;
      if (celDepth) applyGroundedCelDepth(material, 0.11, 8);
      material.needsUpdate = true;
      return material;
    };

    const shellMaterial = texturedMaterial('QuickSense outpost tower graphite shell', 0x48585d, 0.55, 0.66);
    const interiorMaterial = texturedMaterial('QuickSense outpost tower illuminated interior', 0x4c5c61, 0.16, 0.68, 0.14, false);
    // Keep the wall material dark enough to receive authored pools of light;
    // a strong full-surface emissive made the entire stair volume read flat.
    interiorMaterial.emissive.setHex(0x07191d);
    interiorMaterial.emissiveIntensity = 0.18;
    const trimMaterial = texturedMaterial('QuickSense outpost tower brushed trim', 0xb8c4c5, 0.78, 0.34, 0.2);
    const padMaterial = texturedMaterial('QuickSense outpost tower flight deck', 0x394f57, 0.62, 0.58, 0.24);
    const doorMaterial = this.material('QuickSense outpost tower passable energy doors', 0x56b9c4, 0.08, 0.3);
    doorMaterial.emissive.setHex(0x0b7181);
    doorMaterial.emissiveIntensity = 1.4;
    doorMaterial.side = THREE.DoubleSide;
    doorMaterial.transparent = true;
    doorMaterial.opacity = 0.34;
    doorMaterial.depthWrite = false;
    const cyanMaterial = this.emissiveMaterial('QuickSense outpost tower cyan systems', 0x18bad0, 0x087e9b);
    const magentaMaterial = this.emissiveMaterial('QuickSense outpost tower magenta banner', 0xb84d83, 0x8b175d);
    cyanMaterial.side = THREE.DoubleSide;
    cyanMaterial.roughness = 0.34;
    magentaMaterial.side = THREE.DoubleSide;
    magentaMaterial.roughness = 0.52;

    const sourceMaterials = new Set<THREE.Material>();
    const towerX = 0;
    const towerZ = 0;
    model.name = 'QuickSense imported outpost tower';
    model.scale.set(
      OUTPOST_TOWER_MODEL_SCALE_XZ,
      OUTPOST_TOWER_MODEL_SCALE_Y,
      OUTPOST_TOWER_MODEL_SCALE_XZ,
    );
    model.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    const terrainY = Math.max(
      this.terrainHeightAt(towerX, towerZ),
      this.terrainHeightAt(towerX, towerZ - 18),
      this.terrainHeightAt(towerX - 12, towerZ),
      this.terrainHeightAt(towerX + 12, towerZ),
    );
    // The source origin is centered on the inhabited tower shaft while its
    // aircraft pads are intentionally asymmetric. Keep that authored shaft on
    // the map origin and only solve the vertical seat from the measured GLB.
    const towerBaseY = terrainY + 0.08;
    model.position.set(towerX, towerBaseY - bounds.min.y, towerZ);
    model.userData.source = 'Sketchfab Outpost Tower (FXB) by laza';
    model.userData.license = 'CC BY-NC 4.0';
    model.userData.texturePass = 'QuickSense authored panel grid, roughness, and signal accents';
    model.updateMatrixWorld(true);

    const pieceAudit: Array<{
      name: string;
      role: string;
      triangles: number;
      uvVertices: number;
      bounds: { min: THREE.Vector3; max: THREE.Vector3 };
    }> = [];
    model.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      this.trackGeometry(mesh.geometry);
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => sourceMaterials.add(material));
      const label = `${mesh.name} ${object.name}`.toLowerCase();
      let material = shellMaterial;
      let role = 'shell';
      if (label.includes('interior')) {
        material = interiorMaterial;
        role = 'interior';
      }
      if (label.includes('aircraftspawnpad') || label.includes('turretplatform')) {
        material = padMaterial;
        role = 'deck';
      }
      if (label.includes('flakcannon') || label.includes('tankcannon')) {
        material = trimMaterial;
        role = 'weapon';
      }
      if (label.includes('doors')) {
        material = doorMaterial;
        role = 'door';
      }
      if (label.includes('jumppad') || label.includes('commandconsole')) {
        material = cyanMaterial;
        role = 'system';
      }
      if (label.includes('banner')) {
        material = magentaMaterial;
        role = 'banner';
      }
      mesh.material = material;
      const isShadowedArchitecture = role === 'shell' || role === 'deck' || role === 'weapon';
      mesh.castShadow = isShadowedArchitecture;
      mesh.receiveShadow = isShadowedArchitecture;
      mesh.frustumCulled = true;
      const meshBounds = new THREE.Box3().setFromObject(mesh);
      const positions = mesh.geometry.getAttribute('position');
      const indices = mesh.geometry.getIndex();
      pieceAudit.push({
        name: mesh.name,
        role,
        triangles: Math.round((indices?.count ?? positions.count) / 3),
        uvVertices: mesh.geometry.getAttribute('uv')?.count ?? 0,
        bounds: { min: meshBounds.min.clone(), max: meshBounds.max.clone() },
      });
    });

    this.group.add(model);
    for (const material of sourceMaterials) material.dispose();
    const traversal = this.createOutpostTowerCollision(model);
    const renderBatchAudit = this.batchOutpostTowerRenderMeshes(model);
    this.outpostTowerCoreLocal = traversal.corePosition.clone();
    const seatedBounds = new THREE.Box3().setFromObject(model);
    const signalCrown = this.createOutpostTowerSignalCrown(
      seatedBounds,
      trimMaterial,
      cyanMaterial,
    );
    const crownedBounds = seatedBounds.clone().union(new THREE.Box3().setFromObject(signalCrown));
    const grounding = this.createOutpostTowerGrounding(
      model,
      seatedBounds,
      traversal.entrance,
      traversal.smoothRoutes,
      shellMaterial,
      trimMaterial,
    );
    this.createOutpostTowerPresentation(
      grounding.accessStairs,
      shellMaterial,
      trimMaterial,
      cyanMaterial,
      magentaMaterial,
    );
    const worldBounds = {
      min: this.localToWorld(crownedBounds.min),
      max: this.localToWorld(crownedBounds.max),
    };
    this.group.userData.outpostTowerAudit = {
      center: this.localToWorld(new THREE.Vector3(towerX, towerBaseY + size.y * 0.5, towerZ)),
      entrance: this.localToWorld(traversal.entrance),
      core: this.localToWorld(traversal.corePosition),
      flights: traversal.flights.map((flight) => ({
        name: flight.name,
        start: this.localToWorld(flight.start),
        end: this.localToWorld(flight.end),
      })),
      bounds: worldBounds,
      height: crownedBounds.getSize(new THREE.Vector3()).y * QUICK_VERTICAL_SCALE,
      habitableHeight: size.y * QUICK_VERTICAL_SCALE,
      collision: {
        engine: 'hybrid-authored-bvh',
        triangles: this.outpostTowerCollisionTriangleCount,
        bodyTriangles: this.outpostTowerBodyTriangleCount,
        walkableTriangles: this.outpostTowerFloorTriangleCount,
      },
      rendering: renderBatchAudit,
      grounding: {
        foundationTop: this.localToWorld(grounding.foundationTop),
        accessStairs: grounding.accessStairs.map((stair) => ({
          start: this.localToWorld(stair.start),
          end: this.localToWorld(stair.end),
          width: stair.width * QUICK_HORIZONTAL_SCALE,
        })),
      },
    };
    this.group.userData.outpostTowerPieces = pieceAudit.map((piece) => ({
      name: piece.name,
      role: piece.role,
      triangles: piece.triangles,
      uvVertices: piece.uvVertices,
      bounds: {
        min: this.localToWorld(piece.bounds.min),
        max: this.localToWorld(piece.bounds.max),
      },
    }));
    this.registerBuilding(
      'Outpost Tower',
      'citadel',
      'imported-fxb',
      'amber',
      new THREE.Vector3(towerX, towerBaseY + size.y * 0.5, towerZ),
    );
  }

  private batchOutpostTowerRenderMeshes(model: THREE.Group): {
    sourceMeshes: number;
    renderBatches: number;
  } {
    model.updateMatrixWorld(true);
    const modelInverse = model.matrixWorld.clone().invert();
    const transform = new THREE.Matrix4();
    const batches = new Map<THREE.Material, THREE.Mesh[]>();
    model.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material) || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
      const batch = batches.get(mesh.material) ?? [];
      batch.push(mesh);
      batches.set(mesh.material, batch);
    });

    let sourceMeshes = 0;
    let renderBatches = 0;
    for (const [material, meshes] of batches) {
      if (meshes.length < 2) continue;
      const transformed = meshes.map((mesh) => {
        const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
        for (const attribute of Object.keys(geometry.attributes)) {
          if (!['position', 'normal', 'uv'].includes(attribute)) geometry.deleteAttribute(attribute);
        }
        if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
        if (!geometry.getAttribute('uv')) {
          const positions = geometry.getAttribute('position');
          geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(positions.count * 2), 2));
        }
        // Some GLB parts encode UVs as normalized integers while others use
        // Float32. BufferGeometryUtils correctly refuses mixed array types, so
        // normalize the three shader inputs before merging each material role.
        for (const attributeName of ['position', 'normal', 'uv']) {
          const attribute = geometry.getAttribute(attributeName);
          const values = new Float32Array(attribute.count * attribute.itemSize);
          for (let index = 0; index < attribute.count; index += 1) {
            const offset = index * attribute.itemSize;
            values[offset] = attribute.getX(index);
            if (attribute.itemSize > 1) values[offset + 1] = attribute.getY(index);
            if (attribute.itemSize > 2) values[offset + 2] = attribute.getZ(index);
            if (attribute.itemSize > 3) values[offset + 3] = attribute.getW(index);
          }
          geometry.setAttribute(
            attributeName,
            new THREE.Float32BufferAttribute(values, attribute.itemSize),
          );
        }
        transform.multiplyMatrices(modelInverse, mesh.matrixWorld);
        geometry.applyMatrix4(transform);
        return geometry;
      });
      const merged = mergeGeometries(transformed, false);
      for (const geometry of transformed) geometry.dispose();
      if (!merged) continue;
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      this.trackGeometry(merged);
      const batched = new THREE.Mesh(merged, material);
      batched.name = `QuickSense imported tower render batch ${material.name}`;
      batched.castShadow = meshes.some((mesh) => mesh.castShadow);
      batched.receiveShadow = meshes.some((mesh) => mesh.receiveShadow);
      batched.userData.sourceMeshCount = meshes.length;
      model.add(batched);
      for (const source of meshes) {
        source.removeFromParent();
        source.geometry.dispose();
      }
      sourceMeshes += meshes.length;
      renderBatches += 1;
    }
    const audit = { sourceMeshes, renderBatches };
    model.userData.renderBatchAudit = audit;
    return audit;
  }

  private createOutpostTowerPresentation(
    routes: Array<{ start: THREE.Vector3; end: THREE.Vector3; width: number }>,
    structureMaterial: THREE.MeshStandardMaterial,
    trimMaterial: THREE.MeshStandardMaterial,
    cyanMaterial: THREE.MeshStandardMaterial,
    magentaMaterial: THREE.MeshStandardMaterial,
  ): void {
    const entry = routes[0];
    if (!entry) return;
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const structural: InstanceTransform[] = [];
    const trim: InstanceTransform[] = [];
    const cyan: InstanceTransform[] = [];
    const magenta: InstanceTransform[] = [];
    const delta = entry.end.clone().sub(entry.start);
    const run = Math.hypot(delta.x, delta.z);
    const length = delta.length();
    const yaw = Math.atan2(delta.x, delta.z);
    const slope = Math.atan2(delta.y, Math.max(run, 0.001));
    const slopeRotation = new THREE.Euler(-slope, yaw, 0, 'YXZ');
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const inward = delta.clone().setY(0).normalize();
    const midpoint = entry.start.clone().lerp(entry.end, 0.5);
    const routePoint = (t: number): THREE.Vector3 => entry.start.clone().lerp(entry.end, t);

    // One continuous engineered slab removes the floating-tread read while the
    // thin terrain apron gives the access route a deliberate load path.
    structural.push({
      position: midpoint.clone().add(new THREE.Vector3(0, -0.22, 0)),
      scale: new THREE.Vector3(entry.width * 1.06, 0.22, length),
      rotation: slopeRotation,
    });
    for (let index = 0; index < 3; index += 1) {
      const position = entry.start.clone().addScaledVector(inward, -(1.25 + index * 2.15));
      const terrainY = this.terrainHeightAt(position.x, position.z);
      structural.push({
        position: new THREE.Vector3(position.x, terrainY + 0.025, position.z),
        scale: new THREE.Vector3(entry.width * (1.3 + index * 0.08), 0.09, 2.3),
        yaw,
      });
    }

    for (const side of [-1, 1]) {
      const lateral = right.clone().multiplyScalar(side * (entry.width * 0.58 + 0.12));
      structural.push({
        position: midpoint.clone().add(lateral).add(new THREE.Vector3(0, -0.2, 0)),
        scale: new THREE.Vector3(0.24, 0.3, length),
        rotation: slopeRotation,
      });
      trim.push({
        position: midpoint.clone().add(lateral).add(new THREE.Vector3(0, 0.5, 0)),
        scale: new THREE.Vector3(0.075, 0.075, length),
        rotation: slopeRotation,
      });
      trim.push({
        position: midpoint.clone().add(lateral).add(new THREE.Vector3(0, 0.25, 0)),
        scale: new THREE.Vector3(0.05, 0.05, length),
        rotation: slopeRotation,
      });
      for (let index = 0; index <= 8; index += 1) {
        const point = routePoint(index / 8).add(lateral);
        trim.push({
          position: point.clone().add(new THREE.Vector3(0, 0.25, 0)),
          scale: new THREE.Vector3(0.075, 0.56, 0.075),
        });
      }
      for (const t of [0.08, 0.31, 0.54, 0.77, 0.96]) {
        const point = routePoint(t).add(lateral);
        const terrainY = this.terrainHeightAt(point.x, point.z) - 0.03;
        const topY = point.y - 0.22;
        const supportHeight = Math.max(0.28, topY - terrainY);
        structural.push({
          position: new THREE.Vector3(point.x, terrainY + supportHeight * 0.5, point.z),
          scale: new THREE.Vector3(0.26, supportHeight, 0.26),
        });
      }
      const landingSide = entry.end.clone().add(lateral);
      structural.push({
        position: landingSide.add(new THREE.Vector3(0, 0.48, 0)).addScaledVector(inward, 0.65),
        scale: new THREE.Vector3(0.42, 1.35, 1.6),
        yaw,
      });
    }

    // Alternating route lights turn the approach into an authored faction seam
    // and make every fifth tread legible without introducing collision edges.
    for (let index = 0; index < 12; index += 1) {
      const t = (index + 0.5) / 12;
      const point = routePoint(t).add(new THREE.Vector3(0, 0.055, 0));
      const transform = {
        position: point,
        scale: new THREE.Vector3(entry.width * 0.84, 0.035, 0.09),
        yaw,
      };
      (index % 2 === 0 ? cyan : magenta).push(transform);
    }

    const facadeX = entry.end.x + 1.55;
    const facadeY = entry.end.y + 2.15;
    cyan.push(
      { position: new THREE.Vector3(facadeX, facadeY, -entry.width * 1.35), scale: new THREE.Vector3(0.075, 2.4, 0.13) },
      { position: new THREE.Vector3(facadeX, facadeY + 1.25, -entry.width * 0.82), scale: new THREE.Vector3(0.075, 0.11, entry.width * 0.9) },
    );
    magenta.push(
      { position: new THREE.Vector3(facadeX, facadeY, entry.width * 1.35), scale: new THREE.Vector3(0.075, 2.4, 0.13) },
      { position: new THREE.Vector3(facadeX, facadeY + 1.25, entry.width * 0.82), scale: new THREE.Vector3(0.075, 0.11, entry.width * 0.9) },
    );

    // Alternating attached fixtures pull the eye through the tunnel and make
    // its depth readable from both gameplay and player-eye stair views.
    for (let index = 0; index < 4; index += 1) {
      const fixture = entry.end.clone().addScaledVector(inward, 2.5 + index * 3.1);
      fixture.y += 2.55;
      const transform = {
        position: fixture,
        scale: new THREE.Vector3(entry.width * 0.72, 0.055, 0.14),
        yaw,
      };
      (index % 2 === 0 ? cyan : magenta).push(transform);
    }

    // Repeat the navigation language on representative internal flights. The
    // narrow side-mounted strips remain outside the walkable lane, while the
    // paired local lights break up the previously flat gray stair interiors.
    const internalLightRoutes = routes.filter((_, index) => index === 1 || index === 4 || index === 7);
    internalLightRoutes.forEach((route, routeIndex) => {
      const routeDelta = route.end.clone().sub(route.start);
      const routeYaw = Math.atan2(routeDelta.x, routeDelta.z);
      const routeRight = new THREE.Vector3(Math.cos(routeYaw), 0, -Math.sin(routeYaw));
      const routeMidpoint = route.start.clone().lerp(route.end, 0.5);
      for (const side of [-1, 1]) {
        const transform = {
          position: routeMidpoint.clone()
            .addScaledVector(routeRight, side * route.width * 0.48)
            .add(new THREE.Vector3(0, 1.05, 0)),
          scale: new THREE.Vector3(0.055, 0.82, 0.055),
          yaw: routeYaw,
        };
        ((routeIndex + (side > 0 ? 1 : 0)) % 2 === 0 ? cyan : magenta).push(transform);
      }
    });

    this.addInstancedMeshes('QuickSense outpost tower engineered edge trim structure', unitBox, structureMaterial, structural);
    this.addInstancedMeshes('QuickSense outpost tower engineered edge trim rails', unitBox, trimMaterial, trim);
    this.addInstancedMeshes('QuickSense outpost tower cyan route signal', unitBox, cyanMaterial, cyan, false);
    this.addInstancedMeshes('QuickSense outpost tower magenta route signal', unitBox, magentaMaterial, magenta, false);

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    if (context) {
      const gradient = context.createLinearGradient(0, 0, canvas.width, 0);
      gradient.addColorStop(0, '#101b21');
      gradient.addColorStop(0.5, '#20323a');
      gradient.addColorStop(1, '#101b21');
      context.fillStyle = gradient;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.strokeStyle = '#33d4e7';
      context.lineWidth = 7;
      context.strokeRect(5, 5, canvas.width - 10, canvas.height - 10);
      context.fillStyle = '#f0a236';
      for (let x = -32; x < 90; x += 28) {
        context.beginPath();
        context.moveTo(x, canvas.height);
        context.lineTo(x + 34, 0);
        context.lineTo(x + 50, 0);
        context.lineTo(x + 16, canvas.height);
        context.closePath();
        context.fill();
      }
      context.font = '700 38px Oxanium, sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillStyle = '#eafcff';
      context.fillText('RIFT // OUTPOST 01', 300, 64);
    }
    const signTexture = new THREE.CanvasTexture(canvas);
    signTexture.colorSpace = THREE.SRGBColorSpace;
    signTexture.minFilter = THREE.LinearMipmapLinearFilter;
    signTexture.magFilter = THREE.LinearFilter;
    this.textures.push(signTexture);
    const signMaterial = new THREE.MeshBasicMaterial({
      name: 'QuickSense outpost tower identity signal',
      map: signTexture,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.materials.push(signMaterial);
    const signGeometry = new THREE.PlaneGeometry(5.2, 1.05);
    this.trackGeometry(signGeometry);
    const sign = new THREE.Mesh(signGeometry, signMaterial);
    sign.name = 'QuickSense outpost tower identity signal';
    sign.position.set(facadeX + 0.02, entry.end.y + 4.15, 0);
    sign.rotation.y = Math.PI * 0.5;
    sign.renderOrder = 3;
    this.group.add(sign);

    const entranceLight = new THREE.PointLight(0x57deee, 145, 16, 2);
    entranceLight.name = 'QuickSense outpost tower attached entrance light';
    entranceLight.position.copy(entry.end).addScaledVector(inward, 2.8).add(new THREE.Vector3(0, 2.1, 0));
    entranceLight.castShadow = false;
    this.group.add(entranceLight);
    const interiorLight = new THREE.PointLight(0xff9f4a, 105, 15, 2);
    interiorLight.name = 'QuickSense outpost tower attached interior light';
    interiorLight.position.copy(entry.end).addScaledVector(inward, 9).add(new THREE.Vector3(0, 2.25, 0));
    interiorLight.castShadow = false;
    this.group.add(interiorLight);
    internalLightRoutes.forEach((route, index) => {
      const colors = [0x57deee, 0xffa45a, 0xff5fbe];
      const light = new THREE.PointLight(colors[index % colors.length], 125, 12, 2);
      light.name = `QuickSense outpost tower internal route light ${index + 1}`;
      light.position.copy(route.start).lerp(route.end, 0.5).add(new THREE.Vector3(0, 1.35, 0));
      light.castShadow = false;
      this.group.add(light);
    });
  }

  private createOutpostTowerSignalCrown(
    towerBounds: THREE.Box3,
    trimMaterial: THREE.MeshStandardMaterial,
    signalMaterial: THREE.MeshStandardMaterial,
  ): THREE.Group {
    const crown = new THREE.Group();
    crown.name = 'QuickSense outpost tower signal crown';
    crown.position.set(0, towerBounds.max.y, 0);
    const addPart = (
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      name: string,
      y: number,
      rotationX = 0,
    ): THREE.Mesh => {
      this.trackGeometry(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `QuickSense outpost tower signal crown ${name}`;
      mesh.position.y = y;
      mesh.rotation.x = rotationX;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      crown.add(mesh);
      return mesh;
    };
    addPart(new THREE.CylinderGeometry(0.34, 0.58, 8, 10), trimMaterial, 'lower mast', 4);
    addPart(new THREE.CylinderGeometry(0.12, 0.3, 13, 8), trimMaterial, 'upper mast', 14.5);
    addPart(new THREE.TorusGeometry(1.15, 0.08, 6, 24), signalMaterial, 'locator ring', 9.2, Math.PI * 0.5);
    addPart(new THREE.ConeGeometry(0.44, 3, 8), trimMaterial, 'spire tip', 22.5);
    addPart(new THREE.SphereGeometry(0.3, 10, 8), signalMaterial, 'beacon', 24);
    this.group.add(crown);
    crown.updateMatrixWorld(true);
    return crown;
  }

  private createOutpostTowerCollision(model: THREE.Group): {
    entrance: THREE.Vector3;
    corePosition: THREE.Vector3;
    flights: Array<{ name: string; start: THREE.Vector3; end: THREE.Vector3 }>;
    smoothRoutes: Array<{ name: string; start: THREE.Vector3; end: THREE.Vector3; width: number }>;
  } {
    model.updateMatrixWorld(true);
    const sourcePoint = (x: number, y: number, z: number): THREE.Vector3 => (
      new THREE.Vector3(x, y, z).applyMatrix4(model.matrixWorld)
    );
    const smoothRoutes = OUTPOST_TOWER_SOURCE_SMOOTH_ROUTES.map((route) => ({
      name: route.name,
      start: sourcePoint(route.start[0], route.start[1], route.start[2]),
      end: sourcePoint(route.end[0], route.end[1], route.end[2]),
      width: route.width * model.scale.x,
    }));
    const surfacePositions: number[] = [];
    const bodyPositions: number[] = [];
    const floorPositions: number[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    model.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const label = mesh.name.toLowerCase();
      // Doors are energy membranes and remain intentionally passable. Small
      // consoles, banners, pads, and weapon props should not snag the capsule;
      // their load-bearing decks and surrounding architecture are included by
      // the structural meshes.
      if (/doors|cannon|banner|commandconsole|jumppad/.test(label)) return;
      const position = mesh.geometry.getAttribute('position');
      const index = mesh.geometry.getIndex();
      const count = index?.count ?? position.count;
      for (let offset = 0; offset < count; offset += 3) {
        const ia = index ? index.getX(offset) : offset;
        const ib = index ? index.getX(offset + 1) : offset + 1;
        const ic = index ? index.getX(offset + 2) : offset + 2;
        a.fromBufferAttribute(position, ia).applyMatrix4(mesh.matrixWorld);
        b.fromBufferAttribute(position, ib).applyMatrix4(mesh.matrixWorld);
        c.fromBufferAttribute(position, ic).applyMatrix4(mesh.matrixWorld);
        ab.subVectors(b, a).cross(ac.subVectors(c, a));
        const doubledArea = ab.length();
        // Ignore micro-bevels and cable facets smaller than the movement skin.
        // They remain fully rendered, but cannot catch a running player.
        if (doubledArea < 0.008) continue;
        surfacePositions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
        // Build a second, much smaller BVH containing only authored upward
        // walkable faces. This avoids a downward floor probe stopping on a
        // wall bevel or ceiling before it reaches the actual tread below.
        if (ab.y / doubledArea >= MOVEMENT.maxSlopeCosine) {
          floorPositions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
        } else if (
          Math.max(a.y, b.y, c.y) - Math.min(a.y, b.y, c.y)
            > MOVEMENT.stepHeight / QUICK_VERTICAL_SCALE + 0.32
          && doubledArea >= 0.045
        ) {
          const centroidX = (a.x + b.x + c.x) / 3;
          const centroidY = (a.y + b.y + c.y) / 3;
          const centroidZ = (a.z + b.z + c.z) / 3;
          const insideSmoothStair = smoothRoutes.some((route) => {
            const { x: startX, y: startY, z: startZ } = route.start;
            const { x: endX, y: endY, z: endZ } = route.end;
            const dx = endX - startX;
            const dz = endZ - startZ;
            const lengthSquared = dx * dx + dz * dz;
            const t = THREE.MathUtils.clamp(
              ((centroidX - startX) * dx + (centroidZ - startZ) * dz) / lengthSquared,
              0,
              1,
            );
            const routeX = THREE.MathUtils.lerp(startX, endX, t);
            const routeY = THREE.MathUtils.lerp(startY, endY, t);
            const routeZ = THREE.MathUtils.lerp(startZ, endZ, t);
            const triangleMinX = Math.min(a.x, b.x, c.x);
            const triangleMaxX = Math.max(a.x, b.x, c.x);
            const triangleMinY = Math.min(a.y, b.y, c.y);
            const triangleMaxY = Math.max(a.y, b.y, c.y);
            const triangleMinZ = Math.min(a.z, b.z, c.z);
            const triangleMaxZ = Math.max(a.z, b.z, c.z);
            const routeMinX = Math.min(startX, endX) - route.width * 0.62;
            const routeMaxX = Math.max(startX, endX) + route.width * 0.62;
            const routeMinZ = Math.min(startZ, endZ) - route.width * 0.62;
            const routeMaxZ = Math.max(startZ, endZ) + route.width * 0.62;
            const routeMinY = Math.min(startY, endY) - 0.32;
            const routeMaxY = Math.max(startY, endY) + 1.05;
            const projectedBoundsOverlap = triangleMaxX >= routeMinX
              && triangleMinX <= routeMaxX
              && triangleMaxZ >= routeMinZ
              && triangleMinZ <= routeMaxZ
              && triangleMaxY >= routeMinY
              && triangleMinY <= routeMaxY;
            return projectedBoundsOverlap || (
              Math.hypot(centroidX - routeX, centroidZ - routeZ) <= route.width * 0.62
              && centroidY >= routeY - 0.32
              && centroidY <= routeY + 1.05
            );
          });
          if (insideSmoothStair) continue;
          // Support faces are seated by floorSurfaceAt. Keeping them out of
          // the penetrating body BVH avoids double-resolution and stops tread
          // bevels from catching the capsule; walls, ceilings and rails remain
          // authored geometry. Sub-capsule panel bevels remain visual-only so
          // they cannot snag a player moving through an otherwise open portal.
          bodyPositions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
        }
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(bodyPositions, 3));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    this.trackGeometry(geometry);
    this.outpostTowerBoundsTree = new MeshBVH(geometry, { maxLeafSize: 18 });
    this.outpostTowerBodyTriangleCount = bodyPositions.length / 9;

    const surfaceGeometry = new THREE.BufferGeometry();
    surfaceGeometry.setAttribute('position', new THREE.Float32BufferAttribute(surfacePositions, 3));
    surfaceGeometry.computeBoundingBox();
    surfaceGeometry.computeBoundingSphere();
    this.trackGeometry(surfaceGeometry);
    this.outpostTowerSurfaceBoundsTree = new MeshBVH(surfaceGeometry, { maxLeafSize: 18 });
    this.outpostTowerCollisionBounds.copy(surfaceGeometry.boundingBox!);
    this.outpostTowerCollisionTriangleCount = surfacePositions.length / 9;

    const floorGeometry = new THREE.BufferGeometry();
    floorGeometry.setAttribute('position', new THREE.Float32BufferAttribute(floorPositions, 3));
    floorGeometry.computeBoundingBox();
    floorGeometry.computeBoundingSphere();
    this.trackGeometry(floorGeometry);
    this.outpostTowerFloorBoundsTree = new MeshBVH(floorGeometry, { maxLeafSize: 12 });
    this.outpostTowerFloorTriangleCount = floorPositions.length / 9;

    const entrance = sourcePoint(5.4, 0.05, -15.7);
    const lowerStart = sourcePoint(4.7, 0.05, -15.2);
    const lowerEnd = sourcePoint(0, 15.55, 10.8);
    const upperEnd = sourcePoint(0, 32.05, -4.8);
    const corePosition = upperEnd.clone().add(new THREE.Vector3(0, 1.35, 0));
    return {
      entrance,
      corePosition,
      flights: [
        { name: 'Outpost tower authored lower stair network', start: lowerStart, end: lowerEnd },
        { name: 'Outpost tower authored upper stair network', start: lowerEnd.clone(), end: upperEnd.clone() },
      ],
      smoothRoutes,
    };
  }

  private createOutpostTowerGrounding(
    model: THREE.Group,
    bounds: THREE.Box3,
    entrance: THREE.Vector3,
    smoothRoutes: Array<{ name: string; start: THREE.Vector3; end: THREE.Vector3; width: number }>,
    foundationMaterial: THREE.MeshStandardMaterial,
    stairMaterial: THREE.MeshStandardMaterial,
  ): {
    foundationTop: THREE.Vector3;
    accessStairs: Array<{ start: THREE.Vector3; end: THREE.Vector3; width: number }>;
  } {
    const foundationRadius = 19.375 * model.scale.x;
    const terrainSamples = Array.from({ length: 20 }, (_, index) => {
      const angle = index / 20 * Math.PI * 2;
      return this.terrainHeightAt(
        Math.cos(angle) * foundationRadius,
        Math.sin(angle) * foundationRadius,
      );
    });
    terrainSamples.push(this.terrainHeightAt(0, 0));
    const foundationTopY = bounds.min.y + 0.12;
    const foundationBottomY = Math.min(...terrainSamples) - 0.55;
    const foundationHeight = Math.max(0.8, foundationTopY - foundationBottomY);
    const foundation = this.addMesh(
      new THREE.CylinderGeometry(17.03 * model.scale.x, foundationRadius, foundationHeight, 20, 1, false),
      foundationMaterial,
      'QuickSense outpost tower terrain-sealed foundation',
      new THREE.Vector3(0, foundationBottomY + foundationHeight * 0.5, 0),
    );
    foundation.castShadow = true;
    foundation.receiveShadow = true;

    const stairTransforms: InstanceTransform[] = [];
    const accessStairs: Array<{ start: THREE.Vector3; end: THREE.Vector3; width: number }> = [];
    // Approach through the imported tower's actual east doorway. The former
    // south-west and upper-east handoffs both terminated against authored guard
    // rails; this centerline is clear at full capsule height from terrain into
    // the lower hall, then flows unobstructed to the first visible stair flight.
    const sourceAccessStart = new THREE.Vector3(39.0625, 0, 0).applyMatrix4(model.matrixWorld);
    const sourceAccessEnd = new THREE.Vector3(21.875, 0, 0).applyMatrix4(model.matrixWorld);
    for (const access of [{
      startX: sourceAccessStart.x,
      startZ: sourceAccessStart.z,
      endX: sourceAccessEnd.x,
      endZ: sourceAccessEnd.z,
    }]) {
      const start = new THREE.Vector3(
        access.startX,
        this.terrainHeightAt(access.startX, access.startZ) + 0.06,
        access.startZ,
      );
      const authoredLanding = this.outpostTowerFloorAt(
        access.endX,
        access.endZ,
        entrance.y + 0.8,
        this.outpostTowerCollisionNormal,
      );
      const end = new THREE.Vector3(
        access.endX,
        authoredLanding ?? entrance.y,
        access.endZ,
      );
      const width = 5.46875 * model.scale.x;
      this.buildingEntryRamps.push({
        name: 'QuickSense outpost tower east terrain access smooth stair support',
        start: start.clone(),
        end: end.clone(),
        width,
      });
      accessStairs.push({ start: start.clone(), end: end.clone(), width });
      const run = Math.hypot(end.x - start.x, end.z - start.z);
      const rise = Math.max(0, end.y - start.y);
      const stepCount = Math.max(8, Math.ceil(Math.max(run / 0.34, rise / 0.16)));
      const treadDepth = run / stepCount * 1.08;
      const yaw = Math.atan2(end.x - start.x, end.z - start.z);
      for (let step = 0; step < stepCount; step += 1) {
        const t = (step + 0.5) / stepCount;
        const topY = THREE.MathUtils.lerp(start.y, end.y, (step + 1) / stepCount) - 0.035;
        stairTransforms.push({
          position: new THREE.Vector3(
            THREE.MathUtils.lerp(start.x, end.x, t),
            topY - 0.11,
            THREE.MathUtils.lerp(start.z, end.z, t),
          ),
          scale: new THREE.Vector3(width, 0.22, treadDepth),
          yaw,
        });
      }
    }
    for (const route of smoothRoutes) {
      const start = route.start.clone();
      const end = route.end.clone();
      this.buildingEntryRamps.push({
        name: `QuickSense outpost tower authored ${route.name} smooth support`,
        start: start.clone(),
        end: end.clone(),
        width: route.width,
      });
      accessStairs.push({ start, end, width: route.width });
    }
    this.addInstancedMeshes(
      'QuickSense outpost tower smooth access stair treads',
      new THREE.BoxGeometry(1, 1, 1),
      stairMaterial,
      stairTransforms,
    );
    return {
      foundationTop: new THREE.Vector3(0, foundationTopY, 0),
      accessStairs,
    };
  }
  private addInstancedMeshes(
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    transforms: InstanceTransform[],
    shadows = true,
  ): THREE.InstancedMesh | null {
    if (transforms.length === 0) return null;
    this.trackGeometry(geometry);
    const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
    mesh.name = name;
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const defaultEuler = new THREE.Euler();
    transforms.forEach((transform, index) => {
      const rotation = transform.rotation ?? defaultEuler.set(0, transform.yaw ?? 0, 0);
      quaternion.setFromEuler(rotation);
      matrix.compose(transform.position, quaternion, transform.scale);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    return mesh;
  }

  private registerBuilding(
    name: string,
    category: BuildingAuditEntry['category'],
    profile: string,
    accent: AccentRole,
    position: THREE.Vector3,
  ): void {
    const entry: BuildingAuditEntry = {
      name,
      category,
      profile,
      accent,
      position: { x: position.x, y: position.y, z: position.z },
    };
    this.buildingManifest.push(entry);
    this.group.userData.buildings = this.buildingManifest;

    // Geometry-free markers give QA and future level agents a stable identity
    // for every authored structure without adding a draw call to the scene.
    const building = new THREE.Group();
    building.name = `QuickSense building: ${name}`;
    building.position.copy(position);
    building.userData = {
      kind: 'quicksense-building',
      ...entry,
      sockets: ['roof', 'grapple', 'entrance'],
      collisionContract: 'authored-proxies',
    };
    for (const [socketName, socketY, socketZ] of [
      ['roof', 3.5, 0],
      ['grapple', 5.5, 0.8],
      ['entrance', -2.8, -1.2],
    ] as const) {
      const socket = new THREE.Object3D();
      socket.name = `${name} ${socketName} socket`;
      socket.position.set(0, socketY, socketZ);
      socket.userData = { kind: 'building-socket', socket: socketName };
      building.add(socket);
    }
    this.group.add(building);
  }

  private createMountainWallGeometry(): THREE.BufferGeometry {
    type RidgePoint = { x: number; z: number; y: number };
    const fortressSlots = CLIFF_HABITAT_SPECS.map((spec) => ({
      x: spec.x,
      z: spec.z,
      roofY: spec.roofY,
      // Side rock shoulders extend beyond the occupied shell.  Derive the cut
      // from that complete authored width and add a visible clearance margin.
      halfWidth: Math.atan2(spec.width * 0.72, Math.hypot(spec.x, spec.z)) + 0.025,
      angle: Math.atan2(spec.z, spec.x),
    }));

    // The old perimeter varied every crest sample independently, creating an
    // evenly serrated crown. These authored macro features make long ridges,
    // deep saddles, and a few memorable peaks before any low-poly faceting.
    const ridgeFeatures = [
      { angle: -2.82, width: 0.3, radius: 11, height: 25 },
      { angle: -2.18, width: 0.23, radius: 16, height: 42 },
      { angle: -1.34, width: 0.34, radius: 9, height: 23 },
      { angle: -0.62, width: 0.22, radius: 15, height: 38 },
      { angle: 0.18, width: 0.29, radius: 10, height: 26 },
      { angle: 0.94, width: 0.23, radius: 17, height: 44 },
      { angle: 1.72, width: 0.32, radius: 10, height: 24 },
      { angle: 2.46, width: 0.25, radius: 14, height: 36 },
    ] as const;
    const passes = [
      { angle: -Math.PI * 0.5, width: 0.18, radius: -10, height: -30 },
      { angle: 0.02, width: 0.16, radius: -8, height: -24 },
      { angle: Math.PI * 0.5, width: 0.2, radius: -11, height: -32 },
      { angle: Math.PI - 0.03, width: 0.17, radius: -8, height: -25 },
    ] as const;
    const angularInfluence = (angle: number, center: number, width: number): number => {
      const delta = Math.abs(Math.atan2(Math.sin(angle - center), Math.cos(angle - center)));
      return delta >= width ? 0 : smootherPulse(1 - delta / width);
    };
    const segments = 64;
    const crestSamples: RidgePoint[] = [];
    for (let index = 0; index < segments; index += 1) {
      const angle = index / segments * Math.PI * 2 - Math.PI;
      let radialOffset = Math.sin(angle * 3 + 0.38) * 3.8 + Math.sin(angle * 5 - 0.74) * 2.1;
      let heightOffset = Math.sin(angle * 3 - 0.22) * 8.5 + Math.sin(angle * 5 + 0.91) * 4.8;
      for (const feature of ridgeFeatures) {
        const influence = angularInfluence(angle, feature.angle, feature.width);
        radialOffset += feature.radius * influence;
        heightOffset += feature.height * influence;
      }
      for (const pass of passes) {
        const influence = angularInfluence(angle, pass.angle, pass.width);
        radialOffset += pass.radius * influence;
        heightOffset += pass.height * influence;
      }
      crestSamples.push({
        x: Math.cos(angle) * (106 + radialOffset),
        z: Math.sin(angle) * (95 + radialOffset * 0.78),
        y: THREE.MathUtils.clamp(92 + heightOffset, 68, 145),
      });
    }

    // Eight distinct strata create a readable basin toe, talus, inhabited
    // shelf, upper wall, crest, rear shoulder, secondary ridge, and apron.
    const rings: RidgePoint[][] = Array.from({ length: 8 }, () => []);
    for (let index = 0; index < crestSamples.length; index += 1) {
      const crest = crestSamples[index];
      const angle = Math.atan2(crest.z, crest.x);
      let recess = 0;
      let recessRoofY = 0;
      for (const slot of fortressSlots) {
        const delta = Math.abs(Math.atan2(Math.sin(angle - slot.angle), Math.cos(angle - slot.angle)));
        const influence = delta >= slot.halfWidth ? 0 : smoothPulse(1 - delta / slot.halfWidth);
        if (influence > recess) {
          recess = influence;
          recessRoofY = slot.roofY;
        }
      }
      const tangentX = -Math.sin(angle);
      const tangentZ = Math.cos(angle);
      const erosionShift = Math.sin(angle * 7 + 0.7) * 1.35 + Math.sin(angle * 11 - 0.4) * 0.55;
      const pointAt = (scale: number, y: number, shift = 0): RidgePoint => ({
        x: crest.x * scale + tangentX * (erosionShift + shift),
        z: crest.z * scale + tangentZ * (erosionShift + shift),
        y,
      });
      const passCut = Math.max(...passes.map((pass) => angularInfluence(angle, pass.angle, pass.width)));
      const lowVariation = Math.sin(angle * 4 + 0.6) * 1.8 + Math.sin(angle * 9) * 0.65;
      // The inhabited cuts remain open all the way down to the basin toe. A
      // shallow toe displacement left the first two mountain rings in front of
      // entrances, visually burying doors behind stray triangles even though
      // the upper wall was recessed correctly.
      rings[0].push(pointAt(0.805 + recess * 0.16, 2.2 + lowVariation * 0.18, -0.5));
      rings[1].push({
        ...pointAt(0.85 + recess * 0.16, 0, 0.65),
        y: THREE.MathUtils.lerp(13.5 + lowVariation, recessRoofY * 0.4, recess),
      });
      rings[2].push({
        ...pointAt(0.89 + recess * 0.14, 0, -0.8),
        y: THREE.MathUtils.lerp(27 + lowVariation * 1.4 - passCut * 6, recessRoofY * 0.74, recess),
      });
      rings[3].push({
        ...pointAt(0.935 + recess * 0.11, 0, 0.35),
        y: THREE.MathUtils.lerp(56 + lowVariation * 2.2 - passCut * 15, recessRoofY + 14, recess),
      });
      rings[4].push({
        x: crest.x * (1 + recess * 0.055),
        z: crest.z * (1 + recess * 0.055),
        y: Math.max(crest.y, recessRoofY + 38 * recess),
      });
      rings[5].push(pointAt(1.075, crest.y - 17 - Math.cos(angle * 4) * 4.5, -0.45));
      rings[6].push(pointAt(1.18 + Math.sin(angle * 3) * 0.015, crest.y * 0.63 + 4, 0.9));
      rings[7].push(pointAt(1.3, -4 + Math.sin(angle * 3.4) * 0.7));
    }
    const positions: number[] = [];
    const indices: number[] = [];
    for (let ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
      const ring = rings[ringIndex];
      for (let index = 0; index < segments; index += 1) {
        const point = ring[index];
        positions.push(point.x, point.y, point.z);
      }
    }
    for (let ringIndex = 0; ringIndex < rings.length - 1; ringIndex += 1) {
      for (let index = 0; index < segments; index += 1) {
        const next = (index + 1) % segments;
        const inner = ringIndex * segments + index;
        const innerNext = ringIndex * segments + next;
        const outer = (ringIndex + 1) * segments + index;
        const outerNext = (ringIndex + 1) * segments + next;
        if ((index + ringIndex) % 2 === 0) {
          indices.push(inner, outer, outerNext, inner, outerNext, innerNext);
        } else {
          indices.push(inner, outer, innerNext, innerNext, outer, outerNext);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    const faceted = geometry.toNonIndexed();
    geometry.dispose();
    faceted.computeVertexNormals();
    const colors: number[] = [];
    const uvs: number[] = [];
    const vertices = faceted.getAttribute('position');
    const normals = faceted.getAttribute('normal');
    const cliffDark = new THREE.Color(0x3a302c);
    const cliffMid = new THREE.Color(0x5b493d);
    const cliffLight = new THREE.Color(0x876b4d);
    const faceCount = vertices.count / 3;
    for (let face = 0; face < faceCount; face += 1) {
      const height = (
        vertices.getY(face * 3)
        + vertices.getY(face * 3 + 1)
        + vertices.getY(face * 3 + 2)
      ) / 3;
      const centroidX = (
        vertices.getX(face * 3)
        + vertices.getX(face * 3 + 1)
        + vertices.getX(face * 3 + 2)
      ) / 3;
      const centroidZ = (
        vertices.getZ(face * 3)
        + vertices.getZ(face * 3 + 1)
        + vertices.getZ(face * 3 + 2)
      ) / 3;
      const angle = Math.atan2(centroidZ, centroidX);
      const upward = Math.max(0, (
        normals.getY(face * 3) + normals.getY(face * 3 + 1) + normals.getY(face * 3 + 2)
      ) / 3);
      const strata = Math.sin(height * 0.17 + angle * 3.2) * 0.075;
      const broadLight = Math.sin(angle - 0.65) * 0.08;
      const baseMix = THREE.MathUtils.clamp(0.18 + height / 150 + upward * 0.18 + strata + broadLight, 0, 0.86);
      const color = baseMix < 0.5
        ? cliffDark.clone().lerp(cliffMid, baseMix * 2)
        : cliffMid.clone().lerp(cliffLight, (baseMix - 0.5) * 2);
      const faceAngles = [0, 1, 2].map((vertex) => {
        const vertexIndex = face * 3 + vertex;
        return (Math.atan2(vertices.getZ(vertexIndex), vertices.getX(vertexIndex)) + Math.PI) / (Math.PI * 2);
      });
      if (Math.max(...faceAngles) - Math.min(...faceAngles) > 0.5) {
        for (let vertex = 0; vertex < faceAngles.length; vertex += 1) {
          if (faceAngles[vertex] < 0.5) faceAngles[vertex] += 1;
        }
      }
      for (let vertex = 0; vertex < 3; vertex += 1) {
        const vertexIndex = face * 3 + vertex;
        colors.push(color.r, color.g, color.b);
        uvs.push(faceAngles[vertex] * 6, vertices.getY(vertexIndex) / 34);
      }
    }
    faceted.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    faceted.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    faceted.computeBoundingBox();
    faceted.computeBoundingSphere();
    return faceted;
  }

  private createRockShelfGeometry(): THREE.BufferGeometry {
    const positions = [
      -0.5, 0.5, -0.5, 0.5, 0.5, -0.46, 0.42, 0.5, 0.5, -0.36, 0.5, 0.44,
      -0.34, -0.5, -0.28, 0.36, -0.5, -0.25, 0.22, -0.5, 0.27, -0.2, -0.5, 0.24,
    ];
    const indices = [
      0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
      0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2,
      2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
    ];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private createRockSpurGeometry(): THREE.BufferGeometry {
    const positions = [
      -0.5, -0.5, -0.5, 0.5, -0.5, -0.42, 0.44, -0.5, 0.5, -0.46, -0.5, 0.38,
      -0.38, 0.12, -0.34, 0.34, 0.12, -0.28, 0.28, 0.12, 0.32, -0.3, 0.12, 0.28,
      -0.2, 0.5, -0.14, 0.16, 0.5, -0.1, 0.12, 0.5, 0.16, -0.14, 0.5, 0.13,
    ];
    const indices = [
      0, 1, 2, 0, 2, 3,
      0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
      4, 8, 9, 4, 9, 5, 5, 9, 10, 5, 10, 6, 6, 10, 11, 6, 11, 7, 7, 11, 8, 7, 8, 4,
      8, 10, 9, 8, 11, 10,
    ];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private createArchitecturalLoftGeometry(
    footprint: ReadonlyArray<readonly [number, number]>,
    rings: ReadonlyArray<{
      y: number;
      scaleX: number;
      scaleZ: number;
      shiftX?: number;
      shiftZ?: number;
      rotation?: number;
    }>,
    uvRepeats = 3,
  ): THREE.BufferGeometry {
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const sideVerticesPerRing = footprint.length + 1;
    const cumulative = [0];
    for (let index = 0; index < footprint.length; index += 1) {
      const current = footprint[index];
      const next = footprint[(index + 1) % footprint.length];
      cumulative.push(cumulative[index] + Math.hypot(next[0] - current[0], next[1] - current[1]));
    }
    const perimeter = cumulative.at(-1) || 1;
    const transformPoint = (
      point: readonly [number, number],
      ring: (typeof rings)[number],
    ): [number, number] => {
      const scaledX = point[0] * ring.scaleX;
      const scaledZ = point[1] * ring.scaleZ;
      const rotation = ring.rotation ?? 0;
      const cosine = Math.cos(rotation);
      const sine = Math.sin(rotation);
      return [
        scaledX * cosine + scaledZ * sine + (ring.shiftX ?? 0),
        -scaledX * sine + scaledZ * cosine + (ring.shiftZ ?? 0),
      ];
    };

    for (let ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
      const ring = rings[ringIndex];
      for (let index = 0; index <= footprint.length; index += 1) {
        const sourceIndex = index % footprint.length;
        const [x, z] = transformPoint(footprint[sourceIndex], ring);
        positions.push(x, ring.y, z);
        uvs.push(cumulative[index] / perimeter * uvRepeats, ringIndex / (rings.length - 1) * uvRepeats);
      }
    }
    for (let ringIndex = 0; ringIndex < rings.length - 1; ringIndex += 1) {
      const current = ringIndex * sideVerticesPerRing;
      const next = (ringIndex + 1) * sideVerticesPerRing;
      for (let index = 0; index < footprint.length; index += 1) {
        indices.push(
          current + index, next + index, next + index + 1,
          current + index, next + index + 1, current + index + 1,
        );
      }
    }

    const appendCap = (ringIndex: number, top: boolean): void => {
      const ring = rings[ringIndex];
      const capPoints = footprint.map((point) => {
        const [x, z] = transformPoint(point, ring);
        return new THREE.Vector2(x, z);
      });
      const minX = Math.min(...capPoints.map(({ x }) => x));
      const maxX = Math.max(...capPoints.map(({ x }) => x));
      const minZ = Math.min(...capPoints.map(({ y }) => y));
      const maxZ = Math.max(...capPoints.map(({ y }) => y));
      const capStart = positions.length / 3;
      for (const point of capPoints) {
        positions.push(point.x, ring.y, point.y);
        uvs.push(
          (point.x - minX) / Math.max(EPSILON, maxX - minX) * uvRepeats,
          (point.y - minZ) / Math.max(EPSILON, maxZ - minZ) * uvRepeats,
        );
      }
      const triangles = THREE.ShapeUtils.triangulateShape(capPoints, []);
      for (const [a, b, c] of triangles) {
        if (top) indices.push(capStart + a, capStart + c, capStart + b);
        else indices.push(capStart + a, capStart + b, capStart + c);
      }
    };
    appendCap(0, false);
    appendCap(rings.length - 1, true);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private createPortalFrameGeometry(): THREE.ExtrudeGeometry {
    const shape = new THREE.Shape();
    shape.moveTo(-0.5, -0.5);
    shape.lineTo(0.5, -0.5);
    shape.lineTo(0.5, 0.12);
    shape.lineTo(0.22, 0.48);
    shape.lineTo(-0.22, 0.48);
    shape.lineTo(-0.5, 0.12);
    shape.closePath();
    const opening = new THREE.Path();
    opening.moveTo(-0.25, -0.34);
    opening.lineTo(-0.25, 0.09);
    opening.lineTo(-0.13, 0.3);
    opening.lineTo(0.13, 0.3);
    opening.lineTo(0.25, 0.09);
    opening.lineTo(0.25, -0.34);
    opening.closePath();
    shape.holes.push(opening);
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: 1,
      bevelEnabled: false,
      curveSegments: 1,
      steps: 1,
    });
    geometry.translate(0, 0, -0.5);
    geometry.computeVertexNormals();
    return geometry;
  }

  private createPortalOpeningGeometry(): THREE.ShapeGeometry {
    const shape = new THREE.Shape();
    shape.moveTo(-0.5, -0.5);
    shape.lineTo(0.5, -0.5);
    shape.lineTo(0.5, 0.08);
    shape.lineTo(0.27, 0.42);
    shape.lineTo(-0.27, 0.42);
    shape.lineTo(-0.5, 0.08);
    shape.closePath();
    const geometry = new THREE.ShapeGeometry(shape, 1);
    geometry.computeVertexNormals();
    return geometry;
  }

  private createChamferedBlockGeometry(chamfer = 0.16): THREE.ExtrudeGeometry {
    const shape = new THREE.Shape();
    shape.moveTo(-0.5 + chamfer, -0.5);
    shape.lineTo(0.5 - chamfer, -0.5);
    shape.lineTo(0.5, -0.5 + chamfer);
    shape.lineTo(0.5, 0.5 - chamfer);
    shape.lineTo(0.5 - chamfer, 0.5);
    shape.lineTo(-0.5 + chamfer, 0.5);
    shape.lineTo(-0.5, 0.5 - chamfer);
    shape.lineTo(-0.5, -0.5 + chamfer);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: 1,
      bevelEnabled: false,
      curveSegments: 1,
      steps: 1,
    });
    geometry.translate(0, 0, -0.5);
    geometry.computeVertexNormals();
    return geometry;
  }

  private createCliffButtressGeometry(): THREE.ExtrudeGeometry {
    const shape = new THREE.Shape();
    shape.moveTo(-0.5, -0.5);
    shape.lineTo(0.5, -0.5);
    shape.lineTo(0.38, 0.18);
    shape.lineTo(0.2, 0.5);
    shape.lineTo(-0.2, 0.5);
    shape.lineTo(-0.38, 0.18);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: 1,
      bevelEnabled: false,
      curveSegments: 1,
      steps: 1,
    });
    geometry.translate(0, 0, -0.5);
    geometry.computeVertexNormals();
    return geometry;
  }

  private createAsymmetricFinGeometry(): THREE.ExtrudeGeometry {
    const shape = new THREE.Shape();
    shape.moveTo(-0.5, -0.5);
    shape.lineTo(0.5, -0.5);
    shape.lineTo(0.27, 0.5);
    shape.lineTo(-0.18, 0.36);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: 1,
      bevelEnabled: false,
      curveSegments: 1,
      steps: 1,
    });
    geometry.translate(0, 0, -0.5);
    geometry.computeVertexNormals();
    return geometry;
  }

  private createFloatingHullGeometry(profile: FloatingBuildingProfile): THREE.BufferGeometry {
    const footprint: Record<FloatingBuildingProfile, ReadonlyArray<readonly [number, number]>> = {
      // The cyan dock carries a concave landing notch in its forward edge.
      skydock: [[-0.5, -0.34], [-0.22, -0.5], [-0.1, -0.22], [0.14, -0.22], [0.22, -0.5], [0.5, -0.3], [0.46, 0.32], [0.14, 0.5], [-0.42, 0.4]],
      // The needle remains narrow in plan and twists toward its mast.
      needle: [[-0.34, -0.5], [0.26, -0.46], [0.5, -0.08], [0.24, 0.5], [-0.28, 0.42], [-0.5, -0.06]],
      // The command ark is a broad asymmetric wedge rather than a scaled dock.
      command: [[-0.5, -0.34], [-0.2, -0.5], [0.42, -0.44], [0.5, -0.06], [0.34, 0.44], [0.02, 0.5], [-0.46, 0.3]],
    };
    const twist = profile === 'needle' ? 0.1 : profile === 'command' ? -0.045 : 0.035;
    return this.createArchitecturalLoftGeometry(footprint[profile], [
      { y: -0.5, scaleX: profile === 'needle' ? 0.62 : 0.74, scaleZ: 0.7, shiftX: -twist },
      { y: -0.22, scaleX: 0.92, scaleZ: 0.88, shiftX: -twist * 0.3, rotation: -twist * 0.25 },
      { y: 0.22, scaleX: 1, scaleZ: 1, shiftX: twist * 0.3, rotation: twist * 0.5 },
      { y: 0.5, scaleX: profile === 'command' ? 1.08 : 0.94, scaleZ: profile === 'skydock' ? 1.08 : 0.94, shiftX: twist, rotation: twist },
    ], 3);
  }

  private createFloatingKeelGeometry(profile: FloatingBuildingProfile): THREE.BufferGeometry {
    const footprints: Record<FloatingBuildingProfile, ReadonlyArray<readonly [number, number]>> = {
      skydock: [[-0.5, -0.38], [0.5, -0.38], [0.4, 0.4], [-0.34, 0.5]],
      needle: [[-0.3, -0.5], [0.34, -0.4], [0.48, 0.26], [0, 0.5], [-0.44, 0.2]],
      command: [[-0.5, -0.32], [0.44, -0.44], [0.5, 0.22], [0.16, 0.5], [-0.4, 0.38]],
    };
    return this.createArchitecturalLoftGeometry(footprints[profile], [
      { y: 0.5, scaleX: 1, scaleZ: 1 },
      { y: 0.08, scaleX: profile === 'command' ? 0.72 : 0.58, scaleZ: 0.62, shiftX: profile === 'needle' ? 0.08 : 0 },
      { y: -0.32, scaleX: profile === 'needle' ? 0.18 : 0.3, scaleZ: 0.28, shiftX: profile === 'needle' ? 0.16 : -0.04 },
      { y: -0.5, scaleX: 0.06, scaleZ: 0.08, shiftX: profile === 'needle' ? 0.22 : 0 },
    ], 2.4);
  }

  private createGround(
    groundMaterial: THREE.MeshStandardMaterial,
    groundFoundationMaterial: THREE.MeshStandardMaterial,
    rockMaterial: THREE.MeshStandardMaterial,
    rockHighlightMaterial: THREE.MeshStandardMaterial,
    mossCapMaterial: THREE.MeshStandardMaterial,
  ): void {
    this.addMesh(
      this.createTerrainGeometry(),
      groundMaterial,
      'QuickSense faceted playable terrain',
    );
    this.addMesh(
      new THREE.BoxGeometry(QUICK_LOCAL_WIDTH, 2.4, QUICK_LOCAL_DEPTH),
      groundFoundationMaterial,
      'QuickSense terrain foundation',
      new THREE.Vector3(0, -1.4, 0),
    );
    this.colliders.push({
      box: new THREE.Box3(
        new THREE.Vector3(-QUICK_LOCAL_WIDTH * 0.5, -4, -QUICK_LOCAL_DEPTH * 0.5),
        new THREE.Vector3(QUICK_LOCAL_WIDTH * 0.5, -0.2, QUICK_LOCAL_DEPTH * 0.5),
      ),
      name: 'terrain foundation',
      blocksMovement: true,
    });
    const mountainWall = this.addMesh(
      this.createMountainWallGeometry(),
      rockMaterial,
      'QuickSense continuous mountain wall',
    );
    mountainWall.castShadow = true;
    mountainWall.receiveShadow = true;

    const erosionSpurs: InstanceTransform[] = [];
    const ledges: InstanceTransform[] = [];
    const mossShelves: InstanceTransform[] = [];
    const spurSpecs = [
      [-3.02, 18, 7.6, 7.8], [-2.74, 27, 9.4, 9.5], [-2.26, 15, 6.4, 8.2],
      [-1.88, 23, 8.8, 10.6], [-1.23, 17, 7.2, 8.4], [-0.83, 29, 10.2, 11.2],
      [-0.28, 20, 7.8, 9.2], [0.12, 14, 6.2, 7.4], [0.56, 26, 9.6, 10.8],
      [1.04, 18, 7.1, 8.3], [1.42, 30, 10.6, 11.4], [1.98, 16, 6.8, 8.1],
      [2.38, 24, 9.1, 9.8], [2.82, 19, 7.4, 8.8],
    ] as const;
    const habitatCutAngles = CLIFF_HABITAT_SPECS.map((spec) => Math.atan2(spec.z, spec.x));
    const insideHabitatCut = (angle: number, clearance = 0.25): boolean => habitatCutAngles.some((cutAngle) => (
      Math.abs(Math.atan2(Math.sin(angle - cutAngle), Math.cos(angle - cutAngle))) < clearance
    ));
    for (let index = 0; index < spurSpecs.length; index += 1) {
      const [angle, height, width, depth] = spurSpecs[index];
      if (insideHabitatCut(angle, 0.2)) continue;
      const radiusX = 90.5 + Math.sin(angle * 5) * 1.8;
      const radiusZ = 81.2 + Math.cos(angle * 4) * 1.4;
      erosionSpurs.push({
        position: new THREE.Vector3(
          Math.cos(angle) * radiusX,
          height * 0.5 + 0.6,
          Math.sin(angle) * radiusZ,
        ),
        scale: new THREE.Vector3(width, height, depth),
        yaw: Math.PI * 0.5 - angle,
      });
    }
    const shelfSpecs = [
      [-2.92, 18.5, 12.5, 5.8], [-2.16, 25.5, 18.2, 7.4], [-1.73, 16.8, 10.5, 5.2],
      [-0.9, 27.8, 17.4, 7.8], [-0.2, 20.5, 11.2, 5.5], [0.47, 24.2, 15.8, 6.8],
      [1.22, 29.5, 19.4, 7.9], [1.82, 17.8, 10.8, 5.1], [2.33, 25.8, 16.6, 7.1],
      [2.9, 21.2, 12.8, 5.9],
    ] as const;
    for (let index = 0; index < shelfSpecs.length; index += 1) {
      const [angle, y, width, depth] = shelfSpecs[index];
      if (insideHabitatCut(angle)) continue;
      const yaw = Math.PI * 0.5 - angle;
      const center = new THREE.Vector3(Math.cos(angle) * 94.2, y, Math.sin(angle) * 84.5);
      ledges.push({
        position: center,
        scale: new THREE.Vector3(width, 2.4 + (index % 3) * 0.35, depth),
        yaw,
      });
      if (index % 2 === 0) {
        mossShelves.push({
          position: new THREE.Vector3(
            Math.cos(angle) * 94.7,
            y + 1.42,
            Math.sin(angle) * 85,
          ),
          scale: new THREE.Vector3(width * 0.74, 0.42, depth * 0.72),
          yaw,
        });
      }
    }
    this.addInstancedMeshes(
      'QuickSense irregular erosion spurs',
      this.createRockSpurGeometry(),
      rockHighlightMaterial,
      erosionSpurs,
    );
    this.addInstancedMeshes(
      'QuickSense broken mountain shelf strata',
      this.createRockShelfGeometry(),
      rockHighlightMaterial,
      ledges,
    );
    this.addInstancedMeshes(
      'QuickSense moss on inhabited cliff shelves',
      this.createRockShelfGeometry(),
      mossCapMaterial,
      mossShelves,
      false,
    );
  }

  private createTerrainGeometry(): THREE.BufferGeometry {
    const segmentsX = 81;
    const segmentsZ = 73;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    for (let zIndex = 0; zIndex <= segmentsZ; zIndex += 1) {
      const v = zIndex / segmentsZ;
      const baseZ = THREE.MathUtils.lerp(-QUICK_LOCAL_DEPTH * 0.5, QUICK_LOCAL_DEPTH * 0.5, v);
      for (let xIndex = 0; xIndex <= segmentsX; xIndex += 1) {
        const u = xIndex / segmentsX;
        const baseX = THREE.MathUtils.lerp(-QUICK_LOCAL_WIDTH * 0.5, QUICK_LOCAL_WIDTH * 0.5, u);
        const boundary = xIndex === 0 || xIndex === segmentsX || zIndex === 0 || zIndex === segmentsZ;
        const jitterX = boundary
          ? 0
          : Math.sin(xIndex * 12.9898 + zIndex * 78.233) * 0.16
            + Math.sin(xIndex * 2.73 - zIndex * 1.91) * 0.06;
        const jitterZ = boundary
          ? 0
          : Math.sin(xIndex * 39.346 - zIndex * 11.135) * 0.15
            + Math.cos(xIndex * 1.37 + zIndex * 2.41) * 0.06;
        const x = baseX + jitterX;
        const z = baseZ + jitterZ;
        positions.push(x, this.terrainHeightAt(x, z), z);
        uvs.push(u * 6, v * 6);
      }
    }
    const row = segmentsX + 1;
    for (let zIndex = 0; zIndex < segmentsZ; zIndex += 1) {
      for (let xIndex = 0; xIndex < segmentsX; xIndex += 1) {
        const a = zIndex * row + xIndex;
        const b = a + 1;
        const c = a + row;
        const d = c + 1;
        if ((xIndex * 17 + zIndex * 31) % 2 === 0) {
          indices.push(a, c, d, a, d, b);
        } else {
          indices.push(a, c, b, b, c, d);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    const faceted = geometry.toNonIndexed();
    geometry.dispose();
    faceted.computeVertexNormals();
    const lowShadow = new THREE.Color(0x4e3c2c);
    const lowSun = new THREE.Color(0x896e49);
    const highRock = new THREE.Color(0x75563e);
    const scree = new THREE.Color(0x5f4938);
    const colors: number[] = [];
    const facetedPositions = faceted.getAttribute('position');
    const facetedNormals = faceted.getAttribute('normal');
    const faceCount = faceted.getAttribute('position').count / 3;
    for (let face = 0; face < faceCount; face += 1) {
      const vertex = face * 3;
      const height = (
        facetedPositions.getY(vertex)
        + facetedPositions.getY(vertex + 1)
        + facetedPositions.getY(vertex + 2)
      ) / 3;
      const slope = 1 - Math.abs(facetedNormals.getY(vertex));
      const centerX = (
        facetedPositions.getX(vertex)
        + facetedPositions.getX(vertex + 1)
        + facetedPositions.getX(vertex + 2)
      ) / 3;
      const centerZ = (
        facetedPositions.getZ(vertex)
        + facetedPositions.getZ(vertex + 1)
        + facetedPositions.getZ(vertex + 2)
      ) / 3;
      const macroVariation = clamp01(
        0.5
          + Math.sin(centerX * 0.071 + centerZ * 0.037) * 0.24
          + Math.cos(centerZ * 0.083 - centerX * 0.024) * 0.18,
      );
      const color = lowShadow.clone().lerp(lowSun, macroVariation);
      const rockBlend = clamp01((height - 10) / 19) * 0.58 + clamp01(slope * 1.95) * 0.34;
      color.lerp(highRock, clamp01(rockBlend));
      color.lerp(scree, clamp01((slope - 0.18) * 2.4) * (0.45 + (face % 5) * 0.05));
      color.multiplyScalar(0.94 + ((face * 11) % 5) * 0.018);
      for (let vertex = 0; vertex < 3; vertex += 1) colors.push(color.r, color.g, color.b);
    }
    faceted.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    faceted.computeBoundingBox();
    faceted.computeBoundingSphere();
    return faceted;
  }

  private terrainHeightAt(x: number, z: number): number {
    const hills = [
      { x: -69, z: -49, height: 21.5, radiusX: 32, radiusZ: 29 },
      { x: 69, z: -47, height: 19.6, radiusX: 31, radiusZ: 28 },
      { x: -67, z: 49, height: 20.4, radiusX: 32, radiusZ: 29 },
      { x: 68, z: 50, height: 22.2, radiusX: 33, radiusZ: 30 },
      { x: -47, z: 5, height: 14.6, radiusX: 27, radiusZ: 32 },
      { x: 48, z: -4, height: 13.8, radiusX: 27, radiusZ: 31 },
      { x: 0, z: 59, height: 15.8, radiusX: 40, radiusZ: 24 },
      { x: 0, z: -57, height: 12.4, radiusX: 44, radiusZ: 22 },
      { x: -16, z: 12, height: 6.2, radiusX: 18, radiusZ: 21 },
      { x: 17, z: -13, height: 5.8, radiusX: 18, radiusZ: 21 },
    ];
    const bowlRadius = Math.min(1, Math.hypot(x / 82, z / 70));
    let height = 0.34 + bowlRadius * bowlRadius * 7.2;
    for (const hill of hills) {
      const blend = ellipseInfluence(x, z, hill.x, hill.z, hill.radiusX, hill.radiusZ);
      height += hill.height * blend * blend;
    }

    // Two broad, terrain-native pump lines. Their wide smooth rollers create
    // downhill-to-uphill transitions without a mesh seam or collision step.
    for (const laneX of [-29, 29]) {
      const laneBlend = Math.exp(-(((x - laneX) / 17) ** 2)) * smoothPulse(1 - Math.min(1, Math.abs(z) / 78));
      const rollers = 3.5 + Math.sin((z + (laneX < 0 ? 9 : -9)) * 0.112) * 3.35;
      height += laneBlend * rollers;
    }

    // Four broad gravity bowls turn the central floor into a pumpable ski
    // surface. The depression and soft outer berm share a C2 envelope, so a
    // player can compress into the trough and unload onto the next rise with
    // no normal discontinuity or hidden collision lip.
    const momentumBowls = [
      { x: -31, z: -38, radiusX: 24, radiusZ: 20, depth: 8.2 },
      { x: -35, z: 34, radiusX: 25, radiusZ: 21, depth: 7.6 },
      { x: 31, z: -34, radiusX: 25, radiusZ: 21, depth: 7.7 },
      { x: 35, z: 39, radiusX: 24, radiusZ: 20, depth: 8.4 },
    ];
    for (const bowl of momentumBowls) {
      const nx = (x - bowl.x) / bowl.radiusX;
      const nz = (z - bowl.z) / bowl.radiusZ;
      const distance = Math.hypot(nx, nz);
      if (distance < 1.34) {
        const depression = distance < 1 ? smootherPulse(1 - distance) : 0;
        const berm = Math.exp(-(((distance - 1.05) / 0.18) ** 2));
        height -= depression * bowl.depth;
        height += berm * 2.25;
      }
    }

    // A continuous mountain apron lifts the perimeter before the near-vertical
    // cliff wall, giving the arena a deep carved-basin section from eye level.
    const edgeRadius = Math.hypot(x / 89, z / 79);
    const edgeBlend = smoothPulse(THREE.MathUtils.smoothstep(edgeRadius, 0.68, 1.03));
    height += edgeBlend * (20.5 + Math.sin(Math.atan2(z, x) * 5 - 0.6) * 3.8);

    // Each faction line contains three compact C2 bowls. A skier can drop,
    // compress through the low point, and carry that gravity gain up the next
    // face without crossing a hard ownership seam between terrain formulas.
    height -= linearSwaleDepth(x, z, -22, -60, -40, 60);
    height -= linearSwaleDepth(x, z, 22, -60, 40, 60);
    height += (Math.sin(x * 0.073 + z * 0.037) + Math.cos(z * 0.064 - x * 0.021)) * 0.3;

    for (const approach of CLIFF_HABITAT_APPROACHES) {
      const blend = ellipseInfluence(
        x,
        z,
        approach.x,
        approach.z,
        approach.radiusX,
        approach.radiusZ,
      );
      height = THREE.MathUtils.lerp(height, approach.threshold, blend * 0.88);
    }

    // Grade a compact, rounded-rect forecourt beneath each facility entrance.
    // The core follows the actual terrace run and eases into untouched rock at
    // its shoulders. This prevents faceted terrain peaks from punching through
    // the stair decks without flattening the wider mountain silhouette.
    for (const spec of CLIFF_HABITAT_SPECS) {
      const dx = x - spec.x;
      const dz = z - spec.z;
      const cosine = Math.cos(spec.yaw);
      const sine = Math.sin(spec.yaw);
      const localX = dx * cosine - dz * sine;
      const localZ = dx * sine + dz * cosine;
      const portalX = habitatPortalOffset(spec.signature) * spec.width;
      const lateralDistance = Math.abs(localX - portalX) / (spec.width * 0.19);
      const longitudinalDistance = Math.abs(localZ + spec.depth * 0.64) / (spec.depth * 0.48);
      const edgeDistance = Math.max(lateralDistance, longitudinalDistance);
      if (edgeDistance >= 1.42) continue;
      const blend = edgeDistance <= 1
        ? 1
        : smootherPulse((1.42 - edgeDistance) / 0.42);
      const approachProgress = clamp01((localZ + spec.depth * 1.08) / (spec.depth * 0.78));
      const bottomY = spec.roofY - spec.height;
      const threshold = THREE.MathUtils.lerp(bottomY - 1.25, bottomY + 0.35, approachProgress);
      height = THREE.MathUtils.lerp(height, threshold, blend * 0.98);
    }

    // Gatehouses are cut into deliberate launch shelves rather than left as
    // freestanding boxes inside the basin berm.  The overlap is limited to
    // each building footprint and its short front apron, preserving the
    // surrounding mountain silhouette while exposing a flush lower facade.
    for (const gatehouse of ENTRY_GATEHOUSE_APPROACHES) {
      const dx = x - gatehouse.x;
      const dz = z - gatehouse.z;
      const cosine = Math.cos(gatehouse.yaw);
      const sine = Math.sin(gatehouse.yaw);
      const localX = dx * cosine - dz * sine;
      const localZ = dx * sine + dz * cosine;
      const nx = localX / (gatehouse.width * 0.78);
      const nz = (localZ + gatehouse.depth * 0.1) / (gatehouse.depth * 0.82);
      const distance = Math.hypot(nx, nz);
      if (distance >= 1) continue;
      height = THREE.MathUtils.lerp(height, gatehouse.threshold, smootherPulse(1 - distance));
    }

    let shapedHeight = height;
    for (const path of this.pathSurfaces) {
      const nearest = closestSegment(path.points, path.closed, x, z);
      if (!nearest) continue;
      const edgeDistance = Math.sqrt(nearest.distanceSquared) - path.width * 0.5;
      const influence = 1 - THREE.MathUtils.smoothstep(edgeDistance, 0.45, 6.5);
      if (influence <= 0) continue;
      const a = path.points[nearest.index];
      const b = path.points[(nearest.index + 1) % path.points.length];
      const routeBank = THREE.MathUtils.lerp(
        path.banks[nearest.index],
        path.banks[(nearest.index + 1) % path.banks.length],
        nearest.t,
      );
      const routeHeight = THREE.MathUtils.lerp(a.y, b.y, nearest.t) + nearest.lateral * routeBank;
      // Elevated routes must remain visually and physically detached from the
      // terrain below them. A shallow 0.58 m cut only prevented z-fighting and
      // left the west/east underpasses too low for a player-height opening.
      // Preserve that shallow seat for near-ground lanes, but carve a true
      // bridge undercroft beneath every route whose riding surface is high
      // enough to support one. At the arena's 1.6 vertical scale, 4.65 local
      // metres yields 7.44 world metres of deck-top separation.
      const clearanceDepth = path.name === 'Flux Core orbital transfer'
        ? 12.5
        : routeHeight >= 6
          ? 4.65
          : 0.58;
      const clearanceHeight = routeHeight - clearanceDepth;
      if (shapedHeight > clearanceHeight) {
        shapedHeight = THREE.MathUtils.lerp(shapedHeight, clearanceHeight, influence);
      }
    }
    for (const ramp of this.rampSurfaces) {
      const rampHeight = ramp.flow.heightAt(x, z);
      if (rampHeight !== null) {
        shapedHeight = Math.min(shapedHeight, rampHeight - 0.34);
      }
    }
    return Math.max(0.08, shapedHeight);
  }

  private terrainNormalAt(x: number, z: number, target: THREE.Vector3): THREE.Vector3 {
    const epsilon = 0.32;
    const left = this.terrainHeightAt(x - epsilon, z);
    const right = this.terrainHeightAt(x + epsilon, z);
    const back = this.terrainHeightAt(x, z - epsilon);
    const front = this.terrainHeightAt(x, z + epsilon);
    return target.set(left - right, epsilon * 2, back - front).normalize();
  }

  private createPath(
    name: string,
    points: PathPoint[],
    width: number,
    bank: number,
    deckMaterial: THREE.MeshStandardMaterial,
    sideMaterial: THREE.MeshStandardMaterial,
    edgeMaterial: THREE.MeshStandardMaterial,
    _safetyMaterial: THREE.MeshStandardMaterial,
    closed: boolean,
  ): PathSurface {
    const bankEaseSamples = Math.max(2, Math.floor(points.length * 0.14));
    const banks = points.map((_, index) => {
      if (closed) return bank;
      const fromStart = index / bankEaseSamples;
      const fromEnd = (points.length - 1 - index) / bankEaseSamples;
      return bank * smootherPulse(Math.min(1, fromStart, fromEnd));
    });
    const path: PathSurface = {
      name,
      points,
      vertexNormals: buildPathVertexNormals(points, closed, banks),
      width,
      bank,
      banks,
      closed,
      contains: (x, z) => {
        if (!closed && !isWithinOpenPathCaps(points, x, z)) return false;
        const nearest = closestSegment(points, closed, x, z);
        return Boolean(nearest && nearest.distanceSquared <= (width * 0.5 + 0.08) ** 2);
      },
      heightAt: (x, z) => pathHeightAt(path, x, z),
      normalAt: (x, z, target = new THREE.Vector3()) => pathNormalAt(path, x, z, target),
    };
    this.pathSurfaces.push(path);

    const primaryRoute = name.includes('outer basin');
    const secondaryRoute = name.includes('inner momentum');
    const positions: number[] = [];
    const uvs: number[] = [];
    const topIndices: number[] = [];
    const sideIndices: number[] = [];
    const segmentCount = closed ? points.length : points.length - 1;
    // The route body is a finished bridge deck rather than a paper-thin
    // ribbon. Its lower perimeter is inset to create a broad structural
    // chamfer while the analytic riding surface stays exactly unchanged.
    const bottomDepth = pathDeckBottomDepth(name);
    const bottomInset = Math.min(primaryRoute ? 0.58 : 0.5, width * 0.06);
    const pathDistances = [0];
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      pathDistances.push(pathDistances[index - 1] + Math.hypot(
        current.x - previous.x,
        current.z - previous.z,
      ));
    }
    const addVertex = (point: THREE.Vector3, u: number, v: number): number => {
      positions.push(point.x, point.y, point.z);
      uvs.push(u, v);
      return positions.length / 3 - 1;
    };
    for (let index = 0; index < points.length; index += 1) {
      const previous = points[closed ? (index - 1 + points.length) % points.length : Math.max(0, index - 1)];
      const current = points[index];
      const next = points[closed ? (index + 1) % points.length : Math.min(points.length - 1, index + 1)];
      const tangentX = next.x - previous.x;
      const tangentZ = next.z - previous.z;
      const tangentLength = Math.hypot(tangentX, tangentZ) || 1;
      const crossX = tangentZ / tangentLength;
      const crossZ = -tangentX / tangentLength;
      const pointBank = banks[index];
      const left = new THREE.Vector3(
        current.x - crossX * width * 0.5,
        current.y - pointBank * width * 0.5,
        current.z - crossZ * width * 0.5,
      );
      const right = new THREE.Vector3(
        current.x + crossX * width * 0.5,
        current.y + pointBank * width * 0.5,
        current.z + crossZ * width * 0.5,
      );
      const textureU = pathDistances[index] / Math.max(width, 1);
      addVertex(left, textureU, 0);
      addVertex(right, textureU, 1);
      const leftBottom = left.clone().addScaledVector(new THREE.Vector3(crossX, 0, crossZ), bottomInset);
      leftBottom.y -= bottomDepth;
      const rightBottom = right.clone().addScaledVector(new THREE.Vector3(crossX, 0, crossZ), -bottomInset);
      rightBottom.y -= bottomDepth;
      addVertex(leftBottom, textureU, 0);
      addVertex(rightBottom, textureU, 1);
    }
    for (let index = 0; index < segmentCount; index += 1) {
      const next = (index + 1) % points.length;
      const topLeft = index * 4;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + 2;
      const bottomRight = topLeft + 3;
      const nextTopLeft = next * 4;
      const nextTopRight = nextTopLeft + 1;
      const nextBottomLeft = nextTopLeft + 2;
      const nextBottomRight = nextTopLeft + 3;
      topIndices.push(topLeft, nextTopLeft, nextTopRight, topLeft, nextTopRight, topRight);
      sideIndices.push(topLeft, bottomLeft, nextBottomLeft, topLeft, nextBottomLeft, nextTopLeft);
      sideIndices.push(topRight, nextTopRight, nextBottomRight, topRight, nextBottomRight, bottomRight);
      sideIndices.push(bottomLeft, bottomRight, nextBottomRight, bottomLeft, nextBottomRight, nextBottomLeft);
    }
    if (!closed) {
      const firstTopLeft = 0;
      const firstTopRight = 1;
      const firstBottomLeft = 2;
      const firstBottomRight = 3;
      sideIndices.push(
        firstTopLeft, firstTopRight, firstBottomRight,
        firstTopLeft, firstBottomRight, firstBottomLeft,
      );
      const finalBase = (points.length - 1) * 4;
      const finalTopLeft = finalBase;
      const finalTopRight = finalBase + 1;
      const finalBottomLeft = finalBase + 2;
      const finalBottomRight = finalBase + 3;
      sideIndices.push(
        finalTopLeft, finalBottomRight, finalTopRight,
        finalTopLeft, finalBottomLeft, finalBottomRight,
      );
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex([...topIndices, ...sideIndices]);
    geometry.addGroup(0, topIndices.length, 0);
    geometry.addGroup(topIndices.length, sideIndices.length, 1);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    this.addMesh(geometry, [deckMaterial, sideMaterial], name);
    const safetyGeometry = this.createRibbonGeometry(
      points,
      closed,
      [-width * 0.5 + 0.28, width * 0.5 - 0.28],
      primaryRoute ? 0.12 : secondaryRoute ? 0.075 : 0.09,
      banks,
      0.17,
    );
    this.pathSafetyGeometries.push(safetyGeometry);
    const factionGeometry = this.createRibbonGeometry(
      points,
      closed,
      [0],
      primaryRoute ? 0.44 : secondaryRoute ? 0.3 : 0.22,
      banks,
      0.185,
    );
    const factionBatch = this.pathFactionGeometries.get(edgeMaterial) ?? [];
    factionBatch.push(factionGeometry);
    this.pathFactionGeometries.set(edgeMaterial, factionBatch);

    // Thin top-surface boxes give hitscan, grapple, and LOS queries the same
    // vertical profile as the analytic riding surface without filling the
    // intentionally open space beneath elevated bridge lanes.
    for (let index = 0; index < segmentCount; index += 1) {
      const a = points[index];
      const b = points[(index + 1) % points.length];
      const minX = Math.min(a.x, b.x) - width * 0.5;
      const maxX = Math.max(a.x, b.x) + width * 0.5;
      const minZ = Math.min(a.z, b.z) - width * 0.5;
      const maxZ = Math.max(a.z, b.z) + width * 0.5;
      const minY = Math.min(a.y, b.y) - 0.18 - Math.abs(bank) * width * 0.5;
      const maxY = Math.max(a.y, b.y) + 0.18 + Math.abs(bank) * width * 0.5;
      this.shotBoxes.push(new THREE.Box3(new THREE.Vector3(minX, minY, minZ), new THREE.Vector3(maxX, maxY, maxZ)));
    }
    return path;
  }

  private flushPathTrimMeshes(safetyMaterial: THREE.MeshStandardMaterial): void {
    const safetyGeometry = mergeGeometries(this.pathSafetyGeometries, false);
    if (!safetyGeometry) throw new Error('QuickSense could not merge path safety geometry.');
    const safety = this.addMesh(safetyGeometry, safetyMaterial, 'QuickSense merged route edge trim');
    safety.castShadow = false;
    safety.receiveShadow = false;
    for (const geometry of this.pathSafetyGeometries) geometry.dispose();
    this.pathSafetyGeometries.length = 0;

    for (const [material, geometries] of this.pathFactionGeometries) {
      const geometry = mergeGeometries(geometries, false);
      if (!geometry) throw new Error(`QuickSense could not merge ${material.name} route signals.`);
      const faction = this.addMesh(geometry, material, `${material.name} merged route centerlines`);
      faction.castShadow = false;
      faction.receiveShadow = false;
      for (const source of geometries) source.dispose();
    }
    this.pathFactionGeometries.clear();
  }

  private createRibbonGeometry(
    points: PathPoint[],
    closed: boolean,
    offsets: number[],
    ribbonWidth: number,
    bank: number | number[],
    lift: number,
  ): THREE.BufferGeometry {
    const positions: number[] = [];
    const indices: number[] = [];
    const pointCount = points.length;
    const segmentCount = closed ? pointCount : pointCount - 1;
    for (const offset of offsets) {
      const startVertex = positions.length / 3;
      for (let index = 0; index < pointCount; index += 1) {
        const previousIndex = closed ? (index - 1 + pointCount) % pointCount : Math.max(0, index - 1);
        const nextIndex = closed ? (index + 1) % pointCount : Math.min(pointCount - 1, index + 1);
        const previous = points[previousIndex];
        const current = points[index];
        const next = points[nextIndex];
        const tangentX = next.x - previous.x;
        const tangentZ = next.z - previous.z;
        const tangentLength = Math.hypot(tangentX, tangentZ) || 1;
        const crossX = tangentZ / tangentLength;
        const crossZ = -tangentX / tangentLength;
        const pointBank = typeof bank === 'number' ? bank : bank[index];
        const centerX = current.x + crossX * offset;
        const centerZ = current.z + crossZ * offset;
        const centerY = current.y + pointBank * offset + lift;
        positions.push(
          centerX - crossX * ribbonWidth * 0.5,
          centerY - pointBank * ribbonWidth * 0.5,
          centerZ - crossZ * ribbonWidth * 0.5,
          centerX + crossX * ribbonWidth * 0.5,
          centerY + pointBank * ribbonWidth * 0.5,
          centerZ + crossZ * ribbonWidth * 0.5,
        );
      }
      for (let index = 0; index < segmentCount; index += 1) {
        const next = (index + 1) % pointCount;
        const a = startVertex + index * 2;
        const b = a + 1;
        const c = startVertex + next * 2;
        const d = c + 1;
        indices.push(a, c, d, a, d, b);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private createRamps(
    deckMaterial: THREE.MeshStandardMaterial,
    sideMaterial: THREE.MeshStandardMaterial,
    cyanMaterial: THREE.MeshStandardMaterial,
    magentaMaterial: THREE.MeshStandardMaterial,
    amberMaterial: THREE.MeshStandardMaterial,
    includeCenterCrest = true,
  ): void {
    const junctionCollars: InstanceTransform[] = [];
    const junctionSignals: InstanceTransform[] = [];
    const ramps: Array<{ name: string; spec: LaunchRampSpec; edge: THREE.MeshStandardMaterial }> = [
      {
        name: 'South progressive launch',
        spec: { origin: { x: 0, y: 3.05, z: -63 }, heading: 0, length: 28, width: 11.5, rise: 15.6, curveExponent: 1.82, profile: 'smootherstep', troughDepth: 0.72, longitudinalSegments: 28, lateralSegments: 6, solid: true, skirtDepth: 2.1, collisionSkirtDepth: 1.18, edgeChamfer: 0.48, followSurfaceUnderside: true },
        edge: amberMaterial,
      },
      {
        name: 'North return launch',
        spec: { origin: { x: 0, y: 27.7, z: 63 }, heading: Math.PI, length: 28, width: 11.5, rise: -5.7, curveExponent: 1.82, profile: 'smootherstep', troughDepth: 0.72, longitudinalSegments: 28, lateralSegments: 6, solid: true, skirtDepth: 2.1, collisionSkirtDepth: 1.18, edgeChamfer: 0.48, followSurfaceUnderside: true },
        edge: amberMaterial,
      },
      {
        name: 'West transfer ramp',
        spec: { origin: { x: -71, y: 14.5, z: -18 }, heading: Math.PI * 0.5, length: 29, width: 10.5, rise: 11.8, curveExponent: 1.78, profile: 'smootherstep', troughDepth: 0.6, longitudinalSegments: 26, lateralSegments: 6, solid: true, skirtDepth: 1.75, collisionSkirtDepth: 1.08, edgeChamfer: 0.42, followSurfaceUnderside: true },
        edge: cyanMaterial,
      },
      {
        name: 'East transfer ramp',
        spec: { origin: { x: 71, y: 8.5, z: 18 }, heading: -Math.PI * 0.5, length: 33, width: 10.5, rise: 14.8, curveExponent: 1.78, profile: 'smootherstep', troughDepth: 0.6, longitudinalSegments: 28, lateralSegments: 6, solid: true, skirtDepth: 1.75, collisionSkirtDepth: 1.08, edgeChamfer: 0.42, followSurfaceUnderside: true },
        edge: magentaMaterial,
      },
      {
        name: 'Center crest downslope',
        spec: { origin: { x: 0, y: 18.65, z: -35 }, heading: 0, length: 24.8, width: 9.5, rise: -6.43, curveExponent: 1.55, profile: 'smootherstep', troughDepth: 0.46, longitudinalSegments: 22, lateralSegments: 6, solid: true, skirtDepth: 1.4, collisionSkirtDepth: 0.92, edgeChamfer: 0.36, followSurfaceUnderside: true },
        edge: amberMaterial,
      },
    ];
    for (const ramp of ramps) {
      if (!includeCenterCrest && ramp.name === 'Center crest downslope') continue;
      const flow = buildLaunchRamp(ramp.spec);
      const rampUv = flow.geometry.getAttribute('uv') as THREE.BufferAttribute;
      const textureLengthScale = Math.max(1, ramp.spec.length / 8);
      const textureWidthScale = Math.max(1, ramp.spec.width / 8);
      for (let index = 0; index < rampUv.count; index += 1) {
        rampUv.setXY(
          index,
          rampUv.getX(index) * textureLengthScale,
          rampUv.getY(index) * textureWidthScale,
        );
      }
      rampUv.needsUpdate = true;
      const longitudinalSegments = ramp.spec.longitudinalSegments ?? 12;
      const lateralSegments = ramp.spec.lateralSegments ?? 4;
      const topVertexCount = longitudinalSegments * lateralSegments * 6;
      const vertexCount = flow.geometry.getAttribute('position').count;
      flow.geometry.clearGroups();
      flow.geometry.addGroup(0, topVertexCount, 0);
      if (vertexCount > topVertexCount) {
        flow.geometry.addGroup(topVertexCount, vertexCount - topVertexCount, 1);
      }
      this.rampSurfaces.push({ name: ramp.name, spec: ramp.spec, flow });
      this.geometries.push(flow.geometry);
      const mesh = new THREE.Mesh(flow.geometry, [deckMaterial, sideMaterial]);
      mesh.name = ramp.name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.addRampRails(ramp.spec, amberMaterial, ramp.edge);
      this.addRampSupportRibs(ramp.spec, sideMaterial, ramp.edge);
      this.addRampTopShotSurfaces(ramp.spec);
      for (const u of [0, 1]) {
        const surface = this.rampPoint(ramp.spec, u, 0);
        const alongOffset = u === 0 ? 0.46 : -0.46;
        const sine = Math.sin(ramp.spec.heading);
        const cosine = Math.cos(ramp.spec.heading);
        const collarPosition = new THREE.Vector3(
          surface.x + sine * alongOffset,
          surface.y - 0.34,
          surface.z + cosine * alongOffset,
        );
        if (junctionCollars.some((collar) => collar.position.distanceToSquared(collarPosition) < 1.44)) continue;
        junctionCollars.push({
          position: collarPosition,
          scale: new THREE.Vector3(ramp.spec.width + 1.15, 0.3, 1.7),
          yaw: ramp.spec.heading,
        });
        junctionSignals.push({
          position: new THREE.Vector3(
            surface.x + sine * alongOffset,
            surface.y - 0.16,
            surface.z + cosine * alongOffset,
          ),
          scale: new THREE.Vector3(ramp.spec.width * 0.76, 0.055, 0.24),
          yaw: ramp.spec.heading,
        });
      }
    }
    this.addInstancedMeshes(
      'QuickSense authored ramp junction collars',
      this.createChamferedBlockGeometry(0.12),
      deckMaterial,
      junctionCollars,
    );
    this.addInstancedMeshes(
      'QuickSense ramp junction load-path signals',
      new THREE.BoxGeometry(1, 1, 1),
      amberMaterial,
      junctionSignals,
      false,
    );
  }

  private addRampTopShotSurfaces(spec: LaunchRampSpec): void {
    const segments = spec.longitudinalSegments ?? 12;
    for (let index = 0; index < segments; index += 1) {
      const box = new THREE.Box3();
      const u0 = index / segments;
      const u1 = (index + 1) / segments;
      for (const u of [u0, u1]) {
        for (const lateral of [-spec.width * 0.5, spec.width * 0.5]) {
          const point = this.rampPoint(spec, u, lateral);
          point.y -= 0.2;
          box.expandByPoint(point);
        }
      }
      box.min.y -= 0.08;
      box.max.y += 0.08;
      this.shotBoxes.push(box);
    }
  }

  private addRampRails(
    spec: LaunchRampSpec,
    safetyMaterial: THREE.MeshStandardMaterial,
    routeMaterial: THREE.MeshStandardMaterial,
  ): void {
    const samples = 24;
    for (const lateral of [-spec.width * 0.5 + 0.3, spec.width * 0.5 - 0.3]) {
      const edgePoints = Array.from({ length: samples }, (_, index) => {
        const point = this.rampPoint(spec, index / (samples - 1), lateral);
        return { x: point.x, y: point.y, z: point.z };
      });
      const safetyGeometry = this.createRibbonGeometry(edgePoints, false, [0], 0.28, 0, 0.04);
      const safety = this.addMesh(safetyGeometry, safetyMaterial, 'QuickSense sculpted ramp edge trim');
      safety.castShadow = false;
      safety.receiveShadow = false;
    }
    const centerPoints = Array.from({ length: samples }, (_, index) => {
      const point = this.rampPoint(spec, index / (samples - 1), 0);
      return { x: point.x, y: point.y, z: point.z };
    });
    const routeGeometry = this.createRibbonGeometry(centerPoints, false, [0], 0.18, 0, 0.06);
    const route = this.addMesh(routeGeometry, routeMaterial, 'QuickSense ramp route signal');
    route.castShadow = false;
    route.receiveShadow = false;
  }

  private addRampSupportRibs(
    spec: LaunchRampSpec,
    structureMaterial: THREE.MeshStandardMaterial,
    accentMaterial: THREE.MeshStandardMaterial,
  ): void {
    const supports: InstanceTransform[] = [];
    const accents: InstanceTransform[] = [];
    for (const u of [0.34, 0.72]) {
      const deckCenter = this.rampPoint(spec, u, 0);
      const skirtDepth = spec.skirtDepth ?? 0.45;
      const rampUndersideAt = (x: number, z: number): number => (
        sampleLaunchRampHeight(spec, x, z)
        ?? deckCenter.y - RAMP_POINT_VISUAL_LIFT
      ) - skirtDepth;
      for (const side of [-1, 1]) {
        const foot = this.rampPoint(spec, u, side * spec.width * 0.37);
        const terrain = this.terrainHeightAt(foot.x, foot.z);
        const capHeight = 0.42;
        const centerUndersideY = this.deckUndersideAt(foot.x, foot.z) ?? rampUndersideAt(foot.x, foot.z);
        const capBottomY = centerUndersideY - SUPPORT_CONTACT_EPSILON - capHeight;
        const height = capBottomY - terrain + 0.025;
        if (height > 1.15) {
          const cap = this.createFittedSupportCapGeometry(
            foot.x,
            foot.z,
            1.28,
            1.9,
            spec.heading,
            capHeight,
            rampUndersideAt,
          );
          this.addMesh(cap, structureMaterial, 'QuickSense fitted curved ramp support cap');
          supports.push({
            position: new THREE.Vector3(foot.x, terrain + height * 0.5, foot.z),
            scale: new THREE.Vector3(1.28, height, 1.9),
            yaw: spec.heading,
          });
        }
      }
      const beamHeight = 0.3;
      const beam = this.createFittedSupportCapGeometry(
        deckCenter.x,
        deckCenter.z,
        spec.width * 0.92,
        1.05,
        spec.heading,
        beamHeight,
        rampUndersideAt,
      );
      this.addMesh(beam, structureMaterial, 'QuickSense fitted ramp cross beam');
      const centerUndersideY = this.deckUndersideAt(deckCenter.x, deckCenter.z)
        ?? rampUndersideAt(deckCenter.x, deckCenter.z);
      accents.push({
        position: new THREE.Vector3(
          deckCenter.x,
          centerUndersideY - SUPPORT_CONTACT_EPSILON - beamHeight - 0.08,
          deckCenter.z,
        ),
        scale: new THREE.Vector3(spec.width * 0.64, 0.12, 1.1),
        yaw: spec.heading,
      });
    }
    this.addInstancedMeshes(
      'QuickSense curved ramp buttresses',
      this.createCliffButtressGeometry(),
      structureMaterial,
      supports,
    );
    this.addInstancedMeshes(
      'QuickSense ramp underside signals',
      new THREE.BoxGeometry(1, 1, 1),
      accentMaterial,
      accents,
      false,
    );
  }

  private rampPoint(spec: LaunchRampSpec, u: number, lateral: number): THREE.Vector3 {
    const sine = Math.sin(spec.heading);
    const cosine = Math.cos(spec.heading);
    const x = spec.origin.x + sine * spec.length * u + cosine * lateral;
    const z = spec.origin.z + cosine * spec.length * u - sine * lateral;
    const y = sampleLaunchRampHeight(spec, x, z)
      ?? spec.origin.y + spec.rise * sampleLaunchRampProfile(spec, u);
    return new THREE.Vector3(x, y + RAMP_POINT_VISUAL_LIFT, z);
  }

  private createRouteJunctionDecks(material: THREE.MeshStandardMaterial): void {
    const deckHeight = 1.72;
    const junctions = [
      { name: 'QuickSense south fork junction', x: 0, z: -69, y: 3.05, width: 28, depth: 12 },
      { name: 'QuickSense north fork junction', x: 0, z: 69, y: 27.7, width: 28, depth: 12 },
      { name: 'QuickSense west outer T junction', x: -77, z: -18, y: 14.5, width: 12, depth: 12 },
      { name: 'QuickSense east outer T junction', x: 77, z: 18, y: 8.5, width: 12, depth: 12 },
      { name: 'QuickSense west inner merge junction', x: -38, z: 36, y: 20.5, width: 18, depth: 12 },
      { name: 'QuickSense east inner merge junction', x: 38, z: 36, y: 20.5, width: 18, depth: 12 },
    ];
    this.addInstancedMeshes(
      'QuickSense single-piece route junction decks',
      new THREE.BoxGeometry(1, 1, 1),
      material,
      junctions.map((junction) => ({
        position: new THREE.Vector3(junction.x, junction.y - deckHeight * 0.5, junction.z),
        scale: new THREE.Vector3(junction.width, deckHeight, junction.depth),
      })),
    );
    for (const junction of junctions) {
      this.platformSurfaces.push({
        name: junction.name,
        minX: junction.x - junction.width * 0.5,
        maxX: junction.x + junction.width * 0.5,
        minZ: junction.z - junction.depth * 0.5,
        maxZ: junction.z + junction.depth * 0.5,
        y: junction.y,
      });
      this.shotBoxes.push(new THREE.Box3(
        new THREE.Vector3(junction.x - junction.width * 0.5, junction.y - 0.22, junction.z - junction.depth * 0.5),
        new THREE.Vector3(junction.x + junction.width * 0.5, junction.y + 0.08, junction.z + junction.depth * 0.5),
      ));
    }
  }

  private addPlatform(
    name: string,
    x: number,
    z: number,
    y: number,
    width: number,
    height: number,
    depth: number,
    material: THREE.MeshStandardMaterial,
    collider: boolean,
  ): void {
    this.box(name, new THREE.Vector3(x, y - height * 0.5, z), new THREE.Vector3(width, height, depth), material, collider);
    this.platformSurfaces.push({ name, minX: x - width * 0.5, maxX: x + width * 0.5, minZ: z - depth * 0.5, maxZ: z + depth * 0.5, y });
    if (collider) this.shotBoxes.push(new THREE.Box3(new THREE.Vector3(x - width * 0.5, y - height, z - depth * 0.5), new THREE.Vector3(x + width * 0.5, y, z + depth * 0.5)));
  }

  private box(
    name: string,
    center: THREE.Vector3,
    size: THREE.Vector3,
    material: THREE.MeshStandardMaterial,
    collider = false,
    yaw = 0,
  ): THREE.Mesh {
    const mesh = this.addMesh(new THREE.BoxGeometry(size.x, size.y, size.z), material, name, center);
    mesh.rotation.y = yaw;
    if (collider) {
      this.registerBoxCollision(name, center, size, yaw);
    }
    return mesh;
  }

  /** Add a load-bearing member between two authored building sockets. */
  private addBuildingConnectionBeam(
    name: string,
    start: THREE.Vector3,
    end: THREE.Vector3,
    width: number,
    depth: number,
    material: THREE.MeshStandardMaterial,
  ): void {
    const direction = end.clone().sub(start);
    const length = direction.length();
    if (length < 0.05) return;
    const beam = this.addMesh(
      new THREE.BoxGeometry(width, length, depth),
      material,
      name,
      start.clone().lerp(end, 0.5),
    );
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    beam.castShadow = true;
    beam.receiveShadow = true;
    this.shotBoxes.push(new THREE.Box3().setFromPoints([start, end]).expandByScalar(Math.max(width, depth) * 0.55));
  }

  /**
   * Build a short, terrain-keyed entry apron so a building never presents a
   * floating door face. The ramp is visual infrastructure and its flat
   * landing is registered as a support surface for traversal and QA.
   */
  private createFlushBuildingEntry(
    name: string,
    x: number,
    z: number,
    width: number,
    depth: number,
    yaw: number,
    doorY: number,
    foundationMaterial: THREE.MeshStandardMaterial,
    trimMaterial: THREE.MeshStandardMaterial,
  ): void {
    const doorLocalZ = -depth * 0.49;
    const approachLocalZ = -depth * 0.88;
    const rampLength = Math.max(3.4, depth * 0.39);
    const approachPoint = this.localOffset(x, 0, z, 0, approachLocalZ, yaw);
    const terrainY = this.terrainHeightAt(approachPoint.x, approachPoint.z);
    const groundY = Math.min(doorY - 0.34, Math.max(0.08, terrainY + 0.06));
    const rise = Math.max(0.28, doorY - groundY);
    const rampCenter = this.localOffset(
      x,
      (groundY + doorY) * 0.5,
      z,
      0,
      (approachLocalZ + doorLocalZ) * 0.5,
      yaw,
    );
    const rampWidth = Math.min(width * 0.34, 10.5);
    const rampStart = approachPoint.clone().setY(groundY);
    const rampEnd = this.localOffset(x, doorY, z, 0, doorLocalZ, yaw);
    this.buildingEntryRamps.push({
      name: `QuickSense ${name} flush entry ramp`,
      start: rampStart,
      end: rampEnd,
      width: rampWidth,
    });
    this.shotBoxes.push(new THREE.Box3(
      new THREE.Vector3(
        Math.min(rampStart.x, rampEnd.x) - rampWidth * 0.5 - 0.16,
        Math.min(rampStart.y, rampEnd.y) - 0.24,
        Math.min(rampStart.z, rampEnd.z) - rampWidth * 0.5 - 0.16,
      ),
      new THREE.Vector3(
        Math.max(rampStart.x, rampEnd.x) + rampWidth * 0.5 + 0.16,
        Math.max(rampStart.y, rampEnd.y) + 0.24,
        Math.max(rampStart.z, rampEnd.z) + rampWidth * 0.5 + 0.16,
      ),
    ));
    const ramp = this.addMesh(
      this.createChamferedBlockGeometry(0.1),
      foundationMaterial,
      `QuickSense ${name} flush entry ramp`,
      rampCenter,
    );
    ramp.scale.set(
      rampWidth,
      Math.max(0.42, 0.3 + rise * 0.08),
      rampLength,
    );
    ramp.rotation.set(-Math.atan2(rise, rampLength), yaw, 0);

    const landingWidth = Math.min(width * 0.38, 11.5);
    const landingDepth = Math.min(3.4, depth * 0.24);
    const landingCenter = this.localOffset(
      x,
      doorY - 0.15,
      z,
      0,
      doorLocalZ + landingDepth * 0.32,
      yaw,
    );
    this.box(
      `QuickSense ${name} flush entry landing`,
      landingCenter,
      new THREE.Vector3(landingWidth, 0.3, landingDepth),
      trimMaterial,
      false,
      yaw,
    );
    const cosine = Math.abs(Math.cos(yaw));
    const sine = Math.abs(Math.sin(yaw));
    const halfX = (landingWidth * cosine + landingDepth * sine) * 0.5;
    const halfZ = (landingWidth * sine + landingDepth * cosine) * 0.5;
    this.platformSurfaces.push({
      name: `QuickSense ${name} flush entry landing`,
      minX: landingCenter.x - halfX,
      maxX: landingCenter.x + halfX,
      minZ: landingCenter.z - halfZ,
      maxZ: landingCenter.z + halfZ,
      y: doorY,
    });
    this.shotBoxes.push(new THREE.Box3(
      new THREE.Vector3(landingCenter.x - halfX, doorY - 0.28, landingCenter.z - halfZ),
      new THREE.Vector3(landingCenter.x + halfX, doorY + 0.12, landingCenter.z + halfZ),
    ));

    const railOffset = Math.min(width * 0.2, 3.1);
    for (const side of [-1, 1]) {
      const railStart = this.localOffset(
        x,
        groundY + 0.62,
        z,
        side * railOffset,
        approachLocalZ + 0.5,
        yaw,
      );
      const railEnd = this.localOffset(
        x,
        doorY + 0.62,
        z,
        side * railOffset,
        doorLocalZ + 0.12,
        yaw,
      );
      this.addBuildingConnectionBeam(
        `QuickSense ${name} entry handrail ${side < 0 ? 'left' : 'right'}`,
        railStart,
        railEnd,
        0.14,
        0.14,
        trimMaterial,
      );
    }
  }

  private createEntryGatehouses(
    sideMaterial: THREE.MeshStandardMaterial,
    _cyanMaterial: THREE.MeshStandardMaterial,
    _magentaMaterial: THREE.MeshStandardMaterial,
    _amberMaterial: THREE.MeshStandardMaterial,
  ): void {
    const specs = [
      { name: 'North Gate West House', profile: 'north-cantilever', x: -10.6, z: 61, roofY: 21.4, height: 18, width: 10.2, depth: 15, yaw: 0.08, accent: 'cyan' as const },
      { name: 'North Gate East House', profile: 'north-split', x: 10.6, z: 61, roofY: 21.4, height: 18, width: 10.2, depth: 15, yaw: -0.08, accent: 'magenta' as const },
      { name: 'South Launch West House', profile: 'south-wedge', x: -10.6, z: -61, roofY: 7.1, height: 6.2, width: 10.2, depth: 15, yaw: -0.05, accent: 'cyan' as const },
      { name: 'South Launch East House', profile: 'south-fork', x: 10.6, z: -61, roofY: 7.1, height: 6.2, width: 10.2, depth: 15, yaw: 0.05, accent: 'magenta' as const },
    ];
    const accentColors: Record<AccentRole, THREE.Color> = {
      cyan: new THREE.Color(0x239eb3),
      magenta: new THREE.Color(0xa96846),
      amber: new THREE.Color(0xb57a2b),
    };
    const accents: Record<AccentRole, InstanceTransform[]> = { cyan: [], magenta: [], amber: [] };
    for (const [index, spec] of specs.entries()) {
      const bottomY = spec.roofY - spec.height;
      this.registerBuilding(
        spec.name,
        'gateway',
        spec.profile,
        spec.accent,
        new THREE.Vector3(spec.x, bottomY + spec.height * 0.5, spec.z),
      );
      const footprint = index === 0
        ? [[-0.5, -0.34], [0.12, -0.5], [0.5, -0.18], [0.38, 0.5], [-0.32, 0.42], [-0.5, 0.02]] as const
        : index === 1
          ? [[-0.46, -0.44], [0.24, -0.5], [0.5, -0.08], [0.22, 0.5], [-0.36, 0.38], [-0.5, -0.04]] as const
          : index === 2
            ? [[-0.5, -0.3], [-0.16, -0.5], [0.5, -0.36], [0.4, 0.38], [-0.28, 0.5], [-0.5, 0.1]] as const
            : [[-0.48, -0.4], [0.16, -0.5], [0.5, -0.2], [0.3, 0.5], [-0.22, 0.42], [-0.5, 0.06]] as const;
      const shell = this.addMesh(
        this.createArchitecturalLoftGeometry(footprint, [
          { y: -0.5, scaleX: 1, scaleZ: 1 },
          { y: -0.22, scaleX: 0.94, scaleZ: 0.96, shiftX: index % 2 === 0 ? -0.03 : 0.03 },
          { y: 0.26, scaleX: 0.76, scaleZ: 0.84, shiftX: index % 2 === 0 ? -0.1 : 0.1, rotation: index % 2 === 0 ? -0.05 : 0.05 },
          { y: 0.5, scaleX: index < 2 ? 0.92 : 0.82, scaleZ: 0.9, shiftX: index % 2 === 0 ? -0.14 : 0.14, rotation: index % 2 === 0 ? -0.08 : 0.08 },
        ], 3),
        sideMaterial,
        `QuickSense ${spec.name} authored shell`,
        new THREE.Vector3(spec.x, bottomY + spec.height * 0.5, spec.z),
      );
      shell.scale.set(spec.width, spec.height, spec.depth);
      shell.rotation.y = spec.yaw;
      accents[spec.accent].push(
        {
          position: this.localOffset(spec.x, bottomY + spec.height * 0.62, spec.z, 0, -spec.depth * 0.5, spec.yaw),
          scale: new THREE.Vector3(spec.width * 0.55, 0.32, 0.18),
          yaw: spec.yaw,
        },
        {
          position: this.localOffset(spec.x, bottomY + spec.height * 0.78, spec.z, index % 2 === 0 ? -spec.width * 0.2 : spec.width * 0.2, -spec.depth * 0.47, spec.yaw),
          scale: new THREE.Vector3(0.28, spec.height * 0.32, 0.18),
          yaw: spec.yaw,
        },
      );
      this.registerBoxCollision(
        `QuickSense ${spec.name} lower shell`,
        new THREE.Vector3(spec.x, bottomY + spec.height * 0.42, spec.z),
        new THREE.Vector3(spec.width * 0.68, spec.height * 0.84, spec.depth * 0.68),
        spec.yaw,
      );
      this.createFlushBuildingEntry(
        spec.name,
        spec.x,
        spec.z,
        spec.width,
        spec.depth,
        spec.yaw,
        bottomY + 0.46,
        sideMaterial,
        sideMaterial,
      );
      if (index < 2) {
        const bridgeSocket = new THREE.Vector3(index === 0 ? -8.7 : 8.7, 37.05, 49.15);
        const roofSocket = this.localOffset(
          spec.x,
          spec.roofY + 0.18,
          spec.z,
          0,
          -spec.depth * 0.48,
          spec.yaw,
        );
        this.addBuildingConnectionBeam(
          `QuickSense ${spec.name} to north grapple bridge spine`,
          roofSocket,
          bridgeSocket,
          0.72,
          1.1,
          sideMaterial,
        );
      }
    }
    const transforms = (['cyan', 'magenta', 'amber'] as const).flatMap((role) => accents[role]);
    const material = new THREE.MeshBasicMaterial({ name: 'QuickSense entry house signal material', color: 0xffffff, toneMapped: false });
    this.materials.push(material);
    const signals = this.addInstancedMeshes('QuickSense entry gatehouse faction signals', new THREE.BoxGeometry(1, 1, 1), material, transforms, false);
    if (signals) {
      let instance = 0;
      for (const role of ['cyan', 'magenta', 'amber'] as const) {
        for (let index = 0; index < accents[role].length; index += 1) {
          signals.setColorAt(instance, accentColors[role]);
          instance += 1;
        }
      }
      if (signals.instanceColor) signals.instanceColor.needsUpdate = true;
    }
  }

  private createCentralStructures(
    sideMaterial: THREE.MeshStandardMaterial,
    whiteMaterial: THREE.MeshStandardMaterial,
    cyanMaterial: THREE.MeshStandardMaterial,
    magentaMaterial: THREE.MeshStandardMaterial,
    amberMaterial: THREE.MeshStandardMaterial,
  ): void {
    const eastFactionMaterial = magentaMaterial.clone();
    eastFactionMaterial.name = 'QuickSense terracotta building signal';
    eastFactionMaterial.color.setHex(0xa96846);
    eastFactionMaterial.emissive.setHex(0x7f4028);
    eastFactionMaterial.emissiveIntensity = 0.34;
    this.materials.push(eastFactionMaterial);
    this.registerBuilding('Flux Core Citadel', 'citadel', 'split-bastion-reactor', 'amber', new THREE.Vector3(0, 26, 0));
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    this.addMesh(
      this.createFluxCoreCitadelGeometry(false),
      sideMaterial,
      'Flux Core custom reactor citadel shell',
    );
    this.addMesh(
      this.createFluxCoreCitadelGeometry(true),
      whiteMaterial,
      'Flux Core custom reactor citadel armor',
    );

    const shoulders: InstanceTransform[] = [];
    const cyanSignals: InstanceTransform[] = [];
    const magentaSignals: InstanceTransform[] = [];
    for (const side of [-1, 1]) {
      shoulders.push(
        {
          position: new THREE.Vector3(side * 12.9, 20.5, 0),
          scale: new THREE.Vector3(2.6, 10.2, 7.8),
          yaw: side * -0.08,
        },
        {
          position: new THREE.Vector3(side * 8.8, 37.5, 0),
          scale: new THREE.Vector3(5.6, 1.1, 6.2),
          yaw: side * Math.PI / 8,
        },
        {
          position: new THREE.Vector3(side * 14.2, 21.2, -4.6),
          scale: new THREE.Vector3(2.0, 13.6, 2.2),
          rotation: new THREE.Euler(0, side * -0.08, side * 0.22),
        },
        {
          position: new THREE.Vector3(side * 14.2, 21.2, 4.6),
          scale: new THREE.Vector3(2.0, 13.6, 2.2),
          rotation: new THREE.Euler(0, side * 0.08, side * 0.22),
        },
        {
          position: new THREE.Vector3(side * 11.8, 33.2, -3.8),
          scale: new THREE.Vector3(1.35, 8.6, 1.7),
          rotation: new THREE.Euler(0, side * -0.12, side * -0.25),
        },
      );
      const signal = {
        position: new THREE.Vector3(side * 8.8, 26.4, -4.2),
        scale: new THREE.Vector3(0.32, 14.6, 0.2),
        yaw: 0,
      };
      (side < 0 ? cyanSignals : magentaSignals).push(
        signal,
        {
          position: new THREE.Vector3(side * 8.8, 31.2, -4.24),
          scale: new THREE.Vector3(2.55, 0.38, 0.22),
          yaw: 0,
        },
        {
          position: new THREE.Vector3(side * 10.25, 18.6, -6.3),
          scale: new THREE.Vector3(3.9, 0.32, 0.22),
          yaw: 0,
        },
      );
    }
    shoulders.push(
      { position: new THREE.Vector3(0, 34.2, 0), scale: new THREE.Vector3(22.2, 1.5, 4.4) },
      { position: new THREE.Vector3(0, 17.8, 5.3), scale: new THREE.Vector3(19.5, 1.2, 2.4) },
    );
    this.addInstancedMeshes('Flux Core cyan wayfinding', unitBox, cyanMaterial, cyanSignals, false);
    this.addInstancedMeshes('Flux Core terracotta wayfinding', unitBox, eastFactionMaterial, magentaSignals, false);
    this.addInstancedMeshes('Flux Core amber reactor spine', unitBox, amberMaterial, [
      { position: new THREE.Vector3(0, 25.3, -1.05), scale: new THREE.Vector3(0.42, 18.6, 0.24) },
      { position: new THREE.Vector3(0, 34.35, -2.35), scale: new THREE.Vector3(10.8, 0.28, 0.2) },
    ], false);

    this.registerBoxCollision(
      'Flux Core west bastion collision',
      new THREE.Vector3(-10.2, 16.2, 0),
      new THREE.Vector3(5.8, 8, 12.5),
    );
    this.registerBoxCollision(
      'Flux Core east bastion collision',
      new THREE.Vector3(10.2, 16.2, 0),
      new THREE.Vector3(5.8, 8, 12.5),
    );
    this.registerBoxCollision(
      'Flux Core west tower collision',
      new THREE.Vector3(-8.8, 26.3, 0),
      new THREE.Vector3(3.8, 20.2, 4.6),
    );
    this.registerBoxCollision(
      'Flux Core east tower collision',
      new THREE.Vector3(8.8, 26.3, 0),
      new THREE.Vector3(3.8, 20.2, 4.6),
    );

    const ring = new THREE.Mesh(new THREE.TorusGeometry(11.2, 0.13, 6, 32), amberMaterial);
    ring.name = 'Flux Core orbit ring';
    ring.rotation.x = Math.PI * 0.5;
    ring.position.set(0, 35.5, 0);
    ring.castShadow = false;
    this.trackGeometry(ring.geometry);
    this.group.add(ring);
    this.animatedProps.push({ object: ring, baseY: 35.5, phase: 0.2, spin: 0.16 });
    const coreLight = new THREE.PointLight(0x53eaff, 4.5, 28, 2);
    coreLight.position.set(0, 29, 0);
    this.group.add(coreLight);
    this.registerBuilding('Cyan Grapple Tower', 'grapple-tower', 'octagonal-halo', 'cyan', new THREE.Vector3(-23, 27, 7));
    this.registerBuilding('Magenta Grapple Tower', 'grapple-tower', 'octagonal-halo', 'magenta', new THREE.Vector3(23, 27, 7));
    this.createTower(-23, 7, 12.5, 24, cyanMaterial, sideMaterial);
    this.createTower(23, 7, 12.5, 24, eastFactionMaterial, sideMaterial);

    this.registerBuilding('North Grapple Gate', 'gateway', 'forked-bridge', 'amber', new THREE.Vector3(0, 28, 47));

    this.addMesh(
      this.createNorthGrappleGateGeometry(),
      sideMaterial,
      'QuickSense authored flying-buttress north grapple gate',
      new THREE.Vector3(0, 0, 47),
    );
    this.addInstancedMeshes('QuickSense north gate faction signals', unitBox, cyanMaterial, [
      { position: new THREE.Vector3(-8.7, 21.2, 44.94), scale: new THREE.Vector3(0.34, 24, 0.2) },
      { position: new THREE.Vector3(-5.1, 37.72, 44.48), scale: new THREE.Vector3(5.5, 0.3, 0.2) },
    ], false);
    this.addInstancedMeshes('QuickSense north gate terracotta signals', unitBox, eastFactionMaterial, [
      { position: new THREE.Vector3(8.7, 21.2, 44.94), scale: new THREE.Vector3(0.34, 24, 0.2) },
      { position: new THREE.Vector3(5.1, 37.72, 44.48), scale: new THREE.Vector3(5.5, 0.3, 0.2) },
    ], false);
    this.addInstancedMeshes('QuickSense north gate amber crown', unitBox, amberMaterial, [
      { position: new THREE.Vector3(0, 38.78, 44.46), scale: new THREE.Vector3(8.6, 0.3, 0.22) },
    ], false);
    this.platformSurfaces.push({
      name: 'QuickSense north grapple gate bridge floor',
      minX: -8.2,
      maxX: 8.2,
      minZ: 44.9,
      maxZ: 49.1,
      y: 39.15,
    });
    this.shotBoxes.push(new THREE.Box3(
      new THREE.Vector3(-11.8, 37.4, 43.9),
      new THREE.Vector3(11.8, 45.8, 50.1),
    ));
    for (const x of [-8.7, 8.7]) {
      this.registerBoxCollision(
        'QuickSense north grapple gate collision',
        new THREE.Vector3(x, 20.2, 47),
        new THREE.Vector3(3.7, 37.5, 4.3),
      );
    }
  }

  private createFluxCoreCitadelGeometry(armor: boolean): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const append = (
      geometry: THREE.BufferGeometry,
      position: THREE.Vector3,
      scale: THREE.Vector3,
      rotation = new THREE.Euler(),
    ): void => {
      const normalized = geometry.index ? geometry.toNonIndexed() : geometry;
      if (normalized !== geometry) geometry.dispose();
      normalized.applyMatrix4(new THREE.Matrix4().compose(
        position,
        new THREE.Quaternion().setFromEuler(rotation),
        scale,
      ));
      parts.push(normalized);
    };
    const westFootprint = [[-0.5, -0.34], [0.02, -0.5], [0.5, -0.24], [0.4, 0.42], [-0.16, 0.5], [-0.5, 0.12]] as const;
    const eastFootprint = [[-0.46, -0.42], [0.22, -0.5], [0.5, -0.08], [0.28, 0.5], [-0.34, 0.4], [-0.5, -0.06]] as const;
    if (!armor) {
      for (const side of [-1, 1]) {
        append(
          this.createArchitecturalLoftGeometry(side < 0 ? westFootprint : eastFootprint, [
            { y: -0.5, scaleX: 1.08, scaleZ: 1.04 },
            { y: -0.18, scaleX: 0.96, scaleZ: 0.98, shiftX: side * -0.03 },
            { y: 0.34, scaleX: 0.78, scaleZ: 0.84, shiftX: side * -0.08, rotation: side * -0.04 },
            { y: 0.5, scaleX: 0.92, scaleZ: 0.9, shiftX: side * -0.1, rotation: side * -0.06 },
          ], 2.5),
          new THREE.Vector3(side * 10.2, 16.2, 0),
          new THREE.Vector3(7.2, 8.2, 9.6),
          new THREE.Euler(0, side * -Math.PI / 9, 0),
        );
        append(
          this.createArchitecturalLoftGeometry(side < 0 ? westFootprint : eastFootprint, [
            { y: -0.5, scaleX: 1, scaleZ: 1 },
            { y: -0.1, scaleX: 0.84, scaleZ: 0.9, shiftX: side * -0.04 },
            { y: 0.32, scaleX: 0.62, scaleZ: 0.68, shiftX: side * -0.13, rotation: side * -0.08 },
            { y: 0.5, scaleX: side < 0 ? 0.78 : 0.7, scaleZ: 0.76, shiftX: side * -0.18, rotation: side * -0.12 },
          ], 4.2),
          new THREE.Vector3(side * 8.8, 27, 0),
          new THREE.Vector3(side < 0 ? 5.2 : 4.8, side < 0 ? 21.6 : 23.4, 5.5),
          new THREE.Euler(0, side * -Math.PI / 8, 0),
        );
        append(
          this.createAsymmetricFinGeometry(),
          new THREE.Vector3(side * 14.2, 22, -4.4),
          new THREE.Vector3(2.1, side < 0 ? 15.2 : 12.8, 2.5),
          new THREE.Euler(0, side * -0.08, side * 0.22),
        );
        append(
          this.createAsymmetricFinGeometry(),
          new THREE.Vector3(side * 13.4, 23.2, 4.2),
          new THREE.Vector3(1.8, side < 0 ? 11.6 : 15.6, 2.4),
          new THREE.Euler(0, side * 0.08, side * 0.18),
        );
      }
      append(
        this.createArchitecturalLoftGeometry(
          [[-0.5, -0.32], [-0.18, -0.5], [0.44, -0.42], [0.5, 0.14], [0.18, 0.5], [-0.4, 0.4]],
          [
            { y: -0.5, scaleX: 1, scaleZ: 1 },
            { y: 0.18, scaleX: 0.74, scaleZ: 0.82, rotation: 0.05 },
            { y: 0.5, scaleX: 0.86, scaleZ: 0.9, rotation: 0.08 },
          ],
          3.5,
        ),
        new THREE.Vector3(0, 25, 0),
        new THREE.Vector3(3.2, 20, 3.2),
      );
      append(new THREE.BoxGeometry(1, 1, 1), new THREE.Vector3(0, 34.2, 0), new THREE.Vector3(22.2, 1.5, 4.4));
      append(new THREE.BoxGeometry(1, 1, 1), new THREE.Vector3(0, 17.8, 5.3), new THREE.Vector3(19.5, 1.2, 2.4));
    } else {
      for (const side of [-1, 1]) {
        append(
          this.createArchitecturalLoftGeometry(side < 0 ? westFootprint : eastFootprint, [
            { y: -0.5, scaleX: 1, scaleZ: 1 },
            { y: 0.5, scaleX: 1.06, scaleZ: 1.04 },
          ], 1.4),
          new THREE.Vector3(side * 10.2, 12.9, 0),
          new THREE.Vector3(8.1, 2.1, 9.3),
          new THREE.Euler(0, side * -Math.PI / 9, 0),
        );
        append(
          this.createArchitecturalLoftGeometry(side < 0 ? westFootprint : eastFootprint, [
            { y: -0.5, scaleX: 1, scaleZ: 1 },
            { y: 0.5, scaleX: 1.08, scaleZ: 1.04 },
          ], 1.2),
          new THREE.Vector3(side * 8.8, side < 0 ? 37.2 : 38.1, 0),
          new THREE.Vector3(side < 0 ? 5.6 : 5, 1.25, 6.2),
          new THREE.Euler(0, side * -Math.PI / 8, 0),
        );
      }
      append(new THREE.BoxGeometry(1, 1, 1), new THREE.Vector3(-1.2, 34.55, -2.35), new THREE.Vector3(9.2, 0.52, 0.34), new THREE.Euler(0, 0, -0.05));
      append(new THREE.BoxGeometry(1, 1, 1), new THREE.Vector3(4.4, 34.25, -2.35), new THREE.Vector3(5.2, 0.42, 0.34), new THREE.Euler(0, 0, 0.08));
    }
    const merged = mergeGeometries(parts, false);
    if (!merged) throw new Error(`QuickSense could not merge Flux Core ${armor ? 'armor' : 'shell'} geometry.`);
    for (const part of parts) part.dispose();
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }

  private createTower(
    x: number,
    z: number,
    baseY: number,
    height: number,
    accent: THREE.MeshStandardMaterial,
    sideMaterial: THREE.MeshStandardMaterial,
  ): void {
    const variant = x < 0 ? 'crescent' : 'split-fork';
    const upperBaseBottomY = baseY - 1.05;
    const terrainY = this.terrainHeightAt(x, z) - 0.45;
    const foundationTopY = upperBaseBottomY + 1.15;
    const foundationHeight = Math.max(2.4, foundationTopY - terrainY);
    const foundation = this.addMesh(
      this.createArchitecturalLoftGeometry(
        [[-0.5, -0.34], [-0.3, -0.5], [0.34, -0.48], [0.5, -0.24], [0.44, 0.42], [-0.4, 0.48]],
        [
          { y: -0.5, scaleX: 1.12, scaleZ: 1.1 },
          { y: -0.18, scaleX: 1.02, scaleZ: 1 },
          { y: 0.5, scaleX: 0.78, scaleZ: 0.8, shiftX: x < 0 ? -0.05 : 0.05 },
        ],
        2.2,
      ),
      sideMaterial,
      `QuickSense ${variant} grapple tower grounded foundation`,
      new THREE.Vector3(x, terrainY + foundationHeight * 0.5, z),
    );
    foundation.scale.set(10.8, foundationHeight, 10.2);
    foundation.rotation.y = x < 0 ? -0.06 : 0.08;
    const structure = this.addMesh(
      this.createGrappleTowerGeometry(variant, height),
      sideMaterial,
      `QuickSense ${variant} grapple tower architecture`,
      new THREE.Vector3(x, baseY - 1.05, z),
    );
    structure.rotation.y = x < 0 ? -0.06 : 0.08;
    const beacon = this.addMesh(
      new THREE.BoxGeometry(x < 0 ? 0.42 : 0.56, height * 0.72, 0.22),
      accent,
      `QuickSense ${variant} tower recessed conduit`,
      new THREE.Vector3(x + (x < 0 ? -0.32 : 0.38), baseY + height * 0.5 + 0.8, z - 2.34),
    );
    beacon.castShadow = false;
    const ringArc = x < 0 ? Math.PI * 1.72 : Math.PI * 1.42;
    const ring = this.addMesh(
      new THREE.TorusGeometry(x < 0 ? 5.2 : 4.65, 0.16, 6, 24, ringArc),
      accent,
      `QuickSense ${variant} grapple crown`,
      new THREE.Vector3(x, baseY + height + (x < 0 ? 3.1 : 4), z),
    );
    ring.rotation.x = Math.PI * 0.5;
    ring.rotation.z = x < 0 ? 0.3 : -0.22;
    ring.castShadow = false;
    this.animatedProps.push({ object: ring, baseY: ring.position.y, phase: x * 0.02 + z * 0.01, spin: x >= 0 ? 0.27 : -0.24 });
    this.registerBoxCollision(
      `QuickSense ${variant} tower grounded foundation`,
      new THREE.Vector3(x, terrainY + foundationHeight * 0.5, z),
      new THREE.Vector3(8.8, foundationHeight, 8.4),
    );
    this.registerBoxCollision(
      `QuickSense ${variant} tower base`,
      new THREE.Vector3(x, baseY, z),
      new THREE.Vector3(8.4, 3.2, 8),
    );
    this.registerBoxCollision(
      `QuickSense ${variant} tower shaft`,
      new THREE.Vector3(x, baseY + height * 0.5 + 0.8, z),
      new THREE.Vector3(4.5, height, 4.2),
    );
    this.shotBoxes.push(new THREE.Box3(
      new THREE.Vector3(x - 5.3, baseY + height + 2.75, z - 5.3),
      new THREE.Vector3(x + 5.3, baseY + height + 3.45, z + 5.3),
    ));
  }

  private createGrappleTowerGeometry(
    variant: 'crescent' | 'split-fork',
    height: number,
  ): THREE.BufferGeometry {
    const octagon = Array.from({ length: 8 }, (_, index) => {
      const angle = Math.PI * 0.25 * index + Math.PI * 0.125;
      return [Math.cos(angle) * 0.5, Math.sin(angle) * 0.5] as const;
    });
    const parts: THREE.BufferGeometry[] = [];
    const transform = (
      geometry: THREE.BufferGeometry,
      position: THREE.Vector3,
      scale: THREE.Vector3,
      rotation = new THREE.Euler(),
    ): void => {
      const matrix = new THREE.Matrix4().compose(
        position,
        new THREE.Quaternion().setFromEuler(rotation),
        scale,
      );
      const normalized = geometry.index ? geometry.toNonIndexed() : geometry;
      if (normalized !== geometry) geometry.dispose();
      normalized.applyMatrix4(matrix);
      parts.push(normalized);
    };

    transform(
      this.createArchitecturalLoftGeometry(octagon, [
        { y: -0.5, scaleX: 1, scaleZ: 1 },
        { y: 0.18, scaleX: 0.9, scaleZ: 0.9 },
        { y: 0.5, scaleX: 1.08, scaleZ: 1.04 },
      ], 1.6),
      new THREE.Vector3(0, 1.05, 0),
      new THREE.Vector3(9.4, 2.1, 8.8),
    );
    transform(
      this.createArchitecturalLoftGeometry(
        variant === 'crescent'
          ? [[-0.46, -0.34], [0.08, -0.5], [0.5, -0.18], [0.34, 0.48], [-0.28, 0.42], [-0.5, 0.08]]
          : [[-0.5, -0.24], [-0.2, -0.5], [0.44, -0.42], [0.5, 0.16], [0.1, 0.5], [-0.44, 0.34]],
        [
          { y: -0.5, scaleX: 1, scaleZ: 1 },
          { y: -0.16, scaleX: 0.82, scaleZ: 0.88, shiftX: variant === 'crescent' ? -0.04 : 0.05 },
          { y: 0.34, scaleX: 0.66, scaleZ: 0.72, shiftX: variant === 'crescent' ? -0.12 : 0.12, rotation: variant === 'crescent' ? -0.05 : 0.07 },
          { y: 0.5, scaleX: 0.8, scaleZ: 0.78, shiftX: variant === 'crescent' ? -0.16 : 0.16, rotation: variant === 'crescent' ? -0.08 : 0.1 },
        ],
        4,
      ),
      new THREE.Vector3(0, height * 0.5 + 1.85, 0),
      new THREE.Vector3(5.8, height, 5.2),
    );

    const forkXs = variant === 'crescent' ? [-2.3, 1.6] : [-2.6, 2.6];
    for (const [index, forkX] of forkXs.entries()) {
      transform(
        this.createAsymmetricFinGeometry(),
        new THREE.Vector3(forkX, height + (variant === 'crescent' ? 4.2 + index * 0.8 : 4.8), 0),
        new THREE.Vector3(1.5, variant === 'crescent' ? 8.2 + index * 1.4 : 9.6, 3.2),
        new THREE.Euler(0, 0, variant === 'crescent' ? (index === 0 ? -0.16 : 0.08) : (index === 0 ? -0.24 : 0.24)),
      );
    }
    transform(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.Vector3(variant === 'crescent' ? -0.5 : 0, height + 7.2, 0),
      new THREE.Vector3(variant === 'crescent' ? 8.4 : 6.8, 0.75, 3.4),
      new THREE.Euler(0, 0, variant === 'crescent' ? -0.08 : 0),
    );
    if (variant === 'crescent') {
      transform(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.Vector3(-3.6, height * 0.62, -2.8),
        new THREE.Vector3(4.2, 0.75, 3.8),
        new THREE.Euler(0, -0.18, -0.08),
      );
    }
    const merged = mergeGeometries(parts, false);
    if (!merged) throw new Error(`QuickSense could not merge ${variant} grapple tower geometry.`);
    for (const part of parts) part.dispose();
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }

  private createNorthGrappleGateGeometry(): THREE.BufferGeometry {
    const footprint = [
      [-0.5, -0.34], [-0.24, -0.5], [0.42, -0.44], [0.5, 0.12], [0.2, 0.5], [-0.42, 0.36],
    ] as const;
    const parts: THREE.BufferGeometry[] = [];
    const append = (
      geometry: THREE.BufferGeometry,
      position: THREE.Vector3,
      scale: THREE.Vector3,
      rotation = new THREE.Euler(),
    ): void => {
      const normalized = geometry.index ? geometry.toNonIndexed() : geometry;
      if (normalized !== geometry) geometry.dispose();
      normalized.applyMatrix4(new THREE.Matrix4().compose(
        position,
        new THREE.Quaternion().setFromEuler(rotation),
        scale,
      ));
      parts.push(normalized);
    };
    for (const side of [-1, 1]) {
      append(
        this.createArchitecturalLoftGeometry(footprint, [
          { y: -0.5, scaleX: 1.08, scaleZ: 1.06 },
          { y: -0.22, scaleX: 0.88, scaleZ: 0.92, shiftX: side * -0.04 },
          { y: 0.28, scaleX: 0.68, scaleZ: 0.76, shiftX: side * -0.13, rotation: side * -0.05 },
          { y: 0.5, scaleX: 0.84, scaleZ: 0.86, shiftX: side * -0.18, rotation: side * -0.08 },
        ], 4),
        new THREE.Vector3(side * 8.7, 20.2, 0),
        new THREE.Vector3(4.4, 37.5, 5.1),
        new THREE.Euler(0, side * -Math.PI / 10, 0),
      );
      append(
        this.createAsymmetricFinGeometry(),
        new THREE.Vector3(side * 6.3, 34.2, 0),
        new THREE.Vector3(2, 15.5, 3.4),
        new THREE.Euler(0, side * -0.08, side * 0.46),
      );
      append(
        this.createAsymmetricFinGeometry(),
        new THREE.Vector3(side * 10.9, 41.6, 0),
        new THREE.Vector3(1.7, 9.2, 3.6),
        new THREE.Euler(0, side * 0.08, side * -0.17),
      );
    }
    append(
      this.createArchitecturalLoftGeometry(
        [[-0.5, -0.5], [0.5, -0.44], [0.48, 0.4], [0.1, 0.5], [-0.5, 0.34]],
        [
          { y: -0.5, scaleX: 0.92, scaleZ: 0.84 },
          { y: 0.2, scaleX: 1, scaleZ: 1 },
          { y: 0.5, scaleX: 0.94, scaleZ: 0.9 },
        ],
        2.2,
      ),
      new THREE.Vector3(0, 38, 0),
      new THREE.Vector3(21.4, 2.3, 5.2),
    );
    append(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.Vector3(0, 34.5, 1.4),
      new THREE.Vector3(15.5, 0.72, 2),
    );
    const merged = mergeGeometries(parts, false);
    if (!merged) throw new Error('QuickSense could not merge north grapple gate geometry.');
    for (const part of parts) part.dispose();
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }

  private createIntegratedCliffHabitats(
    sideMaterial: THREE.MeshStandardMaterial,
    _whiteMaterial: THREE.MeshStandardMaterial,
    cyanMaterial: THREE.MeshStandardMaterial,
    magentaMaterial: THREE.MeshStandardMaterial,
    amberMaterial: THREE.MeshStandardMaterial,
    rockMaterial: THREE.MeshStandardMaterial,
    _mossMaterial: THREE.MeshStandardMaterial,
  ): void {
    const specs = CLIFF_HABITAT_SPECS;
    // Mountain architecture needs to separate from both the pale riding deck
    // and the blue-grey cliff.  These are material variants of the authored
    // panel surface, so they retain the same UV/bump/roughness language while
    // gaining the graphite massing and restrained gunmetal trim of the target
    // concept.
    const habitatShellMaterial = sideMaterial.clone();
    habitatShellMaterial.name = 'QuickSense cliff habitat graphite shell';
    habitatShellMaterial.color.setHex(0x627178);
    habitatShellMaterial.metalness = 0.2;
    habitatShellMaterial.roughness = 0.74;
    // Clone the textured architectural material rather than the untextured
    // white trim. The old pale plates read as detached white kitbash pieces
    // in shadow; this medium gunmetal keeps the same procedural panel grain
    // as the occupied shell and separates through value, not glare.
    const habitatArmorMaterial = sideMaterial.clone();
    habitatArmorMaterial.name = 'QuickSense cliff habitat gunmetal armor';
    habitatArmorMaterial.color.setHex(0x839095);
    habitatArmorMaterial.metalness = 0.28;
    habitatArmorMaterial.roughness = 0.62;
    const habitatFoundationMaterial = sideMaterial.clone();
    habitatFoundationMaterial.name = 'QuickSense cliff habitat retaining foundations';
    habitatFoundationMaterial.color.setHex(0x59676b);
    habitatFoundationMaterial.metalness = 0.18;
    habitatFoundationMaterial.roughness = 0.82;
    const habitatRockMaterial = rockMaterial.clone();
    habitatRockMaterial.name = 'QuickSense cliff habitat carved support rock';
    habitatRockMaterial.color.setHex(0x405058);
    habitatRockMaterial.roughness = 0.98;
    habitatRockMaterial.metalness = 0;
    this.materials.push(
      habitatShellMaterial,
      habitatArmorMaterial,
      habitatFoundationMaterial,
      habitatRockMaterial,
    );
    const rockShoulders: InstanceTransform[] = [];
    const retainingFoundations: InstanceTransform[] = [];
    const groundedFootings: InstanceTransform[] = [];
    const entryTerraces: InstanceTransform[] = [];
    const portalDepths: InstanceTransform[] = [];
    const windowSignals: Record<AccentRole, InstanceTransform[]> = { cyan: [], magenta: [], amber: [] };
    const amberArchitectureTrim: InstanceTransform[] = [];
    const windowCavities: InstanceTransform[] = [];
    const facadeMullions: InstanceTransform[] = [];
    const portalMaterial = this.material('QuickSense inhabited portal interior', 0x071116, 0.08, 0.92);
    const habitatAccentMaterials: Record<AccentRole, THREE.MeshStandardMaterial> = {
      cyan: cyanMaterial.clone(),
      magenta: magentaMaterial.clone(),
      amber: amberMaterial.clone(),
    };
    const habitatAccentValues: Record<AccentRole, { color: number; emissive: number }> = {
      cyan: { color: 0x239eb3, emissive: 0x11839b },
      magenta: { color: 0xa96846, emissive: 0x7f4028 },
      amber: { color: 0xb57a2b, emissive: 0x8c5617 },
    };
    for (const role of ['cyan', 'magenta', 'amber'] as const) {
      const material = habitatAccentMaterials[role];
      material.name = `QuickSense ${role} inhabited architectural light`;
      material.color.setHex(habitatAccentValues[role].color);
      material.emissive.setHex(habitatAccentValues[role].emissive);
      material.emissiveIntensity = 0.34;
      material.toneMapped = true;
      this.materials.push(material);
    }

    for (const spec of specs) {
      const bottomY = spec.roofY - spec.height;
      const plinthHeight = THREE.MathUtils.clamp(spec.height * 0.22, 2.4, 3.4);
      const portalCenterX = habitatPortalOffset(spec.signature) * spec.width;
      const supportSamples = [
        [-spec.width * 0.4, -spec.depth * 0.28],
        [spec.width * 0.4, -spec.depth * 0.28],
        [-spec.width * 0.34, spec.depth * 0.26],
        [spec.width * 0.34, spec.depth * 0.26],
        [portalCenterX, -spec.depth * 0.62],
      ] as const;
      const supportHeights = supportSamples.map(([localX, localZ]) => {
        const point = this.localOffset(spec.x, 0, spec.z, localX, localZ, spec.yaw);
        return this.terrainHeightAt(point.x, point.z);
      });
      const supportBaseY = Math.min(...supportHeights) - 0.75;
      const foundationTopY = bottomY + plinthHeight * 0.72;
      const foundationHeight = Math.max(4.2, foundationTopY - supportBaseY);
      const shoulderTopY = spec.roofY + Math.max(5.5, spec.height * 0.38);
      const shoulderHeight = shoulderTopY - supportBaseY;
      this.registerBuilding(
        spec.name,
        'cliff-habitat',
        `${spec.family}:${spec.signature}`,
        spec.accent,
        new THREE.Vector3(spec.x, bottomY + spec.height * 0.52, spec.z),
      );

      const shell = this.addMesh(
        this.createMountainHabitatGeometry(spec, false),
        habitatShellMaterial,
        `QuickSense ${spec.name} unified architectural shell`,
        new THREE.Vector3(spec.x, bottomY, spec.z),
      );
      shell.rotation.y = spec.yaw;
      const armor = this.addMesh(
        this.createMountainHabitatGeometry(spec, true),
        habitatArmorMaterial,
        `QuickSense ${spec.name} unified armor and silhouette`,
        new THREE.Vector3(spec.x, bottomY, spec.z),
      );
      armor.rotation.y = spec.yaw;

      // All facade dressing sits inside the front structural plane. The old
      // -0.565 depth placed the portal metres in front of the bunker and made
      // it look like a floating sticker from oblique gameplay views.
      const frontDepth = -spec.depth * 0.492;
      const portalCenterY = bottomY + Math.max(2.2, spec.height * 0.21);
      portalDepths.push({
        position: this.localOffset(spec.x, portalCenterY, spec.z, portalCenterX, frontDepth, spec.yaw),
        scale: new THREE.Vector3(spec.width * 0.2, spec.height * 0.26, 0.48),
        yaw: spec.yaw + Math.PI,
      });
      // The entrance light is assembled from attached strips below.  The old
      // single ShapeGeometry outline was coplanar with several stepped shells
      // and read as a loose glowing wave instead of a door frame.

      const occupiedHeight = spec.height - plinthHeight;
      const occupiedBottomY = bottomY + plinthHeight;
      // Every window has an authored facade depth.  Side wings are deliberately
      // set back from the main occupied mass; forcing all lights onto one front
      // plane made them float metres in front of those wings.
      const windowLayouts: Record<HabitatSignature, ReadonlyArray<readonly [number, number, number, number]>> = {
        'twin-stack': [[-0.25, 0.54, 0.2, -0.472], [0.08, 0.54, 0.15, -0.472], [0.32, 0.4, 0.11, -0.405]],
        'bridge-crane': [[-0.29, 0.38, 0.15, -0.375], [0.03, 0.54, 0.19, -0.472], [0.31, 0.54, 0.13, -0.472]],
        'halo-dome': [[-0.25, 0.47, 0.17, -0.455], [0, 0.55, 0.13, -0.462], [0.25, 0.47, 0.17, -0.455]],
        'split-dish': [[-0.31, 0.39, 0.13, -0.374], [0, 0.58, 0.15, -0.468], [0.31, 0.41, 0.13, -0.374]],
        'fork-mast': [[-0.22, 0.45, 0.18, -0.425], [0.18, 0.53, 0.18, -0.42]],
        'signal-spire': [[-0.31, 0.35, 0.16, -0.425], [0, 0.49, 0.18, -0.365], [0.29, 0.63, 0.14, -0.285]],
        'cross-array': [[-0.31, 0.39, 0.15, -0.37], [0, 0.57, 0.15, -0.468], [0.3, 0.47, 0.15, -0.385]],
        'split-fin': [[-0.25, 0.46, 0.17, -0.398], [0.24, 0.59, 0.17, -0.398]],
      };
      for (const [windowX, windowY, windowWidth, windowDepth] of windowLayouts[spec.signature]) {
        const position = this.localOffset(
          spec.x,
          occupiedBottomY + occupiedHeight * windowY,
          spec.z,
          spec.width * windowX,
          spec.depth * (windowDepth - 0.008),
          spec.yaw,
        );
        windowCavities.push({
          position: this.localOffset(
            spec.x,
            occupiedBottomY + occupiedHeight * windowY,
            spec.z,
            spec.width * windowX,
            spec.depth * (windowDepth + 0.002),
            spec.yaw,
          ),
          scale: new THREE.Vector3(spec.width * windowWidth * 1.13, occupiedHeight * 0.17, 0.42),
          yaw: spec.yaw,
        });
        windowSignals[spec.accent].push({
          position,
          scale: new THREE.Vector3(spec.width * windowWidth, occupiedHeight * 0.082, 0.2),
          yaw: spec.yaw,
        });
        const mullionCount = windowWidth >= 0.18 ? 2 : 1;
        for (let mullion = 0; mullion < mullionCount; mullion += 1) {
          const fraction = mullionCount === 1 ? 0 : mullion === 0 ? -0.26 : 0.26;
          facadeMullions.push({
            position: this.localOffset(
              spec.x,
              occupiedBottomY + occupiedHeight * windowY,
              spec.z,
              spec.width * (windowX + windowWidth * fraction),
              spec.depth * (windowDepth - 0.012),
              spec.yaw,
            ),
            scale: new THREE.Vector3(0.11, occupiedHeight * 0.13, 0.23),
            yaw: spec.yaw,
          });
        }
      }

      // A five-piece luminous frame is physically keyed into the entrance
      // jambs.  It remains legible from racing distance without becoming a
      // billboard or a detached neon decal.
      const portalHalfWidth = spec.width * 0.095;
      // Keep the signal frame just proud of the portal shell.  The previous
      // offset put the whole frame a visible step in front of the occupied
      // mass when viewed from the side.
      const portalFrameDepth = frontDepth - 0.015;
      for (const side of [-1, 1]) {
        windowSignals[spec.accent].push({
          position: this.localOffset(
            spec.x,
            portalCenterY - spec.height * 0.035,
            spec.z,
            portalCenterX + side * portalHalfWidth,
            portalFrameDepth,
            spec.yaw,
          ),
          scale: new THREE.Vector3(0.14, spec.height * 0.205, 0.2),
          yaw: spec.yaw,
        });
        windowSignals[spec.accent].push({
          position: this.localOffset(
            spec.x,
            portalCenterY + spec.height * 0.115,
            spec.z,
            portalCenterX + side * spec.width * 0.061,
            portalFrameDepth,
            spec.yaw,
          ),
          scale: new THREE.Vector3(spec.width * 0.082, 0.14, 0.2),
          rotation: new THREE.Euler(0, spec.yaw, side * -0.53),
        });
      }
      windowSignals[spec.accent].push({
        position: this.localOffset(
          spec.x,
          portalCenterY + spec.height * 0.156,
          spec.z,
          portalCenterX,
          portalFrameDepth,
          spec.yaw,
        ),
        scale: new THREE.Vector3(spec.width * 0.075, 0.14, 0.2),
        yaw: spec.yaw,
      });
      facadeMullions.push(
        {
          position: this.localOffset(spec.x, portalCenterY - spec.height * 0.055, spec.z, portalCenterX, portalFrameDepth - 0.01, spec.yaw),
          scale: new THREE.Vector3(0.13, spec.height * 0.18, 0.24),
          yaw: spec.yaw,
        },
        {
          position: this.localOffset(spec.x, portalCenterY - spec.height * 0.02, spec.z, portalCenterX, portalFrameDepth - 0.012, spec.yaw),
          scale: new THREE.Vector3(spec.width * 0.175, 0.12, 0.24),
          yaw: spec.yaw,
        },
      );
      const addRoofDatum = (localX: number, y: number, localZ: number, datumWidth: number): void => {
        amberArchitectureTrim.push({
          position: this.localOffset(spec.x, y + 0.12, spec.z, localX, localZ - 0.08, spec.yaw),
          scale: new THREE.Vector3(datumWidth, 0.2, 0.26),
          yaw: spec.yaw,
        });
      };
      if (spec.signature === 'twin-stack') {
        addRoofDatum(-spec.width * 0.16, spec.roofY + 0.82, -spec.depth * 0.34, spec.width * 0.53);
      } else if (spec.signature === 'bridge-crane') {
        addRoofDatum(spec.width * 0.14, spec.roofY + 0.84, -spec.depth * 0.33, spec.width * 0.56);
      } else if (spec.signature === 'halo-dome') {
        addRoofDatum(0, spec.roofY + 0.85, -spec.depth * 0.285, spec.width * 0.61);
      } else if (spec.signature === 'split-dish') {
        for (const [index, side] of [-1, 1].entries()) {
          const wingHeight = occupiedHeight * (index === 0 ? 0.62 : 0.72);
          addRoofDatum(side * spec.width * 0.3, bottomY + plinthHeight + wingHeight + 0.84, -spec.depth * 0.27, spec.width * 0.29);
        }
      } else if (spec.signature === 'fork-mast') {
        addRoofDatum(0, bottomY + plinthHeight + occupiedHeight * 0.82 + 0.73, -spec.depth * 0.26, spec.width * 0.59);
      } else if (spec.signature === 'signal-spire') {
        addRoofDatum(spec.width * 0.08, spec.roofY + 0.75, -spec.depth * 0.22, spec.width * 0.4);
      } else if (spec.signature === 'cross-array') {
        addRoofDatum(0, spec.roofY + 0.81, -spec.depth * 0.3, spec.width * 0.33);
      } else {
        for (const [index, side] of [-1, 1].entries()) {
          const hallHeight = occupiedHeight * (index === 0 ? 0.72 : 0.88);
          addRoofDatum(side * spec.width * 0.22, bottomY + plinthHeight + hallHeight + 0.6, -spec.depth * 0.3, spec.width * 0.34);
        }
      }

      // One restrained, physically attached machinery light makes each roof
      // signature legible from the arena without turning the building into a
      // neon prop. These transforms sit on the authored machinery itself.
      const addMachinerySignal = (
        role: AccentRole,
        localX: number,
        y: number,
        localZ: number,
        scale: THREE.Vector3,
        yaw = spec.yaw,
      ): void => {
        windowSignals[role].push({
          position: this.localOffset(spec.x, y, spec.z, localX, localZ, spec.yaw),
          scale,
          yaw,
        });
      };
      if (spec.signature === 'twin-stack') {
        for (const side of [-1, 1]) {
          addMachinerySignal(
            spec.accent,
            -spec.width * 0.16 + side * spec.width * 0.15,
            spec.roofY + 2.8 + (side > 0 ? 0.25 : 0),
            -spec.depth * 0.045,
            new THREE.Vector3(0.14, 2.2, 0.16),
          );
        }
      } else if (spec.signature === 'bridge-crane') {
        addMachinerySignal('amber', 0, spec.roofY + 4.55, -spec.depth * 0.245, new THREE.Vector3(spec.width * 0.5, 0.16, 0.18));
      } else if (spec.signature === 'halo-dome') {
        addMachinerySignal(spec.accent, 0, spec.roofY + 0.92, -spec.depth * 0.22, new THREE.Vector3(spec.width * 0.36, 0.16, 0.2));
      } else if (spec.signature === 'split-dish') {
        for (const [index, side] of [-1, 1].entries()) {
          const wingHeight = occupiedHeight * (index === 0 ? 0.62 : 0.72);
          addMachinerySignal(
            spec.accent,
            side * spec.width * 0.3,
            bottomY + plinthHeight + wingHeight + 1.75,
            -spec.depth * 0.06,
            new THREE.Vector3(spec.width * 0.13, 0.16, 0.18),
          );
        }
      } else if (spec.signature === 'fork-mast') {
        addMachinerySignal(spec.accent, 0, spec.roofY + 3.85, -spec.depth * 0.055, new THREE.Vector3(spec.width * 0.42, 0.15, 0.18));
      } else if (spec.signature === 'signal-spire') {
        addMachinerySignal(spec.accent, spec.width * 0.08, spec.roofY + 3.05, -spec.depth * 0.08, new THREE.Vector3(0.16, 2.5, 0.18));
      } else if (spec.signature === 'cross-array') {
        addMachinerySignal(spec.accent, 0, spec.roofY + 3.02, -spec.depth * 0.055, new THREE.Vector3(spec.width * 0.46, 0.15, 0.18));
        addMachinerySignal(spec.accent, 0, spec.roofY + 3.02, -spec.depth * 0.055, new THREE.Vector3(spec.width * 0.36, 0.15, 0.18), spec.yaw + Math.PI * 0.5);
      } else {
        for (const side of [-1, 1]) {
          addMachinerySignal(spec.accent, side * spec.width * 0.22, spec.roofY + 2.6 + side * 0.3, -spec.depth * 0.055, new THREE.Vector3(0.15, 2.0, 0.18));
        }
      }

      // A deep retaining socket overlaps both the carved rock and the occupied
      // body. It is deliberately broad and heavy: from the arena the facility
      // now has an obvious load path into the mountain instead of a dark gap.
      retainingFoundations.push({
        position: this.localOffset(
          spec.x,
          supportBaseY + foundationHeight * 0.5,
          spec.z,
          0,
          spec.depth * 0.025,
          spec.yaw,
        ),
        scale: new THREE.Vector3(spec.width * 1.06, foundationHeight, spec.depth * 0.9),
        yaw: spec.yaw,
      });
      for (const [supportIndex, localX] of [-spec.width * 0.36, spec.width * 0.36].entries()) {
        const localZ = supportIndex === 0 ? -spec.depth * 0.29 : -spec.depth * 0.24;
        const supportPoint = this.localOffset(spec.x, 0, spec.z, localX, localZ, spec.yaw);
        const terrainY = this.terrainHeightAt(supportPoint.x, supportPoint.z) - 0.45;
        const footingTopY = bottomY + plinthHeight * (supportIndex === 0 ? 0.66 : 0.78);
        const footingHeight = Math.max(2.6, footingTopY - terrainY);
        groundedFootings.push({
          position: this.localOffset(
            spec.x,
            terrainY + footingHeight * 0.5,
            spec.z,
            localX,
            localZ,
            spec.yaw,
          ),
          scale: new THREE.Vector3(spec.width * 0.24, footingHeight, spec.depth * 0.36),
          rotation: new THREE.Euler(0, spec.yaw + (supportIndex === 0 ? -0.035 : 0.04), supportIndex === 0 ? -0.035 : 0.045),
        });
      }

      // Three overlapping armored terraces bridge the carved forecourt to the
      // sealed portal. Each step grows down into the sampled terrain, so the
      // entrance reads as part of the mountain instead of a facade hovering
      // above it.
      for (let terraceIndex = 0; terraceIndex < 3; terraceIndex += 1) {
        const progress = (terraceIndex + 1) / 3;
        const localZ = THREE.MathUtils.lerp(-spec.depth * 0.76, -spec.depth * 0.49, progress);
        const terracePoint = this.localOffset(spec.x, 0, spec.z, portalCenterX, localZ, spec.yaw);
        const terraceWidth = spec.width * (0.32 - terraceIndex * 0.025);
        const terraceDepth = spec.depth * 0.16;
        const terraceHalfWidth = terraceWidth * 0.5;
        const terraceHalfDepth = terraceDepth * 0.5;
        const terrainSamples = [-terraceHalfWidth, 0, terraceHalfWidth].flatMap((localXOffset) =>
          [-terraceHalfDepth, terraceHalfDepth].map((localZOffset) => {
            const samplePoint = this.localOffset(
              spec.x,
              0,
              spec.z,
              portalCenterX + localXOffset,
              localZ + localZOffset,
              spec.yaw,
            );
            return this.terrainHeightAt(samplePoint.x, samplePoint.z);
          }),
        );
        const terrainY = Math.min(...terrainSamples) - 0.35;
        const terraceTopY = Math.max(
          THREE.MathUtils.lerp(bottomY - 1.15, bottomY + 0.95, progress),
          terrainY + 0.22,
        );
        const terraceHeight = Math.max(0.8, terraceTopY - terrainY);
        entryTerraces.push({
          position: this.localOffset(
            spec.x,
            terrainY + terraceHeight * 0.5,
            spec.z,
            portalCenterX,
            localZ,
            spec.yaw,
          ),
          scale: new THREE.Vector3(terraceWidth, terraceHeight, terraceDepth),
          yaw: spec.yaw,
        });
        const terraceCosine = Math.abs(Math.cos(spec.yaw));
        const terraceSine = Math.abs(Math.sin(spec.yaw));
        const terraceHalfX = (terraceWidth * terraceCosine + terraceDepth * terraceSine) * 0.5;
        const terraceHalfZ = (terraceWidth * terraceSine + terraceDepth * terraceCosine) * 0.5;
        this.platformSurfaces.push({
          name: `QuickSense ${spec.name} connected entry terrace ${terraceIndex + 1}`,
          minX: terracePoint.x - terraceHalfX,
          maxX: terracePoint.x + terraceHalfX,
          minZ: terracePoint.z - terraceHalfZ,
          maxZ: terracePoint.z + terraceHalfZ,
          y: terraceTopY,
        });
        this.shotBoxes.push(new THREE.Box3(
          new THREE.Vector3(terracePoint.x - terraceHalfX, terraceTopY - 0.22, terracePoint.z - terraceHalfZ),
          new THREE.Vector3(terracePoint.x + terraceHalfX, terraceTopY + 0.08, terracePoint.z + terraceHalfZ),
        ));
      }
      for (const side of [-1, 1]) {
        rockShoulders.push({
          position: this.localOffset(
            spec.x,
            supportBaseY + shoulderHeight * 0.43,
            spec.z,
            side * spec.width * 0.51,
            spec.depth * 0.31,
            spec.yaw,
          ),
          scale: new THREE.Vector3(spec.width * 0.29, shoulderHeight * 0.86, spec.depth * 0.7),
          rotation: new THREE.Euler(side * 0.05, spec.yaw + side * 0.16, side * 0.1),
        });
      }

      type HabitatRoofDeck = { localX: number; localZ: number; width: number; depth: number; y: number };
      const roofDecks: HabitatRoofDeck[] = [];
      const pushDeck = (localX: number, localZ: number, width: number, deckDepth: number, y: number): void => {
        roofDecks.push({ localX, localZ, width, depth: deckDepth, y });
      };
      if (spec.signature === 'twin-stack') {
        pushDeck(-spec.width * 0.16, -spec.depth * 0.08, spec.width * 0.53, spec.depth * 0.52, spec.roofY + 0.79);
      } else if (spec.signature === 'bridge-crane') {
        pushDeck(spec.width * 0.14, -spec.depth * 0.08, spec.width * 0.56, spec.depth * 0.5, spec.roofY + 0.8);
        pushDeck(-spec.width * 0.32, -spec.depth * 0.08, spec.width * 0.28, spec.depth * 0.42, bottomY + plinthHeight + occupiedHeight * 0.65 + 0.64);
      } else if (spec.signature === 'halo-dome') {
        pushDeck(0, -spec.depth * 0.03, spec.width * 0.61, spec.depth * 0.5, spec.roofY + 0.81);
      } else if (spec.signature === 'split-dish') {
        pushDeck(0, -spec.depth * 0.06, spec.width * 0.27, spec.depth * 0.5, spec.roofY + 0.77);
        for (const [index, side] of [-1, 1].entries()) {
          const wingHeight = occupiedHeight * (index === 0 ? 0.62 : 0.72);
          pushDeck(side * spec.width * 0.3, -spec.depth * 0.06, spec.width * 0.29, spec.depth * 0.42, bottomY + plinthHeight + wingHeight + 0.81);
        }
      } else if (spec.signature === 'fork-mast') {
        pushDeck(0, -spec.depth * 0.04, spec.width * 0.59, spec.depth * 0.44, bottomY + plinthHeight + occupiedHeight * 0.82 + 0.69);
      } else if (spec.signature === 'signal-spire') {
        pushDeck(spec.width * 0.08, -spec.depth * 0.04, spec.width * 0.4, spec.depth * 0.36, spec.roofY + 0.71);
        pushDeck(-spec.width * 0.06, -spec.depth * 0.08, spec.width * 0.58, spec.depth * 0.48, bottomY + plinthHeight + occupiedHeight * 0.76 + 0.6);
      } else if (spec.signature === 'cross-array') {
        pushDeck(0, -spec.depth * 0.05, spec.width * 0.33, spec.depth * 0.5, spec.roofY + 0.77);
        for (const side of [-1, 1]) {
          const wingRatio = side < 0 ? 0.72 : 0.62;
          pushDeck(side * spec.width * 0.31, -spec.depth * 0.08, spec.width * 0.29, spec.depth * 0.42, bottomY + plinthHeight + occupiedHeight * wingRatio + 0.6);
        }
      } else {
        for (const [index, side] of [-1, 1].entries()) {
          const hallHeight = occupiedHeight * (index === 0 ? 0.72 : 0.88);
          pushDeck(side * spec.width * 0.22, -spec.depth * 0.08, spec.width * 0.34, spec.depth * 0.44, bottomY + plinthHeight + hallHeight + 0.56);
        }
      }
      for (const [deckIndex, deck] of roofDecks.entries()) {
        const center = this.localOffset(spec.x, deck.y, spec.z, deck.localX, deck.localZ, spec.yaw);
        const cosine = Math.abs(Math.cos(spec.yaw));
        const sine = Math.abs(Math.sin(spec.yaw));
        const halfX = (deck.width * cosine + deck.depth * sine) * 0.5;
        const halfZ = (deck.width * sine + deck.depth * cosine) * 0.5;
        this.platformSurfaces.push({
          name: `QuickSense ${spec.name} authored roof deck ${deckIndex + 1}`,
          minX: center.x - halfX,
          maxX: center.x + halfX,
          minZ: center.z - halfZ,
          maxZ: center.z + halfZ,
          y: deck.y,
        });
        this.shotBoxes.push(new THREE.Box3(
          new THREE.Vector3(center.x - halfX, deck.y - 0.22, center.z - halfZ),
          new THREE.Vector3(center.x + halfX, deck.y + 0.12, center.z + halfZ),
        ));
      }

      // Entrances are sealed occupied doors, not traversable holes.  The
      // collision therefore follows the complete inhabited shell instead of a
      // fictitious lintel several metres above the visible portal.
      this.registerBoxCollision(
        `QuickSense ${spec.name} sealed inhabited shell`,
        this.localOffset(spec.x, bottomY + spec.height * 0.5, spec.z, 0, -spec.depth * 0.02, spec.yaw),
        new THREE.Vector3(spec.width * 0.96, spec.height, spec.depth * 0.82),
        spec.yaw,
      );
      this.registerBoxCollision(
        `QuickSense ${spec.name} retaining plinth`,
        this.localOffset(spec.x, supportBaseY + foundationHeight * 0.5, spec.z, 0, spec.depth * 0.025, spec.yaw),
        new THREE.Vector3(spec.width, foundationHeight, spec.depth * 0.82),
        spec.yaw,
      );
    }

    this.addInstancedMeshes(
      'QuickSense mountain habitat integrated rock shoulders',
      new THREE.IcosahedronGeometry(0.5, 1),
      habitatRockMaterial,
      rockShoulders,
    );
    this.addInstancedMeshes(
      'QuickSense mountain habitat retaining foundation sockets',
      this.createArchitecturalLoftGeometry(
        [[-0.5, -0.42], [-0.34, -0.5], [0.34, -0.5], [0.5, -0.42], [0.47, 0.5], [-0.47, 0.5]],
        [
          { y: -0.5, scaleX: 1.08, scaleZ: 1.06 },
          { y: -0.18, scaleX: 1.02, scaleZ: 1 },
          { y: 0.5, scaleX: 0.9, scaleZ: 0.88 },
        ],
        2,
      ),
      habitatFoundationMaterial,
      retainingFoundations,
    );
    this.addInstancedMeshes(
      'QuickSense mountain habitat grounded load-bearing feet',
      this.createCliffButtressGeometry(),
      habitatFoundationMaterial,
      groundedFootings,
    );
    this.addInstancedMeshes(
      'QuickSense mountain habitat connected entry terraces',
      this.createChamferedBlockGeometry(0.1),
      habitatFoundationMaterial,
      entryTerraces,
    );
    this.addInstancedMeshes(
      'QuickSense mountain habitat deep portal interiors',
      this.createPortalOpeningGeometry(),
      portalMaterial,
      portalDepths,
      false,
    );
    this.addInstancedMeshes(
      'QuickSense mountain habitat recessed window cavities',
      new THREE.BoxGeometry(1, 1, 1),
      portalMaterial,
      windowCavities,
      false,
    );
    this.addInstancedMeshes(
      'QuickSense mountain habitat structural facade mullions',
      new THREE.BoxGeometry(1, 1, 1),
      habitatArmorMaterial,
      facadeMullions,
    );

    const addFactionBatch = (
      name: string,
      geometry: THREE.BufferGeometry,
      batches: Record<AccentRole, InstanceTransform[]>,
    ): void => {
      for (const role of ['cyan', 'magenta', 'amber'] as const) {
        this.addInstancedMeshes(
          `${name} ${role}`,
          geometry,
          habitatAccentMaterials[role],
          batches[role],
          false,
        );
      }
    };
    addFactionBatch(
      'QuickSense mountain habitat recessed window lights',
      new THREE.BoxGeometry(1, 1, 1),
      windowSignals,
    );
    this.addInstancedMeshes(
      'QuickSense mountain habitat amber roof datum',
      new THREE.BoxGeometry(1, 1, 1),
      amberMaterial,
      amberArchitectureTrim,
      false,
    );
  }

  /**
   * Builds one cliff habitat as a small number of overlapping, load-bearing
   * architectural masses.  Every attachment either grows out of the roof or
   * keys into the main bunker; nothing is allowed to hover as decorative
   * kitbash clutter.  The shell and armor are returned separately so the
   * facade retains a clear graphite / gunmetal hierarchy at gameplay range.
   */
  private createMountainHabitatGeometry(
    spec: GroundBuildingSpec,
    armor: boolean,
  ): THREE.BufferGeometry {
    const { width, height, depth } = spec;
    const plinthHeight = THREE.MathUtils.clamp(height * 0.22, 2.4, 3.4);
    const occupiedHeight = height - plinthHeight;
    const occupiedCenterY = plinthHeight + occupiedHeight * 0.5;
    const portalX = habitatPortalOffset(spec.signature) * width;
    const portalLocalY = Math.max(2.2, height * 0.21);
    const parts: THREE.BufferGeometry[] = [];
    const append = (
      geometry: THREE.BufferGeometry,
      position: THREE.Vector3,
      scale: THREE.Vector3,
      rotation = new THREE.Euler(),
    ): void => {
      const normalized = geometry.index ? geometry.toNonIndexed() : geometry;
      if (normalized !== geometry) geometry.dispose();
      normalized.applyMatrix4(new THREE.Matrix4().compose(
        position,
        new THREE.Quaternion().setFromEuler(rotation),
        scale,
      ));
      parts.push(normalized);
    };
    const box = (
      x: number,
      y: number,
      z: number,
      sx: number,
      sy: number,
      sz: number,
      rotation = new THREE.Euler(),
    ): void => append(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.Vector3(x, y, z),
      new THREE.Vector3(sx, sy, sz),
      rotation,
    );
    const chamfer = (
      x: number,
      y: number,
      z: number,
      sx: number,
      sy: number,
      sz: number,
      amount = 0.12,
      rotation = new THREE.Euler(),
    ): void => append(
      this.createChamferedBlockGeometry(amount),
      new THREE.Vector3(x, y, z),
      new THREE.Vector3(sx, sy, sz),
      rotation,
    );
    const octagon: ReadonlyArray<readonly [number, number]> = [
      [-0.5, -0.28], [-0.32, -0.5], [0.32, -0.5], [0.5, -0.28],
      [0.5, 0.28], [0.32, 0.5], [-0.32, 0.5], [-0.5, 0.28],
    ];
    const wedge: ReadonlyArray<readonly [number, number]> = [
      [-0.5, -0.36], [-0.28, -0.5], [0.42, -0.46], [0.5, -0.14],
      [0.34, 0.5], [-0.42, 0.42],
    ];

    if (!armor) {
      // The lower wall is retaining architecture, not a stretched occupied
      // tower.  It forms the excavated shelf and carries the entrance pod.
      chamfer(0, plinthHeight * 0.5, -depth * 0.01, width * 0.98, plinthHeight, depth * 0.86, 0.1);
      chamfer(portalX, portalLocalY, -depth * 0.43, width * 0.27, Math.min(5.8, height * 0.27), depth * 0.13, 0.14);
      for (const side of [-1, 1]) {
        append(
          this.createCliffButtressGeometry(),
          new THREE.Vector3(side * width * 0.43, Math.max(3.6, plinthHeight * 0.54), -depth * 0.025),
          new THREE.Vector3(width * 0.16, Math.max(7.2, plinthHeight * 1.02), depth * 0.58),
          new THREE.Euler(0, side * 0.035, side * -0.025),
        );
      }

      // Each facility receives a different occupied silhouette, not a shared
      // bunker with a decorative roof hat.
      if (spec.signature === 'twin-stack') {
        append(
          this.createArchitecturalLoftGeometry(
            [[-0.5, -0.4], [-0.34, -0.5], [0.38, -0.47], [0.5, -0.18], [0.43, 0.5], [-0.44, 0.44]],
            [
              { y: -0.5, scaleX: 0.94, scaleZ: 0.92 },
              { y: -0.18, scaleX: 1, scaleZ: 1 },
              { y: 0.28, scaleX: 0.96, scaleZ: 0.94, shiftX: -0.02 },
              { y: 0.5, scaleX: 0.86, scaleZ: 0.82, shiftX: -0.055 },
            ],
            3,
          ),
          new THREE.Vector3(-width * 0.16, occupiedCenterY, -depth * 0.13),
          new THREE.Vector3(width * 0.6, occupiedHeight, depth * 0.68),
        );
        chamfer(width * 0.29, plinthHeight + occupiedHeight * 0.39, -depth * 0.12, width * 0.38, occupiedHeight * 0.76, depth * 0.58, 0.12);
        chamfer(-width * 0.16, height + 0.38, -depth * 0.08, width * 0.58, 0.76, depth * 0.58, 0.08);
        for (const side of [-1, 1]) {
          chamfer(-width * 0.16 + side * width * 0.15, height + 0.9, depth * 0.02, width * 0.12, 1.1, depth * 0.2, 0.12);
          append(
            new THREE.CylinderGeometry(0.82, 1, 1, 8),
            new THREE.Vector3(-width * 0.16 + side * width * 0.15, height + 2.75 + (side > 0 ? 0.3 : 0), depth * 0.02),
            new THREE.Vector3(width * 0.055, 3.6 + (side > 0 ? 0.6 : 0), width * 0.055),
          );
        }
      } else if (spec.signature === 'bridge-crane') {
        append(
          this.createArchitecturalLoftGeometry(
            [[-0.5, -0.3], [-0.36, -0.5], [0.4, -0.47], [0.5, -0.14], [0.38, 0.5], [-0.46, 0.42]],
            [
              { y: -0.5, scaleX: 0.92, scaleZ: 0.9 },
              { y: -0.16, scaleX: 1, scaleZ: 1 },
              { y: 0.32, scaleX: 0.96, scaleZ: 0.94, shiftX: 0.02 },
              { y: 0.5, scaleX: 0.82, scaleZ: 0.8, shiftX: 0.065 },
            ],
            3,
          ),
          new THREE.Vector3(width * 0.14, occupiedCenterY, -depth * 0.13),
          new THREE.Vector3(width * 0.64, occupiedHeight, depth * 0.68),
        );
        chamfer(-width * 0.32, plinthHeight + occupiedHeight * 0.34, -depth * 0.1, width * 0.36, occupiedHeight * 0.64, depth * 0.56, 0.12);
        chamfer(width * 0.14, height + 0.38, -depth * 0.08, width * 0.62, 0.76, depth * 0.58, 0.08);
      } else if (spec.signature === 'halo-dome') {
        append(
          this.createArchitecturalLoftGeometry(octagon, [
            { y: -0.5, scaleX: 1, scaleZ: 1 },
            { y: 0.5, scaleX: 0.86, scaleZ: 0.84 },
          ], 3),
          new THREE.Vector3(0, occupiedCenterY, -depth * 0.12),
          new THREE.Vector3(width * 0.72, occupiedHeight, depth * 0.68),
        );
        for (const side of [-1, 1]) {
          chamfer(side * width * 0.37, plinthHeight + occupiedHeight * 0.34, -depth * 0.09, width * 0.27, occupiedHeight * 0.58, depth * 0.48, 0.12);
        }
        chamfer(0, height + 0.36, -depth * 0.03, width * 0.7, 0.72, depth * 0.58, 0.1);
        append(
          new THREE.SphereGeometry(1, 14, 7, 0, Math.PI * 2, 0, Math.PI * 0.5),
          new THREE.Vector3(0, height + 0.72, -depth * 0.01),
          new THREE.Vector3(width * 0.23, occupiedHeight * 0.18, width * 0.23),
        );
      } else if (spec.signature === 'split-dish') {
        chamfer(0, plinthHeight + occupiedHeight * 0.51, -depth * 0.14, width * 0.34, occupiedHeight * 0.84, depth * 0.66, 0.1);
        for (const [index, side] of [-1, 1].entries()) {
          const wingHeight = occupiedHeight * (index === 0 ? 0.62 : 0.72);
          const wingRoofTop = plinthHeight + wingHeight + 0.82;
          chamfer(side * width * 0.3, plinthHeight + wingHeight * 0.5, -depth * 0.1, width * 0.38, wingHeight, depth * 0.56, 0.12);
          chamfer(side * width * 0.3, plinthHeight + wingHeight + 0.32, -depth * 0.05, width * 0.34, 0.64, depth * 0.48, 0.1);
          chamfer(side * width * 0.3, wingRoofTop + 1.65, -depth * 0.01, width * 0.12, 3.5, depth * 0.15, 0.1);
        }
      } else if (spec.signature === 'fork-mast') {
        append(
          this.createArchitecturalLoftGeometry(wedge, [
            { y: -0.5, scaleX: 1, scaleZ: 1 },
            { y: 0.5, scaleX: 0.78, scaleZ: 0.76, shiftX: -0.06 },
          ], 3),
          new THREE.Vector3(0, plinthHeight + occupiedHeight * 0.42, -depth * 0.11),
          new THREE.Vector3(width * 0.82, occupiedHeight * 0.8, depth * 0.64),
        );
        chamfer(0, plinthHeight + occupiedHeight * 0.8 + 0.34, -depth * 0.04, width * 0.7, 0.68, depth * 0.52, 0.1);
        chamfer(0, height + 2.2, 0, width * 0.13, 7.0, depth * 0.15, 0.1);
        for (const side of [-1, 1]) {
          box(side * width * 0.17, height + 3.75, 0, width * 0.26, 0.66, depth * 0.12, new THREE.Euler(0, 0, side * 0.28));
          chamfer(side * width * 0.27, height + 4.25, 0, width * 0.07, 1.4, depth * 0.12, 0.08, new THREE.Euler(0, 0, side * 0.08));
        }
      } else if (spec.signature === 'signal-spire') {
        chamfer(0, plinthHeight + occupiedHeight * 0.24, -depth * 0.1, width * 0.94, occupiedHeight * 0.46, depth * 0.66, 0.1);
        chamfer(-width * 0.06, plinthHeight + occupiedHeight * 0.54, -depth * 0.08, width * 0.74, occupiedHeight * 0.42, depth * 0.58, 0.1);
        chamfer(width * 0.08, plinthHeight + occupiedHeight * 0.82, -depth * 0.04, width * 0.52, occupiedHeight * 0.36, depth * 0.48, 0.1);
        chamfer(width * 0.08, height + 0.34, -depth * 0.02, width * 0.48, 0.68, depth * 0.42, 0.1);
        append(
          this.createArchitecturalLoftGeometry(octagon, [
            { y: -0.5, scaleX: 1, scaleZ: 1 },
            { y: 0.5, scaleX: 0.22, scaleZ: 0.24, shiftX: -0.08 },
          ], 2),
          new THREE.Vector3(width * 0.08, height + 3.1, 0),
          new THREE.Vector3(width * 0.17, 5.0, depth * 0.17),
        );
      } else if (spec.signature === 'cross-array') {
        chamfer(0, occupiedCenterY, -depth * 0.13, width * 0.42, occupiedHeight, depth * 0.68, 0.1);
        chamfer(-width * 0.31, plinthHeight + occupiedHeight * 0.37, -depth * 0.09, width * 0.37, occupiedHeight * 0.7, depth * 0.56, 0.12);
        chamfer(width * 0.31, plinthHeight + occupiedHeight * 0.32, -depth * 0.1, width * 0.37, occupiedHeight * 0.6, depth * 0.58, 0.12);
        chamfer(0, height + 0.38, -depth * 0.04, width * 0.4, 0.76, depth * 0.56, 0.1);
        append(new THREE.CylinderGeometry(1, 1.1, 1, 10), new THREE.Vector3(0, height + 1.65, 0), new THREE.Vector3(width * 0.14, 2.7, width * 0.14));
      } else {
        for (const [index, side] of [-1, 1].entries()) {
          const hallHeight = occupiedHeight * (index === 0 ? 0.72 : 0.88);
          append(
            this.createArchitecturalLoftGeometry(wedge, [
              { y: -0.5, scaleX: 1, scaleZ: 1 },
              { y: 0.5, scaleX: index === 0 ? 0.76 : 0.62, scaleZ: 0.72, shiftX: side * 0.05 },
            ], 3),
            new THREE.Vector3(side * width * 0.22, plinthHeight + hallHeight * 0.5, -depth * 0.1),
            new THREE.Vector3(width * 0.43, hallHeight, depth * 0.6),
            new THREE.Euler(0, side * 0.025, side * 0.02),
          );
          chamfer(side * width * 0.22, plinthHeight + hallHeight + 2.1, -depth * 0.02, width * 0.2, 3.8 + index * 0.8, depth * 0.2, 0.1, new THREE.Euler(0, 0, side * 0.035));
        }
        chamfer(0, plinthHeight + occupiedHeight * 0.44, -depth * 0.3, width * 0.32, occupiedHeight * 0.3, depth * 0.22, 0.12);
      }
    } else {
      const portalY = portalLocalY;
      append(
        this.createPortalFrameGeometry(),
        new THREE.Vector3(portalX, portalY, -depth * 0.486),
        new THREE.Vector3(width * 0.215, height * 0.29, 0.5),
      );
      // Only the entrance socket is shared.  The occupied armor below is
      // authored per facility so the primary mass, rather than a roof prop,
      // remains identifiable in silhouette.
      chamfer(
        portalX,
        plinthHeight * 0.74,
        -depth * 0.432,
        width * 0.3,
        plinthHeight * 0.74,
        depth * 0.17,
        0.12,
      );

      if (spec.signature === 'twin-stack') {
        chamfer(-width * 0.16, height + 0.38, -depth * 0.08, width * 0.59, 0.82, depth * 0.6, 0.08);
        for (const side of [-1, 1]) {
          box(-width * 0.16 + side * width * 0.145, height + 0.73, -depth * 0.08, width * 0.3, 0.48, depth * 0.55, new THREE.Euler(0, 0, side * -0.055));
        }
        chamfer(width * 0.29, plinthHeight + occupiedHeight * 0.76 + 0.34, -depth * 0.1, width * 0.37, 0.68, depth * 0.52, 0.08);
        for (const x of [-width * 0.445, width * 0.13]) {
          chamfer(x, plinthHeight + occupiedHeight * 0.5, -depth * 0.445, width * 0.035, occupiedHeight * 0.84, depth * 0.11, 0.08);
        }
        box(-width * 0.16, plinthHeight + occupiedHeight * 0.29, -depth * 0.475, width * 0.53, 0.34, depth * 0.11);
        for (const side of [-1, 1]) {
          append(
            new THREE.TorusGeometry(1, 0.13, 5, 16),
            new THREE.Vector3(-width * 0.16 + side * width * 0.15, height + 4.0 + (side > 0 ? 0.3 : 0), depth * 0.02),
            new THREE.Vector3(width * 0.065, width * 0.065, width * 0.065),
            new THREE.Euler(Math.PI * 0.5, 0, 0),
          );
        }
      } else if (spec.signature === 'bridge-crane') {
        chamfer(width * 0.14, height + 0.38, -depth * 0.08, width * 0.64, 0.84, depth * 0.6, 0.08);
        box(width * 0.14, height + 0.72, -depth * 0.08, width * 0.61, 0.5, depth * 0.54, new THREE.Euler(0, 0, -0.035));
        chamfer(-width * 0.32, plinthHeight + occupiedHeight * 0.65 + 0.32, -depth * 0.08, width * 0.35, 0.66, depth * 0.5, 0.08);
        for (const x of [-width * 0.49, width * 0.46]) {
          chamfer(x, plinthHeight + occupiedHeight * 0.44, -depth * 0.36, width * 0.045, occupiedHeight * 0.68, depth * 0.17, 0.08);
        }
        // Deep U-frame, trolley, and knee braces provide an unambiguous load
        // path.  Both legs overlap the roof instead of terminating in air.
        for (const side of [-1, 1]) {
          chamfer(side * width * 0.25, height + 2.45, -depth * 0.205, width * 0.095, 4.9, depth * 0.18, 0.08);
          box(side * width * 0.2, height + 1.4, -depth * 0.205, width * 0.18, 0.58, depth * 0.17, new THREE.Euler(0, 0, side * -0.56));
        }
        chamfer(0, height + 4.7, -depth * 0.205, width * 0.6, 0.78, depth * 0.21, 0.08);
        box(0, height + 4.25, depth * 0.06, width * 0.52, 0.48, depth * 0.16);
        chamfer(width * 0.18, height + 4.15, -depth * 0.235, width * 0.12, 1.0, depth * 0.2, 0.1);
      } else if (spec.signature === 'halo-dome') {
        chamfer(0, height + 0.4, -depth * 0.03, width * 0.73, 0.84, depth * 0.61, 0.08);
        for (const side of [-1, 1]) {
          chamfer(side * width * 0.345, plinthHeight + occupiedHeight * 0.47, -depth * 0.365, width * 0.045, occupiedHeight * 0.72, depth * 0.16, 0.08);
        }
        append(
          new THREE.TorusGeometry(1, 0.12, 6, 28),
          new THREE.Vector3(0, height + 2.65, -depth * 0.01),
          new THREE.Vector3(width * 0.27, width * 0.27, width * 0.27),
          new THREE.Euler(Math.PI * 0.42, -0.14, 0.14),
        );
        for (const side of [-1, 0, 1]) box(side * width * 0.16, height + 1.58, -depth * 0.01, 0.56, 2.2, 0.58, new THREE.Euler(0, 0, side * 0.16));
        for (const angle of [0, Math.PI * 0.5]) {
          box(0, height + 2.32, -depth * 0.01, width * 0.52, 0.38, 0.56, new THREE.Euler(0, angle, 0));
        }
      } else if (spec.signature === 'split-dish') {
        chamfer(0, height + 0.38, -depth * 0.06, width * 0.34, 0.8, depth * 0.59, 0.08);
        for (const [index, side] of [-1, 1].entries()) {
          const wingHeight = occupiedHeight * (index === 0 ? 0.62 : 0.72);
          const wingRoofTop = plinthHeight + wingHeight + 0.82;
          chamfer(side * width * 0.3, plinthHeight + wingHeight + 0.32, -depth * 0.06, width * 0.36, 0.64, depth * 0.5, 0.08);
          box(side * width * 0.3, plinthHeight + wingHeight + 0.62, -depth * 0.06, width * 0.34, 0.36, depth * 0.46, new THREE.Euler(0, 0, side * -0.045));
          chamfer(side * width * 0.3, wingRoofTop + 1.65, -depth * 0.01, width * 0.11, 3.35, depth * 0.14, 0.08);
          const dishRotation = new THREE.Euler(-0.5, side * 0.12, side * 0.22);
          append(
            new THREE.CylinderGeometry(1, 1, 1, 12),
            new THREE.Vector3(side * width * 0.3, wingRoofTop + 3.25, -depth * 0.02),
            new THREE.Vector3(width * 0.155, 0.42, width * 0.155),
            dishRotation,
          );
          box(side * width * 0.3, wingRoofTop + 3.55, -depth * 0.13, 0.48, 1.25, 0.48, dishRotation);
        }
      } else if (spec.signature === 'fork-mast') {
        chamfer(0, plinthHeight + occupiedHeight * 0.82 + 0.34, -depth * 0.04, width * 0.7, 0.72, depth * 0.54, 0.08);
        for (const side of [-1, 1]) {
          box(side * width * 0.17, plinthHeight + occupiedHeight * 0.82 + 0.65, -depth * 0.04, width * 0.35, 0.4, depth * 0.49, new THREE.Euler(0, 0, side * -0.05));
        }
        for (const side of [-1, 1]) {
          box(side * width * 0.3, plinthHeight + occupiedHeight * 0.44, -depth * 0.39, width * 0.045, occupiedHeight * 0.64, depth * 0.15, new THREE.Euler(0, 0, side * -0.14));
        }
        chamfer(0, height + 2.0, 0, width * 0.16, 6.5, depth * 0.18, 0.08);
      } else if (spec.signature === 'signal-spire') {
        chamfer(0, plinthHeight + occupiedHeight * 0.47 + 0.3, -depth * 0.1, width * 0.93, 0.64, depth * 0.67, 0.08);
        chamfer(-width * 0.06, plinthHeight + occupiedHeight * 0.76 + 0.3, -depth * 0.08, width * 0.72, 0.62, depth * 0.59, 0.08);
        chamfer(width * 0.08, height + 0.36, -depth * 0.04, width * 0.5, 0.72, depth * 0.47, 0.08);
        append(
          new THREE.TorusGeometry(1, 0.13, 6, 20),
          new THREE.Vector3(width * 0.08, height + 3.8, 0),
          new THREE.Vector3(2.65, 2.65, 2.65),
          new THREE.Euler(Math.PI * 0.5, 0, 0),
        );
      } else if (spec.signature === 'cross-array') {
        chamfer(0, height + 0.38, -depth * 0.05, width * 0.42, 0.8, depth * 0.59, 0.08);
        for (const side of [-1, 1]) {
          chamfer(side * width * 0.31, plinthHeight + occupiedHeight * (side < 0 ? 0.72 : 0.62) + 0.3, -depth * 0.08, width * 0.36, 0.62, depth * 0.51, 0.08);
          chamfer(side * width * 0.47, plinthHeight + occupiedHeight * 0.4, -depth * 0.34, width * 0.04, occupiedHeight * 0.58, depth * 0.15, 0.08);
        }
        for (const angle of [Math.PI * 0.25, Math.PI * 0.75]) {
          box(0, height + 3.0, 0, width * 0.62, 0.42, 0.62, new THREE.Euler(0, angle, 0));
        }
        append(new THREE.TorusGeometry(1, 0.1, 5, 20), new THREE.Vector3(0, height + 3.0, 0), new THREE.Vector3(2.1, 2.1, 2.1));
      } else {
        for (const side of [-1, 1]) {
          chamfer(side * width * 0.22, plinthHeight + occupiedHeight * (side < 0 ? 0.72 : 0.88) + 0.28, -depth * 0.08, width * 0.42, 0.58, depth * 0.55, 0.08);
          chamfer(side * width * 0.22, plinthHeight + occupiedHeight * 0.5, -depth * 0.39, width * 0.035, occupiedHeight * 0.66, depth * 0.14, 0.08, new THREE.Euler(0, 0, side * -0.08));
        }
      }
    }

    const merged = mergeGeometries(parts, false);
    if (!merged) throw new Error(`QuickSense could not merge ${spec.name} ${armor ? 'armor' : 'shell'} geometry.`);
    for (const part of parts) part.dispose();
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }

  private createFloatingStructures(
    sideMaterial: THREE.MeshStandardMaterial,
    whiteMaterial: THREE.MeshStandardMaterial,
    cyanMaterial: THREE.MeshStandardMaterial,
    _magentaMaterial: THREE.MeshStandardMaterial,
    amberMaterial: THREE.MeshStandardMaterial,
  ): void {
    const specs: FloatingBuildingSpec[] = [
      { name: 'Cyan Skydock', profile: 'skydock', x: -58, z: 23, y: 52, width: 26, height: 12, depth: 17, yaw: -0.24, accent: 'cyan' },
      { name: 'Magenta Needle Dock', profile: 'needle', x: 58, z: 23, y: 56, width: 22, height: 15, depth: 15, yaw: 0.24, accent: 'magenta' },
      { name: 'Amber Command Ark', profile: 'command', x: 0, z: 58, y: 66, width: 36, height: 15, depth: 23, yaw: 0, accent: 'amber' },
    ];
    const hulls: Record<FloatingBuildingProfile, InstanceTransform[]> = {
      skydock: [], needle: [], command: [],
    };
    const undercarriages: Record<FloatingBuildingProfile, InstanceTransform[]> = {
      skydock: [], needle: [], command: [],
    };
    const wingBlocks: InstanceTransform[] = [];
    const wingBraces: InstanceTransform[] = [];
    const crownCaps: InstanceTransform[] = [];
    const landingDecks: InstanceTransform[] = [];
    const landingRails: InstanceTransform[] = [];
    const whiteDetails: InstanceTransform[] = [];
    const accentPanels: Record<AccentRole, InstanceTransform[]> = { cyan: [], magenta: [], amber: [] };
    const thrusters: Record<AccentRole, InstanceTransform[]> = { cyan: [], magenta: [], amber: [] };
    const tethers: Record<AccentRole, InstanceTransform[]> = { cyan: [], magenta: [], amber: [] };
    const tetherAnchors: InstanceTransform[] = [];
    const rings: Record<AccentRole, InstanceTransform[]> = { cyan: [], magenta: [], amber: [] };
    const signalColors: Record<AccentRole, THREE.Color> = {
      cyan: cyanMaterial.color.clone(),
      magenta: new THREE.Color(0xa96846),
      amber: amberMaterial.color.clone(),
    };
    const factionSignalMaterial = new THREE.MeshBasicMaterial({
      name: 'QuickSense floating station signal material',
      color: 0xffffff,
      toneMapped: false,
    });
    this.materials.push(factionSignalMaterial);
    const addFactionBatch = (
      name: string,
      geometry: THREE.BufferGeometry,
      batches: ReadonlyArray<{ transforms: InstanceTransform[]; color: THREE.Color }>,
    ): void => {
      const transforms = batches.flatMap((batch) => batch.transforms);
      const mesh = this.addInstancedMeshes(name, geometry, factionSignalMaterial, transforms, false);
      if (!mesh) return;
      let instanceIndex = 0;
      for (const batch of batches) {
        for (let index = 0; index < batch.transforms.length; index += 1) {
          mesh.setColorAt(instanceIndex, batch.color);
          instanceIndex += 1;
        }
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    };

    for (const spec of specs) {
      this.registerBuilding(
        spec.name,
        'floating-station',
        spec.profile,
        spec.accent,
        new THREE.Vector3(spec.x, spec.y, spec.z),
      );
      const hullWidth = spec.profile === 'needle' ? 0.42 : spec.profile === 'command' ? 0.56 : 0.5;
      const hullHeight = spec.profile === 'needle' ? 1.18 : spec.profile === 'command' ? 1 : 0.92;
      const hullDepth = spec.profile === 'skydock' ? 0.58 : 0.52;
      hulls[spec.profile].push({
        position: new THREE.Vector3(spec.x, spec.y, spec.z),
        scale: new THREE.Vector3(spec.width * hullWidth, spec.height * hullHeight, spec.depth * hullDepth),
        yaw: spec.yaw,
      });
      undercarriages[spec.profile].push({
        position: new THREE.Vector3(spec.x, spec.y - spec.height * 0.76, spec.z),
        scale: new THREE.Vector3(
          spec.width * (spec.profile === 'command' ? 0.76 : 0.68),
          spec.height * (spec.profile === 'needle' ? 1.62 : 1.28),
          spec.depth * 0.68,
        ),
        yaw: spec.yaw,
      });
      for (const side of [-1, 1]) {
        const wingScale = spec.profile === 'command'
          ? (side > 0 ? 0.5 : 0.43)
          : spec.profile === 'needle'
            ? (side > 0 ? 0.31 : 0.22)
            : (side > 0 ? 0.45 : 0.34);
        undercarriages[spec.profile].push({
          position: this.localOffset(
            spec.x,
            spec.y - spec.height * 0.82,
            spec.z,
            side * spec.width * 0.22,
            spec.depth * 0.035,
            spec.yaw,
          ),
          scale: new THREE.Vector3(spec.width * 0.3, spec.height * 0.92, spec.depth * 0.34),
          yaw: spec.yaw + side * 0.16,
        });
        wingBlocks.push({
          position: this.localOffset(
            spec.x,
            spec.y + spec.height * (side > 0 ? 0.08 : -0.02),
            spec.z,
            side * spec.width * 0.43,
            side * spec.depth * 0.055,
            spec.yaw,
          ),
          scale: new THREE.Vector3(spec.width * wingScale, spec.height * 0.54, spec.depth * (side > 0 ? 0.76 : 0.62)),
          yaw: spec.yaw,
        });
        wingBlocks.push({
          position: this.localOffset(
            spec.x,
            spec.y - spec.height * 0.34,
            spec.z,
            side * spec.width * 0.28,
            spec.depth * 0.03,
            spec.yaw,
          ),
          scale: new THREE.Vector3(spec.width * 0.12, spec.height * 0.62, spec.depth * 0.15),
          rotation: new THREE.Euler(0, spec.yaw, side * 0.32),
        });
        wingBraces.push(
          {
            position: this.localOffset(
              spec.x,
              spec.y - spec.height * 0.16,
              spec.z,
              side * spec.width * 0.29,
              -spec.depth * 0.16,
              spec.yaw,
            ),
            scale: new THREE.Vector3(spec.width * 0.31, spec.height * 0.18, spec.depth * 0.2),
            rotation: new THREE.Euler(0, spec.yaw, side * -0.22),
          },
          {
            position: this.localOffset(
              spec.x,
              spec.y + spec.height * 0.12,
              spec.z,
              side * spec.width * 0.31,
              spec.depth * 0.17,
              spec.yaw,
            ),
            scale: new THREE.Vector3(spec.width * 0.28, spec.height * 0.15, spec.depth * 0.18),
            rotation: new THREE.Euler(0, spec.yaw, side * 0.18),
          },
        );
        whiteDetails.push({
          position: this.localOffset(spec.x, spec.y + spec.height * 0.25, spec.z, side * spec.width * 0.48, -spec.depth * 0.08, spec.yaw),
          scale: new THREE.Vector3(0.55, spec.height * 0.66, spec.depth * 0.42),
          yaw: spec.yaw,
        });
      }
      crownCaps.push({
        position: new THREE.Vector3(spec.x, spec.y + spec.height * 0.54, spec.z),
        scale: new THREE.Vector3(
          spec.width * (spec.profile === 'needle' ? 0.58 : spec.profile === 'command' ? 0.9 : 0.82),
          spec.profile === 'command' ? 1.18 : 0.88,
          spec.depth * (spec.profile === 'needle' ? 0.66 : 0.78),
        ),
        yaw: spec.yaw,
      });
      landingDecks.push({
        position: new THREE.Vector3(spec.x, spec.y + spec.height * 0.59, spec.z),
        scale: new THREE.Vector3(spec.width * 0.66, 0.2, spec.depth * 0.62),
        yaw: spec.yaw,
      });
      for (const localZ of [-0.34, 0.34]) {
        landingRails.push({
          position: this.localOffset(
            spec.x,
            spec.y + spec.height * 0.64,
            spec.z,
            0,
            spec.depth * localZ,
            spec.yaw,
          ),
          scale: new THREE.Vector3(spec.width * 0.68, 0.48, 0.34),
          yaw: spec.yaw,
        });
      }
      for (const column of [-0.3, -0.1, 0.1, 0.3]) {
        accentPanels[spec.accent].push({
          position: this.localOffset(
            spec.x,
            spec.y + spec.height * 0.12,
            spec.z,
            spec.width * column,
            -spec.depth * 0.57,
            spec.yaw,
          ),
          scale: new THREE.Vector3(spec.width * 0.13, spec.height * 0.18, 0.2),
          yaw: spec.yaw,
        });
      }
      accentPanels[spec.accent].push({
        position: this.localOffset(spec.x, spec.y + spec.height * 0.55, spec.z, 0, -spec.depth * 0.42, spec.yaw),
        scale: new THREE.Vector3(spec.width * 0.62, 0.22, 0.24),
        yaw: spec.yaw,
      });
      for (const sideX of [-1, 1]) {
        for (const sideZ of [-1, 1]) {
          thrusters[spec.accent].push({
            position: this.localOffset(
              spec.x,
              spec.y - spec.height * 0.65,
              spec.z,
              sideX * spec.width * 0.3,
              sideZ * spec.depth * 0.28,
              spec.yaw,
            ),
            scale: new THREE.Vector3(0.72, 2.1, 0.72),
            rotation: new THREE.Euler(0, spec.yaw, Math.PI),
          });
        }
        whiteDetails.push({
          position: this.localOffset(
            spec.x,
            spec.y - spec.height * 0.43,
            spec.z,
            sideX * spec.width * 0.28,
            spec.depth * 0.02,
            spec.yaw,
          ),
          scale: new THREE.Vector3(0.64, spec.height * 0.48, 0.82),
          rotation: new THREE.Euler(0, spec.yaw, sideX * 0.18),
        });
      }
      if (spec.profile === 'needle') {
        whiteDetails.push(
          {
            position: this.localOffset(spec.x, spec.y + spec.height * 0.92, spec.z, 0, 0.03 * spec.depth, spec.yaw),
            scale: new THREE.Vector3(1.25, spec.height * 1.05, 1.25),
            yaw: spec.yaw,
          },
          {
            position: this.localOffset(spec.x, spec.y + spec.height * 1.4, spec.z, 0, 0.03 * spec.depth, spec.yaw),
            scale: new THREE.Vector3(spec.width * 0.42, 0.72, 1.2),
            yaw: spec.yaw,
          },
        );
      } else if (spec.profile === 'command') {
        for (const side of [-1, 1]) {
          whiteDetails.push({
            position: this.localOffset(spec.x, spec.y + spec.height * 0.86, spec.z, side * spec.width * 0.18, 0.04 * spec.depth, spec.yaw),
            scale: new THREE.Vector3(1.3, spec.height * 0.68, 1.45),
            yaw: spec.yaw,
          });
        }
        whiteDetails.push({
          position: this.localOffset(spec.x, spec.y + spec.height * 1.18, spec.z, 0, 0.04 * spec.depth, spec.yaw),
          scale: new THREE.Vector3(spec.width * 0.46, 0.88, 1.5),
          yaw: spec.yaw,
        });
      }
      for (const localX of [-0.24, 0, 0.24]) {
        const anchorPoint = this.localOffset(spec.x, 0, spec.z, spec.width * localX, spec.depth * 0.04, spec.yaw);
        // Terminate every suspension at the actual terrain skin.  A small
        // positive seat avoids z-fighting while keeping the anchor visibly
        // planted instead of burying the first half metre underground.
        const anchorY = this.terrainHeightAt(anchorPoint.x, anchorPoint.z) + 0.06;
        const tetherTopY = spec.y - spec.height * (spec.profile === 'needle' ? 0.72 : 0.68);
        const tetherHeight = Math.max(7, tetherTopY - anchorY);
        tethers[spec.accent].push({
          position: this.localOffset(
            spec.x,
            anchorY + tetherHeight * 0.5,
            spec.z,
            spec.width * localX,
            spec.depth * 0.04,
            spec.yaw,
          ),
          scale: new THREE.Vector3(localX === 0 ? 0.2 : 0.13, tetherHeight, localX === 0 ? 0.2 : 0.13),
        });
        tetherAnchors.push({
          position: this.localOffset(
            spec.x,
            anchorY + 0.72,
            spec.z,
            spec.width * localX,
            spec.depth * 0.04,
            spec.yaw,
          ),
          scale: new THREE.Vector3(localX === 0 ? 2.2 : 1.55, 1.45, localX === 0 ? 2.2 : 1.55),
          yaw: spec.yaw + (localX < 0 ? -0.08 : localX > 0 ? 0.08 : 0),
        });
      }
      const ringScale = Math.max(spec.width, spec.depth) * 0.32;
      rings[spec.accent].push({
        position: new THREE.Vector3(
          spec.x,
          spec.y + spec.height * (spec.profile === 'needle' ? 1.12 : 0.65) + 1.1,
          spec.z,
        ),
        scale: new THREE.Vector3(
          ringScale * (spec.profile === 'command' ? 1.16 : spec.profile === 'needle' ? 0.72 : 1),
          ringScale * (spec.profile === 'command' ? 1.16 : spec.profile === 'needle' ? 0.72 : 1),
          ringScale * (spec.profile === 'command' ? 1.16 : spec.profile === 'needle' ? 0.72 : 1),
        ),
        rotation: new THREE.Euler(spec.profile === 'needle' ? 0.08 : Math.PI * 0.5, spec.yaw, spec.profile === 'needle' ? 0.18 : 0),
      });
      const roofY = spec.y + spec.height * 0.59 + 0.1;
      this.platformSurfaces.push({
        name: `QuickSense ${spec.name} landing roof`,
        minX: spec.x - spec.width * 0.27,
        maxX: spec.x + spec.width * 0.27,
        minZ: spec.z - spec.depth * 0.22,
        maxZ: spec.z + spec.depth * 0.22,
        y: roofY,
      });
      this.registerBoxCollision(
        `QuickSense ${spec.name} primary hull`,
        new THREE.Vector3(spec.x, spec.y, spec.z),
        new THREE.Vector3(
          spec.width * (spec.profile === 'command' ? 0.72 : spec.profile === 'needle' ? 0.5 : 0.64),
          spec.height,
          spec.depth * 0.7,
        ),
        spec.yaw,
      );
      for (const side of [-1, 1]) {
        this.registerBoxCollision(
          `QuickSense ${spec.name} ${side < 0 ? 'port' : 'starboard'} dock wing`,
          this.localOffset(spec.x, spec.y, spec.z, side * spec.width * 0.38, 0, spec.yaw),
          new THREE.Vector3(spec.width * 0.25, spec.height * 0.48, spec.depth * 0.58),
          spec.yaw,
        );
      }
      const haloCenter = new THREE.Vector3(
        spec.x,
        spec.y + spec.height * (spec.profile === 'needle' ? 1.12 : 0.65) + 1.1,
        spec.z,
      );
      const haloRadius = ringScale * (spec.profile === 'command' ? 1.16 : spec.profile === 'needle' ? 0.72 : 1);
      this.shotBoxes.push(new THREE.Box3(
        haloCenter.clone().add(new THREE.Vector3(-haloRadius, -0.24, -haloRadius)),
        haloCenter.clone().add(new THREE.Vector3(haloRadius, 0.24, haloRadius)),
      ));
    }

    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const crown = this.createChamferedBlockGeometry(0.14);
    const thruster = new THREE.ConeGeometry(1, 1, 6);
    const tether = new THREE.CylinderGeometry(1, 1, 1, 6);
    const ring = new THREE.TorusGeometry(1, 0.035, 5, 24);
    for (const profile of ['skydock', 'needle', 'command'] as const) {
      this.addInstancedMeshes(
        `QuickSense ${profile} floating station hull`,
        this.createFloatingHullGeometry(profile),
        sideMaterial,
        hulls[profile],
      );
      this.addInstancedMeshes(
        `QuickSense ${profile} floating station keel`,
        this.createFloatingKeelGeometry(profile),
        sideMaterial,
        undercarriages[profile],
      );
    }
    this.addInstancedMeshes('QuickSense floating station wings', unitBox, sideMaterial, wingBlocks);
    this.addInstancedMeshes(
      'QuickSense floating station attached wing trusses',
      this.createCliffButtressGeometry(),
      whiteMaterial,
      wingBraces,
    );
    this.addInstancedMeshes('QuickSense floating station crowns', crown, sideMaterial, crownCaps);
    this.addInstancedMeshes('QuickSense floating landing decks', unitBox, sideMaterial, landingDecks, false);
    this.addInstancedMeshes('QuickSense floating landing rails', unitBox, whiteMaterial, landingRails, false);
    this.addInstancedMeshes('QuickSense floating station fins', unitBox, whiteMaterial, whiteDetails);
    this.addInstancedMeshes(
      'QuickSense floating station grounded tether anchors',
      this.createChamferedBlockGeometry(0.16),
      sideMaterial,
      tetherAnchors,
    );
    const factionBatches = (transforms: Record<AccentRole, InstanceTransform[]>) => (
      ['cyan', 'magenta', 'amber'] as const
    ).map((role) => ({ transforms: transforms[role], color: signalColors[role] }));
    addFactionBatch('QuickSense floating faction panels', unitBox, factionBatches(accentPanels));
    addFactionBatch('QuickSense floating station thrusters', thruster, factionBatches(thrusters));
    addFactionBatch('QuickSense floating energy tethers', tether, factionBatches(tethers));
    addFactionBatch('QuickSense floating grapple halos', ring, factionBatches(rings));
  }

  private localOffset(
    x: number,
    y: number,
    z: number,
    localX: number,
    localZ: number,
    yaw: number,
  ): THREE.Vector3 {
    const cosine = Math.cos(yaw);
    const sine = Math.sin(yaw);
    return new THREE.Vector3(
      x + localX * cosine + localZ * sine,
      y,
      z - localX * sine + localZ * cosine,
    );
  }

  private registerBoxCollision(
    name: string,
    center: THREE.Vector3,
    size: THREE.Vector3,
    yaw = 0,
    blocksMovement = true,
  ): void {
    const cosine = Math.abs(Math.cos(yaw));
    const sine = Math.abs(Math.sin(yaw));
    const halfX = (size.x * cosine + size.z * sine) * 0.5;
    const halfZ = (size.x * sine + size.z * cosine) * 0.5;
    const box = new THREE.Box3(
      new THREE.Vector3(center.x - halfX, center.y - size.y * 0.5, center.z - halfZ),
      new THREE.Vector3(center.x + halfX, center.y + size.y * 0.5, center.z + halfZ),
    );
    this.colliders.push({ box, name, blocksMovement });
    this.shotBoxes.push(box.clone());
  }

  private buildingEntryRampHeightAt(ramp: BuildingEntryRampSurface, x: number, z: number): number | null {
    const dx = ramp.end.x - ramp.start.x;
    const dz = ramp.end.z - ramp.start.z;
    const lengthSquared = dx * dx + dz * dz;
    if (lengthSquared < EPSILON) return null;
    const t = ((x - ramp.start.x) * dx + (z - ramp.start.z) * dz) / lengthSquared;
    if (t < 0 || t > 1) return null;
    const nearestX = ramp.start.x + dx * t;
    const nearestZ = ramp.start.z + dz * t;
    if (Math.hypot(x - nearestX, z - nearestZ) > ramp.width * 0.5) return null;
    return THREE.MathUtils.lerp(ramp.start.y, ramp.end.y, t);
  }

  private createSkylineGateways(
    sideMaterial: THREE.MeshStandardMaterial,
    cyanMaterial: THREE.MeshStandardMaterial,
    magentaMaterial: THREE.MeshStandardMaterial,
    amberMaterial: THREE.MeshStandardMaterial,
  ): void {
    const eastFactionMaterial = magentaMaterial.clone();
    eastFactionMaterial.name = 'QuickSense terracotta skyline signal';
    eastFactionMaterial.color.setHex(0xa96846);
    eastFactionMaterial.emissive.setHex(0x7f4028);
    eastFactionMaterial.emissiveIntensity = 0.34;
    this.materials.push(eastFactionMaterial);
    const pylons = [
      { x: -84.5, z: -16, height: 34, yaw: -0.08, accent: cyanMaterial, role: 'cyan' },
      { x: 84.5, z: 16, height: 36, yaw: 0.08, accent: eastFactionMaterial, role: 'magenta' },
    ] as const;
    const signals: Record<'cyan' | 'magenta', InstanceTransform[]> = { cyan: [], magenta: [] };
    const halos: Record<'cyan' | 'magenta', InstanceTransform[]> = { cyan: [], magenta: [] };
    const pylonCableTops = new Map<'cyan' | 'magenta', THREE.Vector3>();
    for (const pylon of pylons) {
      // Seat the pylon base on the terrain skin with only a tiny construction
      // tolerance.  The old half-metre embed made the lower plinth disappear
      // into the cliff and left the shaft looking detached from its footing.
      const shaftBottom = Math.max(0.08, this.terrainHeightAt(pylon.x, pylon.z) - 0.12);
      const visibleHeight = Math.max(18, pylon.height - (shaftBottom - 2.2));
      const shaftTop = shaftBottom + visibleHeight;
      this.registerBuilding(
        pylon.role === 'cyan' ? 'Cyan Skyline Pylon' : 'Magenta Skyline Pylon',
        'gateway',
        'cable-anchor-fork',
        pylon.role,
        new THREE.Vector3(pylon.x, shaftBottom + visibleHeight * 0.58, pylon.z),
      );
      const pylonMesh = this.addMesh(
        this.createSkylinePylonGeometry(pylon.role, visibleHeight),
        sideMaterial,
        `QuickSense ${pylon.role} authored skyline pylon`,
        new THREE.Vector3(pylon.x, shaftBottom, pylon.z),
      );
      pylonMesh.rotation.y = pylon.yaw;
      signals[pylon.role].push(
        {
          position: this.localOffset(pylon.x, shaftBottom + visibleHeight * 0.52, pylon.z, 0, -2.02, pylon.yaw),
          scale: new THREE.Vector3(0.55, visibleHeight * 0.78, 0.2),
          yaw: pylon.yaw,
        },
        {
          position: new THREE.Vector3(pylon.x, shaftTop + 8.55, pylon.z - 2.08),
          scale: new THREE.Vector3(3.2, 0.28, 0.22),
          yaw: pylon.yaw,
        },
      );
      const haloScale = 5.5;
      halos[pylon.role].push({
        position: new THREE.Vector3(pylon.x, shaftTop + 4.2, pylon.z),
        scale: new THREE.Vector3(haloScale, haloScale, haloScale),
        rotation: new THREE.Euler(Math.PI * 0.5, pylon.yaw, 0),
      });
      this.registerBoxCollision(
        `QuickSense ${pylon.role} skyline pylon base`,
        new THREE.Vector3(pylon.x, shaftBottom + 1.5, pylon.z),
        new THREE.Vector3(8.4, 3, 7.2),
        pylon.yaw,
      );
      this.registerBoxCollision(
        `QuickSense ${pylon.role} skyline pylon shaft`,
        new THREE.Vector3(pylon.x, shaftBottom + visibleHeight * 0.5, pylon.z),
        new THREE.Vector3(5.4, visibleHeight, 5),
        pylon.yaw,
      );
      this.shotBoxes.push(new THREE.Box3(
        new THREE.Vector3(pylon.x - 6, shaftTop + 3.4, pylon.z - 6),
        new THREE.Vector3(pylon.x + 6, shaftTop + 5, pylon.z + 6),
      ));
      pylonCableTops.set(pylon.role, new THREE.Vector3(pylon.x, shaftTop + 6.3, pylon.z));
    }

    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const haloGeometry = new THREE.TorusGeometry(1, 0.05, 5, 24);
    this.addInstancedMeshes('QuickSense cyan pylon signals', unitBox, cyanMaterial, signals.cyan, false);
    this.addInstancedMeshes('QuickSense terracotta pylon signals', unitBox, eastFactionMaterial, signals.magenta, false);
    this.addInstancedMeshes('QuickSense cyan pylon halo', haloGeometry, cyanMaterial, halos.cyan, false);
    this.addInstancedMeshes('QuickSense terracotta pylon halo', haloGeometry, eastFactionMaterial, halos.magenta, false);

    const cyanPylonTop = pylonCableTops.get('cyan')!;
    const magentaPylonTop = pylonCableTops.get('magenta')!;
    // Cable endpoints use exterior roof sockets, not station centers.  This
    // keeps the invasion network visibly attached to the buildings and stops
    // the cables from disappearing through their hulls.
    const cyanStation = this.localOffset(-58, 52 + 12 * 0.59 + 0.1, 23, 0, -17 * 0.22, -0.24);
    const magentaStation = this.localOffset(58, 56 + 15 * 0.59 + 0.1, 23, 0, -15 * 0.22, 0.24);
    const flagship = this.localOffset(0, 66 + 15 * 0.59 + 0.1, 58, 0, -23 * 0.22, 0);
    this.createSuspendedCable('QuickSense cyan skyline cable', cyanPylonTop, cyanStation, 8, cyanMaterial, 0.22);
    this.createSuspendedCable('QuickSense terracotta skyline cable', magentaPylonTop, magentaStation, 8, eastFactionMaterial, 0.22);
    this.createSuspendedCable('QuickSense west flagship cable', cyanStation, flagship, 10, amberMaterial, 0.19);
    this.createSuspendedCable('QuickSense east flagship cable', magentaStation, flagship, 12, amberMaterial, 0.19);
  }

  private createSkylinePylonGeometry(role: 'cyan' | 'magenta', height: number): THREE.BufferGeometry {
    const footprint = role === 'cyan'
      ? [[-0.5, -0.34], [0.04, -0.5], [0.48, -0.22], [0.34, 0.5], [-0.2, 0.44], [-0.5, 0.08]] as const
      : [[-0.46, -0.42], [0.22, -0.5], [0.5, -0.12], [0.24, 0.5], [-0.3, 0.4], [-0.5, -0.04]] as const;
    const parts: THREE.BufferGeometry[] = [];
    const append = (
      geometry: THREE.BufferGeometry,
      position: THREE.Vector3,
      scale: THREE.Vector3,
      rotation = new THREE.Euler(),
    ): void => {
      const normalized = geometry.index ? geometry.toNonIndexed() : geometry;
      if (normalized !== geometry) geometry.dispose();
      normalized.applyMatrix4(new THREE.Matrix4().compose(
        position,
        new THREE.Quaternion().setFromEuler(rotation),
        scale,
      ));
      parts.push(normalized);
    };
    append(
      this.createArchitecturalLoftGeometry(footprint, [
        { y: -0.5, scaleX: 1.1, scaleZ: 1.08 },
        { y: -0.3, scaleX: 0.94, scaleZ: 0.96 },
        { y: 0.24, scaleX: 0.6, scaleZ: 0.7, shiftX: role === 'cyan' ? -0.09 : 0.1 },
        { y: 0.5, scaleX: 0.76, scaleZ: 0.78, shiftX: role === 'cyan' ? -0.16 : 0.18, rotation: role === 'cyan' ? -0.08 : 0.1 },
      ], 4.5),
      new THREE.Vector3(0, height * 0.5, 0),
      new THREE.Vector3(6.2, height, 5.4),
    );
    append(
      this.createArchitecturalLoftGeometry(footprint, [
        { y: -0.5, scaleX: 1, scaleZ: 1 },
        { y: 0.5, scaleX: 1.12, scaleZ: 1.08 },
      ], 1.5),
      new THREE.Vector3(0, 1.2, 0),
      new THREE.Vector3(9.2, 2.4, 8.2),
    );
    const forks = role === 'cyan'
      ? [{ x: -2.5, h: 8.8, lean: -0.2 }, { x: 1.8, h: 6.6, lean: 0.08 }]
      : [{ x: -2.8, h: 7.4, lean: -0.24 }, { x: 2.8, h: 10.2, lean: 0.2 }];
    for (const fork of forks) {
      append(
        this.createAsymmetricFinGeometry(),
        new THREE.Vector3(fork.x, height + fork.h * 0.5 + 1.5, 0),
        new THREE.Vector3(1.65, fork.h, 3.4),
        new THREE.Euler(0, 0, fork.lean),
      );
    }
    append(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.Vector3(role === 'cyan' ? -0.45 : 0.55, height + 7.1, 0),
      new THREE.Vector3(role === 'cyan' ? 7.8 : 8.8, 0.8, 3.3),
      new THREE.Euler(0, 0, role === 'cyan' ? -0.08 : 0.1),
    );
    const merged = mergeGeometries(parts, false);
    if (!merged) throw new Error(`QuickSense could not merge ${role} skyline pylon geometry.`);
    for (const part of parts) part.dispose();
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }

  private createSuspendedCable(
    name: string,
    start: THREE.Vector3,
    end: THREE.Vector3,
    sag: number,
    material: THREE.MeshStandardMaterial,
    radius: number,
  ): void {
    const midpoint = start.clone().lerp(end, 0.5);
    midpoint.y = Math.min(start.y, end.y) - sag;
    const quarter = start.clone().lerp(midpoint, 0.5);
    const threeQuarter = midpoint.clone().lerp(end, 0.5);
    const curve = new THREE.CatmullRomCurve3([start, quarter, midpoint, threeQuarter, end]);
    const geometry = new THREE.TubeGeometry(curve, 28, radius, 5, false);
    const cable = this.addMesh(geometry, material, name);
    cable.castShadow = false;
    cable.receiveShadow = false;
    let previous = curve.getPoint(0);
    for (let index = 1; index <= 12; index += 1) {
      const next = curve.getPoint(index / 12);
      this.shotBoxes.push(new THREE.Box3().setFromPoints([previous, next]).expandByScalar(radius + 0.22));
      previous = next;
    }
  }

  private createBoundaryArchitecture(sideMaterial: THREE.MeshStandardMaterial, accent: THREE.MeshStandardMaterial): void {
    const walls = [
      { center: new THREE.Vector3(-50, 4.2, -79.1), size: new THREE.Vector3(72, 8.4, 2.2) },
      { center: new THREE.Vector3(50, 4.2, -79.1), size: new THREE.Vector3(72, 8.4, 2.2) },
      { center: new THREE.Vector3(-50, 4.2, 79.1), size: new THREE.Vector3(72, 8.4, 2.2) },
      { center: new THREE.Vector3(50, 4.2, 79.1), size: new THREE.Vector3(72, 8.4, 2.2) },
      { center: new THREE.Vector3(-89, 4.2, -43), size: new THREE.Vector3(2.2, 8.4, 31) },
      { center: new THREE.Vector3(-89, 4.2, 0), size: new THREE.Vector3(2.2, 8.4, 31) },
      { center: new THREE.Vector3(-89, 4.2, 43), size: new THREE.Vector3(2.2, 8.4, 31) },
      { center: new THREE.Vector3(89, 4.2, -43), size: new THREE.Vector3(2.2, 8.4, 31) },
      { center: new THREE.Vector3(89, 4.2, 0), size: new THREE.Vector3(2.2, 8.4, 31) },
      { center: new THREE.Vector3(89, 4.2, 43), size: new THREE.Vector3(2.2, 8.4, 31) },
    ];
    const wallTransforms: InstanceTransform[] = [];
    const capTransforms: InstanceTransform[] = [];
    for (const wall of walls) {
      wallTransforms.push({ position: wall.center, scale: wall.size });
      capTransforms.push({
        position: new THREE.Vector3(wall.center.x, 8.58, wall.center.z),
        scale: new THREE.Vector3(wall.size.x * 1.03, 0.34, wall.size.z * 1.08),
      });
      this.registerBoxCollision('QuickSense fortified perimeter', wall.center, wall.size);
    }
    const buttresses: InstanceTransform[] = [];
    const amberStrips: InstanceTransform[] = [];
    for (const x of [-84, -66, -42, 42, 66, 84]) {
      for (const z of [-79.1, 79.1]) {
        buttresses.push({ position: new THREE.Vector3(x, 5.1, z), scale: new THREE.Vector3(3.4, 10.2, 4.8) });
        amberStrips.push({ position: new THREE.Vector3(x, 8.86, z - Math.sign(z) * 1.22), scale: new THREE.Vector3(7.8, 0.24, 0.18) });
      }
    }
    for (const z of [-64, -43, -21, 0, 21, 43, 64]) {
      for (const x of [-89, 89]) {
        buttresses.push({ position: new THREE.Vector3(x, 5.1, z), scale: new THREE.Vector3(4.8, 10.2, 3.4) });
        amberStrips.push({ position: new THREE.Vector3(x - Math.sign(x) * 1.22, 8.86, z), scale: new THREE.Vector3(0.18, 0.24, 7.8) });
      }
    }
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    this.addInstancedMeshes('QuickSense perimeter retaining walls', this.createChamferedBlockGeometry(0.08), sideMaterial, wallTransforms);
    this.addInstancedMeshes('QuickSense perimeter armored caps', this.createChamferedBlockGeometry(0.12), sideMaterial, capTransforms);
    this.addInstancedMeshes('QuickSense perimeter buttresses', this.createCliffButtressGeometry(), sideMaterial, buttresses);
    this.addInstancedMeshes('QuickSense perimeter amber signals', unitBox, accent, amberStrips, false);
  }

  private createRouteSupports(
    sideMaterial: THREE.MeshStandardMaterial,
    trimMaterial: THREE.MeshStandardMaterial,
    cyanMaterial: THREE.MeshStandardMaterial,
    magentaMaterial: THREE.MeshStandardMaterial,
  ): void {
    const columns: InstanceTransform[] = [];
    const cyanSignals: InstanceTransform[] = [];
    const magentaSignals: InstanceTransform[] = [];
    const neutralSignals: InstanceTransform[] = [];
    for (const path of this.pathSurfaces) {
      const stride = path.closed ? 10 : 11;
      for (let index = Math.floor(stride * 0.55); index < path.points.length; index += stride) {
        const point = path.points[index];
        if (point.y < 3.1 || (Math.abs(point.x) < 15 && Math.abs(point.z) < 17)) continue;
        const terrain = this.terrainHeightAt(point.x, point.z);
        const baseY = terrain;
        const previous = path.points[(index - 1 + path.points.length) % path.points.length];
        const next = path.points[(index + 1) % path.points.length];
        const supportYaw = Math.atan2(next.x - previous.x, next.z - previous.z);
        const capWidth = 2.85;
        const capHeight = 0.58;
        const capDepth = 3.65;
        const ownPathUndersideAt = (x: number, z: number): number => (
          path.heightAt(x, z) ?? point.y
        ) - pathDeckBottomDepth(path.name);
        const centerUnderside = Math.min(
          ownPathUndersideAt(point.x, point.z),
          this.deckUndersideAt(point.x, point.z) ?? Number.POSITIVE_INFINITY,
        );
        const capBottomY = centerUnderside - SUPPORT_CONTACT_EPSILON - capHeight;
        const height = capBottomY - baseY + 0.025;
        if (height <= 0.72) continue;
        const capGeometry = this.createFittedSupportCapGeometry(
          point.x,
          point.z,
          capWidth,
          capDepth,
          supportYaw,
          capHeight,
          ownPathUndersideAt,
        );
        this.addMesh(capGeometry, sideMaterial, 'QuickSense fitted route support cap');
        columns.push({
          position: new THREE.Vector3(point.x, baseY + height * 0.5, point.z),
          scale: new THREE.Vector3(2.1, height, 2.75),
          yaw: supportYaw,
        });
        const signal = {
          position: this.localOffset(point.x, baseY + height * 0.52, point.z, 0, -1.18, supportYaw),
          scale: new THREE.Vector3(0.16, Math.max(0.7, height * 0.58), 0.1),
          yaw: supportYaw,
        };
        if (path.name.startsWith('Cyan')) cyanSignals.push(signal);
        else if (path.name.startsWith('Magenta')) magentaSignals.push(signal);
        else neutralSignals.push(signal);
        this.registerBoxCollision(
          'QuickSense elevated route support',
          new THREE.Vector3(point.x, baseY + height * 0.5, point.z),
          new THREE.Vector3(2.0, height, 2.0),
        );
      }
    }
    const columnGeometry = this.createCliffButtressGeometry();
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    this.addInstancedMeshes('QuickSense route support columns', columnGeometry, sideMaterial, columns);
    this.addInstancedMeshes('QuickSense cyan support signals', unitBox, cyanMaterial, cyanSignals, false);
    this.addInstancedMeshes('QuickSense magenta support signals', unitBox, magentaMaterial, magentaSignals, false);
    this.addInstancedMeshes('QuickSense neutral support signals', unitBox, trimMaterial, neutralSignals, false);
  }

  private deckUndersideAt(x: number, z: number): number | null {
    let lowest: number | null = null;
    for (const path of this.pathSurfaces) {
      if (!path.contains(x, z)) continue;
      const surfaceY = path.heightAt(x, z);
      if (surfaceY === null) continue;
      const undersideY = surfaceY - pathDeckBottomDepth(path.name);
      lowest = lowest === null ? undersideY : Math.min(lowest, undersideY);
    }
    for (const ramp of this.rampSurfaces) {
      const surfaceY = ramp.flow.heightAt(x, z);
      if (surfaceY === null) continue;
      const undersideY = surfaceY - (ramp.spec.skirtDepth ?? 0.45);
      lowest = lowest === null ? undersideY : Math.min(lowest, undersideY);
    }
    return lowest;
  }

  private createFittedSupportCapGeometry(
    centerX: number,
    centerZ: number,
    width: number,
    depth: number,
    yaw: number,
    height: number,
    targetUndersideAt: (x: number, z: number) => number,
  ): THREE.BufferGeometry {
    const segmentsX = 4;
    const segmentsZ = 4;
    const rowLength = segmentsX + 1;
    const layerSize = rowLength * (segmentsZ + 1);
    const positions: number[] = [];
    const uvs: number[] = [];
    const topHeights: number[] = [];

    // Follow the same analytic underside used by the rendered deck. A fitted
    // grid seats the entire cap against local slope and banking, while the
    // two-millimetre tolerance prevents coplanar flicker or visible piercing.
    for (let zIndex = 0; zIndex <= segmentsZ; zIndex += 1) {
      const v = zIndex / segmentsZ;
      for (let xIndex = 0; xIndex <= segmentsX; xIndex += 1) {
        const u = xIndex / segmentsX;
        const sample = this.localOffset(
          centerX,
          0,
          centerZ,
          THREE.MathUtils.lerp(-width * 0.5, width * 0.5, u),
          THREE.MathUtils.lerp(-depth * 0.5, depth * 0.5, v),
          yaw,
        );
        const targetUnderside = targetUndersideAt(sample.x, sample.z);
        const underside = Math.min(
          targetUnderside,
          this.deckUndersideAt(sample.x, sample.z) ?? Number.POSITIVE_INFINITY,
        );
        const topY = underside - SUPPORT_CONTACT_EPSILON;
        positions.push(sample.x, topY, sample.z);
        uvs.push(u, v);
        topHeights.push(topY);
        this.recordSupportClearance(underside - topY);
      }
    }
    for (let index = 0; index < layerSize; index += 1) {
      const offset = index * 3;
      positions.push(positions[offset], topHeights[index] - height, positions[offset + 2]);
      uvs.push(uvs[index * 2], uvs[index * 2 + 1]);
    }

    const indices: number[] = [];
    const top = (x: number, z: number): number => z * rowLength + x;
    const bottom = (x: number, z: number): number => layerSize + top(x, z);
    for (let zIndex = 0; zIndex < segmentsZ; zIndex += 1) {
      for (let xIndex = 0; xIndex < segmentsX; xIndex += 1) {
        const a = top(xIndex, zIndex);
        const b = top(xIndex + 1, zIndex);
        const c = top(xIndex, zIndex + 1);
        const d = top(xIndex + 1, zIndex + 1);
        indices.push(a, c, b, b, c, d);
        const bottomA = bottom(xIndex, zIndex);
        const bottomB = bottom(xIndex + 1, zIndex);
        const bottomC = bottom(xIndex, zIndex + 1);
        const bottomD = bottom(xIndex + 1, zIndex + 1);
        indices.push(bottomA, bottomB, bottomC, bottomB, bottomD, bottomC);
      }
    }
    for (let xIndex = 0; xIndex < segmentsX; xIndex += 1) {
      const northA = top(xIndex, 0);
      const northB = top(xIndex + 1, 0);
      const northBottomA = bottom(xIndex, 0);
      const northBottomB = bottom(xIndex + 1, 0);
      indices.push(northA, northB, northBottomA, northB, northBottomB, northBottomA);

      const southA = top(xIndex, segmentsZ);
      const southB = top(xIndex + 1, segmentsZ);
      const southBottomA = bottom(xIndex, segmentsZ);
      const southBottomB = bottom(xIndex + 1, segmentsZ);
      indices.push(southA, southBottomA, southB, southB, southBottomA, southBottomB);
    }
    for (let zIndex = 0; zIndex < segmentsZ; zIndex += 1) {
      const westA = top(0, zIndex);
      const westB = top(0, zIndex + 1);
      const westBottomA = bottom(0, zIndex);
      const westBottomB = bottom(0, zIndex + 1);
      indices.push(westA, westBottomA, westB, westB, westBottomA, westBottomB);

      const eastA = top(segmentsX, zIndex);
      const eastB = top(segmentsX, zIndex + 1);
      const eastBottomA = bottom(segmentsX, zIndex);
      const eastBottomB = bottom(segmentsX, zIndex + 1);
      indices.push(eastA, eastB, eastBottomA, eastB, eastBottomB, eastBottomA);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    const fitted = geometry.toNonIndexed();
    geometry.dispose();
    fitted.computeVertexNormals();
    fitted.computeBoundingBox();
    fitted.computeBoundingSphere();
    return fitted;
  }

  private recordSupportClearance(clearance: number): void {
    this.supportClearanceSamples += 1;
    this.supportClearanceMinimum = Math.min(this.supportClearanceMinimum, clearance);
    this.supportClearanceMaximum = Math.max(this.supportClearanceMaximum, clearance);
    if (clearance < -EPSILON) this.supportPenetrations += 1;
  }

  private createJumpPad(
    position: THREE.Vector3,
    direction: THREE.Vector3,
    accentMaterial: THREE.MeshStandardMaterial,
    shellMaterial: THREE.MeshStandardMaterial,
  ): JumpPad {
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.55, 0.24, 8), shellMaterial);
    pad.name = 'QuickSense jump pad';
    pad.position.copy(position);
    this.geometries.push(pad.geometry);
    this.group.add(pad);
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(0.68, 0.68, 0.28, 8), accentMaterial);
    inner.name = 'QuickSense jump pad core';
    inner.position.copy(position).add(new THREE.Vector3(0, 0.2, 0));
    this.geometries.push(inner.geometry);
    this.group.add(inner);
    return {
      position: this.localToWorld(position),
      direction: this.localVectorToWorld(direction.clone()).normalize(),
      radius: 1.7 * QUICK_HORIZONTAL_SCALE,
      launchSpeed: 27,
    };
  }

  private pointOnFloor(x: number, z: number, lift = 0.04): THREE.Vector3 {
    return this.localToWorld(this.localPointOnFloor(x, z, lift));
  }

  private localPointOnFloor(x: number, z: number, lift = 0.04): THREE.Vector3 {
    const floor = this.floorSurfaceAt(x, z, Number.POSITIVE_INFINITY)?.height ?? 0;
    return new THREE.Vector3(x, floor + lift / QUICK_VERTICAL_SCALE, z);
  }

  private worldToLocal(source: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
    return target.set(
      source.x / QUICK_HORIZONTAL_SCALE,
      source.y / QUICK_VERTICAL_SCALE,
      source.z / QUICK_HORIZONTAL_SCALE,
    );
  }

  private localToWorld(source: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
    return target.set(
      source.x * QUICK_HORIZONTAL_SCALE,
      source.y * QUICK_VERTICAL_SCALE,
      source.z * QUICK_HORIZONTAL_SCALE,
    );
  }

  private worldVectorToLocal(source: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
    return this.worldToLocal(source, target);
  }

  private localVectorToWorld(source: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
    return this.localToWorld(source, target);
  }

  private localNormalToWorld(source: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
    return target.set(
      source.x / QUICK_HORIZONTAL_SCALE,
      source.y / QUICK_VERTICAL_SCALE,
      source.z / QUICK_HORIZONTAL_SCALE,
    ).normalize();
  }

  private floorSurfaceAt(x: number, z: number, fromY: number): { height: number; normal: THREE.Vector3 } | null {
    let hasSurface = false;
    let highestHeight = Number.NEGATIVE_INFINITY;
    this.floorNormal.set(0, 1, 0);
    const terrainInBounds = Math.abs(x) <= QUICK_LOCAL_WIDTH * 0.5
      && Math.abs(z) <= QUICK_LOCAL_DEPTH * 0.5;
    if (terrainInBounds) {
      const terrainHeight = this.terrainHeightAt(x, z);
      if (terrainHeight <= fromY + 0.04) {
        hasSurface = true;
        highestHeight = terrainHeight;
        this.terrainNormalAt(x, z, this.floorNormal);
      }
    }
    for (const platform of this.platformSurfaces) {
      if (x < platform.minX || x > platform.maxX || z < platform.minZ || z > platform.maxZ) continue;
      if (platform.y <= fromY + 0.04 && platform.y > highestHeight) {
        hasSurface = true;
        highestHeight = platform.y;
        this.floorNormal.set(0, 1, 0);
      }
    }
    for (const path of this.pathSurfaces) {
      const height = path.heightAt(x, z);
      if (height !== null && height <= fromY + 0.04 && height > highestHeight) {
        hasSurface = true;
        highestHeight = height;
        path.normalAt(x, z, this.floorNormal);
      }
    }
    for (const ramp of this.rampSurfaces) {
      const height = ramp.flow.heightAt(x, z);
      if (height !== null && height <= fromY + 0.04 && height > highestHeight) {
        hasSurface = true;
        highestHeight = height;
        ramp.flow.normalAt(x, z, this.floorNormal);
      }
    }
    for (const ramp of this.buildingEntryRamps) {
      const height = this.buildingEntryRampHeightAt(ramp, x, z);
      if (height === null || height > fromY + 0.04 || height <= highestHeight) continue;
      hasSurface = true;
      highestHeight = height;
      const dx = ramp.end.x - ramp.start.x;
      const dz = ramp.end.z - ramp.start.z;
      const length = Math.hypot(dx, dz);
      const slope = (ramp.end.y - ramp.start.y) / Math.max(EPSILON, length);
      this.floorNormal.set(
        -slope * dx / length,
        1,
        -slope * dz / length,
      ).normalize();
    }
    const towerHeight = this.outpostTowerFloorAt(x, z, fromY, this.outpostTowerCollisionNormal);
    if (towerHeight !== null && towerHeight > highestHeight) {
      hasSurface = true;
      highestHeight = towerHeight;
      this.floorNormal.copy(this.outpostTowerCollisionNormal);
    }
    const staticHeight = this.staticWorldFloorAt(x, z, fromY, this.outpostTowerCollisionNormal);
    if (staticHeight !== null && staticHeight > highestHeight) {
      hasSurface = true;
      highestHeight = staticHeight;
      this.floorNormal.copy(this.outpostTowerCollisionNormal);
    }
    if (!hasSurface) return null;
    this.floorSurface.height = highestHeight;
    return this.floorSurface;
  }

  private outpostTowerFloorAt(
    x: number,
    z: number,
    fromY: number,
    targetNormal: THREE.Vector3,
  ): number | null {
    const boundsTree = this.outpostTowerFloorBoundsTree;
    if (!boundsTree) return null;
    const bounds = this.outpostTowerCollisionBounds;
    if (x < bounds.min.x || x > bounds.max.x || z < bounds.min.z || z > bounds.max.z) return null;
    const originY = Number.isFinite(fromY)
      ? Math.min(fromY + 0.035, bounds.max.y + 0.08)
      : bounds.max.y + 0.08;
    if (originY < bounds.min.y) return null;
    this.outpostTowerFloorRay.origin.set(x, originY, z);
    const hit = boundsTree.raycastFirst(
      this.outpostTowerFloorRay,
      THREE.FrontSide,
      0,
      originY - bounds.min.y + 0.16,
    );
    if (!hit?.face?.normal || hit.face.normal.y <= 0.12) return null;
    targetNormal.copy(hit.face.normal);
    return hit.point.y;
  }

  private staticWorldFloorAt(
    x: number,
    z: number,
    fromY: number,
    targetNormal: THREE.Vector3,
  ): number | null {
    const boundsTree = this.staticWorldFloorBoundsTree;
    if (!boundsTree) return null;
    const bounds = this.staticWorldFloorBounds;
    if (x < bounds.min.x || x > bounds.max.x || z < bounds.min.z || z > bounds.max.z) return null;
    const originY = Number.isFinite(fromY)
      ? Math.min(fromY + 0.035, bounds.max.y + 0.08)
      : bounds.max.y + 0.08;
    if (originY < bounds.min.y) return null;
    this.outpostTowerFloorRay.origin.set(x, originY, z);
    const hit = boundsTree.raycastFirst(
      this.outpostTowerFloorRay,
      THREE.FrontSide,
      0,
      originY - bounds.min.y + 0.16,
    );
    if (!hit?.face?.normal) return null;
    targetNormal.copy(hit.face.normal);
    return hit.point.y;
  }

  private isConcretePoint(x: number, z: number, height: number): boolean {
    if (this.pathSurfaces.some((path) => path.contains(x, z))) return true;
    if (this.rampSurfaces.some((ramp) => ramp.flow.heightAt(x, z) !== null)) return true;
    if (this.buildingEntryRamps.some((ramp) => this.buildingEntryRampHeightAt(ramp, x, z) !== null)) return true;
    return this.platformSurfaces.some((platform) => (
      x >= platform.minX - 0.4 && x <= platform.maxX + 0.4
      && z >= platform.minZ - 0.4 && z <= platform.maxZ + 0.4
      && Math.abs(height - platform.y) < 0.5
    ));
  }

  private boxNormal(
    box: THREE.Box3,
    point: THREE.Vector3,
    direction: THREE.Vector3,
    target: THREE.Vector3,
  ): THREE.Vector3 {
    let closestDistance = Math.abs(point.x - box.min.x);
    target.set(-1, 0, 0);
    let faceDistance = Math.abs(point.x - box.max.x);
    if (faceDistance < closestDistance) {
      closestDistance = faceDistance;
      target.set(1, 0, 0);
    }
    faceDistance = Math.abs(point.y - box.min.y);
    if (faceDistance < closestDistance) {
      closestDistance = faceDistance;
      target.set(0, -1, 0);
    }
    faceDistance = Math.abs(point.y - box.max.y);
    if (faceDistance < closestDistance) {
      closestDistance = faceDistance;
      target.set(0, 1, 0);
    }
    faceDistance = Math.abs(point.z - box.min.z);
    if (faceDistance < closestDistance) {
      closestDistance = faceDistance;
      target.set(0, 0, -1);
    }
    faceDistance = Math.abs(point.z - box.max.z);
    if (faceDistance < closestDistance) target.set(0, 0, 1);
    if (target.dot(direction) > 0) target.negate();
    return target;
  }

  private rampSolidContact(
    ramp: RampSurface,
    position: THREE.Vector3,
    radius = MOVEMENT.playerRadius,
    height = MOVEMENT.playerHeight,
  ): { normal: THREE.Vector3; depth: number } | null {
    const { spec } = ramp;
    if (!(spec.solid ?? true)) return null;
    const dx = position.x - spec.origin.x;
    const dz = position.z - spec.origin.z;
    const sine = Math.sin(spec.heading);
    const cosine = Math.cos(spec.heading);
    const longitudinal = dx * sine + dz * cosine;
    const lateral = dx * cosine - dz * sine;
    const halfWidth = spec.width * 0.5;
    if (longitudinal <= -radius || longitudinal >= spec.length + radius || lateral <= -halfWidth - radius || lateral >= halfWidth + radius) return null;
    const clampedLongitudinal = THREE.MathUtils.clamp(longitudinal, 0, spec.length);
    const clampedLateral = THREE.MathUtils.clamp(lateral, -halfWidth, halfWidth);
    const sampleX = spec.origin.x + sine * clampedLongitudinal + cosine * clampedLateral;
    const sampleZ = spec.origin.z + cosine * clampedLongitudinal - sine * clampedLateral;
    const u = THREE.MathUtils.clamp(clampedLongitudinal / spec.length, 0, 1);
    const surfaceY = sampleLaunchRampHeight(spec, sampleX, sampleZ)
      ?? spec.origin.y + spec.rise * sampleLaunchRampProfile(spec, u);
    const collisionSkirtDepth = spec.collisionSkirtDepth ?? spec.skirtDepth ?? 0.8;
    const bottomY = spec.followSurfaceUnderside
      ? surfaceY - collisionSkirtDepth
      : Math.min(spec.origin.y, spec.origin.y + spec.rise) - collisionSkirtDepth;
    if (position.y + height <= bottomY + 0.01 || position.y >= surfaceY - 0.015) return null;
    const entryDepth = Math.max(radius + 0.35, spec.length * 0.08);
    const localStepHeight = MOVEMENT.stepHeight / QUICK_VERTICAL_SCALE;
    if (
      (longitudinal <= entryDepth || longitudinal >= spec.length - entryDepth)
      && Math.abs(lateral) <= halfWidth
      && surfaceY - position.y <= localStepHeight + 0.16 / QUICK_VERTICAL_SCALE
    ) return null;
    let depth = longitudinal + radius;
    let normalX = -sine;
    let normalZ = -cosine;
    const exitDepth = spec.length + radius - longitudinal;
    if (exitDepth < depth) { depth = exitDepth; normalX = sine; normalZ = cosine; }
    const leftDepth = lateral + halfWidth + radius;
    if (leftDepth < depth) { depth = leftDepth; normalX = -cosine; normalZ = sine; }
    const rightDepth = halfWidth + radius - lateral;
    if (rightDepth < depth) { depth = rightDepth; normalX = cosine; normalZ = -sine; }
    this.rampNormal.set(normalX, 0, normalZ);
    return { normal: this.rampNormal, depth };
  }
}
