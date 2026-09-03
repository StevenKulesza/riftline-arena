import * as THREE from 'three';
import { FlamethrowerDroneVisual, type FlamethrowerDroneMotionState } from '../entities/FlamethrowerDroneVisual';
import type { ArenaRuntime } from '../game/Arena';
import type { DroneTargetOwner, DroneTargetSnapshot } from './DroneSwarmSystem';
import { droneCanAcquire, GRENADIER_AWARENESS } from './DroneAwareness';

export const FLAMETHROWER_DRONE_TUNING = Object.freeze({
  count: 3,
  maxHealth: 280,
  collisionRadius: 1.48,
  collisionHeight: 3.7,
  patrolSpeed: 5.6,
  stalkSpeed: 8.6,
  acceleration: 25,
  ...GRENADIER_AWARENESS,
  grenadeMinimumRange: 11,
  grenadeMaximumRange: 32,
  grenadeCooldownSeconds: 4.3,
  grenadeWindupSeconds: 0.68,
  grenadeRecoverySeconds: 0.62,
  grenadeFuseSeconds: 2.25,
  jumpAnticipationSeconds: 0.42,
  jumpHorizontalSpeed: 12.5,
  jumpVerticalSpeed: 11.8,
  targetMemorySeconds: 2.6,
  obstacleLookAheadSeconds: 0.42,
  obstacleAvoidanceSeconds: 0.9,
  collisionSkin: 0.08,
  respawnSeconds: 21,
});

export type FlamethrowerDroneRuntime = {
  readonly id: string;
  readonly kind: 'grenadier';
  readonly index: number;
  readonly visual: FlamethrowerDroneVisual;
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly spawnPosition: THREE.Vector3;
  readonly patrolCenter: THREE.Vector3;
  readonly collisionRadius: number;
  readonly maxHealth: number;
  health: number;
  alive: boolean;
  state: FlamethrowerDroneMotionState;
  stateElapsed: number;
  targetOwner: DroneTargetOwner | null;
  targetLostSeconds: number;
  readonly lastSeenPosition: THREE.Vector3;
  fireCooldown: number;
  jumpCooldown: number;
  respawnRemaining: number;
  shotsFired: number;
  jumps: number;
  landings: number;
  distanceWalked: number;
  collisionHits: number;
  readonly avoidanceDirection: THREE.Vector3;
  avoidanceSeconds: number;
  avoidanceActivations: number;
  readonly lastCollisionNormal: THREE.Vector3;
  acquireCooldown: number;
  patrolStep: number;
  forcedTargetOwner: DroneTargetOwner | null;
  forcedTargetSeconds: number;
  forcedTargetSnapshot: DroneTargetSnapshot | null;
};

export type FlamethrowerGrenadeEvent = Readonly<{
  droneId: string;
  targetOwner: DroneTargetOwner;
  origin: THREE.Vector3;
  velocity: THREE.Vector3;
  fuse: number;
}>;

export type FlamethrowerDroneRayHit = {
  drone: FlamethrowerDroneRuntime;
  point: THREE.Vector3;
  distance: number;
};

export type FlamethrowerDroneDamageResult = Readonly<{
  applied: boolean;
  destroyed: boolean;
  position: THREE.Vector3;
}>;

export class FlamethrowerDroneSystem {
  readonly drones: FlamethrowerDroneRuntime[] = [];
  readonly ready: Promise<void>;
  readonly lastGrenadeOrigin = new THREE.Vector3();
  readonly lastGrenadeVelocity = new THREE.Vector3();
  lastGrenadeSourceId = '';
  lastGrenadeTargetOwner: DroneTargetOwner | null = null;
  grenadesLaunched = 0;

  private readonly desired = new THREE.Vector3();
  private readonly steering = new THREE.Vector3();
  private readonly movement = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly muzzle = new THREE.Vector3();
  private readonly awarenessFacing = new THREE.Vector3();
  private readonly awarenessToTarget = new THREE.Vector3();
  private readonly groundProbeStart = new THREE.Vector3();
  private readonly groundProbeEnd = new THREE.Vector3();
  private readonly groundProbeOffset = new THREE.Vector3();
  private readonly groundWallNormal = new THREE.Vector3();
  private readonly groundTangent = new THREE.Vector3();
  private readonly groundCandidate = new THREE.Vector3();
  private readonly groundAlternative = new THREE.Vector3();
  private readonly groundMotion = new THREE.Vector3();
  private readonly groundPrevious = new THREE.Vector3();
  private readonly ray = new THREE.Ray();
  private readonly sphere = new THREE.Sphere();
  private readonly hitPoint = new THREE.Vector3();

