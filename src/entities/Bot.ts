import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadCharacterAsset } from '../assets/CharacterAsset';
import { SupportArmIk } from '../assets/SupportArmIk';
import { JetpackRig } from '../assets/JetpackRig';
import type { ArenaRuntime } from '../game/Arena';
import { GRAPPLE, GRENADE, MOVEMENT, POWERUP, WEAPONS, type WeaponId } from '../game/config';
import { JetpackEnergy } from '../game/JetpackEnergy';
import {
  BotNavigationGrid,
  NAV_LINK_JUMP,
  NAV_LINK_PAD,
  NAV_LINK_WALK,
  NavPath,
  navLinkName,
  type NavLinkKind,
  type NavLinkName,
} from '../systems/BotNavigation';
import {
  BotThreatMemory,
  SeededStream,
  solveBallisticLaunch,
  type BotDamageSource,
  type BotThreatPoint,
} from '../systems/BotThreat';
import {
  botArchetypeForId,
  botObjectiveUtility,
  botPickupUtility,
  botSkillProfile,
  botWeaponUtility,
  type BotArchetypeId,
  type BotArchetypeTuning,
  type BotObjectiveKind,
  type BotPickupKind,
  type BotSkillProfile,
  type BotVisualIdentity,
} from './BotArchetypes';
import { BOT_WEAPON_RANGE, botWeaponBandForDistance } from './BotWeapons';
import {
  aimWfacMetres,
  applyAimWfacOffset,
  botMayPullTrigger,
  directionFromYawPitch,
  stepAimChangeAngle,
  yawPitchFromDirection,
  type AimAngleRates,
} from './BotAim';

// The authored SWAT mesh measures roughly 1.84 x 0.88 world units. It needs a
// dedicated capsule; the smaller qfusion player hull lets shoulders and the
// head visibly enter walls and ceilings even when physics resolves correctly.
const BOT_COLLIDER_HEIGHT = 1.82;
const BOT_COLLIDER_RADIUS = 0.43;
const BOT_EYE_HEIGHT = 1.5;
// Aim/LOS origin. Game fires from the weapon muzzle socket (~1.37-1.5 m), so
// computing the aim vector from the feet would put every level shot high.
const BOT_AIM_HEIGHT = 1.42;
const STEP_PROBE_OFFSETS = [
  0,
  BOT_COLLIDER_RADIUS * 0.34,
  BOT_COLLIDER_RADIUS * 0.68,
  BOT_COLLIDER_RADIUS + 0.035,
] as const;
const TRAVERSAL_PROBE_DISTANCE = 3.1;
const TRAVERSAL_HEADINGS = [
  { sine: 0, cosine: 1 },
  { sine: Math.sin(0.38), cosine: Math.cos(0.38) },
  { sine: Math.sin(-0.38), cosine: Math.cos(-0.38) },
  { sine: Math.sin(0.78), cosine: Math.cos(0.78) },
  { sine: Math.sin(-0.78), cosine: Math.cos(-0.78) },
  { sine: Math.sin(1.18), cosine: Math.cos(1.18) },
  { sine: Math.sin(-1.18), cosine: Math.cos(-1.18) },
] as const;
const TRAVERSAL_FALLBACK = {
  positive: { sine: Math.sin(1.45), cosine: Math.cos(1.45) },
  negative: { sine: Math.sin(-1.45), cosine: Math.cos(-1.45) },
} as const;
const INFINITE_AMMO_WEAPONS: ReadonlySet<WeaponId> = new Set<WeaponId>(['machine', 'shotgun']);

const WEAPON_PROJECTILE_SPEED: Readonly<Record<WeaponId, number>> = {
  machine: 0,
  shotgun: 0,
  rocket: 40,
  plasma: 48,
  laser: 0,
  sniper: 0,
  rail: 0,
  disc: 76,
};
const WEAPON_AMMO_MAX: Readonly<Record<WeaponId, number>> = Object.fromEntries(
  WEAPONS.map((definition) => [definition.id, definition.id === 'rail' ? 3 : definition.ammo]),
) as Record<WeaponId, number>;

const EMPTY_THREATS: readonly BotThreatPoint[] = [];
const PATH_REPLAN_INTERVAL = 1.5;
const PATH_GOAL_DRIFT = 4;
const COMBAT_RANGE = 48;
const STUCK_RELOCATE_SECONDS = 6;
const NAVIGATION_STALL_RELOCATE_SECONDS = 9;
const PAD_LAUNCH_COOLDOWN = 0.7;

export type BotPathState = 'none' | 'following' | 'direct' | 'blocked';

/** Per-tick world context supplied by Game. */
export type BotUpdateContext = {
  navigation: BotNavigationGrid | null;
  /** Predicted impact points of hostile projectiles; entries with `active=false` are ignored. */
  threats: readonly BotThreatPoint[];
  /** False when the target vector is a placeholder (no live opponent). */
  hasTarget: boolean;
  targetGrounded: boolean;
  /** Height of the supplied target point above the target's feet. */
  targetCenterOffset: number;
  /** Game has routed the bot to a recovery pickup: follow the path even while fighting. */
  retreat: boolean;
};

const DEFAULT_CONTEXT: BotUpdateContext = {
  navigation: null,
  threats: EMPTY_THREATS,
  hasTarget: true,
  targetGrounded: true,
  targetCenterOffset: 1.05,
  retreat: false,
};

export class Bot {
  readonly group = new THREE.Group();
  readonly velocity = new THREE.Vector3();
  readonly aimDirection = new THREE.Vector3(0, 0, -1);
  readonly weaponGripSocket = new THREE.Object3D();
  readonly supportGripSocket = new THREE.Object3D();
  readonly archetype: BotArchetypeId;
  readonly displayName: string;
  readonly visualIdentity: BotVisualIdentity;
  readonly archetypeTuning: BotArchetypeTuning;
  readonly skillProfile: BotSkillProfile;
  readonly threat = new BotThreatMemory();
  readonly ready: Promise<void>;
  /** Launch velocity solved for the current grenade request. */
  readonly grenadeLaunchVelocity = new THREE.Vector3();
  health = 100;
  armor = 50;
  alive = true;
  respawnTimer = 0;
  wantsToFire = false;
  targetVisible = false;
  facingDot = -1;
  grounded = true;
  navigationTarget = new THREE.Vector3();
  stepSuccesses = 0;
  shotsFired = 0;
  shotsHit = 0;
  movementLocked = false;
  /** Test hook: pin the equipped weapon so accuracy can be measured per weapon. */
  weaponLocked = false;
  modelReady = false;
  modelHeight = 0;
  modelCenterY = 0;
  modelWidth = 0;
  modelDepth = 0;
  modelCenterX = 0;
  modelCenterZ = 0;
  modelMeshCount = 0;
  renderedMeshCount = 0;
  runtimeBoneCount = 0;
  runtimeAnimationCount = 0;
  sourceTriangleCount = 0;
  sourceTextureCount = 0;
  roleHardwareMeshCount = 0;
  roleHardwareProfile: BotVisualIdentity['roleLabel'] = 'HUNTER';
  score = 0;
  weapon: WeaponId;
  wantsToThrowGrenade = false;
  grappleActive = false;
  readonly grappleAnchor = new THREE.Vector3();
  grappleLength = 0;
  weaponSwitches = 0;
  bunnyHops = 0;
  grenadesThrown = 0;
  grapplesUsed = 0;
  collisionRecoveries = 0;
  relocations = 0;
  padLaunches = 0;
  combatMoves = 0;
  dodges = 0;
  pathReplans = 0;
  pathState: BotPathState = 'none';
  retreating = false;
  wallContacts = 0;
  ceilingContacts = 0;
  targetOwner: 'player' | number | null = null;
  stalledFor = 0;
  damageBoost = 0;
  speedBoost = 0;
  jetpackActive = false;
  jetpackBursts = 0;
  jetpackCharge = 1;
  jetpackLocked = false;
  dashCooldown = 0;
  dashesUsed = 0;
  jumpPadCooldown = 0;
  aimErrorDegrees = 0;
  aimTracking = 0;
  reactionRemaining = 0;
  knockbackLockout = 0;
  private hitFlashRemaining = 0;

  private tacticalTimer = 0;
  private fireCooldown = 0;
  private readonly reactionTimer: number;
  private targetVisibleFor = 0;
  private readonly wishDirection = new THREE.Vector3(0, 0, -1);
  private blockedTimer = 0;
  private jumpRequested = false;
  private dashRequested = false;
  private climbRequested = false;
  private grenadeAmmo = 3;
  private grenadeCooldown = 0;
  private grappleCooldown = 0;
  private stuckTimer = 0;
  private jetpackTimer = 0;
  private recoveryRequested = false;
  private readonly availableWeapons = new Set<WeaponId>(['machine', 'shotgun']);
  private readonly ammo = new Map<WeaponId, number>();
  private readonly progressAnchor = new THREE.Vector3();
  private navigationStallTimer = 0;
  private weaponLockout = 0;
  private combatMoveTimer = 0;
  private combatStrafe = 0;
  private combatAdvance = 0;
  private combatStrafing = false;
  private dodgeCooldown = 0;
  private lastSeenTargetAt = Number.NEGATIVE_INFINITY;
  private readonly lastSeenTargetPosition = new THREE.Vector3();
  private readonly path = new NavPath();
  private pathBlocked = false;
  private currentLinkKind: NavLinkKind = NAV_LINK_WALK;
  private readonly steerPoint = new THREE.Vector3();
  private lives = 0;
  private seedBase: number;
  private readonly random: SeededStream;
  // Fixed-step bot simulation runs at 60 Hz. Keep mutable scratch state on
  // each bot so movement, collision, and navigation do not fill the young
  // generation with short-lived Vector3 instances when actor count rises.
  private readonly floorNormal = new THREE.Vector3(0, 1, 0);
  private readonly scratchToTarget = new THREE.Vector3();
  private readonly scratchBotEye = new THREE.Vector3();
  private readonly scratchDirectionA = new THREE.Vector3();
  private readonly scratchDirectionB = new THREE.Vector3();
  private readonly scratchSegmentEnd = new THREE.Vector3();
  private readonly scratchDesired = new THREE.Vector3();
  private readonly scratchAimDesired = new THREE.Vector3();
  private readonly scratchAimPoint = new THREE.Vector3();
  private readonly scratchFrameStart = new THREE.Vector3();
  private readonly scratchEscapeNormal = new THREE.Vector3();
  private readonly scratchStartPosition = new THREE.Vector3();
  private readonly scratchStartVelocity = new THREE.Vector3();
  private readonly scratchBlockedPosition = new THREE.Vector3();
  private readonly scratchStepPosition = new THREE.Vector3();
  private readonly scratchStepVelocity = new THREE.Vector3();
  private readonly scratchStepDirection = new THREE.Vector3();
  private readonly scratchTraversalDirection = new THREE.Vector3();
  private readonly scratchTraversalProbe = new THREE.Vector3();
  private readonly scratchPathNode = new THREE.Vector3();
  private readonly scratchLookahead = new THREE.Vector3();
  private readonly scratchForward = new THREE.Vector3();
  private readonly scratchRight = new THREE.Vector3();
  private readonly scratchProbe = new THREE.Vector3();
  private readonly awarenessDot: number;
  private readonly grenadeCooldownDuration: number;
  private readonly strafeScale: number;
  private readonly wishSpeedBase: number;
  private readonly jetpackBurstDuration: number;
  private readonly grappleCooldownDuration: number;
  private readonly yawSpeedRadians: number;
  private readonly yawAccelRadians: number;
  private readonly aimRates: AimAngleRates = { speedYaw: 0, speedPitch: 0 };
  private readonly scratchAimAngles = { yaw: 0, pitch: 0 };
  private readonly scratchIdealAngles = { yaw: 0, pitch: 0 };
  private readonly jetpackEnergy = new JetpackEnergy({
    burnSeconds: MOVEMENT.jetpackBurnSeconds,
    rechargeDelaySeconds: MOVEMENT.jetpackRechargeDelaySeconds,
    rechargeSeconds: MOVEMENT.jetpackRechargeSeconds,
    restartCharge: MOVEMENT.jetpackRestartCharge,
  });
  private mixer?: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private activeAnimation = '';
  private disposed = false;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly renderedMeshes = new Set<string>();
  private readonly bindPoseDebug = new URLSearchParams(window.location.search).has('bindPose');
  private readonly primaryArmIk = new SupportArmIk();
  private readonly supportArmIk = new SupportArmIk();
  private readonly jetpackRig: JetpackRig;

