import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { acceleratedRaycast, MeshBVH } from 'three-mesh-bvh';
import { assetUrl } from '../assets/assetUrl';
import type { WeatherGameplaySnapshot, WeatherPhase } from '../systems/WeatherGameplaySystem';
import { GroundCoverCulling, partitionGroundCover, type GroundCoverProfile } from '../systems/GroundCoverCulling';
import { MOVEMENT } from './config';
import {
  MONSOON_DIVIDE,
  MONSOON_INNER_LOOP_SAMPLES,
  MONSOON_WORLD_SCALE,
  buildMonsoonTerrainGeometry,
  mapSeedFromLocation,
  sampleMonsoonMeshHeight,
  sampleMonsoonMeshNormal,
  sampleMonsoonMasks,
} from './maps/MonsoonDivide';
import {
  buildLaunchRamp,
  buildTerrainRibbonGeometry,
  type FlowSurfaceBuild,
  type LaunchRampSpec,
} from './maps/FlowGeometry';
import { QuickSenseArena } from './maps/QuickSenseArena';
import { Bipbeta2Arena } from './maps/Bipbeta2Arena';
import { buildMonsoonDistantWorld } from './maps/MonsoonDistantWorld';
import { buildMonsoonEncounterArt } from './maps/MonsoonEncounterArt';
import { buildMonsoonOutpostTowers } from './maps/MonsoonOutpostTowers';
import { buildMonsoonRouteInfrastructure } from './maps/MonsoonRouteInfrastructure';
import { buildMonsoonWorldArt } from './maps/MonsoonWorldArt';
import { buildMonsoonRockField, type MonsoonRockFieldBuild } from './maps/MonsoonRockField';

// Runtime placement, traversal, and support all use the exact rendered
// triangles. The analytic field remains the terrain generator's source only.
const sampleMonsoonHeight = sampleMonsoonMeshHeight;
const sampleMonsoonNormal = sampleMonsoonMeshNormal;

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
  prepareRender?(camera: THREE.PerspectiveCamera): void;
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
  /** Optional world-space support normal for props that must sit flush on ramps. */
  surfaceNormalAt?(x: number, z: number, fromY?: number): THREE.Vector3 | null;
  segmentHitDetails(start: THREE.Vector3, end: THREE.Vector3): SurfaceHit | null;
  /** Player CCD query. Maps may exclude rideable tops and hitscan-only proxies. */
  movementSegmentHitDetails(start: THREE.Vector3, end: THREE.Vector3): SurfaceHit | null;
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
  renderWithConcreteKit: boolean;
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
  [-99, 64], [89, 68], [-60, -58], [51, -73],
  [-158, 90], [153, 79], [-130, -101], [160, -40],
  [-75, 130], [75, 130], [-179, 33], [176, 28],
  [6, -140], [-10, 130], [-109, -22],
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
// Player-scale interactables stay at the proven release dimensions even
// though Monsoon's horizontal/vertical world footprint is now doubled.
const MONSOON_PLAYER_ART_SCALE = 2;