  constructor(private readonly scene: THREE.Scene, private readonly arena: ArenaRuntime) {
    const ready: Promise<void>[] = [];
    for (let index = 0; index < FLAMETHROWER_DRONE_TUNING.count; index += 1) {
      const visual = new FlamethrowerDroneVisual(`grenadier-${index + 1}`);
      const spawn = this.chooseSpawn(index);
      const runtime: FlamethrowerDroneRuntime = {
        id: `grenadier-${index + 1}`,
        kind: 'grenadier',
        index,
        visual,
        position: spawn.clone(),
        velocity: new THREE.Vector3(),
        spawnPosition: spawn.clone(),
        patrolCenter: spawn.clone(),
        collisionRadius: FLAMETHROWER_DRONE_TUNING.collisionRadius,
        maxHealth: FLAMETHROWER_DRONE_TUNING.maxHealth,
        health: FLAMETHROWER_DRONE_TUNING.maxHealth,
        alive: true,
        state: 'patrol',
        stateElapsed: 0,
        targetOwner: null,
        targetLostSeconds: 0,
        lastSeenPosition: spawn.clone(),
        fireCooldown: 1.4 + index * 0.55,
        jumpCooldown: 5.5 + index * 1.7,
        respawnRemaining: 0,
        shotsFired: 0,
        jumps: 0,
        landings: 0,
        distanceWalked: 0,
        collisionHits: 0,
        avoidanceDirection: new THREE.Vector3(),
        avoidanceSeconds: 0,
        avoidanceActivations: 0,
        lastCollisionNormal: new THREE.Vector3(),
        acquireCooldown: 0,
        patrolStep: index * 2,
        forcedTargetOwner: null,
        forcedTargetSeconds: 0,
        forcedTargetSnapshot: null,
      };
      visual.root.position.copy(spawn);
      this.scene.add(visual.root);
      this.drones.push(runtime);
      ready.push(visual.ready);
    }
    this.ready = Promise.all(ready).then(() => undefined);
  }

  update(
    delta: number,
    _elapsed: number,
    targets: readonly DroneTargetSnapshot[],
    onGrenade: (event: FlamethrowerGrenadeEvent) => void,
  ): void {
    for (const drone of this.drones) {
      if (!drone.alive) {
        drone.respawnRemaining -= delta;
        if (drone.respawnRemaining <= 0) this.respawn(drone);
        continue;
      }
      drone.stateElapsed += delta;
      drone.fireCooldown = Math.max(0, drone.fireCooldown - delta);
      drone.jumpCooldown = Math.max(0, drone.jumpCooldown - delta);
      drone.forcedTargetSeconds = Math.max(0, drone.forcedTargetSeconds - delta);
      if (drone.forcedTargetSeconds <= 0) {
        drone.forcedTargetOwner = null;
        drone.forcedTargetSnapshot = null;
      }
      drone.avoidanceSeconds = Math.max(0, drone.avoidanceSeconds - delta);
      drone.acquireCooldown -= delta;
      let target: DroneTargetSnapshot | null = null;
      if (drone.acquireCooldown <= 0) {
        const acquired = this.selectTarget(drone, targets);
        if (acquired) {
          target = acquired;
          drone.targetOwner = acquired.owner;
          drone.lastSeenPosition.copy(acquired.position);
          drone.targetLostSeconds = 0;
        }
        drone.acquireCooldown = 0.18 + drone.index * 0.025;
      }
      if (!target && drone.targetOwner !== null && drone.targetLostSeconds <= 0.001) {
        target = targets.find((candidate) => candidate.owner === drone.targetOwner && candidate.alive) ?? null;
      }
      if (!target && drone.targetOwner !== null) {
        drone.targetLostSeconds += delta;
        if (drone.targetLostSeconds > FLAMETHROWER_DRONE_TUNING.targetMemorySeconds) {
          drone.targetOwner = null;
          drone.targetLostSeconds = 0;
        }
      }
      this.updateState(drone, target, delta, onGrenade);
      this.updateMovement(drone, target, delta);
      const horizontalSpeed = Math.hypot(drone.velocity.x, drone.velocity.z);
      this.aim.copy(target?.position ?? drone.velocity).sub(target ? drone.position : new THREE.Vector3());
      drone.visual.update(delta, drone.stateElapsed, drone.state, horizontalSpeed, target ? this.aim : undefined);
      drone.visual.root.position.copy(drone.position);
    }
  }

