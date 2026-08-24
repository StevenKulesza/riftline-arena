import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { assetUrl } from '../assets/assetUrl';
import type { Arena } from '../game/Arena';
import { GRAPPLE, MOVEMENT, type WeaponId } from '../game/config';

type BotAsset = { scene: THREE.Group; animations: THREE.AnimationClip[] };

const BOT_MODEL_URL = assetUrl('assets/models/quaternius-swat.glb');
// The authored SWAT mesh measures roughly 1.84 x 0.88 world units. It needs a
// dedicated capsule; the smaller qfusion player hull lets shoulders and the
// head visibly enter walls and ceilings even when physics resolves correctly.
const BOT_COLLIDER_HEIGHT = 1.82;
const BOT_COLLIDER_RADIUS = 0.43;
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
  private mixer?: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private activeAnimation = '';
  private disposed = false;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly renderedMeshes = new Set<string>();
  private readonly bindPoseDebug = new URLSearchParams(window.location.search).has('bindPose');

  constructor(readonly id: number, color: number, spawn: THREE.Vector3, private readonly arena: Arena) {
    this.weapon = (['machine', 'rocket', 'plasma'] as WeaponId[])[id % 3];
    this.reactionTimer = 0.2 + id * 0.04;
    this.createModel(color);
    void this.installAuthoredModel(color);
    this.respawn(spawn);
  }

  update(delta: number, elapsed: number, target: THREE.Vector3, objective: THREE.Vector3, hasTargetLineOfSight: boolean): void {
    this.wantsToFire = false;
    this.wantsToThrowGrenade = false;
    if (!this.alive) {
      this.respawnTimer -= delta;
      this.group.rotation.z += delta * 2.5;
      return;
    }

    this.fireCooldown = Math.max(0, this.fireCooldown - delta);
    this.jumpCooldown = Math.max(0, this.jumpCooldown - delta);
    this.grenadeCooldown = Math.max(0, this.grenadeCooldown - delta);
    this.grappleCooldown = Math.max(0, this.grappleCooldown - delta);
    this.tacticalTimer -= delta;
    const toPlayer = target.clone().sub(this.group.position);
    const distance = toPlayer.length();
    const flatTargetDirection = toPlayer.clone().setY(0);
    if (flatTargetDirection.lengthSq() > 0.001) flatTargetDirection.normalize();
    const flatFacing = this.aimDirection.clone().setY(0);
    if (flatFacing.lengthSq() > 0.001) flatFacing.normalize();
    this.facingDot = flatFacing.dot(flatTargetDirection);
    // A clear BSP trace is necessary but not sufficient: bots only acquire a
    // target inside their forward 142-degree awareness cone.
    const visible = distance < 72 && hasTargetLineOfSight && this.facingDot > 0.325;
    this.targetVisible = visible;
    this.targetVisibleFor = visible ? this.targetVisibleFor + delta : 0;
    this.navigationTarget.copy(objective);
    this.avoidTimer = Math.max(0, this.avoidTimer - delta);
    this.chooseWeapon(distance, visible);

    if (this.movementLocked) {
      this.velocity.set(0, 0, 0);
      if (visible && toPlayer.lengthSq() > 0.001) {
        this.aimDirection.copy(toPlayer).normalize();
        this.group.rotation.y = Math.atan2(this.aimDirection.x, this.aimDirection.z);
      }
      if (visible && this.targetVisibleFor >= this.reactionTimer && this.fireCooldown <= 0) {
        this.wantsToFire = true;
        this.shotsFired += 1;
        this.fireCooldown = this.weapon === 'rocket' ? 1.25 : this.weapon === 'plasma' ? 0.28 : 0.18;
      }
      this.group.userData.speed = 0;
      this.updateAnimation(delta);
      return;
    }

    if (distance > 10 && !this.grappleActive && this.grappleCooldown <= 0) {
      const botEye = this.group.position.clone().add(new THREE.Vector3(0, 1.5, 0));
      const hookDirections = [
        toPlayer.clone().normalize().add(new THREE.Vector3(0, 0.42, 0)).normalize(),
        new THREE.Vector3(0, 1, 0),
        this.wishDirection.clone().add(new THREE.Vector3(0, 0.32, 0)).normalize(),
      ];
      const grappleHit = hookDirections
        .map((hookDirection) => this.arena.segmentHitDetails(botEye, botEye.clone().addScaledVector(hookDirection, GRAPPLE.maxLength)))
        .find((hit) => hit && hit.distance > GRAPPLE.minLength);
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
      this.grenadeCooldown = 4.8;
      this.grenadesThrown += 1;
    }

    const horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.tacticalTimer <= 0) {
      this.tacticalTimer = 0.1;
      const chaseTarget = visible && distance < 24 ? target : objective;
      const desired = chaseTarget.clone().sub(this.group.position).setY(0);
      if (desired.lengthSq() > 0.001) desired.normalize();
      const strafeAmount = visible ? 0.68 : 0.23;
      const strafe = new THREE.Vector3(-desired.z, 0, desired.x).multiplyScalar(
        Math.sin(elapsed * (0.82 + this.id * 0.06) + this.id * 2.1) * strafeAmount,
      );
      desired.add(strafe).normalize();
      if (this.avoidTimer > 0) {
        desired.applyAxisAngle(THREE.Object3D.DEFAULT_UP, (this.id % 2 ? -1 : 1) * 0.82);
      }
      this.wishDirection.copy(desired);
      const wishSpeed = 13 + this.id * 1.4;
      const currentAlong = this.velocity.x * desired.x + this.velocity.z * desired.z;
      const acceleration = this.grounded
        ? MOVEMENT.groundAcceleration
        : MOVEMENT.airAcceleration * (visible ? 3.2 : 2.4);
      const add = Math.min(acceleration * 0.1 * wishSpeed, wishSpeed - currentAlong);
      if (add > 0) {
        this.velocity.x += desired.x * add;
        this.velocity.z += desired.z * add;
      }
      if (this.grounded && this.jumpCooldown <= 0 && (visible || horizontalSpeed > 6.2)) {
        this.velocity.y = MOVEMENT.jumpImpulse;
        this.grounded = false;
        this.jumpCooldown = 0.12;
        this.bunnyHops += 1;
      }
    }

    if (this.grappleActive) {
      const botEye = this.group.position.clone().add(new THREE.Vector3(0, 1.5, 0));
      const toAnchor = this.grappleAnchor.clone().sub(botEye);
      const anchorDistance = toAnchor.length();
      if (anchorDistance < 0.75 || anchorDistance > GRAPPLE.maxLength * 1.35) {
        this.grappleActive = false;
        this.grappleCooldown = 1.2;
      } else {
        const ropeDirection = toAnchor.multiplyScalar(1 / anchorDistance);
        const tangent = this.wishDirection.clone().addScaledVector(ropeDirection, -this.wishDirection.dot(ropeDirection));
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
    const frameStart = this.group.position.clone();
    const expectedHorizontalDistance = Math.hypot(this.velocity.x, this.velocity.z) * delta;
    const movementSteps = Math.max(1, Math.ceil(this.velocity.length() * delta / MOVEMENT.maxSubstepDistance));
    const subDelta = delta / movementSteps;
    let frameWallContact = false;
    let frameCeilingContact = false;
    const escapeNormal = new THREE.Vector3();

    for (let movementStep = 0; movementStep < movementSteps; movementStep += 1) {
      const startPosition = this.group.position.clone();
      const startVelocity = this.velocity.clone();
      const wasGrounded = this.grounded;
      this.group.position.addScaledVector(this.velocity, subDelta);
      const blockedPosition = this.group.position.clone();
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
      this.group.userData.floorNormal = contact.contactNormal.clone();

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
        const eye = this.group.position.clone().add(new THREE.Vector3(0, 1.5, 0));
        const ropeDirection = this.grappleAnchor.clone().sub(eye).normalize();
        const surfaceNormal = ceilingContact ? contact.contactNormal : contact.wallNormal;
        if (surfaceNormal.lengthSq() > 0.5 && ropeDirection.dot(surfaceNormal) < -0.22) {
          this.grappleActive = false;
          this.grappleLength = 0;
          this.grappleCooldown = 1.2;
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
    if ((frameWallContact || frameCeilingContact) && lowProgress) this.stuckTimer += delta;
    else this.stuckTimer = Math.max(0, this.stuckTimer - delta * 2.5);

    if (this.stuckTimer >= 0.42 && escapeNormal.lengthSq() > 0.25) {
      escapeNormal.normalize();
      this.grappleActive = false;
      this.grappleLength = 0;
      this.grappleCooldown = Math.max(this.grappleCooldown, 1.2);
      this.group.position.addScaledVector(escapeNormal, BOT_COLLIDER_RADIUS * 0.3);
      this.velocity.addScaledVector(escapeNormal, frameCeilingContact ? 3.2 : 4.4);
      if (!frameCeilingContact) this.velocity.y = Math.max(this.velocity.y, 3.4);
      this.arena.resolveCapsule(this.group.position, this.velocity, BOT_COLLIDER_RADIUS, BOT_COLLIDER_HEIGHT);
      this.avoidTimer = Math.max(this.avoidTimer, 0.9);
      this.stuckTimer = 0;
      this.collisionRecoveries += 1;
    }

    if (visible && toPlayer.lengthSq() > 0.001) {
      const aimError = THREE.MathUtils.degToRad(1.5 + this.id * 0.55);
      this.aimDirection.copy(toPlayer).normalize();
      this.aimDirection.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.sin(elapsed * 1.7 + this.id * 3) * aimError);
    } else if (this.wishDirection.lengthSq() > 0.001) {
      const turn = 1 - Math.exp(-delta * 5.2);
      this.aimDirection.lerp(this.wishDirection, turn).normalize();
    }
    this.group.rotation.y = Math.atan2(this.aimDirection.x, this.aimDirection.z);

    if (visible && this.targetVisibleFor >= this.reactionTimer && this.fireCooldown <= 0) {
      this.wantsToFire = true;
      this.shotsFired += 1;
      this.fireCooldown = this.weapon === 'rocket' ? 1.25 : this.weapon === 'plasma' ? 0.28 : 0.18;
    }

    this.group.userData.speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.updateAnimation(delta);
  }

  private tryStepMove(
    startPosition: THREE.Vector3,
    startVelocity: THREE.Vector3,
    blockedPosition: THREE.Vector3,
    delta: number,
  ): ReturnType<Arena['resolveCapsule']> | null {
    const intendedDistance = Math.hypot(startVelocity.x, startVelocity.z) * delta;
    if (intendedDistance < 0.0001) return null;
    const blockedDistance = Math.hypot(blockedPosition.x - startPosition.x, blockedPosition.z - startPosition.z);
    const stepPosition = startPosition.clone().add(new THREE.Vector3(0, MOVEMENT.stepHeight, 0));
    const stepVelocity = startVelocity.clone().setY(0);
    this.arena.resolveCapsule(stepPosition, stepVelocity, BOT_COLLIDER_RADIUS, BOT_COLLIDER_HEIGHT);
    if (stepPosition.y < startPosition.y + MOVEMENT.stepHeight * 0.72) return null;
    stepPosition.x += stepVelocity.x * delta;
    stepPosition.z += stepVelocity.z * delta;
    this.arena.resolveCapsule(stepPosition, stepVelocity, BOT_COLLIDER_RADIUS, BOT_COLLIDER_HEIGHT);
    const direction = new THREE.Vector3(startVelocity.x, 0, startVelocity.z).normalize();
    const offsets = [0, BOT_COLLIDER_RADIUS * 0.34, BOT_COLLIDER_RADIUS * 0.68, BOT_COLLIDER_RADIUS + 0.035];
    const floors = offsets
      .map((offset) => this.arena.floorHeightAt(
        stepPosition.x + direction.x * offset,
        stepPosition.z + direction.z * offset,
        stepPosition.y + 0.08,
      ))
      .filter((height): height is number => height !== null)
      .filter((height) => height >= startPosition.y - MOVEMENT.groundSnapDistance - 0.02
        && height <= startPosition.y + MOVEMENT.stepHeight + 0.04);
    const rising = floors.filter((height) => height > startPosition.y + 0.015).sort((a, b) => a - b);
    const floor = rising[0] ?? floors.sort((a, b) => Math.abs(a - startPosition.y) - Math.abs(b - startPosition.y))[0];
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

  respawn(position: THREE.Vector3): void {
    this.group.position.copy(position);
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
    this.grenadeAmmo = 3;
    this.grenadeCooldown = 0;
    this.jumpCooldown = 0;
    this.stuckTimer = 0;
    this.group.visible = true;
  }

  private chooseWeapon(distance: number, visible: boolean): void {
    let next: WeaponId = this.weapon;
    if (distance < 8.5) next = 'plasma';
    else if (distance > 34) next = 'machine';
    else if (distance > 17) next = 'rocket';
    else if (!visible && this.id === 1) next = 'rocket';
    if (next === this.weapon) return;
    this.weapon = next;
    this.weaponSwitches += 1;
    this.fireCooldown = Math.max(this.fireCooldown, 0.18);
  }

  get grenadesRemaining(): number {
    return this.grenadeAmmo;
  }

  dispose(): void {
    this.disposed = true;
    this.mixer?.stopAllAction();
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

  private updateAnimation(delta: number): void {
    if (!this.mixer || this.bindPoseDebug) return;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
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
    const entry = [...this.actions].find(([key]) => key.endsWith(`|${name}`))
      ?? [...this.actions].find(([key]) => key.includes(name));
    if (!entry) return;
    const previous = this.activeAnimation
      ? [...this.actions].find(([key]) => key.includes(this.activeAnimation))?.[1]
      : undefined;
    const next = entry[1];
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