  constructor(readonly id: number, color: number, spawn: THREE.Vector3, private readonly arena: ArenaRuntime) {
    this.group.name = `rift-bot-${id}`;
    this.archetypeTuning = botArchetypeForId(id);
    this.archetype = this.archetypeTuning.id;
    this.displayName = this.archetypeTuning.callsign;
    this.visualIdentity = this.archetypeTuning.visual;
    this.skillProfile = botSkillProfile(this.archetypeTuning);
    this.seedBase = Bot.hashSeed(arena.seed, id);
    this.random = new SeededStream(this.seedBase);
    const movementTuning = this.archetypeTuning.movement;
    this.awarenessDot = THREE.MathUtils.lerp(0.02, -0.26, this.archetypeTuning.aggression);
    this.grenadeCooldownDuration = THREE.MathUtils.lerp(5.4, 4.35, this.archetypeTuning.aggression);
    this.strafeScale = THREE.MathUtils.lerp(0.72, 1.24, movementTuning.strafeTendency);
    // Archetypes differ in route choice and commitment, not in superhuman
    // top speed. A speed pickup is the only way a bot exceeds player wish speed.
    this.wishSpeedBase = MOVEMENT.wishSpeed;
    this.jetpackBurstDuration = THREE.MathUtils.lerp(0.46, 0.72, movementTuning.jetpackTendency);
    this.grappleCooldownDuration = THREE.MathUtils.lerp(1.55, 0.95, movementTuning.grappleTendency);
    // Warfork yaw_speed 600–950 °/s minus 20*(1-S); yaw_accel 85–115.
    this.yawSpeedRadians = THREE.MathUtils.degToRad(
      THREE.MathUtils.lerp(620, 920, this.skillProfile.skill)
      - 20 * (1 - this.skillProfile.skill),
    );
    this.yawAccelRadians = THREE.MathUtils.degToRad(
      THREE.MathUtils.lerp(85, 115, this.skillProfile.skill),
    );
    this.weapon = (['machine', 'rocket', 'plasma'] as WeaponId[])[id % 3];
    this.availableWeapons.add(this.weapon);
    if (id === 0) this.availableWeapons.add('sniper');
    if (id === 2) this.availableWeapons.add('laser');
    for (const owned of this.availableWeapons) this.ammo.set(owned, WEAPON_AMMO_MAX[owned]);
    this.reactionTimer = this.skillProfile.reactionSeconds;
    this.group.userData.archetype = this.archetype;
    this.group.userData.displayName = this.displayName;
    this.group.userData.visualIdentity = this.visualIdentity;
    this.group.userData.floorNormal = this.floorNormal;
    this.weaponGripSocket.name = `bot-${id}-trigger-hand-socket`;
    this.supportGripSocket.name = `bot-${id}-support-hand-socket`;
    this.weaponGripSocket.position.set(-0.22, 1.28, 0.34);
    this.supportGripSocket.position.set(0.22, 1.3, 0.48);
    this.group.add(this.weaponGripSocket, this.supportGripSocket);
    this.createModel(color);
    this.jetpackRig = new JetpackRig({ color, vfxOnly: true });
    this.group.add(this.jetpackRig.root);
    this.ready = this.installAuthoredModel(color);
    this.respawn(spawn);
  }

  private static hashSeed(gameSeed: number, id: number): number {
    let hash = (gameSeed ^ 0x9e3779b9) >>> 0;
    hash = Math.imul(hash ^ (id + 1) * 0x85ebca6b, 0xc2b2ae35) >>> 0;
    hash ^= hash >>> 13;
    return hash >>> 0;
  }

  /** Re-seed this bot's private random stream (all bot randomness flows through it). */
  reseed(gameSeed: number): void {
    this.seedBase = Bot.hashSeed(gameSeed, this.id);
    this.random.reseed(this.seedBase);
  }

  update(
    delta: number,
    elapsed: number,
    target: THREE.Vector3,
    targetVelocity: THREE.Vector3,
    objective: THREE.Vector3,
    hasTargetLineOfSight: boolean,
    context: BotUpdateContext = DEFAULT_CONTEXT,
  ): void {
    this.wantsToFire = false;
    this.wantsToThrowGrenade = false;
    this.knockbackLockout = Math.max(0, this.knockbackLockout - delta);
    this.updateHitFlash(delta);
    if (!this.alive) {
      this.jetpackActive = false;
      this.jetpackRig.update(false, delta, elapsed, false);
      this.respawnTimer -= delta;
      this.group.rotation.z += delta * 2.5;
      this.updateAnimation(delta, 0);
      return;
    }

    this.fireCooldown = Math.max(0, this.fireCooldown - delta);
    this.grenadeCooldown = Math.max(0, this.grenadeCooldown - delta);
    this.grappleCooldown = Math.max(0, this.grappleCooldown - delta);
    this.jetpackTimer = Math.max(0, this.jetpackTimer - delta);
    this.dashCooldown = Math.max(0, this.dashCooldown - delta);
    this.damageBoost = Math.max(0, this.damageBoost - delta);
    this.speedBoost = Math.max(0, this.speedBoost - delta);
    this.weaponLockout = Math.max(0, this.weaponLockout - delta);
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - delta);
    this.jumpPadCooldown = Math.max(0, this.jumpPadCooldown - delta);
    this.blockedTimer = Math.max(0, this.blockedTimer - delta);
    this.combatMoveTimer -= delta;
    this.tacticalTimer -= delta;
    this.threat.decay(delta);

    const eye = this.scratchBotEye.copy(this.group.position);
    eye.y += BOT_AIM_HEIGHT;
    const toTarget = this.scratchToTarget.subVectors(target, eye);
    const targetDistanceSq = toTarget.lengthSq();
    const distance = Math.sqrt(targetDistanceSq);

    // A hit from outside the awareness cone snaps attention toward the damage
    // bearing and widens the cone for a moment, like a player turning to a hit.
    const alerted = this.threat.isAlerted(elapsed);
    if (alerted && this.threat.hasBearing && !this.targetVisible) {
      const snap = 1 - Math.exp(-delta * 14);
      this.aimDirection.lerp(this.threat.damageBearing, snap).normalize();
    }
    this.facingDot = this.flatFacingDot(toTarget);
    const awarenessThreshold = alerted ? -0.98 : this.awarenessDot;
    // A clear BSP trace is necessary but not sufficient: bots only acquire a
    // target inside their forward awareness cone unless they were just hit.
    const visible = context.hasTarget && distance < 155 && hasTargetLineOfSight && this.facingDot > awarenessThreshold;
    this.targetVisible = visible;
    this.targetVisibleFor = visible ? this.targetVisibleFor + delta : 0;
    this.reactionRemaining = visible ? Math.max(0, this.reactionTimer - this.targetVisibleFor) : this.reactionTimer;
    if (visible) {
      this.lastSeenTargetPosition.copy(target);
      this.lastSeenTargetAt = elapsed;
    }
    const recentlySeen = context.hasTarget && elapsed - this.lastSeenTargetAt <= 2;
    this.navigationTarget.copy(objective);
    this.retreating = context.retreat;
    this.chooseWeapon(distance, visible);

    if (this.movementLocked) {
      this.jetpackActive = false;
      this.jetpackRig.update(false, delta, elapsed, false);
      if (this.knockbackLockout <= 0) this.velocity.set(0, 0, 0);
      if (visible && targetDistanceSq > 0.001) {
        this.updateAim(delta, elapsed, eye, target, targetVelocity, distance, context);
      }
      this.group.rotation.y = Math.atan2(this.aimDirection.x, this.aimDirection.z);
      this.tryFire(visible, distance);
      this.group.userData.speed = 0;
      this.updateAnimation(delta, 0);
      return;
    }

    const horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    const inCombat = visible && distance < COMBAT_RANGE && !context.retreat;
    const navigation = context.navigation;

