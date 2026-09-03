/**
 * Adapter-friendly Star Sparrow pilot policy.
 *
 * This module owns decisions only. Vehicle physics, damage, projectiles,
 * animation, boarding, pad docking, and respawn remain authoritative in their
 * respective systems. The controller consumes read-only snapshots and emits a
 * reusable intent object, so it can be integrated without importing Game or a
 * concrete fighter implementation.
 */

export type FighterAiEntityId = string | number;
export type FighterAiTeamId = string | number;
export type FighterAiDifficulty = 'easy' | 'normal' | 'hard' | 'expert';

export type FighterAiState =
  | 'ground_idle'
  | 'seek_fighter'
  | 'claim_fighter'
  | 'approach_fighter'
  | 'enter_fighter'
  | 'launch'
  | 'patrol'
  | 'engage'
  | 'evade'
  | 'return_to_pad'
  | 'land'
  | 'abandon'
  | 'dead';

export type FighterAiTransitionReason =
  | 'initialized'
  | 'actor_dead'
  | 'actor_respawned'
  | 'fighter_not_useful'
  | 'fighter_useful'
  | 'candidate_found'
  | 'no_candidate'
  | 'claim_accepted'
  | 'claim_denied'
  | 'claim_expired'
  | 'approach_timeout'
  | 'at_canopy'
  | 'boarded'
  | 'boarding_failed'
  | 'launch_complete'
  | 'target_acquired'
  | 'target_lost'
  | 'incoming_threat'
  | 'threat_clear'
  | 'low_hull'
  | 'pad_selected'
  | 'at_pad_approach'
  | 'landed'
  | 'vehicle_destroyed'
  | 'vehicle_missing'
  | 'pilot_displaced'
  | 'abandon_complete';

export interface FighterAiVector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface FighterAiActorSnapshot {
  readonly id: FighterAiEntityId;
  readonly teamId: FighterAiTeamId;
  readonly alive: boolean;
  readonly canUseFighters: boolean;
  readonly position: FighterAiVector3;
  readonly velocity: FighterAiVector3;
  readonly currentVehicleId: FighterAiEntityId | null;
}

export type FighterAiVehiclePhase = 'parked' | 'launching' | 'airborne' | 'landing' | 'destroyed';

export interface FighterAiVehicleSnapshot {
  readonly id: FighterAiEntityId;
  readonly teamId: FighterAiTeamId | null;
  /** Integration-level availability flag (not locked, repairing, or scripted). */
  readonly available: boolean;
  readonly destroyed: boolean;
  readonly phase: FighterAiVehiclePhase;
  readonly position: FighterAiVector3;
  readonly velocity: FighterAiVector3;
  /** Normalized local basis vectors supplied by the vehicle adapter. */
  readonly forward: FighterAiVector3;
  readonly right: FighterAiVector3;
  readonly up: FighterAiVector3;
  readonly pilotId: FighterAiEntityId | null;
  readonly reservedBy: FighterAiEntityId | null;
  readonly hull: number;
  readonly maxHull: number;
  readonly primaryReady: boolean;
  readonly secondaryReady: boolean;
  readonly secondaryAmmo: number;
  readonly homePadId: FighterAiEntityId | null;
}

export interface FighterAiTargetSnapshot {
  readonly id: FighterAiEntityId;
  readonly teamId: FighterAiTeamId;
  readonly alive: boolean;
  readonly targetable: boolean;
  /** Must be false until this target is legitimately available to AI sensors. */
  readonly sensorVisible: boolean;
  readonly airborne: boolean;
  readonly threat: number;
  readonly radius: number;
  readonly position: FighterAiVector3;
  readonly velocity: FighterAiVector3;
}

export interface FighterAiIncomingThreatSnapshot {
  readonly id: FighterAiEntityId;
  /** Prevents dodging projectiles that the AI has not legitimately detected. */
  readonly sensorVisible: boolean;
  readonly position: FighterAiVector3;
  readonly velocity: FighterAiVector3;
  readonly timeToImpact: number;
  readonly severity: number;
}

export interface FighterAiPadSnapshot {
  readonly id: FighterAiEntityId;
  readonly teamId: FighterAiTeamId | null;
  readonly enabled: boolean;
  readonly occupiedBy: FighterAiEntityId | null;
  readonly position: FighterAiVector3;
  /** Authored safe point above/in front of the pad. */
  readonly approachPosition: FighterAiVector3;
}

export interface FighterAiTacticalContext {
  readonly allowFighterUse: boolean;
  /** 0..1 signal from the objective director: air threat, travel need, or vehicle objective. */
  readonly fighterDemand: number;
  readonly patrolCenter: FighterAiVector3;
  /** Optional overrides let each map author the flight envelope without changing policy. */
  readonly patrolRadius?: number;
  readonly patrolAltitude?: number;
}

export interface FighterAiWorldQuery {
  terrainHeightAt(x: number, z: number): number;
  hasLineOfSight(
    fromX: number,
    fromY: number,
    fromZ: number,
    toX: number,
    toY: number,
    toZ: number,
  ): boolean;
  /** Optional fog/team/sensor query. It is combined with target.sensorVisible. */
  canObserveTarget?(observerId: FighterAiEntityId, targetId: FighterAiEntityId): boolean;
  /** Optional structure-aware corridor test in addition to terrain sampling. */
  isFlightPathClear?(
    fromX: number,
    fromY: number,
    fromZ: number,
    toX: number,
    toY: number,
    toZ: number,
    clearance: number,
  ): boolean;
}

export interface FighterAiUpdateInput {
  readonly deltaSeconds: number;
  readonly actor: FighterAiActorSnapshot;
  readonly vehicles: readonly FighterAiVehicleSnapshot[];
  readonly targets: readonly FighterAiTargetSnapshot[];
  readonly incomingThreats: readonly FighterAiIncomingThreatSnapshot[];
  readonly pads: readonly FighterAiPadSnapshot[];
  readonly context: FighterAiTacticalContext;
  readonly world: FighterAiWorldQuery;
}

/**
 * Commands are deliberately explicit. A host may ignore a command it cannot
 * currently satisfy, but claim/enter/dock/exit/respawn should be processed
 * idempotently. The same object is reused on every update; copy it if retained.
 */
export interface FighterAiIntent {
  readonly state: FighterAiState;
  readonly controlledVehicleId: FighterAiEntityId | null;
  readonly groundMoveX: number;
  readonly groundMoveZ: number;
  readonly groundSprint: boolean;
  readonly groundTargetX: number;
  readonly groundTargetY: number;
  readonly groundTargetZ: number;
  readonly claimVehicleId: FighterAiEntityId | null;
  readonly claimLeaseSeconds: number;
  readonly releaseVehicleId: FighterAiEntityId | null;
  readonly enterVehicleId: FighterAiEntityId | null;
  readonly exitVehicle: boolean;
  readonly throttle: number;
  readonly pitch: number;
  readonly yaw: number;
  readonly roll: number;
  readonly brake: number;
  readonly boost: boolean;
  readonly landingGear: boolean;
  readonly hasAimPoint: boolean;
  readonly aimX: number;
  readonly aimY: number;
  readonly aimZ: number;
  readonly firePrimary: boolean;
  readonly fireSecondary: boolean;
  readonly dockAtPadId: FighterAiEntityId | null;
  /** Persistent until acknowledgeVehicleRespawn() or a healthy vehicle is observed. */
  readonly requestVehicleRespawnId: FighterAiEntityId | null;
}

type MutableIntent = { -readonly [Key in keyof FighterAiIntent]: FighterAiIntent[Key] };

