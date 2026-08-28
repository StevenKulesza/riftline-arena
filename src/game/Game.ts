import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createWeaponViewModel, updateWeaponViewModel, type WeaponViewModel } from '../assets/WeaponViewModel';
import { JetpackRig } from '../assets/JetpackRig';
import { PlayerAvatar } from '../assets/PlayerAvatar';
import { InputController } from '../core/InputController';
import { Loop } from '../core/Loop';
import { createRenderer, getRenderDpr, resizeRenderer } from '../core/Renderer';
import { Bot } from '../entities/Bot';
import { AudioSystem } from '../systems/AudioSystem';
import { AdaptiveQualitySystem } from '../systems/AdaptiveQualitySystem';
import { FluxCoreDirector, type FluxCoreAnchor } from '../systems/FluxCoreDirector';
import { Hud } from '../systems/Hud';
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
import { createSeededRandom } from '../utils/random';
import { Arena, type ArenaRuntime, type ArenaSurface, type CapsuleContact } from './Arena';
import { GRAPPLE, GRENADE, MATCH_DURATION, MOVEMENT, POWERUP, SCORE_LIMIT, WEAPONS, type WeaponDefinition, type WeaponId } from './config';
import { skiMomentumCurve, type SkiMomentumCurve } from './SkiMomentum';

