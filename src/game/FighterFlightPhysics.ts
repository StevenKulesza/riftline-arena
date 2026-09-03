import * as THREE from 'three';

/**
 * Star Sparrow deterministic arcade-flight model.
 *
 * Ownership deliberately stops at simulation state: player input and bot AI
 * both submit the same intent, while the arena supplies swept-sphere results
 * through a callback. The caller owns the 120 Hz accumulator and rendering.
 */

export const FIGHTER_FIXED_STEP = 1 / 120;
/** QuickSense's hard flight ceiling, doubled from the 300 m 2×-map limit. */
export const QUICKSENSE_FIGHTER_CEILING_Y = 600;

export type FighterControlIntent = Readonly<{
  /** Forward throttle in [-1, 1]. Negative values request reverse thrust. */
  throttle: number;
  /** Rightward translation in [-1, 1]. */
  strafe: number;
  /** Upward translation in [-1, 1]. */
  lift: number;
  /** Nose-up rotation in [-1, 1]. */
  pitch: number;
  /** Right-turn rotation in [-1, 1]. */
  yaw: number;
  /** Right-wing-down rotation in [-1, 1]. */
  roll: number;
  afterburner: boolean;
  /** Edge-triggered burst; holding this does not retrigger it. */
  boost: boolean;
}>;

export type FighterCollisionQueryKind = 'body' | 'support';

/**
 * Reused query supplied to the arena collision adapter. `start` and `end` are
 * sphere-center positions. The adapter must perform a swept-sphere query, not
 * a ray against the detailed fighter mesh.
 */
export type FighterCollisionQuery = {
  kind: FighterCollisionQueryKind;
  /** Index into `tuning.collisionProxies`, or -1 for the support probe. */
  proxyIndex: number;
  radius: number;
  start: THREE.Vector3;
  end: THREE.Vector3;
  displacement: THREE.Vector3;
  maxDistance: number;
};

/**
 * Caller-filled, retained collision result. `fraction` is measured along the
 * query center sweep in [0, 1]. An adapter may fill `distance` instead and
 * leave `fraction` non-finite. Normals must point away from the obstacle.
 */
export type FighterCollisionHit = {
  fraction: number;
  distance: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  surfaceVelocity: THREE.Vector3;
  /** Stable numeric handle supplied by the arena; -1 means unspecified. */
  colliderId: number;
};

export type FighterCollisionQueryCallback = (
  query: FighterCollisionQuery,
  outHit: FighterCollisionHit,
) => boolean;

export type FighterCollisionProxy = Readonly<{
  x: number;
  y: number;
  z: number;
  radius: number;
}>;

export type FighterFlightBounds = Readonly<{
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}>;

export type FighterFlightTuning = Readonly<{
  fixedStep: number;
  inputResponse: number;
  pitchAcceleration: number;
  yawAcceleration: number;
  rollAcceleration: number;
  maxPitchRate: number;
  maxYawRate: number;
  maxRollRate: number;
  angularDamping: number;
  autoBankAngle: number;
  autoBankStrength: number;
  forwardAcceleration: number;
  reverseAcceleration: number;
  strafeAcceleration: number;
  liftAcceleration: number;
  gravity: number;
  forwardDrag: number;
  lateralDrag: number;
  verticalDrag: number;
  groundDrag: number;
  cruiseSpeed: number;
  afterburnerSpeed: number;
  boostSpeed: number;
  afterburnerAccelerationMultiplier: number;
  afterburnerEnergyDrain: number;
  afterburnerEnergyRecharge: number;
  afterburnerHeatGain: number;
  heatCooling: number;
  overheatThreshold: number;
  overheatRecoveryThreshold: number;
  boostAcceleration: number;
  boostDuration: number;
  boostCooldown: number;
  boostEnergyCost: number;
  boostHeat: number;
  hoverTargetClearance: number;
  hoverAssistRange: number;
  hoverSpring: number;
  hoverDamping: number;
  hoverMaxAcceleration: number;
  supportProbeRadius: number;
  supportProbeLength: number;
  supportOffsetX: number;
  supportOffsetY: number;
  supportOffsetZ: number;
  groundContactDistance: number;
  groundSeparationSpeed: number;
  landingReadyDistance: number;
  landingMinimumUp: number;
  landingMaxHorizontalSpeed: number;
  landingMaxDescentSpeed: number;
  hardLandingSpeed: number;
  hardLandingDamageScale: number;
  colliderSkin: number;
  collisionIterations: number;
  collisionRestitution: number;
  collisionSlideRetention: number;
  collisionAngularRetention: number;
  collisionSpinTransfer: number;
  collisionDamageThreshold: number;
  collisionDamageScale: number;
  bounds: FighterFlightBounds;
  collisionProxies: readonly FighterCollisionProxy[];
}>;

/**
 * Defaults are authored for a proportional Star Sparrow scaled to a 28.5 m
 * length and 11.8 m wing span
 * in QuickSense's 360 x 320 world-unit playable volume. Local nose-forward is
 * -Z, matching Three.js camera/object convention.
 */