  nearestVisibleDrone(origin: THREE.Vector3, maxDistance: number): FlamethrowerDroneRuntime | null {
    let nearest: FlamethrowerDroneRuntime | null = null;
    let nearestDistanceSq = maxDistance * maxDistance;
    for (const drone of this.drones) {
      if (!drone.alive) continue;
      const center = this.hitPoint.copy(drone.position).add(new THREE.Vector3(0, 1.8, 0));
      const distanceSq = center.distanceToSquared(origin);
      if (distanceSq >= nearestDistanceSq || !this.arena.hasLineOfSight(origin, center, 0.5)) continue;
      nearest = drone;
      nearestDistanceSq = distanceSq;
    }
    return nearest;
  }

  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number, extraRadius = 0): FlamethrowerDroneRayHit | null {
    this.ray.set(origin, direction);
    let nearest: FlamethrowerDroneRayHit | null = null;
    for (const drone of this.drones) {
      if (!drone.alive) continue;
      this.sphere.set(this.hitPoint.copy(drone.position).add(new THREE.Vector3(0, 1.8, 0)), drone.collisionRadius + extraRadius);
      const point = this.ray.intersectSphere(this.sphere, new THREE.Vector3());
      if (!point) continue;
      const distance = point.distanceTo(origin);
      if (distance > maxDistance || (nearest && distance >= nearest.distance)) continue;
      nearest = { drone, point, distance };
    }
    return nearest;
  }

  raycastSegment(start: THREE.Vector3, end: THREE.Vector3, extraRadius = 0): FlamethrowerDroneRayHit | null {
    const direction = this.aim.subVectors(end, start);
    const distance = direction.length();
    if (distance <= 1e-6) return null;
    return this.raycast(start, direction.multiplyScalar(1 / distance), distance, extraRadius);
  }

  damage(
    drone: FlamethrowerDroneRuntime,
    amount: number,
    attacker: DroneTargetOwner | null = null,
  ): FlamethrowerDroneDamageResult {
    if (!drone.alive || amount <= 0) return { applied: false, destroyed: false, position: drone.position.clone() };
    drone.health = Math.max(0, drone.health - amount);
    drone.visual.flashDamage();
    if (attacker !== null) {
      // A hit is an attention event even when the attacker is behind the
      // drone. The next awareness pass can retain this lock without waiting
      // for the forward cone to sweep back around.
      drone.targetOwner = attacker;
      drone.targetLostSeconds = 0;
      drone.acquireCooldown = 0;
      drone.avoidanceSeconds = Math.max(drone.avoidanceSeconds, 0.65);
    }
    const destroyed = drone.health <= 0;
    if (destroyed) {
      drone.alive = false;
      drone.state = 'destroyed';
      drone.velocity.set(0, 0, 0);
      drone.targetOwner = null;
      drone.avoidanceSeconds = 0;
      drone.lastCollisionNormal.set(0, 0, 0);
      drone.visual.root.visible = false;
      drone.respawnRemaining = FLAMETHROWER_DRONE_TUNING.respawnSeconds;
    }
    return { applied: true, destroyed, position: drone.position.clone().add(new THREE.Vector3(0, 1.7, 0)) };
  }

  resetForQa(center: THREE.Vector3): void {
    this.drones.forEach((drone, index) => {
      const angle = index / this.drones.length * Math.PI * 2;
      const candidate = center.clone().add(new THREE.Vector3(Math.cos(angle) * 13, 0, Math.sin(angle) * 13));
      const safe = this.arena.safeSpawnPoint(candidate, drone.collisionRadius, FLAMETHROWER_DRONE_TUNING.collisionHeight)
        ?? this.chooseSpawn(index);
      drone.spawnPosition.copy(safe);
      drone.patrolCenter.copy(safe);
      this.respawn(drone);
      drone.fireCooldown = 0.5 + index * 0.2;
      drone.jumpCooldown = 1.2 + index * 0.35;
    });
  }

  stageAttackForQa(id: string, target: DroneTargetSnapshot): boolean {
    const drone = this.drones.find((candidate) => candidate.id === id);
    if (!drone || !target.alive) return false;
    let staged: THREE.Vector3 | null = null;
    // Monsoon's capture plaza has a much denser obstacle ring than
    // QuickSense. Search several map-scaled rings so the QA encounter (and
    // any future authored encounter using this helper) never depends on a
    // lucky 20 m patch of walkable ground.
    const stagingRadii = [20, 30, 44, 64, 88, 120];
    const samplesPerRing = 16;
    for (let attempt = 0; attempt < stagingRadii.length * samplesPerRing; attempt += 1) {
      const angle = (attempt % samplesPerRing) / samplesPerRing * Math.PI * 2 + drone.index * 0.37;
      const radius = stagingRadii[Math.floor(attempt / samplesPerRing)];
      const candidate = target.position.clone().add(new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius));
      const safe = this.arena.safeSpawnPoint(candidate, drone.collisionRadius, FLAMETHROWER_DRONE_TUNING.collisionHeight);
      if (!safe) continue;
      const towardTarget = target.position.clone().sub(safe).setY(0);
      if (towardTarget.lengthSq() < 1e-5) continue;
      towardTarget.normalize();
      const muzzle = safe.clone().addScaledVector(towardTarget, 2.18).add(new THREE.Vector3(0, 2.72, 0));
      if (!this.arena.hasLineOfSight(muzzle, target.position, 0.4)) continue;
      const stagedVelocity = new THREE.Vector3();
      const flightTime = this.solveGrenadeVelocity(muzzle, target, stagedVelocity);
      let clearArc = true;
      let previous = muzzle.clone();
      for (let sample = 1; sample <= 14; sample += 1) {
        const time = flightTime * sample / 14;
        const point = muzzle.clone().addScaledVector(stagedVelocity, time);
        point.y -= 0.5 * 25 * time * time;
        if (this.arena.segmentHitDetails(previous, point)) {
          clearArc = false;
          break;
        }
        previous = point;
      }
      if (!clearArc) continue;
      staged = safe;
      break;
    }
    if (!staged) return false;
    drone.position.copy(staged);
    drone.velocity.set(0, 0, 0);
    drone.health = drone.maxHealth;
    drone.alive = true;
    drone.visual.root.visible = true;
    drone.visual.root.position.copy(staged);
    this.aim.subVectors(target.position, staged).setY(0);
    drone.visual.face(this.aim, 1);
    drone.targetOwner = target.owner;
    drone.targetLostSeconds = 0;
    drone.lastSeenPosition.copy(target.position);
    drone.acquireCooldown = 0;
    drone.forcedTargetOwner = target.owner;
    drone.forcedTargetSeconds = 2.2;
    drone.forcedTargetSnapshot = {
      owner: target.owner,
      position: target.position.clone(),
      velocity: target.velocity.clone(),
      alive: true,
    };
    drone.fireCooldown = 0;
    drone.jumpCooldown = 8;
    this.setState(drone, 'attack-windup');
    return true;
  }

  dispose(): void {
    for (const drone of this.drones) drone.visual.dispose();
  }

  private chooseSpawn(index: number): THREE.Vector3 {
    const points = this.arena.spawnPoints;
    const pointIndex = Math.floor((index + 0.5) * points.length / FLAMETHROWER_DRONE_TUNING.count) % points.length;
    const authored = points[pointIndex]?.clone() ?? this.arena.corePosition.clone();
    const safe = this.arena.safeSpawnPoint(authored, FLAMETHROWER_DRONE_TUNING.collisionRadius, FLAMETHROWER_DRONE_TUNING.collisionHeight);
    if (safe) return safe;
    const floor = this.arena.floorHeightAt(authored.x, authored.z, Number.POSITIVE_INFINITY);
    if (floor !== null) authored.y = floor;
    return authored;
  }

  private selectTarget(drone: FlamethrowerDroneRuntime, targets: readonly DroneTargetSnapshot[]): DroneTargetSnapshot | null {
    let nearest: DroneTargetSnapshot | null = null;
    let nearestDistanceSq = Number.POSITIVE_INFINITY;
    drone.visual.muzzleWorld(this.muzzle);
    if (drone.velocity.lengthSq() > 0.04) this.awarenessFacing.copy(drone.velocity);
    else this.awarenessFacing.set(0, 0, -1).applyQuaternion(drone.visual.root.quaternion);
    this.awarenessFacing.y = 0;
    if (this.awarenessFacing.lengthSq() > 0.01) this.awarenessFacing.normalize();
    else this.awarenessFacing.set(0, 0, -1);
    if (drone.forcedTargetOwner !== null) {
      const forced = targets.find((target) => target.owner === drone.forcedTargetOwner && target.alive) ?? null;
      // QA staging already resolved a clear body-to-target lane. Keep that
      // short lock even if the offset launcher socket clips a nearby railing;
      // the grenade's own arena sweep still enforces real world collision.
      if (forced) return forced;
      if (drone.forcedTargetSnapshot) return drone.forcedTargetSnapshot;
    }
    for (const target of targets) {
      if (!target.alive) continue;
      const distance = target.position.distanceTo(drone.position);
      this.awarenessToTarget.subVectors(target.position, drone.position);
      const horizontal = Math.hypot(this.awarenessToTarget.x, this.awarenessToTarget.z);
      const facingDot = horizontal > 0.001
        ? (this.awarenessFacing.x * this.awarenessToTarget.x + this.awarenessFacing.z * this.awarenessToTarget.z)
          / (Math.hypot(this.awarenessFacing.x, this.awarenessFacing.z) * horizontal)
        : 1;
      if (!droneCanAcquire({
        distance,
        acquireRange: FLAMETHROWER_DRONE_TUNING.acquireRange,
        retainRange: FLAMETHROWER_DRONE_TUNING.retainRange,
        proximityRange: FLAMETHROWER_DRONE_TUNING.proximityRange,
        alreadyTargeting: drone.targetOwner === target.owner,
        facingDot,
        acquireDot: FLAMETHROWER_DRONE_TUNING.acquireDot,
        hasLos: this.arena.hasLineOfSight(this.muzzle, target.position, 0.4),
      })) continue;
      const distanceSq = distance * distance;
      if (distanceSq >= nearestDistanceSq) continue;
      nearest = target;
      nearestDistanceSq = distanceSq;
    }
    return nearest;
  }

  private updateState(
    drone: FlamethrowerDroneRuntime,
    target: DroneTargetSnapshot | null,
    delta: number,
    onGrenade: (event: FlamethrowerGrenadeEvent) => void,
  ): void {
    if (drone.state === 'airborne' || drone.state === 'landing' || drone.state === 'jump-anticipation') return;
    if (drone.state === 'attack-windup') {
      if (!target) {
        this.setState(drone, 'patrol');
      } else if (drone.stateElapsed >= FLAMETHROWER_DRONE_TUNING.grenadeWindupSeconds) {
        this.launchGrenade(drone, target, onGrenade);
        this.setState(drone, 'attack-recover');
      }
      return;
    }
    if (drone.state === 'attack-recover') {
      if (drone.stateElapsed >= FLAMETHROWER_DRONE_TUNING.grenadeRecoverySeconds) {
        this.setState(drone, target ? 'stalk' : 'patrol');
      }
      return;
    }
    const hasSearchMemory = !target
      && drone.targetOwner !== null
      && drone.targetLostSeconds <= FLAMETHROWER_DRONE_TUNING.targetMemorySeconds;
    const distance = target ? target.position.distanceTo(drone.position) : Number.POSITIVE_INFINITY;
    if (target && drone.jumpCooldown <= 0 && distance > 9 && distance < 45) {
      this.setState(drone, 'jump-anticipation');
      return;
    }
    const inGrenadeRange = target
      && distance >= FLAMETHROWER_DRONE_TUNING.grenadeMinimumRange
      && distance <= FLAMETHROWER_DRONE_TUNING.grenadeMaximumRange;
    if (inGrenadeRange && drone.fireCooldown <= 0) {
      this.setState(drone, 'attack-windup');
      drone.velocity.multiplyScalar(Math.exp(-delta * 8));
      return;
    }
    this.setState(drone, target || hasSearchMemory ? 'stalk' : 'patrol');
  }

  private updateMovement(drone: FlamethrowerDroneRuntime, target: DroneTargetSnapshot | null, delta: number): void {
    if (drone.state === 'jump-anticipation') {
      drone.velocity.multiplyScalar(Math.exp(-delta * 10));
      if (drone.stateElapsed >= FLAMETHROWER_DRONE_TUNING.jumpAnticipationSeconds) {
        this.movement.copy(target?.position ?? drone.patrolCenter).sub(drone.position).setY(0);
        if (this.movement.lengthSq() < 1e-5) this.movement.set(0, 0, -1);
        this.movement.normalize();
        const flank = drone.index % 2 === 0 ? 1 : -1;
        this.movement.applyAxisAngle(THREE.Object3D.DEFAULT_UP, flank * 0.24);
        drone.velocity.copy(this.movement).multiplyScalar(FLAMETHROWER_DRONE_TUNING.jumpHorizontalSpeed);
        drone.velocity.y = FLAMETHROWER_DRONE_TUNING.jumpVerticalSpeed;
        drone.position.y += 0.08;
        drone.jumps += 1;
        drone.jumpCooldown = 7.5 + drone.index * 1.15;
        this.setState(drone, 'airborne');
      }
      return;
    }
    if (drone.state === 'airborne') {
      drone.velocity.y -= 25 * delta;
      const horizontal = Math.hypot(drone.velocity.x, drone.velocity.z);
      if (horizontal > 0.2) drone.visual.face(drone.velocity, delta);
      drone.position.addScaledVector(drone.velocity, delta);
      const contact = this.arena.resolveCapsule(
        drone.position,
        drone.velocity,
        drone.collisionRadius,
        FLAMETHROWER_DRONE_TUNING.collisionHeight,
      );
      const support = this.arena.floorHeightAt(
        drone.position.x,
        drone.position.z,
        drone.position.y + FLAMETHROWER_DRONE_TUNING.collisionHeight,
      );
      const supportLanding = support !== null && drone.position.y <= support + 0.12 && drone.velocity.y <= 0;
      if ((contact.grounded || supportLanding) && drone.velocity.y <= 0) {
        if (supportLanding) drone.position.y = support;
        drone.velocity.y = 0;
        drone.landings += 1;
        this.setState(drone, 'landing');
      } else if (drone.position.y < this.arena.killY) {
        drone.position.copy(drone.spawnPosition);
        drone.velocity.set(0, 0, 0);
        drone.landings += 1;
        this.setState(drone, 'landing');
      }
      return;
    }
    if (drone.state === 'landing') {
      drone.velocity.multiplyScalar(Math.exp(-delta * 12));
      if (drone.stateElapsed >= 0.32) this.setState(drone, target ? 'stalk' : 'patrol');
      return;
    }
    if (drone.state === 'attack-windup' || drone.state === 'attack-recover') {
      drone.velocity.multiplyScalar(Math.exp(-delta * 8));
      if (target) {
        this.aim.subVectors(target.position, drone.position).setY(0);
        drone.visual.face(this.aim, delta);
      }
      return;
    }

    const hasSearchMemory = !target
      && drone.targetOwner !== null
      && drone.targetLostSeconds <= FLAMETHROWER_DRONE_TUNING.targetMemorySeconds;
    if (target || hasSearchMemory) {
      const targetPosition = target?.position ?? drone.lastSeenPosition;
      this.desired.copy(targetPosition);
      const distance = this.desired.distanceTo(drone.position);
      if (distance < 19) {
        this.movement.subVectors(drone.position, targetPosition).setY(0);
        if (this.movement.lengthSq() > 1e-5) this.desired.copy(drone.position).addScaledVector(this.movement.normalize(), 12);
      }
    } else {
      const angle = drone.patrolStep * 1.93 + drone.index * 2.1;
      this.desired.copy(drone.patrolCenter).add(new THREE.Vector3(Math.cos(angle) * 17, 0, Math.sin(angle) * 17));
      if (drone.position.distanceToSquared(this.desired) < 5) drone.patrolStep += 1;
    }
    const speed = target || hasSearchMemory
      ? FLAMETHROWER_DRONE_TUNING.stalkSpeed
      : FLAMETHROWER_DRONE_TUNING.patrolSpeed;
    this.movement.subVectors(this.desired, drone.position).setY(0);
    if (this.movement.lengthSq() > 1e-5) this.movement.normalize().multiplyScalar(speed);
    this.steering.subVectors(this.movement, drone.velocity).setY(0);
    if (this.steering.length() > FLAMETHROWER_DRONE_TUNING.acceleration) {
      this.steering.setLength(FLAMETHROWER_DRONE_TUNING.acceleration);
    }
    drone.velocity.addScaledVector(this.steering, delta);
    this.applyGroundObstacleAvoidance(drone, speed, delta);
    this.groundPrevious.copy(drone.position);
    drone.position.addScaledVector(drone.velocity, delta);
    const contact = this.arena.resolveCapsule(
      drone.position,
      drone.velocity,
      drone.collisionRadius,
      FLAMETHROWER_DRONE_TUNING.collisionHeight,
    );
    if (contact.wallContact) {
      drone.collisionHits += 1;
      this.groundWallNormal.copy(contact.wallNormal).setY(0);
      if (this.groundWallNormal.lengthSq() > 0.04) {
        this.groundWallNormal.normalize();
        drone.lastCollisionNormal.copy(this.groundWallNormal);
        drone.position.addScaledVector(
          this.groundWallNormal,
          FLAMETHROWER_DRONE_TUNING.collisionSkin,
        );
        this.groundTangent.copy(drone.velocity)
          .addScaledVector(this.groundWallNormal, -drone.velocity.dot(this.groundWallNormal))
          .setY(0);
        if (this.groundTangent.lengthSq() < 0.25) {
          this.chooseGroundAvoidance(drone, this.groundWallNormal, speed);
          this.groundTangent.copy(drone.avoidanceDirection).multiplyScalar(speed * 0.72);
        } else {
          this.groundTangent.normalize().multiplyScalar(Math.min(speed, this.groundTangent.length()));
          drone.avoidanceDirection.copy(this.groundTangent).normalize();
          drone.avoidanceSeconds = Math.max(
            drone.avoidanceSeconds,
            FLAMETHROWER_DRONE_TUNING.obstacleAvoidanceSeconds,
          );
        }
        drone.velocity.x = this.groundTangent.x;
        drone.velocity.z = this.groundTangent.z;
      }
    }
    this.enforceGroundBounds(drone, speed);
    drone.distanceWalked += this.groundPrevious.distanceTo(drone.position);
    if (drone.velocity.lengthSq() > 0.2) drone.visual.face(drone.velocity, delta);
  }

  /** Bias before contact, then turn along the wall after capsule resolution. */
  private applyGroundObstacleAvoidance(
    drone: FlamethrowerDroneRuntime,
    speed: number,
    delta: number,
  ): void {
    this.groundMotion.copy(drone.velocity).setY(0);
    if (this.groundMotion.lengthSq() < 0.04) return;
    this.groundMotion.normalize();
    const probeDistance = Math.max(
      drone.collisionRadius * 2.2,
      speed * FLAMETHROWER_DRONE_TUNING.obstacleLookAheadSeconds,
    );
    this.groundProbeStart.set(
      drone.position.x,
      drone.position.y + FLAMETHROWER_DRONE_TUNING.collisionHeight * 0.48,
      drone.position.z,
    );
    this.groundProbeEnd.copy(this.groundProbeStart).addScaledVector(this.groundMotion, probeDistance);
    this.groundWallNormal.set(0, 0, 0);
    let nearestDistance = Number.POSITIVE_INFINITY;
    const probeOffsets = [
      [0, 0],
      [drone.collisionRadius * 0.72, 0],
      [-drone.collisionRadius * 0.72, 0],
      [0, drone.collisionRadius * 0.72],
      [0, -drone.collisionRadius * 0.72],
    ];
    for (const [offsetX, offsetZ] of probeOffsets) {
      this.groundProbeOffset.set(offsetX, 0, offsetZ);
      const hit = this.arena.movementSegmentHitDetails(
        this.groundProbeStart.clone().add(this.groundProbeOffset),
        this.groundProbeEnd.clone().add(this.groundProbeOffset),
      );
      if (!hit || hit.distance >= nearestDistance) continue;
      nearestDistance = hit.distance;
      this.groundWallNormal.copy(hit.normal).setY(0);
    }
    if (this.groundWallNormal.lengthSq() < 0.04) {
      if (drone.avoidanceSeconds <= 0) return;
      this.groundMotion.copy(drone.avoidanceDirection).setY(0);
      if (this.groundMotion.lengthSq() < 0.04) return;
      this.groundMotion.normalize();
      this.groundTangent.setLength(0);
      drone.velocity.lerp(
        this.groundMotion.multiplyScalar(speed),
        1 - Math.exp(-delta * 8),
      );
      drone.velocity.y = 0;
      return;
    }
    this.groundWallNormal.normalize();
    drone.lastCollisionNormal.copy(this.groundWallNormal);
    this.chooseGroundAvoidance(drone, this.groundWallNormal, speed);
    drone.velocity.lerp(
      this.groundMotion.copy(drone.avoidanceDirection).multiplyScalar(speed * 0.92),
      1 - Math.exp(-delta * 12),
    );
    drone.velocity.y = 0;
  }

  private chooseGroundAvoidance(
    drone: FlamethrowerDroneRuntime,
    wallNormal: THREE.Vector3,
    speed: number,
  ): void {
    this.groundCandidate.set(-wallNormal.z, 0, wallNormal.x).normalize();
    this.groundAlternative.copy(this.groundCandidate).multiplyScalar(-1);
    const towardDesired = this.groundMotion.copy(this.movement).setY(0);
    const first = drone.index % 2 === 0 ? this.groundCandidate : this.groundAlternative;
    const second = drone.index % 2 === 0 ? this.groundAlternative : this.groundCandidate;
    const firstScore = first.dot(towardDesired);
    const secondScore = second.dot(towardDesired);
    drone.avoidanceDirection.copy(firstScore >= secondScore ? first : second);
    drone.avoidanceSeconds = Math.max(
      drone.avoidanceSeconds,
      FLAMETHROWER_DRONE_TUNING.obstacleAvoidanceSeconds,
    );
    drone.avoidanceActivations += 1;
    drone.velocity.x = drone.avoidanceDirection.x * Math.max(3.5, speed * 0.72);
    drone.velocity.z = drone.avoidanceDirection.z * Math.max(3.5, speed * 0.72);
  }

  private enforceGroundBounds(drone: FlamethrowerDroneRuntime, speed: number): void {
    const maxX = this.arena.mapInfo.bounds.width * 0.47 - drone.collisionRadius;
    const maxZ = this.arena.mapInfo.bounds.depth * 0.47 - drone.collisionRadius;
    if (drone.position.x < -maxX) {
      drone.position.x = -maxX;
      drone.velocity.x = Math.max(2.5, speed * 0.45);
      drone.lastCollisionNormal.set(1, 0, 0);
      drone.avoidanceDirection.set(0, 0, drone.index % 2 === 0 ? 1 : -1);
      drone.avoidanceSeconds = Math.max(drone.avoidanceSeconds, FLAMETHROWER_DRONE_TUNING.obstacleAvoidanceSeconds);
    } else if (drone.position.x > maxX) {
      drone.position.x = maxX;
      drone.velocity.x = -Math.max(2.5, speed * 0.45);
      drone.lastCollisionNormal.set(-1, 0, 0);
      drone.avoidanceDirection.set(0, 0, drone.index % 2 === 0 ? 1 : -1);
      drone.avoidanceSeconds = Math.max(drone.avoidanceSeconds, FLAMETHROWER_DRONE_TUNING.obstacleAvoidanceSeconds);
    }
    if (drone.position.z < -maxZ) {
      drone.position.z = -maxZ;
      drone.velocity.z = Math.max(2.5, speed * 0.45);
      drone.lastCollisionNormal.set(0, 0, 1);
      drone.avoidanceDirection.set(drone.index % 2 === 0 ? 1 : -1, 0, 0);
      drone.avoidanceSeconds = Math.max(drone.avoidanceSeconds, FLAMETHROWER_DRONE_TUNING.obstacleAvoidanceSeconds);
    } else if (drone.position.z > maxZ) {
      drone.position.z = maxZ;
      drone.velocity.z = -Math.max(2.5, speed * 0.45);
      drone.lastCollisionNormal.set(0, 0, -1);
      drone.avoidanceDirection.set(drone.index % 2 === 0 ? 1 : -1, 0, 0);
      drone.avoidanceSeconds = Math.max(drone.avoidanceSeconds, FLAMETHROWER_DRONE_TUNING.obstacleAvoidanceSeconds);
    }
  }

  private launchGrenade(
    drone: FlamethrowerDroneRuntime,
    target: DroneTargetSnapshot,
    onGrenade: (event: FlamethrowerGrenadeEvent) => void,
  ): void {
    drone.visual.muzzleWorld(this.muzzle);
    const flightTime = this.solveGrenadeVelocity(this.muzzle, target, this.movement);
    onGrenade({
      droneId: drone.id,
      targetOwner: target.owner,
      origin: this.muzzle.clone(),
      velocity: this.movement.clone(),
      // Airburst at the predicted intercept. The wind-up plus flight provides
      // the dodge window; delaying the fuse after arrival lets a sloped floor
      // bounce an otherwise accurate grenade harmlessly past its target.
      fuse: Math.min(
        FLAMETHROWER_DRONE_TUNING.grenadeFuseSeconds,
        THREE.MathUtils.clamp(flightTime, 0.72, 2.25),
      ),
    });
    this.lastGrenadeSourceId = drone.id;
    this.lastGrenadeTargetOwner = target.owner;
    this.lastGrenadeOrigin.copy(this.muzzle);
    this.lastGrenadeVelocity.copy(this.movement);
    this.grenadesLaunched += 1;
    drone.shotsFired += 1;
    drone.fireCooldown = FLAMETHROWER_DRONE_TUNING.grenadeCooldownSeconds + drone.index * 0.24;
  }

  private solveGrenadeVelocity(
    origin: THREE.Vector3,
    target: DroneTargetSnapshot,
    out: THREE.Vector3,
  ): number {
    const horizontalDistance = Math.hypot(target.position.x - origin.x, target.position.z - origin.z);
    const verticalDrop = Math.max(0, origin.y - target.position.y);
    const minimumUpwardArcTime = Math.sqrt(verticalDrop * 2 / 25) + 0.24;
    const flightTime = THREE.MathUtils.clamp(
      Math.max(horizontalDistance / 25, minimumUpwardArcTime),
      0.72,
      FLAMETHROWER_DRONE_TUNING.grenadeFuseSeconds,
    );
    this.desired.copy(target.position).addScaledVector(target.velocity, flightTime * 0.58);
    out.set(
      (this.desired.x - origin.x) / flightTime,
      (this.desired.y - origin.y + 0.5 * 25 * flightTime * flightTime) / flightTime,
      (this.desired.z - origin.z) / flightTime,
    );
    return flightTime;
  }

  private setState(drone: FlamethrowerDroneRuntime, state: FlamethrowerDroneMotionState): void {
    if (drone.state === state) return;
    drone.state = state;
    drone.stateElapsed = 0;
  }

  private respawn(drone: FlamethrowerDroneRuntime): void {
    drone.position.copy(drone.spawnPosition);
    drone.velocity.set(0, 0, 0);
    drone.health = drone.maxHealth;
    drone.alive = true;
    drone.state = 'patrol';
    drone.stateElapsed = 0;
    drone.targetOwner = null;
    drone.targetLostSeconds = 0;
    drone.lastSeenPosition.copy(drone.position);
    drone.acquireCooldown = 0;
    drone.avoidanceDirection.set(0, 0, 0);
    drone.avoidanceSeconds = 0;
    drone.avoidanceActivations = 0;
    drone.lastCollisionNormal.set(0, 0, 0);
    drone.forcedTargetOwner = null;
    drone.forcedTargetSeconds = 0;
    drone.forcedTargetSnapshot = null;
    drone.fireCooldown = 1.2 + drone.index * 0.4;
    drone.jumpCooldown = 4.8 + drone.index * 1.2;
    drone.respawnRemaining = 0;
    drone.visual.root.visible = true;
    drone.visual.root.position.copy(drone.position);
  }
}
