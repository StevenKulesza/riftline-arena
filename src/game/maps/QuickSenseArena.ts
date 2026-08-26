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
  generationVersion: 1,
  width: 180,
  depth: 160,
  killY: -16,
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

const PANEL_GRID = 64;
const EPSILON = 0.0001;
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
  context.fillStyle = '#667782';
  context.fillRect(0, 0, PANEL_GRID, PANEL_GRID);
  context.strokeStyle = 'rgba(226, 241, 245, 0.23)';
  context.lineWidth = 1;
  for (let offset = 0; offset <= PANEL_GRID; offset += 8) {
    context.beginPath();
    context.moveTo(offset + 0.5, 0);
    context.lineTo(offset + 0.5, PANEL_GRID);
    context.stroke();
    context.beginPath();
    context.moveTo(0, offset + 0.5);
    context.lineTo(PANEL_GRID, offset + 0.5);
    context.stroke();
  }
  context.fillStyle = 'rgba(7, 16, 27, 0.28)';
  context.fillRect(2, 2, 3, PANEL_GRID - 4);
  context.fillRect(PANEL_GRID - 5, 2, 3, PANEL_GRID - 4);
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'QuickSensePanelGrid';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 4);
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

    const panelTexture = createPanelTexture();
    this.textures.push(panelTexture);
    const groundMaterial = this.material('QuickSense moss floor', 0x3f6049, 0.02, 0.98);
    const deckMaterial = this.material('QuickSense graphite panels', 0xa7b3b8, 0.72, 0.42, panelTexture);
    const sideMaterial = this.material('QuickSense deck skirts', 0x293946, 0.72, 0.5);
    const rockMaterial = this.material('QuickSense volcanic cliffs', 0x35424d, 0.05, 0.98);
    const cyanMaterial = this.emissiveMaterial('QuickSense cyan route', 0x2edfff, 0x2edfff);
    const magentaMaterial = this.emissiveMaterial('QuickSense magenta route', 0xff3fad, 0xff3fad);
    const amberMaterial = this.emissiveMaterial('QuickSense amber safety', 0xffb638, 0xffb638);
    const whiteMaterial = this.material('QuickSense structure highlight', 0x8f9ca8, 0.8, 0.34);

    this.createGround(groundMaterial, rockMaterial);

    const leftLoop = this.createPath(
      'Cyan outer circulation loop',
      ellipsePoints(-42, 0, 31, 57, 24, 2.2, Math.PI * 0.5),
      8.2,
      0.12,
      deckMaterial,
      cyanMaterial,
      true,
    );
    const rightLoop = this.createPath(
      'Magenta outer circulation loop',
      ellipsePoints(42, 0, 31, 57, 24, 2.2, Math.PI * 0.5),
      8.2,
      -0.12,
      deckMaterial,
      magentaMaterial,
      true,
    );
    void leftLoop;
    void rightLoop;

    this.createPath(
      'Central uphill spine',
      [
        { x: 0, y: 1.8, z: -69 },
        { x: 0, y: 3.0, z: -50 },
        { x: 0, y: 6.4, z: -26 },
        { x: 0, y: 10.2, z: 0 },
        { x: 0, y: 13.2, z: 26 },
        { x: 0, y: 16.0, z: 50 },
        { x: 0, y: 17.5, z: 69 },
      ],
      8.6,
      0,
      deckMaterial,
      amberMaterial,
      false,
    );
    this.createPath(
      'West transfer bridge',
      [
        { x: -73, y: 3.0, z: 0 },
        { x: -57, y: 3.2, z: 0 },
        { x: -35, y: 5.0, z: 0 },
        { x: -13, y: 8.6, z: 0 },
      ],
      7.8,
      0.08,
      deckMaterial,
      cyanMaterial,
      false,
    );
    this.createPath(
      'East transfer bridge',
      [
        { x: 73, y: 3.0, z: 0 },
        { x: 57, y: 3.2, z: 0 },
        { x: 35, y: 5.0, z: 0 },
        { x: 13, y: 8.6, z: 0 },
      ],
      7.8,
      -0.08,
      deckMaterial,
      magentaMaterial,
      false,
    );
    this.createPath(
      'Upper cross transfer',
      [
        { x: -49, y: 9.5, z: 32 },
        { x: -27, y: 11.2, z: 31 },
        { x: 0, y: 13.5, z: 31 },
        { x: 27, y: 11.2, z: 31 },
        { x: 49, y: 9.5, z: 32 },
      ],
      7.2,
      0,
      deckMaterial,
      amberMaterial,
      false,
    );

    this.createRamps(deckMaterial, cyanMaterial, magentaMaterial, amberMaterial);
    this.createBoundaryArchitecture(sideMaterial, amberMaterial);

    this.addPlatform('Flux Core central dais', 0, 0, 12.2, 24, 3.2, 20, deckMaterial, true);
    this.addPlatform('North grapple roof', 0, 61, 21.4, 19, 3.0, 13, deckMaterial, true);
    this.addPlatform('South launch roof', 0, -61, 7.1, 19, 2.4, 13, deckMaterial, true);
    this.addPlatform('West overlook roof', -67, 31, 11.4, 16, 2.2, 14, deckMaterial, true);
    this.addPlatform('East overlook roof', 67, -31, 11.4, 16, 2.2, 14, deckMaterial, true);

    this.createCentralStructures(sideMaterial, whiteMaterial, cyanMaterial, magentaMaterial, amberMaterial);
    this.createPeripheralBuildings(sideMaterial, whiteMaterial, cyanMaterial, magentaMaterial);
    this.createFloatingStructures(sideMaterial, whiteMaterial, cyanMaterial, magentaMaterial);
    this.createRouteSupports(sideMaterial, cyanMaterial, magentaMaterial);

    const cyanPad = this.createJumpPad(new THREE.Vector3(-42, 2.5, -54), new THREE.Vector3(0.22, 0.76, 0.6), cyanMaterial);
    const magentaPad = this.createJumpPad(new THREE.Vector3(42, 2.5, 54), new THREE.Vector3(-0.22, 0.76, -0.6), magentaMaterial);
    const centerPad = this.createJumpPad(new THREE.Vector3(0, 10.55, 0), new THREE.Vector3(0, 0.88, 0.47), amberMaterial);
    const westPad = this.createJumpPad(new THREE.Vector3(-62, 3.35, 0), new THREE.Vector3(0.78, 0.45, 0), cyanMaterial);
    const eastPad = this.createJumpPad(new THREE.Vector3(62, 3.35, 0), new THREE.Vector3(-0.78, 0.45, 0), magentaMaterial);
    this.jumpPads.push(cyanPad, magentaPad, centerPad, westPad, eastPad);

    this.corePosition = new THREE.Vector3(0, 19.6, 0);
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
      rail: new THREE.Vector3(0, 23.05, 61),
      rocket: this.pointOnFloor(-42, 0, 0.8),
      plasma: this.pointOnFloor(42, 0, 0.8),
      shotgun: this.pointOnFloor(-24, -31, 0.8),
      sniper: new THREE.Vector3(0, 23.05, -61),
      laser: this.pointOnFloor(24, 31, 0.8),
    };

    const renderTriangles = this.geometries.reduce((sum, geometry) => {
      const position = geometry.getAttribute('position');
      return sum + (position ? position.count / 3 : 0);
    }, 0);
    this.collisionTriangles = Math.round(this.colliders.length * 12 + this.rampSurfaces.length * 72 + this.pathSurfaces.length * 48);
    this.mapInfo = {
      name: QUICKSENSE.name,
      seed,
      generationVersion: QUICKSENSE.generationVersion,
      ready: true,
      topologyHash: `quicksense-${seed.toString(16)}-flow-v1`,
      bounds: { width: QUICKSENSE.width, depth: QUICKSENSE.depth },
      altitudeRange: { min: 0, max: 32 },
      renderTriangles: Math.round(renderTriangles),
      collisionTriangles: this.collisionTriangles,
      spawnCount: this.spawnPoints.length,
      pickupCount: Object.keys(this.itemPoints).length,
      jumpPadCount: this.jumpPads.length,
      skiRoutes: 6,
    };
  }

  update(elapsed: number, reducedMotion: boolean): void {
    const time = reducedMotion ? 0 : elapsed;
    for (const prop of this.animatedProps) {
      prop.object.rotation.y = prop.phase + time * prop.spin;
      prop.object.position.y = prop.baseY + (reducedMotion ? 0 : Math.sin(time * 1.8 + prop.phase) * 0.16);
    }
    const pulse = reducedMotion ? 0.72 : 0.86 + Math.sin(time * 2.8) * 0.18;
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
    this.playerInfluence.copy(position);
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
    this.correction.set(0, 0, 0);
    this.wallNormal.set(0, 0, 0);
    let grounded = false;
    let wallContact = false;
    let contacts = 0;
    const floor = this.floorSurfaceAt(position.x, position.z, position.y + MOVEMENT.groundSnapDistance + 0.08);
    if (floor) {
      this.contactNormal.copy(floor.normal);
      const gap = position.y - floor.height;
      if (gap <= 0.015 || (velocity.y <= 0.5 && gap <= MOVEMENT.groundSnapDistance + 0.025)) {
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

    return {
      grounded,
      contactNormal: this.contactNormal.clone(),
      wallContact,
      wallNormal: this.wallNormal.clone(),
      correction: this.correction.clone(),
      contacts,
    };
  }

  floorHeightAt(x: number, z: number, fromY = 96): number | null {
    return this.floorSurfaceAt(x, z, fromY)?.height ?? null;
  }

  surfaceAt(x: number, z: number, fromY = Number.POSITIVE_INFINITY): ArenaSurface {
    const floor = this.floorSurfaceAt(x, z, fromY);
    if (!floor) return 'water';
    if (this.isConcretePoint(x, z, floor.height)) return 'concrete';
    return 'grass';
  }

  segmentHitDetails(start: THREE.Vector3, end: THREE.Vector3): SurfaceHit | null {
    const direction = end.clone().sub(start);
    const distance = direction.length();
    if (distance < EPSILON) return null;
    direction.multiplyScalar(1 / distance);
    const ray = new THREE.Ray(start, direction);
    let closest: SurfaceHit | null = null;
    const point = new THREE.Vector3();
    for (const box of this.shotBoxes) {
      const hit = ray.intersectBox(box, point);
      if (!hit) continue;
      const hitDistance = hit.distanceTo(start);
      if (hitDistance > distance || (closest && hitDistance >= closest.distance)) continue;
      const normal = this.boxNormal(box, hit, direction);
      closest = { point: hit.clone(), normal, distance: hitDistance, surface: 'concrete' };
    }
    return closest;
  }

  segmentHit(start: THREE.Vector3, end: THREE.Vector3): THREE.Vector3 | null {
    return this.segmentHitDetails(start, end)?.point ?? null;
  }

  hasLineOfSight(start: THREE.Vector3, end: THREE.Vector3, endTolerance = 0.12): boolean {
    const hit = this.segmentHitDetails(start, end);
    return hit === null || hit.point.distanceToSquared(end) <= endTolerance * endTolerance;
  }

  safeSpawnPoint(candidate: THREE.Vector3, radius = MOVEMENT.playerRadius, height = MOVEMENT.playerHeight): THREE.Vector3 | null {
    const floor = this.floorHeightAt(candidate.x, candidate.z, Number.POSITIVE_INFINITY);
    if (floor === null) return null;
    for (let index = 0; index < 8; index += 1) {
      const angle = index / 8 * Math.PI * 2;
      const sample = this.floorHeightAt(
        candidate.x + Math.cos(angle) * (radius + 0.12),
        candidate.z + Math.sin(angle) * (radius + 0.12),
        Number.POSITIVE_INFINITY,
      );
      if (sample === null || Math.abs(sample - floor) > 1.2) return null;
    }
    const seated = new THREE.Vector3(candidate.x, floor, candidate.z);
    const capsuleBox = new THREE.Box3(
      new THREE.Vector3(seated.x - radius, seated.y + 0.02, seated.z - radius),
      new THREE.Vector3(seated.x + radius, seated.y + height, seated.z + radius),
    );
    if (this.colliders.some((collider) => collider.blocksMovement && collider.box.intersectsBox(capsuleBox))) return null;
    const contact = this.resolvePlayerCapsule(seated, new THREE.Vector3(0, -0.1, 0));
    return contact.grounded && !contact.wallContact ? seated : null;
  }

  isTraversablePoint(candidate: THREE.Vector3, fromY = candidate.y + 4): boolean {
    const floor = this.floorSurfaceAt(candidate.x, candidate.z, fromY);
    return floor !== null && floor.normal.y >= MOVEMENT.maxSlopeCosine;
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
    const material = this.material(name, color, 0.35, 0.3);
    material.emissive.setHex(emissive);
    material.emissiveIntensity = 0.86;
    this.pulseMaterials.push(material);
    return material;
  };

  private addMesh(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    name: string,
    position?: THREE.Vector3,
  ): THREE.Mesh {
    this.geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    if (position) mesh.position.copy(position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }

  private createGround(groundMaterial: THREE.MeshStandardMaterial, rockMaterial: THREE.MeshStandardMaterial): void {
    this.addMesh(
      new THREE.BoxGeometry(QUICKSENSE.width, 1.4, QUICKSENSE.depth),
      groundMaterial,
      'QuickSense playable ground',
      new THREE.Vector3(0, -0.7, 0),
    );
    this.colliders.push({
      box: new THREE.Box3(
        new THREE.Vector3(-QUICKSENSE.width * 0.5, -4, -QUICKSENSE.depth * 0.5),
        new THREE.Vector3(QUICKSENSE.width * 0.5, 0, QUICKSENSE.depth * 0.5),
      ),
      name: 'ground slab',
      blocksMovement: true,
    });
    const ridgePositions = [
      [-75, -72, 9, 22], [-40, -76, 12, 24], [4, -78, 10, 20], [47, -74, 13, 26], [78, -60, 8, 20],
      [-78, 60, 12, 25], [-45, 74, 9, 22], [6, 77, 13, 24], [48, 72, 10, 22], [78, 52, 11, 24],
      [-86, -22, 9, 20], [-86, 25, 12, 26], [86, -18, 11, 24], [86, 28, 9, 21],
    ] as const;
    for (const [x, z, height, radius] of ridgePositions) {
      const dramaticHeight = height * 2.2;
      const geometry = new THREE.ConeGeometry(radius * 0.82, dramaticHeight, 6, 1);
      this.addMesh(geometry, rockMaterial, 'low-poly boundary ridge', new THREE.Vector3(x * 1.18, dramaticHeight * 0.5 - 0.2, z * 1.18));
    }
  }

  private createPath(
    name: string,
    points: PathPoint[],
    width: number,
    bank: number,
    deckMaterial: THREE.MeshStandardMaterial,
    edgeMaterial: THREE.MeshStandardMaterial,
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
    const indices: number[] = [];
    const segmentCount = closed ? points.length : points.length - 1;
    const bottomDepth = 1.8;
    const addVertex = (point: THREE.Vector3, u: number, v: number): number => {
      positions.push(point.x, point.y, point.z);
      uvs.push(u * 2.4, v);
      return positions.length / 3 - 1;
    };
    for (let index = 0; index < points.length; index += 1) {
      const previous = points[(index - 1 + points.length) % points.length];
      const current = points[index];
      const next = points[(index + 1) % points.length];
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
      addVertex(left, index / Math.max(1, segmentCount), 0);
      addVertex(right, index / Math.max(1, segmentCount), 1);
      const leftBottom = left.clone(); leftBottom.y -= bottomDepth;
      const rightBottom = right.clone(); rightBottom.y -= bottomDepth;
      addVertex(leftBottom, index / Math.max(1, segmentCount), 0);
      addVertex(rightBottom, index / Math.max(1, segmentCount), 1);
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
      indices.push(topLeft, nextTopLeft, nextTopRight, topLeft, nextTopRight, topRight);
      indices.push(topLeft, bottomLeft, nextBottomLeft, topLeft, nextBottomLeft, nextTopLeft);
      indices.push(topRight, nextTopRight, nextBottomRight, topRight, nextBottomRight, bottomRight);
      indices.push(bottomLeft, bottomRight, nextBottomRight, bottomLeft, nextBottomRight, nextBottomLeft);

      const a = points[index];
      const b = points[next];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length > 0.01) {
        const heading = Math.atan2(b.x - a.x, b.z - a.z);
        const center = new THREE.Vector3((a.x + b.x) * 0.5, Math.max(a.y, b.y) + 0.13, (a.z + b.z) * 0.5);
        const tangent = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, length + 0.08), edgeMaterial);
        tangent.name = `${name} route edge`;
        tangent.position.copy(center);
        tangent.rotation.y = heading;
        tangent.castShadow = false;
        tangent.receiveShadow = false;
        this.geometries.push(tangent.geometry);
        this.group.add(tangent);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    this.addMesh(geometry, deckMaterial, name);

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

  private createRamps(
    deckMaterial: THREE.MeshStandardMaterial,
    cyanMaterial: THREE.MeshStandardMaterial,
    magentaMaterial: THREE.MeshStandardMaterial,
    amberMaterial: THREE.MeshStandardMaterial,
  ): void {
    const ramps: Array<{ name: string; spec: LaunchRampSpec; edge: THREE.MeshStandardMaterial }> = [
      {
        name: 'South progressive launch',
        spec: { origin: { x: -9, y: 2.0, z: -67 }, heading: 0, length: 22, width: 10, rise: 7.4, curveExponent: 1.7, solid: true, skirtDepth: 1.7 },
        edge: amberMaterial,
      },
      {
        name: 'North return launch',
        spec: { origin: { x: 9, y: 17.3, z: 67 }, heading: Math.PI, length: 22, width: 10, rise: -7.4, curveExponent: 1.7, solid: true, skirtDepth: 1.7 },
        edge: amberMaterial,
      },
      {
        name: 'West transfer ramp',
        spec: { origin: { x: -72, y: 2.2, z: 9 }, heading: Math.PI * 0.5, length: 24, width: 9, rise: 7.4, curveExponent: 1.8, solid: true, skirtDepth: 1.7 },
        edge: cyanMaterial,
      },
      {
        name: 'East transfer ramp',
        spec: { origin: { x: 72, y: 2.2, z: -9 }, heading: -Math.PI * 0.5, length: 24, width: 9, rise: 7.4, curveExponent: 1.8, solid: true, skirtDepth: 1.7 },
        edge: magentaMaterial,
      },
      {
        name: 'Center hip ramp',
        spec: { origin: { x: -4.5, y: 8.0, z: -16 }, heading: 0, length: 16, width: 8, rise: 4.8, curveExponent: 1.6, solid: true, skirtDepth: 1.4 },
        edge: deckMaterial,
      },
    ];
    for (const ramp of ramps) {
      const flow = buildLaunchRamp(ramp.spec);
      this.rampSurfaces.push({ name: ramp.name, spec: ramp.spec, flow });
      this.geometries.push(flow.geometry);
      const mesh = new THREE.Mesh(flow.geometry, deckMaterial);
      mesh.name = ramp.name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.addRampRails(ramp.spec, ramp.edge);
      const box = flow.geometry.boundingBox?.clone();
      if (box) this.shotBoxes.push(box);
    }
  }

  private addRampRails(spec: LaunchRampSpec, edgeMaterial: THREE.MeshStandardMaterial): void {
    const points = 5;
    for (let index = 0; index < points - 1; index += 1) {
      const a = this.rampPoint(spec, index / (points - 1), spec.width * 0.5 + 0.32);
      const b = this.rampPoint(spec, (index + 1) / (points - 1), spec.width * 0.5 + 0.32);
      const length = a.distanceTo(b);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, length), edgeMaterial);
      rail.name = `${spec.origin.x < 0 ? 'west' : 'east'} ramp rail`;
      rail.position.copy(a.clone().lerp(b, 0.5));
      rail.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
      this.geometries.push(rail.geometry);
      this.group.add(rail);
    }
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
    this.box('Flux Core central body', new THREE.Vector3(0, 15.3, 0), new THREE.Vector3(17, 6.2, 13), sideMaterial, true);
    this.box('Flux Core upper cap', new THREE.Vector3(0, 19.0, 0), new THREE.Vector3(12.5, 1.0, 9.5), whiteMaterial, true);
    this.box('Core cyan tower', new THREE.Vector3(-7.3, 20.0, 0), new THREE.Vector3(2.4, 8.8, 2.4), cyanMaterial, true);
    this.box('Core magenta tower', new THREE.Vector3(7.3, 20.0, 0), new THREE.Vector3(2.4, 8.8, 2.4), magentaMaterial, true);
    this.box('Core amber spine', new THREE.Vector3(0, 22.0, 0), new THREE.Vector3(1.4, 13.0, 1.4), amberMaterial, true);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(8.6, 0.16, 6, 24), amberMaterial);
    ring.name = 'Flux Core orbit ring';
    ring.rotation.x = Math.PI * 0.5;
    ring.position.set(0, 23.6, 0);
    ring.castShadow = false;
    this.geometries.push(ring.geometry);
    this.group.add(ring);
    this.animatedProps.push({ object: ring, baseY: 23.6, phase: 0.2, spin: 0.22 });
    const coreLight = new THREE.PointLight(0x53eaff, 9, 32, 2);
    coreLight.position.set(0, 22, 0);
    this.group.add(coreLight);
    this.box('Flux Core upper citadel', new THREE.Vector3(0, 24.2, 0), new THREE.Vector3(15, 3.2, 10.5), sideMaterial, true);
    this.box('Flux Core citadel roof', new THREE.Vector3(0, 26.1, 0), new THREE.Vector3(18, 0.7, 13.5), whiteMaterial, true);
    this.box('Flux Core west buttress', new THREE.Vector3(-10.4, 21.2, 0), new THREE.Vector3(2.8, 10.0, 7.4), sideMaterial, true);
    this.box('Flux Core east buttress', new THREE.Vector3(10.4, 21.2, 0), new THREE.Vector3(2.8, 10.0, 7.4), sideMaterial, true);
    this.createTower(-17, 0, 12.5, 19, cyanMaterial, sideMaterial);
    this.createTower(17, 0, 12.5, 19, magentaMaterial, sideMaterial);
    this.createTower(0, 43, 17.0, 20, amberMaterial, sideMaterial);
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
  ): void {
    this.buildings(-67, 31, 10.5, 16, 14, 11, sideMaterial, whiteMaterial, cyanMaterial);
    this.buildings(67, -31, 10.5, 16, 14, 11, sideMaterial, whiteMaterial, magentaMaterial);
    this.buildings(0, 61, 20.5, 19, 13, 16, sideMaterial, whiteMaterial, cyanMaterial);
    this.buildings(0, -61, 6.2, 19, 13, 9, sideMaterial, whiteMaterial, magentaMaterial);
  }

  private buildings(
    x: number,
    z: number,
    roofY: number,
    width: number,
    depth: number,
    height: number,
    sideMaterial: THREE.MeshStandardMaterial,
    whiteMaterial: THREE.MeshStandardMaterial,
    accent: THREE.MeshStandardMaterial,
  ): void {
    this.box('QuickSense building mass', new THREE.Vector3(x, roofY - height * 0.5, z), new THREE.Vector3(width, height, depth), sideMaterial, true);
    this.box('QuickSense building roof', new THREE.Vector3(x, roofY + 0.45, z), new THREE.Vector3(width + 1.6, 0.9, depth + 1.6), whiteMaterial, true);
    this.box('QuickSense vertical light panel', new THREE.Vector3(x - width * 0.5 - 0.12, roofY - height * 0.55, z), new THREE.Vector3(0.16, height * 0.56, depth * 0.56), accent, false);
    this.box('QuickSense front light panel', new THREE.Vector3(x, roofY - height * 0.55, z - depth * 0.5 - 0.12), new THREE.Vector3(width * 0.55, height * 0.28, 0.16), accent, false);
    this.box('QuickSense roof front rail', new THREE.Vector3(x, roofY + 0.98, z - depth * 0.5 - 0.15), new THREE.Vector3(width * 0.78, 0.18, 0.22), accent, false);
    this.box('QuickSense roof side rail', new THREE.Vector3(x - width * 0.5 - 0.15, roofY + 0.98, z), new THREE.Vector3(0.22, 0.18, depth * 0.78), accent, false);
  }

  private createFloatingStructures(
    sideMaterial: THREE.MeshStandardMaterial,
    whiteMaterial: THREE.MeshStandardMaterial,
    cyanMaterial: THREE.MeshStandardMaterial,
    magentaMaterial: THREE.MeshStandardMaterial,
  ): void {
    this.floatingBuilding(-29, -37, 32, 22, 10, 14, sideMaterial, whiteMaterial, cyanMaterial, 0.22);
    this.floatingBuilding(29, 37, 34, 22, 10, 14, sideMaterial, whiteMaterial, magentaMaterial, -0.22);
    this.floatingBuilding(34, -34, 26, 15, 8, 10, sideMaterial, whiteMaterial, magentaMaterial, 0);
    this.floatingBuilding(-34, 34, 26, 15, 8, 10, sideMaterial, whiteMaterial, cyanMaterial, 0);
    this.floatingBuilding(0, -12, 36, 20, 8, 13, sideMaterial, whiteMaterial, cyanMaterial, 0.12);
  }

  private floatingBuilding(
    x: number,
    z: number,
    y: number,
    width: number,
    height: number,
    depth: number,
    sideMaterial: THREE.MeshStandardMaterial,
    whiteMaterial: THREE.MeshStandardMaterial,
    accent: THREE.MeshStandardMaterial,
    yaw: number,
  ): void {
    const body = this.box('Floating grapple building', new THREE.Vector3(x, y, z), new THREE.Vector3(width, height, depth), sideMaterial, true, yaw);
    this.box('Floating building crown', new THREE.Vector3(x, y + height * 0.5 + 0.45, z), new THREE.Vector3(width + 1.4, 0.9, depth + 1.4), whiteMaterial, true, yaw);
    this.box('Floating building signal face', new THREE.Vector3(x, y, z - depth * 0.5 - 0.12), new THREE.Vector3(width * 0.6, height * 0.4, 0.18), accent, false, yaw);
    const tether = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, y - 1.2, 6), accent);
    tether.name = 'Floating building energy tether';
    tether.position.set(x, y * 0.5, z);
    this.geometries.push(tether.geometry);
    this.group.add(tether);
    for (const cornerX of [-1, 1]) {
      for (const cornerZ of [-1, 1]) {
        const thruster = new THREE.Mesh(new THREE.ConeGeometry(0.62, 1.8, 5), accent);
        thruster.name = 'Floating building undercarriage thruster';
        thruster.position.set(
          x + cornerX * (width * 0.34),
          y - height * 0.5 - 0.9,
          z + cornerZ * (depth * 0.34),
        );
        this.geometries.push(thruster.geometry);
        this.group.add(thruster);
      }
    }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(Math.max(width, depth) * 0.65, 0.12, 6, 18), accent);
    ring.name = 'Floating building grapple ring';
    ring.rotation.x = Math.PI * 0.5;
    ring.position.set(x, y + height * 0.5 + 1.0, z);
    this.geometries.push(ring.geometry);
    this.group.add(ring);
    this.animatedProps.push({ object: ring, baseY: ring.position.y, phase: yaw, spin: yaw >= 0 ? 0.3 : -0.3 });
    void body;
  }

  private createBoundaryArchitecture(sideMaterial: THREE.MeshStandardMaterial, accent: THREE.MeshStandardMaterial): void {
    const walls = [
      { center: new THREE.Vector3(0, 1.4, -80), size: new THREE.Vector3(168, 2.8, 1.2) },
      { center: new THREE.Vector3(0, 1.4, 80), size: new THREE.Vector3(168, 2.8, 1.2) },
      { center: new THREE.Vector3(-90, 1.4, 0), size: new THREE.Vector3(1.2, 2.8, 148) },
      { center: new THREE.Vector3(90, 1.4, 0), size: new THREE.Vector3(1.2, 2.8, 148) },
    ];
    for (const wall of walls) this.box('QuickSense perimeter wall', wall.center, wall.size, sideMaterial, false);
    for (let index = -3; index <= 3; index += 1) {
      this.box('QuickSense perimeter light', new THREE.Vector3(index * 24, 2.95, -80.68), new THREE.Vector3(7.5, 0.14, 0.12), accent, false);
      this.box('QuickSense perimeter light', new THREE.Vector3(index * 24, 2.95, 80.68), new THREE.Vector3(7.5, 0.14, 0.12), accent, false);
    }
  }

  private createRouteSupports(
    sideMaterial: THREE.MeshStandardMaterial,
    cyanMaterial: THREE.MeshStandardMaterial,
    magentaMaterial: THREE.MeshStandardMaterial,
  ): void {
    const supports = [
      [-67, 0, 3.0, cyanMaterial], [-42, 0, 2.0, cyanMaterial], [-18, 0, 7.5, cyanMaterial],
      [67, 0, 3.0, magentaMaterial], [42, 0, 2.0, magentaMaterial], [18, 0, 7.5, magentaMaterial],
      [-42, -48, 2.2, sideMaterial], [42, 48, 2.2, sideMaterial], [0, -48, 3.0, sideMaterial], [0, 48, 15.0, sideMaterial],
    ] as const;
    for (const [x, z, top, material] of supports) {
      this.box('Flow bridge support', new THREE.Vector3(x, top * 0.5, z), new THREE.Vector3(1.8, Math.max(1.5, top), 1.8), material, true);
      const light = this.box('Flow bridge support light', new THREE.Vector3(x, top * 0.56, z - 0.95), new THREE.Vector3(0.18, Math.max(0.9, top * 0.58), 0.08), material, false);
      light.castShadow = false;
    }
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
      position: position.clone(),
      direction: direction.normalize().clone(),
      radius: 4.2,
      launchSpeed: 25,
    };
  }

  private pointOnFloor(x: number, z: number, lift = 0.04): THREE.Vector3 {
    const floor = this.floorHeightAt(x, z, Number.POSITIVE_INFINITY) ?? 0;
    return new THREE.Vector3(x, floor + lift, z);
  }

  private floorSurfaceAt(x: number, z: number, fromY: number): { height: number; normal: THREE.Vector3 } | null {
    if (Math.abs(x) > QUICKSENSE.width * 0.5 || Math.abs(z) > QUICKSENSE.depth * 0.5) return null;
    let hasSurface = false;
    let highestHeight = Number.NEGATIVE_INFINITY;
    this.floorNormal.set(0, 1, 0);
    if (0 <= fromY + 0.04) {
      hasSurface = true;
      highestHeight = 0;
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

  private boxNormal(box: THREE.Box3, point: THREE.Vector3, direction: THREE.Vector3): THREE.Vector3 {
    const distances = [
      { distance: Math.abs(point.x - box.min.x), normal: new THREE.Vector3(-1, 0, 0) },
      { distance: Math.abs(point.x - box.max.x), normal: new THREE.Vector3(1, 0, 0) },
      { distance: Math.abs(point.y - box.min.y), normal: new THREE.Vector3(0, -1, 0) },
      { distance: Math.abs(point.y - box.max.y), normal: new THREE.Vector3(0, 1, 0) },
      { distance: Math.abs(point.z - box.min.z), normal: new THREE.Vector3(0, 0, -1) },
      { distance: Math.abs(point.z - box.max.z), normal: new THREE.Vector3(0, 0, 1) },
    ];
    distances.sort((a, b) => a.distance - b.distance);
    const normal = distances[0].normal;
    if (normal.dot(direction) > 0) normal.negate();
    return normal;
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
    if (longitudinal <= entryDepth && Math.abs(lateral) <= halfWidth && surfaceY - position.y <= MOVEMENT.stepHeight + 0.16) return null;
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