export const FIGHTER_FLIGHT_TUNING = {
  fixedStep: FIGHTER_FIXED_STEP,
  // A fast input settle plus damped angular rates keeps the reticle precise
  // without making the craft snap to a new heading.
  inputResponse: 18,
  pitchAcceleration: 10.5,
  yawAcceleration: 9.4,
  rollAcceleration: 13.5,
  maxPitchRate: 2.3,
  maxYawRate: 2.5,
  maxRollRate: 3.6,
  angularDamping: 4.6,
  autoBankAngle: 0.62,
  autoBankStrength: 10,
  // Forward speed is now an assisted envelope (see updateLinearMotion), so
  // these are response rates rather than an unbounded thrust accumulator.
  forwardAcceleration: 66,
  reverseAcceleration: 30,
  strafeAcceleration: 16,
  liftAcceleration: 64,
  gravity: 11.5,
  forwardDrag: 0.65,
  lateralDrag: 4.2,
  verticalDrag: 1.8,
  groundDrag: 8,
  cruiseSpeed: 78,
  afterburnerSpeed: 126,
  boostSpeed: 172,
  afterburnerAccelerationMultiplier: 1.82,
  afterburnerEnergyDrain: 0.23,
  afterburnerEnergyRecharge: 0.15,
  afterburnerHeatGain: 0.27,
  heatCooling: 0.19,
  overheatThreshold: 0.96,
  overheatRecoveryThreshold: 0.48,
  boostAcceleration: 112,
  boostDuration: 0.34,
  boostCooldown: 1.45,
  boostEnergyCost: 0.24,
  boostHeat: 0.2,
  hoverTargetClearance: 0.55,
  hoverAssistRange: 2.3,
  hoverSpring: 35,
  hoverDamping: 8.2,
  hoverMaxAcceleration: 31,
  supportProbeRadius: 0.55,
  supportProbeLength: 4,
  supportOffsetX: 0,
  // The completed hull's central ventral housing sits 3.05245 m below its
  // root. With the 0.55 m probe and 0.12 m contact gap, this equilibrium leaves
  // that housing flush on QuickSense's authored pad surface.
  supportOffsetY: -2.38245,
  supportOffsetZ: 0.7,
  groundContactDistance: 0.12,
  groundSeparationSpeed: 1.1,
  landingReadyDistance: 3,
  landingMinimumUp: 0.74,
  landingMaxHorizontalSpeed: 15,
  landingMaxDescentSpeed: 7,
  hardLandingSpeed: 8.5,
  hardLandingDamageScale: 0.62,
  colliderSkin: 0.025,
  collisionIterations: 3,
  // A wall should scrub the nose velocity and stabilize the craft into a
  // recoverable slide, not turn a glancing hit into a pinball spin.
  collisionRestitution: 0.06,
  collisionSlideRetention: 0.72,
  collisionAngularRetention: 0.36,
  collisionSpinTransfer: 0.003,
  collisionDamageThreshold: 9,
  collisionDamageScale: 0.2,
  bounds: {
    // QuickSense playable half-extents are 360 × 320. Keep the same 4 m
    // inset the 180 × 160 2×-map used, plus a floor just below killY (-48).
    minX: -356,
    maxX: 356,
    minY: -52,
    maxY: QUICKSENSE_FIGHTER_CEILING_Y,
    minZ: -316,
    maxZ: 316,
  },
  collisionProxies: [
    { x: 0, y: 0, z: -10.83, radius: 1.25 },
    { x: 0, y: 0, z: -4.9, radius: 1.5 },
    { x: 0, y: 0, z: 1.25, radius: 1.65 },
    { x: 0, y: 0, z: 8.55, radius: 1.25 },
    { x: -4.8, y: 0, z: 0.35, radius: 1.5 },
    { x: 4.8, y: 0, z: 0.35, radius: 1.5 },
  ],
} as const satisfies FighterFlightTuning;

export type FighterFlightDiagnostics = {
  steps: number;
  collisionQueries: number;
  supportQueries: number;
  collisionHits: number;
  impacts: number;
  boundsContacts: number;
  invalidCollisionHits: number;
  boostStarts: number;
  afterburnerSeconds: number;
  clampedInputAxes: number;
  lastStepCollisionQueries: number;
  lastStepCollisionHits: number;
  lastStepSolverIterations: number;
  lastImpactSpeed: number;
  totalImpactDamage: number;
};

type FighterFlightScratch = {
  query: FighterCollisionQuery;
  candidateHit: FighterCollisionHit;
  bestHit: FighterCollisionHit;
  startPosition: THREE.Vector3;
  proposedPosition: THREE.Vector3;
  proxyStart: THREE.Vector3;
  proxyEnd: THREE.Vector3;
  forward: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  relativeVelocity: THREE.Vector3;
  tangentVelocity: THREE.Vector3;
  lever: THREE.Vector3;
  torqueAxis: THREE.Vector3;
  startOrientation: THREE.Quaternion;
  targetOrientation: THREE.Quaternion;
  deltaOrientation: THREE.Quaternion;
  preMoveVelocity: THREE.Vector3;
};

