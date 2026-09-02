import * as THREE from 'three';
import { cloneScifiDroneScene, loadScifiDroneAsset } from '../assets/ScifiDroneAsset';
import { BusterDroneVisual, type BusterVisualFlightState } from '../entities/BusterDroneVisual';
import type { ArenaRuntime } from '../game/Arena';
import { DroneSentinelBeamVfx } from './DroneSentinelBeamVfx';
import { droneCanAcquire, SENTINEL_AWARENESS, BUSTER_AWARENESS } from './DroneAwareness';

export const DRONE_TUNING = Object.freeze({
  count: 3,
  maxHealth: 225,
  collisionRadius: 1.7,
  patrolSpeed: 14,
  combatSpeed: 21,
  acceleration: 24,
  minimumClearance: 6.2,
  ...SENTINEL_AWARENESS,
  fireRange: 36,
  laserDps: 18,
  laserDamageTickSeconds: 0.1,
  targetRadiusPlayer: 0.58,
  targetRadiusBot: 0.62,
  respawnSeconds: 18,
  visualDiameter: 3.4,
});

export const BUSTER_DRONE_TUNING = Object.freeze({
  count: 2,
  maxHealth: DRONE_TUNING.maxHealth * 1.5,
  collisionRadius: 2.45,
  landedCenterHeight: 1.74,
  takeoffSpoolSeconds: 1.75,
  takeoffSeconds: 3.8,
  landingIdleSeconds: 4.5,
  noTargetLandingSeconds: 12,
  criticalLandingHealthRatio: 0.32,
  flightClearance: 13.5,
  surveySpeed: 12.5,
  attackRunSpeed: 29,
  breakawaySpeed: 34,
  acceleration: 18,
  ...BUSTER_AWARENESS,
  fireRange: 42,
  gazeDegrees: 8,
  shardSpeed: 68,
  shardHomingResponsiveness: 5.5,
  shardDamage: 17,
  shardLifeSeconds: 2.25,
  shardRadius: 0.2,
  burstCount: 3,
  burstSpacingSeconds: 0.16,
  burstCooldownSeconds: 1.85,
  respawnSeconds: 22,
  deploymentDamageMultiplier: 0.25,
});

export type DroneTargetOwner = 'player' | number;

export type DroneTargetSnapshot = {
  owner: DroneTargetOwner;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  alive: boolean;
};

export type DroneLaserEvent = Readonly<{
  droneId: string;
  targetOwner: DroneTargetOwner;
  origin: THREE.Vector3;
  hitPoint: THREE.Vector3;
  damage: number;
  started: boolean;
}>;

export type BusterShardEvent = Readonly<{
  droneId: string;
  targetOwner: DroneTargetOwner | null;
  origin: THREE.Vector3;
  hitPoint: THREE.Vector3;
  damage: number;
  worldImpact: boolean;
}>;

export type CombatDroneKind = 'sentinel' | 'buster';
export type CombatDroneState =
  | 'patrol'
  | 'engage'
  | 'evade'
  | BusterVisualFlightState;

export type DroneRayHit = {
  drone: CombatDroneRuntime;
  point: THREE.Vector3;
  distance: number;
};

export type DroneDamageResult = Readonly<{
  applied: boolean;
  destroyed: boolean;
  position: THREE.Vector3;
}>;

const MODEL_FORWARD = new THREE.Vector3(0, 0, 1);
const COLLISION_OFFSETS = [
  new THREE.Vector3(),
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1),
] as const;

class CombatDroneVisual {
  readonly root = new THREE.Group();
  readonly ready: Promise<void>;
  isReady = false;
  loadError: Error | null = null;
  modelMeshCount = 0;
  modelWidth = 0;
  modelHeight = 0;
  modelDepth = 0;

  private readonly modelMount = new THREE.Group();
  private readonly muzzleLeft = new THREE.Object3D();
  private readonly muzzleRight = new THREE.Object3D();
  private readonly beamEmitter = new THREE.Object3D();
  private readonly beamVfx: DroneSentinelBeamVfx;
  private readonly beamStartLocal = new THREE.Vector3();
  private readonly beamEndLocal = new THREE.Vector3();
  private readonly ownedMaterials: THREE.Material[] = [];
  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private fallback: THREE.Object3D | null = null;

  constructor(readonly id: string) {
    this.root.name = `${id}-combat-drone`;
    this.root.userData.combatDroneId = id;
    this.modelMount.name = `${id}-authored-model-mount`;
    this.root.add(this.modelMount);
    this.installFallback();
    this.installCombatLights();
    this.beamVfx = new DroneSentinelBeamVfx(id);
    this.root.add(this.beamVfx.root);
    this.ready = this.installAuthoredModel();
  }

  beamOriginWorld(target: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    this.beamEmitter.updateWorldMatrix(true, false);
    this.beamEmitter.getWorldPosition(out);
    const towardTarget = target.clone().sub(out);
    if (towardTarget.lengthSq() > 1e-6) out.addScaledVector(towardTarget.normalize(), 0.05);
    return out;
  }

  updateContinuousBeam(startWorld: THREE.Vector3, endWorld: THREE.Vector3, phase: number): void {
    this.root.updateWorldMatrix(true, false);
    this.beamStartLocal.copy(startWorld);
    this.beamEndLocal.copy(endWorld);
    this.root.worldToLocal(this.beamStartLocal);
    this.root.worldToLocal(this.beamEndLocal);
    this.beamVfx.update(this.beamStartLocal, this.beamEndLocal, phase);
  }

  stopContinuousBeam(): void {
    this.beamVfx.stop();
  }

  get continuousBeamVisible(): boolean {
    return this.beamVfx.visible;
  }

  get continuousBeamLayerCount(): number {
    return this.beamVfx.layerCount;
  }

  get continuousBeamHaloCount(): number {
    return this.beamVfx.haloCount;
  }

  get continuousBeamParticleCount(): number {
    return this.beamVfx.particleCount;
  }

  readonly rigNodeCount = 0;
  readonly animationClipName = '';
  readonly animationClipDuration = 0;
  readonly animationTime = 0;
  readonly animationPlaying = false;

  updateAnimation(_delta: number, _state: BusterVisualFlightState, _targetDirection?: THREE.Vector3): void {
    // Sentinel drones have no authored animation clip.
  }

  resetTakeoffAnimation(): void {
    // Sentinel drones spawn airborne.
  }

  startLandingAnimation(): void {
    // Sentinel drones do not land.
  }

  face(direction: THREE.Vector3, delta: number): void {
    if (direction.lengthSq() <= 0.01) return;
    const desired = new THREE.Quaternion().setFromUnitVectors(MODEL_FORWARD, direction.clone().normalize());
    this.root.quaternion.slerp(desired, 1 - Math.exp(-delta * 5.5));
  }

  dispose(): void {
    this.beamVfx.dispose();
    for (const material of this.ownedMaterials) material.dispose();
    for (const geometry of this.ownedGeometries) geometry.dispose();
    this.root.removeFromParent();
  }

