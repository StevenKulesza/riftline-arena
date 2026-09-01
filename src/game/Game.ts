import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { loadGrenadeAsset } from '../assets/GrenadeAsset';
import { createWeaponViewModel, updateWeaponViewModel, type WeaponViewModel } from '../assets/WeaponViewModel';
import { JetpackRig } from '../assets/JetpackRig';
import { PlayerAvatar } from '../assets/PlayerAvatar';
import { InputController } from '../core/InputController';
import { Loop } from '../core/Loop';
import { createRenderer, getRenderDpr, resizeRenderer } from '../core/Renderer';
import { Bot } from '../entities/Bot';
import { AudioSystem } from '../systems/AudioSystem';
import { AdaptiveQualitySystem } from '../systems/AdaptiveQualitySystem';
import {
  BUSTER_DRONE_TUNING,
  DRONE_TUNING,
  DroneSwarmSystem,
  type BusterShardEvent,
  type CombatDroneRuntime,
  type DroneLaserEvent,
  type DroneRayHit,
  type DroneTargetOwner,
  type DroneTargetSnapshot,
} from '../systems/DroneSwarmSystem';
import {
  FighterAiPilotController,
  type FighterAiIntent,
  type FighterAiVehicleSnapshot,
} from '../systems/FighterAiPilotController';
import { FluxCoreDirector, type FluxCoreAnchor } from '../systems/FluxCoreDirector';
import { Hud } from '../systems/Hud';
import { MapLightingRig } from '../systems/MapLightingRig';
import { StyleSystem, type StyleEvent } from '../systems/StyleSystem';
import {
  SPEED_EFFECT_FULL_KMH,
  SPEED_EFFECT_START_KMH,
  SpeedTrailSystem,
  speedEffectIntensity,
  type SpeedTrailSource,
} from '../systems/SpeedTrailSystem';
import { WeatherGameplaySystem, type WeatherGameplaySnapshot } from '../systems/WeatherGameplaySystem';
import { WeaponVfxSystem } from '../systems/WeaponVfxSystem';
import { WorldHealthBarSystem } from '../systems/WorldHealthBarSystem';
import { FighterArenaCollisionAdapter } from '../systems/FighterArenaCollisionAdapter';
import {
  FIGHTER_BOARD_RANGE,
  FIGHTER_HULL_MAX,
  FIGHTER_MISSILE_COOLDOWN,
  FIGHTER_PRIMARY_COOLDOWN,
  FIGHTER_RESPAWN_SECONDS,
  FIGHTER_SHIELD_MAX,
  createQuickSenseFighters,
  nearestBoardableFighter,
  resetFighterAtPad,
  updateFighterPresentation,
  type FighterRuntime,
} from '../systems/FighterSquadronSystem';
import { createSeededRandom } from '../utils/random';
import { Arena, type ArenaRuntime, type ArenaSurface, type CapsuleContact, type SurfaceHit } from './Arena';
import { GRAPPLE, GRENADE, MATCH_DURATION, MOVEMENT, POWERUP, SCORE_LIMIT, WEAPONS, type WeaponDefinition, type WeaponId } from './config';
import { JetpackEnergy } from './JetpackEnergy';
import {
  FIGHTER_FIXED_STEP,
  FIGHTER_FLIGHT_TUNING,
  resetFighterFlightState,
  stepFighterFlight,
  type FighterCollisionHit,
  type FighterCollisionQuery,
} from './FighterFlightPhysics';
import { skiMomentumCurve, type SkiMomentumCurve } from './SkiMomentum';

type GameMode = 'ready' | 'countdown' | 'running' | 'respawning' | 'paused' | 'complete';
type ViewMode = 'first-person' | 'third-person';
type Owner = 'player' | number;
type DamageSource = Owner | 'drone';
type PickupKind = 'health' | 'armor' | 'damage' | 'speed' | WeaponId;
type CountdownCue = 'READY' | '3' | '2' | '1';
export type GameLoadProgress = {
  fraction: number;
  label: string;
};
type GameLoadReporter = (progress: GameLoadProgress) => void;
// Loading must make forward progress even when the tab is backgrounded. Most
// browsers suspend requestAnimationFrame in hidden tabs, which previously left
// QuickSense parked at 6% until the page became visible. A zero-delay timer
// still gives the loading UI a scheduling opportunity without depending on a
// render callback.
const yieldDuringLoad = (): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, 0));
type CoreAnchor = FluxCoreAnchor & { readonly position: THREE.Vector3 };
type PlayerSweepResult = {
  wallNormal: THREE.Vector3 | null;
  ceilingNormal: THREE.Vector3 | null;
};

type QuickSenseStructureAudit = {
  id: string;
  name: string;
  category: string;
  profile: string;
  accent: string;
  state: string;
  connection: 'terrain-foundation' | 'terrain-tethers';
  position: { x: number; y: number; z: number };
};

type QuickSenseOutpostTowerAudit = {
  center: { x: number; y: number; z: number };
  entrance: { x: number; y: number; z: number };
  core: { x: number; y: number; z: number };
  flights: Array<{
    name: string;
    start: { x: number; y: number; z: number };
    end: { x: number; y: number; z: number };
  }>;
  bounds: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  };
  height: number;
  habitableHeight: number;
  collision: {
    engine: 'hybrid-authored-bvh';
    triangles: number;
    bodyTriangles: number;
    walkableTriangles: number;
  };
  grounding: {
    foundationTop: { x: number; y: number; z: number };
    accessStairs: Array<{
      start: { x: number; y: number; z: number };
      end: { x: number; y: number; z: number };
      width: number;
    }>;
  };
};

type QuickSenseOutpostTowerPieceAudit = {
  name: string;
  role: string;
  triangles: number;
  uvVertices: number;
  bounds: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  };
};

type Projectile = {
  root: THREE.Group;
  velocity: THREE.Vector3;
  owner: Owner;
  weapon: WeaponId;
  damage: number;
  splash: number;
  life: number;
  trailDistance: number;
  bounces: number;
  maxBounces: number;
  restitution: number;
  ownerSafeTime: number;
  angularVelocity: number;
};

type ProjectileOptions = {
  maxBounces?: number;
  restitution?: number;
  ownerSafeTime?: number;
  angularVelocity?: number;
  life?: number;
};

type GrenadeEntity = {
  root: THREE.Group;
  velocity: THREE.Vector3;
  owner: Owner;
  fuse: number;
  trailDistance: number;
  bounces: number;
};

type PickupState = {
  kind: PickupKind;
  group: THREE.Group;
  active: boolean;
  cooldown: number;
  respawn: number;
};

const BOT_COLORS = [0xff5f73, 0x9d72ff, 0x50e692];
const MATCH_COUNTDOWN_DURATION = 4;
const MATCH_COUNTDOWN_CUES: readonly CountdownCue[] = ['READY', '3', '2', '1'];
// qfusion's standing view is origin + 30; origin sits 24 units above ground.
const PLAYER_EYE = 54 / 56;
const MAX_FIXED_STEPS_PER_FRAME = 2;
// Player movement/projectiles retain the authored 120 Hz step. Bot decisions
// and locomotion do not benefit perceptibly above 60 Hz and were doubling LOS,
// navigation, and capsule work on every render frame.
const BOT_FIXED_STEP = 1 / 60;
const HUD_UPDATE_INTERVAL = 1 / 15;
const DIAGNOSTICS_UPDATE_INTERVAL = 1 / 4;
const BASE_GAME_FOV = 80;
const THIRD_PERSON_FOV = 62;
const MAX_SPEED_FOV = 98;
const MAP_FOG_PROFILES = Object.freeze({
  quicksense: Object.freeze({
    // Warm, pale mineral dust ties the road network into QuickSense's
    // sandstone mountains without tinting nearby combat silhouettes.
    color: 0xc9b99d,
    near: 105,
    far: 560,
  }),
  monsoon: Object.freeze({
    color: 0x86a2aa,
    near: 130,
    far: 650,
  }),
});
const WEAPON_VIEW_RETRACT_DISTANCE = 2.45;
const WEAPON_VIEW_CLEARANCE = 0.1;
const WEAPON_OBSTRUCTION_PROBE_LENGTH = 3.35;
// The view-model converges on the camera's reticle at a stable presentation
// distance. Gameplay hitscan still uses the real surface hit below, but a
// nearby ramp or stair must never pull the barrel behind its own muzzle and
// flip the model by half a turn in one frame.
const WEAPON_VIEW_CONVERGENCE_DISTANCE = 48;
const WEAPON_VIEW_WALL_CONVERGENCE_DISTANCE = 0.9;
// View-model collision is intentionally stricter than player slope handling.
// Traversable terrain, stairs, and ramps must never masquerade as a wall just
// because their broad hitscan proxy crosses the low/right weapon envelope.
const WEAPON_WALL_MAX_NORMAL_Y = MOVEMENT.maxSlopeCosine - 0.08;
const WEAPON_WALL_MIN_FACING = 0.18;
const FIGHTER_PRIMARY_PROJECTILE_SPEED = 220;
const FIGHTER_MISSILE_PROJECTILE_SPEED = 120;
const FIGHTER_AIM_RANGE = 320;
const FIGHTER_DESTRUCTION_VFX_SCALE = 6.4;
const DRONE_DESTRUCTION_VFX_SCALE = 2.6;
// Camera-to-muzzle reach includes each weapon's authored presentation scale,
// side angle, and a small allowance for its visible muzzle cage. Keeping this
// per weapon prevents the Longshot from forcing compact guns to tuck early.
const WEAPON_VIEW_SAFE_REACH: Record<WeaponId, number> = {
  disc: 1.68,
  machine: 1.92,
  shotgun: 2.08,
  rocket: 2.38,
  plasma: 2.02,
  laser: 2.08,
  sniper: 3.18,
  rail: 2.28,
};
const THIRD_PERSON_CAMERA_DISTANCE = 2.2;
const THIRD_PERSON_CAMERA_PORTRAIT_DISTANCE_SCALE = 1.1;
const THIRD_PERSON_CAMERA_PORTRAIT_DISTANCE_MAX = 0.62;
const THIRD_PERSON_CAMERA_SHOULDER_MIN = 0.56;
const THIRD_PERSON_CAMERA_SHOULDER_MAX = 0.72;
const THIRD_PERSON_CAMERA_SHOULDER_ASPECT_SCALE = 0.42;
const THIRD_PERSON_CAMERA_HEIGHT = 1.72;
const THIRD_PERSON_CAMERA_TARGET_HEIGHT = 1.35;
const THIRD_PERSON_CAMERA_CLEARANCE = 0.26;
const THIRD_PERSON_CAMERA_GROUND_CLEARANCE = 0.42;
const THIRD_PERSON_CAMERA_TERRAIN_HEADROOM = 1.25;
const THIRD_PERSON_CAMERA_MAX_LIFT = 1.65;
const THIRD_PERSON_CAMERA_TERRAIN_PROBES = 4;
const THIRD_PERSON_WEAPON_FORWARD = new THREE.Vector3(0, 0, -1);
const THIRD_PERSON_WEAPON_SCALE: Record<WeaponId, number> = {
  machine: 0.59,
  shotgun: 0.56,
  rocket: 0.51,
  plasma: 0.58,
  laser: 0.58,
  sniper: 0.58,
  rail: 0.59,
  disc: 0.51,
};

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private inkPass!: ShaderPass;
  private readonly scene = new THREE.Scene();
  private readonly speedTrails = new SpeedTrailSystem(this.scene, 4);
  private readonly camera = new THREE.PerspectiveCamera(BASE_GAME_FOV, 1, 0.08, 1400);
  private readonly input: InputController;
  private readonly arena: ArenaRuntime;
  private readonly audio = new AudioSystem();
  private readonly hud = new Hud();
  private readonly weaponVfx: WeaponVfxSystem;
  private readonly worldHealthBars: WorldHealthBarSystem;
  private mapLighting!: MapLightingRig;
  private readonly jetpackEnergy = new JetpackEnergy({
    burnSeconds: MOVEMENT.jetpackBurnSeconds,
    rechargeDelaySeconds: MOVEMENT.jetpackRechargeDelaySeconds,
    rechargeSeconds: MOVEMENT.jetpackRechargeSeconds,
    restartCharge: MOVEMENT.jetpackRestartCharge,
  });
  private readonly playerJetpack = new JetpackRig({ firstPerson: true });
  private readonly playerAvatar = new PlayerAvatar();
  private readonly mobileQuality = window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 600;
  // The arena uses several full-screen post passes. Letting a high-DPI display
  // render them at 1.75x multiplies fragment work by more than 3x, which is
  // the dominant cause of the low-FPS reports on otherwise capable GPUs.
  private readonly maxRenderDpr: number;
  private readonly adaptiveQuality: AdaptiveQualitySystem;
  private renderDprCap: number;
  private readonly softwareRenderer: boolean;
  private readonly visualCapture: boolean;
  private readonly bots: Bot[] = [];
  private readonly droneSwarm: DroneSwarmSystem;
  private readonly droneTargetSnapshots: DroneTargetSnapshot[] = [];
  private readonly botDroneTargets = new Map<number, string>();
  private readonly fighters: FighterRuntime[];
  private readonly fighterCollision: FighterArenaCollisionAdapter;
  private readonly fighterAi = new Map<number, FighterAiPilotController>();
  private readonly projectiles: Projectile[] = [];
  private readonly grenades: GrenadeEntity[] = [];
  private readonly grenadeSweepOffsets = [
    new THREE.Vector3(),
    new THREE.Vector3(GRENADE.radius, 0, 0),
    new THREE.Vector3(-GRENADE.radius, 0, 0),
    new THREE.Vector3(0, GRENADE.radius, 0),
    new THREE.Vector3(0, -GRENADE.radius, 0),
    new THREE.Vector3(0, 0, GRENADE.radius),
    new THREE.Vector3(0, 0, -GRENADE.radius),
  ];
  private readonly grenadeSweepStart = new THREE.Vector3();
  private readonly grenadeSweepEnd = new THREE.Vector3();
  private readonly grenadeSweepCenter = new THREE.Vector3();
  private readonly grenadeSweepSeparation = new THREE.Vector3();
  private readonly grenadeSweepResult: SurfaceHit = {
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    distance: 0,
    surface: 'metal',
  };
  private readonly pickups: PickupState[] = [];
  private readonly botTargets = new Map<number, Owner>();
  private readonly recentSpawnIndices: number[] = [];
  private readonly playerPosition = new THREE.Vector3();
  private readonly playerVelocity = new THREE.Vector3();
  private readonly speedTrailSources: SpeedTrailSource[] = [];
  private readonly moveInput = new THREE.Vector2();
  private readonly lookInput = new THREE.Vector2();
  private readonly wishDirection = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly terrainNormal = new THREE.Vector3(0, 1, 0);
  private readonly grappleSocket = new THREE.Object3D();
  private readonly grappleAnchor = new THREE.Vector3();
  private readonly weaponModel = new THREE.Group();
  private readonly thirdPersonWeaponModel = new THREE.Group();
  private readonly thirdPersonMuzzleSocket = new THREE.Object3D();
  private weaponVisual?: WeaponViewModel;
  private thirdPersonWeaponVisual?: WeaponViewModel;
  private inspectionWeaponVisual?: WeaponViewModel;
  private readonly weaponVisualCache = new Map<WeaponId, WeaponViewModel>();
  private readonly thirdPersonWeaponCache = new Map<WeaponId, WeaponViewModel>();
  private muzzleSocket = new THREE.Object3D();
  private readonly coreGroup = new THREE.Group();
  private readonly coreLight = new THREE.PointLight(0x3ee8ff, 6, 26, 2);
  private readonly coreAnchors: readonly CoreAnchor[];
  private readonly coreDirector: FluxCoreDirector<CoreAnchor>;
  private readonly styleSystem = new StyleSystem();
  private readonly weatherSystem: WeatherGameplaySystem;
  private readonly loop = new Loop((delta, elapsed) => this.update(delta, elapsed), () => this.render());
  private readonly ammo = new Map<WeaponId, number>();
  private readonly startButton: HTMLButtonElement;
  private readonly playTab: HTMLButtonElement;
  private readonly optionsTab: HTMLButtonElement;
  private readonly playMenu: HTMLElement;
  private readonly optionsMenu: HTMLElement;
  private readonly sensitivityOption: HTMLInputElement;
  private readonly sensitivityValue: HTMLOutputElement;
  private readonly audioOption: HTMLButtonElement;
  private readonly motionOption: HTMLButtonElement;
  private readonly fullscreenOption: HTMLButtonElement;
  private readonly optionsBack: HTMLButtonElement;
  private readonly viewModeValue: HTMLElement;
  private readonly viewButton: HTMLButtonElement;
  private readonly vehicleButton: HTMLButtonElement;
  private readonly physicsQaMode = new URLSearchParams(window.location.search).get('qa') === 'physics';
  private environmentTexture?: THREE.Texture;

  private rng = createSeededRandom(450600);
  private mode: GameMode = 'ready';
  private accumulator = 0;
  private botAccumulator = 0;
  private frame = 0;
  private elapsed = 0;
  private matchTime = MATCH_DURATION;
  private countdownRemaining = 0;
  private countdownCueIndex = -1;
  private countdownArmed = false;
  private countdownSequenceToken = 0;
  private health = 100;
  private armor = 50;
  private score = 0;
  private deaths = 0;
  private airborneKills = 0;
  private selectedWeapon = 0;
  private weaponCooldown = 0;
  private grenadeCooldown = 0;
  private grenadeAmmo: number = GRENADE.maxAmmo;
  private grappleActive = false;
  private grappleLength = 0;
  private laserHeat = 0;
  private jumpBuffer = 0;
  private coyote = 0;
  private grounded = false;
  private skiHeld = false;
  private jetpackActive = false;
  private jumpPadCooldown = 0;
  private dashBuffer = 0;
  private dashCooldown = 0;
  private dashMomentumTimer = 0;
  private wallContactTimer = 0;
  private ceilingContactTimer = 0;
  private yaw = 0;
  private pitch = -0.08;
  private trauma = 0;
  private fovPunch = 0;
  private recoil = 0;
  private speedBlurIntensity = 0;
  private fps = 60;
  private damageBoost = 0;
  private speedBoost = 0;
  private respawnTimer = 0;
  private respawnCause = '';
  private spawnIndex = 0;
  private coreCooldown = 6;
  private coreProgress = 0;
  private coreOwner: Owner | null = null;
  private coreActive = false;
  private coreContested = false;
  private currentCoreAnchorName = 'RIFT NEXUS';
  private weatherSnapshot: WeatherGameplaySnapshot;
  private readonly recentPlayerKills: number[] = [];
  private reducedMotion = false;
  private pausedForScreenshot = false;
  private screenshotArenaTime = 0;
  private screenshotCameraFov = BASE_GAME_FOV;
  private weaponInspectionMode = false;
  private lastGroundImpact = 0;
  private lastDamageDirection = '';
  private lastDamageBearing = 0;
  private muted = false;
  private rocketJumpCount = 0;
  private lastPhysicsContacts = 0;
  private physicsQaFrameRendered = false;
  private lastShotWeapon: WeaponId | null = null;
  private readonly lastShotOrigin = new THREE.Vector3();
  private readonly lastMuzzlePosition = new THREE.Vector3();
  private readonly lastProjectileOrigin = new THREE.Vector3();
  private lastPelletCount = 0;
  private lastPelletSpread = 0;
  private discBounceCount = 0;
  private readonly lastDiscBouncePosition = new THREE.Vector3();
  private footstepDistance = 0;
  private weaponTuck = 0;
  private weaponObstructionDistance = WEAPON_OBSTRUCTION_PROBE_LENGTH;
  private weaponMuzzleDistance = 0;
  private weaponMuzzleForwardDistance = 0;
  private weaponMuzzleOccluded = false;
  private scopeBlend = 0;
  private scopeRange = 190;
  private skiMomentumResistance = 0;
  private skiGravityDriveScale = 1;
  private skiDragAcceleration = 0;
  private readonly skiMomentumScratch: SkiMomentumCurve = {
    resistance: 0,
    gravityDriveScale: 1,
    dragAcceleration: 0,
  };
  private weaponBobPhase = 0;
  private weaponWalkWeight = 0;
  private weaponVerticalLag = 0;
  private weaponAirborneTime = 0;
  private readonly weaponTurnSway = new THREE.Vector2();
  private readonly cameraDirectionScratch = new THREE.Vector3();
  private readonly audioDirectionScratch = new THREE.Vector3();
  private readonly cameraEyeScratch = new THREE.Vector3();
  private readonly cameraProbeScratch = new THREE.Vector3();
  private readonly weaponProbeScratch = new THREE.Vector3();
  private readonly weaponWallDirectionScratch = new THREE.Vector3();
  private readonly cameraRightScratch = new THREE.Vector3();
  private readonly cameraAimScratch = new THREE.Vector3();
  private readonly thirdPersonAnchorScratch = new THREE.Vector3();
  private readonly thirdPersonDesiredScratch = new THREE.Vector3();
  private readonly thirdPersonPositionScratch = new THREE.Vector3();
  private readonly thirdPersonOffsetScratch = new THREE.Vector3();
  private readonly thirdPersonAlternateDesiredScratch = new THREE.Vector3();
  private readonly thirdPersonSmoothedOffset = new THREE.Vector3();
  private readonly thirdPersonBackScratch = new THREE.Vector3();
  private readonly thirdPersonAimScratch = new THREE.Vector3();
  private thirdPersonCameraInitialized = false;
  private thirdPersonCameraObstructed = false;
  private readonly screenshotLookTarget = new THREE.Vector3();
  private screenshotLookTargetActive = false;
  private readonly cameraLocalAimScratch = new THREE.Vector3();
  private readonly weaponBoreScratch = new THREE.Vector3();
  private readonly weaponMuzzleScratch = new THREE.Vector3();
  private readonly thirdPersonMuzzleForwardScratch = new THREE.Vector3();
  private readonly thirdPersonMuzzleRightScratch = new THREE.Vector3();
  private readonly grappleOriginScratch = new THREE.Vector3();
  private readonly movementStartScratch = new THREE.Vector3();
  private readonly tangentGravityScratch = new THREE.Vector3();
  private readonly substepStartPosition = new THREE.Vector3();
  private readonly substepStartVelocity = new THREE.Vector3();
  private readonly substepIntendedPosition = new THREE.Vector3();
  private readonly substepBlockedPosition = new THREE.Vector3();
  private readonly movementVectorScratchA = new THREE.Vector3();
  private readonly movementVectorScratchB = new THREE.Vector3();
  private readonly sweepDisplacement = new THREE.Vector3();
  private readonly sweepHorizontal = new THREE.Vector3();
  private readonly sweepSide = new THREE.Vector3();
  private readonly sweepFront = new THREE.Vector3();
  private readonly sweepHalfSide = new THREE.Vector3();
  private readonly sweepRayStart = new THREE.Vector3();
  private readonly sweepRayEnd = new THREE.Vector3();
  private readonly sweepOffsets = Array.from({ length: 5 }, () => new THREE.Vector3());
  private readonly sweepBestNormal = new THREE.Vector3();
  private readonly sweepWallNormal = new THREE.Vector3();
  private readonly sweepCeilingNormal = new THREE.Vector3();
  private readonly sweepBoundaryNormal = new THREE.Vector3();
  private readonly sweepResult: PlayerSweepResult = { wallNormal: null, ceilingNormal: null };
  private sweepBestFraction = Number.POSITIVE_INFINITY;
  private sweepBestKind: 'wall' | 'ceiling' | null = null;
  private nextHudUpdateAt = 0;
  private nextDiagnosticsUpdateAt = 0;
  private stepAttempts = 0;
  private stepSuccesses = 0;
  private lastStepReason = 'none';
  private lastStepRise = 0;
  private lastStepBlockedDistance = 0;
  private lastStepTravelDistance = 0;
  private lastStepInputDistance = 0;
  private lastStepRaisedSpeed = 0;
  private lastStepStartSpeed = 0;
  private lastStepFinalSpeed = 0;
  private ccdSweeps = 0;
  private ccdWallHits = 0;
  private ccdCeilingHits = 0;
  private ccdBoundaryHits = 0;
  private viewMode: ViewMode = 'first-person';
  private overtime = false;
  private overtimeBaselineScores: number[] = [];
  private playerShots = 0;
  private playerHits = 0;
  private coreCaptures = 0;
  private maxPlayerSpeed = 0;
  private playerFighter: FighterRuntime | null = null;
  private fighterBoostQueued = false;
  private fighterMissileQueued = false;
  private readonly fighterForwardScratch = new THREE.Vector3();
  private readonly fighterRightScratch = new THREE.Vector3();
  private readonly fighterUpScratch = new THREE.Vector3();
  private readonly fighterCameraDesiredScratch = new THREE.Vector3();
  private readonly fighterCameraLookScratch = new THREE.Vector3();
  private readonly fighterMuzzleScratch = new THREE.Vector3();
  private readonly fighterAimScratch = new THREE.Vector3();
  private readonly fighterAimPointScratch = new THREE.Vector3();
  private readonly fighterAimHitScratch = new THREE.Vector3();
  private readonly fighterAimRay = new THREE.Ray();
  private readonly fighterQuaternionScratch = new THREE.Quaternion();
  private readonly fighterDynamicProxyScratch = new THREE.Vector3();
  private readonly fighterDynamicSweepScratch = new THREE.Vector3();
  private readonly fighterDynamicDeltaScratch = new THREE.Vector3();
  private readonly fighterCharacterDeltaScratch = new THREE.Vector3();
  private readonly fighterCharacterNormalScratch = new THREE.Vector3(1, 0, 0);
  private fighterCollisionSubject: FighterRuntime | null = null;
  private readonly queryFighterWorldCollision = (
    query: FighterCollisionQuery,
    outHit: FighterCollisionHit,
  ): boolean => this.castFighterWorldCollision(query, outHit);

  static async create(canvas: HTMLCanvasElement, reportProgress: GameLoadReporter = () => undefined): Promise<Game> {
    reportProgress({ fraction: 0.06, label: 'Loading arena geometry' });
    await yieldDuringLoad();
    const [arena, grenadeAsset] = await Promise.all([
      Arena.load(),
      loadGrenadeAsset(),
    ]);
    reportProgress({ fraction: 0.48, label: 'Building combat systems' });
    await yieldDuringLoad();
    const game = new Game(canvas, arena, grenadeAsset);
    reportProgress({ fraction: 0.68, label: 'Loading combat frames' });
    await game.prepareVisualResources(reportProgress);
    reportProgress({ fraction: 1, label: 'Arena ready' });
    // Keep the completed loading state visible for one short beat after the
    // synchronous GPU upload. Besides making progress legible, this gives the
    // browser a free main-thread window before input and simulation begin.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 350));
    return game;
  }

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    arena: ArenaRuntime,
    grenadeAsset: THREE.Group,
  ) {
    this.arena = arena;
    const nexusName = arena.mapInfo.name === 'QuickSense' ? 'QUICKSENSE // RIFT NEXUS' : 'RIFT NEXUS';
    this.coreAnchors = Object.freeze([
      { name: nexusName, position: arena.corePosition.clone() },
      { name: 'WEST ARMOR RELAY', position: arena.itemPoints.armor.clone() },
      { name: 'SOUTH SPEED RING', position: arena.itemPoints.speed.clone() },
      { name: 'EAST PLASMA RIDGE', position: arena.itemPoints.plasma.clone() },
    ]);
    this.coreDirector = new FluxCoreDirector(this.coreAnchors, { cooldownSeconds: POWERUP.coreRespawn });
    this.coreCooldown = this.coreDirector.snapshot().secondsRemaining;
    this.weatherSystem = new WeatherGameplaySystem({ seed: arena.mapInfo.seed });
    this.weatherSnapshot = this.weatherSystem.snapshot();
    this.arena.setWeatherGameplaySnapshot(this.weatherSnapshot);
    this.renderer = createRenderer(canvas);
    const gl = this.renderer.getContext();
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null;
    const rendererName = debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : '';
    this.softwareRenderer = navigator.webdriver || /swiftshader|llvmpipe|software/i.test(rendererName);
    const qaMode = new URLSearchParams(window.location.search).get('qa');
    const diagnosticCapture = qaMode !== null;
    const visualCapture = qaMode === 'visual' || qaMode === 'capture';
    // `qa=native` retains the direct-render software path used by imported PBR
    // assets while raising the drawing buffer to screenshot resolution. The
    // post-processing capture path is intentionally separate because SwiftShader
    // can drop the tower's StandardMaterial draw calls when the composer is used.
    const highResolutionCapture = visualCapture || qaMode === 'native';
    this.visualCapture = visualCapture;
    this.maxRenderDpr = this.softwareRenderer
      ? highResolutionCapture
        ? 1
        : diagnosticCapture
          ? 0.75
          : 0.25
      : this.mobileQuality
        ? 1
        : arena.mapInfo.name === 'QuickSense'
          // Start crisp, then retain one small measured fallback for unusually
          // heavy combat. The optimized steady path normally remains here.
          ? 0.75
          : 1.25;
    this.renderDprCap = this.maxRenderDpr;
    const quickSenseQuality = arena.mapInfo.name === 'QuickSense';
    this.adaptiveQuality = new AdaptiveQualitySystem({
      // QuickSense's dense multi-level sightlines get one restrained fallback
      // under measured overload. Capture/software paths remain deterministic
      // at their explicit QA resolution.
      minDpr: this.softwareRenderer
        ? this.maxRenderDpr
        : this.mobileQuality
          ? 0.7
          : quickSenseQuality
            ? 0.625
            : 0.75,
      maxDpr: this.maxRenderDpr,
      sampleWindowMs: 750,
      dprStep: quickSenseQuality ? 0.125 : 0.25,
      degradeCooldownMs: 750,
    });
    // Ordinary software-rendered play stays cheap, but explicit QA captures
    // must retain the grounding/contact shadows being judged. Otherwise the
    // screenshot path materially understates the real GPU presentation.
    if (this.softwareRenderer && !visualCapture) this.renderer.shadowMap.enabled = false;
    this.renderer.info.autoReset = false;
    this.startButton = this.element<HTMLButtonElement>('#start-button');
    this.playTab = this.element<HTMLButtonElement>('#play-tab');
    this.optionsTab = this.element<HTMLButtonElement>('#options-tab');
    this.playMenu = this.element('#play-menu');
    this.optionsMenu = this.element('#options-menu');
    this.sensitivityOption = this.element<HTMLInputElement>('#sensitivity-option');
    this.sensitivityValue = this.element<HTMLOutputElement>('#sensitivity-value');
    this.audioOption = this.element<HTMLButtonElement>('#audio-option');
    this.motionOption = this.element<HTMLButtonElement>('#motion-option');
    this.fullscreenOption = this.element<HTMLButtonElement>('#fullscreen-option');
    this.optionsBack = this.element<HTMLButtonElement>('#options-back');
    this.viewModeValue = this.element('#view-mode-value');
    this.viewButton = this.element<HTMLButtonElement>('#view-button');
    this.vehicleButton = this.element<HTMLButtonElement>('#vehicle-button');
    this.input = new InputController(
      canvas,
      this.element('#touch-stick'),
      this.element('#touch-knob'),
      this.element('#fire-button'),
      this.element('#jump-button'),
      this.element('#ski-button'),
      this.element('#grapple-button'),
      this.element('#grenade-button'),
      this.element('#dash-button'),
      this.element('#weapon-button'),
      this.element('#zoom-button'),
      this.viewButton,
      this.vehicleButton,
    );
    this.weaponVfx = new WeaponVfxSystem(
      this.scene,
      this.camera,
      () => this.rng(),
      grenadeAsset,
      this.mobileQuality,
    );
    this.createScene();
    this.droneSwarm = new DroneSwarmSystem(this.scene, this.arena);
    this.fighterCollision = new FighterArenaCollisionAdapter(this.arena);
    this.fighters = this.arena.mapInfo.name === 'QuickSense'
      ? createQuickSenseFighters(this.scene)
      : [];
    this.scene.add(this.playerAvatar.root);
    this.thirdPersonWeaponModel.name = 'third-person-equipped-weapon';
    this.scene.add(this.thirdPersonWeaponModel);
    this.composer = this.createPostProcessing();
    this.createBots();
    this.worldHealthBars = new WorldHealthBarSystem(this.scene);
    this.registerWorldHealthBars();
    this.installGroundingShadows();
    this.droneTargetSnapshots.push({
      owner: 'player',
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      alive: true,
    });
    for (const bot of this.bots) {
      this.droneTargetSnapshots.push({
        owner: bot.id,
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        alive: true,
      });
    }
    for (const bot of this.bots) {
      this.fighterAi.set(bot.id, new FighterAiPilotController(
        bot.id,
        bot.id === 2 ? 'hard' : 'normal',
        // Vehicle roots sit at the pad center while the solid hull surrounds
        // them. AI must be able to enter from beside the canopy rather than
        // trying to walk through collision to a 2.2 m root radius.
        { enterDistance: 10 },
      ));
    }
    this.speedTrailSources.push({ position: this.playerPosition, velocity: this.playerVelocity, active: false });
    for (const bot of this.bots) {
      this.speedTrailSources.push({ position: bot.group.position, velocity: bot.velocity, active: bot.alive });
    }
    this.createPickups();
    this.createCore();
    this.camera.add(this.weaponModel);
    this.grappleSocket.name = 'grapple-lower-left-socket';
    this.grappleSocket.position.set(-0.44, -0.34, -0.58);
    this.camera.add(this.grappleSocket);
    this.camera.add(this.playerJetpack.root);
    this.scene.add(this.camera);
    this.resetPlayerLoadout();
    this.buildWeaponModel();
    this.respawnPlayer(false);
    this.startButton.addEventListener('click', this.onStartClick);
    this.applyMenuSettings();
    document.addEventListener('rift:settings', this.onMenuSettings);
    // Keep the legacy in-canvas menu adapters addressable while the shared
    // settings event owns the active listener lifecycle.
    void this.installMenuControls;
    void this.removeMenuControls;
    resizeRenderer(this.renderer, this.camera, this.maxRenderDpr);
    this.resizePostProcessing();
    this.updateCamera(0);
    this.updateViewModeUi();
  }

  start(): void {
    this.loop.start();
  }

  private prewarmSceneResources(): void {
    // Three.js uploads vertex/index buffers lazily on first visibility. A fast
    // traversal can otherwise reveal a whole distant arena sector in one
    // frame and make that frame pay every driver upload at once. Render once
    // behind the ready screen with culling disabled, then restore authored
    // culling before live play.
    if (this.softwareRenderer) return;
    const restoreCulling: THREE.Object3D[] = [];
    const restoreVisibility: THREE.Object3D[] = [];
    const inactiveWeaponRoots: THREE.Object3D[] = [];
    const inactiveThirdPersonWeaponRoots: THREE.Object3D[] = [];
    const playerWasVisible = this.playerAvatar.root.visible;
    const coreWasVisible = this.coreGroup.visible;
    const speedTrailsWereVisible = this.speedTrails.mesh.visible;
    const speedTrailDrawCount = this.speedTrails.mesh.geometry.drawRange.count;
    this.playerAvatar.root.visible = true;
    // The Flux Core begins hidden and is revealed by the match director. Its
    // two toon-shaded meshes were therefore missing the scene prewarm and
    // could block a live frame for several seconds on their first GPU upload.
    this.coreGroup.visible = true;
    // Weapon switches must only exchange already-resident scene nodes. Attach
    // every cached first-person frame for this hidden upload, then detach all
    // but the selected model before the ready state is exposed.
    for (const visual of this.weaponVisualCache.values()) {
      if (visual === this.weaponVisual) continue;
      inactiveWeaponRoots.push(visual.root);
      this.weaponModel.add(visual.root);
    }
    for (const visual of this.thirdPersonWeaponCache.values()) {
      if (visual === this.thirdPersonWeaponVisual) continue;
      inactiveThirdPersonWeaponRoots.push(visual.root);
      this.thirdPersonWeaponModel.add(visual.root);
    }
    // The batched speed ribbon normally has an empty draw range until an actor
    // first exceeds 70 km/h. A six-vertex preload prevents that exciting
    // gameplay moment from also being its first buffer and shader upload.
    this.speedTrails.mesh.visible = true;
    this.speedTrails.mesh.geometry.setDrawRange(0, 6);
    // Jet flames, sparks, pooled muzzle groups, bot fallback parts, and other
    // event-driven nodes start hidden. Three.js skips invisible ancestors
    // during compile/render, so reveal them only for this loading-frame upload.
    this.scene.traverse((object) => {
      if (object.visible) return;
      restoreVisibility.push(object);
      object.visible = true;
    });
    this.scene.traverse((object) => {
      if (!object.frustumCulled || !(object as THREE.Mesh).isMesh) return;
      restoreCulling.push(object);
      object.frustumCulled = false;
    });
    this.renderer.compile(this.scene, this.camera);
    // Exercise the real render path as well as the scene shaders. This
    // allocates and compiles the composer passes before the first live frame.
    this.composer.render();
    for (const object of restoreCulling) object.frustumCulled = true;
    for (const object of restoreVisibility) object.visible = false;
    for (const root of inactiveWeaponRoots) this.weaponModel.remove(root);
    for (const root of inactiveThirdPersonWeaponRoots) this.thirdPersonWeaponModel.remove(root);
    this.playerAvatar.root.visible = playerWasVisible;
    this.coreGroup.visible = coreWasVisible;
    this.speedTrails.mesh.visible = speedTrailsWereVisible;
    this.speedTrails.mesh.geometry.setDrawRange(0, speedTrailDrawCount);
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = false;
    this.renderer.info.reset();
  }

  private async prepareVisualResources(reportProgress: GameLoadReporter): Promise<void> {
    // Finish shared GLB decode, skeleton cloning, and material setup before the
    // live loop can observe them. Installing all four characters from promise
    // callbacks during play previously turned one frame into several seconds
    // of main-thread work and left their first shader uploads to later frames.
    await Promise.all([
      this.playerAvatar.ready,
      ...this.bots.map((bot) => bot.ready),
      ...this.fighters.map((fighter) => fighter.visual.ready),
      this.droneSwarm.ready,
    ]);
    this.mapLighting.excludeDynamicShadowCasters([
      this.playerAvatar.root,
      ...this.bots.map((bot) => bot.group),
      ...this.fighters.map((fighter) => fighter.visual.root),
      ...this.droneSwarm.combatDrones.map((drone) => drone.visual.root),
    ]);
    // Build every weapon exactly once behind the deployment screen. Their
    // authored geometry and battle-wear textures stay cached for the match,
    // eliminating the multi-frame model construction/upload hitch on switch.
    if (!this.softwareRenderer) {
      for (let index = 0; index < WEAPONS.length; index += 1) {
        const definition = WEAPONS[index];
        reportProgress({
          fraction: 0.7 + ((index + 1) / WEAPONS.length) * 0.09,
          label: `Loading ${definition.shortName} combat frame`,
        });
        await yieldDuringLoad();
        if (!this.weaponVisualCache.has(definition.id)) {
          this.weaponVisualCache.set(definition.id, createWeaponViewModel(definition, true, true));
        }
        if (!this.thirdPersonWeaponCache.has(definition.id)) {
          this.thirdPersonWeaponCache.set(
            definition.id,
            this.createThirdPersonWeaponClone(this.weaponVisualCache.get(definition.id)!),
          );
        }
      }
    }
    reportProgress({ fraction: 0.8, label: 'Warming combat effects' });
    await yieldDuringLoad();
    this.weaponVfx.prewarm(this.renderer);
    reportProgress({ fraction: 0.9, label: 'Uploading arena shaders' });
    // Let the loading status paint before the intentionally synchronous GPU
    // warmup. The ready state is not exposed until every live shader path has
    // completed once.
    await yieldDuringLoad();
    this.prewarmSceneResources();
    reportProgress({ fraction: 0.98, label: 'Finalizing deployment' });
    await yieldDuringLoad();
    this.installTestHooks();
    this.publishDiagnostics();
  }

  dispose(): void {
    this.loop.stop();
    this.startButton.removeEventListener('click', this.onStartClick);
    document.removeEventListener('rift:settings', this.onMenuSettings);
    this.input.dispose();
    this.audio.dispose();
    this.weaponVfx.dispose();
    this.speedTrails.dispose();
    this.playerJetpack.dispose();
    this.playerAvatar.dispose();
    this.worldHealthBars.dispose();
    this.mapLighting.dispose();
    this.arena.dispose();
    for (const bot of this.bots) bot.dispose();
    this.droneSwarm.dispose();
    for (const fighter of this.fighters) fighter.visual.dispose();
    for (const projectile of this.projectiles) this.disposeObject(projectile.root);
    for (const grenade of this.grenades) this.disposeObject(grenade.root);
    for (const pickup of this.pickups) this.disposeObject(pickup.group);
    this.disposeObject(this.coreGroup);
    // These clones share the first-person cache's GPU resources. Detach them
    // before the owning visuals are disposed so shared textures and geometry
    // are released exactly once.
    this.thirdPersonWeaponModel.clear();
    this.thirdPersonWeaponCache.clear();
    // The active cached frame is already traversed through weaponModel. Dispose
    // detached cached frames separately and exactly once.
    this.disposeObject(this.weaponModel);
    for (const visual of this.weaponVisualCache.values()) {
      if (visual.root.parent !== this.weaponModel) this.disposeObject(visual.root);
    }
    if (this.inspectionWeaponVisual && this.inspectionWeaponVisual.root.parent !== this.weaponModel) {
      this.disposeObject(this.inspectionWeaponVisual.root);
    }
    this.weaponVisualCache.clear();
    this.weaponModel.clear();
    this.scene.remove(this.thirdPersonWeaponModel);
    this.environmentTexture?.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    window.__THREE_GAME_DIAGNOSTICS__ = undefined;
    window.__THREE_GAME_TEST_HOOKS__ = undefined;
  }

  private readonly onStartClick = (): void => {
    this.beginMatch();
  };

  private readonly onMenuSettings = (event: Event): void => {
    const settings = (event as CustomEvent<{
      sensitivity: number;
      muted: boolean;
      reducedMotion: boolean;
    }>).detail;
    if (!settings) return;
    this.input.setLookSensitivity(settings.sensitivity);
    this.muted = settings.muted;
    this.audio.setMuted(this.muted);
    this.reducedMotion = settings.reducedMotion;
  };

  private applyMenuSettings(): void {
    const sensitivity = Number(localStorage.getItem('rift:sensitivity') ?? '1');
    this.input.setLookSensitivity(Number.isFinite(sensitivity) ? sensitivity : 1);
    this.muted = localStorage.getItem('rift:muted') === 'true';
    this.reducedMotion = localStorage.getItem('rift:reduced-motion') === 'true'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.audio.setMuted(this.muted);
  }

  private readonly showPlayMenu = (): void => this.setMenuView('play');
  private readonly showOptionsMenu = (): void => this.setMenuView('options');
  private readonly onSensitivityChange = (): void => {
    const sensitivity = Number(this.sensitivityOption.value);
    this.input.setLookSensitivity(sensitivity);
    this.sensitivityValue.value = `${sensitivity.toFixed(1)}×`;
    localStorage.setItem('rift:sensitivity', String(sensitivity));
  };
  private readonly onAudioOption = (): void => {
    this.muted = !this.muted;
    this.audio.setMuted(this.muted);
    this.updateMenuToggles();
    localStorage.setItem('rift:muted', String(this.muted));
  };
  private readonly onMotionOption = (): void => {
    this.reducedMotion = !this.reducedMotion;
    this.updateMenuToggles();
    localStorage.setItem('rift:reduced-motion', String(this.reducedMotion));
  };
  private readonly onFullscreenOption = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  };
  private readonly onFullscreenChange = (): void => this.updateMenuToggles();

  private isThirdPerson(): boolean {
    return this.viewMode === 'third-person';
  }

  private toggleViewMode(): void {
    this.viewMode = this.isThirdPerson() ? 'first-person' : 'third-person';
    const thirdPerson = this.isThirdPerson();
    this.weaponModel.visible = !thirdPerson;
    this.thirdPersonWeaponModel.visible = thirdPerson && Boolean(this.thirdPersonWeaponVisual);
    this.playerAvatar.setVisible(thirdPerson);
    this.updateViewModeUi();
    if (this.mode === 'running') this.hud.message(thirdPerson ? 'THIRD-PERSON CAMERA' : 'FIRST-PERSON CAMERA');
    this.updateCamera(0);
    this.publishDiagnostics();
  }

  private updateViewModeUi(): void {
    const thirdPerson = this.isThirdPerson();
    this.viewModeValue.textContent = thirdPerson ? 'Third person' : 'First person';
    this.viewModeValue.dataset.mode = this.viewMode;
    this.viewButton.setAttribute('aria-label', thirdPerson ? 'Switch to first-person view' : 'Switch to third-person view');
    this.viewButton.dataset.mode = this.viewMode;
    document.body.dataset.viewMode = this.viewMode;
  }

  private installMenuControls(): void {
    const sensitivity = Number(localStorage.getItem('rift:sensitivity') ?? '1');
    this.sensitivityOption.value = String(Number.isFinite(sensitivity) ? sensitivity : 1);
    this.muted = localStorage.getItem('rift:muted') === 'true';
    this.reducedMotion = localStorage.getItem('rift:reduced-motion') === 'true'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.audio.setMuted(this.muted);
    this.onSensitivityChange();
    this.updateMenuToggles();
    this.playTab.addEventListener('click', this.showPlayMenu);
    this.optionsTab.addEventListener('click', this.showOptionsMenu);
    this.optionsBack.addEventListener('click', this.showPlayMenu);
    this.sensitivityOption.addEventListener('input', this.onSensitivityChange);
    this.audioOption.addEventListener('click', this.onAudioOption);
    this.motionOption.addEventListener('click', this.onMotionOption);
    this.fullscreenOption.addEventListener('click', this.onFullscreenOption);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
  }

  private removeMenuControls(): void {
    this.playTab.removeEventListener('click', this.showPlayMenu);
    this.optionsTab.removeEventListener('click', this.showOptionsMenu);
    this.optionsBack.removeEventListener('click', this.showPlayMenu);
    this.sensitivityOption.removeEventListener('input', this.onSensitivityChange);
    this.audioOption.removeEventListener('click', this.onAudioOption);
    this.motionOption.removeEventListener('click', this.onMotionOption);
    this.fullscreenOption.removeEventListener('click', this.onFullscreenOption);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
  }

  private setMenuView(view: 'play' | 'options'): void {
    const options = view === 'options';
    this.playMenu.classList.toggle('active', !options);
    this.optionsMenu.classList.toggle('active', options);
    this.optionsMenu.setAttribute('aria-hidden', String(!options));
    this.playTab.classList.toggle('active', !options);
    this.optionsTab.classList.toggle('active', options);
    this.playTab.setAttribute('aria-selected', String(!options));
    this.optionsTab.setAttribute('aria-selected', String(options));
    (options ? this.sensitivityOption : this.startButton).focus({ preventScroll: true });
  }

  private updateMenuToggles(): void {
    this.audioOption.textContent = this.muted ? 'Off' : 'On';
    this.audioOption.setAttribute('aria-pressed', String(!this.muted));
    this.motionOption.textContent = this.reducedMotion ? 'On' : 'Off';
    this.motionOption.setAttribute('aria-pressed', String(this.reducedMotion));
    const fullscreen = Boolean(document.fullscreenElement);
    this.fullscreenOption.textContent = fullscreen ? 'Exit' : 'Enter';
    this.fullscreenOption.setAttribute('aria-pressed', String(fullscreen));
  }

  private update(delta: number, elapsed: number): void {
    this.frame += 1;
    this.elapsed = elapsed;
    this.fps += ((1 / Math.max(delta, 0.001)) - this.fps) * Math.min(1, delta * 3);
    // Base dynamic resolution on the work the game actually submitted, not on
    // the requestAnimationFrame interval. Browser/OS scheduling gaps can make
    // `delta` hundreds of milliseconds even when update + render cost 10 ms;
    // treating those gaps as GPU overload caused a live render-target resize,
    // which amplified a harmless delayed callback into the visible hitch.
    const measuredFrameMs = window.__THREE_FRAME_TIMING__?.totalMs ?? 0;
    const qualityChange = this.softwareRenderer || measuredFrameMs <= 0
      ? null
      : this.adaptiveQuality.sampleFrame(measuredFrameMs);
    if (qualityChange) this.renderDprCap = qualityChange.dprCap;
    if (resizeRenderer(this.renderer, this.camera, this.renderDprCap)) this.resizePostProcessing();

    this.input.consumeLook(this.lookInput);
    if (!this.playerFighter && this.sniperScopeRequested()) this.lookInput.multiplyScalar(0.28);
    this.yaw -= this.lookInput.x * 0.0018;
    this.pitch = THREE.MathUtils.clamp(this.pitch - this.lookInput.y * 0.0016, -1.28, 1.22);
    if (this.input.consumeInteract()) this.togglePlayerFighter();
    if (this.input.consumeJump() && !this.playerFighter) this.jumpBuffer = MOVEMENT.jumpBuffer;
    if (this.input.consumeDash()) {
      if (this.playerFighter) this.fighterBoostQueued = true;
      else this.dashBuffer = 0.12;
    }
    if (this.input.consumeGrapple() && !this.playerFighter) this.toggleGrapple();
    if (this.input.consumeGrenade()) {
      if (this.playerFighter) this.fighterMissileQueued = true;
      else this.tryThrowGrenade();
    }
    if (!this.playerFighter && this.grappleActive && !this.input.isGrappleHeld()) this.detachGrapple();
    if (!this.playerFighter) this.handleWeaponRequest();
    if (this.input.consumeAltFire()) {
      if (this.playerFighter) this.fighterMissileQueued = true;
      else this.trySecondaryFire();
    }
    if (this.input.consumeMute()) {
      this.muted = !this.muted;
      this.audio.setMuted(this.muted);
      this.hud.message(this.muted ? 'AUDIO MUTED' : 'AUDIO ONLINE');
    }
    if (this.input.consumeViewToggle()) this.toggleViewMode();
    if (this.input.consumePause()) this.togglePause();

    if (!this.pausedForScreenshot) {
      // Bound catch-up work so one slow render cannot trigger a spiral of
      // increasingly expensive simulation frames. At 60 FPS this still runs
      // the authored 120 Hz simulation twice per render; only overload debt is
      // discarded.
      this.accumulator = Math.min(
        this.accumulator + Math.min(delta, 0.05),
        MOVEMENT.fixedStep * MAX_FIXED_STEPS_PER_FRAME,
      );
      let fixedSteps = 0;
      while (this.accumulator >= MOVEMENT.fixedStep && fixedSteps < MAX_FIXED_STEPS_PER_FRAME) {
        this.fixedUpdate(MOVEMENT.fixedStep);
        this.accumulator -= MOVEMENT.fixedStep;
        fixedSteps += 1;
      }
    }

    this.arena.setPlayerInfluence(this.playerPosition);
    this.arena.setWeatherGameplaySnapshot(this.weatherSnapshot);
    this.arena.update(this.pausedForScreenshot ? this.screenshotArenaTime : elapsed, this.reducedMotion);
    this.updatePickupVisuals(delta, elapsed);
    this.updateEffects(this.pausedForScreenshot ? 0 : delta);
    this.playerJetpack.update(this.jetpackActive && !this.playerFighter, this.pausedForScreenshot ? 0 : delta, elapsed, this.reducedMotion);
    this.playerJetpack.root.visible = !this.playerFighter && !this.isThirdPerson() && this.playerJetpack.root.visible;
    this.playerAvatar.root.position.copy(this.playerPosition);
    this.playerAvatar.root.visible = !this.playerFighter && this.isThirdPerson();
    this.playerAvatar.setPose(this.yaw, this.moveInput.x);
    this.playerAvatar.update(
      this.pausedForScreenshot ? 0 : delta,
      elapsed,
      this.grounded,
      Math.hypot(this.playerVelocity.x, this.playerVelocity.z),
      this.input.isFireHeld() && !this.playerFighter,
      this.jetpackActive,
      this.reducedMotion,
    );
    this.audio.setJetpackActive(this.jetpackActive || Boolean(this.playerFighter?.flight.afterburnerActive));
    for (const fighter of this.fighters) {
      updateFighterPresentation(fighter, this.pausedForScreenshot ? 0 : delta, this.reducedMotion);
      // The local pilot sees the cockpit/flight glass only. Rendering the full
      // exterior around a seat camera exposes wings and fuselage, unlike the
      // dedicated cockpit views in PlanetSide 2 and Battlefront.
      if (fighter === this.playerFighter) fighter.visual.root.visible = false;
    }
    this.mapLighting.updateGroundingShadows(this.arena);
    this.updateMobilePresentationDetail();
    this.updateCamera(delta);
    this.worldHealthBars.update(
      this.camera,
      this.mode === 'countdown' || this.mode === 'running' || this.mode === 'respawning' || this.mode === 'paused',
    );
    this.updateSpeedEffects(this.pausedForScreenshot ? 0 : delta, elapsed);
    this.audio.updateListener(this.camera.position, this.viewDirection(this.audioDirectionScratch));
    if (elapsed >= this.nextHudUpdateAt) {
      this.updateHud();
      this.nextHudUpdateAt = elapsed + HUD_UPDATE_INTERVAL;
    }
    if (elapsed >= this.nextDiagnosticsUpdateAt) {
      this.publishDiagnostics();
      this.nextDiagnosticsUpdateAt = elapsed + DIAGNOSTICS_UPDATE_INTERVAL;
    }
  }

  private updateSpeedEffects(delta: number, elapsed: number, snap = false): void {
    const reducedMotionScale = this.reducedMotion ? 0.25 : 1;
    const target = speedEffectIntensity(this.playerVelocity) * reducedMotionScale;
    if (snap) {
      this.speedBlurIntensity = target;
    } else if (delta > 0) {
      const response = target > this.speedBlurIntensity ? 7.5 : 3.25;
      const blend = 1 - Math.exp(-delta * response);
      this.speedBlurIntensity = THREE.MathUtils.lerp(this.speedBlurIntensity, target, blend);
    }
    this.inkPass.uniforms.speedBlur.value = this.speedBlurIntensity;

    if (this.speedTrailSources.length > 0) {
      this.speedTrailSources[0].active = this.mode === 'running' || this.mode === 'respawning';
      for (let index = 0; index < this.bots.length; index += 1) {
        this.speedTrailSources[index + 1].active = this.bots[index].alive;
      }
    }
    this.speedTrails.update(this.speedTrailSources, elapsed, this.reducedMotion);
  }

  private updateMobilePresentationDetail(): void {
    if (!this.mobileQuality) {
      for (const fighter of this.fighters) fighter.visual.setHighDetail(true);
      return;
    }

    // Cull only beyond each actor's gameplay awareness envelope so mobile
    // never receives damage from an invisible combatant. Fighters retain a
    // low-poly silhouette at range because their 28.5 m profile is part of the
    // map composition; the full imported hull returns well before boarding.
    const fighterHighDetailDistanceSq = 72 * 72;
    const botVisibleDistanceSq = 160 * 160;
    const droneVisibleDistanceSq = 126 * 126;
    for (const fighter of this.fighters) {
      fighter.visual.setHighDetail(
        fighter === this.playerFighter
        || fighter.flight.position.distanceToSquared(this.playerPosition) <= fighterHighDetailDistanceSq,
      );
    }
    for (const bot of this.bots) {
      if (!bot.alive || this.fighterForPilot(bot.id)) continue;
      bot.group.visible = bot.group.position.distanceToSquared(this.playerPosition) <= botVisibleDistanceSq;
    }
    for (const drone of this.droneSwarm.combatDrones) {
      if (!drone.alive) continue;
      drone.visual.root.visible = drone.position.distanceToSquared(this.playerPosition) <= droneVisibleDistanceSq;
    }
  }

  private togglePlayerFighter(): void {
    if (this.mode !== 'running' || this.fighters.length === 0) return;
    if (this.playerFighter) {
      this.exitPlayerFighter();
      return;
    }
    const fighter = nearestBoardableFighter(this.fighters, this.playerPosition);
    if (!fighter) {
      this.hud.message('NO STAR SPARROW IN BOARDING RANGE');
      return;
    }
    if (fighter.reservedBy !== null) {
      const bot = this.bots[fighter.reservedBy];
      if (bot) this.hud.message(`${bot.displayName} RESERVATION OVERRIDDEN`);
    }
    fighter.reservedBy = null;
    fighter.reservationSeconds = 0;
    fighter.pilot = 'player';
    this.playerFighter = fighter;
    this.detachGrapple();
    this.jetpackActive = false;
    this.playerPosition.copy(fighter.flight.position);
    this.playerVelocity.copy(fighter.flight.velocity);
    const forward = this.fighterForwardScratch.set(0, 0, -1).applyQuaternion(fighter.flight.orientation);
    this.yaw = Math.atan2(-forward.x, -forward.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1));
    this.weaponModel.visible = false;
    this.playerAvatar.root.visible = false;
    this.vehicleButton.textContent = 'EJECT';
    document.body.dataset.pilotingFighter = 'true';
    this.hud.message(`STAR SPARROW ONLINE · ${fighter.pad.label}`);
    this.audio.dash();
  }

  private exitPlayerFighter(): void {
    const fighter = this.playerFighter;
    if (!fighter) return;
    const right = this.fighterRightScratch.set(1, 0, 0).applyQuaternion(fighter.flight.orientation);
    const up = this.fighterUpScratch.set(0, 1, 0).applyQuaternion(fighter.flight.orientation);
    this.playerPosition.copy(fighter.flight.position)
      .addScaledVector(right, 10)
      .addScaledVector(up, 3.2);
    const safe = this.arena.safeSpawnPoint(this.playerPosition, 0.34, 1.78);
    if (safe) this.playerPosition.copy(safe);
    this.playerVelocity.copy(fighter.flight.velocity).multiplyScalar(0.55).addScaledVector(up, 4.5);
    fighter.pilot = null;
    this.playerFighter = null;
    this.fighterBoostQueued = false;
    this.fighterMissileQueued = false;
    this.grounded = false;
    this.vehicleButton.textContent = 'BOARD';
    document.body.dataset.pilotingFighter = 'false';
    this.weaponModel.visible = !this.isThirdPerson();
    this.hud.message('EJECTED · JETPACK CONTROL RESTORED');
  }

  /**
   * Adds dynamic craft contacts to the arena's static 120 Hz sweep. The same
   * six-sphere compound used for building impacts represents every other live
   * fighter, including docked craft. Relative motion keeps boosted head-on
   * contacts from tunnelling and supplies the other hull's velocity to the
   * existing slide/restitution/impact-damage solver.
   */
  private castFighterWorldCollision(
    query: FighterCollisionQuery,
    outHit: FighterCollisionHit,
  ): boolean {
    let found = this.fighterCollision.query(query, outHit);
    let bestFraction = found && Number.isFinite(outHit.fraction)
      ? outHit.fraction
      : Number.POSITIVE_INFINITY;
    const subject = this.fighterCollisionSubject;
    if (!subject || query.kind !== 'body') return found;

    const relativeSweep = this.fighterDynamicSweepScratch
      .copy(query.end)
      .sub(query.start);
    const originalDx = relativeSweep.x;
    const originalDy = relativeSweep.y;
    const originalDz = relativeSweep.z;
    for (let fighterIndex = 0; fighterIndex < this.fighters.length; fighterIndex += 1) {
      const other = this.fighters[fighterIndex];
      if (other === subject || other.destroyed) continue;
      for (let proxyIndex = 0; proxyIndex < FIGHTER_FLIGHT_TUNING.collisionProxies.length; proxyIndex += 1) {
        const proxy = FIGHTER_FLIGHT_TUNING.collisionProxies[proxyIndex];
        const proxyCenter = this.fighterDynamicProxyScratch
          .set(proxy.x, proxy.y, proxy.z)
          .applyQuaternion(other.flight.orientation)
          .add(other.flight.position);
        relativeSweep.set(
          originalDx - other.flight.velocity.x * FIGHTER_FIXED_STEP,
          originalDy - other.flight.velocity.y * FIGHTER_FIXED_STEP,
          originalDz - other.flight.velocity.z * FIGHTER_FIXED_STEP,
        );
        const delta = this.fighterDynamicDeltaScratch.copy(query.start).sub(proxyCenter);
        const combinedRadius = query.radius + proxy.radius + 0.035;
        const c = delta.lengthSq() - combinedRadius * combinedRadius;
        const a = relativeSweep.lengthSq();
        let fraction = Number.POSITIVE_INFINITY;
        if (c <= 0) fraction = 0;
        else if (a > 1e-9) {
          const b = delta.dot(relativeSweep);
          const discriminant = b * b - a * c;
          if (b < 0 && discriminant >= 0) fraction = (-b - Math.sqrt(discriminant)) / a;
        }
        if (fraction < 0 || fraction > 1 || fraction >= bestFraction) continue;

        proxyCenter.addScaledVector(other.flight.velocity, FIGHTER_FIXED_STEP * fraction);
        delta.set(
          query.start.x + originalDx * fraction,
          query.start.y + originalDy * fraction,
          query.start.z + originalDz * fraction,
        ).sub(proxyCenter);
        if (delta.lengthSq() < 1e-8) {
          delta.copy(query.start).sub(other.flight.position);
          if (delta.lengthSq() < 1e-8) delta.set(1, 0, 0);
        }
        delta.normalize();
        bestFraction = fraction;
        found = true;
        outHit.fraction = fraction;
        outHit.distance = query.maxDistance * fraction;
        outHit.normal.copy(delta);
        outHit.point.set(
          query.start.x + originalDx * fraction - delta.x * query.radius,
          query.start.y + originalDy * fraction - delta.y * query.radius,
          query.start.z + originalDz * fraction - delta.z * query.radius,
        );
        outHit.surfaceVelocity.copy(other.flight.velocity);
        outHit.colliderId = 10_000 + fighterIndex * 16 + proxyIndex;
      }
    }
    return found;
  }

  /**
   * Resolve an upright infantry capsule against the fighter compound. Three
   * retained horizontal sphere slices block both players and bots without
   * turning the broad visual AABB into an invisible wall around the wings.
   */
  private resolveCharacterAgainstFighters(
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    radius: number,
    height: number,
  ): number {
    let contacts = 0;
    const sliceYs = [radius, height * 0.5, height - radius] as const;
    for (let iteration = 0; iteration < 2; iteration += 1) {
      for (const fighter of this.fighters) {
        if (fighter.destroyed) continue;
        for (const proxy of FIGHTER_FLIGHT_TUNING.collisionProxies) {
          const proxyCenter = this.fighterDynamicProxyScratch
            .set(proxy.x, proxy.y, proxy.z)
            .applyQuaternion(fighter.flight.orientation)
            .add(fighter.flight.position);
          // Infantry intersects the lower visible hull, whereas the flight
          // compound is centered for symmetric aerial response. Lower this
          // character-only sampling layer to cover the ventral housing.
          proxyCenter.y -= 1;
          for (const sliceY of sliceYs) {
            const dy = position.y + sliceY - proxyCenter.y;
            // The authored hull's ventral housing reaches about 3.05 m below
            // the root while the flight spheres are intentionally tighter for
            // responsive building grazes. Infantry receives a small shell
            // expansion so it cannot stand in that visible lower body.
            const combinedRadius = radius + proxy.radius + 0.35;
            if (Math.abs(dy) >= combinedRadius) continue;
            const allowedHorizontal = Math.sqrt(Math.max(0, combinedRadius * combinedRadius - dy * dy));
            const delta = this.fighterCharacterDeltaScratch.set(
              position.x - proxyCenter.x,
              0,
              position.z - proxyCenter.z,
            );
            const horizontalSq = delta.x * delta.x + delta.z * delta.z;
            if (horizontalSq >= allowedHorizontal * allowedHorizontal) continue;
            const horizontalDistance = Math.sqrt(horizontalSq);
            const normal = this.fighterCharacterNormalScratch;
            if (horizontalDistance > 1e-6) normal.copy(delta).multiplyScalar(1 / horizontalDistance);
            else {
              normal.set(1, 0, 0).applyQuaternion(fighter.flight.orientation).setY(0);
              if (normal.lengthSq() < 1e-8) normal.set(1, 0, 0);
              else normal.normalize();
            }
            const separation = allowedHorizontal - horizontalDistance + 0.012;
            position.addScaledVector(normal, separation);
            const inwardSpeed = velocity.x * normal.x + velocity.z * normal.z;
            if (inwardSpeed < 0) velocity.addScaledVector(normal, -inwardSpeed);
            contacts += 1;
          }
        }
      }
    }
    return contacts;
  }

  private updateFighters(delta: number): void {
    for (const fighter of this.fighters) {
      fighter.primaryCooldown = Math.max(0, fighter.primaryCooldown - delta);
      fighter.missileCooldown = Math.max(0, fighter.missileCooldown - delta);
      fighter.shieldDelay = Math.max(0, fighter.shieldDelay - delta);
      fighter.hullHit = Math.max(0, fighter.hullHit - delta * 4.8);
      fighter.shieldHit = Math.max(0, fighter.shieldHit - delta * 5.8);
      fighter.reservationSeconds = Math.max(0, fighter.reservationSeconds - delta);
      if (fighter.reservationSeconds <= 0) fighter.reservedBy = null;

      if (fighter.destroyed) {
        fighter.respawnSeconds = Math.max(0, fighter.respawnSeconds - delta);
        if (fighter.respawnSeconds <= 0) {
          resetFighterAtPad(fighter);
          this.hud.message(`STAR SPARROW REBUILT · ${fighter.pad.label}`);
        }
        continue;
      }

      if (fighter.shieldDelay <= 0 && fighter.shield < FIGHTER_SHIELD_MAX) {
        fighter.shield = Math.min(FIGHTER_SHIELD_MAX, fighter.shield + delta * 55);
      }

      const intent = fighter.intent;
      if (fighter.pilot === 'player') {
        this.input.readMovement(this.moveInput);
        const forward = this.fighterForwardScratch.set(0, 0, -1).applyQuaternion(fighter.flight.orientation);
        const right = this.fighterRightScratch.set(1, 0, 0).applyQuaternion(fighter.flight.orientation);
        const up = this.fighterUpScratch.set(0, 1, 0).applyQuaternion(fighter.flight.orientation);
        const desired = this.viewDirection(this.fighterAimScratch);
        intent.throttle = this.moveInput.y;
        intent.strafe = this.moveInput.x;
        intent.lift = this.input.isJumpHeld() ? 1 : this.input.isFighterDescendHeld() ? -0.55 : 0;
        if (fighter.flight.grounded && (intent.throttle > 0.1 || this.input.isJumpHeld())) {
          intent.lift = Math.max(intent.lift, 0.72);
        }
        intent.pitch = THREE.MathUtils.clamp(desired.dot(up) * 2.4, -1, 1);
        intent.yaw = THREE.MathUtils.clamp(desired.dot(right) * 2.6, -1, 1);
        intent.roll = THREE.MathUtils.clamp(intent.yaw * 0.68 + this.moveInput.x * 0.22, -1, 1);
        intent.afterburner = this.input.isSkiHeld() && intent.throttle > 0.1;
        intent.boost = this.fighterBoostQueued;
        // Keep camera/aim stable if a hard collision rotates the craft through
        // the reticle; flight response, not direct quaternion assignment, closes it.
        void forward;
      } else if (fighter.pilot === null) {
        intent.throttle = 0;
        intent.strafe = 0;
        intent.lift = 0;
        intent.pitch = 0;
        intent.yaw = 0;
        intent.roll = 0;
        intent.afterburner = false;
        intent.boost = false;
      }

      const dockedAndUnpiloted = fighter.pilot === null
        && fighter.flight.position.distanceToSquared(fighter.pad.position) <= 2.2 * 2.2
        && fighter.flight.velocity.lengthSq() <= 3 * 3;
      if (dockedAndUnpiloted) {
        fighter.flight.position.copy(fighter.pad.position);
        fighter.flight.velocity.set(0, 0, 0);
        fighter.flight.angularVelocity.set(0, 0, 0);
        fighter.flight.grounded = true;
        fighter.flight.landingReady = true;
        fighter.flight.landingReadiness = 1;
        fighter.flight.supportDistance = 0.12;
        fighter.flightAccumulator = 0;
        continue;
      }

      fighter.flightAccumulator = Math.min(
        fighter.flightAccumulator + delta,
        FIGHTER_FIXED_STEP * 3,
      );
      while (fighter.flightAccumulator >= FIGHTER_FIXED_STEP) {
        this.fighterCollisionSubject = fighter;
        stepFighterFlight(fighter.flight, intent, this.queryFighterWorldCollision);
        this.fighterCollisionSubject = null;
        fighter.flightAccumulator -= FIGHTER_FIXED_STEP;
        intent.boost = false;
        if (fighter.flight.impactDamageThisStep > 0) {
          this.damageFighter(
            fighter,
            fighter.flight.impactDamageThisStep,
            fighter.pilot ?? 'player',
            'IMPACT',
          );
          if (fighter.destroyed) break;
        }
      }

      if (fighter.pilot === 'player') {
        this.playerPosition.copy(fighter.flight.position);
        this.playerVelocity.copy(fighter.flight.velocity);
        if (this.input.isFireHeld()) this.fireFighterWeapon(fighter, false);
        if (this.fighterMissileQueued) this.fireFighterWeapon(fighter, true);
      } else if (typeof fighter.pilot === 'number') {
        const bot = this.bots[fighter.pilot];
        if (bot) {
          bot.group.position.copy(fighter.flight.position);
          bot.velocity.copy(fighter.flight.velocity);
          bot.group.visible = false;
        }
      }
    }
    this.fighterCollisionSubject = null;
    this.fighterBoostQueued = false;
    this.fighterMissileQueued = false;
  }

  private fireFighterWeapon(fighter: FighterRuntime, missile: boolean, explicitAimPoint?: THREE.Vector3): void {
    const cooldown = missile ? fighter.missileCooldown : fighter.primaryCooldown;
    if (fighter.destroyed || fighter.pilot === null || cooldown > 0) return;
    const owner = fighter.pilot;
    const sockets = fighter.visual.weaponSockets;
    const socket = sockets.length > 0
      ? sockets[fighter.weaponAlternator % sockets.length]
      : null;
    fighter.visual.root.updateMatrixWorld(true);
    const origin = socket
      ? socket.getWorldPosition(this.fighterMuzzleScratch)
      : this.fighterMuzzleScratch.copy(fighter.flight.position)
        .addScaledVector(this.fighterForwardScratch.set(0, 0, -1).applyQuaternion(fighter.flight.orientation), 3.4);
    const aimPoint = explicitAimPoint ?? (owner === 'player'
      ? this.playerFighterAimPoint(fighter, FIGHTER_AIM_RANGE)
      : this.fighterAimPointScratch.copy(fighter.flight.position)
        .addScaledVector(
          this.fighterAimScratch.set(0, 0, -1).applyQuaternion(fighter.flight.orientation),
          FIGHTER_AIM_RANGE,
        ));
    const direction = this.fighterAimScratch.copy(aimPoint).sub(origin);
    if (direction.lengthSq() > 1e-8) direction.normalize();
    else direction.set(0, 0, -1).applyQuaternion(fighter.flight.orientation);
    const baseDefinition = this.weapon(missile ? 'rocket' : 'plasma');
    const definition: WeaponDefinition = {
      ...baseDefinition,
      projectileSpeed: missile
        ? FIGHTER_MISSILE_PROJECTILE_SPEED
        : FIGHTER_PRIMARY_PROJECTILE_SPEED,
    };
    this.spawnProjectile(origin, direction, owner, definition, missile ? { life: 5.2 } : { life: 3.2 });
    fighter.weaponAlternator += 1;
    if (missile) fighter.missileCooldown = FIGHTER_MISSILE_COOLDOWN;
    else fighter.primaryCooldown = FIGHTER_PRIMARY_COOLDOWN;
    if (owner === 'player') this.audio.weaponPlayer(definition.id, this.rng() - 0.5);
    else this.audio.weaponWorld(definition.id, origin, `fighter-${fighter.id}`, (owner - 1) * 0.14);
    this.fovPunch = Math.max(this.fovPunch, missile ? 3.4 : 0.75);
    this.recoil = Math.max(this.recoil, missile ? 0.45 : 0.12);
  }

  /** Converges offset fighter hardpoints onto the first target under the HUD reticle. */
  private playerFighterAimPoint(subject: FighterRuntime, range: number): THREE.Vector3 {
    const origin = this.camera.position;
    const view = this.viewDirection(this.fighterAimScratch);
    const result = this.fighterAimPointScratch.copy(origin).addScaledVector(view, range);
    const worldHit = this.arena.segmentHit(origin, result);
    let bestDistance = worldHit ? origin.distanceTo(worldHit) : range;
    if (worldHit) result.copy(worldHit);
    this.fighterAimRay.set(origin, view);

    for (const fighter of this.fighters) {
      if (fighter === subject || fighter.destroyed) continue;
      const radius = Math.max(1.8, fighter.visual.radius * 0.68);
      const hit = this.fighterAimRay.intersectSphere(
        new THREE.Sphere(fighter.flight.position, radius),
        this.fighterAimHitScratch,
      );
      if (!hit) continue;
      const distance = origin.distanceTo(hit);
      if (distance <= 0.05 || distance >= bestDistance) continue;
      bestDistance = distance;
      result.copy(hit);
    }
    for (const bot of this.bots) {
      if (!bot.alive || this.fighters.some((fighter) => fighter.pilot === bot.id)) continue;
      const hit = this.rayOwnerCapsuleHit(origin, view, bot.id, bestDistance, 'plasma');
      if (!hit) continue;
      const distance = origin.distanceTo(hit);
      if (distance <= 0.05 || distance >= bestDistance) continue;
      bestDistance = distance;
      result.copy(hit);
    }
    return result;
  }

  private damageFighter(fighter: FighterRuntime, amount: number, owner: Owner, cause: string): void {
    if (fighter.destroyed || amount <= 0) return;
    fighter.shieldDelay = 4;
    let remaining = amount;
    if (fighter.shield > 0) {
      const shieldDamage = Math.min(fighter.shield, remaining);
      fighter.shield -= shieldDamage;
      remaining -= shieldDamage;
      fighter.shieldHit = Math.min(1, fighter.shieldHit + shieldDamage / 32);
    }
    if (remaining > 0) {
      fighter.hull = Math.max(0, fighter.hull - remaining);
      fighter.hullHit = Math.min(1, fighter.hullHit + remaining / 42);
    }
    if (fighter.hull > 0) return;
    this.destroyFighter(fighter, owner, cause);
  }

  private destroyFighter(fighter: FighterRuntime, owner: Owner, cause: string): void {
    const pilot = fighter.pilot;
    fighter.destroyed = true;
    fighter.explosions += 1;
    fighter.respawnSeconds = FIGHTER_RESPAWN_SECONDS;
    fighter.pilot = null;
    fighter.reservedBy = null;
    fighter.flight.velocity.set(0, 0, 0);
    fighter.flight.angularVelocity.set(0, 0, 0);
    // Remove the intact hull in the same gameplay event as the blast. Waiting
    // for presentation sync leaves a one-frame wreck—and can leave it parked
    // indefinitely when simulation is paused immediately after lethal damage.
    fighter.visual.root.visible = false;
    this.weaponVfx.vehicleExplosion(
      fighter.flight.position,
      0xff713b,
      FIGHTER_DESTRUCTION_VFX_SCALE,
    );
    this.spawnBurst(fighter.flight.position, 0xff713b, 32);
    this.audio.projectileImpact('rocket', fighter.flight.position, this.rng() - 0.5);
    const destructionProximity = THREE.MathUtils.clamp(
      1 - this.playerPosition.distanceTo(fighter.flight.position) / 140,
      0,
      1,
    );
    this.fovPunch = Math.max(this.fovPunch, destructionProximity * 8);
    this.trauma = Math.min(1, this.trauma + destructionProximity * 0.7);
    if (pilot === 'player') {
      this.playerFighter = null;
      this.playerPosition.copy(fighter.flight.position);
      this.playerVelocity.set(0, 0, 0);
      this.vehicleButton.textContent = 'BOARD';
      document.body.dataset.pilotingFighter = 'false';
      this.damagePlayer(999, owner, `STAR SPARROW DESTROYED · ${cause}`, fighter.flight.position);
    } else if (typeof pilot === 'number') {
      const bot = this.bots[pilot];
      if (bot) {
        bot.group.visible = true;
        bot.group.position.copy(fighter.flight.position);
        this.applyDamageToBot(bot, 999, owner, `STAR SPARROW DESTROYED · ${cause}`);
      }
    }
    this.hud.message(`STAR SPARROW DESTROYED · REBUILD ${FIGHTER_RESPAWN_SECONDS}s`);
  }

  private fixedUpdate(delta: number): void {
    this.jumpBuffer = Math.max(0, this.jumpBuffer - delta);
    if (this.input.isJumpHeld()) this.jumpBuffer = Math.max(this.jumpBuffer, MOVEMENT.fixedStep * 1.5);
    this.dashBuffer = Math.max(0, this.dashBuffer - delta);
    this.dashCooldown = Math.max(0, this.dashCooldown - delta);
    this.dashMomentumTimer = Math.max(0, this.dashMomentumTimer - delta);
    this.wallContactTimer = Math.max(0, this.wallContactTimer - delta);
    this.ceilingContactTimer = Math.max(0, this.ceilingContactTimer - delta);
    this.weaponCooldown = Math.max(0, this.weaponCooldown - delta);
    this.grenadeCooldown = Math.max(0, this.grenadeCooldown - delta);
    this.jumpPadCooldown = Math.max(0, this.jumpPadCooldown - delta);
    this.damageBoost = Math.max(0, this.damageBoost - delta);
    this.speedBoost = Math.max(0, this.speedBoost - delta);
    const holdingLaser = this.mode === 'running'
      && WEAPONS[this.selectedWeapon].id === 'laser'
      && this.input.isFireHeld();
    if (!holdingLaser) this.laserHeat = Math.max(0, this.laserHeat - delta * 0.56);

    if (this.mode === 'respawning') {
      this.respawnTimer -= delta;
      if (this.respawnTimer <= 0) this.respawnPlayer(true);
    }

    if (this.mode === 'countdown') {
      const countdownComplete = this.updateMatchCountdown(delta);
      if (!countdownComplete) {
        this.weaponVfx.stopContinuousLaser();
        this.audio.setLaserBeamActive(false);
        return;
      }
    }

    if (this.mode !== 'running') {
      if (this.mode === 'respawning') this.updateFighters(delta);
      this.botAccumulator = 0;
      this.jetpackActive = false;
      this.jetpackEnergy.update(0, false, this.grounded);
      this.weaponVfx.stopContinuousLaser();
      this.audio.setLaserBeamActive(false);
      this.updateProjectiles(delta);
      this.updateGrenades(delta);
      return;
    }

    this.matchTime -= delta;
    let bestScore = this.score;
    let leadersAtBestScore = 1;
    let reachedScoreLimit = this.score >= SCORE_LIMIT;
    let overtimeScoreChanged = this.overtime && this.overtimeBaselineScores[0] !== this.score;
    for (let index = 0; index < this.bots.length; index += 1) {
      const botScore = this.bots[index].score;
      reachedScoreLimit ||= botScore >= SCORE_LIMIT;
      overtimeScoreChanged ||= this.overtime && this.overtimeBaselineScores[index + 1] !== botScore;
      if (botScore > bestScore) {
        bestScore = botScore;
        leadersAtBestScore = 1;
      } else if (botScore === bestScore) {
        leadersAtBestScore += 1;
      }
    }
    if (overtimeScoreChanged) {
      this.completeMatch();
      return;
    }
    if (reachedScoreLimit) {
      this.completeMatch();
      return;
    }
    if (this.matchTime <= 0) {
      if (!this.overtime && leadersAtBestScore > 1) {
        this.overtime = true;
        this.overtimeBaselineScores = [this.score, ...this.bots.map((bot) => bot.score)];
        this.matchTime = 60;
        this.hud.message('OVERTIME · NEXT SCORE WINS');
      } else if (this.overtime) {
        this.matchTime = 60;
        this.hud.message('OVERTIME EXTENDED · NEXT SCORE WINS');
      } else {
        this.completeMatch();
        return;
      }
    }

    this.styleSystem.update(delta);
    const previousWeatherPhase = this.weatherSnapshot.phase;
    this.weatherSnapshot = this.weatherSystem.update(delta);
    if (this.weatherSnapshot.phase !== previousWeatherPhase) {
      if (this.weatherSnapshot.phase === 'warning') this.hud.message(this.weatherSnapshot.label);
      else if (this.weatherSnapshot.phase === 'monsoon') this.hud.message('MONSOON ACTIVE · TRACTION SHIFT');
      else if (this.weatherSnapshot.phase === 'recovery') this.hud.message('WEATHER CLEARING');
    }
    this.updateMapFog(this.weatherSnapshot.multipliers.visibilityMultiplier);

    this.updateFighters(delta);
    if (!this.playerFighter) this.updatePlayerMovement(delta);
    else {
      this.jetpackActive = false;
      this.jetpackEnergy.update(0, false, false);
    }
    this.updateDrones(delta);
    this.maxPlayerSpeed = Math.max(this.maxPlayerSpeed, Math.hypot(this.playerVelocity.x, this.playerVelocity.z));
    this.updateGrapple(delta);
    if (!this.physicsQaMode) {
      this.botAccumulator += delta;
      while (this.botAccumulator >= BOT_FIXED_STEP) {
        this.updateBots(BOT_FIXED_STEP);
        this.botAccumulator -= BOT_FIXED_STEP;
      }
    }
    this.updateProjectiles(delta);
    this.updateGrenades(delta);
    this.updatePickups(delta);
    this.updateCore(delta);
    if (this.input.isFireHeld() && !this.playerFighter) {
      if (WEAPONS[this.selectedWeapon].id === 'laser') this.fireContinuousLaserTick(delta);
      else {
        this.weaponVfx.stopContinuousLaser();
        this.audio.setLaserBeamActive(false);
        this.tryFirePlayerWeapon();
      }
    } else {
      this.weaponVfx.stopContinuousLaser();
      this.audio.setLaserBeamActive(false);
    }
  }

  private updatePlayerMovement(delta: number): void {
    const movementStart = this.movementStartScratch.copy(this.playerPosition);
    this.input.readMovement(this.moveInput);
    this.skiHeld = this.input.isSkiHeld();
    this.coyote = this.grounded ? MOVEMENT.coyoteTime : Math.max(0, this.coyote - delta);

    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.wishDirection.set(0, 0, 0)
      .addScaledVector(this.right, this.moveInput.x)
      .addScaledVector(this.forward, this.moveInput.y);
    if (this.wishDirection.lengthSq() > 1) this.wishDirection.normalize();

    if (this.dashBuffer > 0 && this.dashCooldown <= 0) {
      const dashDirection = this.wishDirection.lengthSq() > 0.01 ? this.wishDirection : this.forward;
      const along = this.playerVelocity.x * dashDirection.x + this.playerVelocity.z * dashDirection.z;
      const impulse = Math.max(0, MOVEMENT.dashImpulse - Math.max(0, along) * 0.18);
      this.playerVelocity.addScaledVector(dashDirection, impulse);
      this.dashBuffer = 0;
      this.dashCooldown = MOVEMENT.dashCooldown;
      this.dashMomentumTimer = MOVEMENT.dashPreserveTime;
      this.fovPunch = Math.max(this.fovPunch, 5.5);
      this.audio.dash();
    }

    const horizontalSpeed = Math.hypot(this.playerVelocity.x, this.playerVelocity.z);
    const bufferedGroundJump = this.jumpBuffer > 0 && this.coyote > 0;
    if (bufferedGroundJump) {
      // Held jumping skips the landing-friction frame, matching Warsow's
      // momentum-preserving bunny hop instead of bleeding speed every cycle.
      this.playerVelocity.y = MOVEMENT.jumpImpulse;
      this.jumpBuffer = 0;
      this.coyote = 0;
      this.grounded = false;
      this.fovPunch = Math.max(this.fovPunch, 3.5);
      this.audio.jump();
    }

    const previousJetpackEnergy = this.jetpackEnergy.snapshot();
    const jetpackEnergy = this.jetpackEnergy.update(
      delta,
      this.input.isJumpHeld(),
      this.grounded,
    );
    this.jetpackActive = jetpackEnergy.active;
    if (!previousJetpackEnergy.locked && jetpackEnergy.locked) {
      this.hud.message('JETPACK DEPLETED · COAST TO RECHARGE');
      this.hud.pulseJetpack('depleted');
      this.audio.jetpackDepleted();
    } else if (previousJetpackEnergy.locked && !jetpackEnergy.locked) {
      this.hud.message('JETPACK READY');
      this.hud.pulseJetpack('ready');
      this.audio.jetpackReady();
    }

    if (this.grounded) {
      if (this.skiHeld) {
        if (this.terrainNormal.y > 0.05) {
          this.playerVelocity.y = -(
            this.terrainNormal.x * this.playerVelocity.x
            + this.terrainNormal.z * this.playerVelocity.z
          ) / this.terrainNormal.y;
        }
        const skiMomentum = skiMomentumCurve(horizontalSpeed, this.skiMomentumScratch);
        this.skiMomentumResistance = skiMomentum.resistance;
        this.skiGravityDriveScale = skiMomentum.gravityDriveScale;
        this.skiDragAcceleration = skiMomentum.dragAcceleration
          * this.weatherSnapshot.multipliers.groundFrictionMultiplier;
        const tangentGravity = this.tangentGravityScratch.set(0, -MOVEMENT.gravity, 0)
          .addScaledVector(this.terrainNormal, MOVEMENT.gravity * this.terrainNormal.y)
          .multiplyScalar(MOVEMENT.skiGravityScale * skiMomentum.gravityDriveScale);
        this.playerVelocity.addScaledVector(tangentGravity, delta);
        this.applySkiCarve(this.wishDirection, this.terrainNormal, delta);
        const tangentSpeed = this.playerVelocity.length();
        if (tangentSpeed > 0.001) {
          const nextSpeed = Math.max(0, tangentSpeed - this.skiDragAcceleration * delta);
          this.playerVelocity.multiplyScalar(nextSpeed / tangentSpeed);
        }
        // Ski input supplies only a small shove and steering authority. Race
        // speed has to come from choosing a downhill line and carrying that
        // momentum through the next transition.
        this.accelerateOnSurface(
          this.wishDirection,
          this.terrainNormal,
          MOVEMENT.skiPushAcceleration,
          MOVEMENT.skiPushWishSpeed * (this.speedBoost > 0 ? 1.2 : 1),
          delta,
        );
      } else if (horizontalSpeed > 0 && this.dashMomentumTimer <= 0) {
        const control = Math.max(MOVEMENT.stopSpeed, horizontalSpeed);
        const nextSpeed = Math.max(
          0,
          horizontalSpeed
            - control * MOVEMENT.groundFriction * this.weatherSnapshot.multipliers.groundFrictionMultiplier * delta,
        );
        const scale = nextSpeed / horizontalSpeed;
        this.playerVelocity.x *= scale;
        this.playerVelocity.z *= scale;
      }
      if (!this.skiHeld) {
        this.skiMomentumResistance = 0;
        this.skiGravityDriveScale = 1;
        this.skiDragAcceleration = 0;
        this.accelerate(
          this.wishDirection,
          MOVEMENT.groundAcceleration * this.weatherSnapshot.multipliers.groundTractionMultiplier,
          MOVEMENT.wishSpeed * (this.speedBoost > 0 ? 1.25 : 1),
          delta,
        );
      }
    } else {
      this.skiMomentumResistance = 0;
      this.skiGravityDriveScale = 1;
      this.skiDragAcceleration = 0;
      const wishSpeed = MOVEMENT.wishSpeed * (this.speedBoost > 0 ? 1.25 : 1);
      const movingAgainstVelocity = this.playerVelocity.x * this.wishDirection.x
        + this.playerVelocity.z * this.wishDirection.z < 0;
      const pureStrafe = Math.abs(this.moveInput.x) > 0.01 && Math.abs(this.moveInput.y) < 0.01;
      this.accelerate(
        this.wishDirection,
        (pureStrafe
          ? MOVEMENT.strafeAcceleration
          : movingAgainstVelocity
            ? MOVEMENT.airDeceleration
            : MOVEMENT.airAcceleration) * this.weatherSnapshot.multipliers.airControlMultiplier,
        pureStrafe ? MOVEMENT.strafeWishSpeed : wishSpeed,
        delta,
      );
      this.applyWarsowAirControl(this.wishDirection, delta);
      this.applyAirCarve(this.wishDirection, delta);
    }

    if (!this.grounded) {
      if (this.jetpackActive) {
        this.playerVelocity.y = Math.min(
          MOVEMENT.jetpackMaxRiseSpeed,
          this.playerVelocity.y + MOVEMENT.jetpackAcceleration * delta,
        );
        this.fovPunch = Math.max(this.fovPunch, 1.2);
      }
      this.playerVelocity.y -= MOVEMENT.gravity * delta;
    }
    const speed3d = this.playerVelocity.length();
    if (speed3d > MOVEMENT.maxSpeed) this.playerVelocity.multiplyScalar(MOVEMENT.maxSpeed / speed3d);
    const distance = this.playerVelocity.length() * delta;
    const movementSteps = Math.max(1, Math.ceil(distance / MOVEMENT.maxSubstepDistance));
    const subDelta = delta / movementSteps;
    for (let index = 0; index < movementSteps; index += 1) this.movePlayerSubstep(subDelta);
    this.updateFootsteps(movementStart, delta);
    this.checkJumpPads();
  }

  private updateFootsteps(start: THREE.Vector3, delta: number): void {
    const distance = Math.hypot(this.playerPosition.x - start.x, this.playerPosition.z - start.z);
    const speed = Math.hypot(this.playerVelocity.x, this.playerVelocity.z);
    const planted = this.grounded || this.coyote > MOVEMENT.fixedStep * 2;
    if (!planted || this.skiHeld || speed < 2 || distance > MOVEMENT.maxSpeed * delta * 1.5) {
      this.footstepDistance = Math.max(0, this.footstepDistance - delta * 4);
      return;
    }
    this.footstepDistance += distance;
    const stride = THREE.MathUtils.clamp(2.15 - speed * 0.035, 1.12, 2.05);
    if (this.footstepDistance < stride) return;
    this.footstepDistance %= stride;
    const surface = this.arena.surfaceAt(this.playerPosition.x, this.playerPosition.z, this.playerPosition.y + 0.35);
    this.audio.footstep(this.noise(this.elapsed, 37) * 0.5, surface);
    if (surface === 'soil') this.arena.addFootTrack(this.playerPosition, this.playerVelocity, this.elapsed);
  }

  private movePlayerSubstep(delta: number): void {
    const startPosition = this.substepStartPosition.copy(this.playerPosition);
    const startVelocity = this.substepStartVelocity.copy(this.playerVelocity);
    const wasGrounded = this.grounded;
    const intendedPosition = this.substepIntendedPosition.copy(this.playerPosition)
      .addScaledVector(this.playerVelocity, delta);
    const sweptContact = this.sweepPlayerMotion(startPosition, intendedPosition);
    this.playerPosition.copy(intendedPosition);
    const impact = -this.playerVelocity.y;
    const blockedPosition = this.substepBlockedPosition.copy(this.playerPosition);
    let contact = this.arena.resolvePlayerCapsule(this.playerPosition, this.playerVelocity);
    const fighterContacts = this.resolveCharacterAgainstFighters(
      this.playerPosition,
      this.playerVelocity,
      MOVEMENT.playerRadius,
      MOVEMENT.playerHeight,
    );
    if (fighterContacts > 0) {
      contact.wallContact = true;
      contact.wallNormal.copy(this.fighterCharacterNormalScratch);
      contact.contacts += fighterContacts;
    }
    if (sweptContact.wallNormal) {
      contact.wallContact = true;
      contact.wallNormal.copy(sweptContact.wallNormal);
      contact.contacts += 1;
    }
    if (sweptContact.ceilingNormal) contact.contacts += 1;
    blockedPosition.copy(this.playerPosition);

    const intendedHorizontalDistance = Math.hypot(startVelocity.x, startVelocity.z) * delta;
    const resolvedHorizontalDistance = Math.hypot(
      blockedPosition.x - startPosition.x,
      blockedPosition.z - startPosition.z,
    );
    const horizontallyBlocked = intendedHorizontalDistance > 1e-4
      && resolvedHorizontalDistance < intendedHorizontalDistance * 0.9;
    if (wasGrounded && sweptContact.wallNormal === null && (contact.wallContact || horizontallyBlocked)) {
      const steppedContact = this.tryStepMove(
        startPosition,
        startVelocity,
        blockedPosition,
        delta,
      );
      if (steppedContact) contact = steppedContact;
    }

    this.lastPhysicsContacts = contact.contacts;
    this.grounded = contact.grounded;
    if (contact.grounded) {
      this.terrainNormal.copy(contact.contactNormal);
      if (impact > 7 && this.lastGroundImpact <= 0) {
        this.trauma = Math.min(1, this.trauma + Math.min(0.34, impact * 0.012));
        this.audio.land(impact);
        this.lastGroundImpact = 0.16;
      }
    } else if (contact.contacts === 0) {
      this.terrainNormal.set(0, 1, 0);
    }
    // A grounded capsule can touch floor and wall in the same substep. Keep
    // wall feedback independent from the ground-contact branch so diagnostics,
    // steering recovery, and tests observe the actual compound contact.
    if (contact.wallContact) this.wallContactTimer = 0.1;
    if (sweptContact.ceilingNormal) this.ceilingContactTimer = 0.1;
    this.lastGroundImpact = Math.max(0, this.lastGroundImpact - delta);
    if (this.playerPosition.y < this.arena.killY && this.mode === 'running') this.damagePlayer(999, 'player', 'FELL INTO THE VOID');
  }

  /**
   * Conservative CCD guard for the custom character controller.
   *
   * Arena.resolvePlayerCapsule owns penetration recovery and grounding, but an
   * overlap-only endpoint can land beyond a thin wall/roof after a dash,
   * grapple pull, or frame spike. These offset BVH rays approximate the swept
   * capsule's leading face, stop just before first impact, and project velocity
   * onto the contact plane. Walkable upward-facing terrain is deliberately
   * ignored so ski and ramp flow still use the authored heightfield solver.
   */
  private sweepPlayerMotion(
    start: THREE.Vector3,
    intended: THREE.Vector3,
  ): PlayerSweepResult {
    const result = this.sweepResult;
    result.wallNormal = null;
    result.ceilingNormal = null;
    const displacement = this.sweepDisplacement.copy(intended).sub(start);
    const distance = displacement.length();
    if (distance >= MOVEMENT.sweepMinDistance) {
      this.ccdSweeps += 1;
      const horizontal = this.sweepHorizontal.set(displacement.x, 0, displacement.z);
      const horizontalDistance = horizontal.length();
      let wallOffsetCount = 0;
      if (horizontalDistance > 1e-5) {
        const forward = horizontal.multiplyScalar(1 / horizontalDistance);
        const side = this.sweepSide.set(-forward.z, 0, forward.x);
        const front = this.sweepFront.copy(forward).multiplyScalar(MOVEMENT.playerRadius);
        const halfSide = this.sweepHalfSide.copy(side).multiplyScalar(MOVEMENT.playerRadius * 0.68);
        const middleHeight = MOVEMENT.playerHeight * 0.5;
        const lowerHeight = Math.max(
          MOVEMENT.playerRadius,
          MOVEMENT.stepHeight + MOVEMENT.collisionSkin,
        );
        const upperHeight = MOVEMENT.playerHeight - MOVEMENT.playerRadius * 0.7;
        this.sweepOffsets[0].copy(front).setY(middleHeight);
        this.sweepOffsets[1].copy(front).add(halfSide).setY(middleHeight);
        this.sweepOffsets[2].copy(front).sub(halfSide).setY(middleHeight);
        // Mid-height rays can pass entirely above a low ramp skirt or below a
        // lintel even though the capsule overlaps it. Center probes near the
        // feet and head close those vertical tunnelling gaps without adding a
        // full grid of expensive BVH rays.
        this.sweepOffsets[3].copy(front).setY(lowerHeight);
        this.sweepOffsets[4].copy(front).setY(upperHeight);
        wallOffsetCount = 5;
      }

      this.sweepBestFraction = Number.POSITIVE_INFINITY;
      this.sweepBestKind = null;
      for (let index = 0; index < wallOffsetCount; index += 1) {
        this.considerPlayerSweep(start, intended, distance, this.sweepOffsets[index], 'wall');
      }
      if (displacement.y > 0.001) {
        const radial = MOVEMENT.playerRadius * 0.72;
        const horizontalLength = Math.hypot(displacement.x, displacement.z);
        const sideX = horizontalLength > 1e-6 ? -displacement.z / horizontalLength : 1;
        const sideZ = horizontalLength > 1e-6 ? displacement.x / horizontalLength : 0;
        this.sweepOffsets[0].set(0, MOVEMENT.playerHeight, 0);
        this.sweepOffsets[1].set(sideX * radial, MOVEMENT.playerHeight, sideZ * radial);
        this.sweepOffsets[2].set(-sideX * radial, MOVEMENT.playerHeight, -sideZ * radial);
        for (let index = 0; index < 3; index += 1) {
          this.considerPlayerSweep(start, intended, distance, this.sweepOffsets[index], 'ceiling');
        }
      }

      if (this.sweepBestKind !== null) {
        intended.copy(start).addScaledVector(displacement, this.sweepBestFraction);
        const intoSurface = this.playerVelocity.dot(this.sweepBestNormal);
        if (intoSurface < 0) this.playerVelocity.addScaledVector(this.sweepBestNormal, -intoSurface);
        if (this.sweepBestKind === 'wall') {
          result.wallNormal = this.sweepWallNormal.copy(this.sweepBestNormal);
          this.ccdWallHits += 1;
        } else {
          result.ceilingNormal = this.sweepCeilingNormal.copy(this.sweepBestNormal);
          this.ccdCeilingHits += 1;
        }
      }
    }

    const halfWidth = this.arena.mapInfo.bounds.width * 0.5
      - MOVEMENT.playerRadius
      - MOVEMENT.arenaBoundaryInset;
    const halfDepth = this.arena.mapInfo.bounds.depth * 0.5
      - MOVEMENT.playerRadius
      - MOVEMENT.arenaBoundaryInset;
    const clampedX = THREE.MathUtils.clamp(intended.x, -halfWidth, halfWidth);
    const clampedZ = THREE.MathUtils.clamp(intended.z, -halfDepth, halfDepth);
    if (clampedX !== intended.x || clampedZ !== intended.z) {
      const boundaryNormal = this.sweepBoundaryNormal.set(
        clampedX !== intended.x ? -Math.sign(intended.x) : 0,
        0,
        clampedZ !== intended.z ? -Math.sign(intended.z) : 0,
      ).normalize();
      intended.x = clampedX;
      intended.z = clampedZ;
      const intoBoundary = this.playerVelocity.dot(boundaryNormal);
      if (intoBoundary < 0) this.playerVelocity.addScaledVector(boundaryNormal, -intoBoundary);
      result.wallNormal = this.sweepWallNormal.copy(boundaryNormal);
      this.ccdBoundaryHits += 1;
    }

    return result;
  }

  private considerPlayerSweep(
    start: THREE.Vector3,
    intended: THREE.Vector3,
    distance: number,
    offset: THREE.Vector3,
    kind: 'wall' | 'ceiling',
  ): void {
    const rayStart = this.sweepRayStart.copy(start).add(offset);
    const rayEnd = this.sweepRayEnd.copy(intended).add(offset);
    const hit = this.arena.movementSegmentHitDetails(rayStart, rayEnd);
    if (!hit || hit.distance <= 1e-5) return;
    const qualifies = kind === 'wall'
      ? hit.normal.y < MOVEMENT.maxSlopeCosine && hit.normal.y > -0.55
      : hit.normal.y < -0.42;
    if (!qualifies) return;
    const fraction = THREE.MathUtils.clamp(
      (hit.distance - MOVEMENT.collisionSkin) / distance,
      0,
      1,
    );
    if (fraction >= this.sweepBestFraction) return;
    this.sweepBestFraction = fraction;
    this.sweepBestKind = kind;
    this.sweepBestNormal.copy(hit.normal);
  }

  private tryStepMove(
    startPosition: THREE.Vector3,
    startVelocity: THREE.Vector3,
    blockedPosition: THREE.Vector3,
    delta: number,
  ): CapsuleContact | null {
    this.stepAttempts += 1;
    const intendedDistance = Math.hypot(startVelocity.x, startVelocity.z) * delta;
    this.lastStepStartSpeed = Math.hypot(startVelocity.x, startVelocity.z);
    this.lastStepInputDistance = intendedDistance;
    if (intendedDistance < 1e-4) {
      this.lastStepReason = 'no-intent';
      return null;
    }

    const blockedDistance = Math.hypot(
      blockedPosition.x - startPosition.x,
      blockedPosition.z - startPosition.z,
    );
    const stepPosition = startPosition.clone();
    const stepVelocity = startVelocity.clone();
    stepPosition.y += MOVEMENT.stepHeight;
    stepVelocity.y = 0;

    // Resolve once at the raised position so a low ceiling or overhang rejects
    // the step path before horizontal movement is applied.
    this.arena.resolvePlayerCapsule(stepPosition, stepVelocity);
    this.lastStepRaisedSpeed = Math.hypot(stepVelocity.x, stepVelocity.z);
    if (stepPosition.y < startPosition.y + MOVEMENT.stepHeight * 0.72) {
      this.lastStepReason = 'blocked-overhead';
      return null;
    }

    // Resolving the raised capsule can correctly remove velocity against the
    // stair riser, but that response must not erase the player's horizontal
    // momentum before the actual tread landing. Keep the authored run vector
    // for the step probe; the landing resolver still owns final placement.
    const stepHorizontal = new THREE.Vector3(startVelocity.x, 0, startVelocity.z);
    if (this.moveInput.lengthSq() > 0.01 && this.wishDirection.lengthSq() > 0.001) {
      const preservedSpeed = Math.min(
        Math.max(stepHorizontal.length(), MOVEMENT.wishSpeed * 0.72),
        MOVEMENT.wishSpeed * 0.78,
      );
      stepHorizontal.copy(this.wishDirection).multiplyScalar(preservedSpeed);
    }
    stepVelocity.x = stepHorizontal.x;
    stepVelocity.z = stepHorizontal.z;
    stepPosition.x += stepVelocity.x * delta;
    stepPosition.z += stepVelocity.z * delta;
    this.arena.resolvePlayerCapsule(stepPosition, stepVelocity);

    // Our capsule solver resolves overlap endpoints rather than performing a
    // continuous trace. A single deep down endpoint can overlap the tread and
    // riser at once, choosing the wall plane and undoing horizontal progress.
    // Probe the downward sweep at several footprint depths and select the
    // nearest climbable authored tread instead.
    const horizontalDirection = new THREE.Vector3(startVelocity.x, 0, startVelocity.z).normalize();
    const probeOffsets = [0, MOVEMENT.playerRadius * 0.34, MOVEMENT.playerRadius * 0.68, MOVEMENT.playerRadius + 0.035];
    const floorCandidates = probeOffsets
      .map((offset) => this.arena.floorHeightAt(
        stepPosition.x + horizontalDirection.x * offset,
        stepPosition.z + horizontalDirection.z * offset,
        stepPosition.y + 0.08,
      ))
      .filter((height): height is number => height !== null)
      .filter((height) => height >= startPosition.y - MOVEMENT.groundSnapDistance - 0.02
        && height <= startPosition.y + MOVEMENT.stepHeight + 0.04);
    const risingTreads = floorCandidates
      .filter((height) => height > startPosition.y + 0.015)
      .sort((a, b) => a - b);
    const floor = risingTreads[0]
      ?? floorCandidates.sort((a, b) => Math.abs(a - startPosition.y) - Math.abs(b - startPosition.y))[0];
    if (floor === undefined) {
      this.lastStepReason = 'no-floor';
      return null;
    }
    // Seat slightly into the ray-selected tread so the overlap resolver emits
    // a genuine walkable ground contact instead of hovering 0.1 mm above it.
    stepPosition.y = floor - 0.003;
    stepVelocity.y = -0.1;
    const landing = this.arena.resolvePlayerCapsule(stepPosition, stepVelocity);
    const rise = stepPosition.y - startPosition.y;
    this.lastStepRise = rise;
    if (rise < -MOVEMENT.groundSnapDistance - 0.02 || rise > MOVEMENT.stepHeight + 0.04) {
      this.lastStepReason = 'invalid-rise';
      return null;
    }
    const steppedDistance = Math.hypot(
      stepPosition.x - startPosition.x,
      stepPosition.z - startPosition.z,
    );
    this.lastStepBlockedDistance = blockedDistance;
    this.lastStepTravelDistance = steppedDistance;
    if (!landing.grounded) {
      this.lastStepReason = 'no-landing';
      return null;
    }
    if (steppedDistance <= blockedDistance + 0.005) {
      this.lastStepReason = 'no-progress';
      return null;
    }

    stepVelocity.y = 0;
    stepVelocity.x = stepHorizontal.x;
    stepVelocity.z = stepHorizontal.z;
    this.lastStepFinalSpeed = Math.hypot(stepVelocity.x, stepVelocity.z);
    this.playerPosition.copy(stepPosition);
    this.playerVelocity.copy(stepVelocity);
    this.stepSuccesses += 1;
    this.lastStepReason = 'success';
    return landing;
  }

  private accelerate(direction: THREE.Vector3, acceleration: number, wishSpeed: number, delta: number): void {
    if (direction.lengthSq() < 0.0001) return;
    const current = this.playerVelocity.x * direction.x + this.playerVelocity.z * direction.z;
    const add = Math.min(acceleration * wishSpeed * delta, wishSpeed - current);
    if (add > 0) {
      this.playerVelocity.x += direction.x * add;
      this.playerVelocity.z += direction.z * add;
    }
  }

  private accelerateOnSurface(
    direction: THREE.Vector3,
    normal: THREE.Vector3,
    acceleration: number,
    wishSpeed: number,
    delta: number,
  ): void {
    if (direction.lengthSq() < 0.0001 || normal.y < 0.05) return;
    const tangentWish = this.movementVectorScratchA.copy(direction)
      .addScaledVector(normal, -direction.dot(normal));
    if (tangentWish.lengthSq() < 0.0001) return;
    tangentWish.normalize();
    const current = this.playerVelocity.dot(tangentWish);
    const add = Math.min(acceleration * wishSpeed * delta, wishSpeed - current);
    if (add > 0) this.playerVelocity.addScaledVector(tangentWish, add);
  }

  private applyWarsowAirControl(direction: THREE.Vector3, delta: number): void {
    // qfusion's forward-air-control equation: rotate the horizontal velocity
    // toward forward/back input while preserving its magnitude and vertical arc.
    if (direction.lengthSq() < 0.0001 || Math.abs(this.moveInput.x) > 0.01 || Math.abs(this.moveInput.y) < 0.01) return;
    const verticalSpeed = this.playerVelocity.y;
    const horizontal = this.movementVectorScratchA.set(this.playerVelocity.x, 0, this.playerVelocity.z);
    const speed = horizontal.length();
    if (speed < 0.001) return;
    horizontal.multiplyScalar(1 / speed);
    const dot = horizontal.dot(direction);
    if (dot <= 0) return;
    const control = 32
      * MOVEMENT.airControl
      * this.weatherSnapshot.multipliers.airControlMultiplier
      * dot
      * dot
      * delta;
    horizontal.multiplyScalar(speed).addScaledVector(direction, control).normalize().multiplyScalar(speed);
    this.playerVelocity.set(horizontal.x, verticalSpeed, horizontal.z);
  }

  private applyAirCarve(direction: THREE.Vector3, delta: number): void {
    if (direction.lengthSq() < 0.0001) return;
    const horizontal = this.movementVectorScratchA.set(this.playerVelocity.x, 0, this.playerVelocity.z);
    const speed = horizontal.length();
    if (speed < 0.25) return;
    const target = this.movementVectorScratchB.copy(direction).setY(0).normalize();
    const heading = horizontal.multiplyScalar(1 / speed);
    const dot = THREE.MathUtils.clamp(heading.dot(target), -1, 1);
    const angle = Math.acos(dot);
    if (angle < 1e-4) return;
    const speedPenalty = 1 + Math.max(0, speed - MOVEMENT.wishSpeed) / MOVEMENT.wishSpeed * 0.82;
    const maxTurn = MOVEMENT.airCarveRate
      * this.weatherSnapshot.multipliers.airControlMultiplier
      * delta
      / speedPenalty;
    const turn = Math.min(angle, maxTurn);
    const cross = heading.x * target.z - heading.z * target.x;
    const sign = Math.sign(cross) || 1;
    const cosine = Math.cos(turn);
    const sine = Math.sin(turn) * sign;
    const x = heading.x * cosine - heading.z * sine;
    const z = heading.x * sine + heading.z * cosine;
    this.playerVelocity.x = x * speed;
    this.playerVelocity.z = z * speed;
  }

  private applySkiCarve(direction: THREE.Vector3, normal: THREE.Vector3, delta: number): void {
    if (direction.lengthSq() < 0.0001 || normal.y < 0.05) return;
    const tangentVelocity = this.movementVectorScratchA.copy(this.playerVelocity)
      .addScaledVector(normal, -this.playerVelocity.dot(normal));
    const speed = tangentVelocity.length();
    if (speed < 0.25) return;
    const tangentWish = this.movementVectorScratchB.copy(direction)
      .addScaledVector(normal, -direction.dot(normal));
    if (tangentWish.lengthSq() < 1e-4) return;
    tangentWish.normalize();
    const heading = tangentVelocity.multiplyScalar(1 / speed);
    const blend = Math.min(1, MOVEMENT.skiCarveRate * delta / (1 + speed / 42));
    heading.lerp(tangentWish, blend).normalize().multiplyScalar(speed);
    this.playerVelocity.copy(heading);
  }

  private checkJumpPads(): void {
    if (this.jumpPadCooldown > 0) return;
    for (const pad of this.arena.jumpPads) {
      const distanceSq = this.playerPosition.distanceToSquared(pad.position);
      if (distanceSq < pad.radius * pad.radius) {
        const preserved = Math.max(18, Math.hypot(this.playerVelocity.x, this.playerVelocity.z));
        this.playerVelocity.addScaledVector(pad.direction, Math.max(pad.launchSpeed, preserved * 0.68));
        this.playerVelocity.y = Math.max(this.playerVelocity.y, pad.direction.y * pad.launchSpeed);
        this.jumpPadCooldown = 0.7;
        this.fovPunch = 7;
        this.trauma = Math.min(1, this.trauma + 0.24);
        this.audio.jump();
        break;
      }
    }
  }

  private fighterForPilot(pilot: Owner): FighterRuntime | null {
    return this.fighters.find((fighter) => fighter.pilot === pilot) ?? null;
  }

  private fighterVehicleSnapshot(fighter: FighterRuntime): FighterAiVehicleSnapshot {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(fighter.flight.orientation);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(fighter.flight.orientation);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(fighter.flight.orientation);
    const speed = fighter.flight.velocity.length();
    const phase = fighter.destroyed
      ? 'destroyed'
      : fighter.pilot === null && speed < 2.5
        ? 'parked'
        : fighter.flight.landingReady
          ? 'landing'
          : fighter.flight.position.y < fighter.pad.position.y + 10
            ? 'launching'
            : 'airborne';
    return {
      id: fighter.id,
      teamId: null,
      available: !fighter.destroyed && fighter.pilot === null,
      destroyed: fighter.destroyed,
      phase,
      position: fighter.flight.position,
      velocity: fighter.flight.velocity,
      forward,
      right,
      up,
      pilotId: fighter.pilot,
      reservedBy: fighter.reservedBy,
      hull: fighter.hull,
      maxHull: FIGHTER_HULL_MAX,
      primaryReady: fighter.primaryCooldown <= 0,
      secondaryReady: fighter.missileCooldown <= 0,
      secondaryAmmo: fighter.destroyed ? 0 : 4,
      homePadId: fighter.pad.id,
    };
  }

  private updateBotFighterAi(bot: Bot, delta: number): { groundTarget: THREE.Vector3 | null; piloting: boolean } {
    const controller = this.fighterAi.get(bot.id);
    if (!controller || this.fighters.length === 0) return { groundTarget: null, piloting: false };
    const currentFighter = this.fighterForPilot(bot.id);
    const vehicles = this.fighters.map((fighter) => this.fighterVehicleSnapshot(fighter));
    const targets = [
      {
        id: 'player',
        teamId: 'player',
        alive: this.mode === 'running' && this.health > 0,
        targetable: this.mode === 'running' && this.health > 0,
        sensorVisible: bot.group.position.distanceToSquared(this.playerPosition) <= 190 * 190,
        airborne: Boolean(this.playerFighter) || !this.grounded,
        threat: this.playerFighter ? 1 : 0.72,
        radius: this.playerFighter ? 2.4 : 0.75,
        position: this.playerPosition,
        velocity: this.playerVelocity,
      },
      ...this.bots.filter((targetBot) => targetBot.id !== bot.id).map((targetBot) => ({
        id: targetBot.id,
        teamId: targetBot.id,
        alive: targetBot.alive,
        targetable: targetBot.alive,
        sensorVisible: bot.group.position.distanceToSquared(targetBot.group.position) <= 190 * 190,
        airborne: Boolean(this.fighterForPilot(targetBot.id)) || !targetBot.grounded,
        threat: this.fighterForPilot(targetBot.id) ? 0.92 : 0.58,
        radius: this.fighterForPilot(targetBot.id) ? 2.4 : 0.75,
        position: targetBot.group.position,
        velocity: targetBot.velocity,
      })),
    ];
    const threats = this.projectiles
      .filter((projectile) => projectile.owner !== bot.id)
      .slice(0, 8)
      .map((projectile, index) => {
        const distance = projectile.root.position.distanceTo(bot.group.position);
        return {
          id: `${projectile.weapon}-${index}`,
          sensorVisible: distance <= 85,
          position: projectile.root.position,
          velocity: projectile.velocity,
          timeToImpact: distance / Math.max(1, projectile.velocity.length()),
          severity: projectile.weapon === 'rocket' ? 1 : projectile.weapon === 'plasma' ? 0.62 : 0.42,
        };
      });
    const pads = this.fighters.map((fighter) => {
      const padForward = new THREE.Vector3(-Math.sin(fighter.pad.yaw), 0, -Math.cos(fighter.pad.yaw));
      return {
        id: fighter.pad.id,
        teamId: null,
        enabled: true,
        occupiedBy: fighter.destroyed ? null : fighter.id,
        position: fighter.pad.position,
        approachPosition: fighter.pad.position.clone().addScaledVector(padForward, 14).add(new THREE.Vector3(0, 12, 0)),
      };
    });
    const intent = controller.update({
      deltaSeconds: delta,
      actor: {
        id: bot.id,
        teamId: bot.id,
        alive: bot.alive,
        canUseFighters: true,
        position: bot.group.position,
        velocity: bot.velocity,
        currentVehicleId: currentFighter?.id ?? null,
      },
      vehicles,
      targets,
      incomingThreats: threats,
      pads,
      context: {
        allowFighterUse: true,
        fighterDemand: 0.88,
        patrolCenter: { x: 0, y: 72, z: 24 },
        patrolRadius: 58,
        patrolAltitude: 30,
      },
      world: {
        terrainHeightAt: (x, z) => this.arena.floorHeightAt(x, z, 180) ?? 0,
        hasLineOfSight: (fromX, fromY, fromZ, toX, toY, toZ) => this.arena.hasLineOfSight(
          new THREE.Vector3(fromX, fromY, fromZ),
          new THREE.Vector3(toX, toY, toZ),
          0.5,
        ),
        isFlightPathClear: (fromX, fromY, fromZ, toX, toY, toZ) => !this.arena.segmentHitDetails(
          new THREE.Vector3(fromX, fromY, fromZ),
          new THREE.Vector3(toX, toY, toZ),
        ),
      },
    });
    const groundTarget = this.applyBotFighterIntent(bot, intent);
    return { groundTarget, piloting: Boolean(this.fighterForPilot(bot.id)) };
  }

  private applyBotFighterIntent(bot: Bot, intent: FighterAiIntent): THREE.Vector3 | null {
    if (intent.releaseVehicleId !== null) {
      const fighter = this.fighters.find((candidate) => candidate.id === intent.releaseVehicleId);
      if (fighter?.reservedBy === bot.id) {
        fighter.reservedBy = null;
        fighter.reservationSeconds = 0;
      }
    }
    if (intent.claimVehicleId !== null) {
      const fighter = this.fighters.find((candidate) => candidate.id === intent.claimVehicleId);
      if (fighter && !fighter.destroyed && fighter.pilot === null
        && (fighter.reservedBy === null || fighter.reservedBy === bot.id)) {
        fighter.reservedBy = bot.id;
        fighter.reservationSeconds = Math.max(0.25, intent.claimLeaseSeconds);
      }
    }
    if (intent.enterVehicleId !== null) {
      const fighter = this.fighters.find((candidate) => candidate.id === intent.enterVehicleId);
      if (fighter && !fighter.destroyed && fighter.pilot === null && fighter.reservedBy === bot.id
        && fighter.flight.position.distanceToSquared(bot.group.position) <= FIGHTER_BOARD_RANGE ** 2) {
        fighter.pilot = bot.id;
        fighter.reservedBy = null;
        fighter.reservationSeconds = 0;
        bot.group.visible = false;
        this.hud.message(`${bot.displayName} LAUNCHED A STAR SPARROW`);
      }
    }

    const fighter = this.fighterForPilot(bot.id);
    if (fighter) {
      fighter.intent.throttle = intent.throttle * (1 - intent.brake);
      fighter.intent.strafe = 0;
      fighter.intent.lift = intent.state === 'launch' ? 0.82 : intent.landingGear ? -0.34 : 0;
      fighter.intent.pitch = intent.pitch;
      fighter.intent.yaw = intent.yaw;
      fighter.intent.roll = intent.roll;
      fighter.intent.afterburner = intent.boost && intent.throttle > 0.5;
      fighter.intent.boost = intent.boost;
      const aimPoint = intent.hasAimPoint
        ? new THREE.Vector3(intent.aimX, intent.aimY, intent.aimZ)
        : undefined;
      if (intent.firePrimary) this.fireFighterWeapon(fighter, false, aimPoint);
      if (intent.fireSecondary) this.fireFighterWeapon(fighter, true, aimPoint);
      if (intent.dockAtPadId !== null
        && intent.dockAtPadId === fighter.pad.id
        && fighter.flight.position.distanceToSquared(fighter.pad.position) <= 4.5 ** 2) {
        const orientation = this.fighterQuaternionScratch.setFromEuler(new THREE.Euler(0, fighter.pad.yaw, 0));
        resetFighterFlightState(fighter.flight, fighter.pad.position, orientation);
      }
      if (intent.exitVehicle) {
        fighter.pilot = null;
        bot.group.visible = true;
        bot.group.position.copy(fighter.pad.position).add(new THREE.Vector3(
          fighter.pad.position.x > 0 ? -10 : 10,
          0.2,
          0,
        ));
        bot.velocity.set(0, 0, 0);
      }
      return null;
    }

    if (intent.groundSprint || Math.abs(intent.groundMoveX) + Math.abs(intent.groundMoveZ) > 0.01) {
      return new THREE.Vector3(intent.groundTargetX, intent.groundTargetY, intent.groundTargetZ);
    }
    return null;
  }

  private updateBots(delta: number): void {
    for (const bot of this.bots) {
      if (bot.readyToRespawn()) {
        bot.respawn(this.selectSafeSpawn(bot.id));
      }
      if (!bot.alive) {
        this.updateBotFighterAi(bot, delta);
        bot.update(delta, this.elapsed, bot.group.position, bot.velocity, this.arena.corePosition, false);
        continue;
      }
      const fighterAi = this.updateBotFighterAi(bot, delta);
      const pilotedFighter = this.fighterForPilot(bot.id);
      if (pilotedFighter || fighterAi.piloting) {
        const activeFighter = pilotedFighter ?? this.fighterForPilot(bot.id);
        if (activeFighter) {
          bot.group.position.copy(activeFighter.flight.position);
          bot.velocity.copy(activeFighter.flight.velocity);
          bot.group.visible = false;
        }
        continue;
      }
      bot.group.visible = true;
      if (bot.consumeRecoveryRequest()) {
        bot.respawn(this.selectSafeSpawn(bot.id, bot.navigationTarget));
        bot.collisionRecoveries += 1;
      }

      const botEye = bot.group.position.clone().add(new THREE.Vector3(0, 1.5, 0));
      const droneTarget = this.droneSwarm.nearestVisibleDrone(botEye, 105);
      // A movement-locked combatant is an explicitly staged test/capture actor.
      // Preserve its assigned target instead of allowing nearby ambient bots to
      // steal aggro from the sightline being exercised.
      const lockedTarget = bot.movementLocked ? bot.targetOwner : null;
      const targetOwner = droneTarget ? null : lockedTarget ?? this.chooseBotTarget(bot);
      bot.targetOwner = targetOwner;
      if (droneTarget) {
        this.botDroneTargets.set(bot.id, droneTarget.id);
        this.botTargets.delete(bot.id);
      } else {
        this.botDroneTargets.delete(bot.id);
        if (targetOwner !== null) this.botTargets.set(bot.id, targetOwner);
        else this.botTargets.delete(bot.id);
      }
      const target = droneTarget?.position
        ?? (targetOwner === null ? this.arena.corePosition : this.ownerPosition(targetOwner, 1.05));
      const targetVelocity = droneTarget?.velocity
        ?? (targetOwner === null ? new THREE.Vector3() : this.ownerVelocity(targetOwner));
      const visibilityRange = 155 * this.weatherSnapshot.multipliers.visibilityMultiplier;
      const canSeeTarget = (targetOwner !== null || droneTarget !== null)
        && botEye.distanceToSquared(target) <= visibilityRange * visibilityRange
        && this.arena.hasLineOfSight(botEye, target, 0.3);
      const objective = fighterAi.groundTarget ?? this.chooseBotObjective(bot, target, canSeeTarget);
      bot.update(delta, this.elapsed, target, targetVelocity, objective, canSeeTarget);
      this.resolveCharacterAgainstFighters(bot.group.position, bot.velocity, 0.43, 1.82);
      if (bot.wantsToThrowGrenade && targetOwner !== null) this.botThrowGrenade(bot, targetOwner);
      if (bot.wantsToFire && droneTarget) this.botFireDrone(bot, droneTarget);
      else if (bot.wantsToFire && targetOwner !== null) this.botFire(bot, targetOwner);
    }
  }

  private updateDrones(delta: number): void {
    const playerTarget = this.droneTargetSnapshots[0];
    playerTarget.position.copy(this.playerPosition);
    playerTarget.position.y += 0.95;
    playerTarget.velocity.copy(this.playerVelocity);
    playerTarget.alive = this.mode === 'running' && this.health > 0 && !this.playerFighter;
    for (let index = 0; index < this.bots.length; index += 1) {
      const bot = this.bots[index];
      const target = this.droneTargetSnapshots[index + 1];
      target.position.copy(bot.group.position);
      target.position.y += 1.05;
      target.velocity.copy(bot.velocity);
      target.alive = bot.alive && !this.fighterForPilot(bot.id);
    }
    this.droneSwarm.update(
      delta,
      this.elapsed,
      this.droneTargetSnapshots,
      (event) => this.resolveDroneLaser(event),
      (event) => this.resolveBusterShard(event),
    );
    for (const drone of this.droneSwarm.drones) {
      this.audio.setDroneBeamActive(drone.id, drone.beamActive, drone.position);
    }
  }

  private resolveDroneLaser(event: DroneLaserEvent): void {
    if (event.started) this.audio.weaponWorld('laser', event.origin, event.droneId, 0.22);
    if (event.targetOwner === 'player') {
      if (!this.playerFighter) this.damagePlayer(event.damage, 'drone', 'HOSTILE DRONE LASER', event.origin);
      return;
    }
    const bot = this.bots[event.targetOwner];
    if (bot?.alive && !this.fighterForPilot(bot.id)) {
      this.applyDamageToBot(bot, event.damage, 'drone', 'HOSTILE DRONE LASER');
    }
  }

  private resolveBusterShard(event: BusterShardEvent): void {
    this.weaponVfx.beam(event.origin, event.hitPoint, 'plasma', 0xff163f, 0.095);
    this.weaponVfx.impact(event.hitPoint, 0xff163f, 'plasma');
    this.spawnBurst(event.hitPoint, event.worldImpact ? 0xff2748 : 0xff8ba2, event.worldImpact ? 4 : 7);
    this.audio.projectileImpact('plasma', event.hitPoint, this.rng() - 0.5);
    if (event.targetOwner === null) return;
    if (event.targetOwner === 'player') {
      if (!this.playerFighter) {
        this.damagePlayer(event.damage, 'drone', 'BUSTER RED SHARD', event.origin);
      }
      return;
    }
    const bot = this.bots[event.targetOwner];
    if (bot?.alive && !this.fighterForPilot(bot.id)) {
      this.applyDamageToBot(bot, event.damage, 'drone', 'BUSTER RED SHARD');
    }
  }

  private botFireDrone(bot: Bot, intendedTarget: CombatDroneRuntime): void {
    if (!intendedTarget.alive) return;
    const origin = bot.group.position.clone().add(new THREE.Vector3(0, 1.5, 0));
    if (!this.arena.hasLineOfSight(origin, intendedTarget.position, 0.3)) return;
    const definition = this.weapon(bot.weapon);
    if (bot.weapon === 'rocket' || bot.weapon === 'plasma' || bot.weapon === 'disc') {
      this.spawnProjectile(origin, bot.aimDirection, bot.id, definition);
      this.audio.weaponWorld(bot.weapon, origin, `bot-${bot.id}`, (bot.id - 1) * 0.2);
      return;
    }
    const range = definition.range ?? (bot.weapon === 'shotgun' ? 34 : 110);
    const bulletEnd = origin.clone().addScaledVector(bot.aimDirection, range);
    const worldHit = this.arena.segmentHit(origin, bulletEnd);
    const worldDistance = worldHit ? origin.distanceTo(worldHit) : range;
    const droneHit = this.droneSwarm.raycast(origin, bot.aimDirection, worldDistance);
    const visibleEnd = droneHit?.point ?? worldHit ?? bulletEnd;
    const visualWeapon = bot.weapon === 'laser' || bot.weapon === 'rail' || bot.weapon === 'sniper' ? bot.weapon : 'machine';
    this.weaponVfx.beam(
      origin,
      visibleEnd,
      visualWeapon,
      definition.color,
      bot.weapon === 'rail' ? 0.13 : bot.weapon === 'sniper' ? 0.14 : 0.065,
    );
    if (droneHit) {
      let damage = definition.damage;
      if (bot.weapon === 'shotgun') {
        const falloff = THREE.MathUtils.clamp(1 - Math.max(0, droneHit.distance - 5) / 30, 0.12, 1);
        damage *= Math.max(2, Math.round((definition.pellets ?? 10) * falloff * 0.62));
      }
      if (bot.damageBoost > 0) damage *= 1.35;
      this.applyDamageToDrone(droneHit.drone, damage, bot.id, definition.name);
    }
    this.audio.tracerPass(origin.clone().lerp(visibleEnd, 0.55), !droneHit, (bot.id - 1) * 0.2, `bot-${bot.id}`);
    this.audio.weaponWorld(bot.weapon, origin, `bot-${bot.id}`, (bot.id - 1) * 0.2);
  }

  private botFire(bot: Bot, targetOwner: Owner): void {
    if (!this.ownerAlive(targetOwner) || targetOwner === bot.id) return;
    const origin = bot.group.position.clone().add(new THREE.Vector3(0, 1.5, 0));
    const target = this.ownerPosition(targetOwner, 0.95);
    // Fire-time LOS closes the reaction/update race: neither hitscan nor a
    // projectile may be emitted once the target has moved behind BSP/patch cover.
    if (!this.arena.hasLineOfSight(origin, target)) return;
    if (bot.weapon === 'rocket' || bot.weapon === 'plasma' || bot.weapon === 'disc') {
      const definition = this.weapon(bot.weapon);
      this.spawnProjectile(origin, bot.aimDirection, bot.id, definition);
      this.audio.weaponWorld(bot.weapon, origin, `bot-${bot.id}`, (bot.id - 1) * 0.2);
      return;
    }
    const definition = this.weapon(bot.weapon);
    const range = definition.range ?? (bot.weapon === 'shotgun' ? 34 : 110);
    const bulletEnd = origin.clone().addScaledVector(bot.aimDirection, range);
    const worldHit = this.arena.segmentHit(origin, bulletEnd);
    const visibleEnd = worldHit ?? bulletEnd;
    const visualWeapon = bot.weapon === 'laser' || bot.weapon === 'rail' || bot.weapon === 'sniper' ? bot.weapon : 'machine';
    const worldDistance = worldHit ? origin.distanceTo(worldHit) : range;
    const targetHitPoint = this.rayOwnerCapsuleHit(origin, bot.aimDirection, targetOwner, worldDistance, bot.weapon);
    this.weaponVfx.beam(
      origin,
      targetHitPoint ?? visibleEnd,
      visualWeapon,
      definition.color,
      bot.weapon === 'rail' ? 0.13 : bot.weapon === 'sniper' ? 0.14 : 0.065,
    );
    let targetHit = targetHitPoint !== null;
    if (targetHitPoint) {
      const along = targetHitPoint.distanceTo(origin);
      targetHit = true;
      let damage = definition.damage;
      if (bot.weapon === 'shotgun') {
        const falloff = THREE.MathUtils.clamp(1 - Math.max(0, along - 5) / 30, 0.12, 1);
        const pelletHits = Math.max(2, Math.round((definition.pellets ?? 10) * falloff * 0.62));
        damage *= pelletHits;
      }
      if (bot.damageBoost > 0) damage *= 1.35;
      this.applyDamageToOwner(targetOwner, damage, bot.id, definition.name, origin);
    }
    const tracerPosition = origin.clone().lerp(visibleEnd, 0.55);
    this.audio.tracerPass(tracerPosition, !targetHit, (bot.id - 1) * 0.2, `bot-${bot.id}`);
    this.audio.weaponWorld(bot.weapon, origin, `bot-${bot.id}`, (bot.id - 1) * 0.2);
  }

  private botThrowGrenade(bot: Bot, targetOwner: Owner): void {
    const origin = bot.group.position.clone().add(new THREE.Vector3(0, 1.5, 0));
    const target = this.ownerPosition(targetOwner, 0.9);
    const direction = target.sub(origin).normalize();
    const root = this.weaponVfx.createGrenade(0xff607d);
    root.position.copy(origin);
    this.scene.add(root);
    const velocity = direction.multiplyScalar(GRENADE.throwSpeed * 0.92).addScaledVector(bot.velocity, 0.18);
    velocity.y += GRENADE.upwardImpulse * 0.9;
    this.grenades.push({ root, velocity, owner: bot.id, fuse: GRENADE.fuse, trailDistance: 0, bounces: 0 });
    this.audio.weaponWorld('rocket', origin, `bot-${bot.id}-grenade`, (bot.id - 1) * 0.16);
  }

  private chooseBotTarget(bot: Bot): Owner | null {
    const candidates: Owner[] = ['player', ...this.bots.filter((candidate) => candidate.id !== bot.id).map((candidate) => candidate.id)];
    const eye = bot.group.position.clone().add(new THREE.Vector3(0, 1.5, 0));
    let best: { owner: Owner; score: number } | null = null;
    for (const owner of candidates) {
      if (!this.ownerAlive(owner)) continue;
      const target = this.ownerPosition(owner, 1.05);
      const distance = eye.distanceTo(target);
      const visibilityRange = 155 * this.weatherSnapshot.multipliers.visibilityMultiplier;
      const visible = distance <= visibilityRange && this.arena.hasLineOfSight(eye, target, 0.3);
      const threatScore = owner === 'player' ? this.score : this.bots[owner]?.score ?? 0;
      const pressureBias = bot.getObjectiveUtility('player');
      const score = distance
        - (visible ? 52 * pressureBias : 0)
        - threatScore * 2.2 * bot.archetypeTuning.aggression
        + (this.botTargets.get(bot.id) === owner ? -9 : 0);
      if (!best || score < best.score) best = { owner, score };
    }
    return best?.owner ?? null;
  }

  private chooseBotObjective(bot: Bot, target: THREE.Vector3, targetVisible: boolean): THREE.Vector3 {
    const playerPressure = bot.getObjectiveUtility('player');
    const corePressure = bot.getObjectiveUtility('core');
    const chaseRange = 62 * THREE.MathUtils.clamp(playerPressure / Math.max(0.45, corePressure), 0.7, 1.3);
    if (targetVisible && bot.group.position.distanceToSquared(target) < chaseRange * chaseRange) return target;
    if (this.coreActive && (corePressure >= playerPressure || !targetVisible)) return this.arena.corePosition;

    let bestPickup: { point: THREE.Vector3; score: number } | null = null;
    for (const pickup of this.pickups) {
      if (!pickup.active) continue;
      let utility = 8;
      if (pickup.kind === 'health') {
        if (bot.health >= 95) continue;
        utility = bot.health < 45 ? 58 : 28;
      } else if (pickup.kind === 'armor') {
        if (bot.armor >= 95) continue;
        utility = bot.armor < 35 ? 52 : 25;
      }
      else if (pickup.kind === 'damage' || pickup.kind === 'speed') utility = 38;
      else if (pickup.kind === 'rail' || pickup.kind === 'rocket' || pickup.kind === 'sniper' || pickup.kind === 'disc') utility = 32;
      else utility = 22;
      utility *= 0.55 + bot.getPickupUtility(pickup.kind);
      const score = bot.group.position.distanceTo(pickup.group.position) - utility;
      if (!bestPickup || score < bestPickup.score) bestPickup = { point: pickup.group.position, score };
    }
    if (bestPickup && bestPickup.score < 132) return bestPickup.point;
    const routePoints = [...this.arena.spawnPoints, ...Object.values(this.arena.itemPoints), this.arena.corePosition];
    const phase = Math.floor((this.elapsed + bot.id * 3.1) / 8.5);
    return routePoints[(bot.id * 5 + phase * 3) % routePoints.length];
  }

  private ownerAlive(owner: Owner): boolean {
    return owner === 'player' ? this.mode === 'running' && this.health > 0 : Boolean(this.bots[owner]?.alive);
  }

  private ownerPosition(owner: Owner, centerY = 0.9): THREE.Vector3 {
    return owner === 'player'
      ? this.playerPosition.clone().add(new THREE.Vector3(0, centerY, 0))
      : this.bots[owner].group.position.clone().add(new THREE.Vector3(0, centerY, 0));
  }

  private ownerVelocity(owner: Owner): THREE.Vector3 {
    return owner === 'player' ? this.playerVelocity.clone() : this.bots[owner].velocity.clone();
  }

  private rayOwnerCapsuleHit(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    owner: Owner,
    maxDistance: number,
    weapon: WeaponId,
  ): THREE.Vector3 | null {
    const occupiedFighter = this.fighterForPilot(owner);
    if (occupiedFighter) {
      const ray = new THREE.Ray(origin, direction);
      return ray.intersectSphere(
        new THREE.Sphere(occupiedFighter.flight.position, Math.max(1.8, occupiedFighter.visual.radius * 0.68)),
        new THREE.Vector3(),
      );
    }
    const feet = this.ownerPosition(owner, 0);
    const capsuleStart = feet.clone().add(new THREE.Vector3(0, 0.28, 0));
    const capsuleEnd = feet.add(new THREE.Vector3(0, 1.52, 0));
    const pointOnRay = new THREE.Vector3();
    const pointOnCapsule = new THREE.Vector3();
    const ray = new THREE.Ray(origin, direction);
    const distanceSq = ray.distanceSqToSegment(capsuleStart, capsuleEnd, pointOnRay, pointOnCapsule);
    const radius = weapon === 'shotgun' ? 1.58
      : weapon === 'machine' ? 0.58
        : weapon === 'laser' ? 0.5
          : weapon === 'sniper' ? 0.5
            : 0.46;
    const along = pointOnRay.distanceTo(origin);
    if (distanceSq > radius * radius || along <= 0 || along > maxDistance + 0.02) return null;
    return pointOnRay;
  }

  private applyDamageToOwner(owner: Owner, damage: number, attacker: Owner, cause: string, hitOrigin?: THREE.Vector3): void {
    const occupiedFighter = this.fighterForPilot(owner);
    if (occupiedFighter) this.damageFighter(occupiedFighter, damage, attacker, cause.toUpperCase());
    else if (owner === 'player') this.damagePlayer(damage, attacker, cause.toUpperCase(), hitOrigin);
    else this.applyDamageToBot(this.bots[owner], damage, attacker, cause);
  }

  private damageFirstFighterOnRay(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number,
    damage: number,
    owner: Owner,
    cause: string,
  ): FighterRuntime | null {
    const ray = new THREE.Ray(origin, direction);
    let best: FighterRuntime | null = null;
    let bestDistance = maxDistance;
    const hitPoint = new THREE.Vector3();
    for (const fighter of this.fighters) {
      if (fighter.destroyed || fighter.pilot === owner) continue;
      const radius = Math.max(1.8, fighter.visual.radius * 0.68);
      const hit = ray.intersectSphere(new THREE.Sphere(fighter.flight.position, radius), hitPoint);
      if (!hit) continue;
      const distance = origin.distanceTo(hit);
      if (distance >= bestDistance) continue;
      best = fighter;
      bestDistance = distance;
    }
    if (best) this.damageFighter(best, damage, owner, cause);
    return best;
  }

  private selectSafeSpawn(excludedBotId?: number, recoveryObjective?: THREE.Vector3): THREE.Vector3 {
    const opponents = [
      ...(this.mode === 'running' || this.mode === 'respawning' ? [this.playerPosition] : []),
      ...this.bots.filter((bot) => bot.alive && bot.id !== excludedBotId).map((bot) => bot.group.position),
    ];
    let best: { point: THREE.Vector3; score: number; index: number } | null = null;
    for (let index = 0; index < this.arena.spawnPoints.length; index += 1) {
      const authored = this.arena.spawnPoints[index];
      const point = this.arena.safeSpawnPoint(authored);
      if (!point) continue;
      const minDistance = opponents.length ? Math.min(...opponents.map((opponent) => point.distanceTo(opponent))) : 100;
      const eye = point.clone().add(new THREE.Vector3(0, 1.05, 0));
      const exposed = opponents.filter((opponent) => this.arena.hasLineOfSight(eye, opponent.clone().add(new THREE.Vector3(0, 1, 0)))).length;
      const recentPenalty = this.recentSpawnIndices.includes(index) ? 24 : 0;
      const separation = Math.min(minDistance, recoveryObjective ? 72 : 105);
      const objectiveBias = recoveryObjective
        ? -point.distanceTo(recoveryObjective) * 0.72
        : -point.distanceTo(this.arena.corePosition) * 0.035;
      const score = separation * (recoveryObjective ? 0.38 : 1) + objectiveBias - exposed * 18 - recentPenalty;
      if (!best || score > best.score) best = { point, score, index };
    }
    if (!best) {
      const fallbackIndex = this.spawnIndex++ % this.arena.spawnPoints.length;
      const fallback = this.arena.spawnPoints[fallbackIndex].clone();
      const floor = this.arena.floorHeightAt(fallback.x, fallback.z, Number.POSITIVE_INFINITY);
      if (floor !== null) fallback.y = floor;
      return fallback;
    }
    this.recentSpawnIndices.push(best.index);
    if (this.recentSpawnIndices.length > 5) this.recentSpawnIndices.shift();
    return best.point;
  }

  private tryFirePlayerWeapon(): void {
    if (this.mode !== 'running') return;
    const definition = WEAPONS[this.selectedWeapon];
    if (definition.id === 'laser') {
      this.fireContinuousLaserTick(MOVEMENT.fixedStep, true);
      return;
    }
    const ammo = this.ammo.get(definition.id) ?? 0;
    if (this.weaponCooldown > 0) return;
    if (ammo === 0) {
      this.weaponCooldown = 0.25;
      this.audio.dryFire(definition.id);
      return;
    }
    const focusedMachine = definition.id === 'machine' && this.input.isAltFireHeld();
    this.weaponCooldown = definition.cooldown * (focusedMachine ? 0.84 : 1);
    this.recoil = Math.min(1, this.recoil + definition.recoil);
    this.trauma = Math.min(1, this.trauma + definition.trauma);
    this.ammo.set(definition.id, Math.max(0, ammo - 1));

    const origin = this.weaponMuzzleWorldPosition();
    // Long hitscan weapons must converge at their effective range. A fixed
    // 120 m convergence point makes the long sniper barrel diverge from the
    // reticle again before its 165 m endpoint.
    const aimRange = definition.projectileSpeed ? 120 : definition.range ?? 120;
    const direction = this.shotDirectionFromMuzzle(origin, aimRange);
    this.recordPlayerShot(definition.id, origin);
    this.weaponVfx.muzzle(definition.id, definition.color, this.playerMuzzleVfxSocket(origin, direction));
    if (definition.projectileSpeed) {
      this.spawnProjectile(origin, direction, 'player', definition);
    } else if (definition.pellets) {
      const hits = new Map<Bot, number>();
      const spreadRight = direction.clone().cross(new THREE.Vector3(0, 1, 0)).normalize();
      if (spreadRight.lengthSq() < 0.01) spreadRight.set(1, 0, 0);
      const spreadUp = spreadRight.clone().cross(direction).normalize();
      this.lastPelletCount = definition.pellets;
      this.lastPelletSpread = 0;
      for (let pellet = 0; pellet < definition.pellets; pellet += 1) {
        const normalizedRadius = pellet === 0 ? 0 : Math.sqrt((pellet + 0.35) / definition.pellets);
        const angle = pellet * 2.399963 + (this.rng() - 0.5) * 0.16;
        const radius = normalizedRadius * (definition.spread ?? 0.09);
        const pelletDirection = direction.clone()
          .addScaledVector(spreadRight, Math.cos(angle) * radius)
          .addScaledVector(spreadUp, Math.sin(angle) * radius)
          .normalize();
        this.lastPelletSpread = Math.max(this.lastPelletSpread, Math.acos(THREE.MathUtils.clamp(direction.dot(pelletDirection), -1, 1)));
        const trace = this.traceBotShot(origin, pelletDirection, definition.falloffEnd ?? 30, false);
        this.damageFirstFighterOnRay(
          origin,
          pelletDirection,
          origin.distanceTo(trace.combatEnd),
          definition.damage * 0.72 * this.damageMultiplier(),
          'player',
          definition.name,
        );
        if (trace.firstTarget === 'drone' && trace.drone) {
          const falloff = 1 - THREE.MathUtils.smoothstep(
            trace.drone.distance,
            definition.falloffStart ?? 5,
            definition.falloffEnd ?? 30,
          ) * 0.58;
          this.applyDamageToDrone(
            trace.drone.drone,
            definition.damage * falloff * this.damageMultiplier(),
            'player',
            definition.name,
          );
        } else if (trace.first) {
          const distance = trace.first.t;
          const falloff = 1 - THREE.MathUtils.smoothstep(distance, definition.falloffStart ?? 5, definition.falloffEnd ?? 30) * 0.58;
          const locationMultiplier = trace.first.zone === 'head' ? 1.25 : 1;
          hits.set(trace.first.bot, (hits.get(trace.first.bot) ?? 0) + definition.damage * falloff * locationMultiplier);
        }
        const pelletEnd = trace.combatEnd;
        this.weaponVfx.beam(origin, pelletEnd, definition.id, definition.color, 0.055 + pellet * 0.0015);
        if (trace.firstTarget === null && trace.worldHit) {
          this.weaponVfx.mark(trace.worldHit, trace.worldNormal ?? new THREE.Vector3(0, 1, 0), definition.id, definition.color);
          if (pellet % 3 === 0) this.weaponVfx.impact(trace.worldHit, definition.color, definition.id, trace.worldNormal ?? undefined);
          if (pellet % 3 === 0) this.registerConcreteTraceImpact(trace, definition.damage * 2.4);
        }
      }
      for (const [bot, damage] of hits) this.applyDamageToBot(bot, damage * this.damageMultiplier(), 'player', definition.name);
    } else {
      const range = definition.range ?? 120;
      const piercing = definition.id === 'rail';
      const hitscanDirection = definition.id === 'machine'
        ? this.spreadDirection(
          direction,
          (definition.spread ?? 0) * (focusedMachine ? 0.18 : 1) * (1 + Math.min(2, this.playerVelocity.length() / 24)),
        )
        : direction;
      const trace = this.traceBotShot(origin, hitscanDirection, range, piercing, definition.damage * this.damageMultiplier(), definition.name, definition.id);
      this.damageFirstFighterOnRay(
        origin,
        hitscanDirection,
        origin.distanceTo(piercing ? trace.end : trace.combatEnd),
        definition.damage * this.damageMultiplier(),
        'player',
        definition.name,
      );
      const end = piercing ? trace.end : trace.combatEnd;
      this.weaponVfx.beam(
        origin,
        end,
        definition.id,
        definition.color,
        definition.id === 'rail' ? 0.2 : definition.id === 'sniper' ? 0.15 : 0.085,
      );
      if (trace.firstTarget === null && trace.worldHit) {
        this.weaponVfx.mark(trace.worldHit, trace.worldNormal ?? new THREE.Vector3(0, 1, 0), definition.id, definition.color);
        this.weaponVfx.impact(trace.worldHit, definition.color, definition.id, trace.worldNormal ?? undefined);
        this.registerConcreteTraceImpact(trace, definition.damage);
      }
      if (trace.firstTarget === 'bot' && trace.first && definition.id === 'machine') {
        this.weaponVfx.stickTracer(trace.first.bot.group, trace.first.point, hitscanDirection, definition.color);
      }
    }
    this.applyWeaponRecoil(definition);
    this.audio.weaponPlayer(definition.id, this.rng() - 0.5);
  }

  private fireContinuousLaserTick(delta: number, forced = false): void {
    const definition = this.weapon('laser');
    const ammo = this.ammo.get('laser') ?? 0;
    const focused = this.input.isAltFireHeld();
    const ammoCost = focused ? 2 : 1;
    if ((!forced && !this.input.isFireHeld()) || ammo < ammoCost || this.laserHeat >= 1) {
      this.weaponVfx.stopContinuousLaser();
      this.audio.setLaserBeamActive(false);
      if ((ammo < ammoCost || this.laserHeat >= 1) && this.weaponCooldown <= 0) {
        this.weaponCooldown = 0.25;
        this.audio.dryFire('laser');
      }
      return;
    }

    const wasActive = this.weaponVfx.continuousLaserActive;
    const origin = this.weaponMuzzleWorldPosition();
    const range = definition.range ?? 54;
    const direction = this.shotDirectionFromMuzzle(origin, range);
    const trace = this.traceBotShot(origin, direction, range, false);
    const botHit = trace.first;
    const botVisible = trace.firstTarget === 'bot' && botHit !== null;
    const droneVisible = trace.firstTarget === 'drone' && trace.drone !== null;
    const end = trace.combatEnd;
    this.audio.setLaserBeamActive(true);
    this.weaponVfx.updateContinuousLaser(origin, end, definition.color, delta);
    this.recordPlayerShot('laser', origin);
    this.laserHeat = Math.min(1.1, this.laserHeat + delta * (focused ? 1.08 : 0.7));

    if (!wasActive) this.weaponVfx.muzzle('laser', definition.color, this.playerMuzzleVfxSocket(origin, direction));
    if (this.weaponCooldown > 0) return;

    this.weaponCooldown = definition.cooldown * (focused ? 1.35 : 1);
    this.ammo.set('laser', Math.max(0, ammo - ammoCost));
    this.recoil = Math.min(0.34, this.recoil + definition.recoil);
    this.trauma = Math.min(0.22, this.trauma + definition.trauma);
    this.damageFirstFighterOnRay(
      origin,
      direction,
      origin.distanceTo(trace.combatEnd),
      definition.damage * (focused ? 1.8 : 1) * this.damageMultiplier(),
      'player',
      focused ? 'HELIX CUTTING FOCUS' : definition.name,
    );
    if (botVisible && botHit) {
      this.applyDamageToBot(
        botHit.bot,
        definition.damage * (focused ? 1.8 : 1) * this.damageMultiplier(),
        'player',
        focused ? 'HELIX CUTTING FOCUS' : definition.name,
      );
    } else if (droneVisible && trace.drone) {
      this.applyDamageToDrone(
        trace.drone.drone,
        definition.damage * (focused ? 1.8 : 1) * this.damageMultiplier(),
        'player',
        focused ? 'HELIX CUTTING FOCUS' : definition.name,
      );
    } else if (trace.worldHit) {
      this.weaponVfx.mark(trace.worldHit, trace.worldNormal ?? new THREE.Vector3(0, 1, 0), 'laser', definition.color);
      this.weaponVfx.impact(trace.worldHit, definition.color, 'laser', trace.worldNormal ?? undefined);
      this.registerConcreteTraceImpact(trace, definition.damage * (focused ? 1.6 : 0.72));
    }
    this.applyWeaponRecoil(definition);
  }

  private trySecondaryFire(): void {
    if (this.mode !== 'running') return;
    const definition = WEAPONS[this.selectedWeapon];
    if (definition.id === 'machine' || definition.id === 'laser' || definition.id === 'sniper') return;
    if (this.weaponCooldown > 0) return;

    const ammo = this.ammo.get(definition.id) ?? 0;
    const cost = definition.id === 'disc' ? 1
      : definition.id === 'shotgun' || definition.id === 'rail' ? 2
      : definition.id === 'rocket' ? 3
        : 5;
    if (ammo < cost) {
      this.weaponCooldown = 0.25;
      this.audio.dryFire(definition.id);
      return;
    }

    this.ammo.set(definition.id, ammo - cost);
    const origin = this.weaponMuzzleWorldPosition();
    const direction = this.shotDirectionFromMuzzle(origin, 220);
    this.recordPlayerShot(definition.id, origin);
    this.weaponVfx.muzzle(definition.id, definition.color, this.playerMuzzleVfxSocket(origin, direction));

    if (definition.id === 'shotgun') {
      this.weaponCooldown = 1.15;
      const trace = this.traceBotShot(
        origin,
        direction,
        95,
        false,
        92 * this.damageMultiplier(),
        'SCATTER SABOT',
        'shotgun',
      );
      const end = trace.combatEnd;
      this.weaponVfx.beam(origin, end, 'shotgun', 0xffe2a6, 0.16);
      if (trace.firstTarget === null && trace.worldHit) {
        this.weaponVfx.mark(trace.worldHit, trace.worldNormal ?? new THREE.Vector3(0, 1, 0), 'shotgun', 0xffe2a6);
        this.weaponVfx.impact(trace.worldHit, 0xffe2a6, 'shotgun', trace.worldNormal ?? undefined);
        this.registerConcreteTraceImpact(trace, 110);
      }
    } else if (definition.id === 'rocket') {
      this.weaponCooldown = 1.4;
      const right = direction.clone().cross(new THREE.Vector3(0, 1, 0)).normalize();
      const salvoDefinition: WeaponDefinition = { ...definition, damage: 68, splash: 4.3, projectileSpeed: 34 };
      for (const offset of [-0.045, 0, 0.045]) {
        this.spawnProjectile(origin, direction.clone().addScaledVector(right, offset).normalize(), 'player', salvoDefinition);
      }
    } else if (definition.id === 'plasma') {
      this.weaponCooldown = 1.05;
      const orbDefinition: WeaponDefinition = { ...definition, damage: 58, splash: 4.1, projectileSpeed: 22 };
      this.spawnProjectile(origin, direction, 'player', orbDefinition);
    } else if (definition.id === 'rail') {
      this.weaponCooldown = 2.25;
      const trace = this.traceBotShot(
        origin,
        direction,
        220,
        true,
        175 * this.damageMultiplier(),
        'APEX OVERCHARGE',
        'rail',
      );
      this.weaponVfx.beam(origin, trace.end, 'rail', 0xffffff, 0.34);
      if (trace.firstTarget === null && trace.worldHit) {
        this.weaponVfx.mark(trace.worldHit, trace.worldNormal ?? new THREE.Vector3(0, 1, 0), 'rail', definition.color);
        this.weaponVfx.impact(trace.worldHit, definition.color, 'rail', trace.worldNormal ?? undefined);
        this.registerConcreteTraceImpact(trace, 175);
      }
    } else if (definition.id === 'disc') {
      this.weaponCooldown = 1.12;
      const overdriveDefinition: WeaponDefinition = {
        ...definition,
        damage: 68,
        projectileSpeed: 92,
      };
      this.spawnProjectile(origin, direction, 'player', overdriveDefinition, {
        maxBounces: 8,
        restitution: 0.94,
        ownerSafeTime: 0.32,
        angularVelocity: 68,
        life: 8,
      });
    }

    this.recoil = Math.min(1, this.recoil + Math.max(0.45, definition.recoil));
    this.trauma = Math.min(1, this.trauma + Math.max(0.12, definition.trauma));
    this.fovPunch = Math.max(this.fovPunch, definition.id === 'rail' ? 7 : 4.5);
    this.applyWeaponRecoil(definition);
    this.audio.weaponPlayer(definition.id, this.rng() - 0.5);
    this.hud.message(`${definition.secondary.toUpperCase()} DEPLOYED`);
  }

  private applyWeaponRecoil(definition: WeaponDefinition): void {
    // Apply the kick after resolving the shot, so recoil affects follow-up aim
    // without pulling the projectile that caused it away from the reticle.
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + definition.recoil * 0.012,
      -1.28,
      1.22,
    );
  }

  private weaponMuzzleWorldPosition(): THREE.Vector3 {
    if (this.isThirdPerson()) {
      if (this.thirdPersonWeaponVisual) {
        this.updateThirdPersonWeaponPose(this.viewDirection(new THREE.Vector3()));
        this.thirdPersonWeaponVisual.muzzleSocket.updateWorldMatrix(true, false);
        return this.thirdPersonWeaponVisual.muzzleSocket.getWorldPosition(new THREE.Vector3());
      }
      // Asset-load fallback: preserve a plausible shouldered origin if the
      // cached world weapon is unavailable. Normal play uses its real socket.
      const forward = this.thirdPersonMuzzleForwardScratch
        .set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = this.thirdPersonMuzzleRightScratch
        .set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      return new THREE.Vector3().copy(this.playerPosition)
        .addScaledVector(forward, 0.72)
        .addScaledVector(right, 0.28)
        .add(new THREE.Vector3(0, 1.28, 0));
    }
    this.camera.position.copy(this.playerPosition).add(new THREE.Vector3(0, PLAYER_EYE, 0));
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    this.camera.updateMatrixWorld(true);
    this.muzzleSocket.updateWorldMatrix(true, false);
    return this.muzzleSocket.getWorldPosition(new THREE.Vector3());
  }

  private playerMuzzleVfxSocket(origin: THREE.Vector3, direction: THREE.Vector3): THREE.Object3D {
    if (!this.isThirdPerson()) return this.muzzleSocket;
    if (this.thirdPersonWeaponVisual) {
      this.thirdPersonWeaponVisual.muzzleSocket.updateWorldMatrix(true, false);
      return this.thirdPersonWeaponVisual.muzzleSocket;
    }
    this.thirdPersonMuzzleSocket.position.copy(origin);
    this.thirdPersonMuzzleSocket.quaternion.setFromUnitVectors(
      this.thirdPersonMuzzleForwardScratch.set(0, 0, -1),
      direction,
    );
    this.thirdPersonMuzzleSocket.updateMatrixWorld(true);
    return this.thirdPersonMuzzleSocket;
  }

  private shotDirectionFromMuzzle(origin: THREE.Vector3, range: number): THREE.Vector3 {
    const eye = this.playerPosition.clone().add(new THREE.Vector3(0, PLAYER_EYE, 0));
    const view = this.viewDirection();
    const cameraEnd = eye.clone().addScaledVector(view, range);
    // Arena hit results use retained vectors. Clone the hit point before
    // deriving a direction so a later arena query cannot overwrite a live
    // projectile/grenade velocity that was built from this return value.
    const aimPoint = this.arena.segmentHit(eye, cameraEnd)?.clone() ?? cameraEnd;
    const direction = aimPoint.sub(origin);
    return direction.lengthSq() > 1e-6 ? direction.normalize() : view;
  }

  private spreadDirection(direction: THREE.Vector3, spread: number): THREE.Vector3 {
    if (spread <= 0) return direction;
    const right = direction.clone().cross(new THREE.Vector3(0, 1, 0));
    if (right.lengthSq() < 1e-4) right.set(1, 0, 0);
    else right.normalize();
    const up = right.clone().cross(direction).normalize();
    const angle = this.rng() * Math.PI * 2;
    const radius = Math.sqrt(this.rng()) * spread;
    return direction.clone()
      .addScaledVector(right, Math.cos(angle) * radius)
      .addScaledVector(up, Math.sin(angle) * radius)
      .normalize();
  }

  private recordPlayerShot(weapon: WeaponId, origin: THREE.Vector3): void {
    this.playerShots += 1;
    this.lastShotWeapon = weapon;
    this.lastShotOrigin.copy(origin);
    this.lastMuzzlePosition.copy(origin);
  }

  private traceBotShot(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    range: number,
    piercing: boolean,
    damage = 0,
    weaponName = '',
    weaponId?: WeaponId,
  ): {
    first: { bot: Bot; point: THREE.Vector3; t: number; zone: 'body' | 'head' } | null;
    drone: DroneRayHit | null;
    firstTarget: 'bot' | 'drone' | null;
    worldHit: THREE.Vector3 | null;
    worldNormal: THREE.Vector3 | null;
    worldSurface: ArenaSurface | null;
    end: THREE.Vector3;
    combatEnd: THREE.Vector3;
  } {
    const rangeEnd = origin.clone().addScaledVector(direction, range);
    const surfaceHit = this.arena.segmentHitDetails(origin, rangeEnd);
    const worldHit = surfaceHit?.point ?? null;
    const worldDistance = surfaceHit?.distance ?? range;
    const ray = new THREE.Ray(origin, direction);
    const droneHit = this.droneSwarm.raycast(origin, direction, worldDistance);
    const hits: Array<{ bot: Bot; t: number; point: THREE.Vector3; zone: 'body' | 'head' }> = [];
    for (const bot of this.bots) {
      if (!bot.alive || this.fighterForPilot(bot.id)) continue;
      const bodyHit = ray.intersectSphere(
        new THREE.Sphere(bot.group.position.clone().add(new THREE.Vector3(0, 0.88, 0)), 0.66),
        new THREE.Vector3(),
      );
      const headHit = ray.intersectSphere(
        new THREE.Sphere(bot.group.position.clone().add(new THREE.Vector3(0, 1.55, 0)), 0.3),
        new THREE.Vector3(),
      );
      const bodyT = bodyHit ? bodyHit.distanceTo(origin) : Number.POSITIVE_INFINITY;
      const headT = headHit ? headHit.distanceTo(origin) : Number.POSITIVE_INFINITY;
      const t = Math.min(bodyT, headT);
      if (!Number.isFinite(t) || t <= 0 || t > worldDistance + 0.02) continue;
      const zone = headT <= bodyT ? 'head' : 'body';
      hits.push({ bot, t, point: zone === 'head' ? headHit! : bodyHit!, zone });
    }
    hits.sort((a, b) => a.t - b.t);
    const firstBot = hits[0] ?? null;
    const firstTarget = droneHit && (!firstBot || droneHit.distance < firstBot.t)
      ? 'drone'
      : firstBot
        ? 'bot'
        : null;
    if (damage > 0) {
      const targets = piercing ? hits : firstTarget === 'bot' ? hits.slice(0, 1) : [];
      for (const hit of targets) {
        const criticalMultiplier = hit.zone === 'head'
          ? weaponId === 'sniper' ? 1.75 : weaponId === 'rail' ? 1.35 : weaponId === 'machine' ? 1.25 : 1.15
          : 1;
        this.applyDamageToBot(hit.bot, damage * criticalMultiplier, 'player', weaponName);
      }
      if (droneHit && (piercing || firstTarget === 'drone')) {
        this.applyDamageToDrone(droneHit.drone, damage, 'player', weaponName);
      }
    }
    const end = worldHit ?? rangeEnd;
    const combatEnd = piercing
      ? end
      : firstTarget === 'drone' && droneHit
        ? droneHit.point
        : firstTarget === 'bot' && firstBot
          ? firstBot.point
          : end;
    return {
      first: piercing ? firstBot : firstTarget === 'bot' ? firstBot : null,
      drone: droneHit,
      firstTarget,
      worldHit,
      worldNormal: surfaceHit?.normal ?? null,
      worldSurface: surfaceHit?.surface ?? null,
      end,
      combatEnd,
    };
  }

  private registerConcreteTraceImpact(
    trace: {
      worldHit: THREE.Vector3 | null;
      worldNormal: THREE.Vector3 | null;
      worldSurface: ArenaSurface | null;
    },
    strength: number,
  ): void {
    if (trace.worldSurface !== 'concrete' || !trace.worldHit || !trace.worldNormal) return;
    this.arena.registerSurfaceImpact(trace.worldHit, trace.worldNormal, strength, this.elapsed);
  }

  private spawnProjectile(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    owner: Owner,
    definition: WeaponDefinition,
    options: ProjectileOptions = {},
  ): void {
    const projectileWeapon = definition.id === 'rocket' || definition.id === 'plasma' || definition.id === 'disc'
      ? definition.id
      : 'plasma';
    const root = this.weaponVfx.createProjectile(
      projectileWeapon,
      definition.color,
      owner !== 'player',
    );
    root.position.copy(origin);
    if (owner === 'player') this.lastProjectileOrigin.copy(root.position);
    this.weaponVfx.orientProjectile(root, direction, this.elapsed, definition.id);
    this.scene.add(root);
    this.projectiles.push({
      root,
      velocity: direction.clone().multiplyScalar(definition.projectileSpeed ?? 40),
      owner,
      weapon: definition.id,
      damage: definition.damage * (owner === 'player' ? this.damageMultiplier() : 1),
      splash: definition.splash ?? 0,
      life: options.life ?? (definition.id === 'disc' ? 6.5 : definition.id === 'rocket' ? 4 : 2.4),
      trailDistance: 0,
      bounces: 0,
      maxBounces: options.maxBounces ?? (definition.id === 'disc' ? 5 : 0),
      restitution: options.restitution ?? (definition.id === 'disc' ? 0.88 : 0),
      ownerSafeTime: options.ownerSafeTime ?? (definition.id === 'disc' ? 0.24 : Number.POSITIVE_INFINITY),
      angularVelocity: options.angularVelocity ?? (definition.id === 'disc' ? 54 : 0),
    });
  }

  private toggleGrapple(): void {
    if (this.grappleActive) {
      this.detachGrapple();
      this.hud.message('GRAPPLE RELEASED');
      return;
    }
    if (this.mode !== 'running') return;
    const eye = this.playerPosition.clone().add(new THREE.Vector3(0, PLAYER_EYE, 0));
    const direction = this.viewDirection();
    const hit = this.arena.segmentHitDetails(eye, eye.clone().addScaledVector(direction, GRAPPLE.maxLength));
    if (!hit || hit.distance < GRAPPLE.minLength) {
      this.hud.message('NO GRAPPLE SURFACE');
      return;
    }
    this.grappleActive = true;
    this.grappleAnchor.copy(hit.point).addScaledVector(hit.normal, 0.035);
    this.grappleLength = hit.distance;
    this.fovPunch = Math.max(this.fovPunch, 3.5);
    this.audio.weaponPlayer('plasma', this.rng() - 0.5);
    this.hud.message(`GRAPPLE ANCHORED · ${Math.round(hit.distance * 3.28)} FT`);
  }

  private detachGrapple(): void {
    this.grappleActive = false;
    this.grappleLength = 0;
    this.weaponVfx.clearGrapple();
  }

  private updateGrapple(delta: number): void {
    if (!this.grappleActive) return;
    const eye = this.playerPosition.clone().add(new THREE.Vector3(0, PLAYER_EYE, 0));
    const toAnchor = this.grappleAnchor.clone().sub(eye);
    const distance = toAnchor.length();
    if (distance < 0.7 || distance > GRAPPLE.maxLength * 1.35) {
      this.detachGrapple();
      return;
    }
    const ropeDirection = toAnchor.multiplyScalar(1 / distance);
    const radialSpeed = this.playerVelocity.dot(ropeDirection);
    // Project steering onto the rope tangent. This preserves lateral momentum
    // around the anchor while the tension term reels the player toward it.
    const tangentWish = this.wishDirection.clone().addScaledVector(
      ropeDirection,
      -this.wishDirection.dot(ropeDirection),
    );
    if (tangentWish.lengthSq() > 0.001) {
      this.playerVelocity.addScaledVector(tangentWish.normalize(), GRAPPLE.swingAcceleration * delta);
    }
    if (radialSpeed < 0) this.playerVelocity.addScaledVector(ropeDirection, -radialSpeed);
    const stretch = distance - this.grappleLength;
    const pullStrength = GRAPPLE.pullAcceleration * THREE.MathUtils.clamp(distance / Math.max(this.grappleLength, 0.1), 0.35, 1.35);
    this.playerVelocity.addScaledVector(ropeDirection, pullStrength * delta);
    if (stretch > 0) {
      this.playerPosition.addScaledVector(ropeDirection, Math.min(stretch, 0.28));
      const contact = this.arena.resolvePlayerCapsule(this.playerPosition, this.playerVelocity);
      this.grounded = contact.grounded;
      if (contact.grounded) this.terrainNormal.copy(contact.contactNormal);
      this.playerVelocity.addScaledVector(ropeDirection, Math.min(GRAPPLE.ropeTension * stretch, 18) * delta);
    }
    const speed = this.playerVelocity.length();
    if (speed > GRAPPLE.maxSpeed) this.playerVelocity.multiplyScalar(GRAPPLE.maxSpeed / speed);
  }

  private tryThrowGrenade(): void {
    if (this.mode !== 'running' || this.grenadeCooldown > 0 || this.grenadeAmmo <= 0) return;
    const origin = this.weaponMuzzleWorldPosition();
    const direction = this.shotDirectionFromMuzzle(origin, 24);
    const root = this.weaponVfx.createGrenade(0xffb84a);
    root.position.copy(origin);
    this.scene.add(root);
    const velocity = direction.multiplyScalar(GRENADE.throwSpeed).addScaledVector(this.playerVelocity, 0.28);
    velocity.y += GRENADE.upwardImpulse;
    this.grenades.push({ root, velocity, owner: 'player', fuse: GRENADE.fuse, trailDistance: 0, bounces: 0 });
    this.grenadeAmmo -= 1;
    this.grenadeCooldown = GRENADE.cooldown;
    this.fovPunch = Math.max(this.fovPunch, 2.2);
    this.audio.weaponPlayer('rocket', this.rng() - 0.5);
    this.hud.message(`GRENADE OUT · ${GRENADE.fuse.toFixed(1)}s FUSE`);
  }

  private updateGrenades(delta: number): void {
    for (let index = this.grenades.length - 1; index >= 0; index -= 1) {
      const grenade = this.grenades[index];
      grenade.fuse -= delta;
      grenade.velocity.x += this.weatherSnapshot.modifiers.wind.x * delta;
      grenade.velocity.z += this.weatherSnapshot.modifiers.wind.z * delta;
      const distance = grenade.velocity.length() * delta;
      grenade.trailDistance += distance;
      // Keep each advance shorter than the grenade radius, then sweep the
      // center and all six sphere extrema. A center-only ray can miss thin or
      // oblique map faces and leave the next substep starting behind them.
      const steps = Math.max(1, Math.ceil(distance / (GRENADE.radius * 0.72)));
      const step = delta / steps;
      for (let substep = 0; substep < steps; substep += 1) {
        grenade.velocity.y -= GRENADE.gravity * step;
        const previousPosition = grenade.root.position.clone();
        grenade.root.position.addScaledVector(grenade.velocity, step);
        const surfaceHit = this.sweepGrenadeAgainstArena(previousPosition, grenade.root.position);
        if (!surfaceHit) continue;
        const travelDistance = previousPosition.distanceTo(grenade.root.position);
        const hitFraction = travelDistance > 1e-7
          ? THREE.MathUtils.clamp(surfaceHit.distance / travelDistance, 0, 1)
          : 0;
        this.grenadeSweepCenter.lerpVectors(previousPosition, grenade.root.position, hitFraction);
        const separation = this.grenadeSweepSeparation
          .copy(this.grenadeSweepCenter)
          .sub(surfaceHit.point)
          .dot(surfaceHit.normal);
        grenade.root.position.copy(this.grenadeSweepCenter).addScaledVector(
          surfaceHit.normal,
          Math.max(0.004, GRENADE.radius + 0.004 - separation),
        );
        const impactSpeed = grenade.velocity.length();
        const normalSpeed = grenade.velocity.dot(surfaceHit.normal);
        if (normalSpeed < -2.5) {
          this.audio.surfaceImpact(
            surfaceHit.surface,
            surfaceHit.point,
            Math.min(1.25, Math.abs(normalSpeed) / 18),
          );
        }
        if (surfaceHit.surface === 'concrete' && normalSpeed < -7.5) {
          this.arena.registerSurfaceImpact(surfaceHit.point, surfaceHit.normal, Math.abs(normalSpeed) * 2.2, this.elapsed);
        }
        if (normalSpeed < 0) {
          grenade.velocity.addScaledVector(surfaceHit.normal, -normalSpeed * (1 + GRENADE.restitution));
          grenade.velocity.multiplyScalar(GRENADE.tangentialDamping);
          const reboundSpeed = grenade.velocity.length();
          if (reboundSpeed > impactSpeed && reboundSpeed > 1e-7) {
            grenade.velocity.multiplyScalar(impactSpeed / reboundSpeed);
          }
          grenade.bounces += 1;
          if (surfaceHit.normal.y > 0.55 && grenade.velocity.lengthSq() < 3.2) {
            grenade.velocity.y = 0;
            grenade.velocity.x *= 0.82;
            grenade.velocity.z *= 0.82;
          }
        }
      }
      this.weaponVfx.orientGrenade(grenade.root, grenade.velocity, this.elapsed);
      if (grenade.fuse <= 0) {
        this.explodeGrenade(index);
      }
    }
  }

  private sweepGrenadeAgainstArena(start: THREE.Vector3, end: THREE.Vector3): SurfaceHit | null {
    let bestDistance = Number.POSITIVE_INFINITY;
    let found = false;
    for (const offset of this.grenadeSweepOffsets) {
      this.grenadeSweepStart.copy(start).add(offset);
      this.grenadeSweepEnd.copy(end).add(offset);
      const hit = this.arena.segmentHitDetails(this.grenadeSweepStart, this.grenadeSweepEnd);
      if (!hit || hit.distance >= bestDistance) continue;
      found = true;
      bestDistance = hit.distance;
      this.grenadeSweepResult.point.copy(hit.point);
      this.grenadeSweepResult.normal.copy(hit.normal).normalize();
      this.grenadeSweepResult.distance = hit.distance;
      this.grenadeSweepResult.surface = hit.surface;
    }
    return found ? this.grenadeSweepResult : null;
  }

  private explodeGrenade(index: number): void {
    const grenade = this.grenades[index];
    if (!grenade) return;
    const position = grenade.root.position.clone();
    const color = 0xffb84a;
    this.weaponVfx.grenadeExplosion(position, color);
    this.audio.projectileImpact('rocket', position, this.rng() - 0.5);
    for (const bot of this.bots) {
      if (!bot.alive || grenade.owner === bot.id) continue;
      const target = bot.group.position.clone().add(new THREE.Vector3(0, 1.1, 0));
      const distance = target.distanceTo(position);
      if (distance >= GRENADE.splash || !this.explosionHasLineOfSight(position, target)) continue;
      const falloff = THREE.MathUtils.clamp(1 - distance / GRENADE.splash, 0, 1);
      this.applyDamageToBot(bot, GRENADE.damage * (falloff * 0.3 + falloff * falloff * 0.7), grenade.owner, 'FRAG GRENADE');
      const impulse = target.sub(position).normalize().multiplyScalar(falloff * 7.5);
      bot.velocity.add(impulse);
      bot.velocity.y = Math.max(bot.velocity.y, impulse.y + 2.2);
    }
    for (const drone of this.droneSwarm.combatDrones) {
      if (!drone.alive) continue;
      const distance = drone.position.distanceTo(position);
      if (distance >= GRENADE.splash || !this.explosionHasLineOfSight(position, drone.position)) continue;
      const falloff = THREE.MathUtils.clamp(1 - distance / GRENADE.splash, 0, 1);
      this.applyDamageToDrone(
        drone,
        GRENADE.damage * (falloff * 0.3 + falloff * falloff * 0.7),
        grenade.owner,
        'FRAG GRENADE',
      );
    }
    const playerCenter = this.playerPosition.clone().add(new THREE.Vector3(0, 0.9, 0));
    const playerDistance = playerCenter.distanceTo(position);
    if (this.mode === 'running' && playerDistance < GRENADE.splash && this.explosionHasLineOfSight(position, playerCenter)) {
      const falloff = THREE.MathUtils.clamp(1 - playerDistance / GRENADE.splash, 0, 1);
      const damageScale = grenade.owner === 'player' ? 0.34 : 0.78;
      const damage = GRENADE.damage * damageScale * (falloff * 0.3 + falloff * falloff * 0.7);
      if (damage > 1) this.damagePlayer(damage, grenade.owner, 'FRAG GRENADE SPLASH', position);
      const impulse = playerCenter.clone().sub(position).normalize().multiplyScalar(falloff * 6.2);
      this.playerVelocity.add(impulse);
      this.playerVelocity.y = Math.max(this.playerVelocity.y, impulse.y + 2.4);
      this.grounded = false;
    }
    this.trauma = Math.min(1, this.trauma + Math.max(0, 0.48 - playerDistance * 0.06));
    this.removeGrenade(index);
  }

  private updateProjectiles(delta: number): void {
    for (let index = this.projectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.projectiles[index];
      projectile.life -= delta;
      projectile.ownerSafeTime = Math.max(0, projectile.ownerSafeTime - delta);
      projectile.velocity.x += this.weatherSnapshot.modifiers.wind.x * delta;
      projectile.velocity.z += this.weatherSnapshot.modifiers.wind.z * delta;
      const distance = projectile.velocity.length() * delta;
      projectile.trailDistance += distance;
      const steps = Math.max(1, Math.ceil(distance / 0.24));
      const step = delta / steps;
      let remove = projectile.life <= 0;
      for (let substep = 0; substep < steps && !remove; substep += 1) {
        const previousPosition = projectile.root.position.clone();
        projectile.root.position.addScaledVector(projectile.velocity, step);
        const surfaceHit = this.arena.segmentHitDetails(previousPosition, projectile.root.position);
        if (surfaceHit) {
          projectile.root.position.copy(surfaceHit.point);
          if (surfaceHit.surface === 'concrete') {
            this.arena.registerSurfaceImpact(
              surfaceHit.point,
              surfaceHit.normal,
              projectile.weapon === 'rocket' ? 92 : projectile.weapon === 'disc' ? 58 : 42,
              this.elapsed,
            );
          }
          if (projectile.weapon === 'disc') {
            // BSP triangle winding can expose either side of a thin surface.
            // Always orient the contact normal against the incoming disc, then
            // separate along both that normal and the reflected travel vector.
            // The latter prevents a very fast disc from immediately re-hitting
            // the same coplanar face and consuming its bounce budget in one tick.
            const impactNormal = surfaceHit.normal.clone();
            if (projectile.velocity.dot(impactNormal) > 0) impactNormal.negate();
            this.discBounceCount += 1;
            this.lastDiscBouncePosition.copy(surfaceHit.point);
            projectile.bounces += 1;
            // Saw Sling ricochets use physical motion and positional audio as
            // feedback; additive ring/spark VFX were removed for clarity and
            // to keep multi-bounce volleys cheap.
            this.audio.projectileImpact('disc', surfaceHit.point, this.rng() - 0.5);
            this.audio.surfaceImpact(surfaceHit.surface, surfaceHit.point, 0.72);
            if (projectile.bounces >= projectile.maxBounces || projectile.velocity.lengthSq() < 18 * 18) {
              remove = true;
              break;
            }
            projectile.velocity.reflect(impactNormal).multiplyScalar(projectile.restitution);
            projectile.root.position
              .addScaledVector(impactNormal, 0.08)
              .addScaledVector(projectile.velocity.clone().normalize(), 0.035);
            projectile.angularVelocity *= -1;
            continue;
          }
          this.explodeProjectile(projectile, undefined, false, true, surfaceHit.normal, surfaceHit.surface);
          remove = true;
          break;
        }
        const droneHit = this.droneSwarm.raycastSegment(
          previousPosition,
          projectile.root.position,
          projectile.weapon === 'rocket' ? 0.18 : 0.08,
        );
        if (droneHit) {
          projectile.root.position.copy(droneHit.point);
          this.applyDamageToDrone(
            droneHit.drone,
            projectile.damage,
            projectile.owner,
            this.weapon(projectile.weapon).name,
          );
          if (projectile.splash > 0 || projectile.weapon === 'disc') {
            this.explodeProjectile(
              projectile,
              undefined,
              false,
              false,
              undefined,
              undefined,
              undefined,
              droneHit.drone,
            );
          } else {
            this.weaponVfx.impact(projectile.root.position, this.weapon(projectile.weapon).color, projectile.weapon);
            if (projectile.weapon === 'rocket' || projectile.weapon === 'plasma') {
              this.audio.projectileImpact(projectile.weapon, projectile.root.position, this.rng() - 0.5);
            }
          }
          remove = true;
          break;
        }
        for (const fighter of this.fighters) {
          if (fighter.destroyed || fighter.pilot === projectile.owner) continue;
          const hitRadius = Math.max(1.4, fighter.visual.radius * 0.72);
          if (projectile.root.position.distanceToSquared(fighter.flight.position) >= hitRadius * hitRadius) continue;
          this.damageFighter(
            fighter,
            projectile.damage,
            projectile.owner,
            this.weapon(projectile.weapon).name,
          );
          if (projectile.splash > 0 || projectile.weapon === 'disc') {
            this.explodeProjectile(projectile, undefined, false, false, undefined, undefined, fighter);
          } else {
            this.weaponVfx.impact(projectile.root.position, this.weapon(projectile.weapon).color, projectile.weapon);
            if (projectile.weapon === 'rocket' || projectile.weapon === 'plasma') {
              this.audio.projectileImpact(projectile.weapon, projectile.root.position, this.rng() - 0.5);
            }
          }
          remove = true;
          break;
        }
        if (remove) break;
        for (const bot of this.bots) {
          if (!bot.alive || this.fighters.some((fighter) => fighter.pilot === bot.id)
            || (projectile.owner === bot.id && (projectile.weapon !== 'disc' || projectile.ownerSafeTime > 0))) continue;
          const botCenter = bot.group.position.clone().add(new THREE.Vector3(0, 0.9, 0));
          if (projectile.root.position.distanceTo(botCenter) >= 0.88) continue;
          this.applyDamageToBot(bot, projectile.damage, projectile.owner, this.weapon(projectile.weapon).name);
          if (projectile.weapon === 'rocket') {
            const impulse = projectile.velocity.clone().normalize().multiplyScalar(6.8);
            bot.velocity.add(impulse);
            bot.velocity.y = Math.max(bot.velocity.y, 4.1);
          }
          if (projectile.splash > 0 || projectile.weapon === 'disc') this.explodeProjectile(projectile, bot);
          else if (projectile.weapon === 'plasma') {
            this.weaponVfx.impact(projectile.root.position, this.weapon('plasma').color, 'plasma');
            this.audio.projectileImpact('plasma', projectile.root.position, this.rng() - 0.5);
          }
          remove = true;
          break;
        }
        if (!remove && !this.playerFighter
          && (projectile.owner !== 'player' || (projectile.weapon === 'disc' && projectile.ownerSafeTime <= 0)) && this.mode === 'running'
          && projectile.root.position.distanceTo(this.playerPosition.clone().add(new THREE.Vector3(0, 0.9, 0))) < 0.9) {
          const impactSource = projectile.root.position.clone().addScaledVector(projectile.velocity.clone().normalize(), -1.5);
          this.damagePlayer(
            projectile.damage * (projectile.owner === 'player' ? 0.42 : 1),
            projectile.owner,
            this.weapon(projectile.weapon).name,
            impactSource,
          );
          if (projectile.weapon === 'rocket') {
            this.playerVelocity.addScaledVector(projectile.velocity.clone().normalize(), 6.4);
            this.playerVelocity.y = Math.max(this.playerVelocity.y, 4.2);
            this.grounded = false;
          }
          if (projectile.splash > 0 || projectile.weapon === 'disc') this.explodeProjectile(projectile, undefined, true);
          else if (projectile.weapon === 'plasma') {
            this.weaponVfx.impact(projectile.root.position, this.weapon('plasma').color, 'plasma');
            this.audio.projectileImpact('plasma', projectile.root.position, this.rng() - 0.5);
          }
          remove = true;
        }
      }
      if (!remove) {
        const trailSpacing = projectile.weapon === 'rocket' ? 0.32 : projectile.weapon === 'disc' ? 0.5 : 0.24;
        if (projectile.weapon !== 'disc' && projectile.trailDistance >= trailSpacing) {
          projectile.trailDistance %= trailSpacing;
            this.weaponVfx.projectileTrail(
              projectile.root.position,
              projectile.weapon === 'rocket' ? 'rocket' : 'plasma',
              this.weapon(projectile.weapon).color,
            );
        }
        this.weaponVfx.orientProjectile(projectile.root, projectile.velocity, this.elapsed, projectile.weapon);
        if (projectile.weapon === 'disc') {
          const rotor = (projectile.root.userData.vfxParts as { rotor?: THREE.Object3D } | undefined)?.rotor
            ?? projectile.root.getObjectByName('disc-projectile-rotor');
          if (rotor) rotor.rotation.z += projectile.angularVelocity * delta;
        }
      }
      if (remove) this.removeProjectile(index);
    }
  }

  private explodeProjectile(
    projectile: Projectile,
    directlyHit?: Bot,
    directlyHitPlayer = false,
    worldImpact = false,
    surfaceNormal?: THREE.Vector3,
    surface?: 'grass' | 'soil' | 'rock' | 'metal' | 'concrete' | 'water',
    directlyHitFighter?: FighterRuntime,
    directlyHitDrone?: CombatDroneRuntime,
  ): void {
    const position = projectile.root.position.clone();
    const color = this.weapon(projectile.weapon).color;
    if (projectile.weapon === 'rocket') this.weaponVfx.rocketExplosion(position, color);
    else this.weaponVfx.impact(position, color, projectile.weapon, surfaceNormal);
    if (worldImpact) this.weaponVfx.mark(position, surfaceNormal ?? new THREE.Vector3(0, 1, 0), projectile.weapon, color);
    this.spawnBurst(position, color, projectile.weapon === 'rocket' ? 24 : 7);
    if (projectile.weapon === 'rocket' || projectile.weapon === 'plasma' || projectile.weapon === 'disc') {
      this.audio.projectileImpact(projectile.weapon, position, this.rng() - 0.5);
      if (worldImpact && surface) {
        this.audio.surfaceImpact(surface, position, projectile.weapon === 'rocket' ? 1.2 : 0.8);
      }
    }
    if (projectile.splash <= 0) return;
    for (const bot of this.bots) {
      if (!bot.alive || this.fighters.some((fighter) => fighter.pilot === bot.id)
        || bot === directlyHit || projectile.owner === bot.id) continue;
      const target = bot.group.position.clone().add(new THREE.Vector3(0, 1.1, 0));
      const distance = target.distanceTo(position);
      if (distance < projectile.splash && this.explosionHasLineOfSight(position, target)) {
        const falloff = 1 - distance / projectile.splash;
        const damage = projectile.damage * 0.78 * (falloff * 0.3 + falloff * falloff * 0.7);
        this.applyDamageToBot(bot, damage, projectile.owner, this.weapon(projectile.weapon).name);
        if (projectile.weapon === 'rocket') {
          const impulse = target.sub(position).normalize().multiplyScalar((1 - distance / projectile.splash) * 9.5);
          bot.velocity.add(impulse);
          bot.velocity.y = Math.max(bot.velocity.y, impulse.y + 3.4);
        }
      }
    }
    for (const fighter of this.fighters) {
      if (fighter.destroyed || fighter === directlyHitFighter || fighter.pilot === projectile.owner) continue;
      const distance = fighter.flight.position.distanceTo(position);
      if (distance >= projectile.splash || !this.explosionHasLineOfSight(position, fighter.flight.position)) continue;
      const falloff = 1 - distance / projectile.splash;
      this.damageFighter(
        fighter,
        projectile.damage * 0.78 * (falloff * 0.3 + falloff * falloff * 0.7),
        projectile.owner,
        `${this.weapon(projectile.weapon).name} SPLASH`,
      );
    }
    for (const drone of this.droneSwarm.combatDrones) {
      if (!drone.alive || drone === directlyHitDrone || drone.position.distanceToSquared(position) >= projectile.splash * projectile.splash) continue;
      const distance = drone.position.distanceTo(position);
      if (!this.explosionHasLineOfSight(position, drone.position)) continue;
      const falloff = 1 - distance / projectile.splash;
      this.applyDamageToDrone(
        drone,
        projectile.damage * 0.78 * (falloff * 0.3 + falloff * falloff * 0.7),
        projectile.owner,
        `${this.weapon(projectile.weapon).name} SPLASH`,
      );
    }
    const playerCenter = this.playerPosition.clone().add(new THREE.Vector3(0, 0.9, 0));
    const playerDistance = playerCenter.distanceTo(position);
    if (!this.playerFighter && !directlyHitPlayer && playerDistance < projectile.splash && this.mode === 'running' && this.explosionHasLineOfSight(position, playerCenter)) {
      const selfRocketJump = projectile.owner === 'player' && projectile.weapon === 'rocket';
      if (!selfRocketJump) {
        const selfScale = projectile.owner === 'player' ? 0.55 : 0.78;
        const falloff = 1 - playerDistance / projectile.splash;
        const damage = projectile.damage * selfScale * (falloff * 0.3 + falloff * falloff * 0.7);
        if (damage > 1) this.damagePlayer(damage, projectile.owner, `${this.weapon(projectile.weapon).name.toUpperCase()} SPLASH`, position);
        if (projectile.owner !== 'player' && projectile.weapon === 'rocket') {
          const impulse = playerCenter.clone().sub(position).normalize().multiplyScalar(falloff * 7.8);
          this.playerVelocity.add(impulse);
          this.playerVelocity.y = Math.max(this.playerVelocity.y, impulse.y + 3.2);
          this.grounded = false;
        }
      }
      if (selfRocketJump) {
        this.applyRocketJump(position, playerDistance);
      }
    }
    this.trauma = Math.min(1, this.trauma + Math.max(0, 0.55 - playerDistance * 0.06));
  }

  private applyRocketJump(explosionPosition: THREE.Vector3, playerDistance: number): void {
    const falloff = THREE.MathUtils.clamp(1 - playerDistance / MOVEMENT.rocketJumpRadius, 0, 1);
    const playerCenter = this.playerPosition.clone().add(new THREE.Vector3(0, 0.9, 0));
    const away = playerCenter.sub(explosionPosition);
    const awayHorizontal = new THREE.Vector3(away.x, 0, away.z);
    if (awayHorizontal.lengthSq() > 1e-4) awayHorizontal.normalize();

    const momentum = new THREE.Vector3(this.playerVelocity.x, 0, this.playerVelocity.z);
    if (momentum.lengthSq() > 0.25) momentum.normalize();
    else momentum.copy(this.forward).setY(0).normalize();

    // A rocket fired at the player's feet is a deliberate movement tool: the
    // blast supplies lift, pushes away from the impact, and adds a little speed
    // in the current travel direction so the jump is easy to chain.
    this.playerVelocity.addScaledVector(
      awayHorizontal,
      MOVEMENT.rocketJumpHorizontalImpulse * (0.45 + falloff * 0.55),
    );
    this.playerVelocity.addScaledVector(momentum, MOVEMENT.rocketJumpMomentumBoost * (0.65 + falloff * 0.35));
    this.playerVelocity.y = Math.max(
      this.playerVelocity.y,
      THREE.MathUtils.lerp(MOVEMENT.rocketJumpMinVerticalImpulse, MOVEMENT.rocketJumpMaxVerticalImpulse, falloff),
    );
    this.grounded = false;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.rocketJumpCount += 1;
    this.fovPunch = Math.max(this.fovPunch, 8);
    this.trauma = Math.min(1, this.trauma + 0.24);
    this.audio.jump();
    this.hud.message('ROCKET BOOST');
  }

  private explosionHasLineOfSight(origin: THREE.Vector3, target: THREE.Vector3): boolean {
    const direction = target.clone().sub(origin);
    if (direction.lengthSq() < 1e-6) return true;
    direction.normalize();
    return this.arena.hasLineOfSight(origin.clone().addScaledVector(direction, 0.08), target, 0.2);
  }

  private applyDamageToDrone(
    drone: CombatDroneRuntime,
    damage: number,
    owner: Owner,
    weaponName: string,
  ): boolean {
    const result = this.droneSwarm.damage(drone, damage);
    if (!result.applied) return false;
    this.spawnBurst(result.position, result.destroyed ? 0xffb33c : 0xff3155, result.destroyed ? 28 : 4);
    if (owner === 'player') {
      this.playerHits += 1;
      this.hud.hitMarker(result.destroyed);
      this.audio.hit(result.destroyed ? 1.4 : 0.75);
    }
    if (!result.destroyed) return false;
    this.weaponVfx.vehicleExplosion(
      result.position,
      drone.kind === 'buster' ? 0xff2148 : 0xff7a31,
      drone.kind === 'buster' ? DRONE_DESTRUCTION_VFX_SCALE * 1.45 : DRONE_DESTRUCTION_VFX_SCALE,
    );
    this.audio.projectileImpact('rocket', result.position, this.rng() - 0.5);
    this.fovPunch = Math.max(this.fovPunch, 3.5);
    this.trauma = Math.min(1, this.trauma + 0.22);
    if (owner === 'player') {
      this.score += 1;
      this.hud.message(`HOSTILE ${drone.id.toUpperCase()} DESTROYED · ${weaponName.toUpperCase()}`);
    } else {
      const bot = this.bots[owner];
      if (bot) {
        bot.score += 1;
        this.hud.message(`${bot.displayName} DESTROYED ${drone.id.toUpperCase()} · ${weaponName.toUpperCase()}`);
      }
    }
    return true;
  }

  private applyDamageToBot(bot: Bot, damage: number, owner: DamageSource, weaponName: string): void {
    const coreDenial = this.coreActive && this.coreOwner === bot.id && this.coreProgress >= 0.25;
    const eliminationDistance = this.playerPosition.distanceTo(bot.group.position);
    const eliminationSpeed = Math.hypot(this.playerVelocity.x, this.playerVelocity.z);
    const killed = bot.takeDamage(damage);
    if (owner === 'player') {
      this.playerHits += 1;
      this.hud.hitMarker(killed);
      this.audio.hit(killed ? 1.4 : 0.8);
    }
    this.spawnBurst(bot.group.position.clone().add(new THREE.Vector3(0, 1.2, 0)), killed ? 0xffffff : 0xff4f75, killed ? 11 : 4);
    if (!killed) {
      this.audio.grunt(bot.group.position, Math.min(1.35, damage / 34), `bot-${bot.id}`);
    }
    if (!killed) return;
    if (owner === 'player') {
      this.score += 1;
      if (!this.grounded) this.airborneKills += 1;
      this.awardEliminationStyle({
        airborne: !this.grounded || !bot.grounded,
        coreDenial,
        distance: eliminationDistance,
        grappled: this.grappleActive,
        speed: eliminationSpeed,
      });
      this.hud.message(`YOU FRAGGED ${bot.displayName} · ${weaponName.toUpperCase()}`);
    } else if (typeof owner === 'number') {
      const shooter = this.bots[owner];
      if (shooter) {
        shooter.score += 1;
        this.hud.message(`${shooter.displayName} FRAGGED ${bot.displayName} · ${weaponName.toUpperCase()}`);
      }
    } else {
      this.hud.message(`HOSTILE DRONE FRAGGED ${bot.displayName} · LASER`);
    }
    this.fovPunch = Math.max(this.fovPunch, 4);
    this.trauma = Math.min(1, this.trauma + 0.3);
  }

  private awardEliminationStyle(context: {
    airborne: boolean;
    coreDenial: boolean;
    distance: number;
    grappled: boolean;
    speed: number;
  }): void {
    let event: StyleEvent | null = null;
    if (context.coreDenial) event = { type: 'core-denial' };
    else if (context.grappled) event = { type: 'grapple-elimination' };
    else if (context.airborne) event = { type: 'air-frag' };
    else if (context.speed >= 24) event = { type: 'high-speed-elimination', speedMetersPerSecond: context.speed };
    else if (context.distance >= 35) event = { type: 'long-range-elimination', distanceMeters: context.distance };

    const results = event ? [this.styleSystem.register(event)] : [];
    this.recentPlayerKills.push(this.elapsed);
    while (this.recentPlayerKills.length > 0 && this.elapsed - this.recentPlayerKills[0] > 5) {
      this.recentPlayerKills.shift();
    }
    if (this.recentPlayerKills.length >= 2) {
      results.push(this.styleSystem.register({ type: 'multikill', killCount: this.recentPlayerKills.length }));
    }
    const awarded = results.filter((result) => result.accepted).at(-1);
    if (awarded?.medal) {
      this.hud.message(`${awarded.medal.label} · +${Math.round(awarded.styleGain)} STYLE`);
    }
  }

  private damagePlayer(amount: number, owner: DamageSource, cause: string, hitOrigin?: THREE.Vector3): void {
    if (this.mode !== 'running') return;
    const armored = this.armor > 0;
    const absorbed = Math.min(this.armor, amount * 0.66);
    this.armor -= absorbed;
    this.health -= amount - absorbed;
    const damageRead = this.resolveDamageDirection(owner, hitOrigin);
    this.lastDamageDirection = damageRead.label;
    this.lastDamageBearing = damageRead.bearing;
    this.hud.damage(damageRead.label, damageRead.bearing, Math.min(1, amount / 70));
    this.audio.damage(armored);
    this.audio.grunt(undefined, Math.min(1.35, amount / 42), 'player');
    this.trauma = Math.min(1, this.trauma + Math.min(0.55, amount * 0.009));
    if (this.health <= 0) {
      this.health = 0;
      this.deaths += 1;
      this.mode = 'respawning';
      this.respawnTimer = 1.6;
      this.respawnCause = cause;
      if (owner === 'player') this.score = Math.max(-5, this.score - 1);
      else if (typeof owner === 'number') this.bots[owner].score += 1;
      this.audio.death();
      this.hud.message(owner === 'player'
        ? `SELF-DESTRUCT · ${cause}`
        : owner === 'drone'
          ? `HOSTILE DRONE FRAGGED YOU · ${cause}`
          : `${this.bots[owner].displayName} FRAGGED YOU · ${cause}`);
    }
  }

  private resolveDamageDirection(owner: DamageSource, hitOrigin?: THREE.Vector3): { label: string; bearing: number } {
    if (owner === 'player') return { label: 'self', bearing: 0 };
    const source = hitOrigin ?? (typeof owner === 'number' ? this.bots[owner]?.group.position : undefined);
    if (!source) return { label: 'front', bearing: 0 };
    const incoming = source.clone().sub(this.playerPosition).setY(0);
    if (incoming.lengthSq() < 0.001) return { label: 'front', bearing: 0 };
    incoming.normalize();
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const forwardDot = incoming.dot(forward);
    const rightDot = incoming.dot(right);
    const bearing = Math.atan2(rightDot, forwardDot);
    if (Math.abs(rightDot) > Math.abs(forwardDot)) return { label: rightDot > 0 ? 'right' : 'left', bearing };
    return { label: forwardDot > 0 ? 'front' : 'back', bearing };
  }

  private updatePickups(delta: number): void {
    for (const pickup of this.pickups) {
      if (!pickup.active) {
        pickup.cooldown -= delta;
        if (pickup.cooldown <= 0) {
          pickup.active = true;
          pickup.group.visible = true;
        }
        continue;
      }
      const pickupDx = pickup.group.position.x - this.playerPosition.x;
      const pickupDy = pickup.group.position.y - (this.playerPosition.y + 0.8);
      const pickupDz = pickup.group.position.z - this.playerPosition.z;
      if (pickupDx * pickupDx + pickupDy * pickupDy + pickupDz * pickupDz <= 1.75 * 1.75) {
        this.collectPickup(pickup);
        continue;
      }
      const bot = this.bots.find((candidate) => candidate.alive && candidate.group.position.distanceTo(pickup.group.position) <= 1.55);
      if (bot) this.collectBotPickup(pickup, bot);
    }
  }

  private collectPickup(pickup: PickupState): void {
    switch (pickup.kind) {
      case 'health':
        this.health = Math.min(125, this.health + 50);
        break;
      case 'armor':
        this.armor = Math.min(150, this.armor + 100);
        break;
      case 'damage':
        this.damageBoost = POWERUP.duration;
        break;
      case 'speed':
        this.speedBoost = POWERUP.duration;
        break;
      case 'rail':
        this.ammo.set('rail', 3);
        break;
      default: {
        const definition = this.weapon(pickup.kind);
        this.ammo.set(pickup.kind, Math.min(definition.ammo, (this.ammo.get(pickup.kind) ?? 0) + Math.ceil(definition.ammo * 0.45)));
      }
    }
    pickup.active = false;
    pickup.group.visible = false;
    pickup.cooldown = pickup.respawn;
    if (
      pickup.kind === 'rail'
      || pickup.kind === 'rocket'
      || pickup.kind === 'plasma'
      || pickup.kind === 'shotgun'
      || pickup.kind === 'sniper'
      || pickup.kind === 'laser'
      || pickup.kind === 'disc'
    ) {
      this.audio.ammoPickup(pickup.kind, this.rng() - 0.5);
    } else {
      this.audio.pickup(pickup.kind);
    }
    this.hud.message(`${pickup.kind.toUpperCase()} ACQUIRED`);
    this.spawnBurst(pickup.group.position, this.weaponColorForPickup(pickup.kind), 9);
    this.trauma = Math.min(1, this.trauma + 0.12);
  }

  private collectBotPickup(pickup: PickupState, bot: Bot): void {
    bot.collectPickup(pickup.kind);
    pickup.active = false;
    pickup.group.visible = false;
    pickup.cooldown = pickup.respawn;
    this.audio.pickup(pickup.kind === 'rail' || pickup.kind === 'rocket' || pickup.kind === 'plasma'
      || pickup.kind === 'shotgun' || pickup.kind === 'sniper' || pickup.kind === 'laser' || pickup.kind === 'disc' ? 'core' : pickup.kind);
    this.hud.message(`${bot.displayName} TOOK ${pickup.kind.toUpperCase()}`);
    this.spawnBurst(pickup.group.position, this.weaponColorForPickup(pickup.kind), 7);
  }

  private updateCore(delta: number): void {
    const wasActive = this.coreActive;
    this.coreDirector.update(delta);
    const directorState = this.coreDirector.snapshot();
    const targetAnchor = directorState.active ? directorState.currentAnchor : directorState.nextAnchor;
    if (targetAnchor) this.positionCoreAt(targetAnchor);
    this.coreActive = directorState.active;
    this.coreCooldown = directorState.active ? 0 : directorState.secondsRemaining;

    if (!this.coreActive) {
      this.coreProgress = 0;
      this.coreOwner = null;
      this.coreContested = false;
      const telegraphing = directorState.phase === 'telegraph';
      this.coreGroup.visible = telegraphing;
      this.coreGroup.scale.setScalar(telegraphing ? 0.68 : 1);
      // Keep the light in Three's light set and fade it with intensity. Toggling
      // visibility changes NUM_POINT_LIGHTS and recompiles every lit material
      // in the arena on the live frame where the objective appears.
      this.coreLight.intensity = telegraphing ? 2.2 : 0;
      return;
    }

    this.coreGroup.visible = true;
    this.coreGroup.scale.setScalar(1);
    this.coreLight.visible = true;
    this.coreLight.intensity = 6;
    if (!wasActive) this.hud.message(`FLUX CORE ACTIVE · ${this.currentCoreAnchorName}`);

    const coreRadiusSq = POWERUP.coreRadius * POWERUP.coreRadius;
    const playerInside = this.playerPosition.distanceToSquared(this.arena.corePosition) <= coreRadiusSq;
    let insideBotCount = 0;
    let soleBotOwner: number | null = null;
    for (const bot of this.bots) {
      if (!bot.alive || bot.group.position.distanceToSquared(this.arena.corePosition) > coreRadiusSq) continue;
      insideBotCount += 1;
      soleBotOwner = bot.id;
    }
    let owner: Owner | null = null;
    if (playerInside && insideBotCount === 0) owner = 'player';
    if (!playerInside && insideBotCount === 1) owner = soleBotOwner;
    this.coreContested = (playerInside && insideBotCount > 0) || insideBotCount > 1;
    if (owner === null) {
      this.coreProgress = Math.max(0, this.coreProgress - delta * 0.65);
      this.coreOwner = null;
      return;
    }
    if (this.coreOwner !== owner) this.coreProgress = 0;
    this.coreOwner = owner;
    this.coreProgress += delta / POWERUP.coreHold;
    if (this.coreProgress < 1) return;
    if (owner === 'player') {
      this.score += 3;
      this.coreCaptures += 1;
      this.hud.message(`FLUX CORE CAPTURED · ${this.currentCoreAnchorName} · +3`);
    } else {
      this.bots[owner].score += 3;
      this.hud.message(`${this.bots[owner].displayName} CAPTURED ${this.currentCoreAnchorName}`);
    }
    this.audio.pickup('core');
    this.hud.pulseObjective();
    this.spawnBurst(this.coreGroup.position, 0x43e8ff, 18);
    this.coreDirector.captured(owner);
    const cooldownState = this.coreDirector.snapshot();
    this.coreActive = cooldownState.active;
    this.coreGroup.visible = false;
    this.coreLight.intensity = 0;
    this.coreCooldown = cooldownState.secondsRemaining;
    this.coreProgress = 0;
    this.coreOwner = null;
    this.coreContested = false;
  }

  private positionCoreAt(anchor: CoreAnchor): void {
    this.currentCoreAnchorName = anchor.name;
    this.arena.corePosition.copy(anchor.position);
    this.coreGroup.position.set(anchor.position.x, anchor.position.y + 2.4, anchor.position.z);
    this.coreLight.position.set(anchor.position.x, anchor.position.y + 6, anchor.position.z);
  }

  private updatePickupVisuals(delta: number, elapsed: number): void {
    if (this.mobileQuality) {
      const mobilePickupDetailDistanceSq = 34 * 34;
      for (const pickup of this.pickups) {
        if (!pickup.active) continue;
        // Keep the full authored pickup readable in the current combat lane;
        // stream distant pickup meshes back in as the player approaches so
        // mobile does not pay for every remote material batch at once.
        pickup.group.visible = pickup.group.position.distanceToSquared(this.playerPosition) <= mobilePickupDetailDistanceSq;
      }
    }
    if (!this.reducedMotion) {
      for (const pickup of this.pickups) {
        // Pickups are physical props seated on their floor racks. Only small
        // internal identification hardware animates; the item never hovers.
        const rotor = pickup.group.getObjectByName('pickup-id-rotor');
        if (rotor) rotor.rotation.y += delta * 0.65;
        const pulse = 0.82 + Math.sin(elapsed * 2.4 + pickup.group.userData.phase) * 0.16;
        pickup.group.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (!mesh.isMesh || !mesh.userData.pickupGlow) return;
          const material = mesh.material as THREE.MeshStandardMaterial;
          material.emissiveIntensity = pulse;
        });
      }
      this.coreGroup.rotation.y += delta * 1.1;
      this.coreGroup.position.y = this.arena.corePosition.y + 2.4 + Math.sin(elapsed * 2.7) * 0.18;
    }
  }

  private updateEffects(delta: number): void {
    this.weaponVfx.update(delta);
  }

  private applyWeaponViewPose(
    aimPointLocal: THREE.Vector3,
    walkSwayX: number,
    walkSwayY: number,
    jumpLag: number,
    strafeRoll: number,
    downwardAim: number,
  ): void {
    // At full obstruction the parent crosses behind the camera while the
    // visible nose folds out of the lower viewport. This range is large enough
    // to clear the longest launcher, rather than merely nudging its receiver.
    this.weaponModel.position.set(
      0.3 + this.weaponTurnSway.x + walkSwayX,
      -0.54 - this.recoil * 0.08 - this.weaponTuck * 0.52 - this.scopeBlend * 1.25
        + this.weaponTurnSway.y + walkSwayY + jumpLag,
      -0.5 + this.recoil * 0.1 + this.weaponTuck * WEAPON_VIEW_RETRACT_DISTANCE,
    );
    const boreDirection = this.weaponBoreScratch.copy(aimPointLocal).sub(this.weaponModel.position).normalize();
    const boreYaw = Math.atan2(-boreDirection.x, -boreDirection.z);
    const borePitch = Math.asin(THREE.MathUtils.clamp(boreDirection.y, -1, 1));
    // A wall lets the nose fold down slightly. Looking into terrain reverses
    // that fold so the barrel retreats upward and back instead of being driven
    // through the floor by the camera pitch.
    const obstructionPitch = THREE.MathUtils.lerp(-0.18, 0.2, downwardAim);
    this.weaponModel.rotation.x = borePitch + this.recoil * 0.15
      + this.weaponTuck * obstructionPitch - jumpLag * 0.45;
    this.weaponModel.rotation.y = boreYaw - this.weaponTurnSway.x * 0.72 - walkSwayX * 0.36;
    this.weaponModel.rotation.z = strafeRoll - this.weaponTurnSway.x * 0.18;
  }

  private weaponWallHitDistance(hit: SurfaceHit | null, wallDirection: THREE.Vector3): number {
    if (!hit || Math.abs(hit.normal.y) > WEAPON_WALL_MAX_NORMAL_Y) {
      return WEAPON_OBSTRUCTION_PROBE_LENGTH;
    }
    const facing = -(hit.normal.x * wallDirection.x + hit.normal.z * wallDirection.z);
    return facing >= WEAPON_WALL_MIN_FACING
      ? hit.distance
      : WEAPON_OBSTRUCTION_PROBE_LENGTH;
  }

  private updateThirdPersonWeaponPose(direction: THREE.Vector3): void {
    const visual = this.thirdPersonWeaponVisual;
    const visible = this.isThirdPerson()
      && !this.playerFighter
      && !this.weaponInspectionMode
      && !this.screenshotLookTargetActive
      && Boolean(visual);
    this.thirdPersonWeaponModel.visible = visible;
    if (!visible || !visual) return;

    // Seat the receiver between the character's hands and the screen-center
    // reticle. The camera is on the same (right) shoulder, so the weapon stays
    // visible without covering the target or floating across the torso.
    const forward = this.thirdPersonMuzzleForwardScratch
      .set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = this.thirdPersonMuzzleRightScratch
      .set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const isShoulderedLongshot = visual.weapon === 'sniper';
    this.thirdPersonWeaponModel.position.copy(this.playerPosition)
      .addScaledVector(forward, isShoulderedLongshot ? 0.08 : 0.18)
      .addScaledVector(right, isShoulderedLongshot ? 0.12 : 0.26);
    this.thirdPersonWeaponModel.position.y += isShoulderedLongshot ? 1.35 : 1.24;
    this.thirdPersonWeaponModel.quaternion.setFromUnitVectors(THIRD_PERSON_WEAPON_FORWARD, direction);
    this.thirdPersonWeaponModel.scale.setScalar(THIRD_PERSON_WEAPON_SCALE[visual.weapon]);
    this.thirdPersonWeaponModel.updateMatrixWorld(true);
  }

  private updateFighterCamera(delta: number, fighter: FighterRuntime): void {
    const forward = this.fighterForwardScratch.set(0, 0, -1).applyQuaternion(fighter.flight.orientation);
    const up = this.fighterUpScratch.set(0, 1, 0).applyQuaternion(fighter.flight.orientation);
    // The player occupies the cockpit: never spring-arm or lag this camera
    // behind the vehicle, because even a few frames of separation exposes the
    // full craft and turns piloting into a third-person chase view. The seat is
    // just below the canopy crown and slightly ahead of the mass center.
    const seat = this.fighterCameraDesiredScratch.copy(fighter.flight.position)
      .addScaledVector(forward, fighter.visual.dimensions.z * 0.075 * fighter.visual.visibleScaleCorrection)
      .addScaledVector(up, fighter.visual.dimensions.y * 0.39 * fighter.visual.visibleScaleCorrection);
    this.camera.position.copy(seat);
    const look = this.fighterCameraLookScratch.copy(seat)
      .addScaledVector(this.viewDirection(this.fighterAimScratch), 38);
    this.camera.up.copy(up);
    this.camera.lookAt(look);
    const speed = fighter.flight.velocity.length();
    const targetFov = THREE.MathUtils.clamp(74 + speed * 0.12 + this.fovPunch, 74, 88);
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, 1 - Math.exp(-Math.max(delta, 1 / 120) * 8));
    this.camera.updateProjectionMatrix();
    this.weaponModel.visible = false;
    this.thirdPersonWeaponModel.visible = false;
    this.playerAvatar.root.visible = false;
    this.playerJetpack.root.visible = false;
    this.weaponVfx.updateGrapple(this.camera.position, this.grappleAnchor, false);
    this.forward.copy(forward);
    this.fovPunch = Math.max(0, this.fovPunch - delta * 12);
  }

  private updateCamera(delta: number): void {
    if (this.playerFighter) {
      this.updateFighterCamera(delta, this.playerFighter);
      return;
    }
    this.camera.up.set(0, 1, 0);
    const direction = this.viewDirection(this.cameraDirectionScratch);
    // Reassert this every frame because weapon rebuilds and deterministic QA
    // state changes may occur after the view toggle. The first-person model
    // must never cover the local avatar in third-person flight.
    this.weaponModel.visible = !this.isThirdPerson() && !this.screenshotLookTargetActive;
    this.thirdPersonWeaponModel.visible = this.isThirdPerson()
      && !this.screenshotLookTargetActive
      && Boolean(this.thirdPersonWeaponVisual);
    this.playerAvatar.setVisible(this.isThirdPerson() && !this.screenshotLookTargetActive);
    this.playerAvatar.root.position.copy(this.playerPosition);
    this.playerAvatar.setPose(this.yaw, this.moveInput.x);
    this.updateThirdPersonWeaponPose(direction);
    const eye = this.cameraEyeScratch.copy(this.playerPosition);
    eye.y += PLAYER_EYE;
    this.thirdPersonAnchorScratch.copy(this.playerPosition);
    this.thirdPersonAnchorScratch.y += THIRD_PERSON_CAMERA_TARGET_HEIGHT;
    this.thirdPersonBackScratch.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.cameraRightScratch.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const shoulderOffset = THREE.MathUtils.clamp(
      this.camera.aspect * THIRD_PERSON_CAMERA_SHOULDER_ASPECT_SCALE,
      THIRD_PERSON_CAMERA_SHOULDER_MIN,
      THIRD_PERSON_CAMERA_SHOULDER_MAX,
    );
    const cameraDistance = THIRD_PERSON_CAMERA_DISTANCE + THREE.MathUtils.clamp(
      (1 - this.camera.aspect) * THIRD_PERSON_CAMERA_PORTRAIT_DISTANCE_SCALE,
      0,
      THIRD_PERSON_CAMERA_PORTRAIT_DISTANCE_MAX,
    );
    this.thirdPersonDesiredScratch.copy(this.thirdPersonAnchorScratch)
      .addScaledVector(this.thirdPersonBackScratch, cameraDistance)
      .addScaledVector(this.cameraRightScratch, shoulderOffset);
    this.thirdPersonDesiredScratch.y = this.playerPosition.y + THIRD_PERSON_CAMERA_HEIGHT;
    // Keep the rig compact. Terrain is handled by lifting the rear camera just
    // enough to clear the sampled path; it must never solve an obstruction by
    // flinging the camera sideways and shrinking the player into the distance.
    let terrainLift = 0;
    for (let index = 1; index <= THIRD_PERSON_CAMERA_TERRAIN_PROBES; index += 1) {
      const t = index / THIRD_PERSON_CAMERA_TERRAIN_PROBES;
      this.thirdPersonAlternateDesiredScratch.lerpVectors(
        this.thirdPersonAnchorScratch,
        this.thirdPersonDesiredScratch,
        t,
      );
      const pathFloor = this.arena.floorHeightAt(
        this.thirdPersonAlternateDesiredScratch.x,
        this.thirdPersonAlternateDesiredScratch.z,
        this.thirdPersonAlternateDesiredScratch.y + THIRD_PERSON_CAMERA_TERRAIN_HEADROOM,
      );
      if (pathFloor === null) continue;
      const requiredLift = pathFloor + THIRD_PERSON_CAMERA_GROUND_CLEARANCE
        - this.thirdPersonAlternateDesiredScratch.y;
      if (requiredLift > 0) terrainLift = Math.max(terrainLift, requiredLift / t);
    }
    terrainLift = Math.min(terrainLift, THIRD_PERSON_CAMERA_MAX_LIFT);
    this.thirdPersonDesiredScratch.y += terrainLift;
    this.thirdPersonOffsetScratch.subVectors(this.thirdPersonDesiredScratch, this.thirdPersonAnchorScratch);
    const desiredDistance = this.thirdPersonOffsetScratch.length();
    let thirdPersonHit = this.arena.segmentHitDetails(
      this.thirdPersonAnchorScratch,
      this.thirdPersonDesiredScratch,
    );
    this.thirdPersonCameraObstructed = terrainLift > 0.01 || thirdPersonHit !== null;
    if (thirdPersonHit) {
      const safeDistance = THREE.MathUtils.clamp(
        thirdPersonHit.distance - THIRD_PERSON_CAMERA_CLEARANCE,
        0.95,
        desiredDistance,
      );
      this.thirdPersonPositionScratch.copy(this.thirdPersonAnchorScratch)
        .addScaledVector(this.thirdPersonOffsetScratch.normalize(), safeDistance);
    } else {
      this.thirdPersonPositionScratch.copy(this.thirdPersonDesiredScratch);
    }

    this.thirdPersonOffsetScratch.subVectors(this.thirdPersonPositionScratch, this.thirdPersonAnchorScratch);
    if (!this.thirdPersonCameraInitialized || delta <= 0) {
      this.thirdPersonSmoothedOffset.copy(this.thirdPersonOffsetScratch);
      this.thirdPersonCameraInitialized = true;
    } else if (this.thirdPersonCameraObstructed) {
      // Collision response is immediate so the camera never eases through a
      // wall. Returning to the authored shoulder distance remains smooth.
      this.thirdPersonSmoothedOffset.copy(this.thirdPersonOffsetScratch);
    } else {
      const smoothing = 1 - Math.exp(-delta * 12);
      this.thirdPersonSmoothedOffset.lerp(this.thirdPersonOffsetScratch, smoothing);
    }
    this.thirdPersonPositionScratch.copy(this.thirdPersonAnchorScratch)
      .add(this.thirdPersonSmoothedOffset);

    // The smoothed orbit can sweep across a nearby corner during a fast turn.
    // Re-clip the final segment so interpolation never introduces wall pops.
    thirdPersonHit = this.arena.segmentHitDetails(
      this.thirdPersonAnchorScratch,
      this.thirdPersonPositionScratch,
    );
    if (thirdPersonHit) {
      this.thirdPersonCameraObstructed = true;
      this.thirdPersonOffsetScratch.subVectors(this.thirdPersonPositionScratch, this.thirdPersonAnchorScratch);
      const safeDistance = THREE.MathUtils.clamp(
        thirdPersonHit.distance - THIRD_PERSON_CAMERA_CLEARANCE,
        0.95,
        this.thirdPersonOffsetScratch.length(),
      );
      this.thirdPersonPositionScratch.copy(this.thirdPersonAnchorScratch)
        .addScaledVector(this.thirdPersonOffsetScratch.normalize(), safeDistance);
      this.thirdPersonSmoothedOffset.subVectors(this.thirdPersonPositionScratch, this.thirdPersonAnchorScratch);
    }
    const cameraFloor = this.arena.floorHeightAt(
      this.thirdPersonPositionScratch.x,
      this.thirdPersonPositionScratch.z,
      this.thirdPersonPositionScratch.y + THIRD_PERSON_CAMERA_TERRAIN_HEADROOM,
    );
    if (
      cameraFloor !== null
      && this.thirdPersonPositionScratch.y < cameraFloor + THIRD_PERSON_CAMERA_GROUND_CLEARANCE
    ) {
      this.thirdPersonCameraObstructed = true;
      this.thirdPersonPositionScratch.y = cameraFloor + THIRD_PERSON_CAMERA_GROUND_CLEARANCE;
      this.thirdPersonSmoothedOffset.subVectors(this.thirdPersonPositionScratch, this.thirdPersonAnchorScratch);
    }
    this.camera.position.copy(this.isThirdPerson() ? this.thirdPersonPositionScratch : eye);
    if (!this.isThirdPerson()) this.thirdPersonCameraInitialized = false;
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    if (this.isThirdPerson()) {
      // Look through the reticle into the arena. The shoulder offset keeps the
      // avatar low-left while the center of the screen stays on the aim line.
      this.thirdPersonAimScratch.copy(this.thirdPersonAnchorScratch)
        .addScaledVector(direction, 7.5);
      this.camera.lookAt(this.thirdPersonAimScratch);
    }

    if (!this.reducedMotion && this.trauma > 0) {
      const shake = this.trauma * this.trauma;
      const frequency = this.elapsed * 31;
      this.camera.position.x += this.noise(frequency, 1) * 0.22 * shake;
      this.camera.position.y += this.noise(frequency, 2) * 0.18 * shake;
      this.camera.rotation.z = this.noise(frequency, 3) * 0.035 * shake;
      this.trauma = Math.max(0, this.trauma - delta * 1.4);
    } else {
      this.camera.rotation.z = 0;
    }
    if (this.pausedForScreenshot && this.screenshotLookTargetActive) {
      this.camera.lookAt(this.screenshotLookTarget);
    }

    const speed = Math.hypot(this.playerVelocity.x, this.playerVelocity.z);
    const scopeRequested = this.sniperScopeRequested();
    const scopeDelta = Math.max(delta, MOVEMENT.fixedStep);
    this.scopeBlend = THREE.MathUtils.lerp(
      this.scopeBlend,
      scopeRequested ? 1 : 0,
      1 - Math.exp(-scopeDelta * (scopeRequested ? 14 : 18)),
    );
    if (this.scopeBlend < 0.001) this.scopeBlend = 0;
    const unscopedFov = Math.min(
      MAX_SPEED_FOV,
      this.pausedForScreenshot
        ? this.screenshotCameraFov
        : this.isThirdPerson()
          ? THIRD_PERSON_FOV + speed * 0.1 + this.fovPunch * 0.45
          : BASE_GAME_FOV + speed * 0.24 + this.fovPunch,
    );
    const baseFov = THREE.MathUtils.lerp(unscopedFov, 24, this.scopeBlend);
    this.fovPunch *= Math.exp(-delta / 0.2);
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, baseFov, 1 - Math.exp(-scopeDelta * 12));
    this.camera.updateProjectionMatrix();
    this.recoil *= Math.exp(-delta * 11);
    const motionDelta = Math.max(delta, MOVEMENT.fixedStep);
    const walkWeightTarget = this.grounded && !this.skiHeld
      ? THREE.MathUtils.smoothstep(speed, 1.5, 11)
      : 0;
    // Ground contact legitimately flickers for a frame while stepping across
    // authored stair seams. Ease the presentation weight so that collision
    // bookkeeping never switches the view-model animation on and off.
    this.weaponWalkWeight = THREE.MathUtils.lerp(
      this.weaponWalkWeight,
      walkWeightTarget,
      1 - Math.exp(-motionDelta * 12),
    );
    this.weaponBobPhase += motionDelta * (4.8 + Math.min(18, speed) * 0.62) * this.weaponWalkWeight;
    const turnTargetX = THREE.MathUtils.clamp(-this.lookInput.x * 0.00072, -0.072, 0.072);
    const turnTargetY = THREE.MathUtils.clamp(this.lookInput.y * 0.00062, -0.055, 0.055);
    this.weaponTurnSway.x = THREE.MathUtils.lerp(this.weaponTurnSway.x, turnTargetX, 1 - Math.exp(-motionDelta * 15));
    this.weaponTurnSway.y = THREE.MathUtils.lerp(this.weaponTurnSway.y, turnTargetY, 1 - Math.exp(-motionDelta * 15));
    const walkSwayX = Math.sin(this.weaponBobPhase) * 0.022 * this.weaponWalkWeight;
    const walkSwayY = -Math.abs(Math.cos(this.weaponBobPhase)) * 0.014 * this.weaponWalkWeight;
    this.weaponAirborneTime = this.grounded || this.skiHeld
      ? 0
      : this.weaponAirborneTime + motionDelta;
    // Delay and low-pass airborne lag so real jumps retain weight while a
    // single unresolved stair/ramp contact cannot kick the gun toward the
    // camera. Grounded slope velocity is intentionally excluded.
    const verticalLagTarget = this.weaponAirborneTime > 0.075
      ? THREE.MathUtils.clamp(-this.playerVelocity.y * 0.0035, -0.04, 0.04)
      : 0;
    this.weaponVerticalLag = THREE.MathUtils.lerp(
      this.weaponVerticalLag,
      verticalLagTarget,
      1 - Math.exp(-motionDelta * 9),
    );
    const strafeRoll = THREE.MathUtils.clamp(-this.moveInput.x * speed * 0.00125, -0.028, 0.028);
    this.camera.updateMatrixWorld(true);
    const probeOrigin = this.camera.position;
    const probeLength = WEAPON_OBSTRUCTION_PROBE_LENGTH;
    const wallDirection = this.weaponWallDirectionScratch.set(direction.x, 0, direction.z).normalize();
    const wallProbeEnd = this.cameraProbeScratch.copy(probeOrigin)
      .addScaledVector(wallDirection, probeLength);
    // Weapon clearance follows movement-grade collision, not broad hitscan
    // proxies. The latter deliberately wrap whole curved route segments and
    // caused false wall hits whenever the player crossed their AABB seams.
    const centerObstruction = this.arena.movementSegmentHitDetails(probeOrigin, wallProbeEnd);
    // The FPS weapon sits low/right, so retain a lateral envelope probe. Keep
    // it horizontal: a downward offset repeatedly entered stair treads and
    // ramp tops as the player's eye rose and fell over the surface.
    this.cameraRightScratch.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const weaponProbeEnd = this.weaponProbeScratch.copy(wallProbeEnd)
      .addScaledVector(this.cameraRightScratch, 0.38);
    const weaponObstruction = this.arena.movementSegmentHitDetails(probeOrigin, weaponProbeEnd);
    this.weaponObstructionDistance = Math.min(
      this.weaponWallHitDistance(centerObstruction, wallDirection),
      this.weaponWallHitDistance(weaponObstruction, wallDirection),
    );
    const downwardAim = THREE.MathUtils.smoothstep(-direction.y, 0.34, 0.94);
    const safeReach = WEAPON_VIEW_SAFE_REACH[WEAPONS[this.selectedWeapon].id];
    const tuckTarget = THREE.MathUtils.clamp(
      (safeReach + WEAPON_VIEW_CLEARANCE - this.weaponObstructionDistance) / WEAPON_VIEW_RETRACT_DISTANCE,
      0,
      1,
    );
    // Contact entry is immediate so a sprint cannot produce a one-frame clip;
    // release is eased to avoid the weapon snapping back into its idle pose.
    this.weaponTuck = tuckTarget >= this.weaponTuck
      ? tuckTarget
      : THREE.MathUtils.lerp(this.weaponTuck, tuckTarget, 1 - Math.exp(-motionDelta * 14));
    const aimRayEnd = this.cameraAimScratch.copy(eye).addScaledVector(direction, 190);
    const aimPointWorld = this.arena.segmentHit(eye, aimRayEnd) ?? aimRayEnd;
    this.scopeRange = eye.distanceTo(aimPointWorld);
    this.hud.setSniperScope(this.scopeBlend, this.scopeRange, BASE_GAME_FOV / Math.max(24, this.camera.fov));
    this.camera.updateMatrixWorld(true);
    // Keep presentation convergence independent from collision range. The old
    // surface-local target could land behind the low/right weapon origin when
    // the reticle crossed nearby terrain, producing the reported rapid
    // forward/back flip even though wall tuck never activated.
    const wallConvergence = THREE.MathUtils.smoothstep(this.weaponTuck, 0.42, 0.72);
    const convergenceDistance = THREE.MathUtils.lerp(
      WEAPON_VIEW_CONVERGENCE_DISTANCE,
      WEAPON_VIEW_WALL_CONVERGENCE_DISTANCE,
      wallConvergence,
    );
    const aimPointLocal = this.cameraLocalAimScratch.set(0, 0, -convergenceDistance);
    this.applyWeaponViewPose(
      aimPointLocal,
      walkSwayX,
      walkSwayY,
      this.weaponVerticalLag,
      strafeRoll,
      downwardAim,
    );

    // Verify the authored muzzle against real map geometry. This is diagnostic
    // only: feeding it back into weaponTuck caused the old full-tuck latch,
    // where a partially restored barrel could keep re-hiding itself forever.
    this.weaponModel.updateWorldMatrix(true, true);
    this.muzzleSocket.getWorldPosition(this.weaponMuzzleScratch);
    this.weaponMuzzleDistance = probeOrigin.distanceTo(this.weaponMuzzleScratch);
    this.weaponMuzzleForwardDistance = (
      (this.weaponMuzzleScratch.x - probeOrigin.x) * direction.x
      + (this.weaponMuzzleScratch.y - probeOrigin.y) * direction.y
      + (this.weaponMuzzleScratch.z - probeOrigin.z) * direction.z
    );
    const muzzleObstruction = this.arena.segmentHitDetails(probeOrigin, this.weaponMuzzleScratch);
    this.weaponMuzzleOccluded = Boolean(
      this.weaponMuzzleForwardDistance > this.camera.near + 0.03
      && muzzleObstruction
      && muzzleObstruction.distance < this.weaponMuzzleDistance - 0.055,
    );
    if (this.weaponInspectionMode) {
      this.weaponModel.position.set(0, 0, -3.15);
      this.weaponModel.rotation.set(0, Math.PI * 0.5, 0);
      this.weaponModel.scale.setScalar(1);
    }
    if (this.isThirdPerson()) {
      this.weaponTuck = 0;
      this.weaponMuzzleOccluded = false;
    }
    if (this.weaponVisual) updateWeaponViewModel(this.weaponVisual, this.elapsed, this.recoil, this.laserHeat, this.reducedMotion);
    if (this.thirdPersonWeaponVisual) {
      updateWeaponViewModel(
        this.thirdPersonWeaponVisual,
        this.elapsed,
        this.recoil,
        this.laserHeat,
        this.reducedMotion,
      );
    }
    this.forward.copy(direction);
    const grappleOrigin = this.grappleActive
      ? this.isThirdPerson()
        ? this.grappleOriginScratch.copy(eye).addScaledVector(this.cameraRightScratch, -0.28)
        : this.grappleSocket.getWorldPosition(this.grappleOriginScratch)
      : this.isThirdPerson() ? eye : this.camera.position;
    this.weaponVfx.updateGrapple(grappleOrigin, this.grappleAnchor, this.grappleActive);
  }

  private updateHud(): void {
    const definition = WEAPONS[this.selectedWeapon];
    const jetpackEnergy = this.jetpackEnergy.snapshot();
    const botLead = Math.max(...this.bots.map((bot) => bot.score));
    const coreDirectorState = this.coreDirector.snapshot();
    const coreLocation = coreDirectorState.active
      ? coreDirectorState.currentAnchor?.name ?? this.currentCoreAnchorName
      : coreDirectorState.nextAnchor?.name ?? this.currentCoreAnchorName;
    const coreStatus = this.coreActive
      ? this.coreContested
        ? 'CORE CONTESTED'
        : this.coreOwner === null
        ? 'CORE UNCONTESTED'
        : this.coreOwner === 'player'
          ? 'CAPTURING CORE'
          : `${this.bots[this.coreOwner]?.displayName ?? 'ENEMY'} CAPTURING`
      : coreDirectorState.phase === 'telegraph'
        ? `CORE LOCKING · ${Math.max(0, Math.ceil(this.coreCooldown))}s`
        : `CORE RELOCATING · ${Math.max(0, Math.ceil(this.coreCooldown))}s`;
    const matchStatus = this.mode === 'complete'
      ? this.score > botLead ? 'MATCH WON' : this.score === botLead ? 'MATCH DRAWN' : 'MATCH LOST'
      : this.mode === 'ready'
        ? 'CLICK TO ENTER'
        : this.mode === 'countdown' ? 'WEAPONS LOCKED' : this.overtime ? 'OVERTIME · NEXT SCORE' : `FIRST TO ${SCORE_LIMIT}`;
    const resolvedMatchStatus = this.mode === 'paused' ? 'MATCH PAUSED' : matchStatus;
    const powerups: string[] = [];
    if (this.damageBoost > 0) powerups.push(`DAMAGE ${Math.ceil(this.damageBoost)}s`);
    if (this.speedBoost > 0) powerups.push(`SPEED ${Math.ceil(this.speedBoost)}s`);
    if (definition.id === 'laser' && this.laserHeat > 0.65) powerups.push(`HEAT ${Math.round(this.laserHeat * 100)}%`);
    powerups.push(this.grappleActive ? 'GRAPPLE ANCHORED' : 'GRAPPLE READY');
    powerups.push(this.dashCooldown > 0 ? `DASH ${this.dashCooldown.toFixed(1)}s` : 'DASH READY');
    if (this.jetpackActive) powerups.push(`JET THRUST ${Math.round(jetpackEnergy.charge * 100)}%`);
    else if (jetpackEnergy.locked) powerups.push(`JET COOL ${jetpackEnergy.restartInSeconds.toFixed(1)}s`);
    powerups.push(this.grenadeCooldown > 0 ? `FRAG ${this.grenadeAmmo} · ${this.grenadeCooldown.toFixed(1)}s` : `FRAG GRENADES ${this.grenadeAmmo}`);
    const rail = this.pickups.find((pickup) => pickup.kind === 'rail');
    const style = this.styleSystem.snapshot();
    const scores = [this.score, ...this.bots.map((bot) => bot.score)];
    const leadingScore = Math.max(...scores);
    this.hud.update({
      health: this.health,
      armor: this.armor,
      speed: Math.hypot(this.playerVelocity.x, this.playerVelocity.z),
      score: this.score,
      botLead,
      timeRemaining: this.matchTime,
      weaponId: definition.id,
      weapon: definition.name,
      secondary: definition.secondary.toUpperCase(),
      ammo: this.ammo.get(definition.id) ?? 0,
      coreProgress: this.coreProgress,
      coreStatus,
      matchStatus: resolvedMatchStatus,
      fps: this.fps,
      powerups,
      railTimer: rail?.active ? 0 : rail?.cooldown ?? 0,
      jetpack: {
        charge: jetpackEnergy.charge,
        phase: jetpackEnergy.phase,
      },
      standings: [
        { callsign: 'RIFT-01', score: this.score, isPlayer: true, isLeader: this.score === leadingScore },
        ...this.bots.map((bot) => ({
          callsign: bot.displayName,
          score: bot.score,
          isLeader: bot.score === leadingScore,
        })),
      ],
      objective: {
        location: coreLocation,
        phase: this.coreActive ? this.coreContested ? 'CONTESTED' : 'CAPTURE' : coreDirectorState.phase.toUpperCase(),
        contestState: coreStatus,
        nextEventLabel: this.coreActive ? 'CAPTURE LIVE' : coreDirectorState.phase === 'telegraph' ? 'CORE ONLINE' : 'NEXT LOCK',
        nextEventSeconds: this.coreActive ? 0 : this.coreCooldown,
      },
      style: style.meter > 0 || style.lastMedal
        ? {
          medal: style.lastMedal?.label ?? `FLOW ×${style.comboMultiplier.toFixed(2)}`,
          meter: style.meter / 100,
        }
        : null,
      weather: {
        phase: String(this.weatherSnapshot.phase).toUpperCase(),
        detail: this.weatherSnapshot.label,
      },
    });
    const activeFighter = this.playerFighter;
    const fighterForward = activeFighter
      ? this.fighterForwardScratch.set(0, 0, -1).applyQuaternion(activeFighter.flight.orientation)
      : null;
    const fighterFloor = activeFighter
      ? this.arena.floorHeightAt(
        activeFighter.flight.position.x,
        activeFighter.flight.position.z,
        activeFighter.flight.position.y,
      )
      : null;
    const fighterFlightMode = activeFighter?.flight.overheated
      ? 'DRIVE OVERHEAT'
      : activeFighter?.flight.boostActive
        ? 'VECTOR BOOST'
        : activeFighter?.flight.afterburnerActive
          ? 'AFTERBURNER'
          : activeFighter?.flight.grounded
            ? 'PAD LOCKED'
            : activeFighter?.flight.hovering
              ? 'VTOL HOLD'
              : 'COMBAT FLIGHT';
    let promptFighter: FighterRuntime | null = null;
    let promptDistanceSq = (FIGHTER_BOARD_RANGE + 1.5) ** 2;
    for (const fighter of this.fighters) {
      if (fighter.pilot !== null && fighter.pilot !== 'player') continue;
      const distanceSq = fighter.flight.position.distanceToSquared(this.playerPosition);
      if (distanceSq >= promptDistanceSq) continue;
      promptDistanceSq = distanceSq;
      promptFighter = fighter;
    }
    const promptTitle = promptFighter?.destroyed
      ? 'STAR SPARROW REBUILDING'
      : promptFighter
        ? `R // BOARD ${promptFighter.pad.label}`
        : '';
    const promptDetail = promptFighter?.destroyed
      ? `${promptFighter.respawnSeconds.toFixed(1)}s until pad-ready`
      : promptFighter
        ? 'Plasma · missiles · afterburner · eject anytime'
        : '';
    this.hud.fighter({
      active: Boolean(activeFighter),
      prompt: Boolean(promptFighter && !activeFighter),
      promptTitle,
      promptDetail,
      hull: activeFighter?.hull,
      hullMax: FIGHTER_HULL_MAX,
      shield: activeFighter?.shield,
      shieldMax: FIGHTER_SHIELD_MAX,
      drive: activeFighter?.flight.afterburnerEnergy,
      heat: activeFighter?.flight.heat,
      overheated: activeFighter?.flight.overheated,
      throttle: activeFighter?.flight.controlThrottle,
      speed: activeFighter ? activeFighter.flight.velocity.length() * 3.6 : 0,
      altitude: activeFighter
        ? activeFighter.flight.position.y - (fighterFloor ?? 0)
        : 0,
      verticalSpeed: activeFighter?.flight.velocity.y,
      heading: fighterForward
        ? THREE.MathUtils.radToDeg(Math.atan2(-fighterForward.x, -fighterForward.z))
        : 0,
      pitch: fighterForward ? Math.asin(THREE.MathUtils.clamp(fighterForward.y, -1, 1)) : 0,
      primaryCooldown: activeFighter?.primaryCooldown,
      missileCooldown: activeFighter?.missileCooldown,
      flightMode: fighterFlightMode,
      locked: false,
      respawnSeconds: promptFighter?.respawnSeconds,
    });
    this.vehicleButton.textContent = activeFighter ? 'EJECT' : 'BOARD';
    this.hud.setRespawn(this.mode === 'respawning' ? this.respawnTimer : 0, this.respawnCause);
  }

  private beginMatch(): void {
    if (this.mode === 'complete') this.resetMatch();
    if (this.mode === 'ready') {
      this.startMatchCountdown();
    } else if (this.mode === 'paused') {
      this.mode = 'running';
      this.hud.hideStart();
      this.startButton.textContent = 'ENTER THE RIFT';
      this.audio.setPaused(false);
      void this.audio.unlock();
      this.input.setPointerLockAllowed(true);
      this.input.requestGameplayPointerLock();
    }
  }

  private startMatchCountdown(): void {
    this.mode = 'countdown';
    this.countdownRemaining = MATCH_COUNTDOWN_DURATION;
    this.countdownCueIndex = 0;
    this.countdownArmed = false;
    const sequenceToken = ++this.countdownSequenceToken;
    this.hud.hideStart();
    this.hud.showCountdown('READY');
    this.startButton.textContent = 'ENTER THE RIFT';
    this.audio.setPaused(false);
    this.input.setPointerLockAllowed(true);
    this.input.requestGameplayPointerLock();
    this.publishDiagnostics();

    // The four tiny voice clips are loaded ahead of the combat bank. READY
    // holds the arena lock until that priority load settles, so the first cue
    // is never silently skipped on a cold browser cache.
    void this.audio.prepareCountdown().then(() => {
      if (this.mode !== 'countdown' || sequenceToken !== this.countdownSequenceToken) return;
      this.countdownRemaining = MATCH_COUNTDOWN_DURATION;
      this.countdownCueIndex = 0;
      this.countdownArmed = true;
      this.hud.showCountdown('READY');
      this.audio.announceCountdown('READY');
      this.publishDiagnostics();
    });
  }

  private updateMatchCountdown(delta: number): boolean {
    if (!this.countdownArmed) return false;
    this.countdownRemaining = Math.max(0, this.countdownRemaining - delta);
    if (this.countdownRemaining <= 0) {
      this.countdownArmed = false;
      this.mode = 'running';
      this.hud.hideCountdown();
      this.hud.message('WEAPONS FREE · E DASH · G HOOK · HOLD SPACE FOR JET');
      return true;
    }
    const cueIndex = Math.min(
      MATCH_COUNTDOWN_CUES.length - 1,
      Math.floor(MATCH_COUNTDOWN_DURATION - this.countdownRemaining + 1e-6),
    );
    if (cueIndex <= this.countdownCueIndex) return false;
    this.countdownCueIndex = cueIndex;
    const cue = MATCH_COUNTDOWN_CUES[cueIndex];
    this.hud.showCountdown(cue);
    this.audio.announceCountdown(cue);
    return false;
  }

  private cancelMatchCountdown(): void {
    this.countdownSequenceToken += 1;
    this.countdownRemaining = 0;
    this.countdownCueIndex = -1;
    this.countdownArmed = false;
    this.hud.hideCountdown();
  }

  private togglePause(): void {
    if (this.mode === 'running') {
      this.mode = 'paused';
      this.hud.showStart('paused');
      this.startButton.textContent = 'RESUME MATCH';
      this.input.setPointerLockAllowed(false);
      this.audio.setPaused(true);
    } else if (this.mode === 'paused') {
      this.beginMatch();
    }
  }

  private completeMatch(): void {
    this.cancelMatchCountdown();
    this.mode = 'complete';
    const botLead = Math.max(...this.bots.map((bot) => bot.score));
    const won = this.score > botLead;
    this.hud.message(won ? 'RIFT DOMINATED' : this.score === botLead ? 'MATCH DRAWN' : 'MATCH LOST · RE-ENTER');
    this.input.setPointerLockAllowed(false);
    this.audio.reset();
    this.audio.setPaused(true);
    this.hud.showStart('complete');
    const accuracy = this.playerShots > 0 ? Math.min(100, Math.round(this.playerHits / this.playerShots * 100)) : 0;
    const style = this.styleSystem.snapshot();
    this.hud.showMatchReport(won ? 'RIFT DOMINATED' : this.score === botLead ? 'STALEMATE' : 'RIFT LOST', [
      ['Score', `${this.score} / ${botLead}`],
      ['Accuracy', `${accuracy}%`],
      ['Deaths', String(this.deaths)],
      ['Core captures', String(this.coreCaptures)],
      ['Air frags', String(this.airborneKills)],
      ['Style', `${Math.round(style.meter)} · ×${style.comboMultiplier.toFixed(2)}`],
      ['Top speed', `${Math.round(this.maxPlayerSpeed * 3.6)} km/h`],
    ]);
    this.startButton.textContent = 'RESTART MATCH';
  }

  private resetMatch(): void {
    this.cancelMatchCountdown();
    this.score = 0;
    this.deaths = 0;
    this.airborneKills = 0;
    this.rocketJumpCount = 0;
    this.grenadeAmmo = 3;
    this.grenadeCooldown = 0;
    this.damageBoost = 0;
    this.speedBoost = 0;
    this.detachGrapple();
    this.clearGrenades();
    for (let index = this.projectiles.length - 1; index >= 0; index -= 1) this.removeProjectile(index);
    this.matchTime = MATCH_DURATION;
    this.overtime = false;
    this.overtimeBaselineScores = [];
    this.playerShots = 0;
    this.playerHits = 0;
    this.discBounceCount = 0;
    this.lastDiscBouncePosition.set(0, 0, 0);
    this.coreCaptures = 0;
    this.maxPlayerSpeed = 0;
    this.coreDirector.reset();
    const openingCore = this.coreDirector.snapshot();
    if (openingCore.nextAnchor) this.positionCoreAt(openingCore.nextAnchor);
    this.coreCooldown = openingCore.secondsRemaining;
    this.coreProgress = 0;
    this.coreActive = false;
    this.coreContested = false;
    this.coreGroup.visible = false;
    this.coreGroup.scale.setScalar(1);
    this.coreLight.intensity = 0;
    this.styleSystem.reset();
    this.recentPlayerKills.length = 0;
    this.weatherSnapshot = this.weatherSystem.reset();
    this.arena.setWeatherGameplaySnapshot(this.weatherSnapshot);
    this.updateMapFog(this.weatherSnapshot.multipliers.visibilityMultiplier);
    for (const pickup of this.pickups) {
      pickup.active = true;
      pickup.cooldown = 0;
      pickup.group.visible = true;
    }
    for (const bot of this.bots) {
      bot.score = 0;
      bot.respawn(this.selectSafeSpawn(bot.id));
    }
    this.resetPlayerLoadout();
    this.hud.clearMatchReport();
    this.audio.reset();
    this.mode = 'ready';
    this.respawnPlayer(false);
    this.startButton.textContent = 'ENTER THE RIFT';
  }

  private respawnPlayer(showMessage: boolean): void {
    this.detachGrapple();
    this.clearGrenades();
    const spawn = this.selectSafeSpawn();
    this.playerPosition.copy(spawn);
    this.playerVelocity.set(0, 0, 0);
    this.jetpackActive = false;
    this.jetpackEnergy.reset();
    this.dashBuffer = 0;
    this.dashCooldown = 0;
    this.dashMomentumTimer = 0;
    this.wallContactTimer = 0;
    this.ceilingContactTimer = 0;
    this.terrainNormal.set(0, 1, 0);
    this.health = 100;
    this.armor = 50;
    this.grenadeAmmo = Math.max(this.grenadeAmmo, 3);
    this.mode = this.mode === 'ready' ? 'ready' : 'running';
    this.respawnTimer = 0;
    this.respawnCause = '';
    this.yaw = Math.atan2(this.playerPosition.x, this.playerPosition.z);
    this.pitch = -0.06;
    if (this.mode === 'running') {
      this.input.setPointerLockAllowed(true);
      this.input.requestGameplayPointerLock();
    }
    if (showMessage) this.hud.message('REDEPLOYED');
  }

  private installGroundingShadows(): void {
    this.mapLighting.addGroundingShadow({
      id: 'player',
      position: this.playerPosition,
      footprint: { width: 0.92, depth: 0.68 },
      maxHeight: 3.5,
      visible: () => this.health > 0 && !this.playerFighter,
    });
    for (const bot of this.bots) {
      this.mapLighting.addGroundingShadow({
        id: `bot-${bot.id}`,
        position: bot.group.position,
        footprint: { width: 0.92, depth: 0.68 },
        maxHeight: 3.5,
        visible: () => bot.alive && bot.group.visible && !this.fighterForPilot(bot.id),
      });
    }
    for (const fighter of this.fighters) {
      this.mapLighting.addGroundingShadow({
        id: fighter.id,
        position: fighter.flight.position,
        footprint: { width: 10.5, depth: 22 },
        heightOffset: 3,
        maxHeight: 18,
        visible: () => !fighter.destroyed && fighter.visual.root.visible,
      });
    }
    for (const drone of this.droneSwarm.combatDrones) {
      this.mapLighting.addGroundingShadow({
        id: drone.id,
        position: drone.position,
        footprint: drone.kind === 'buster' ? { width: 4.8, depth: 4.8 } : { width: 2.1, depth: 2.1 },
        heightOffset: drone.kind === 'buster' ? 1.9 : 0.5,
        maxHeight: drone.kind === 'buster' ? 18 : 12,
        visible: () => drone.alive && drone.visual.root.visible,
      });
    }
    this.mapLighting.updateGroundingShadows(this.arena);
  }

  private createScene(): void {
    const quickSense = this.arena.mapInfo.name === 'QuickSense';
    const fogProfile = quickSense ? MAP_FOG_PROFILES.quicksense : MAP_FOG_PROFILES.monsoon;
    this.scene.background = quickSense
      ? this.arena.skyTexture ?? new THREE.Color(0x75b6df)
      : this.arena.skyTexture ?? new THREE.Color(0x8fcddd);
    this.scene.backgroundIntensity = quickSense
      ? (this.arena.skyTexture ? 0.84 : 0.96)
      : 0.78;
    this.scene.backgroundBlurriness = this.arena.skyTexture ? 0.02 : 0.035;
    this.scene.fog = new THREE.Fog(fogProfile.color, fogProfile.near, fogProfile.far);
    const environmentGenerator = new THREE.PMREMGenerator(this.renderer);
    // A compact neutral IBL keeps dark metal and clearcoat readable in every
    // lane. The authored panorama still owns the visible sky, while the map
    // profile below matches its direct-light palette and direction.
    this.environmentTexture = environmentGenerator.fromScene(new RoomEnvironment(), 0.03).texture;
    this.scene.environment = this.environmentTexture;
    environmentGenerator.dispose();
    if (!this.arena.skyTexture) this.scene.add(this.createSky(quickSense));
    this.mapLighting = new MapLightingRig(
      this.arena.mapInfo.name,
      this.arena.mapInfo.bounds,
      this.arena.corePosition,
      this.mobileQuality,
    );
    this.scene.environmentIntensity = this.mapLighting.environmentIntensity;
    this.renderer.toneMappingExposure = this.mapLighting.exposure;
    this.scene.add(this.mapLighting.root);
    this.coreLight.position.copy(this.arena.corePosition).add(new THREE.Vector3(0, 6, 0));
    this.coreLight.visible = true;
    this.coreLight.intensity = 0;
    this.scene.add(this.coreLight);
    this.scene.add(this.arena.group);
  }

  private updateMapFog(visibilityMultiplier: number): void {
    if (!(this.scene.fog instanceof THREE.Fog)) return;
    const profile = this.arena.mapInfo.name === 'QuickSense'
      ? MAP_FOG_PROFILES.quicksense
      : MAP_FOG_PROFILES.monsoon;
    const visibility = THREE.MathUtils.clamp(visibilityMultiplier, 0.82, 1);
    this.scene.fog.near = profile.near;
    this.scene.fog.far = profile.near + (profile.far - profile.near) * visibility;
  }

  private createPostProcessing(): EffectComposer {
    const quickSense = this.arena.mapInfo.name === 'QuickSense';
    const composer = new EffectComposer(this.renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));
    // QuickSense's bloom was intentionally subtle, yet UnrealBloom still runs
    // a full downsample/blur/composite pyramid. Its authored emissive materials,
    // soft smoke, and restrained grade already provide the highlights; keep
    // those and spend the saved GPU synchronization budget on stable combat.
    if (!quickSense) {
      composer.addPass(new UnrealBloomPass(
        new THREE.Vector2(1, 1),
        this.mobileQuality ? 0.12 : 0.28,
        0.34,
        1.08,
      ));
    }
    this.inkPass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        resolution: { value: new THREE.Vector2(1, 1) },
        edgeStrength: { value: quickSense ? (this.mobileQuality ? 0.035 : 0.05) : (this.mobileQuality ? 0.08 : 0.115) },
        vignette: { value: quickSense ? 0.07 : 0.16 },
        gradeStrength: { value: quickSense ? 1 : 0 },
        gradeContrast: { value: quickSense ? 1.055 : 1 },
        neutralDarken: { value: quickSense ? 0.05 : 0 },
        shadowCool: { value: quickSense ? 0.18 : 0 },
        shadowLift: { value: quickSense ? 0.018 : 0 },
        routeHueSeparation: { value: quickSense ? 1 : 0 },
        saturation: { value: quickSense ? 1.09 : 1.065 },
        speedBlur: { value: 0 },
      },
      vertexShader: `varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `uniform sampler2D tDiffuse;
        uniform vec2 resolution;
        uniform float edgeStrength;
        uniform float vignette;
        uniform float gradeStrength;
        uniform float gradeContrast;
        uniform float neutralDarken;
        uniform float shadowCool;
        uniform float shadowLift;
        uniform float routeHueSeparation;
        uniform float saturation;
        uniform float speedBlur;
        varying vec2 vUv;
        float luma(vec3 color) { return dot(color, vec3(0.2126, 0.7152, 0.0722)); }
        void main() {
          vec2 px = 1.0 / resolution;
          float tl = luma(texture2D(tDiffuse, vUv + px * vec2(-1.0,  1.0)).rgb);
          float tc = luma(texture2D(tDiffuse, vUv + px * vec2( 0.0,  1.0)).rgb);
          float tr = luma(texture2D(tDiffuse, vUv + px * vec2( 1.0,  1.0)).rgb);
          float ml = luma(texture2D(tDiffuse, vUv + px * vec2(-1.0,  0.0)).rgb);
          float mr = luma(texture2D(tDiffuse, vUv + px * vec2( 1.0,  0.0)).rgb);
          float bl = luma(texture2D(tDiffuse, vUv + px * vec2(-1.0, -1.0)).rgb);
          float bc = luma(texture2D(tDiffuse, vUv + px * vec2( 0.0, -1.0)).rgb);
          float br = luma(texture2D(tDiffuse, vUv + px * vec2( 1.0, -1.0)).rgb);
          float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
          float gy = tl + 2.0 * tc + tr - bl - 2.0 * bc - br;
          float edge = smoothstep(0.09, 0.28, length(vec2(gx, gy)));
          vec3 color = texture2D(tDiffuse, vUv).rgb;
          if (speedBlur > 0.001) {
            vec2 centered = vUv - 0.5;
            vec2 aspect = vec2(resolution.x / max(resolution.y, 1.0), 1.0);
            float peripheral = smoothstep(0.38, 0.77, length(centered * aspect));
            vec2 radialDirection = centered / max(length(centered), 0.001);
            vec2 blurOffset = radialDirection * px * (2.0 + speedBlur * 9.0);
            vec3 blurNear = texture2D(tDiffuse, clamp(vUv - blurOffset, 0.0, 1.0)).rgb;
            vec3 blurFar = texture2D(tDiffuse, clamp(vUv - blurOffset * 2.15, 0.0, 1.0)).rgb;
            vec3 speedColor = color * 0.54 + blurNear * 0.31 + blurFar * 0.15;
            color = mix(color, speedColor, peripheral * speedBlur * 0.54);
          }
          color *= 1.0 - edge * edgeStrength;
          vec3 graded = color;
          float signalPeak = max(graded.r, max(graded.g, graded.b));
          float redOverGreen = graded.r / max(graded.g, 0.001);
          float blueOverGreen = graded.b / max(graded.g, 0.001);
          float redBlueBalance = min(graded.r, graded.b) / max(max(graded.r, graded.b), 0.001);
          float magentaMask = smoothstep(1.28, 2.1, redOverGreen)
            * smoothstep(1.18, 1.95, blueOverGreen)
            * smoothstep(0.48, 0.82, redBlueBalance);
          vec3 magentaRoute = vec3(signalPeak, signalPeak * 0.13, signalPeak * 0.7);
          graded = mix(graded, magentaRoute, routeHueSeparation * magentaMask * 0.82);
          float gradeLuma = luma(graded);
          float maxChannel = max(graded.r, max(graded.g, graded.b));
          float minChannel = min(graded.r, min(graded.g, graded.b));
          float neutralMask = 1.0 - smoothstep(0.055, 0.24, maxChannel - minChannel);
          float neutralRange = smoothstep(0.08, 0.3, gradeLuma)
            * (1.0 - smoothstep(1.35, 2.2, gradeLuma));
          graded *= 1.0 - neutralDarken * neutralMask * neutralRange;
          graded = max(vec3(0.0), (graded - 0.2) * gradeContrast + 0.2);
          float shadowMask = 1.0 - smoothstep(0.2, 0.68, luma(graded));
          graded = mix(graded, graded * vec3(0.93, 0.985, 1.04), shadowCool * shadowMask);
          graded += vec3(shadowLift * (1.0 - smoothstep(0.04, 0.24, luma(graded))));
          color = mix(color, graded, gradeStrength);
          color = mix(vec3(luma(color)), color, saturation);
          float radial = smoothstep(0.92, 0.2, length(vUv - 0.5));
          color *= mix(1.0 - vignette, 1.0, radial);
          gl_FragColor = vec4(color, 1.0);
        }`,
    });
    composer.addPass(this.inkPass);
    composer.addPass(new OutputPass());
    return composer;
  }

  private resizePostProcessing(): void {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    const dpr = getRenderDpr(this.renderDprCap);
    // Post-processing is fill-rate bound and does not benefit materially from
    // the extra 1.25x canvas samples. Keep the final canvas crisp while using
    // a 1x intermediate buffer for bloom, ink, and tone/output passes.
    const postDpr = Math.min(dpr, 1);
    this.composer.setPixelRatio(postDpr);
    this.composer.setSize(width, height);
    this.inkPass.uniforms.resolution.value.set(width * postDpr, height * postDpr);
  }

  private createSky(bright = false): THREE.Mesh {
    const uniforms = {
      uTop: { value: new THREE.Color(bright ? 0x4a95cc : 0x152a43) },
      uHorizon: { value: new THREE.Color(bright ? 0xa9d2e4 : 0x83a8b6) },
      uLower: { value: new THREE.Color(bright ? 0xd0dfe0 : 0x2d5567) },
      uStorm: { value: new THREE.Color(bright ? 0x789db2 : 0x101c31) },
      uSunColor: { value: new THREE.Color(0xffd7a4) },
      uSunDir: { value: new THREE.Vector3(bright ? -0.62 : 0.62, bright ? 0.38 : 0.22, bright ? -0.55 : 0.55).normalize() },
      uCloudStrength: { value: bright ? 0.1 : 0.88 },
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(850, 40, 22),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms,
        vertexShader: `varying vec3 vDir;
          void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `varying vec3 vDir;
          uniform vec3 uTop, uHorizon, uLower, uStorm, uSunColor, uSunDir;
          uniform float uCloudStrength;
          float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
          float noise(vec2 p){
            vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
            return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
          }
          void main(){
            float elevation = clamp(vDir.y, 0.0, 1.0);
            vec3 upper = mix(uHorizon, uTop, pow(elevation, 0.58));
            vec3 col = mix(uLower, upper, smoothstep(-0.18, 0.055, vDir.y));
            float azimuth = atan(vDir.z, vDir.x);
            float cloudNoise = noise(vec2(azimuth * 2.8, vDir.y * 7.0)) * 0.62
              + noise(vec2(azimuth * 6.2 + 4.0, vDir.y * 13.0)) * 0.38;
            float stormSide = smoothstep(-0.3, 0.68, -vDir.x - vDir.z * 0.38);
            float clouds = smoothstep(0.38, 0.7, cloudNoise + (uCloudStrength < 0.7 ? 0.1 : 0.0) + stormSide * 0.24)
              * smoothstep(-0.02, 0.42, vDir.y);
            col = mix(col, uStorm, clouds * uCloudStrength);
            float d = clamp(dot(normalize(vDir), normalize(uSunDir)), 0.0, 1.0);
            col += uSunColor * (pow(d, 900.0) * 1.25 + pow(d, 14.0) * 0.11);
            gl_FragColor = vec4(col, 1.0);
          }`,
      }),
    );
    sky.frustumCulled = false;
    sky.name = 'GraphicSkyDome';
    return sky;
  }

  private createBots(): void {
    for (let id = 0; id < 3; id += 1) {
      const bot = new Bot(id, BOT_COLORS[id], this.selectSafeSpawn(id), this.arena);
      this.bots.push(bot);
      this.scene.add(bot.group);
    }
  }

  private registerWorldHealthBars(): void {
    for (const bot of this.bots) {
      this.worldHealthBars.register({
        id: `bot-${bot.id}`,
        kind: 'person',
        position: bot.group.position,
        // Armor is part of the character's visible survivability envelope, so
        // incoming damage always changes the compact meter immediately.
        value: () => bot.health + bot.armor,
        maximum: () => 150,
        visible: () => bot.alive && bot.group.visible && !this.fighterForPilot(bot.id),
        anchorHeight: () => Math.max(2.2, bot.modelCenterY + bot.modelHeight * 0.5 + 0.34),
      });
    }
    for (const drone of this.droneSwarm.combatDrones) {
      this.worldHealthBars.register({
        id: drone.id,
        kind: 'drone',
        position: drone.position,
        value: () => drone.health,
        maximum: () => drone.maxHealth,
        visible: () => drone.alive && drone.visual.root.visible,
        anchorHeight: () => Math.max(
          drone.collisionRadius + 0.7,
          drone.visual.modelHeight * 0.5 + 0.48,
        ),
      });
    }
    for (const fighter of this.fighters) {
      this.worldHealthBars.register({
        id: fighter.id,
        kind: 'craft',
        position: fighter.flight.position,
        value: () => fighter.hull + fighter.shield,
        maximum: () => FIGHTER_HULL_MAX + FIGHTER_SHIELD_MAX,
        visible: () => !fighter.destroyed && fighter !== this.playerFighter && fighter.visual.root.visible,
        anchorHeight: () => Math.max(4.2, fighter.visual.collisionHalfExtents.y + 1.15),
      });
    }
  }

  private createPickups(): void {
    const definitions: Array<[PickupKind, string, number, offset?: readonly [number, number]]> = [
      ['health', 'health-a', 20],
      ['health', 'health-b', 20],
      ['armor', 'armor', 30],
      ['damage', 'damage', POWERUP.respawn],
      ['speed', 'speed', POWERUP.respawn],
      ['rail', 'rail', POWERUP.railRespawn],
      ['rocket', 'rocket', 25],
      ['disc', 'rocket', 28, [3.2, -1.8]],
      ['plasma', 'plasma', 25],
      ['shotgun', 'shotgun', 25],
      ['sniper', 'sniper', 30],
      ['laser', 'laser', 25],
    ];
    definitions.forEach(([kind, point, respawn, offset], index) => {
      const group = this.createPickupModel(kind);
      const authored = this.arena.itemPoints[point].clone();
      if (offset) authored.add(new THREE.Vector3(offset[0], 0, offset[1]));
      // The authored point is only an XY hint; the support surface may be a
      // raised ramp, landing roof, or banked route above that hint. Resolve
      // the highest real support at the point so the pickup cannot be buried
      // in a lower floor or clipped through a ramp deck.
      const floor = this.arena.floorHeightAt(authored.x, authored.z, Number.POSITIVE_INFINITY) ?? authored.y - 0.9;
      group.position.set(authored.x, floor + 0.012, authored.z);
      group.userData.baseY = floor + 0.012;
      const supportNormal = this.arena.surfaceNormalAt?.(authored.x, authored.z, Number.POSITIVE_INFINITY);
      if (supportNormal) {
        group.quaternion.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, supportNormal);
      }
      group.userData.phase = index * 0.73;
      this.scene.add(group);
      this.pickups.push({ kind, group, active: true, cooldown: 0, respawn });
    });
  }

  private createPickupModel(kind: PickupKind): THREE.Group {
    const group = new THREE.Group();
    group.name = `${kind}-grounded-pickup`;
    const color = this.weaponColorForPickup(kind);
    const accent = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color).multiplyScalar(0.74),
      emissive: color,
      emissiveIntensity: 0.82,
      roughness: 0.25,
      metalness: 0.48,
    });
    const dark = new THREE.MeshStandardMaterial({ color: 0x101822, roughness: 0.48, metalness: 0.72 });
    const pale = new THREE.MeshStandardMaterial({ color: 0x9eacb4, roughness: 0.34, metalness: 0.36 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x05080d, roughness: 0.9, metalness: 0.05 });
    const add = (
      name: string,
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      position: [number, number, number],
      rotation: [number, number, number] = [0, 0, 0],
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = name;
      mesh.position.set(...position);
      mesh.rotation.set(...rotation);
      // Pickups are emissive readability props, not world architecture. Their
      // former dynamic shadows duplicated the full weapon geometry in every
      // shadow refresh and dominated the scene's submitted triangle budget.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      group.add(mesh);
      return mesh;
    };

    add('pickup-floor-rack', new THREE.CylinderGeometry(0.7, 0.78, 0.12, 12), dark, [0, 0.06, 0]);
    const ring = add('pickup-id-ring', new THREE.TorusGeometry(0.55, 0.026, 6, 30), accent, [0, 0.14, 0], [Math.PI * 0.5, 0, 0]);
    ring.userData.pickupGlow = true;
    const rotor = new THREE.Group();
    rotor.name = 'pickup-id-rotor';
    rotor.position.y = 0.16;
    group.add(rotor);

    const isWeapon = kind === 'rail' || kind === 'rocket' || kind === 'plasma'
      || kind === 'shotgun' || kind === 'sniper' || kind === 'laser' || kind === 'disc';
    if (isWeapon) {
      group.add(this.createWeaponPickupLod(kind, dark, accent));
      for (const side of [-1, 1]) {
        add(`weapon-rack-${side}`, new THREE.BoxGeometry(0.1, 0.34, 0.18), rubber, [side * 0.34, 0.3, 0]);
        add(`weapon-clamp-${side}`, new THREE.TorusGeometry(0.12, 0.025, 6, 16, Math.PI), accent, [side * 0.34, 0.48, 0], [0, Math.PI * 0.5, 0]);
      }
    } else if (kind === 'health') {
      add('medkit-case', new THREE.BoxGeometry(0.76, 0.46, 0.46), pale, [0, 0.43, 0]);
      add('medkit-latch', new THREE.BoxGeometry(0.82, 0.08, 0.18), dark, [0, 0.43, 0.2]);
      add('medkit-cross-v', new THREE.BoxGeometry(0.12, 0.29, 0.025), accent, [0, 0.43, 0.245]);
      add('medkit-cross-h', new THREE.BoxGeometry(0.3, 0.11, 0.025), accent, [0, 0.43, 0.246]);
      for (const side of [-1, 1]) add(`medkit-canister-${side}`, new THREE.CylinderGeometry(0.08, 0.08, 0.44, 12), accent, [side * 0.3, 0.43, -0.23], [Math.PI * 0.5, 0, 0]);
    } else if (kind === 'armor') {
      const shieldShape = new THREE.Shape();
      shieldShape.moveTo(-0.43, 0.32);
      shieldShape.lineTo(-0.34, -0.26);
      shieldShape.lineTo(0, -0.48);
      shieldShape.lineTo(0.34, -0.26);
      shieldShape.lineTo(0.43, 0.32);
      shieldShape.lineTo(0, 0.48);
      shieldShape.closePath();
      const plate = add('armor-chest-plate', new THREE.ExtrudeGeometry(shieldShape, { depth: 0.14, bevelEnabled: true, bevelSize: 0.035, bevelThickness: 0.035, bevelSegments: 2 }), pale, [0, 0.66, 0], [0, 0, 0]);
      plate.geometry.center();
      add('armor-energy-spine', new THREE.BoxGeometry(0.1, 0.62, 0.18), accent, [0, 0.66, 0.12]);
      for (const side of [-1, 1]) add(`armor-shoulder-${side}`, new THREE.BoxGeometry(0.32, 0.18, 0.32), dark, [side * 0.4, 0.68, 0]);
    } else {
      const isDamage = kind === 'damage';
      add(`${kind}-power-cell`, new THREE.CylinderGeometry(0.2, 0.2, 0.62, 16), accent, [0, 0.5, 0]);
      add(`${kind}-power-core`, new THREE.CylinderGeometry(0.095, 0.095, 0.7, 14), pale, [0, 0.5, 0]);
      for (let index = 0; index < 4; index += 1) {
        const angle = index * Math.PI * 0.5;
        const x = Math.cos(angle) * 0.31;
        const z = Math.sin(angle) * 0.31;
        add(`${kind}-module-${index}`, isDamage ? new THREE.BoxGeometry(0.14, 0.42, 0.2) : new THREE.CylinderGeometry(0.08, 0.12, 0.42, 10), index % 2 ? dark : accent, [x, 0.48, z], [0, -angle, 0]);
      }
      const halo = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.035, 8, 28), accent);
      halo.name = `${kind}-stabilizer`;
      halo.rotation.x = Math.PI * 0.5;
      halo.userData.pickupGlow = true;
      rotor.add(halo);
    }
    this.compactPickupModel(group);
    return group;
  }

  private createWeaponPickupLod(
    kind: WeaponId,
    dark: THREE.MeshStandardMaterial,
    accent: THREE.MeshStandardMaterial,
  ): THREE.Group {
    const root = new THREE.Group();
    root.name = `${kind}-pickup-weapon-model`;
    root.position.set(0, 0.58, 0);
    root.rotation.set(-0.06, 0.18, kind === 'rocket' ? -0.08 : 0);

    const longWeapon = kind === 'rail' || kind === 'sniper' || kind === 'laser';
    const bodyLength = longWeapon ? 1.42 : kind === 'rocket' ? 1.18 : 1.02;
    const bodyHeight = kind === 'rocket' ? 0.31 : 0.24;
    const bodyDepth = kind === 'disc' ? 0.4 : kind === 'rocket' ? 0.38 : 0.31;
    const bodyParts: THREE.BufferGeometry[] = [];
    const receiver = new THREE.BoxGeometry(bodyLength * 0.64, bodyHeight, bodyDepth);
    receiver.translate(-bodyLength * 0.06, 0, 0);
    bodyParts.push(receiver);
    const stock = new THREE.BoxGeometry(bodyLength * 0.3, bodyHeight * 0.82, bodyDepth * 0.84);
    stock.translate(-bodyLength * 0.46, -bodyHeight * 0.04, 0);
    bodyParts.push(stock);
    if (kind === 'sniper' || kind === 'rail') {
      const upper = new THREE.BoxGeometry(bodyLength * 0.42, bodyHeight * 0.4, bodyDepth * 0.62);
      upper.translate(-bodyLength * 0.02, bodyHeight * 0.58, 0);
      bodyParts.push(upper);
    }
    const mergedBody = mergeGeometries(bodyParts, false);
    for (const geometry of bodyParts) geometry.dispose();
    if (mergedBody) {
      const mesh = new THREE.Mesh(mergedBody, dark);
      mesh.name = `${kind}-pickup-lod-body`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      root.add(mesh);
    }

    const barrelParts: THREE.BufferGeometry[] = [];
    const barrelLength = longWeapon ? 0.92 : kind === 'rocket' ? 0.74 : 0.62;
    const barrelRadius = kind === 'rocket' ? 0.13 : kind === 'shotgun' ? 0.055 : 0.045;
    const barrelCount = kind === 'shotgun' ? 2 : 1;
    for (let index = 0; index < barrelCount; index += 1) {
      const barrel = new THREE.CylinderGeometry(barrelRadius, barrelRadius * 1.08, barrelLength, 8);
      barrel.rotateZ(Math.PI * 0.5);
      barrel.translate(bodyLength * 0.34 + barrelLength * 0.5, 0, (index - (barrelCount - 1) * 0.5) * 0.13);
      barrelParts.push(barrel);
    }
    if (kind === 'plasma') {
      const chamber = new THREE.SphereGeometry(0.19, 8, 5);
      chamber.translate(bodyLength * 0.12, 0.03, 0);
      barrelParts.push(chamber);
    }
    const mergedBarrel = mergeGeometries(barrelParts, false);
    for (const geometry of barrelParts) geometry.dispose();
    if (mergedBarrel) {
      const mesh = new THREE.Mesh(mergedBarrel, dark);
      mesh.name = `${kind}-pickup-lod-barrel`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      root.add(mesh);
    }

    const signature = kind === 'disc'
      ? new THREE.TorusGeometry(0.29, 0.055, 6, 18)
      : kind === 'rocket'
        ? new THREE.CylinderGeometry(0.17, 0.17, 0.18, 8)
        : new THREE.BoxGeometry(longWeapon ? 0.42 : 0.28, bodyHeight * 0.28, bodyDepth * 1.04);
    if (kind === 'rocket') {
      signature.rotateZ(Math.PI * 0.5);
      signature.translate(bodyLength * 0.25, 0, 0);
    } else if (kind === 'disc') {
      signature.rotateY(Math.PI * 0.5);
      signature.translate(bodyLength * 0.05, bodyHeight * 0.52, 0);
    } else {
      signature.translate(bodyLength * 0.08, bodyHeight * 0.52, 0);
    }
    const signatureMesh = new THREE.Mesh(signature, accent);
    signatureMesh.name = `${kind}-pickup-lod-signature`;
    signatureMesh.castShadow = false;
    signatureMesh.receiveShadow = false;
    root.add(signatureMesh);
    this.compactPickupModel(root);
    return root;
  }

  private compactPickupModel(group: THREE.Group): void {
    // Pickup sub-parts are authored as separate meshes for readability while
    // building them. Batch only direct, non-animated parts by material once
    // the shape is complete; glow rings and rotors remain independent so their
    // state animation and readability are unchanged.
    const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const sourceMeshes: THREE.Mesh[] = [];
    for (const child of [...group.children]) {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.pickupGlow || Array.isArray(mesh.material)) continue;
      mesh.updateMatrix();
      let geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      geometry.applyMatrix4(mesh.matrix);
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
      if (!geometry.getAttribute('uv')) {
        geometry.setAttribute(
          'uv',
          new THREE.Float32BufferAttribute(geometry.getAttribute('position').count * 2, 2),
        );
      }
      for (const attribute of Object.keys(geometry.attributes)) {
        if (attribute !== 'position' && attribute !== 'normal' && attribute !== 'uv') geometry.deleteAttribute(attribute);
      }
      const entries = batches.get(mesh.material) ?? [];
      entries.push(geometry);
      batches.set(mesh.material, entries);
      sourceMeshes.push(mesh);
    }

    for (const mesh of sourceMeshes) {
      group.remove(mesh);
      mesh.geometry.dispose();
    }
    const materials: THREE.Material[] = [];
    const mergedParts: THREE.BufferGeometry[] = [];
    for (const [material, geometries] of batches) {
      const merged = mergeGeometries(geometries, false);
      for (const geometry of geometries) geometry.dispose();
      if (merged) {
        materials.push(material);
        mergedParts.push(merged);
      }
    }
    const merged = mergeGeometries(mergedParts, true);
    for (const geometry of mergedParts) geometry.dispose();
    if (merged) {
      const mesh = new THREE.Mesh(merged, materials.length === 1 ? materials[0] : materials);
      mesh.name = 'pickup-static-material-batches';
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      group.add(mesh);
    }
  }

  private createCore(): void {
    const shell = new THREE.MeshToonMaterial({ color: 0x6cf6ff, emissive: 0x20dfff, emissiveIntensity: 2 });
    const dark = new THREE.MeshToonMaterial({ color: 0x151a36 });
    const crystal = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9, 1), shell);
    const cage = new THREE.Mesh(new THREE.IcosahedronGeometry(1.35, 1), dark);
    cage.material.wireframe = true;
    this.coreGroup.add(crystal, cage);
    this.coreGroup.position.copy(this.arena.corePosition).add(new THREE.Vector3(0, 2.4, 0));
    this.coreGroup.visible = false;
    this.scene.add(this.coreGroup);
  }

  private buildWeaponModel(): void {
    this.weaponVfx.stopContinuousLaser();
    this.audio.setLaserBeamActive(false);
    if (this.inspectionWeaponVisual) {
      this.disposeObject(this.inspectionWeaponVisual.root);
      this.inspectionWeaponVisual = undefined;
    }
    this.weaponModel.clear();
    this.thirdPersonWeaponModel.clear();
    const definition = WEAPONS[this.selectedWeapon];
    if (this.weaponInspectionMode) {
      this.weaponVisual = createWeaponViewModel(definition, false, false);
      this.inspectionWeaponVisual = this.weaponVisual;
    } else {
      this.weaponVisual = this.weaponVisualCache.get(definition.id);
      if (!this.weaponVisual) {
        this.weaponVisual = createWeaponViewModel(definition, true, true);
        this.weaponVisualCache.set(definition.id, this.weaponVisual);
      }
    }
    if (this.weaponInspectionMode) {
      const bounds = new THREE.Box3().setFromObject(this.weaponVisual.root);
      const center = bounds.getCenter(new THREE.Vector3());
      this.weaponVisual.root.position.sub(center);
    }
    this.muzzleSocket = this.weaponVisual.muzzleSocket;
    this.weaponModel.add(this.weaponVisual.root);
    this.weaponModel.scale.setScalar(1);
    this.weaponModel.position.set(0.3, -0.54, -0.5);
    this.weaponModel.rotation.set(0, 0, 0);

    if (this.weaponInspectionMode) {
      this.thirdPersonWeaponVisual = undefined;
      this.thirdPersonWeaponModel.visible = false;
      return;
    }
    this.thirdPersonWeaponVisual = this.thirdPersonWeaponCache.get(definition.id);
    if (!this.thirdPersonWeaponVisual) {
      this.thirdPersonWeaponVisual = this.createThirdPersonWeaponClone(this.weaponVisual);
      this.thirdPersonWeaponCache.set(definition.id, this.thirdPersonWeaponVisual);
    }
    this.thirdPersonWeaponModel.add(this.thirdPersonWeaponVisual.root);
    this.thirdPersonWeaponModel.scale.setScalar(THIRD_PERSON_WEAPON_SCALE[definition.id]);
    this.thirdPersonWeaponModel.visible = this.isThirdPerson();
  }

  private createThirdPersonWeaponClone(source: WeaponViewModel): WeaponViewModel {
    // Clone the already-batched combat frame so third person gets the exact
    // equipped weapon without rebuilding geometry or duplicating its 256px
    // wear-texture set. Meshes share immutable GPU resources; transforms and
    // animation state remain independent.
    const root = source.root.clone(true);
    root.name = `${source.weapon}-third-person-world-model`;
    root.getObjectByName('first-person-armature')?.removeFromParent();
    const animationNodes = new Map<string, THREE.Object3D>();
    root.traverse((object) => {
      if (object.name) animationNodes.set(object.name, object);
      object.userData.weaponAnimationBase = {
        position: object.position.clone(),
        rotation: object.rotation.clone(),
        scale: object.scale.clone(),
      };
    });
    const muzzleSocket = root.getObjectByName(`${source.weapon}-muzzle-socket`);
    if (!muzzleSocket) throw new Error(`Missing third-person muzzle socket for ${source.weapon}`);
    const mapAnimatedNodes = (nodes: THREE.Object3D[]): THREE.Object3D[] => nodes
      .map((node) => animationNodes.get(node.name))
      .filter((node): node is THREE.Object3D => Boolean(node));
    return {
      root,
      muzzleSocket,
      animatedRotors: mapAnimatedNodes(source.animatedRotors),
      animatedSlides: mapAnimatedNodes(source.animatedSlides),
      animationNodes,
      animationState: {
        lastElapsed: Number.NaN,
        lastRecoil: 0,
        shotAge: Number.POSITIVE_INFINITY,
        shotStrength: 0,
        rotorAngle: 0,
        rotorVelocity: 0,
      },
      // Materials are shared with the active first-person cache, whose update
      // already owns emissive pulses. The world clone only needs rigid-node
      // animation and therefore must not write the shared material twice.
      pulseMaterials: [],
      pulseBaseIntensities: [],
      battleWearMaterialCount: source.battleWearMaterialCount,
      battleWearTextureCount: source.battleWearTextureCount,
      assetSource: source.assetSource,
      meshCount: source.meshCount,
      renderMeshCount: source.renderMeshCount,
      triangleCount: source.triangleCount,
      weapon: source.weapon,
    };
  }

  private spawnBurst(position: THREE.Vector3, color: number, count: number): void {
    this.weaponVfx.burst(position, color, count);
  }

  private removeProjectile(index: number): void {
    const projectile = this.projectiles[index];
    this.scene.remove(projectile.root);
    this.disposeObject(projectile.root);
    this.projectiles.splice(index, 1);
  }

  private removeGrenade(index: number): void {
    const grenade = this.grenades[index];
    if (!grenade) return;
    grenade.root.parent?.remove(grenade.root);
    this.disposeObject(grenade.root);
    this.grenades.splice(index, 1);
  }

  private clearGrenades(): void {
    for (let index = this.grenades.length - 1; index >= 0; index -= 1) this.removeGrenade(index);
  }

  private handleWeaponRequest(): void {
    const request = this.input.consumeWeaponRequest();
    if (request === null) return;
    const previousWeapon = this.selectedWeapon;
    if (request === 100 || request === -100) {
      const step = request > 0 ? 1 : -1;
      for (let offset = 1; offset <= WEAPONS.length; offset += 1) {
        const candidate = (this.selectedWeapon + step * offset + WEAPONS.length * 2) % WEAPONS.length;
        if ((this.ammo.get(WEAPONS[candidate].id) ?? 0) !== 0) {
          this.selectedWeapon = candidate;
          break;
        }
      }
    } else {
      const candidate = THREE.MathUtils.clamp(request, 0, WEAPONS.length - 1);
      if ((this.ammo.get(WEAPONS[candidate].id) ?? 0) === 0) {
        this.hud.message(`${WEAPONS[candidate].shortName} AMMO REQUIRED`);
        return;
      }
      this.selectedWeapon = candidate;
    }
    this.buildWeaponModel();
    if (this.selectedWeapon !== previousWeapon) this.audio.weaponSwitch(WEAPONS[this.selectedWeapon].id);
  }

  private sniperScopeRequested(): boolean {
    return this.mode === 'running'
      && WEAPONS[this.selectedWeapon].id === 'sniper'
      && this.input.isZoomHeld();
  }

  private viewDirection(target = new THREE.Vector3()): THREE.Vector3 {
    const cosPitch = Math.cos(this.pitch);
    return target.set(-Math.sin(this.yaw) * cosPitch, Math.sin(this.pitch), -Math.cos(this.yaw) * cosPitch).normalize();
  }

  private damageMultiplier(): number {
    return this.damageBoost > 0 ? 1.5 : 1;
  }

  private weapon(id: WeaponId): WeaponDefinition {
    const definition = WEAPONS.find((candidate) => candidate.id === id);
    if (!definition) throw new Error(`Missing weapon definition: ${id}`);
    return definition;
  }

  private resetPlayerLoadout(): void {
    for (const weapon of WEAPONS) {
      // Rail used zero as its pickup-only sentinel; the default all-guns
      // loadout grants a compact three-shot reserve while every other weapon
      // starts at its authored full ammo value.
      this.ammo.set(weapon.id, weapon.id === 'rail' ? 3 : weapon.ammo);
    }
    this.selectedWeapon = 0;
  }

  private weaponColorForPickup(kind: PickupKind): number {
    if (kind === 'health') return 0x5dff8b;
    if (kind === 'armor') return 0x45dfff;
    if (kind === 'damage') return 0xff704f;
    if (kind === 'speed') return 0xe8ff4f;
    return this.weapon(kind).color;
  }

  private noise(time: number, seed: number): number {
    const value = Math.sin(time * 12.9898 + seed * 78.233) * 43758.5453;
    return (value - Math.floor(value)) * 2 - 1;
  }

  private quickSenseStructureAudit(): QuickSenseStructureAudit[] {
    if (this.arena.mapInfo.name !== 'QuickSense') return [];
    const manifest = this.arena.group.userData.buildings as Array<{
      name: string;
      category: string;
      profile: string;
      accent: string;
      position: { x: number; y: number; z: number };
    }> | undefined;
    if (!Array.isArray(manifest)) return [];

    this.arena.group.updateMatrixWorld(true);
    return manifest.map((entry) => {
      const id = entry.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      const marker = this.arena.group.getObjectByName(`QuickSense building: ${entry.name}`);
      const worldPosition = marker
        ? marker.getWorldPosition(new THREE.Vector3())
        : new THREE.Vector3(entry.position.x, entry.position.y, entry.position.z)
          .applyMatrix4(this.arena.group.matrixWorld);
      return {
        id,
        name: entry.name,
        category: entry.category,
        profile: entry.profile,
        accent: entry.accent,
        state: `quicksense-structure-${id}`,
        connection: entry.category === 'floating-station' ? 'terrain-tethers' : 'terrain-foundation',
        position: { x: worldPosition.x, y: worldPosition.y, z: worldPosition.z },
      };
    });
  }

  private setQuickSenseStructureCapture(id: string): boolean {
    const structure = this.quickSenseStructureAudit().find((candidate) => candidate.id === id);
    if (!structure) return false;

    const center = new THREE.Vector3(structure.position.x, structure.position.y, structure.position.z);
    const authoredViews: Record<string, { camera: THREE.Vector3; target: THREE.Vector3; fov: number }> = {
      'north-gate-west-house': { camera: new THREE.Vector3(-52, 42, 70), target: new THREE.Vector3(-21, 21, 122), fov: 52 },
      'north-gate-east-house': { camera: new THREE.Vector3(52, 42, 70), target: new THREE.Vector3(21, 21, 122), fov: 52 },
      'south-launch-west-house': { camera: new THREE.Vector3(-52, 34, -70), target: new THREE.Vector3(-21, 8, -122), fov: 52 },
      'south-launch-east-house': { camera: new THREE.Vector3(52, 34, -70), target: new THREE.Vector3(21, 8, -122), fov: 52 },
      'flux-core-citadel': { camera: new THREE.Vector3(-52, 58, -72), target: new THREE.Vector3(0, 31, 0), fov: 54 },
      'cyan-grapple-tower': { camera: new THREE.Vector3(-86, 52, -44), target: new THREE.Vector3(-46, 32, 14), fov: 52 },
      'magenta-grapple-tower': { camera: new THREE.Vector3(86, 52, -44), target: new THREE.Vector3(46, 32, 14), fov: 52 },
      'north-grapple-gate': { camera: new THREE.Vector3(48, 62, 34), target: new THREE.Vector3(0, 35, 94), fov: 54 },
      'southwest-forge': { camera: new THREE.Vector3(-82, 44, -112), target: new THREE.Vector3(-134, 45, -172), fov: 52 },
      'southeast-smelter': { camera: new THREE.Vector3(82, 48, -112), target: new THREE.Vector3(134, 50, -172), fov: 52 },
      'northwest-lens': { camera: new THREE.Vector3(-74, 52, 112), target: new THREE.Vector3(-110, 58, 172), fov: 52 },
      'northeast-array': { camera: new THREE.Vector3(74, 56, 112), target: new THREE.Vector3(110, 62, 172), fov: 52 },
      'west-scar-relay': { camera: new THREE.Vector3(-130, 55, -78), target: new THREE.Vector3(-198, 58, -78), fov: 52 },
      'west-crown-habitat': { camera: new THREE.Vector3(-130, 65, 80), target: new THREE.Vector3(-198, 70, 80), fov: 52 },
      'east-crown-habitat': { camera: new THREE.Vector3(130, 65, -80), target: new THREE.Vector3(198, 72, -80), fov: 52 },
      'east-scar-relay': { camera: new THREE.Vector3(130, 57, 78), target: new THREE.Vector3(198, 62, 78), fov: 52 },
      'cyan-skydock': { camera: new THREE.Vector3(-68, 94, -24), target: new THREE.Vector3(-116, 52, 46), fov: 56 },
      'magenta-needle-dock': { camera: new THREE.Vector3(68, 100, -24), target: new THREE.Vector3(116, 55, 46), fov: 56 },
      'amber-command-ark': { camera: new THREE.Vector3(70, 114, 36), target: new THREE.Vector3(0, 64, 116), fov: 58 },
      'cyan-skyline-pylon': { camera: new THREE.Vector3(-108, 64, -92), target: new THREE.Vector3(-169, 38, -32), fov: 54 },
      'magenta-skyline-pylon': { camera: new THREE.Vector3(108, 64, -28), target: new THREE.Vector3(169, 38, 32), fov: 54 },
      'outpost-tower': { camera: new THREE.Vector3(-112, 98, -126), target: new THREE.Vector3(0, 68, 0), fov: 58 },
    };
    let view = authoredViews[id];
    if (!view) {
      const radial = new THREE.Vector3(center.x, 0, center.z);
      if (radial.lengthSq() < 64) radial.set(0, 0, 1);
      else radial.normalize();
      view = {
        camera: center.clone().addScaledVector(radial, -72).setY(Math.max(32, center.y + 18)),
        target: center.clone(),
        fov: 54,
      };
    }

    this.mode = 'running';
    this.audio.setPaused(true);
    this.screenshotCameraFov = view.fov;
    this.playerPosition.copy(view.camera);
    this.playerVelocity.set(0, 0, 0);
    this.screenshotLookTarget.copy(view.target);
    this.screenshotLookTargetActive = true;
    const viewDirection = this.screenshotLookTarget.clone().sub(
      this.playerPosition.clone().add(new THREE.Vector3(0, PLAYER_EYE, 0)),
    ).normalize();
    this.yaw = Math.atan2(-viewDirection.x, -viewDirection.z);
    this.pitch = Math.asin(viewDirection.y);
    this.grounded = false;
    this.weaponModel.visible = false;
    return true;
  }

  private setQuickSenseTowerSectionCapture(id: string): boolean {
    const audit = this.arena.group.userData.outpostTowerAudit as QuickSenseOutpostTowerAudit | undefined;
    if (!audit) return false;
    const boundsCenter = new THREE.Vector3(
      (audit.bounds.min.x + audit.bounds.max.x) * 0.5,
      (audit.bounds.min.y + audit.bounds.max.y) * 0.5,
      (audit.bounds.min.z + audit.bounds.max.z) * 0.5,
    );
    const exteriorDistance = Math.max(
      120,
      (audit.bounds.max.x - audit.bounds.min.x) * 1.35,
      (audit.bounds.max.z - audit.bounds.min.z) * 1.35,
    );
    const exteriorCameraY = audit.bounds.min.y + 114;
    const routeView = (index: number, fov = 72): { camera: THREE.Vector3; target: THREE.Vector3; fov: number } => {
      const stair = audit.grounding.accessStairs[index];
      const start = new THREE.Vector3(stair.start.x, stair.start.y, stair.start.z);
      const end = new THREE.Vector3(stair.end.x, stair.end.y, stair.end.z);
      const approach = end.clone().sub(start).setY(0);
      if (approach.lengthSq() > 0.001) start.addScaledVector(approach.normalize(), -0.7);
      return {
        // Capture positions are player feet; updateCamera adds PLAYER_EYE.
        camera: start,
        target: end.add(new THREE.Vector3(0, PLAYER_EYE * 0.8, 0)),
        fov,
      };
    };
    const lowerFloorY = audit.grounding.accessStairs[1].start.y;
    const views: Record<string, { camera: THREE.Vector3; target: THREE.Vector3; fov: number }> = {
      'exterior-south': {
        camera: new THREE.Vector3(boundsCenter.x, exteriorCameraY, boundsCenter.z - exteriorDistance),
        target: boundsCenter,
        fov: 76,
      },
      'exterior-east': {
        camera: new THREE.Vector3(boundsCenter.x + exteriorDistance, exteriorCameraY, boundsCenter.z),
        target: boundsCenter,
        fov: 76,
      },
      'exterior-north': {
        camera: new THREE.Vector3(boundsCenter.x, exteriorCameraY, boundsCenter.z + exteriorDistance),
        target: boundsCenter,
        fov: 76,
      },
      'exterior-west': {
        camera: new THREE.Vector3(boundsCenter.x - exteriorDistance, exteriorCameraY, boundsCenter.z),
        target: boundsCenter,
        fov: 76,
      },
      'terrain-entry-east': routeView(0, 70),
      'lower-hall-east': {
        camera: new THREE.Vector3(18, lowerFloorY, 0),
        target: new THREE.Vector3(-8, lowerFloorY + PLAYER_EYE, 0),
        fov: 72,
      },
      'lower-hall-west': {
        camera: new THREE.Vector3(-18, lowerFloorY, 0),
        target: new THREE.Vector3(8, lowerFloorY + PLAYER_EYE, 0),
        fov: 72,
      },
      'stair-landing-player': routeView(1, 74),
      'mid-stair-player': routeView(4, 72),
      'interior-stair-player': routeView(7, 72),
      'flight-deck-south': {
        camera: new THREE.Vector3(0, 27, -42),
        target: new THREE.Vector3(0, 30, -5),
        fov: 68,
      },
      'flight-deck-north': {
        camera: new THREE.Vector3(0, 27, 32),
        target: new THREE.Vector3(0, 30, 2),
        fov: 68,
      },
      'upper-shaft': {
        camera: new THREE.Vector3(0, 40, -14),
        target: new THREE.Vector3(0, 58, -3),
        fov: 70,
      },
      'upper-landing': {
        camera: new THREE.Vector3(0, 64, -12),
        target: new THREE.Vector3(0, 82, -3),
        fov: 70,
      },
      'top-platform': {
        camera: new THREE.Vector3(0, 86, -14),
        target: new THREE.Vector3(0, audit.bounds.max.y - 2, -2),
        fov: 68,
      },
    };
    const view = views[id];
    if (!view) return false;
    this.mode = 'running';
    this.audio.setPaused(true);
    this.screenshotCameraFov = view.fov;
    this.playerPosition.copy(view.camera);
    this.playerVelocity.set(0, 0, 0);
    this.screenshotLookTarget.copy(view.target);
    this.screenshotLookTargetActive = true;
    const viewDirection = this.screenshotLookTarget.clone().sub(
      this.playerPosition.clone().add(new THREE.Vector3(0, PLAYER_EYE, 0)),
    ).normalize();
    this.yaw = Math.atan2(-viewDirection.x, -viewDirection.z);
    this.pitch = Math.asin(viewDirection.y);
    this.grounded = false;
    this.weaponModel.visible = false;
    return true;
  }

  private installTestHooks(): void {
    window.__THREE_GAME_TEST_HOOKS__ = {
      seed: (value: number) => {
        this.rng = createSeededRandom(value);
      },
      setState: (name: string) => {
        this.cancelMatchCountdown();
        this.jetpackActive = false;
        this.jetpackEnergy.reset();
        this.pausedForScreenshot = false;
        this.screenshotArenaTime = 0;
        this.screenshotCameraFov = BASE_GAME_FOV;
        this.screenshotLookTargetActive = false;
        this.weaponModel.visible = !this.isThirdPerson();
        this.input.consumeJump();
        this.input.consumeDash();
        for (const bot of this.bots) bot.movementLocked = false;
        if (name.startsWith('view-')) {
          const spawnIndex = THREE.MathUtils.clamp(Number.parseInt(name.slice(5), 10) || 0, 0, this.arena.spawnPoints.length - 1);
          this.mode = 'running';
          this.audio.setPaused(false);
          this.hud.hideStart();
          this.playerPosition.copy(this.arena.spawnPoints[spawnIndex]);
          this.playerVelocity.set(0, 0, 0);
          this.jumpBuffer = 0;
          this.coyote = 0;
          this.dashBuffer = 0;
          this.dashMomentumTimer = 0;
          const toCore = this.arena.corePosition.clone().sub(this.playerPosition).normalize();
          this.yaw = Math.atan2(-toCore.x, -toCore.z);
          this.pitch = THREE.MathUtils.clamp(Math.asin(toCore.y) - 0.025, -0.34, 0.18);
          // Test-view spawns are also live movement states. Resolve their
          // authored floor contact before input so stair-route checks exercise
          // ground acceleration rather than accidentally starting airborne.
          const floor = this.arena.floorHeightAt(this.playerPosition.x, this.playerPosition.z, this.playerPosition.y + 3);
          if (floor !== null) this.playerPosition.y = floor;
          let contact = this.arena.resolvePlayerCapsule(this.playerPosition, this.playerVelocity);
          if (!contact.grounded && floor !== null) {
            // A few imported stair seams sit exactly on the ray height but
            // miss the capsule patch by a fraction of a millimeter. Reseat the
            // deterministic view spawn just inside the authored tread.
            this.playerPosition.y = floor - 0.003;
            contact = this.arena.resolvePlayerCapsule(this.playerPosition, this.playerVelocity);
          }
          this.grounded = contact.grounded;
          this.terrainNormal.copy(contact.contactNormal);
        } else if (name === 'movement-flat') {
          this.mode = 'running';
          this.audio.setPaused(false);
          this.hud.hideStart();
          this.playerPosition.copy(this.arena.spawnPoints[Math.min(13, this.arena.spawnPoints.length - 1)]);
          const floor = this.arena.floorHeightAt(this.playerPosition.x, this.playerPosition.z, this.playerPosition.y + 3);
          if (floor !== null) this.playerPosition.y = floor;
          this.playerVelocity.set(0, 0, 0);
          this.jumpBuffer = 0;
          this.coyote = 0;
          this.dashBuffer = 0;
          this.dashMomentumTimer = 0;
          const toCore = this.arena.corePosition.clone().sub(this.playerPosition).setY(0).normalize();
          this.yaw = Math.atan2(-toCore.x, -toCore.z);
          this.pitch = -0.04;
          const contact = this.arena.resolvePlayerCapsule(this.playerPosition, this.playerVelocity);
          this.grounded = contact.grounded;
          this.terrainNormal.copy(contact.contactNormal);
        } else if (name === 'movement-slope') {
          this.mode = 'running';
          this.audio.setPaused(false);
          this.hud.hideStart();
          const floor = this.arena.floorHeightAt(-148, 76, Number.POSITIVE_INFINITY) ?? 0;
          this.playerPosition.set(-148, floor - 0.08, 76);
          // Aim the deterministic descent at the low edge of the west launch.
          // The old route target cut across its skirt instead of following the
          // visible ramp line, which made a clean downhill run look snagged.
          const downhill = new THREE.Vector3(-119, floor, 58).sub(this.playerPosition).setY(0).normalize();
          this.playerVelocity.set(0, 0, 0);
          this.jumpBuffer = 0;
          this.coyote = 0;
          this.dashBuffer = 0;
          this.dashMomentumTimer = 0;
          this.yaw = Math.atan2(-downhill.x, -downhill.z);
          this.pitch = -0.08;
          let contact = this.arena.resolvePlayerCapsule(this.playerPosition, this.playerVelocity);
          if (!contact.grounded) {
            this.playerPosition.y = floor - 0.14;
            contact = this.arena.resolvePlayerCapsule(this.playerPosition, this.playerVelocity);
          }
          this.grounded = contact.grounded;
          this.terrainNormal.copy(contact.contactNormal);
          this.playerVelocity.copy(downhill).multiplyScalar(14);
        } else if (name === 'active-play') {
          this.mode = 'running';
          this.audio.setPaused(false);
          this.hud.hideStart();
          this.selectedWeapon = WEAPONS.findIndex((weapon) => weapon.id === 'machine');
          this.weaponCooldown = 0;
          this.ammo.set('machine', this.weapon('machine').ammo);
          this.buildWeaponModel();
          // Use the validated flat-lane spawn for live-input and visual smoke
          // tests. Spawn 7 sits above a brush seam that has no capsule contact,
          // which made deterministic active play begin airborne and produced
          // false input/softlock failures.
          this.playerPosition.copy(this.arena.spawnPoints[Math.min(13, this.arena.spawnPoints.length - 1)]);
          const floor = this.arena.floorHeightAt(this.playerPosition.x, this.playerPosition.z, this.playerPosition.y + 3);
          if (floor !== null) this.playerPosition.y = floor;
          this.playerVelocity.set(0, 0, 0);
          const toCore = this.arena.corePosition.clone().sub(this.playerPosition).normalize();
          this.yaw = Math.atan2(-toCore.x, -toCore.z);
          this.pitch = THREE.MathUtils.clamp(Math.asin(toCore.y) - 0.03, -0.28, 0.12);
          const contact = this.arena.resolvePlayerCapsule(this.playerPosition, this.playerVelocity);
          this.grounded = contact.grounded;
          this.terrainNormal.copy(contact.contactNormal);
        } else if (name === 'tower-combat-review') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.hud.hideStart();
          this.pausedForScreenshot = true;
          this.screenshotCameraFov = 82;
          for (const selector of ['#hud', '#crosshair', '#view-mode-indicator', '#helmet-visor']) {
            document.querySelector<HTMLElement>(selector)?.classList.remove('hidden');
          }
          document.querySelector<HTMLElement>('#touch-controls')?.classList.add('hidden');

          const audit = this.arena.group.userData.outpostTowerAudit as QuickSenseOutpostTowerAudit | undefined;
          const entry = audit?.grounding.accessStairs[0];
          if (!entry) throw new Error('QuickSense tower entry route is unavailable');
          const entryStart = new THREE.Vector3(entry.start.x, entry.start.y, entry.start.z);
          const entryEnd = new THREE.Vector3(entry.end.x, entry.end.y, entry.end.z);
          const outward = entryStart.clone().sub(entryEnd).setY(0).normalize();
          const playerSpawn = entryStart.clone().addScaledVector(outward, 3.5);
          const playerFloor = this.arena.floorHeightAt(playerSpawn.x, playerSpawn.z, entryStart.y + 1.5);
          if (playerFloor !== null) playerSpawn.y = playerFloor;
          this.playerPosition.copy(playerSpawn);
          this.playerVelocity.set(0, 0, 0);

          const botPosition = entryEnd.clone().addScaledVector(outward, -1.2);
          // Restrict both support probes to the entry flight. An unbounded ray
          // correctly finds the flight deck 15 m overhead, but that is the wrong
          // walkable layer for this ground-level review state.
          const botFloor = this.arena.floorHeightAt(botPosition.x, botPosition.z, entryEnd.y + 1.5);
          if (botFloor !== null) botPosition.y = botFloor;
          const bot = this.bots[0];
          bot.respawn(botPosition, false);
          bot.health = 60;
          bot.armor = 20;
          bot.movementLocked = true;
          bot.velocity.set(0, 0, 0);
          const aimPoint = botPosition.clone().add(new THREE.Vector3(0, 1.35, 0));
          const view = aimPoint.sub(this.playerPosition.clone().add(new THREE.Vector3(0, PLAYER_EYE, 0))).normalize();
          this.yaw = Math.atan2(-view.x, -view.z);
          this.pitch = Math.asin(view.y);
          bot.aimDirection.copy(view).negate();
          bot.group.rotation.y = Math.atan2(bot.aimDirection.x, bot.aimDirection.z);
          for (let index = 1; index < this.bots.length; index += 1) {
            this.bots[index].respawn(this.arena.spawnPoints[(index + 8) % this.arena.spawnPoints.length], false);
            this.bots[index].movementLocked = true;
            this.bots[index].velocity.set(0, 0, 0);
          }

          this.selectedWeapon = WEAPONS.findIndex((weapon) => weapon.id === 'machine');
          this.weaponCooldown = 0;
          this.ammo.set('machine', this.weapon('machine').ammo);
          this.buildWeaponModel();
          const contact = this.arena.resolvePlayerCapsule(this.playerPosition, this.playerVelocity);
          this.grounded = contact.grounded;
          this.terrainNormal.copy(contact.contactNormal);
          this.weaponVfx.clearTransientEffects();
          this.updateCamera(0);
          this.tryFirePlayerWeapon();
          // Preserve one real tower strike alongside the enemy hit so the
          // authored metal impact, tracer, and surface response can be reviewed
          // in the same native gameplay frame.
          const reviewYaw = this.yaw;
          const reviewPitch = this.pitch;
          const impactTarget = new THREE.Vector3(entry.end.x, entry.end.y + 3.6, entry.end.z + 5.4);
          const impactView = impactTarget.sub(
            this.playerPosition.clone().add(new THREE.Vector3(0, PLAYER_EYE, 0)),
          ).normalize();
          this.yaw = Math.atan2(-impactView.x, -impactView.z);
          this.pitch = Math.asin(impactView.y);
          this.updateCamera(0);
          this.weaponCooldown = 0;
          this.tryFirePlayerWeapon();
          this.yaw = reviewYaw;
          this.pitch = reviewPitch;
          this.updateCamera(0);
          this.renderer.shadowMap.autoUpdate = false;
          this.renderer.shadowMap.needsUpdate = false;
        } else if (name === 'drone-encounter' || name === 'buster-encounter') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.hud.hideStart();
          this.health = 100;
          this.armor = 50;
          const spawn = this.arena.spawnPoints[0];
          this.playerPosition.copy(spawn);
          const supportY = this.arena.floorHeightAt(spawn.x, spawn.z, spawn.y + 4);
          if (supportY !== null) this.playerPosition.y = supportY;
          this.playerVelocity.set(0, 0, 0);
          const eye = this.playerPosition.clone().add(new THREE.Vector3(0, PLAYER_EYE, 0));
          const towardCenter = this.arena.corePosition.clone().sub(eye).setY(0);
          if (towardCenter.lengthSq() < 0.01) towardCenter.set(0, 0, -1);
          else towardCenter.normalize();
          let encounterCenter = eye.clone().addScaledVector(towardCenter, 25).add(new THREE.Vector3(0, 6, 0));
          for (let attempt = 0; attempt < 8; attempt += 1) {
            const direction = towardCenter.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), attempt * Math.PI * 0.25);
            const candidate = eye.clone().addScaledVector(direction, 25).add(new THREE.Vector3(0, 6, 0));
            if (!this.arena.hasLineOfSight(eye, candidate, 0.3)) continue;
            encounterCenter = candidate;
            break;
          }
          if (name === 'buster-encounter') {
            this.droneSwarm.suspendSentinelsForQa();
            this.droneSwarm.resetBustersForQa(encounterCenter);
          } else this.droneSwarm.resetForQa(encounterCenter);
          const firstDrone = name === 'buster-encounter'
            ? this.droneSwarm.busterDrones[0]
            : this.droneSwarm.drones[0];
          const view = firstDrone.position.clone().sub(eye).normalize();
          this.yaw = Math.atan2(-view.x, -view.z);
          this.pitch = Math.asin(view.y);
          this.selectedWeapon = WEAPONS.findIndex((weapon) => weapon.id === 'machine');
          this.weaponCooldown = 0;
          this.ammo.set('machine', this.weapon('machine').ammo);
          this.buildWeaponModel();
          this.bots.forEach((bot, index) => {
            const position = this.playerPosition.clone().add(new THREE.Vector3((index - 1) * 3, 0, 4 + index * 2));
            bot.respawn(position, false);
            bot.movementLocked = false;
          });
          const contact = this.arena.resolvePlayerCapsule(this.playerPosition, this.playerVelocity);
          this.grounded = contact.grounded;
          this.terrainNormal.copy(contact.contactNormal);
        } else if (name === 'combat') {
          this.mode = 'running';
          this.audio.setPaused(false);
          this.hud.hideStart();
          // Deterministic clear lane: target visibility, authored character
          // framing, muzzle convergence, and impact marks can all be judged.
          this.playerPosition.copy(this.arena.spawnPoints[3]);
          this.playerVelocity.set(0, 0, 0);
          this.yaw = 0;
          this.pitch = 0.045;
          this.selectedWeapon = WEAPONS.findIndex((weapon) => weapon.id === 'machine');
          this.weaponCooldown = 0;
          this.ammo.set('machine', this.weapon('machine').ammo);
          this.buildWeaponModel();
          const playerContact = this.arena.resolvePlayerCapsule(this.playerPosition, this.playerVelocity);
          this.grounded = playerContact.grounded;
          const botPosition = this.playerPosition.clone().add(new THREE.Vector3(0, 0, -4));
          this.bots[0].respawn(botPosition, false);
          this.bots[0].health = 35;
          this.bots[0].armor = 0;
          this.bots[1].respawn(this.arena.spawnPoints[1]);
          this.bots[2].respawn(this.arena.spawnPoints[2]);
        } else if (name === 'monsoon-overlook') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.hud.hideStart();
          this.playerPosition.set(-168, 84, 166);
          this.playerVelocity.set(0, 0, 0);
          const toCore = this.arena.corePosition.clone().sub(this.playerPosition).normalize();
          this.yaw = Math.atan2(-toCore.x, -toCore.z);
          this.pitch = Math.asin(toCore.y);
          this.grounded = false;
          this.weaponModel.visible = false;
        } else if (name === 'monsoon-grassland') {
          this.mode = 'running';
          this.audio.setPaused(true);
          const target = new THREE.Vector3(-158, this.arena.floorHeightAt(-158, 10) ?? 0, 10);
          const floor = this.arena.floorHeightAt(-149, 18) ?? target.y;
          this.playerPosition.set(-149, floor + 0.04, 18);
          this.playerVelocity.set(0, 0, 0);
          const view = target.clone().add(new THREE.Vector3(0, 1.05, 0)).sub(
            this.playerPosition.clone().add(new THREE.Vector3(0, PLAYER_EYE, 0)),
          ).normalize();
          this.yaw = Math.atan2(-view.x, -view.z);
          this.pitch = Math.asin(view.y);
          this.grounded = false;
          this.weaponModel.visible = false;
        } else if (name === 'monsoon-structure') {
          this.mode = 'running';
          this.audio.setPaused(true);
          const floor = this.arena.floorHeightAt(-101, 108) ?? 0;
          this.playerPosition.set(-101, floor + 0.04, 108);
          this.playerVelocity.set(0, 0, 0);
          const target = new THREE.Vector3(-132, (this.arena.floorHeightAt(-132, 111) ?? floor) + 3.2, 111);
          const view = target.sub(this.playerPosition.clone().add(new THREE.Vector3(0, PLAYER_EYE, 0))).normalize();
          this.yaw = Math.atan2(-view.x, -view.z);
          this.pitch = Math.asin(view.y);
          this.grounded = false;
          this.weaponModel.visible = false;
        } else if (name === 'monsoon-ramp') {
          this.mode = 'running';
          this.audio.setPaused(true);
          const floor = this.arena.floorHeightAt(-132, 66) ?? 0;
          this.playerPosition.set(-132, floor + 0.04, 66);
          this.playerVelocity.set(0, 0, 0);
          const target = new THREE.Vector3(-98, (this.arena.floorHeightAt(-98, 45) ?? floor) + 2.1, 45);
          const view = target.sub(this.playerPosition.clone().add(new THREE.Vector3(0, PLAYER_EYE, 0))).normalize();
          this.yaw = Math.atan2(-view.x, -view.z);
          this.pitch = Math.asin(view.y);
          this.grounded = false;
          this.weaponModel.visible = false;
        } else if (name === 'monsoon-damage') {
          this.mode = 'running';
          this.audio.setPaused(true);
          const wallTop = this.arena.floorHeightAt(-132, 102, Number.POSITIVE_INFINITY) ?? 30;
          const wallPoint = new THREE.Vector3(-132, wallTop - 3.5, 101.43);
          const normal = new THREE.Vector3(0, 0, -1);
          const offsets = [
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(-1.25, 0.55, 0),
            new THREE.Vector3(1.05, -0.42, 0),
            new THREE.Vector3(1.8, 0.7, 0),
          ];
          offsets.forEach((offset, index) => {
            this.arena.registerSurfaceImpact(wallPoint.clone().add(offset), normal, 40 + index * 24, 0);
          });
          const floor = this.arena.floorHeightAt(-132, 91) ?? wallTop - 8;
          this.playerPosition.set(-132, floor + 0.04, 91);
          this.playerVelocity.set(0, 0, 0);
          const view = wallPoint.clone().sub(this.playerPosition.clone().add(new THREE.Vector3(0, PLAYER_EYE, 0))).normalize();
          this.yaw = Math.atan2(-view.x, -view.z);
          this.pitch = Math.asin(view.y);
          this.grounded = false;
          this.weaponModel.visible = false;
        } else if (name === 'monsoon-weather') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.screenshotArenaTime = 65;
          this.playerPosition.set(-176, 68, -142);
          this.playerVelocity.set(0, 0, 0);
          const target = new THREE.Vector3(-55, 18, -42);
          const view = target.sub(this.playerPosition).normalize();
          this.yaw = Math.atan2(-view.x, -view.z);
          this.pitch = Math.asin(view.y);
          this.grounded = false;
          this.weaponModel.visible = false;
        } else if (name === 'quicksense-fighter-pads') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.hud.hideStart();
          this.pausedForScreenshot = true;
          if (this.playerFighter) this.playerFighter = null;
          document.body.dataset.pilotingFighter = 'false';
          this.vehicleButton.textContent = 'BOARD';
          for (const fighter of this.fighters) resetFighterAtPad(fighter);
          for (const bot of this.bots) {
            bot.group.visible = true;
            bot.movementLocked = true;
          }
          this.screenshotCameraFov = 66;
          this.playerPosition.set(84, 102, -106);
          this.playerVelocity.set(0, 0, 0);
          this.screenshotLookTarget.set(0, 42, -6);
          this.screenshotLookTargetActive = true;
          const view = this.screenshotLookTarget.clone().sub(this.playerPosition).normalize();
          this.yaw = Math.atan2(-view.x, -view.z);
          this.pitch = Math.asin(view.y);
          this.weaponModel.visible = false;
          for (const selector of ['#hud', '#crosshair', '#touch-controls', '#view-mode-indicator', '#helmet-visor']) {
            document.querySelector<HTMLElement>(selector)?.classList.add('hidden');
          }
        } else if (name === 'quicksense-fighter-active') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.hud.hideStart();
          this.pausedForScreenshot = true;
          for (const fighter of this.fighters) resetFighterAtPad(fighter);
          const fighter = this.fighters[2];
          if (!fighter) throw new Error('QuickSense fighter state is unavailable');
          const orientation = this.fighterQuaternionScratch.setFromEuler(new THREE.Euler(0, 0, 0));
          resetFighterFlightState(fighter.flight, new THREE.Vector3(0, 94, 42), orientation);
          fighter.flight.velocity.set(0, 0, -34);
          fighter.pilot = 'player';
          fighter.visual.root.visible = false;
          this.playerFighter = fighter;
          this.playerPosition.copy(fighter.flight.position);
          this.playerVelocity.copy(fighter.flight.velocity);
          this.yaw = 0;
          this.pitch = -0.045;
          this.vehicleButton.textContent = 'EJECT';
          document.body.dataset.pilotingFighter = 'true';
          for (const selector of ['#hud', '#crosshair', '#view-mode-indicator', '#helmet-visor']) {
            document.querySelector<HTMLElement>(selector)?.classList.remove('hidden');
          }
          document.querySelector<HTMLElement>('#touch-controls')?.classList.toggle('hidden', !this.mobileQuality);
          this.updateHud();
        } else if (name.startsWith('quicksense-fighter-proof-')) {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.hud.hideStart();
          this.pausedForScreenshot = true;
          if (this.playerFighter) this.playerFighter = null;
          document.body.dataset.pilotingFighter = 'false';
          for (const fighter of this.fighters) resetFighterAtPad(fighter);
          const key = name.slice('quicksense-fighter-proof-'.length);
          const index = ({ nw: 0, ne: 1, sw: 2, se: 3 } as Record<string, number>)[key];
          const fighter = this.fighters[index];
          if (!fighter) throw new Error(`QuickSense fighter proof view ${key} is unavailable`);
          const outward = new THREE.Vector3(fighter.pad.position.x, 0, fighter.pad.position.z).normalize();
          this.screenshotCameraFov = 48;
          this.playerPosition.copy(fighter.pad.position)
            .addScaledVector(outward, 30)
            .add(new THREE.Vector3(0, 10.5, 0));
          this.playerVelocity.set(0, 0, 0);
          this.screenshotLookTarget.copy(fighter.pad.position).add(new THREE.Vector3(0, -0.9, 0));
          this.screenshotLookTargetActive = true;
          const view = this.screenshotLookTarget.clone().sub(this.playerPosition).normalize();
          this.yaw = Math.atan2(-view.x, -view.z);
          this.pitch = Math.asin(view.y);
          this.weaponModel.visible = false;
          for (const selector of ['#hud', '#crosshair', '#touch-controls', '#view-mode-indicator', '#helmet-visor']) {
            document.querySelector<HTMLElement>(selector)?.classList.add('hidden');
          }
        } else if (name === 'quicksense-fighter-pad-close') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.hud.hideStart();
          this.pausedForScreenshot = true;
          if (this.playerFighter) this.playerFighter = null;
          document.body.dataset.pilotingFighter = 'false';
          for (const fighter of this.fighters) resetFighterAtPad(fighter);
          this.screenshotCameraFov = 54;
          this.playerPosition.set(54, 61, -72);
          this.playerVelocity.set(0, 0, 0);
          this.screenshotLookTarget.set(27.32, 43.8, -32.18);
          this.screenshotLookTargetActive = true;
          const view = this.screenshotLookTarget.clone().sub(this.playerPosition).normalize();
          this.yaw = Math.atan2(-view.x, -view.z);
          this.pitch = Math.asin(view.y);
          this.weaponModel.visible = false;
          for (const selector of ['#hud', '#crosshair', '#touch-controls', '#view-mode-indicator', '#helmet-visor']) {
            document.querySelector<HTMLElement>(selector)?.classList.add('hidden');
          }
        } else if (name === 'quicksense-fighter-ai-board') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.hud.hideStart();
          for (const fighter of this.fighters) resetFighterAtPad(fighter);
          const fighter = this.fighters[0];
          const bot = this.bots[0];
          if (!fighter || !bot) throw new Error('QuickSense fighter AI state is unavailable');
          bot.respawn(fighter.flight.position.clone().add(new THREE.Vector3(1.2, 0, 0)), false);
          bot.movementLocked = false;
          this.fighterAi.set(bot.id, new FighterAiPilotController(bot.id, 'normal', {
            enterDistance: 10,
            enterHoldSeconds: 0.08,
            reactionSeconds: 0.2,
          }));
          this.playerPosition.copy(this.arena.spawnPoints[0]);
          this.playerVelocity.set(0, 0, 0);
        } else if (name === 'quicksense-overlook') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.hud.hideStart();
          for (const selector of ['#hud', '#crosshair', '#touch-controls', '#view-mode-indicator', '#helmet-visor']) {
            document.querySelector<HTMLElement>(selector)?.classList.add('hidden');
          }
          this.screenshotCameraFov = 68;
          // Anchor the map review to a validated live spawn. Fixed aerial
          // coordinates became stale as QuickSense's vertical topology grew
          // and could produce a plausible-looking but empty sky capture.
          const spawn = this.arena.spawnPoints[0];
          const supportY = this.arena.floorHeightAt(spawn.x, spawn.z, Number.POSITIVE_INFINITY) ?? spawn.y;
          this.playerPosition.set(spawn.x, supportY, spawn.z);
          this.playerVelocity.set(0, 0, 0);
          this.screenshotLookTarget.copy(this.arena.corePosition);
          this.screenshotLookTargetActive = true;
          const view = this.screenshotLookTarget.clone().sub(this.playerPosition).normalize();
          this.yaw = Math.atan2(-view.x, -view.z);
          this.pitch = Math.asin(view.y);
          this.grounded = false;
          this.weaponModel.visible = false;
        } else if (name === 'quicksense-depth') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.screenshotCameraFov = 62;
          this.playerPosition.set(-96, 30, -116);
          this.playerVelocity.set(0, 0, 0);
          this.screenshotLookTarget.set(18, 31, 32);
          this.screenshotLookTargetActive = true;
          const view = this.screenshotLookTarget.clone().sub(this.playerPosition).normalize();
          this.yaw = Math.atan2(-view.x, -view.z);
          this.pitch = Math.asin(view.y);
          this.grounded = false;
          this.weaponModel.visible = false;
        } else if (name === 'quicksense-crossings') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.screenshotCameraFov = 56;
          this.playerPosition.set(80, 48, -110);
          this.playerVelocity.set(0, 0, 0);
          this.screenshotLookTarget.set(-78, 27, -42);
          this.screenshotLookTargetActive = true;
          const view = this.screenshotLookTarget.clone().sub(this.playerPosition).normalize();
          this.yaw = Math.atan2(-view.x, -view.z);
          this.pitch = Math.asin(view.y);
          this.grounded = false;
          this.weaponModel.visible = false;
        } else if (name === 'quicksense-ramp') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.hud.hideStart();
          for (const selector of ['#hud', '#crosshair', '#touch-controls', '#view-mode-indicator', '#helmet-visor']) {
            document.querySelector<HTMLElement>(selector)?.classList.add('hidden');
          }
          this.screenshotCameraFov = 58;
          const spawn = this.arena.spawnPoints[Math.min(3, this.arena.spawnPoints.length - 1)];
          const supportY = this.arena.floorHeightAt(spawn.x, spawn.z, Number.POSITIVE_INFINITY) ?? spawn.y;
          this.playerPosition.set(spawn.x, supportY, spawn.z);
          this.playerVelocity.set(0, 0, 0);
          this.screenshotLookTarget.copy(this.arena.corePosition);
          this.screenshotLookTargetActive = true;
          const view = this.screenshotLookTarget.clone().sub(this.playerPosition).normalize();
          this.yaw = Math.atan2(-view.x, -view.z);
          this.pitch = Math.asin(view.y);
          this.grounded = false;
          this.weaponModel.visible = false;
        } else if (name === 'quicksense-cliff') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.screenshotCameraFov = 60;
          this.playerPosition.set(-110, 62, 65);
          this.playerVelocity.set(0, 0, 0);
          this.screenshotLookTarget.set(-110, 32, 160);
          this.screenshotLookTargetActive = true;
          const view = this.screenshotLookTarget.clone().sub(this.playerPosition).normalize();
          this.yaw = Math.atan2(-view.x, -view.z);
          this.pitch = Math.asin(view.y);
          this.grounded = false;
          this.weaponModel.visible = false;
        } else if (name.startsWith('quicksense-tower-')) {
          const id = name.slice('quicksense-tower-'.length);
          if (!this.setQuickSenseTowerSectionCapture(id)) {
            throw new Error(`Unknown QuickSense tower capture state: ${name}`);
          }
        } else if (name.startsWith('quicksense-structure-')) {
          const id = name.slice('quicksense-structure-'.length);
          if (!this.setQuickSenseStructureCapture(id)) {
            throw new Error(`Unknown QuickSense structure capture state: ${name}`);
          }
        } else if (name.startsWith('quicksense-building-')) {
          const buildingViews: Record<string, { camera: THREE.Vector3; target: THREE.Vector3; fov: number }> = {
            'quicksense-building-northwest': {
              camera: new THREE.Vector3(-74, 52, 112),
              target: new THREE.Vector3(-110, 58, 172),
              fov: 52,
            },
            'quicksense-building-northeast': {
              camera: new THREE.Vector3(74, 56, 112),
              target: new THREE.Vector3(110, 62, 172),
              fov: 52,
            },
            'quicksense-building-southwest': {
              camera: new THREE.Vector3(-82, 44, -112),
              target: new THREE.Vector3(-134, 45, -172),
              fov: 52,
            },
            'quicksense-building-southeast': {
              camera: new THREE.Vector3(82, 48, -112),
              target: new THREE.Vector3(134, 50, -172),
              fov: 52,
            },
            'quicksense-building-west-scar': {
              camera: new THREE.Vector3(-130, 55, -78),
              target: new THREE.Vector3(-198, 58, -78),
              fov: 52,
            },
            'quicksense-building-west-crown': {
              camera: new THREE.Vector3(-130, 65, 80),
              target: new THREE.Vector3(-198, 70, 80),
              fov: 52,
            },
            'quicksense-building-east-crown': {
              camera: new THREE.Vector3(130, 65, -80),
              target: new THREE.Vector3(198, 72, -80),
              fov: 52,
            },
            'quicksense-building-east-scar': {
              camera: new THREE.Vector3(130, 57, 78),
              target: new THREE.Vector3(198, 62, 78),
              fov: 52,
            },
          };
          const buildingView = buildingViews[name];
          if (!buildingView) throw new Error(`Unknown QuickSense building capture state: ${name}`);
          this.mode = 'running';
          this.audio.setPaused(true);
          this.screenshotCameraFov = buildingView.fov;
          this.playerPosition.copy(buildingView.camera);
          this.playerVelocity.set(0, 0, 0);
          this.screenshotLookTarget.copy(buildingView.target);
          this.screenshotLookTargetActive = true;
          const view = this.screenshotLookTarget.clone().sub(this.playerPosition).normalize();
          this.yaw = Math.atan2(-view.x, -view.z);
          this.pitch = Math.asin(view.y);
          this.grounded = false;
          this.weaponModel.visible = false;
        } else if (name === 'quicksense-buildings-north') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.screenshotCameraFov = 58;
          this.playerPosition.set(0, 80, 92);
          this.playerVelocity.set(0, 0, 0);
          this.screenshotLookTarget.set(0, 50, 158);
          this.screenshotLookTargetActive = true;
          const view = this.screenshotLookTarget.clone().sub(this.playerPosition).normalize();
          this.yaw = Math.atan2(-view.x, -view.z);
          this.pitch = Math.asin(view.y);
          this.grounded = false;
          this.weaponModel.visible = false;
        } else if (name === 'quicksense-buildings-south') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.screenshotCameraFov = 58;
          this.playerPosition.set(0, 76, -92);
          this.playerVelocity.set(0, 0, 0);
          this.screenshotLookTarget.set(0, 46, -158);
          this.screenshotLookTargetActive = true;
          const view = this.screenshotLookTarget.clone().sub(this.playerPosition).normalize();
          this.yaw = Math.atan2(-view.x, -view.z);
          this.pitch = Math.asin(view.y);
          this.grounded = false;
          this.weaponModel.visible = false;
        } else if (name === 'quicksense-buildings-west') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.screenshotCameraFov = 58;
          this.playerPosition.set(-112, 78, 0);
          this.playerVelocity.set(0, 0, 0);
          this.screenshotLookTarget.set(-182, 50, 0);
          this.screenshotLookTargetActive = true;
          const view = this.screenshotLookTarget.clone().sub(this.playerPosition).normalize();
          this.yaw = Math.atan2(-view.x, -view.z);
          this.pitch = Math.asin(view.y);
          this.grounded = false;
          this.weaponModel.visible = false;
        } else if (name === 'quicksense-buildings-east') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.screenshotCameraFov = 58;
          this.playerPosition.set(112, 80, 0);
          this.playerVelocity.set(0, 0, 0);
          this.screenshotLookTarget.set(182, 52, 0);
          this.screenshotLookTargetActive = true;
          const view = this.screenshotLookTarget.clone().sub(this.playerPosition).normalize();
          this.yaw = Math.atan2(-view.x, -view.z);
          this.pitch = Math.asin(view.y);
          this.grounded = false;
          this.weaponModel.visible = false;
        } else if (name === 'quicksense-speed') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.hud.hideStart();
          this.pausedForScreenshot = true;
          this.screenshotCameraFov = 96;
          const floor = this.arena.floorHeightAt(0, -128, 160) ?? 4.8;
          this.playerPosition.set(0, floor - 0.04, -128);
          this.playerVelocity.set(0, 0, 0);
          const contact = this.arena.resolvePlayerCapsule(this.playerPosition, this.playerVelocity);
          this.grounded = contact.grounded;
          this.terrainNormal.copy(contact.contactNormal);
          this.playerVelocity.set(0, 0, 38);
          this.skiHeld = true;
          this.yaw = Math.PI;
          this.pitch = -0.035;
          this.weaponModel.visible = false;
          this.renderer.shadowMap.autoUpdate = false;
          this.renderer.shadowMap.needsUpdate = false;
          for (const bot of this.bots) {
            bot.movementLocked = true;
            bot.velocity.set(0, 0, 0);
          }
        } else if (name === 'quicksense-flow') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.hud.hideStart();
          this.pausedForScreenshot = true;
          const floor = this.arena.floorHeightAt(0, -60) ?? 7.8;
          this.playerPosition.set(0, floor, -60);
          this.playerVelocity.set(0, 0, 14);
          this.yaw = 0;
          this.pitch = 0.03;
          const contact = this.arena.resolvePlayerCapsule(this.playerPosition, this.playerVelocity);
          this.grounded = contact.grounded;
          this.terrainNormal.copy(contact.contactNormal);
        } else if (name === 'quicksense-grapple') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.hud.hideStart();
          this.pausedForScreenshot = true;
          this.playerPosition.set(-58, 30, -28);
          this.playerVelocity.set(0, 0, 0);
          // Aim at the west habitat wall. The former bridge-space target became
          // open sky after the center-tower/road clearance pass.
          const target = new THREE.Vector3(-80, 30, -5);
          const view = target.sub(this.playerPosition).normalize();
          this.yaw = Math.atan2(-view.x, -view.z);
          this.pitch = Math.asin(view.y);
          this.grounded = false;
          this.toggleGrapple();
        } else if (name === 'quicksense-bounce') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.hud.hideStart();
          this.pausedForScreenshot = true;
          const pad = this.arena.jumpPads[0];
          this.playerPosition.copy(pad.position);
          this.playerVelocity.set(0, 0, 0);
          this.jumpPadCooldown = 0;
          this.yaw = Math.atan2(-pad.direction.x, -pad.direction.z);
          this.pitch = Math.asin(pad.direction.y) * 0.42;
          this.checkJumpPads();
          this.grounded = false;
        } else if (name === 'jump-pad-0') {
          this.mode = 'running';
          this.audio.setPaused(false);
          this.hud.hideStart();
          const pad = this.arena.jumpPads[0];
          this.playerPosition.copy(pad.position);
          this.playerVelocity.set(0, 0, 0);
          this.jumpPadCooldown = 0;
          this.yaw = Math.atan2(-pad.direction.x, -pad.direction.z);
          this.pitch = Math.asin(pad.direction.y) * 0.4;
          const contact = this.arena.resolvePlayerCapsule(this.playerPosition, this.playerVelocity);
          this.grounded = contact.grounded;
          this.terrainNormal.copy(contact.contactNormal);
        } else if (name === 'fail') {
          this.mode = 'respawning';
          this.health = 0;
          this.respawnTimer = 1.6;
          this.respawnCause = 'TEST STATE';
        } else if (name === 'complete') {
          this.completeMatch();
        } else if (name === 'stress') {
          this.mode = 'running';
          this.hud.hideStart();
          for (let index = 0; index < 24; index += 1) {
            const angle = (index / 24) * Math.PI * 2;
            const definition = this.weapon(index % 2 === 0 ? 'plasma' : 'rocket');
            this.spawnProjectile(
              this.arena.corePosition.clone().add(new THREE.Vector3(0, 4, 0)),
              new THREE.Vector3(Math.cos(angle), 0.12, Math.sin(angle)).normalize(),
              index % 3,
              definition,
            );
          }
        }
        if (
          name.startsWith('monsoon-')
          || name.startsWith('quicksense-tower-')
          || name.startsWith('quicksense-structure-')
          || name.startsWith('quicksense-building-')
          || name.startsWith('quicksense-buildings-')
          || ['quicksense-depth', 'quicksense-crossings', 'quicksense-cliff'].includes(name)
        ) {
          this.pausedForScreenshot = true;
          this.renderer.shadowMap.autoUpdate = false;
          this.renderer.shadowMap.needsUpdate = false;
          this.hud.hideStart();
          for (const selector of ['#hud', '#crosshair', '#touch-controls', '#view-mode-indicator', '#helmet-visor']) {
            document.querySelector<HTMLElement>(selector)?.classList.add('hidden');
          }
        }
        this.updateCamera(0);
        this.updateSpeedEffects(0, this.elapsed, true);
        this.publishDiagnostics();
      },
      setAmmo: (weapon: WeaponId, amount: number) => {
        this.ammo.set(weapon, Math.max(0, Math.floor(amount)));
      },
      setWeapon: (weapon: WeaponId) => {
        const index = WEAPONS.findIndex((candidate) => candidate.id === weapon);
        if (index < 0) return;
        this.selectedWeapon = index;
        this.weaponCooldown = 0;
        if ((this.ammo.get(weapon) ?? 0) <= 0) this.ammo.set(weapon, this.weapon(weapon).ammo || 8);
        this.buildWeaponModel();
        this.updateCamera(0);
        this.publishDiagnostics();
      },
      setAim: (yaw: number, pitch: number) => {
        this.yaw = yaw;
        this.pitch = THREE.MathUtils.clamp(pitch, -1.28, 1.22);
        this.updateCamera(0);
        this.publishDiagnostics();
      },
      setSpectatorCamera: (position, target, fov = 58) => {
        this.screenshotCameraFov = THREE.MathUtils.clamp(fov, 35, 90);
        this.playerPosition.set(position.x, position.y, position.z);
        this.playerVelocity.set(0, 0, 0);
        this.screenshotLookTarget.set(target.x, target.y, target.z);
        this.screenshotLookTargetActive = true;
        const direction = this.screenshotLookTarget.clone().sub(
          this.playerPosition.clone().add(new THREE.Vector3(0, PLAYER_EYE, 0)),
        ).normalize();
        this.yaw = Math.atan2(-direction.x, -direction.z);
        this.pitch = Math.asin(direction.y);
        this.updateCamera(0);
        this.publishDiagnostics();
      },
      toggleViewMode: () => {
        this.toggleViewMode();
      },
      sampleFloorHeight: (x: number, z: number, fromY = 8) => this.arena.floorHeightAt(x, z, fromY),
      sampleCapsulePlacement: (position) => {
        const resolvedPosition = new THREE.Vector3(position.x, position.y, position.z);
        const resolvedVelocity = new THREE.Vector3();
        const contact = this.arena.resolvePlayerCapsule(resolvedPosition, resolvedVelocity);
        return {
          position: { x: resolvedPosition.x, y: resolvedPosition.y, z: resolvedPosition.z },
          grounded: contact.grounded,
          wallContact: contact.wallContact,
          contacts: contact.contacts,
          correction: { x: contact.correction.x, y: contact.correction.y, z: contact.correction.z },
        };
      },
      sampleMovementHit: (start, end) => {
        const hit = this.arena.movementSegmentHitDetails(
          new THREE.Vector3(start.x, start.y, start.z),
          new THREE.Vector3(end.x, end.y, end.z),
        );
        return hit ? {
          point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
          normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
          distance: hit.distance,
        } : null;
      },
      getSpawnPoints: () => this.arena.spawnPoints.map((point) => ({ x: point.x, y: point.y, z: point.z })),
      sampleLineOfSight: (start, end) => this.arena.hasLineOfSight(
        new THREE.Vector3(start.x, start.y, start.z),
        new THREE.Vector3(end.x, end.y, end.z),
      ),
      setCombatants: (player, botPosition, botFacesPlayer = true, lockBot = true) => {
        this.mode = 'running';
        this.hud.hideStart();
        this.playerPosition.set(player.x, player.y, player.z);
        this.playerVelocity.set(0, 0, 0);
        const playerContact = this.arena.resolvePlayerCapsule(this.playerPosition, this.playerVelocity);
        this.grounded = playerContact.grounded;
        this.terrainNormal.copy(playerContact.contactNormal);
        const bot = this.bots[0];
        bot.respawn(new THREE.Vector3(botPosition.x, botPosition.y, botPosition.z), false);
        bot.movementLocked = lockBot;
        bot.targetOwner = 'player';
        this.arena.resolvePlayerCapsule(bot.group.position, bot.velocity);
        const facing = this.playerPosition.clone().add(new THREE.Vector3(0, PLAYER_EYE * 0.72, 0))
          .sub(bot.group.position.clone().add(new THREE.Vector3(0, 1.5, 0)))
          .normalize();
        bot.aimDirection.copy(botFacesPlayer ? facing : facing.negate());
        bot.group.rotation.y = Math.atan2(bot.aimDirection.x, bot.aimDirection.z);
        this.publishDiagnostics();
      },
      getLongSightline: () => {
        let best: { player: THREE.Vector3; bot: THREE.Vector3; distance: number } | null = null;
        const candidates = this.arena.spawnPoints.map((point) => point.clone());
        if (this.arena.mapInfo.name === 'QuickSense') {
          // Spawn-to-spawn sightlines are intentionally screened by terrain. These
          // authored X/Z probes sit on real walkable surfaces and let the combat
          // harness find a genuine long lane without bypassing world collision.
          const longLaneProbes: ReadonlyArray<readonly [number, number]> = [
            [-60, -40], [90, -25],
            [-90, -115], [45, -40], [-75, 20], [75, 65],
            [45, -100], [90, 50], [-60, 20], [90, 65],
            [-75, 80], [75, 35], [-60, -25], [90, -70],
          ];
          for (const [x, z] of longLaneProbes) {
            const seated = this.arena.safeSpawnPoint(new THREE.Vector3(x, 0, z));
            if (seated) candidates.push(seated);
          }
        }
        for (let playerIndex = 0; playerIndex < candidates.length; playerIndex += 1) {
          for (let botIndex = 0; botIndex < candidates.length; botIndex += 1) {
            if (playerIndex === botIndex) continue;
            const player = candidates[playerIndex];
            const bot = candidates[botIndex];
            const distance = player.distanceTo(bot);
            // Stay inside the bot's 155 m awareness envelope with room for
            // capsule resolution and chest/eye offsets during the live test.
            if (distance < 58 || distance > 152 || distance <= (best?.distance ?? 0)) continue;
            const botEye = bot.clone().add(new THREE.Vector3(0, 1.5, 0));
            const playerChest = player.clone().add(new THREE.Vector3(0, 0.95, 0));
            if (!this.arena.hasLineOfSight(botEye, playerChest, 0.3)) continue;
            const playerEye = player.clone().add(new THREE.Vector3(0, PLAYER_EYE, 0));
            const botBody = bot.clone().add(new THREE.Vector3(0, 0.92, 0));
            if (!this.arena.hasLineOfSight(playerEye, botBody, 0.3)) continue;
            best = { player: player.clone(), bot: bot.clone(), distance };
          }
        }
        return best ? {
          player: { x: best.player.x, y: best.player.y, z: best.player.z },
          bot: { x: best.bot.x, y: best.bot.y, z: best.bot.z },
          distance: best.distance,
        } : null;
      },
      fireBotWeapon: (botIndex: number, weapon: WeaponId) => {
        const bot = this.bots[botIndex];
        if (!bot) throw new RangeError(`Unknown bot index ${botIndex}.`);
        bot.weapon = weapon;
        bot.targetOwner = 'player';
        this.botFire(bot, 'player');
        this.publishDiagnostics();
      },
      fireBotAtDrone: (botIndex: number, droneId: string, weapon: WeaponId) => {
        const bot = this.bots[botIndex];
        const drone = this.droneSwarm.combatDrones.find((candidate) => candidate.id === droneId);
        if (!bot) throw new RangeError(`Unknown bot index ${botIndex}.`);
        if (!drone) throw new RangeError(`Unknown drone id ${droneId}.`);
        bot.weapon = weapon;
        bot.aimDirection.copy(drone.position).sub(bot.group.position.clone().add(new THREE.Vector3(0, 1.5, 0))).normalize();
        this.botFireDrone(bot, drone);
        this.publishDiagnostics();
      },
      fireWeapon: () => {
        this.weaponCooldown = 0;
        this.tryFirePlayerWeapon();
        this.publishDiagnostics();
      },
      triggerHitMarker: (kill = false) => {
        this.hud.hitMarker(kill);
      },
      fireSecondary: () => {
        this.weaponCooldown = 0;
        this.trySecondaryFire();
        this.publishDiagnostics();
      },
      boardFighter: (id?: string) => {
        if (this.playerFighter) return true;
        const fighter = id
          ? this.fighters.find((candidate) => candidate.id === id) ?? null
          : nearestBoardableFighter(this.fighters, this.playerPosition, Number.POSITIVE_INFINITY);
        if (!fighter || fighter.destroyed || fighter.pilot !== null) return false;
        this.mode = 'running';
        this.hud.hideStart();
        this.playerPosition.copy(fighter.flight.position).add(new THREE.Vector3(2.2, 0, 0));
        this.togglePlayerFighter();
        this.updateCamera(0);
        this.updateHud();
        this.publishDiagnostics();
        return this.playerFighter === fighter;
      },
      fireActiveFighterWeapon: (missile = false) => {
        if (!this.playerFighter) return false;
        if (missile) this.playerFighter.missileCooldown = 0;
        else this.playerFighter.primaryCooldown = 0;
        this.fireFighterWeapon(this.playerFighter, missile);
        this.publishDiagnostics();
        return true;
      },
      damageFighter: (id: string, amount: number) => {
        const fighter = this.fighters.find((candidate) => candidate.id === id);
        if (!fighter) return false;
        this.damageFighter(fighter, Math.max(0, amount), 'player', 'QA DAMAGE');
        this.updateHud();
        this.publishDiagnostics();
        return true;
      },
      damageDrone: (id: string, amount: number) => {
        const drone = this.droneSwarm.combatDrones.find((candidate) => candidate.id === id);
        if (!drone) return false;
        this.applyDamageToDrone(drone, Math.max(0, amount), 'player', 'QA DAMAGE');
        this.updateHud();
        this.publishDiagnostics();
        return true;
      },
      stageBusterAttack: (id: string, targetOwner: DroneTargetOwner) => {
        const target = targetOwner === 'player'
          ? {
            owner: 'player' as const,
            position: this.playerPosition.clone().add(new THREE.Vector3(0, 0.95, 0)),
            velocity: this.playerVelocity.clone(),
            alive: this.health > 0,
          }
          : {
            owner: targetOwner,
            position: this.bots[targetOwner]?.group.position.clone().add(new THREE.Vector3(0, 1.05, 0))
              ?? new THREE.Vector3(),
            velocity: this.bots[targetOwner]?.velocity.clone() ?? new THREE.Vector3(),
            alive: Boolean(this.bots[targetOwner]?.alive),
          };
        const staged = this.droneSwarm.stageBusterAttackForQa(id, target);
        this.publishDiagnostics();
        return staged;
      },
      throwGrenade: () => {
        this.tryThrowGrenade();
        this.publishDiagnostics();
      },
      toggleGrapple: () => {
        this.toggleGrapple();
        this.updateCamera(0);
        this.publishDiagnostics();
      },
      setPausedForScreenshot: (paused: boolean) => {
        this.pausedForScreenshot = paused;
        if (paused) {
          // The static arena shadow atlas is already valid by the time the QA
          // hooks are installed. Camera-only capture states must not resubmit
          // every static mesh merely because the player was teleported.
          this.renderer.shadowMap.autoUpdate = false;
          this.renderer.shadowMap.needsUpdate = false;
        }
      },
      setWeaponInspectionMode: (enabled: boolean) => {
        this.weaponInspectionMode = enabled;
        this.buildWeaponModel();
        this.updateCamera(0);
        this.publishDiagnostics();
      },
      setWeaponHandsVisible: (visible: boolean) => {
        const armature = this.weaponVisual?.root.getObjectByName('first-person-armature');
        if (armature) armature.visible = visible;
      },
      parkBotsForScreenshot: () => {
        const spawns = [...this.arena.spawnPoints]
          .sort((left, right) => right.distanceToSquared(this.playerPosition) - left.distanceToSquared(this.playerPosition));
        this.bots.forEach((bot, index) => {
          bot.respawn(spawns[index % spawns.length], false);
          bot.movementLocked = true;
          bot.velocity.set(0, 0, 0);
        });
      },
      resetWeaponCaptureState: () => {
        this.recoil = 0;
        this.laserHeat = 0;
        this.weaponTuck = 0;
        this.weaponWalkWeight = 0;
        this.weaponVerticalLag = 0;
        this.weaponAirborneTime = 0;
        this.trauma = 0;
        this.weaponCooldown = 0;
        this.discBounceCount = 0;
        this.lastDiscBouncePosition.set(0, 0, 0);
        this.weaponVfx.clearTransientEffects();
        this.updateCamera(0);
        this.publishDiagnostics();
      },
      setReducedMotion: (enabled: boolean) => {
        this.reducedMotion = enabled;
      },
      stepSimulation: (seconds: number) => {
        if (this.input.consumeInteract()) this.togglePlayerFighter();
        if (this.input.consumeJump() && !this.playerFighter) this.jumpBuffer = MOVEMENT.jumpBuffer;
        if (this.input.consumeDash()) {
          if (this.playerFighter) this.fighterBoostQueued = true;
          else this.dashBuffer = 0.12;
        }
        if (this.input.consumeGrapple()) this.toggleGrapple();
        if (this.input.consumeGrenade()) {
          if (this.playerFighter) this.fighterMissileQueued = true;
          else this.tryThrowGrenade();
        }
        const steps = THREE.MathUtils.clamp(Math.ceil(seconds / MOVEMENT.fixedStep), 1, 3_600);
        for (let index = 0; index < steps; index += 1) this.fixedUpdate(MOVEMENT.fixedStep);
        this.updateCamera(0);
        this.updateSpeedEffects(0, this.elapsed, true);
        this.publishDiagnostics();
      },
      stepDrones: (seconds: number) => {
        const targetActivity = this.droneTargetSnapshots.map((target) => target.alive);
        for (const target of this.droneTargetSnapshots) target.alive = false;
        const steps = THREE.MathUtils.clamp(Math.ceil(seconds / MOVEMENT.fixedStep), 1, 3_600);
        for (let index = 0; index < steps; index += 1) {
          this.droneSwarm.update(MOVEMENT.fixedStep, this.elapsed, this.droneTargetSnapshots, () => undefined);
        }
        this.droneTargetSnapshots.forEach((target, index) => { target.alive = targetActivity[index]; });
        this.publishDiagnostics();
      },
      stepVisualEffects: (seconds: number) => {
        const safeSeconds = THREE.MathUtils.clamp(seconds, 0, 0.5);
        const steps = Math.max(1, Math.ceil(safeSeconds / MOVEMENT.fixedStep));
        for (let index = 0; index < steps; index += 1) this.weaponVfx.update(safeSeconds / steps);
        this.updateCamera(0);
        this.publishDiagnostics();
      },
      setPlayerKinematics: (position, velocity) => {
        this.mode = 'running';
        this.audio.setPaused(false);
        this.hud.hideStart();
        this.playerPosition.set(position.x, position.y, position.z);
        this.playerVelocity.set(velocity.x, velocity.y, velocity.z);
        this.jumpBuffer = 0;
        this.coyote = 0;
        this.dashBuffer = 0;
        this.dashMomentumTimer = 0;
        this.wallContactTimer = 0;
        this.ceilingContactTimer = 0;
        const contact = this.arena.resolvePlayerCapsule(this.playerPosition, this.playerVelocity);
        this.grounded = contact.grounded;
        this.terrainNormal.copy(contact.contactNormal);
        const horizontal = new THREE.Vector3(velocity.x, 0, velocity.z);
        if (horizontal.lengthSq() > 1e-5) {
          horizontal.normalize();
          this.yaw = Math.atan2(-horizontal.x, -horizontal.z);
        }
        this.updateCamera(0);
        this.updateSpeedEffects(0, this.elapsed, true);
        this.publishDiagnostics();
      },
      setFighterKinematics: (id, position, velocity, yaw = 0) => {
        const fighter = this.fighters.find((candidate) => candidate.id === id);
        if (!fighter) return false;
        if (this.playerFighter === fighter) this.playerFighter = null;
        resetFighterAtPad(fighter);
        const orientation = this.fighterQuaternionScratch.setFromEuler(new THREE.Euler(0, yaw, 0));
        resetFighterFlightState(
          fighter.flight,
          new THREE.Vector3(position.x, position.y, position.z),
          orientation,
        );
        fighter.flight.velocity.set(velocity.x, velocity.y, velocity.z);
        fighter.pilot = null;
        fighter.visual.root.position.copy(fighter.flight.position);
        fighter.visual.root.quaternion.copy(fighter.flight.orientation);
        this.publishDiagnostics();
        return true;
      },
      setSpeedCapture: (speedKmh: number) => {
        const speed = Math.max(0, speedKmh) / 3.6;
        this.mode = 'running';
        this.audio.setPaused(false);
        this.hud.hideStart();
        const view = this.viewDirection(new THREE.Vector3()).setY(0);
        if (view.lengthSq() < 0.001) view.set(0, 0, -1);
        view.normalize();
        const side = new THREE.Vector3(-view.z, 0, view.x);
        this.playerVelocity.copy(view).multiplyScalar(speed);
        const botPosition = this.playerPosition.clone().addScaledVector(view, 11).addScaledVector(side, 1.35);
        const botFloor = this.arena.floorHeightAt(botPosition.x, botPosition.z, botPosition.y + 8);
        if (botFloor !== null) botPosition.y = botFloor;
        this.bots[0].respawn(botPosition, false);
        this.bots[0].movementLocked = true;
        this.bots[0].velocity.copy(side).multiplyScalar(speed);
        for (let index = 1; index < this.bots.length; index += 1) {
          this.bots[index].movementLocked = true;
          this.bots[index].velocity.set(0, 0, 0);
        }
        this.updateCamera(0);
        this.updateSpeedEffects(0, this.elapsed, true);
        this.publishDiagnostics();
      },
      pickSceneObjects: (ndcX: number, ndcY: number) => {
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
        return raycaster.intersectObjects(this.scene.children, true)
          .filter((intersection) => intersection.object.visible)
          .slice(0, 24)
          .map((intersection) => ({
            name: intersection.object.name || intersection.object.parent?.name || '(unnamed)',
            distance: intersection.distance,
          }));
      },
      getStructureAudit: () => this.quickSenseStructureAudit(),
      getOutpostTowerAudit: () => (
        this.arena.group.userData.outpostTowerAudit as QuickSenseOutpostTowerAudit | undefined
      ) ?? null,
      getOutpostTowerReviewStates: () => [
        'quicksense-tower-exterior-south',
        'quicksense-tower-exterior-east',
        'quicksense-tower-exterior-north',
        'quicksense-tower-exterior-west',
        'quicksense-tower-terrain-entry-east',
        'quicksense-tower-lower-hall-east',
        'quicksense-tower-lower-hall-west',
        'quicksense-tower-stair-landing-player',
        'quicksense-tower-mid-stair-player',
        'quicksense-tower-interior-stair-player',
        'quicksense-tower-flight-deck-south',
        'quicksense-tower-flight-deck-north',
      ],
      getOutpostTowerVisibilityAudit: () => {
        const tower = this.arena.group.getObjectByName('QuickSense imported outpost tower');
        if (!tower) return null;
        const hierarchy: Array<{ name: string; visible: boolean }> = [];
        let current: THREE.Object3D | null = tower;
        while (current) {
          hierarchy.push({ name: current.name || current.type, visible: current.visible });
          current = current.parent;
        }
        let meshCount = 0;
        let visibleMeshCount = 0;
        let visibleMaterialCount = 0;
        tower.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (!mesh.isMesh) return;
          meshCount += 1;
          if (mesh.visible) visibleMeshCount += 1;
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          visibleMaterialCount += materials.filter((material) => material.visible && material.opacity > 0).length;
        });
        return { hierarchy, meshCount, visibleMeshCount, visibleMaterialCount };
      },
      getOutpostTowerPieceAudit: () => (
        this.arena.group.userData.outpostTowerPieces as QuickSenseOutpostTowerPieceAudit[] | undefined
      ) ?? [],
      getArenaRenderAudit: () => {
        const rows = new Map<string, {
          material: string;
          draws: number;
          shadowDraws: number;
          triangles: number;
          instances: number;
        }>();
        this.arena.group.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (!mesh.isMesh || !mesh.visible) return;
          const geometry = mesh.geometry;
          const positions = geometry.getAttribute('position');
          if (!positions) return;
          const triangles = (geometry.getIndex()?.count ?? positions.count) / 3;
          const instances = (mesh as THREE.InstancedMesh).isInstancedMesh
            ? (mesh as THREE.InstancedMesh).count
            : 1;
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const material of materials) {
            const key = material.name || material.type;
            const row = rows.get(key) ?? {
              material: key,
              draws: 0,
              shadowDraws: 0,
              triangles: 0,
              instances: 0,
            };
            row.draws += 1;
            row.shadowDraws += Number(mesh.castShadow);
            row.triangles += Math.round(triangles * instances);
            row.instances += instances;
            rows.set(key, row);
          }
        });
        return [...rows.values()].sort((left, right) => (
          right.draws + right.shadowDraws - left.draws - left.shadowDraws
        ));
      },
      hideDebugUi: () => undefined,
    };
  }

  private publishDiagnostics(): void {
    const info = this.renderer.info;
    const coreDirectorState = this.coreDirector.snapshot();
    const styleSnapshot = this.styleSystem.snapshot();
    const jetpackEnergy = this.jetpackEnergy.snapshot();
    window.__THREE_GAME_DIAGNOSTICS__ = {
      frame: this.frame,
      elapsed: this.elapsed,
      score: this.score,
      targetScore: SCORE_LIMIT,
      complete: this.mode === 'complete',
      state: this.mode,
      viewMode: this.viewMode,
      countdown: {
        remaining: this.countdownRemaining,
        cue: this.countdownCueIndex >= 0 ? MATCH_COUNTDOWN_CUES[this.countdownCueIndex] : null,
        armed: this.countdownArmed,
        weaponsLocked: this.mode === 'countdown',
      },
      health: this.health,
      armor: this.armor,
      worldHealthBars: this.worldHealthBars.snapshot(),
      weapon: WEAPONS[this.selectedWeapon].id,
      botsAlive: this.bots.filter((bot) => bot.alive).length,
      bots: this.bots.map((bot) => ({
        id: bot.id,
        displayName: bot.displayName,
        archetype: bot.archetype,
        alive: bot.alive,
        health: bot.health,
        armor: bot.armor,
        score: bot.score,
        weapon: bot.weapon,
        targetOwner: bot.targetOwner,
        targetVisible: bot.targetVisible,
        wantsToFire: bot.wantsToFire,
        facingDot: bot.facingDot,
        grounded: bot.grounded,
        stepSuccesses: bot.stepSuccesses,
        shotsFired: bot.shotsFired,
        navigationTarget: { x: bot.navigationTarget.x, y: bot.navigationTarget.y, z: bot.navigationTarget.z },
        modelReady: bot.modelReady,
        modelHeight: bot.modelHeight,
        modelCenterY: bot.modelCenterY,
        modelWidth: bot.modelWidth,
        modelDepth: bot.modelDepth,
        modelCenterX: bot.modelCenterX,
        modelCenterZ: bot.modelCenterZ,
        modelMeshCount: bot.modelMeshCount,
        renderedMeshCount: bot.renderedMeshCount,
        weaponSwitches: bot.weaponSwitches,
        bunnyHops: bot.bunnyHops,
        jetpackActive: bot.jetpackActive,
        jetpackBursts: bot.jetpackBursts,
        jetpackCharge: bot.jetpackCharge,
        jetpackLocked: bot.jetpackLocked,
        dashCooldown: bot.dashCooldown,
        dashesUsed: bot.dashesUsed,
        aimErrorDegrees: bot.aimErrorDegrees,
        aimTracking: bot.aimTracking,
        reactionRemaining: bot.reactionRemaining,
        grenadesThrown: bot.grenadesThrown,
        grapplesUsed: bot.grapplesUsed,
        grenadesRemaining: bot.grenadesRemaining,
        grappleActive: bot.grappleActive,
        collisionRecoveries: bot.collisionRecoveries,
        stalledFor: bot.stalledFor,
        wallContacts: bot.wallContacts,
        ceilingContacts: bot.ceilingContacts,
        position: { x: bot.group.position.x, y: bot.group.position.y, z: bot.group.position.z },
      })),
      fighters: this.fighters.map((fighter) => {
        const ai = typeof fighter.pilot === 'number'
          ? this.fighterAi.get(fighter.pilot)?.snapshot() ?? null
          : null;
        return {
          id: fighter.id,
          pad: fighter.pad.label,
          pilot: fighter.pilot,
          reservedBy: fighter.reservedBy,
          destroyed: fighter.destroyed,
          explosions: fighter.explosions,
          hull: fighter.hull,
          shield: fighter.shield,
          respawnSeconds: fighter.respawnSeconds,
          speed: fighter.flight.velocity.length(),
          grounded: fighter.flight.grounded,
          landingReady: fighter.flight.landingReady,
          afterburnerEnergy: fighter.flight.afterburnerEnergy,
          heat: fighter.flight.heat,
          modelReady: fighter.visual.isReady,
          visible: fighter.visual.root.visible,
          loadError: fighter.visual.loadError?.message ?? null,
          position: {
            x: fighter.flight.position.x,
            y: fighter.flight.position.y,
            z: fighter.flight.position.z,
          },
          velocity: {
            x: fighter.flight.velocity.x,
            y: fighter.flight.velocity.y,
            z: fighter.flight.velocity.z,
          },
          physics: {
            ceilingY: FIGHTER_FLIGHT_TUNING.bounds.maxY,
            steps: fighter.flight.diagnostics.steps,
            collisionQueries: fighter.flight.diagnostics.collisionQueries,
            collisionHits: fighter.flight.diagnostics.collisionHits,
            impacts: fighter.flight.diagnostics.impacts,
            boundsContacts: fighter.flight.diagnostics.boundsContacts,
            invalidCollisionHits: fighter.flight.diagnostics.invalidCollisionHits,
          },
          ai: ai ? {
            state: ai.state,
            transitionReason: ai.transitionReason,
            targetId: ai.targetId,
          } : null,
        };
      }),
      drones: this.droneSwarm.drones.map((drone) => ({
        id: drone.id,
        alive: drone.alive,
        health: drone.health,
        maxHealth: drone.maxHealth,
        state: drone.state,
        targetOwner: drone.targetOwner,
        respawnSeconds: drone.respawnSeconds,
        shotsFired: drone.shotsFired,
        beamActive: drone.beamActive,
        beamVisible: drone.visual.continuousBeamVisible,
        beamUptimeSeconds: drone.beamUptimeSeconds,
        beamDamageTicks: drone.beamDamageTicks,
        beamMissTicks: drone.beamMissTicks,
        beamOnTarget: drone.beamOnTarget,
        aimErrorDegrees: drone.aimErrorDegrees,
        beamLayers: drone.visual.continuousBeamLayerCount,
        beamHalos: drone.visual.continuousBeamHaloCount,
        beamParticles: drone.visual.continuousBeamParticleCount,
        explosions: drone.explosions,
        respawns: drone.respawns,
        collisionRadius: drone.collisionRadius,
        collisionHits: drone.collisionHits,
        modelReady: drone.visual.isReady,
        modelMeshCount: drone.visual.modelMeshCount,
        modelWidth: drone.visual.modelWidth,
        modelHeight: drone.visual.modelHeight,
        modelDepth: drone.visual.modelDepth,
        loadError: drone.visual.loadError?.message ?? null,
        targetedByBots: [...this.botDroneTargets.values()].filter((id) => id === drone.id).length,
        position: { x: drone.position.x, y: drone.position.y, z: drone.position.z },
        velocity: { x: drone.velocity.x, y: drone.velocity.y, z: drone.velocity.z },
      })),
      busterDrones: this.droneSwarm.busterDrones.map((drone) => ({
        id: drone.id,
        kind: drone.kind,
        alive: drone.alive,
        health: drone.health,
        maxHealth: drone.maxHealth,
        healthMultiplier: drone.maxHealth / DRONE_TUNING.maxHealth,
        state: drone.state,
        flightPattern: drone.flightPattern,
        targetOwner: drone.targetOwner,
        respawnSeconds: drone.respawnSeconds,
        collisionRadius: drone.collisionRadius,
        collisionHits: drone.collisionHits,
        shotsFired: drone.shotsFired,
        shardsFired: drone.shardsFired,
        shardHits: drone.shardHits,
        shardWorldImpacts: drone.shardWorldImpacts,
        activeShards: this.droneSwarm.activeShardCount,
        gazeDot: drone.gazeDot,
        gazeThreshold: drone.gazeThreshold,
        lookingAtTarget: drone.lookingAtTarget,
        aimErrorDegrees: drone.aimErrorDegrees,
        takeoffElapsed: drone.takeoffElapsed,
        takeoffs: drone.takeoffs,
        landings: drone.landings,
        grounded: drone.state === 'spool' || drone.state === 'landed',
        explosions: drone.explosions,
        respawns: drone.respawns,
        modelReady: drone.visual.isReady,
        modelMeshCount: drone.visual.modelMeshCount,
        modelWidth: drone.visual.modelWidth,
        modelHeight: drone.visual.modelHeight,
        modelDepth: drone.visual.modelDepth,
        rigNodeCount: drone.visual.rigNodeCount,
        animationClipName: drone.visual.animationClipName,
        animationClipDuration: drone.visual.animationClipDuration,
        animationTime: drone.visual.animationTime,
        animationPlaying: drone.visual.animationPlaying,
        loadError: drone.visual.loadError?.message ?? null,
        targetedByBots: [...this.botDroneTargets.values()].filter((id) => id === drone.id).length,
        position: { x: drone.position.x, y: drone.position.y, z: drone.position.z },
        velocity: { x: drone.velocity.x, y: drone.velocity.y, z: drone.velocity.z },
      })),
      busterShardPool: {
        active: this.droneSwarm.activeShardCount,
        capacity: this.droneSwarm.shardPoolSize,
        speed: BUSTER_DRONE_TUNING.shardSpeed,
        damage: BUSTER_DRONE_TUNING.shardDamage,
        lastSourceId: this.droneSwarm.lastShardSourceId,
        lastTargetOwner: this.droneSwarm.lastShardTargetOwner,
        lastWorldImpact: this.droneSwarm.lastShardWorldImpact,
        lastOrigin: {
          x: this.droneSwarm.lastShardOrigin.x,
          y: this.droneSwarm.lastShardOrigin.y,
          z: this.droneSwarm.lastShardOrigin.z,
        },
        lastImpact: {
          x: this.droneSwarm.lastShardImpact.x,
          y: this.droneSwarm.lastShardImpact.y,
          z: this.droneSwarm.lastShardImpact.z,
        },
      },
      projectiles: this.projectiles.length,
      grenades: this.grenades.length,
      grenadeStates: this.grenades.map((grenade) => ({
        position: {
          x: grenade.root.position.x,
          y: grenade.root.position.y,
          z: grenade.root.position.z,
        },
        velocity: {
          x: grenade.velocity.x,
          y: grenade.velocity.y,
          z: grenade.velocity.z,
        },
        bounces: grenade.bounces,
        modelName: grenade.root.getObjectByName('a-star-wars-grenade')?.name ?? 'missing',
      })),
      grapple: {
        active: this.grappleActive,
        anchor: { x: this.grappleAnchor.x, y: this.grappleAnchor.y, z: this.grappleAnchor.z },
        length: this.grappleLength,
        distance: Math.hypot(
          this.playerPosition.x - this.grappleAnchor.x,
          this.playerPosition.y + PLAYER_EYE - this.grappleAnchor.y,
          this.playerPosition.z - this.grappleAnchor.z,
        ),
        maxLength: GRAPPLE.maxLength,
      },
      tracers: this.weaponVfx.activeTracers,
      pickups: this.pickups.map((pickup) => ({
        kind: pickup.kind,
        active: pickup.active,
        modelName: pickup.group.name,
        groundOffset: pickup.group.position.y - Number(pickup.group.userData.baseY ?? pickup.group.position.y),
        position: {
          x: pickup.group.position.x,
          y: pickup.group.position.y,
          z: pickup.group.position.z,
        },
        supportY: Number(pickup.group.userData.baseY ?? pickup.group.position.y) - 0.012,
        hasAuthoredWeapon: Boolean(pickup.group.getObjectByName(`${pickup.kind}-pickup-weapon-model`)),
      })),
      coreProgress: this.coreProgress,
      core: {
        phase: coreDirectorState.phase,
        active: this.coreActive,
        contested: this.coreContested,
        owner: this.coreOwner,
        location: this.currentCoreAnchorName,
        nextLocation: coreDirectorState.nextAnchor?.name ?? null,
        secondsRemaining: coreDirectorState.secondsRemaining,
        cycle: coreDirectorState.cycle,
        captures: coreDirectorState.count,
      },
      style: {
        meter: styleSnapshot.meter,
        comboCount: styleSnapshot.comboCount,
        comboMultiplier: styleSnapshot.comboMultiplier,
        lastMedal: styleSnapshot.lastMedal?.label ?? null,
      },
      weather: {
        phase: this.weatherSnapshot.phase,
        label: this.weatherSnapshot.label,
        secondsRemaining: this.weatherSnapshot.secondsRemaining,
        severity: this.weatherSnapshot.severity,
        windDirection: { ...this.weatherSnapshot.windDirection },
        windStrength: this.weatherSnapshot.windStrength,
        multipliers: { ...this.weatherSnapshot.multipliers },
        visuals: this.arena.getWeatherVisualDiagnostics(),
      },
      map: this.arena.mapInfo,
      lighting: this.mapLighting.diagnostics(this.scene),
      fog: this.scene.fog instanceof THREE.Fog
        ? {
          type: 'linear',
          color: `#${this.scene.fog.color.getHexString()}`,
          near: this.scene.fog.near,
          far: this.scene.fog.far,
        }
        : null,
      player: {
        position: { x: this.playerPosition.x, y: this.playerPosition.y, z: this.playerPosition.z },
        velocity: { x: this.playerVelocity.x, y: this.playerVelocity.y, z: this.playerVelocity.z },
        speed: Math.hypot(this.playerVelocity.x, this.playerVelocity.z),
        rocketJumpCount: this.rocketJumpCount,
        grounded: this.grounded,
        skiing: this.skiHeld,
        jetpacking: this.jetpackActive,
        jetpackCharge: jetpackEnergy.charge,
        jetpackLocked: jetpackEnergy.locked,
        jetpackPhase: jetpackEnergy.phase,
        jetpackRechargeDelay: jetpackEnergy.rechargeDelayRemaining,
        jetpackRestartIn: jetpackEnergy.restartInSeconds,
        dashCooldown: this.dashCooldown,
        wallContact: this.wallContactTimer > 0,
        ceilingContact: this.ceilingContactTimer > 0,
        yaw: this.yaw,
        pitch: this.pitch,
        modelReady: this.playerAvatar.modelReady,
        modelMeshCount: this.playerAvatar.modelMeshCount,
        modelHeight: this.playerAvatar.modelHeight,
        modelWidth: this.playerAvatar.modelWidth,
        modelDepth: this.playerAvatar.modelDepth,
        avatarVisible: this.playerAvatar.root.visible,
        firstPersonWeaponVisible: this.weaponModel.visible,
        thirdPersonWeaponVisible: this.thirdPersonWeaponModel.visible,
        thirdPersonWeapon: this.thirdPersonWeaponVisual?.weapon ?? null,
        thirdPersonWeaponMeshes: this.thirdPersonWeaponVisual?.renderMeshCount ?? 0,
      },
      camera: {
        distance: this.camera.position.distanceTo(this.playerPosition),
        position: {
          x: this.camera.position.x,
          y: this.camera.position.y,
          z: this.camera.position.z,
        },
        thirdPersonObstructed: this.isThirdPerson()
          && this.thirdPersonCameraObstructed,
      },
      speedEffects: {
        thresholdKmh: SPEED_EFFECT_START_KMH,
        fullIntensityKmh: SPEED_EFFECT_FULL_KMH,
        playerSpeedKmh: Math.hypot(this.playerVelocity.x, this.playerVelocity.z) * 3.6,
        blurIntensity: this.speedBlurIntensity,
        activeTrailSources: this.speedTrails.activeSourceCount,
      },
      skiMomentum: {
        speedKmh: Math.hypot(this.playerVelocity.x, this.playerVelocity.z) * 3.6,
        resistance: this.skiMomentumResistance,
        gravityDriveScale: this.skiGravityDriveScale,
        dragAcceleration: this.skiDragAcceleration,
      },
      physics: {
        engine: 'fixed-step-capsule-heightfield-bvh',
        timestep: MOVEMENT.fixedStep,
        bodies: 1 + this.bots.length + this.fighters.length + this.projectiles.length + this.grenades.length,
        colliders: this.arena.collisionTriangles + this.bots.length + this.fighters.length * 6 + this.projectiles.length + this.grenades.length,
        ccdBodies: 1 + this.fighters.length + this.projectiles.length + this.grenades.length,
        sensors: this.pickups.filter((pickup) => pickup.active).length + (this.coreActive ? 1 : 0),
        contacts: this.lastPhysicsContacts,
        groundNormal: { x: this.terrainNormal.x, y: this.terrainNormal.y, z: this.terrainNormal.z },
        ccd: {
          sweeps: this.ccdSweeps,
          wallHits: this.ccdWallHits,
          ceilingHits: this.ccdCeilingHits,
          boundaryHits: this.ccdBoundaryHits,
        },
        stairs: {
          attempts: this.stepAttempts,
          successes: this.stepSuccesses,
          lastReason: this.lastStepReason,
          lastRise: this.lastStepRise,
          blockedDistance: this.lastStepBlockedDistance,
          travelDistance: this.lastStepTravelDistance,
          inputDistance: this.lastStepInputDistance,
          raisedSpeed: this.lastStepRaisedSpeed,
          startSpeed: this.lastStepStartSpeed,
          finalSpeed: this.lastStepFinalSpeed,
        },
      },
      renderer: {
        calls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        activeWeaponVfx: this.weaponVfx.activeEffects,
        activeSurfaceMarks: this.weaponVfx.activeMarks,
        activeTracers: this.weaponVfx.activeTracers,
        activeSoftSmoke: this.weaponVfx.activeSoftSmoke,
        smokeTextureSource: this.weaponVfx.smokeTextureSource,
        tracerTextureSource: this.weaponVfx.tracerTextureSource,
        weaponWearMaterials: this.weaponVisual?.battleWearMaterialCount ?? 0,
        weaponWearTextures: this.weaponVisual?.battleWearTextureCount ?? 0,
        weaponAssetSource: this.weaponVisual?.assetSource ?? 'procedural',
        weaponModelMeshes: this.weaponVisual?.meshCount ?? 0,
        weaponRenderMeshes: this.weaponVisual?.renderMeshCount ?? 0,
        weaponModelTriangles: this.weaponVisual?.triangleCount ?? 0,
        weaponTuck: this.weaponTuck,
        weaponObstructionDistance: this.weaponObstructionDistance,
        weaponViewPosition: {
          x: this.weaponModel.position.x,
          y: this.weaponModel.position.y,
          z: this.weaponModel.position.z,
        },
        weaponViewRotation: {
          x: this.weaponModel.rotation.x,
          y: this.weaponModel.rotation.y,
          z: this.weaponModel.rotation.z,
        },
        weaponMuzzleDistance: this.weaponMuzzleDistance,
        weaponMuzzleForwardDistance: this.weaponMuzzleForwardDistance,
        weaponMuzzleOccluded: this.weaponMuzzleOccluded,
        weaponPulseIntensity: this.weaponVisual?.pulseMaterials.reduce(
          (maximum, material) => Math.max(maximum, material.emissiveIntensity),
          0,
        ) ?? 0,
      },
      combat: {
        lastDamageDirection: this.lastDamageDirection,
        lastDamageBearing: this.lastDamageBearing,
        secondaryAbility: WEAPONS[this.selectedWeapon].secondary,
        altFireHeld: this.input.isAltFireHeld(),
        continuousLaserActive: this.weaponVfx.continuousLaserActive,
        continuousLaserBend: this.weaponVfx.continuousLaserBend,
        lastPelletCount: this.lastPelletCount,
        lastPelletSpread: this.lastPelletSpread,
        discBounceCount: this.discBounceCount,
        lastDiscBouncePosition: {
          x: this.lastDiscBouncePosition.x,
          y: this.lastDiscBouncePosition.y,
          z: this.lastDiscBouncePosition.z,
        },
        lastShotWeapon: this.lastShotWeapon,
        lastShotOrigin: {
          x: this.lastShotOrigin.x,
          y: this.lastShotOrigin.y,
          z: this.lastShotOrigin.z,
        },
        lastMuzzlePosition: {
          x: this.lastMuzzlePosition.x,
          y: this.lastMuzzlePosition.y,
          z: this.lastMuzzlePosition.z,
        },
        lastProjectileOrigin: {
          x: this.lastProjectileOrigin.x,
          y: this.lastProjectileOrigin.y,
          z: this.lastProjectileOrigin.z,
        },
        muzzleOffset: this.lastShotOrigin.distanceTo(this.lastMuzzlePosition),
        projectileMuzzleOffset: this.lastShotWeapon === 'rocket' || this.lastShotWeapon === 'plasma' || this.lastShotWeapon === 'disc'
          ? this.lastProjectileOrigin.distanceTo(this.lastMuzzlePosition)
          : null,
      },
      canvas: {
        clientWidth: this.canvas.clientWidth,
        clientHeight: this.canvas.clientHeight,
        width: this.canvas.width,
        height: this.canvas.height,
        dpr: this.renderer.getPixelRatio(),
      },
      pointerLocked: this.input.pointerLocked(),
      scope: {
        active: this.scopeBlend > 0.5,
        blend: this.scopeBlend,
        range: this.scopeRange,
        zoom: BASE_GAME_FOV / Math.max(24, this.camera.fov),
      },
      audio: this.audio.diagnostics(),
    };
  }

  private render(): void {
    if (this.physicsQaMode && this.physicsQaFrameRendered) return;
    this.renderer.info.reset();
    if (this.physicsQaMode || (this.softwareRenderer && !this.visualCapture)) {
      this.renderer.render(this.scene, this.camera);
      if (this.physicsQaMode) this.physicsQaFrameRendered = true;
      return;
    }

    // QuickSense's environment is static, so its authored directional shadow
    // atlas is valid after the first complete render. Rebuilding that 2048²
    // atlas resubmits hundreds of arena meshes in one frame and presents as a
    // recurring hitch rather than ordinary low FPS. Dynamic actors use their
    // own local grounding and do not justify stalling the entire map.
    this.composer.render();
    this.renderer.shadowMap.autoUpdate = false;
  }

  private element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const node = document.querySelector<T>(selector);
    if (!node) throw new Error(`Missing element: ${selector}`);
    return node;
  }

  private disposeObject(root: THREE.Object3D): void {
    const ownedTextures = new Set<THREE.Texture>();
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry && !mesh.geometry.userData.sharedWeaponVfx) mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of materials) {
        if (material.userData.sharedWeaponVfx) continue;
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture && value.userData.disposeWithMaterial) ownedTextures.add(value);
        }
        material.dispose();
      }
    });
    for (const texture of ownedTextures) texture.dispose();
  }
}