export type FighterFlightState = {
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly orientation: THREE.Quaternion;
  /** World-space radians per second. */
  readonly angularVelocity: THREE.Vector3;
  afterburnerEnergy: number;
  heat: number;
  afterburnerActive: boolean;
  overheated: boolean;
  boostActive: boolean;
  boostRemaining: number;
  boostCooldownRemaining: number;
  boostTriggeredThisStep: boolean;
  grounded: boolean;
  hovering: boolean;
  takeoffReady: boolean;
  landingReady: boolean;
  landingReadiness: number;
  landedThisStep: boolean;
  tookOffThisStep: boolean;
  safeLanding: boolean;
  supportDistance: number;
  supportColliderId: number;
  readonly supportNormal: THREE.Vector3;
  readonly supportVelocity: THREE.Vector3;
  impactDamageThisStep: number;
  lastImpactSpeed: number;
  readonly lastImpactNormal: THREE.Vector3;
  elapsedSimulationTime: number;
  readonly diagnostics: FighterFlightDiagnostics;
  /** Smoothed public values are useful to both animation and bot steering. */
  controlThrottle: number;
  controlStrafe: number;
  controlLift: number;
  controlPitch: number;
  controlYaw: number;
  controlRoll: number;
  /** @internal Retained scratch storage; callers must not mutate it. */
  readonly _scratch: FighterFlightScratch;
  /** @internal Edge latch for the boost button. */
  _boostHeld: boolean;
};

const ORIGIN = new THREE.Vector3();
const IDENTITY = new THREE.Quaternion();
const EPSILON = 1e-8;

function createHit(): FighterCollisionHit {
  return {
    fraction: Number.POSITIVE_INFINITY,
    distance: Number.POSITIVE_INFINITY,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    surfaceVelocity: new THREE.Vector3(),
    colliderId: -1,
  };
}

function createScratch(): FighterFlightScratch {
  const start = new THREE.Vector3();
  const end = new THREE.Vector3();
  return {
    query: {
      kind: 'body',
      proxyIndex: 0,
      radius: 1,
      start,
      end,
      displacement: new THREE.Vector3(),
      maxDistance: 0,
    },
    candidateHit: createHit(),
    bestHit: createHit(),
    startPosition: new THREE.Vector3(),
    proposedPosition: new THREE.Vector3(),
    proxyStart: start,
    proxyEnd: end,
    forward: new THREE.Vector3(),
    right: new THREE.Vector3(),
    up: new THREE.Vector3(),
    relativeVelocity: new THREE.Vector3(),
    tangentVelocity: new THREE.Vector3(),
    lever: new THREE.Vector3(),
    torqueAxis: new THREE.Vector3(),
    startOrientation: new THREE.Quaternion(),
    targetOrientation: new THREE.Quaternion(),
    deltaOrientation: new THREE.Quaternion(),
    preMoveVelocity: new THREE.Vector3(),
  };
}

function createDiagnostics(): FighterFlightDiagnostics {
  return {
    steps: 0,
    collisionQueries: 0,
    supportQueries: 0,
    collisionHits: 0,
    impacts: 0,
    boundsContacts: 0,
    invalidCollisionHits: 0,
    boostStarts: 0,
    afterburnerSeconds: 0,
    clampedInputAxes: 0,
    lastStepCollisionQueries: 0,
    lastStepCollisionHits: 0,
    lastStepSolverIterations: 0,
    lastImpactSpeed: 0,
    totalImpactDamage: 0,
  };
}

export function createFighterFlightState(
  position: Readonly<THREE.Vector3> = ORIGIN,
  orientation: Readonly<THREE.Quaternion> = IDENTITY,
): FighterFlightState {
  const state: FighterFlightState = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    orientation: new THREE.Quaternion(),
    angularVelocity: new THREE.Vector3(),
    afterburnerEnergy: 1,
    heat: 0,
    afterburnerActive: false,
    overheated: false,
    boostActive: false,
    boostRemaining: 0,
    boostCooldownRemaining: 0,
    boostTriggeredThisStep: false,
    grounded: false,
    hovering: false,
    takeoffReady: false,
    landingReady: false,
    landingReadiness: 0,
    landedThisStep: false,
    tookOffThisStep: false,
    safeLanding: false,
    supportDistance: Number.POSITIVE_INFINITY,
    supportColliderId: -1,
    supportNormal: new THREE.Vector3(0, 1, 0),
    supportVelocity: new THREE.Vector3(),
    impactDamageThisStep: 0,
    lastImpactSpeed: 0,
    lastImpactNormal: new THREE.Vector3(),
    elapsedSimulationTime: 0,
    diagnostics: createDiagnostics(),
    controlThrottle: 0,
    controlStrafe: 0,
    controlLift: 0,
    controlPitch: 0,
    controlYaw: 0,
    controlRoll: 0,
    _scratch: createScratch(),
    _boostHeld: false,
  };
  return resetFighterFlightState(state, position, orientation);
}

