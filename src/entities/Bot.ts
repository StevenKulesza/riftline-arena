import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { assetUrl } from '../assets/assetUrl';
import { JetpackRig } from '../assets/JetpackRig';
import type { ArenaRuntime } from '../game/Arena';
import { GRAPPLE, MOVEMENT, POWERUP, type WeaponId } from '../game/config';
import {
  botArchetypeForId,
  botObjectiveUtility,
  botPickupUtility,
  botWeaponUtility,
  type BotArchetypeId,
  type BotArchetypeTuning,
  type BotObjectiveKind,
  type BotPickupKind,
  type BotVisualIdentity,
} from './BotArchetypes';

type BotAsset = { scene: THREE.Group; animations: THREE.AnimationClip[] };

const BOT_MODEL_URL = assetUrl('assets/models/quaternius-swat.glb');
// The authored SWAT mesh measures roughly 1.84 x 0.88 world units. It needs a
// dedicated capsule; the smaller qfusion player hull lets shoulders and the
// head visibly enter walls and ceilings even when physics resolves correctly.
const BOT_COLLIDER_HEIGHT = 1.82;
const BOT_COLLIDER_RADIUS = 0.43;
const BOT_EYE_HEIGHT = 1.5;
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
const CLOSE_WEAPONS = ['shotgun', 'plasma', 'machine'] as const;
const SHORT_WEAPONS = ['plasma', 'disc', 'laser', 'shotgun', 'machine'] as const;
const MID_WEAPONS = ['disc', 'rocket', 'laser', 'plasma', 'machine'] as const;
const FAR_WEAPONS = ['sniper', 'rail', 'machine'] as const;
const EXTREME_WEAPONS = ['rail', 'sniper', 'machine'] as const;
const BLIND_WEAPONS = ['rocket', 'machine'] as const;
const botAssetPromise: Promise<BotAsset> = new Promise((resolve, reject) => {
  new GLTFLoader().load(
    BOT_MODEL_URL,
    (gltf) => resolve({ scene: gltf.scene, animations: gltf.animations }),
    undefined,
    reject,
  );
});

export class Bot {
  readonly group = new THREE.Group();
  readonly velocity = new THREE.Vector3();
  readonly aimDirection = new THREE.Vector3(0, 0, -1);
  readonly archetype: BotArchetypeId;
  readonly displayName: string;
  readonly visualIdentity: BotVisualIdentity;
  readonly archetypeTuning: BotArchetypeTuning;
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
  movementLocked = false;
  modelReady = false;
  modelHeight = 0;
  modelCenterY = 0;
  modelWidth = 0;
  modelDepth = 0;
  modelCenterX = 0;
  modelCenterZ = 0;
  modelMeshCount = 0;
  renderedMeshCount = 0;
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
  wallContacts = 0;
  ceilingContacts = 0;
  targetOwner: 'player' | number | null = null;
  stalledFor = 0;
  damageBoost = 0;
  speedBoost = 0;
  jetpackActive = false;
  jetpackBursts = 0;

  private tacticalTimer = 0;
  private fireCooldown = 0;
  private reactionTimer: number;
  private targetVisibleFor = 0;
  private readonly wishDirection = new THREE.Vector3(0, 0, -1);
  private avoidTimer = 0;
  private jumpCooldown = 0;
  private grenadeAmmo = 3;
  private grenadeCooldown = 0;
  private grappleCooldown = 0;
  private stuckTimer = 0;
  private jetpackTimer = 0;
  private jetpackCooldown = 0;
  private recoveryRequested = false;
  private readonly availableWeapons = new Set<WeaponId>(['machine', 'shotgun']);
  private readonly progressAnchor = new THREE.Vector3();
  private navigationStallTimer = 0;
  // Fixed-step bot simulation runs at 120 Hz. Keep mutable scratch state on
  // each bot so movement, collision, and navigation do not fill the young
  // generation with short-lived Vector3 instances when actor count rises.
  private readonly floorNormal = new THREE.Vector3(0, 1, 0);
  private readonly scratchToTarget = new THREE.Vector3();
  private readonly scratchBotEye = new THREE.Vector3();
  private readonly scratchDirectionA = new THREE.Vector3();
  private readonly scratchDirectionB = new THREE.Vector3();
  private readonly scratchSegmentEnd = new THREE.Vector3();
  private readonly scratchDesired = new THREE.Vector3();
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
  private readonly awarenessDot: number;
  private readonly grappleMinDistance: number;
  private readonly grenadeCooldownDuration: number;
  private readonly strafeScale: number;
  private readonly wishSpeedBase: number;
  private readonly chaseDistance: number;
  private readonly jumpSpeedThreshold: number;
  private readonly jumpCooldownDuration: number;
  private readonly jetpackBurstDuration: number;
  private readonly jetpackCooldownDuration: number;
  private readonly grappleCooldownDuration: number;
  private readonly aimErrorRadians: number;
  private mixer?: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private activeAnimation = '';
  private disposed = false;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly renderedMeshes = new Set<string>();
  private readonly bindPoseDebug = new URLSearchParams(window.location.search).has('bindPose');
  private readonly jetpackRig: JetpackRig;

