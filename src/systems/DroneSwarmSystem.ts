import * as THREE from 'three';
import { cloneScifiDroneScene, loadScifiDroneAsset } from '../assets/ScifiDroneAsset';
import type { ArenaRuntime } from '../game/Arena';

export const DRONE_TUNING = Object.freeze({
  count: 3,
  maxHealth: 225,
  collisionRadius: 1.7,
  patrolSpeed: 14,
  combatSpeed: 21,
  acceleration: 24,
  minimumClearance: 6.2,
  acquireRange: 118,
  fireRange: 104,
  laserDps: 18,
  laserDamageTickSeconds: 0.1,
  respawnSeconds: 18,
  visualDiameter: 3.4,
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
const BEAM_UP = new THREE.Vector3(0, 1, 0);
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
  private readonly beamRoot = new THREE.Group();
  private readonly beamBody = new THREE.Group();
  private readonly beamCore: THREE.Mesh;
  private readonly beamHalo: THREE.Mesh;
  private readonly beamImpact: THREE.Mesh;
  private readonly beamStartLocal = new THREE.Vector3();
  private readonly beamEndLocal = new THREE.Vector3();
  private readonly beamDirection = new THREE.Vector3();
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
    const beam = this.installContinuousBeam();
    this.beamCore = beam.core;
    this.beamHalo = beam.halo;
    this.beamImpact = beam.impact;
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
    this.beamDirection.subVectors(this.beamEndLocal, this.beamStartLocal);
    const length = this.beamDirection.length();
    if (length <= 0.05) {
      this.stopContinuousBeam();
      return;
    }
    this.beamDirection.multiplyScalar(1 / length);
    this.beamRoot.visible = true;
    this.beamBody.position.copy(this.beamStartLocal).lerp(this.beamEndLocal, 0.5);
    this.beamBody.quaternion.setFromUnitVectors(BEAM_UP, this.beamDirection);
    this.beamCore.scale.set(0.095, length, 0.095);
    this.beamHalo.scale.set(0.28, length, 0.28);
    this.beamImpact.position.copy(this.beamEndLocal);
    this.beamImpact.scale.setScalar(0.78 + Math.sin(phase * 27) * 0.12);
  }

  stopContinuousBeam(): void {
    this.beamRoot.visible = false;
  }

  get continuousBeamVisible(): boolean {
    return this.beamRoot.visible;
  }

  face(direction: THREE.Vector3, delta: number): void {
    if (direction.lengthSq() <= 0.01) return;
    const desired = new THREE.Quaternion().setFromUnitVectors(MODEL_FORWARD, direction.clone().normalize());
    this.root.quaternion.slerp(desired, 1 - Math.exp(-delta * 5.5));
  }

  dispose(): void {
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

  private installContinuousBeam(): {
    core: THREE.Mesh;
    halo: THREE.Mesh;
    impact: THREE.Mesh;
  } {
    const beamGeometry = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    const impactGeometry = new THREE.SphereGeometry(0.18, 12, 8);
    const coreMaterial = new THREE.MeshBasicMaterial({
      color: 0xff0000,
      blending: THREE.NormalBlending,
      depthWrite: false,
      toneMapped: false,
      transparent: false,
    });
    const haloMaterial = new THREE.MeshBasicMaterial({
      color: 0xff0000,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      transparent: true,
      opacity: 0.26,
    });
    const impactMaterial = new THREE.MeshBasicMaterial({
      color: 0xff3155,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      transparent: true,
      opacity: 0.82,
    });
    const core = new THREE.Mesh(beamGeometry, coreMaterial);
    const halo = new THREE.Mesh(beamGeometry, haloMaterial);
    const impact = new THREE.Mesh(impactGeometry, impactMaterial);
    core.name = `${this.id}-continuous-laser-core`;
    halo.name = `${this.id}-continuous-laser-halo`;
    impact.name = `${this.id}-continuous-laser-impact`;
    core.renderOrder = 17;
    halo.renderOrder = 16;
    impact.renderOrder = 18;
    this.beamBody.add(halo, core);
    this.beamRoot.add(this.beamBody, impact);
    this.beamRoot.visible = false;
    this.root.add(this.beamRoot);
    this.ownedGeometries.push(beamGeometry, impactGeometry);
    this.ownedMaterials.push(coreMaterial, haloMaterial, impactMaterial);
    return { core, halo, impact };
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
  readonly visual: CombatDroneVisual;
  readonly collisionRadius = DRONE_TUNING.collisionRadius;
  health: number = DRONE_TUNING.maxHealth;
  alive = true;
  respawnSeconds = 0;
  targetOwner: DroneTargetOwner | null = null;
  state: 'patrol' | 'engage' | 'evade' | 'destroyed' = 'patrol';
  shotsFired = 0;
  explosions = 0;
  respawns = 0;
  collisionHits = 0;
  beamActive = false;
  beamUptimeSeconds = 0;
  beamDamageTicks = 0;
  beamDamageAccumulator = 0;
  beamStartPending = false;
  acquireCooldown = 0;
  evadeSeconds = 0;

  constructor(readonly id: string, readonly index: number) {
    this.visual = new CombatDroneVisual(id);
  }
}

export class DroneSwarmSystem {
  readonly drones: CombatDroneRuntime[] = [];
  readonly ready: Promise<void>;
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
  private readonly laserTargetPoint = new THREE.Vector3();
  private readonly laserVisualEnd = new THREE.Vector3();
  private readonly laserToOrigin = new THREE.Vector3();

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
    this.ready = Promise.all(this.drones.map((drone) => drone.visual.ready)).then(() => undefined);
  }

  setSeed(_seed: number): void {
    // Spawns and steering are already deterministic; retained for QA API compatibility.
  }

  update(
    delta: number,
    elapsed: number,
    targets: readonly DroneTargetSnapshot[],
    onLaser: (event: DroneLaserEvent) => void,
  ): void {
    for (const drone of this.drones) {
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
      this.updateFlight(drone, target, delta, elapsed);
      drone.visual.root.position.copy(drone.position);
      drone.visual.face(drone.velocity, delta);
      this.updateWeapons(drone, target, delta, onLaser);
    }
  }

  nearestVisibleDrone(origin: THREE.Vector3, maxDistance: number): CombatDroneRuntime | null {
    let best: CombatDroneRuntime | null = null;
    let bestDistanceSq = maxDistance * maxDistance;
    for (const drone of this.drones) {
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
    for (const drone of this.drones) {
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
    drone.health = Math.max(0, drone.health - amount);
    drone.evadeSeconds = Math.max(drone.evadeSeconds, 1.25);
    const destroyed = drone.health <= 0;
    if (destroyed) {
      drone.alive = false;
      drone.state = 'destroyed';
      drone.respawnSeconds = DRONE_TUNING.respawnSeconds;
      drone.velocity.set(0, 0, 0);
      drone.visual.root.visible = false;
      drone.visual.stopContinuousBeam();
      drone.targetOwner = null;
      drone.beamActive = false;
      drone.beamDamageAccumulator = 0;
      drone.beamStartPending = false;
      drone.explosions += 1;
    }
    return { applied: true, destroyed, position: drone.position.clone() };
  }

  damageInRadius(position: THREE.Vector3, radius: number, maxDamage: number): CombatDroneRuntime[] {
    const destroyed: CombatDroneRuntime[] = [];
    for (const drone of this.drones) {
      if (!drone.alive) continue;
      const distance = drone.position.distanceTo(position);
      if (distance >= radius || !this.arena.hasLineOfSight(position, drone.position, drone.collisionRadius * 0.4)) continue;
      const falloff = THREE.MathUtils.clamp(1 - distance / radius, 0, 1);
      if (this.damage(drone, maxDamage * (falloff * 0.3 + falloff * falloff * 0.7)).destroyed) destroyed.push(drone);
    }
    return destroyed;
  }

  resetForQa(center: THREE.Vector3): void {
    for (const drone of this.drones) {
      const angle = drone.index / this.drones.length * Math.PI * 2;
      drone.position.copy(center).add(new THREE.Vector3(Math.cos(angle) * 8, 5.5 + drone.index, Math.sin(angle) * 8));
      drone.velocity.set(-Math.sin(angle) * 2, 0, Math.cos(angle) * 2);
      drone.health = DRONE_TUNING.maxHealth;
      drone.alive = true;
      drone.respawnSeconds = 0;
      drone.beamActive = false;
      drone.beamUptimeSeconds = 0;
      drone.beamDamageTicks = 0;
      drone.beamDamageAccumulator = 0;
      drone.beamStartPending = false;
      drone.targetOwner = null;
      drone.state = 'patrol';
      drone.visual.root.visible = true;
      drone.visual.root.position.copy(drone.position);
      drone.visual.stopContinuousBeam();
    }
  }

  dispose(): void {
    for (const drone of this.drones) drone.visual.dispose();
  }

  private placeSpawn(drone: CombatDroneRuntime): void {
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
    drone.health = DRONE_TUNING.maxHealth;
    drone.alive = true;
    drone.respawnSeconds = 0;
    drone.position.copy(drone.spawnPosition);
    drone.velocity.set(0, 0, 0);
    drone.targetOwner = null;
    drone.state = 'patrol';
    drone.beamActive = false;
    drone.beamDamageAccumulator = 0;
    drone.beamStartPending = false;
    drone.respawns += 1;
    drone.visual.root.visible = true;
    drone.visual.root.position.copy(drone.position);
    drone.visual.stopContinuousBeam();
  }

  private chooseTarget(
    drone: CombatDroneRuntime,
    targets: readonly DroneTargetSnapshot[],
  ): DroneTargetSnapshot | null {
    let best: DroneTargetSnapshot | null = null;
    let bestScore: number = DRONE_TUNING.acquireRange;
    for (const target of targets) {
      if (!target.alive) continue;
      const distance = drone.position.distanceTo(target.position);
      if (distance >= DRONE_TUNING.acquireRange) continue;
      if (!this.arena.hasLineOfSight(drone.position, target.position, 0.35)) continue;
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
    for (const other of this.drones) {
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

  private updateWeapons(
    drone: CombatDroneRuntime,
    target: DroneTargetSnapshot | null,
    delta: number,
    onLaser: (event: DroneLaserEvent) => void,
  ): void {
    const distance = target ? drone.position.distanceTo(target.position) : Number.POSITIVE_INFINITY;
    const visible = target !== null
      && distance <= DRONE_TUNING.fireRange
      && this.arena.hasLineOfSight(drone.position, target.position, 0.35);
    if (!target || !visible) {
      drone.beamActive = false;
      drone.beamDamageAccumulator = 0;
      drone.beamStartPending = false;
      drone.visual.stopContinuousBeam();
      return;
    }

    const started = !drone.beamActive;
    if (started) {
      drone.beamActive = true;
      drone.beamStartPending = true;
      drone.shotsFired += 1;
    }
    drone.beamUptimeSeconds += delta;
    this.laserTargetPoint.copy(target.position).addScaledVector(
      target.velocity,
      Math.min(0.08, distance / 1600),
    );
    drone.visual.beamOriginWorld(this.laserTargetPoint, this.muzzlePosition);
    this.laserToOrigin.subVectors(this.muzzlePosition, this.laserTargetPoint);
    if (this.laserToOrigin.lengthSq() > 1e-6) this.laserToOrigin.normalize();
    this.laserVisualEnd.copy(this.laserTargetPoint).addScaledVector(
      this.laserToOrigin,
      target.owner === 'player' ? 1.6 : 0.55,
    );
    drone.visual.updateContinuousBeam(this.muzzlePosition, this.laserVisualEnd, drone.beamUptimeSeconds);

    drone.beamDamageAccumulator += delta;
    let firstDamageTick = true;
    while (drone.beamDamageAccumulator >= DRONE_TUNING.laserDamageTickSeconds) {
      drone.beamDamageAccumulator -= DRONE_TUNING.laserDamageTickSeconds;
      drone.beamDamageTicks += 1;
      onLaser({
        droneId: drone.id,
        targetOwner: target.owner,
        origin: this.muzzlePosition.clone(),
        hitPoint: this.laserTargetPoint.clone(),
        damage: DRONE_TUNING.laserDps * DRONE_TUNING.laserDamageTickSeconds,
        started: drone.beamStartPending && firstDamageTick,
      });
      drone.beamStartPending = false;
      firstDamageTick = false;
    }
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