export function resetFighterFlightState(
  state: FighterFlightState,
  position: Readonly<THREE.Vector3> = ORIGIN,
  orientation: Readonly<THREE.Quaternion> = IDENTITY,
): FighterFlightState {
  state.position.copy(position);
  state.velocity.set(0, 0, 0);
  state.orientation.copy(orientation).normalize();
  state.angularVelocity.set(0, 0, 0);
  state.afterburnerEnergy = 1;
  state.heat = 0;
  state.afterburnerActive = false;
  state.overheated = false;
  state.boostActive = false;
  state.boostRemaining = 0;
  state.boostCooldownRemaining = 0;
  state.boostTriggeredThisStep = false;
  state.grounded = false;
  state.hovering = false;
  state.takeoffReady = true;
  state.landingReady = false;
  state.landingReadiness = 0;
  state.landedThisStep = false;
  state.tookOffThisStep = false;
  state.safeLanding = false;
  state.supportDistance = Number.POSITIVE_INFINITY;
  state.supportColliderId = -1;
  state.supportNormal.set(0, 1, 0);
  state.supportVelocity.set(0, 0, 0);
  state.impactDamageThisStep = 0;
  state.lastImpactSpeed = 0;
  state.lastImpactNormal.set(0, 0, 0);
  state.elapsedSimulationTime = 0;
  state.controlThrottle = 0;
  state.controlStrafe = 0;
  state.controlLift = 0;
  state.controlPitch = 0;
  state.controlYaw = 0;
  state.controlRoll = 0;
  state._boostHeld = false;
  const diagnostics = state.diagnostics;
  diagnostics.steps = 0;
  diagnostics.collisionQueries = 0;
  diagnostics.supportQueries = 0;
  diagnostics.collisionHits = 0;
  diagnostics.impacts = 0;
  diagnostics.boundsContacts = 0;
  diagnostics.invalidCollisionHits = 0;
  diagnostics.boostStarts = 0;
  diagnostics.afterburnerSeconds = 0;
  diagnostics.clampedInputAxes = 0;
  diagnostics.lastStepCollisionQueries = 0;
  diagnostics.lastStepCollisionHits = 0;
  diagnostics.lastStepSolverIterations = 0;
  diagnostics.lastImpactSpeed = 0;
  diagnostics.totalImpactDamage = 0;
  return state;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAxis(value: number, diagnostics: FighterFlightDiagnostics): number {
  if (!Number.isFinite(value)) {
    diagnostics.clampedInputAxes += 1;
    return 0;
  }
  const clamped = Math.max(-1, Math.min(1, value));
  if (clamped !== value) diagnostics.clampedInputAxes += 1;
  return clamped;
}

function approach(current: number, target: number, maximumDelta: number): number {
  if (current < target) return Math.min(target, current + maximumDelta);
  return Math.max(target, current - maximumDelta);
}

function resetHit(hit: FighterCollisionHit): void {
  hit.fraction = Number.POSITIVE_INFINITY;
  hit.distance = Number.POSITIVE_INFINITY;
  hit.point.set(0, 0, 0);
  hit.normal.set(0, 1, 0);
  hit.surfaceVelocity.set(0, 0, 0);
  hit.colliderId = -1;
}

function copyHit(target: FighterCollisionHit, source: FighterCollisionHit): void {
  target.fraction = source.fraction;
  target.distance = source.distance;
  target.point.copy(source.point);
  target.normal.copy(source.normal);
  target.surfaceVelocity.copy(source.surfaceVelocity);
  target.colliderId = source.colliderId;
}

function normalizeHit(
  state: FighterFlightState,
  hit: FighterCollisionHit,
  maxDistance: number,
): boolean {
  let fraction = hit.fraction;
  if (!Number.isFinite(fraction) && Number.isFinite(hit.distance) && maxDistance > EPSILON) {
    fraction = hit.distance / maxDistance;
  }
  const normalLengthSq = hit.normal.lengthSq();
  const validPoint = Number.isFinite(hit.point.x)
    && Number.isFinite(hit.point.y)
    && Number.isFinite(hit.point.z);
  const validSurfaceVelocity = Number.isFinite(hit.surfaceVelocity.x)
    && Number.isFinite(hit.surfaceVelocity.y)
    && Number.isFinite(hit.surfaceVelocity.z);
  if (
    !Number.isFinite(fraction)
    || !Number.isFinite(normalLengthSq)
    || normalLengthSq <= EPSILON
    || !validPoint
    || !validSurfaceVelocity
  ) {
    state.diagnostics.invalidCollisionHits += 1;
    return false;
  }
  hit.fraction = Math.max(0, Math.min(1, fraction));
  hit.distance = hit.fraction * maxDistance;
  if (Math.abs(normalLengthSq - 1) > 1e-4) hit.normal.multiplyScalar(1 / Math.sqrt(normalLengthSq));
  return true;
}

function queryCollision(
  state: FighterFlightState,
  collisionQuery: FighterCollisionQueryCallback,
  kind: FighterCollisionQueryKind,
  proxyIndex: number,
  radius: number,
  start: THREE.Vector3,
  end: THREE.Vector3,
): FighterCollisionHit | null {
  const scratch = state._scratch;
  const query = scratch.query;
  query.kind = kind;
  query.proxyIndex = proxyIndex;
  query.radius = radius;
  query.start.copy(start);
  query.end.copy(end);
  query.displacement.subVectors(query.end, query.start);
  query.maxDistance = query.displacement.length();
  if (query.maxDistance <= EPSILON) return null;
  const hit = scratch.candidateHit;
  resetHit(hit);
  state.diagnostics.collisionQueries += 1;
  state.diagnostics.lastStepCollisionQueries += 1;
  if (kind === 'support') state.diagnostics.supportQueries += 1;
  if (!collisionQuery(query, hit) || !normalizeHit(state, hit, query.maxDistance)) return null;
  state.diagnostics.collisionHits += 1;
  state.diagnostics.lastStepCollisionHits += 1;
  return hit;
}

function updateSupport(
  state: FighterFlightState,
  collisionQuery: FighterCollisionQueryCallback | null,
  tuning: FighterFlightTuning,
): boolean {
  state.supportDistance = Number.POSITIVE_INFINITY;
  state.supportColliderId = -1;
  state.supportNormal.set(0, 1, 0);
  state.supportVelocity.set(0, 0, 0);
  if (!collisionQuery) return false;
  const scratch = state._scratch;
  scratch.proxyStart.set(
    tuning.supportOffsetX,
    tuning.supportOffsetY,
    tuning.supportOffsetZ,
  ).applyQuaternion(state.orientation).add(state.position);
  scratch.proxyEnd.copy(scratch.proxyStart).addScaledVector(scratch.up.set(0, -1, 0), tuning.supportProbeLength);
  const hit = queryCollision(
    state,
    collisionQuery,
    'support',
    -1,
    tuning.supportProbeRadius,
    scratch.proxyStart,
    scratch.proxyEnd,
  );
  if (!hit || hit.normal.y < 0.2) return false;
  state.supportDistance = hit.distance;
  state.supportColliderId = hit.colliderId;
  state.supportNormal.copy(hit.normal);
  state.supportVelocity.copy(hit.surfaceVelocity);
  return true;
}

function updateResources(
  state: FighterFlightState,
  wantsAfterburner: boolean,
  wantsBoost: boolean,
  tuning: FighterFlightTuning,
  delta: number,
): void {
  state.boostTriggeredThisStep = false;
  state.boostCooldownRemaining = Math.max(0, state.boostCooldownRemaining - delta);
  if (state.overheated && state.heat <= tuning.overheatRecoveryThreshold) state.overheated = false;

  if (
    wantsBoost
    && !state._boostHeld
    && !state.overheated
    && state.boostCooldownRemaining <= 0
    && state.afterburnerEnergy >= tuning.boostEnergyCost
  ) {
    state.boostRemaining = tuning.boostDuration;
    state.boostCooldownRemaining = tuning.boostCooldown;
    state.afterburnerEnergy -= tuning.boostEnergyCost;
    state.heat = clamp01(state.heat + tuning.boostHeat);
    state.boostTriggeredThisStep = true;
    state.diagnostics.boostStarts += 1;
  }
  state._boostHeld = wantsBoost;
  state.boostActive = state.boostRemaining > 0;

  state.afterburnerActive = wantsAfterburner
    && !state.overheated
    && state.afterburnerEnergy > 0
    && state.controlThrottle > 0.05;
  if (state.afterburnerActive) {
    state.afterburnerEnergy = clamp01(
      state.afterburnerEnergy - tuning.afterburnerEnergyDrain * delta,
    );
    state.heat = clamp01(state.heat + tuning.afterburnerHeatGain * delta);
    state.diagnostics.afterburnerSeconds += delta;
  } else if (!state.boostActive) {
    state.afterburnerEnergy = clamp01(
      state.afterburnerEnergy + tuning.afterburnerEnergyRecharge * delta,
    );
  }
  if (!state.afterburnerActive && !state.boostActive) {
    state.heat = clamp01(state.heat - tuning.heatCooling * delta);
  }
  if (state.heat >= tuning.overheatThreshold || state.afterburnerEnergy <= 0) {
    if (state.heat >= tuning.overheatThreshold) state.overheated = true;
    state.afterburnerActive = false;
  }
}

function updateAngularMotion(
  state: FighterFlightState,
  tuning: FighterFlightTuning,
  delta: number,
): void {
  const scratch = state._scratch;
  const orientation = state.orientation;
  const forward = scratch.forward.set(0, 0, -1).applyQuaternion(orientation);
  const right = scratch.right.set(1, 0, 0).applyQuaternion(orientation);
  const up = scratch.up.set(0, 1, 0).applyQuaternion(orientation);
  const currentBank = -Math.asin(Math.max(-1, Math.min(1, right.y)));
  const desiredBank = state.controlRoll * tuning.autoBankAngle
    + state.controlYaw * tuning.autoBankAngle * 0.72;
  const bankError = Math.max(-tuning.autoBankAngle, Math.min(tuning.autoBankAngle, desiredBank - currentBank));

  state.angularVelocity.addScaledVector(right, state.controlPitch * tuning.pitchAcceleration * delta);
  state.angularVelocity.addScaledVector(up, -state.controlYaw * tuning.yawAcceleration * delta);
  state.angularVelocity.addScaledVector(
    forward,
    (state.controlRoll * tuning.rollAcceleration + bankError * tuning.autoBankStrength) * delta,
  );

  let pitchRate = Math.max(-tuning.maxPitchRate, Math.min(tuning.maxPitchRate, state.angularVelocity.dot(right)));
  let yawRate = Math.max(-tuning.maxYawRate, Math.min(tuning.maxYawRate, state.angularVelocity.dot(up)));
  let rollRate = Math.max(-tuning.maxRollRate, Math.min(tuning.maxRollRate, state.angularVelocity.dot(forward)));
  const damping = Math.exp(-tuning.angularDamping * delta);
  pitchRate *= damping;
  yawRate *= damping;
  rollRate *= damping;
  state.angularVelocity.copy(right).multiplyScalar(pitchRate)
    .addScaledVector(up, yawRate)
    .addScaledVector(forward, rollRate);

  const angularSpeed = state.angularVelocity.length();
  if (angularSpeed <= EPSILON) return;
  const axis = scratch.torqueAxis.copy(state.angularVelocity).multiplyScalar(1 / angularSpeed);
  scratch.deltaOrientation.setFromAxisAngle(axis, angularSpeed * delta);
  orientation.premultiply(scratch.deltaOrientation).normalize();
}

function updateLinearMotion(
  state: FighterFlightState,
  tuning: FighterFlightTuning,
  delta: number,
  hasSupport: boolean,
): void {
  const scratch = state._scratch;
  const forward = scratch.forward.set(0, 0, -1).applyQuaternion(state.orientation);
  const right = scratch.right.set(1, 0, 0).applyQuaternion(state.orientation);
  const up = scratch.up.set(0, 1, 0).applyQuaternion(state.orientation);
  const afterburnerScale = state.afterburnerActive ? tuning.afterburnerAccelerationMultiplier : 1;
  state.velocity.addScaledVector(right, state.controlStrafe * tuning.strafeAcceleration * delta);
  state.velocity.addScaledVector(up, state.controlLift * tuning.liftAcceleration * delta);
  state.velocity.y -= tuning.gravity * delta;

  const relativeSupportVelocity = scratch.relativeVelocity.copy(state.velocity).sub(state.supportVelocity);
  const supportNormalSpeed = relativeSupportVelocity.dot(state.supportNormal);
  // Neutral controls must let an unpiloted or landing fighter settle onto its
  // gear. Forward/lift intent engages terrain-following hover assistance.
  const hoverRequested = state.controlLift > 0.05 || state.controlThrottle > 0.35;
  state.hovering = hasSupport
    && hoverRequested
    && state.supportDistance <= tuning.hoverAssistRange;
  if (state.hovering) {
    const springAcceleration = (tuning.hoverTargetClearance - state.supportDistance) * tuning.hoverSpring
      - supportNormalSpeed * tuning.hoverDamping;
    const hoverAcceleration = Math.max(
      -tuning.hoverMaxAcceleration,
      Math.min(tuning.hoverMaxAcceleration, springAcceleration),
    );
    state.velocity.addScaledVector(state.supportNormal, hoverAcceleration * delta);
  }

  const speedLimit = state.boostActive
    ? tuning.boostSpeed
    : state.afterburnerActive
      ? tuning.afterburnerSpeed
      : tuning.cruiseSpeed;
  const targetForwardSpeed = state.controlThrottle >= 0
    ? speedLimit * state.controlThrottle
    : -Math.min(tuning.cruiseSpeed * 0.38, tuning.reverseAcceleration) * Math.abs(state.controlThrottle);
  const currentForwardSpeed = state.velocity.dot(forward) * Math.exp(-tuning.forwardDrag * delta);
  const forwardResponse = state.boostActive
    ? tuning.boostAcceleration
    : tuning.forwardAcceleration * afterburnerScale;
  const forwardSpeed = approach(
    currentForwardSpeed,
    targetForwardSpeed,
    Math.max(tuning.reverseAcceleration, forwardResponse) * delta,
  );
  const lateralSpeed = state.velocity.dot(right) * Math.exp(-tuning.lateralDrag * delta);
  const verticalSpeed = state.velocity.dot(up) * Math.exp(-tuning.verticalDrag * delta);
  state.velocity.copy(forward).multiplyScalar(forwardSpeed)
    .addScaledVector(right, lateralSpeed)
    .addScaledVector(up, verticalSpeed);
  if (state.grounded && !hoverRequested) {
    const groundRetention = Math.exp(-tuning.groundDrag * delta);
    const normalSpeed = state.velocity.dot(state.supportNormal);
    scratch.tangentVelocity.copy(state.velocity).addScaledVector(state.supportNormal, -normalSpeed);
    state.velocity.addScaledVector(scratch.tangentVelocity, groundRetention - 1);
  }

  const speedSq = state.velocity.lengthSq();
  if (speedSq > speedLimit * speedLimit) state.velocity.multiplyScalar(speedLimit / Math.sqrt(speedSq));
}

function findEarliestBodyHit(
  state: FighterFlightState,
  collisionQuery: FighterCollisionQueryCallback,
  tuning: FighterFlightTuning,
  startPosition: THREE.Vector3,
  endPosition: THREE.Vector3,
  startOrientation: THREE.Quaternion,
  endOrientation: THREE.Quaternion,
): boolean {
  const scratch = state._scratch;
  const bestHit = scratch.bestHit;
  resetHit(bestHit);
  let found = false;
  for (let index = 0; index < tuning.collisionProxies.length; index += 1) {
    const proxy = tuning.collisionProxies[index];
    scratch.proxyStart.set(proxy.x, proxy.y, proxy.z)
      .applyQuaternion(startOrientation)
      .add(startPosition);
    scratch.proxyEnd.set(proxy.x, proxy.y, proxy.z)
      .applyQuaternion(endOrientation)
      .add(endPosition);
    const hit = queryCollision(
      state,
      collisionQuery,
      'body',
      index,
      proxy.radius,
      scratch.proxyStart,
      scratch.proxyEnd,
    );
    if (!hit || hit.fraction >= bestHit.fraction) continue;
    copyHit(bestHit, hit);
    found = true;
  }
  return found;
}

function applyCollisionResponse(
  state: FighterFlightState,
  hit: FighterCollisionHit,
  tuning: FighterFlightTuning,
): void {
  const scratch = state._scratch;
  const relativeVelocity = scratch.relativeVelocity.copy(state.velocity).sub(hit.surfaceVelocity);
  const inwardSpeed = relativeVelocity.dot(hit.normal);
  if (inwardSpeed >= 0) return;
  const impactSpeed = -inwardSpeed;
  relativeVelocity.addScaledVector(hit.normal, -(1 + tuning.collisionRestitution) * inwardSpeed);
  const outgoingNormalSpeed = relativeVelocity.dot(hit.normal);
  scratch.tangentVelocity.copy(relativeVelocity).addScaledVector(hit.normal, -outgoingNormalSpeed);
  relativeVelocity.addScaledVector(
    scratch.tangentVelocity,
    tuning.collisionSlideRetention - 1,
  );
  state.velocity.copy(hit.surfaceVelocity).add(relativeVelocity);
  state.angularVelocity.multiplyScalar(tuning.collisionAngularRetention);
  scratch.lever.copy(hit.point).sub(state.position).cross(hit.normal);
  state.angularVelocity.addScaledVector(scratch.lever, impactSpeed * tuning.collisionSpinTransfer);

  state.lastImpactSpeed = impactSpeed;
  state.lastImpactNormal.copy(hit.normal);
  state.diagnostics.lastImpactSpeed = impactSpeed;
  state.diagnostics.impacts += 1;
  const damagingSpeed = Math.max(0, impactSpeed - tuning.collisionDamageThreshold);
  if (damagingSpeed > 0) {
    const damage = damagingSpeed * damagingSpeed * tuning.collisionDamageScale;
    state.impactDamageThisStep += damage;
    state.diagnostics.totalImpactDamage += damage;
  }
}

function resolveSweptMotion(
  state: FighterFlightState,
  collisionQuery: FighterCollisionQueryCallback | null,
  tuning: FighterFlightTuning,
  delta: number,
): void {
  const scratch = state._scratch;
  let remaining = delta;
  let iteration = 0;
  while (remaining > EPSILON && iteration < tuning.collisionIterations) {
    iteration += 1;
    state.diagnostics.lastStepSolverIterations = iteration;
    scratch.startPosition.copy(state.position);
    scratch.proposedPosition.copy(state.position).addScaledVector(state.velocity, remaining);
    if (!collisionQuery || !findEarliestBodyHit(
      state,
      collisionQuery,
      tuning,
      scratch.startPosition,
      scratch.proposedPosition,
      scratch.startOrientation,
      scratch.targetOrientation,
    )) {
      state.position.copy(scratch.proposedPosition);
      state.orientation.copy(scratch.targetOrientation);
      break;
    }

    const hit = scratch.bestHit;
    const bodyDistance = scratch.proposedPosition.distanceTo(scratch.startPosition);
    const skinFraction = bodyDistance > EPSILON ? tuning.colliderSkin / bodyDistance : 0;
    const travelFraction = Math.max(0, hit.fraction - skinFraction);
    state.position.lerpVectors(scratch.startPosition, scratch.proposedPosition, travelFraction);
    state.orientation.copy(scratch.startOrientation).slerp(scratch.targetOrientation, hit.fraction).normalize();
    state.position.addScaledVector(hit.normal, tuning.colliderSkin);
    applyCollisionResponse(state, hit, tuning);
    remaining *= Math.max(0, 1 - hit.fraction);
    scratch.startOrientation.copy(state.orientation);
    // Rotation stops at contact; remaining time resolves only the slide.
    scratch.targetOrientation.copy(state.orientation);
  }
  // Exhausting the contact budget intentionally discards the tiny remainder;
  // an unqueried fallback move could tunnel through the corner just resolved.
}

function resolveWorldBounds(
  state: FighterFlightState,
  tuning: FighterFlightTuning,
): void {
  const bounds = tuning.bounds;
  const hit = state._scratch.bestHit;
  hit.surfaceVelocity.set(0, 0, 0);
  hit.point.copy(state.position);
  hit.colliderId = -2;
  if (state.position.x < bounds.minX) {
    state.position.x = bounds.minX;
    applyBoundsContact(state, hit, tuning, 1, 0, 0);
  } else if (state.position.x > bounds.maxX) {
    state.position.x = bounds.maxX;
    applyBoundsContact(state, hit, tuning, -1, 0, 0);
  }
  if (state.position.y < bounds.minY) {
    state.position.y = bounds.minY;
    applyBoundsContact(state, hit, tuning, 0, 1, 0);
  } else if (state.position.y > bounds.maxY) {
    state.position.y = bounds.maxY;
    applyBoundsContact(state, hit, tuning, 0, -1, 0);
  }
  if (state.position.z < bounds.minZ) {
    state.position.z = bounds.minZ;
    applyBoundsContact(state, hit, tuning, 0, 0, 1);
  } else if (state.position.z > bounds.maxZ) {
    state.position.z = bounds.maxZ;
    applyBoundsContact(state, hit, tuning, 0, 0, -1);
  }
}

function applyBoundsContact(
  state: FighterFlightState,
  hit: FighterCollisionHit,
  tuning: FighterFlightTuning,
  normalX: number,
  normalY: number,
  normalZ: number,
): void {
  hit.normal.set(normalX, normalY, normalZ);
  applyCollisionResponse(state, hit, tuning);
  state.diagnostics.boundsContacts += 1;
}

function updateLandingState(
  state: FighterFlightState,
  hadSupport: boolean,
  wasGrounded: boolean,
  tuning: FighterFlightTuning,
): void {
  const scratch = state._scratch;
  const relativeVelocity = scratch.relativeVelocity.copy(state.velocity).sub(state.supportVelocity);
  const normalSpeed = relativeVelocity.dot(state.supportNormal);
  scratch.tangentVelocity.copy(relativeVelocity).addScaledVector(state.supportNormal, -normalSpeed);
  const horizontalSpeed = scratch.tangentVelocity.length();
  const upAlignment = scratch.up.set(0, 1, 0).applyQuaternion(state.orientation).dot(state.supportNormal);
  const proximity = hadSupport
    ? 1 - clamp01(state.supportDistance / tuning.landingReadyDistance)
    : 0;
  const attitude = clamp01(
    (upAlignment - tuning.landingMinimumUp) / Math.max(EPSILON, 1 - tuning.landingMinimumUp),
  );
  const horizontal = 1 - clamp01(horizontalSpeed / tuning.landingMaxHorizontalSpeed);
  const descent = 1 - clamp01(Math.max(0, -normalSpeed) / tuning.landingMaxDescentSpeed);
  state.landingReadiness = Math.min(proximity, attitude, horizontal, descent);
  state.landingReady = hadSupport && state.landingReadiness >= 0.65;
  state.grounded = hadSupport
    && state.supportDistance <= tuning.groundContactDistance
    && normalSpeed <= tuning.groundSeparationSpeed
    && upAlignment >= tuning.landingMinimumUp;

  if (state.grounded) {
    if (state.supportDistance < tuning.groundContactDistance) {
      state.position.addScaledVector(
        state.supportNormal,
        tuning.groundContactDistance - state.supportDistance,
      );
    }
    if (normalSpeed < 0) state.velocity.addScaledVector(state.supportNormal, -normalSpeed);
  }
  state.landedThisStep = !wasGrounded && state.grounded;
  state.tookOffThisStep = wasGrounded && !state.grounded;
  state.safeLanding = false;
  if (state.landedThisStep) {
    const landingSpeed = Math.max(0, -scratch.preMoveVelocity.dot(state.supportNormal));
    state.safeLanding = landingSpeed <= tuning.landingMaxDescentSpeed
      && horizontalSpeed <= tuning.landingMaxHorizontalSpeed
      && upAlignment >= tuning.landingMinimumUp;
    if (landingSpeed > tuning.hardLandingSpeed && state.impactDamageThisStep <= 0) {
      const excess = landingSpeed - tuning.hardLandingSpeed;
      const damage = excess * excess * tuning.hardLandingDamageScale;
      state.impactDamageThisStep += damage;
      state.diagnostics.totalImpactDamage += damage;
    }
  }
  state.takeoffReady = state.grounded
    && !state.overheated
    && state.afterburnerEnergy >= tuning.boostEnergyCost;
}

/**
 * Advance exactly one caller-owned fixed tick. Do not call this with render
 * delta: feed it from the game's 120 Hz accumulator. The function performs no
 * allocations after `createFighterFlightState` has returned.
 */
export function stepFighterFlight(
  state: FighterFlightState,
  intent: FighterControlIntent,
  collisionQuery: FighterCollisionQueryCallback | null,
  tuning: FighterFlightTuning = FIGHTER_FLIGHT_TUNING,
): FighterFlightState {
  const delta = tuning.fixedStep;
  if (!Number.isFinite(delta) || delta <= 0) {
    throw new RangeError('Fighter flight fixedStep must be finite and greater than zero.');
  }
  const diagnostics = state.diagnostics;
  diagnostics.steps += 1;
  diagnostics.lastStepCollisionQueries = 0;
  diagnostics.lastStepCollisionHits = 0;
  diagnostics.lastStepSolverIterations = 0;
  state.impactDamageThisStep = 0;
  state.lastImpactSpeed = 0;
  state.landedThisStep = false;
  state.tookOffThisStep = false;
  state.safeLanding = false;
  const wasGrounded = state.grounded;

  const responseDelta = tuning.inputResponse * delta;
  state.controlThrottle = approach(state.controlThrottle, clampAxis(intent.throttle, diagnostics), responseDelta);
  state.controlStrafe = approach(state.controlStrafe, clampAxis(intent.strafe, diagnostics), responseDelta);
  state.controlLift = approach(state.controlLift, clampAxis(intent.lift, diagnostics), responseDelta);
  state.controlPitch = approach(state.controlPitch, clampAxis(intent.pitch, diagnostics), responseDelta);
  state.controlYaw = approach(state.controlYaw, clampAxis(intent.yaw, diagnostics), responseDelta);
  state.controlRoll = approach(state.controlRoll, clampAxis(intent.roll, diagnostics), responseDelta);

  const hadSupportBeforeMove = updateSupport(state, collisionQuery, tuning);
  updateResources(state, intent.afterburner, intent.boost, tuning, delta);
  const scratch = state._scratch;
  scratch.startOrientation.copy(state.orientation);
  updateAngularMotion(state, tuning, delta);
  scratch.targetOrientation.copy(state.orientation);
  // Preserve the incoming velocity for landing-speed and impact telemetry.
  // It must be captured before thrust, gravity, and collision response modify
  // the state for this tick.
  scratch.preMoveVelocity.copy(state.velocity);
  updateLinearMotion(state, tuning, delta, hadSupportBeforeMove);
  resolveSweptMotion(state, collisionQuery, tuning, delta);
  resolveWorldBounds(state, tuning);
  const hadSupportAfterMove = updateSupport(state, collisionQuery, tuning);
  updateLandingState(state, hadSupportAfterMove, wasGrounded, tuning);

  state.boostRemaining = Math.max(0, state.boostRemaining - delta);
  state.boostActive = state.boostRemaining > 0;
  state.elapsedSimulationTime += delta;
  return state;
}