  constructor(readonly id: number, color: number, spawn: THREE.Vector3, private readonly arena: ArenaRuntime) {
    this.archetypeTuning = botArchetypeForId(id);
    this.archetype = this.archetypeTuning.id;
    this.displayName = this.archetypeTuning.callsign;
    this.visualIdentity = this.archetypeTuning.visual;
    const movementTuning = this.archetypeTuning.movement;
    this.awarenessDot = THREE.MathUtils.lerp(0.02, -0.26, this.archetypeTuning.aggression);
    this.grappleMinDistance = THREE.MathUtils.lerp(19, 9, movementTuning.grappleTendency);
    this.grenadeCooldownDuration = THREE.MathUtils.lerp(5.4, 4.35, this.archetypeTuning.aggression);
    this.strafeScale = THREE.MathUtils.lerp(0.72, 1.24, movementTuning.strafeTendency);
    this.wishSpeedBase = 14.4 * movementTuning.speedScale;
    this.chaseDistance = THREE.MathUtils.clamp(
      24 * botObjectiveUtility(this.archetypeTuning, 'player')
        / Math.max(0.35, botObjectiveUtility(this.archetypeTuning, 'core')),
      15,
      34,
    );
    this.jumpSpeedThreshold = THREE.MathUtils.lerp(8.2, 5.6, movementTuning.jumpTendency);
    this.jumpCooldownDuration = THREE.MathUtils.lerp(0.24, 0.12, movementTuning.jumpTendency);
    this.jetpackBurstDuration = THREE.MathUtils.lerp(0.46, 0.72, movementTuning.jetpackTendency);
    this.jetpackCooldownDuration = THREE.MathUtils.lerp(1.48, 0.98, movementTuning.jetpackTendency);
    this.grappleCooldownDuration = THREE.MathUtils.lerp(1.55, 0.95, movementTuning.grappleTendency);
    this.aimErrorRadians = THREE.MathUtils.degToRad(
      THREE.MathUtils.lerp(1.05, 0.52, this.archetypeTuning.aggression),
    );
    this.weapon = (['machine', 'rocket', 'plasma'] as WeaponId[])[id % 3];
    this.availableWeapons.add(this.weapon);
    if (id === 0) this.availableWeapons.add('sniper');
    if (id === 2) this.availableWeapons.add('laser');
    this.reactionTimer = this.archetypeTuning.reactionSeconds;
    this.group.userData.archetype = this.archetype;
    this.group.userData.displayName = this.displayName;
    this.group.userData.visualIdentity = this.visualIdentity;
    this.group.userData.floorNormal = this.floorNormal;
    this.createModel(color);
    this.jetpackRig = new JetpackRig({ color });
    this.group.add(this.jetpackRig.root);
    void this.installAuthoredModel(color);
    this.respawn(spawn);
  }