export interface FighterAiTuning {
  readonly difficulty: FighterAiDifficulty;
  readonly reactionSeconds: number;
  readonly threatReactionSeconds: number;
  readonly aimErrorDegrees: number;
  readonly aimRefreshSeconds: number;
  readonly targetMemorySeconds: number;
  readonly sensorRange: number;
  readonly fighterDemandThreshold: number;
  readonly minimumUsableHullRatio: number;
  readonly lowHullReturnRatio: number;
  readonly claimTimeoutSeconds: number;
  readonly reservationLeaseSeconds: number;
  readonly approachTimeoutSeconds: number;
  readonly enterDistance: number;
  readonly enterHoldSeconds: number;
  readonly minimumLaunchSeconds: number;
  readonly launchClearance: number;
  readonly patrolRadius: number;
  readonly patrolAltitude: number;
  readonly patrolAngularSpeed: number;
  readonly preferredRange: number;
  readonly disengageRange: number;
  readonly primaryRange: number;
  readonly primaryProjectileSpeed: number;
  readonly primaryCooldownSeconds: number;
  readonly primaryAlignmentDegrees: number;
  readonly secondaryMinRange: number;
  readonly secondaryRange: number;
  readonly secondaryProjectileSpeed: number;
  readonly secondaryCooldownSeconds: number;
  readonly secondaryLockSeconds: number;
  readonly secondaryAlignmentDegrees: number;
  readonly maxLeadSeconds: number;
  readonly evadeTimeToImpact: number;
  readonly evadeSeverityThreshold: number;
  readonly evadeDurationSeconds: number;
  readonly terrainLookAheadSeconds: number;
  readonly minimumTerrainClearance: number;
  readonly landingDistance: number;
  readonly dockingDistance: number;
}

export type FighterAiTuningOverrides = Readonly<Partial<Omit<FighterAiTuning, 'difficulty'>>>;

export interface FighterAiSnapshot {
  readonly pilotId: FighterAiEntityId;
  readonly difficulty: FighterAiDifficulty;
  readonly state: FighterAiState;
  readonly transitionReason: FighterAiTransitionReason;
  readonly transitionCount: number;
  readonly simulationSeconds: number;
  readonly stateSeconds: number;
  readonly vehicleId: FighterAiEntityId | null;
  readonly targetId: FighterAiEntityId | null;
  readonly padId: FighterAiEntityId | null;
  readonly respawnVehicleId: FighterAiEntityId | null;
  readonly reservationSecondsRemaining: number;
  readonly targetVisibleSeconds: number;
  readonly targetLostSeconds: number;
  readonly reactionSecondsRequired: number;
  readonly sensedThreatId: FighterAiEntityId | null;
  readonly threatVisibleSeconds: number;
  readonly threatReactionSecondsRequired: number;
  readonly aimErrorDegrees: number;
  readonly aimSampleIndex: number;
  readonly secondaryLockSecondsRequired: number;
  readonly primaryCooldownSeconds: number;
  readonly secondaryCooldownSeconds: number;
  readonly hullRatio: number;
}

type DifficultyBase = Readonly<{
  reactionSeconds: number;
  threatReactionSeconds: number;
  aimErrorDegrees: number;
  aimRefreshSeconds: number;
  primaryCooldownSeconds: number;
  secondaryCooldownSeconds: number;
  fighterDemandThreshold: number;
}>;

const DIFFICULTY: Readonly<Record<FighterAiDifficulty, DifficultyBase>> = Object.freeze({
  easy: Object.freeze({
    reactionSeconds: 0.78,
    threatReactionSeconds: 0.34,
    aimErrorDegrees: 6.4,
    aimRefreshSeconds: 0.52,
    primaryCooldownSeconds: 0.24,
    secondaryCooldownSeconds: 5.4,
    fighterDemandThreshold: 0.56,
  }),
  normal: Object.freeze({
    reactionSeconds: 0.5,
    threatReactionSeconds: 0.25,
    aimErrorDegrees: 4.1,
    aimRefreshSeconds: 0.42,
    primaryCooldownSeconds: 0.18,
    secondaryCooldownSeconds: 4.5,
    fighterDemandThreshold: 0.48,
  }),
  hard: Object.freeze({
    reactionSeconds: 0.34,
    threatReactionSeconds: 0.19,
    aimErrorDegrees: 2.6,
    aimRefreshSeconds: 0.34,
    primaryCooldownSeconds: 0.15,
    secondaryCooldownSeconds: 3.9,
    fighterDemandThreshold: 0.42,
  }),
  expert: Object.freeze({
    reactionSeconds: 0.24,
    threatReactionSeconds: 0.15,
    aimErrorDegrees: 1.65,
    aimRefreshSeconds: 0.28,
    primaryCooldownSeconds: 0.13,
    secondaryCooldownSeconds: 3.5,
    fighterDemandThreshold: 0.38,
  }),
});

const DEG_TO_RAD = Math.PI / 180;
const MAX_AI_DELTA_SECONDS = 0.1;
const EPSILON = 0.000001;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? value as number : fallback;
}

function sameId(a: FighterAiEntityId | null, b: FighterAiEntityId | null): boolean {
  return a === b;
}

