import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { acceleratedRaycast, MeshBVH } from 'three-mesh-bvh';
import { assetUrl } from '../assets/assetUrl';
import type { WeatherGameplaySnapshot, WeatherPhase } from '../systems/WeatherGameplaySystem';
import { MOVEMENT } from './config';
import {
  MONSOON_DIVIDE,
  MONSOON_INNER_LOOP_SAMPLES,
  MONSOON_ROUTE_SEGMENTS,
  buildMonsoonTerrainGeometry,
  mapSeedFromLocation,
  sampleMonsoonHeight,
  sampleMonsoonMeshHeight,
  sampleMonsoonMasks,
  sampleMonsoonNormal,
} from './maps/MonsoonDivide';
import {
  buildLaunchRamp,
  buildTerrainRibbonGeometry,
  type FlowSurfaceBuild,
  type LaunchRampSpec,
} from './maps/FlowGeometry';
import { QuickSenseArena } from './maps/QuickSenseArena';

THREE.Mesh.prototype.raycast = acceleratedRaycast;

export type JumpPad = {
  position: THREE.Vector3;
  direction: THREE.Vector3;
  radius: number;
  launchSpeed: number;
};

export type CapsuleContact = {
  grounded: boolean;
  contactNormal: THREE.Vector3;
  wallContact: boolean;
  wallNormal: THREE.Vector3;
  correction: THREE.Vector3;
  contacts: number;
};

export type SurfaceHit = {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  surface: 'grass' | 'soil' | 'rock' | 'metal' | 'concrete' | 'water';
};

export type ArenaSurface = SurfaceHit['surface'];

export type ArenaMapInfo = {
  name: string;
  seed: number;
  generationVersion: number;
  ready: boolean;
  topologyHash: string;
  bounds: { width: number; depth: number };
  altitudeRange: { min: number; max: number };
  renderTriangles: number;
  collisionTriangles: number;
  spawnCount: number;
  pickupCount: number;
  jumpPadCount: number;
  skiRoutes: number;
};

/** Runtime contract shared by the authored maps loaded by Game. */
export interface ArenaRuntime {
  readonly group: THREE.Group;
  readonly skyTexture?: THREE.Texture;
  readonly seed: number;
  readonly killY: number;
  readonly jumpPads: JumpPad[];
  readonly collisionTriangles: number;
  readonly corePosition: THREE.Vector3;
  readonly spawnPoints: THREE.Vector3[];
  readonly itemPoints: Record<string, THREE.Vector3>;
  readonly mapInfo: ArenaMapInfo;
  update(elapsed: number, reducedMotion: boolean): void;
  setWeatherGameplaySnapshot(snapshot: WeatherGameplaySnapshot | null): void;
  getWeatherVisualDiagnostics(): ArenaWeatherVisualDiagnostics;
  setPlayerInfluence(position: THREE.Vector3): void;
  resolvePlayerCapsule(position: THREE.Vector3, velocity: THREE.Vector3): CapsuleContact;
  resolveCapsule(
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    radius: number,
    height: number,
  ): CapsuleContact;
  floorHeightAt(x: number, z: number, fromY?: number): number | null;
  segmentHitDetails(start: THREE.Vector3, end: THREE.Vector3): SurfaceHit | null;
  surfaceAt(x: number, z: number, fromY?: number): ArenaSurface;
  addFootTrack(position: THREE.Vector3, movement: THREE.Vector3, elapsed: number): void;
  registerSurfaceImpact(position: THREE.Vector3, normal: THREE.Vector3, energy: number, elapsed: number): void;
  segmentHit(start: THREE.Vector3, end: THREE.Vector3): THREE.Vector3 | null;
  hasLineOfSight(start: THREE.Vector3, end: THREE.Vector3, endTolerance?: number): boolean;
  safeSpawnPoint(candidate: THREE.Vector3, radius?: number, height?: number): THREE.Vector3 | null;
  isTraversablePoint(candidate: THREE.Vector3, fromY?: number): boolean;
  dispose(): void;
}

export type ArenaWeatherVisualDiagnostics = Readonly<{
  source: 'autonomous' | 'gameplay';
  phase: WeatherPhase | 'autonomous';
  label: string;
  severity: number;
  rainIntensity: number;
  visualWindStrength: number;
  windDirection: Readonly<{ x: number; z: number }>;
  visibilityMultiplier: number;
}>;

type AnimatedProp = {
  object: THREE.Object3D;
  baseY: number;
  phase: number;
  spin: number;
};

type ArenaCollider = {
  box: THREE.Box3;
  name: string;
};

type RampSurface = {
  name: string;
  centerX: number;
  centerZ: number;
  startY: number;
  length: number;
  width: number;
  rise: number;
  yaw: number;
  spec: LaunchRampSpec;
  flow: FlowSurfaceBuild;
};

type PlatformSurface = {
  name: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  y: number;
};

type AmbientAnimalRoute = {
  centerX: number;
  centerZ: number;
  radiusX: number;
  radiusZ: number;
  phase: number;
  speed: number;
};

type AnimalRig = {
  mesh: THREE.SkinnedMesh;
  spine: THREE.Bone;
  head: THREE.Bone;
  tail: THREE.Bone;
  hips: [THREE.Bone, THREE.Bone, THREE.Bone, THREE.Bone];
  knees: [THREE.Bone, THREE.Bone, THREE.Bone, THREE.Bone];
};

type AmbientLifeMeshes = {
  animals: AnimalRig[];
  shadows: THREE.InstancedMesh;
  beetles: THREE.InstancedMesh;
  birds: THREE.InstancedMesh;
};

type ScatteredRock = {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
};

type GroundMark = {
  position: THREE.Vector3;
  normal: THREE.Vector3;
  forward: THREE.Vector3;
  bornAt: number;
  size: number;
};

type SurfaceTextureSet = {
  albedo: THREE.Texture;
  normal: THREE.Texture;
  roughness: THREE.Texture;
};

const SPAWN_XZ: ReadonlyArray<readonly [number, number]> = [
  [-92, 70], [80, 60], [-48, -55], [55, -62],
  [-150, 90], [145, 80], [-136, -109], [128, -114],
  [-84, 137], [82, 137], [-178, 25], [174, 20],
  [0, -148], [0, 132], [-110, -10],
];

const ITEM_XZ: Readonly<Record<string, readonly [number, number]>> = {
  'health-a': [-58, -42],
  'health-b': [68, 34],
  armor: [-98, 28],
  damage: [0, -31],
  speed: [112, -88],
  rail: [-158, 96],
  rocket: [-148, -86],
  plasma: [113, 63],
  shotgun: [16, -86],
  sniper: [139, 93],
  laser: [-78, 136],
};

const GATE_XZ: ReadonlyArray<readonly [number, number]> = [
  // The four inner gates are centered on their matching launch-ramp lines so
  // their solid posts frame the route instead of clipping the riding surface.
  [-111, 53], [105, 44.7], [-103, -71.4], [104, -74.9],
  [-180, 42], [177, 35], [-58, 118], [61, 118],
];
const ROUTE_GATE_HALF_WIDTH = 8.2;
const AMBIENT_UPDATE_INTERVAL_SECONDS = 1 / 30;
const GROUND_MARK_UPDATE_INTERVAL_SECONDS = 1 / 12;
const VEGETATION_CHUNK_COLUMNS = 6;
const VEGETATION_CHUNK_ROWS = 5;
const VEGETATION_CHUNK_COUNT = VEGETATION_CHUNK_COLUMNS * VEGETATION_CHUNK_ROWS;