  update(delta: number, elapsed: number, target: THREE.Vector3, objective: THREE.Vector3, hasTargetLineOfSight: boolean): void {
    this.wantsToFire = false;
    this.wantsToThrowGrenade = false;
    if (!this.alive) {
      this.jetpackActive = false;
      this.jetpackRig.update(false, delta, elapsed, false);
      this.respawnTimer -= delta;
      this.group.rotation.z += delta * 2.5;
      return;
    }

    this.fireCooldown = Math.max(0, this.fireCooldown - delta);
    this.jumpCooldown = Math.max(0, this.jumpCooldown - delta);
    this.grenadeCooldown = Math.max(0, this.grenadeCooldown - delta);
    this.grappleCooldown = Math.max(0, this.grappleCooldown - delta);
    this.jetpackCooldown = Math.max(0, this.jetpackCooldown - delta);
    this.jetpackTimer = Math.max(0, this.jetpackTimer - delta);
    this.damageBoost = Math.max(0, this.damageBoost - delta);
    this.speedBoost = Math.max(0, this.speedBoost - delta);
    this.tacticalTimer -= delta;
    const toTarget = this.scratchToTarget.subVectors(target, this.group.position);
    const targetDistanceSq = toTarget.lengthSq();
    const distance = Math.sqrt(targetDistanceSq);
    const targetFlatLengthSq = toTarget.x * toTarget.x + toTarget.z * toTarget.z;
    const facingFlatLengthSq = this.aimDirection.x * this.aimDirection.x
      + this.aimDirection.z * this.aimDirection.z;
    const targetFlatScale = targetFlatLengthSq > 0.001 ? 1 / Math.sqrt(targetFlatLengthSq) : 1;
    const facingFlatScale = facingFlatLengthSq > 0.001 ? 1 / Math.sqrt(facingFlatLengthSq) : 1;
    this.facingDot = (this.aimDirection.x * facingFlatScale) * (toTarget.x * targetFlatScale)
      + (this.aimDirection.z * facingFlatScale) * (toTarget.z * targetFlatScale);
    // A clear BSP trace is necessary but not sufficient: bots only acquire a
    // target inside their forward 142-degree awareness cone.
    const visible = distance < 155 && hasTargetLineOfSight && this.facingDot > this.awarenessDot;
    this.targetVisible = visible;
    this.targetVisibleFor = visible ? this.targetVisibleFor + delta : 0;
    this.navigationTarget.copy(objective);
    this.avoidTimer = Math.max(0, this.avoidTimer - delta);
    this.chooseWeapon(distance, visible);

    if (this.movementLocked) {
      this.jetpackActive = false;
      this.jetpackRig.update(false, delta, elapsed, false);
      this.velocity.set(0, 0, 0);
      if (visible && targetDistanceSq > 0.001) {
        this.aimDirection.copy(toTarget).normalize();
        this.group.rotation.y = Math.atan2(this.aimDirection.x, this.aimDirection.z);
      }
      if (visible && this.targetVisibleFor >= this.reactionTimer && this.fireCooldown <= 0) {
        this.wantsToFire = true;
        this.shotsFired += 1;
        this.fireCooldown = this.weaponCooldownForCurrentWeapon();
      }
      this.group.userData.speed = 0;
      this.updateAnimation(delta, 0);
      return;
    }

    if (distance > this.grappleMinDistance && !this.grappleActive && this.grappleCooldown <= 0) {
      const botEye = this.scratchBotEye.copy(this.group.position);
      botEye.y += BOT_EYE_HEIGHT;
      let grappleHit: ReturnType<ArenaRuntime['segmentHitDetails']> = null;
      for (let hookIndex = 0; hookIndex < 3; hookIndex += 1) {
        const hookDirection = this.scratchDirectionA;
        if (hookIndex === 0) {
          hookDirection.copy(toTarget).normalize();
          hookDirection.y += 0.42;
          hookDirection.normalize();
        } else if (hookIndex === 1) {
          hookDirection.set(0, 1, 0);
        } else {
          hookDirection.copy(this.wishDirection);
          hookDirection.y += 0.32;
          hookDirection.normalize();
        }
        this.scratchSegmentEnd.copy(botEye).addScaledVector(hookDirection, GRAPPLE.maxLength);
        const hit = this.arena.segmentHitDetails(botEye, this.scratchSegmentEnd);
        if (!hit || hit.distance <= GRAPPLE.minLength) continue;
        grappleHit = hit;
        break;
      }
      if (grappleHit) {
        this.grappleActive = true;
        this.grappleAnchor.copy(grappleHit.point).addScaledVector(grappleHit.normal, 0.035);
        this.grappleLength = grappleHit.distance;
        this.grapplesUsed += 1;
      }
    }
    if (this.grenadeAmmo > 0 && this.grenadeCooldown <= 0 && distance > 7 && distance < 28
      && (visible || distance < 18)) {
      this.wantsToThrowGrenade = true;
      this.grenadeAmmo -= 1;
      this.grenadeCooldown = this.grenadeCooldownDuration;
      this.grenadesThrown += 1;
    }

    const horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.tacticalTimer <= 0) {
      this.tacticalTimer = 0.1;
      const chaseTarget = visible && distance < this.chaseDistance ? target : objective;
      const desired = this.scratchDesired.subVectors(chaseTarget, this.group.position).setY(0);
      if (desired.lengthSq() > 0.001) desired.normalize();
      const strafeAmount = (visible ? 0.68 : 0.23) * this.strafeScale;
      const strafe = Math.sin(elapsed * (0.82 + this.id * 0.06) + this.id * 2.1) * strafeAmount;
      const desiredX = desired.x;
      const desiredZ = desired.z;
      desired.x -= desiredZ * strafe;
      desired.z += desiredX * strafe;
      desired.normalize();
      if (this.avoidTimer > 0) {
        desired.applyAxisAngle(THREE.Object3D.DEFAULT_UP, (this.id % 2 ? -1 : 1) * 0.82);
      }
      this.selectTraversableHeading(desired);
      this.wishDirection.copy(desired);
      const wishSpeed = this.wishSpeedBase * (this.speedBoost > 0 ? 1.28 : 1);
      const currentAlong = this.velocity.x * desired.x + this.velocity.z * desired.z;
      const acceleration = this.grounded
        ? MOVEMENT.groundAcceleration
        : MOVEMENT.airAcceleration * (visible ? 3.2 : 2.4) * this.strafeScale;
      const add = Math.min(acceleration * 0.1 * wishSpeed, wishSpeed - currentAlong);
      if (add > 0) {
        this.velocity.x += desired.x * add;
        this.velocity.z += desired.z * add;
      }
      if (this.grounded && this.jumpCooldown <= 0 && (visible || horizontalSpeed > this.jumpSpeedThreshold)) {
        this.velocity.y = MOVEMENT.jumpImpulse;
        this.grounded = false;
        this.jumpCooldown = this.jumpCooldownDuration;
        this.bunnyHops += 1;
      }
    }