function mw(value: number): number {
  return value * MONSOON_WORLD_SCALE;
}

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
  const worldX = mw(x);
  const worldZ = mw(z);
  return new THREE.Vector3(worldX, sampleMonsoonHeight(worldX, worldZ, seed) + offset, worldZ);
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
  // Keep the original airtime while covering the doubled route distance.
  // Scaling time with the enlarged world made pads nearly vertical and left
  // them short of their authored landing shelves.
  const scaledFlightTime = flightTime * MONSOON_PLAYER_ART_SCALE;
  const velocity = new THREE.Vector3(
    (target.x - position.x) / scaledFlightTime,
    (target.y - position.y + 0.5 * MOVEMENT.gravity * scaledFlightTime * scaledFlightTime) / scaledFlightTime,
    (target.z - position.z) / scaledFlightTime,
  );
  return {
    position,
    direction: velocity.clone().normalize(),
    radius: 4.2 * MONSOON_PLAYER_ART_SCALE,
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
  private readonly weatherResponsiveMaterials: Array<{
    material: THREE.MeshStandardMaterial;
    dryRoughness: number;
    wetRoughness: number;
  }> = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly groundCoverCulling = new GroundCoverCulling();
  private readonly textures: THREE.Texture[] = [];
  private readonly colliders: ArenaCollider[] = [];
  private readonly rampSurfaces: RampSurface[] = [];
  private readonly platformSurfaces: PlatformSurface[] = [];
  private readonly concreteBoxes: THREE.Box3[] = [];
  private rockField!: MonsoonRockFieldBuild;
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
    uDeep: { value: new THREE.Color(0x103f58) },
    uShallow: { value: new THREE.Color(0x43869a) },
    uSun: { value: new THREE.Color(0xb9d7d3) },
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
  private rain?: THREE.LineSegments;
  private lightning?: THREE.LineSegments;
  private lightningMaterial?: THREE.LineBasicMaterial;
  private distantWorldUpdate?: (deltaSeconds: number, weatherSeverity: number) => void;
  private lastDistantWorldTime = 0;
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
    const map = new URLSearchParams(window.location.search).get('map');
    if (map === 'bipbeta2') {
      return Bipbeta2Arena.load(mapSeedFromLocation());
    }
    if (map === 'quicksense') {
      return QuickSenseArena.load(mapSeedFromLocation());
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
    return new Arena(
      mapSeedFromLocation(),
      skyTexture,
    );
  }

  private constructor(
    seed: number,
    skyTexture?: THREE.Texture,
  ) {
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
      normalScale: new THREE.Vector2(0.48, 0.48),
      roughnessMap: terrainTextures.roughness,
      roughness: 0.92,
      metalness: 0.015,
    });
    terrainMaterial.name = 'MonsoonPanoramaMatchedTerrainPBR';
    this.materials.push(terrainMaterial);
    this.weatherResponsiveMaterials.push({ material: terrainMaterial, dryRoughness: 0.92, wetRoughness: 0.5 });
    this.geometries.push(terrain.geometry);
    const terrainMesh = new THREE.Mesh(terrain.geometry, terrainMaterial);
    terrainMesh.name = 'MonsoonDivideTerrain';
    terrainMesh.receiveShadow = true;
    this.group.add(terrainMesh);

    this.registerGameplayColliders();
    this.registerConcreteTraversal();
    this.registerCoverLayout();
    const worldArt = buildMonsoonWorldArt(seed);
    this.group.add(worldArt.group);
    this.geometries.push(...worldArt.geometries);
    this.materials.push(...worldArt.materials);
    for (const material of worldArt.materials) {
      if (material instanceof THREE.MeshStandardMaterial) {
        this.weatherResponsiveMaterials.push({
          material,
          dryRoughness: material.roughness,
          wetRoughness: Math.max(0.18, material.roughness * 0.56),
        });
      }
    }
    this.textures.push(...worldArt.textures);
    worldArt.colliderBoxes.forEach((box, index) => {
      this.colliders.push({ name: `world-art-anchor-${index + 1}`, box });
    });
    this.group.userData.worldArt = worldArt.diagnostics;
    const encounterArt = buildMonsoonEncounterArt(seed);
    this.group.add(encounterArt.group);
    this.geometries.push(...encounterArt.geometries);
    this.materials.push(...encounterArt.materials);
    for (const material of encounterArt.materials) {
      if (material instanceof THREE.MeshStandardMaterial) {
        this.weatherResponsiveMaterials.push({
          material,
          dryRoughness: material.roughness,
          wetRoughness: Math.max(0.18, material.roughness * 0.56),
        });
      }
    }
    this.textures.push(...encounterArt.textures);
    encounterArt.colliderBoxes.forEach((box, index) => {
      this.colliders.push({ name: `encounter-art-${index + 1}`, box });
    });
    this.group.userData.encounterArt = encounterArt.diagnostics;
    const routeInfrastructure = buildMonsoonRouteInfrastructure(seed);
    this.group.add(routeInfrastructure.group);
    this.geometries.push(...routeInfrastructure.geometries);
    this.materials.push(...routeInfrastructure.materials);
    for (const material of routeInfrastructure.materials) {
      if (material instanceof THREE.MeshStandardMaterial) {
        this.weatherResponsiveMaterials.push({
          material,
          dryRoughness: material.roughness,
          wetRoughness: Math.max(0.16, material.roughness * 0.52),
        });
      }
    }
    this.textures.push(...routeInfrastructure.textures);
    this.group.userData.routeInfrastructure = routeInfrastructure.diagnostics;
    const preexistingOutpostColliders = this.colliders.slice();
    const preexistingOutpostRamps = this.rampSurfaces.slice();
    const outpostTowers = buildMonsoonOutpostTowers(seed);
    this.group.add(outpostTowers.group);
    this.geometries.push(...outpostTowers.geometries);
    this.materials.push(...outpostTowers.materials);
    for (const material of outpostTowers.materials) {
      if (material instanceof THREE.MeshStandardMaterial) {
        this.weatherResponsiveMaterials.push({
          material,
          dryRoughness: material.roughness,
          wetRoughness: Math.max(0.14, material.roughness * 0.5),
        });
      }
    }
    this.textures.push(...outpostTowers.textures);
    for (const collider of outpostTowers.colliderBoxes) {
      this.colliders.push({ name: collider.name, box: collider.box });
    }
    this.platformSurfaces.push(...outpostTowers.platformSurfaces);
    for (const stairRamp of outpostTowers.stairRamps) {
      const spec = stairRamp.spec;
      const forwardX = Math.sin(spec.heading);
      const forwardZ = Math.cos(spec.heading);
      this.rampSurfaces.push({
        name: stairRamp.name,
        centerX: spec.origin.x + forwardX * spec.length * 0.5,
        centerZ: spec.origin.z + forwardZ * spec.length * 0.5,
        startY: spec.origin.y,
        length: spec.length,
        width: spec.width,
        rise: spec.rise,
        yaw: spec.heading,
        spec,
        flow: buildLaunchRamp(spec),
        // The tower factory supplies individual treads, stringers, rails, and
        // route lights. The smooth surface is collision-only so the visible
        // stairs retain their player-scale stepped silhouette.
        renderWithConcreteKit: false,
      });
    }
    const integrationClearanceConflicts = outpostTowers.stairRamps.flatMap(({ name, spec }) => {
      if (!name.includes('internal switchback')) return [];
      const x = spec.origin.x + Math.sin(spec.heading) * spec.length * 0.5;
      const z = spec.origin.z + Math.cos(spec.heading) * spec.length * 0.5;
      const y = spec.origin.y + spec.rise * 0.5;
      const colliderConflicts = preexistingOutpostColliders
        .filter(({ box }) => (
          x + MOVEMENT.playerRadius > box.min.x && x - MOVEMENT.playerRadius < box.max.x
          && z + MOVEMENT.playerRadius > box.min.z && z - MOVEMENT.playerRadius < box.max.z
          && y + MOVEMENT.playerHeight > box.min.y && y < box.max.y
        ))
        .map(({ name: colliderName }) => ({ stair: name, collider: colliderName }));
      const rampConflicts = preexistingOutpostRamps
        .filter((ramp) => {
          const rampY = ramp.flow.heightAt(x, z);
          if (rampY === null) return false;
          const bottomY = ramp.spec.origin.y
            - (ramp.spec.collisionSkirtDepth ?? ramp.spec.skirtDepth ?? 0.8);
          return y < rampY - 0.015 && y + MOVEMENT.playerHeight > bottomY + 0.01;
        })
        .map(({ name: rampName }) => ({ stair: name, collider: `ramp:${rampName}` }));
      return [...colliderConflicts, ...rampConflicts];
    });
    this.group.userData.outpostTowers = {
      ...outpostTowers.diagnostics,
      reviewViews: outpostTowers.reviewViews,
      stairRamps: outpostTowers.stairRamps.map(({ name, spec }) => ({ name, spec })),
      integrationClearanceConflicts,
    };
    const distantWorld = buildMonsoonDistantWorld(seed);
    this.group.add(distantWorld.group);
    this.geometries.push(...distantWorld.geometries);
    this.materials.push(...distantWorld.materials);
    this.textures.push(...distantWorld.textures);
    this.distantWorldUpdate = distantWorld.update;
    this.group.userData.distantWorld = distantWorld.diagnostics;
    // Place rocks after every building, platform, and stair is registered so
    // the entire boulder footprint can respect their approaches.
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
    this.createRouteGates(toonRamp);
    this.createJumpPadVisuals(toonRamp);
    this.createConcreteTraversal(toonRamp);
    this.createDetailedDirtRoutes(toonRamp);
    this.createStormPuddles();
    this.createCoreReactor(toonRamp);
    this.createVegetation(toonRamp);
    this.createGroundMarks();
    this.createAmbientLife(toonRamp);
    this.createStormRain();
    this.createStormLightning();

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

    // CALM must read as genuinely calm. The old non-zero floor left pale
    // streaks across every establishing shot even while the HUD said CALM;
    // precipitation now ramps in with the authored storm severity.
    const rainIntensity = THREE.MathUtils.smoothstep(shower, 0.08, 1) * 0.9;
    this.waterUniforms.uTime.value = time;
    this.weatherUniforms.uTime.value = time;
    this.weatherUniforms.uIntensity.value = rainIntensity;
    this.weatherUniforms.uWind.value = wind;
    this.weatherUniforms.uWindDirection.value.set(windDirectionX, windDirectionZ);
    const distantWorldDelta = Math.max(0, time - this.lastDistantWorldTime);
    this.lastDistantWorldTime = time;
    this.distantWorldUpdate?.(distantWorldDelta, shower);
    if (this.rain) this.rain.position.set(this.playerInfluence.x, this.playerInfluence.y - 20, this.playerInfluence.z);
    if (this.lightning && this.lightningMaterial) {
      const strike = shower > 0.72;
      this.lightning.visible = strike;
      this.lightningMaterial.opacity = strike
        ? 0.42 + (reducedMotion ? 0.22 : Math.max(0, Math.sin(time * 17.3)) * 0.5)
        : 0;
    }
    this.grassUniforms.uTime.value = time;
    this.grassUniforms.uWind.value = wind;
    this.grassUniforms.uWindDirection.value.set(windDirectionX, windDirectionZ);
    this.grassUniforms.uPlayer.value.copy(this.playerInfluence);
    this.weatherVisualDiagnostics.rainIntensity = rainIntensity;
    this.weatherVisualDiagnostics.visualWindStrength = wind;
    this.weatherVisualDiagnostics.windDirection.x = windDirectionX;
    this.weatherVisualDiagnostics.windDirection.z = windDirectionZ;
    for (const responsive of this.weatherResponsiveMaterials) {
      responsive.material.roughness = THREE.MathUtils.lerp(
        responsive.dryRoughness,
        responsive.wetRoughness,
        shower,
      );
    }
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

  prepareRender(camera: THREE.PerspectiveCamera): void {
    this.groundCoverCulling.update(camera);
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

    // The ordinary snap range is intentionally short, but it must not become
    // a one-way trap. A steep ramp transition or a lateral solid correction
    // can put the feet farther below a valid floor than that snap range in one
    // substep. Probe the part of the vertical span already occupied by the
    // capsule so such penetration is recovered without selecting roofs above
    // the player's head or surfaces on another level.
    const floorRecoveryReach = Math.max(
      MOVEMENT.groundSnapDistance + 0.08,
      Math.min(
        Math.max(0, height - MOVEMENT.collisionSkin),
        MOVEMENT.groundSnapDistance + MOVEMENT.stepHeight + MOVEMENT.maxSubstepDistance + 0.08,
      ),
    );
    let floorFlags = this.resolveFloorContact(position, velocity, floorRecoveryReach);
    if ((floorFlags & 1) !== 0) contacts += 1;
    grounded = (floorFlags & 2) !== 0;

    // A single endpoint recovery can be pushed from one overlapping proxy
    // directly into its neighbour at structure corners. A second pass runs
    // only after an actual solid correction and closes that corner escape
    // without multiplying the normal open-terrain cost.
    let solidCorrected = false;
    for (let pass = 0; pass < 2; pass += 1) {
      let passCorrected = false;
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
        passCorrected = true;
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
        passCorrected = true;
        contacts += 1;
      }
      if (!passCorrected) break;
      solidCorrected = true;
    }

    // Lateral recovery changes which terrain/ramp/platform is under the feet.
    // Re-seat against that final support instead of carrying the old height
    // into the next frame (where it may already be outside the snap window).
    if (solidCorrected) {
      floorFlags = this.resolveFloorContact(position, velocity, floorRecoveryReach);
      grounded = (floorFlags & 2) !== 0;
      if ((floorFlags & 1) !== 0) contacts += 1;
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

  /** Bit 0 = floor contact, bit 1 = walkable grounded contact. */
  private resolveFloorContact(
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    recoveryReach: number,
  ): number {
    const floorSurface = this.floorSurfaceAt(
      position.x,
      position.z,
      position.y + recoveryReach,
    );
    if (floorSurface === null) return 0;
    this.contactNormal.copy(floorSurface.normal);
    const gap = position.y - floorSurface.height;
    const snap = velocity.y <= 0.5 && gap <= MOVEMENT.groundSnapDistance + 0.025;
    if (gap > 0.015 && !snap) return 0;
    const correctionY = floorSurface.height - position.y;
    position.y = floorSurface.height;
    this.correction.y += correctionY;
    const intoSurface = velocity.dot(this.contactNormal);
    if (intoSurface < 0) velocity.addScaledVector(this.contactNormal, -intoSurface);
    // ClipVelocity only. PM_StepSlideMove ramp preserve (restore pre-move 2D
    // speed, keep this Z, un-ground if Z is a launch) lives in Game.pmove.
    // Grounding depends on separation from the contact plane, not world-Y
    // velocity. A skier climbing a ramp can have strong upward velocity while
    // remaining exactly tangent to the riding surface.
    const grounded = this.contactNormal.y >= MOVEMENT.maxSlopeCosine && intoSurface <= 1.2;
    return grounded ? 3 : 1;
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
    const bottomY = ramp.spec.origin.y - (ramp.spec.collisionSkirtDepth ?? ramp.spec.skirtDepth ?? 0.8);
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

  /** Support normal of the highest floor at or below `fromY` (shared scratch; copy to keep). */
  surfaceNormalAt(x: number, z: number, fromY = Number.POSITIVE_INFINITY): THREE.Vector3 | null {
    return this.floorSurfaceAt(x, z, fromY)?.normal ?? null;
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

  movementSegmentHitDetails(start: THREE.Vector3, end: THREE.Vector3): SurfaceHit | null {
    return this.segmentHitDetails(start, end);
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
    this.groundCoverCulling.clear();
    this.group.traverse((object) => {
      if ((object as THREE.SkinnedMesh).isSkinnedMesh) (object as THREE.SkinnedMesh).skeleton.dispose();
      if ((object as THREE.InstancedMesh).isInstancedMesh) (object as THREE.InstancedMesh).dispose();
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
    const relief = new Float32Array(size * size);
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
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const pixel = y * size + x;
        const broad = smooth[pixel] - 0.5;
        const strata = Math.sin(y * 0.31 + smooth[pixel] * 19 + Math.sin(x * 0.08) * 1.4);
        const runoff = Math.pow(Math.max(0, Math.sin(x * 0.2 + smooth[pixel] * 15)), 7);
        relief[pixel] = smooth[pixel] + (raw[pixel] - 0.5) * 0.055 + strata * 0.026 + runoff * 0.018 + broad * 0.04;
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
        const strata = Math.sin(y * 0.31 + smooth[pixel] * 19 + Math.sin(x * 0.08) * 1.4);
        const runoff = Math.pow(Math.max(0, Math.sin(x * 0.2 + smooth[pixel] * 15)), 7);
        albedoData[channel] = THREE.MathUtils.clamp(190 + broad * 68 + grain * 17 + strata * 8 - runoff * 24 - lichen * 44, 126, 231);
        albedoData[channel + 1] = THREE.MathUtils.clamp(201 + broad * 61 + grain * 13 + strata * 5 - runoff * 17 + lichen * 14, 136, 236);
        albedoData[channel + 2] = THREE.MathUtils.clamp(197 + broad * 70 + grain * 11 - strata * 6 - runoff * 13 - lichen * 10, 132, 236);
        albedoData[channel + 3] = 255;

        const dx = (sample(relief, x - 1, y) - sample(relief, x + 1, y)) * 4.8;
        const dy = (sample(relief, x, y - 1) - sample(relief, x, y + 1)) * 4.8;
        const inverseLength = 1 / Math.hypot(dx, dy, 1);
        normalData[channel] = (dx * inverseLength * 0.5 + 0.5) * 255;
        normalData[channel + 1] = (dy * inverseLength * 0.5 + 0.5) * 255;
        normalData[channel + 2] = inverseLength * 255;
        normalData[channel + 3] = 255;

        const roughness = THREE.MathUtils.clamp(214 + broad * 38 - grain * 13 + lichen * 72 - runoff * 48 + Math.abs(strata) * 8, 150, 250);
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
      texture.repeat.set(84, 70);
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
      const worldX = mw(x);
      const worldZ = mw(z);
      const y = sampleMonsoonHeight(worldX, worldZ, this.seed);
      this.colliders.push({
        name,
        box: new THREE.Box3(
          new THREE.Vector3(worldX - mw(halfX), y, worldZ - mw(halfZ)),
          new THREE.Vector3(worldX + mw(halfX), y + mw(height), worldZ + mw(halfZ)),
        ),
      });
    };
    add('flux-core', 0, 0, 4.45, 8.5, 4.45);
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
    const structureBoxes = [
      ...this.colliders.map(({ box }) => box),
      ...this.concreteBoxes,
      ...this.platformSurfaces.map((platform) => new THREE.Box3(
        new THREE.Vector3(platform.minX, 0, platform.minZ), new THREE.Vector3(platform.maxX, 0, platform.maxZ),
      )),
      ...this.rampSurfaces.map((ramp) => {
        ramp.flow.geometry.computeBoundingBox();
        return ramp.flow.geometry.boundingBox!;
      }),
    ];
    this.rockField = buildMonsoonRockField(this.seed, (x, z, radius) => (
      structureBoxes.some((box) => Math.hypot(
        x - THREE.MathUtils.clamp(x, box.min.x - 3, box.max.x + 3),
        z - THREE.MathUtils.clamp(z, box.min.z - 3, box.max.z + 3),
      ) <= radius)
    ));
    this.colliders.push(...this.rockField.colliderBoxes);
    this.geometries.push(...this.rockField.geometries);
    this.materials.push(this.rockField.material);
    this.textures.push(...this.rockField.textures);
    this.weatherResponsiveMaterials.push({ material: this.rockField.material, dryRoughness: 0.94, wetRoughness: 0.67 });
    this.group.userData.rockField = this.rockField.diagnostics;
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
        // Sample beyond the visible side edge as well as beneath it. Mountain
        // terrain can fall away sharply just outside a wide ramp; limiting the
        // probe to the riding surface left a crouch-height walk-through gap
        // below the fascia even though the authored ramp was marked solid.
        for (const across of [-0.62, -0.48, 0, 0.48, 0.62]) {
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
        renderWithConcreteKit: true,
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
      centerX = mw(centerX);
      centerZ = mw(centerZ);
      const width = mw(25);
      const depth = mw(18);
      const height = mw(7.6);
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
      addConcreteBox(`${name}-back`, makeBox(backX, baseY + height * 0.5, centerZ, mw(1.1), height, depth));
      addConcreteBox(`${name}-north`, makeBox(centerX, baseY + height * 0.5, centerZ - depth * 0.5, width, height, mw(1.1)));
      addConcreteBox(`${name}-south`, makeBox(centerX, baseY + height * 0.5, centerZ + depth * 0.5, width, height, mw(1.1)));

      const entranceX = centerX + (openSide === 'east' ? width * 0.5 : -width * 0.5);
      const openingWidth = mw(7.2);
      const wingDepth = (depth - openingWidth) * 0.5;
      for (const side of [-1, 1]) {
        addConcreteBox(
          `${name}-entrance-wing-${side}`,
          makeBox(
            entranceX,
            baseY + height * 0.5,
            centerZ + side * (openingWidth * 0.5 + wingDepth * 0.5),
            mw(1.1),
            height,
            wingDepth,
          ),
        );
      }

      const parapetY = roof.max.y + mw(0.38);
      addConcreteBox(`${name}-roof-back-parapet`, makeBox(backX, parapetY, centerZ, mw(0.72), mw(0.76), depth));
      addConcreteBox(`${name}-roof-north-parapet`, makeBox(centerX, parapetY, centerZ - depth * 0.5, width, mw(0.76), mw(0.72)));
      addConcreteBox(`${name}-roof-south-parapet`, makeBox(centerX, parapetY, centerZ + depth * 0.5, width, mw(0.76), mw(0.72)));

      const serviceX = centerX + (openSide === 'east' ? -mw(5.2) : mw(5.2));
      const serviceCabin = makeBox(serviceX, roof.max.y + mw(1.25), centerZ - mw(1.2), mw(7.2), mw(2.5), mw(6.4));
      addConcreteBox(`${name}-roof-service-cabin`, serviceCabin);
      addPlatform(`${name}-roof-service-cabin`, serviceCabin);

      const outward = openSide === 'east' ? 1 : -1;
      const approachX = entranceX + outward * mw(32);
      const landingX = entranceX - outward * mw(1.8);
      addRamp(
        `${name}-roof-access`,
        approachX,
        centerZ + depth * 0.28,
        landingX,
        centerZ + depth * 0.28,
        mw(16),
        0,
        undefined,
        roof.max.y + 0.025,
      );
    };

    // Six wide launch ramps cross the main valleys. Their low ends meet the
    // terrain and their raised lips create predictable race jumps at speed.
    addRamp('west-core-launch', mw(-119), mw(58), mw(-88), mw(39), mw(13), mw(7.2));
    addRamp('east-core-launch', mw(121), mw(53), mw(90), mw(37), mw(13), mw(7.4));
    // Keep the lip compact enough that a banked Katabatic-style approach
    // converts speed into airtime instead of spending the whole run climbing.
    addRamp('southwest-launch', mw(-118), mw(-82), mw(-92), mw(-62), mw(14), mw(8.2));
    addRamp('southeast-launch', mw(119), mw(-86), mw(84), mw(-60), mw(14), mw(8.4));
    addRamp('north-divide-launch', mw(0), mw(127), mw(0), mw(94), mw(16), mw(8.8));
    addRamp('south-divide-launch', mw(0), mw(-137), mw(0), mw(-102), mw(16), mw(9.2));

    addBuilding('west-relay-bunker', -132, 111, 'east');
    addBuilding('east-weather-station', 132, 96, 'west');

    // A broad two-way underpass adds a real interior route without breaking
    // the north/south ski line; the roof is another playable platform.
    const tunnelX = mw(42);
    const tunnelZ = mw(-96);
    const tunnelWidth = mw(30);
    const tunnelDepth = mw(32);
    const tunnelBase = Math.max(
      sampleMonsoonHeight(tunnelX - mw(10), tunnelZ, this.seed),
      sampleMonsoonHeight(tunnelX + mw(10), tunnelZ, this.seed),
    ) + 0.2;
    const tunnelFloor = makeBox(tunnelX, tunnelBase, tunnelZ, tunnelWidth, mw(0.44), tunnelDepth);
    const tunnelRoof = makeBox(tunnelX, tunnelBase + mw(7.2), tunnelZ, tunnelWidth, mw(0.62), tunnelDepth);
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
          tunnelWidth - mw(0.5),
          tunnelFoundationTop - tunnelFoundationBottom,
          tunnelDepth - mw(0.5),
        ),
      );
    }
    addConcreteBox('south-underpass-west-wall', makeBox(tunnelX - tunnelWidth * 0.5, tunnelBase + mw(3.6), tunnelZ, mw(1.1), mw(7.2), tunnelDepth));
    addConcreteBox('south-underpass-east-wall', makeBox(tunnelX + tunnelWidth * 0.5, tunnelBase + mw(3.6), tunnelZ, mw(1.1), mw(7.2), tunnelDepth));
    addConcreteBox('south-underpass-roof-west-parapet', makeBox(tunnelX - tunnelWidth * 0.5, tunnelRoof.max.y + mw(0.4), tunnelZ, mw(0.72), mw(0.8), tunnelDepth));
    addConcreteBox('south-underpass-roof-north-parapet', makeBox(tunnelX, tunnelRoof.max.y + mw(0.4), tunnelZ - tunnelDepth * 0.5, tunnelWidth, mw(0.8), mw(0.72)));
    addConcreteBox('south-underpass-roof-south-parapet', makeBox(tunnelX, tunnelRoof.max.y + mw(0.4), tunnelZ + tunnelDepth * 0.5, tunnelWidth, mw(0.8), mw(0.72)));
    addRamp(
      'south-underpass-roof-access',
      tunnelX + tunnelWidth * 0.5 + mw(30),
      tunnelZ + mw(8),
      tunnelX + tunnelWidth * 0.5 - mw(1.8),
      tunnelZ + mw(8),
      mw(16),
      0,
      undefined,
      tunnelRoof.max.y + 0.025,
    );
  }

  /**
   * Deck-17 / Katabatic cover pass: low hard cover at every pickup, mid-bowl
   * sightline breakers, and a visible perimeter berm just inside the AABB.
   * Collision is registered here so the merged BVH matches the concrete mesh.
   */
  private registerCoverLayout(): void {
    const addWorldBox = (
      name: string,
      x: number,
      z: number,
      width: number,
      minY: number,
      maxY: number,
      depth: number,
    ): void => {
      const box = new THREE.Box3(
        new THREE.Vector3(x - width * 0.5, minY, z - depth * 0.5),
        new THREE.Vector3(x + width * 0.5, maxY, z + depth * 0.5),
      );
      this.concreteBoxes.push(box);
      this.colliders.push({ name, box });
    };
    const addBox = (
      name: string,
      x: number,
      z: number,
      width: number,
      minY: number,
      maxY: number,
      depth: number,
    ): void => {
      addWorldBox(name, mw(x), mw(z), mw(width), minY, maxY, mw(depth));
    };
    const addGroundedBox = (
      name: string,
      x: number,
      z: number,
      width: number,
      height: number,
      depth: number,
    ): void => {
      const y = sampleMonsoonHeight(mw(x), mw(z), this.seed);
      addBox(name, x, z, width, y, y + mw(height), depth);
    };
    const supportYWorld = (worldX: number, worldZ: number): number => {
      let supportY = sampleMonsoonHeight(worldX, worldZ, this.seed);
      for (const platform of this.platformSurfaces) {
        if (
          worldX >= platform.minX && worldX <= platform.maxX
          && worldZ >= platform.minZ && worldZ <= platform.maxZ
        ) {
          supportY = Math.max(supportY, platform.y);
        }
      }
      for (const ramp of this.rampSurfaces) {
        const rampY = this.rampHeightAt(ramp, worldX, worldZ);
        if (rampY !== null) supportY = Math.max(supportY, rampY);
      }
      return supportY;
    };
    const supportYAt = (x: number, z: number): number => supportYWorld(mw(x), mw(z));
    const addWorldPickupCover = (
      name: string,
      worldX: number,
      worldZ: number,
      offsetX: number,
      offsetZ: number,
      width: number,
      depth: number,
    ): void => {
      const x = worldX + offsetX;
      const z = worldZ + offsetZ;
      const pickupY = supportYWorld(worldX, worldZ);
      const localY = supportYWorld(x, z);
      const wallHeight = 2.2;
      const wallBase = pickupY;
      const wallTop = pickupY + wallHeight;
      if (wallBase - localY > 0.28) {
        addWorldBox(`${name}-footing`, x, z, width * 0.78, localY, wallBase, depth * 0.78);
      }
      addWorldBox(name, x, z, width, wallBase, wallTop, depth);
    };
    const addPickupCover = (
      name: string,
      pickupX: number,
      pickupZ: number,
      offsetX: number,
      offsetZ: number,
      width: number,
      depth: number,
    ): void => {
      addWorldPickupCover(name, mw(pickupX), mw(pickupZ), offsetX, offsetZ, width, depth);
    };

    addPickupCover('rail-cover-west', -158, 96, -5, 0, 0.9, 3.1);
    addPickupCover('rail-cover-east', -158, 96, 5, 0, 0.85, 2.8);
    addPickupCover('rocket-cover-north', -148, -86, 0, 5, 2.8, 0.85);
    addWorldPickupCover('disc-cover-north', mw(-148) + 3.2, mw(-86) - 1.8, 0, 5, 2.8, 0.85);
    addWorldPickupCover('disc-cover-east', mw(-148) + 3.2, mw(-86) - 1.8, 5, 0, 0.85, 2.8);
    addPickupCover('sniper-cover-south', 139, 93, 0, -5, 3.2, 0.9);
    addPickupCover('damage-cover-east', 0, -31, 5, 0, 0.85, 2.8);
    addPickupCover('damage-cover-north', 0, -31, 0, 5, 2.8, 0.85);
    addPickupCover('health-a-cover-north', -58, -42, 0, 5, 2.8, 0.85);
    addPickupCover('health-a-cover-east', -58, -42, 5, 0, 0.85, 2.6);
    addPickupCover('health-b-cover-north', 68, 34, 0, 5, 2.8, 0.85);
    addPickupCover('health-b-cover-south', 68, 34, 0, -5, 2.8, 0.85);
    addPickupCover('armor-cover-east', -98, 28, 5, 0, 0.85, 2.8);
    addPickupCover('armor-cover-west', -98, 28, -5, 0, 0.85, 2.8);
    addPickupCover('speed-cover-south', 112, -88, 0, -7, 2.8, 0.85);
    addPickupCover('plasma-cover-north', 113, 63, 0, 5, 3.0, 0.9);
    addPickupCover('shotgun-cover-west', 16, -86, -5, 0, 0.85, 2.8);
    addPickupCover('laser-cover-east', -78, 136, 5, 0, 0.85, 2.8);
    // Local cubby at the east-slope pad. The old (125, −104) pad sat on ski
    // corridor 1; this pad is ~62 m off that line and behind the eastern
    // massif so west-ridge LOS dies in terrain instead of a midfield slab.
    addPickupCover('spawn-east-slope-west', 160, -40, -5, 0, 0.9, 3.1);
    addPickupCover('spawn-east-slope-south', 160, -40, 0, -5, 3.2, 0.9);
    // Deck-17 cubby on the north-rim pad. SPAWN (75, 130) → (−130, −101) is a
    // 309 m rail; 8 m along that chord is ~84 m off ski corridor 2. A bunker
    // wall here clips eye-height LOS without a fifth column at x≈110.
    addGroundedBox('spawn-north-east-cubby', 69.7, 124, 4.6, 5.8, 3.2);
    // Deck-17 cubby on the inner-west pad. SPAWN (153, 79) → (−109, −22) is a
    // 281 m rail; 8 m along that chord is ~45 m off ski corridor 2. The 8 m
    // step drops ~7 m into a ravine, so the lid is pad height + 5.8 m (not
    // local-grounded 5.8 m) or the eye ray flies over. Do not put a box at
    // x≈110, z≈62 — that ray is 18 m off the grade, inside halfWidth 20.
    {
      const cubbyX = -101.5;
      const cubbyZ = -19.1;
      const padY = supportYAt(-109, -22);
      const localY = supportYAt(cubbyX, cubbyZ);
      addBox('spawn-inner-west-cubby', cubbyX, cubbyZ, 4.6, Math.min(localY, padY), padY + mw(5.8), 3.2);
    }
    // Old pad (89, 55) sat 13 m off ski corridor 2 (inside halfWidth 20); the
    // 269 m rail to (−130, −101) ran 3–13 m off the grade. Nudge north to
    // (89, 68) (≥25 m off corridor 2), then a pad-height cubby 8 m along the
    // new chord. Do not wall corridor 2 and do not cubby the SW pad.
    {
      const cubbyX = 82.7;
      const cubbyZ = 63.1;
      const padY = supportYAt(89, 68);
      const localY = supportYAt(cubbyX, cubbyZ);
      addBox('spawn-inner-east-cubby', cubbyX, cubbyZ, 4.6, Math.min(localY, padY), padY + mw(5.8), 3.2);
    }
    // Leftover after maps B: (89, 68) → (−158, 90) is 248 m CLEAR. The SW
    // cubby at (82.7, 63.1) misses this chord. 8 m along it is (81.0, 68.7),
    // 27.6 m off corridor 2. Do not cubby (−158, 90) (8 m back is on corridor 1).
    {
      const cubbyX = 81.0;
      const cubbyZ = 68.7;
      const padY = supportYAt(89, 68);
      const localY = supportYAt(cubbyX, cubbyZ);
      addBox('spawn-inner-east-ridge-cubby', cubbyX, cubbyZ, 4.6, Math.min(localY, padY), padY + mw(5.8), 3.2);
    }
    // SPAWN (51, −73) → (−158, 90) is a 265 m rail along ski corridor 1.
    // 8 m along that chord is (44.7, −68.1), 25.8 m off the grade (outside
    // halfWidth 20). Pad-height lid — do not cubby (−158, 90) (7 m off
    // corridor 1) and do not drop a midfield wall on the ski.
    {
      const cubbyX = 44.7;
      const cubbyZ = -68.1;
      const padY = supportYAt(51, -73);
      const localY = supportYAt(cubbyX, cubbyZ);
      addBox('spawn-inner-south-cubby', cubbyX, cubbyZ, 4.6, Math.min(localY, padY), padY + mw(5.8), 3.2);
    }
    // SPAWN (−99, 64) → (153, 79) is a 252 m rail. 8 m along that chord sits
    // 17.6 m off ski corridor 1 (inside halfWidth 20). 24 m lands at
    // (−75.0, 65.4), off the grade. Pad-height lid — local floor drops 10.9 m.
    // Do not cubby (153, 79) (8 m back is on corridor 2) and do not wall the bowl.
    {
      const cubbyX = -75.0;
      const cubbyZ = 65.4;
      const padY = supportYAt(-99, 64);
      const localY = supportYAt(cubbyX, cubbyZ);
      addBox('spawn-northwest-cubby', cubbyX, cubbyZ, 4.6, Math.min(localY, padY), padY + mw(5.8), 3.2);
    }

    const midfieldBreakers: Array<{
      name: string;
      x: number;
      z: number;
      width: number;
      height: number;
      depth: number;
    }> = [
      { name: 'midfield-north-breaker', x: 8, z: 34, width: 4.6, height: 5.8, depth: 3.2 },
      { name: 'midfield-northwest-breaker', x: -32, z: 32, width: 3.8, height: 6.4, depth: 4.2 },
      { name: 'midfield-southeast-breaker', x: 32, z: -28, width: 4.2, height: 5.4, depth: 3.6 },
      // On the rocket (−148, −86) → sniper (139, 93) chord, past the ski
      // corridor. A bowl-floor 6 m box cannot reach that 38 m LOS.
      { name: 'midfield-rocket-sniper-breaker', x: 110, z: 75, width: 8.4, height: 48, depth: 6.2 },
      // Rail (−158, 96) → sniper (139, 93) is a 297 m east-west chord at z≈94.
      // The rocket-sniper box at z=75 misses it by ~15 m. Sniper sits inside
      // east-weather-station; a roof/cabin eye is ~52 m, so 16 m from terrain
      // 28 leaves the lid at 44 and the ray flies over.
      { name: 'midfield-rail-sniper-breaker', x: 109, z: 93, width: 8.4, height: 36, depth: 6.2 },
      // SPAWN (−158, 90) → (153, 79) is a 311 m shelf chord at z≈81, 2.4 m
      // north of the rocket box and 9.3 m south of the rail box. Eye ~60 m
      // over terrain ~23 m, so a 18 m lid cannot reach it.
      { name: 'midfield-spawn-shelf-breaker', x: 109, z: 81, width: 8.4, height: 52, depth: 6.2 },
      // SPAWN (153, 79) → (−130, −101) is a 335 m rail along ski corridor 2.
      // At x=110 the ray is z≈52, ~7.5 m north of the grade centerline
      // (halfWidth 20). A 5.2 m nunatak sits in that offset so the ski still
      // runs south of it; do not span the 40 m run with a wall.
      { name: 'ski-corridor-2-nunatak', x: 110.5, z: 52, width: 5.2, height: 36, depth: 5.2 },
    ];
    for (const breaker of midfieldBreakers) {
      addGroundedBox(breaker.name, breaker.x, breaker.z, breaker.width, breaker.height, breaker.depth);
    }

    // The ocean and hard arena bounds already close the play space. A former
    // rectangular concrete berm drew the implementation AABB across the water
    // and fought the island silhouette, so the natural cliff edge owns the
    // boundary presentation now.
  }

  private rampHeightAt(ramp: RampSurface, x: number, z: number): number | null {
    return ramp.flow.heightAt(x, z);
  }

  private createConcreteTraversal(_toonRamp: THREE.Texture): void {
    const texture = this.createConcreteTexture();
    const concrete = new THREE.MeshStandardMaterial({
      bumpMap: texture,
      bumpScale: 0.09,
      color: 0x9aabad,
      map: texture,
      roughness: 0.88,
      metalness: 0.07,
    });
    const routeApron = new THREE.MeshStandardMaterial({
      bumpMap: texture,
      bumpScale: 0.055,
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
    this.weatherResponsiveMaterials.push(
      { material: concrete, dryRoughness: 0.88, wetRoughness: 0.46 },
      { material: routeApron, dryRoughness: 0.96, wetRoughness: 0.58 },
    );

    const boxGeometry = new RoundedBoxGeometry(1, 1, 1, 1, 0.075);
    this.geometries.push(boxGeometry);
    const cubbyColliders = this.colliders.filter((collider) => collider.name.includes('cubby'));
    const cubbyBoxes = new Set(cubbyColliders.map((collider) => collider.box));
    const wrappedStormwallBoxes = new Set(this.colliders
      .filter((collider) => [
        'midfield-rocket-sniper-breaker',
        'midfield-rail-sniper-breaker',
        'midfield-spawn-shelf-breaker',
        'ski-corridor-2-nunatak',
      ].includes(collider.name))
      .map((collider) => collider.box));
    const structuralBoxes = this.concreteBoxes.filter((box) => (
      !cubbyBoxes.has(box) && !wrappedStormwallBoxes.has(box)
    ));
    const boxes = new THREE.InstancedMesh(boxGeometry, concrete, structuralBoxes.length);
    boxes.name = 'MonsoonEnterableConcreteStructures';
    const matrix = new THREE.Matrix4();
    const identity = new THREE.Quaternion();
    structuralBoxes.forEach((box, index) => {
      matrix.compose(box.getCenter(new THREE.Vector3()), identity, box.getSize(new THREE.Vector3()));
      boxes.setMatrixAt(index, matrix);
    });
    boxes.instanceMatrix.needsUpdate = true;
    boxes.castShadow = true;
    boxes.receiveShadow = true;

    const concreteKitRamps = this.rampSurfaces.filter((ramp) => ramp.renderWithConcreteKit);
    const rampParts = concreteKitRamps.map((ramp) => ramp.flow.geometry);
    const rampGeometry = mergeGeometries(rampParts, false);
    if (!rampGeometry) throw new Error('Failed to merge Monsoon concrete traversal ramps.');
    this.geometries.push(rampGeometry);
    const ramps = new THREE.Mesh(rampGeometry, concrete);
    ramps.name = 'MonsoonConcreteSkiLaunchRamps';
    ramps.castShadow = true;
    ramps.receiveShadow = true;

    const apronParts: THREE.BufferGeometry[] = [];
    for (const ramp of concreteKitRamps) {
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
        start: { x: start.x - forwardX * mw(8.5), z: start.z - forwardZ * mw(8.5) },
        end: { x: start.x + forwardX * mw(1.6), z: start.z + forwardZ * mw(1.6) },
        startWidth: ramp.width + mw(5.2),
        endWidth: ramp.width + mw(0.8),
        longitudinalSegments: 12,
        lateralSegments: 5,
        heightAt: (x, z) => sampleMonsoonMeshHeight(x, z, this.seed),
        lift: 0.045,
      }));
      apronParts.push(buildTerrainRibbonGeometry({
        start: { x: endX + forwardX * mw(5.5), z: endZ + forwardZ * mw(5.5) },
        end: { x: endX + forwardX * mw(20), z: endZ + forwardZ * mw(20) },
        startWidth: ramp.width + mw(1.2),
        endWidth: ramp.width + mw(7.5),
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
      new THREE.Vector3(mw(-119.5), sampleMonsoonHeight(mw(-132), mw(111), this.seed) + mw(7.1), mw(102)),
      new THREE.Vector3(mw(119.5), sampleMonsoonHeight(mw(132), mw(96), this.seed) + mw(7.1), mw(87)),
      new THREE.Vector3(mw(42), sampleMonsoonHeight(mw(42), mw(-96), this.seed) + mw(7.4), mw(-109.8)),
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

    const cubbyHulls: DetailTransform[] = [];
    const cubbyDark: DetailTransform[] = [];
    const cubbySignal: DetailTransform[] = [];
    for (const collider of cubbyColliders) {
      this.dressSpawnCubbyBunker(collider.box, addDetail, cubbyHulls, cubbyDark, cubbySignal);
    }
    this.group.userData.spawnCubbyBunkers = {
      count: cubbyColliders.length,
      hullInstances: cubbyHulls.length,
      trimInstances: cubbyDark.length,
      signalInstances: cubbySignal.length,
      names: cubbyColliders.map((collider) => collider.name),
    };

    const tunnelFloor = this.platformSurfaces.find((platform) => platform.name === 'south-underpass-floor');
    const tunnelRoof = this.platformSurfaces.find((platform) => platform.name === 'south-underpass-roof');
    if (tunnelFloor && tunnelRoof) {
      const middleY = (tunnelFloor.y + tunnelRoof.y) * 0.5;
      for (const end of [-1, 1]) {
        for (const side of [-1, 1]) {
          addDetail(darkDetails, new THREE.Vector3(mw(42 + side * 15.28), middleY, mw(-96 + end * 15.9)), new THREE.Vector3(mw(0.7), tunnelRoof.y - tunnelFloor.y, mw(0.72)));
          addDetail(signalDetails, new THREE.Vector3(mw(42 + side * 14.84), middleY, mw(-96 + end * 16.28)), new THREE.Vector3(mw(0.11), mw(4.8), mw(0.12)));
        }
        addDetail(darkDetails, new THREE.Vector3(mw(42), tunnelRoof.y - mw(0.3), mw(-96 + end * 15.9)), new THREE.Vector3(mw(30.2), mw(0.62), mw(0.72)));
      }
    }

    const rampDarkParts: THREE.BufferGeometry[] = [];
    const rampSignalParts: THREE.BufferGeometry[] = [];
    for (const ramp of concreteKitRamps) {
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
    const cubbyHullMesh = cubbyHulls.length > 0
      ? buildDetails(cubbyHulls, concrete, 'MonsoonSpawnCubbyBunkerHulls')
      : null;
    const cubbyTrimMesh = cubbyDark.length > 0
      ? buildDetails(cubbyDark, structuralDark, 'MonsoonSpawnCubbyBunkerTrims')
      : null;
    const cubbySignalMesh = cubbySignal.length > 0
      ? buildDetails(cubbySignal, signal, 'MonsoonSpawnCubbyBunkerSignals')
      : null;
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
    if (cubbyHullMesh) this.group.add(cubbyHullMesh);
    if (cubbyTrimMesh) this.group.add(cubbyTrimMesh);
    if (cubbySignalMesh) this.group.add(cubbySignalMesh);
  }

  /**
   * Visual bunker kit for spawn cubbies. Collision stays on the original AABB
   * so LOS tests keep matching the authored cover chords.
   */
  private dressSpawnCubbyBunker(
    box: THREE.Box3,
    addDetail: (
      target: Array<{ position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }>,
      position: THREE.Vector3,
      scale: THREE.Vector3,
      quaternion?: THREE.Quaternion,
    ) => void,
    hulls: Array<{ position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }>,
    dark: Array<{ position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }>,
    signal: Array<{ position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }>,
  ): void {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    addDetail(hulls, center, size);
    addDetail(
      dark,
      new THREE.Vector3(center.x, box.max.y + 0.14, center.z),
      new THREE.Vector3(size.x + 0.38, 0.28, size.z + 0.38),
    );
    addDetail(
      dark,
      new THREE.Vector3(center.x, box.min.y + 0.16, center.z),
      new THREE.Vector3(size.x + 0.24, 0.32, size.z + 0.24),
    );
    for (const sideX of [-1, 1]) {
      for (const sideZ of [-1, 1]) {
        addDetail(
          dark,
          new THREE.Vector3(
            center.x + sideX * (size.x * 0.5 - 0.18),
            center.y,
            center.z + sideZ * (size.z * 0.5 - 0.18),
          ),
          new THREE.Vector3(0.44, size.y * 0.94, 0.44),
        );
      }
    }
    const fasciaZ = center.z + size.z * 0.5 + 0.06;
    addDetail(
      signal,
      new THREE.Vector3(center.x, box.max.y - 0.22, fasciaZ),
      new THREE.Vector3(size.x * 0.62, 0.1, 0.08),
    );
    addDetail(
      dark,
      new THREE.Vector3(center.x, center.y - size.y * 0.08, fasciaZ),
      new THREE.Vector3(1.15, size.y * 0.42, 0.12),
    );
    addDetail(
      signal,
      new THREE.Vector3(center.x, center.y - size.y * 0.08, fasciaZ + 0.04),
      new THREE.Vector3(0.72, size.y * 0.18, 0.06),
    );
    addDetail(
      dark,
      new THREE.Vector3(center.x + size.x * 0.18, box.max.y + 0.82, center.z - size.z * 0.12),
      new THREE.Vector3(0.1, 1.36, 0.1),
    );
    addDetail(
      signal,
      new THREE.Vector3(center.x + size.x * 0.18, box.max.y + 1.52, center.z - size.z * 0.12),
      new THREE.Vector3(0.22, 0.12, 0.22),
    );
    for (const side of [-1, 1]) {
      addDetail(
        dark,
        new THREE.Vector3(center.x, center.y + size.y * 0.12, center.z + side * (size.z * 0.5 + 0.03)),
        new THREE.Vector3(size.x * 0.78, 0.08, 0.07),
      );
    }
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
    const oceanSpan = Math.max(MONSOON_DIVIDE.width, MONSOON_DIVIDE.depth) * 1.9;
    const geometry = new THREE.PlaneGeometry(oceanSpan, oceanSpan, 160, 160);
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
          float waveLight = smoothstep(-0.52, 0.72, vWave);
          float horizon = smoothstep(720.0, 2880.0, length(vWorld.xz));
          vec3 color = mix(uDeep, uShallow, 0.25 + waveLight * 0.36);
          float glint = pow(smoothstep(0.42, 0.75, vWave), 3.0);
          color = mix(color, uSun, horizon * 0.08 + glint * 0.09);
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
    this.createShorelineFoam();
  }

  private createShorelineFoam(): void {
    const halfWidth = MONSOON_DIVIDE.width * 0.5;
    const halfDepth = MONSOON_DIVIDE.depth * 0.5;
    const waterline = MONSOON_DIVIDE.waterY + 0.7;
    const paths: THREE.Vector3[][] = [];
    const sides = [
      { samples: 120, point: (t: number) => ({ x: THREE.MathUtils.lerp(-halfWidth, halfWidth, t), z: -halfDepth, ix: 0, iz: 1 }) },
      { samples: 120, point: (t: number) => ({ x: THREE.MathUtils.lerp(halfWidth, -halfWidth, t), z: halfDepth, ix: 0, iz: -1 }) },
      { samples: 100, point: (t: number) => ({ x: -halfWidth, z: THREE.MathUtils.lerp(halfDepth, -halfDepth, t), ix: 1, iz: 0 }) },
      { samples: 100, point: (t: number) => ({ x: halfWidth, z: THREE.MathUtils.lerp(-halfDepth, halfDepth, t), ix: -1, iz: 0 }) },
    ] as const;
    for (const side of sides) {
      const path: THREE.Vector3[] = [];
      for (let index = 0; index <= side.samples; index += 1) {
        const edge = side.point(index / side.samples);
        let found: THREE.Vector3 | null = null;
        for (let distance = 0; distance <= 440; distance += 8) {
          const x = edge.x + edge.ix * distance;
          const z = edge.z + edge.iz * distance;
          if (sampleMonsoonHeight(x, z, this.seed) > waterline + 0.8) {
            found = new THREE.Vector3(x, waterline, z);
            break;
          }
        }
        if (found) path.push(found);
      }
      if (path.length > 1) paths.push(path);
    }

    const positions: number[] = [];
    const push = (point: THREE.Vector3): void => {
      positions.push(point.x, point.y, point.z);
    };
    for (const path of paths) {
      for (let index = 0; index < path.length - 1; index += 1) {
        const a = path[index];
        const b = path[index + 1];
        const tangent = b.clone().sub(a).setY(0).normalize();
        const cross = new THREE.Vector3(-tangent.z, 0, tangent.x);
        const widthA = 2.2 + (Math.sin(index * 1.73) * 0.5 + 0.5) * 2.4;
        const widthB = 2.2 + (Math.sin((index + 1) * 1.73) * 0.5 + 0.5) * 2.4;
        const leftA = a.clone().addScaledVector(cross, widthA);
        const rightA = a.clone().addScaledVector(cross, -widthA);
        const leftB = b.clone().addScaledVector(cross, widthB);
        const rightB = b.clone().addScaledVector(cross, -widthB);
        push(leftA); push(leftB); push(rightA);
        push(rightA); push(leftB); push(rightB);
      }
    }
    if (positions.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const material = new THREE.MeshBasicMaterial({
      color: 0xb9e4e2,
      depthWrite: false,
      fog: true,
      opacity: 0.34,
      side: THREE.DoubleSide,
      transparent: true,
    });
    material.name = 'MonsoonWindBrokenShoreFoam';
    const foam = new THREE.Mesh(geometry, material);
    foam.name = 'MonsoonWindBrokenShoreline';
    foam.renderOrder = 0;
    foam.userData.nonCollidable = true;
    this.geometries.push(geometry);
    this.materials.push(material);
    this.group.add(foam);
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
    GATE_XZ.forEach(([designX, designZ], gateIndex) => {
      const x = mw(designX);
      const z = mw(designZ);
      const y = sampleMonsoonHeight(x, z, this.seed);
      const yaw = Math.atan2(-x, -z);
      quaternion.setFromEuler(new THREE.Euler(0, yaw, 0));
      const cross = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      const gateHalfWidth = mw(ROUTE_GATE_HALF_WIDTH);
      for (const side of [-1, 1]) {
        const post = new THREE.Vector3(x, y + mw(2.8), z).addScaledVector(cross, side * gateHalfWidth);
        matrix.compose(post, quaternion, new THREE.Vector3(mw(0.82), mw(5.6), mw(1.05)));
        frames.setMatrixAt(frameIndex++, matrix);
        matrix.compose(post.clone().addScaledVector(cross, -side * mw(0.08)), quaternion, new THREE.Vector3(mw(0.28), mw(3.8), mw(1.12)));
        insets.setMatrixAt(insetIndex++, matrix);
      }
      matrix.compose(
        new THREE.Vector3(x, y + mw(5.58), z),
        quaternion,
        new THREE.Vector3(gateHalfWidth * 2 + mw(0.8), mw(0.72), mw(1.05)),
      );
      frames.setMatrixAt(frameIndex++, matrix);
      matrix.compose(
        new THREE.Vector3(x, y + mw(5.52), z),
        quaternion,
        new THREE.Vector3(gateHalfWidth * 2 - mw(2.4), mw(0.12), mw(1.12)),
      );
      strips.setMatrixAt(gateIndex, matrix);
      for (const side of [-1, 1]) {
        const bracePosition = new THREE.Vector3(x, y + mw(4.35), z)
          .addScaledVector(cross, side * (gateHalfWidth - mw(1.38)));
        const localBrace = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(0, yaw, side * -0.7),
        );
        matrix.compose(bracePosition, localBrace, new THREE.Vector3(mw(0.34), mw(3.3), mw(0.68)));
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
      matrix.compose(
        pad.position.clone().add(new THREE.Vector3(0, 0.08, 0)),
        identity,
        new THREE.Vector3(MONSOON_PLAYER_ART_SCALE, 1, MONSOON_PLAYER_ART_SCALE),
      );
      bases.setMatrixAt(index, matrix);
      matrix.compose(
        pad.position.clone().add(new THREE.Vector3(0, 0.33, 0)),
        horizontal,
        new THREE.Vector3(MONSOON_PLAYER_ART_SCALE, MONSOON_PLAYER_ART_SCALE, MONSOON_PLAYER_ART_SCALE),
      );
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
        const routeProgress = samples.length > 1 ? index / (samples.length - 1) : 0.5;
        const longitudinalFade = closed
          ? 1
          : THREE.MathUtils.smoothstep(routeProgress, 0, 0.18)
            * (1 - THREE.MathUtils.smoothstep(routeProgress, 0.82, 1));
        const halfWidth = width * 0.5 * THREE.MathUtils.lerp(0.2, 1, longitudinalFade);
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

    // The terrain palette already exposes the radial ski corridors with an
    // organic soil blend. A second set of straight decals read as editor
    // arrows from overview height, so only the compact inner race line gets a
    // restrained packed-earth surface treatment.
    appendRibbon(
      MONSOON_INNER_LOOP_SAMPLES.map(([x, z]) => [mw(x), mw(z)] as const),
      mw(7.2),
      true,
    );
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const texture = this.createDirtTexture();
    const edgeMask = this.createDirtRouteEdgeMask();
    const material = new THREE.MeshStandardMaterial({
      color: 0x778073,
      map: texture,
      alphaMap: edgeMask,
      alphaTest: 0.06,
      transparent: true,
      opacity: 0.68,
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

  private createStormPuddles(): void {
    const puddles = [
      { x: -92, z: -34, rx: 19, rz: 10, yaw: -0.3 },
      { x: -48, z: 28, rx: 13, rz: 7, yaw: 0.4 },
      { x: -18, z: -62, rx: 16, rz: 8, yaw: 0.12 },
      { x: 30, z: 42, rx: 18, rz: 9, yaw: -0.48 },
      { x: 76, z: -24, rx: 14, rz: 7, yaw: 0.3 },
      { x: 112, z: 54, rx: 12, rz: 6, yaw: -0.18 },
      { x: -128, z: 72, rx: 11, rz: 5, yaw: 0.62 },
      { x: 118, z: -78, rx: 17, rz: 7, yaw: -0.52 },
    ] as const;
    const positions: number[] = [];
    const colors: number[] = [];
    const segments = 18;
    const push = (x: number, z: number, brightness: number): void => {
      positions.push(x, sampleMonsoonHeight(x, z, this.seed) + 0.11, z);
      colors.push(0.36 * brightness, 0.73 * brightness, 0.8 * brightness);
    };
    for (const puddle of puddles) {
      const cosine = Math.cos(puddle.yaw);
      const sine = Math.sin(puddle.yaw);
      for (let segment = 0; segment < segments; segment += 1) {
        const appendRim = (index: number): void => {
          const angle = index / segments * Math.PI * 2;
          const ripple = 0.86 + Math.sin(index * 2.17 + puddle.x) * 0.09;
          const localX = Math.cos(angle) * puddle.rx * ripple;
          const localZ = Math.sin(angle) * puddle.rz * ripple;
          push(
            puddle.x + localX * cosine - localZ * sine,
            puddle.z + localX * sine + localZ * cosine,
            0.72,
          );
        };
        push(puddle.x, puddle.z, 1);
        appendRim(segment);
        appendRim(segment + 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      depthWrite: false,
      metalness: 0.08,
      opacity: 0.46,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      roughness: 0.2,
      transparent: true,
      vertexColors: true,
    });
    material.name = 'MonsoonStormBasinWetPatches';
    const wetPatches = new THREE.Mesh(geometry, material);
    wetPatches.name = 'MonsoonIrregularStormPuddles';
    wetPatches.renderOrder = 1;
    wetPatches.userData.nonCollidable = true;
    this.geometries.push(geometry);
    this.materials.push(material);
    this.group.add(wetPatches);
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
      const width = 0.026 + (blade % 3) * 0.008;
      const height = 0.42 + (blade % 4) * 0.075;
      const points = [
        new THREE.Vector3(-width + offsetX, 0, offsetZ),
        new THREE.Vector3(width + offsetX, 0, offsetZ),
        new THREE.Vector3(offsetX + width * 0.45 + 0.055, height * 0.62, offsetZ),
        new THREE.Vector3(offsetX + 0.07, height, offsetZ),
      ];
      for (const point of points) {
        const x = point.x * cosine - point.z * sine;
        const z = point.x * sine + point.z * cosine;
        point.set(x, point.y, z);
      }
      for (const index of [0, 1, 2, 0, 2, 3]) {
        const point = points[index];
        positions.push(point.x, point.y, point.z);
        normals.push(sine * 0.26, 0.93, cosine * 0.26);
        uvs.push(index === 0 ? 0 : index === 1 ? 1 : 0.55, index < 2 ? 0 : index === 2 ? 0.62 : 1);
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
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const stemColor = new THREE.Color(0x73805a);
    const leafColor = new THREE.Color(0x98a975);
    const seedColor = new THREE.Color(0xc6b47b);
    const push = (points: THREE.Vector3[], normal: THREE.Vector3, color: THREE.Color): void => {
      for (const point of points) {
        positions.push(point.x, point.y, point.z);
        normals.push(normal.x, normal.y, normal.z);
        colors.push(color.r, color.g, color.b);
      }
    };
    for (let stalk = 0; stalk < 4; stalk += 1) {
      const angle = stalk / 4 * Math.PI * 2 + stalk * 0.23;
      const forward = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const side = new THREE.Vector3(-forward.z, 0, forward.x);
      const normal = new THREE.Vector3(forward.x * 0.22, 0.94, forward.z * 0.22).normalize();
      const root = forward.clone().multiplyScalar(0.08 + stalk * 0.02);
      const height = 0.68 + stalk * 0.09;
      const bend = forward.clone().multiplyScalar(0.08 + stalk * 0.025);
      const stemLeft = root.clone().addScaledVector(side, 0.022);
      const stemRight = root.clone().addScaledVector(side, -0.022);
      const top = root.clone().add(bend).add(new THREE.Vector3(0, height, 0));
      push([stemLeft, stemRight, top], normal, stemColor);
      for (const [leafY, leafSide] of [[0.28, -1], [0.43, 1]] as const) {
        const center = root.clone().addScaledVector(bend, leafY / height).add(new THREE.Vector3(0, leafY, 0));
        const outward = side.clone().multiplyScalar(leafSide);
        const leafReach = 0.13 + stalk * 0.012;
        const leafWidth = 0.024 + (stalk % 2) * 0.006;
        const tip = center.clone().addScaledVector(outward, leafReach).add(new THREE.Vector3(0, 0.055, 0));
        const shoulderA = center.clone().addScaledVector(outward, leafReach * 0.38).addScaledVector(forward, leafWidth);
        const shoulderB = center.clone().addScaledVector(outward, leafReach * 0.38).addScaledVector(forward, -leafWidth);
        push([center, shoulderA, tip, center, tip, shoulderB], normal, leafColor);
      }
      const headSide = side.clone().multiplyScalar(0.038 + (stalk % 2) * 0.008);
      const headBottom = top.clone().add(new THREE.Vector3(0, -0.035, 0));
      const headTop = top.clone().add(new THREE.Vector3(0, 0.09 + stalk * 0.008, 0));
      push([headBottom.clone().add(headSide), headBottom.clone().sub(headSide), headTop], normal, seedColor);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  /**
   * Low-cost fern silhouette used for the mass understory tier. Nearby hero
   * ferns keep individual leaflets; this tier keeps the radial,
   * arcing fern read with broad segmented fronds at roughly one seventh of the
   * vertex cost, which is the difference between a few patches and a jungle.
   */
  private createFernLodGeometry(variant: 0 | 1 | 2): THREE.BufferGeometry {
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const baseColor = new THREE.Color(variant === 0 ? 0x537d52 : variant === 1 ? 0x3f7150 : 0x688b5c);
    const tipColor = new THREE.Color(variant === 0 ? 0x86a874 : variant === 1 ? 0x6d9a65 : 0x9eb781);
    const stemColor = new THREE.Color(0x415f3c);
    const frondCount = variant === 0 ? 5 : variant === 1 ? 6 : 4;
    const leafletPairs = variant === 0 ? 6 : variant === 1 ? 7 : 5;
    const pushTriangle = (
      a: THREE.Vector3,
      b: THREE.Vector3,
      c: THREE.Vector3,
      normal: THREE.Vector3,
      color: THREE.Color,
    ): void => {
      for (const point of [a, b, c]) {
        positions.push(point.x, point.y, point.z);
        normals.push(normal.x, normal.y, normal.z);
        colors.push(color.r, color.g, color.b);
      }
    };
    for (let frond = 0; frond < frondCount; frond += 1) {
      const angle = frond / frondCount * Math.PI * 2 + variant * 0.29 + (frond % 2) * 0.13;
      const forward = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const side = new THREE.Vector3(-forward.z, 0, forward.x);
      const normal = new THREE.Vector3(forward.x * 0.2, 0.96, forward.z * 0.2).normalize();
      const reach = (variant === 0 ? 1.06 : variant === 1 ? 1.32 : 0.88) * (0.9 + (frond % 3) * 0.08);
      const rise = variant === 0 ? 0.92 : variant === 1 ? 0.66 : 1.1;
      const curve = variant === 1 ? 0.68 : 0.42;
      const sample = (t: number): THREE.Vector3 => forward.clone()
        .multiplyScalar(reach * (t - t * t * 0.09))
        .add(new THREE.Vector3(0, 0.035 + rise * (t - curve * t * t * 0.58), 0));
      for (let segment = 0; segment < leafletPairs; segment += 1) {
        const t0 = segment / leafletPairs;
        const t1 = (segment + 1) / leafletPairs;
        const stemA = sample(t0);
        const stemB = sample(t1);
        const stemWidth = 0.018 * (1 - t0 * 0.62);
        pushTriangle(
          stemA.clone().addScaledVector(side, stemWidth),
          stemA.clone().addScaledVector(side, -stemWidth),
          stemB,
          normal,
          stemColor,
        );
        if (segment === 0) continue;
        const t = (segment + 0.12) / leafletPairs;
        const center = sample(t);
        const along = sample(Math.min(1, t + 0.06)).sub(center).normalize();
        const taper = Math.sin(Math.PI * Math.pow(t, 0.86));
        const leafLength = (variant === 1 ? 0.27 : variant === 2 ? 0.19 : 0.23) * (0.28 + taper * 0.86);
        const leafWidth = leafLength * (0.14 + variant * 0.025);
        const tint = baseColor.clone().lerp(tipColor, t * 0.68 + (frond % 3) * 0.06);
        for (const leafSide of [-1, 1]) {
          const outward = side.clone().multiplyScalar(leafSide);
          const base = center.clone().addScaledVector(outward, 0.018);
          const tip = base.clone()
            .addScaledVector(outward, leafLength)
            .addScaledVector(along, leafLength * 0.18)
            .add(new THREE.Vector3(0, -leafLength * (variant === 1 ? 0.16 : 0.08), 0));
          const shoulderA = base.clone()
            .addScaledVector(outward, leafLength * 0.42)
            .addScaledVector(along, leafWidth);
          const shoulderB = base.clone()
            .addScaledVector(outward, leafLength * 0.38)
            .addScaledVector(along, -leafWidth * 0.76);
          pushTriangle(base, shoulderA, tip, normal, tint);
          pushTriangle(base, tip, shoulderB, normal, tint);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.name = `MonsoonProceduralMassFern${variant + 1}`;
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private createFernGeometry(variant: 0 | 1 | 2): THREE.BufferGeometry {
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const leafColor = new THREE.Color(variant === 0 ? 0x729b63 : variant === 1 ? 0x5f8b58 : 0x89a76d);
    const tipColor = new THREE.Color(variant === 0 ? 0x9bb77a : variant === 1 ? 0x7eaa68 : 0xb0c587);
    const stemColor = new THREE.Color(0x536e45);
    const frondCount = variant === 0 ? 7 : variant === 1 ? 9 : 6;
    const leafletPairs = variant === 0 ? 10 : variant === 1 ? 12 : 8;
    const pushTriangle = (
      a: THREE.Vector3,
      b: THREE.Vector3,
      c: THREE.Vector3,
      normal: THREE.Vector3,
      color: THREE.Color,
    ): void => {
      for (const point of [a, b, c]) {
        positions.push(point.x, point.y, point.z);
        normals.push(normal.x, normal.y, normal.z);
        colors.push(color.r, color.g, color.b);
      }
    };
    for (let frond = 0; frond < frondCount; frond += 1) {
      const angle = frond / frondCount * Math.PI * 2 + variant * 0.21 + (frond % 2) * 0.1;
      const forward = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const side = new THREE.Vector3(-forward.z, 0, forward.x);
      const normal = new THREE.Vector3(forward.x * 0.2, 0.96, forward.z * 0.2).normalize();
      const reach = (variant === 0 ? 1.08 : variant === 1 ? 1.34 : 0.9) * (0.88 + (frond % 3) * 0.08);
      const rise = variant === 0 ? 1.04 : variant === 1 ? 0.7 : 1.34;
      const curve = variant === 0 ? 0.46 : variant === 1 ? 0.7 : 0.24;
      const sample = (t: number): THREE.Vector3 => {
        const radial = reach * (t * (1 - curve * 0.17 * t));
        const y = rise * (t - curve * t * t * 0.62) + Math.sin(t * Math.PI) * (variant === 1 ? 0.18 : 0.1);
        return forward.clone().multiplyScalar(radial).add(new THREE.Vector3(0, y + 0.035, 0));
      };
      for (let segment = 0; segment < leafletPairs; segment += 1) {
        const t0 = segment / leafletPairs;
        const t1 = (segment + 1) / leafletPairs;
        const stemA = sample(t0);
        const stemB = sample(t1);
        const stemWidth = 0.022 * (1 - t0 * 0.64);
        pushTriangle(stemA.clone().addScaledVector(side, stemWidth), stemA.clone().addScaledVector(side, -stemWidth), stemB, normal, stemColor);
        if (segment === 0) continue;
        const t = (segment + 0.16) / leafletPairs;
        const center = sample(t);
        const taper = Math.sin(Math.PI * Math.pow(t, 0.82));
        const leafLength = (variant === 1 ? 0.23 : variant === 2 ? 0.18 : 0.21) * (0.28 + taper * 0.82);
        const leafWidth = leafLength * (variant === 1 ? 0.18 : variant === 2 ? 0.24 : 0.21);
        const along = sample(Math.min(1, t + 0.05)).sub(center).normalize();
        for (const leafSide of [-1, 1]) {
          const outward = side.clone().multiplyScalar(leafSide);
          const base = center.clone().addScaledVector(outward, 0.025);
          const tip = center.clone()
            .addScaledVector(outward, leafLength)
            .addScaledVector(along, leafLength * 0.26)
            .add(new THREE.Vector3(0, -leafLength * (variant === 1 ? 0.18 : 0.08), 0));
          const shoulder = base.clone()
            .addScaledVector(outward, leafLength * 0.42)
            .addScaledVector(along, leafWidth);
          const trailing = base.clone()
            .addScaledVector(outward, leafLength * 0.38)
            .addScaledVector(along, -leafWidth * 0.72);
          const mixed = leafColor.clone().lerp(tipColor, t * 0.55 + (frond % 3) * 0.08);
          pushTriangle(base, shoulder, tip, normal, mixed);
          pushTriangle(base, tip, trailing, normal, mixed);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private colorizeProceduralGeometry(source: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
    const geometry = source.index ? source.toNonIndexed() : source;
    if (geometry !== source) source.dispose();
    const positions = geometry.getAttribute('position');
    const tint = new THREE.Color(color);
    const colors = new Float32Array(positions.count * 3);
    for (let index = 0; index < positions.count; index += 1) {
      colors[index * 3] = tint.r;
      colors[index * 3 + 1] = tint.g;
      colors[index * 3 + 2] = tint.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
  }

  private createShrubGeometry(variant: 0 | 1 | 2 | 3): THREE.BufferGeometry {
    const configs = [
      { height: 1.65, spread: 1.22, stems: 8, leaves: 64, leafLength: 0.42, leafWidth: 0.18 },
      { height: 2.15, spread: 0.9, stems: 7, leaves: 58, leafLength: 0.5, leafWidth: 0.16 },
      { height: 1.08, spread: 1.72, stems: 9, leaves: 76, leafLength: 0.34, leafWidth: 0.16 },
      { height: 1.82, spread: 1.38, stems: 6, leaves: 54, leafLength: 0.68, leafWidth: 0.24 },
    ] as const;
    const config = configs[variant];
    const random = randomFactory(0x4a9f213d ^ (variant * 0x9e3779b9));
    const parts: THREE.BufferGeometry[] = [];
    const branchEnds: THREE.Vector3[] = [];
    const branchBetween = (start: THREE.Vector3, end: THREE.Vector3, radius: number): void => {
      const direction = end.clone().sub(start);
      const branch = this.colorizeProceduralGeometry(
        new THREE.CylinderGeometry(radius * 0.38, radius, direction.length(), 6, 1, true),
        variant === 3 ? 0x5f5540 : 0x4a4435,
      );
      branch.applyMatrix4(new THREE.Matrix4().compose(
        start.clone().add(end).multiplyScalar(0.5),
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()),
        new THREE.Vector3(1, 1, 1),
      ));
      parts.push(branch);
    };
    for (let stem = 0; stem < config.stems; stem += 1) {
      const angle = stem / config.stems * Math.PI * 2 + variant * 0.41 + (random() - 0.5) * 0.34;
      const start = new THREE.Vector3((random() - 0.5) * 0.22, 0.04, (random() - 0.5) * 0.22);
      const reach = config.spread * (0.55 + random() * 0.45);
      const end = new THREE.Vector3(
        Math.cos(angle) * reach,
        config.height * (0.62 + random() * 0.42),
        Math.sin(angle) * reach,
      );
      branchBetween(start, end, 0.045 + random() * 0.025);
      branchEnds.push(end);
      if (stem % 2 === 0) {
        const forkStart = start.clone().lerp(end, 0.58);
        const forkAngle = angle + (stem % 4 === 0 ? 0.56 : -0.48);
        const forkEnd = end.clone().add(new THREE.Vector3(
          Math.cos(forkAngle) * reach * 0.42,
          0.18 + random() * 0.32,
          Math.sin(forkAngle) * reach * 0.42,
        ));
        branchBetween(forkStart, forkEnd, 0.032 + random() * 0.014);
        branchEnds.push(forkEnd);
      }
    }
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const uvs: number[] = [];
    const palettes = [
      [0x315d3a, 0x467348, 0x5d8755, 0x789c66],
      [0x284f39, 0x386345, 0x4b7951, 0x668e5c],
      [0x3b633c, 0x52794a, 0x6d8f58, 0x87a56c],
      [0x2b5b3c, 0x3e7149, 0x568652, 0x77a064],
    ].map((palette) => palette.map((color) => new THREE.Color(color)));
    const palette = palettes[variant];
    const push = (point: THREE.Vector3, normal: THREE.Vector3, color: THREE.Color, u: number, v: number): void => {
      positions.push(point.x, point.y, point.z);
      normals.push(normal.x, normal.y, normal.z);
      colors.push(color.r, color.g, color.b);
      uvs.push(u, v);
    };
    for (let leaf = 0; leaf < config.leaves; leaf += 1) {
      const anchor = branchEnds[Math.floor(random() * branchEnds.length)];
      const center = anchor.clone().add(new THREE.Vector3(
        (random() - 0.5) * config.spread * 0.72,
        (random() - 0.5) * config.height * 0.48,
        (random() - 0.5) * config.spread * 0.72,
      ));
      const yaw = random() * Math.PI * 2;
      const axis = new THREE.Vector3(Math.cos(yaw), -0.24 + random() * 0.64, Math.sin(yaw)).normalize();
      const facing = new THREE.Vector3((random() - 0.5) * 0.45, 0.8, (random() - 0.5) * 0.45).normalize();
      const right = new THREE.Vector3().crossVectors(facing, axis);
      if (right.lengthSq() < 0.02) right.set(-axis.z, 0, axis.x);
      right.normalize();
      const normal = new THREE.Vector3().crossVectors(axis, right).normalize();
      const length = config.leafLength * (0.72 + random() * 0.58);
      const width = config.leafWidth * (0.72 + random() * 0.54);
      const boundary = [
        center.clone().addScaledVector(axis, -length * 0.54),
        center.clone().addScaledVector(axis, -length * 0.18).addScaledVector(right, width * 0.84),
        center.clone().addScaledVector(axis, length * 0.18).addScaledVector(right, width),
        center.clone().addScaledVector(axis, length * 0.56),
        center.clone().addScaledVector(axis, length * 0.18).addScaledVector(right, -width),
        center.clone().addScaledVector(axis, -length * 0.18).addScaledVector(right, -width * 0.84),
      ];
      const tint = palette[Math.floor(random() * palette.length)].clone().multiplyScalar(0.9 + random() * 0.16);
      for (let edge = 0; edge < boundary.length; edge += 1) {
        const a = boundary[edge];
        const b = boundary[(edge + 1) % boundary.length];
        push(center, normal, tint, 0.5, 0.5);
        push(a, normal, tint, 0.5 + (a.x - center.x), 0.5 + (a.z - center.z));
        push(b, normal, tint, 0.5 + (b.x - center.x), 0.5 + (b.z - center.z));
      }
    }
    const leafGeometry = new THREE.BufferGeometry();
    leafGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    leafGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    leafGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    leafGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    parts.push(leafGeometry);
    const merged = mergeGeometries(parts, false);
    parts.forEach((part) => part.dispose());
    if (!merged) throw new Error('Failed to build Monsoon procedural tropical shrub.');
    merged.name = `MonsoonProceduralTropicalShrub${variant + 1}`;
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }

  private createProceduralTropicalLeafTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Failed to create procedural tropical leaf texture.');
    context.clearRect(0, 0, canvas.width, canvas.height);
    const random = randomFactory(0x5eaf71c3);
    const widths = [82, 62, 94, 54];
    const shoulders = [142, 126, 158, 112];
    for (let cell = 0; cell < 4; cell += 1) {
      const offsetX = (cell % 2) * 256;
      const offsetY = Math.floor(cell / 2) * 256;
      const width = widths[cell];
      const shoulder = shoulders[cell];
      const path = new Path2D();
      path.moveTo(offsetX + 128, offsetY + 246);
      path.bezierCurveTo(
        offsetX + 128 - width * 0.18,
        offsetY + 224,
        offsetX + 128 - width,
        offsetY + shoulder + 28,
        offsetX + 128 - width * 0.78,
        offsetY + shoulder,
      );
      path.bezierCurveTo(
        offsetX + 128 - width * 0.62,
        offsetY + 78,
        offsetX + 128 - width * 0.2,
        offsetY + 28,
        offsetX + 128,
        offsetY + 10,
      );
      path.bezierCurveTo(
        offsetX + 128 + width * 0.2,
        offsetY + 28,
        offsetX + 128 + width * 0.62,
        offsetY + 78,
        offsetX + 128 + width * 0.78,
        offsetY + shoulder,
      );
      path.bezierCurveTo(
        offsetX + 128 + width,
        offsetY + shoulder + 28,
        offsetX + 128 + width * 0.18,
        offsetY + 224,
        offsetX + 128,
        offsetY + 246,
      );
      path.closePath();
      context.save();
      context.clip(path);
      const gradient = context.createLinearGradient(0, offsetY + 246, 0, offsetY + 8);
      gradient.addColorStop(0, 'rgb(165, 176, 148)');
      gradient.addColorStop(0.45, 'rgb(226, 233, 210)');
      gradient.addColorStop(1, 'rgb(242, 246, 226)');
      context.fillStyle = gradient;
      context.fillRect(offsetX, offsetY, 256, 256);
      for (let fleck = 0; fleck < 150; fleck += 1) {
        const x = offsetX + 36 + random() * 184;
        const y = offsetY + 18 + random() * 218;
        const radius = 0.35 + random() * 1.2;
        context.fillStyle = random() > 0.36 ? 'rgba(70,91,61,.12)' : 'rgba(255,255,235,.13)';
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
      }
      context.strokeStyle = 'rgba(65, 82, 57, .52)';
      context.lineWidth = cell === 3 ? 2.2 : 2.8;
      context.beginPath();
      context.moveTo(offsetX + 128, offsetY + 246);
      context.quadraticCurveTo(offsetX + 125, offsetY + 130, offsetX + 128, offsetY + 13);
      context.stroke();
      context.lineWidth = 1;
      context.strokeStyle = 'rgba(76, 98, 67, .31)';
      for (let vein = 1; vein <= 9; vein += 1) {
        const t = vein / 10;
        const y = offsetY + 238 - t * 206;
        const reach = Math.sin(Math.PI * t) * width * 0.66;
        context.beginPath();
        context.moveTo(offsetX + 128, y);
        context.quadraticCurveTo(offsetX + 128 - reach * 0.35, y - 8, offsetX + 128 - reach, y - 15);
        context.moveTo(offsetX + 128, y);
        context.quadraticCurveTo(offsetX + 128 + reach * 0.35, y - 8, offsetX + 128 + reach, y - 15);
        context.stroke();
      }
      context.restore();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.name = 'MonsoonProceduralTropicalLeafAtlas';
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.userData.procedural = true;
    return texture;
  }

  private createProceduralTropicalBarkTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Failed to create procedural tropical bark texture.');
    const random = randomFactory(0x8b3f62d1);
    const gradient = context.createLinearGradient(0, 0, 256, 0);
    gradient.addColorStop(0, '#82745d');
    gradient.addColorStop(0.28, '#a09273');
    gradient.addColorStop(0.62, '#746951');
    gradient.addColorStop(1, '#92836a');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 256, 256);
    for (let fiber = 0; fiber < 190; fiber += 1) {
      const x = random() * 256;
      const width = 0.35 + random() * 2.2;
      const sway = (random() - 0.5) * 7;
      context.strokeStyle = random() > 0.48
        ? `rgba(42, 38, 30, ${0.08 + random() * 0.18})`
        : `rgba(224, 213, 178, ${0.05 + random() * 0.13})`;
      context.lineWidth = width;
      context.beginPath();
      context.moveTo(x, -8);
      context.bezierCurveTo(x + sway, 70, x - sway * 0.5, 174, x + sway * 0.35, 264);
      context.stroke();
    }
    for (let scar = 0; scar < 46; scar += 1) {
      const x = random() * 248;
      const y = random() * 256;
      const width = 5 + random() * 24;
      context.strokeStyle = `rgba(38, 43, 31, ${0.08 + random() * 0.17})`;
      context.lineWidth = 0.8 + random() * 1.6;
      context.beginPath();
      context.moveTo(x, y);
      context.quadraticCurveTo(x + width * 0.5, y + (random() - 0.5) * 5, x + width, y + (random() - 0.5) * 3);
      context.stroke();
    }
    for (let moss = 0; moss < 115; moss += 1) {
      const x = random() * 256;
      const y = random() * 256;
      const radius = 0.5 + random() * 3.2;
      context.fillStyle = `rgba(55, 77, 46, ${0.035 + random() * 0.095})`;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.name = 'MonsoonProceduralTropicalBark';
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1.4, 3.2);
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.userData.procedural = true;
    return texture;
  }

  private createTropicalTreeLodGeometries(variant: 0 | 1 | 2 | 3): [THREE.BufferGeometry, THREE.BufferGeometry] {
    const configs = [
      { height: 7.2, leanX: 0.28, leanZ: -0.16, branches: 8, spread: 2.7, crownLift: 2.4, leaves: 850, leafSize: 0.55 },
      { height: 9.3, leanX: -0.18, leanZ: 0.24, branches: 7, spread: 2.5, crownLift: 3.05, leaves: 720, leafSize: 0.49 },
      { height: 7.8, leanX: 0.48, leanZ: 0.12, branches: 9, spread: 3.15, crownLift: 2.05, leaves: 960, leafSize: 0.61 },
      { height: 8.5, leanX: -0.42, leanZ: -0.28, branches: 8, spread: 2.85, crownLift: 2.7, leaves: 800, leafSize: 0.53 },
    ] as const;
    const config = configs[variant];
    const random = randomFactory(0x71c4a90d ^ (variant * 0x45d9f3b));
    const woodParts: THREE.BufferGeometry[] = [];
    const branchBetween = (
      start: THREE.Vector3,
      end: THREE.Vector3,
      startRadius: number,
      endRadius: number,
      color: number,
      radialSegments = 7,
    ): void => {
      const direction = end.clone().sub(start);
      const branch = this.colorizeProceduralGeometry(
        new THREE.CylinderGeometry(endRadius, startRadius, direction.length(), radialSegments, 1, true),
        color,
      );
      branch.applyMatrix4(new THREE.Matrix4().compose(
        start.clone().add(end).multiplyScalar(0.5),
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()),
        new THREE.Vector3(1, 1, 1),
      ));
      woodParts.push(branch);
    };
    const trunkAt = (t: number): THREE.Vector3 => new THREE.Vector3(
      config.leanX * t * t + Math.sin(t * Math.PI * 1.35 + variant) * 0.08,
      config.height * t,
      config.leanZ * t * t + Math.sin(t * Math.PI * 1.7 + variant * 0.7) * 0.07,
    );
    const trunkSegments = variant === 1 ? 7 : 6;
    for (let segment = 0; segment < trunkSegments; segment += 1) {
      const t0 = segment / trunkSegments;
      const t1 = (segment + 1) / trunkSegments;
      branchBetween(
        trunkAt(t0),
        trunkAt(t1),
        THREE.MathUtils.lerp(0.56, 0.2, t0),
        THREE.MathUtils.lerp(0.56, 0.16, t1),
        segment % 2 === 0 ? 0x766a54 : 0x7c7058,
        9,
      );
    }
    for (let root = 0; root < 6; root += 1) {
      const angle = root / 6 * Math.PI * 2 + variant * 0.27;
      const radial = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const tangent = new THREE.Vector3(-radial.z, 0, radial.x);
      const reach = 1.34 + (root % 2) * 0.3;
      const top = radial.clone().multiplyScalar(0.3).add(new THREE.Vector3(0, 1.42 + (root % 3) * 0.11, 0));
      const innerLeft = radial.clone().multiplyScalar(0.3).addScaledVector(tangent, 0.34);
      const innerRight = radial.clone().multiplyScalar(0.3).addScaledVector(tangent, -0.34);
      const outerLeft = radial.clone().multiplyScalar(reach).addScaledVector(tangent, 0.12).setY(0.025);
      const outerRight = radial.clone().multiplyScalar(reach).addScaledVector(tangent, -0.12).setY(0.025);
      const buttressPositions: number[] = [];
      const pushFace = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void => {
        for (const point of [a, b, c, a, c, b]) buttressPositions.push(point.x, point.y, point.z);
      };
      pushFace(top, innerLeft, outerLeft);
      pushFace(top, outerLeft, outerRight);
      pushFace(top, outerRight, innerRight);
      pushFace(innerLeft, innerRight, outerRight);
      pushFace(innerLeft, outerRight, outerLeft);
      const buttress = new THREE.BufferGeometry();
      buttress.setAttribute('position', new THREE.Float32BufferAttribute(buttressPositions, 3));
      buttress.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(buttressPositions.length / 3 * 2), 2));
      buttress.computeVertexNormals();
      woodParts.push(this.colorizeProceduralGeometry(buttress, root % 2 === 0 ? 0x6b5f4b : 0x756750));
    }
    const crownCenters: THREE.Vector3[] = [trunkAt(1).add(new THREE.Vector3(0, config.crownLift * 0.72, 0))];
    for (let branch = 0; branch < config.branches; branch += 1) {
      const angle = branch / config.branches * Math.PI * 2 + variant * 0.63 + (random() - 0.5) * 0.38;
      const attach = 0.48 + (branch % 4) * 0.075 + random() * 0.06;
      const start = trunkAt(Math.min(0.86, attach));
      const reach = config.spread * (0.72 + random() * 0.5);
      const end = new THREE.Vector3(
        start.x + Math.cos(angle) * reach,
        config.height + config.crownLift * (0.35 + random() * 0.7),
        start.z + Math.sin(angle) * reach,
      );
      branchBetween(start, end, 0.17 - (branch % 3) * 0.018, 0.04, branch % 2 === 0 ? 0x665b49 : 0x5b5242);
      crownCenters.push(end.clone());
      if (branch % 2 === variant % 2) {
        const forkStart = start.clone().lerp(end, 0.62);
        const forkAngle = angle + (branch % 3 === 0 ? 0.48 : -0.42);
        const forkEnd = end.clone().add(new THREE.Vector3(
          Math.cos(forkAngle) * reach * 0.38,
          0.5 + random() * 0.85,
          Math.sin(forkAngle) * reach * 0.38,
        ));
        branchBetween(forkStart, forkEnd, 0.085, 0.022, 0x574e3f, 6);
        crownCenters.push(forkEnd);
      }
    }
    const wood = mergeGeometries(woodParts, false);
    woodParts.forEach((part) => part.dispose());
    if (!wood) throw new Error('Failed to build Monsoon tropical tree wood.');
    wood.name = `MonsoonProceduralTropicalTree${variant + 1}Wood`;
    wood.computeBoundingBox();
    wood.computeBoundingSphere();

    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const uvs: number[] = [];
    const palettes = [
      [0x214f34, 0x2f6840, 0x477c4d, 0x658f5c],
      [0x1e4935, 0x2a5e40, 0x3e744b, 0x587f54],
      [0x28583a, 0x376c42, 0x4d814f, 0x6d985f],
      [0x244c38, 0x315f43, 0x46764e, 0x628a59],
    ].map((palette) => palette.map((color) => new THREE.Color(color)));
    const palette = palettes[variant];
    const pushVertex = (point: THREE.Vector3, normal: THREE.Vector3, color: THREE.Color, u: number, v: number): void => {
      positions.push(point.x, point.y, point.z);
      normals.push(normal.x, normal.y, normal.z);
      colors.push(color.r, color.g, color.b);
      uvs.push(u, v);
    };
    for (let leaf = 0; leaf < config.leaves; leaf += 1) {
      const lobe = crownCenters[Math.floor(random() * crownCenters.length)];
      const theta = random() * Math.PI * 2;
      const radius = Math.pow(random(), 0.58);
      const vertical = (random() - 0.5) * (1.65 + variant * 0.08);
      const center = new THREE.Vector3(
        lobe.x + Math.cos(theta) * config.spread * 0.72 * radius,
        lobe.y + vertical,
        lobe.z + Math.sin(theta) * config.spread * 0.68 * radius,
      );
      const directionAngle = theta + (random() - 0.5) * 1.45;
      const axis = new THREE.Vector3(
        Math.cos(directionAngle),
        -0.26 + random() * 0.62,
        Math.sin(directionAngle),
      ).normalize();
      const facing = new THREE.Vector3(
        (random() - 0.5) * 0.72,
        0.68 + random() * 0.58,
        (random() - 0.5) * 0.72,
      ).normalize();
      const right = new THREE.Vector3().crossVectors(facing, axis);
      if (right.lengthSq() < 0.02) right.set(-axis.z, 0, axis.x);
      right.normalize();
      const normal = new THREE.Vector3().crossVectors(axis, right).normalize();
      const length = config.leafSize * (0.72 + random() * 0.72);
      const halfWidth = length * (0.18 + random() * 0.1);
      const root = center.clone().addScaledVector(axis, -length * 0.5);
      const tip = center.clone().addScaledVector(axis, length * 0.5);
      const a = root.clone().addScaledVector(right, halfWidth);
      const b = root.clone().addScaledVector(right, -halfWidth);
      const c = tip.clone().addScaledVector(right, -halfWidth);
      const d = tip.clone().addScaledVector(right, halfWidth);
      const tint = palette[Math.floor(random() * palette.length)].clone().multiplyScalar(0.9 + random() * 0.16);
      const atlasCell = (variant + leaf) % 4;
      const u0 = (atlasCell % 2) * 0.5 + 0.006;
      const v0 = Math.floor(atlasCell / 2) * 0.5 + 0.006;
      const u1 = u0 + 0.488;
      const v1 = v0 + 0.488;
      pushVertex(a, normal, tint, u0, v0);
      pushVertex(b, normal, tint, u1, v0);
      pushVertex(c, normal, tint, u1, v1);
      pushVertex(a, normal, tint, u0, v0);
      pushVertex(c, normal, tint, u1, v1);
      pushVertex(d, normal, tint, u0, v1);
    }
    const leaves = new THREE.BufferGeometry();
    leaves.name = `MonsoonProceduralTropicalTree${variant + 1}LeafCanopy`;
    leaves.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    leaves.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    leaves.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    leaves.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    leaves.computeBoundingBox();
    leaves.computeBoundingSphere();
    return [wood, leaves];
  }

  private createTropicalPalmGeometries(variant: 0 | 1): [THREE.BufferGeometry, THREE.BufferGeometry] {
    const woodParts: THREE.BufferGeometry[] = [];
    const woodColor = variant === 0 ? 0x675a43 : 0x594c38;
    const segmentCount = variant === 0 ? 7 : 8;
    const lean = variant === 0 ? new THREE.Vector2(0.85, -0.38) : new THREE.Vector2(-0.62, 0.5);
    let previous = new THREE.Vector3(0, 0, 0);
    for (let segment = 0; segment < segmentCount; segment += 1) {
      const t = (segment + 1) / segmentCount;
      const next = new THREE.Vector3(
        lean.x * t * t,
        (variant === 0 ? 11.2 : 13.4) * t,
        lean.y * t * t,
      );
      const direction = next.clone().sub(previous);
      const radius0 = THREE.MathUtils.lerp(0.44, 0.19, segment / segmentCount);
      const radius1 = THREE.MathUtils.lerp(0.44, 0.16, (segment + 1) / segmentCount);
      const trunk = this.colorizeProceduralGeometry(
        new THREE.CylinderGeometry(radius1, radius0, direction.length(), 7, 1, false),
        segment % 2 === 0 ? woodColor : new THREE.Color(woodColor).multiplyScalar(0.86).getHex(),
      );
      trunk.applyMatrix4(new THREE.Matrix4().compose(
        previous.clone().add(next).multiplyScalar(0.5),
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()),
        new THREE.Vector3(1, 1, 1),
      ));
      woodParts.push(trunk);
      previous = next;
    }
    for (let root = 0; root < 5; root += 1) {
      const angle = root / 5 * Math.PI * 2 + variant * 0.36;
      const start = new THREE.Vector3(0, 0.28, 0);
      const end = new THREE.Vector3(Math.cos(angle) * 1.45, 0.04, Math.sin(angle) * 1.45);
      const direction = end.clone().sub(start);
      const buttress = this.colorizeProceduralGeometry(
        new THREE.CylinderGeometry(0.04, 0.18, direction.length(), 5, 1, false),
        woodColor,
      );
      buttress.applyMatrix4(new THREE.Matrix4().compose(
        start.clone().add(end).multiplyScalar(0.5),
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()),
        new THREE.Vector3(1, 1, 1),
      ));
      woodParts.push(buttress);
    }
    const wood = mergeGeometries(woodParts, false);
    woodParts.forEach((part) => part.dispose());
    if (!wood) throw new Error('Failed to build Monsoon tropical palm wood.');
    wood.name = `MonsoonTropicalPalm${variant + 1}Wood`;
    wood.computeBoundingBox();
    wood.computeBoundingSphere();

    const crown = previous.clone().add(new THREE.Vector3(0, -0.02, 0));
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const random = randomFactory(0x2f98c6d1 ^ (variant * 0x9e3779b9));
    const dark = new THREE.Color(variant === 0 ? 0x2c6540 : 0x245a3d);
    const light = new THREE.Color(variant === 0 ? 0x6f9b5d : 0x5f8f58);
    const pushTriangle = (
      a: THREE.Vector3,
      b: THREE.Vector3,
      c: THREE.Vector3,
      normal: THREE.Vector3,
      color: THREE.Color,
    ): void => {
      for (const point of [a, b, c]) {
        positions.push(point.x, point.y, point.z);
        normals.push(normal.x, normal.y, normal.z);
        colors.push(color.r, color.g, color.b);
      }
    };
    const frondCount = variant === 0 ? 13 : 15;
    const leafletPairs = variant === 0 ? 9 : 11;
    for (let frond = 0; frond < frondCount; frond += 1) {
      const angle = frond / frondCount * Math.PI * 2 + random() * 0.12;
      const outward = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const side = new THREE.Vector3(-outward.z, 0, outward.x);
      const reach = (variant === 0 ? 4.9 : 5.65) * (0.86 + random() * 0.24);
      const lift = frond % 4 === 0 ? 1.25 : frond % 3 === 0 ? 0.45 : -0.35 - random() * 0.7;
      const centerAt = (t: number): THREE.Vector3 => crown.clone()
        .addScaledVector(outward, reach * (t - t * t * 0.08))
        .add(new THREE.Vector3(0, lift * t - t * t * (variant === 0 ? 1.15 : 1.5), 0));
      const normal = new THREE.Vector3(outward.x * 0.18, 0.96, outward.z * 0.18).normalize();
      for (let pair = 0; pair < leafletPairs; pair += 1) {
        const t = (pair + 0.45) / leafletPairs;
        const center = centerAt(t);
        const taper = Math.sin(Math.PI * t);
        const leafLength = (0.54 + taper * 0.72) * (variant === 0 ? 1 : 1.08);
        const leafWidth = 0.12 + taper * 0.11;
        const along = centerAt(Math.min(1, t + 0.035)).sub(center).normalize();
        for (const leafSide of [-1, 1]) {
          const direction = side.clone().multiplyScalar(leafSide);
          const root = center.clone().addScaledVector(direction, 0.05);
          const tip = center.clone()
            .addScaledVector(direction, leafLength)
            .addScaledVector(along, leafLength * 0.18)
            .add(new THREE.Vector3(0, -leafLength * 0.1, 0));
          const shoulderA = root.clone().addScaledVector(direction, leafLength * 0.34).addScaledVector(along, leafWidth);
          const shoulderB = root.clone().addScaledVector(direction, leafLength * 0.34).addScaledVector(along, -leafWidth);
          const color = dark.clone().lerp(light, t * 0.7 + random() * 0.18);
          pushTriangle(root, shoulderA, tip, normal, color);
          pushTriangle(root, tip, shoulderB, normal, color);
        }
      }
    }
    const leaves = new THREE.BufferGeometry();
    leaves.name = `MonsoonTropicalPalm${variant + 1}Fronds`;
    leaves.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    leaves.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    leaves.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    leaves.computeBoundingBox();
    leaves.computeBoundingSphere();
    return [wood, leaves];
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
    const biomeGroup = new THREE.Group();
    biomeGroup.name = 'MonsoonAuthoredHighlandBiome';
    const rockCount = this.rockField.rocks.length;
    const rockGroup = this.rockField.group;
    const grassGeometry = this.createGrassBladeGeometry();
    const grassMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      depthWrite: false,
      opacity: 0.22,
      side: THREE.DoubleSide,
      transparent: true,
      vertexColors: true,
    });
    grassMaterial.name = 'MonsoonBiomeGrassMaterial';
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
    const grassCount = mobile ? 9_000 : 29_000;
    const grassGroup = new THREE.Group();
    grassGroup.name = 'MonsoonLayeredWindGrass';
    const weedGeometry = this.createWeedGeometry();
    const weedMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      depthWrite: false,
      opacity: 0.88,
      side: THREE.DoubleSide,
      transparent: true,
      vertexColors: true,
    });
    weedMaterial.name = 'MonsoonBiomeWeedMaterial';
    weedMaterial.customProgramCacheKey = () => 'monsoon-reactive-weeds-v1';
    weedMaterial.onBeforeCompile = grassMaterial.onBeforeCompile;
    const weedCount = mobile ? 620 : 2_200;
    const weedGroup = new THREE.Group();
    weedGroup.name = 'MonsoonMixedWeedsAndSeedHeads';
    const fernGeometries = ([0, 1, 2] as const).map((variant) => this.createFernGeometry(variant));
    const fernMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x456744,
      emissiveIntensity: 0.18,
      roughness: 0.9,
      metalness: 0,
      side: THREE.DoubleSide,
      vertexColors: true,
    });
    fernMaterial.name = 'MonsoonBiomeFernMaterial';
    fernMaterial.customProgramCacheKey = () => 'monsoon-reactive-pinnate-ferns-v2';
    fernMaterial.onBeforeCompile = grassMaterial.onBeforeCompile;
    const fernCount = mobile ? 360 : 1_200;
    const fernGroup = new THREE.Group();
    fernGroup.name = 'MonsoonHeroPinnateFernFamilies';
    const massFernGeometries = ([0, 1, 2] as const).map((variant) => this.createFernLodGeometry(variant));
    const massFernCount = mobile ? 2_500 : 10_500;
    const massFernGroup = new THREE.Group();
    massFernGroup.name = 'MonsoonMassUnderstoryFernFamilies';
    const shrubCount = mobile ? 720 : 3_200;
    const shrubGeometries = ([0, 1, 2, 3] as const).map((variant) => this.createShrubGeometry(variant));
    const shrubMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x172515,
      emissiveIntensity: 0.16,
      roughness: 0.94,
      metalness: 0,
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    shrubMaterial.name = 'MonsoonBiomeProceduralTropicalShrubMaterial';
    this.groundCoverCulling.configureMaterial(grassMaterial, 'grass');
    this.groundCoverCulling.configureMaterial(weedMaterial, 'weed');
    this.groundCoverCulling.configureMaterial(fernMaterial, 'fern');
    this.groundCoverCulling.configureMaterial(shrubMaterial, 'shrub');
    const shrubGroup = new THREE.Group();
    shrubGroup.name = 'MonsoonProceduralTropicalShrubFamilies';
    // Keep the legacy faceted tree builder out of Monsoon. The runtime forest
    // uses project-original procedural branch, leaf-card, and palm geometry.
    const treeCount: number = 0;
    const treeGeometries: THREE.BufferGeometry[] = [];
    const treeMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      visible: false,
    });
    treeMaterial.name = 'MonsoonDisabledLegacyTreeMaterial';
    const treeGroup = new THREE.Group();
    treeGroup.name = 'MonsoonDisabledLegacyTreeFamilies';
    type TreeTier = {
      geometries: THREE.BufferGeometry[];
      partMaterials: THREE.Material[];
      partVariants: number[];
      variantNames: string[];
      variantHeights: number[];
    };
    const emptyTreeTier: TreeTier = {
      geometries: [],
      partMaterials: [],
      partVariants: [],
      variantNames: [],
      variantHeights: [],
    };
    const proceduralBarkTexture = this.createProceduralTropicalBarkTexture();
    const treeWoodMaterial = new THREE.MeshStandardMaterial({
      name: 'MonsoonBiomeProceduralTropicalWoodMaterial',
      color: 0xffffff,
      map: proceduralBarkTexture,
      emissive: 0x211c16,
      emissiveIntensity: 0.12,
      roughness: 0.94,
      metalness: 0,
      vertexColors: true,
    });
    const proceduralLeafTexture = this.createProceduralTropicalLeafTexture();
    const treeLeafMaterial = new THREE.MeshStandardMaterial({
      name: 'MonsoonBiomeProceduralTropicalLeafMaterial',
      color: 0xffffff,
      map: proceduralLeafTexture,
      alphaTest: 0.34,
      transparent: false,
      depthWrite: true,
      emissive: 0x102317,
      emissiveIntensity: 0.14,
      roughness: 0.88,
      metalness: 0,
      vertexColors: true,
      side: THREE.DoubleSide,
      shadowSide: THREE.DoubleSide,
    });
    const palmLeafMaterial = new THREE.MeshStandardMaterial({
      name: 'MonsoonBiomeProceduralPalmLeafMaterial',
      color: 0xffffff,
      emissive: 0x0d2115,
      emissiveIntensity: 0.14,
      roughness: 0.9,
      metalness: 0,
      vertexColors: true,
      side: THREE.DoubleSide,
      shadowSide: THREE.DoubleSide,
    });
    const applyProceduralCanopyWind = (
      material: THREE.MeshStandardMaterial,
      cacheKey: string,
      strength: number,
    ): void => {
      material.customProgramCacheKey = () => cacheKey;
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = this.grassUniforms.uTime;
        shader.uniforms.uWind = this.grassUniforms.uWind;
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <common>',
            `#include <common>
            uniform float uTime;
            uniform float uWind;`,
          )
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            #ifdef USE_INSTANCING
              vec3 monsoonCanopyRoot = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
              float monsoonCanopyWave = sin(uTime * 0.74 + monsoonCanopyRoot.x * 0.021 + monsoonCanopyRoot.z * 0.017)
                + sin(uTime * 1.31 + monsoonCanopyRoot.z * 0.028) * 0.32;
              float monsoonCanopyFlutter = sin(uTime * 2.2 + position.x * 2.7 + position.z * 2.1) * 0.18;
              transformed.x += (monsoonCanopyWave + monsoonCanopyFlutter) * uWind * ${strength.toFixed(3)};
              transformed.z += monsoonCanopyWave * uWind * ${
                (strength * 0.56).toFixed(3)
              };
            #endif`,
          );
      };
    };
    applyProceduralCanopyWind(treeLeafMaterial, 'monsoon-procedural-broadleaf-wind-v1', 0.12);
    applyProceduralCanopyWind(palmLeafMaterial, 'monsoon-procedural-palm-wind-v1', 0.2);
    const proceduralTreeBuilds = [
      this.createTropicalTreeLodGeometries(0),
      this.createTropicalTreeLodGeometries(1),
      this.createTropicalTreeLodGeometries(2),
      this.createTropicalTreeLodGeometries(3),
      this.createTropicalPalmGeometries(0),
      this.createTropicalPalmGeometries(1),
    ];
    const massCanopyTier: TreeTier = {
      geometries: proceduralTreeBuilds.flatMap(([wood, leaves]) => [wood, leaves]),
      partMaterials: proceduralTreeBuilds.flatMap((_, variant) => [
        treeWoodMaterial,
        variant >= 4 ? palmLeafMaterial : treeLeafMaterial,
      ]),
      partVariants: proceduralTreeBuilds.flatMap((_, variant) => [variant, variant]),
      variantNames: [
        'RainforestBroadleaf',
        'HighlandEmergent',
        'SpreadingKapok',
        'StormCanopyBroadleaf',
        'WindwardPalm',
        'CrownPalm',
      ],
      variantHeights: proceduralTreeBuilds.map(([wood, leaves]) => Math.max(
        wood.boundingBox ? wood.boundingBox.max.y - Math.min(0, wood.boundingBox.min.y) : 0,
        leaves.boundingBox ? leaves.boundingBox.max.y - Math.min(0, leaves.boundingBox.min.y) : 0,
        1,
      )),
    };
    const heroTreeTier = emptyTreeTier;
    const heroTreeCount = 0;
    const massCanopyTreeCount = mobile ? 360 : 1_400;
    const heroTreeGroup = new THREE.Group();
    heroTreeGroup.name = 'MonsoonDisabledImportedTreeTier';
    const massCanopyTreeGroup = new THREE.Group();
    massCanopyTreeGroup.name = 'MonsoonProceduralTropicalTreeFamilies';
    this.geometries.push(
      grassGeometry,
      weedGeometry,
      ...fernGeometries,
      ...massFernGeometries,
      ...shrubGeometries,
      ...treeGeometries,
      ...heroTreeTier.geometries,
      ...massCanopyTier.geometries,
    );
    this.materials.push(grassMaterial, weedMaterial, fernMaterial, shrubMaterial, treeMaterial);
    this.materials.push(treeWoodMaterial, treeLeafMaterial, palmLeafMaterial);
    this.textures.push(proceduralBarkTexture, proceduralLeafTexture);
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const scaleVector = new THREE.Vector3();
    const instanceColor = new THREE.Color();
    const grassBuckets = Array.from({ length: VEGETATION_CHUNK_COUNT }, () => [] as number[]);
    const weedBuckets = Array.from({ length: VEGETATION_CHUNK_COUNT }, () => [] as number[]);
    const fernBuckets = fernGeometries.map(() => Array.from({ length: VEGETATION_CHUNK_COUNT }, () => [] as number[]));
    const massFernBuckets = massFernGeometries.map(() => Array.from({ length: VEGETATION_CHUNK_COUNT }, () => [] as number[]));
    const shrubBuckets = shrubGeometries.map(() => Array.from({ length: VEGETATION_CHUNK_COUNT }, () => [] as number[]));
    const treeBuckets = treeGeometries.map(() => Array.from({ length: VEGETATION_CHUNK_COUNT }, () => [] as number[]));
    const heroTreeBuckets = heroTreeTier.geometries.map(() => Array.from({ length: VEGETATION_CHUNK_COUNT }, () => [] as number[]));
    const massCanopyTreeBuckets = massCanopyTier.geometries.map(() => Array.from({ length: VEGETATION_CHUNK_COUNT }, () => [] as number[]));
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
    type VegetationProfile = 'grass' | 'weed' | 'fern' | 'shrub' | 'tree';
    type BiomeZone = readonly [centerX: number, centerZ: number, radiusX: number, radiusZ: number, density: number];
    const placementNormal = new THREE.Vector3();
    const biomeZones: Readonly<Record<VegetationProfile, ReadonlyArray<BiomeZone>>> = {
      grass: [
        [-112, 61, 64, 34, 1.12], [-48, -96, 76, 39, 1.18], [82, 68, 70, 39, 1.02],
        [124, -48, 61, 42, 0.9], [4, -142, 94, 30, 0.82], [-159, -8, 48, 53, 0.72],
        [18, 18, 68, 48, 0.58],
      ],
      weed: [
        [-118, 54, 49, 22, 1.2], [-52, -103, 60, 25, 1.05], [75, 61, 54, 25, 1.12],
        [120, -48, 46, 28, 0.82], [8, -139, 68, 18, 0.92], [-154, -18, 34, 32, 0.7],
      ],
      fern: [
        [-176, 92, 34, 21, 0.82], [-136, 64, 54, 29, 1.32], [-91, 103, 46, 24, 1.12],
        [-42, 121, 52, 24, 0.92], [28, 116, 54, 25, 0.88], [83, 82, 52, 29, 1.18],
        [142, 54, 43, 32, 0.94], [164, -12, 35, 38, 0.74], [128, -59, 48, 31, 1.02],
        [78, -101, 56, 26, 0.92], [18, -142, 75, 21, 1.04], [-54, -108, 66, 30, 1.25],
        [-116, -82, 49, 34, 1.02], [-164, -28, 39, 41, 0.84], [-19, 43, 45, 28, 0.82],
        [43, 34, 42, 28, 0.78],
      ],
      shrub: [
        [-174, 88, 31, 19, 0.75], [-132, 62, 49, 28, 1.2], [-78, 108, 45, 23, 0.96],
        [-20, 120, 54, 23, 0.78], [48, 104, 49, 26, 0.82], [91, 72, 48, 29, 1.08],
        [148, 40, 37, 34, 0.78], [150, -28, 35, 37, 0.7], [122, -65, 46, 31, 0.98],
        [68, -111, 53, 25, 0.82], [4, -145, 70, 19, 0.88], [-59, -108, 60, 29, 1.18],
        [-121, -76, 47, 33, 0.9], [-166, -20, 35, 38, 0.72],
      ],
      tree: [
        [-171, 91, 28, 17, 0.72], [-131, 62, 44, 24, 1.22], [-72, 109, 40, 20, 0.88],
        [-14, 120, 48, 20, 0.7], [48, 105, 42, 22, 0.76], [91, 70, 42, 25, 1.04],
        [148, 38, 31, 28, 0.68], [151, -26, 29, 31, 0.62], [124, -61, 40, 26, 0.94],
        [64, -111, 47, 21, 0.74], [2, -146, 61, 16, 0.78], [-61, -109, 53, 25, 1.2],
        [-122, -73, 40, 28, 0.82], [-165, -19, 29, 31, 0.64],
      ],
    };
    const routeLimits: Readonly<Record<VegetationProfile, number>> = {
      grass: 0.27,
      weed: 0.2,
      fern: 0.16,
      shrub: 0.12,
      tree: 0.085,
    };
    const baseClearance: Readonly<Record<VegetationProfile, number>> = {
      grass: 205,
      weed: 225,
      fern: 245,
      shrub: 265,
      tree: 285,
    };
    const pickZone = (zones: ReadonlyArray<BiomeZone>): BiomeZone => {
      const total = zones.reduce((sum, zone) => sum + zone[4], 0);
      let roll = random() * total;
      for (const zone of zones) {
        roll -= zone[4];
        if (roll <= 0) return zone;
      }
      return zones[zones.length - 1];
    };
    const findPlacement = (profile: VegetationProfile): THREE.Vector3 | null => {
      const zones = biomeZones[profile];
      const attemptBudget = profile === 'tree' ? 256 : profile === 'shrub' ? 128 : 96;
      for (let attempt = 0; attempt < attemptBudget; attempt += 1) {
        let x: number;
        let z: number;
        let zoneDensity = 0.42;
        let radial = 0.86;
        const clusterChance = profile === 'tree' ? 0.98 : profile === 'shrub' ? 0.96 : profile === 'fern' ? 0.97 : profile === 'weed' ? 0.91 : 0.84;
        if (random() < clusterChance) {
          const [centerX, centerZ, radiusX, radiusZ, density] = pickZone(zones);
          const angle = random() * Math.PI * 2;
          radial = Math.sqrt(random());
          const meander = 0.82 + Math.sin(angle * 3 + centerX * 0.04 - centerZ * 0.03) * 0.16;
          x = mw(centerX + Math.cos(angle) * radiusX * radial * meander);
          z = mw(centerZ + Math.sin(angle) * radiusZ * radial / meander);
          zoneDensity = density;
        } else {
          x = (random() - 0.5) * mw(430);
          z = (random() - 0.5) * mw(350);
        }
        const y = sampleMonsoonHeight(x, z, this.seed);
        const masks = sampleMonsoonMasks(x, z);
        const designY = y / MONSOON_WORLD_SCALE;
        const designX = x / MONSOON_WORLD_SCALE;
        const designZ = z / MONSOON_WORLD_SCALE;
        const moisture = THREE.MathUtils.clamp(masks.crater * 0.62 + (1 - radial) * 0.56 + (1 - masks.coast) * 0.18, 0, 1);
        const patchNoise = 0.5 + 0.5 * Math.sin(designX * 0.21 + Math.sin(designZ * 0.13) * 2.2)
          * Math.cos(designZ * 0.17 - designX * 0.04);
        const profileAffinity = profile === 'fern'
          ? 0.38 + moisture * 0.58
          : profile === 'tree'
            ? 0.32 + moisture * 0.4
            : profile === 'shrub'
              ? 0.42 + patchNoise * 0.42
              : 0.5 + moisture * 0.24 + patchNoise * 0.2;
        const clearOfBases = (
          Math.hypot(x - mw(-85), z - mw(130)) > baseClearance[profile]
          && Math.hypot(x - mw(95), z - mw(-120)) > baseClearance[profile]
        );
        if (
          y > MONSOON_DIVIDE.waterY + 3.4
          && masks.route < routeLimits[profile]
          && masks.coast < (profile === 'grass' ? 0.92 : profile === 'fern' ? 0.84 : 0.88)
          && clearOfBases
        ) {
          const highlandScour = THREE.MathUtils.smoothstep(designY, 48, 84);
          const altitudeSurvival = 1 - highlandScour * (profile === 'tree' ? 0.96 : profile === 'shrub' ? 0.84 : profile === 'fern' ? 0.76 : 0.62);
          const centerFalloff = 0.28 + Math.pow(1 - radial, profile === 'tree' ? 0.62 : 0.82) * 0.88;
          const density = THREE.MathUtils.clamp(zoneDensity * profileAffinity * altitudeSurvival * centerFalloff, 0.04, 0.98);
          if (random() >= density) continue;
          const normalY = sampleMonsoonNormal(x, z, placementNormal, this.seed).y;
          const minimumNormal = profile === 'tree' ? 0.8 : profile === 'shrub' ? 0.72 : profile === 'fern' ? 0.64 : 0.57;
          if (normalY < minimumNormal || this.isConcreteFootprint(x, z)) continue;
          return new THREE.Vector3(x, y, z);
        }
      }
      return null;
    };
    const placedCounts = { grass: 0, weed: 0, fern: [0, 0, 0], shrub: [0, 0, 0, 0], tree: [0, 0, 0] };
    const placedMassFernCounts = massFernGeometries.map(() => 0);
    const placedHeroTreeCounts = heroTreeTier.variantNames.map(() => 0);
    const placedMassCanopyTreeCounts = massCanopyTier.variantNames.map(() => 0);
    const treeRepresentativePositions = massCanopyTier.variantNames.map(() => [] as Array<{ x: number; y: number; z: number }>);
    const pack = (bucket: number[], position: THREE.Vector3, yaw: number, sx: number, sy: number, sz: number, color: number): void => {
      bucket.push(position.x, position.y, position.z, yaw, sx, sy, sz, color);
    };
    for (let index = 0; index < grassCount; index += 1) {
      const position = findPlacement('grass');
      if (!position) continue;
      const yaw = random() * Math.PI * 2;
      const scale = 0.7 + random() * 0.92;
      const colorPick = random();
      const color = colorPick > 0.84 ? 0xd6e3ad : colorPick > 0.34 ? 0xb3ca8f : 0x9ab67e;
      pack(grassBuckets[chunkFor(position.x, position.z)], position.setY(position.y + 0.018), yaw, scale * (0.86 + random() * 0.28), scale, scale, color);
      placedCounts.grass += 1;
    }
    for (let index = 0; index < weedCount; index += 1) {
      const position = findPlacement('weed');
      if (!position) continue;
      const yaw = random() * Math.PI * 2;
      const scale = 0.86 + random() * 1.08;
      const pick = random();
      const color = pick > 0.82 ? 0xf0dcaa : pick > 0.42 ? 0xdce4bd : 0xc5d7ac;
      pack(weedBuckets[chunkFor(position.x, position.z)], position.setY(position.y + 0.015), yaw, scale, scale * (0.9 + random() * 0.45), scale, color);
      placedCounts.weed += 1;
    }
    for (let index = 0; index < fernCount; index += 1) {
      const position = findPlacement('fern');
      if (!position) continue;
      const familyRoll = random();
      const family = familyRoll > 0.73 ? 2 : familyRoll > 0.36 ? 1 : 0;
      const yaw = random() * Math.PI * 2;
      const hero = random() > 0.94 ? 1.32 : 1;
      const width = (0.42 + random() * 0.78) * hero;
      const height = width * (family === 2 ? 1.04 + random() * 0.32 : 0.72 + random() * 0.32);
      const pick = random();
      const color = pick > 0.82 ? 0xd7e1bd : pick > 0.4 ? 0xb9ce9f : 0x9eb989;
      pack(fernBuckets[family][chunkFor(position.x, position.z)], position.setY(position.y + 0.024), yaw, width, height, width * (0.88 + random() * 0.24), color);
      placedCounts.fern[family] += 1;
    }
    for (let index = 0; index < massFernCount; index += 1) {
      const position = findPlacement('fern');
      if (!position) continue;
      const familyRoll = random();
      const family = familyRoll > 0.76 ? 2 : familyRoll > 0.38 ? 1 : 0;
      const scale = (0.54 + random() * 1.12) * (random() > 0.96 ? 1.35 : 1);
      const colorRoll = random();
      const color = colorRoll > 0.82 ? 0xc1d7aa : colorRoll > 0.38 ? 0x96b989 : 0x78a078;
      pack(
        massFernBuckets[family][chunkFor(position.x, position.z)],
        position.setY(position.y + 0.018),
        random() * Math.PI * 2,
        scale * (0.82 + random() * 0.36),
        scale * (0.78 + random() * 0.42),
        scale * (0.82 + random() * 0.36),
        color,
      );
      placedMassFernCounts[family] += 1;
    }
    for (let index = 0; index < shrubCount; index += 1) {
      const position = findPlacement('shrub');
      if (!position) continue;
      const familyRoll = random();
      const family = familyRoll > 0.79 ? 3 : familyRoll > 0.52 ? 2 : familyRoll > 0.25 ? 1 : 0;
      const yaw = random() * Math.PI * 2;
      const hero = random() > 0.9 ? 1.38 : 1;
      const width = (0.9 + random() * 1.65) * hero;
      const height = width * (family === 0 ? 0.88 + random() * 0.28 : family === 1 ? 0.7 + random() * 0.24 : 0.5 + random() * 0.18);
      const color = random() > 0.5 ? 0xc3d1b9 : 0x9fb69b;
      pack(shrubBuckets[family][chunkFor(position.x, position.z)], position.setY(position.y + 0.03), yaw, width, height, width * (0.82 + random() * 0.34), color);
      placedCounts.shrub[family] += 1;
    }
    for (let index = 0; index < treeCount; index += 1) {
      const position = findPlacement('tree');
      if (!position) continue;
      const familyRoll = random();
      const family = familyRoll > 0.78 ? 2 : familyRoll > 0.4 ? 1 : 0;
      const yaw = random() * Math.PI * 2;
      const scale = family === 0 ? 0.9 + random() * 1.25 : family === 1 ? 0.82 + random() * 1.18 : 0.78 + random() * 1.12;
      const color = random() > 0.5 ? 0xd7e1ce : 0xbfd1bb;
      pack(treeBuckets[family][chunkFor(position.x, position.z)], position.setY(position.y + 0.04), yaw, scale * (0.86 + random() * 0.34), scale * (0.94 + random() * 0.28), scale, color);
      placedCounts.tree[family] += 1;
    }
    const placeTreeTier = (
      tier: TreeTier,
      count: number,
      buckets: number[][][],
      placed: number[],
      minimumHeight: number,
      maximumHeight: number,
      massCanopy: boolean,
    ): void => {
      for (let index = 0; index < count; index += 1) {
        const position = findPlacement('tree');
        if (!position) continue;
        const masks = sampleMonsoonMasks(position.x, position.z);
        const designY = position.y / MONSOON_WORLD_SCALE;
        const palmHabitat = masks.coast < 0.72 && designY < 48;
        const variant = massCanopy && tier.variantNames.length === 6
          ? palmHabitat && random() > 0.72
            ? random() > 0.5 ? 4 : 5
            : (() => {
              const roll = random();
              return roll > 0.82 ? 1 : roll > 0.6 ? 3 : roll > 0.3 ? 2 : 0;
            })()
          : index % tier.variantNames.length;
        const speciesMinimum = variant === 1
          ? Math.max(minimumHeight, 24)
          : variant >= 4
            ? Math.max(minimumHeight, 18)
            : Math.min(minimumHeight, 15);
        const speciesMaximum = variant === 1
          ? Math.max(maximumHeight, 44)
          : variant >= 4
            ? Math.max(maximumHeight, 39)
            : variant === 2
              ? Math.max(maximumHeight, 37)
              : Math.max(maximumHeight, 35);
        const understoryTree = variant !== 1 && variant < 4 && random() < 0.24;
        const desiredHeight = understoryTree
          ? 9 + random() * 9
          : speciesMinimum + random() * (speciesMaximum - speciesMinimum);
        const scale = desiredHeight / Math.max(tier.variantHeights[variant], 0.1);
        const colorRoll = random();
        const color = massCanopy
          ? colorRoll > 0.72 ? 0xf2f4e8 : colorRoll > 0.34 ? 0xdfe9d7 : 0xd2e0ca
          : colorRoll > 0.72 ? 0xdce9d2 : colorRoll > 0.34 ? 0xc8dbbb : 0xb2c9a4;
        const yaw = random() * Math.PI * 2;
        const sx = scale * (0.74 + random() * 0.48);
        const sy = scale * (0.86 + random() * 0.3);
        const sz = scale * (0.74 + random() * 0.48);
        position.setY(position.y + 0.035);
        const chunk = chunkFor(position.x, position.z);
        tier.partVariants.forEach((partVariant, part) => {
          if (partVariant === variant) pack(buckets[part][chunk], position, yaw, sx, sy, sz, color);
        });
        if (massCanopy && treeRepresentativePositions[variant].length < 4) {
          treeRepresentativePositions[variant].push({ x: position.x, y: position.y, z: position.z });
        }
        placed[variant] += 1;
      }
    };
    placeTreeTier(heroTreeTier, heroTreeCount, heroTreeBuckets, placedHeroTreeCounts, 18, 36, false);
    placeTreeTier(massCanopyTier, massCanopyTreeCount, massCanopyTreeBuckets, placedMassCanopyTreeCounts, 18, 34, true);
    const buildChunks = (
      name: string,
      geometry: THREE.BufferGeometry,
      material: THREE.Material | THREE.Material[],
      buckets: number[][],
      target: THREE.Group,
      castShadow = false,
      receiveShadow = false,
      groundCoverProfile?: GroundCoverProfile,
    ): void => {
      const renderBuckets = groundCoverProfile ? partitionGroundCover(buckets) : buckets;
      for (let chunk = 0; chunk < renderBuckets.length; chunk += 1) {
        const packed = renderBuckets[chunk];
        const count = packed.length / 8;
        if (count === 0) continue;
        const mesh = new THREE.InstancedMesh(geometry, material, count);
        mesh.name = `${name}Chunk${chunk}`;
        mesh.matrixAutoUpdate = false;
        mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        for (let index = 0; index < count; index += 1) {
          const offset = index * 8;
          this.ambientPosition.set(packed[offset], packed[offset + 1], packed[offset + 2]);
          quaternion.setFromEuler(euler.set(0, packed[offset + 3], 0));
          scaleVector.set(packed[offset + 4], packed[offset + 5], packed[offset + 6]);
          matrix.compose(this.ambientPosition, quaternion, scaleVector);
          mesh.setMatrixAt(index, matrix);
          mesh.setColorAt(index, instanceColor.setHex(packed[offset + 7]));
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) {
          mesh.instanceColor.setUsage(THREE.StaticDrawUsage);
          mesh.instanceColor.needsUpdate = true;
        }
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
        mesh.castShadow = castShadow;
        mesh.receiveShadow = receiveShadow;
        if (groundCoverProfile) this.groundCoverCulling.add(mesh, target, groundCoverProfile);
        else target.add(mesh);
      }
    };
    buildChunks('MonsoonWindGrass', grassGeometry, grassMaterial, grassBuckets, grassGroup, false, false, 'grass');
    buildChunks('MonsoonMixedWeedsAndSeedHeads', weedGeometry, weedMaterial, weedBuckets, weedGroup, false, false, 'weed');
    fernGeometries.forEach((geometry, family) => {
      buildChunks(`MonsoonFernFamily${family + 1}`, geometry, fernMaterial, fernBuckets[family], fernGroup, false, true, 'fern');
    });
    massFernGeometries.forEach((geometry, family) => {
      buildChunks(
        `MonsoonMassFernFamily${family + 1}`,
        geometry,
        fernMaterial,
        massFernBuckets[family],
        massFernGroup,
        false,
        true,
        'fern',
      );
    });
    shrubGeometries.forEach((geometry, family) => {
      buildChunks(`MonsoonShrubFamily${family + 1}`, geometry, shrubMaterial, shrubBuckets[family], shrubGroup, false, true, 'shrub');
    });
    treeGeometries.forEach((geometry, family) => {
      buildChunks(`MonsoonTreeFamily${family + 1}`, geometry, treeMaterial, treeBuckets[family], treeGroup, !mobile, true);
    });
    if (heroTreeTier.partMaterials.length > 0) {
      heroTreeTier.geometries.forEach((geometry, family) => {
        buildChunks(
          `MonsoonHeroTropicalTreeFamily${family + 1}`,
          geometry,
          heroTreeTier.partMaterials[family],
          heroTreeBuckets[family],
          heroTreeGroup,
          false,
          true,
        );
      });
    }
    if (massCanopyTier.partMaterials.length > 0) {
      massCanopyTier.geometries.forEach((geometry, family) => {
        buildChunks(
          `MonsoonProceduralTropicalTreePart${family + 1}`,
          geometry,
          massCanopyTier.partMaterials[family],
          massCanopyTreeBuckets[family],
          massCanopyTreeGroup,
          false,
          true,
        );
      });
    }
    const placedTreeCounts = Array.from(
      { length: Math.max(placedHeroTreeCounts.length, placedMassCanopyTreeCounts.length) },
      (_, index) => (placedHeroTreeCounts[index] ?? 0) + (placedMassCanopyTreeCounts[index] ?? 0),
    );
    biomeGroup.userData.biomeVegetation = {
      deterministic: true,
      vegetationConstruction: 'fully-procedural',
      familyCounts: {
        boulder: this.rockField.diagnostics.archetypes.length,
        fern: fernGeometries.length + massFernGeometries.length,
        shrub: shrubGeometries.length,
        tree: (treeCount > 0 ? treeGeometries.length : 0) + new Set([
          ...heroTreeTier.variantNames,
          ...massCanopyTier.variantNames,
        ]).size,
      },
      requestedCounts: {
        rock: rockCount,
        grass: grassCount,
        weed: weedCount,
        fern: fernCount + massFernCount,
        shrub: shrubCount,
        tree: treeCount + heroTreeCount + massCanopyTreeCount,
      },
      visualPlantEstimate: {
        fern: fernCount + massFernCount,
        shrub: shrubCount,
        tree: treeCount + heroTreeCount + massCanopyTreeCount,
      },
      placedCounts: {
        ...placedCounts,
        fern: [...placedCounts.fern, ...placedMassFernCounts],
        shrub: placedCounts.shrub,
        tree: [...(treeCount > 0 ? placedCounts.tree : []), ...placedTreeCounts],
      },
      treeConstruction: 'fully-procedural',
      treeVariantNames: massCanopyTier.variantNames,
      treeRepresentativePositions,
      treeLodCounts: { hero: heroTreeCount, massCanopy: massCanopyTreeCount },
      fernLodCounts: { hero: fernCount, mass: massFernCount, scanned: 0 },
      routeLimits,
      baseClearance,
      densityZoneCounts: Object.fromEntries(Object.entries(biomeZones).map(([profile, zones]) => [profile, zones.length])),
      scaleRanges: {
        fern: [0.42, 3.34],
        shrub: [0.9, 3.52],
        tree: [9, 44],
        boulder: this.rockField.diagnostics.diameterRange,
      },
      rockField: this.rockField.diagnostics,
      scannedFernSource: 'Project-original procedural pinnate fern geometry',
      scannedFernLicense: 'Riftline project original',
      scannedShrubSource: 'Project-original procedural tropical shrub geometry',
      scannedShrubLicense: 'Riftline project original',
      shrubLodCounts: { hero: shrubCount, thicket: 0 },
      scannedTreeSource: 'Project-original procedural broadleaf, emergent, and palm geometry',
      scannedTreeLicense: 'Riftline project original',
    };
    biomeGroup.add(
      rockGroup,
      grassGroup,
      weedGroup,
      fernGroup,
      massFernGroup,
      shrubGroup,
      treeGroup,
      heroTreeGroup,
      massCanopyTreeGroup,
    );
    this.group.add(biomeGroup);
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

    // The passive quadruped grazers were replaced by the three combat-capable
    // flamethrower grenadiers managed by Game. Ambient birds and beetles stay
    // here so the biome retains its small-scale life and motion.
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
    const count = window.matchMedia('(pointer: coarse)').matches ? 460 : 1_280;
    const random = randomFactory(this.seed ^ 0x57024d11);
    const positions = new Float32Array(count * 6);
    for (let index = 0; index < count; index += 1) {
      const offset = index * 6;
      const x = -130 + random() * 260;
      const y = random() * 120;
      const z = -130 + random() * 260;
      const length = 2.8 + random() * 5.2;
      positions[offset] = x;
      positions[offset + 1] = y;
      positions[offset + 2] = z;
      positions[offset + 3] = x - 1.15;
      positions[offset + 4] = y - length;
      positions[offset + 5] = z - 0.62;
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
          vFade = smoothstep(0.0, 20.0, p.y) * (1.0 - smoothstep(90.0, 118.0, p.y)) * uIntensity;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        varying float vFade;
        void main() {
          gl_FragColor = vec4(0.62, 0.86, 1.0, vFade * 0.7);
        }
      `,
    });
    this.geometries.push(geometry);
    this.materials.push(material);
    const rain = new THREE.LineSegments(geometry, material);
    rain.name = 'MonsoonWindSlantedRainSheets';
    rain.frustumCulled = false;
    this.rain = rain;
    this.group.add(rain);
  }

  private createStormLightning(): void {
    const random = randomFactory(this.seed ^ 0x11a7f11e);
    const start = new THREE.Vector3(76, 286, -84);
    const end = new THREE.Vector3(220, 86, 150);
    const positions: number[] = [];
    const trunk: THREE.Vector3[] = [];
    const segments = 13;
    for (let index = 0; index <= segments; index += 1) {
      const t = index / segments;
      const point = start.clone().lerp(end, t);
      if (index > 0 && index < segments) {
        point.x += (random() - 0.5) * 22;
        point.z += (random() - 0.5) * 18;
      }
      trunk.push(point);
      if (index > 0) positions.push(...trunk[index - 1].toArray(), ...point.toArray());
    }
    for (const branchIndex of [4, 7, 9]) {
      const root = trunk[branchIndex];
      const direction = new THREE.Vector3(
        (random() - 0.5) * 68,
        -24 - random() * 34,
        (random() - 0.5) * 58,
      );
      const elbow = root.clone().addScaledVector(direction, 0.48);
      const tip = root.clone().add(direction);
      positions.push(...root.toArray(), ...elbow.toArray(), ...elbow.toArray(), ...tip.toArray());
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const material = new THREE.LineBasicMaterial({
      blending: THREE.AdditiveBlending,
      color: 0xc8f4ff,
      depthWrite: false,
      opacity: 0,
      toneMapped: false,
      transparent: true,
    });
    material.name = 'MonsoonCollectorLightning';
    const lightning = new THREE.LineSegments(geometry, material);
    lightning.name = 'MonsoonCollectorLightningBranches';
    lightning.frustumCulled = false;
    lightning.visible = false;
    lightning.renderOrder = 5;
    this.lightning = lightning;
    this.lightningMaterial = material;
    this.geometries.push(geometry);
    this.materials.push(material);
    this.group.add(lightning);
  }
}
