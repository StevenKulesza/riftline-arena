import * as THREE from 'three';

/** Anything that can hurt a bot: the player, another bot (by id), or a hostile drone. */
export type BotDamageSource = 'player' | number | 'drone';

/** Predicted impact of a hostile projectile or grenade, shared by every bot each tick. */
export type BotThreatPoint = {
  readonly position: THREE.Vector3;
  owner: BotDamageSource | null;
  timeToImpact: number;
  radius: number;
  active: boolean;
};

export function createThreatPoint(): BotThreatPoint {
  return { position: new THREE.Vector3(), owner: null, timeToImpact: 0, radius: 0, active: false };
}

/** Deterministic mulberry32 stream that can be re-seeded in place. */
export class SeededStream {
  private state = 0;

  constructor(seed: number) {
    this.reseed(seed);
  }

  reseed(seed: number): void {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [-1, 1]. */
  signed(): number {
    return this.next() * 2 - 1;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
}

const RECENT_DAMAGE_DECAY_PER_SECOND = 22;
const ALERT_DURATION = 1.5;
const ATTACKER_MEMORY_SECONDS = 6;

/**
 * Warfork-style damage memory: who hit the bot last, how hard, and from
 * where, so target selection and awareness can react to an unseen attacker.
 */
export class BotThreatMemory {
  lastAttacker: BotDamageSource | null = null;
  lastDamageTime = Number.NEGATIVE_INFINITY;
  damageTakenRecently = 0;
  /** Unit vector from the bot toward the last damage origin (flat when possible). */
  readonly damageBearing = new THREE.Vector3(0, 0, -1);
  hasBearing = false;
  /** Set when a hit arrived from outside the awareness cone; consumed by the bot. */
  alertUntil = Number.NEGATIVE_INFINITY;
  dodgeRequested = false;

  registerDamage(
    source: BotDamageSource,
    amount: number,
    origin: THREE.Vector3 | null,
    botPosition: THREE.Vector3,
    facing: THREE.Vector3,
    awarenessDot: number,
    elapsed: number,
  ): void {
    this.lastAttacker = source;
    this.lastDamageTime = elapsed;
    this.damageTakenRecently = Math.min(200, this.damageTakenRecently + amount);
    this.dodgeRequested = true;
    if (!origin) {
      this.hasBearing = false;
      return;
    }
    const bearing = this.damageBearing.subVectors(origin, botPosition);
    bearing.y *= 0.35;
    if (bearing.lengthSq() < 1e-6) {
      this.hasBearing = false;
      return;
    }
    bearing.normalize();
    this.hasBearing = true;
    const flatFacing = Math.hypot(facing.x, facing.z);
    const flatBearing = Math.hypot(bearing.x, bearing.z);
    const facingDot = flatFacing > 1e-4 && flatBearing > 1e-4
      ? (facing.x * bearing.x + facing.z * bearing.z) / (flatFacing * flatBearing)
      : 1;
    if (facingDot <= awarenessDot) this.alertUntil = elapsed + ALERT_DURATION;
  }

  decay(delta: number): void {
    this.damageTakenRecently = Math.max(0, this.damageTakenRecently - RECENT_DAMAGE_DECAY_PER_SECOND * delta);
  }

  isAlerted(elapsed: number): boolean {
    return elapsed < this.alertUntil;
  }

  attackerIsRecent(elapsed: number): boolean {
    return this.lastAttacker !== null && elapsed - this.lastDamageTime <= ATTACKER_MEMORY_SECONDS;
  }

  consumeDodgeRequest(): boolean {
    const requested = this.dodgeRequested;
    this.dodgeRequested = false;
    return requested;
  }

  reset(): void {
    this.lastAttacker = null;
    this.lastDamageTime = Number.NEGATIVE_INFINITY;
    this.damageTakenRecently = 0;
    this.hasBearing = false;
    this.alertUntil = Number.NEGATIVE_INFINITY;
    this.dodgeRequested = false;
  }
}

/**
 * Solve a fixed-speed ballistic lob from `origin` to `target` under `gravity`.
 * Writes the launch velocity into `out` and returns the flight time, or -1
 * when the target is out of range. Prefers the low arc.
 */
export function solveBallisticLaunch(
  origin: THREE.Vector3,
  target: THREE.Vector3,
  speed: number,
  gravity: number,
  out: THREE.Vector3,
): number {
  const dx = target.x - origin.x;
  const dz = target.z - origin.z;
  const horizontal = Math.hypot(dx, dz);
  const rise = target.y - origin.y;
  if (horizontal < 1e-4) return -1;
  const speedSq = speed * speed;
  const discriminant = speedSq * speedSq - gravity * (gravity * horizontal * horizontal + 2 * rise * speedSq);
  if (discriminant < 0) return -1;
  const root = Math.sqrt(discriminant);
  const tangent = (speedSq - root) / (gravity * horizontal);
  const angle = Math.atan(tangent);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  if (cosine <= 1e-4) return -1;
  out.set(dx / horizontal * speed * cosine, speed * sine, dz / horizontal * speed * cosine);
  return horizontal / (speed * cosine);
}