    if (this.grappleActive) {
      const botEye = this.scratchBotEye.copy(this.group.position);
      botEye.y += BOT_EYE_HEIGHT;
      const toAnchor = this.scratchDirectionA.subVectors(this.grappleAnchor, botEye);
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

    // Bots spend short, readable fuel bursts to recover altitude, pursue an
    // elevated objective, or arrest a dangerous fall. Their thrust uses the
    // same acceleration and rise-speed cap as the player jetpack.
    const needsVerticalRecovery = objective.y > this.group.position.y + 1.25
      || target.y > this.group.position.y + 2.4
      || this.velocity.y < -4.2
      || (this.avoidTimer > 0.2 && !this.grounded);
    if (!this.grounded && this.jetpackTimer <= 0 && this.jetpackCooldown <= 0 && needsVerticalRecovery) {
      this.jetpackTimer = this.jetpackBurstDuration;
      this.jetpackCooldown = this.jetpackCooldownDuration;
      this.jetpackBursts += 1;
    }
    this.jetpackActive = !this.grounded && this.jetpackTimer > 0;
    if (this.jetpackActive) {
      this.velocity.y = Math.min(
        MOVEMENT.jetpackMaxRiseSpeed,
        this.velocity.y + MOVEMENT.jetpackAcceleration * delta,
      );
    }

    if (this.grounded && horizontalSpeed > 0) {
      const floorNormal = this.group.userData.floorNormal as THREE.Vector3 | undefined;
      const skiing = floorNormal ? floorNormal.y < 0.965 && horizontalSpeed > 8 : false;
      const friction = Math.max(0, 1 - (skiing ? MOVEMENT.skiFriction : 1.7) * delta);
      this.velocity.x *= friction;
      this.velocity.z *= friction;
    }
    this.velocity.y -= MOVEMENT.gravity * delta;
    const speed = this.velocity.length();
    if (speed > GRAPPLE.maxSpeed) this.velocity.multiplyScalar(GRAPPLE.maxSpeed / speed);

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
        else this.avoidTimer = Math.max(this.avoidTimer, 0.48);
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
      // small outward impulse so its existing strafe plan can carry it away.
      if (this.grappleActive && (contact.wallContact || ceilingContact)) {
        const eye = this.scratchBotEye.copy(this.group.position);
        eye.y += BOT_EYE_HEIGHT;
        const ropeDirection = this.scratchDirectionA.subVectors(this.grappleAnchor, eye).normalize();
        const surfaceNormal = ceilingContact ? contact.contactNormal : contact.wallNormal;
        if (surfaceNormal.lengthSq() > 0.5 && ropeDirection.dot(surfaceNormal) < -0.22) {
          this.grappleActive = false;
          this.grappleLength = 0;
          this.grappleCooldown = this.grappleRecoveryCooldown();
          this.avoidTimer = Math.max(this.avoidTimer, 0.7);
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

    if (this.stuckTimer >= 0.42 && escapeNormal.lengthSq() > 0.25) {
      escapeNormal.normalize();
      this.grappleActive = false;
      this.grappleLength = 0;
      this.grappleCooldown = Math.max(this.grappleCooldown, this.grappleRecoveryCooldown());
      this.group.position.addScaledVector(escapeNormal, BOT_COLLIDER_RADIUS * 0.3);
      this.velocity.addScaledVector(escapeNormal, frameCeilingContact ? 3.2 : 4.4);
      if (!frameCeilingContact) this.velocity.y = Math.max(this.velocity.y, 3.4);
      this.arena.resolveCapsule(this.group.position, this.velocity, BOT_COLLIDER_RADIUS, BOT_COLLIDER_HEIGHT);
      this.avoidTimer = Math.max(this.avoidTimer, 0.9);
      this.stuckTimer = 0;
      this.collisionRecoveries += 1;
    }

    if (this.stuckTimer >= 2.4 || this.group.position.y < this.arena.killY) {
      this.recoveryRequested = true;
      this.stuckTimer = 0;
      this.stalledFor = 0;
    }

    if (visible && targetDistanceSq > 0.001) {
      this.aimDirection.copy(toTarget).normalize();
      this.aimDirection.applyAxisAngle(
        THREE.Object3D.DEFAULT_UP,
        Math.sin(elapsed * 1.7 + this.id * 3) * this.aimErrorRadians,
      );
    } else if (this.wishDirection.lengthSq() > 0.001) {
      const turn = 1 - Math.exp(-delta * 5.2);
      this.aimDirection.lerp(this.wishDirection, turn).normalize();
    }
    this.group.rotation.y = Math.atan2(this.aimDirection.x, this.aimDirection.z);

    if (visible && this.targetVisibleFor >= this.reactionTimer && this.fireCooldown <= 0) {
      this.wantsToFire = true;
      this.shotsFired += 1;
      this.fireCooldown = this.weaponCooldownForCurrentWeapon();
    }

    const resolvedHorizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.group.userData.speed = resolvedHorizontalSpeed;
    const navigationDistanceSq = this.group.position.distanceToSquared(this.navigationTarget);
    if (this.group.position.distanceToSquared(this.progressAnchor) > 2.25 * 2.25 || navigationDistanceSq < 4 * 4) {
      this.progressAnchor.copy(this.group.position);
      this.navigationStallTimer = 0;
    } else {
      this.navigationStallTimer += delta;
    }
    if (this.navigationStallTimer >= 4.25) {
      this.recoveryRequested = true;
      this.navigationStallTimer = 0;
      this.progressAnchor.copy(this.group.position);
    }
    if (this.grounded) this.jetpackActive = false;
    this.jetpackRig.update(this.jetpackActive, delta, elapsed, false);
    this.updateAnimation(delta, resolvedHorizontalSpeed);
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
      this.respawnTimer = 1.6;
      this.velocity.set(0, 5, 0);
      return true;
    }
    return false;
  }

  readyToRespawn(): boolean {
    return !this.alive && this.respawnTimer <= 0;
  }

  respawn(position: THREE.Vector3, validateSpawn = true): void {
    this.group.position.copy(validateSpawn
      ? this.arena.safeSpawnPoint(position, BOT_COLLIDER_RADIUS, BOT_COLLIDER_HEIGHT) ?? position
      : position);
    this.velocity.set(0, 0, 0);
    this.health = 100;
    this.armor = 50;
    this.alive = true;
    this.respawnTimer = 0;
    this.group.rotation.set(0, 0, 0);
    this.aimDirection.set(0, 0, -1);
    this.wishDirection.set(0, 0, -1);
    this.targetVisible = false;
    this.targetVisibleFor = 0;
    this.grappleActive = false;
    this.grappleLength = 0;
    this.grappleCooldown = 0;
    this.jetpackActive = false;
    this.jetpackTimer = 0;
    this.jetpackCooldown = 0;
    this.grenadeAmmo = 3;
    this.grenadeCooldown = 0;
    this.jumpCooldown = 0;
    this.stuckTimer = 0;
    this.stalledFor = 0;
    this.navigationStallTimer = 0;
    this.progressAnchor.copy(this.group.position);
    this.recoveryRequested = false;
    this.targetOwner = null;
    this.group.visible = true;
  }

  private chooseWeapon(distance: number, visible: boolean): void {
    let next: WeaponId = this.weapon;
    if (distance < 7.5) next = this.bestAvailableWeapon(CLOSE_WEAPONS);
    else if (distance < 18) next = this.bestAvailableWeapon(SHORT_WEAPONS);
    else if (distance < 42) next = this.bestAvailableWeapon(MID_WEAPONS);
    else if (distance > 78) next = this.bestAvailableWeapon(EXTREME_WEAPONS);
    else if (distance > 42) next = this.bestAvailableWeapon(FAR_WEAPONS);
    else if (!visible) next = this.bestAvailableWeapon(BLIND_WEAPONS);
    if (next === this.weapon) return;
    this.weapon = next;
    this.weaponSwitches += 1;
    this.fireCooldown = Math.max(this.fireCooldown, 0.18);
  }

  private bestAvailableWeapon(choices: readonly WeaponId[]): WeaponId {
    let best: WeaponId = 'machine';
    let bestUtility = Number.NEGATIVE_INFINITY;
    for (const choice of choices) {
      if (!this.availableWeapons.has(choice)) continue;
      const utility = this.getWeaponUtility(choice);
      // Array.sort is stable, so strict comparison preserves the authored
      // candidate order when two weapon roles have equal utility.
      if (utility <= bestUtility) continue;
      best = choice;
      bestUtility = utility;
    }
    return best;
  }

  get grenadesRemaining(): number {
    return this.grenadeAmmo;
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

  collectPickup(kind: 'health' | 'armor' | 'damage' | 'speed' | WeaponId): void {
    if (kind === 'health') this.health = Math.min(125, this.health + 50);
    else if (kind === 'armor') this.armor = Math.min(150, this.armor + 100);
    else if (kind === 'damage') this.damageBoost = POWERUP.duration;
    else if (kind === 'speed') this.speedBoost = POWERUP.duration;
    else {
      this.availableWeapons.add(kind);
      this.weapon = kind;
    }
  }

  consumeRecoveryRequest(): boolean {
    const requested = this.recoveryRequested;
    this.recoveryRequested = false;
    return requested;
  }

  private weaponCooldownForCurrentWeapon(): number {
    switch (this.weapon) {
      case 'shotgun': return 0.95;
      case 'rocket': return 1.05;
      case 'plasma': return 0.2;
      case 'laser': return 0.13;
      case 'sniper': return 1.2;
      case 'rail': return 1.55;
      case 'disc': return 0.78;
      default: return 0.16;
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
      const asset = await botAssetPromise;
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
            if (materialRole.includes('visor')) {
              material.color.set(0x8eeeff).lerp(teamColor, 0.22);
              material.emissive.copy(material.color).multiplyScalar(0.36);
              material.emissiveIntensity = 1.25;
            } else if (materialRole.includes('skin')) {
              material.color.offsetHSL(0, -0.04, 0.07);
              material.emissive.set(0x000000);
              material.emissiveIntensity = 0;
            } else if (materialRole.includes('black')) {
              material.color.set(0x111820).lerp(teamColor, 0.08);
              material.emissive.copy(teamColor).multiplyScalar(0.018);
              material.emissiveIntensity = 0.16;
            } else {
              material.color.set(0x3d4c57).lerp(teamColor, 0.2);
              material.emissive.copy(teamColor).multiplyScalar(0.04);
              material.emissiveIntensity = 0.32;
            }
            material.roughness = Math.max(0.28, material.roughness * 0.82);
            material.metalness = Math.min(0.78, material.metalness + 0.12);
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

      // The GLB mesh nodes already rotate their Z-up source into Y-up. Its
      // verified source positions span 0..1.85245 m after the authored x100
      // node scale, with feet at zero. Skinned Box3 reports pre-skin bounds and
      // cannot safely drive normalization for this FBX2glTF export.
      const modelScale = 1.78 / 1.85245;
      model.scale.setScalar(modelScale);
      model.position.set(0, 0, 0);
      model.name = `vector-${this.id + 1}-authored-character`;

      for (const child of [...this.group.children]) this.group.remove(child);
      this.group.add(model);
      this.addTeamHardware(color);
      this.group.add(this.jetpackRig.root);
      this.group.updateMatrixWorld(true);
      const installedBounds = new THREE.Box3().setFromObject(this.group);
      const installedSize = installedBounds.getSize(new THREE.Vector3());
      this.modelHeight = installedSize.y;
      this.modelWidth = installedSize.x;
      this.modelDepth = installedSize.z;
      const installedCenter = installedBounds.getCenter(new THREE.Vector3());
      this.modelCenterY = installedCenter.y - this.group.position.y;
      this.modelCenterX = installedCenter.x - this.group.position.x;
      this.modelCenterZ = installedCenter.z - this.group.position.z;
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

  private addTeamHardware(color: number): void {
    const accent = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 2.2,
      roughness: 0.22,
      metalness: 0.58,
    });
    accent.userData.baseEmissiveIntensity = accent.emissiveIntensity;
    this.materials.push(accent);
    const beaconGeometry = new THREE.OctahedronGeometry(0.075, 1);
    const ringGeometry = new THREE.TorusGeometry(0.42, 0.018, 6, 28);
    this.geometries.push(beaconGeometry, ringGeometry);
    const beacons = new THREE.InstancedMesh(beaconGeometry, accent, 2);
    beacons.name = 'team-beacons';
    const beaconMatrix = new THREE.Matrix4();
    for (const [index, side] of [-1, 1].entries()) {
      beaconMatrix.makeTranslation(side * 0.34, 1.46, 0.06);
      beacons.setMatrixAt(index, beaconMatrix);
    }
    beacons.instanceMatrix.needsUpdate = true;
    this.group.add(beacons);
    const identityRing = new THREE.Mesh(ringGeometry, accent);
    identityRing.position.set(0, 1.82, 0);
    identityRing.rotation.x = Math.PI / 2;
    this.group.add(identityRing);
  }

  private updateAnimation(delta: number, speed: number): void {
    if (!this.mixer || this.bindPoseDebug) return;
    const animation = !this.alive
      ? 'death'
      : this.wantsToFire
        ? 'shoot'
        : !this.grounded
          ? 'jump'
          : speed > 6
            ? 'run'
            : speed > 0.8
              ? 'walk'
              : 'idle';
    this.playAnimation(animation, 0.13);
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
    for (const material of this.materials) {
      if (!(material instanceof THREE.MeshToonMaterial || material instanceof THREE.MeshStandardMaterial)) continue;
      const base = Number(material.userData.baseEmissiveIntensity ?? material.emissiveIntensity);
      material.emissiveIntensity = Math.max(base, 1.8);
      window.setTimeout(() => {
        material.emissiveIntensity = base;
      }, 80);
    }
  }
}