    if (this.tacticalTimer <= 0) {
      // A slightly irregular decision cadence prevents metronomic switching.
      this.tacticalTimer = 0.085 + this.random.next() * 0.05;
      this.planPathIfNeeded(objective, elapsed, navigation);
      const desired = this.steerAlongPath(objective, navigation);
      this.combatStrafing = false;
      if (inCombat && distance < 40 && this.currentLinkKind !== NAV_LINK_PAD) {
        this.applyCombatMovement(desired, toTarget, distance, navigation);
      }
      if (this.blockedTimer > 0 && desired.lengthSq() > 0.001) this.selectTraversableHeading(desired);
      this.wishDirection.copy(desired);
      this.planTraversalActions(horizontalSpeed, objective, navigation);
      this.considerGrapple(eye, inCombat, objective);
    }
    this.processThreats(context);
    this.considerGrenade(eye, target, distance, visible, recentlySeen);

    // ---- Locomotion physics, every tick (Quake friction + Q3 acceleration) ----
    const jumpedThisTick = this.tryJump();
    this.tryDash();
    if (this.grounded && !jumpedThisTick && horizontalSpeed > 0 && this.knockbackLockout <= 0) {
      const skiing = this.floorNormal.y < 0.965 && horizontalSpeed > 8;
      if (skiing) {
        const friction = Math.max(0, 1 - MOVEMENT.skiFriction * delta);
        this.velocity.x *= friction;
        this.velocity.z *= friction;
      } else {
        const control = Math.max(MOVEMENT.stopSpeed, horizontalSpeed);
        const nextSpeed = Math.max(0, horizontalSpeed - control * MOVEMENT.groundFriction * delta);
        const scale = nextSpeed / horizontalSpeed;
        this.velocity.x *= scale;
        this.velocity.z *= scale;
      }
    }
    this.accelerate(delta);

    if (this.grappleActive) {
      const anchorEye = this.scratchDirectionB.copy(this.group.position);
      anchorEye.y += BOT_EYE_HEIGHT;
      const toAnchor = this.scratchDirectionA.subVectors(this.grappleAnchor, anchorEye);
      const anchorDistance = toAnchor.length();
      if (anchorDistance < 0.75 || anchorDistance > GRAPPLE.maxLength * 1.35) {
        this.grappleActive = false;
        this.grappleCooldown = this.grappleRecoveryCooldown();
      } else {
        const ropeDirection = toAnchor.multiplyScalar(1 / anchorDistance);
        const tangent = this.scratchDirectionB.copy(this.wishDirection)
          .addScaledVector(ropeDirection, -this.wishDirection.dot(ropeDirection));
        if (tangent.lengthSq() > 0.001) this.velocity.addScaledVector(tangent.normalize(), GRAPPLE.swingAcceleration * delta);
        const radial = this.velocity.dot(ropeDirection);
        if (radial < 0) this.velocity.addScaledVector(ropeDirection, -radial);
        this.velocity.addScaledVector(ropeDirection, GRAPPLE.pullAcceleration * delta);
        const stretch = anchorDistance - this.grappleLength;
        if (stretch > 0) {
          this.velocity.addScaledVector(ropeDirection, Math.min(stretch * GRAPPLE.ropeTension, 14) * delta);
        }
      }
    }

    // Jetpack: only for climbs the path cannot walk or jump, or to arrest a
    // fall toward the kill plane. Same thrust/cap as the player jetpack.
    const fallDanger = this.velocity.y < -7 && this.fallingTowardKillPlane();
    if (!this.grounded && this.jetpackTimer <= 0 && (this.climbRequested || fallDanger)
      && !this.jetpackEnergy.snapshot().locked) {
      this.jetpackTimer = this.jetpackBurstDuration;
      this.jetpackBursts += 1;
    }
    const jetpack = this.jetpackEnergy.update(delta, !this.grounded && this.jetpackTimer > 0, this.grounded);
    this.jetpackActive = jetpack.active;
    this.jetpackCharge = jetpack.charge;
    this.jetpackLocked = jetpack.locked;
    if (this.jetpackActive) {
      this.velocity.y = Math.min(
        MOVEMENT.jetpackMaxRiseSpeed,
        this.velocity.y + MOVEMENT.jetpackAcceleration * delta,
      );
    }

    this.velocity.y -= MOVEMENT.gravity * delta;
    const speed = this.velocity.length();
    const cap = this.grappleActive ? GRAPPLE.maxSpeed : MOVEMENT.maxSpeed;
    if (speed > cap) this.velocity.multiplyScalar(cap / speed);

    // Grappling can accelerate a bot well beyond its ordinary run speed. Use
    // the same distance-bounded movement substeps as the player so a capsule
    // cannot skip through thin wall or ceiling collision between fixed ticks.
    const frameStart = this.scratchFrameStart.copy(this.group.position);
    const expectedHorizontalDistance = Math.hypot(this.velocity.x, this.velocity.z) * delta;
    const movementSteps = Math.max(
      1,
      Math.ceil(Math.min(speed, GRAPPLE.maxSpeed) * delta / MOVEMENT.maxSubstepDistance),
    );
    const subDelta = delta / movementSteps;
    let frameWallContact = false;
    let frameCeilingContact = false;
    const escapeNormal = this.scratchEscapeNormal.set(0, 0, 0);

    for (let movementStep = 0; movementStep < movementSteps; movementStep += 1) {
      const startPosition = this.scratchStartPosition.copy(this.group.position);
      const startVelocity = this.scratchStartVelocity.copy(this.velocity);
      const wasGrounded = this.grounded;
      this.group.position.addScaledVector(this.velocity, subDelta);
      const blockedPosition = this.scratchBlockedPosition.copy(this.group.position);
      let contact = this.arena.resolveCapsule(
        this.group.position,
        this.velocity,
        BOT_COLLIDER_RADIUS,
        BOT_COLLIDER_HEIGHT,
      );
      blockedPosition.copy(this.group.position);
      const intendedDistance = Math.hypot(startVelocity.x, startVelocity.z) * subDelta;
      const resolvedDistance = Math.hypot(blockedPosition.x - startPosition.x, blockedPosition.z - startPosition.z);
      const blocked = intendedDistance > 0.0001 && resolvedDistance < intendedDistance * 0.9;
      if (wasGrounded && (contact.wallContact || blocked)) {
        const stepped = this.tryStepMove(startPosition, startVelocity, blockedPosition, subDelta);
        if (stepped) contact = stepped;
        else this.blockedTimer = Math.max(this.blockedTimer, 0.48);
      }
      this.grounded = contact.grounded;
      this.floorNormal.copy(contact.contactNormal);

      const ceilingContact = contact.contactNormal.y < -0.42 && contact.correction.y < -1e-5;
      if (contact.wallContact) {
        frameWallContact = true;
        escapeNormal.copy(contact.wallNormal);
      }
      if (ceilingContact) {
        frameCeilingContact = true;
        escapeNormal.copy(contact.contactNormal);
      }

      // Once the capsule reaches the grapple surface, continuing to reel in
      // only pins the AI against that wall/ceiling. Release and preserve a
      // small outward impulse so its existing movement plan can carry it away.
      if (this.grappleActive && (contact.wallContact || ceilingContact)) {
        const ropeEye = this.scratchDirectionB.copy(this.group.position);
        ropeEye.y += BOT_EYE_HEIGHT;
        const ropeDirection = this.scratchDirectionA.subVectors(this.grappleAnchor, ropeEye).normalize();
        const surfaceNormal = ceilingContact ? contact.contactNormal : contact.wallNormal;
        if (surfaceNormal.lengthSq() > 0.5 && ropeDirection.dot(surfaceNormal) < -0.22) {
          this.grappleActive = false;
          this.grappleLength = 0;
          this.grappleCooldown = this.grappleRecoveryCooldown();
          this.blockedTimer = Math.max(this.blockedTimer, 0.7);
          this.velocity.addScaledVector(surfaceNormal, ceilingContact ? 1.6 : 2.8);
          if (!ceilingContact) this.velocity.y = Math.max(this.velocity.y, 2.2);
        }
      }
    }

    if (frameWallContact) this.wallContacts += 1;
    if (frameCeilingContact) this.ceilingContacts += 1;
    const actualHorizontalDistance = Math.hypot(
      this.group.position.x - frameStart.x,
      this.group.position.z - frameStart.z,
    );
    const lowProgress = expectedHorizontalDistance > 0.025
      && actualHorizontalDistance < expectedHorizontalDistance * 0.16;
    if (lowProgress) this.stuckTimer += delta;
    else this.stuckTimer = Math.max(0, this.stuckTimer - delta * 2.5);
    this.stalledFor = this.stuckTimer;
    this.resolveStuck(escapeNormal, frameCeilingContact);

    if (visible && targetDistanceSq > 0.001) {
      this.updateAim(delta, elapsed, eye, target, targetVelocity, distance, context);
    } else if (this.wishDirection.lengthSq() > 0.001) {
      const turn = 1 - Math.exp(-delta * 5.2);
      this.aimDirection.lerp(this.wishDirection, turn).normalize();
    }
    this.group.rotation.y = Math.atan2(this.aimDirection.x, this.aimDirection.z);
    this.tryFire(visible, distance);

