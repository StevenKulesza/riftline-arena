import * as THREE from 'three';
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

type GroundBuildingSpec = {
  x: number;
  z: number;
  roofY: number;
  width: number;
  depth: number;
  height: number;
  yaw: number;
  accent: AccentRole;
  collidable: boolean;
};

type FloatingBuildingSpec = {
  x: number;
  z: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  yaw: number;
  accent: AccentRole;
};

const PANEL_GRID = 256;
const EPSILON = 0.0001;
const QUICK_LOCAL_WIDTH = 180;
const QUICK_LOCAL_DEPTH = 160;
const QUICK_HORIZONTAL_SCALE = 2;
const QUICK_VERTICAL_SCALE = 1.6;
const QUICK_WEATHER_DIRECTION = new THREE.Vector2(0.82, 0.28).normalize();

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
  return curve.getPoints(samples).map((point) => ({ x: point.x, y: point.y, z: point.z }));
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

function pathHeightAt(path: PathSurface, x: number, z: number): number | null {
  const nearest = closestSegment(path.points, path.closed, x, z);
  if (!nearest || nearest.distanceSquared > (path.width * 0.5 + 0.08) ** 2) return null;
  const a = path.points[nearest.index];
  const b = path.points[(nearest.index + 1) % path.points.length];
  return THREE.MathUtils.lerp(a.y, b.y, nearest.t) + nearest.lateral * path.bank;
}

