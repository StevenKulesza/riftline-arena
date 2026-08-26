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
import { buildLaunchRamp, type FlowSurfaceBuild, type LaunchRampSpec } from './FlowGeometry';

export const QUICKSENSE = {
  id: 'quicksense',
  name: 'QuickSense',
  generationVersion: 2,
  width: 360,
  depth: 320,
  killY: -24,
} as const;

type PathPoint = { x: number; y: number; z: number };

type PathSurface = {
  name: string;
  points: PathPoint[];
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

const PANEL_GRID = 128;
const EPSILON = 0.0001;
const QUICK_LOCAL_WIDTH = 180;
const QUICK_LOCAL_DEPTH = 160;
const QUICK_HORIZONTAL_SCALE = 2;
const QUICK_VERTICAL_SCALE = 1.6;
const QUICK_WEATHER_DIRECTION = new THREE.Vector2(0.82, 0.28).normalize();

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
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
  const a = path.points[nearest.index];
  const b = path.points[(nearest.index + 1) % path.points.length];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz) || 1;
  const tx = dx / length;
  const tz = dz / length;
  const slope = (b.y - a.y) / length;
  const dHeightDx = slope * tx + path.bank * tz;
  const dHeightDz = slope * tz - path.bank * tx;
  return target.set(-dHeightDx, 1, -dHeightDz).normalize();
}

function createPanelTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = PANEL_GRID;
  canvas.height = PANEL_GRID;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('QuickSense could not create its panel texture.');
  context.fillStyle = '#63676a';
  context.fillRect(0, 0, PANEL_GRID, PANEL_GRID);
  const panelSize = 32;
  for (let panelZ = 0; panelZ < PANEL_GRID / panelSize; panelZ += 1) {
    for (let panelX = 0; panelX < PANEL_GRID / panelSize; panelX += 1) {
      const variation = (panelX * 5 + panelZ * 3) % 4;
      context.fillStyle = ['#636669', '#585c5f', '#6c7073', '#5e6265'][variation];
      const x = panelX * panelSize;
      const y = panelZ * panelSize;
      context.fillRect(x + 1, y + 1, panelSize - 2, panelSize - 2);
      context.strokeStyle = 'rgba(24, 27, 30, 0.84)';
      context.lineWidth = 2;
      context.strokeRect(x + 0.7, y + 0.7, panelSize - 1.4, panelSize - 1.4);
      context.strokeStyle = 'rgba(218, 221, 222, 0.22)';
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x + 2, y + 2);
      context.lineTo(x + panelSize - 2, y + 2);
      context.stroke();
      context.fillStyle = 'rgba(20, 23, 26, 0.72)';
      context.fillRect(x + 4, y + 4, 2, 2);
      context.fillRect(x + panelSize - 6, y + panelSize - 6, 2, 2);
    }
  }
  context.strokeStyle = 'rgba(223, 226, 226, 0.18)';
  context.lineWidth = 1;
  context.strokeRect(2.5, 2.5, PANEL_GRID - 5, PANEL_GRID - 5);
  context.fillStyle = 'rgba(15, 18, 21, 0.36)';
  context.fillRect(0, 0, 4, PANEL_GRID);
  context.fillRect(PANEL_GRID - 4, 0, 4, PANEL_GRID);
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

  constructor(seed: number) {
    this.seed = seed;
    this.group.name = 'QuickSenseProceduralArena';
    this.group.userData.source = 'Authored low-poly flow layout';
    this.group.userData.license = 'Riftline project original';
    this.group.userData.mapSeed = seed;
    this.group.userData.horizontalScale = QUICK_HORIZONTAL_SCALE;
    this.group.userData.verticalScale = QUICK_VERTICAL_SCALE;
    this.group.scale.set(QUICK_HORIZONTAL_SCALE, QUICK_VERTICAL_SCALE, QUICK_HORIZONTAL_SCALE);

    const panelTexture = createPanelTexture();
    this.textures.push(panelTexture);
    const groundMaterial = this.material('QuickSense olive basin floor', 0xffffff, 0.01, 0.98);
    const groundFoundationMaterial = this.material('QuickSense terrain foundation', 0x3c4334, 0.01, 0.99);
    const deckMaterial = this.material('QuickSense graphite panels', 0xb4b6b8, 0.27, 0.78, panelTexture);
    const sideMaterial = this.material('QuickSense charcoal deck skirts', 0x394047, 0.46, 0.75);
    const rockMaterial = this.material('QuickSense volcanic cliffs', 0x292d31, 0.02, 0.99);
    const rockHighlightMaterial = this.material('QuickSense cliff faces', 0x3b4045, 0.02, 0.97);
    const mossCapMaterial = this.material('QuickSense moss cliff caps', 0x5b6548, 0.01, 1);
    const cyanMaterial = this.emissiveMaterial('QuickSense cyan route', 0x23c6ea, 0x16b9e4);
    const magentaMaterial = this.emissiveMaterial('QuickSense magenta route', 0xdf3da5, 0xd42b9a);
    const amberMaterial = this.emissiveMaterial('QuickSense amber safety', 0xce841b, 0xb96b0d);
    const whiteMaterial = this.material('QuickSense gunmetal structure trim', 0x5f666a, 0.48, 0.58);
    groundMaterial.vertexColors = true;
    rockMaterial.vertexColors = true;
    rockHighlightMaterial.vertexColors = true;
    deckMaterial.bumpMap = panelTexture;
    deckMaterial.bumpScale = 0.035;

    this.createPath(
      'Cyan outer basin circuit',
      splinePoints([
        { x: 0, y: 2.2, z: -72 }, { x: -30, y: 3.4, z: -73 }, { x: -59, y: 6.8, z: -62 },
        { x: -75, y: 4.4, z: -38 }, { x: -79, y: 9.4, z: -7 }, { x: -75, y: 6.8, z: 25 },
        { x: -61, y: 13.5, z: 51 }, { x: -36, y: 12.0, z: 67 }, { x: 0, y: 18.0, z: 72 },
      ], 32),
      9.2,
      0.18,
      deckMaterial,
      sideMaterial,
      cyanMaterial,
      amberMaterial,
      false,
    );
    this.createPath(
      'Magenta outer basin circuit',
      splinePoints([
        { x: 0, y: 2.2, z: -72 }, { x: 30, y: 3.4, z: -73 }, { x: 59, y: 6.8, z: -62 },
        { x: 75, y: 4.4, z: -38 }, { x: 79, y: 9.4, z: -7 }, { x: 75, y: 6.8, z: 25 },
        { x: 61, y: 13.5, z: 51 }, { x: 36, y: 12.0, z: 67 }, { x: 0, y: 18.0, z: 72 },
      ], 32),
      9.2,
      -0.18,
      deckMaterial,
      sideMaterial,
      magentaMaterial,
      amberMaterial,
      false,
    );
    this.createPath(
      'Cyan inner momentum spiral',
      splinePoints([
        { x: -4, y: 3.0, z: -59 }, { x: -24, y: 5.7, z: -52 }, { x: -44, y: 4.2, z: -39 },
        { x: -56, y: 9.0, z: -17 }, { x: -53, y: 6.6, z: 8 }, { x: -40, y: 12.8, z: 27 },
        { x: -19, y: 10.2, z: 37 }, { x: 0, y: 16.2, z: 35 },
      ], 26),
      7.8,
      0.16,
      deckMaterial,
      sideMaterial,
      cyanMaterial,
      amberMaterial,
      false,
    );
    this.createPath(
      'Magenta inner momentum spiral',
      splinePoints([
        { x: 4, y: 3.0, z: -59 }, { x: 24, y: 5.7, z: -52 }, { x: 44, y: 4.2, z: -39 },
        { x: 56, y: 9.0, z: -17 }, { x: 53, y: 6.6, z: 8 }, { x: 40, y: 12.8, z: 27 },
        { x: 19, y: 10.2, z: 37 }, { x: 0, y: 16.2, z: 35 },
      ], 26),
      7.8,
      -0.16,
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
      ], 24),
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
        { x: -69, y: 5.5, z: -25 }, { x: -48, y: 8.2, z: -23 }, { x: -27, y: 6.8, z: -14 },
        { x: 0, y: 11.8, z: 3 }, { x: 27, y: 6.8, z: -14 }, { x: 48, y: 8.2, z: -23 },
        { x: 69, y: 5.5, z: -25 },
      ], 22),
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
        { x: -63, y: 11.0, z: 33 }, { x: -40, y: 14.2, z: 29 }, { x: -20, y: 12.2, z: 20 },
        { x: 0, y: 16.6, z: 12 }, { x: 20, y: 12.2, z: 20 }, { x: 40, y: 14.2, z: 29 },
        { x: 63, y: 11.0, z: 33 },
      ], 22),
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
      rollerEllipsePoints(0, 7, 28, 22, 24, 12.3, 2.1, 2, Math.PI * 0.5),
      7.2,
      0.09,
      deckMaterial,
      sideMaterial,
      amberMaterial,
      amberMaterial,
      true,
    );

    this.createRamps(deckMaterial, cyanMaterial, magentaMaterial, amberMaterial);
    this.createGround(groundMaterial, groundFoundationMaterial, rockMaterial, rockHighlightMaterial, mossCapMaterial);
    this.createBoundaryArchitecture(sideMaterial, amberMaterial);

    this.addPlatform('Flux Core central dais', 0, 0, 12.2, 24, 3.2, 20, deckMaterial, true);
    this.addPlatform('North grapple west roof', -10.6, 61, 21.4, 8.4, 3.0, 13, deckMaterial, true);
    this.addPlatform('North grapple east roof', 10.6, 61, 21.4, 8.4, 3.0, 13, deckMaterial, true);
    this.addPlatform('South launch west roof', -10.6, -61, 7.1, 8.4, 2.4, 13, deckMaterial, true);
    this.addPlatform('South launch east roof', 10.6, -61, 7.1, 8.4, 2.4, 13, deckMaterial, true);
    this.addPlatform('West ridge overlook roof', -82, 42, 11.4, 16, 2.2, 14, deckMaterial, true);
    this.addPlatform('East ridge overlook roof', 82, -42, 11.4, 16, 2.2, 14, deckMaterial, true);

    this.createCentralStructures(sideMaterial, whiteMaterial, cyanMaterial, magentaMaterial, amberMaterial);
    this.createPeripheralBuildings(sideMaterial, whiteMaterial, cyanMaterial, magentaMaterial, amberMaterial);
    this.createFloatingStructures(sideMaterial, whiteMaterial, cyanMaterial, magentaMaterial, amberMaterial);
    this.createSkylineGateways(sideMaterial, whiteMaterial, cyanMaterial, magentaMaterial, amberMaterial);
    this.createRouteSupports(sideMaterial, whiteMaterial, cyanMaterial, magentaMaterial);

    const cyanPad = this.createJumpPad(new THREE.Vector3(-42, 2.5, -54), new THREE.Vector3(0.22, 0.76, 0.6), cyanMaterial);
    const magentaPad = this.createJumpPad(new THREE.Vector3(42, 2.5, 54), new THREE.Vector3(-0.22, 0.76, -0.6), magentaMaterial);
    const centerPad = this.createJumpPad(new THREE.Vector3(0, 10.55, 0), new THREE.Vector3(0, 0.88, 0.47), amberMaterial);
    const westPad = this.createJumpPad(new THREE.Vector3(-62, 3.35, 0), new THREE.Vector3(0.78, 0.45, 0), cyanMaterial);
    const eastPad = this.createJumpPad(new THREE.Vector3(62, 3.35, 0), new THREE.Vector3(-0.78, 0.45, 0), magentaMaterial);
    this.jumpPads.push(cyanPad, magentaPad, centerPad, westPad, eastPad);

    this.corePosition = this.localToWorld(new THREE.Vector3(0, 19.6, 0));
    this.spawnPoints = [
      this.pointOnFloor(-42, -47),
      this.pointOnFloor(42, 47),
      this.pointOnFloor(-69, 0),
      this.pointOnFloor(69, 0),
      this.pointOnFloor(-42, 48),
      this.pointOnFloor(42, -48),
      this.pointOnFloor(0, -66),
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
      topologyHash: `quicksense-${seed.toString(16)}-skyline-v2`,
      bounds: { width: QUICKSENSE.width, depth: QUICKSENSE.depth },
      altitudeRange: { min: 0, max: 96 },
      renderTriangles: Math.round(renderTriangles),
      collisionTriangles: this.collisionTriangles,
      spawnCount: this.spawnPoints.length,
      pickupCount: Object.keys(this.itemPoints).length,
      jumpPadCount: this.jumpPads.length,
      skiRoutes: 8,
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
    const localHit = this.localSegmentHitDetails(this.localStart, this.localEnd);
    if (!localHit) return null;
    const result = this.worldSurfaceHit;
    this.localToWorld(localHit.point, result.point);
    this.localNormalToWorld(localHit.normal, result.normal);
    result.distance = result.point.distanceTo(start);
    result.surface = localHit.surface;
    return result;
  }

  private localSegmentHitDetails(start: THREE.Vector3, end: THREE.Vector3): SurfaceHit | null {
    const direction = this.segmentDirection.copy(end).sub(start);
    const distance = direction.length();
    if (distance < EPSILON) return null;
    direction.multiplyScalar(1 / distance);
    const ray = this.segmentRay.set(start, direction);
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const box of this.shotBoxes) {
      const hit = ray.intersectBox(box, this.segmentPoint);
      if (!hit) continue;
      const hitDistance = hit.distanceTo(start);
      if (hitDistance > distance || hitDistance >= closestDistance) continue;
      closestDistance = hitDistance;
      this.segmentClosestPoint.copy(hit);
      this.boxNormal(box, hit, direction, this.segmentClosestNormal);
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

  private createCragGeometry(): THREE.BufferGeometry {
    const sides = 7;
    const rings = [
      { y: 0, radius: 1, phase: 0 },
      { y: 0.42, radius: 0.72, phase: 0.18 },
      { y: 0.74, radius: 0.43, phase: -0.12 },
    ];
    const positions: number[] = [];
    const indices: number[] = [];
    for (const ring of rings) {
      for (let index = 0; index < sides; index += 1) {
        const angle = ring.phase + index / sides * Math.PI * 2;
        const irregularity = 0.88 + ((index * 5 + rings.indexOf(ring) * 3) % 7) * 0.035;
        positions.push(
          Math.cos(angle) * ring.radius * irregularity,
          ring.y,
          Math.sin(angle) * ring.radius * (1.04 - (index % 3) * 0.045),
        );
      }
    }
    const apexIndex = positions.length / 3;
    positions.push(0.14, 1, -0.08);
    for (let ringIndex = 0; ringIndex < rings.length - 1; ringIndex += 1) {
      for (let index = 0; index < sides; index += 1) {
        const next = (index + 1) % sides;
        const lower = ringIndex * sides + index;
        const lowerNext = ringIndex * sides + next;
        const upper = (ringIndex + 1) * sides + index;
        const upperNext = (ringIndex + 1) * sides + next;
        indices.push(lower, upperNext, lowerNext, lower, upper, upperNext);
      }
    }
    const topRing = (rings.length - 1) * sides;
    for (let index = 0; index < sides; index += 1) {
      indices.push(topRing + index, apexIndex, topRing + (index + 1) % sides);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    const faceted = geometry.toNonIndexed();
    geometry.dispose();
    const colors: number[] = [];
    const faceCount = faceted.getAttribute('position').count / 3;
    for (let face = 0; face < faceCount; face += 1) {
      const factor = 0.72 + ((face * 17) % 7) * 0.075;
      const color = new THREE.Color(factor, factor, factor);
      for (let vertex = 0; vertex < 3; vertex += 1) colors.push(color.r, color.g, color.b);
    }
    faceted.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    faceted.computeVertexNormals();
    faceted.computeBoundingBox();
    faceted.computeBoundingSphere();
    return faceted;
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
    const ridgeClusters = [
      [-84, -82, 36, 20, 0.14], [-60, -86, 27, 17, 0.72], [-35, -85, 45, 23, -0.22],
      [-8, -87, 31, 18, 0.42], [20, -86, 40, 22, -0.52], [49, -85, 30, 18, 0.24], [77, -82, 43, 22, -0.14],
      [-94, -58, 30, 18, 0.54], [-96, -30, 39, 21, -0.36], [-97, 0, 48, 24, 0.18],
      [-96, 31, 34, 19, 0.48], [-93, 60, 43, 22, -0.1],
      [94, -58, 40, 21, -0.4], [96, -29, 31, 18, 0.31], [97, 1, 46, 23, -0.12],
      [96, 32, 36, 20, 0.26], [93, 61, 48, 24, -0.18],
      [-80, 82, 42, 22, 0.52], [-53, 86, 31, 18, -0.24], [-27, 86, 47, 24, 0.16],
      [1, 87, 29, 17, -0.44], [29, 86, 42, 22, 0.34], [57, 85, 34, 19, -0.2], [82, 81, 45, 23, 0.08],
    ] as const;
    const darkCrags: InstanceTransform[] = [];
    const lightCrags: InstanceTransform[] = [];
    const mossCaps: InstanceTransform[] = [];
    for (const [x, z, height, radius, yaw] of ridgeClusters) {
      darkCrags.push({
        position: new THREE.Vector3(x, -0.25, z),
        scale: new THREE.Vector3(radius, height, radius * 0.86),
        yaw,
      });
      lightCrags.push({
        position: new THREE.Vector3(x + radius * 0.52, -0.3, z - radius * 0.22),
        scale: new THREE.Vector3(radius * 0.64, height * 0.7, radius * 0.56),
        yaw: yaw + 0.8,
      });
      darkCrags.push({
        position: new THREE.Vector3(x - radius * 0.46, -0.28, z + radius * 0.28),
        scale: new THREE.Vector3(radius * 0.52, height * 0.56, radius * 0.48),
        yaw: yaw - 0.65,
      });
      if (height >= 38) {
        mossCaps.push({
          position: new THREE.Vector3(x + radius * 0.03, height * 0.7, z - radius * 0.025),
          scale: new THREE.Vector3(radius * 0.27, Math.max(0.5, height * 0.018), radius * 0.22),
          yaw: yaw + 0.08,
        });
      }
    }
    const cragGeometry = this.createCragGeometry();
    this.addInstancedMeshes('QuickSense dark cliff massifs', cragGeometry, rockMaterial, darkCrags);
    this.addInstancedMeshes('QuickSense lit cliff facets', cragGeometry, rockHighlightMaterial, lightCrags);
    const capGeometry = new THREE.CylinderGeometry(1, 1.18, 1, 7);
    this.addInstancedMeshes('QuickSense moss summit shelves', capGeometry, mossCapMaterial, mossCaps);
  }

  private createTerrainGeometry(): THREE.BufferGeometry {
    const segmentsX = 38;
    const segmentsZ = 34;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    for (let zIndex = 0; zIndex <= segmentsZ; zIndex += 1) {
      const v = zIndex / segmentsZ;
      const z = THREE.MathUtils.lerp(-QUICK_LOCAL_DEPTH * 0.5, QUICK_LOCAL_DEPTH * 0.5, v);
      for (let xIndex = 0; xIndex <= segmentsX; xIndex += 1) {
        const u = xIndex / segmentsX;
        const x = THREE.MathUtils.lerp(-QUICK_LOCAL_WIDTH * 0.5, QUICK_LOCAL_WIDTH * 0.5, u);
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
        indices.push(a, c, d, a, d, b);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    const faceted = geometry.toNonIndexed();
    geometry.dispose();
    const colorChoices = [0x4a4f3e, 0x505443, 0x464b3a, 0x555947, 0x4c513f];
    const colors: number[] = [];
    const faceCount = faceted.getAttribute('position').count / 3;
    for (let face = 0; face < faceCount; face += 1) {
      const color = new THREE.Color(colorChoices[(face * 7 + Math.floor(face / 11)) % colorChoices.length]);
      for (let vertex = 0; vertex < 3; vertex += 1) colors.push(color.r, color.g, color.b);
    }
    faceted.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    faceted.computeVertexNormals();
    faceted.computeBoundingBox();
    faceted.computeBoundingSphere();
    return faceted;
  }

  private terrainHeightAt(x: number, z: number): number {
    const hills = [
      { x: -68, z: -48, height: 7.4, radiusX: 27, radiusZ: 22 },
      { x: 68, z: -48, height: 6.4, radiusX: 25, radiusZ: 20 },
      { x: -66, z: 48, height: 6.8, radiusX: 26, radiusZ: 21 },
      { x: 67, z: 49, height: 7.8, radiusX: 28, radiusZ: 22 },
      { x: -37, z: 4, height: 5.2, radiusX: 22, radiusZ: 25 },
      { x: 39, z: -2, height: 4.8, radiusX: 23, radiusZ: 24 },
      { x: 0, z: 55, height: 4.2, radiusX: 35, radiusZ: 19 },
    ];
    let height = 0.24;
    for (const hill of hills) {
      const nx = (x - hill.x) / hill.radiusX;
      const nz = (z - hill.z) / hill.radiusZ;
      const distance = nx * nx + nz * nz;
      if (distance >= 1) continue;
      const blend = 1 - THREE.MathUtils.smoothstep(distance, 0.08, 1);
      height += hill.height * blend * blend;
    }
    height += (Math.sin(x * 0.095 + z * 0.041) + Math.cos(z * 0.083 - x * 0.027)) * 0.14;

    let corridorBlend = 1;
    for (const path of this.pathSurfaces) {
      const nearest = closestSegment(path.points, path.closed, x, z);
      if (!nearest) continue;
      const edgeDistance = Math.sqrt(nearest.distanceSquared) - path.width * 0.5;
      corridorBlend = Math.min(corridorBlend, THREE.MathUtils.smoothstep(edgeDistance, 0.45, 6.5));
    }
    for (const ramp of this.rampSurfaces) {
      if (ramp.flow.contains(x, z)) corridorBlend = 0;
    }
    return Math.max(0.06, height * THREE.MathUtils.lerp(0.08, 1, corridorBlend));
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
    safetyMaterial: THREE.MeshStandardMaterial,
    closed: boolean,
  ): PathSurface {
    const path: PathSurface = {
      name,
      points,
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
    const bottomDepth = 1.8;
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
      const leftBottom = left.clone(); leftBottom.y -= bottomDepth;
      const rightBottom = right.clone(); rightBottom.y -= bottomDepth;
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

    // Route deck slabs are raycast-only. Keeping them out of the capsule
    // solver lets a skier pass underneath an elevated lane while still giving
    // hitscan, grapple, and LOS queries a real surface to read.
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
    cyanMaterial: THREE.MeshStandardMaterial,
    magentaMaterial: THREE.MeshStandardMaterial,
    amberMaterial: THREE.MeshStandardMaterial,
  ): void {
    const ramps: Array<{ name: string; spec: LaunchRampSpec; edge: THREE.MeshStandardMaterial }> = [
      {
        name: 'South progressive launch',
        spec: { origin: { x: 0, y: 2.0, z: -69 }, heading: 0, length: 30, width: 11, rise: 12.4, curveExponent: 1.58, longitudinalSegments: 18, lateralSegments: 4, solid: true, skirtDepth: 2.4 },
        edge: amberMaterial,
      },
      {
        name: 'North return launch',
        spec: { origin: { x: 0, y: 24.0, z: 69 }, heading: Math.PI, length: 30, width: 11, rise: -12.4, curveExponent: 1.58, longitudinalSegments: 18, lateralSegments: 4, solid: true, skirtDepth: 2.4 },
        edge: amberMaterial,
      },
      {
        name: 'West transfer ramp',
        spec: { origin: { x: -76, y: 5.6, z: -18 }, heading: Math.PI * 0.5, length: 31, width: 9.5, rise: 10.0, curveExponent: 1.62, longitudinalSegments: 16, lateralSegments: 4, solid: true, skirtDepth: 2.2 },
        edge: cyanMaterial,
      },
      {
        name: 'East transfer ramp',
        spec: { origin: { x: 76, y: 5.6, z: 18 }, heading: -Math.PI * 0.5, length: 31, width: 9.5, rise: 10.0, curveExponent: 1.62, longitudinalSegments: 16, lateralSegments: 4, solid: true, skirtDepth: 2.2 },
        edge: magentaMaterial,
      },
      {
        name: 'Center hip ramp',
        spec: { origin: { x: 0, y: 10.2, z: -15 }, heading: 0, length: 22, width: 9, rise: 7.2, curveExponent: 1.48, longitudinalSegments: 16, lateralSegments: 4, solid: true, skirtDepth: 2.0 },
        edge: amberMaterial,
      },
    ];
    for (const ramp of ramps) {
      const flow = buildLaunchRamp(ramp.spec);
      const rampUv = flow.geometry.getAttribute('uv') as THREE.BufferAttribute;
      const textureLengthScale = Math.max(1, ramp.spec.length / 6);
      for (let index = 0; index < rampUv.count; index += 1) {
        rampUv.setXY(index, rampUv.getX(index) * textureLengthScale, rampUv.getY(index));
      }
      rampUv.needsUpdate = true;
      this.rampSurfaces.push({ name: ramp.name, spec: ramp.spec, flow });
      this.geometries.push(flow.geometry);
      const mesh = new THREE.Mesh(flow.geometry, deckMaterial);
      mesh.name = ramp.name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.addRampRails(ramp.spec, amberMaterial, ramp.edge);
      const box = flow.geometry.boundingBox?.clone();
      if (box) this.shotBoxes.push(box);
    }
  }

  private addRampRails(
    spec: LaunchRampSpec,
    safetyMaterial: THREE.MeshStandardMaterial,
    routeMaterial: THREE.MeshStandardMaterial,
  ): void {
    const samples = 12;
    const points = Array.from({ length: samples }, (_, index) => {
      const point = this.rampPoint(spec, index / (samples - 1), 0);
      return { x: point.x, y: point.y, z: point.z };
    });
    const safetyGeometry = this.createRibbonGeometry(
      points,
      false,
      [-spec.width * 0.5 + 0.3, spec.width * 0.5 - 0.3],
      0.28,
      0,
      0.04,
    );
    const safety = this.addMesh(safetyGeometry, safetyMaterial, 'QuickSense ramp amber edge trim');
    safety.castShadow = false;
    safety.receiveShadow = false;
    const routeGeometry = this.createRibbonGeometry(points, false, [0], 0.18, 0, 0.06);
    const route = this.addMesh(routeGeometry, routeMaterial, 'QuickSense ramp route signal');
    route.castShadow = false;
    route.receiveShadow = false;
  }

  private rampPoint(spec: LaunchRampSpec, u: number, lateral: number): THREE.Vector3 {
    const sine = Math.sin(spec.heading);
    const cosine = Math.cos(spec.heading);
    return new THREE.Vector3(
      spec.origin.x + sine * spec.length * u + cosine * lateral,
      spec.origin.y + spec.rise * Math.pow(u, spec.curveExponent ?? 1.8) + 0.2,
      spec.origin.z + cosine * spec.length * u - sine * lateral,
    );
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
      const broad = Math.max(size.x, size.z);
      this.colliders.push({
        box: new THREE.Box3(
          new THREE.Vector3(center.x - broad * 0.5, center.y - size.y * 0.5, center.z - broad * 0.5),
          new THREE.Vector3(center.x + broad * 0.5, center.y + size.y * 0.5, center.z + broad * 0.5),
        ),
        name,
        blocksMovement: true,
      });
      this.shotBoxes.push(this.colliders[this.colliders.length - 1].box.clone());
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

  private createPeripheralBuildings(
    sideMaterial: THREE.MeshStandardMaterial,
    whiteMaterial: THREE.MeshStandardMaterial,
    cyanMaterial: THREE.MeshStandardMaterial,
    magentaMaterial: THREE.MeshStandardMaterial,
    amberMaterial: THREE.MeshStandardMaterial,
  ): void {
    const specs: GroundBuildingSpec[] = [
      { x: -67, z: 31, roofY: 10.5, width: 16, depth: 14, height: 11, yaw: -0.08, accent: 'cyan', collidable: true },
      { x: 67, z: -31, roofY: 10.5, width: 16, depth: 14, height: 11, yaw: 0.08, accent: 'magenta', collidable: true },
      { x: 0, z: 61, roofY: 20.5, width: 19, depth: 13, height: 16, yaw: 0, accent: 'cyan', collidable: true },
      { x: 0, z: -61, roofY: 6.2, width: 19, depth: 13, height: 9, yaw: Math.PI, accent: 'magenta', collidable: true },
      { x: -74, z: -51, roofY: 13.5, width: 15, depth: 12, height: 13.5, yaw: 0.26, accent: 'cyan', collidable: true },
      { x: 74, z: 51, roofY: 14.5, width: 15, depth: 12, height: 14.5, yaw: -0.26, accent: 'magenta', collidable: true },
      { x: -54, z: 63, roofY: 12.5, width: 14, depth: 11, height: 12.5, yaw: -0.18, accent: 'amber', collidable: true },
      { x: 54, z: -63, roofY: 12.5, width: 14, depth: 11, height: 12.5, yaw: 0.18, accent: 'amber', collidable: true },
    ];
    const accentMaterials: Record<AccentRole, THREE.MeshStandardMaterial> = {
      cyan: cyanMaterial,
      magenta: magentaMaterial,
      amber: amberMaterial,
    };
    const taperedParts: InstanceTransform[] = [];
    const shellParts: InstanceTransform[] = [];
    const roofCaps: InstanceTransform[] = [];
    const roofDetails: InstanceTransform[] = [];
    const accentParts: Record<AccentRole, InstanceTransform[]> = { cyan: [], magenta: [], amber: [] };

    for (const spec of specs) {
      const bottomY = spec.roofY - spec.height;
      const lowerHeight = spec.height * 0.7;
      const upperHeight = spec.height * 0.46;
      taperedParts.push({
        position: new THREE.Vector3(spec.x, bottomY + lowerHeight * 0.5, spec.z),
        scale: new THREE.Vector3(spec.width * 0.48, lowerHeight, spec.depth * 0.48),
        yaw: spec.yaw,
      });
      const upper = this.localOffset(spec.x, spec.roofY - upperHeight * 0.5, spec.z, spec.width * 0.06, spec.depth * 0.04, spec.yaw);
      taperedParts.push({
        position: upper,
        scale: new THREE.Vector3(spec.width * 0.35, upperHeight, spec.depth * 0.36),
        yaw: spec.yaw + Math.PI / 8,
      });
      for (const side of [-1, 1]) {
        shellParts.push({
          position: this.localOffset(spec.x, bottomY + spec.height * 0.37, spec.z, side * spec.width * 0.42, 0, spec.yaw),
          scale: new THREE.Vector3(spec.width * 0.18, spec.height * 0.62, spec.depth * 0.58),
          yaw: spec.yaw,
        });
        roofDetails.push({
          position: this.localOffset(spec.x, spec.roofY + 1.65, spec.z, side * spec.width * 0.27, spec.depth * 0.04, spec.yaw),
          scale: new THREE.Vector3(0.62, 2.45, 0.86),
          yaw: spec.yaw,
        });
      }
      roofCaps.push({
        position: new THREE.Vector3(spec.x, spec.roofY + 0.38, spec.z),
        scale: new THREE.Vector3(spec.width * 0.86, 0.76, spec.depth * 0.84),
        yaw: spec.yaw,
      });
      accentParts[spec.accent].push(
        {
          position: this.localOffset(spec.x, bottomY + spec.height * 0.56, spec.z, 0, -spec.depth * 0.51, spec.yaw),
          scale: new THREE.Vector3(spec.width * 0.5, spec.height * 0.24, 0.18),
          yaw: spec.yaw,
        },
        {
          position: this.localOffset(spec.x, bottomY + spec.height * 0.48, spec.z, -spec.width * 0.51, 0, spec.yaw),
          scale: new THREE.Vector3(0.18, spec.height * 0.5, spec.depth * 0.3),
          yaw: spec.yaw,
        },
        {
          position: this.localOffset(spec.x, spec.roofY + 0.88, spec.z, 0, -spec.depth * 0.43, spec.yaw),
          scale: new THREE.Vector3(spec.width * 0.66, 0.2, 0.24),
          yaw: spec.yaw,
        },
      );
      if (spec.collidable) {
        this.registerBoxCollision(
          'QuickSense stepped perimeter building',
          new THREE.Vector3(spec.x, spec.roofY - spec.height * 0.5, spec.z),
          new THREE.Vector3(spec.width, spec.height, spec.depth),
          spec.yaw,
        );
      }
    }

    const taperedGeometry = new THREE.CylinderGeometry(0.82, 1, 1, 8);
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const capGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.addInstancedMeshes('QuickSense stepped building shells', taperedGeometry, sideMaterial, taperedParts);
    this.addInstancedMeshes('QuickSense building buttresses', unitBox, sideMaterial, shellParts);
    this.addInstancedMeshes('QuickSense octagonal roof crowns', capGeometry, whiteMaterial, roofCaps);
    this.addInstancedMeshes('QuickSense rooftop fins', unitBox, whiteMaterial, roofDetails);
    for (const role of ['cyan', 'magenta', 'amber'] as const) {
      this.addInstancedMeshes(`QuickSense ${role} building signals`, unitBox, accentMaterials[role], accentParts[role], false);
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
      { x: -58, z: 23, y: 41, width: 19, height: 10, depth: 13, yaw: -0.24, accent: 'cyan' },
      { x: 58, z: 23, y: 43, width: 19, height: 10, depth: 13, yaw: 0.24, accent: 'magenta' },
      { x: 0, z: 61, y: 52, width: 27, height: 11, depth: 17, yaw: 0, accent: 'amber' },
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
    const whiteDetails: InstanceTransform[] = [];
    const accentPanels: Record<AccentRole, InstanceTransform[]> = { cyan: [], magenta: [], amber: [] };
    const thrusters: Record<AccentRole, InstanceTransform[]> = { cyan: [], magenta: [], amber: [] };
    const tethers: Record<AccentRole, InstanceTransform[]> = { cyan: [], magenta: [], amber: [] };
    const rings: Record<AccentRole, InstanceTransform[]> = { cyan: [], magenta: [], amber: [] };

    for (const spec of specs) {
      hulls.push({
        position: new THREE.Vector3(spec.x, spec.y, spec.z),
        scale: new THREE.Vector3(spec.width * 0.38, spec.height, spec.depth * 0.43),
        yaw: spec.yaw,
      });
      undercarriages.push({
        position: new THREE.Vector3(spec.x, spec.y - spec.height * 0.72, spec.z),
        scale: new THREE.Vector3(spec.width * 0.36, spec.height * 0.62, spec.depth * 0.38),
        yaw: spec.yaw + Math.PI / 7,
      });
      for (const side of [-1, 1]) {
        wingBlocks.push({
          position: this.localOffset(spec.x, spec.y + spec.height * 0.02, spec.z, side * spec.width * 0.4, 0, spec.yaw),
          scale: new THREE.Vector3(spec.width * 0.34, spec.height * 0.5, spec.depth * 0.72),
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
      accentPanels[spec.accent].push(
        {
          position: this.localOffset(spec.x, spec.y + spec.height * 0.08, spec.z, 0, -spec.depth * 0.57, spec.yaw),
          scale: new THREE.Vector3(spec.width * 0.55, spec.height * 0.32, 0.2),
          yaw: spec.yaw,
        },
        {
          position: this.localOffset(spec.x, spec.y + spec.height * 0.55, spec.z, 0, -spec.depth * 0.42, spec.yaw),
          scale: new THREE.Vector3(spec.width * 0.62, 0.22, 0.24),
          yaw: spec.yaw,
        },
      );
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
      }
      const tetherHeight = Math.max(7, spec.y - spec.height * 0.5 - 2);
      tethers[spec.accent].push({
        position: new THREE.Vector3(spec.x, tetherHeight * 0.5, spec.z),
        scale: new THREE.Vector3(0.2, tetherHeight, 0.2),
      });
      const ringScale = Math.max(spec.width, spec.depth) * 0.38;
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

    const taperedHull = new THREE.CylinderGeometry(0.8, 1, 1, 8);
    const undercarriage = new THREE.CylinderGeometry(1, 0.12, 1, 7);
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const crown = new THREE.BoxGeometry(1, 1, 1);
    const thruster = new THREE.ConeGeometry(1, 1, 6);
    const tether = new THREE.CylinderGeometry(1, 1, 1, 6);
    const ring = new THREE.TorusGeometry(1, 0.035, 5, 24);
    this.addInstancedMeshes('QuickSense floating station hulls', taperedHull, sideMaterial, hulls);
    this.addInstancedMeshes('QuickSense floating station undercarriages', undercarriage, sideMaterial, undercarriages);
    this.addInstancedMeshes('QuickSense floating station wings', unitBox, sideMaterial, wingBlocks);
    this.addInstancedMeshes('QuickSense floating station crowns', crown, whiteMaterial, crownCaps);
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
    const cyanStation = new THREE.Vector3(-58, 48, 23);
    const magentaStation = new THREE.Vector3(58, 50, 23);
    const flagship = new THREE.Vector3(0, 59, 61);
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
      { center: new THREE.Vector3(-50, 2.8, -79.1), size: new THREE.Vector3(72, 5.6, 2.2) },
      { center: new THREE.Vector3(50, 2.8, -79.1), size: new THREE.Vector3(72, 5.6, 2.2) },
      { center: new THREE.Vector3(-50, 2.8, 79.1), size: new THREE.Vector3(72, 5.6, 2.2) },
      { center: new THREE.Vector3(50, 2.8, 79.1), size: new THREE.Vector3(72, 5.6, 2.2) },
      { center: new THREE.Vector3(-89, 2.8, -43), size: new THREE.Vector3(2.2, 5.6, 31) },
      { center: new THREE.Vector3(-89, 2.8, 0), size: new THREE.Vector3(2.2, 5.6, 31) },
      { center: new THREE.Vector3(-89, 2.8, 43), size: new THREE.Vector3(2.2, 5.6, 31) },
      { center: new THREE.Vector3(89, 2.8, -43), size: new THREE.Vector3(2.2, 5.6, 31) },
      { center: new THREE.Vector3(89, 2.8, 0), size: new THREE.Vector3(2.2, 5.6, 31) },
      { center: new THREE.Vector3(89, 2.8, 43), size: new THREE.Vector3(2.2, 5.6, 31) },
    ];
    const wallTransforms: InstanceTransform[] = [];
    const capTransforms: InstanceTransform[] = [];
    for (const wall of walls) {
      wallTransforms.push({ position: wall.center, scale: wall.size });
      capTransforms.push({
        position: new THREE.Vector3(wall.center.x, 5.76, wall.center.z),
        scale: new THREE.Vector3(wall.size.x * 1.03, 0.34, wall.size.z * 1.08),
      });
      this.registerBoxCollision('QuickSense fortified perimeter', wall.center, wall.size);
    }
    const buttresses: InstanceTransform[] = [];
    const amberStrips: InstanceTransform[] = [];
    for (const x of [-84, -66, -42, 42, 66, 84]) {
      for (const z of [-79.1, 79.1]) {
        buttresses.push({ position: new THREE.Vector3(x, 3.7, z), scale: new THREE.Vector3(3.4, 7.4, 4.8) });
        amberStrips.push({ position: new THREE.Vector3(x, 6.04, z - Math.sign(z) * 1.22), scale: new THREE.Vector3(7.8, 0.24, 0.18) });
      }
    }
    for (const z of [-64, -43, -21, 0, 21, 43, 64]) {
      for (const x of [-89, 89]) {
        buttresses.push({ position: new THREE.Vector3(x, 3.7, z), scale: new THREE.Vector3(4.8, 7.4, 3.4) });
        amberStrips.push({ position: new THREE.Vector3(x - Math.sign(x) * 1.22, 6.04, z), scale: new THREE.Vector3(0.18, 0.24, 7.8) });
      }
    }
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const octagon = new THREE.CylinderGeometry(1, 1.18, 1, 8);
    this.addInstancedMeshes('QuickSense perimeter retaining walls', unitBox, sideMaterial, wallTransforms);
    this.addInstancedMeshes('QuickSense perimeter armored caps', unitBox, sideMaterial, capTransforms);
    this.addInstancedMeshes('QuickSense perimeter buttresses', octagon, sideMaterial, buttresses);
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
      const stride = path.closed ? 4 : 5;
      for (let index = Math.floor(stride * 0.55); index < path.points.length; index += stride) {
        const point = path.points[index];
        if (point.y < 2.35 || (Math.abs(point.x) < 15 && Math.abs(point.z) < 17)) continue;
        const terrain = this.terrainHeightAt(point.x, point.z);
        const height = Math.max(1.4, point.y - terrain - 0.18);
        const baseY = terrain;
        columns.push({
          position: new THREE.Vector3(point.x, baseY + height * 0.5, point.z),
          scale: new THREE.Vector3(1.02, height, 1.02),
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
    const dx = position.x - spec.origin.x;
    const dz = position.z - spec.origin.z;
    const sine = Math.sin(spec.heading);
    const cosine = Math.cos(spec.heading);
    const longitudinal = dx * sine + dz * cosine;
    const lateral = dx * cosine - dz * sine;
    const halfWidth = spec.width * 0.5;
    if (longitudinal <= -radius || longitudinal >= spec.length + radius || lateral <= -halfWidth - radius || lateral >= halfWidth + radius) return null;
    const u = THREE.MathUtils.clamp(longitudinal / spec.length, 0, 1);
    const surfaceY = spec.origin.y + spec.rise * Math.pow(u, spec.curveExponent ?? 1.8);
    const bottomY = Math.min(spec.origin.y, spec.origin.y + spec.rise) - (spec.skirtDepth ?? 0.8);
    if (position.y + height <= bottomY + 0.01 || position.y >= surfaceY - 0.015) return null;
    const entryDepth = Math.max(radius + 0.35, spec.length * 0.08);
    const localStepHeight = MOVEMENT.stepHeight / QUICK_VERTICAL_SCALE;
    if (
      longitudinal <= entryDepth
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