type GameMode = 'ready' | 'countdown' | 'running' | 'respawning' | 'paused' | 'complete';
type ViewMode = 'first-person' | 'third-person';
type Owner = 'player' | number;
type PickupKind = 'health' | 'armor' | 'damage' | 'speed' | WeaponId;
type CountdownCue = 'READY' | '3' | '2' | '1';
type CoreAnchor = FluxCoreAnchor & { readonly position: THREE.Vector3 };
type PlayerSweepResult = {
  wallNormal: THREE.Vector3 | null;
  ceilingNormal: THREE.Vector3 | null;
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
const MAX_FIXED_STEPS_PER_FRAME = 4;
const HUD_UPDATE_INTERVAL = 1 / 15;
const DIAGNOSTICS_UPDATE_INTERVAL = 1 / 4;
const BASE_GAME_FOV = 80;
const THIRD_PERSON_FOV = 62;
const MAX_SPEED_FOV = 98;
const QUICKSENSE_FOG_DENSITY = 0.00074;
const WEAPON_VIEW_RETRACT_DISTANCE = 2.45;
const WEAPON_VIEW_CLEARANCE = 0.1;
const WEAPON_OBSTRUCTION_PROBE_LENGTH = 3.35;
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
const THIRD_PERSON_CAMERA_PORTRAIT_DISTANCE_SCALE = 0.72;
const THIRD_PERSON_CAMERA_PORTRAIT_DISTANCE_MAX = 0.45;
const THIRD_PERSON_CAMERA_SHOULDER_MIN = 0.3;
const THIRD_PERSON_CAMERA_SHOULDER_MAX = 0.82;
const THIRD_PERSON_CAMERA_SHOULDER_ASPECT_SCALE = 0.46;
const THIRD_PERSON_CAMERA_HEIGHT = 1.55;
const THIRD_PERSON_CAMERA_TARGET_HEIGHT = 1.08;
const THIRD_PERSON_CAMERA_CLEARANCE = 0.26;
const THIRD_PERSON_CAMERA_GROUND_CLEARANCE = 0.42;
const THIRD_PERSON_CAMERA_TERRAIN_HEADROOM = 1.25;
const THIRD_PERSON_CAMERA_MAX_LIFT = 1.65;
const THIRD_PERSON_CAMERA_TERRAIN_PROBES = 4;

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private inkPass!: ShaderPass;
  private readonly shadowRefreshInterval = 240;
  private readonly scene = new THREE.Scene();
  private readonly speedTrails = new SpeedTrailSystem(this.scene, 4);
  private readonly camera = new THREE.PerspectiveCamera(BASE_GAME_FOV, 1, 0.08, 1400);
  private readonly input: InputController;
  private readonly arena: ArenaRuntime;
  private readonly audio = new AudioSystem();
  private readonly hud = new Hud();
  private readonly weaponVfx: WeaponVfxSystem;
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
  private readonly projectiles: Projectile[] = [];
  private readonly grenades: GrenadeEntity[] = [];
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
  private weaponVisual?: WeaponViewModel;
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
  private readonly physicsQaMode = new URLSearchParams(window.location.search).get('qa') === 'physics';
  private environmentTexture?: THREE.Texture;

  private rng = createSeededRandom(450600);
  private mode: GameMode = 'ready';
  private accumulator = 0;
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
  private readonly weaponTurnSway = new THREE.Vector2();
  private readonly cameraDirectionScratch = new THREE.Vector3();
  private readonly audioDirectionScratch = new THREE.Vector3();
  private readonly cameraEyeScratch = new THREE.Vector3();
  private readonly cameraProbeScratch = new THREE.Vector3();
  private readonly weaponProbeScratch = new THREE.Vector3();
  private readonly cameraRightScratch = new THREE.Vector3();
  private readonly cameraDownScratch = new THREE.Vector3();
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
  private readonly sweepOffsets = Array.from({ length: 3 }, () => new THREE.Vector3());
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

  static async create(canvas: HTMLCanvasElement): Promise<Game> {
    return new Game(canvas, await Arena.load());
  }

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    arena: ArenaRuntime,
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
    this.visualCapture = visualCapture;
    this.maxRenderDpr = this.softwareRenderer
      ? visualCapture
        ? 1
        : diagnosticCapture
          ? 0.75
          : 0.25
      : this.mobileQuality
        ? 1
        : 1.25;
    this.renderDprCap = this.maxRenderDpr;
    this.adaptiveQuality = new AdaptiveQualitySystem({
      minDpr: this.softwareRenderer ? this.maxRenderDpr : this.mobileQuality ? 0.7 : 0.75,
      maxDpr: this.maxRenderDpr,
      sampleWindowMs: 750,
      dprStep: 0.25,
      degradeCooldownMs: 750,
    });
    // Ordinary software-rendered play stays cheap, but explicit QA captures
    // must retain the grounding/contact shadows being judged. Otherwise the
    // screenshot path materially understates the real GPU presentation.
    if (this.softwareRenderer && !visualCapture) this.renderer.shadowMap.enabled = false;
    this.renderer.info.autoReset = false;
    this.renderer.toneMappingExposure = new URLSearchParams(window.location.search).get('map') === 'quicksense'
      ? 0.95
      : 0.86;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
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
    );
    this.weaponVfx = new WeaponVfxSystem(this.scene, this.camera, () => this.rng());
    this.createScene();
    this.scene.add(this.playerAvatar.root);
    this.composer = this.createPostProcessing();
    this.createBots();
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
    this.weaponVfx.prewarm(this.renderer);
    this.prewarmSceneResources();
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
    this.installTestHooks();
    this.updateCamera(0);
    this.updateViewModeUi();
    this.publishDiagnostics();
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
    this.scene.traverse((object) => {
      if (!object.frustumCulled || !(object as THREE.Mesh).isMesh) return;
      restoreCulling.push(object);
      object.frustumCulled = false;
    });
    this.renderer.compile(this.scene, this.camera);
    this.renderer.render(this.scene, this.camera);
    for (const object of restoreCulling) object.frustumCulled = true;
    this.renderer.info.reset();
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
    this.arena.dispose();
    for (const bot of this.bots) bot.dispose();
    for (const projectile of this.projectiles) this.disposeObject(projectile.root);
    for (const grenade of this.grenades) this.disposeObject(grenade.root);
    for (const pickup of this.pickups) this.disposeObject(pickup.group);
    this.disposeObject(this.coreGroup);
    this.disposeObject(this.weaponModel);
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
    const qualityChange = this.softwareRenderer ? null : this.adaptiveQuality.sampleFrame(delta * 1_000);
    if (qualityChange) this.renderDprCap = qualityChange.dprCap;
    if (resizeRenderer(this.renderer, this.camera, this.renderDprCap)) this.resizePostProcessing();

    this.input.consumeLook(this.lookInput);
    if (this.sniperScopeRequested()) this.lookInput.multiplyScalar(0.28);
    this.yaw -= this.lookInput.x * 0.0018;
    this.pitch = THREE.MathUtils.clamp(this.pitch - this.lookInput.y * 0.0016, -1.28, 1.22);
    if (this.input.consumeJump()) this.jumpBuffer = MOVEMENT.jumpBuffer;
    if (this.input.consumeDash()) this.dashBuffer = 0.12;
    if (this.input.consumeGrapple()) this.toggleGrapple();
    if (this.input.consumeGrenade()) this.tryThrowGrenade();
    if (this.grappleActive && !this.input.isGrappleHeld()) this.detachGrapple();
    this.handleWeaponRequest();
    if (this.input.consumeAltFire()) this.trySecondaryFire();
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
    this.playerJetpack.update(this.jetpackActive, this.pausedForScreenshot ? 0 : delta, elapsed, this.reducedMotion);
    this.playerJetpack.root.visible = !this.isThirdPerson() && this.playerJetpack.root.visible;
    this.playerAvatar.root.position.copy(this.playerPosition);
    this.playerAvatar.setPose(this.yaw, this.moveInput.x);
    this.playerAvatar.update(
      this.pausedForScreenshot ? 0 : delta,
      elapsed,
      this.grounded,
      Math.hypot(this.playerVelocity.x, this.playerVelocity.z),
      this.input.isFireHeld(),
      this.jetpackActive,
      this.reducedMotion,
    );
    this.audio.setJetpackActive(this.jetpackActive);
    this.updateCamera(delta);
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
      this.jetpackActive = false;
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
    if (this.scene.fog instanceof THREE.FogExp2) {
      const baseline = this.arena.mapInfo.name === 'QuickSense' ? QUICKSENSE_FOG_DENSITY : 0.00146;
      this.scene.fog.density = baseline / Math.max(0.82, this.weatherSnapshot.multipliers.visibilityMultiplier);
    }

    this.updatePlayerMovement(delta);
    this.maxPlayerSpeed = Math.max(this.maxPlayerSpeed, Math.hypot(this.playerVelocity.x, this.playerVelocity.z));
    this.updateGrapple(delta);
    if (!this.physicsQaMode) this.updateBots(delta);
    this.updateProjectiles(delta);
    this.updateGrenades(delta);
    this.updatePickups(delta);
    this.updateCore(delta);
    if (this.input.isFireHeld()) {
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

    this.jetpackActive = !this.grounded && this.input.isJumpHeld();

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
        const height = MOVEMENT.playerHeight * 0.5;
        this.sweepOffsets[0].copy(front).setY(height);
        this.sweepOffsets[1].copy(front).add(halfSide).setY(height);
        this.sweepOffsets[2].copy(front).sub(halfSide).setY(height);
        wallOffsetCount = 3;
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

  private updateBots(delta: number): void {
    for (const bot of this.bots) {
      if (bot.readyToRespawn()) {
        bot.respawn(this.selectSafeSpawn(bot.id));
      }
      if (!bot.alive) {
        bot.update(delta, this.elapsed, bot.group.position, this.arena.corePosition, false);
        continue;
      }
      if (bot.consumeRecoveryRequest()) {
        bot.respawn(this.selectSafeSpawn(bot.id, bot.navigationTarget));
        bot.collisionRecoveries += 1;
      }

      const targetOwner = this.chooseBotTarget(bot);
      bot.targetOwner = targetOwner;
      if (targetOwner !== null) this.botTargets.set(bot.id, targetOwner);
      else this.botTargets.delete(bot.id);
      const botEye = bot.group.position.clone().add(new THREE.Vector3(0, 1.5, 0));
      const target = targetOwner === null ? this.arena.corePosition : this.ownerPosition(targetOwner, 1.05);
      const visibilityRange = 155 * this.weatherSnapshot.multipliers.visibilityMultiplier;
      const canSeeTarget = targetOwner !== null
        && botEye.distanceToSquared(target) <= visibilityRange * visibilityRange
        && this.arena.hasLineOfSight(botEye, target, 0.3);
      const objective = this.chooseBotObjective(bot, target, canSeeTarget);
      bot.update(delta, this.elapsed, target, objective, canSeeTarget);
      if (bot.wantsToThrowGrenade && targetOwner !== null) this.botThrowGrenade(bot, targetOwner);
      if (bot.wantsToFire && targetOwner !== null) this.botFire(bot, targetOwner);
    }
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
    this.weaponVfx.beam(origin, visibleEnd, visualWeapon, definition.color, bot.weapon === 'rail' ? 0.13 : 0.065);
    const toTarget = target.sub(origin);
    const along = toTarget.dot(bot.aimDirection);
    const closest = origin.clone().addScaledVector(bot.aimDirection, along);
    const worldDistance = worldHit ? origin.distanceTo(worldHit) : range;
    const hitRadius = bot.weapon === 'shotgun' ? 1.75 : bot.weapon === 'machine' ? 1.08 : 0.82;
    let targetHit = false;
    if (along > 0 && along <= worldDistance + 0.02 && closest.distanceTo(this.ownerPosition(targetOwner, 0.9)) < hitRadius) {
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

  private applyDamageToOwner(owner: Owner, damage: number, attacker: Owner, cause: string, hitOrigin?: THREE.Vector3): void {
    if (owner === 'player') this.damagePlayer(damage, attacker, cause.toUpperCase(), hitOrigin);
    else this.applyDamageToBot(this.bots[owner], damage, attacker, cause);
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
    const direction = this.shotDirectionFromMuzzle(origin, 120);
    this.recordPlayerShot(definition.id, origin);
    this.weaponVfx.muzzle(definition.id, definition.color, this.muzzleSocket);
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
        if (trace.first) {
          const distance = trace.first.t;
          const falloff = 1 - THREE.MathUtils.smoothstep(distance, definition.falloffStart ?? 5, definition.falloffEnd ?? 30) * 0.58;
          const locationMultiplier = trace.first.zone === 'head' ? 1.25 : 1;
          hits.set(trace.first.bot, (hits.get(trace.first.bot) ?? 0) + definition.damage * falloff * locationMultiplier);
        }
        const pelletEnd = trace.first?.point ?? trace.end;
        this.weaponVfx.beam(origin, pelletEnd, definition.id, definition.color, 0.055 + pellet * 0.0015);
        if (!trace.first && trace.worldHit) {
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
      const end = piercing ? trace.end : trace.first?.point ?? trace.end;
      this.weaponVfx.beam(origin, end, definition.id, definition.color, definition.id === 'rail' ? 0.2 : 0.085);
      if (!trace.first && trace.worldHit) {
        this.weaponVfx.mark(trace.worldHit, trace.worldNormal ?? new THREE.Vector3(0, 1, 0), definition.id, definition.color);
        this.weaponVfx.impact(trace.worldHit, definition.color, definition.id, trace.worldNormal ?? undefined);
        this.registerConcreteTraceImpact(trace, definition.damage);
      }
      if (trace.first && definition.id === 'machine') {
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
    const botVisible = botHit !== null;
    const end = botVisible ? botHit.point : trace.end;
    this.audio.setLaserBeamActive(true);
    this.weaponVfx.updateContinuousLaser(origin, end, definition.color, delta);
    this.recordPlayerShot('laser', origin);
    this.laserHeat = Math.min(1.1, this.laserHeat + delta * (focused ? 1.08 : 0.7));

    if (!wasActive) this.weaponVfx.muzzle('laser', definition.color, this.muzzleSocket);
    if (this.weaponCooldown > 0) return;

    this.weaponCooldown = definition.cooldown * (focused ? 1.35 : 1);
    this.ammo.set('laser', Math.max(0, ammo - ammoCost));
    this.recoil = Math.min(0.34, this.recoil + definition.recoil);
    this.trauma = Math.min(0.22, this.trauma + definition.trauma);
    if (botVisible && botHit) {
      this.applyDamageToBot(
        botHit.bot,
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
    this.weaponVfx.muzzle(definition.id, definition.color, this.muzzleSocket);

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
      const end = trace.first?.point ?? trace.end;
      this.weaponVfx.beam(origin, end, 'shotgun', 0xffe2a6, 0.16);
      if (!trace.first && trace.worldHit) {
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
      if (!trace.first && trace.worldHit) {
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
    this.camera.position.copy(this.playerPosition).add(new THREE.Vector3(0, PLAYER_EYE, 0));
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    this.camera.updateMatrixWorld(true);
    this.muzzleSocket.updateWorldMatrix(true, false);
    return this.muzzleSocket.getWorldPosition(new THREE.Vector3());
  }

  private shotDirectionFromMuzzle(origin: THREE.Vector3, range: number): THREE.Vector3 {
    const eye = this.playerPosition.clone().add(new THREE.Vector3(0, PLAYER_EYE, 0));
    const view = this.viewDirection();
    const cameraEnd = eye.clone().addScaledVector(view, range);
    const aimPoint = this.arena.segmentHit(eye, cameraEnd) ?? cameraEnd;
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
    worldHit: THREE.Vector3 | null;
    worldNormal: THREE.Vector3 | null;
    worldSurface: ArenaSurface | null;
    end: THREE.Vector3;
  } {
    const rangeEnd = origin.clone().addScaledVector(direction, range);
    const surfaceHit = this.arena.segmentHitDetails(origin, rangeEnd);
    const worldHit = surfaceHit?.point ?? null;
    const worldDistance = surfaceHit?.distance ?? range;
    const ray = new THREE.Ray(origin, direction);
    const hits: Array<{ bot: Bot; t: number; point: THREE.Vector3; zone: 'body' | 'head' }> = [];
    for (const bot of this.bots) {
      if (!bot.alive) continue;
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
    if (damage > 0) {
      const targets = piercing ? hits : hits.slice(0, 1);
      for (const hit of targets) {
        const criticalMultiplier = hit.zone === 'head'
          ? weaponId === 'sniper' ? 1.75 : weaponId === 'rail' ? 1.35 : weaponId === 'machine' ? 1.25 : 1.15
          : 1;
        this.applyDamageToBot(hit.bot, damage * criticalMultiplier, 'player', weaponName);
      }
    }
    return {
      first: hits[0] ?? null,
      worldHit,
      worldNormal: surfaceHit?.normal ?? null,
      worldSurface: surfaceHit?.surface ?? null,
      end: worldHit ?? rangeEnd,
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
    const root = this.weaponVfx.createProjectile(projectileWeapon, definition.color);
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
      const steps = Math.max(1, Math.ceil(distance / 0.14));
      const step = delta / steps;
      for (let substep = 0; substep < steps; substep += 1) {
        grenade.velocity.y -= GRENADE.gravity * step;
        const previousPosition = grenade.root.position.clone();
        grenade.root.position.addScaledVector(grenade.velocity, step);
        const surfaceHit = this.arena.segmentHitDetails(previousPosition, grenade.root.position);
        if (!surfaceHit) continue;
        grenade.root.position.copy(surfaceHit.point).addScaledVector(surfaceHit.normal, GRENADE.radius * 0.72);
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
        for (const bot of this.bots) {
          if (!bot.alive || (projectile.owner === bot.id && (projectile.weapon !== 'disc' || projectile.ownerSafeTime > 0))) continue;
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
        if (!remove && (projectile.owner !== 'player' || (projectile.weapon === 'disc' && projectile.ownerSafeTime <= 0)) && this.mode === 'running'
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
      if (!bot.alive || bot === directlyHit || projectile.owner === bot.id) continue;
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
    const playerCenter = this.playerPosition.clone().add(new THREE.Vector3(0, 0.9, 0));
    const playerDistance = playerCenter.distanceTo(position);
    if (!directlyHitPlayer && playerDistance < projectile.splash && this.mode === 'running' && this.explosionHasLineOfSight(position, playerCenter)) {
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

  private applyDamageToBot(bot: Bot, damage: number, owner: Owner, weaponName: string): void {
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
    } else {
      const shooter = this.bots[owner];
      if (shooter) {
        shooter.score += 1;
        this.hud.message(`${shooter.displayName} FRAGGED ${bot.displayName} · ${weaponName.toUpperCase()}`);
      }
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

  private damagePlayer(amount: number, owner: Owner, cause: string, hitOrigin?: THREE.Vector3): void {
    if (this.mode !== 'running') return;
    const armored = this.armor > 0;
    const absorbed = Math.min(this.armor, amount * 0.66);
    this.armor -= absorbed;
    this.health -= amount - absorbed;
    this.lastDamageDirection = this.resolveDamageDirection(owner, hitOrigin);
    this.hud.damage(this.lastDamageDirection);
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
      else this.bots[owner].score += 1;
      this.audio.death();
      this.hud.message(owner === 'player' ? `SELF-DESTRUCT · ${cause}` : `${this.bots[owner].displayName} FRAGGED YOU · ${cause}`);
    }
  }

  private resolveDamageDirection(owner: Owner, hitOrigin?: THREE.Vector3): string {
    if (owner === 'player') return 'self';
    const source = hitOrigin ?? this.bots[owner]?.group.position;
    if (!source) return 'front';
    const incoming = source.clone().sub(this.playerPosition).setY(0);
    if (incoming.lengthSq() < 0.001) return 'front';
    incoming.normalize();
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const forwardDot = incoming.dot(forward);
    const rightDot = incoming.dot(right);
    if (Math.abs(rightDot) > Math.abs(forwardDot)) return rightDot > 0 ? 'right' : 'left';
    return forwardDot > 0 ? 'front' : 'back';
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
      if (pickup.group.position.distanceTo(this.playerPosition.clone().add(new THREE.Vector3(0, 0.8, 0))) <= 1.75) {
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
      this.coreLight.visible = telegraphing;
      this.coreLight.intensity = telegraphing ? 2.2 : 6;
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
    this.coreLight.visible = false;
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
    bob: number,
  ): void {
    // At full obstruction the parent crosses behind the camera while the
    // visible nose folds out of the lower viewport. This range is large enough
    // to clear the longest launcher, rather than merely nudging its receiver.
    this.weaponModel.position.set(
      0.3 + this.weaponTurnSway.x + walkSwayX,
      -0.54 - this.recoil * 0.08 - this.weaponTuck * 0.52 - this.scopeBlend * 1.25
        + this.weaponTurnSway.y + walkSwayY + jumpLag + bob,
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

  private updateCamera(delta: number): void {
    const direction = this.viewDirection(this.cameraDirectionScratch);
    this.playerAvatar.root.position.copy(this.playerPosition);
    this.playerAvatar.setPose(this.yaw, this.moveInput.x);
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
        .addScaledVector(direction, 4.8);
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
    const walkWeight = this.grounded && !this.skiHeld ? THREE.MathUtils.smoothstep(speed, 1.5, 11) : 0;
    this.weaponBobPhase += motionDelta * (4.8 + Math.min(18, speed) * 0.62) * walkWeight;
    const turnTargetX = THREE.MathUtils.clamp(-this.lookInput.x * 0.00072, -0.072, 0.072);
    const turnTargetY = THREE.MathUtils.clamp(this.lookInput.y * 0.00062, -0.055, 0.055);
    this.weaponTurnSway.x = THREE.MathUtils.lerp(this.weaponTurnSway.x, turnTargetX, 1 - Math.exp(-motionDelta * 15));
    this.weaponTurnSway.y = THREE.MathUtils.lerp(this.weaponTurnSway.y, turnTargetY, 1 - Math.exp(-motionDelta * 15));
    const walkSwayX = Math.sin(this.weaponBobPhase) * 0.022 * walkWeight;
    const walkSwayY = -Math.abs(Math.cos(this.weaponBobPhase)) * 0.014 * walkWeight;
    const jumpLag = THREE.MathUtils.clamp(-this.playerVelocity.y * 0.0065, -0.072, 0.072);
    const strafeRoll = THREE.MathUtils.clamp(-this.moveInput.x * speed * 0.00125, -0.028, 0.028);
    this.camera.updateMatrixWorld(true);
    const probeOrigin = this.camera.position;
    const probeLength = WEAPON_OBSTRUCTION_PROBE_LENGTH;
    const wallProbeEnd = this.cameraProbeScratch.copy(probeOrigin).addScaledVector(direction, probeLength);
    const centerObstruction = this.arena.segmentHitDetails(probeOrigin, wallProbeEnd);
    // The FPS weapon sits low/right, so a center ray alone misses wall edges
    // and sloped terrain already intersecting the visible barrel envelope.
    this.cameraRightScratch.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    this.cameraDownScratch.set(0, -1, 0).applyQuaternion(this.camera.quaternion);
    const weaponProbeEnd = this.weaponProbeScratch.copy(wallProbeEnd)
      .addScaledVector(this.cameraRightScratch, 0.38)
      .addScaledVector(this.cameraDownScratch, 0.3);
    const weaponObstruction = this.arena.segmentHitDetails(probeOrigin, weaponProbeEnd);
    this.weaponObstructionDistance = Math.min(
      centerObstruction?.distance ?? probeLength,
      weaponObstruction?.distance ?? probeLength,
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
    const aimPointLocal = this.camera.worldToLocal(this.cameraLocalAimScratch.copy(aimPointWorld));
    const bob = this.reducedMotion
      ? 0
      : Math.sin(this.elapsed * Math.min(18, 5 + speed)) * Math.min(0.025, speed * 0.0008);
    this.applyWeaponViewPose(aimPointLocal, walkSwayX, walkSwayY, jumpLag, strafeRoll, downwardAim, bob);

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
    if (this.jetpackActive) powerups.push('JET THRUST');
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
      weapon: definition.name,
      secondary: definition.secondary.toUpperCase(),
      ammo: this.ammo.get(definition.id) ?? 0,
      coreProgress: this.coreProgress,
      coreStatus,
      matchStatus: resolvedMatchStatus,
      fps: this.fps,
      powerups,
      railTimer: rail?.active ? 0 : rail?.cooldown ?? 0,
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
    this.coreLight.visible = false;
    this.styleSystem.reset();
    this.recentPlayerKills.length = 0;
    this.weatherSnapshot = this.weatherSystem.reset();
    this.arena.setWeatherGameplaySnapshot(this.weatherSnapshot);
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.density = this.arena.mapInfo.name === 'QuickSense' ? QUICKSENSE_FOG_DENSITY : 0.00146;
    }
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

  private createScene(): void {
    const quickSense = this.arena.mapInfo.name === 'QuickSense';
    // QuickSense uses the authored equirectangular panorama as its live value
    // backdrop. Keep the procedural sky only for offline/failed asset loads.
    this.scene.background = quickSense
      ? this.arena.skyTexture ?? new THREE.Color(0x75b6df)
      : this.arena.skyTexture ?? new THREE.Color(0x8fcddd);
    this.scene.backgroundIntensity = quickSense
      ? (this.arena.skyTexture ? 0.84 : 0.96)
      : 0.78;
    this.scene.backgroundBlurriness = this.arena.skyTexture ? 0.02 : 0.035;
    this.scene.fog = new THREE.FogExp2(quickSense ? 0x6f899a : 0x7293a0, quickSense ? QUICKSENSE_FOG_DENSITY : 0.00146);
    const environmentGenerator = new THREE.PMREMGenerator(this.renderer);
    // Keep the 4K panorama as the authored background. A compact PMREM studio
    // provides predictable PBR fill without prefiltering that large image on
    // startup (which is especially costly on integrated and software GPUs).
    this.environmentTexture = environmentGenerator.fromScene(new RoomEnvironment(), 0.03).texture;
    this.scene.environment = this.environmentTexture;
    this.scene.environmentIntensity = quickSense ? 0.56 : 0.72;
    environmentGenerator.dispose();
    if (!this.arena.skyTexture) this.scene.add(this.createSky(quickSense));
    this.scene.add(new THREE.AmbientLight(0x607786, quickSense ? 0.032 : 0.11));
    const hemisphere = new THREE.HemisphereLight(
      quickSense ? 0x9fc5dc : 0xb4d7e3,
      quickSense ? 0x242d28 : 0x263825,
      quickSense ? 0.58 : 0.76,
    );
    this.scene.add(hemisphere);
    const sun = new THREE.DirectionalLight(0xfff1df, quickSense ? 2.12 : 1.86);
    sun.position.set(quickSense ? -205 : 135, quickSense ? 255 : 190, quickSense ? -145 : 105);
    sun.castShadow = true;
    const shadowMapSize = quickSense && this.mobileQuality ? 1024 : 2048;
    sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    sun.shadow.camera.near = 20;
    sun.shadow.camera.far = quickSense ? 540 : 520;
    const shadowExtent = quickSense ? 235 : 210;
    sun.shadow.camera.left = -shadowExtent;
    sun.shadow.camera.right = shadowExtent;
    sun.shadow.camera.top = shadowExtent;
    sun.shadow.camera.bottom = -shadowExtent;
    sun.shadow.bias = quickSense ? -0.00018 : -0.00035;
    sun.shadow.normalBias = quickSense ? 0.018 : 0.035;
    this.scene.add(sun);
    this.coreLight.position.copy(this.arena.corePosition).add(new THREE.Vector3(0, 6, 0));
    this.coreLight.visible = false;
    this.scene.add(this.coreLight);
    const rim = new THREE.DirectionalLight(0x6aa7d4, quickSense ? 0.3 : 0.56);
    rim.position.set(quickSense ? 165 : -90, quickSense ? 115 : 70, quickSense ? 185 : -120);
    this.scene.add(rim);
    this.scene.add(this.arena.group);
  }

  private createPostProcessing(): EffectComposer {
    const quickSense = this.arena.mapInfo.name === 'QuickSense';
    const composer = new EffectComposer(this.renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));
    composer.addPass(new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      quickSense ? (this.mobileQuality ? 0.075 : 0.14) : (this.mobileQuality ? 0.12 : 0.28),
      quickSense ? 0.24 : 0.34,
      quickSense ? 1.08 : 1.08,
    ));
    this.inkPass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        resolution: { value: new THREE.Vector2(1, 1) },
        edgeStrength: { value: quickSense ? (this.mobileQuality ? 0.035 : 0.05) : (this.mobileQuality ? 0.08 : 0.115) },
        vignette: { value: quickSense ? 0.07 : 0.16 },
        gradeStrength: { value: quickSense ? 1 : 0 },
        gradeContrast: { value: quickSense ? 1.055 : 1 },
        neutralDarken: { value: quickSense ? 0.085 : 0 },
        shadowCool: { value: quickSense ? 0.18 : 0 },
        shadowLift: { value: quickSense ? 0.009 : 0 },
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
          float greenOverBlue = graded.g / max(graded.b, 0.001);
          float blueShare = graded.b / max(graded.r, 0.001);
          float warmRoseMask = smoothstep(1.18, 1.62, redOverGreen)
            * smoothstep(1.08, 1.72, greenOverBlue)
            * smoothstep(0.11, 0.24, blueShare)
            * (1.0 - smoothstep(0.46, 0.68, blueShare));
          vec3 terracottaRoute = vec3(signalPeak, signalPeak * 0.42, signalPeak * 0.18);
          graded = mix(graded, terracottaRoute, routeHueSeparation * warmRoseMask * 0.92);
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
      const floor = this.arena.floorHeightAt(authored.x, authored.z, authored.y + 4) ?? authored.y - 0.9;
      group.position.set(authored.x, floor + 0.012, authored.z);
      group.userData.baseY = floor + 0.012;
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
    this.disposeObject(this.weaponModel);
    this.weaponModel.clear();
    const definition = WEAPONS[this.selectedWeapon];
    this.weaponVisual = createWeaponViewModel(definition, !this.weaponInspectionMode, !this.weaponInspectionMode);
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

  private installTestHooks(): void {
    window.__THREE_GAME_TEST_HOOKS__ = {
      seed: (value: number) => {
        this.rng = createSeededRandom(value);
      },
      setState: (name: string) => {
        this.cancelMatchCountdown();
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
        } else if (name === 'quicksense-overlook') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.screenshotCameraFov = 55;
          this.playerPosition.set(0, 520, -20);
          this.playerVelocity.set(0, 0, 0);
          this.screenshotLookTarget.set(0, 8, 0);
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
        } else if (name === 'quicksense-ramp') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.screenshotCameraFov = 58;
          this.playerPosition.set(-46, 42, -150);
          this.playerVelocity.set(0, 0, 0);
          this.screenshotLookTarget.set(0, 26, -74);
          this.screenshotLookTargetActive = true;
          const view = this.screenshotLookTarget.clone().sub(this.playerPosition).normalize();
          this.yaw = Math.atan2(-view.x, -view.z);
          this.pitch = Math.asin(view.y);
          this.grounded = false;
          this.weaponModel.visible = false;
        } else if (name === 'quicksense-cliff') {
          this.mode = 'running';
          this.audio.setPaused(true);
          this.screenshotCameraFov = 56;
          this.playerPosition.set(-110, 68, 62);
          this.playerVelocity.set(0, 0, 0);
          this.screenshotLookTarget.set(-110, 36, 164);
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
          this.playerPosition.set(0, 5.833, -30);
          this.playerVelocity.set(0, 0, 0);
          this.yaw = -3;
          this.pitch = 0.3;
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
        if (name.startsWith('monsoon-') || ['quicksense-overlook', 'quicksense-depth', 'quicksense-ramp', 'quicksense-cliff'].includes(name)) {
          this.pausedForScreenshot = true;
          this.renderer.shadowMap.autoUpdate = false;
          this.renderer.shadowMap.needsUpdate = false;
          this.hud.hideStart();
          for (const selector of ['#hud', '#crosshair', '#touch-controls']) {
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
      toggleViewMode: () => {
        this.toggleViewMode();
      },
      sampleFloorHeight: (x: number, z: number, fromY = 8) => this.arena.floorHeightAt(x, z, fromY),
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
        this.arena.resolvePlayerCapsule(bot.group.position, bot.velocity);
        const facing = this.playerPosition.clone().add(new THREE.Vector3(0, PLAYER_EYE * 0.72, 0))
          .sub(bot.group.position.clone().add(new THREE.Vector3(0, 1.5, 0)))
          .normalize();
        bot.aimDirection.copy(botFacesPlayer ? facing : facing.negate());
        bot.group.rotation.y = Math.atan2(bot.aimDirection.x, bot.aimDirection.z);
        this.publishDiagnostics();
      },
      fireWeapon: () => {
        this.weaponCooldown = 0;
        this.tryFirePlayerWeapon();
        this.publishDiagnostics();
      },
      fireSecondary: () => {
        this.weaponCooldown = 0;
        this.trySecondaryFire();
        this.publishDiagnostics();
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
        if (this.input.consumeJump()) this.jumpBuffer = MOVEMENT.jumpBuffer;
        if (this.input.consumeDash()) this.dashBuffer = 0.12;
        if (this.input.consumeGrapple()) this.toggleGrapple();
        if (this.input.consumeGrenade()) this.tryThrowGrenade();
        const steps = THREE.MathUtils.clamp(Math.ceil(seconds / MOVEMENT.fixedStep), 1, 3_600);
        for (let index = 0; index < steps; index += 1) this.fixedUpdate(MOVEMENT.fixedStep);
        this.updateCamera(0);
        this.updateSpeedEffects(0, this.elapsed, true);
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
      hideDebugUi: () => undefined,
    };
  }

  private publishDiagnostics(): void {
    const info = this.renderer.info;
    const coreDirectorState = this.coreDirector.snapshot();
    const styleSnapshot = this.styleSystem.snapshot();
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
      projectiles: this.projectiles.length,
      grenades: this.grenades.length,
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
      player: {
        position: { x: this.playerPosition.x, y: this.playerPosition.y, z: this.playerPosition.z },
        velocity: { x: this.playerVelocity.x, y: this.playerVelocity.y, z: this.playerVelocity.z },
        speed: Math.hypot(this.playerVelocity.x, this.playerVelocity.z),
        rocketJumpCount: this.rocketJumpCount,
        grounded: this.grounded,
        skiing: this.skiHeld,
        jetpacking: this.jetpackActive,
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
        bodies: 1 + this.bots.length + this.projectiles.length + this.grenades.length,
        colliders: this.arena.collisionTriangles + this.bots.length + this.projectiles.length + this.grenades.length,
        ccdBodies: 1 + this.projectiles.length + this.grenades.length,
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
        weaponWearMaterials: this.weaponVisual?.battleWearMaterialCount ?? 0,
        weaponWearTextures: this.weaponVisual?.battleWearTextureCount ?? 0,
        weaponAssetSource: this.weaponVisual?.assetSource ?? 'procedural',
        weaponModelMeshes: this.weaponVisual?.meshCount ?? 0,
        weaponRenderMeshes: this.weaponVisual?.renderMeshCount ?? 0,
        weaponModelTriangles: this.weaponVisual?.triangleCount ?? 0,
        weaponTuck: this.weaponTuck,
        weaponObstructionDistance: this.weaponObstructionDistance,
        weaponMuzzleDistance: this.weaponMuzzleDistance,
        weaponMuzzleForwardDistance: this.weaponMuzzleForwardDistance,
        weaponMuzzleOccluded: this.weaponMuzzleOccluded,
        weaponPulseIntensity: this.weaponVisual?.pulseMaterials.reduce(
          (maximum, material) => Math.max(maximum, material.emissiveIntensity),
          0,
        ) ?? 0,
      },
      combat: {
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

    // The arena is static, but bots and pickups still need fresh directional
    // shadows. Keep the authored 2048² shadow map and refresh it at a cadence
    // that avoids rebuilding the entire shadow pass on every render.
    const combatFrame = this.input.isFireHeld()
      || this.weaponVfx.activeEffects > 0
      || this.projectiles.length > 0
      || this.grenades.length > 0;
    if (!combatFrame && this.frame > 1 && this.fps >= 45 && this.frame % this.shadowRefreshInterval === 0) {
      this.renderer.shadowMap.needsUpdate = true;
    }
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
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture && value.userData.disposeWithMaterial) ownedTextures.add(value);
        }
        material.dispose();
      }
    });
    for (const texture of ownedTextures) texture.dispose();
  }
}