function pathNormalAt(path: PathSurface, x: number, z: number, target: THREE.Vector3): THREE.Vector3 | null {
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

function buildPathVertexNormals(points: PathPoint[], closed: boolean, bank: number): PathPoint[] {
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

function createPanelTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = PANEL_GRID;
  canvas.height = PANEL_GRID;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('QuickSense could not create its panel texture.');
  context.fillStyle = '#8b9296';
  context.fillRect(0, 0, PANEL_GRID, PANEL_GRID);
  const panelWidth = 128;
  const panelHeight = 64;
  for (let panelZ = 0; panelZ < PANEL_GRID / panelHeight; panelZ += 1) {
    for (let panelX = 0; panelX < PANEL_GRID / panelWidth; panelX += 1) {
      const variation = (panelX * 5 + panelZ * 3) % 5;
      context.fillStyle = ['#969da1', '#878e92', '#a0a6a9', '#90979b', '#858d91'][variation];
      const x = panelX * panelWidth;
      const y = panelZ * panelHeight;
      context.fillRect(x + 2, y + 2, panelWidth - 4, panelHeight - 4);
      context.strokeStyle = 'rgba(18, 23, 27, 0.48)';
      context.lineWidth = 2;
      context.strokeRect(x + 1.5, y + 1.5, panelWidth - 3, panelHeight - 3);
      context.strokeStyle = 'rgba(230, 235, 237, 0.12)';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x + 5, y + 5);
      context.lineTo(x + panelWidth - 5, y + 5);
      context.stroke();
      context.fillStyle = 'rgba(19, 23, 26, 0.58)';
      context.fillRect(x + 7, y + 7, 3, 3);
      context.fillRect(x + panelWidth - 10, y + panelHeight - 10, 3, 3);
      context.strokeStyle = 'rgba(255, 255, 255, 0.045)';
      context.beginPath();
      context.moveTo(x + 20, y + panelHeight - 14);
      context.lineTo(x + panelWidth - 20, y + 14);
      context.stroke();
    }
  }
  const wash = context.createLinearGradient(0, 0, PANEL_GRID, PANEL_GRID);
  wash.addColorStop(0, 'rgba(255,255,255,0.06)');
  wash.addColorStop(0.45, 'rgba(255,255,255,0)');
  wash.addColorStop(1, 'rgba(10,14,18,0.09)');
  context.fillStyle = wash;
  context.fillRect(0, 0, PANEL_GRID, PANEL_GRID);
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'QuickSensePanelGrid';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 1);
  texture.anisotropy = 4;
  return texture;
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
  private readonly platformSurfaces: PlatformSurface[] = [];
  private readonly rampSurfaces: RampSurface[] = [];
  private readonly shotBoxes: THREE.Box3[] = [];
  private readonly animatedProps: AnimatedProp[] = [];
  private readonly pulseMaterials: THREE.MeshStandardMaterial[] = [];
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

  constructor(seed: number, skyTexture?: THREE.Texture) {
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

    const panelTexture = createPanelTexture();
    this.textures.push(panelTexture);
    const groundMaterial = this.material('QuickSense olive basin floor', 0xffffff, 0.01, 0.94);
    const groundFoundationMaterial = this.material('QuickSense terrain foundation', 0x343a30, 0.01, 0.99);
    const terrainRouteMaterial = this.material('QuickSense carved ski channels', 0x354044, 0.05, 0.86);
    const deckMaterial = this.material('QuickSense graphite panels', 0xb8bdc0, 0.16, 0.62, panelTexture);
    const sideMaterial = this.material('QuickSense chamfered deck structure', 0x3d484e, 0.18, 0.76);
    const structureMaterial = this.material('QuickSense architectural shells', 0x3b474d, 0.22, 0.7);
    const rockMaterial = this.material('QuickSense volcanic cliffs', 0xffffff, 0.0, 0.96);
    const rockHighlightMaterial = this.material('QuickSense cliff faces', 0x5b6567, 0.0, 0.94);
    const mossCapMaterial = this.material('QuickSense moss cliff caps', 0x667254, 0.01, 1);
    const cyanMaterial = this.emissiveMaterial('QuickSense cyan route', 0x28b9d5, 0x16b9e4);
    const magentaMaterial = this.emissiveMaterial('QuickSense terracotta route', 0xb47754, 0x9b5f3d);
    const amberMaterial = this.emissiveMaterial('QuickSense amber safety', 0xd18b28, 0xb96b0d);
    const whiteMaterial = this.material('QuickSense gunmetal structure trim', 0x818b8f, 0.3, 0.6);
    groundMaterial.vertexColors = true;
    rockMaterial.vertexColors = true;
    rockMaterial.side = THREE.DoubleSide;
    rockHighlightMaterial.vertexColors = true;
    deckMaterial.bumpMap = panelTexture;
    deckMaterial.bumpScale = 0.018;

    this.createPath(
      'Cyan outer basin circuit',
      splinePoints([
        { x: 0, y: 2.2, z: -72 }, { x: -30, y: 7.8, z: -73 }, { x: -59, y: 14.6, z: -62 },
        { x: -75, y: 5.2, z: -38 }, { x: -79, y: 17.6, z: -7 }, { x: -75, y: 7.2, z: 25 },
        { x: -61, y: 22.0, z: 51 }, { x: -36, y: 12.6, z: 67 }, { x: 0, y: 27.0, z: 72 },
      ], 44),
      9.2,
      0.28,
      deckMaterial,
      sideMaterial,
      cyanMaterial,
      amberMaterial,
      false,
    );
    this.createPath(
      'Magenta outer basin circuit',
      splinePoints([
        { x: 0, y: 2.2, z: -72 }, { x: 30, y: 7.8, z: -73 }, { x: 59, y: 14.6, z: -62 },
        { x: 75, y: 5.2, z: -38 }, { x: 79, y: 17.6, z: -7 }, { x: 75, y: 7.2, z: 25 },
        { x: 61, y: 22.0, z: 51 }, { x: 36, y: 12.6, z: 67 }, { x: 0, y: 27.0, z: 72 },
      ], 44),
      9.2,
      -0.28,
      deckMaterial,
      sideMaterial,
      magentaMaterial,
      amberMaterial,
      false,
    );
    this.createPath(
      'Cyan inner momentum spiral',
      splinePoints([
        { x: -4, y: 3.0, z: -59 }, { x: -24, y: 10.0, z: -52 }, { x: -44, y: 4.2, z: -39 },
        { x: -56, y: 15.8, z: -17 }, { x: -53, y: 5.7, z: 8 }, { x: -40, y: 20.5, z: 27 },
        { x: -19, y: 9.5, z: 37 }, { x: 0, y: 22.0, z: 35 },
      ], 40),
      7.8,
      0.24,
      deckMaterial,
      sideMaterial,
      cyanMaterial,
      amberMaterial,
      false,
    );
    this.createPath(
      'Magenta inner momentum spiral',
      splinePoints([
        { x: 4, y: 3.0, z: -59 }, { x: 24, y: 10.0, z: -52 }, { x: 44, y: 4.2, z: -39 },
        { x: 56, y: 15.8, z: -17 }, { x: 53, y: 5.7, z: 8 }, { x: 40, y: 20.5, z: 27 },
        { x: 19, y: 9.5, z: 37 }, { x: 0, y: 22.0, z: 35 },
      ], 40),
      7.8,
      -0.24,
      deckMaterial,
      sideMaterial,
      magentaMaterial,
      amberMaterial,
      false,
    );
    this.createPath(
      'Central uphill spine',
      splinePoints([
        { x: 0, y: 2.0, z: -69 }, { x: 0, y: 4.0, z: -50 }, { x: 0, y: 7.2, z: -30 },
        { x: 0, y: 12.0, z: 0 }, { x: 0, y: 17.0, z: 30 }, { x: 0, y: 21.0, z: 50 },
        { x: 0, y: 24.0, z: 69 },
      ], 36),
      8.8,
      0,
      deckMaterial,
      sideMaterial,
      amberMaterial,
      amberMaterial,
      false,
    );
    this.createPath(
      'Lower velocity cross',
      splinePoints([
        { x: -69, y: 5.5, z: -25 }, { x: -48, y: 14.0, z: -23 }, { x: -27, y: 6.5, z: -14 },
        { x: 0, y: 17.0, z: 3 }, { x: 27, y: 6.5, z: -14 }, { x: 48, y: 14.0, z: -23 },
        { x: 69, y: 5.5, z: -25 },
      ], 36),
      7.6,
      0,
      deckMaterial,
      sideMaterial,
      amberMaterial,
      amberMaterial,
      false,
    );
    this.createPath(
      'Upper velocity cross',
      splinePoints([
        { x: -63, y: 10.0, z: 33 }, { x: -40, y: 18.0, z: 29 }, { x: -20, y: 10.8, z: 20 },
        { x: 0, y: 21.0, z: 12 }, { x: 20, y: 10.8, z: 20 }, { x: 40, y: 18.0, z: 29 },
        { x: 63, y: 10.0, z: 33 },
      ], 36),
      7.4,
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

    this.createRamps(deckMaterial, sideMaterial, cyanMaterial, magentaMaterial, amberMaterial);
    this.createGround(groundMaterial, groundFoundationMaterial, rockMaterial, rockHighlightMaterial, mossCapMaterial);
    this.createTerrainFlowInlays(terrainRouteMaterial, cyanMaterial, magentaMaterial);
    this.createBoundaryArchitecture(sideMaterial, amberMaterial);

    this.addPlatform('Flux Core central dais', 0, 0, 12.2, 24, 3.2, 20, deckMaterial, false);
    for (const side of [-1, 1]) {
      this.registerBoxCollision(
        'Flux Core split dais collision',
        new THREE.Vector3(side * 8.75, 10.6, 0),
        new THREE.Vector3(6.5, 3.2, 20),
      );
    }
    this.addPlatform('North grapple west roof', -10.6, 61, 21.4, 8.4, 3.0, 13, deckMaterial, true);
    this.addPlatform('North grapple east roof', 10.6, 61, 21.4, 8.4, 3.0, 13, deckMaterial, true);
    this.addPlatform('South launch west roof', -10.6, -61, 7.1, 8.4, 2.4, 13, deckMaterial, true);
    this.addPlatform('South launch east roof', 10.6, -61, 7.1, 8.4, 2.4, 13, deckMaterial, true);

    this.createCentralStructures(structureMaterial, whiteMaterial, cyanMaterial, magentaMaterial, amberMaterial);
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
    this.createSkylineGateways(structureMaterial, whiteMaterial, cyanMaterial, magentaMaterial, amberMaterial);
    this.createRouteSupports(sideMaterial, whiteMaterial, cyanMaterial, magentaMaterial);

    const cyanPad = this.createJumpPad(new THREE.Vector3(-42, 2.5, -54), new THREE.Vector3(0.22, 0.76, 0.6), cyanMaterial);
    const magentaPad = this.createJumpPad(new THREE.Vector3(42, 2.5, 54), new THREE.Vector3(-0.22, 0.76, -0.6), magentaMaterial);
    const centerPad = this.createJumpPad(new THREE.Vector3(0, 10.55, 0), new THREE.Vector3(0, 0.88, 0.47), amberMaterial);
    const westPad = this.createJumpPad(new THREE.Vector3(-62, 3.35, 0), new THREE.Vector3(0.78, 0.45, 0), cyanMaterial);
    const eastPad = this.createJumpPad(new THREE.Vector3(62, 3.35, 0), new THREE.Vector3(-0.78, 0.45, 0), magentaMaterial);
    this.jumpPads.push(cyanPad, magentaPad, centerPad, westPad, eastPad);

    this.corePosition = this.localToWorld(new THREE.Vector3(0, 19.6, 0));
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
      rail: this.localToWorld(new THREE.Vector3(0, 23.05, 61)),
      rocket: this.pointOnFloor(-42, 0, 0.8),
      plasma: this.pointOnFloor(42, 0, 0.8),
      shotgun: this.pointOnFloor(-24, -31, 0.8),
      sniper: this.localToWorld(new THREE.Vector3(0, 23.05, -61)),
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
    this.collisionTriangles = Math.round(this.colliders.length * 12 + this.rampSurfaces.length * 72 + this.pathSurfaces.length * 48);
    this.mapInfo = {
      name: QUICKSENSE.name,
      seed,
      generationVersion: QUICKSENSE.generationVersion,
      ready: true,
      topologyHash: `quicksense-${seed.toString(16)}-habitat-flow-v6`,
      bounds: { width: QUICKSENSE.width, depth: QUICKSENSE.depth },
      altitudeRange: { min: 0, max: 180 },
      renderTriangles: Math.round(renderTriangles),
      collisionTriangles: this.collisionTriangles,
      spawnCount: this.spawnPoints.length,
      pickupCount: Object.keys(this.itemPoints).length,
      jumpPadCount: this.jumpPads.length,
      skiRoutes: 10,
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
    const floor = this.floorSurfaceAt(
      position.x,
      position.z,
      position.y + localGroundSnap + 0.08 / QUICK_VERTICAL_SCALE,
    );
    if (floor) {
      this.contactNormal.copy(floor.normal);
      const gap = position.y - floor.height;
      if (
        gap <= 0.015 / QUICK_VERTICAL_SCALE
        || (velocity.y <= 0.5 && gap <= localGroundSnap + 0.025 / QUICK_VERTICAL_SCALE)
      ) {
        const correctionY = floor.height - position.y;
        position.y = floor.height;
        this.correction.y += correctionY;
        const intoSurface = velocity.dot(this.contactNormal);
        if (intoSurface < 0) velocity.addScaledVector(this.contactNormal, -intoSurface);
        grounded = this.contactNormal.y >= MOVEMENT.maxSlopeCosine && intoSurface <= 1.2;
        contacts += 1;
      }
    }

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
      contacts += 1;
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

  floorHeightAt(x: number, z: number, fromY = 96): number | null {
    const local = this.floorSurfaceAt(
      x / QUICK_HORIZONTAL_SCALE,
      z / QUICK_HORIZONTAL_SCALE,
      fromY / QUICK_VERTICAL_SCALE,
    );
    return local ? local.height * QUICK_VERTICAL_SCALE : null;
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
      for (const box of this.shotBoxes) considerBox(box);
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
    const material = new THREE.MeshStandardMaterial({
      name,
      color,
      metalness,
      roughness,
      map,
      flatShading: true,
    });
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

  private createMountainWallGeometry(): THREE.BufferGeometry {
    type RidgePoint = { x: number; z: number; y: number };
    const fortressSlots = [
      { x: -58, z: -82, roofY: 31, halfWidth: 0.16 }, { x: 58, z: -82, roofY: 34, halfWidth: 0.16 },
      { x: -55, z: 82, roofY: 39, halfWidth: 0.17 }, { x: 55, z: 82, roofY: 42, halfWidth: 0.17 },
      { x: -94, z: -39, roofY: 36, halfWidth: 0.14 }, { x: -94, z: 40, roofY: 44, halfWidth: 0.15 },
      { x: 94, z: -40, roofY: 45, halfWidth: 0.15 }, { x: 94, z: 39, roofY: 38, halfWidth: 0.14 },
    ].map((slot) => ({ ...slot, angle: Math.atan2(slot.z, slot.x) }));

    // The old perimeter varied every crest sample independently, creating an
    // evenly serrated crown. These authored macro features make long ridges,
    // deep saddles, and a few memorable peaks before any low-poly faceting.
    const ridgeFeatures = [
      { angle: -2.82, width: 0.34, radius: 9, height: 19 },
      { angle: -2.18, width: 0.28, radius: 14, height: 29 },
      { angle: -1.34, width: 0.38, radius: 7, height: 17 },
      { angle: -0.62, width: 0.25, radius: 13, height: 27 },
      { angle: 0.18, width: 0.33, radius: 8, height: 20 },
      { angle: 0.94, width: 0.27, radius: 15, height: 31 },
      { angle: 1.72, width: 0.36, radius: 8, height: 18 },
      { angle: 2.46, width: 0.3, radius: 12, height: 25 },
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
    const segments = 72;
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
        y: THREE.MathUtils.clamp(70 + heightOffset, 45, 108),
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
      rings[0].push(pointAt(0.805 + recess * 0.055, 2.2 + lowVariation * 0.18, -0.5));
      rings[1].push({
        ...pointAt(0.85 + recess * 0.06, 0, 0.65),
        y: THREE.MathUtils.lerp(11.5 + lowVariation, recessRoofY * 0.38, recess),
      });
      rings[2].push({
        ...pointAt(0.89 + recess * 0.065, 0, -0.8),
        y: THREE.MathUtils.lerp(22.5 + lowVariation * 1.4 - passCut * 5, recessRoofY * 0.72, recess),
      });
      rings[3].push({
        ...pointAt(0.935 + recess * 0.055, 0, 0.35),
        y: THREE.MathUtils.lerp(38 + lowVariation * 1.9 - passCut * 10, recessRoofY + 9, recess),
      });
      rings[4].push({
        x: crest.x,
        z: crest.z,
        y: Math.max(crest.y, recessRoofY + 30 * recess),
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
    const vertices = faceted.getAttribute('position');
    const normals = faceted.getAttribute('normal');
    const cliffDark = new THREE.Color(0x263136);
    const cliffMid = new THREE.Color(0x3d4a4e);
    const cliffLight = new THREE.Color(0x667174);
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
      for (let vertex = 0; vertex < 3; vertex += 1) colors.push(color.r, color.g, color.b);
    }
    faceted.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
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

  private createCliffHabitatGeometry(
    profile: 'foundry' | 'observatory' | 'relay',
  ): THREE.BufferGeometry {
    const footprints: Record<typeof profile, ReadonlyArray<readonly [number, number]>> = {
      foundry: [
        [-0.5, -0.46], [0.18, -0.5], [0.5, -0.27], [0.46, 0.35],
        [0.12, 0.5], [-0.38, 0.39], [-0.5, 0.08],
      ],
      observatory: [
        [-0.5, -0.28], [-0.3, -0.5], [0.3, -0.5], [0.5, -0.28], [0.48, 0.29],
        [0.28, 0.48], [-0.28, 0.48], [-0.48, 0.27],
      ],
      relay: [
        [-0.5, -0.4], [0.05, -0.5], [0.5, -0.18], [0.34, 0.46],
        [-0.06, 0.5], [-0.46, 0.22],
      ],
    };
    const footprint = footprints[profile];
    const topScale = profile === 'foundry' ? 0.82 : profile === 'observatory' ? 0.76 : 0.7;
    const topShiftX = profile === 'foundry' ? -0.05 : profile === 'relay' ? 0.09 : 0;
    const ringSpecs = [
      { y: -0.5, scale: 1, shiftX: 0 },
      { y: 0.12, scale: 1, shiftX: 0 },
      { y: 0.5, scale: topScale, shiftX: topShiftX },
    ];
    const positions: number[] = [];
    for (const ring of ringSpecs) {
      for (const [x, z] of footprint) positions.push(x * ring.scale + ring.shiftX, ring.y, z * ring.scale);
    }
    const indices: number[] = [];
    const verticesPerRing = footprint.length;
    for (let ringIndex = 0; ringIndex < ringSpecs.length - 1; ringIndex += 1) {
      const current = ringIndex * verticesPerRing;
      const nextRing = (ringIndex + 1) * verticesPerRing;
      for (let index = 0; index < verticesPerRing; index += 1) {
        const next = (index + 1) % verticesPerRing;
        indices.push(
          current + index, nextRing + index, nextRing + next,
          current + index, nextRing + next, current + next,
        );
      }
    }
    const capTriangles = THREE.ShapeUtils.triangulateShape(
      footprint.map(([x, z]) => new THREE.Vector2(x, z)),
      [],
    );
    const topStart = (ringSpecs.length - 1) * verticesPerRing;
    for (const [a, b, c] of capTriangles) {
      indices.push(a, b, c);
      indices.push(topStart + a, topStart + c, topStart + b);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
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
    shape.lineTo(0.31, 0.42);
    shape.lineTo(0.15, 0.5);
    shape.lineTo(-0.15, 0.5);
    shape.lineTo(-0.31, 0.42);
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

  private createFloatingKeelGeometry(): THREE.BufferGeometry {
    const positions = [
      -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
      -0.22, -0.15, -0.2, 0.22, -0.15, -0.2, 0.22, -0.15, 0.2, -0.22, -0.15, 0.2,
      0, -0.5, 0,
    ];
    const indices = [
      0, 1, 2, 0, 2, 3,
      0, 4, 5, 0, 5, 1,
      1, 5, 6, 1, 6, 2,
      2, 6, 7, 2, 7, 3,
      3, 7, 4, 3, 4, 0,
      4, 8, 5, 5, 8, 6, 6, 8, 7, 7, 8, 4,
    ];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
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
    for (let index = 0; index < spurSpecs.length; index += 1) {
      const [angle, height, width, depth] = spurSpecs[index];
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
    const segmentsX = 49;
    const segmentsZ = 43;
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
          : Math.sin(xIndex * 12.9898 + zIndex * 78.233) * 0.58
            + Math.sin(xIndex * 2.73 - zIndex * 1.91) * 0.22;
        const jitterZ = boundary
          ? 0
          : Math.sin(xIndex * 39.346 - zIndex * 11.135) * 0.52
            + Math.cos(xIndex * 1.37 + zIndex * 2.41) * 0.2;
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
    const lowShadow = new THREE.Color(0x3d4936);
    const lowSun = new THREE.Color(0x68705a);
    const highRock = new THREE.Color(0x59615e);
    const scree = new THREE.Color(0x46504d);
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

    const fortressApproaches = [
      { x: -58, z: -68.5, radiusX: 15, radiusZ: 11, threshold: 4.6 },
      { x: 58, z: -68.5, radiusX: 15, radiusZ: 11, threshold: 4.8 },
      { x: -55, z: 69, radiusX: 15, radiusZ: 11, threshold: 6.8 },
      { x: 55, z: 69, radiusX: 15, radiusZ: 11, threshold: 7.2 },
      { x: -80, z: -39, radiusX: 10, radiusZ: 14, threshold: 5.6 },
      { x: -80, z: 40, radiusX: 10, radiusZ: 15, threshold: 7.4 },
      { x: 80, z: -40, radiusX: 10, radiusZ: 15, threshold: 7.6 },
      { x: 80, z: 39, radiusX: 10, radiusZ: 14, threshold: 6.2 },
    ];
    for (const approach of fortressApproaches) {
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

    let shapedHeight = height;
    for (const path of this.pathSurfaces) {
      const nearest = closestSegment(path.points, path.closed, x, z);
      if (!nearest) continue;
      const edgeDistance = Math.sqrt(nearest.distanceSquared) - path.width * 0.5;
      const influence = 1 - THREE.MathUtils.smoothstep(edgeDistance, 0.45, 6.5);
      if (influence <= 0) continue;
      const a = path.points[nearest.index];
      const b = path.points[(nearest.index + 1) % path.points.length];
      const routeHeight = THREE.MathUtils.lerp(a.y, b.y, nearest.t) + nearest.lateral * path.bank;
      const clearanceHeight = routeHeight - 0.58;
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

  private createTerrainFlowInlays(
    surfaceMaterial: THREE.MeshStandardMaterial,
    cyanMaterial: THREE.MeshStandardMaterial,
    magentaMaterial: THREE.MeshStandardMaterial,
  ): void {
    const lanes = [
      {
        name: 'Cyan carved ski swale',
        material: cyanMaterial,
        points: splinePoints([
          { x: -22, y: 0, z: -60 }, { x: -25, y: 0, z: -40 }, { x: -28, y: 0, z: -20 },
          { x: -31, y: 0, z: 0 }, { x: -34, y: 0, z: 20 }, { x: -37, y: 0, z: 40 },
          { x: -40, y: 0, z: 60 },
        ], 44),
      },
      {
        name: 'Magenta carved ski swale',
        material: magentaMaterial,
        points: splinePoints([
          { x: 22, y: 0, z: -60 }, { x: 25, y: 0, z: -40 }, { x: 28, y: 0, z: -20 },
          { x: 31, y: 0, z: 0 }, { x: 34, y: 0, z: 20 }, { x: 37, y: 0, z: 40 },
          { x: 40, y: 0, z: 60 },
        ], 44),
      },
    ];
    for (const lane of lanes) {
      const swale = this.addMesh(
        this.createTerrainInlayGeometry(lane.points, 10.6, 0.035),
        surfaceMaterial,
        lane.name,
      );
      swale.castShadow = false;
      const signal = this.addMesh(
        this.createTerrainInlayGeometry(lane.points, 0.34, 0.095),
        lane.material,
        `${lane.name} route signal`,
      );
      signal.castShadow = false;
      signal.receiveShadow = false;
    }
  }

  private createTerrainInlayGeometry(
    points: PathPoint[],
    width: number,
    lift: number,
  ): THREE.BufferGeometry {
    const lateralSegments = width > 1 ? 4 : 1;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    let distance = 0;
    for (let index = 0; index < points.length; index += 1) {
      const previous = points[Math.max(0, index - 1)];
      const current = points[index];
      const next = points[Math.min(points.length - 1, index + 1)];
      if (index > 0) distance += Math.hypot(current.x - previous.x, current.z - previous.z);
      const tangentX = next.x - previous.x;
      const tangentZ = next.z - previous.z;
      const tangentLength = Math.hypot(tangentX, tangentZ) || 1;
      const crossX = tangentZ / tangentLength;
      const crossZ = -tangentX / tangentLength;
      for (let lateralIndex = 0; lateralIndex <= lateralSegments; lateralIndex += 1) {
        const v = lateralIndex / lateralSegments;
        const lateral = (v - 0.5) * width;
        const x = current.x + crossX * lateral;
        const z = current.z + crossZ * lateral;
        positions.push(x, this.terrainHeightAt(x, z) + lift, z);
        uvs.push(distance / 8, v);
      }
    }
    const row = lateralSegments + 1;
    for (let index = 0; index < points.length - 1; index += 1) {
      for (let lateralIndex = 0; lateralIndex < lateralSegments; lateralIndex += 1) {
        const a = index * row + lateralIndex;
        const b = (index + 1) * row + lateralIndex;
        const c = a + 1;
        const d = b + 1;
        indices.push(a, b, d, a, d, c);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private createPath(
    name: string,
    points: PathPoint[],
    width: number,
    bank: number,
    deckMaterial: THREE.MeshStandardMaterial,
    sideMaterial: THREE.MeshStandardMaterial,
    edgeMaterial: THREE.MeshStandardMaterial,
    safetyMaterial: THREE.MeshStandardMaterial,
    closed: boolean,
  ): PathSurface {
    const path: PathSurface = {
      name,
      points,
      vertexNormals: buildPathVertexNormals(points, closed, bank),
      width,
      bank,
      closed,
      contains: (x, z) => {
        const nearest = closestSegment(points, closed, x, z);
        return Boolean(nearest && nearest.distanceSquared <= (width * 0.5 + 0.08) ** 2);
      },
      heightAt: (x, z) => pathHeightAt(path, x, z),
      normalAt: (x, z, target = new THREE.Vector3()) => pathNormalAt(path, x, z, target),
    };
    this.pathSurfaces.push(path);

    const positions: number[] = [];
    const uvs: number[] = [];
    const topIndices: number[] = [];
    const sideIndices: number[] = [];
    const segmentCount = closed ? points.length : points.length - 1;
    // The route body is a finished bridge deck rather than a paper-thin
    // ribbon. Its lower perimeter is inset to create a broad structural
    // chamfer while the analytic riding surface stays exactly unchanged.
    const bottomDepth = 1.08;
    const bottomInset = Math.min(0.38, width * 0.045);
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
      const left = new THREE.Vector3(
        current.x - crossX * width * 0.5,
        current.y - bank * width * 0.5,
        current.z - crossZ * width * 0.5,
      );
      const right = new THREE.Vector3(
        current.x + crossX * width * 0.5,
        current.y + bank * width * 0.5,
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
      0.26,
      bank,
      0.17,
    );
    const safety = this.addMesh(safetyGeometry, safetyMaterial, `${name} amber edge trim`);
    safety.castShadow = false;
    safety.receiveShadow = false;
    const factionGeometry = this.createRibbonGeometry(points, closed, [0], 0.16, bank, 0.185);
    const faction = this.addMesh(factionGeometry, edgeMaterial, `${name} faction centerline`);
    faction.castShadow = false;
    faction.receiveShadow = false;

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

  private createRibbonGeometry(
    points: PathPoint[],
    closed: boolean,
    offsets: number[],
    ribbonWidth: number,
    bank: number,
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
        const centerX = current.x + crossX * offset;
        const centerZ = current.z + crossZ * offset;
        const centerY = current.y + bank * offset + lift;
        positions.push(
          centerX - crossX * ribbonWidth * 0.5,
          centerY - bank * ribbonWidth * 0.5,
          centerZ - crossZ * ribbonWidth * 0.5,
          centerX + crossX * ribbonWidth * 0.5,
          centerY + bank * ribbonWidth * 0.5,
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
  ): void {
    const ramps: Array<{ name: string; spec: LaunchRampSpec; edge: THREE.MeshStandardMaterial }> = [
      {
        name: 'South progressive launch',
        spec: { origin: { x: 0, y: 3.05, z: -69 }, heading: 0, length: 34, width: 11.5, rise: 15.6, curveExponent: 1.82, profile: 'smootherstep', troughDepth: 0.72, longitudinalSegments: 32, lateralSegments: 6, solid: true, skirtDepth: 1.18, edgeChamfer: 0.38, followSurfaceUnderside: true },
        edge: amberMaterial,
      },
      {
        name: 'North return launch',
        spec: { origin: { x: 0, y: 27.0, z: 69 }, heading: Math.PI, length: 34, width: 11.5, rise: -15.6, curveExponent: 1.82, profile: 'smootherstep', troughDepth: 0.72, longitudinalSegments: 32, lateralSegments: 6, solid: true, skirtDepth: 1.18, edgeChamfer: 0.38, followSurfaceUnderside: true },
        edge: amberMaterial,
      },
      {
        name: 'West transfer ramp',
        spec: { origin: { x: -77, y: 10.8, z: -18 }, heading: Math.PI * 0.5, length: 35, width: 10.5, rise: 11.8, curveExponent: 1.78, profile: 'smootherstep', troughDepth: 0.6, longitudinalSegments: 30, lateralSegments: 6, solid: true, skirtDepth: 1.08, edgeChamfer: 0.34, followSurfaceUnderside: true },
        edge: cyanMaterial,
      },
      {
        name: 'East transfer ramp',
        spec: { origin: { x: 77, y: 10.8, z: 18 }, heading: -Math.PI * 0.5, length: 35, width: 10.5, rise: 11.8, curveExponent: 1.78, profile: 'smootherstep', troughDepth: 0.6, longitudinalSegments: 30, lateralSegments: 6, solid: true, skirtDepth: 1.08, edgeChamfer: 0.34, followSurfaceUnderside: true },
        edge: magentaMaterial,
      },
      {
        name: 'Center dais transition',
        spec: { origin: { x: 0, y: 7.5, z: -28 }, heading: 0, length: 17.8, width: 9.5, rise: 4.7, curveExponent: 1.55, profile: 'smootherstep', troughDepth: 0.46, longitudinalSegments: 22, lateralSegments: 6, solid: true, skirtDepth: 0.92, edgeChamfer: 0.3, followSurfaceUnderside: true },
        edge: amberMaterial,
      },
    ];
    for (const ramp of ramps) {
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
    }
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
    const crossBeams: InstanceTransform[] = [];
    const accents: InstanceTransform[] = [];
    for (const u of [0.34, 0.72]) {
      const deckCenter = this.rampPoint(spec, u, 0);
      const terrain = this.terrainHeightAt(deckCenter.x, deckCenter.z);
      const height = Math.max(0.7, deckCenter.y - terrain - (spec.skirtDepth ?? 0.45));
      if (height > 1.15) {
        for (const side of [-1, 1]) {
          const foot = this.rampPoint(spec, u, side * spec.width * 0.37);
          supports.push({
            position: new THREE.Vector3(foot.x, terrain + height * 0.5, foot.z),
            scale: new THREE.Vector3(1.28, height, 1.9),
            yaw: spec.heading,
          });
        }
      }
      crossBeams.push({
        position: new THREE.Vector3(deckCenter.x, deckCenter.y - (spec.skirtDepth ?? 0.45) - 0.18, deckCenter.z),
        scale: new THREE.Vector3(spec.width * 0.92, 0.34, 1.05),
        yaw: spec.heading,
      });
      accents.push({
        position: new THREE.Vector3(deckCenter.x, deckCenter.y - (spec.skirtDepth ?? 0.45) - 0.37, deckCenter.z),
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
      'QuickSense ramp cross beams',
      new THREE.BoxGeometry(1, 1, 1),
      structureMaterial,
      crossBeams,
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
    return new THREE.Vector3(x, y + 0.2, z);
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

  private createCentralStructures(
    sideMaterial: THREE.MeshStandardMaterial,
    whiteMaterial: THREE.MeshStandardMaterial,
    cyanMaterial: THREE.MeshStandardMaterial,
    magentaMaterial: THREE.MeshStandardMaterial,
    amberMaterial: THREE.MeshStandardMaterial,
  ): void {
    const taperedOctagon = new THREE.CylinderGeometry(0.82, 1, 1, 8);
    const octagonalSlab = new THREE.CylinderGeometry(1, 1.08, 1, 8);
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const lowerBastions: InstanceTransform[] = [
      { position: new THREE.Vector3(-10.2, 16.2, 0), scale: new THREE.Vector3(5.8, 8, 7.4), yaw: Math.PI / 8 },
      { position: new THREE.Vector3(10.2, 16.2, 0), scale: new THREE.Vector3(5.8, 8, 7.4), yaw: -Math.PI / 8 },
    ];
    const towerShafts: InstanceTransform[] = [
      { position: new THREE.Vector3(-8.8, 26.3, 0), scale: new THREE.Vector3(3.4, 20.2, 4.1), yaw: Math.PI / 8 },
      { position: new THREE.Vector3(8.8, 26.3, 0), scale: new THREE.Vector3(3.4, 20.2, 4.1), yaw: -Math.PI / 8 },
      { position: new THREE.Vector3(0, 25.2, 0), scale: new THREE.Vector3(1.55, 20, 1.55), yaw: Math.PI / 8 },
    ];
    const plinths: InstanceTransform[] = [
      { position: new THREE.Vector3(-10.2, 12.9, 0), scale: new THREE.Vector3(7.5, 2.1, 8.7), yaw: Math.PI / 8 },
      { position: new THREE.Vector3(10.2, 12.9, 0), scale: new THREE.Vector3(7.5, 2.1, 8.7), yaw: -Math.PI / 8 },
      { position: new THREE.Vector3(-8.8, 36.7, 0), scale: new THREE.Vector3(5.1, 1.25, 5.7), yaw: Math.PI / 8 },
      { position: new THREE.Vector3(8.8, 36.7, 0), scale: new THREE.Vector3(5.1, 1.25, 5.7), yaw: -Math.PI / 8 },
    ];
    this.addInstancedMeshes('Flux Core stepped bastions', taperedOctagon, sideMaterial, lowerBastions);
    this.addInstancedMeshes('Flux Core vertical citadel', taperedOctagon, sideMaterial, towerShafts);
    this.addInstancedMeshes('Flux Core octagonal crowns', octagonalSlab, whiteMaterial, plinths);

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
    this.addInstancedMeshes('Flux Core bridge shoulders', unitBox, sideMaterial, shoulders);
    this.addInstancedMeshes('Flux Core cyan wayfinding', unitBox, cyanMaterial, cyanSignals, false);
    this.addInstancedMeshes('Flux Core magenta wayfinding', unitBox, magentaMaterial, magentaSignals, false);
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
    this.createTower(-23, 7, 12.5, 24, cyanMaterial, sideMaterial);
    this.createTower(23, 7, 12.5, 24, magentaMaterial, sideMaterial);

    const northGateShafts: InstanceTransform[] = [
      { position: new THREE.Vector3(-8.7, 20.2, 47), scale: new THREE.Vector3(3.25, 37.5, 3.8), yaw: Math.PI / 8 },
      { position: new THREE.Vector3(8.7, 20.2, 47), scale: new THREE.Vector3(3.25, 37.5, 3.8), yaw: -Math.PI / 8 },
    ];
    const northGateCaps: InstanceTransform[] = [
      { position: new THREE.Vector3(-8.7, 39.2, 47), scale: new THREE.Vector3(4.8, 1.1, 5.3), yaw: Math.PI / 8 },
      { position: new THREE.Vector3(8.7, 39.2, 47), scale: new THREE.Vector3(4.8, 1.1, 5.3), yaw: -Math.PI / 8 },
    ];
    this.addInstancedMeshes('QuickSense north grapple gate shafts', taperedOctagon, sideMaterial, northGateShafts);
    this.addInstancedMeshes('QuickSense north grapple gate crowns', octagonalSlab, whiteMaterial, northGateCaps);
    this.addInstancedMeshes('QuickSense north grapple gate bridge', unitBox, sideMaterial, [
      { position: new THREE.Vector3(0, 37.6, 47), scale: new THREE.Vector3(21.4, 2.2, 4.8) },
    ]);
    this.addInstancedMeshes('QuickSense north gate faction signals', unitBox, cyanMaterial, [
      { position: new THREE.Vector3(-8.7, 21.2, 44.94), scale: new THREE.Vector3(0.34, 24, 0.2) },
      { position: new THREE.Vector3(-5.1, 37.72, 44.48), scale: new THREE.Vector3(5.5, 0.3, 0.2) },
    ], false);
    this.addInstancedMeshes('QuickSense north gate magenta signals', unitBox, magentaMaterial, [
      { position: new THREE.Vector3(8.7, 21.2, 44.94), scale: new THREE.Vector3(0.34, 24, 0.2) },
      { position: new THREE.Vector3(5.1, 37.72, 44.48), scale: new THREE.Vector3(5.5, 0.3, 0.2) },
    ], false);
    this.addInstancedMeshes('QuickSense north gate amber crown', unitBox, amberMaterial, [
      { position: new THREE.Vector3(0, 38.78, 44.46), scale: new THREE.Vector3(8.6, 0.3, 0.22) },
    ], false);
    for (const x of [-8.7, 8.7]) {
      this.registerBoxCollision(
        'QuickSense north grapple gate collision',
        new THREE.Vector3(x, 20.2, 47),
        new THREE.Vector3(3.7, 37.5, 4.3),
      );
    }
  }

  private createTower(
    x: number,
    z: number,
    baseY: number,
    height: number,
    accent: THREE.MeshStandardMaterial,
    sideMaterial: THREE.MeshStandardMaterial,
  ): void {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 5.2, 2.1, 8), sideMaterial);
    base.name = 'QuickSense octagonal tower base';
    base.position.set(x, baseY, z);
    this.geometries.push(base.geometry);
    this.group.add(base);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.8, height, 6), sideMaterial);
    shaft.name = 'QuickSense grapple tower';
    shaft.position.set(x, baseY + height * 0.5 + 0.8, z);
    this.geometries.push(shaft.geometry);
    this.group.add(shaft);
    const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, height * 0.74, 5), accent);
    beacon.name = 'QuickSense tower beacon';
    beacon.position.set(x, baseY + height * 0.5 + 0.8, z - 2.28);
    this.geometries.push(beacon.geometry);
    this.group.add(beacon);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(3.1, 3.8, 1.1, 8), accent);
    cap.name = 'QuickSense tower cap';
    cap.position.set(x, baseY + height + 1.35, z);
    this.geometries.push(cap.geometry);
    this.group.add(cap);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(4.8, 0.13, 6, 20), accent);
    ring.name = 'QuickSense tower grapple ring';
    ring.rotation.x = Math.PI * 0.5;
    ring.position.set(x, baseY + height + 2.05, z);
    this.geometries.push(ring.geometry);
    this.group.add(ring);
    this.animatedProps.push({ object: ring, baseY: ring.position.y, phase: x * 0.02 + z * 0.01, spin: x >= 0 ? 0.27 : -0.24 });
    const box = this.box(
      'QuickSense tower collision shaft',
      new THREE.Vector3(x, baseY + height * 0.5 + 0.8, z),
      new THREE.Vector3(4.4, height, 4.4),
      sideMaterial,
      true,
    );
    box.visible = false;
  }

  private createIntegratedCliffHabitats(
    sideMaterial: THREE.MeshStandardMaterial,
    whiteMaterial: THREE.MeshStandardMaterial,
    cyanMaterial: THREE.MeshStandardMaterial,
    magentaMaterial: THREE.MeshStandardMaterial,
    amberMaterial: THREE.MeshStandardMaterial,
    rockMaterial: THREE.MeshStandardMaterial,
    mossMaterial: THREE.MeshStandardMaterial,
  ): void {
    type HabitatFamily = 'foundry' | 'observatory' | 'relay';
    const specs: GroundBuildingSpec[] = [
      { x: -58, z: -82, roofY: 31, width: 24, depth: 26, height: 27, yaw: Math.PI, accent: 'cyan', collidable: true },
      { x: 58, z: -82, roofY: 34, width: 24, depth: 26, height: 30, yaw: Math.PI, accent: 'magenta', collidable: true },
      { x: -55, z: 82, roofY: 39, width: 25, depth: 26, height: 33, yaw: 0, accent: 'cyan', collidable: true },
      { x: 55, z: 82, roofY: 42, width: 25, depth: 26, height: 36, yaw: 0, accent: 'magenta', collidable: true },
      { x: -94, z: -39, roofY: 36, width: 22, depth: 28, height: 31, yaw: -Math.PI * 0.5, accent: 'cyan', collidable: true },
      { x: -94, z: 40, roofY: 44, width: 24, depth: 28, height: 37, yaw: -Math.PI * 0.5, accent: 'amber', collidable: true },
      { x: 94, z: -40, roofY: 45, width: 24, depth: 28, height: 38, yaw: Math.PI * 0.5, accent: 'amber', collidable: true },
      { x: 94, z: 39, roofY: 38, width: 22, depth: 28, height: 32, yaw: Math.PI * 0.5, accent: 'magenta', collidable: true },
    ];
    const accentMaterials: Record<AccentRole, THREE.MeshStandardMaterial> = {
      cyan: cyanMaterial,
      magenta: magentaMaterial,
      amber: amberMaterial,
    };
    const habitatShells: Record<HabitatFamily, InstanceTransform[]> = {
      foundry: [],
      observatory: [],
      relay: [],
    };
    const rockShoulders: InstanceTransform[] = [];
    const structuralButtresses: InstanceTransform[] = [];
    const terraceSlabs: InstanceTransform[] = [];
    const terraceRetainers: InstanceTransform[] = [];
    const roofShelves: InstanceTransform[] = [];
    const roofDecks: InstanceTransform[] = [];
    const roofParapets: InstanceTransform[] = [];
    const tunnelLintels: InstanceTransform[] = [];
    const portalOpenings: InstanceTransform[] = [];
    const portalFrames: InstanceTransform[] = [];
    const facadeRecesses: InstanceTransform[] = [];
    const facadeBands: InstanceTransform[] = [];
    const mossShelves: InstanceTransform[] = [];
    const foundryRoofTeeth: InstanceTransform[] = [];
    const foundryStacks: InstanceTransform[] = [];
    const observatoryDrums: InstanceTransform[] = [];
    const observatoryRings: InstanceTransform[] = [];
    const relayFins: InstanceTransform[] = [];
    const accentWindows: Record<AccentRole, InstanceTransform[]> = { cyan: [], magenta: [], amber: [] };
    const portalMaterial = this.material('QuickSense inhabited tunnel depth', 0x0c151a, 0.06, 0.97);

    for (let specIndex = 0; specIndex < specs.length; specIndex += 1) {
      const spec = specs[specIndex];
      const family: HabitatFamily = specIndex < 2
        ? 'foundry'
        : specIndex < 4
          ? 'observatory'
          : 'relay';
      const bottomY = spec.roofY - spec.height;
      const asymmetricShift = family === 'foundry'
        ? (specIndex % 2 === 0 ? -1 : 1) * spec.width * 0.035
        : family === 'relay'
          ? (specIndex % 2 === 0 ? 1 : -1) * spec.width * 0.055
          : 0;

      // The primary shell extends through the inner cliff face instead of
      // ending in front of it. A smaller rear-shifted shell makes an inhabited
      // step in the rock rather than a box placed beside the mountain.
      habitatShells[family].push(
        {
          position: this.localOffset(
            spec.x,
            bottomY + spec.height * 0.41,
            spec.z,
            asymmetricShift,
            spec.depth * 0.05,
            spec.yaw,
          ),
          scale: new THREE.Vector3(spec.width * 0.84, spec.height * 0.82, spec.depth * 1.06),
          yaw: spec.yaw,
        },
        {
          position: this.localOffset(
            spec.x,
            spec.roofY - spec.height * 0.16,
            spec.z,
            -asymmetricShift * 1.7,
            spec.depth * 0.27,
            spec.yaw,
          ),
          scale: new THREE.Vector3(spec.width * 0.58, spec.height * 0.32, spec.depth * 0.58),
          yaw: spec.yaw,
        },
      );

      for (const side of [-1, 1]) {
        rockShoulders.push({
          position: this.localOffset(
            spec.x,
            bottomY + spec.height * 0.43,
            spec.z,
            side * spec.width * 0.53,
            spec.depth * 0.28,
            spec.yaw,
          ),
          scale: new THREE.Vector3(spec.width * 0.31, spec.height * 0.9, spec.depth * 0.7),
          yaw: spec.yaw + (side > 0 ? 0.06 : -0.08),
        });
        structuralButtresses.push({
          position: this.localOffset(
            spec.x,
            bottomY + spec.height * 0.25,
            spec.z,
            side * spec.width * 0.36,
            -spec.depth * 0.42,
            spec.yaw,
          ),
          scale: new THREE.Vector3(spec.width * 0.13, spec.height * 0.5, spec.depth * 0.2),
          yaw: spec.yaw,
        });
        roofParapets.push({
          position: this.localOffset(
            spec.x,
            spec.roofY + 1.56,
            spec.z,
            side * spec.width * 0.4,
            spec.depth * 0.02,
            spec.yaw,
          ),
          scale: new THREE.Vector3(0.48, 0.8, spec.depth * 0.72),
          yaw: spec.yaw,
        });
      }

      terraceSlabs.push(
        {
          position: this.localOffset(
            spec.x,
            bottomY + spec.height * 0.31,
            spec.z,
            asymmetricShift * 0.35,
            -spec.depth * 0.42,
            spec.yaw,
          ),
          scale: new THREE.Vector3(spec.width * 0.88, 1.18, spec.depth * 0.25),
          yaw: spec.yaw,
        },
        {
          position: this.localOffset(
            spec.x,
            bottomY + spec.height * 0.59,
            spec.z,
            -asymmetricShift * 0.55,
            -spec.depth * 0.34,
            spec.yaw,
          ),
          scale: new THREE.Vector3(spec.width * 0.72, 0.92, spec.depth * 0.2),
          yaw: spec.yaw,
        },
      );
      terraceRetainers.push({
        position: this.localOffset(
          spec.x,
          bottomY + spec.height * 0.18,
          spec.z,
          asymmetricShift * 0.2,
          -spec.depth * 0.37,
          spec.yaw,
        ),
        scale: new THREE.Vector3(spec.width * 0.7, spec.height * 0.25, spec.depth * 0.18),
        yaw: spec.yaw,
      });
      roofShelves.push({
        position: this.localOffset(spec.x, spec.roofY + 0.56, spec.z, 0, spec.depth * 0.04, spec.yaw),
        scale: new THREE.Vector3(spec.width * 0.96, 1.12, spec.depth * 0.96),
        yaw: spec.yaw,
      });
      roofDecks.push({
        position: this.localOffset(spec.x, spec.roofY + 1.13, spec.z, 0, spec.depth * 0.01, spec.yaw),
        scale: new THREE.Vector3(spec.width * 0.75, 0.06, spec.depth * 0.69),
        yaw: spec.yaw,
      });
      roofParapets.push({
        position: this.localOffset(spec.x, spec.roofY + 1.56, spec.z, 0, spec.depth * 0.37, spec.yaw),
        scale: new THREE.Vector3(spec.width * 0.79, 0.8, 0.48),
        yaw: spec.yaw,
      });

      const portalCenterY = bottomY + spec.height * 0.2;
      portalOpenings.push({
        position: this.localOffset(spec.x, portalCenterY, spec.z, 0, -spec.depth * 0.515, spec.yaw),
        scale: new THREE.Vector3(spec.width * 0.27, spec.height * 0.37, 1),
        yaw: spec.yaw + Math.PI,
      });
      portalFrames.push({
        position: this.localOffset(spec.x, portalCenterY, spec.z, 0, -spec.depth * 0.54, spec.yaw),
        scale: new THREE.Vector3(spec.width * 0.44, spec.height * 0.43, 0.7),
        yaw: spec.yaw,
      });
      tunnelLintels.push({
        position: this.localOffset(
          spec.x,
          bottomY + spec.height * 0.43,
          spec.z,
          0,
          -spec.depth * 0.41,
          spec.yaw,
        ),
        scale: new THREE.Vector3(spec.width * 0.55, 2.7, spec.depth * 0.2),
        yaw: spec.yaw,
      });
      facadeBands.push({
        position: this.localOffset(
          spec.x,
          bottomY + spec.height * 0.43,
          spec.z,
          0,
          -spec.depth * 0.538,
          spec.yaw,
        ),
        scale: new THREE.Vector3(spec.width * 0.7, 0.28, 0.24),
        yaw: spec.yaw,
      });

      const rows = family === 'foundry'
        ? [0.53, 0.69]
        : family === 'observatory'
          ? [0.56, 0.73]
          : [0.51, 0.65, 0.79];
      const columns = family === 'foundry'
        ? [-0.3, -0.1, 0.1, 0.3]
        : family === 'observatory'
          ? [-0.27, 0, 0.27]
          : [-0.2, 0.17];
      for (const row of rows) {
        for (const column of columns) {
          const bayY = bottomY + spec.height * row;
          facadeRecesses.push({
            position: this.localOffset(
              spec.x,
              bayY,
              spec.z,
              spec.width * column,
              -spec.depth * 0.535,
              spec.yaw,
            ),
            scale: new THREE.Vector3(spec.width * 0.135, spec.height * 0.075, 1),
            yaw: spec.yaw + Math.PI,
          });
          accentWindows[spec.accent].push({
            position: this.localOffset(
              spec.x,
              bayY - spec.height * 0.019,
              spec.z,
              spec.width * column,
              -spec.depth * 0.542,
              spec.yaw,
            ),
            scale: new THREE.Vector3(spec.width * 0.09, spec.height * 0.014, 1),
            yaw: spec.yaw + Math.PI,
          });
        }
      }
      accentWindows[spec.accent].push({
        position: this.localOffset(
          spec.x,
          portalCenterY - spec.height * 0.14,
          spec.z,
          0,
          -spec.depth * 0.547,
          spec.yaw,
        ),
        scale: new THREE.Vector3(spec.width * 0.3, spec.height * 0.018, 1),
        yaw: spec.yaw + Math.PI,
      });
      mossShelves.push({
        position: this.localOffset(
          spec.x,
          spec.roofY + 0.32,
          spec.z,
          -asymmetricShift,
          spec.depth * 0.42,
          spec.yaw,
        ),
        scale: new THREE.Vector3(spec.width * 0.46, 0.38, spec.depth * 0.24),
        yaw: spec.yaw,
      });

      if (family === 'foundry') {
        for (const localX of [-0.29, 0, 0.29]) {
          foundryRoofTeeth.push({
            position: this.localOffset(spec.x, spec.roofY + 2.85, spec.z, spec.width * localX, spec.depth * 0.08, spec.yaw),
            scale: new THREE.Vector3(spec.width * 0.17, 4.1, spec.depth * 0.42),
            yaw: spec.yaw,
          });
        }
        for (const localX of [-0.27, 0.27]) {
          foundryStacks.push({
            position: this.localOffset(spec.x, spec.roofY + 5.3, spec.z, spec.width * localX, spec.depth * 0.22, spec.yaw),
            scale: new THREE.Vector3(1.05, 7.8, 1.05),
            yaw: spec.yaw,
          });
        }
      } else if (family === 'observatory') {
        observatoryDrums.push({
          position: this.localOffset(spec.x, spec.roofY + 3.35, spec.z, 0, spec.depth * 0.06, spec.yaw),
          scale: new THREE.Vector3(4.9, 5.2, 4.9),
          yaw: spec.yaw,
        });
        observatoryRings.push({
          position: this.localOffset(spec.x, spec.roofY + 6.05, spec.z, 0, spec.depth * 0.06, spec.yaw),
          scale: new THREE.Vector3(6.5, 6.5, 6.5),
          rotation: new THREE.Euler(Math.PI * 0.5, spec.yaw, 0),
        });
      } else {
        for (const side of [-1, 1]) {
          relayFins.push({
            position: this.localOffset(
              spec.x,
              spec.roofY + 6.5 + (side > 0 ? 1.2 : 0),
              spec.z,
              side * spec.width * 0.24,
              spec.depth * 0.08,
              spec.yaw,
            ),
            scale: new THREE.Vector3(1.55, side > 0 ? 14.5 : 11.8, 3.8),
            yaw: spec.yaw,
          });
        }
      }

      const cosine = Math.abs(Math.cos(spec.yaw));
      const sine = Math.abs(Math.sin(spec.yaw));
      const halfX = spec.width * 0.46 * cosine + spec.depth * 0.45 * sine;
      const halfZ = spec.width * 0.46 * sine + spec.depth * 0.45 * cosine;
      this.platformSurfaces.push({
        name: 'QuickSense cliff fortress roof',
        minX: spec.x - halfX,
        maxX: spec.x + halfX,
        minZ: spec.z - halfZ,
        maxZ: spec.z + halfZ,
        y: spec.roofY + 1.16,
      });
      if (spec.collidable) {
        this.registerBoxCollision(
          'QuickSense mountain-embedded fortress',
          this.localOffset(spec.x, spec.roofY - spec.height * 0.5, spec.z, 0, spec.depth * 0.12, spec.yaw),
          new THREE.Vector3(spec.width * 0.82, spec.height, spec.depth * 0.82),
          spec.yaw,
        );
      }
    }

    for (const family of ['foundry', 'observatory', 'relay'] as const) {
      this.addInstancedMeshes(
        `QuickSense ${family} cliff-fused habitat shells`,
        this.createCliffHabitatGeometry(family),
        sideMaterial,
        habitatShells[family],
      );
    }
    const rockSpurGeometry = this.createRockSpurGeometry();
    const shelfGeometry = this.createRockShelfGeometry();
    const buttressGeometry = this.createCliffButtressGeometry();
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const facadePlane = new THREE.PlaneGeometry(1, 1);
    this.addInstancedMeshes('QuickSense rock-wrapped habitat shoulders', rockSpurGeometry, rockMaterial, rockShoulders);
    this.addInstancedMeshes('QuickSense inhabited cliff buttresses', buttressGeometry, whiteMaterial, structuralButtresses);
    this.addInstancedMeshes('QuickSense stepped cliff habitat terraces', shelfGeometry, sideMaterial, terraceSlabs);
    this.addInstancedMeshes('QuickSense terrace retaining walls', buttressGeometry, sideMaterial, terraceRetainers);
    this.addInstancedMeshes('QuickSense integrated habitat roof shelves', shelfGeometry, sideMaterial, roofShelves);
    this.addInstancedMeshes('QuickSense recessed habitat roof decks', unitBox, portalMaterial, roofDecks, false);
    this.addInstancedMeshes('QuickSense habitat roof parapets', unitBox, sideMaterial, roofParapets, false);
    this.addInstancedMeshes('QuickSense carved tunnel rock lintels', shelfGeometry, rockMaterial, tunnelLintels);
    this.addInstancedMeshes('QuickSense deep tunnel mouths', this.createPortalOpeningGeometry(), portalMaterial, portalOpenings, false);
    this.addInstancedMeshes('QuickSense monolithic tunnel frames', this.createPortalFrameGeometry(), amberMaterial, portalFrames, false);
    this.addInstancedMeshes('QuickSense inhabited facade recess rhythm', facadePlane, portalMaterial, facadeRecesses, false);
    this.addInstancedMeshes('QuickSense habitat facade datum bands', unitBox, whiteMaterial, facadeBands, false);
    this.addInstancedMeshes('QuickSense cliff habitat moss seams', shelfGeometry, mossMaterial, mossShelves, false);
    const asymmetricFinGeometry = this.createAsymmetricFinGeometry();
    this.addInstancedMeshes('QuickSense foundry sawtooth roofline', asymmetricFinGeometry, sideMaterial, foundryRoofTeeth);
    this.addInstancedMeshes('QuickSense foundry exhaust stacks', new THREE.CylinderGeometry(1, 1.16, 1, 6), whiteMaterial, foundryStacks);
    this.addInstancedMeshes('QuickSense observatory drums', new THREE.CylinderGeometry(0.84, 1, 1, 8), sideMaterial, observatoryDrums);
    this.addInstancedMeshes('QuickSense observatory apertures', new THREE.TorusGeometry(1, 0.09, 4, 18), whiteMaterial, observatoryRings, false);
    this.addInstancedMeshes('QuickSense asymmetric cliff relay fins', asymmetricFinGeometry, whiteMaterial, relayFins);
    for (const role of ['cyan', 'magenta', 'amber'] as const) {
      this.addInstancedMeshes(
        `QuickSense ${role} inhabited window lights`,
        facadePlane,
        accentMaterials[role],
        accentWindows[role],
        false,
      );
    }
  }

  private createFloatingStructures(
    sideMaterial: THREE.MeshStandardMaterial,
    whiteMaterial: THREE.MeshStandardMaterial,
    cyanMaterial: THREE.MeshStandardMaterial,
    magentaMaterial: THREE.MeshStandardMaterial,
    amberMaterial: THREE.MeshStandardMaterial,
  ): void {
    const specs: FloatingBuildingSpec[] = [
      { x: -58, z: 23, y: 52, width: 24, height: 12, depth: 16, yaw: -0.24, accent: 'cyan' },
      { x: 58, z: 23, y: 56, width: 24, height: 12, depth: 16, yaw: 0.24, accent: 'magenta' },
      { x: 0, z: 58, y: 66, width: 34, height: 14, depth: 22, yaw: 0, accent: 'amber' },
    ];
    const accentMaterials: Record<AccentRole, THREE.MeshStandardMaterial> = {
      cyan: cyanMaterial,
      magenta: magentaMaterial,
      amber: amberMaterial,
    };
    const hulls: InstanceTransform[] = [];
    const undercarriages: InstanceTransform[] = [];
    const wingBlocks: InstanceTransform[] = [];
    const crownCaps: InstanceTransform[] = [];
    const landingDecks: InstanceTransform[] = [];
    const landingRails: InstanceTransform[] = [];
    const whiteDetails: InstanceTransform[] = [];
    const accentPanels: Record<AccentRole, InstanceTransform[]> = { cyan: [], magenta: [], amber: [] };
    const thrusters: Record<AccentRole, InstanceTransform[]> = { cyan: [], magenta: [], amber: [] };
    const tethers: Record<AccentRole, InstanceTransform[]> = { cyan: [], magenta: [], amber: [] };
    const rings: Record<AccentRole, InstanceTransform[]> = { cyan: [], magenta: [], amber: [] };

    for (const spec of specs) {
      hulls.push({
        position: new THREE.Vector3(spec.x, spec.y, spec.z),
        scale: new THREE.Vector3(spec.width * 0.5, spec.height * 0.92, spec.depth * 0.52),
        yaw: spec.yaw,
      });
      undercarriages.push({
        position: new THREE.Vector3(spec.x, spec.y - spec.height * 0.76, spec.z),
        scale: new THREE.Vector3(spec.width * 0.68, spec.height * 1.28, spec.depth * 0.68),
        yaw: spec.yaw,
      });
      for (const side of [-1, 1]) {
        const wingScale = side > 0 ? 0.42 : 0.32;
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
        whiteDetails.push({
          position: this.localOffset(spec.x, spec.y + spec.height * 0.25, spec.z, side * spec.width * 0.48, -spec.depth * 0.08, spec.yaw),
          scale: new THREE.Vector3(0.55, spec.height * 0.66, spec.depth * 0.42),
          yaw: spec.yaw,
        });
      }
      crownCaps.push({
        position: new THREE.Vector3(spec.x, spec.y + spec.height * 0.54, spec.z),
        scale: new THREE.Vector3(spec.width * 0.82, 0.88, spec.depth * 0.78),
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
      const tetherHeight = Math.max(7, spec.y - spec.height * 0.5 - 2);
      for (const localX of [-0.24, 0, 0.24]) {
        const tetherPoint = this.localOffset(
          spec.x,
          tetherHeight * 0.5,
          spec.z,
          spec.width * localX,
          spec.depth * 0.04,
          spec.yaw,
        );
        tethers[spec.accent].push({
          position: tetherPoint,
          scale: new THREE.Vector3(localX === 0 ? 0.2 : 0.13, tetherHeight, localX === 0 ? 0.2 : 0.13),
        });
      }
      const ringScale = Math.max(spec.width, spec.depth) * 0.32;
      rings[spec.accent].push({
        position: new THREE.Vector3(spec.x, spec.y + spec.height * 0.65 + 1.1, spec.z),
        scale: new THREE.Vector3(ringScale, ringScale, ringScale),
        rotation: new THREE.Euler(Math.PI * 0.5, spec.yaw, 0),
      });
      const roofY = spec.y + spec.height * 0.54 + 0.44;
      this.platformSurfaces.push({
        name: 'QuickSense floating station landing roof',
        minX: spec.x - spec.width * 0.39,
        maxX: spec.x + spec.width * 0.39,
        minZ: spec.z - spec.depth * 0.36,
        maxZ: spec.z + spec.depth * 0.36,
        y: roofY,
      });
      this.registerBoxCollision(
        'QuickSense floating grapple station',
        new THREE.Vector3(spec.x, spec.y, spec.z),
        new THREE.Vector3(spec.width * 1.08, spec.height, spec.depth),
        spec.yaw,
      );
    }

    const taperedHull = this.createChamferedBlockGeometry(0.18);
    const undercarriage = this.createFloatingKeelGeometry();
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const crown = this.createChamferedBlockGeometry(0.14);
    const thruster = new THREE.ConeGeometry(1, 1, 6);
    const tether = new THREE.CylinderGeometry(1, 1, 1, 6);
    const ring = new THREE.TorusGeometry(1, 0.035, 5, 24);
    this.addInstancedMeshes('QuickSense floating station hulls', taperedHull, sideMaterial, hulls);
    this.addInstancedMeshes('QuickSense floating station undercarriages', undercarriage, sideMaterial, undercarriages);
    this.addInstancedMeshes('QuickSense floating station wings', unitBox, sideMaterial, wingBlocks);
    this.addInstancedMeshes('QuickSense floating station crowns', crown, sideMaterial, crownCaps);
    this.addInstancedMeshes('QuickSense floating landing decks', unitBox, sideMaterial, landingDecks, false);
    this.addInstancedMeshes('QuickSense floating landing rails', unitBox, whiteMaterial, landingRails, false);
    this.addInstancedMeshes('QuickSense floating station fins', unitBox, whiteMaterial, whiteDetails);
    for (const role of ['cyan', 'magenta', 'amber'] as const) {
      this.addInstancedMeshes(`QuickSense ${role} floating panels`, unitBox, accentMaterials[role], accentPanels[role], false);
      this.addInstancedMeshes(`QuickSense ${role} station thrusters`, thruster, accentMaterials[role], thrusters[role], false);
      this.addInstancedMeshes(`QuickSense ${role} energy tethers`, tether, accentMaterials[role], tethers[role], false);
      this.addInstancedMeshes(`QuickSense ${role} grapple halos`, ring, accentMaterials[role], rings[role], false);
    }
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

  private createSkylineGateways(
    sideMaterial: THREE.MeshStandardMaterial,
    whiteMaterial: THREE.MeshStandardMaterial,
    cyanMaterial: THREE.MeshStandardMaterial,
    magentaMaterial: THREE.MeshStandardMaterial,
    amberMaterial: THREE.MeshStandardMaterial,
  ): void {
    const pylons = [
      { x: -84.5, z: -16, height: 34, yaw: -0.08, accent: cyanMaterial, role: 'cyan' },
      { x: 84.5, z: 16, height: 36, yaw: 0.08, accent: magentaMaterial, role: 'magenta' },
    ] as const;
    const shafts: InstanceTransform[] = [];
    const bases: InstanceTransform[] = [];
    const shoulders: InstanceTransform[] = [];
    const crowns: InstanceTransform[] = [];
    const signals: Record<'cyan' | 'magenta', InstanceTransform[]> = { cyan: [], magenta: [] };
    const halos: Record<'cyan' | 'magenta', InstanceTransform[]> = { cyan: [], magenta: [] };
    for (const pylon of pylons) {
      const shaftBottom = 2.2;
      shafts.push({
        position: new THREE.Vector3(pylon.x, shaftBottom + pylon.height * 0.5, pylon.z),
        scale: new THREE.Vector3(4.4, pylon.height, 3.7),
        yaw: pylon.yaw,
      });
      bases.push({
        position: new THREE.Vector3(pylon.x, 1.5, pylon.z),
        scale: new THREE.Vector3(6.4, 3, 5.6),
        yaw: pylon.yaw,
      });
      for (const side of [-1, 1]) {
        shoulders.push({
          position: this.localOffset(pylon.x, pylon.height + 5.2, pylon.z, side * 2.65, 0, pylon.yaw),
          scale: new THREE.Vector3(1.55, 7.2, 2.05),
          yaw: pylon.yaw,
        });
      }
      crowns.push(
        {
          position: new THREE.Vector3(pylon.x, pylon.height + 8.45, pylon.z),
          scale: new THREE.Vector3(7.2, 1.25, 3.8),
          yaw: pylon.yaw,
        },
        {
          position: new THREE.Vector3(pylon.x, pylon.height + 2.15, pylon.z),
          scale: new THREE.Vector3(5.9, 0.7, 4.6),
          yaw: pylon.yaw,
        },
      );
      signals[pylon.role].push(
        {
          position: this.localOffset(pylon.x, shaftBottom + pylon.height * 0.52, pylon.z, 0, -2.02, pylon.yaw),
          scale: new THREE.Vector3(0.55, pylon.height * 0.78, 0.2),
          yaw: pylon.yaw,
        },
        {
          position: new THREE.Vector3(pylon.x, pylon.height + 8.55, pylon.z - 2.08),
          scale: new THREE.Vector3(3.2, 0.28, 0.22),
          yaw: pylon.yaw,
        },
      );
      const haloScale = 5.5;
      halos[pylon.role].push({
        position: new THREE.Vector3(pylon.x, pylon.height + 4.2, pylon.z),
        scale: new THREE.Vector3(haloScale, haloScale, haloScale),
        rotation: new THREE.Euler(Math.PI * 0.5, pylon.yaw, 0),
      });
      this.registerBoxCollision(
        `QuickSense ${pylon.role} skyline pylon`,
        new THREE.Vector3(pylon.x, shaftBottom + pylon.height * 0.5, pylon.z),
        new THREE.Vector3(8.8, pylon.height + 5, 7.4),
        pylon.yaw,
      );
    }

    const shaftGeometry = new THREE.CylinderGeometry(0.58, 1, 1, 6);
    const baseGeometry = new THREE.CylinderGeometry(1, 1.16, 1, 8);
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const haloGeometry = new THREE.TorusGeometry(1, 0.05, 5, 24);
    this.addInstancedMeshes('QuickSense skyline pylon shafts', shaftGeometry, sideMaterial, shafts);
    this.addInstancedMeshes('QuickSense skyline pylon bases', baseGeometry, sideMaterial, bases);
    this.addInstancedMeshes('QuickSense skyline pylon forks', unitBox, sideMaterial, shoulders);
    this.addInstancedMeshes('QuickSense skyline pylon crowns', unitBox, whiteMaterial, crowns);
    this.addInstancedMeshes('QuickSense cyan pylon signals', unitBox, cyanMaterial, signals.cyan, false);
    this.addInstancedMeshes('QuickSense magenta pylon signals', unitBox, magentaMaterial, signals.magenta, false);
    this.addInstancedMeshes('QuickSense cyan pylon halo', haloGeometry, cyanMaterial, halos.cyan, false);
    this.addInstancedMeshes('QuickSense magenta pylon halo', haloGeometry, magentaMaterial, halos.magenta, false);

    const cyanPylonTop = new THREE.Vector3(-84.5, 42.5, -16);
    const magentaPylonTop = new THREE.Vector3(84.5, 44.5, 16);
    const cyanStation = new THREE.Vector3(-58, 60, 23);
    const magentaStation = new THREE.Vector3(58, 64, 23);
    const flagship = new THREE.Vector3(0, 75, 58);
    this.createSuspendedCable('QuickSense cyan skyline cable', cyanPylonTop, cyanStation, 8, cyanMaterial, 0.22);
    this.createSuspendedCable('QuickSense magenta skyline cable', magentaPylonTop, magentaStation, 8, magentaMaterial, 0.22);
    this.createSuspendedCable('QuickSense west flagship cable', cyanStation, flagship, 10, amberMaterial, 0.19);
    this.createSuspendedCable('QuickSense east flagship cable', magentaStation, flagship, 12, amberMaterial, 0.19);
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
    const caps: InstanceTransform[] = [];
    const cyanSignals: InstanceTransform[] = [];
    const magentaSignals: InstanceTransform[] = [];
    const neutralSignals: InstanceTransform[] = [];
    for (const path of this.pathSurfaces) {
      const stride = path.closed ? 10 : 11;
      for (let index = Math.floor(stride * 0.55); index < path.points.length; index += stride) {
        const point = path.points[index];
        if (point.y < 3.1 || (Math.abs(point.x) < 15 && Math.abs(point.z) < 17)) continue;
        const terrain = this.terrainHeightAt(point.x, point.z);
        const height = Math.max(1.4, point.y - terrain - 0.18);
        const baseY = terrain;
        columns.push({
          position: new THREE.Vector3(point.x, baseY + height * 0.5, point.z),
          scale: new THREE.Vector3(1.22, height, 1.22),
          yaw: index * 0.17,
        });
        caps.push({
          position: new THREE.Vector3(point.x, point.y - 0.32, point.z),
          scale: new THREE.Vector3(1.72, 0.62, 1.72),
          yaw: index * 0.17,
        });
        const signal = {
          position: new THREE.Vector3(point.x, baseY + height * 0.52, point.z - 0.83),
          scale: new THREE.Vector3(0.16, Math.max(0.7, height * 0.58), 0.1),
          yaw: 0,
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
    const columnGeometry = new THREE.CylinderGeometry(0.72, 1, 1, 6);
    const capGeometry = new THREE.CylinderGeometry(1, 1.14, 1, 8);
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    this.addInstancedMeshes('QuickSense route support columns', columnGeometry, sideMaterial, columns);
    this.addInstancedMeshes('QuickSense route support caps', capGeometry, trimMaterial, caps);
    this.addInstancedMeshes('QuickSense cyan support signals', unitBox, cyanMaterial, cyanSignals, false);
    this.addInstancedMeshes('QuickSense magenta support signals', unitBox, magentaMaterial, magentaSignals, false);
    this.addInstancedMeshes('QuickSense neutral support signals', unitBox, trimMaterial, neutralSignals, false);
  }

  private createJumpPad(position: THREE.Vector3, direction: THREE.Vector3, material: THREE.MeshStandardMaterial): JumpPad {
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.5, 0.34, 8), material);
    pad.name = 'QuickSense jump pad';
    pad.position.copy(position);
    this.geometries.push(pad.geometry);
    this.group.add(pad);
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(1.65, 1.65, 0.38, 8), this.material('QuickSense pad core', 0x9cfbff, 0.25, 0.28));
    inner.name = 'QuickSense jump pad core';
    inner.position.copy(position).add(new THREE.Vector3(0, 0.2, 0));
    this.geometries.push(inner.geometry);
    this.group.add(inner);
    return {
      position: this.localToWorld(position),
      direction: this.localVectorToWorld(direction.clone()).normalize(),
      radius: 4.2 * QUICK_HORIZONTAL_SCALE,
      launchSpeed: 27,
    };
  }

  private pointOnFloor(x: number, z: number, lift = 0.04): THREE.Vector3 {
    const floor = this.floorSurfaceAt(x, z, Number.POSITIVE_INFINITY)?.height ?? 0;
    return new THREE.Vector3(
      x * QUICK_HORIZONTAL_SCALE,
      floor * QUICK_VERTICAL_SCALE + lift,
      z * QUICK_HORIZONTAL_SCALE,
    );
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
    if (Math.abs(x) > QUICK_LOCAL_WIDTH * 0.5 || Math.abs(z) > QUICK_LOCAL_DEPTH * 0.5) return null;
    let hasSurface = false;
    let highestHeight = Number.NEGATIVE_INFINITY;
    this.floorNormal.set(0, 1, 0);
    const terrainHeight = this.terrainHeightAt(x, z);
    if (terrainHeight <= fromY + 0.04) {
      hasSurface = true;
      highestHeight = terrainHeight;
      this.terrainNormalAt(x, z, this.floorNormal);
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
    if (!hasSurface) return null;
    this.floorSurface.height = highestHeight;
    return this.floorSurface;
  }

  private isConcretePoint(x: number, z: number, height: number): boolean {
    if (this.pathSurfaces.some((path) => path.contains(x, z))) return true;
    if (this.rampSurfaces.some((ramp) => ramp.flow.heightAt(x, z) !== null)) return true;
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
    const bottomY = spec.followSurfaceUnderside
      ? surfaceY - (spec.skirtDepth ?? 0.8)
      : Math.min(spec.origin.y, spec.origin.y + spec.rise) - (spec.skirtDepth ?? 0.8);
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