function randomFactory(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

function placedPoint(x: number, z: number, seed: number, offset = 0.02): THREE.Vector3 {
  return new THREE.Vector3(x, sampleMonsoonHeight(x, z, seed) + offset, z);
}

function ballisticPad(
  x: number,
  z: number,
  targetX: number,
  targetZ: number,
  flightTime: number,
  seed: number,
): JumpPad {
  const position = placedPoint(x, z, seed, 0.12);
  const target = placedPoint(targetX, targetZ, seed, 1.1);
  const velocity = new THREE.Vector3(
    (target.x - position.x) / flightTime,
    (target.y - position.y + 0.5 * MOVEMENT.gravity * flightTime * flightTime) / flightTime,
    (target.z - position.z) / flightTime,
  );
  return {
    position,
    direction: velocity.clone().normalize(),
    radius: 4.2,
    launchSpeed: velocity.length(),
  };
}

function createJumpPads(seed: number): JumpPad[] {
  return [
    ballisticPad(-43, 14, -108, 66, 2.2, seed),
    ballisticPad(44, 16, 102, 63, 2.15, seed),
    ballisticPad(-27, -46, -111, -82, 2.45, seed),
    ballisticPad(34, -48, 109, -87, 2.35, seed),
    ballisticPad(-123, 8, -74, 132, 2.85, seed),
    ballisticPad(122, -8, 74, 128, 2.95, seed),
  ];
}

export const JUMP_PADS: JumpPad[] = createJumpPads(MONSOON_DIVIDE.seed);

export class Arena implements ArenaRuntime {
  readonly group = new THREE.Group();
  readonly skyTexture?: THREE.Texture;
  readonly seed: number;
  readonly killY = MONSOON_DIVIDE.killY;
  readonly jumpPads: JumpPad[];
  readonly collisionTriangles: number;
  readonly corePosition: THREE.Vector3;
  readonly spawnPoints: THREE.Vector3[];
  readonly itemPoints: Record<string, THREE.Vector3>;
  readonly mapInfo: ArenaMapInfo;

  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly textures: THREE.Texture[] = [];
  private readonly colliders: ArenaCollider[] = [];
  private readonly rampSurfaces: RampSurface[] = [];
  private readonly platformSurfaces: PlatformSurface[] = [];
  private readonly concreteBoxes: THREE.Box3[] = [];
  private readonly scatteredRocks: ScatteredRock[] = [];
  private readonly animatedProps: AnimatedProp[] = [];
  private readonly collisionGeometry: THREE.BufferGeometry;
  private readonly boundsTree: MeshBVH;
  private readonly contactNormal = new THREE.Vector3(0, 1, 0);
  private readonly correction = new THREE.Vector3();
  private readonly bestWallNormal = new THREE.Vector3();
  private readonly capsuleContacts: CapsuleContact[] = Array.from({ length: 8 }, () => ({
    grounded: false,
    contactNormal: new THREE.Vector3(0, 1, 0),
    wallContact: false,
    wallNormal: new THREE.Vector3(),
    correction: new THREE.Vector3(),
    contacts: 0,
  }));
  private capsuleContactCursor = 0;
  private readonly rayDirection = new THREE.Vector3();
  private readonly collisionRay = new THREE.Ray();
  private readonly rayHitNormal = new THREE.Vector3();
  private readonly surfaceHit: SurfaceHit = {
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    distance: 0,
    surface: 'grass',
  };
  private readonly rampContactNormal = new THREE.Vector3();
  private readonly rampContact = { normal: this.rampContactNormal, depth: 0 };
  private readonly floorSurfaceNormal = new THREE.Vector3(0, 1, 0);
  private readonly floorSurface = { height: 0, normal: this.floorSurfaceNormal };
  private readonly waterUniforms = {
    uTime: { value: 0 },
    uDeep: { value: new THREE.Color(0x0b5278) },
    uShallow: { value: new THREE.Color(0x36a8c8) },
    uSun: { value: new THREE.Color(0xffe1a6) },
  };
  private readonly weatherUniforms = {
    uTime: { value: 0 },
    uWind: { value: 0.7 },
    uWindDirection: { value: new THREE.Vector2(0.72, 0.38).normalize() },
    uIntensity: { value: 0.18 },
  };
  private readonly grassUniforms = {
    uTime: { value: 0 },
    uWind: { value: 0.72 },
    uWindDirection: { value: new THREE.Vector2(0.72, 0.38).normalize() },
    uPlayer: { value: new THREE.Vector3(0, -100, 0) },
  };
  private readonly autonomousWindDirection = new THREE.Vector2(0.72, 0.38).normalize();
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
    label: 'AUTONOMOUS WEATHER',
    severity: 0,
    rainIntensity: 0.07,
    visualWindStrength: 0.58,
    windDirection: { x: this.autonomousWindDirection.x, z: this.autonomousWindDirection.y },
    visibilityMultiplier: 1,
  };
  private readonly playerInfluence = new THREE.Vector3(0, -100, 0);
  private readonly animalRoutes: AmbientAnimalRoute[] = [];
  private ambientLife?: AmbientLifeMeshes;
  private footprintMesh?: THREE.InstancedMesh;
  private crackMesh?: THREE.InstancedMesh;
  private readonly footprints: Array<GroundMark | undefined> = new Array(80);
  private readonly cracks: Array<GroundMark | undefined> = new Array(48);
  private readonly ambientMatrix = new THREE.Matrix4();
  private readonly ambientQuaternion = new THREE.Quaternion();
  private readonly ambientShadowQuaternion = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(-Math.PI * 0.5, 0, 0),
  );
  private readonly ambientEuler = new THREE.Euler();
  private readonly ambientPosition = new THREE.Vector3();
  private readonly ambientScale = new THREE.Vector3();
  private readonly hiddenGroundMarkMatrix = new THREE.Matrix4().makeTranslation(0, -1000, 0);
  private readonly groundMarkMatrix = new THREE.Matrix4();
  private readonly groundMarkTangent = new THREE.Vector3();
  private readonly groundMarkRight = new THREE.Vector3();
  private readonly groundMarkScale = new THREE.Vector3();
  private footprintCursor = 0;
  private crackCursor = 0;
  private footprintSide = 1;
  private lastAmbientUpdateTime = Number.NEGATIVE_INFINITY;
  private lastGroundMarkUpdateTime = Number.NEGATIVE_INFINITY;
  private groundMarksActive = false;
  private groundMarksDirty = false;

  static async load(): Promise<ArenaRuntime> {
    if (new URLSearchParams(window.location.search).get('map') === 'quicksense') {
      return new QuickSenseArena(mapSeedFromLocation());
    }
    let skyTexture: THREE.Texture | undefined;
    try {
      skyTexture = await new THREE.TextureLoader().loadAsync(assetUrl('assets/maps/monsoon-equirect-v4.jpg'));
      skyTexture.name = 'MonsoonEquirectangularSkyV4';
      skyTexture.colorSpace = THREE.SRGBColorSpace;
      skyTexture.mapping = THREE.EquirectangularReflectionMapping;
      skyTexture.minFilter = THREE.LinearMipmapLinearFilter;
      skyTexture.magFilter = THREE.LinearFilter;
    } catch (error) {
      console.warn('Monsoon sky panorama unavailable; using procedural fallback.', error);
    }
    return new Arena(mapSeedFromLocation(), skyTexture);
  }

  private constructor(seed: number, skyTexture?: THREE.Texture) {
    this.seed = seed;
    this.skyTexture = skyTexture;
    if (skyTexture) this.textures.push(skyTexture);
    this.jumpPads = createJumpPads(seed);
    this.corePosition = placedPoint(0, 0, seed, 0.15);
    this.spawnPoints = SPAWN_XZ.map(([x, z]) => placedPoint(x, z, seed, 0.015));
    this.itemPoints = Object.fromEntries(
      Object.entries(ITEM_XZ).map(([name, [x, z]]) => [name, placedPoint(x, z, seed, 0.92)]),
    );
    this.group.name = 'MonsoonDivideProceduralArena';
    this.group.userData.source = 'Original procedural Three.js terrain';
    this.group.userData.license = 'Riftline project original';
    this.group.userData.mapSeed = seed;

    const terrain = buildMonsoonTerrainGeometry(seed);
    const toonRamp = this.createToonRamp();
    const terrainTextures = this.createTerrainTextureSet();
    const terrainMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      map: terrainTextures.albedo,
      normalMap: terrainTextures.normal,
      normalScale: new THREE.Vector2(0.28, 0.28),
      roughnessMap: terrainTextures.roughness,
      roughness: 0.96,
      metalness: 0.015,
    });
    terrainMaterial.name = 'MonsoonPanoramaMatchedTerrainPBR';
    this.materials.push(terrainMaterial);
    this.geometries.push(terrain.geometry);
    const terrainMesh = new THREE.Mesh(terrain.geometry, terrainMaterial);
    terrainMesh.name = 'MonsoonDivideTerrain';
    terrainMesh.receiveShadow = true;
    this.group.add(terrainMesh);

    this.registerGameplayColliders();
    this.registerConcreteTraversal();
    this.registerRockField();
    const collisionParts = [this.positionOnlyGeometry(terrain.geometry)];
    for (const collider of this.colliders) collisionParts.push(this.geometryFromBox(collider.box));
    for (const ramp of this.rampSurfaces) {
      collisionParts.push(this.positionOnlyGeometry(ramp.flow.geometry));
    }
    const mergedCollision = mergeGeometries(collisionParts, false);
    for (const part of collisionParts) part.dispose();
    if (!mergedCollision) throw new Error('Failed to build Monsoon Divide collision surface.');
    mergedCollision.computeBoundingBox();
    mergedCollision.computeBoundingSphere();
    this.collisionGeometry = mergedCollision;
    this.boundsTree = new MeshBVH(this.collisionGeometry, { maxLeafSize: 12 });
    this.collisionTriangles = this.collisionGeometry.getAttribute('position').count / 3;

    this.createOcean();
    this.createDistantIslands();
    this.createRouteGates(toonRamp);
    this.createJumpPadVisuals(toonRamp);
    this.createConcreteTraversal(toonRamp);
    this.createDetailedDirtRoutes(toonRamp);
    this.createCoreReactor(toonRamp);
    this.createLandmarkTower(-166, 91, 0xcf43ff, 1.16, toonRamp);
    this.createLandmarkTower(-148, -112, 0xffb52b, 0.94, toonRamp);
    this.createLandmarkTower(158, 78, 0x8dff35, 0.96, toonRamp);
    this.createVegetation(toonRamp);
    this.createGroundMarks();
    this.createAmbientLife(toonRamp);
    this.createStormRain();

    this.mapInfo = {
      name: MONSOON_DIVIDE.name,
      seed,
      generationVersion: MONSOON_DIVIDE.generationVersion,
      ready: true,
      topologyHash: terrain.topologyHash,
      bounds: { width: MONSOON_DIVIDE.width, depth: MONSOON_DIVIDE.depth },
      altitudeRange: terrain.altitudeRange,
      renderTriangles: terrain.triangleCount,
      collisionTriangles: this.collisionTriangles,
      spawnCount: this.spawnPoints.length,
      pickupCount: Object.keys(this.itemPoints).length,
      jumpPadCount: this.jumpPads.length,
      skiRoutes: 6,
    };
  }

  update(elapsed: number, reducedMotion: boolean): void {
    const time = reducedMotion ? 0 : elapsed;
    const gameplayWeather = this.weatherGameplaySnapshot;
    let shower: number;
    let wind: number;
    let windDirectionX: number;
    let windDirectionZ: number;

    if (gameplayWeather) {
      shower = THREE.MathUtils.clamp(gameplayWeather.severity, 0, 1);
      const requestedWindStrength = THREE.MathUtils.clamp(gameplayWeather.windStrength, 0, 1);
      wind = 0.28 + requestedWindStrength * 1.08;
      const requestedWindLength = Math.hypot(
        gameplayWeather.windDirection.x,
        gameplayWeather.windDirection.z,
      );
      if (Number.isFinite(requestedWindLength) && requestedWindLength > 0.0001) {
        windDirectionX = gameplayWeather.windDirection.x / requestedWindLength;
        windDirectionZ = gameplayWeather.windDirection.z / requestedWindLength;
      } else {
        windDirectionX = this.autonomousWindDirection.x;
        windDirectionZ = this.autonomousWindDirection.y;
      }
      if (reducedMotion) wind = Math.min(wind, 0.42);

      this.weatherVisualDiagnostics.source = 'gameplay';
      this.weatherVisualDiagnostics.phase = gameplayWeather.phase;
      this.weatherVisualDiagnostics.label = gameplayWeather.label;
      this.weatherVisualDiagnostics.severity = shower;
      this.weatherVisualDiagnostics.visibilityMultiplier = THREE.MathUtils.clamp(
        gameplayWeather.multipliers.visibilityMultiplier,
        0,
        1,
      );
    } else {
      const weatherWave = reducedMotion ? 0.22 : 0.5 + Math.sin(time * 0.046 - 1.4) * 0.5;
      shower = THREE.MathUtils.smoothstep(weatherWave, 0.5, 0.94);
      wind = reducedMotion ? 0.42 : 0.58 + shower * 0.75 + Math.sin(time * 0.19) * 0.12;
      windDirectionX = this.autonomousWindDirection.x;
      windDirectionZ = this.autonomousWindDirection.y;

      this.weatherVisualDiagnostics.source = 'autonomous';
      this.weatherVisualDiagnostics.phase = 'autonomous';
      this.weatherVisualDiagnostics.label = 'AUTONOMOUS WEATHER';
      this.weatherVisualDiagnostics.severity = shower;
      this.weatherVisualDiagnostics.visibilityMultiplier = 1;
    }

    const rainIntensity = 0.07 + shower * 0.82;
    this.waterUniforms.uTime.value = time;
    this.weatherUniforms.uTime.value = time;
    this.weatherUniforms.uIntensity.value = rainIntensity;
    this.weatherUniforms.uWind.value = wind;
    this.weatherUniforms.uWindDirection.value.set(windDirectionX, windDirectionZ);
    this.grassUniforms.uTime.value = time;
    this.grassUniforms.uWind.value = wind;
    this.grassUniforms.uWindDirection.value.set(windDirectionX, windDirectionZ);
    this.grassUniforms.uPlayer.value.copy(this.playerInfluence);
    this.weatherVisualDiagnostics.rainIntensity = rainIntensity;
    this.weatherVisualDiagnostics.visualWindStrength = wind;
    this.weatherVisualDiagnostics.windDirection.x = windDirectionX;
    this.weatherVisualDiagnostics.windDirection.z = windDirectionZ;
    for (const prop of this.animatedProps) {
      prop.object.rotation.y = time * prop.spin + prop.phase;
      prop.object.position.y = prop.baseY + (reducedMotion ? 0 : Math.sin(time * 2.1 + prop.phase) * 0.18);
    }
    if (
      time < this.lastAmbientUpdateTime
      || time - this.lastAmbientUpdateTime >= AMBIENT_UPDATE_INTERVAL_SECONDS
    ) {
      this.updateAmbientLife(time);
      this.lastAmbientUpdateTime = time;
    }
    if (
      this.groundMarksDirty
      || (
        this.groundMarksActive
        && (
          time < this.lastGroundMarkUpdateTime
          || time - this.lastGroundMarkUpdateTime >= GROUND_MARK_UPDATE_INTERVAL_SECONDS
        )
      )
    ) {
      this.updateGroundMarks(time);
      this.lastGroundMarkUpdateTime = time;
    }
  }

  /** Use `null` to restore the arena's existing autonomous weather visuals. */
  setWeatherGameplaySnapshot(snapshot: WeatherGameplaySnapshot | null): void {
    // Weather snapshots are readonly value objects. Retaining the current
    // snapshot avoids three short-lived object allocations every render.
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
    this.bestWallNormal.set(0, 0, 0);
    let contacts = 0;
    let grounded = false;
    let wallContact = false;

    const floorSurface = this.floorSurfaceAt(
      position.x,
      position.z,
      position.y + MOVEMENT.groundSnapDistance + 0.08,
    );
    if (floorSurface !== null) {
      this.contactNormal.copy(floorSurface.normal);
      const gap = position.y - floorSurface.height;
      const snap = velocity.y <= 0.5 && gap <= MOVEMENT.groundSnapDistance + 0.025;
      if (gap <= 0.015 || snap) {
        const correctionY = floorSurface.height - position.y;
        position.y = floorSurface.height;
        this.correction.y += correctionY;
        const intoSurface = velocity.dot(this.contactNormal);
        if (intoSurface < 0) velocity.addScaledVector(this.contactNormal, -intoSurface);
        // Grounding depends on separation from the contact plane, not world-Y
        // velocity. A skier climbing a ramp can have strong upward velocity
        // while still being exactly tangent to its riding surface.
        grounded = this.contactNormal.y >= MOVEMENT.maxSlopeCosine && intoSurface <= 1.2;
        contacts += 1;
      }
    }

    const capsuleMinimumY = position.y;
    const capsuleMaximumY = position.y + height;
    for (const collider of this.colliders) {
      const box = collider.box;
      if (capsuleMaximumY <= box.min.y || capsuleMinimumY >= box.max.y) continue;
      const minimumX = box.min.x - radius;
      const maximumX = box.max.x + radius;
      const minimumZ = box.min.z - radius;
      const maximumZ = box.max.z + radius;
      if (position.x <= minimumX || position.x >= maximumX || position.z <= minimumZ || position.z >= maximumZ) continue;
      let depth = position.x - minimumX;
      let normalX = -1;
      let normalZ = 0;
      const positiveXDepth = maximumX - position.x;
      if (positiveXDepth < depth) {
        depth = positiveXDepth;
        normalX = 1;
      }
      const negativeZDepth = position.z - minimumZ;
      if (negativeZDepth < depth) {
        depth = negativeZDepth;
        normalX = 0;
        normalZ = -1;
      }
      const positiveZDepth = maximumZ - position.z;
      if (positiveZDepth < depth) {
        depth = positiveZDepth;
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
      this.bestWallNormal.set(normalX, 0, normalZ);
      wallContact = true;
      contacts += 1;
    }

    for (const ramp of this.rampSurfaces) {
      const rampHit = this.rampSolidContact(ramp, position, radius, height);
      if (!rampHit) continue;
      position.addScaledVector(rampHit.normal, rampHit.depth + 0.001);
      this.correction.addScaledVector(rampHit.normal, rampHit.depth + 0.001);
      const intoSurface = velocity.dot(rampHit.normal);
      if (intoSurface < 0) velocity.addScaledVector(rampHit.normal, -intoSurface);
      this.bestWallNormal.copy(rampHit.normal);
      wallContact = true;
      contacts += 1;
    }

    const result = this.capsuleContacts[this.capsuleContactCursor];
    this.capsuleContactCursor = (this.capsuleContactCursor + 1) % this.capsuleContacts.length;
    result.grounded = grounded;
    result.contactNormal.copy(this.contactNormal);
    result.wallContact = wallContact;
    result.wallNormal.copy(this.bestWallNormal);
    result.correction.copy(this.correction);
    result.contacts = contacts;
    return result;
  }

  private rampSolidContact(
    ramp: RampSurface,
    position: THREE.Vector3,
    radius: number,
    height: number,
  ): { normal: THREE.Vector3; depth: number } | null {
    const dx = position.x - ramp.spec.origin.x;
    const dz = position.z - ramp.spec.origin.z;
    const sine = Math.sin(ramp.spec.heading);
    const cosine = Math.cos(ramp.spec.heading);
    const longitudinal = dx * sine + dz * cosine;
    const lateral = dx * cosine - dz * sine;
    const halfWidth = ramp.spec.width * 0.5;
    if (
      longitudinal <= -radius
      || longitudinal >= ramp.spec.length + radius
      || lateral <= -halfWidth - radius
      || lateral >= halfWidth + radius
    ) return null;

    const u = THREE.MathUtils.clamp(longitudinal / ramp.spec.length, 0, 1);
    const surfaceY = ramp.spec.origin.y
      + ramp.spec.rise * Math.pow(u, ramp.spec.curveExponent ?? 1.8);
    const bottomY = ramp.spec.origin.y - (ramp.spec.skirtDepth ?? 0.8);
    const capsuleTop = position.y + height;
    if (capsuleTop <= bottomY + 0.01 || position.y >= surfaceY - 0.015) return null;

    // Only the low, longitudinal mouth is a walkable step. Treating every
    // shallow point as an entry lets a capsule climb straight through the
    // visible side skirt one physics substep at a time.
    const entryDepth = Math.max(radius + 0.35, ramp.spec.length * 0.08);
    if (
      longitudinal <= entryDepth
      && Math.abs(lateral) <= halfWidth
      && surfaceY - position.y
        <= Math.max(MOVEMENT.stepHeight + 0.04, MOVEMENT.groundSnapDistance + 0.14)
    ) return null;

    let depth = longitudinal + radius;
    let normalX = -sine;
    let normalZ = -cosine;
    const exitDepth = ramp.spec.length + radius - longitudinal;
    if (exitDepth < depth) {
      depth = exitDepth;
      normalX = sine;
      normalZ = cosine;
    }
    const leftDepth = lateral + halfWidth + radius;
    if (leftDepth < depth) {
      depth = leftDepth;
      normalX = -cosine;
      normalZ = sine;
    }
    const rightDepth = halfWidth + radius - lateral;
    if (rightDepth < depth) {
      depth = rightDepth;
      normalX = cosine;
      normalZ = -sine;
    }
    this.rampContactNormal.set(normalX, 0, normalZ);
    this.rampContact.depth = depth;
    return this.rampContact;
  }

  floorHeightAt(x: number, z: number, fromY = 96): number | null {
    return this.floorSurfaceAt(x, z, fromY)?.height ?? null;
  }

  private floorSurfaceAt(
    x: number,
    z: number,
    fromY: number,
  ): { height: number; normal: THREE.Vector3 } | null {
    if (Math.abs(x) > MONSOON_DIVIDE.width * 0.5 || Math.abs(z) > MONSOON_DIVIDE.depth * 0.5) return null;
    let hasSurface = false;
    let highestHeight = Number.NEGATIVE_INFINITY;
    const terrainHeight = sampleMonsoonHeight(x, z, this.seed);
    if (terrainHeight <= fromY + 0.04) {
      hasSurface = true;
      highestHeight = terrainHeight;
      sampleMonsoonNormal(x, z, this.floorSurfaceNormal, this.seed);
    }
    for (const platform of this.platformSurfaces) {
      if (x < platform.minX || x > platform.maxX || z < platform.minZ || z > platform.maxZ) continue;
      if (platform.y <= fromY + 0.04 && (!hasSurface || platform.y > highestHeight)) {
        hasSurface = true;
        highestHeight = platform.y;
        this.floorSurfaceNormal.set(0, 1, 0);
      }
    }
    for (const ramp of this.rampSurfaces) {
      const rampHeight = ramp.flow.heightAt(x, z);
      if (rampHeight !== null && rampHeight <= fromY + 0.04 && (!hasSurface || rampHeight > highestHeight)) {
        hasSurface = true;
        highestHeight = rampHeight;
        if (ramp.flow.normalAt(x, z, this.floorSurfaceNormal) === null) this.floorSurfaceNormal.set(0, 1, 0);
      }
    }
    if (!hasSurface) return null;
    this.floorSurface.height = highestHeight;
    return this.floorSurface;
  }

  segmentHitDetails(start: THREE.Vector3, end: THREE.Vector3): SurfaceHit | null {
    const direction = this.rayDirection.copy(end).sub(start);
    const distance = direction.length();
    if (distance < 1e-6) return null;
    direction.multiplyScalar(1 / distance);
    const ray = this.collisionRay.set(start, direction);
    const hit = this.boundsTree.raycastFirst(ray, THREE.DoubleSide, 0, distance);
    if (!hit) return null;
    const normal = hit.face?.normal
      ? this.rayHitNormal.copy(hit.face.normal)
      : sampleMonsoonNormal(hit.point.x, hit.point.z, this.rayHitNormal, this.seed);
    if (normal.dot(direction) > 0) normal.negate();
    const masks = sampleMonsoonMasks(hit.point.x, hit.point.z);
    const surface: SurfaceHit['surface'] = this.isConcretePoint(hit.point)
      ? 'concrete'
      : hit.point.y <= MONSOON_DIVIDE.waterY + 0.2
      ? 'water'
      : normal.y < 0.62 ? 'rock' : masks.route > 0.24 ? 'soil' : 'grass';
    const result = this.surfaceHit;
    result.point.copy(hit.point);
    result.normal.copy(normal);
    result.distance = hit.distance;
    result.surface = surface;
    return result;
  }

  surfaceAt(x: number, z: number, fromY = Number.POSITIVE_INFINITY): ArenaSurface {
    const floor = this.floorSurfaceAt(x, z, fromY);
    if (!floor || floor.height <= MONSOON_DIVIDE.waterY + 0.2) return 'water';
    const point = new THREE.Vector3(x, floor.height, z);
    if (this.isConcretePoint(point)) return 'concrete';
    if (floor.normal.y < 0.62) return 'rock';
    return sampleMonsoonMasks(x, z).route > 0.24 ? 'soil' : 'grass';
  }

  addFootTrack(position: THREE.Vector3, movement: THREE.Vector3, elapsed: number): void {
    if (!this.footprintMesh || this.surfaceAt(position.x, position.z, position.y + 0.3) !== 'soil') return;
    const floor = this.floorSurfaceAt(position.x, position.z, position.y + 0.3);
    if (!floor) return;
    const forward = new THREE.Vector3(movement.x, 0, movement.z);
    if (forward.lengthSq() < 0.04) return;
    forward.normalize();
    const side = new THREE.Vector3(-forward.z, 0, forward.x).multiplyScalar(this.footprintSide * 0.17);
    this.footprintSide *= -1;
    this.footprints[this.footprintCursor] = {
      position: new THREE.Vector3(position.x, floor.height, position.z).add(side),
      normal: floor.normal.clone(),
      forward,
      bornAt: elapsed,
      size: 1,
    };
    this.footprintCursor = (this.footprintCursor + 1) % this.footprints.length;
    this.groundMarksActive = true;
    this.groundMarksDirty = true;
  }

  registerSurfaceImpact(
    point: THREE.Vector3,
    normal: THREE.Vector3,
    strength: number,
    elapsed: number,
  ): void {
    if (!this.crackMesh || !this.isConcretePoint(point)) return;
    const forward = Math.abs(normal.y) < 0.86
      ? new THREE.Vector3(0, 1, 0).cross(normal).normalize()
      : new THREE.Vector3(0, 0, 1);
    this.cracks[this.crackCursor] = {
      position: point.clone().addScaledVector(normal, 0.018),
      normal: normal.clone().normalize(),
      forward,
      bornAt: elapsed,
      size: THREE.MathUtils.clamp(0.52 + strength * 0.015, 0.55, 1.8),
    };
    this.crackCursor = (this.crackCursor + 1) % this.cracks.length;
    this.groundMarksActive = true;
    this.groundMarksDirty = true;
  }

  segmentHit(start: THREE.Vector3, end: THREE.Vector3): THREE.Vector3 | null {
    return this.segmentHitDetails(start, end)?.point ?? null;
  }

  private isConcretePoint(point: THREE.Vector3): boolean {
    for (const box of this.concreteBoxes) {
      if (
        point.x >= box.min.x - 0.22 && point.x <= box.max.x + 0.22
        && point.y >= box.min.y - 0.22 && point.y <= box.max.y + 0.22
        && point.z >= box.min.z - 0.22 && point.z <= box.max.z + 0.22
      ) return true;
    }
    for (const ramp of this.rampSurfaces) {
      const height = this.rampHeightAt(ramp, point.x, point.z);
      if (height !== null && Math.abs(point.y - height) <= 0.35) return true;
    }
    for (const platform of this.platformSurfaces) {
      if (
        point.x >= platform.minX - 0.2 && point.x <= platform.maxX + 0.2
        && point.z >= platform.minZ - 0.2 && point.z <= platform.maxZ + 0.2
        && Math.abs(point.y - platform.y) <= 0.35
      ) return true;
    }
    return false;
  }

  private isConcreteFootprint(x: number, z: number): boolean {
    for (const box of this.concreteBoxes) {
      if (x >= box.min.x - 0.45 && x <= box.max.x + 0.45 && z >= box.min.z - 0.45 && z <= box.max.z + 0.45) return true;
    }
    for (const ramp of this.rampSurfaces) {
      if (this.rampHeightAt(ramp, x, z) !== null) return true;
    }
    return this.platformSurfaces.some((platform) => (
      x >= platform.minX - 0.45 && x <= platform.maxX + 0.45
      && z >= platform.minZ - 0.45 && z <= platform.maxZ + 0.45
    ));
  }

  hasLineOfSight(start: THREE.Vector3, end: THREE.Vector3, endTolerance = 0.12): boolean {
    const hit = this.segmentHit(start, end);
    return hit === null || hit.distanceToSquared(end) <= endTolerance * endTolerance;
  }

  /**
   * Reseat and validate an authored spawn against the generated terrain.
   * Spawn data is X/Z intent, not a guarantee that the generated seed left a
   * capsule on walkable ground or outside a gameplay prop.
   */
  safeSpawnPoint(candidate: THREE.Vector3, radius = MOVEMENT.playerRadius, height = MOVEMENT.playerHeight): THREE.Vector3 | null {
    const floor = this.floorHeightAt(candidate.x, candidate.z, Number.POSITIVE_INFINITY);
    if (floor === null || floor <= MONSOON_DIVIDE.waterY + 0.8) return null;
    const normal = sampleMonsoonNormal(candidate.x, candidate.z, new THREE.Vector3(), this.seed);
    if (normal.y < MOVEMENT.maxSlopeCosine + 0.06) return null;

    // Make sure the entire footprint has terrain underneath it. This rejects
    // cliff lips where the center ray is valid but a capsule would immediately
    // slide or fall after deployment.
    for (let index = 0; index < 8; index += 1) {
      const angle = index / 8 * Math.PI * 2;
      const x = candidate.x + Math.cos(angle) * (radius + 0.12);
      const z = candidate.z + Math.sin(angle) * (radius + 0.12);
      const sample = this.floorHeightAt(x, z, Number.POSITIVE_INFINITY);
      if (sample === null || sample <= MONSOON_DIVIDE.waterY + 0.6 || Math.abs(sample - floor) > 0.72) return null;
    }

    const seated = new THREE.Vector3(candidate.x, floor, candidate.z);
    const capsuleBox = new THREE.Box3(
      new THREE.Vector3(seated.x - radius, seated.y + 0.02, seated.z - radius),
      new THREE.Vector3(seated.x + radius, seated.y + height, seated.z + radius),
    );
    if (this.colliders.some((collider) => collider.box.intersectsBox(capsuleBox))) return null;
    const velocity = new THREE.Vector3(0, -0.1, 0);
    const contact = this.resolveCapsule(seated, velocity, radius, height);
    return contact.grounded && !contact.wallContact ? seated : null;
  }

  isTraversablePoint(candidate: THREE.Vector3, fromY = candidate.y + 4): boolean {
    const floor = this.floorHeightAt(candidate.x, candidate.z, fromY);
    if (floor === null || floor <= MONSOON_DIVIDE.waterY + 0.65) return false;
    const normal = sampleMonsoonNormal(candidate.x, candidate.z, new THREE.Vector3(), this.seed);
    return normal.y >= MOVEMENT.maxSlopeCosine;
  }

  dispose(): void {
    this.group.traverse((object) => {
      if ((object as THREE.SkinnedMesh).isSkinnedMesh) (object as THREE.SkinnedMesh).skeleton.dispose();
    });
    for (const ramp of this.rampSurfaces) ramp.flow.geometry.dispose();
    for (const geometry of new Set(this.geometries)) geometry.dispose();
    this.collisionGeometry.dispose();
    for (const material of new Set(this.materials)) material.dispose();
    for (const texture of new Set(this.textures)) texture.dispose();
  }

  private createTerrainTextureSet(): SurfaceTextureSet {
    const size = 256;
    const random = randomFactory(this.seed ^ 0x7e227a1d);
    const raw = new Float32Array(size * size);
    const smooth = new Float32Array(size * size);
    const sample = (source: Float32Array, x: number, y: number): number => (
      source[((y + size) % size) * size + ((x + size) % size)]
    );
    for (let index = 0; index < raw.length; index += 1) raw[index] = random();
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        let value = 0;
        for (let oy = -2; oy <= 2; oy += 1) {
          for (let ox = -2; ox <= 2; ox += 1) value += sample(raw, x + ox, y + oy);
        }
        smooth[y * size + x] = value / 25;
      }
    }

    const albedoData = new Uint8Array(size * size * 4);
    const normalData = new Uint8Array(size * size * 4);
    const roughnessData = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const pixel = y * size + x;
        const channel = pixel * 4;
        const broad = smooth[pixel] - 0.5;
        const grain = raw[pixel] - 0.5;
        const lichen = Math.max(0, sample(smooth, x + 7, y - 11) - 0.56);
        albedoData[channel] = THREE.MathUtils.clamp(205 + broad * 58 + grain * 18 - lichen * 42, 150, 238);
        albedoData[channel + 1] = THREE.MathUtils.clamp(211 + broad * 52 + grain * 14 + lichen * 16, 156, 242);
        albedoData[channel + 2] = THREE.MathUtils.clamp(210 + broad * 62 + grain * 12 - lichen * 8, 154, 242);
        albedoData[channel + 3] = 255;

        const dx = (sample(smooth, x - 1, y) - sample(smooth, x + 1, y)) * 2.4;
        const dy = (sample(smooth, x, y - 1) - sample(smooth, x, y + 1)) * 2.4;
        const inverseLength = 1 / Math.hypot(dx, dy, 1);
        normalData[channel] = (dx * inverseLength * 0.5 + 0.5) * 255;
        normalData[channel + 1] = (dy * inverseLength * 0.5 + 0.5) * 255;
        normalData[channel + 2] = inverseLength * 255;
        normalData[channel + 3] = 255;

        const roughness = THREE.MathUtils.clamp(222 + broad * 34 - grain * 12 + lichen * 80, 184, 252);
        roughnessData[channel] = roughness;
        roughnessData[channel + 1] = roughness;
        roughnessData[channel + 2] = roughness;
        roughnessData[channel + 3] = 255;
      }
    }

    const configure = (texture: THREE.DataTexture, name: string, colorSpace: THREE.ColorSpace): THREE.DataTexture => {
      texture.name = name;
      texture.colorSpace = colorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(42, 35);
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      texture.anisotropy = 8;
      texture.needsUpdate = true;
      this.textures.push(texture);
      return texture;
    };
    return {
      albedo: configure(
        new THREE.DataTexture(albedoData, size, size, THREE.RGBAFormat),
        'MonsoonStormTerrainAlbedo',
        THREE.SRGBColorSpace,
      ),
      normal: configure(
        new THREE.DataTexture(normalData, size, size, THREE.RGBAFormat),
        'MonsoonStormTerrainNormal',
        THREE.NoColorSpace,
      ),
      roughness: configure(
        new THREE.DataTexture(roughnessData, size, size, THREE.RGBAFormat),
        'MonsoonStormTerrainRoughness',
        THREE.NoColorSpace,
      ),
    };
  }

  private createToonRamp(): THREE.DataTexture {
    const texture = new THREE.DataTexture(
      new Uint8Array([76, 108, 146, 194, 244]),
      5,
      1,
      THREE.RedFormat,
    );
    texture.name = 'MonsoonFiveBandToonRamp';
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.NoColorSpace;
    texture.needsUpdate = true;
    this.textures.push(texture);
    return texture;
  }

  private positionOnlyGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', source.getAttribute('position').clone());
    return geometry;
  }

  private geometryFromBox(box: THREE.Box3): THREE.BufferGeometry {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const source = new THREE.BoxGeometry(size.x, size.y, size.z).toNonIndexed();
    source.translate(center.x, center.y, center.z);
    const geometry = this.positionOnlyGeometry(source);
    source.dispose();
    return geometry;
  }

  private registerGameplayColliders(): void {
    const add = (name: string, x: number, z: number, halfX: number, height: number, halfZ: number): void => {
      const y = sampleMonsoonHeight(x, z, this.seed);
      this.colliders.push({
        name,
        box: new THREE.Box3(
          new THREE.Vector3(x - halfX, y, z - halfZ),
          new THREE.Vector3(x + halfX, y + height, z + halfZ),
        ),
      });
    };
    add('flux-core', 0, 0, 4.45, 8.5, 4.45);
    add('purple-tower', -166, 91, 4.05, 10, 4.05);
    add('amber-tower', -148, -112, 4.05, 9, 4.05);
    add('lime-tower', 158, 78, 4.05, 9, 4.05);
    for (let index = 0; index < GATE_XZ.length; index += 1) {
      const [x, z] = GATE_XZ[index];
      const towardCore = new THREE.Vector2(-x, -z).normalize();
      const cross = new THREE.Vector2(towardCore.y, -towardCore.x);
      for (const side of [-1, 1]) {
        add(
          `gate-${index}-pillar-${side}`,
          x + cross.x * ROUTE_GATE_HALF_WIDTH * side,
          z + cross.y * ROUTE_GATE_HALF_WIDTH * side,
          0.72,
          5.9,
          0.72,
        );
      }
    }
  }

  private registerRockField(): void {
    const random = randomFactory(this.seed ^ 0x71a55eed);
    const findPlacement = (): THREE.Vector3 => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const x = (random() - 0.5) * 430;
        const z = (random() - 0.5) * 350;
        const y = sampleMonsoonHeight(x, z, this.seed);
        const masks = sampleMonsoonMasks(x, z);
        if (
          y > MONSOON_DIVIDE.waterY + 2.4 && masks.route < 0.46 && masks.crater < 0.62
          && !this.isConcreteFootprint(x, z)
        ) {
          return new THREE.Vector3(x, y, z);
        }
      }
      return new THREE.Vector3(0, -100, 0);
    };
    for (let index = 0; index < 240; index += 1) {
      const base = findPlacement();
      const quaternion = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(random() * 0.45, random() * Math.PI, random() * 0.35),
      );
      const size = 0.38 + random() * 1.38;
      const scale = new THREE.Vector3(
        size,
        size * (0.55 + random() * 0.8),
        size * (0.7 + random() * 0.65),
      );
      const position = base.clone().add(new THREE.Vector3(0, size * 0.35, 0));
      this.scatteredRocks.push({ position, quaternion, scale });
      if (base.y < -50 || size < 0.62) continue;
      const halfX = Math.max(0.22, scale.x * 0.42);
      const halfZ = Math.max(0.22, scale.z * 0.42);
      this.colliders.push({
        name: `faceted-rock-${index}`,
        box: new THREE.Box3(
          new THREE.Vector3(position.x - halfX, base.y, position.z - halfZ),
          new THREE.Vector3(position.x + halfX, base.y + Math.max(0.48, scale.y * 0.82), position.z + halfZ),
        ),
      });
    }
  }

  private registerConcreteTraversal(): void {
    const addRamp = (
      name: string,
      startX: number,
      startZ: number,
      endX: number,
      endZ: number,
      width: number,
      rise: number,
      startY?: number,
      endY?: number,
    ): void => {
      const dx = endX - startX;
      const dz = endZ - startZ;
      const length = Math.hypot(dx, dz);
      const yaw = Math.atan2(dx, dz);
      const crossX = Math.cos(yaw);
      const crossZ = -Math.sin(yaw);
      const embeddedStartY = Math.min(
        sampleMonsoonHeight(startX, startZ, this.seed),
        sampleMonsoonHeight(startX + crossX * width * 0.46, startZ + crossZ * width * 0.46, this.seed),
        sampleMonsoonHeight(startX - crossX * width * 0.46, startZ - crossZ * width * 0.46, this.seed),
      ) - 0.025;
      const resolvedStartY = startY ?? embeddedStartY;
      const resolvedRise = endY === undefined ? rise : endY - resolvedStartY;
      let lowestSupportY = resolvedStartY;
      for (let alongIndex = 0; alongIndex <= 18; alongIndex += 1) {
        const along = alongIndex / 18;
        for (const across of [-0.48, 0, 0.48]) {
          const x = THREE.MathUtils.lerp(startX, endX, along) + crossX * width * across;
          const z = THREE.MathUtils.lerp(startZ, endZ, along) + crossZ * width * across;
          lowestSupportY = Math.min(lowestSupportY, sampleMonsoonHeight(x, z, this.seed));
        }
      }
      const spec: LaunchRampSpec = {
        origin: { x: startX, y: resolvedStartY, z: startZ },
        heading: yaw,
        length,
        width,
        rise: resolvedRise,
        curveExponent: 1.72,
        longitudinalSegments: 18,
        lateralSegments: 6,
        solid: true,
        // Ground the closed wedge beneath the lowest center/edge terrain
        // sample. The rendered skirt and analytic collider share this value,
        // eliminating the walk-through void that a shallow floating slab left
        // below long downhill ramps.
        skirtDepth: Math.max(0.62, resolvedStartY - lowestSupportY + 0.18),
      };
      this.rampSurfaces.push({
        name,
        centerX: (startX + endX) * 0.5,
        centerZ: (startZ + endZ) * 0.5,
        startY: resolvedStartY,
        length,
        width,
        rise: resolvedRise,
        yaw,
        spec,
        flow: buildLaunchRamp(spec),
      });
    };
    const addConcreteBox = (name: string, box: THREE.Box3): void => {
      this.concreteBoxes.push(box);
      // Every opaque structural volume gets a matching player collider. Top
      // faces are still handled by platform sampling, while this proxy makes
      // slab edges, roof fascias, and walls solid from the side.
      this.colliders.push({ name, box });
    };
    const addPlatform = (name: string, box: THREE.Box3): void => {
      this.platformSurfaces.push({
        name,
        minX: box.min.x,
        maxX: box.max.x,
        minZ: box.min.z,
        maxZ: box.max.z,
        y: box.max.y,
      });
    };
    const makeBox = (x: number, y: number, z: number, width: number, height: number, depth: number): THREE.Box3 => (
      new THREE.Box3(
        new THREE.Vector3(x - width * 0.5, y - height * 0.5, z - depth * 0.5),
        new THREE.Vector3(x + width * 0.5, y + height * 0.5, z + depth * 0.5),
      )
    );
    const addBuilding = (
      name: string,
      centerX: number,
      centerZ: number,
      openSide: 'east' | 'west',
    ): void => {
      const width = 25;
      const depth = 18;
      const height = 7.6;
      const cornerHeights = [
        sampleMonsoonHeight(centerX - width * 0.5, centerZ - depth * 0.5, this.seed),
        sampleMonsoonHeight(centerX + width * 0.5, centerZ - depth * 0.5, this.seed),
        sampleMonsoonHeight(centerX - width * 0.5, centerZ + depth * 0.5, this.seed),
        sampleMonsoonHeight(centerX + width * 0.5, centerZ + depth * 0.5, this.seed),
        sampleMonsoonHeight(centerX - width * 0.5, centerZ, this.seed),
        sampleMonsoonHeight(centerX + width * 0.5, centerZ, this.seed),
        sampleMonsoonHeight(centerX, centerZ - depth * 0.5, this.seed),
        sampleMonsoonHeight(centerX, centerZ + depth * 0.5, this.seed),
        sampleMonsoonHeight(centerX, centerZ, this.seed),
      ];
      const baseY = Math.max(...cornerHeights) + 0.18;
      const floor = makeBox(centerX, baseY, centerZ, width, 0.46, depth);
      const roof = makeBox(centerX, baseY + height, centerZ, width, 0.62, depth);
      addConcreteBox(`${name}-floor`, floor);
      addConcreteBox(`${name}-roof`, roof);
      addPlatform(`${name}-floor`, floor);
      addPlatform(`${name}-roof`, roof);

      // The playable floor is leveled to the highest corner. Fill the downhill
      // void with a collision-backed retaining podium so the bunker reads as
      // excavated into the mountain instead of floating above it.
      const foundationBottomY = Math.min(...cornerHeights) - 0.34;
      const foundationTopY = floor.min.y + 0.025;
      if (foundationTopY > foundationBottomY + 0.18) {
        addConcreteBox(
          `${name}-terrain-foundation`,
          makeBox(
            centerX,
            (foundationBottomY + foundationTopY) * 0.5,
            centerZ,
            width - 0.5,
            foundationTopY - foundationBottomY,
            depth - 0.5,
          ),
        );
      }

      const backX = centerX + (openSide === 'east' ? -width * 0.5 : width * 0.5);
      addConcreteBox(`${name}-back`, makeBox(backX, baseY + height * 0.5, centerZ, 1.1, height, depth));
      addConcreteBox(`${name}-north`, makeBox(centerX, baseY + height * 0.5, centerZ - depth * 0.5, width, height, 1.1));
      addConcreteBox(`${name}-south`, makeBox(centerX, baseY + height * 0.5, centerZ + depth * 0.5, width, height, 1.1));

      const entranceX = centerX + (openSide === 'east' ? width * 0.5 : -width * 0.5);
      const openingWidth = 7.2;
      const wingDepth = (depth - openingWidth) * 0.5;
      for (const side of [-1, 1]) {
        addConcreteBox(
          `${name}-entrance-wing-${side}`,
          makeBox(
            entranceX,
            baseY + height * 0.5,
            centerZ + side * (openingWidth * 0.5 + wingDepth * 0.5),
            1.1,
            height,
            wingDepth,
          ),
        );
      }

      const parapetY = roof.max.y + 0.38;
      addConcreteBox(`${name}-roof-back-parapet`, makeBox(backX, parapetY, centerZ, 0.72, 0.76, depth));
      addConcreteBox(`${name}-roof-north-parapet`, makeBox(centerX, parapetY, centerZ - depth * 0.5, width, 0.76, 0.72));
      addConcreteBox(`${name}-roof-south-parapet`, makeBox(centerX, parapetY, centerZ + depth * 0.5, width, 0.76, 0.72));

      const serviceX = centerX + (openSide === 'east' ? -5.2 : 5.2);
      const serviceCabin = makeBox(serviceX, roof.max.y + 1.25, centerZ - 1.2, 7.2, 2.5, 6.4);
      addConcreteBox(`${name}-roof-service-cabin`, serviceCabin);
      addPlatform(`${name}-roof-service-cabin`, serviceCabin);

      const outward = openSide === 'east' ? 1 : -1;
      const approachX = entranceX + outward * 32;
      const landingX = entranceX - outward * 1.8;
      addRamp(
        `${name}-roof-access`,
        approachX,
        centerZ + depth * 0.28,
        landingX,
        centerZ + depth * 0.28,
        16,
        0,
        undefined,
        roof.max.y + 0.025,
      );
    };

    // Six wide launch ramps cross the main valleys. Their low ends meet the
    // terrain and their raised lips create predictable race jumps at speed.
    addRamp('west-core-launch', -119, 58, -88, 39, 13, 7.2);
    addRamp('east-core-launch', 121, 53, 90, 37, 13, 7.4);
    addRamp('southwest-launch', -118, -82, -84, -58, 14, 8.2);
    addRamp('southeast-launch', 119, -86, 84, -60, 14, 8.4);
    addRamp('north-divide-launch', 0, 127, 0, 94, 16, 8.8);
    addRamp('south-divide-launch', 0, -137, 0, -102, 16, 9.2);

    addBuilding('west-relay-bunker', -132, 111, 'east');
    addBuilding('east-weather-station', 132, 96, 'west');

    // A broad two-way underpass adds a real interior route without breaking
    // the north/south ski line; the roof is another playable platform.
    const tunnelX = 42;
    const tunnelZ = -96;
    const tunnelWidth = 30;
    const tunnelDepth = 32;
    const tunnelBase = Math.max(
      sampleMonsoonHeight(tunnelX - 10, tunnelZ, this.seed),
      sampleMonsoonHeight(tunnelX + 10, tunnelZ, this.seed),
    ) + 0.2;
    const tunnelFloor = makeBox(tunnelX, tunnelBase, tunnelZ, tunnelWidth, 0.44, tunnelDepth);
    const tunnelRoof = makeBox(tunnelX, tunnelBase + 7.2, tunnelZ, tunnelWidth, 0.62, tunnelDepth);
    addConcreteBox('south-underpass-floor', tunnelFloor);
    addConcreteBox('south-underpass-roof', tunnelRoof);
    addPlatform('south-underpass-floor', tunnelFloor);
    addPlatform('south-underpass-roof', tunnelRoof);
    const tunnelFoundationBottom = Math.min(
      sampleMonsoonHeight(tunnelX - tunnelWidth * 0.5, tunnelZ - tunnelDepth * 0.5, this.seed),
      sampleMonsoonHeight(tunnelX + tunnelWidth * 0.5, tunnelZ - tunnelDepth * 0.5, this.seed),
      sampleMonsoonHeight(tunnelX - tunnelWidth * 0.5, tunnelZ + tunnelDepth * 0.5, this.seed),
      sampleMonsoonHeight(tunnelX + tunnelWidth * 0.5, tunnelZ + tunnelDepth * 0.5, this.seed),
      sampleMonsoonHeight(tunnelX, tunnelZ, this.seed),
    ) - 0.34;
    const tunnelFoundationTop = tunnelFloor.min.y + 0.025;
    if (tunnelFoundationTop > tunnelFoundationBottom + 0.18) {
      addConcreteBox(
        'south-underpass-terrain-foundation',
        makeBox(
          tunnelX,
          (tunnelFoundationBottom + tunnelFoundationTop) * 0.5,
          tunnelZ,
          tunnelWidth - 0.5,
          tunnelFoundationTop - tunnelFoundationBottom,
          tunnelDepth - 0.5,
        ),
      );
    }
    addConcreteBox('south-underpass-west-wall', makeBox(tunnelX - tunnelWidth * 0.5, tunnelBase + 3.6, tunnelZ, 1.1, 7.2, tunnelDepth));
    addConcreteBox('south-underpass-east-wall', makeBox(tunnelX + tunnelWidth * 0.5, tunnelBase + 3.6, tunnelZ, 1.1, 7.2, tunnelDepth));
    addConcreteBox('south-underpass-roof-west-parapet', makeBox(tunnelX - tunnelWidth * 0.5, tunnelRoof.max.y + 0.4, tunnelZ, 0.72, 0.8, tunnelDepth));
    addConcreteBox('south-underpass-roof-north-parapet', makeBox(tunnelX, tunnelRoof.max.y + 0.4, tunnelZ - tunnelDepth * 0.5, tunnelWidth, 0.8, 0.72));
    addConcreteBox('south-underpass-roof-south-parapet', makeBox(tunnelX, tunnelRoof.max.y + 0.4, tunnelZ + tunnelDepth * 0.5, tunnelWidth, 0.8, 0.72));
    addRamp(
      'south-underpass-roof-access',
      tunnelX + tunnelWidth * 0.5 + 30,
      tunnelZ + 8,
      tunnelX + tunnelWidth * 0.5 - 1.8,
      tunnelZ + 8,
      16,
      0,
      undefined,
      tunnelRoof.max.y + 0.025,
    );
  }

  private rampHeightAt(ramp: RampSurface, x: number, z: number): number | null {
    return ramp.flow.heightAt(x, z);
  }

  private createConcreteTraversal(_toonRamp: THREE.Texture): void {
    const texture = this.createConcreteTexture();
    const concrete = new THREE.MeshStandardMaterial({
      color: 0x9aabad,
      map: texture,
      roughness: 0.88,
      metalness: 0.07,
    });
    const routeApron = new THREE.MeshStandardMaterial({
      color: 0x617579,
      map: texture,
      roughness: 0.96,
      metalness: 0.025,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const signal = new THREE.MeshStandardMaterial({
      color: 0x5bc9d2,
      emissive: 0x16899a,
      emissiveIntensity: 1.35,
      roughness: 0.3,
      metalness: 0.42,
    });
    const structuralDark = new THREE.MeshStandardMaterial({
      color: 0x13232b,
      roughness: 0.64,
      metalness: 0.48,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.materials.push(concrete, routeApron, signal, structuralDark);

    const boxGeometry = new RoundedBoxGeometry(1, 1, 1, 1, 0.075);
    this.geometries.push(boxGeometry);
    const boxes = new THREE.InstancedMesh(boxGeometry, concrete, this.concreteBoxes.length);
    boxes.name = 'MonsoonEnterableConcreteStructures';
    const matrix = new THREE.Matrix4();
    const identity = new THREE.Quaternion();
    this.concreteBoxes.forEach((box, index) => {
      matrix.compose(box.getCenter(new THREE.Vector3()), identity, box.getSize(new THREE.Vector3()));
      boxes.setMatrixAt(index, matrix);
    });
    boxes.instanceMatrix.needsUpdate = true;
    boxes.castShadow = true;
    boxes.receiveShadow = true;

    const rampParts = this.rampSurfaces.map((ramp) => ramp.flow.geometry);
    const rampGeometry = mergeGeometries(rampParts, false);
    if (!rampGeometry) throw new Error('Failed to merge Monsoon concrete traversal ramps.');
    this.geometries.push(rampGeometry);
    const ramps = new THREE.Mesh(rampGeometry, concrete);
    ramps.name = 'MonsoonConcreteSkiLaunchRamps';
    ramps.castShadow = true;
    ramps.receiveShadow = true;

    const apronParts: THREE.BufferGeometry[] = [];
    for (const ramp of this.rampSurfaces) {
      // Terrain launches already emerge from an edge-sampled buried entry and
      // land back on the authored dirt route. A surface ribbon there reads as
      // exposed grey collision geometry on the low-poly ground. Structural
      // roof ramps still use aprons to explain their facility connection.
      if (!ramp.name.includes('roof-access')) continue;
      const forwardX = Math.sin(ramp.yaw);
      const forwardZ = Math.cos(ramp.yaw);
      const start = ramp.spec.origin;
      const endX = start.x + forwardX * ramp.length;
      const endZ = start.z + forwardZ * ramp.length;
      apronParts.push(buildTerrainRibbonGeometry({
        start: { x: start.x - forwardX * 8.5, z: start.z - forwardZ * 8.5 },
        end: { x: start.x + forwardX * 1.6, z: start.z + forwardZ * 1.6 },
        startWidth: ramp.width + 5.2,
        endWidth: ramp.width + 0.8,
        longitudinalSegments: 12,
        lateralSegments: 5,
        heightAt: (x, z) => sampleMonsoonMeshHeight(x, z, this.seed),
        lift: 0.045,
      }));
      apronParts.push(buildTerrainRibbonGeometry({
        start: { x: endX + forwardX * 5.5, z: endZ + forwardZ * 5.5 },
        end: { x: endX + forwardX * 20, z: endZ + forwardZ * 20 },
        startWidth: ramp.width + 1.2,
        endWidth: ramp.width + 7.5,
        longitudinalSegments: 12,
        lateralSegments: 5,
        heightAt: (x, z) => sampleMonsoonMeshHeight(x, z, this.seed),
        lift: 0.045,
      }));
    }
    const apronGeometry = mergeGeometries(apronParts, false);
    for (const part of apronParts) part.dispose();
    if (!apronGeometry) throw new Error('Failed to merge Monsoon terrain transition aprons.');
    this.geometries.push(apronGeometry);
    const aprons = new THREE.Mesh(apronGeometry, routeApron);
    aprons.name = 'MonsoonEmbeddedRampApproachAndLandingAprons';
    aprons.receiveShadow = true;

    const signGeometry = new THREE.BoxGeometry(5.4, 0.18, 0.16);
    this.geometries.push(signGeometry);
    const signs = new THREE.InstancedMesh(signGeometry, signal, 3);
    const signPositions = [
      new THREE.Vector3(-119.5, sampleMonsoonHeight(-132, 111, this.seed) + 7.1, 102),
      new THREE.Vector3(119.5, sampleMonsoonHeight(132, 96, this.seed) + 7.1, 87),
      new THREE.Vector3(42, sampleMonsoonHeight(42, -96, this.seed) + 7.4, -109.8),
    ];
    signPositions.forEach((position, index) => {
      matrix.compose(position, identity, new THREE.Vector3(1, 1, 1));
      signs.setMatrixAt(index, matrix);
    });
    signs.instanceMatrix.needsUpdate = true;

    type DetailTransform = { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 };
    const concreteDetails: DetailTransform[] = [];
    const darkDetails: DetailTransform[] = [];
    const signalDetails: DetailTransform[] = [];
    const addDetail = (
      target: DetailTransform[],
      position: THREE.Vector3,
      scale: THREE.Vector3,
      quaternion = identity,
    ): void => {
      target.push({ position, scale, quaternion: quaternion.clone() });
    };
    const addBuildingDetails = (name: string, centerX: number, centerZ: number, entranceX: number): void => {
      const floor = this.platformSurfaces.find((platform) => platform.name === `${name}-floor`);
      const roof = this.platformSurfaces.find((platform) => platform.name === `${name}-roof`);
      if (!floor || !roof) return;
      const middleY = (floor.y + roof.y) * 0.5;
      const height = roof.y - floor.y;
      for (const side of [-1, 1]) {
        addDetail(darkDetails, new THREE.Vector3(entranceX, middleY, centerZ + side * 8.35), new THREE.Vector3(1.05, height, 0.72));
        addDetail(signalDetails, new THREE.Vector3(entranceX + Math.sign(entranceX) * 0.53, middleY, centerZ + side * 8.34), new THREE.Vector3(0.08, height * 0.72, 0.18));
      }
      addDetail(darkDetails, new THREE.Vector3(entranceX, roof.y - 0.34, centerZ), new THREE.Vector3(1.08, 0.7, 17.4));
      addDetail(signalDetails, new THREE.Vector3(entranceX + Math.sign(entranceX) * 0.56, roof.y - 0.37, centerZ), new THREE.Vector3(0.08, 0.16, 12.8));
      for (const side of [-1, 1]) {
        addDetail(darkDetails, new THREE.Vector3(centerX, roof.y + 0.24, centerZ + side * 8.86), new THREE.Vector3(25.8, 0.48, 0.42));
        addDetail(darkDetails, new THREE.Vector3(centerX + side * 12.86, roof.y + 0.24, centerZ), new THREE.Vector3(0.42, 0.48, 18.1));
      }
    };
    addBuildingDetails('west-relay-bunker', -132, 111, -119.5);
    addBuildingDetails('east-weather-station', 132, 96, 119.5);

    const addFoundationDetails = (colliderName: string): void => {
      const foundation = this.colliders.find((collider) => collider.name === colliderName)?.box;
      if (!foundation) return;
      const size = foundation.getSize(new THREE.Vector3());
      const center = foundation.getCenter(new THREE.Vector3());
      const ribHeight = Math.max(0.24, size.y - 0.34);
      for (const side of [-1, 1]) {
        const xFace = side < 0 ? foundation.min.x : foundation.max.x;
        const zFace = side < 0 ? foundation.min.z : foundation.max.z;
        for (const offset of [-0.31, 0, 0.31]) {
          addDetail(
            darkDetails,
            new THREE.Vector3(xFace, center.y, center.z + offset * size.z),
            new THREE.Vector3(0.09, ribHeight, Math.min(1.35, size.z * 0.13)),
          );
          addDetail(
            darkDetails,
            new THREE.Vector3(center.x + offset * size.x, center.y, zFace),
            new THREE.Vector3(Math.min(1.35, size.x * 0.13), ribHeight, 0.09),
          );
        }
        addDetail(
          darkDetails,
          new THREE.Vector3(xFace, foundation.max.y - 0.18, center.z),
          new THREE.Vector3(0.1, 0.24, size.z * 0.9),
        );
        addDetail(
          darkDetails,
          new THREE.Vector3(center.x, foundation.max.y - 0.18, zFace),
          new THREE.Vector3(size.x * 0.9, 0.24, 0.1),
        );
      }
    };
    addFoundationDetails('west-relay-bunker-terrain-foundation');
    addFoundationDetails('east-weather-station-terrain-foundation');
    addFoundationDetails('south-underpass-terrain-foundation');

    const tunnelFloor = this.platformSurfaces.find((platform) => platform.name === 'south-underpass-floor');
    const tunnelRoof = this.platformSurfaces.find((platform) => platform.name === 'south-underpass-roof');
    if (tunnelFloor && tunnelRoof) {
      const middleY = (tunnelFloor.y + tunnelRoof.y) * 0.5;
      for (const end of [-1, 1]) {
        for (const side of [-1, 1]) {
          addDetail(darkDetails, new THREE.Vector3(42 + side * 15.28, middleY, -96 + end * 15.9), new THREE.Vector3(0.7, tunnelRoof.y - tunnelFloor.y, 0.72));
          addDetail(signalDetails, new THREE.Vector3(42 + side * 14.84, middleY, -96 + end * 16.28), new THREE.Vector3(0.11, 4.8, 0.12));
        }
        addDetail(darkDetails, new THREE.Vector3(42, tunnelRoof.y - 0.3, -96 + end * 15.9), new THREE.Vector3(30.2, 0.62, 0.72));
      }
    }

    const rampDarkParts: THREE.BufferGeometry[] = [];
    const rampSignalParts: THREE.BufferGeometry[] = [];
    for (const ramp of this.rampSurfaces) {
      const lateral = new THREE.Vector3(Math.cos(ramp.yaw), 0, -Math.sin(ramp.yaw));
      const forward = new THREE.Vector3(Math.sin(ramp.yaw), 0, Math.cos(ramp.yaw));
      const bottomY = ramp.spec.origin.y - (ramp.spec.skirtDepth ?? 0.8);
      const rampRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ramp.yaw, 0));
      const mouthDistance = Math.min(1.25, ramp.length * 0.045);
      const mouthU = mouthDistance / ramp.length;
      const mouthTopY = ramp.spec.origin.y
        + ramp.spec.rise * Math.pow(mouthU, ramp.spec.curveExponent ?? 1.8);
      const toeTopY = mouthTopY + 0.035;
      const toeHeight = Math.max(0.48, toeTopY - bottomY);
      const mouthCenter = new THREE.Vector3(ramp.spec.origin.x, bottomY + toeHeight * 0.5, ramp.spec.origin.z)
        .addScaledVector(forward, mouthDistance);
      // Close the full ramp throat with a concrete toe whose bottom is buried
      // with the solid skirt. This makes the approach read as load-bearing
      // construction instead of a dark, traversable-looking undercut.
      addDetail(
        concreteDetails,
        mouthCenter,
        new THREE.Vector3(Math.max(2, ramp.width - 0.34), toeHeight, Math.min(1.4, ramp.length * 0.045)),
        rampRotation,
      );
      for (const side of [-1, 1]) {
        const cheekTopY = mouthTopY - 0.08;
        const cheekHeight = Math.max(0.42, cheekTopY - bottomY - 0.14);
        addDetail(
          darkDetails,
          new THREE.Vector3(ramp.spec.origin.x, bottomY + cheekHeight * 0.5 + 0.08, ramp.spec.origin.z)
            .addScaledVector(forward, Math.min(2.1, ramp.length * 0.075))
            .addScaledVector(lateral, side * (ramp.width * 0.5 - 0.38)),
          new THREE.Vector3(0.68, cheekHeight, Math.min(4.1, ramp.length * 0.13)),
          rampRotation,
        );
        const offset = lateral.clone().multiplyScalar(side * (ramp.width * 0.5 - 0.26));
        rampDarkParts.push(buildLaunchRamp({
          ...ramp.spec,
          origin: {
            x: ramp.spec.origin.x + offset.x,
            y: ramp.spec.origin.y + 0.1,
            z: ramp.spec.origin.z + offset.z,
          },
          width: 0.34,
          solid: false,
        }).geometry);
        for (const u of [0.18, 0.4, 0.62, 0.84]) {
          const topY = ramp.spec.origin.y
            + ramp.spec.rise * Math.pow(u, ramp.spec.curveExponent ?? 1.8);
          const panelHeight = Math.max(0.46, topY - bottomY - 0.38);
          const panelCenter = new THREE.Vector3(ramp.spec.origin.x, bottomY + panelHeight * 0.5 + 0.18, ramp.spec.origin.z)
            .addScaledVector(forward, ramp.length * u)
            .addScaledVector(lateral, side * (ramp.width * 0.5 + 0.055));
          addDetail(
            darkDetails,
            panelCenter,
            new THREE.Vector3(0.13, panelHeight, Math.max(1.4, ramp.length * 0.115)),
            rampRotation,
          );
          addDetail(
            signalDetails,
            panelCenter.clone().setY(topY - 0.22),
            new THREE.Vector3(0.16, 0.11, Math.max(0.9, ramp.length * 0.075)),
            rampRotation,
          );
        }
      }
      rampSignalParts.push(buildLaunchRamp({
        ...ramp.spec,
        origin: { ...ramp.spec.origin, y: ramp.spec.origin.y + 0.14 },
        width: 0.16,
        solid: false,
      }).geometry);
    }
    const buildDetails = (
      transforms: DetailTransform[],
      material: THREE.Material,
      name: string,
    ): THREE.InstancedMesh => {
      const mesh = new THREE.InstancedMesh(boxGeometry, material, transforms.length);
      mesh.name = name;
      transforms.forEach((transform, index) => {
        matrix.compose(transform.position, transform.quaternion, transform.scale);
        mesh.setMatrixAt(index, matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      return mesh;
    };
    const toes = buildDetails(concreteDetails, concrete, 'MonsoonRampBuriedConcreteToes');
    const trims = buildDetails(darkDetails, structuralDark, 'MonsoonConcreteStructuralTrims');
    const accents = buildDetails(signalDetails, signal, 'MonsoonConcreteNavigationAccents');
    const rampDarkGeometry = mergeGeometries(rampDarkParts, false);
    const rampSignalGeometry = mergeGeometries(rampSignalParts, false);
    for (const part of [...rampDarkParts, ...rampSignalParts]) part.dispose();
    if (!rampDarkGeometry || !rampSignalGeometry) throw new Error('Failed to merge Monsoon curved ramp accents.');
    this.geometries.push(rampDarkGeometry, rampSignalGeometry);
    const rampTrims = new THREE.Mesh(rampDarkGeometry, structuralDark);
    rampTrims.name = 'MonsoonCurvedRampEdgeGuides';
    const rampSignals = new THREE.Mesh(rampSignalGeometry, signal);
    rampSignals.name = 'MonsoonCurvedRampCenterGuides';
    this.group.add(aprons, boxes, ramps, signs, toes, trims, accents, rampTrims, rampSignals);
  }

  private createConcreteTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is required for Monsoon concrete synthesis.');
    context.fillStyle = '#687779';
    context.fillRect(0, 0, 512, 512);
    const random = randomFactory(this.seed ^ 0xc04c7e);
    for (let index = 0; index < 5_000; index += 1) {
      const value = 72 + Math.floor(random() * 86);
      context.fillStyle = `rgba(${value},${value + 7},${value + 9},${0.035 + random() * 0.075})`;
      const size = random() < 0.93 ? 1 : 2;
      context.fillRect(random() * 512, random() * 512, size, size);
    }
    for (let index = 0; index < 34; index += 1) {
      const startX = random() * 512;
      const startY = random() * 512;
      context.strokeStyle = `rgba(39,58,64,${0.045 + random() * 0.08})`;
      context.lineWidth = 0.45 + random() * 1.15;
      context.beginPath();
      context.moveTo(startX, startY);
      context.lineTo(startX + (random() - 0.5) * 34, startY + (random() - 0.5) * 22);
      context.lineTo(startX + (random() - 0.5) * 58, startY + (random() - 0.5) * 42);
      context.stroke();
    }
    for (let index = 0; index < 24; index += 1) {
      const x = random() * 512;
      const y = random() * 512;
      const radius = 10 + random() * 42;
      const stain = context.createRadialGradient(x, y, 0, x, y, radius);
      stain.addColorStop(0, `rgba(41,73,70,${0.035 + random() * 0.055})`);
      stain.addColorStop(1, 'rgba(41,73,70,0)');
      context.fillStyle = stain;
      context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
    context.strokeStyle = 'rgba(18,34,42,.62)';
    context.lineWidth = 5;
    context.strokeRect(3, 3, 506, 506);
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(256, 0);
    context.lineTo(256, 512);
    context.moveTo(0, 256);
    context.lineTo(512, 256);
    context.stroke();
    context.fillStyle = 'rgba(35,154,169,.28)';
    context.fillRect(18, 18, 476, 8);
    const texture = new THREE.CanvasTexture(canvas);
    texture.name = 'MonsoonProceduralConcreteAtlas';
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(2.5, 2.5);
    texture.anisotropy = 8;
    this.textures.push(texture);
    return texture;
  }

  private createOcean(): void {
    const geometry = new THREE.PlaneGeometry(1800, 1800, 72, 72);
    const material = new THREE.ShaderMaterial({
      name: 'MonsoonCelOcean',
      transparent: true,
      depthWrite: false,
      uniforms: this.waterUniforms,
      vertexShader: `
        uniform float uTime;
        varying float vWave;
        varying vec3 vWorld;
        void main() {
          vec3 p = position;
          float wave = sin(p.x * 0.026 + uTime * 0.55) * 0.34
            + sin(p.y * 0.038 - uTime * 0.42) * 0.22
            + sin((p.x + p.y) * 0.016 + uTime * 0.28) * 0.18;
          p.z += wave;
          vWave = wave;
          vec4 world = modelMatrix * vec4(p, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: `
        uniform vec3 uDeep;
        uniform vec3 uShallow;
        uniform vec3 uSun;
        varying float vWave;
        varying vec3 vWorld;
        void main() {
          float band = floor(clamp(vWave * 1.8 + 2.0, 0.0, 3.0)) / 3.0;
          float horizon = smoothstep(180.0, 720.0, length(vWorld.xz));
          vec3 color = mix(uDeep, uShallow, 0.34 + band * 0.38);
          color = mix(color, uSun, horizon * 0.12);
          gl_FragColor = vec4(color, 0.94);
        }
      `,
    });
    this.geometries.push(geometry);
    this.materials.push(material);
    const ocean = new THREE.Mesh(geometry, material);
    ocean.name = 'MonsoonOcean';
    ocean.rotation.x = -Math.PI * 0.5;
    ocean.position.y = MONSOON_DIVIDE.waterY;
    ocean.renderOrder = -1;
    ocean.receiveShadow = false;
    this.group.add(ocean);
  }

  private createDistantIslands(): void {
    const geometry = new THREE.ConeGeometry(1, 1, 7, 1);
    const material = new THREE.MeshToonMaterial({ color: 0x233d49 });
    this.geometries.push(geometry);
    this.materials.push(material);
    const count = 11;
    const islands = new THREE.InstancedMesh(geometry, material, count);
    islands.name = 'DistantIslandSilhouettes';
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const random = randomFactory(this.seed ^ 0xd157a17d);
    for (let index = 0; index < count; index += 1) {
      const angle = (index / count) * Math.PI * 2 + random() * 0.22;
      const radius = 560 + random() * 190;
      const position = new THREE.Vector3(
        Math.cos(angle) * radius,
        MONSOON_DIVIDE.waterY - 2 + random() * 4,
        Math.sin(angle) * radius,
      );
      quaternion.setFromEuler(new THREE.Euler(0, random() * Math.PI, 0));
      matrix.compose(position, quaternion, new THREE.Vector3(24 + random() * 30, 10 + random() * 19, 22 + random() * 34));
      islands.setMatrixAt(index, matrix);
    }
    islands.instanceMatrix.needsUpdate = true;
    this.group.add(islands);
  }

  private createRouteGates(_toonRamp: THREE.Texture): void {
    const geometry = new RoundedBoxGeometry(1, 1, 1, 1, 0.08);
    const white = new THREE.MeshStandardMaterial({ color: 0x41545b, roughness: 0.8, metalness: 0.13 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x101d24, roughness: 0.64, metalness: 0.48 });
    const signal = new THREE.MeshStandardMaterial({
      color: 0x55c1ca,
      emissive: 0x147f91,
      emissiveIntensity: 1.35,
      roughness: 0.3,
      metalness: 0.46,
    });
    this.geometries.push(geometry);
    this.materials.push(white, dark, signal);
    const frames = new THREE.InstancedMesh(geometry, white, GATE_XZ.length * 3);
    const insets = new THREE.InstancedMesh(geometry, dark, GATE_XZ.length * 2);
    const strips = new THREE.InstancedMesh(geometry, signal, GATE_XZ.length);
    const braces = new THREE.InstancedMesh(geometry, dark, GATE_XZ.length * 2);
    frames.name = 'MonsoonRouteGateFrames';
    insets.name = 'MonsoonRouteGateInsets';
    strips.name = 'MonsoonRouteGateSignals';
    braces.name = 'MonsoonRouteGateDiagonalBracing';
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    let frameIndex = 0;
    let insetIndex = 0;
    let braceIndex = 0;
    GATE_XZ.forEach(([x, z], gateIndex) => {
      const y = sampleMonsoonHeight(x, z, this.seed);
      const yaw = Math.atan2(-x, -z);
      quaternion.setFromEuler(new THREE.Euler(0, yaw, 0));
      const cross = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      for (const side of [-1, 1]) {
        const post = new THREE.Vector3(x, y + 2.8, z).addScaledVector(cross, side * ROUTE_GATE_HALF_WIDTH);
        matrix.compose(post, quaternion, new THREE.Vector3(0.82, 5.6, 1.05));
        frames.setMatrixAt(frameIndex++, matrix);
        matrix.compose(post.clone().addScaledVector(cross, -side * 0.08), quaternion, new THREE.Vector3(0.28, 3.8, 1.12));
        insets.setMatrixAt(insetIndex++, matrix);
      }
      matrix.compose(
        new THREE.Vector3(x, y + 5.58, z),
        quaternion,
        new THREE.Vector3(ROUTE_GATE_HALF_WIDTH * 2 + 0.8, 0.72, 1.05),
      );
      frames.setMatrixAt(frameIndex++, matrix);
      matrix.compose(
        new THREE.Vector3(x, y + 5.52, z),
        quaternion,
        new THREE.Vector3(ROUTE_GATE_HALF_WIDTH * 2 - 2.4, 0.12, 1.12),
      );
      strips.setMatrixAt(gateIndex, matrix);
      for (const side of [-1, 1]) {
        const bracePosition = new THREE.Vector3(x, y + 4.35, z)
          .addScaledVector(cross, side * (ROUTE_GATE_HALF_WIDTH - 1.38));
        const localBrace = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(0, yaw, side * -0.7),
        );
        matrix.compose(bracePosition, localBrace, new THREE.Vector3(0.34, 3.3, 0.68));
        braces.setMatrixAt(braceIndex++, matrix);
      }
    });
    frames.instanceMatrix.needsUpdate = true;
    insets.instanceMatrix.needsUpdate = true;
    strips.instanceMatrix.needsUpdate = true;
    braces.instanceMatrix.needsUpdate = true;
    frames.castShadow = true;
    braces.castShadow = true;
    this.group.add(frames, insets, strips, braces);
  }

  private createJumpPadVisuals(toonRamp: THREE.Texture): void {
    const baseGeometry = new THREE.CylinderGeometry(1.9, 2.25, 0.36, 12);
    const ringGeometry = new THREE.TorusGeometry(1.36, 0.14, 6, 24);
    const shell = new THREE.MeshToonMaterial({ color: 0x1b2d42, gradientMap: toonRamp });
    const energy = new THREE.MeshStandardMaterial({
      color: 0x9df6ff,
      emissive: 0x1bdcff,
      emissiveIntensity: 2.8,
      roughness: 0.14,
      metalness: 0.2,
    });
    this.geometries.push(baseGeometry, ringGeometry);
    this.materials.push(shell, energy);
    const bases = new THREE.InstancedMesh(baseGeometry, shell, this.jumpPads.length);
    const rings = new THREE.InstancedMesh(ringGeometry, energy, this.jumpPads.length);
    bases.name = 'MonsoonJumpPadBases';
    rings.name = 'MonsoonJumpPadEnergyRings';
    const matrix = new THREE.Matrix4();
    const identity = new THREE.Quaternion();
    const horizontal = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI * 0.5, 0, 0));
    this.jumpPads.forEach((pad, index) => {
      matrix.compose(pad.position.clone().add(new THREE.Vector3(0, 0.08, 0)), identity, new THREE.Vector3(1, 1, 1));
      bases.setMatrixAt(index, matrix);
      matrix.compose(pad.position.clone().add(new THREE.Vector3(0, 0.33, 0)), horizontal, new THREE.Vector3(1, 1, 1));
      rings.setMatrixAt(index, matrix);
    });
    bases.instanceMatrix.needsUpdate = true;
    rings.instanceMatrix.needsUpdate = true;
    this.group.add(bases, rings);
  }

  private createCoreReactor(toonRamp: THREE.Texture): void {
    const root = new THREE.Group();
    root.name = 'MonsoonFluxCoreReactor';
    root.position.copy(this.corePosition);
    const dark = new THREE.MeshToonMaterial({ color: 0x172a3d, gradientMap: toonRamp });
    const metal = new THREE.MeshStandardMaterial({ color: 0x83a5b5, roughness: 0.32, metalness: 0.78 });
    const energy = new THREE.MeshStandardMaterial({
      color: 0xb8fbff,
      emissive: 0x20dfff,
      emissiveIntensity: 3.2,
      transparent: true,
      opacity: 0.86,
      depthWrite: false,
      roughness: 0.1,
    });
    this.materials.push(dark, metal, energy);
    const daisGeometry = new THREE.CylinderGeometry(3.6, 4.4, 0.75, 12);
    const coreGeometry = new THREE.CylinderGeometry(1.05, 1.2, 5.8, 12, 1, true);
    const strutGeometry = new THREE.BoxGeometry(0.42, 6.2, 0.72);
    const ringGeometry = new THREE.TorusGeometry(1.92, 0.17, 8, 32);
    this.geometries.push(daisGeometry, coreGeometry, strutGeometry, ringGeometry);
    const dais = new THREE.Mesh(daisGeometry, dark);
    dais.position.y = 0.38;
    dais.castShadow = true;
    const core = new THREE.Mesh(coreGeometry, energy);
    core.position.y = 3.45;
    const struts = new THREE.InstancedMesh(strutGeometry, metal, 3);
    const matrix = new THREE.Matrix4();
    for (let index = 0; index < 3; index += 1) {
      const angle = index / 3 * Math.PI * 2;
      matrix.compose(
        new THREE.Vector3(Math.cos(angle) * 2.65, 3.35, Math.sin(angle) * 2.65),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -angle, -0.13)),
        new THREE.Vector3(1, 1, 1),
      );
      struts.setMatrixAt(index, matrix);
    }
    const lowerRing = new THREE.Mesh(ringGeometry, energy);
    lowerRing.rotation.x = Math.PI * 0.5;
    lowerRing.position.y = 2.45;
    const upperRing = lowerRing.clone();
    upperRing.position.y = 4.65;
    this.animatedProps.push(
      { object: lowerRing, baseY: 2.45, phase: 0, spin: 0.62 },
      { object: upperRing, baseY: 4.65, phase: Math.PI, spin: -0.48 },
    );
    root.add(dais, core, struts, lowerRing, upperRing);
    this.group.add(root);
  }

  private createLandmarkTower(
    x: number,
    z: number,
    color: number,
    heightScale: number,
    _toonRamp: THREE.Texture,
  ): void {
    const root = new THREE.Group();
    root.name = `MonsoonLandmark_${color.toString(16)}`;
    root.position.copy(placedPoint(x, z, this.seed));
    const dark = new THREE.MeshStandardMaterial({ color: 0x102029, roughness: 0.62, metalness: 0.5 });
    const white = new THREE.MeshStandardMaterial({ color: 0x52666c, roughness: 0.76, metalness: 0.16 });
    const glow = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 1.75,
      roughness: 0.22,
      metalness: 0.3,
    });
    this.materials.push(dark, white, glow);
    const baseGeometry = new THREE.CylinderGeometry(3.1, 4, 1.1, 8);
    const mastGeometry = new THREE.CylinderGeometry(0.38, 1.15, 15 * heightScale, 7);
    const collarGeometry = new THREE.CylinderGeometry(1.3, 1.6, 0.65, 8);
    const crownGeometry = new THREE.OctahedronGeometry(0.92, 0);
    const haloGeometry = new THREE.TorusGeometry(1.45, 0.12, 6, 24);
    const braceGeometry = new RoundedBoxGeometry(0.48, 5.6, 0.62, 1, 0.08);
    const finGeometry = new THREE.ConeGeometry(0.46, 2.4, 4, 1, false, Math.PI * 0.25);
    this.geometries.push(baseGeometry, mastGeometry, collarGeometry, crownGeometry, haloGeometry, braceGeometry, finGeometry);
    const base = new THREE.Mesh(baseGeometry, dark);
    base.position.y = 0.55;
    const mast = new THREE.Mesh(mastGeometry, white);
    mast.position.y = 1.1 + 7.5 * heightScale;
    const collar = new THREE.Mesh(collarGeometry, dark);
    collar.position.y = 3.1;
    const braces = new THREE.InstancedMesh(braceGeometry, dark, 4);
    const fins = new THREE.InstancedMesh(finGeometry, white, 4);
    const detailMatrix = new THREE.Matrix4();
    for (let index = 0; index < 4; index += 1) {
      const angle = index / 4 * Math.PI * 2;
      const radial = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      detailMatrix.compose(
        radial.clone().multiplyScalar(1.68).setY(3.25),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -angle, index % 2 === 0 ? 0.16 : -0.16)),
        new THREE.Vector3(1, 1, 1),
      );
      braces.setMatrixAt(index, detailMatrix);
      detailMatrix.compose(
        radial.clone().multiplyScalar(1.05).setY(7.4 + index * 0.46),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -angle, Math.PI * 0.5)),
        new THREE.Vector3(1, 1, 1),
      );
      fins.setMatrixAt(index, detailMatrix);
    }
    braces.instanceMatrix.needsUpdate = true;
    fins.instanceMatrix.needsUpdate = true;
    const crownY = 2 + 15 * heightScale;
    const crown = new THREE.Mesh(crownGeometry, glow);
    crown.position.y = crownY;
    const halo = new THREE.Mesh(haloGeometry, glow);
    halo.position.y = crownY - 1.35;
    halo.rotation.x = Math.PI * 0.5;
    this.animatedProps.push({ object: crown, baseY: crownY, phase: x * 0.03, spin: 0.7 });
    this.animatedProps.push({ object: halo, baseY: crownY - 1.35, phase: z * 0.03, spin: -0.42 });
    root.add(base, mast, collar, braces, fins, crown, halo);
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh && mesh.material !== glow) mesh.castShadow = true;
    });
    this.group.add(root);
  }

  private createDetailedDirtRoutes(_toonRamp: THREE.Texture): void {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const pushVertex = (point: THREE.Vector3, u: number, v: number): void => {
      const normal = sampleMonsoonNormal(point.x, point.z, new THREE.Vector3(), this.seed);
      positions.push(point.x, point.y, point.z);
      normals.push(normal.x, normal.y, normal.z);
      uvs.push(u, v);
    };
    const appendRibbon = (
      source: ReadonlyArray<readonly [number, number]>,
      width: number,
      closed: boolean,
    ): void => {
      const samples = [...source];
      if (
        closed
        && samples.length > 2
        && Math.hypot(samples[0][0] - samples.at(-1)![0], samples[0][1] - samples.at(-1)![1]) < 0.05
      ) samples.pop();
      if (samples.length < 2) return;
      const left: THREE.Vector3[] = [];
      const right: THREE.Vector3[] = [];
      const distances = [0];
      for (let index = 0; index < samples.length; index += 1) {
        const previousIndex = index === 0 ? (closed ? samples.length - 1 : 0) : index - 1;
        const nextIndex = index === samples.length - 1 ? (closed ? 0 : index) : index + 1;
        const [x, z] = samples[index];
        const [previousX, previousZ] = samples[previousIndex];
        const [nextX, nextZ] = samples[nextIndex];
        const tangentX = nextX - previousX;
        const tangentZ = nextZ - previousZ;
        const tangentLength = Math.hypot(tangentX, tangentZ) || 1;
        const crossX = -tangentZ / tangentLength;
        const crossZ = tangentX / tangentLength;
        const halfWidth = width * 0.5;
        const leftX = x + crossX * halfWidth;
        const leftZ = z + crossZ * halfWidth;
        const rightX = x - crossX * halfWidth;
        const rightZ = z - crossZ * halfWidth;
        left.push(new THREE.Vector3(leftX, sampleMonsoonHeight(leftX, leftZ, this.seed) + 0.085, leftZ));
        right.push(new THREE.Vector3(rightX, sampleMonsoonHeight(rightX, rightZ, this.seed) + 0.085, rightZ));
        if (index > 0) {
          distances.push(distances[index - 1] + Math.hypot(x - samples[index - 1][0], z - samples[index - 1][1]));
        }
      }
      const segmentCount = closed ? samples.length : samples.length - 1;
      for (let index = 0; index < segmentCount; index += 1) {
        const nextIndex = (index + 1) % samples.length;
        const segmentLength = Math.hypot(
          samples[nextIndex][0] - samples[index][0],
          samples[nextIndex][1] - samples[index][1],
        );
        const v0 = distances[index] / 14;
        const v1 = (distances[index] + segmentLength) / 14;
        pushVertex(left[index], 0, v0);
        pushVertex(left[nextIndex], 0, v1);
        pushVertex(right[index], 1, v0);
        pushVertex(right[index], 1, v0);
        pushVertex(left[nextIndex], 0, v1);
        pushVertex(right[nextIndex], 1, v1);
      }
    };

    const subdivisions = 28;
    for (const [startX, startZ, endX, endZ] of MONSOON_ROUTE_SEGMENTS) {
      const samples: Array<readonly [number, number]> = [];
      for (let index = 0; index <= subdivisions; index += 1) {
        const t = index / subdivisions;
        samples.push([
          THREE.MathUtils.lerp(startX, endX, t),
          THREE.MathUtils.lerp(startZ, endZ, t),
        ]);
      }
      appendRibbon(samples, 9.6, false);
    }
    // The terrain itself defines the broad outer ski loop. Keeping its old
    // full-width decal produced a debug-red ring around the whole island and
    // sent ribbon triangles down the coastal cliffs. Only the compact inner
    // race line receives a subtle packed-earth surface treatment.
    appendRibbon(MONSOON_INNER_LOOP_SAMPLES, 9.2, true);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const texture = this.createDirtTexture();
    const edgeMask = this.createDirtRouteEdgeMask();
    const material = new THREE.MeshStandardMaterial({
      color: 0x918979,
      map: texture,
      alphaMap: edgeMask,
      alphaTest: 0.06,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      roughness: 0.98,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.geometries.push(geometry);
    this.materials.push(material);
    const routes = new THREE.Mesh(geometry, material);
    routes.name = 'MonsoonFeatheredPackedEarthSkiRoutes';
    routes.receiveShadow = true;
    routes.renderOrder = 1;
    this.group.add(routes);
  }

  private createDirtTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is required for Monsoon dirt synthesis.');
    context.fillStyle = '#74664d';
    context.fillRect(0, 0, 512, 512);
    const random = randomFactory(this.seed ^ 0xd17d17);
    for (let index = 0; index < 8_000; index += 1) {
      const bright = random() > 0.56;
      context.fillStyle = bright
        ? `rgba(190,166,121,${0.035 + random() * 0.12})`
        : `rgba(42,51,47,${0.025 + random() * 0.13})`;
      const size = random() < 0.88 ? 1 : 2 + random() * 2;
      context.fillRect(random() * 512, random() * 512, size, size * 0.72);
    }
    context.strokeStyle = 'rgba(38,47,45,.24)';
    context.lineWidth = 3;
    for (let track = 0; track < 7; track += 1) {
      const x = 50 + track * 68 + random() * 18;
      context.beginPath();
      context.moveTo(x, 0);
      context.bezierCurveTo(x - 20, 150, x + 26, 330, x - 8, 512);
      context.stroke();
    }
    context.strokeStyle = 'rgba(213,191,145,.16)';
    context.lineWidth = 1;
    for (let crack = 0; crack < 28; crack += 1) {
      const x = random() * 512;
      const y = random() * 512;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + (random() - 0.5) * 24, y + 8 + random() * 25);
      context.lineTo(x + (random() - 0.5) * 30, y + 18 + random() * 34);
      context.stroke();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.name = 'MonsoonProceduralDirtDetail';
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 8;
    this.textures.push(texture);
    return texture;
  }

  private createDirtRouteEdgeMask(): THREE.DataTexture {
    const width = 128;
    const data = new Uint8Array(width * 4);
    for (let x = 0; x < width; x += 1) {
      const u = x / (width - 1);
      const edgeDistance = Math.min(u, 1 - u);
      const alpha = THREE.MathUtils.smoothstep(edgeDistance, 0, 0.16);
      const channel = x * 4;
      data[channel] = 255;
      data[channel + 1] = Math.round(alpha * 255);
      data[channel + 2] = 255;
      data[channel + 3] = 255;
    }
    const texture = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat);
    texture.name = 'MonsoonPackedEarthFeatherMask';
    texture.colorSpace = THREE.NoColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    this.textures.push(texture);
    return texture;
  }

  private createGrassBladeGeometry(): THREE.BufferGeometry {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const cluster: ReadonlyArray<readonly [number, number, number]> = [
      [0, 0, 0],
      [0.55, 0.42, 0.12],
      [-0.62, -0.43, 0.1],
      [1.16, 0.12, 0.48],
      [-1.28, -0.1, -0.49],
      [0.18, 0.5, -0.37],
      [-0.22, -0.51, 0.38],
      [0.92, 0.62, -0.08],
      [-0.96, -0.63, 0.04],
    ];
    for (const [blade, [angle, offsetX, offsetZ]] of cluster.entries()) {
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      const width = 0.01 + (blade % 3) * 0.004;
      const height = 0.2 + (blade % 4) * 0.035;
      const points = [
        new THREE.Vector3(-width + offsetX, 0, offsetZ),
        new THREE.Vector3(width + offsetX, 0, offsetZ),
        new THREE.Vector3(offsetX + 0.07, height, offsetZ),
      ];
      for (const point of points) {
        const x = point.x * cosine - point.z * sine;
        const z = point.x * sine + point.z * cosine;
        point.set(x, point.y, z);
      }
      for (const index of [0, 1, 2]) {
        const point = points[index];
        positions.push(point.x, point.y, point.z);
        normals.push(sine * 0.26, 0.93, cosine * 0.26);
        uvs.push(index === 0 ? 0 : index === 1 ? 1 : 0.5, index < 2 ? 0 : 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.computeBoundingSphere();
    return geometry;
  }

  private createWeedGeometry(): THREE.BufferGeometry {
    const positions = new Float32Array([
      -0.018, 0, 0, 0.018, 0, 0, 0.025, 0.52, 0,
      0.005, 0.2, 0, 0.29, 0.31, 0.02, 0.018, 0.35, 0,
      -0.005, 0.29, 0, -0.25, 0.41, -0.02, 0.015, 0.42, 0,
      -0.04, 0.5, 0, 0.09, 0.5, 0, 0.025, 0.62, 0,
    ]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const normals = new Float32Array(positions.length);
    for (let index = 0; index < normals.length; index += 3) {
      normals[index] = 0.12;
      normals[index + 1] = 0.94;
      normals[index + 2] = 0.32;
    }
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.computeBoundingSphere();
    return geometry;
  }

  private createGroundMarks(): void {
    const footprintCanvas = document.createElement('canvas');
    footprintCanvas.width = 128;
    footprintCanvas.height = 192;
    const footprintContext = footprintCanvas.getContext('2d');
    if (!footprintContext) return;
    footprintContext.clearRect(0, 0, 128, 192);
    footprintContext.fillStyle = 'rgba(255,255,255,.82)';
    footprintContext.beginPath();
    footprintContext.ellipse(64, 47, 30, 42, 0, 0, Math.PI * 2);
    footprintContext.fill();
    footprintContext.beginPath();
    footprintContext.roundRect(36, 72, 56, 92, 20);
    footprintContext.fill();
    footprintContext.globalCompositeOperation = 'destination-out';
    footprintContext.lineWidth = 7;
    for (let y = 24; y < 164; y += 20) {
      footprintContext.beginPath();
      footprintContext.moveTo(34, y);
      footprintContext.lineTo(94, y + 13);
      footprintContext.stroke();
    }
    footprintContext.globalCompositeOperation = 'source-over';
    const footprintTexture = new THREE.CanvasTexture(footprintCanvas);
    footprintTexture.name = 'MonsoonSoilFootprintDecal';
    footprintTexture.colorSpace = THREE.SRGBColorSpace;

    const crackCanvas = document.createElement('canvas');
    crackCanvas.width = 256;
    crackCanvas.height = 256;
    const crackContext = crackCanvas.getContext('2d');
    if (!crackContext) return;
    crackContext.clearRect(0, 0, 256, 256);
    crackContext.translate(128, 128);
    crackContext.strokeStyle = 'rgba(255,255,255,.93)';
    crackContext.lineCap = 'round';
    const random = randomFactory(this.seed ^ 0xc2ac4ed);
    for (let branch = 0; branch < 16; branch += 1) {
      let x = (random() - 0.5) * 8;
      let y = (random() - 0.5) * 8;
      const angle = branch / 16 * Math.PI * 2 + (random() - 0.5) * 0.34;
      crackContext.lineWidth = 1.1 + random() * 2.2;
      crackContext.beginPath();
      crackContext.moveTo(x, y);
      const length = 32 + random() * 72;
      for (let step = 1; step <= 5; step += 1) {
        const distance = length * step / 5;
        x = Math.cos(angle) * distance + (random() - 0.5) * 13;
        y = Math.sin(angle) * distance + (random() - 0.5) * 13;
        crackContext.lineTo(x, y);
      }
      crackContext.stroke();
    }
    crackContext.fillStyle = 'rgba(255,255,255,.88)';
    crackContext.beginPath();
    crackContext.arc(0, 0, 9, 0, Math.PI * 2);
    crackContext.fill();
    const crackTexture = new THREE.CanvasTexture(crackCanvas);
    crackTexture.name = 'MonsoonConcreteFractureDecal';
    crackTexture.colorSpace = THREE.SRGBColorSpace;

    const footprintGeometry = new THREE.PlaneGeometry(0.42, 0.78);
    const crackGeometry = new THREE.PlaneGeometry(1.65, 1.65);
    const footprintMaterial = new THREE.MeshBasicMaterial({
      map: footprintTexture,
      color: 0x47362e,
      transparent: true,
      opacity: 0.42,
      alphaTest: 0.08,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    const crackMaterial = new THREE.MeshBasicMaterial({
      map: crackTexture,
      color: 0x1f2a31,
      transparent: true,
      opacity: 0.86,
      alphaTest: 0.05,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
    });
    this.footprintMesh = new THREE.InstancedMesh(footprintGeometry, footprintMaterial, this.footprints.length);
    this.crackMesh = new THREE.InstancedMesh(crackGeometry, crackMaterial, this.cracks.length);
    this.footprintMesh.name = 'MonsoonPersistentSoilTracks';
    this.crackMesh.name = 'MonsoonPersistentConcreteFractures';
    this.footprintMesh.frustumCulled = false;
    this.crackMesh.frustumCulled = false;
    const hidden = new THREE.Matrix4().makeTranslation(0, -1000, 0);
    for (let index = 0; index < this.footprints.length; index += 1) this.footprintMesh.setMatrixAt(index, hidden);
    for (let index = 0; index < this.cracks.length; index += 1) this.crackMesh.setMatrixAt(index, hidden);
    this.footprintMesh.instanceMatrix.needsUpdate = true;
    this.crackMesh.instanceMatrix.needsUpdate = true;
    this.geometries.push(footprintGeometry, crackGeometry);
    this.materials.push(footprintMaterial, crackMaterial);
    this.textures.push(footprintTexture, crackTexture);
    this.group.add(this.footprintMesh, this.crackMesh);
  }

  private updateGroundMarks(time: number): void {
    const activeFootprints = this.updateGroundMarkMesh(this.footprintMesh, this.footprints, time, 26, 1, 1);
    const activeCracks = this.updateGroundMarkMesh(this.crackMesh, this.cracks, time, 55, 1, 1);
    this.groundMarksActive = activeFootprints || activeCracks;
    this.groundMarksDirty = false;
  }

  private updateGroundMarkMesh(
    mesh: THREE.InstancedMesh | undefined,
    marks: Array<GroundMark | undefined>,
    time: number,
    lifetime: number,
    width: number,
    length: number,
  ): boolean {
    if (!mesh) return false;
    let active = false;
    let changed = false;
    for (let index = 0; index < marks.length; index += 1) {
      const mark = marks[index];
      if (!mark) continue;
      if (time - mark.bornAt > lifetime) {
        mesh.setMatrixAt(index, this.hiddenGroundMarkMatrix);
        marks[index] = undefined;
        changed = true;
        continue;
      }
      active = true;
      changed = true;
      this.groundMarkTangent.copy(mark.forward).addScaledVector(mark.normal, -mark.forward.dot(mark.normal));
      if (this.groundMarkTangent.lengthSq() < 0.001) this.groundMarkTangent.set(0, 0, 1);
      this.groundMarkTangent.normalize();
      this.groundMarkRight.copy(this.groundMarkTangent).cross(mark.normal).normalize();
      const fadeScale = THREE.MathUtils.clamp((lifetime - (time - mark.bornAt)) / 3, 0, 1);
      this.groundMarkMatrix.makeBasis(this.groundMarkRight, this.groundMarkTangent, mark.normal);
      this.groundMarkScale.set(width * mark.size * fadeScale, length * mark.size * fadeScale, 1);
      this.groundMarkMatrix.scale(this.groundMarkScale);
      this.groundMarkMatrix.setPosition(mark.position);
      mesh.setMatrixAt(index, this.groundMarkMatrix);
    }
    if (changed) mesh.instanceMatrix.needsUpdate = true;
    return active;
  }

  private createVegetation(_toonRamp: THREE.Texture): void {
    const mobile = window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 600;
    const random = randomFactory(this.seed ^ 0x6a7a55e1);
    const rockGeometry = new THREE.IcosahedronGeometry(1, 0);
    const rockMaterial = new THREE.MeshStandardMaterial({
      color: 0x657d89,
      roughness: 0.93,
      metalness: 0.015,
      flatShading: true,
    });
    const rockCount = this.scatteredRocks.length;
    const rocks = new THREE.InstancedMesh(rockGeometry, rockMaterial, rockCount);
    rocks.name = 'MonsoonFacetedRockField';
    const grassGeometry = this.createGrassBladeGeometry();
    const grassMaterial = new THREE.MeshStandardMaterial({
      color: 0xc1d59a,
      roughness: 0.92,
      metalness: 0,
      side: THREE.DoubleSide,
      vertexColors: true,
    });
    grassMaterial.customProgramCacheKey = () => 'monsoon-reactive-grass-v1';
    grassMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.grassUniforms.uTime;
      shader.uniforms.uWind = this.grassUniforms.uWind;
      shader.uniforms.uWindDirection = this.grassUniforms.uWindDirection;
      shader.uniforms.uPlayer = this.grassUniforms.uPlayer;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uTime;
          uniform float uWind;
          uniform vec2 uWindDirection;
          uniform vec3 uPlayer;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec3 monsoonRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
            float monsoonBlade = smoothstep(0.0, 0.7, position.y);
            float monsoonWave = sin(uTime * 2.15 + monsoonRoot.x * 0.11 + monsoonRoot.z * 0.083)
              + sin(uTime * 1.18 + monsoonRoot.z * 0.19) * 0.42;
            vec2 monsoonAway = monsoonRoot.xz - uPlayer.xz;
            float monsoonDistance = length(monsoonAway);
            vec2 monsoonPush = monsoonAway / max(monsoonDistance, 0.08);
            float monsoonInfluence = 1.0 - smoothstep(0.65, 3.4, monsoonDistance);
            transformed.xz += uWindDirection * monsoonWave * uWind * monsoonBlade * 0.115;
            transformed.xz += monsoonPush * monsoonInfluence * monsoonBlade * 0.48;
          #endif`,
        );
    };
    // Spatial chunks retain the continuous blade field while letting the
    // renderer reject vegetation behind the camera. The old map-wide mesh was
    // effectively never culled and animated ~1.4M blade vertices every frame.
    const grassCount = mobile ? 12_000 : 36_000;
    const grassGroup = new THREE.Group();
    grassGroup.name = 'MonsoonWindGrass';
    const weedGeometry = this.createWeedGeometry();
    const weedMaterial = new THREE.MeshStandardMaterial({
      color: 0xd5ddb4,
      roughness: 0.88,
      metalness: 0,
      side: THREE.DoubleSide,
      vertexColors: true,
    });
    weedMaterial.customProgramCacheKey = () => 'monsoon-reactive-weeds-v1';
    weedMaterial.onBeforeCompile = grassMaterial.onBeforeCompile;
    const weedCount = mobile ? 900 : 2_800;
    const weedGroup = new THREE.Group();
    weedGroup.name = 'MonsoonMixedWeedsAndSeedHeads';
    this.geometries.push(rockGeometry, grassGeometry, weedGeometry);
    this.materials.push(rockMaterial, grassMaterial, weedMaterial);
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const scaleVector = new THREE.Vector3();
    const instanceColor = new THREE.Color();
    const grassBuckets = Array.from({ length: VEGETATION_CHUNK_COUNT }, () => [] as number[]);
    const weedBuckets = Array.from({ length: VEGETATION_CHUNK_COUNT }, () => [] as number[]);
    const chunkFor = (x: number, z: number): number => {
      const column = THREE.MathUtils.clamp(
        Math.floor((x / MONSOON_DIVIDE.width + 0.5) * VEGETATION_CHUNK_COLUMNS),
        0,
        VEGETATION_CHUNK_COLUMNS - 1,
      );
      const row = THREE.MathUtils.clamp(
        Math.floor((z / MONSOON_DIVIDE.depth + 0.5) * VEGETATION_CHUNK_ROWS),
        0,
        VEGETATION_CHUNK_ROWS - 1,
      );
      return row * VEGETATION_CHUNK_COLUMNS + column;
    };
    const findPlacement = (avoidRoute: number): THREE.Vector3 => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const x = (random() - 0.5) * 430;
        const z = (random() - 0.5) * 350;
        const y = sampleMonsoonHeight(x, z, this.seed);
        const masks = sampleMonsoonMasks(x, z);
        if (
          y > MONSOON_DIVIDE.waterY + 2.4 && masks.route < avoidRoute && masks.crater < 0.62
          && !this.isConcreteFootprint(x, z)
        ) {
          return new THREE.Vector3(x, y, z);
        }
      }
      return new THREE.Vector3(0, -100, 0);
    };
    for (let index = 0; index < rockCount; index += 1) {
      const rock = this.scatteredRocks[index];
      matrix.compose(rock.position, rock.quaternion, rock.scale);
      rocks.setMatrixAt(index, matrix);
      rocks.setColorAt(index, instanceColor.setHex(index % 3 === 0 ? 0x718494 : 0x51687a));
    }
    for (let index = 0; index < grassCount; index += 1) {
      const position = findPlacement(0.21);
      const yaw = random() * Math.PI * 2;
      const scale = 0.68 + random() * 0.4;
      const colorPick = random();
      const color = colorPick > 0.84 ? 0x9eb879 : colorPick > 0.34 ? 0x78975c : 0x607c4d;
      grassBuckets[chunkFor(position.x, position.z)].push(position.x, position.y + 0.018, position.z, yaw, scale, color);
    }
    for (let index = 0; index < weedCount; index += 1) {
      const position = findPlacement(0.19);
      const yaw = random() * Math.PI * 2;
      const scale = 0.55 + random() * 0.52;
      const pick = random();
      const color = pick > 0.82 ? 0xc8b07b : pick > 0.42 ? 0x8d9d66 : 0x697e56;
      weedBuckets[chunkFor(position.x, position.z)].push(position.x, position.y + 0.015, position.z, yaw, scale, color);
    }
    const buildChunks = (
      name: string,
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      buckets: number[][],
      target: THREE.Group,
    ): void => {
      for (let chunk = 0; chunk < buckets.length; chunk += 1) {
        const packed = buckets[chunk];
        const count = packed.length / 6;
        if (count === 0) continue;
        const mesh = new THREE.InstancedMesh(geometry, material, count);
        mesh.name = `${name}Chunk${chunk}`;
        mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        for (let index = 0; index < count; index += 1) {
          const offset = index * 6;
          this.ambientPosition.set(packed[offset], packed[offset + 1], packed[offset + 2]);
          quaternion.setFromEuler(euler.set(0, packed[offset + 3], 0));
          const scale = packed[offset + 4];
          scaleVector.set(scale, scale, scale);
          matrix.compose(this.ambientPosition, quaternion, scaleVector);
          mesh.setMatrixAt(index, matrix);
          mesh.setColorAt(index, instanceColor.setHex(packed[offset + 5]));
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) {
          mesh.instanceColor.setUsage(THREE.StaticDrawUsage);
          mesh.instanceColor.needsUpdate = true;
        }
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
        // Tiny foliage shadow sampling is expensive and visually redundant
        // against the terrain's authored lighting and larger rock shadows.
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        target.add(mesh);
      }
    };
    buildChunks('MonsoonWindGrass', grassGeometry, grassMaterial, grassBuckets, grassGroup);
    buildChunks('MonsoonMixedWeedsAndSeedHeads', weedGeometry, weedMaterial, weedBuckets, weedGroup);
    rocks.instanceMatrix.needsUpdate = true;
    if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
    rocks.computeBoundingSphere();
    rocks.receiveShadow = true;
    this.group.add(rocks, grassGroup, weedGroup);
  }

  private createAmbientLife(toonRamp: THREE.Texture): void {
    const shadowGeometry = new THREE.CircleGeometry(1, 12);
    const beetleGeometry = new THREE.SphereGeometry(0.3, 6, 4);
    const birdGeometry = new THREE.BufferGeometry();
    birdGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0.32, -0.92, 0, 0, 0, 0.08, -0.18,
      0, 0, 0.32, 0, 0.08, -0.18, 0.92, 0, 0,
    ], 3));
    birdGeometry.computeVertexNormals();
    const animalParts: THREE.BufferGeometry[] = [];
    const addAnimalPart = (
      source: THREE.BufferGeometry,
      boneIndex: number,
      color: number,
      transform: (geometry: THREE.BufferGeometry) => void,
    ): void => {
      const geometry = source.index ? source.toNonIndexed() : source.clone();
      source.dispose();
      transform(geometry);
      const count = geometry.getAttribute('position').count;
      const skinIndices = new Uint16Array(count * 4);
      const skinWeights = new Float32Array(count * 4);
      const colors = new Float32Array(count * 3);
      const partColor = new THREE.Color(color);
      for (let index = 0; index < count; index += 1) {
        skinIndices[index * 4] = boneIndex;
        skinWeights[index * 4] = 1;
        colors[index * 3] = partColor.r;
        colors[index * 3 + 1] = partColor.g;
        colors[index * 3 + 2] = partColor.b;
      }
      geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
      geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      animalParts.push(geometry);
    };
    const scaleTranslate = (
      scaleX: number,
      scaleY: number,
      scaleZ: number,
      x: number,
      y: number,
      z: number,
    ) => (geometry: THREE.BufferGeometry): void => {
      geometry.scale(scaleX, scaleY, scaleZ);
      geometry.translate(x, y, z);
    };
    addAnimalPart(new THREE.DodecahedronGeometry(1, 0), 1, 0x96906c, scaleTranslate(0.7, 0.54, 1.1, 0, 1.08, -0.05));
    addAnimalPart(new THREE.DodecahedronGeometry(1, 0), 1, 0xa29a73, scaleTranslate(0.66, 0.62, 0.68, 0, 1.16, 0.55));
    addAnimalPart(new THREE.CylinderGeometry(0.25, 0.37, 0.74, 6), 2, 0x77775b, (geometry) => {
      geometry.rotateX(0.48);
      geometry.translate(0, 1.47, 0.84);
    });
    addAnimalPart(new THREE.IcosahedronGeometry(1, 0), 2, 0x686e56, scaleTranslate(0.42, 0.36, 0.48, 0, 1.78, 1.13));
    addAnimalPart(new THREE.BoxGeometry(1, 1, 1), 2, 0x4d5545, scaleTranslate(0.38, 0.23, 0.46, 0, 1.69, 1.48));
    for (const side of [-1, 1]) {
      addAnimalPart(new THREE.ConeGeometry(0.13, 0.34, 5), 2, 0x8f896a, (geometry) => {
        geometry.rotateZ(side * -0.24);
        geometry.translate(side * 0.25, 2.05, 1.08);
      });
      addAnimalPart(new THREE.ConeGeometry(0.07, 0.34, 5), 2, 0xd2c9a4, (geometry) => {
        geometry.rotateZ(side * 0.14);
        geometry.translate(side * 0.17, 2.13, 1.19);
      });
    }
    addAnimalPart(new THREE.ConeGeometry(0.13, 0.68, 6), 3, 0x5f6550, (geometry) => {
      geometry.rotateX(-1.12);
      geometry.translate(0, 1.2, -1.1);
    });
    const hipPositions: ReadonlyArray<readonly [number, number]> = [
      [-0.36, 0.52], [0.36, 0.52], [-0.36, -0.53], [0.36, -0.53],
    ];
    hipPositions.forEach(([x, z], leg) => {
      const upperBone = 4 + leg * 2;
      const lowerBone = upperBone + 1;
      addAnimalPart(new THREE.CylinderGeometry(0.09, 0.13, 0.56, 5), upperBone, 0x505744, (geometry) => {
        geometry.translate(x, 0.65, z);
      });
      addAnimalPart(new THREE.CylinderGeometry(0.065, 0.09, 0.54, 5), lowerBone, 0x3f493b, (geometry) => {
        geometry.translate(x, 0.11, z);
      });
      addAnimalPart(new THREE.BoxGeometry(0.2, 0.12, 0.3), lowerBone, 0x30392f, (geometry) => {
        geometry.translate(x, -0.18, z + 0.05);
      });
    });
    const animalGeometry = mergeGeometries(animalParts, false);
    for (const part of animalParts) part.dispose();
    if (!animalGeometry) throw new Error('Failed to assemble ambient animal skin.');
    animalGeometry.computeBoundingSphere();
    animalGeometry.name = 'MonsoonArticulatedGrazerGeometry';
    this.geometries.push(animalGeometry, shadowGeometry, beetleGeometry, birdGeometry);

    const animalMaterial = new THREE.MeshToonMaterial({
      color: 0xffffff,
      vertexColors: true,
      gradientMap: toonRamp,
    });
    const shadowMaterial = new THREE.MeshBasicMaterial({
      color: 0x10202b,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
    });
    const beetleMaterial = new THREE.MeshStandardMaterial({
      color: 0x26484c,
      roughness: 0.38,
      metalness: 0.46,
    });
    const birdMaterial = new THREE.MeshToonMaterial({
      color: 0xd7edf0,
      gradientMap: toonRamp,
      side: THREE.DoubleSide,
    });
    this.materials.push(animalMaterial, shadowMaterial, beetleMaterial, birdMaterial);

    this.animalRoutes.push(
      { centerX: -171, centerZ: 8, radiusX: 14, radiusZ: 9, phase: 0.2, speed: 0.12 },
      { centerX: 169, centerZ: -18, radiusX: 12, radiusZ: 15, phase: 1.7, speed: 0.1 },
      { centerX: -73, centerZ: 145, radiusX: 18, radiusZ: 8, phase: 3.2, speed: 0.085 },
      { centerX: 80, centerZ: 143, radiusX: 16, radiusZ: 9, phase: 4.8, speed: 0.095 },
      { centerX: 4, centerZ: -154, radiusX: 22, radiusZ: 7, phase: 5.6, speed: 0.08 },
    );
    const animalCount = this.animalRoutes.length;
    const beetleCount = window.matchMedia('(pointer: coarse)').matches ? 12 : 24;
    const birdCount = window.matchMedia('(pointer: coarse)').matches ? 7 : 12;
    const animals: AnimalRig[] = [];
    for (let index = 0; index < animalCount; index += 1) {
      const skeletonRoot = new THREE.Bone();
      skeletonRoot.name = `Grazer${index}SkeletonRoot`;
      const spine = new THREE.Bone();
      spine.name = 'Spine';
      spine.position.set(0, 1.08, 0);
      const head = new THREE.Bone();
      head.name = 'NeckHead';
      head.position.set(0, 0.3, 0.68);
      const tail = new THREE.Bone();
      tail.name = 'Tail';
      tail.position.set(0, 0.1, -0.88);
      skeletonRoot.add(spine);
      spine.add(head, tail);
      const hips: THREE.Bone[] = [];
      const knees: THREE.Bone[] = [];
      hipPositions.forEach(([x, z], leg) => {
        const hip = new THREE.Bone();
        hip.name = `Leg${leg}Hip`;
        hip.position.set(x, 0.93, z);
        const knee = new THREE.Bone();
        knee.name = `Leg${leg}Knee`;
        knee.position.set(0, -0.54, 0);
        hip.add(knee);
        skeletonRoot.add(hip);
        hips.push(hip);
        knees.push(knee);
      });
      const mesh = new THREE.SkinnedMesh(animalGeometry, animalMaterial);
      mesh.name = `MonsoonArticulatedGrazer${index}`;
      mesh.add(skeletonRoot);
      mesh.bind(new THREE.Skeleton([skeletonRoot, spine, head, tail, ...hips.flatMap((hip, leg) => [hip, knees[leg]])]));
      // The dedicated contact-shadow instances retain grounding while avoiding
      // five animated skinning draws in the directional shadow pass.
      mesh.castShadow = false;
      mesh.frustumCulled = true;
      this.group.add(mesh);
      animals.push({
        mesh,
        spine,
        head,
        tail,
        hips: hips as AnimalRig['hips'],
        knees: knees as AnimalRig['knees'],
      });
    }
    const shadows = new THREE.InstancedMesh(shadowGeometry, shadowMaterial, animalCount);
    const beetles = new THREE.InstancedMesh(beetleGeometry, beetleMaterial, beetleCount);
    const birds = new THREE.InstancedMesh(birdGeometry, birdMaterial, birdCount);
    shadows.name = 'MonsoonAmbientGrazerContactShadows';
    beetles.name = 'MonsoonAmbientRouteBeetles';
    birds.name = 'MonsoonAmbientCliffBirds';
    this.ambientLife = { animals, shadows, beetles, birds };
    this.group.add(shadows, beetles, birds);
    this.updateAmbientLife(0);
  }

  private updateAmbientLife(time: number): void {
    if (!this.ambientLife) return;
    const { animals, shadows, beetles, birds } = this.ambientLife;
    const matrix = this.ambientMatrix;
    const quaternion = this.ambientQuaternion;
    for (let index = 0; index < this.animalRoutes.length; index += 1) {
      const route = this.animalRoutes[index];
      const angle = route.phase + time * route.speed;
      const animal = animals[index];
      let x = route.centerX + Math.cos(angle) * route.radiusX;
      let z = route.centerZ + Math.sin(angle) * route.radiusZ;
      for (const collider of this.colliders) {
        const margin = 0.82;
        const box = collider.box;
        if (
          x <= box.min.x - margin || x >= box.max.x + margin
          || z <= box.min.z - margin || z >= box.max.z + margin
        ) continue;
        let amount = x - (box.min.x - margin);
        let axisX = true;
        let value = box.min.x - margin;
        const positiveXAmount = box.max.x + margin - x;
        if (positiveXAmount < amount) {
          amount = positiveXAmount;
          value = box.max.x + margin;
        }
        const negativeZAmount = z - (box.min.z - margin);
        if (negativeZAmount < amount) {
          amount = negativeZAmount;
          axisX = false;
          value = box.min.z - margin;
        }
        const positiveZAmount = box.max.z + margin - z;
        if (positiveZAmount < amount) {
          axisX = false;
          value = box.max.z + margin;
        }
        if (axisX) x = value;
        else z = value;
      }
      const dx = -Math.sin(angle) * route.radiusX;
      const dz = Math.cos(angle) * route.radiusZ;
      const yaw = Math.atan2(dx, dz);
      const groundY = sampleMonsoonHeight(x, z, this.seed);
      const aheadX = x + Math.sin(yaw) * 0.7;
      const aheadZ = z + Math.cos(yaw) * 0.7;
      const behindX = x - Math.sin(yaw) * 0.7;
      const behindZ = z - Math.cos(yaw) * 0.7;
      const slopePitch = Math.atan2(
        sampleMonsoonHeight(aheadX, aheadZ, this.seed) - sampleMonsoonHeight(behindX, behindZ, this.seed),
        1.4,
      );
      const gait = time * 3.65 + route.phase * 2.7;
      const bob = Math.abs(Math.sin(gait * 2)) * 0.035;
      animal.mesh.position.set(x, groundY + 0.19, z);
      animal.mesh.rotation.set(-slopePitch, yaw, 0);
      animal.spine.position.y = 1.08 + bob;
      animal.spine.rotation.x = Math.sin(gait * 2) * 0.018;
      animal.head.rotation.x = -Math.sin(gait * 2 + 0.4) * 0.055 - slopePitch * 0.24;
      animal.head.rotation.y = Math.sin(time * 0.72 + route.phase) * 0.12;
      animal.tail.rotation.x = -0.08 + Math.sin(gait * 1.1 + route.phase) * 0.24;
      animal.tail.rotation.z = Math.sin(gait * 1.6) * 0.18;
      for (let leg = 0; leg < 4; leg += 1) {
        const diagonalPhase = leg === 0 || leg === 3 ? 0 : Math.PI;
        const stride = Math.sin(gait + diagonalPhase);
        const swingLift = Math.max(0, Math.sin(gait + diagonalPhase + 0.34));
        animal.hips[leg].rotation.x = stride * 0.52;
        animal.knees[leg].rotation.x = -0.1 - swingLift * 0.72;
      }
      matrix.compose(
        this.ambientPosition.set(x, groundY + 0.025, z),
        this.ambientShadowQuaternion,
        this.ambientScale.set(1.25, 0.72, 1),
      );
      shadows.setMatrixAt(index, matrix);
    }
    for (let index = 0; index < beetles.count; index += 1) {
      const lane = index % 4;
      const phase = index * 1.813 + time * (0.34 + lane * 0.035);
      const centerX = [-82, 78, -64, 66][lane];
      const centerZ = [43, 37, -54, -58][lane];
      const x = centerX + Math.cos(phase) * (3.2 + index % 3);
      const z = centerZ + Math.sin(phase) * (2.2 + index % 4);
      const y = sampleMonsoonHeight(x, z, this.seed) + 0.18;
      quaternion.setFromEuler(this.ambientEuler.set(0, -phase + Math.PI * 0.5, 0));
      matrix.compose(
        this.ambientPosition.set(x, y, z),
        quaternion,
        this.ambientScale.set(0.76, 0.42, 1.08),
      );
      beetles.setMatrixAt(index, matrix);
    }
    for (let index = 0; index < birds.count; index += 1) {
      const phase = index / birds.count * Math.PI * 2 + time * (0.07 + index * 0.0015);
      const radius = 105 + (index % 4) * 18;
      const x = Math.cos(phase) * radius;
      const z = Math.sin(phase) * radius;
      const y = 63 + Math.sin(phase * 2.2) * 9 + (index % 3) * 4;
      quaternion.setFromEuler(this.ambientEuler.set(
        Math.sin(phase * 3) * 0.08,
        -phase + Math.PI * 0.5,
        Math.sin(time * 2 + index) * 0.12,
      ));
      matrix.compose(
        this.ambientPosition.set(x, y, z),
        quaternion,
        this.ambientScale.set(1.6, 1.6, 1.6),
      );
      birds.setMatrixAt(index, matrix);
    }
    shadows.instanceMatrix.needsUpdate = true;
    beetles.instanceMatrix.needsUpdate = true;
    birds.instanceMatrix.needsUpdate = true;
  }

  private createStormRain(): void {
    const count = window.matchMedia('(pointer: coarse)').matches ? 220 : 620;
    const random = randomFactory(this.seed ^ 0x57024d11);
    const positions = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      positions[index * 3] = -230 + random() * 260;
      positions[index * 3 + 1] = -4 + random() * 120;
      positions[index * 3 + 2] = -230 + random() * 260;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.ShaderMaterial({
      name: 'MonsoonStormRain',
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: this.weatherUniforms,
      vertexShader: `
        uniform float uTime;
        uniform float uWind;
        uniform vec2 uWindDirection;
        uniform float uIntensity;
        varying float vFade;
        void main() {
          vec3 p = position;
          p.y = mod(position.y - uTime * 31.0 + 10.0, 120.0) - 10.0;
          float gust = sin(dot(position.xz, vec2(0.08, 0.053)) + uTime * 0.7) * uWind * 1.5
            - uTime * uWind * 0.42;
          p.xz += uWindDirection * gust;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = clamp(14.0 / -mv.z, 1.0, 4.0);
          vFade = smoothstep(0.0, 20.0, p.y) * (1.0 - smoothstep(90.0, 118.0, p.y)) * uIntensity;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        varying float vFade;
        void main() {
          vec2 p = gl_PointCoord - 0.5;
          float streak = smoothstep(0.16, 0.0, abs(p.x)) * smoothstep(0.52, 0.1, abs(p.y));
          gl_FragColor = vec4(0.55, 0.82, 1.0, streak * vFade * 0.46);
        }
      `,
    });
    this.geometries.push(geometry);
    this.materials.push(material);
    const rain = new THREE.Points(geometry, material);
    rain.name = 'MonsoonStormFrontRain';
    rain.frustumCulled = false;
    this.group.add(rain);
  }
}