  private installFallback(): void {
    const geometry = new THREE.IcosahedronGeometry(DRONE_TUNING.collisionRadius * 0.82, 1);
    const material = new THREE.MeshStandardMaterial({
      color: 0x253340,
      metalness: 0.8,
      roughness: 0.34,
      emissive: 0xff384f,
      emissiveIntensity: 0.22,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${this.id}-loading-fallback`;
    mesh.castShadow = true;
    this.modelMount.add(mesh);
    this.ownedGeometries.push(geometry);
    this.ownedMaterials.push(material);
    this.fallback = mesh;
  }

  private installCombatLights(): void {
    const geometry = new THREE.SphereGeometry(0.09, 10, 8);
    const material = new THREE.MeshBasicMaterial({ color: 0xff2e54, toneMapped: false });
    this.ownedGeometries.push(geometry);
    this.ownedMaterials.push(material);
    for (const [index, muzzle] of [this.muzzleLeft, this.muzzleRight].entries()) {
      muzzle.name = `${this.id}-laser-muzzle-${index}`;
      muzzle.position.set(index === 0 ? -0.36 : 0.36, -0.12, DRONE_TUNING.collisionRadius * 0.9);
      const glow = new THREE.Mesh(geometry, material);
      glow.scale.set(1, 1, 1.8);
      muzzle.add(glow);
      this.root.add(muzzle);
    }
    this.beamEmitter.name = `${this.id}-continuous-laser-emitter`;
    this.beamEmitter.position.set(0, -0.12, DRONE_TUNING.collisionRadius * 0.9);
    this.root.add(this.beamEmitter);
  }

  private async installAuthoredModel(): Promise<void> {
    try {
      const asset = await loadScifiDroneAsset();
      const model = cloneScifiDroneScene(asset);
      model.name = `${this.id}-authored-scifi-drone`;
      model.updateMatrixWorld(true);
      const sourceBounds = new THREE.Box3().setFromObject(model);
      const sourceSize = sourceBounds.getSize(new THREE.Vector3());
      const maxDimension = Math.max(sourceSize.x, sourceSize.y, sourceSize.z);
      if (!Number.isFinite(maxDimension) || maxDimension <= 0) {
        throw new Error('Scifi drone GLB has no renderable bounds.');
      }
      const center = sourceBounds.getCenter(new THREE.Vector3());
      const modelScale = DRONE_TUNING.visualDiameter / maxDimension;
      model.scale.setScalar(modelScale);
      model.position.copy(center).multiplyScalar(-modelScale);
      model.updateMatrixWorld(true);
      const eyeBounds = new THREE.Box3();
      let eyeLocated = false;
      model.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
        const materials = sourceMaterials.map((source) => {
          const material = source.clone();
          if (material instanceof THREE.MeshStandardMaterial) {
            material.envMapIntensity = Math.max(1.05, material.envMapIntensity);
            if (material.name.toLowerCase().includes('lense')) {
              material.emissive.set(0xff183f);
              material.emissiveIntensity = 1.35;
            }
          }
          this.ownedMaterials.push(material);
          return material;
        });
        object.material = Array.isArray(object.material) ? materials : materials[0];
        if (materials.some((material) => material.name.toLowerCase().includes('lense'))) {
          object.updateWorldMatrix(true, false);
          eyeBounds.expandByObject(object);
          eyeLocated = true;
        }
        object.castShadow = true;
        object.receiveShadow = true;
        object.frustumCulled = false;
        this.modelMeshCount += 1;
      });
      if (this.fallback) {
        this.fallback.removeFromParent();
        this.fallback = null;
      }
      this.modelMount.add(model);
      if (eyeLocated) {
        eyeBounds.getCenter(this.beamEmitter.position);
        this.beamEmitter.position.addScaledVector(MODEL_FORWARD, 0.08);
      }
      this.root.updateMatrixWorld(true);
      const installed = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
      this.modelWidth = installed.x;
      this.modelHeight = installed.y;
      this.modelDepth = installed.z;
      this.isReady = true;
    } catch (error) {
      this.loadError = error instanceof Error ? error : new Error(String(error));
      this.isReady = false;
    }
  }
}

export class CombatDroneRuntime {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly spawnPosition = new THREE.Vector3();
  readonly patrolCenter = new THREE.Vector3();
  readonly visual: CombatDroneVisual | BusterDroneVisual;
  readonly collisionRadius: number;
  readonly maxHealth: number;
  health: number;
  alive = true;
  respawnSeconds = 0;
  targetOwner: DroneTargetOwner | null = null;
  state: CombatDroneState = 'patrol';
  flightPattern: 'sentinel-orbit' | 'figure-eight' | 'vertical-sweep' | 'pincer' = 'sentinel-orbit';
  shotsFired = 0;
  explosions = 0;
  respawns = 0;
  collisionHits = 0;
  beamActive = false;
  beamUptimeSeconds = 0;
  beamDamageTicks = 0;
  beamMissTicks = 0;
  beamDamageAccumulator = 0;
  beamStartPending = false;
  beamOnTarget = false;
  aimErrorDegrees = 0;
  acquireCooldown = 0;
  evadeSeconds = 0;
  stateElapsed = 0;
  takeoffElapsed = 0;
  fireCooldown = 0;
  burstRemaining = 0;
  gazeDot = -1;
  gazeThreshold = Math.cos(THREE.MathUtils.degToRad(BUSTER_DRONE_TUNING.gazeDegrees));
  lookingAtTarget = false;
  shardsFired = 0;
  shardHits = 0;
  shardWorldImpacts = 0;
  takeoffs = 0;
  landings = 0;
  targetLostSeconds = 0;

  constructor(
    readonly id: string,
    readonly index: number,
    readonly kind: CombatDroneKind = 'sentinel',
  ) {
    this.visual = kind === 'buster' ? new BusterDroneVisual(id) : new CombatDroneVisual(id);
    this.collisionRadius = kind === 'buster'
      ? BUSTER_DRONE_TUNING.collisionRadius
      : DRONE_TUNING.collisionRadius;
    this.maxHealth = kind === 'buster' ? BUSTER_DRONE_TUNING.maxHealth : DRONE_TUNING.maxHealth;
    this.health = this.maxHealth;
    if (kind === 'buster') {
      this.state = 'spool';
      this.flightPattern = index === 0 ? 'figure-eight' : 'vertical-sweep';
    }
  }
}

type BusterShardProjectile = {
  root: THREE.Group;
  origin: THREE.Vector3;
  velocity: THREE.Vector3;
  sourceId: string;
  targetOwner: DroneTargetOwner;
  life: number;
  active: boolean;
};

export class DroneSwarmSystem {
  readonly drones: CombatDroneRuntime[] = [];
  readonly busterDrones: CombatDroneRuntime[] = [];
  readonly combatDrones: CombatDroneRuntime[] = [];
  readonly ready: Promise<void>;
  readonly shardPoolSize = 36;
  activeShardCount = 0;
  readonly lastShardOrigin = new THREE.Vector3();
  readonly lastShardImpact = new THREE.Vector3();
  lastShardSourceId = '';
  lastShardTargetOwner: DroneTargetOwner | null = null;
  lastShardWorldImpact = false;
  private readonly ray = new THREE.Ray();
  private readonly sphere = new THREE.Sphere();
  private readonly hitPoint = new THREE.Vector3();
  private readonly desiredPoint = new THREE.Vector3();
  private readonly desiredVelocity = new THREE.Vector3();
  private readonly steering = new THREE.Vector3();
  private readonly separation = new THREE.Vector3();
  private readonly intendedPosition = new THREE.Vector3();
  private readonly collisionStart = new THREE.Vector3();
  private readonly collisionEnd = new THREE.Vector3();
  private readonly muzzlePosition = new THREE.Vector3();
  private readonly laserTargetCenter = new THREE.Vector3();
  private readonly laserTargetPoint = new THREE.Vector3();
  private readonly laserVisualEnd = new THREE.Vector3();
  private readonly laserAimDirection = new THREE.Vector3();
  private readonly laserAimRight = new THREE.Vector3();
  private readonly laserAimUp = new THREE.Vector3();
  private readonly laserRayEnd = new THREE.Vector3();
  private readonly busterAimPoint = new THREE.Vector3();
  private readonly busterAimDirection = new THREE.Vector3();
  private readonly busterForward = new THREE.Vector3();
  private readonly busterAway = new THREE.Vector3();
  private readonly busterLateral = new THREE.Vector3();
  private readonly shardPrevious = new THREE.Vector3();
  private readonly shardNext = new THREE.Vector3();
  private readonly shardSegment = new THREE.Vector3();
  private readonly shardToTarget = new THREE.Vector3();
  private readonly shardImpact = new THREE.Vector3();
  private readonly shardHeading = new THREE.Vector3();
  private readonly shardDesiredHeading = new THREE.Vector3();
  private readonly awarenessFacing = new THREE.Vector3();
  private readonly awarenessToTarget = new THREE.Vector3();
  private readonly shardRoot = new THREE.Group();
  private readonly shardGeometry = new THREE.OctahedronGeometry(0.15, 0);
  private readonly shardCoreMaterial = new THREE.MeshBasicMaterial({
    color: 0xffd4dd,
    toneMapped: false,
  });
  private readonly shardGlowMaterial = new THREE.MeshBasicMaterial({
    color: 0xff123b,
    transparent: true,
    opacity: 0.62,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  private readonly shards: BusterShardProjectile[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    private readonly arena: ArenaRuntime,
  ) {
    for (let index = 0; index < DRONE_TUNING.count; index += 1) {
      const drone = new CombatDroneRuntime(`drone-${index + 1}`, index);
      this.placeSpawn(drone);
      drone.visual.root.position.copy(drone.position);
      this.scene.add(drone.visual.root);
      this.drones.push(drone);
    }
    for (let index = 0; index < BUSTER_DRONE_TUNING.count; index += 1) {
      const drone = new CombatDroneRuntime(`buster-${index + 1}`, index, 'buster');
      this.placeSpawn(drone);
      drone.visual.root.position.copy(drone.position);
      this.scene.add(drone.visual.root);
      this.busterDrones.push(drone);
    }
    this.combatDrones.push(...this.drones, ...this.busterDrones);
    this.shardRoot.name = 'buster-red-shard-projectiles';
    this.scene.add(this.shardRoot);
    this.installShardPool();
    this.ready = Promise.all(this.combatDrones.map((drone) => drone.visual.ready)).then(() => undefined);
  }

  setSeed(_seed: number): void {
    // Spawns and steering are already deterministic; retained for QA API compatibility.
  }

  update(
    delta: number,
    elapsed: number,
    targets: readonly DroneTargetSnapshot[],
    onLaser: (event: DroneLaserEvent) => void,
    onShard: (event: BusterShardEvent) => void = () => undefined,
  ): void {
    this.updateShards(delta, targets, onShard);
    for (const drone of this.combatDrones) {
      if (!drone.alive) {
        drone.respawnSeconds = Math.max(0, drone.respawnSeconds - delta);
        if (drone.respawnSeconds <= 0) this.respawn(drone);
        continue;
      }
      drone.acquireCooldown -= delta;
      drone.evadeSeconds = Math.max(0, drone.evadeSeconds - delta);
      if (drone.acquireCooldown <= 0) {
        drone.targetOwner = this.chooseTarget(drone, targets)?.owner ?? null;
        drone.acquireCooldown = 0.18 + drone.index * 0.025;
      }
      const target = drone.targetOwner === null
        ? null
        : targets.find((candidate) => candidate.owner === drone.targetOwner && candidate.alive) ?? null;
      if (drone.kind === 'buster') {
        this.updateBusterFlight(drone, target, delta, elapsed);
        this.updateBusterWeapons(drone, target, delta, elapsed);
      } else {
        this.updateFlight(drone, target, delta, elapsed);
        drone.visual.root.position.copy(drone.position);
        drone.visual.face(drone.velocity, delta);
        this.updateWeapons(drone, target, delta, onLaser);
      }
    }
  }

  nearestVisibleDrone(origin: THREE.Vector3, maxDistance: number): CombatDroneRuntime | null {
    let best: CombatDroneRuntime | null = null;
    let bestDistanceSq = maxDistance * maxDistance;
    for (const drone of this.combatDrones) {
      if (!drone.alive) continue;
      const distanceSq = origin.distanceToSquared(drone.position);
      if (distanceSq >= bestDistanceSq || !this.arena.hasLineOfSight(origin, drone.position, drone.collisionRadius * 0.4)) continue;
      best = drone;
      bestDistanceSq = distanceSq;
    }
    return best;
  }

  raycast(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number,
    extraRadius = 0,
  ): DroneRayHit | null {
    this.ray.set(origin, direction);
    let best: CombatDroneRuntime | null = null;
    let bestDistance = maxDistance;
    const bestPoint = new THREE.Vector3();
    for (const drone of this.combatDrones) {
      if (!drone.alive) continue;
      this.sphere.set(drone.position, drone.collisionRadius + extraRadius);
      const hit = this.ray.intersectSphere(this.sphere, this.hitPoint);
      if (!hit) continue;
      const distance = origin.distanceTo(hit);
      if (distance <= 0 || distance >= bestDistance) continue;
      best = drone;
      bestDistance = distance;
      bestPoint.copy(hit);
    }
    return best ? { drone: best, point: bestPoint, distance: bestDistance } : null;
  }

  raycastSegment(start: THREE.Vector3, end: THREE.Vector3, extraRadius = 0): DroneRayHit | null {
    const direction = this.desiredVelocity.subVectors(end, start);
    const distance = direction.length();
    if (distance <= 1e-7) return null;
    direction.multiplyScalar(1 / distance);
    return this.raycast(start, direction, distance, extraRadius);
  }

  damage(drone: CombatDroneRuntime, amount: number): DroneDamageResult {
    if (!drone.alive || amount <= 0) {
      return { applied: false, destroyed: false, position: drone.position.clone() };
    }
    const deploymentArmor = drone.kind === 'buster' && (drone.state === 'spool' || drone.state === 'takeoff')
      ? BUSTER_DRONE_TUNING.deploymentDamageMultiplier
      : 1;
    drone.health = Math.max(0, drone.health - amount * deploymentArmor);
    drone.evadeSeconds = Math.max(drone.evadeSeconds, 1.25);
    const destroyed = drone.health <= 0;
    if (destroyed) {
      drone.alive = false;
      drone.state = 'destroyed';
      drone.respawnSeconds = drone.kind === 'buster'
        ? BUSTER_DRONE_TUNING.respawnSeconds
        : DRONE_TUNING.respawnSeconds;
      drone.velocity.set(0, 0, 0);
      drone.visual.root.visible = false;
      drone.visual.stopContinuousBeam();
      drone.targetOwner = null;
      drone.beamActive = false;
      drone.beamDamageAccumulator = 0;
      drone.beamStartPending = false;
      drone.beamOnTarget = false;
      drone.aimErrorDegrees = 0;
      drone.explosions += 1;
    }
    return { applied: true, destroyed, position: drone.position.clone() };
  }

  damageInRadius(position: THREE.Vector3, radius: number, maxDamage: number): CombatDroneRuntime[] {
    const destroyed: CombatDroneRuntime[] = [];
    for (const drone of this.combatDrones) {
      if (!drone.alive) continue;
      const distance = drone.position.distanceTo(position);
      if (distance >= radius || !this.arena.hasLineOfSight(position, drone.position, drone.collisionRadius * 0.4)) continue;
      const falloff = THREE.MathUtils.clamp(1 - distance / radius, 0, 1);
      if (this.damage(drone, maxDamage * (falloff * 0.3 + falloff * falloff * 0.7)).destroyed) destroyed.push(drone);
    }
    return destroyed;
  }

  resetForQa(center: THREE.Vector3, lookAt?: THREE.Vector3): void {
    const facePoint = lookAt ?? center;
    for (const drone of this.drones) {
      const angle = drone.index / this.drones.length * Math.PI * 2;
      drone.position.copy(center).add(new THREE.Vector3(Math.cos(angle) * 8, 5.5 + drone.index, Math.sin(angle) * 8));
      drone.velocity.copy(facePoint).sub(drone.position).setY(0);
      if (drone.velocity.lengthSq() < 0.01) drone.velocity.set(0, 0, 4);
      else drone.velocity.normalize().multiplyScalar(4);
      drone.health = DRONE_TUNING.maxHealth;
      drone.alive = true;
      drone.respawnSeconds = 0;
      drone.beamActive = false;
      drone.beamUptimeSeconds = 0;
      drone.beamDamageTicks = 0;
      drone.beamMissTicks = 0;
      drone.beamDamageAccumulator = 0;
      drone.beamStartPending = false;
      drone.beamOnTarget = false;
      drone.aimErrorDegrees = 0;
      drone.targetOwner = null;
      drone.state = 'patrol';
      drone.visual.root.visible = true;
      drone.visual.root.position.copy(drone.position);
      drone.visual.face(drone.velocity, 8);
      drone.visual.stopContinuousBeam();
    }
  }

  resetBustersForQa(center: THREE.Vector3): void {
    for (const drone of this.busterDrones) {
      const angle = drone.index / Math.max(1, this.busterDrones.length) * Math.PI * 2;
      const spawnX = center.x + Math.cos(angle) * 4.8;
      const spawnZ = center.z + Math.sin(angle) * 4.8;
      const floor = this.arena.floorHeightAt(spawnX, spawnZ, center.y + 30) ?? center.y;
      drone.spawnPosition.set(spawnX, floor + BUSTER_DRONE_TUNING.landedCenterHeight, spawnZ);
      drone.patrolCenter.copy(center).setY(floor + BUSTER_DRONE_TUNING.flightClearance);
      drone.position.copy(drone.spawnPosition);
      drone.velocity.set(0, 0, 0);
      drone.health = drone.maxHealth;
      drone.alive = true;
      drone.respawnSeconds = 0;
      drone.targetOwner = null;
      drone.state = 'spool';
      drone.stateElapsed = 0;
      drone.takeoffElapsed = 0;
      drone.targetLostSeconds = 0;
      drone.acquireCooldown = 0;
      drone.evadeSeconds = 0;
      drone.fireCooldown = 0;
      drone.burstRemaining = 0;
      drone.gazeDot = -1;
      drone.lookingAtTarget = false;
      drone.visual.root.visible = true;
      drone.visual.root.position.copy(drone.position);
      drone.visual.resetTakeoffAnimation();
    }
    for (const shard of this.shards) this.deactivateShard(shard);
  }

  suspendSentinelsForQa(): void {
    for (const drone of this.drones) {
      drone.alive = false;
      drone.health = 0;
      drone.state = 'destroyed';
      drone.respawnSeconds = 999;
      drone.beamActive = false;
      drone.targetOwner = null;
      drone.visual.stopContinuousBeam();
      drone.visual.root.visible = false;
    }
  }

  stageBusterAttackForQa(id: string, target: DroneTargetSnapshot): boolean {
    const drone = this.busterDrones.find((candidate) => candidate.id === id);
    if (!drone) return false;
    for (const other of this.busterDrones) {
      if (other === drone) continue;
      other.alive = false;
      other.health = 0;
      other.state = 'destroyed';
      other.respawnSeconds = 999;
      other.visual.root.visible = false;
    }
    const bounds = this.arena.mapInfo.bounds;
    let staged = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const angle = attempt / 12 * Math.PI * 2;
      const x = THREE.MathUtils.clamp(target.position.x + Math.cos(angle) * 18, -bounds.width * 0.44, bounds.width * 0.44);
      const z = THREE.MathUtils.clamp(target.position.z + Math.sin(angle) * 18, -bounds.depth * 0.44, bounds.depth * 0.44);
      const floor = this.arena.floorHeightAt(x, z, target.position.y + 40) ?? target.position.y;
      this.busterAimPoint.set(x, Math.max(target.position.y + 7, floor + 8), z);
      if (!this.arena.hasLineOfSight(this.busterAimPoint, target.position, 0.35)) continue;
      drone.position.copy(this.busterAimPoint);
      staged = true;
      break;
    }
    if (!staged) drone.position.copy(target.position).add(new THREE.Vector3(0, 16, 24));
    drone.velocity.set(0, 0, 0);
    drone.health = drone.maxHealth;
    drone.alive = true;
    drone.respawnSeconds = 0;
    drone.targetOwner = target.owner;
    // Hold the explicitly staged target long enough for a deterministic eye-on-target burst.
    drone.acquireCooldown = 3;
    drone.evadeSeconds = 0;
    drone.takeoffElapsed = BUSTER_DRONE_TUNING.takeoffSpoolSeconds + BUSTER_DRONE_TUNING.takeoffSeconds + 0.1;
    drone.state = 'attack-run';
    drone.stateElapsed = 0;
    drone.fireCooldown = 0;
    drone.burstRemaining = 0;
    drone.gazeDot = 1;
    drone.lookingAtTarget = true;
    drone.visual.root.visible = true;
    drone.visual.root.position.copy(drone.position);
    this.busterAimDirection.subVectors(target.position, drone.position).normalize();
    (drone.visual as BusterDroneVisual).face(this.busterAimDirection, 1, 100);
    for (const shard of this.shards) this.deactivateShard(shard);
    return true;
  }

  dispose(): void {
    for (const drone of this.combatDrones) drone.visual.dispose();
    this.shardGeometry.dispose();
    this.shardCoreMaterial.dispose();
    this.shardGlowMaterial.dispose();
    this.shardRoot.removeFromParent();
  }

  private placeSpawn(drone: CombatDroneRuntime): void {
    if (drone.kind === 'buster') {
      const angleOffset = this.arena.mapInfo.name === 'QuickSense' ? Math.PI * 0.16 : -Math.PI * 0.28;
      const angle = angleOffset + drone.index / BUSTER_DRONE_TUNING.count * Math.PI * 2;
      const radius = Math.min(this.arena.mapInfo.bounds.width, this.arena.mapInfo.bounds.depth)
        * (this.arena.mapInfo.name === 'QuickSense' ? 0.28 : 0.32);
      const x = this.arena.corePosition.x + Math.cos(angle) * radius;
      const z = this.arena.corePosition.z + Math.sin(angle) * radius;
      const floor = this.arena.floorHeightAt(x, z, Number.POSITIVE_INFINITY) ?? this.arena.corePosition.y;
      drone.spawnPosition.set(x, floor + BUSTER_DRONE_TUNING.landedCenterHeight, z);
      drone.patrolCenter.set(x, floor + BUSTER_DRONE_TUNING.flightClearance, z);
      drone.position.copy(drone.spawnPosition);
      drone.velocity.set(0, 0, 0);
      return;
    }
    const angleOffset = this.arena.mapInfo.name === 'QuickSense' ? -Math.PI * 0.18 : Math.PI * 0.12;
    const angle = angleOffset + drone.index / DRONE_TUNING.count * Math.PI * 2;
    const radius = Math.min(this.arena.mapInfo.bounds.width, this.arena.mapInfo.bounds.depth)
      * (this.arena.mapInfo.name === 'QuickSense' ? 0.19 : 0.24);
    const x = this.arena.corePosition.x + Math.cos(angle) * radius;
    const z = this.arena.corePosition.z + Math.sin(angle) * radius;
    const floor = this.arena.floorHeightAt(x, z, Number.POSITIVE_INFINITY) ?? this.arena.corePosition.y;
    const y = floor + 13 + drone.index * 2.6;
    drone.spawnPosition.set(x, y, z);
    drone.patrolCenter.copy(drone.spawnPosition);
    drone.position.copy(drone.spawnPosition);
    drone.velocity.set(-Math.sin(angle) * 4, 0, Math.cos(angle) * 4);
  }

  private respawn(drone: CombatDroneRuntime): void {
    drone.health = drone.maxHealth;
    drone.alive = true;
    drone.respawnSeconds = 0;
    drone.position.copy(drone.spawnPosition);
    drone.velocity.set(0, 0, 0);
    drone.targetOwner = null;
    drone.state = drone.kind === 'buster' ? 'spool' : 'patrol';
    drone.beamActive = false;
    drone.beamDamageAccumulator = 0;
    drone.beamStartPending = false;
    drone.beamOnTarget = false;
    drone.aimErrorDegrees = 0;
    drone.stateElapsed = 0;
    drone.takeoffElapsed = 0;
    drone.targetLostSeconds = 0;
    drone.fireCooldown = 0;
    drone.burstRemaining = 0;
    drone.gazeDot = -1;
    drone.lookingAtTarget = false;
    drone.respawns += 1;
    drone.visual.root.visible = true;
    drone.visual.root.position.copy(drone.position);
    drone.visual.stopContinuousBeam();
    drone.visual.resetTakeoffAnimation();
  }

  private chooseTarget(
    drone: CombatDroneRuntime,
    targets: readonly DroneTargetSnapshot[],
  ): DroneTargetSnapshot | null {
    const tuning = drone.kind === 'buster' ? BUSTER_DRONE_TUNING : DRONE_TUNING;
    switch (drone.kind) {
      case 'buster':
        (drone.visual as BusterDroneVisual).forwardWorld(this.awarenessFacing);
        break;
      case 'sentinel':
        if (drone.velocity.lengthSq() > 0.04) this.awarenessFacing.copy(drone.velocity);
        else this.awarenessFacing.set(0, 0, 1).applyQuaternion(drone.visual.root.quaternion);
        break;
      default: {
        const _exhaustive: never = drone.kind;
        return _exhaustive;
      }
    }
    this.awarenessFacing.y = 0;
    if (this.awarenessFacing.lengthSq() > 0.01) this.awarenessFacing.normalize();
    else this.awarenessFacing.set(0, 0, 1);
    let best: DroneTargetSnapshot | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const target of targets) {
      if (!target.alive) continue;
      const distance = drone.position.distanceTo(target.position);
      this.awarenessToTarget.subVectors(target.position, drone.position);
      const horizontal = Math.hypot(this.awarenessToTarget.x, this.awarenessToTarget.z);
      const facingDot = horizontal > 0.001
        ? (this.awarenessFacing.x * this.awarenessToTarget.x + this.awarenessFacing.z * this.awarenessToTarget.z)
          / (Math.hypot(this.awarenessFacing.x, this.awarenessFacing.z) * horizontal)
        : 1;
      if (!droneCanAcquire({
        distance,
        acquireRange: tuning.acquireRange,
        retainRange: tuning.retainRange,
        proximityRange: tuning.proximityRange,
        alreadyTargeting: drone.targetOwner === target.owner,
        facingDot,
        acquireDot: tuning.acquireDot,
        hasLos: this.arena.hasLineOfSight(drone.position, target.position, 0.35),
      })) continue;
      const playerBias = target.owner === 'player' ? -5 : 0;
      const retainedBias = target.owner === drone.targetOwner ? -10 : 0;
      const score = distance + playerBias + retainedBias;
      if (score >= bestScore) continue;
      best = target;
      bestScore = score;
    }
    return best;
  }

  private updateFlight(
    drone: CombatDroneRuntime,
    target: DroneTargetSnapshot | null,
    delta: number,
    elapsed: number,
  ): void {
    const orbit = elapsed * (target ? 0.52 : 0.24) + drone.index * 2.37;
    if (target) {
      const orbitRadius = 21 + drone.index * 3.5;
      this.desiredPoint.copy(target.position).add(new THREE.Vector3(
        Math.cos(orbit) * orbitRadius,
        10.5 + Math.sin(orbit * 1.7) * 4.2,
        Math.sin(orbit) * orbitRadius,
      ));
      drone.state = drone.evadeSeconds > 0 ? 'evade' : 'engage';
    } else {
      this.desiredPoint.copy(drone.patrolCenter).add(new THREE.Vector3(
        Math.cos(orbit) * (15 + drone.index * 2.5),
        Math.sin(orbit * 1.4) * 4,
        Math.sin(orbit) * (15 + drone.index * 2.5),
      ));
      drone.state = 'patrol';
    }
    const halfWidth = this.arena.mapInfo.bounds.width * 0.47;
    const halfDepth = this.arena.mapInfo.bounds.depth * 0.47;
    this.desiredPoint.x = THREE.MathUtils.clamp(this.desiredPoint.x, -halfWidth, halfWidth);
    this.desiredPoint.z = THREE.MathUtils.clamp(this.desiredPoint.z, -halfDepth, halfDepth);
    const desiredFloor = this.arena.floorHeightAt(
      this.desiredPoint.x,
      this.desiredPoint.z,
      this.desiredPoint.y + 12,
    );
    if (desiredFloor !== null) this.desiredPoint.y = Math.max(this.desiredPoint.y, desiredFloor + DRONE_TUNING.minimumClearance);

    const speed = target ? DRONE_TUNING.combatSpeed : DRONE_TUNING.patrolSpeed;
    if (drone.evadeSeconds > 0 && target) {
      const away = this.steering.subVectors(drone.position, target.position);
      if (away.lengthSq() > 0.001) this.desiredPoint.addScaledVector(away.normalize(), 14);
    }
    this.desiredVelocity.subVectors(this.desiredPoint, drone.position);
    if (this.desiredVelocity.lengthSq() > 0.01) this.desiredVelocity.normalize().multiplyScalar(speed);
    this.separation.set(0, 0, 0);
    for (const other of this.combatDrones) {
      if (other === drone || !other.alive) continue;
      const distanceSq = drone.position.distanceToSquared(other.position);
      if (distanceSq >= 7.5 * 7.5 || distanceSq <= 1e-6) continue;
      this.steering.subVectors(drone.position, other.position);
      this.separation.addScaledVector(this.steering.normalize(), (7.5 - Math.sqrt(distanceSq)) * 1.8);
    }
    this.desiredVelocity.add(this.separation);
    this.steering.subVectors(this.desiredVelocity, drone.velocity);
    const steeringLength = this.steering.length();
    if (steeringLength > DRONE_TUNING.acceleration) this.steering.multiplyScalar(DRONE_TUNING.acceleration / steeringLength);
    drone.velocity.addScaledVector(this.steering, delta);
    drone.velocity.multiplyScalar(Math.exp(-delta * 0.22));
    const maxSpeed = speed * 1.16;
    if (drone.velocity.lengthSq() > maxSpeed * maxSpeed) drone.velocity.setLength(maxSpeed);

    this.intendedPosition.copy(drone.position).addScaledVector(drone.velocity, delta);
    if (this.sweepWorld(drone.position, this.intendedPosition, drone.collisionRadius * 0.72)) {
      drone.velocity.reflect(this.steering).multiplyScalar(0.42).addScaledVector(this.steering, 7.5);
      drone.position.addScaledVector(this.steering, delta * 1.2);
      drone.collisionHits += 1;
    } else {
      drone.position.copy(this.intendedPosition);
    }
    const floor = this.arena.floorHeightAt(drone.position.x, drone.position.z, drone.position.y + 9);
    if (floor !== null) {
      const minimumY = floor + DRONE_TUNING.minimumClearance;
      if (drone.position.y < minimumY) {
        drone.position.y = minimumY;
        drone.velocity.y = Math.max(3.5, Math.abs(drone.velocity.y) * 0.4);
      }
    }
    if (Math.abs(drone.position.x) >= halfWidth) drone.velocity.x *= -0.6;
    if (Math.abs(drone.position.z) >= halfDepth) drone.velocity.z *= -0.6;
    drone.position.x = THREE.MathUtils.clamp(drone.position.x, -halfWidth, halfWidth);
    drone.position.z = THREE.MathUtils.clamp(drone.position.z, -halfDepth, halfDepth);
  }

  private updateBusterFlight(
    drone: CombatDroneRuntime,
    target: DroneTargetSnapshot | null,
    delta: number,
    elapsed: number,
  ): void {
    const visual = drone.visual as BusterDroneVisual;
    drone.takeoffElapsed += delta;
    drone.stateElapsed += delta;
    const spoolEnd = BUSTER_DRONE_TUNING.takeoffSpoolSeconds;
    const takeoffEnd = spoolEnd + BUSTER_DRONE_TUNING.takeoffSeconds;

    if (drone.takeoffElapsed < takeoffEnd) {
      if (drone.takeoffElapsed < spoolEnd) {
        this.setBusterState(drone, 'spool');
        drone.position.copy(drone.spawnPosition);
        drone.velocity.set(0, 0, 0);
      } else {
        this.setBusterState(drone, 'takeoff');
        const t = THREE.MathUtils.smoothstep(drone.takeoffElapsed, spoolEnd, takeoffEnd);
        const previousY = drone.position.y;
        drone.position.copy(drone.spawnPosition);
        drone.position.y = THREE.MathUtils.lerp(
          drone.spawnPosition.y,
          drone.patrolCenter.y,
          t * t * (3 - 2 * t),
        );
        drone.velocity.set(0, delta > 0 ? (drone.position.y - previousY) / delta : 0, 0);
      }
      drone.visual.root.position.copy(drone.position);
      visual.updateAnimation(delta, drone.state as BusterVisualFlightState);
      if (drone.takeoffElapsed >= takeoffEnd - delta && drone.takeoffs === drone.respawns) {
        drone.takeoffs += 1;
      }
      return;
    }

    if (drone.state === 'landed') {
      drone.position.copy(drone.spawnPosition);
      drone.velocity.set(0, 0, 0);
      drone.health = Math.min(drone.maxHealth, drone.health + drone.maxHealth * 0.08 * delta);
      drone.visual.root.position.copy(drone.position);
      visual.updateAnimation(delta, 'landed');
      if (drone.stateElapsed >= BUSTER_DRONE_TUNING.landingIdleSeconds) {
        drone.takeoffElapsed = 0;
        drone.targetLostSeconds = 0;
        this.setBusterState(drone, 'spool');
        visual.resetTakeoffAnimation();
      }
      return;
    }

    drone.targetLostSeconds = target
      ? 0
      : drone.targetLostSeconds + delta;
    const shouldLand = drone.health / drone.maxHealth <= BUSTER_DRONE_TUNING.criticalLandingHealthRatio
      || drone.targetLostSeconds >= BUSTER_DRONE_TUNING.noTargetLandingSeconds;

    const targetDistance = target ? drone.position.distanceTo(target.position) : Number.POSITIVE_INFINITY;
    if (drone.state === 'landing-approach' || shouldLand) {
      this.setBusterState(drone, 'landing-approach');
    } else if (drone.evadeSeconds > 0) {
      this.setBusterState(drone, 'jink');
    } else if (drone.state === 'breakaway' && drone.stateElapsed < 2.45) {
      // Finish the committed escape vector before reacquiring.
    } else if (target && (
      (targetDistance < 18 && drone.stateElapsed > 1.25)
      || (drone.state === 'attack-run' && drone.stateElapsed > 5.2)
    )) {
      this.setBusterState(drone, 'breakaway');
    } else if (target) {
      this.setBusterState(drone, 'attack-run');
    } else {
      this.setBusterState(drone, 'survey');
    }

    const phase = elapsed * (0.31 + drone.index * 0.025) + drone.index * Math.PI * 0.67;
    if (drone.state === 'landing-approach') {
      const horizontalDistance = Math.hypot(
        drone.position.x - drone.spawnPosition.x,
        drone.position.z - drone.spawnPosition.z,
      );
      this.desiredPoint.copy(drone.spawnPosition);
      if (horizontalDistance > 1.25) {
        this.desiredPoint.y += 9;
      } else {
        // Once inside the landing column, kill lateral drift and descend on a
        // stable vertical rail so the vehicle cannot orbit its touchdown pad.
        drone.position.x = THREE.MathUtils.lerp(drone.position.x, drone.spawnPosition.x, 1 - Math.exp(-delta * 5));
        drone.position.z = THREE.MathUtils.lerp(drone.position.z, drone.spawnPosition.z, 1 - Math.exp(-delta * 5));
        drone.velocity.x *= Math.exp(-delta * 8);
        drone.velocity.z *= Math.exp(-delta * 8);
      }
    } else if (drone.state === 'survey') {
      if (drone.index === 0) {
        drone.flightPattern = 'figure-eight';
        this.desiredPoint.copy(drone.patrolCenter).set(
          drone.patrolCenter.x + Math.sin(phase) * 28,
          drone.patrolCenter.y + Math.sin(phase * 1.7) * 5.5,
          drone.patrolCenter.z + Math.sin(phase * 2) * 17,
        );
      } else {
        drone.flightPattern = 'vertical-sweep';
        this.desiredPoint.copy(drone.patrolCenter).set(
          drone.patrolCenter.x + Math.cos(phase * 0.72) * 18,
          drone.patrolCenter.y + Math.sin(phase * 1.42) * 9,
          drone.patrolCenter.z + Math.sin(phase) * 25,
        );
      }
    } else if (drone.state === 'attack-run' && target) {
      drone.flightPattern = drone.index === 0 ? 'pincer' : 'vertical-sweep';
      const leadSeconds = THREE.MathUtils.clamp(targetDistance / BUSTER_DRONE_TUNING.shardSpeed, 0.15, 1.1);
      this.desiredPoint.copy(target.position).addScaledVector(target.velocity, leadSeconds * 0.45);
      this.desiredPoint.y += drone.index === 0 ? 7.5 : 13;
      this.busterLateral.subVectors(target.position, drone.position).cross(THREE.Object3D.DEFAULT_UP);
      if (this.busterLateral.lengthSq() > 1e-5) {
        this.desiredPoint.addScaledVector(
          this.busterLateral.normalize(),
          (drone.index === 0 ? -1 : 1) * 9,
        );
      }
    } else if (target) {
      this.busterAway.subVectors(drone.position, target.position).setY(0);
      if (this.busterAway.lengthSq() < 1e-5) this.busterAway.set(0, 0, 1);
      else this.busterAway.normalize();
      this.busterLateral.crossVectors(this.busterAway, THREE.Object3D.DEFAULT_UP).normalize();
      this.desiredPoint.copy(drone.position)
        .addScaledVector(this.busterAway, drone.state === 'jink' ? 24 : 38)
        .addScaledVector(this.busterLateral, Math.sin(elapsed * 2.7 + drone.index) * 18);
      this.desiredPoint.y += drone.state === 'jink' ? 8 : 11;
    } else {
      this.desiredPoint.copy(drone.patrolCenter);
    }

    const halfWidth = this.arena.mapInfo.bounds.width * 0.46;
    const halfDepth = this.arena.mapInfo.bounds.depth * 0.46;
    this.desiredPoint.x = THREE.MathUtils.clamp(this.desiredPoint.x, -halfWidth, halfWidth);
    this.desiredPoint.z = THREE.MathUtils.clamp(this.desiredPoint.z, -halfDepth, halfDepth);
    if (drone.state !== 'landing-approach') {
      const desiredFloor = this.arena.floorHeightAt(
        this.desiredPoint.x,
        this.desiredPoint.z,
        this.desiredPoint.y + 20,
      );
      if (desiredFloor !== null) {
        this.desiredPoint.y = Math.max(
          this.desiredPoint.y,
          desiredFloor + BUSTER_DRONE_TUNING.flightClearance * 0.64,
        );
      }
    }

    const speed = drone.state === 'landing-approach'
      ? 10.5
      : drone.state === 'attack-run'
      ? BUSTER_DRONE_TUNING.attackRunSpeed
      : drone.state === 'breakaway' || drone.state === 'jink'
        ? BUSTER_DRONE_TUNING.breakawaySpeed
        : BUSTER_DRONE_TUNING.surveySpeed;
    this.desiredVelocity.subVectors(this.desiredPoint, drone.position);
    if (this.desiredVelocity.lengthSq() > 0.01) this.desiredVelocity.normalize().multiplyScalar(speed);
    this.separation.set(0, 0, 0);
    for (const other of this.combatDrones) {
      if (other === drone || !other.alive) continue;
      const safeDistance = drone.collisionRadius + other.collisionRadius + 3;
      const distanceSq = drone.position.distanceToSquared(other.position);
      if (distanceSq <= 1e-6 || distanceSq >= safeDistance * safeDistance) continue;
      this.steering.subVectors(drone.position, other.position).normalize();
      this.separation.addScaledVector(this.steering, (safeDistance - Math.sqrt(distanceSq)) * 2.2);
    }
    this.desiredVelocity.add(this.separation);
    this.steering.subVectors(this.desiredVelocity, drone.velocity);
    const acceleration = drone.state === 'jink'
      ? BUSTER_DRONE_TUNING.acceleration * 1.45
      : BUSTER_DRONE_TUNING.acceleration;
    if (this.steering.lengthSq() > acceleration * acceleration) this.steering.setLength(acceleration);
    drone.velocity.addScaledVector(this.steering, delta);
    drone.velocity.multiplyScalar(Math.exp(-delta * 0.14));
    if (drone.velocity.lengthSq() > speed * speed) drone.velocity.setLength(speed);

    this.intendedPosition.copy(drone.position).addScaledVector(drone.velocity, delta);
    const inLandingColumn = drone.state === 'landing-approach'
      && Math.hypot(
        drone.position.x - drone.spawnPosition.x,
        drone.position.z - drone.spawnPosition.z,
      ) <= 1.25;
    if (!inLandingColumn && this.sweepWorld(drone.position, this.intendedPosition, drone.collisionRadius * 0.78)) {
      drone.velocity.reflect(this.steering).multiplyScalar(0.36).addScaledVector(this.steering, 9);
      drone.position.addScaledVector(this.steering, delta * 1.4);
      drone.collisionHits += 1;
      this.setBusterState(drone, 'jink');
      drone.evadeSeconds = Math.max(drone.evadeSeconds, 0.9);
    } else {
      drone.position.copy(this.intendedPosition);
    }
    const floor = this.arena.floorHeightAt(drone.position.x, drone.position.z, drone.position.y + 15);
    if (drone.state === 'landing-approach') {
      const minimumY = drone.spawnPosition.y;
      if (drone.position.y < minimumY) {
        drone.position.y = minimumY;
        drone.velocity.y = 0;
      }
    } else if (floor !== null) {
      const minimumY = floor + BUSTER_DRONE_TUNING.flightClearance * 0.52;
      if (drone.position.y < minimumY) {
        drone.position.y = minimumY;
        drone.velocity.y = Math.max(4.5, Math.abs(drone.velocity.y) * 0.45);
      }
    }
    drone.position.x = THREE.MathUtils.clamp(drone.position.x, -halfWidth, halfWidth);
    drone.position.z = THREE.MathUtils.clamp(drone.position.z, -halfDepth, halfDepth);

    if (drone.state === 'landing-approach') {
      const horizontalDistance = Math.hypot(
        drone.position.x - drone.spawnPosition.x,
        drone.position.z - drone.spawnPosition.z,
      );
      if (horizontalDistance <= 0.65 && Math.abs(drone.position.y - drone.spawnPosition.y) <= 0.35) {
        drone.position.copy(drone.spawnPosition);
        drone.velocity.set(0, 0, 0);
        this.setBusterState(drone, 'landed');
        drone.landings += 1;
      }
    }

    const lookDirection = target
      ? this.busterAimDirection.subVectors(target.position, drone.position)
      : this.busterAimDirection.copy(drone.velocity);
    visual.face(lookDirection, delta, target ? 3.6 : 2.1);
    drone.visual.root.position.copy(drone.position);
    visual.updateAnimation(delta, drone.state as BusterVisualFlightState, lookDirection);
  }

  private updateBusterWeapons(
    drone: CombatDroneRuntime,
    target: DroneTargetSnapshot | null,
    delta: number,
    _elapsed: number,
  ): void {
    drone.fireCooldown = Math.max(0, drone.fireCooldown - delta);
    if (!target || drone.state === 'spool' || drone.state === 'takeoff') {
      drone.gazeDot = -1;
      drone.lookingAtTarget = false;
      drone.aimErrorDegrees = 180;
      return;
    }
    const distance = drone.position.distanceTo(target.position);
    const leadSeconds = THREE.MathUtils.clamp(distance / BUSTER_DRONE_TUNING.shardSpeed, 0.12, 1.05);
    this.busterAimPoint.copy(target.position).addScaledVector(target.velocity, leadSeconds);
    this.busterAimDirection.subVectors(this.busterAimPoint, drone.position).normalize();
    (drone.visual as BusterDroneVisual).forwardWorld(this.busterForward);
    drone.gazeDot = THREE.MathUtils.clamp(this.busterForward.dot(this.busterAimDirection), -1, 1);
    drone.aimErrorDegrees = THREE.MathUtils.radToDeg(Math.acos(drone.gazeDot));
    drone.lookingAtTarget = drone.gazeDot >= drone.gazeThreshold;
    (drone.visual as BusterDroneVisual).shardOriginWorld(this.busterAimPoint, this.muzzlePosition);
    const canFire = (drone.state === 'attack-run' || drone.state === 'jink')
      && distance <= BUSTER_DRONE_TUNING.fireRange
      && distance >= 10
      && drone.lookingAtTarget
      && this.arena.hasLineOfSight(this.muzzlePosition, this.busterAimPoint, 0.3);
    if (!canFire || drone.fireCooldown > 0) return;

    if (drone.burstRemaining <= 0) drone.burstRemaining = BUSTER_DRONE_TUNING.burstCount;
    // The eye/gaze cone authorizes the shot; the projectile then travels on a
    // straight predictive intercept rather than inheriting visual turn lag.
    this.fireBusterShard(drone, target, this.busterAimDirection);
    drone.burstRemaining -= 1;
    drone.fireCooldown = drone.burstRemaining > 0
      ? BUSTER_DRONE_TUNING.burstSpacingSeconds
      : BUSTER_DRONE_TUNING.burstCooldownSeconds + drone.index * 0.18;
  }

  private setBusterState(drone: CombatDroneRuntime, state: BusterVisualFlightState): void {
    if (drone.state === state) return;
    drone.state = state;
    drone.stateElapsed = 0;
    if (state === 'landing-approach') drone.visual.startLandingAnimation();
  }

  private updateWeapons(
    drone: CombatDroneRuntime,
    target: DroneTargetSnapshot | null,
    delta: number,
    onLaser: (event: DroneLaserEvent) => void,
  ): void {
    const visual = drone.visual as CombatDroneVisual;
    const distance = target ? drone.position.distanceTo(target.position) : Number.POSITIVE_INFINITY;
    const visible = target !== null
      && distance <= DRONE_TUNING.fireRange
      && this.arena.hasLineOfSight(drone.position, target.position, 0.35);
    if (!target || !visible) {
      drone.beamActive = false;
      drone.beamDamageAccumulator = 0;
      drone.beamStartPending = false;
      drone.beamOnTarget = false;
      drone.aimErrorDegrees = 0;
      visual.stopContinuousBeam();
      return;
    }

    const started = !drone.beamActive;
    if (started) {
      drone.beamActive = true;
      drone.beamStartPending = true;
      drone.shotsFired += 1;
    }
    drone.beamUptimeSeconds += delta;
    // The continuous beam is hitscan, so it tracks the target's present body
    // instead of applying impossible projectile-style future prediction.
    this.laserTargetCenter.copy(target.position);
    visual.beamOriginWorld(this.laserTargetCenter, this.muzzlePosition);

    // Each drone has a stable skill profile, while low-frequency drift
    // produces smooth hand-like error instead of frame-random aimbot jitter.
    // Acquisition starts loose, then settles without ever becoming perfect.
    const skillErrorDegrees = 0.72 + drone.index * 0.22;
    const acquisition = THREE.MathUtils.smoothstep(drone.beamUptimeSeconds, 0.12, 1.35);
    const acquisitionScale = THREE.MathUtils.lerp(2.2, 1, acquisition);
    const motionScale = 1 + Math.min(0.45, target.velocity.length() / 42);
    const angularAmplitude = Math.tan(THREE.MathUtils.degToRad(
      skillErrorDegrees * acquisitionScale * motionScale,
    )) * distance;
    // Keep peak error wider than a character even at point-blank range so a
    // close drone cannot collapse back into perfect tracking.
    const minimumWorldDrift = (0.72 + drone.index * 0.14) * acquisitionScale;
    const driftAmplitude = angularAmplitude + minimumWorldDrift;
    const phase = drone.index * 2.41;
    // A single radial wave guarantees every drone crosses the target instead
    // of two unrelated axes accidentally orbiting around it forever. Slowly
    // rotating that wave keeps the miss direction varied and natural.
    const aimTime = drone.beamUptimeSeconds;
    const driftWave = Math.sin(aimTime * (1.25 + drone.index * 0.08) + phase);
    const driftAngle = aimTime * (0.31 + drone.index * 0.025) + phase * 0.67;
    const yawNoise = driftWave * Math.cos(driftAngle);
    const pitchNoise = driftWave * Math.sin(driftAngle);

    this.laserAimDirection.subVectors(this.laserTargetCenter, this.muzzlePosition).normalize();
    this.laserAimRight.crossVectors(this.laserAimDirection, THREE.Object3D.DEFAULT_UP);
    if (this.laserAimRight.lengthSq() < 1e-5) this.laserAimRight.set(1, 0, 0);
    else this.laserAimRight.normalize();
    this.laserAimUp.crossVectors(this.laserAimRight, this.laserAimDirection).normalize();
    this.laserTargetPoint.copy(this.laserTargetCenter)
      .addScaledVector(this.laserAimRight, yawNoise * driftAmplitude)
      .addScaledVector(this.laserAimUp, pitchNoise * driftAmplitude * 0.72);
    this.laserAimDirection.subVectors(this.laserTargetPoint, this.muzzlePosition).normalize();
    drone.aimErrorDegrees = THREE.MathUtils.radToDeg(Math.atan2(
      this.laserTargetPoint.distanceTo(this.laserTargetCenter),
      Math.max(distance, 0.001),
    ));

    const beamDistance = Math.min(DRONE_TUNING.fireRange, distance + 10);
    this.laserRayEnd.copy(this.muzzlePosition).addScaledVector(this.laserAimDirection, beamDistance);
    const worldHit = this.arena.segmentHitDetails(this.muzzlePosition, this.laserRayEnd);
    const worldDistance = worldHit?.distance ?? beamDistance;
    const targetRadius = target.owner === 'player'
      ? DRONE_TUNING.targetRadiusPlayer
      : DRONE_TUNING.targetRadiusBot;
    this.ray.set(this.muzzlePosition, this.laserAimDirection);
    this.sphere.set(this.laserTargetCenter, targetRadius);
    const targetHit = this.ray.intersectSphere(this.sphere, this.hitPoint);
    const targetHitDistance = targetHit?.distanceTo(this.muzzlePosition) ?? Number.POSITIVE_INFINITY;
    drone.beamOnTarget = targetHit !== null && targetHitDistance <= worldDistance + 0.02;
    if (drone.beamOnTarget) this.laserVisualEnd.copy(targetHit!);
    else if (worldHit) this.laserVisualEnd.copy(worldHit.point);
    else this.laserVisualEnd.copy(this.laserRayEnd);
    visual.updateContinuousBeam(this.muzzlePosition, this.laserVisualEnd, drone.beamUptimeSeconds);

    drone.beamDamageAccumulator += delta;
    let firstDamageTick = true;
    while (drone.beamDamageAccumulator >= DRONE_TUNING.laserDamageTickSeconds) {
      drone.beamDamageAccumulator -= DRONE_TUNING.laserDamageTickSeconds;
      if (drone.beamOnTarget) {
        drone.beamDamageTicks += 1;
        onLaser({
          droneId: drone.id,
          targetOwner: target.owner,
          origin: this.muzzlePosition.clone(),
          hitPoint: this.hitPoint.clone(),
          damage: DRONE_TUNING.laserDps * DRONE_TUNING.laserDamageTickSeconds,
          started: drone.beamStartPending && firstDamageTick,
        });
        drone.beamStartPending = false;
      } else {
        drone.beamMissTicks += 1;
      }
      firstDamageTick = false;
    }
  }

  private installShardPool(): void {
    for (let index = 0; index < this.shardPoolSize; index += 1) {
      const root = new THREE.Group();
      root.name = `buster-red-shard-${index + 1}`;
      root.visible = false;
      const glow = new THREE.Mesh(this.shardGeometry, this.shardGlowMaterial);
      glow.name = 'red-shard-glow';
      glow.scale.set(1.65, 1.65, 4.8);
      glow.renderOrder = 13;
      const core = new THREE.Mesh(this.shardGeometry, this.shardCoreMaterial);
      core.name = 'red-shard-core';
      core.scale.set(0.72, 0.72, 3.15);
      core.renderOrder = 14;
      root.add(glow, core);
      this.shardRoot.add(root);
      this.shards.push({
        root,
        origin: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        sourceId: '',
        targetOwner: 'player',
        life: 0,
        active: false,
      });
    }
  }

  private fireBusterShard(
    drone: CombatDroneRuntime,
    target: DroneTargetSnapshot,
    direction: THREE.Vector3,
  ): void {
    const shard = this.shards.find((candidate) => !candidate.active);
    if (!shard) return;
    const visual = drone.visual as BusterDroneVisual;
    visual.shardOriginWorld(target.position, shard.root.position);
    shard.origin.copy(shard.root.position);
    shard.velocity.copy(direction).normalize().multiplyScalar(BUSTER_DRONE_TUNING.shardSpeed);
    shard.root.quaternion.setFromUnitVectors(MODEL_FORWARD, direction);
    shard.root.visible = true;
    shard.sourceId = drone.id;
    shard.targetOwner = target.owner;
    shard.life = BUSTER_DRONE_TUNING.shardLifeSeconds;
    shard.active = true;
    drone.shotsFired += 1;
    drone.shardsFired += 1;
    this.activeShardCount += 1;
  }

  private updateShards(
    delta: number,
    targets: readonly DroneTargetSnapshot[],
    onShard: (event: BusterShardEvent) => void,
  ): void {
    for (const shard of this.shards) {
      if (!shard.active) continue;
      shard.life -= delta;
      if (shard.life <= 0) {
        this.deactivateShard(shard);
        continue;
      }
      this.shardPrevious.copy(shard.root.position);
      const intendedTarget = targets.find((target) => target.alive && target.owner === shard.targetOwner);
      if (intendedTarget) {
        this.shardDesiredHeading.copy(intendedTarget.position)
          .addScaledVector(intendedTarget.velocity, 0.08)
          .sub(shard.root.position)
          .normalize();
        this.shardHeading.copy(shard.velocity).normalize().lerp(
          this.shardDesiredHeading,
          1 - Math.exp(-BUSTER_DRONE_TUNING.shardHomingResponsiveness * delta),
        ).normalize();
        shard.velocity.copy(this.shardHeading).multiplyScalar(BUSTER_DRONE_TUNING.shardSpeed);
      }
      this.shardNext.copy(shard.root.position).addScaledVector(shard.velocity, delta);
      const worldHit = this.arena.segmentHitDetails(this.shardPrevious, this.shardNext);
      const segmentLength = this.shardPrevious.distanceTo(this.shardNext);
      let bestFraction = worldHit && segmentLength > 1e-6
        ? THREE.MathUtils.clamp(worldHit.distance / segmentLength, 0, 1)
        : 1.001;
      let hitTarget: DroneTargetSnapshot | null = null;
      for (const target of targets) {
        if (!target.alive) continue;
        const radius = (target.owner === 'player'
          ? DRONE_TUNING.targetRadiusPlayer
          : DRONE_TUNING.targetRadiusBot) + BUSTER_DRONE_TUNING.shardRadius;
        const fraction = this.segmentSphereFraction(
          this.shardPrevious,
          this.shardNext,
          target.position,
          radius,
        );
        if (fraction === null || fraction >= bestFraction) continue;
        bestFraction = fraction;
        hitTarget = target;
      }

      if (hitTarget) {
        this.shardImpact.copy(this.shardPrevious).lerp(this.shardNext, bestFraction);
        shard.root.position.copy(this.shardImpact);
        const source = this.busterDrones.find((drone) => drone.id === shard.sourceId);
        if (source) source.shardHits += 1;
        this.recordShardImpact(shard, this.shardImpact, hitTarget.owner, false);
        onShard({
          droneId: shard.sourceId,
          targetOwner: hitTarget.owner,
          origin: shard.origin.clone(),
          hitPoint: this.shardImpact.clone(),
          damage: BUSTER_DRONE_TUNING.shardDamage,
          worldImpact: false,
        });
        this.deactivateShard(shard);
        continue;
      }
      if (worldHit) {
        shard.root.position.copy(worldHit.point);
        const source = this.busterDrones.find((drone) => drone.id === shard.sourceId);
        if (source) source.shardWorldImpacts += 1;
        this.recordShardImpact(shard, worldHit.point, null, true);
        onShard({
          droneId: shard.sourceId,
          targetOwner: null,
          origin: shard.origin.clone(),
          hitPoint: worldHit.point.clone(),
          damage: 0,
          worldImpact: true,
        });
        this.deactivateShard(shard);
        continue;
      }
      shard.root.position.copy(this.shardNext);
      shard.root.quaternion.setFromUnitVectors(MODEL_FORWARD, shard.velocity.clone().normalize());
    }
  }

  private segmentSphereFraction(
    start: THREE.Vector3,
    end: THREE.Vector3,
    center: THREE.Vector3,
    radius: number,
  ): number | null {
    this.shardSegment.subVectors(end, start);
    this.shardToTarget.subVectors(start, center);
    const a = this.shardSegment.lengthSq();
    if (a <= 1e-9) return null;
    const c = this.shardToTarget.lengthSq() - radius * radius;
    if (c <= 0) return 0;
    const b = this.shardToTarget.dot(this.shardSegment);
    const discriminant = b * b - a * c;
    if (discriminant < 0) return null;
    const fraction = (-b - Math.sqrt(discriminant)) / a;
    return fraction >= 0 && fraction <= 1 ? fraction : null;
  }

  private deactivateShard(shard: BusterShardProjectile): void {
    if (!shard.active) return;
    shard.active = false;
    shard.life = 0;
    shard.root.visible = false;
    shard.velocity.set(0, 0, 0);
    this.activeShardCount = Math.max(0, this.activeShardCount - 1);
  }

  private recordShardImpact(
    shard: BusterShardProjectile,
    point: THREE.Vector3,
    targetOwner: DroneTargetOwner | null,
    worldImpact: boolean,
  ): void {
    this.lastShardOrigin.copy(shard.origin);
    this.lastShardImpact.copy(point);
    this.lastShardSourceId = shard.sourceId;
    this.lastShardTargetOwner = targetOwner;
    this.lastShardWorldImpact = worldImpact;
  }

  private sweepWorld(start: THREE.Vector3, end: THREE.Vector3, radius: number): boolean {
    let bestDistance = Number.POSITIVE_INFINITY;
    let found = false;
    this.steering.set(0, 1, 0);
    for (const unitOffset of COLLISION_OFFSETS) {
      this.collisionStart.copy(start).addScaledVector(unitOffset, radius);
      this.collisionEnd.copy(end).addScaledVector(unitOffset, radius);
      const hit = this.arena.movementSegmentHitDetails(this.collisionStart, this.collisionEnd);
      if (!hit || hit.distance >= bestDistance) continue;
      bestDistance = hit.distance;
      this.steering.copy(hit.normal).normalize();
      found = true;
    }
    return found;
  }
}
