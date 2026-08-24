import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createWeaponViewModel, updateWeaponViewModel, type WeaponViewModel } from '../assets/WeaponViewModel';
import { InputController } from '../core/InputController';
import { Loop } from '../core/Loop';
import { createRenderer, getRenderDpr, resizeRenderer } from '../core/Renderer';
import { Bot } from '../entities/Bot';
import { AudioSystem } from '../systems/AudioSystem';
import { Hud } from '../systems/Hud';
import { WeaponVfxSystem } from '../systems/WeaponVfxSystem';
import { createSeededRandom } from '../utils/random';
import { Arena, JUMP_PADS, type CapsuleContact } from './Arena';
import { GRAPPLE, GRENADE, MATCH_DURATION, MOVEMENT, POWERUP, SCORE_LIMIT, WEAPONS, type WeaponDefinition, type WeaponId } from './config';

type GameMode = 'ready' | 'countdown' | 'running' | 'respawning' | 'paused' | 'complete';
type Owner = 'player' | number;
type PickupKind = 'health' | 'armor' | 'damage' | 'speed' | 'rail' | 'rocket' | 'plasma' | 'shotgun' | 'sniper' | 'laser';
type CountdownCue = 'READY' | '3' | '2' | '1';

type Projectile = {
  root: THREE.Group;
  velocity: THREE.Vector3;
  owner: Owner;
  weapon: WeaponId;
  damage: number;
  splash: number;
  life: number;
  trailDistance: number;
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

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private inkPass!: ShaderPass;
  private readonly shadowRefreshInterval = 30;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(84, 1, 0.08, 220);
  private readonly input: InputController;
  private readonly arena: Arena;
  private readonly audio = new AudioSystem();
  private readonly hud = new Hud();
  private readonly weaponVfx: WeaponVfxSystem;
  private readonly mobileQuality = window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 600;
  // The arena uses several full-screen post passes. Letting a high-DPI display
  // render them at 1.75x multiplies fragment work by more than 3x, which is
  // the dominant cause of the low-FPS reports on otherwise capable GPUs.
  private readonly maxRenderDpr = this.mobileQuality ? 1 : 1.25;
  private readonly bots: Bot[] = [];
  private readonly projectiles: Projectile[] = [];
  private readonly grenades: GrenadeEntity[] = [];
  private readonly pickups: PickupState[] = [];
  private readonly playerPosition = new THREE.Vector3();
  private readonly playerVelocity = new THREE.Vector3();
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
  private readonly loop = new Loop((delta, elapsed) => this.update(delta, elapsed), () => this.render());
  private readonly ammo = new Map<WeaponId, number>();
  private readonly startButton: HTMLButtonElement;
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
  private grenadeAmmo = GRENADE.maxAmmo;
  private grappleActive = false;
  private grappleLength = 0;
  private laserHeat = 0;
  private jumpBuffer = 0;
  private coyote = 0;
  private grounded = false;
  private skiHeld = false;
  private jumpPadCooldown = 0;
  private dashBuffer = 0;
  private dashCooldown = 0;
  private dashMomentumTimer = 0;
  private wallContactTimer = 0;
  private yaw = 0;
  private pitch = -0.08;
  private trauma = 0;
  private fovPunch = 0;
  private recoil = 0;
  private fps = 60;
  private damageBoost = 0;
  private speedBoost = 0;
  private respawnTimer = 0;
  private respawnCause = '';
  private spawnIndex = 0;
  private coreCooldown: number = POWERUP.coreActivation;
  private coreProgress = 0;
  private coreOwner: Owner | null = null;
  private coreActive = false;
  private reducedMotion = false;
  private pausedForScreenshot = false;
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
  private footstepDistance = 0;
  private weaponTuck = 0;
  private weaponBobPhase = 0;
  private readonly weaponTurnSway = new THREE.Vector2();
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

  static async create(canvas: HTMLCanvasElement): Promise<Game> {
    const arena = await Arena.load();
    return new Game(canvas, arena);
  }

  private constructor(private readonly canvas: HTMLCanvasElement, arena: Arena) {
    this.arena = arena;
    this.renderer = createRenderer(canvas);
    this.renderer.info.autoReset = false;
    this.renderer.toneMappingExposure = 0.72;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.startButton = this.element<HTMLButtonElement>('#start-button');
    this.input = new InputController(
      canvas,
      this.element('#touch-stick'),
      this.element('#touch-knob'),
      this.element('#fire-button'),
      this.element('#jump-button'),
      this.element('#ski-button'),
      this.element('#grapple-button'),
      this.element('#grenade-button'),
    );
    this.weaponVfx = new WeaponVfxSystem(this.scene, this.camera, () => this.rng());
    this.createScene();
    this.composer = this.createPostProcessing();
    this.createBots();
    this.createPickups();
    this.createCore();
    this.camera.add(this.weaponModel);
    this.grappleSocket.name = 'grapple-lower-left-socket';
    this.grappleSocket.position.set(-0.44, -0.34, -0.58);
    this.camera.add(this.grappleSocket);
    this.scene.add(this.camera);
    WEAPONS.forEach((weapon) => this.ammo.set(weapon.id, weapon.ammo));
    this.buildWeaponModel();
    this.respawnPlayer(false);
    this.startButton.addEventListener('click', this.onStartClick);
    resizeRenderer(this.renderer, this.camera, this.maxRenderDpr);
    this.resizePostProcessing();
    this.installTestHooks();
    this.updateCamera(0);
    this.publishDiagnostics();
  }

  start(): void {
    this.loop.start();
  }

  dispose(): void {
    this.loop.stop();
    this.startButton.removeEventListener('click', this.onStartClick);
    this.input.dispose();
    this.audio.dispose();
    this.weaponVfx.dispose();
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

  private update(delta: number, elapsed: number): void {
    this.frame += 1;
    this.elapsed = elapsed;
    this.fps += ((1 / Math.max(delta, 0.001)) - this.fps) * Math.min(1, delta * 3);
    if (resizeRenderer(this.renderer, this.camera, this.maxRenderDpr)) this.resizePostProcessing();

    this.input.consumeLook(this.lookInput);
    this.yaw -= this.lookInput.x * 0.0018;
    this.pitch = THREE.MathUtils.clamp(this.pitch - this.lookInput.y * 0.0016, -1.28, 1.22);
    if (this.input.consumeJump()) this.jumpBuffer = MOVEMENT.jumpBuffer;
    if (this.input.consumeDash()) this.dashBuffer = 0.12;
    if (this.input.consumeGrapple()) this.toggleGrapple();
    if (this.input.consumeGrenade()) this.tryThrowGrenade();
    if (this.grappleActive && !this.input.isGrappleHeld()) this.detachGrapple();
    this.handleWeaponRequest();
    if (this.input.consumeMute()) {
      this.muted = !this.muted;
      this.audio.setMuted(this.muted);
      this.hud.message(this.muted ? 'AUDIO MUTED' : 'AUDIO ONLINE');
    }
    if (this.input.consumePause()) this.togglePause();

    if (this.mode === 'ready' && this.input.interacted()) this.beginMatch();
    if (!this.pausedForScreenshot) {
      this.accumulator += Math.min(delta, 0.05);
      while (this.accumulator >= MOVEMENT.fixedStep) {
        this.fixedUpdate(MOVEMENT.fixedStep);
        this.accumulator -= MOVEMENT.fixedStep;
      }
    }

    this.arena.update(elapsed, this.reducedMotion);
    this.updatePickupVisuals(delta, elapsed);
    this.updateEffects(this.pausedForScreenshot ? 0 : delta);
    this.updateCamera(delta);
    this.audio.updateListener(this.camera.position, this.viewDirection());
    this.updateHud();
    this.publishDiagnostics();
  }

  private fixedUpdate(delta: number): void {
    this.jumpBuffer = Math.max(0, this.jumpBuffer - delta);
    if (this.input.isJumpHeld()) this.jumpBuffer = Math.max(this.jumpBuffer, MOVEMENT.fixedStep * 1.5);
    this.dashBuffer = Math.max(0, this.dashBuffer - delta);
    this.dashCooldown = Math.max(0, this.dashCooldown - delta);
    this.dashMomentumTimer = Math.max(0, this.dashMomentumTimer - delta);
    this.wallContactTimer = Math.max(0, this.wallContactTimer - delta);
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
        return;
      }
    }

    if (this.mode !== 'running') {
      this.weaponVfx.stopContinuousLaser();
      this.updateProjectiles(delta);
      this.updateGrenades(delta);
      return;
    }

    this.matchTime -= delta;
    if (this.matchTime <= 0 || this.score >= SCORE_LIMIT || this.bots.some((bot) => bot.score >= SCORE_LIMIT)) {
      this.completeMatch();
      return;
    }

    this.updatePlayerMovement(delta);
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
        this.tryFirePlayerWeapon();
      }
    } else {
      this.weaponVfx.stopContinuousLaser();
    }
  }

  private updatePlayerMovement(delta: number): void {
    const movementStart = this.playerPosition.clone();
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

    if (this.grounded) {
      if (this.skiHeld) {
        if (this.terrainNormal.y > 0.05) {
          this.playerVelocity.y = -(
            this.terrainNormal.x * this.playerVelocity.x
            + this.terrainNormal.z * this.playerVelocity.z
          ) / this.terrainNormal.y;
        }
        const tangentGravity = new THREE.Vector3(0, -MOVEMENT.gravity, 0)
          .addScaledVector(this.terrainNormal, MOVEMENT.gravity * this.terrainNormal.y);
        this.playerVelocity.addScaledVector(tangentGravity, delta);
        this.applySkiCarve(this.wishDirection, this.terrainNormal, delta);
        const skiFriction = Math.max(0, 1 - MOVEMENT.skiFriction * delta);
        this.playerVelocity.x *= skiFriction;
        this.playerVelocity.z *= skiFriction;
      } else if (horizontalSpeed > 0 && this.dashMomentumTimer <= 0) {
        const control = Math.max(MOVEMENT.stopSpeed, horizontalSpeed);
        const nextSpeed = Math.max(0, horizontalSpeed - control * MOVEMENT.groundFriction * delta);
        const scale = nextSpeed / horizontalSpeed;
        this.playerVelocity.x *= scale;
        this.playerVelocity.z *= scale;
      }
      this.accelerate(this.wishDirection, MOVEMENT.groundAcceleration, MOVEMENT.wishSpeed * (this.speedBoost > 0 ? 1.25 : 1), delta);
    } else {
      const wishSpeed = MOVEMENT.wishSpeed * (this.speedBoost > 0 ? 1.25 : 1);
      const movingAgainstVelocity = this.playerVelocity.x * this.wishDirection.x
        + this.playerVelocity.z * this.wishDirection.z < 0;
      const pureStrafe = Math.abs(this.moveInput.x) > 0.01 && Math.abs(this.moveInput.y) < 0.01;
      this.accelerate(
        this.wishDirection,
        pureStrafe ? MOVEMENT.strafeAcceleration : movingAgainstVelocity ? MOVEMENT.airDeceleration : MOVEMENT.airAcceleration,
        pureStrafe ? MOVEMENT.strafeWishSpeed : wishSpeed,
        delta,
      );
      this.applyWarsowAirControl(this.wishDirection, delta);
      this.applyAirCarve(this.wishDirection, delta);
    }

    if (!this.grounded) this.playerVelocity.y -= MOVEMENT.gravity * delta;
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
    this.audio.footstep(this.noise(this.elapsed, 37) * 0.5);
  }

  private movePlayerSubstep(delta: number): void {
    const startPosition = this.playerPosition.clone();
    const startVelocity = this.playerVelocity.clone();
    const wasGrounded = this.grounded;
    this.playerPosition.addScaledVector(this.playerVelocity, delta);
    const impact = -this.playerVelocity.y;
    const blockedPosition = this.playerPosition.clone();
    let contact = this.arena.resolvePlayerCapsule(this.playerPosition, this.playerVelocity);
    blockedPosition.copy(this.playerPosition);

    const intendedHorizontalDistance = Math.hypot(startVelocity.x, startVelocity.z) * delta;
    const resolvedHorizontalDistance = Math.hypot(
      blockedPosition.x - startPosition.x,
      blockedPosition.z - startPosition.z,
    );
    const horizontallyBlocked = intendedHorizontalDistance > 1e-4
      && resolvedHorizontalDistance < intendedHorizontalDistance * 0.9;
    if (wasGrounded && (contact.wallContact || horizontallyBlocked)) {
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
    } else if (contact.wallContact) {
      this.wallContactTimer = 0.1;
    }
    this.lastGroundImpact = Math.max(0, this.lastGroundImpact - delta);
    if (this.playerPosition.y < -14 && this.mode === 'running') this.damagePlayer(999, 'player', 'FELL INTO THE VOID');
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

  private applyWarsowAirControl(direction: THREE.Vector3, delta: number): void {
    // qfusion's forward-air-control equation: rotate the horizontal velocity
    // toward forward/back input while preserving its magnitude and vertical arc.
    if (direction.lengthSq() < 0.0001 || Math.abs(this.moveInput.x) > 0.01 || Math.abs(this.moveInput.y) < 0.01) return;
    const verticalSpeed = this.playerVelocity.y;
    const horizontal = new THREE.Vector3(this.playerVelocity.x, 0, this.playerVelocity.z);
    const speed = horizontal.length();
    if (speed < 0.001) return;
    horizontal.multiplyScalar(1 / speed);
    const dot = horizontal.dot(direction);
    if (dot <= 0) return;
    const control = 32 * MOVEMENT.airControl * dot * dot * delta;
    horizontal.multiplyScalar(speed).addScaledVector(direction, control).normalize().multiplyScalar(speed);
    this.playerVelocity.set(horizontal.x, verticalSpeed, horizontal.z);
  }

  private applyAirCarve(direction: THREE.Vector3, delta: number): void {
    if (direction.lengthSq() < 0.0001) return;
    const horizontal = new THREE.Vector3(this.playerVelocity.x, 0, this.playerVelocity.z);
    const speed = horizontal.length();
    if (speed < 0.25) return;
    const target = direction.clone().setY(0).normalize();
    const heading = horizontal.multiplyScalar(1 / speed);
    const dot = THREE.MathUtils.clamp(heading.dot(target), -1, 1);
    const angle = Math.acos(dot);
    if (angle < 1e-4) return;
    const speedPenalty = 1 + Math.max(0, speed - MOVEMENT.wishSpeed) / MOVEMENT.wishSpeed * 0.82;
    const maxTurn = MOVEMENT.airCarveRate * delta / speedPenalty;
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
    const tangentVelocity = this.playerVelocity.clone().addScaledVector(normal, -this.playerVelocity.dot(normal));
    const speed = tangentVelocity.length();
    if (speed < 0.25) return;
    const tangentWish = direction.clone().addScaledVector(normal, -direction.dot(normal));
    if (tangentWish.lengthSq() < 1e-4) return;
    tangentWish.normalize();
    const heading = tangentVelocity.multiplyScalar(1 / speed);
    const blend = Math.min(1, MOVEMENT.skiCarveRate * delta / (1 + speed / 42));
    heading.lerp(tangentWish, blend).normalize().multiplyScalar(speed);
    this.playerVelocity.copy(heading);
  }

  private checkJumpPads(): void {
    if (this.jumpPadCooldown > 0) return;
    for (const pad of JUMP_PADS) {
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
    const playerTarget = this.playerPosition.clone().add(new THREE.Vector3(0, PLAYER_EYE * 0.72, 0));
    const routePoints = [...this.arena.spawnPoints, ...Object.values(this.arena.itemPoints)];
    for (const bot of this.bots) {
      if (bot.readyToRespawn()) {
        const spawn = this.arena.spawnPoints[(bot.id + this.spawnIndex + 1) % this.arena.spawnPoints.length];
        bot.respawn(spawn);
      }
      const botEye = bot.group.position.clone().add(new THREE.Vector3(0, 1.5, 0));
      const canSeePlayer = this.arena.hasLineOfSight(botEye, playerTarget);
      const routePhase = Math.floor((this.elapsed + bot.id * 2.35) / 6.25);
      let routeIndex = (bot.id * 7 + routePhase * 5) % routePoints.length;
      if (bot.group.position.distanceToSquared(routePoints[routeIndex]) < 5.5) {
        routeIndex = (routeIndex + 3 + bot.id) % routePoints.length;
      }
      bot.update(delta, this.elapsed, playerTarget, routePoints[routeIndex], canSeePlayer);
      if (bot.wantsToThrowGrenade) this.botThrowGrenade(bot);
      if (bot.wantsToFire) this.botFire(bot);
    }
  }

  private botFire(bot: Bot): void {
    const origin = bot.group.position.clone().add(new THREE.Vector3(0, 1.5, 0));
    const target = this.playerPosition.clone().add(new THREE.Vector3(0, PLAYER_EYE * 0.65, 0));
    // Fire-time LOS closes the reaction/update race: neither hitscan nor a
    // projectile may be emitted once the target has moved behind BSP/patch cover.
    if (!this.arena.hasLineOfSight(origin, target)) return;
    if (bot.weapon === 'rocket' || bot.weapon === 'plasma') {
      const definition = this.weapon(bot.weapon);
      this.spawnProjectile(origin, bot.aimDirection, bot.id, definition);
      this.audio.weaponWorld(bot.weapon, origin, `bot-${bot.id}`, (bot.id - 1) * 0.2);
      return;
    }
    const bulletEnd = origin.clone().addScaledVector(bot.aimDirection, 80);
    const worldHit = this.arena.segmentHit(origin, bulletEnd);
    const visibleEnd = worldHit ?? bulletEnd;
    this.weaponVfx.beam(origin, visibleEnd, 'machine', 0xff5f73, 0.065);
    const toTarget = target.sub(origin);
    const along = toTarget.dot(bot.aimDirection);
    const closest = origin.clone().addScaledVector(bot.aimDirection, along);
    const worldDistance = worldHit ? origin.distanceTo(worldHit) : 80;
    if (along > 0 && along <= worldDistance + 0.02 && closest.distanceTo(this.playerPosition.clone().add(new THREE.Vector3(0, 0.9, 0))) < 1.1) {
      this.damagePlayer(8, bot.id, 'MACHINE GUN');
    }
    this.audio.weaponWorld('machine', origin, `bot-${bot.id}`, (bot.id - 1) * 0.2);
  }

  private botThrowGrenade(bot: Bot): void {
    const origin = bot.group.position.clone().add(new THREE.Vector3(0, 1.5, 0));
    const target = this.playerPosition.clone().add(new THREE.Vector3(0, PLAYER_EYE * 0.55, 0));
    const direction = target.sub(origin).normalize();
    const root = this.weaponVfx.createGrenade(0xff607d);
    root.position.copy(origin);
    this.scene.add(root);
    const velocity = direction.multiplyScalar(GRENADE.throwSpeed * 0.92).addScaledVector(bot.velocity, 0.18);
    velocity.y += GRENADE.upwardImpulse * 0.9;
    this.grenades.push({ root, velocity, owner: bot.id, fuse: GRENADE.fuse, trailDistance: 0, bounces: 0 });
    this.audio.weaponWorld('rocket', origin, `bot-${bot.id}-grenade`, (bot.id - 1) * 0.16);
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
    this.weaponCooldown = definition.cooldown;
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
        }
      }
      for (const [bot, damage] of hits) this.applyDamageToBot(bot, damage * this.damageMultiplier(), 'player', definition.name);
    } else {
      const range = definition.range ?? 120;
      const piercing = definition.id === 'rail';
      const hitscanDirection = definition.id === 'machine'
        ? this.spreadDirection(direction, (definition.spread ?? 0) * (1 + Math.min(2, this.playerVelocity.length() / 24)))
        : direction;
      const trace = this.traceBotShot(origin, hitscanDirection, range, piercing, definition.damage * this.damageMultiplier(), definition.name, definition.id);
      const end = piercing ? trace.end : trace.first?.point ?? trace.end;
      this.weaponVfx.beam(origin, end, definition.id, definition.color, definition.id === 'rail' ? 0.2 : 0.085);
      if (!trace.first && trace.worldHit) {
        this.weaponVfx.mark(trace.worldHit, trace.worldNormal ?? new THREE.Vector3(0, 1, 0), definition.id, definition.color);
        this.weaponVfx.impact(trace.worldHit, definition.color, definition.id, trace.worldNormal ?? undefined);
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
    if ((!forced && !this.input.isFireHeld()) || ammo <= 0 || this.laserHeat >= 1) {
      this.weaponVfx.stopContinuousLaser();
      if ((ammo <= 0 || this.laserHeat >= 1) && this.weaponCooldown <= 0) {
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
    this.weaponVfx.updateContinuousLaser(origin, end, definition.color, delta);
    this.recordPlayerShot('laser', origin);
    this.laserHeat = Math.min(1.1, this.laserHeat + delta * 0.7);

    if (!wasActive) this.weaponVfx.muzzle('laser', definition.color, this.muzzleSocket);
    if (this.weaponCooldown > 0) return;

    this.weaponCooldown = definition.cooldown;
    this.ammo.set('laser', Math.max(0, ammo - 1));
    this.recoil = Math.min(0.34, this.recoil + definition.recoil);
    this.trauma = Math.min(0.22, this.trauma + definition.trauma);
    if (botVisible && botHit) {
      this.applyDamageToBot(botHit.bot, definition.damage * this.damageMultiplier(), 'player', definition.name);
    } else if (trace.worldHit) {
      this.weaponVfx.mark(trace.worldHit, trace.worldNormal ?? new THREE.Vector3(0, 1, 0), 'laser', definition.color);
      this.weaponVfx.impact(trace.worldHit, definition.color, 'laser', trace.worldNormal ?? undefined);
    }
    this.applyWeaponRecoil(definition);
    this.audio.weaponPlayer('laser', this.rng() - 0.5);
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
    return { first: hits[0] ?? null, worldHit, worldNormal: surfaceHit?.normal ?? null, end: worldHit ?? rangeEnd };
  }

  private spawnProjectile(origin: THREE.Vector3, direction: THREE.Vector3, owner: Owner, definition: WeaponDefinition): void {
    const projectileWeapon = definition.id === 'rocket' ? 'rocket' : 'plasma';
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
      life: definition.id === 'rocket' ? 4 : 2.4,
      trailDistance: 0,
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
    if (grenade.owner === 'player') {
      for (const bot of this.bots) {
        if (!bot.alive) continue;
        const target = bot.group.position.clone().add(new THREE.Vector3(0, 1.1, 0));
        const distance = target.distanceTo(position);
        if (distance >= GRENADE.splash || !this.explosionHasLineOfSight(position, target)) continue;
        const falloff = THREE.MathUtils.clamp(1 - distance / GRENADE.splash, 0, 1);
        this.applyDamageToBot(bot, GRENADE.damage * (falloff * 0.3 + falloff * falloff * 0.7), 'player', 'FRAG GRENADE');
        const impulse = target.sub(position).normalize().multiplyScalar(falloff * 7.5);
        bot.velocity.add(impulse);
        bot.velocity.y = Math.max(bot.velocity.y, impulse.y + 2.2);
      }
    }
    const playerCenter = this.playerPosition.clone().add(new THREE.Vector3(0, 0.9, 0));
    const playerDistance = playerCenter.distanceTo(position);
    if (this.mode === 'running' && playerDistance < GRENADE.splash && this.explosionHasLineOfSight(position, playerCenter)) {
      const falloff = THREE.MathUtils.clamp(1 - playerDistance / GRENADE.splash, 0, 1);
      const damageScale = grenade.owner === 'player' ? 0.34 : 0.78;
      const damage = GRENADE.damage * damageScale * (falloff * 0.3 + falloff * falloff * 0.7);
      if (damage > 1) this.damagePlayer(damage, grenade.owner, 'FRAG GRENADE SPLASH');
    }
    this.trauma = Math.min(1, this.trauma + Math.max(0, 0.48 - playerDistance * 0.06));
    this.removeGrenade(index);
  }

  private updateProjectiles(delta: number): void {
    for (let index = this.projectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.projectiles[index];
      projectile.life -= delta;
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
          this.explodeProjectile(projectile, undefined, false, true, surfaceHit.normal);
          remove = true;
          break;
        }
        if (projectile.owner === 'player') {
          for (const bot of this.bots) {
            if (bot.alive && projectile.root.position.distanceTo(bot.group.position.clone().add(new THREE.Vector3(0, 0.9, 0))) < 0.88) {
              this.applyDamageToBot(bot, projectile.damage, 'player', this.weapon(projectile.weapon).name);
              if (projectile.splash > 0) this.explodeProjectile(projectile, bot);
              else if (projectile.weapon === 'plasma') {
                this.weaponVfx.impact(projectile.root.position, this.weapon('plasma').color, 'plasma');
                this.audio.projectileImpact('plasma', projectile.root.position, this.rng() - 0.5);
              }
              remove = true;
              break;
            }
          }
        } else {
          if (this.mode === 'running' && projectile.root.position.distanceTo(this.playerPosition.clone().add(new THREE.Vector3(0, 0.9, 0))) < 0.9) {
            this.damagePlayer(projectile.damage, projectile.owner, this.weapon(projectile.weapon).name);
              if (projectile.splash > 0) this.explodeProjectile(projectile, undefined, true);
            else if (projectile.weapon === 'plasma') {
              this.weaponVfx.impact(projectile.root.position, this.weapon('plasma').color, 'plasma');
              this.audio.projectileImpact('plasma', projectile.root.position, this.rng() - 0.5);
            }
            remove = true;
          }
        }
      }
      if (!remove) {
        const trailSpacing = projectile.weapon === 'rocket' ? 0.32 : 0.24;
        if (projectile.trailDistance >= trailSpacing) {
          projectile.trailDistance %= trailSpacing;
          this.weaponVfx.projectileTrail(
            projectile.root.position,
            projectile.weapon === 'rocket' ? 'rocket' : 'plasma',
            this.weapon(projectile.weapon).color,
          );
        }
        this.weaponVfx.orientProjectile(projectile.root, projectile.velocity, this.elapsed, projectile.weapon);
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
  ): void {
    const position = projectile.root.position.clone();
    const color = this.weapon(projectile.weapon).color;
    if (projectile.weapon === 'rocket') this.weaponVfx.rocketExplosion(position, color);
    else this.weaponVfx.impact(position, color, projectile.weapon, surfaceNormal);
    if (worldImpact) this.weaponVfx.mark(position, surfaceNormal ?? new THREE.Vector3(0, 1, 0), projectile.weapon, color);
    this.spawnBurst(position, color, projectile.weapon === 'rocket' ? 24 : 7);
    if (projectile.weapon === 'rocket' || projectile.weapon === 'plasma') {
      this.audio.projectileImpact(projectile.weapon, position, this.rng() - 0.5);
    }
    if (projectile.splash <= 0) return;
    for (const bot of this.bots) {
      if (!bot.alive || bot === directlyHit) continue;
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
        if (damage > 1) this.damagePlayer(damage, projectile.owner, `${this.weapon(projectile.weapon).name.toUpperCase()} SPLASH`);
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
    const killed = bot.takeDamage(damage);
    this.hud.hitMarker(killed);
    this.audio.hit(killed ? 1.4 : 0.8);
    this.spawnBurst(bot.group.position.clone().add(new THREE.Vector3(0, 1.2, 0)), killed ? 0xffffff : 0xff4f75, killed ? 11 : 4);
    if (!killed) return;
    if (owner === 'player') {
      this.score += 1;
      if (!this.grounded) this.airborneKills += 1;
      this.hud.message(`YOU FRAGGED VECTOR-${bot.id + 1} · ${weaponName.toUpperCase()}`);
    } else {
      const shooter = this.bots[owner];
      if (shooter) shooter.score += 1;
    }
    this.fovPunch = Math.max(this.fovPunch, 4);
    this.trauma = Math.min(1, this.trauma + 0.3);
  }

  private damagePlayer(amount: number, owner: Owner, cause: string): void {
    if (this.mode !== 'running') return;
    const armored = this.armor > 0;
    const absorbed = Math.min(this.armor, amount * 0.66);
    this.armor -= absorbed;
    this.health -= amount - absorbed;
    this.lastDamageDirection = owner === 'player' ? 'SELF' : `VECTOR-${owner + 1}`;
    this.hud.damage(this.lastDamageDirection);
    this.audio.damage(armored);
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
      this.hud.message(owner === 'player' ? `SELF-DESTRUCT · ${cause}` : `VECTOR-${owner + 1} FRAGGED YOU · ${cause}`);
    }
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
      if (pickup.group.position.distanceTo(this.playerPosition.clone().add(new THREE.Vector3(0, 0.8, 0))) > 1.75) continue;
      this.collectPickup(pickup);
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
        this.selectedWeapon = 6;
        this.buildWeaponModel();
        break;
      default: {
        const definition = this.weapon(pickup.kind);
        this.ammo.set(pickup.kind, Math.min(definition.ammo, (this.ammo.get(pickup.kind) ?? 0) + Math.ceil(definition.ammo * 0.45)));
        this.selectedWeapon = WEAPONS.findIndex((weapon) => weapon.id === pickup.kind);
        this.buildWeaponModel();
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
    ) {
      this.audio.ammoPickup(pickup.kind, this.rng() - 0.5);
    } else {
      this.audio.pickup(pickup.kind);
    }
    this.hud.message(`${pickup.kind.toUpperCase()} ACQUIRED`);
    this.spawnBurst(pickup.group.position, this.weaponColorForPickup(pickup.kind), 9);
    this.trauma = Math.min(1, this.trauma + 0.12);
  }

  private updateCore(delta: number): void {
    if (!this.coreActive) {
      this.coreCooldown -= delta;
      if (this.coreCooldown <= 0) {
        this.coreActive = true;
        this.coreGroup.visible = true;
        this.hud.message('FLUX CORE ACTIVE');
      }
      return;
    }
    const playerInside = this.playerPosition.distanceTo(this.arena.corePosition) <= POWERUP.coreRadius;
    const insideBots = this.bots.filter((bot) => bot.alive && bot.group.position.distanceTo(this.arena.corePosition) <= POWERUP.coreRadius);
    let owner: Owner | null = null;
    if (playerInside && insideBots.length === 0) owner = 'player';
    if (!playerInside && insideBots.length === 1) owner = insideBots[0].id;
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
      this.hud.message('FLUX CORE CAPTURED · +3');
    } else {
      this.bots[owner].score += 3;
      this.hud.message(`VECTOR-${owner + 1} CAPTURED THE CORE`);
    }
    this.audio.pickup('core');
    this.hud.pulseObjective();
    this.spawnBurst(this.coreGroup.position, 0x43e8ff, 18);
    this.coreActive = false;
    this.coreGroup.visible = false;
    this.coreCooldown = POWERUP.coreRespawn;
    this.coreProgress = 0;
    this.coreOwner = null;
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

  private updateCamera(delta: number): void {
    const direction = this.viewDirection();
    const eye = this.playerPosition.clone().add(new THREE.Vector3(0, PLAYER_EYE, 0));
    this.camera.position.copy(eye);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;

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

    const speed = Math.hypot(this.playerVelocity.x, this.playerVelocity.z);
    const baseFov = this.input.isZoomHeld() && ['sniper', 'rail'].includes(WEAPONS[this.selectedWeapon].id) ? 42 : 84;
    this.fovPunch *= Math.exp(-delta / 0.2);
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, Math.min(104, baseFov + speed * 0.31 + this.fovPunch), 1 - Math.exp(-delta * 12));
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
    const wallProbeEnd = eye.clone().addScaledVector(direction, 2.15);
    const wallHit = this.arena.segmentHit(eye, wallProbeEnd);
    const wallDistance = wallHit?.distanceTo(eye) ?? 2.15;
    const tuckTarget = 1 - THREE.MathUtils.smoothstep(wallDistance, 0.42, 1.72);
    this.weaponTuck = THREE.MathUtils.lerp(this.weaponTuck, tuckTarget, 1 - Math.exp(-motionDelta * 18));
    this.weaponModel.position.set(
      0.2 + this.weaponTurnSway.x + walkSwayX,
      -0.59 - this.recoil * 0.08 - this.weaponTuck * 0.42 + this.weaponTurnSway.y + walkSwayY + jumpLag,
      -0.47 + this.recoil * 0.1 + this.weaponTuck * 0.24,
    );
    const aimPointWorld = this.arena.segmentHit(eye, eye.clone().addScaledVector(direction, 190))
      ?? eye.clone().addScaledVector(direction, 190);
    this.camera.updateMatrixWorld(true);
    const aimPointLocal = this.camera.worldToLocal(aimPointWorld.clone());
    const boreDirection = aimPointLocal.sub(this.weaponModel.position).normalize();
    const boreYaw = Math.atan2(-boreDirection.x, -boreDirection.z);
    const borePitch = Math.asin(THREE.MathUtils.clamp(boreDirection.y, -1, 1));
    this.weaponModel.rotation.x = borePitch + this.recoil * 0.15 - this.weaponTuck * 0.52 - jumpLag * 0.45;
    this.weaponModel.rotation.y = boreYaw - this.weaponTurnSway.x * 0.72 - walkSwayX * 0.36;
    this.weaponModel.rotation.z = strafeRoll - this.weaponTurnSway.x * 0.18;
    if (!this.reducedMotion) {
      const bob = Math.sin(this.elapsed * Math.min(18, 5 + speed)) * Math.min(0.025, speed * 0.0008);
      this.weaponModel.position.y += bob;
    }
    if (this.weaponVisual) updateWeaponViewModel(this.weaponVisual, this.elapsed, this.recoil, this.laserHeat, this.reducedMotion);
    this.forward.copy(direction);
    const grappleOrigin = this.grappleActive
      ? this.grappleSocket.getWorldPosition(new THREE.Vector3())
      : this.camera.position;
    this.weaponVfx.updateGrapple(grappleOrigin, this.grappleAnchor, this.grappleActive);
  }

  private updateHud(): void {
    const definition = WEAPONS[this.selectedWeapon];
    const botLead = Math.max(...this.bots.map((bot) => bot.score));
    const coreStatus = this.coreActive
      ? this.coreOwner === null
        ? 'CORE UNCONTESTED'
        : this.coreOwner === 'player'
          ? 'CAPTURING CORE'
          : 'ENEMY CAPTURING'
      : `CORE IN ${Math.max(0, Math.ceil(this.coreCooldown))}s`;
    const matchStatus = this.mode === 'complete'
      ? this.score >= botLead ? 'MATCH WON' : 'MATCH LOST'
      : this.mode === 'ready'
        ? 'CLICK TO ENTER'
        : this.mode === 'countdown' ? 'WEAPONS LOCKED' : `FIRST TO ${SCORE_LIMIT}`;
    const resolvedMatchStatus = this.mode === 'paused' ? 'MATCH PAUSED' : matchStatus;
    const powerups: string[] = [];
    if (this.damageBoost > 0) powerups.push(`DAMAGE ${Math.ceil(this.damageBoost)}s`);
    if (this.speedBoost > 0) powerups.push(`SPEED ${Math.ceil(this.speedBoost)}s`);
    if (definition.id === 'laser' && this.laserHeat > 0.65) powerups.push(`HEAT ${Math.round(this.laserHeat * 100)}%`);
    powerups.push(this.grappleActive ? 'GRAPPLE ANCHORED' : 'GRAPPLE READY');
    powerups.push(this.grenadeCooldown > 0 ? `FRAG ${this.grenadeAmmo} · ${this.grenadeCooldown.toFixed(1)}s` : `FRAG GRENADES ${this.grenadeAmmo}`);
    const rail = this.pickups.find((pickup) => pickup.kind === 'rail');
    this.hud.update({
      health: this.health,
      armor: this.armor,
      speed: Math.hypot(this.playerVelocity.x, this.playerVelocity.z),
      score: this.score,
      botLead,
      timeRemaining: this.matchTime,
      weapon: definition.name,
      ammo: this.ammo.get(definition.id) ?? 0,
      coreProgress: this.coreProgress,
      coreStatus,
      matchStatus: resolvedMatchStatus,
      fps: this.fps,
      powerups,
      railTimer: rail?.active ? 0 : rail?.cooldown ?? 0,
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
      this.hud.message('WEAPONS FREE');
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
    this.hud.message(this.score >= botLead ? 'RIFT DOMINATED' : 'MATCH LOST · RE-ENTER');
    this.input.setPointerLockAllowed(false);
    this.audio.reset();
    this.audio.setPaused(true);
    this.hud.showStart('complete');
    this.startButton.textContent = 'RESTART MATCH';
  }

  private resetMatch(): void {
    this.cancelMatchCountdown();
    this.score = 0;
    this.deaths = 0;
    this.airborneKills = 0;
    this.rocketJumpCount = 0;
    this.grenadeAmmo = GRENADE.maxAmmo;
    this.grenadeCooldown = 0;
    this.detachGrapple();
    this.clearGrenades();
    this.matchTime = MATCH_DURATION;
    this.coreCooldown = POWERUP.coreActivation;
    this.coreProgress = 0;
    this.coreActive = false;
    this.coreGroup.visible = false;
    for (const bot of this.bots) bot.score = 0;
    WEAPONS.forEach((weapon) => this.ammo.set(weapon.id, weapon.ammo));
    this.audio.reset();
    this.mode = 'ready';
    this.respawnPlayer(false);
    this.startButton.textContent = 'ENTER THE RIFT';
  }

  private respawnPlayer(showMessage: boolean): void {
    this.detachGrapple();
    this.clearGrenades();
    const spawn = this.arena.spawnPoints[this.spawnIndex % this.arena.spawnPoints.length];
    this.spawnIndex += 1;
    this.playerPosition.copy(spawn);
    this.playerVelocity.set(0, 0, 0);
    this.dashBuffer = 0;
    this.dashCooldown = 0;
    this.dashMomentumTimer = 0;
    this.wallContactTimer = 0;
    this.terrainNormal.set(0, 1, 0);
    this.health = 100;
    this.armor = 50;
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
    this.scene.background = new THREE.Color(0x070b15);
    this.scene.fog = new THREE.FogExp2(0x070b15, 0.0085);
    const environmentGenerator = new THREE.PMREMGenerator(this.renderer);
    this.environmentTexture = environmentGenerator.fromScene(new RoomEnvironment(), 0.03).texture;
    this.scene.environment = this.environmentTexture;
    environmentGenerator.dispose();
    this.scene.add(this.createSky());
    this.scene.add(new THREE.AmbientLight(0x52708d, 0.2));
    const hemisphere = new THREE.HemisphereLight(0xbdefff, 0x120d24, 0.62);
    this.scene.add(hemisphere);
    const sun = new THREE.DirectionalLight(0xe7f8ff, 1.55);
    sun.position.set(-30, 48, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 130;
    sun.shadow.camera.left = -62;
    sun.shadow.camera.right = 62;
    sun.shadow.camera.top = 62;
    sun.shadow.camera.bottom = -62;
    this.scene.add(sun);
    const coreLight = new THREE.PointLight(0x3ee8ff, 8, 34, 2);
    coreLight.position.copy(this.arena.corePosition).add(new THREE.Vector3(0, 6, 0));
    this.scene.add(coreLight);
    const magentaLight = new THREE.PointLight(0xff328c, 6, 26, 2);
    magentaLight.position.copy(this.arena.itemPoints.rail).add(new THREE.Vector3(0, 5, 0));
    this.scene.add(magentaLight);
    const rim = new THREE.DirectionalLight(0xff4f9d, 0.42);
    rim.position.set(36, 20, -42);
    this.scene.add(rim);
    this.scene.add(this.arena.group);
  }

  private createPostProcessing(): EffectComposer {
    const composer = new EffectComposer(this.renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.24, 0.38, 1.18));
    this.inkPass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        resolution: { value: new THREE.Vector2(1, 1) },
        edgeStrength: { value: 0.34 },
        vignette: { value: 0.23 },
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
          color *= 1.0 - edge * edgeStrength;
          color = mix(vec3(luma(color)), color, 1.13);
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
    const dpr = getRenderDpr(this.maxRenderDpr);
    // Post-processing is fill-rate bound and does not benefit materially from
    // the extra 1.25x canvas samples. Keep the final canvas crisp while using
    // a 1x intermediate buffer for bloom, ink, and tone/output passes.
    const postDpr = Math.min(dpr, 1);
    this.composer.setPixelRatio(postDpr);
    this.composer.setSize(width, height);
    this.inkPass.uniforms.resolution.value.set(width * postDpr, height * postDpr);
  }

  private createSky(): THREE.Mesh {
    const uniforms = {
      uTop: { value: new THREE.Color(0x10173e) },
      uHorizon: { value: new THREE.Color(0x2a5875) },
      uLower: { value: new THREE.Color(0x080813) },
      uSunColor: { value: new THREE.Color(0xff8fbd) },
      uSunDir: { value: new THREE.Vector3(-0.45, 0.2, 0.72).normalize() },
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(190, 32, 18),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms,
        vertexShader: `varying vec3 vDir;
          void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `varying vec3 vDir;
          uniform vec3 uTop, uHorizon, uLower, uSunColor, uSunDir;
          void main(){
            float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
            vec3 upper = mix(uHorizon, uTop, pow(h, 0.72));
            vec3 col = mix(uLower, upper, smoothstep(0.08, 0.48, h));
            float d = clamp(dot(normalize(vDir), normalize(uSunDir)), 0.0, 1.0);
            col += uSunColor * (pow(d, 720.0) + pow(d, 7.0) * 0.22);
            float bands = smoothstep(0.48, 0.5, fract(atan(vDir.z, vDir.x) * 5.1));
            col += vec3(0.05, 0.16, 0.22) * bands * smoothstep(0.2, 0.55, h) * (1.0 - smoothstep(0.55, 0.82, h));
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
      const bot = new Bot(id, BOT_COLORS[id], this.arena.spawnPoints[id + 1], this.arena);
      this.bots.push(bot);
      this.scene.add(bot.group);
    }
  }

  private createPickups(): void {
    const definitions: Array<[PickupKind, string, number]> = [
      ['health', 'health-a', 20],
      ['health', 'health-b', 20],
      ['armor', 'armor', 30],
      ['damage', 'damage', POWERUP.respawn],
      ['speed', 'speed', POWERUP.respawn],
      ['rail', 'rail', POWERUP.railRespawn],
      ['rocket', 'rocket', 25],
      ['plasma', 'plasma', 25],
      ['shotgun', 'shotgun', 25],
      ['sniper', 'sniper', 30],
      ['laser', 'laser', 25],
    ];
    definitions.forEach(([kind, point, respawn], index) => {
      const group = this.createPickupModel(kind);
      const authored = this.arena.itemPoints[point];
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
      mesh.castShadow = true;
      mesh.receiveShadow = true;
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
      || kind === 'shotgun' || kind === 'sniper' || kind === 'laser';
    if (isWeapon) {
      const visual = createWeaponViewModel(this.weapon(kind));
      visual.root.scale.multiplyScalar(kind === 'rail' || kind === 'sniper' ? 0.54 : 0.6);
      visual.root.rotation.set(-0.08, Math.PI * 0.5, kind === 'rocket' ? -0.08 : 0);
      visual.root.position.set(0, 0.49, 0);
      group.add(this.bakePickupWeapon(visual.root, kind));
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
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }

  private bakePickupWeapon(source: THREE.Group, kind: WeaponId): THREE.Group {
    source.updateMatrixWorld(true);
    const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
    source.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material)) return;
      let geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      geometry.applyMatrix4(mesh.matrixWorld);
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
      if (!geometry.getAttribute('uv')) {
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(geometry.getAttribute('position').count * 2, 2));
      }
      for (const attribute of Object.keys(geometry.attributes)) {
        if (attribute !== 'position' && attribute !== 'normal' && attribute !== 'uv') geometry.deleteAttribute(attribute);
      }
      const entries = batches.get(mesh.material) ?? [];
      entries.push(geometry);
      batches.set(mesh.material, entries);
    });

    const baked = new THREE.Group();
    baked.name = `${kind}-pickup-weapon-model`;
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
      mesh.name = `${kind}-pickup-material-batches`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      baked.add(mesh);
    }
    source.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    return baked;
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
    this.disposeObject(this.weaponModel);
    this.weaponModel.clear();
    const definition = WEAPONS[this.selectedWeapon];
    this.weaponVisual = createWeaponViewModel(definition);
    this.muzzleSocket = this.weaponVisual.muzzleSocket;
    this.weaponModel.add(this.weaponVisual.root);
    this.weaponModel.scale.setScalar(1);
    this.weaponModel.position.set(0.16, -0.59, -0.47);
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
      this.selectedWeapon = (this.selectedWeapon + step + WEAPONS.length) % WEAPONS.length;
    } else {
      this.selectedWeapon = THREE.MathUtils.clamp(request, 0, WEAPONS.length - 1);
    }
    this.buildWeaponModel();
    if (this.selectedWeapon !== previousWeapon) this.audio.weaponSwitch(WEAPONS[this.selectedWeapon].id);
  }

  private viewDirection(): THREE.Vector3 {
    const cosPitch = Math.cos(this.pitch);
    return new THREE.Vector3(-Math.sin(this.yaw) * cosPitch, Math.sin(this.pitch), -Math.cos(this.yaw) * cosPitch).normalize();
  }

  private damageMultiplier(): number {
    return this.damageBoost > 0 ? 1.5 : 1;
  }

  private weapon(id: WeaponId): WeaponDefinition {
    const definition = WEAPONS.find((candidate) => candidate.id === id);
    if (!definition) throw new Error(`Missing weapon definition: ${id}`);
    return definition;
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
        this.input.consumeJump();
        this.input.consumeDash();
        for (const bot of this.bots) bot.movementLocked = false;
        if (name.startsWith('view-')) {
          const spawnIndex = THREE.MathUtils.clamp(Number.parseInt(name.slice(5), 10) || 0, 0, this.arena.spawnPoints.length - 1);
          const sourceAngles = [90, -180, 0, 0, 90, 0, -180, 0, -45, -90, -90, 90, -90, 90, -90];
          this.mode = 'running';
          this.audio.setPaused(false);
          this.hud.hideStart();
          this.playerPosition.copy(this.arena.spawnPoints[spawnIndex]);
          this.playerVelocity.set(0, 0, 0);
          this.jumpBuffer = 0;
          this.coyote = 0;
          this.dashBuffer = 0;
          this.dashMomentumTimer = 0;
          this.yaw = THREE.MathUtils.degToRad(sourceAngles[spawnIndex] - 90);
          this.pitch = -0.04;
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
          this.playerPosition.copy(this.arena.spawnPoints[13]);
          const floor = this.arena.floorHeightAt(this.playerPosition.x, this.playerPosition.z, this.playerPosition.y + 3);
          if (floor !== null) this.playerPosition.y = floor;
          this.playerVelocity.set(0, 0, 0);
          this.jumpBuffer = 0;
          this.coyote = 0;
          this.dashBuffer = 0;
          this.dashMomentumTimer = 0;
          // Long southbound lane: leaves enough runway for multi-cycle bhop and
          // air-carve telemetry without colliding with the room's north wall.
          this.yaw = 0;
          this.pitch = -0.04;
          const contact = this.arena.resolvePlayerCapsule(this.playerPosition, this.playerVelocity);
          this.grounded = contact.grounded;
          this.terrainNormal.copy(contact.contactNormal);
        } else if (name === 'movement-slope') {
          this.mode = 'running';
          this.audio.setPaused(false);
          this.hud.hideStart();
          this.playerPosition.set(4, 3.5715, -17.2);
          this.playerVelocity.set(14, 0, 0);
          this.jumpBuffer = 0;
          this.coyote = 0;
          this.dashBuffer = 0;
          this.dashMomentumTimer = 0;
          this.yaw = -Math.PI / 2;
          this.pitch = -0.08;
          const contact = this.arena.resolvePlayerCapsule(this.playerPosition, this.playerVelocity);
          this.grounded = contact.grounded;
          this.terrainNormal.copy(contact.contactNormal);
        } else if (name === 'active-play') {
          this.mode = 'running';
          this.audio.setPaused(false);
          this.hud.hideStart();
          // Use the validated flat-lane spawn for live-input and visual smoke
          // tests. Spawn 7 sits above a brush seam that has no capsule contact,
          // which made deterministic active play begin airborne and produced
          // false input/softlock failures.
          this.playerPosition.copy(this.arena.spawnPoints[13]);
          const floor = this.arena.floorHeightAt(this.playerPosition.x, this.playerPosition.z, this.playerPosition.y + 3);
          if (floor !== null) this.playerPosition.y = floor;
          this.playerVelocity.set(0, 0, 0);
          // Face down the open lane so the active-play evidence includes the
          // arena depth, bots, and authored set dressing instead of a wall.
          this.yaw = 0;
          this.pitch = -0.04;
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
          this.selectedWeapon = 0;
          this.weaponCooldown = 0;
          this.ammo.set('machine', this.weapon('machine').ammo);
          this.buildWeaponModel();
          const playerContact = this.arena.resolvePlayerCapsule(this.playerPosition, this.playerVelocity);
          this.grounded = playerContact.grounded;
          const botPosition = this.playerPosition.clone().add(new THREE.Vector3(0, 0, -4));
          this.bots[0].respawn(botPosition);
          this.bots[0].health = 35;
          this.bots[0].armor = 0;
          this.bots[1].respawn(this.arena.spawnPoints[1]);
          this.bots[2].respawn(this.arena.spawnPoints[2]);
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
        this.updateCamera(0);
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
        this.arena.resolvePlayerCapsule(this.playerPosition, this.playerVelocity);
        const bot = this.bots[0];
        bot.respawn(new THREE.Vector3(botPosition.x, botPosition.y, botPosition.z));
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
        this.publishDiagnostics();
      },
      hideDebugUi: () => undefined,
    };
  }

  private publishDiagnostics(): void {
    const info = this.renderer.info;
    window.__THREE_GAME_DIAGNOSTICS__ = {
      frame: this.frame,
      elapsed: this.elapsed,
      score: this.score,
      targetScore: SCORE_LIMIT,
      complete: this.mode === 'complete',
      state: this.mode,
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
        alive: bot.alive,
        health: bot.health,
        weapon: bot.weapon,
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
        grenadesThrown: bot.grenadesThrown,
        grapplesUsed: bot.grapplesUsed,
        grenadesRemaining: bot.grenadesRemaining,
        grappleActive: bot.grappleActive,
        collisionRecoveries: bot.collisionRecoveries,
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
        distance: this.playerPosition.clone().add(new THREE.Vector3(0, PLAYER_EYE, 0)).distanceTo(this.grappleAnchor),
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
      player: {
        position: { x: this.playerPosition.x, y: this.playerPosition.y, z: this.playerPosition.z },
        velocity: { x: this.playerVelocity.x, y: this.playerVelocity.y, z: this.playerVelocity.z },
        speed: Math.hypot(this.playerVelocity.x, this.playerVelocity.z),
        rocketJumpCount: this.rocketJumpCount,
        grounded: this.grounded,
        skiing: this.skiHeld,
        dashCooldown: this.dashCooldown,
        wallContact: this.wallContactTimer > 0,
        yaw: this.yaw,
        pitch: this.pitch,
      },
      physics: {
        engine: 'fixed-step-capsule-bsp-brush-patch-bvh',
        timestep: MOVEMENT.fixedStep,
        bodies: 1 + this.bots.length + this.projectiles.length + this.grenades.length,
        colliders: this.arena.collisionTriangles + this.bots.length + this.projectiles.length + this.grenades.length,
        ccdBodies: this.projectiles.length + this.grenades.length,
        sensors: this.pickups.filter((pickup) => pickup.active).length + (this.coreActive ? 1 : 0),
        contacts: this.lastPhysicsContacts,
        groundNormal: { x: this.terrainNormal.x, y: this.terrainNormal.y, z: this.terrainNormal.z },
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
      },
      combat: {
        continuousLaserActive: this.weaponVfx.continuousLaserActive,
        continuousLaserBend: this.weaponVfx.continuousLaserBend,
        lastPelletCount: this.lastPelletCount,
        lastPelletSpread: this.lastPelletSpread,
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
        projectileMuzzleOffset: this.lastShotWeapon === 'rocket' || this.lastShotWeapon === 'plasma'
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
      audio: this.audio.diagnostics(),
    };
  }

  private render(): void {
    if (this.physicsQaMode && this.physicsQaFrameRendered) return;
    this.renderer.info.reset();
    if (this.physicsQaMode) {
      this.renderer.render(this.scene, this.camera);
      this.physicsQaFrameRendered = true;
      return;
    }

    // The arena is static, but bots and pickups still need fresh directional
    // shadows. Keep the authored 2048² shadow map and refresh it at a cadence
    // that avoids rebuilding the entire shadow pass on every render.
    if (this.frame > 1 && this.frame % this.shadowRefreshInterval === 0) {
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
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      if (Array.isArray(mesh.material)) mesh.material.forEach((material) => material.dispose());
      else mesh.material?.dispose();
    });
  }
}