/** Stable FNV-1a hash used for per-pilot personality, aim samples, and tie breaks. */
export function hashFighterAiId(id: FighterAiEntityId): number {
  const value = typeof id === 'number' ? `${Math.trunc(id)}` : id;
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hashMix(a: number, b: number, c: number): number {
  let value = (a ^ Math.imul(b + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(c + 0x27d4eb2f, 0xc2b2ae35)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  value ^= value >>> 16;
  return value >>> 0;
}

function signedHash(hash: number): number {
  return (hash / 0xffffffff) * 2 - 1;
}

function finitePositive(value: number | undefined, fallback: number, minimum = EPSILON): number {
  return Math.max(minimum, finiteOr(value, fallback));
}

function freezeTuning(tuning: FighterAiTuning): FighterAiTuning {
  return Object.freeze(tuning);
}

/**
 * Builds deterministic difficulty tuning with a small stable-id personality
 * band. Pilots differ by at most +/-8%; difficulty remains the dominant axis.
 */
export function createFighterAiTuning(
  difficulty: FighterAiDifficulty,
  pilotId: FighterAiEntityId,
  overrides: FighterAiTuningOverrides = {},
): FighterAiTuning {
  const resolvedDifficulty = Object.prototype.hasOwnProperty.call(DIFFICULTY, difficulty) ? difficulty : 'normal';
  const base = DIFFICULTY[resolvedDifficulty];
  const idHash = hashFighterAiId(pilotId);
  const personality = 0.92 + ((idHash & 0xffff) / 0xffff) * 0.16;
  const inversePersonality = 2 - personality;

  return freezeTuning({
    difficulty: resolvedDifficulty,
    reactionSeconds: finitePositive(overrides.reactionSeconds, base.reactionSeconds * personality, 0.1),
    threatReactionSeconds: finitePositive(overrides.threatReactionSeconds, base.threatReactionSeconds * personality, 0.08),
    aimErrorDegrees: clamp(finiteOr(overrides.aimErrorDegrees, base.aimErrorDegrees * inversePersonality), 0.75, 9),
    aimRefreshSeconds: finitePositive(overrides.aimRefreshSeconds, base.aimRefreshSeconds, 0.1),
    targetMemorySeconds: finitePositive(overrides.targetMemorySeconds, 1.5, 0.2),
    sensorRange: finitePositive(overrides.sensorRange, 190, 20),
    fighterDemandThreshold: clamp(finiteOr(overrides.fighterDemandThreshold, base.fighterDemandThreshold), 0, 1),
    minimumUsableHullRatio: clamp(finiteOr(overrides.minimumUsableHullRatio, 0.48), 0.1, 1),
    lowHullReturnRatio: clamp(finiteOr(overrides.lowHullReturnRatio, 0.26), 0.05, 0.9),
    claimTimeoutSeconds: finitePositive(overrides.claimTimeoutSeconds, 1.4, 0.2),
    reservationLeaseSeconds: finitePositive(overrides.reservationLeaseSeconds, 2.5, 0.5),
    approachTimeoutSeconds: finitePositive(overrides.approachTimeoutSeconds, 18, 2),
    enterDistance: finitePositive(overrides.enterDistance, 2.2, 0.25),
    enterHoldSeconds: finitePositive(overrides.enterHoldSeconds, 0.24, 0),
    minimumLaunchSeconds: finitePositive(overrides.minimumLaunchSeconds, 1.15, 0),
    launchClearance: finitePositive(overrides.launchClearance, 14, 2),
    patrolRadius: finitePositive(overrides.patrolRadius, 46, 8),
    patrolAltitude: finitePositive(overrides.patrolAltitude, 30, 5),
    patrolAngularSpeed: finitePositive(overrides.patrolAngularSpeed, 0.17, 0.02),
    preferredRange: finitePositive(overrides.preferredRange, 48, 8),
    disengageRange: finitePositive(overrides.disengageRange, 210, 40),
    primaryRange: finitePositive(overrides.primaryRange, 145, 20),
    primaryProjectileSpeed: finitePositive(overrides.primaryProjectileSpeed, 175, 20),
    primaryCooldownSeconds: finitePositive(overrides.primaryCooldownSeconds, base.primaryCooldownSeconds, 0.08),
    primaryAlignmentDegrees: clamp(finiteOr(overrides.primaryAlignmentDegrees, 7), 1, 30),
    secondaryMinRange: finitePositive(overrides.secondaryMinRange, 28, 0),
    secondaryRange: finitePositive(overrides.secondaryRange, 125, 20),
    secondaryProjectileSpeed: finitePositive(overrides.secondaryProjectileSpeed, 95, 10),
    secondaryCooldownSeconds: finitePositive(overrides.secondaryCooldownSeconds, base.secondaryCooldownSeconds, 0.5),
    secondaryLockSeconds: finitePositive(overrides.secondaryLockSeconds, 0.85, 0.2),
    secondaryAlignmentDegrees: clamp(finiteOr(overrides.secondaryAlignmentDegrees, 4.5), 0.5, 20),
    maxLeadSeconds: finitePositive(overrides.maxLeadSeconds, 2.3, 0.1),
    evadeTimeToImpact: finitePositive(overrides.evadeTimeToImpact, 1.25, 0.1),
    evadeSeverityThreshold: clamp(finiteOr(overrides.evadeSeverityThreshold, 0.35), 0, 1),
    evadeDurationSeconds: finitePositive(overrides.evadeDurationSeconds, 1.1, 0.2),
    terrainLookAheadSeconds: finitePositive(overrides.terrainLookAheadSeconds, 1.25, 0.2),
    minimumTerrainClearance: finitePositive(overrides.minimumTerrainClearance, 8, 1),
    landingDistance: finitePositive(overrides.landingDistance, 11, 2),
    dockingDistance: finitePositive(overrides.dockingDistance, 2.8, 0.5),
  });
}

export function fighterHullRatio(vehicle: FighterAiVehicleSnapshot): number {
  return vehicle.maxHull > EPSILON ? clamp(vehicle.hull / vehicle.maxHull, 0, 1) : 0;
}

/** Pure reservation eligibility helper for adapters and tests. */
export function canClaimFighter(
  actor: FighterAiActorSnapshot,
  vehicle: FighterAiVehicleSnapshot,
  minimumHullRatio = 0,
): boolean {
  if (!actor.alive || !actor.canUseFighters || actor.currentVehicleId !== null) return false;
  if (!vehicle.available || vehicle.destroyed || vehicle.phase !== 'parked') return false;
  if (vehicle.pilotId !== null && !sameId(vehicle.pilotId, actor.id)) return false;
  if (vehicle.reservedBy !== null && !sameId(vehicle.reservedBy, actor.id)) return false;
  if (vehicle.teamId !== null && vehicle.teamId !== actor.teamId) return false;
  return fighterHullRatio(vehicle) >= minimumHullRatio;
}

/** Selects the nearest eligible vehicle without allocating candidate records. */
export function selectNearestAvailableFighter(
  actor: FighterAiActorSnapshot,
  vehicles: readonly FighterAiVehicleSnapshot[],
  minimumHullRatio = 0,
): FighterAiVehicleSnapshot | null {
  let best: FighterAiVehicleSnapshot | null = null;
  let bestDistanceSquared = Number.POSITIVE_INFINITY;
  let bestStableId = Number.MAX_SAFE_INTEGER;

  for (let index = 0; index < vehicles.length; index += 1) {
    const vehicle = vehicles[index];
    if (!canClaimFighter(actor, vehicle, minimumHullRatio)) continue;
    const dx = vehicle.position.x - actor.position.x;
    const dy = vehicle.position.y - actor.position.y;
    const dz = vehicle.position.z - actor.position.z;
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    const stableId = hashFighterAiId(vehicle.id);
    if (distanceSquared < bestDistanceSquared - EPSILON
      || (Math.abs(distanceSquared - bestDistanceSquared) <= EPSILON && stableId < bestStableId)) {
      best = vehicle;
      bestDistanceSquared = distanceSquared;
      bestStableId = stableId;
    }
  }
  return best;
}

type ReservationEntry = {
  readonly pilotId: FighterAiEntityId;
  expiresAtSimulationSeconds: number;
};

/**
 * Optional atomic reservation helper. Time is always caller-owned simulation
 * time; there is no Date.now/performance.now dependency.
 */
export class FighterReservationBook {
  private readonly entries = new Map<FighterAiEntityId, ReservationEntry>();

  tryClaim(
    vehicleId: FighterAiEntityId,
    pilotId: FighterAiEntityId,
    simulationSeconds: number,
    leaseSeconds: number,
  ): boolean {
    const now = Math.max(0, finiteOr(simulationSeconds, 0));
    const existing = this.entries.get(vehicleId);
    if (existing && existing.expiresAtSimulationSeconds > now && !sameId(existing.pilotId, pilotId)) return false;
    const expiresAt = now + finitePositive(leaseSeconds, 1, 0.05);
    if (existing && sameId(existing.pilotId, pilotId)) {
      existing.expiresAtSimulationSeconds = expiresAt;
    } else {
      this.entries.set(vehicleId, { pilotId, expiresAtSimulationSeconds: expiresAt });
    }
    return true;
  }

  ownerOf(vehicleId: FighterAiEntityId, simulationSeconds: number): FighterAiEntityId | null {
    const existing = this.entries.get(vehicleId);
    if (!existing) return null;
    if (existing.expiresAtSimulationSeconds <= Math.max(0, finiteOr(simulationSeconds, 0))) {
      this.entries.delete(vehicleId);
      return null;
    }
    return existing.pilotId;
  }

  secondsRemaining(vehicleId: FighterAiEntityId, simulationSeconds: number): number {
    const existing = this.entries.get(vehicleId);
    if (!existing) return 0;
    return Math.max(0, existing.expiresAtSimulationSeconds - Math.max(0, finiteOr(simulationSeconds, 0)));
  }

  release(vehicleId: FighterAiEntityId, pilotId: FighterAiEntityId): boolean {
    const existing = this.entries.get(vehicleId);
    if (!existing || !sameId(existing.pilotId, pilotId)) return false;
    this.entries.delete(vehicleId);
    return true;
  }

  releaseAllForPilot(pilotId: FighterAiEntityId): number {
    let released = 0;
    for (const [vehicleId, entry] of this.entries) {
      if (!sameId(entry.pilotId, pilotId)) continue;
      this.entries.delete(vehicleId);
      released += 1;
    }
    return released;
  }

  pruneExpired(simulationSeconds: number): number {
    const now = Math.max(0, finiteOr(simulationSeconds, 0));
    let pruned = 0;
    for (const [vehicleId, entry] of this.entries) {
      if (entry.expiresAtSimulationSeconds > now) continue;
      this.entries.delete(vehicleId);
      pruned += 1;
    }
    return pruned;
  }

  clear(): void {
    this.entries.clear();
  }
}

export class FighterAiPilotController {
  readonly pilotId: FighterAiEntityId;
  readonly tuning: FighterAiTuning;

  private readonly pilotHash: number;
  private readonly patrolDirection: number;
  private readonly intent: MutableIntent;
  private state: FighterAiState = 'seek_fighter';
  private transitionReason: FighterAiTransitionReason = 'initialized';
  private transitionCount = 0;
  private simulationSeconds = 0;
  private stateSeconds = 0;
  private targetVisibleSeconds = 0;
  private targetLostSeconds = 0;
  private threatVisibleSeconds = 0;
  private primaryCooldownSeconds = 0;
  private secondaryCooldownSeconds = 0;
  private aimSampleSeconds = 0;
  private aimSampleIndex = 0;
  private boardingSeconds = 0;
  private reservationSecondsRemaining = 0;
  private hullRatio = 1;
  private targetVehicleId: FighterAiEntityId | null = null;
  private combatTargetId: FighterAiEntityId | null = null;
  private returnPadId: FighterAiEntityId | null = null;
  private respawnVehicleId: FighterAiEntityId | null = null;
  private evadeThreatId: FighterAiEntityId | null = null;
  private sensedThreatId: FighterAiEntityId | null = null;
  private evadeSign = 1;

  constructor(
    pilotId: FighterAiEntityId,
    difficulty: FighterAiDifficulty = 'normal',
    overrides: FighterAiTuningOverrides = {},
  ) {
    this.pilotId = pilotId;
    this.pilotHash = hashFighterAiId(pilotId);
    this.patrolDirection = (this.pilotHash & 1) === 0 ? 1 : -1;
    this.tuning = createFighterAiTuning(difficulty, pilotId, overrides);
    this.intent = {
      state: this.state,
      controlledVehicleId: null,
      groundMoveX: 0,
      groundMoveZ: 0,
      groundSprint: false,
      groundTargetX: 0,
      groundTargetY: 0,
      groundTargetZ: 0,
      claimVehicleId: null,
      claimLeaseSeconds: 0,
      releaseVehicleId: null,
      enterVehicleId: null,
      exitVehicle: false,
      throttle: 0,
      pitch: 0,
      yaw: 0,
      roll: 0,
      brake: 0,
      boost: false,
      landingGear: false,
      hasAimPoint: false,
      aimX: 0,
      aimY: 0,
      aimZ: 0,
      firePrimary: false,
      fireSecondary: false,
      dockAtPadId: null,
      requestVehicleRespawnId: null,
    };
  }

  update(input: FighterAiUpdateInput): FighterAiIntent {
    const delta = clamp(finiteOr(input.deltaSeconds, 0), 0, MAX_AI_DELTA_SECONDS);
    this.simulationSeconds += delta;
    this.stateSeconds += delta;
    this.primaryCooldownSeconds = Math.max(0, this.primaryCooldownSeconds - delta);
    this.secondaryCooldownSeconds = Math.max(0, this.secondaryCooldownSeconds - delta);
    this.reservationSecondsRemaining = Math.max(0, this.reservationSecondsRemaining - delta);
    this.resetIntent(input.actor.currentVehicleId);

    if (this.respawnVehicleId !== null) {
      const respawned = this.findVehicle(input.vehicles, this.respawnVehicleId);
      if (respawned && !respawned.destroyed && respawned.phase !== 'destroyed') this.respawnVehicleId = null;
    }
    this.intent.requestVehicleRespawnId = this.respawnVehicleId;

    if (!input.actor.alive) {
      this.handleActorDead(input);
      this.finishIntent();
      return this.intent;
    }
    if (this.state === 'dead') this.transition('ground_idle', 'actor_respawned');

    switch (this.state) {
      case 'ground_idle':
        this.updateGroundIdle(input);
        break;
      case 'seek_fighter':
        this.updateSeek(input);
        break;
      case 'claim_fighter':
        this.updateClaim(input);
        break;
      case 'approach_fighter':
        this.updateApproach(input);
        break;
      case 'enter_fighter':
        this.updateEnter(input);
        break;
      case 'launch':
        this.updateLaunch(input);
        break;
      case 'patrol':
        this.updatePatrol(input);
        break;
      case 'engage':
        this.updateEngage(input);
        break;
      case 'evade':
        this.updateEvade(input);
        break;
      case 'return_to_pad':
        this.updateReturn(input);
        break;
      case 'land':
        this.updateLand(input);
        break;
      case 'abandon':
        this.updateAbandon(input);
        break;
      case 'dead':
        break;
    }

    this.intent.requestVehicleRespawnId = this.respawnVehicleId;
    this.finishIntent();
    return this.intent;
  }

  /** Clears a persistent, externally handled respawn request. */
  acknowledgeVehicleRespawn(vehicleId: FighterAiEntityId): void {
    if (sameId(this.respawnVehicleId, vehicleId)) this.respawnVehicleId = null;
  }

  /** Allocating diagnostic path; never called from update(). */
  snapshot(): FighterAiSnapshot {
    return Object.freeze({
      pilotId: this.pilotId,
      difficulty: this.tuning.difficulty,
      state: this.state,
      transitionReason: this.transitionReason,
      transitionCount: this.transitionCount,
      simulationSeconds: this.simulationSeconds,
      stateSeconds: this.stateSeconds,
      vehicleId: this.targetVehicleId,
      targetId: this.combatTargetId,
      padId: this.returnPadId,
      respawnVehicleId: this.respawnVehicleId,
      reservationSecondsRemaining: this.reservationSecondsRemaining,
      targetVisibleSeconds: this.targetVisibleSeconds,
      targetLostSeconds: this.targetLostSeconds,
      reactionSecondsRequired: this.tuning.reactionSeconds,
      sensedThreatId: this.sensedThreatId,
      threatVisibleSeconds: this.threatVisibleSeconds,
      threatReactionSecondsRequired: this.tuning.threatReactionSeconds,
      aimErrorDegrees: this.tuning.aimErrorDegrees,
      aimSampleIndex: this.aimSampleIndex,
      secondaryLockSecondsRequired: this.tuning.secondaryLockSeconds,
      primaryCooldownSeconds: this.primaryCooldownSeconds,
      secondaryCooldownSeconds: this.secondaryCooldownSeconds,
      hullRatio: this.hullRatio,
    });
  }

  private resetIntent(controlledVehicleId: FighterAiEntityId | null): void {
    this.intent.state = this.state;
    this.intent.controlledVehicleId = controlledVehicleId;
    this.intent.groundMoveX = 0;
    this.intent.groundMoveZ = 0;
    this.intent.groundSprint = false;
    this.intent.groundTargetX = 0;
    this.intent.groundTargetY = 0;
    this.intent.groundTargetZ = 0;
    this.intent.claimVehicleId = null;
    this.intent.claimLeaseSeconds = 0;
    this.intent.releaseVehicleId = null;
    this.intent.enterVehicleId = null;
    this.intent.exitVehicle = false;
    this.intent.throttle = 0;
    this.intent.pitch = 0;
    this.intent.yaw = 0;
    this.intent.roll = 0;
    this.intent.brake = 0;
    this.intent.boost = false;
    this.intent.landingGear = false;
    this.intent.hasAimPoint = false;
    this.intent.aimX = 0;
    this.intent.aimY = 0;
    this.intent.aimZ = 0;
    this.intent.firePrimary = false;
    this.intent.fireSecondary = false;
    this.intent.dockAtPadId = null;
    this.intent.requestVehicleRespawnId = this.respawnVehicleId;
  }

  private finishIntent(): void {
    this.intent.state = this.state;
    this.intent.pitch = clamp(this.intent.pitch, -1, 1);
    this.intent.yaw = clamp(this.intent.yaw, -1, 1);
    this.intent.roll = clamp(this.intent.roll, -1, 1);
    this.intent.throttle = clamp(this.intent.throttle, 0, 1);
    this.intent.brake = clamp(this.intent.brake, 0, 1);
  }

  private transition(state: FighterAiState, reason: FighterAiTransitionReason): void {
    if (this.state === state) return;
    this.state = state;
    this.transitionReason = reason;
    this.transitionCount += 1;
    this.stateSeconds = 0;
    if (state !== 'engage') {
      this.targetVisibleSeconds = 0;
      this.targetLostSeconds = 0;
    }
    if (state !== 'enter_fighter') this.boardingSeconds = 0;
  }

  private handleActorDead(input: FighterAiUpdateInput): void {
    if (this.state !== 'dead') {
      if (this.targetVehicleId !== null) this.intent.releaseVehicleId = this.targetVehicleId;
      const vehicle = this.currentVehicle(input);
      if (vehicle?.destroyed || vehicle?.phase === 'destroyed') this.markVehicleDestroyed(vehicle.id);
      this.transition('dead', 'actor_dead');
      this.targetVehicleId = null;
      this.combatTargetId = null;
      this.returnPadId = null;
      this.reservationSecondsRemaining = 0;
    }
    this.intent.exitVehicle = input.actor.currentVehicleId !== null;
  }

  private updateGroundIdle(input: FighterAiUpdateInput): void {
    if (input.actor.currentVehicleId !== null) {
      this.targetVehicleId = input.actor.currentVehicleId;
      this.transition('launch', 'boarded');
      return;
    }
    if (this.fighterIsUseful(input)) this.transition('seek_fighter', 'fighter_useful');
  }

  private updateSeek(input: FighterAiUpdateInput): void {
    if (input.actor.currentVehicleId !== null) {
      this.targetVehicleId = input.actor.currentVehicleId;
      this.transition('launch', 'boarded');
      return;
    }
    if (!this.fighterIsUseful(input)) {
      this.transition('ground_idle', 'fighter_not_useful');
      return;
    }
    const vehicle = selectNearestAvailableFighter(input.actor, input.vehicles, this.tuning.minimumUsableHullRatio);
    if (!vehicle) {
      this.transition('ground_idle', 'no_candidate');
      return;
    }
    this.targetVehicleId = vehicle.id;
    this.reservationSecondsRemaining = this.tuning.reservationLeaseSeconds;
    this.emitClaim(vehicle.id);
    this.transition('claim_fighter', 'candidate_found');
  }

  private updateClaim(input: FighterAiUpdateInput): void {
    const vehicle = this.findVehicle(input.vehicles, this.targetVehicleId);
    if (!vehicle || !canClaimFighter(input.actor, vehicle, this.tuning.minimumUsableHullRatio)) {
      const heldByOther = vehicle?.reservedBy !== null && !sameId(vehicle?.reservedBy ?? null, this.pilotId);
      this.dropVehicleClaim(heldByOther ? 'claim_denied' : 'vehicle_missing');
      return;
    }
    this.emitClaim(vehicle.id);
    if (sameId(vehicle.reservedBy, this.pilotId)) {
      this.reservationSecondsRemaining = this.tuning.reservationLeaseSeconds;
      this.transition('approach_fighter', 'claim_accepted');
      return;
    }
    if (this.stateSeconds >= this.tuning.claimTimeoutSeconds) this.dropVehicleClaim('claim_expired');
  }

  private updateApproach(input: FighterAiUpdateInput): void {
    const vehicle = this.findVehicle(input.vehicles, this.targetVehicleId);
    if (!vehicle || vehicle.destroyed) {
      this.dropVehicleClaim(vehicle?.destroyed ? 'vehicle_destroyed' : 'vehicle_missing');
      if (vehicle?.destroyed) this.markVehicleDestroyed(vehicle.id);
      return;
    }
    if (vehicle.reservedBy !== null && !sameId(vehicle.reservedBy, this.pilotId)) {
      this.dropVehicleClaim('claim_denied');
      return;
    }
    this.emitClaim(vehicle.id);
    this.reservationSecondsRemaining = this.tuning.reservationLeaseSeconds;
    this.moveActorToward(input.actor, vehicle.position);
    const distanceSquared = this.distanceSquared(input.actor.position, vehicle.position);
    if (distanceSquared <= this.tuning.enterDistance * this.tuning.enterDistance) {
      this.transition('enter_fighter', 'at_canopy');
      return;
    }
    if (this.stateSeconds >= this.tuning.approachTimeoutSeconds) this.dropVehicleClaim('approach_timeout');
  }

  private updateEnter(input: FighterAiUpdateInput): void {
    if (input.actor.currentVehicleId !== null && sameId(input.actor.currentVehicleId, this.targetVehicleId)) {
      this.reservationSecondsRemaining = 0;
      this.transition('launch', 'boarded');
      return;
    }
    const vehicle = this.findVehicle(input.vehicles, this.targetVehicleId);
    if (!vehicle || vehicle.destroyed) {
      this.dropVehicleClaim(vehicle?.destroyed ? 'vehicle_destroyed' : 'vehicle_missing');
      if (vehicle?.destroyed) this.markVehicleDestroyed(vehicle.id);
      return;
    }
    if (vehicle.pilotId !== null && !sameId(vehicle.pilotId, this.pilotId)) {
      this.dropVehicleClaim('claim_denied');
      return;
    }
    if (this.distanceSquared(input.actor.position, vehicle.position) > this.tuning.enterDistance * this.tuning.enterDistance * 2.25) {
      this.transition('approach_fighter', 'boarding_failed');
      return;
    }
    this.emitClaim(vehicle.id);
    this.reservationSecondsRemaining = this.tuning.reservationLeaseSeconds;
    this.boardingSeconds += clamp(finiteOr(input.deltaSeconds, 0), 0, MAX_AI_DELTA_SECONDS);
    if (this.boardingSeconds >= this.tuning.enterHoldSeconds) this.intent.enterVehicleId = vehicle.id;
  }

  private updateLaunch(input: FighterAiUpdateInput): void {
    const vehicle = this.requirePilotedVehicle(input);
    if (!vehicle || this.checkLowHull(vehicle)) return;
    const terrain = input.world.terrainHeightAt(vehicle.position.x, vehicle.position.z);
    const targetY = Math.max(
      terrain + this.tuning.launchClearance,
      input.context.patrolCenter.y + this.tuning.launchClearance,
    );
    this.steerToward(input, vehicle, vehicle.position.x + vehicle.forward.x * 30, targetY, vehicle.position.z + vehicle.forward.z * 30, 1, false);
    this.intent.boost = this.stateSeconds >= 0.4;
    const safelyAirborne = vehicle.phase === 'airborne'
      && vehicle.position.y >= terrain + this.tuning.minimumTerrainClearance;
    if (safelyAirborne && this.stateSeconds >= this.tuning.minimumLaunchSeconds) {
      const target = this.selectCombatTarget(input, vehicle);
      if (target) {
        this.acquireTarget(target.id);
        this.transition('engage', 'target_acquired');
      } else {
        this.transition('patrol', 'launch_complete');
      }
    }
  }

  private updatePatrol(input: FighterAiUpdateInput): void {
    const vehicle = this.requirePilotedVehicle(input);
    if (!vehicle || this.checkLowHull(vehicle)) return;
    const threat = this.selectIncomingThreat(input, vehicle);
    if (this.threatReactionReady(threat, input.deltaSeconds)) {
      this.beginEvade(threat, vehicle);
      return;
    }
    const target = this.selectCombatTarget(input, vehicle);
    if (target) {
      this.acquireTarget(target.id);
      this.transition('engage', 'target_acquired');
      return;
    }

    const radius = finitePositive(input.context.patrolRadius, this.tuning.patrolRadius, 8);
    const altitude = finitePositive(input.context.patrolAltitude, this.tuning.patrolAltitude, 5);
    const phase = (this.pilotHash % 6283) / 1000;
    const angle = phase + this.simulationSeconds * this.tuning.patrolAngularSpeed * this.patrolDirection;
    const targetX = input.context.patrolCenter.x + Math.cos(angle) * radius;
    const targetZ = input.context.patrolCenter.z + Math.sin(angle) * radius;
    const terrain = input.world.terrainHeightAt(targetX, targetZ);
    const targetY = Math.max(input.context.patrolCenter.y + altitude, terrain + this.tuning.minimumTerrainClearance);
    this.steerToward(input, vehicle, targetX, targetY, targetZ, 0.72, false);
  }

  private updateEngage(input: FighterAiUpdateInput): void {
    const vehicle = this.requirePilotedVehicle(input);
    if (!vehicle || this.checkLowHull(vehicle)) return;
    const threat = this.selectIncomingThreat(input, vehicle);
    if (this.threatReactionReady(threat, input.deltaSeconds)) {
      this.beginEvade(threat, vehicle);
      return;
    }

    const target = this.findTarget(input.targets, this.combatTargetId);
    if (!target || !target.alive || !target.targetable || target.teamId === input.actor.teamId) {
      this.combatTargetId = null;
      this.transition('patrol', 'target_lost');
      return;
    }
    const dx = target.position.x - vehicle.position.x;
    const dy = target.position.y - vehicle.position.y;
    const dz = target.position.z - vehicle.position.z;
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    const distance = Math.sqrt(distanceSquared);
    if (distance > this.tuning.disengageRange) {
      this.combatTargetId = null;
      this.transition('patrol', 'target_lost');
      return;
    }

    const observable = this.targetIsObservable(input, target);
    const lineOfSight = observable && input.world.hasLineOfSight(
      vehicle.position.x,
      vehicle.position.y,
      vehicle.position.z,
      target.position.x,
      target.position.y,
      target.position.z,
    );
    const delta = clamp(finiteOr(input.deltaSeconds, 0), 0, MAX_AI_DELTA_SECONDS);
    if (observable) {
      this.targetVisibleSeconds += delta;
      this.targetLostSeconds = 0;
    } else {
      this.targetLostSeconds += delta;
      this.targetVisibleSeconds = Math.max(0, this.targetVisibleSeconds - delta * 2);
      if (this.targetLostSeconds >= this.tuning.targetMemorySeconds) {
        this.combatTargetId = null;
        this.transition('patrol', 'target_lost');
        return;
      }
    }

    this.aimSampleSeconds += delta;
    if (this.aimSampleSeconds >= this.tuning.aimRefreshSeconds) {
      this.aimSampleSeconds -= this.tuning.aimRefreshSeconds;
      this.aimSampleIndex += 1;
    }
    this.writeLeadAim(vehicle, target, this.tuning.primaryProjectileSpeed, distance);
    this.steerToward(input, vehicle, this.intent.aimX, this.intent.aimY, this.intent.aimZ, distance > this.tuning.preferredRange ? 0.9 : 0.54, false);
    this.intent.hasAimPoint = observable;

    if (!observable || !lineOfSight || this.targetVisibleSeconds < this.tuning.reactionSeconds) return;
    const alignment = this.aimAlignment(vehicle);
    const primaryAlignment = Math.cos(this.tuning.primaryAlignmentDegrees * DEG_TO_RAD);
    if (distance <= this.tuning.primaryRange
      && alignment >= primaryAlignment
      && vehicle.primaryReady
      && this.primaryCooldownSeconds <= 0) {
      this.intent.firePrimary = true;
      this.primaryCooldownSeconds = this.tuning.primaryCooldownSeconds;
    }

    const secondaryAlignment = Math.cos(this.tuning.secondaryAlignmentDegrees * DEG_TO_RAD);
    const hasSecondaryLock = this.targetVisibleSeconds >= this.tuning.reactionSeconds + this.tuning.secondaryLockSeconds;
    if (hasSecondaryLock
      && distance >= this.tuning.secondaryMinRange
      && distance <= this.tuning.secondaryRange
      && alignment >= secondaryAlignment
      && vehicle.secondaryReady
      && vehicle.secondaryAmmo > 0
      && this.secondaryCooldownSeconds <= 0) {
      this.writeLeadAim(vehicle, target, this.tuning.secondaryProjectileSpeed, distance);
      this.intent.fireSecondary = true;
      this.secondaryCooldownSeconds = this.tuning.secondaryCooldownSeconds;
    }
  }

  private updateEvade(input: FighterAiUpdateInput): void {
    const vehicle = this.requirePilotedVehicle(input);
    if (!vehicle || this.checkLowHull(vehicle)) return;
    const threat = this.selectIncomingThreat(input, vehicle);
    const stillThreatened = threat !== null && sameId(threat.id, this.evadeThreatId);
    const side = this.evadeSign;
    const targetX = vehicle.position.x
      + vehicle.forward.x * 26
      + vehicle.right.x * side * 38
      + vehicle.up.x * 16;
    const targetY = vehicle.position.y
      + vehicle.forward.y * 26
      + vehicle.right.y * side * 38
      + vehicle.up.y * 16;
    const targetZ = vehicle.position.z
      + vehicle.forward.z * 26
      + vehicle.right.z * side * 38
      + vehicle.up.z * 16;
    this.steerToward(input, vehicle, targetX, targetY, targetZ, 1, false);
    this.intent.boost = true;

    if (!stillThreatened && this.stateSeconds >= this.tuning.evadeDurationSeconds) {
      this.evadeThreatId = null;
      const target = this.findTarget(input.targets, this.combatTargetId);
      this.transition(target?.alive ? 'engage' : 'patrol', 'threat_clear');
    }
  }

  private updateReturn(input: FighterAiUpdateInput): void {
    const vehicle = this.requirePilotedVehicle(input);
    if (!vehicle) return;
    let pad = this.findPad(input.pads, this.returnPadId);
    if (!pad || !this.padIsUsable(pad, input.actor.teamId, vehicle.id)) {
      pad = this.selectReturnPad(input, vehicle);
      this.returnPadId = pad?.id ?? null;
    }
    if (!pad) {
      const terrain = input.world.terrainHeightAt(input.context.patrolCenter.x, input.context.patrolCenter.z);
      this.steerToward(
        input,
        vehicle,
        input.context.patrolCenter.x,
        Math.max(input.context.patrolCenter.y + this.tuning.patrolAltitude, terrain + this.tuning.minimumTerrainClearance),
        input.context.patrolCenter.z,
        0.55,
        false,
      );
      this.applyReturnThreatEvasion(input, vehicle);
      return;
    }

    const distanceSquared = this.distanceSquared(vehicle.position, pad.approachPosition);
    this.steerToward(
      input,
      vehicle,
      pad.approachPosition.x,
      pad.approachPosition.y,
      pad.approachPosition.z,
      0.58,
      false,
    );
    this.intent.landingGear = true;
    this.applyReturnThreatEvasion(input, vehicle);
    if (distanceSquared <= this.tuning.landingDistance * this.tuning.landingDistance) {
      this.transition('land', 'at_pad_approach');
    }
  }

  private updateLand(input: FighterAiUpdateInput): void {
    const vehicle = this.requirePilotedVehicle(input);
    if (!vehicle) return;
    const pad = this.findPad(input.pads, this.returnPadId);
    if (!pad || !this.padIsUsable(pad, input.actor.teamId, vehicle.id)) {
      this.transition('return_to_pad', 'pad_selected');
      return;
    }
    this.steerToward(input, vehicle, pad.position.x, pad.position.y, pad.position.z, 0.24, true);
    this.intent.landingGear = true;
    this.intent.brake = 0.72;
    const distanceSquared = this.distanceSquared(vehicle.position, pad.position);
    if (distanceSquared <= this.tuning.dockingDistance * this.tuning.dockingDistance) {
      this.intent.dockAtPadId = pad.id;
      this.intent.brake = 1;
    }
    if (vehicle.phase === 'parked') {
      this.intent.exitVehicle = true;
      this.transition('abandon', 'landed');
    }
  }

  private updateAbandon(input: FighterAiUpdateInput): void {
    if (input.actor.currentVehicleId !== null) {
      this.intent.exitVehicle = true;
      return;
    }
    if (this.targetVehicleId !== null) this.intent.releaseVehicleId = this.targetVehicleId;
    this.targetVehicleId = null;
    this.combatTargetId = null;
    this.returnPadId = null;
    this.reservationSecondsRemaining = 0;
    this.transition(this.fighterIsUseful(input) ? 'seek_fighter' : 'ground_idle', 'abandon_complete');
  }

  private requirePilotedVehicle(input: FighterAiUpdateInput): FighterAiVehicleSnapshot | null {
    const vehicle = this.currentVehicle(input);
    if (!vehicle) {
      this.transition('abandon', 'vehicle_missing');
      return null;
    }
    this.targetVehicleId = vehicle.id;
    this.hullRatio = fighterHullRatio(vehicle);
    if (vehicle.destroyed || vehicle.phase === 'destroyed') {
      this.markVehicleDestroyed(vehicle.id);
      this.intent.exitVehicle = true;
      this.transition('abandon', 'vehicle_destroyed');
      return null;
    }
    if (!sameId(vehicle.pilotId, this.pilotId) && !sameId(input.actor.currentVehicleId, vehicle.id)) {
      this.transition('abandon', 'pilot_displaced');
      return null;
    }
    this.intent.controlledVehicleId = vehicle.id;
    return vehicle;
  }

  private checkLowHull(vehicle: FighterAiVehicleSnapshot): boolean {
    this.hullRatio = fighterHullRatio(vehicle);
    if (this.hullRatio > this.tuning.lowHullReturnRatio) return false;
    this.combatTargetId = null;
    this.returnPadId = vehicle.homePadId;
    this.transition('return_to_pad', 'low_hull');
    return true;
  }

  private beginEvade(threat: FighterAiIncomingThreatSnapshot, vehicle: FighterAiVehicleSnapshot): void {
    this.evadeThreatId = threat.id;
    const relativeX = threat.position.x - vehicle.position.x;
    const relativeY = threat.position.y - vehicle.position.y;
    const relativeZ = threat.position.z - vehicle.position.z;
    const sideDot = relativeX * vehicle.right.x + relativeY * vehicle.right.y + relativeZ * vehicle.right.z;
    this.evadeSign = Math.abs(sideDot) > 0.1 ? (sideDot >= 0 ? -1 : 1) : ((hashMix(this.pilotHash, hashFighterAiId(threat.id), this.transitionCount) & 1) === 0 ? 1 : -1);
    this.transition('evade', 'incoming_threat');
  }

  private threatReactionReady(
    threat: FighterAiIncomingThreatSnapshot | null,
    deltaSeconds: number,
  ): threat is FighterAiIncomingThreatSnapshot {
    if (!threat) {
      this.sensedThreatId = null;
      this.threatVisibleSeconds = 0;
      return false;
    }
    if (!sameId(this.sensedThreatId, threat.id)) {
      this.sensedThreatId = threat.id;
      this.threatVisibleSeconds = 0;
    }
    this.threatVisibleSeconds += clamp(finiteOr(deltaSeconds, 0), 0, MAX_AI_DELTA_SECONDS);
    return this.threatVisibleSeconds >= this.tuning.threatReactionSeconds;
  }

  private applyReturnThreatEvasion(input: FighterAiUpdateInput, vehicle: FighterAiVehicleSnapshot): void {
    const threat = this.selectIncomingThreat(input, vehicle);
    if (!this.threatReactionReady(threat, input.deltaSeconds)) return;
    const relativeX = threat.position.x - vehicle.position.x;
    const relativeY = threat.position.y - vehicle.position.y;
    const relativeZ = threat.position.z - vehicle.position.z;
    const sideDot = relativeX * vehicle.right.x + relativeY * vehicle.right.y + relativeZ * vehicle.right.z;
    const side = Math.abs(sideDot) > 0.1
      ? (sideDot >= 0 ? -1 : 1)
      : ((hashMix(this.pilotHash, hashFighterAiId(threat.id), this.transitionCount) & 1) === 0 ? 1 : -1);
    this.intent.yaw = side;
    this.intent.roll = -side;
    this.intent.pitch = Math.max(this.intent.pitch, 0.35);
    this.intent.throttle = Math.max(this.intent.throttle, 0.82);
    this.intent.boost = true;
  }

  private fighterIsUseful(input: FighterAiUpdateInput): boolean {
    return input.context.allowFighterUse
      && input.actor.canUseFighters
      && clamp(finiteOr(input.context.fighterDemand, 0), 0, 1) >= this.tuning.fighterDemandThreshold;
  }

  private emitClaim(vehicleId: FighterAiEntityId): void {
    this.intent.claimVehicleId = vehicleId;
    this.intent.claimLeaseSeconds = this.tuning.reservationLeaseSeconds;
  }

  private dropVehicleClaim(reason: FighterAiTransitionReason): void {
    if (this.targetVehicleId !== null) this.intent.releaseVehicleId = this.targetVehicleId;
    this.targetVehicleId = null;
    this.reservationSecondsRemaining = 0;
    this.transition('seek_fighter', reason);
  }

  private markVehicleDestroyed(vehicleId: FighterAiEntityId): void {
    this.respawnVehicleId = vehicleId;
    this.intent.requestVehicleRespawnId = vehicleId;
    this.intent.releaseVehicleId = vehicleId;
    this.reservationSecondsRemaining = 0;
  }

  private moveActorToward(actor: FighterAiActorSnapshot, target: FighterAiVector3): void {
    const dx = target.x - actor.position.x;
    const dz = target.z - actor.position.z;
    const length = Math.sqrt(dx * dx + dz * dz);
    if (length > EPSILON) {
      this.intent.groundMoveX = dx / length;
      this.intent.groundMoveZ = dz / length;
    }
    this.intent.groundSprint = length > this.tuning.enterDistance * 2;
    this.intent.groundTargetX = target.x;
    this.intent.groundTargetY = target.y;
    this.intent.groundTargetZ = target.z;
  }

  private steerToward(
    input: FighterAiUpdateInput,
    vehicle: FighterAiVehicleSnapshot,
    targetX: number,
    targetY: number,
    targetZ: number,
    throttle: number,
    landing: boolean,
  ): void {
    let dx = targetX - vehicle.position.x;
    let dy = targetY - vehicle.position.y;
    let dz = targetZ - vehicle.position.z;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length > EPSILON) {
      dx /= length;
      dy /= length;
      dz /= length;
    }
    const yaw = dx * vehicle.right.x + dy * vehicle.right.y + dz * vehicle.right.z;
    const pitch = dx * vehicle.up.x + dy * vehicle.up.y + dz * vehicle.up.z;
    // The flight model supplies coordinated bank and slip damping. AI only
    // needs a measured steering request; the old saturated values caused
    // oscillating S-turns when a target crossed the nose.
    this.intent.yaw = yaw * 1.45;
    this.intent.pitch = pitch * 1.35;
    this.intent.roll = -yaw * 0.86;
    this.intent.throttle = throttle;

    const speed = Math.sqrt(
      vehicle.velocity.x * vehicle.velocity.x
      + vehicle.velocity.y * vehicle.velocity.y
      + vehicle.velocity.z * vehicle.velocity.z,
    );
    const lookAhead = Math.max(12, speed * this.tuning.terrainLookAheadSeconds);
    const probeX = vehicle.position.x + vehicle.forward.x * lookAhead;
    const probeZ = vehicle.position.z + vehicle.forward.z * lookAhead;
    const predictedY = vehicle.position.y + vehicle.velocity.y * this.tuning.terrainLookAheadSeconds;
    const safeY = input.world.terrainHeightAt(probeX, probeZ) + this.tuning.minimumTerrainClearance;
    if (!landing && predictedY < safeY) {
      const urgency = clamp((safeY - predictedY) / this.tuning.minimumTerrainClearance, 0, 1);
      this.intent.pitch = Math.max(this.intent.pitch, 0.5 + urgency * 0.5);
      this.intent.throttle = Math.min(this.intent.throttle, 0.82);
      this.intent.boost = urgency > 0.45;
    }

    const pathClear = input.world.isFlightPathClear?.(
      vehicle.position.x,
      vehicle.position.y,
      vehicle.position.z,
      probeX,
      Math.max(predictedY, safeY),
      probeZ,
      this.tuning.minimumTerrainClearance * 0.5,
    );
    if (pathClear === false && !landing) {
      const avoidSign = this.patrolDirection;
      this.intent.yaw = avoidSign;
      this.intent.roll = -avoidSign;
      this.intent.pitch = Math.max(this.intent.pitch, 0.55);
      this.intent.throttle = Math.min(this.intent.throttle, 0.7);
    }
  }

  private writeLeadAim(
    vehicle: FighterAiVehicleSnapshot,
    target: FighterAiTargetSnapshot,
    projectileSpeed: number,
    distance: number,
  ): void {
    const rx = target.position.x - vehicle.position.x;
    const ry = target.position.y - vehicle.position.y;
    const rz = target.position.z - vehicle.position.z;
    const vx = target.velocity.x - vehicle.velocity.x;
    const vy = target.velocity.y - vehicle.velocity.y;
    const vz = target.velocity.z - vehicle.velocity.z;
    const speedSquared = projectileSpeed * projectileSpeed;
    const a = vx * vx + vy * vy + vz * vz - speedSquared;
    const b = 2 * (rx * vx + ry * vy + rz * vz);
    const c = rx * rx + ry * ry + rz * rz;
    let interceptSeconds = projectileSpeed > EPSILON ? distance / projectileSpeed : 0;
    if (Math.abs(a) > EPSILON) {
      const discriminant = b * b - 4 * a * c;
      if (discriminant >= 0) {
        const root = Math.sqrt(discriminant);
        const first = (-b - root) / (2 * a);
        const second = (-b + root) / (2 * a);
        if (first > EPSILON && second > EPSILON) interceptSeconds = Math.min(first, second);
        else if (first > EPSILON) interceptSeconds = first;
        else if (second > EPSILON) interceptSeconds = second;
      }
    } else if (Math.abs(b) > EPSILON) {
      const linear = -c / b;
      if (linear > EPSILON) interceptSeconds = linear;
    }
    interceptSeconds = clamp(interceptSeconds, 0, this.tuning.maxLeadSeconds);

    const targetHash = hashFighterAiId(target.id);
    const errorScale = Math.tan(this.tuning.aimErrorDegrees * DEG_TO_RAD) * Math.max(distance, target.radius);
    const horizontalError = signedHash(hashMix(this.pilotHash, targetHash, this.aimSampleIndex * 2)) * errorScale;
    const verticalError = signedHash(hashMix(this.pilotHash, targetHash, this.aimSampleIndex * 2 + 1)) * errorScale * 0.7;
    this.intent.aimX = target.position.x
      + target.velocity.x * interceptSeconds
      + vehicle.right.x * horizontalError
      + vehicle.up.x * verticalError;
    this.intent.aimY = target.position.y
      + target.velocity.y * interceptSeconds
      + vehicle.right.y * horizontalError
      + vehicle.up.y * verticalError;
    this.intent.aimZ = target.position.z
      + target.velocity.z * interceptSeconds
      + vehicle.right.z * horizontalError
      + vehicle.up.z * verticalError;
    this.intent.hasAimPoint = true;
  }

  private aimAlignment(vehicle: FighterAiVehicleSnapshot): number {
    const dx = this.intent.aimX - vehicle.position.x;
    const dy = this.intent.aimY - vehicle.position.y;
    const dz = this.intent.aimZ - vehicle.position.z;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length <= EPSILON) return -1;
    return (dx * vehicle.forward.x + dy * vehicle.forward.y + dz * vehicle.forward.z) / length;
  }

  private acquireTarget(targetId: FighterAiEntityId): void {
    if (!sameId(this.combatTargetId, targetId)) {
      this.combatTargetId = targetId;
      this.targetVisibleSeconds = 0;
      this.targetLostSeconds = 0;
      this.aimSampleSeconds = 0;
      this.aimSampleIndex = 0;
    }
  }

  private targetIsObservable(input: FighterAiUpdateInput, target: FighterAiTargetSnapshot): boolean {
    if (!target.sensorVisible) return false;
    return input.world.canObserveTarget?.(this.pilotId, target.id) ?? true;
  }

  private selectCombatTarget(
    input: FighterAiUpdateInput,
    vehicle: FighterAiVehicleSnapshot,
  ): FighterAiTargetSnapshot | null {
    let best: FighterAiTargetSnapshot | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestHash = Number.MAX_SAFE_INTEGER;
    const rangeSquared = this.tuning.sensorRange * this.tuning.sensorRange;
    for (let index = 0; index < input.targets.length; index += 1) {
      const target = input.targets[index];
      if (!target.alive || !target.targetable || target.teamId === input.actor.teamId || !this.targetIsObservable(input, target)) continue;
      const dx = target.position.x - vehicle.position.x;
      const dy = target.position.y - vehicle.position.y;
      const dz = target.position.z - vehicle.position.z;
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      if (distanceSquared > rangeSquared) continue;
      const distanceScore = 1 - distanceSquared / rangeSquared;
      const stickyBonus = sameId(target.id, this.combatTargetId) ? 0.3 : 0;
      const score = clamp(finiteOr(target.threat, 0), 0, 1) * 1.5
        + distanceScore
        + (target.airborne ? 0.2 : 0)
        + stickyBonus;
      const stableHash = hashFighterAiId(target.id);
      if (score > bestScore + EPSILON || (Math.abs(score - bestScore) <= EPSILON && stableHash < bestHash)) {
        best = target;
        bestScore = score;
        bestHash = stableHash;
      }
    }
    return best;
  }

  private selectIncomingThreat(
    input: FighterAiUpdateInput,
    vehicle: FighterAiVehicleSnapshot,
  ): FighterAiIncomingThreatSnapshot | null {
    let best: FighterAiIncomingThreatSnapshot | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestHash = Number.MAX_SAFE_INTEGER;
    for (let index = 0; index < input.incomingThreats.length; index += 1) {
      const threat = input.incomingThreats[index];
      if (!threat.sensorVisible
        || threat.timeToImpact < 0
        || threat.timeToImpact > this.tuning.evadeTimeToImpact
        || threat.severity < this.tuning.evadeSeverityThreshold) continue;
      const dx = threat.position.x - vehicle.position.x;
      const dy = threat.position.y - vehicle.position.y;
      const dz = threat.position.z - vehicle.position.z;
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      const score = threat.severity * 2
        + (1 - threat.timeToImpact / this.tuning.evadeTimeToImpact)
        - Math.min(distanceSquared / (this.tuning.sensorRange * this.tuning.sensorRange), 1) * 0.2;
      const stableHash = hashFighterAiId(threat.id);
      if (score > bestScore + EPSILON || (Math.abs(score - bestScore) <= EPSILON && stableHash < bestHash)) {
        best = threat;
        bestScore = score;
        bestHash = stableHash;
      }
    }
    return best;
  }

  private selectReturnPad(input: FighterAiUpdateInput, vehicle: FighterAiVehicleSnapshot): FighterAiPadSnapshot | null {
    let best: FighterAiPadSnapshot | null = null;
    let bestDistanceSquared = Number.POSITIVE_INFINITY;
    let bestHash = Number.MAX_SAFE_INTEGER;
    for (let index = 0; index < input.pads.length; index += 1) {
      const pad = input.pads[index];
      if (!this.padIsUsable(pad, input.actor.teamId, vehicle.id)) continue;
      const distanceSquared = this.distanceSquared(vehicle.position, pad.approachPosition);
      const stableHash = hashFighterAiId(pad.id);
      if (distanceSquared < bestDistanceSquared - EPSILON
        || (Math.abs(distanceSquared - bestDistanceSquared) <= EPSILON && stableHash < bestHash)) {
        best = pad;
        bestDistanceSquared = distanceSquared;
        bestHash = stableHash;
      }
    }
    return best;
  }

  private padIsUsable(
    pad: FighterAiPadSnapshot,
    teamId: FighterAiTeamId,
    vehicleId: FighterAiEntityId,
  ): boolean {
    return pad.enabled
      && (pad.teamId === null || pad.teamId === teamId)
      && (pad.occupiedBy === null || sameId(pad.occupiedBy, vehicleId));
  }

  private currentVehicle(input: FighterAiUpdateInput): FighterAiVehicleSnapshot | null {
    const id = input.actor.currentVehicleId ?? this.targetVehicleId;
    return this.findVehicle(input.vehicles, id);
  }

  private findVehicle(
    vehicles: readonly FighterAiVehicleSnapshot[],
    id: FighterAiEntityId | null,
  ): FighterAiVehicleSnapshot | null {
    if (id === null) return null;
    for (let index = 0; index < vehicles.length; index += 1) {
      if (sameId(vehicles[index].id, id)) return vehicles[index];
    }
    return null;
  }

  private findTarget(
    targets: readonly FighterAiTargetSnapshot[],
    id: FighterAiEntityId | null,
  ): FighterAiTargetSnapshot | null {
    if (id === null) return null;
    for (let index = 0; index < targets.length; index += 1) {
      if (sameId(targets[index].id, id)) return targets[index];
    }
    return null;
  }

  private findPad(
    pads: readonly FighterAiPadSnapshot[],
    id: FighterAiEntityId | null,
  ): FighterAiPadSnapshot | null {
    if (id === null) return null;
    for (let index = 0; index < pads.length; index += 1) {
      if (sameId(pads[index].id, id)) return pads[index];
    }
    return null;
  }

  private distanceSquared(a: FighterAiVector3, b: FighterAiVector3): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
  }
}