    const resolvedHorizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.group.userData.speed = resolvedHorizontalSpeed;
    const navigationDistanceSq = this.group.position.distanceToSquared(this.navigationTarget);
    if (this.group.position.distanceToSquared(this.progressAnchor) > 2.25 * 2.25 || navigationDistanceSq < 4 * 4) {
      this.progressAnchor.copy(this.group.position);
      this.navigationStallTimer = 0;
    } else {
      this.navigationStallTimer += delta;
    }
    if (this.navigationStallTimer >= 4.25 && !this.pathBlocked) {
      // No progress toward the objective: re-plan before anything drastic.
      this.pathBlocked = true;
      this.blockedTimer = Math.max(this.blockedTimer, 0.6);
    }
    if (this.navigationStallTimer >= NAVIGATION_STALL_RELOCATE_SECONDS) {
      this.recoveryRequested = true;
      this.navigationStallTimer = 0;
      this.progressAnchor.copy(this.group.position);
    }
    if (this.grounded) this.jetpackActive = false;
    this.jetpackRig.update(this.jetpackActive, delta, elapsed, false);
    this.updateAnimation(delta, resolvedHorizontalSpeed);
  }

  private flatFacingDot(toTarget: THREE.Vector3): number {
    const targetFlatLengthSq = toTarget.x * toTarget.x + toTarget.z * toTarget.z;
    const facingFlatLengthSq = this.aimDirection.x * this.aimDirection.x
      + this.aimDirection.z * this.aimDirection.z;
    const targetFlatScale = targetFlatLengthSq > 0.001 ? 1 / Math.sqrt(targetFlatLengthSq) : 1;
    const facingFlatScale = facingFlatLengthSq > 0.001 ? 1 / Math.sqrt(facingFlatLengthSq) : 1;
    return (this.aimDirection.x * facingFlatScale) * (toTarget.x * targetFlatScale)
      + (this.aimDirection.z * facingFlatScale) * (toTarget.z * targetFlatScale);
  }

  private planPathIfNeeded(goal: THREE.Vector3, elapsed: number, navigation: BotNavigationGrid | null): void {
    if (!navigation) {
      this.path.valid = false;
      return;
    }
    const needsPlan = !this.path.valid
      || this.pathBlocked
      || elapsed - this.path.plannedAt > PATH_REPLAN_INTERVAL
      || goal.distanceToSquared(this.path.goal) > PATH_GOAL_DRIFT * PATH_GOAL_DRIFT;
    if (!needsPlan) return;
    this.pathBlocked = false;
    this.pathReplans += 1;
    navigation.planPath(this.group.position, goal, this.path);
    this.path.plannedAt = elapsed;
  }

  /** Two-node lookahead path following; falls back to a direct heading. */
  private steerAlongPath(goal: THREE.Vector3, navigation: BotNavigationGrid | null): THREE.Vector3 {
    const desired = this.scratchDesired;
    const position = this.group.position;
    if (!navigation || !this.path.valid || this.path.length < 2) {
      desired.subVectors(goal, position).setY(0);
      if (desired.lengthSq() > 0.001) desired.normalize();
      this.currentLinkKind = NAV_LINK_WALK;
      this.steerPoint.copy(goal);
      this.pathState = navigation && !this.path.valid ? 'blocked' : 'direct';
      // Without a path the seven-probe heading search is the only avoidance.
      this.selectTraversableHeading(desired);
      return desired;
    }
    const path = this.path;
    while (path.cursor < path.length - 1) {
      path.point(path.cursor, this.scratchPathNode);
      const reach = path.kind(path.cursor) === NAV_LINK_PAD ? 0.9 : 1.4;
      const flat = Math.hypot(this.scratchPathNode.x - position.x, this.scratchPathNode.z - position.z);
      if (flat > reach) break;
      path.cursor += 1;
    }
    const steer = path.point(path.cursor, this.scratchPathNode);
    const kind = path.kind(path.cursor);
    this.currentLinkKind = kind;
    if (kind !== NAV_LINK_PAD && path.cursor + 1 < path.length) {
      const nextKind = path.kind(path.cursor + 1);
      if (nextKind === NAV_LINK_WALK) {
        const lookahead = path.point(path.cursor + 1, this.scratchLookahead);
        if (navigation.segmentWalkable(position, lookahead)) steer.copy(lookahead);
      }
    }
    this.steerPoint.copy(steer);
    desired.subVectors(steer, position).setY(0);
    if (desired.lengthSq() > 0.001) desired.normalize();
    this.pathState = 'following';
    return desired;
  }

  private applyCombatMovement(
    desired: THREE.Vector3,
    toTarget: THREE.Vector3,
    distance: number,
    navigation: BotNavigationGrid | null,
  ): void {
    const forward = this.scratchForward.set(toTarget.x, 0, toTarget.z);
    if (forward.lengthSq() < 0.001) return;
    forward.normalize();
    const right = this.scratchRight.set(-forward.z, 0, forward.x);
    if (this.combatMoveTimer <= 0) this.rerollCombatMove(distance);
    if (this.combatStrafe !== 0 && !this.footingAhead(right, this.combatStrafe, forward, this.combatAdvance, navigation)) {
      this.combatStrafe = -this.combatStrafe;
      if (!this.footingAhead(right, this.combatStrafe, forward, this.combatAdvance, navigation)) this.combatStrafe = 0;
    }
    if (this.combatAdvance !== 0 && this.combatStrafe === 0
      && !this.footingAhead(right, 0, forward, this.combatAdvance, navigation)) {
      this.combatAdvance = 0;
    }
    desired.set(0, 0, 0)
      .addScaledVector(right, this.combatStrafe * this.strafeScale)
      .addScaledVector(forward, this.combatAdvance);
    if (desired.lengthSq() > 0.001) desired.normalize();
    this.combatStrafing = this.combatStrafe !== 0;
  }

  /** Warfork-style stepwise random side-step held for `combatmove_timeout`. */
  private rerollCombatMove(distance: number): void {
    const roll = this.random.next();
    if (distance < 8) {
      this.combatStrafe = roll < 0.5 ? -1 : 1;
      this.combatAdvance = this.weapon === 'shotgun' ? 1 : (this.random.next() < 0.3 ? -1 : 0);
    } else if (distance < 20) {
      this.combatStrafe = roll < 0.5 ? -1 : 1;
      this.combatAdvance = this.random.next() < 0.3 ? 1 : 0;
    } else if (distance < 36) {
      this.combatStrafe = roll < 0.5 ? -1 : 1;
      this.combatAdvance = 0;
    } else if (roll < 0.75) {
      this.combatStrafe = this.random.next() < 0.5 ? -1 : 1;
      this.combatAdvance = this.archetypeTuning.aggression > 0.7 ? 1 : 0;
    } else {
      this.combatStrafe = 0;
      this.combatAdvance = 1;
    }
    this.combatMoveTimer = this.random.range(0.2, 1.3);
    this.combatMoves += 1;
  }

  /** Never strafe off a ledge: the destination cell must be walkable near our height. */
  private footingAhead(
    right: THREE.Vector3,
    strafe: number,
    forward: THREE.Vector3,
    advance: number,
    navigation: BotNavigationGrid | null,
  ): boolean {
    const probe = this.scratchProbe.set(0, 0, 0)
      .addScaledVector(right, strafe)
      .addScaledVector(forward, advance * 0.5);
    if (probe.lengthSq() < 0.001) return true;
    probe.normalize().multiplyScalar(2.2).add(this.group.position);
    if (navigation) return navigation.isWalkablePoint(probe, 1.6);
    return this.arena.isTraversablePoint(probe, this.group.position.y + 3.5);
  }

  private planTraversalActions(
    horizontalSpeed: number,
    objective: THREE.Vector3,
    navigation: BotNavigationGrid | null,
  ): void {
    this.climbRequested = false;
    const position = this.group.position;
    const flatToSteer = Math.hypot(this.steerPoint.x - position.x, this.steerPoint.z - position.z);
    if (this.grounded) {
      if (this.currentLinkKind === NAV_LINK_JUMP && flatToSteer <= 2.8) {
        this.jumpRequested = true;
      } else if (horizontalSpeed > 3 && flatToSteer > 1.5 && this.ledgeGapAhead()) {
        this.jumpRequested = true;
      } else if (this.skillProfile.bunnyHops && !this.combatStrafing && horizontalSpeed >= this.wishSpeedBase * 0.9
        && flatToSteer > 6 && this.pathStraightAhead(horizontalSpeed)) {
        this.jumpRequested = true;
      }
    }
    // A climb the grid cannot express (no path, goal well above us) is the one
    // case where fuel is spent: jump first, then burst once airborne.
    if (navigation && !this.path.valid && objective.y > position.y + 2.5
      && Math.hypot(objective.x - position.x, objective.z - position.z) < 14) {
      this.climbRequested = true;
      if (this.grounded) this.jumpRequested = true;
    } else if (this.currentLinkKind === NAV_LINK_JUMP && this.steerPoint.y > position.y + 1.2 && !this.grounded) {
      this.climbRequested = true;
    }
  }

  private ledgeGapAhead(): boolean {
    const position = this.group.position;
    const probe = this.scratchProbe.copy(position).addScaledVector(this.wishDirection, 1.4);
    const floor = this.arena.floorHeightAt(probe.x, probe.z, position.y + 0.6);
    const gap = floor === null || floor < position.y - 2.4;
    return gap && this.steerPoint.y >= position.y - 1.2;
  }

  private pathStraightAhead(horizontalSpeed: number): boolean {
    const along = (this.velocity.x * this.wishDirection.x + this.velocity.z * this.wishDirection.z) / horizontalSpeed;
    if (along < 0.94) return false;
    if (!this.path.valid || this.path.cursor + 1 >= this.path.length) return true;
    const next = this.path.point(this.path.cursor + 1, this.scratchLookahead);
    const dx = next.x - this.group.position.x;
    const dz = next.z - this.group.position.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.5) return true;
    return (dx * this.wishDirection.x + dz * this.wishDirection.z) / length > 0.9;
  }

  private fallingTowardKillPlane(): boolean {
    const position = this.group.position;
    const floor = this.arena.floorHeightAt(position.x, position.z, position.y + 0.5);
    return floor === null || floor < this.arena.killY + 2;
  }

  /** Event-driven dodges: being hit, or a hostile projectile predicted to land nearby. */
  private processThreats(context: BotUpdateContext): void {
    if (!this.skillProfile.dodgesProjectiles) {
      this.threat.consumeDodgeRequest();
      return;
    }
    const right = this.scratchRight.set(-this.aimDirection.z, 0, this.aimDirection.x);
    if (this.threat.consumeDodgeRequest() && this.dodgeCooldown <= 0) {
      let side = this.random.next() < 0.5 ? -1 : 1;
      if (this.threat.hasBearing) {
        const lateral = this.threat.damageBearing.x * right.x + this.threat.damageBearing.z * right.z;
        if (Math.abs(lateral) > 0.3) side = lateral > 0 ? -1 : 1;
      }
      this.dodge(side);
    }
    if (this.dodgeCooldown > 0) return;
    const threats = context.threats;
    const position = this.group.position;
    for (let index = 0; index < threats.length; index += 1) {
      const threat = threats[index];
      if (!threat.active || threat.owner === this.id) continue;
      const dx = threat.position.x - position.x;
      const dy = threat.position.y - position.y;
      const dz = threat.position.z - position.z;
      const reach = 5 + threat.radius;
      if (dx * dx + dy * dy * 0.35 + dz * dz > reach * reach) continue;
      const lateral = dx * right.x + dz * right.z;
      this.dodge(Math.abs(lateral) > 0.2 ? (lateral > 0 ? -1 : 1) : (this.random.next() < 0.5 ? -1 : 1));
      break;
    }
  }

  private dodge(side: number): void {
    this.combatStrafe = side;
    this.combatAdvance = 0;
    this.combatMoveTimer = this.random.range(0.2, 1.0);
    this.dodgeCooldown = 0.35;
    this.dodges += 1;
    const right = this.scratchRight.set(-this.aimDirection.z, 0, this.aimDirection.x);
    this.wishDirection.copy(right).multiplyScalar(side);
    this.combatStrafing = true;
  }

  /** Grapple toward a path node or distant goal, never at the fight target. */
  private considerGrapple(
    eye: THREE.Vector3,
    inCombat: boolean,
    goal: THREE.Vector3,
  ): void {
    if (this.grappleActive || this.grappleCooldown > 0 || this.archetypeTuning.movement.grappleTendency < 0.2) return;
    const position = this.group.position;
    const hookDirection = this.scratchDirectionA;
    let candidates = 0;
    for (let attempt = 1; attempt < 3 && candidates < 2; attempt += 1) {
      if (attempt === 1) {
        if (!this.path.valid) continue;
        const flat = Math.hypot(this.steerPoint.x - position.x, this.steerPoint.z - position.z);
        if (flat < 10 && this.steerPoint.y < position.y + 2.5) continue;
        hookDirection.subVectors(this.steerPoint, eye).normalize();
        hookDirection.y += 0.35;
      } else {
        if (inCombat || !this.grounded) continue;
        const flatGoal = Math.hypot(goal.x - position.x, goal.z - position.z);
        if (flatGoal < 24 || this.random.next() > 0.15) continue;
        hookDirection.copy(this.wishDirection);
        hookDirection.y += 0.3;
      }
      hookDirection.normalize();
      candidates += 1;
      if (hookDirection.y > 0.85) continue;
      this.scratchSegmentEnd.copy(eye).addScaledVector(hookDirection, GRAPPLE.maxLength);
      const hit = this.arena.segmentHitDetails(eye, this.scratchSegmentEnd);
      if (!hit || hit.distance <= GRAPPLE.minLength + 1.5 || hit.point.y < eye.y + 0.5) continue;
      this.grappleActive = true;
      this.grappleAnchor.copy(hit.point).addScaledVector(hit.normal, 0.035);
      this.grappleLength = hit.distance;
      this.grapplesUsed += 1;
      return;
    }
  }

  /** Solve a lob for the visible (or very recently seen) target; never through walls. */
  private considerGrenade(
    eye: THREE.Vector3,
    target: THREE.Vector3,
    distance: number,
    visible: boolean,
    recentlySeen: boolean,
  ): void {
    if (this.grenadeAmmo <= 0 || this.grenadeCooldown > 0 || !(visible || recentlySeen)) return;
    const aimPoint = visible ? target : this.lastSeenTargetPosition;
    const flat = Math.hypot(aimPoint.x - eye.x, aimPoint.z - eye.z);
    if (flat < GRENADE.splash + 1.2 || flat > 13 || distance > 16) return;
    const rise = aimPoint.y - eye.y;
    if (rise < -7 || rise > 3.5) return;
    const flightTime = solveBallisticLaunch(eye, aimPoint, GRENADE.throwSpeed, GRENADE.gravity, this.grenadeLaunchVelocity);
    if (flightTime <= 0 || flightTime > GRENADE.fuse - 0.4) return;
    const launchDirection = this.scratchDirectionA.copy(this.grenadeLaunchVelocity).normalize();
    this.scratchSegmentEnd.copy(eye).addScaledVector(launchDirection, 3);
    if (!this.arena.hasLineOfSight(eye, this.scratchSegmentEnd, 0.2)) return;
    this.wantsToThrowGrenade = true;
    this.grenadeAmmo -= 1;
    this.grenadeCooldown = this.grenadeCooldownDuration;
    this.grenadesThrown += 1;
  }

  private tryJump(): boolean {
    if (!this.jumpRequested) return false;
    this.jumpRequested = false;
    if (!this.grounded) return false;
    const rise = this.velocity.y;
    if (rise > MOVEMENT.doubleJumpStackThreshold * MOVEMENT.jumpImpulse) {
      this.velocity.y = rise + MOVEMENT.jumpImpulse;
    } else {
      this.velocity.y = Math.max(0, rise) + MOVEMENT.jumpImpulse;
    }
    this.grounded = false;
    this.dashCooldown = 0;
    this.bunnyHops += 1;
    return true;
  }

  private tryDash(): void {
    if (!this.dashRequested) return;
    this.dashRequested = false;
    if (!this.grounded || this.dashCooldown > 0 || this.knockbackLockout > 0) return;
    const wishLength = Math.hypot(this.wishDirection.x, this.wishDirection.z);
    const dirX = wishLength > 0.01 ? this.wishDirection.x / wishLength : 0;
    const dirZ = wishLength > 0.01 ? this.wishDirection.z / wishLength : 0;
    if (dirX === 0 && dirZ === 0) return;
    const current = Math.hypot(this.velocity.x, this.velocity.z);
    const dashSpeed = Math.max(current, MOVEMENT.dashSpeed * (this.speedBoost > 0 ? 1.25 : 1));
    this.velocity.x = dirX * dashSpeed;
    this.velocity.z = dirZ * dashSpeed;
    this.velocity.y = Math.max(this.velocity.y, MOVEMENT.dashUpSpeed);
    this.dashCooldown = MOVEMENT.dashCooldown;
    this.grounded = false;
    this.dashesUsed += 1;
  }

  /** Q3 acceleration every tick, plus CPM-style air control when airborne. */
  private accelerate(delta: number): void {
    const wish = this.wishDirection;
    const wishLengthSq = wish.x * wish.x + wish.z * wish.z;
    if (wishLengthSq < 1e-4) return;
    const wishSpeed = this.wishSpeedBase * (this.speedBoost > 0 ? 1.28 : 1);
    const currentAlong = this.velocity.x * wish.x + this.velocity.z * wish.z;
    const acceleration = this.grounded
      ? MOVEMENT.groundAcceleration
      : (currentAlong < 0 ? MOVEMENT.airDeceleration : MOVEMENT.airAcceleration);
    const add = Math.min(acceleration * delta * wishSpeed, wishSpeed - currentAlong);
    if (add > 0) {
      this.velocity.x += wish.x * add;
      this.velocity.z += wish.z * add;
    }
    if (this.grounded || this.grappleActive || this.knockbackLockout > 0) return;
    // PM_Aircontrol: preserve speed, rotate the horizontal heading toward wish.
    const horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (horizontalSpeed < 0.5) return;
    const headingX = this.velocity.x / horizontalSpeed;
    const headingZ = this.velocity.z / horizontalSpeed;
    const dot = headingX * wish.x + headingZ * wish.z;
    if (dot <= 0) return;
    const k = 32 * MOVEMENT.airControl * dot * dot * delta;
    let nextX = headingX * horizontalSpeed + wish.x * k;
    let nextZ = headingZ * horizontalSpeed + wish.z * k;
    const nextLength = Math.hypot(nextX, nextZ);
    if (nextLength < 1e-5) return;
    nextX = nextX / nextLength * horizontalSpeed;
    nextZ = nextZ / nextLength * horizontalSpeed;
    this.velocity.x = nextX;
    this.velocity.z = nextZ;
  }

  /**
   * Escalating stuck response: nudge off the surface, re-plan, jump, rotate
   * the heading, and only after six seconds ask Game to relocate the body.
   */
  private resolveStuck(escapeNormal: THREE.Vector3, frameCeilingContact: boolean): void {
    if (this.stuckTimer >= 0.42 && escapeNormal.lengthSq() > 0.25) {
      escapeNormal.normalize();
      this.grappleActive = false;
      this.grappleLength = 0;
      this.grappleCooldown = Math.max(this.grappleCooldown, this.grappleRecoveryCooldown());
      this.group.position.addScaledVector(escapeNormal, BOT_COLLIDER_RADIUS * 0.3);
      this.velocity.addScaledVector(escapeNormal, frameCeilingContact ? 3.2 : 4.4);
      if (!frameCeilingContact) this.velocity.y = Math.max(this.velocity.y, 3.4);
      this.arena.resolveCapsule(this.group.position, this.velocity, BOT_COLLIDER_RADIUS, BOT_COLLIDER_HEIGHT);
      this.blockedTimer = Math.max(this.blockedTimer, 0.9);
      this.collisionRecoveries += 1;
      this.pathBlocked = true;
      this.stuckTimer = Math.max(0, this.stuckTimer - 0.42);
      return;
    }
    if (this.stuckTimer >= 0.9 && !this.pathBlocked) {
      this.pathBlocked = true;
      this.blockedTimer = Math.max(this.blockedTimer, 0.6);
    }
    if (this.stuckTimer >= 1.6 && this.grounded) this.jumpRequested = true;
    if (this.stuckTimer >= 2.4 && this.blockedTimer <= 0.05) {
      const angle = (this.random.next() < 0.5 ? -1 : 1) * (Math.PI * 0.5);
      this.wishDirection.applyAxisAngle(THREE.Object3D.DEFAULT_UP, angle);
      this.blockedTimer = 0.8;
    }
    if (this.stuckTimer >= STUCK_RELOCATE_SECONDS || this.group.position.y < this.arena.killY) {
      this.recoveryRequested = true;
      this.stuckTimer = 0;
      this.stalledFor = 0;
    }
  }

  /** Warfork-style fire decision: in-front + skill delay, along the hunted heading. */
  private tryFire(visible: boolean, distance: number): void {
    if (BOT_WEAPON_RANGE[this.weapon] < distance) return;
    if (!INFINITE_AMMO_WEAPONS.has(this.weapon) && (this.ammo.get(this.weapon) ?? 0) <= 0) {
      this.weaponLockout = 0;
      return;
    }
    const continuous = this.weapon === 'laser' || this.weapon === 'plasma';
    if (!botMayPullTrigger({
      visible,
      acquired: this.targetVisibleFor >= this.reactionTimer,
      fireCooldown: this.fireCooldown,
      continuous,
      fireProbability: this.skillProfile.fireProbability,
      unitRandom: continuous ? 0 : this.random.next(),
    })) return;
    this.wantsToFire = true;
    this.shotsFired += 1;
    if (!INFINITE_AMMO_WEAPONS.has(this.weapon)) this.ammo.set(this.weapon, (this.ammo.get(this.weapon) ?? 1) - 1);
    this.fireCooldown = this.weaponCooldownForCurrentWeapon();
  }

  private tryStepMove(
    startPosition: THREE.Vector3,
    startVelocity: THREE.Vector3,
    blockedPosition: THREE.Vector3,
    delta: number,
  ): ReturnType<ArenaRuntime['resolveCapsule']> | null {
    const intendedDistance = Math.hypot(startVelocity.x, startVelocity.z) * delta;
    if (intendedDistance < 0.0001) return null;
    const blockedDistance = Math.hypot(blockedPosition.x - startPosition.x, blockedPosition.z - startPosition.z);
    const stepPosition = this.scratchStepPosition.copy(startPosition);
    stepPosition.y += MOVEMENT.stepHeight;
    const stepVelocity = this.scratchStepVelocity.copy(startVelocity).setY(0);
    this.arena.resolveCapsule(stepPosition, stepVelocity, BOT_COLLIDER_RADIUS, BOT_COLLIDER_HEIGHT);
    if (stepPosition.y < startPosition.y + MOVEMENT.stepHeight * 0.72) return null;
    stepPosition.x += stepVelocity.x * delta;
    stepPosition.z += stepVelocity.z * delta;
    this.arena.resolveCapsule(stepPosition, stepVelocity, BOT_COLLIDER_RADIUS, BOT_COLLIDER_HEIGHT);
    const direction = this.scratchStepDirection.set(startVelocity.x, 0, startVelocity.z).normalize();
    let nearestFloor: number | undefined;
    let nearestFloorDistance = Number.POSITIVE_INFINITY;
    let lowestRisingFloor: number | undefined;
    for (const offset of STEP_PROBE_OFFSETS) {
      const height = this.arena.floorHeightAt(
        stepPosition.x + direction.x * offset,
        stepPosition.z + direction.z * offset,
        stepPosition.y + 0.08,
      );
      if (height === null
        || height < startPosition.y - MOVEMENT.groundSnapDistance - 0.02
        || height > startPosition.y + MOVEMENT.stepHeight + 0.04) continue;
      const floorDistance = Math.abs(height - startPosition.y);
      if (floorDistance < nearestFloorDistance) {
        nearestFloor = height;
        nearestFloorDistance = floorDistance;
      }
      if (height > startPosition.y + 0.015
        && (lowestRisingFloor === undefined || height < lowestRisingFloor)) {
        lowestRisingFloor = height;
      }
    }
    const floor = lowestRisingFloor ?? nearestFloor;
    if (floor === undefined) return null;
    stepPosition.y = floor - 0.003;
    stepVelocity.y = -0.1;
    const landing = this.arena.resolveCapsule(stepPosition, stepVelocity, BOT_COLLIDER_RADIUS, BOT_COLLIDER_HEIGHT);
    const steppedDistance = Math.hypot(stepPosition.x - startPosition.x, stepPosition.z - startPosition.z);
    if (!landing.grounded || steppedDistance <= blockedDistance + 0.005) return null;
    stepVelocity.y = 0;
    this.group.position.copy(stepPosition);
    this.velocity.copy(stepVelocity);
    this.stepSuccesses += 1;
    return landing;
  }

  takeDamage(amount: number): boolean {
    if (!this.alive) return false;
    const absorbed = Math.min(this.armor, amount * 0.66);
    this.armor -= absorbed;
    this.health -= amount - absorbed;
    this.flash();
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.respawnTimer = this.skillProfile.respawnDelaySeconds;
      this.velocity.set(0, 5, 0);
      return true;
    }
    return false;
  }

  /** Remember who hurt us and from where so targeting and awareness can react. */
  registerDamage(source: BotDamageSource, amount: number, origin: THREE.Vector3 | null, elapsed: number): void {
    if (!this.alive) return;
    this.threat.registerDamage(source, amount, origin, this.group.position, this.aimDirection, this.awarenessDot, elapsed);
  }

  /** Whether this owner is the bot's recent attacker (weighted 1.0 vs 0.3 in target choice). */
  isRecentAttacker(owner: 'player' | number, elapsed: number): boolean {
    return this.threat.attackerIsRecent(elapsed) && this.threat.lastAttacker === owner;
  }

  readyToRespawn(): boolean {
    return !this.alive && this.respawnTimer <= 0;
  }

  respawn(position: THREE.Vector3, validateSpawn = true): void {
    this.group.position.copy(validateSpawn
      ? this.arena.safeSpawnPoint(position, BOT_COLLIDER_RADIUS, BOT_COLLIDER_HEIGHT) ?? position
      : position);
    this.velocity.set(0, 0, 0);
    this.grounded = true;
    this.floorNormal.set(0, 1, 0);
    this.health = 100;
    this.armor = 50;
    this.alive = true;
    this.respawnTimer = 0;
    this.group.rotation.set(0, 0, 0);
    this.aimDirection.set(0, 0, -1);
    this.aimRates.speedYaw = 0;
    this.aimRates.speedPitch = 0;
    this.wishDirection.set(0, 0, -1);
    this.targetVisible = false;
    this.targetVisibleFor = 0;
    this.grappleActive = false;
    this.grappleLength = 0;
    this.grappleCooldown = 0;
    this.jetpackActive = false;
    this.jetpackTimer = 0;
    this.jetpackRig.update(false, 1, 0, true);
    this.jetpackEnergy.reset();
    this.jetpackCharge = 1;
    this.jetpackLocked = false;
    this.dashCooldown = 0;
    this.grenadeAmmo = 3;
    this.grenadeCooldown = 0;
    this.jumpRequested = false;
    this.dashRequested = false;
    this.climbRequested = false;
    this.jumpPadCooldown = 0;
    this.stuckTimer = 0;
    this.stalledFor = 0;
    this.navigationStallTimer = 0;
    this.progressAnchor.copy(this.group.position);
    this.recoveryRequested = false;
    this.targetOwner = null;
    this.aimErrorDegrees = 0;
    this.aimTracking = 0;
    this.reactionRemaining = this.reactionTimer;
    this.combatMoveTimer = 0;
    this.combatStrafe = 0;
    this.combatAdvance = 0;
    this.combatStrafing = false;
    this.weaponLockout = 0;
    this.lastSeenTargetAt = Number.NEGATIVE_INFINITY;
    this.path.clear();
    this.pathBlocked = false;
    this.pathState = 'none';
    this.retreating = false;
    this.threat.reset();
    for (const owned of this.availableWeapons) {
      const current = this.ammo.get(owned) ?? 0;
      this.ammo.set(owned, Math.max(current, Math.ceil(WEAPON_AMMO_MAX[owned] * 0.5)));
    }
    this.lives += 1;
    this.random.reseed((this.seedBase ^ Math.imul(this.lives, 0x9e3779b9)) >>> 0);
    this.group.visible = true;
  }

  /** Move the body without touching health, armor, ammo or grenades (last-resort unstick). */
  relocate(position: THREE.Vector3): void {
    this.group.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.grounded = true;
    this.floorNormal.set(0, 1, 0);
    this.grappleActive = false;
    this.grappleLength = 0;
    this.grappleCooldown = Math.max(this.grappleCooldown, this.grappleRecoveryCooldown());
    this.jetpackTimer = 0;
    this.stuckTimer = 0;
    this.stalledFor = 0;
    this.blockedTimer = 0;
    this.navigationStallTimer = 0;
    this.progressAnchor.copy(position);
    this.recoveryRequested = false;
    this.path.clear();
    this.pathBlocked = false;
    this.pathState = 'none';
    this.relocations += 1;
  }

  /** Jump-pad launch identical to the player's `checkJumpPads` impulse. */
  launchFromPad(direction: THREE.Vector3, launchSpeed: number): boolean {
    if (!this.alive || this.jumpPadCooldown > 0) return false;
    const preserved = Math.max(18, Math.hypot(this.velocity.x, this.velocity.z));
    this.velocity.addScaledVector(direction, Math.max(launchSpeed, preserved * 0.68));
    this.velocity.y = Math.max(this.velocity.y, direction.y * launchSpeed);
    this.grounded = false;
    this.jumpPadCooldown = PAD_LAUNCH_COOLDOWN;
    this.padLaunches += 1;
    // The pad carried us past the pad node; let the next tactical tick re-plan
    // from wherever we land rather than steering back to the pad.
    this.pathBlocked = true;
    return true;
  }

  private updateAim(
    delta: number,
    elapsed: number,
    eye: THREE.Vector3,
    target: THREE.Vector3,
    targetVelocity: THREE.Vector3,
    distance: number,
    context: BotUpdateContext,
  ): void {
    const aimPoint = this.scratchAimPoint.copy(target);
    const projectileSpeed = WEAPON_PROJECTILE_SPEED[this.weapon];
    if (projectileSpeed > 0 && this.skillProfile.predictsProjectiles) {
      // Linear lead (Warfork BOT_DMclass_PredictProjectileShot); halve the
      // lead when the predicted point is not visible from the muzzle.
      let lead = Math.min(0.9, distance / projectileSpeed);
      aimPoint.addScaledVector(targetVelocity, lead);
      if (!this.arena.hasLineOfSight(eye, aimPoint, 0.45)) {
        lead *= 0.5;
        aimPoint.copy(target).addScaledVector(targetVelocity, lead);
        if (!this.arena.hasLineOfSight(eye, aimPoint, 0.45)) aimPoint.copy(target);
      }
    }
    if (this.weapon === 'rocket' && context.targetGrounded) {
      // Explosive aim style: from above the enemy's feet, aim at the floor by
      // their feet so the splash lands even when the direct shot would miss.
      const feetY = target.y - context.targetCenterOffset + 0.1;
      if (eye.y > feetY) {
        const feetX = aimPoint.x;
        const feetZ = aimPoint.z;
        const feetPoint = this.scratchAimDesired.set(feetX, feetY, feetZ);
        if (this.arena.hasLineOfSight(eye, feetPoint, 0.35)) aimPoint.copy(feetPoint);
      }
    }
    const desired = this.scratchAimDesired.subVectors(aimPoint, eye);
    if (desired.lengthSq() < 1e-6) return;
    desired.normalize();
    const idealX = desired.x;
    const idealY = desired.y;
    const idealZ = desired.z;

    // Warfork wfac: world-XY jitter on the aim point, then AI_ChangeAngle hunts it.
    const wfac = aimWfacMetres(this.weapon, this.skillProfile.skill, !context.targetGrounded);
    applyAimWfacOffset(aimPoint, this.weapon, wfac, elapsed, () => this.random.next());
    desired.subVectors(aimPoint, eye);
    if (desired.lengthSq() < 1e-6) return;
    desired.normalize();

    // AI_ChangeAngle: persistent yaw_accel, 10°/3° damping, no snap-to-ideal.
    yawPitchFromDirection(this.aimDirection, this.scratchAimAngles);
    yawPitchFromDirection(desired, this.scratchIdealAngles);
    const turned = stepAimChangeAngle(
      this.scratchAimAngles.yaw,
      this.scratchAimAngles.pitch,
      this.scratchIdealAngles.yaw,
      this.scratchIdealAngles.pitch,
      this.aimRates,
      this.yawSpeedRadians,
      this.yawAccelRadians,
      delta,
    );
    directionFromYawPitch(turned.yaw, turned.pitch, this.aimDirection);
    this.aimTracking = THREE.MathUtils.clamp(this.aimDirection.dot(desired), -1, 1);
    const idealDot = THREE.MathUtils.clamp(
      this.aimDirection.x * idealX + this.aimDirection.y * idealY + this.aimDirection.z * idealZ,
      -1,
      1,
    );
    this.aimErrorDegrees = THREE.MathUtils.radToDeg(Math.acos(idealDot));
  }

  private chooseWeapon(distance: number, visible: boolean): void {
    if (this.weaponLocked) return;
    const currentAmmo = INFINITE_AMMO_WEAPONS.has(this.weapon) ? 1 : (this.ammo.get(this.weapon) ?? 0);
    const currentOutranged = BOT_WEAPON_RANGE[this.weapon] < distance && visible;
    if (this.weaponLockout > 0 && currentAmmo > 0 && !currentOutranged) return;
    const next = this.bestAvailableWeapon(botWeaponBandForDistance(distance, visible), distance);
    if (next === this.weapon) return;
    this.weapon = next;
    this.weaponSwitches += 1;
    this.weaponLockout = this.skillProfile.weaponLockoutSeconds;
    this.fireCooldown = Math.max(this.fireCooldown, 0.18);
  }

  private bestAvailableWeapon(choices: readonly WeaponId[], distance: number): WeaponId {
    let best: WeaponId | null = null;
    let bestUtility = Number.NEGATIVE_INFINITY;
    const jitter = (1 - this.skillProfile.skill) * 0.3;
    for (const choice of choices) {
      if (!this.availableWeapons.has(choice)) continue;
      if (BOT_WEAPON_RANGE[choice] < distance) continue;
      const infinite = INFINITE_AMMO_WEAPONS.has(choice);
      const ammo = infinite ? 1 : (this.ammo.get(choice) ?? 0);
      if (ammo <= 0) continue;
      const ammoWeight = infinite ? 0.9 : 0.55 + 0.45 * Math.min(1, ammo / WEAPON_AMMO_MAX[choice]);
      const utility = (this.getWeaponUtility(choice) + 0.2) * ammoWeight + this.random.signed() * jitter;
      if (utility <= bestUtility) continue;
      best = choice;
      bestUtility = utility;
    }
    if (best) return best;
    return this.longestRangeOwnedWeapon();
  }

  private longestRangeOwnedWeapon(): WeaponId {
    let best: WeaponId = 'machine';
    let bestRange = -1;
    for (const owned of this.availableWeapons) {
      const ammo = INFINITE_AMMO_WEAPONS.has(owned) ? 1 : (this.ammo.get(owned) ?? 0);
      if (ammo <= 0) continue;
      const range = BOT_WEAPON_RANGE[owned];
      if (range < bestRange) continue;
      best = owned;
      bestRange = range;
    }
    return best;
  }

  get grenadesRemaining(): number {
    return this.grenadeAmmo;
  }

  get pathNodes(): number {
    return this.path.valid ? this.path.length : 0;
  }

  get pathCursor(): number {
    return this.path.cursor;
  }

  get pathCost(): number {
    return this.path.valid ? this.path.totalCost : Number.POSITIVE_INFINITY;
  }

  get currentLinkName(): NavLinkName {
    return navLinkName(this.currentLinkKind);
  }

  get combatMoveLabel(): string {
    if (!this.combatStrafing && this.combatAdvance === 0) return 'hold';
    const strafe = this.combatStrafe < 0 ? 'left' : this.combatStrafe > 0 ? 'right' : '';
    const advance = this.combatAdvance > 0 ? 'forward' : this.combatAdvance < 0 ? 'back' : '';
    if (strafe && advance) return `${strafe}-${advance}`;
    return strafe || advance || 'hold';
  }

  get preferredWeaponRoles(): BotArchetypeTuning['preferredWeaponRoles'] {
    return this.archetypeTuning.preferredWeaponRoles;
  }

  getObjectiveUtility(objective: BotObjectiveKind): number {
    return botObjectiveUtility(this.archetypeTuning, objective);
  }

  getPickupUtility(pickup: BotPickupKind): number {
    return botPickupUtility(this.archetypeTuning, pickup);
  }

  getWeaponUtility(weapon: WeaponId): number {
    return botWeaponUtility(this.archetypeTuning, weapon);
  }

  /** Whether the bot already carries this weapon with a healthy ammo reserve. */
  ownsWeaponWithAmmo(weapon: WeaponId, minimumFraction = 0.4): boolean {
    if (!this.availableWeapons.has(weapon)) return false;
    if (INFINITE_AMMO_WEAPONS.has(weapon)) return true;
    return (this.ammo.get(weapon) ?? 0) >= WEAPON_AMMO_MAX[weapon] * minimumFraction;
  }

  ammoFraction(weapon: WeaponId): number {
    if (INFINITE_AMMO_WEAPONS.has(weapon)) return 1;
    return Math.min(1, (this.ammo.get(weapon) ?? 0) / WEAPON_AMMO_MAX[weapon]);
  }

  /** Uniform draw from this bot's seeded stream (for Game-side objective jitter). */
  randomUnit(): number {
    return this.random.next();
  }

  collectPickup(kind: 'health' | 'armor' | 'damage' | 'speed' | WeaponId): void {
    if (kind === 'health') this.health = Math.min(125, this.health + 50);
    else if (kind === 'armor') this.armor = Math.min(150, this.armor + 100);
    else if (kind === 'damage') this.damageBoost = POWERUP.duration;
    else if (kind === 'speed') this.speedBoost = POWERUP.duration;
    else {
      this.availableWeapons.add(kind);
      const max = WEAPON_AMMO_MAX[kind];
      this.ammo.set(kind, Math.min(max, (this.ammo.get(kind) ?? 0) + Math.max(1, Math.ceil(max * 0.45))));
      this.weapon = kind;
      this.weaponLockout = this.skillProfile.weaponLockoutSeconds;
    }
  }

  consumeRecoveryRequest(): boolean {
    const requested = this.recoveryRequested;
    this.recoveryRequested = false;
    return requested;
  }

  private weaponCooldownForCurrentWeapon(): number {
    switch (this.weapon) {
      case 'shotgun': return 0.9;
      case 'rocket': return 0.95;
      case 'plasma': return 0.125;
      case 'laser': return 0.1;
      case 'sniper': return 1.1;
      case 'rail': return 1.5;
      case 'disc': return 0.72;
      case 'machine': return 0.09;
      default: {
        const exhaustive: never = this.weapon;
        throw new Error(`Unknown weapon ${String(exhaustive)}`);
      }
    }
  }

  private grappleRecoveryCooldown(): number {
    return this.grappleCooldownDuration;
  }

  private selectTraversableHeading(desired: THREE.Vector3): void {
    if (desired.lengthSq() < 0.001) return;
    for (const heading of TRAVERSAL_HEADINGS) {
      const candidateDirection = this.scratchTraversalDirection.set(
        desired.x * heading.cosine + desired.z * heading.sine,
        0,
        desired.z * heading.cosine - desired.x * heading.sine,
      );
      const probe = this.scratchTraversalProbe.copy(this.group.position)
        .addScaledVector(candidateDirection, TRAVERSAL_PROBE_DISTANCE);
      if (!this.arena.isTraversablePoint(probe, this.group.position.y + 3.5)) continue;
      desired.copy(candidateDirection);
      return;
    }
    const fallback = this.id % 2 ? TRAVERSAL_FALLBACK.positive : TRAVERSAL_FALLBACK.negative;
    const desiredX = desired.x;
    const desiredZ = desired.z;
    desired.x = desiredX * fallback.cosine + desiredZ * fallback.sine;
    desired.z = desiredZ * fallback.cosine - desiredX * fallback.sine;
  }

  dispose(): void {
    this.disposed = true;
    this.mixer?.stopAllAction();
    this.jetpackRig.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
  }

  private async installAuthoredModel(color: number): Promise<void> {
    try {
      const asset = await loadCharacterAsset();
      if (this.disposed) return;

      // The procedural silhouette is created synchronously so the bot has a
      // visible fallback while the GLB loads. Once the authored asset is
      // ready, release that temporary resource before replacing the children;
      // otherwise every bot keeps its hidden fallback geometries/materials in
      // renderer memory for the entire match.
      const fallbackGeometries = new Set<THREE.BufferGeometry>();
      const fallbackMaterials = new Set<THREE.Material>();
      this.group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (mesh.userData.jetpackVfx) return;
        if (mesh.geometry) fallbackGeometries.add(mesh.geometry);
        if (Array.isArray(mesh.material)) mesh.material.forEach((material) => fallbackMaterials.add(material));
        else if (mesh.material) fallbackMaterials.add(mesh.material);
      });
      for (const geometry of fallbackGeometries) geometry.dispose();
      for (const material of fallbackMaterials) material.dispose();
      this.geometries.length = 0;
      this.materials.length = 0;

      const model = cloneSkeleton(asset.scene) as THREE.Group;
      const teamColor = new THREE.Color(color);
      model.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        // SkeletonUtils clones the node/bone hierarchy; the immutable GLB
        // geometries can remain shared by all three team variants.
        // Per-bot materials are still cloned below for team-color tuning.
        const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const authoredMaterials = sourceMaterials.map((source) => {
          const material = source.clone();
          if (material instanceof THREE.MeshStandardMaterial) {
            const materialRole = material.name.toLowerCase();
            if (materialRole.includes('helmet')) {
              material.color.multiplyScalar(0.94).lerp(teamColor, 0.08);
              material.emissive.copy(teamColor).multiplyScalar(0.14);
              material.emissiveIntensity = 0.78;
            } else if (materialRole.includes('jumpjet')) {
              material.color.multiplyScalar(0.88).lerp(teamColor, 0.12);
              material.emissive.copy(teamColor).multiplyScalar(0.12);
              material.emissiveIntensity = 0.64;
            } else {
              material.color.multiplyScalar(materialRole.includes('pants') ? 0.82 : 0.9)
                .lerp(teamColor, materialRole.includes('gear') ? 0.09 : 0.045);
              material.emissive.copy(teamColor).multiplyScalar(0.045);
              material.emissiveIntensity = 0.28;
            }
            material.roughness = Math.max(0.3, material.roughness * 0.9);
            material.metalness = Math.min(0.72, material.metalness + 0.07);
            material.envMapIntensity = 0.86;
            material.side = THREE.DoubleSide;
            material.userData.baseEmissiveIntensity = material.emissiveIntensity;
          }
          this.materials.push(material);
          return material;
        });
        mesh.material = Array.isArray(mesh.material) ? authoredMaterials : authoredMaterials[0];
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.modelMeshCount += 1;
        mesh.onBeforeRender = () => {
          this.renderedMeshes.add(mesh.name || `mesh-${mesh.id}`);
          this.renderedMeshCount = this.renderedMeshes.size;
        };
        // Animated skinned bounds from this asset are authored in centimeter
        // space; disable static frustum bounds after normalization so the
        // character cannot be culled while its team hardware remains visible.
        mesh.frustumCulled = false;
      });

      // CharacterAsset normalizes the supplied trooper to gameplay meters
      // before applying the donor rig, so no second scale belongs here.
      model.scale.setScalar(1);
      model.position.set(0, 0, 0);
      model.name = `vector-${this.id + 1}-authored-character`;

      for (const child of [...this.group.children]) this.group.remove(child);
      this.group.add(model);
      this.attachGripSocket(model, 'WristR', this.weaponGripSocket);
      this.attachGripSocket(model, 'WristL', this.supportGripSocket);
      this.primaryArmIk.attach(model, 'R');
      this.supportArmIk.attach(model, 'L');
      this.addTeamHardware(color);
      this.group.add(this.jetpackRig.root);
      this.group.updateMatrixWorld(true);
      const installedBounds = new THREE.Box3().setFromObject(model);
      const installedSize = installedBounds.getSize(new THREE.Vector3());
      this.modelHeight = installedSize.y;
      this.modelWidth = installedSize.x;
      this.modelDepth = installedSize.z;
      const installedCenter = installedBounds.getCenter(new THREE.Vector3());
      this.modelCenterY = installedCenter.y - this.group.position.y;
      this.modelCenterX = installedCenter.x - this.group.position.x;
      this.modelCenterZ = installedCenter.z - this.group.position.z;
      this.runtimeBoneCount = asset.diagnostics.runtimeBoneCount;
      this.runtimeAnimationCount = asset.diagnostics.runtimeAnimationCount;
      this.sourceTriangleCount = asset.diagnostics.triangleCount;
      this.sourceTextureCount = asset.diagnostics.textureCount;
      this.mixer = new THREE.AnimationMixer(model);
      for (const clip of asset.animations) {
        const action = this.mixer.clipAction(clip);
        const key = clip.name.toLowerCase();
        if (key.includes('death') || key.includes('jump') || key.includes('shoot')) {
          action.setLoop(THREE.LoopOnce, 1);
          action.clampWhenFinished = true;
        }
        this.actions.set(key, action);
      }
      this.modelReady = true;
      this.activeAnimation = '';
      if (!this.bindPoseDebug) this.playAnimation('idle_gun', 0);
    } catch {
      // The procedural silhouette remains as an offline/loading fallback.
      this.modelReady = false;
    }
  }

  solveSupportHand(targetWorld: THREE.Vector3): number {
    return this.supportArmIk.solve(targetWorld);
  }

  solvePrimaryHand(targetWorld: THREE.Vector3): number {
    return this.primaryArmIk.solve(targetWorld);
  }

  get animationName(): string {
    return this.activeAnimation;
  }

  private attachGripSocket(model: THREE.Object3D, boneName: string, socket: THREE.Object3D): void {
    const bone = model.getObjectByName(boneName);
    if (!bone) return;
    bone.add(socket);
    socket.position.set(0, 0, 0);
    socket.rotation.set(0, 0, 0);
    socket.scale.set(1, 1, 1);
  }

  private addTeamHardware(color: number): void {
    const accent = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.48,
      roughness: 0.27,
      metalness: 0.58,
    });
    accent.userData.baseEmissiveIntensity = accent.emissiveIntensity;
    this.materials.push(accent);
    const beaconGeometry = new THREE.OctahedronGeometry(0.045, 1);
    this.geometries.push(beaconGeometry);
    const beacons = new THREE.InstancedMesh(beaconGeometry, accent, 2);
    beacons.name = 'team-beacons';
    const beaconMatrix = new THREE.Matrix4();
    for (const [index, side] of [-1, 1].entries()) {
      beaconMatrix.makeTranslation(side * 0.34, 1.46, 0.06);
      beacons.setMatrixAt(index, beaconMatrix);
    }
    beacons.instanceMatrix.needsUpdate = true;
    beacons.castShadow = true;
    beacons.receiveShadow = true;
    this.group.add(beacons);
    this.roleHardwareMeshCount = 0;
    this.roleHardwareProfile = this.visualIdentity.roleLabel;
  }

  private updateAnimation(delta: number, speed: number): void {
    if (!this.mixer || this.bindPoseDebug) return;
    const animation = !this.alive
      ? 'death'
      : this.wantsToFire
        ? 'shoot'
        : !this.grounded
          ? 'jump'
          : speed > 0.8
            ? 'run_shoot'
            : 'idle_gun_pointing';
    this.playAnimation(animation, 0.13);
    for (const [key, action] of this.actions) {
      if (key.includes('run_shoot')) action.timeScale = THREE.MathUtils.clamp(speed / 6.8, 0.58, 1.34);
    }
    this.mixer.update(delta);
  }

  private playAnimation(name: string, fade: number): void {
    if (name === this.activeAnimation) return;
    let next: THREE.AnimationAction | undefined;
    let fuzzyNext: THREE.AnimationAction | undefined;
    let previous: THREE.AnimationAction | undefined;
    for (const [key, action] of this.actions) {
      if (!fuzzyNext && key.includes(name)) fuzzyNext = action;
      if (!next && key.endsWith(`|${name}`)) next = action;
      if (!previous && this.activeAnimation && key.includes(this.activeAnimation)) previous = action;
    }
    next ??= fuzzyNext;
    if (!next) return;
    previous?.fadeOut(fade);
    next.reset().fadeIn(fade).play();
    this.activeAnimation = name;
  }

  private createModel(color: number): void {
    const bodyMaterial = new THREE.MeshToonMaterial({ color, emissive: color, emissiveIntensity: 0.12 });
    const darkMaterial = new THREE.MeshToonMaterial({ color: 0x101628 });
    const visorMaterial = new THREE.MeshToonMaterial({ color: 0x8ff7ff, emissive: 0x36ddff, emissiveIntensity: 1.1 });
    const outlineMaterial = new THREE.MeshBasicMaterial({ color: 0x03050a, side: THREE.BackSide });
    this.materials.push(bodyMaterial, darkMaterial, visorMaterial, outlineMaterial);

    const bodyGeometry = new THREE.CapsuleGeometry(0.62, 1.15, 5, 10);
    const shoulderGeometry = new THREE.BoxGeometry(1.9, 0.45, 0.72);
    const headGeometry = new THREE.DodecahedronGeometry(0.48, 0);
    const legGeometry = new THREE.BoxGeometry(0.42, 1.05, 0.5);
    this.geometries.push(bodyGeometry, shoulderGeometry, headGeometry, legGeometry);

    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    body.position.y = 1.35;
    body.castShadow = true;
    this.group.add(body);
    const bodyOutline = new THREE.Mesh(bodyGeometry, outlineMaterial);
    bodyOutline.position.copy(body.position);
    bodyOutline.scale.setScalar(1.055);
    this.group.add(bodyOutline);
    const shoulders = new THREE.Mesh(shoulderGeometry, darkMaterial);
    shoulders.position.y = 1.82;
    shoulders.castShadow = true;
    this.group.add(shoulders);
    const shouldersOutline = new THREE.Mesh(shoulderGeometry, outlineMaterial);
    shouldersOutline.position.copy(shoulders.position);
    shouldersOutline.scale.setScalar(1.065);
    this.group.add(shouldersOutline);
    const head = new THREE.Mesh(headGeometry, darkMaterial);
    head.position.y = 2.55;
    head.castShadow = true;
    this.group.add(head);
    const headOutline = new THREE.Mesh(headGeometry, outlineMaterial);
    headOutline.position.copy(head.position);
    headOutline.scale.setScalar(1.075);
    this.group.add(headOutline);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.16, 0.08), visorMaterial);
    this.geometries.push(visor.geometry);
    visor.position.set(0, 2.58, 0.43);
    this.group.add(visor);
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(legGeometry, bodyMaterial);
      leg.position.set(side * 0.34, 0.55, 0);
      leg.castShadow = true;
      this.group.add(leg);
      const legOutline = new THREE.Mesh(legGeometry, outlineMaterial);
      legOutline.position.copy(leg.position);
      legOutline.scale.setScalar(1.065);
      this.group.add(legOutline);
    }
    this.group.userData.botId = this.id;
  }

  private flash(): void {
    this.hitFlashRemaining = 0.08;
    for (const material of this.materials) {
      if (!(material instanceof THREE.MeshToonMaterial || material instanceof THREE.MeshStandardMaterial)) continue;
      const base = Number(material.userData.baseEmissiveIntensity ?? material.emissiveIntensity);
      material.userData.baseEmissiveIntensity = base;
      material.emissiveIntensity = Math.max(base, 1.8);
    }
  }

  private updateHitFlash(delta: number): void {
    if (this.hitFlashRemaining <= 0) return;
    this.hitFlashRemaining = Math.max(0, this.hitFlashRemaining - delta);
    if (this.hitFlashRemaining > 0) return;
    for (const material of this.materials) {
      if (!(material instanceof THREE.MeshToonMaterial || material instanceof THREE.MeshStandardMaterial)) continue;
      material.emissiveIntensity = Number(material.userData.baseEmissiveIntensity ?? material.emissiveIntensity);
    }
  }
}
