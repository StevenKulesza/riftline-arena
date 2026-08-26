import type { WeaponId } from '../game/config';

/**
 * The four target classes are deliberately small so an integration can map
 * them to existing Game/Bot facts without giving the policy system ownership
 * of world state.
 */
export type BotTarget = 'player' | 'core' | 'powerup' | 'route';

export type BotArchetypeId = 'hunter' | 'anchor' | 'runner' | 'thief';

export type BotDifficultyId = 'easy' | 'normal' | 'hard' | 'expert';

export type PreferredRange = Readonly<{
  min: number;
  max: number;
}>;

export type BotArchetype = Readonly<{
  id: BotArchetypeId;
  behaviorLabel: string;
  targetPriorities: readonly BotTarget[];
  aggression: number;
  preferredRange: PreferredRange;
  weaponAffinity: readonly WeaponId[];
  objectiveCommitment: number;
  pickupGreed: number;
}>;

export type BotDifficultyProfile = Readonly<{
  id: BotDifficultyId;
  label: string;
  reactionDelayScale: number;
  aimErrorScale: number;
  aggressionScale: number;
}>;

export type BotTargetCandidate = Readonly<{
  target: BotTarget;
  /** False candidates are ignored without affecting deterministic ordering. */
  available?: boolean;
  /** A bounded urgency hint breaks ties between candidates of one target class. */
  urgency?: number;
  /** Lower stable ids win equal-priority ties. Use world/entity ids at integration time. */
  stableId?: number;
}>;

export type BotTargetDecision = Readonly<{
  target: BotTarget | null;
  stableId: number | null;
  priorityRank: number | null;
  urgency: number;
  score: number;
  reason: 'priority' | 'tie-break' | 'none-available';
}>;

export type BotPolicyOverrides = Readonly<{
  aggression?: number;
  objectiveCommitment?: number;
  pickupGreed?: number;
  reactionDelaySeconds?: number;
  aimErrorDegrees?: number;
  preferredRange?: Readonly<Partial<PreferredRange>>;
}>;

export type BotPolicySnapshot = Readonly<{
  archetypeId: BotArchetypeId;
  behaviorLabel: string;
  difficulty: BotDifficultyId;
  targetPriorities: readonly BotTarget[];
  aggression: number;
  preferredRange: PreferredRange;
  weaponAffinity: readonly WeaponId[];
  objectiveCommitment: number;
  pickupGreed: number;
  reactionDelaySeconds: number;
  aimErrorDegrees: number;
}>;

export const BOT_ARCHETYPE_IDS: readonly BotArchetypeId[] = Object.freeze([
  'hunter',
  'anchor',
  'runner',
  'thief',
]);

export const BOT_TARGETS: readonly BotTarget[] = Object.freeze([
  'player',
  'core',
  'powerup',
  'route',
]);

/**
 * Difficulty is a deterministic multiplier over the existing bot model:
 * normal starts near the current 200–320ms reaction / 1.5–3 degree aim band;
 * the other profiles move that band conservatively instead of adding noise.
 */
export const BOT_DIFFICULTY_PROFILES: Readonly<Record<BotDifficultyId, BotDifficultyProfile>> = Object.freeze({
  easy: Object.freeze({
    id: 'easy',
    label: 'Training pace',
    reactionDelayScale: 1.3,
    aimErrorScale: 1.3,
    aggressionScale: 0.86,
  }),
  normal: Object.freeze({
    id: 'normal',
    label: 'Arena standard',
    reactionDelayScale: 1,
    aimErrorScale: 1,
    aggressionScale: 1,
  }),
  hard: Object.freeze({
    id: 'hard',
    label: 'Pressure test',
    reactionDelayScale: 0.82,
    aimErrorScale: 0.78,
    aggressionScale: 1.1,
  }),
  expert: Object.freeze({
    id: 'expert',
    label: 'Elite pressure',
    reactionDelayScale: 0.68,
    aimErrorScale: 0.62,
    aggressionScale: 1.18,
  }),
});

const BASE_REACTION_DELAY_SECONDS = 0.24;
const BASE_AIM_ERROR_DEGREES = 2.2;
const MAX_PREFERRED_RANGE = 200;
const MIN_REACTION_DELAY_SECONDS = 0.05;
const MAX_REACTION_DELAY_SECONDS = 1.5;
const MIN_AIM_ERROR_DEGREES = 0.1;
const MAX_AIM_ERROR_DEGREES = 8;
const TARGET_PRIORITY_WEIGHT = 100;
const TARGET_URGENCY_WEIGHT = 10;

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function clampFinite(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value as number));
}

function isArchetypeId(value: unknown): value is BotArchetypeId {
  return typeof value === 'string' && (BOT_ARCHETYPE_IDS as readonly string[]).includes(value);
}

function isDifficultyId(value: unknown): value is BotDifficultyId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BOT_DIFFICULTY_PROFILES, value);
}

function isBotTarget(value: unknown): value is BotTarget {
  return typeof value === 'string' && (BOT_TARGETS as readonly string[]).includes(value);
}

function freezeArchetype(archetype: BotArchetype): BotArchetype {
  return Object.freeze({
    ...archetype,
    targetPriorities: freezeArray(archetype.targetPriorities),
    preferredRange: Object.freeze({ ...archetype.preferredRange }),
    weaponAffinity: freezeArray(archetype.weaponAffinity),
  });
}

function normalizeTargetPriorities(values: readonly BotTarget[]): readonly BotTarget[] {
  const seen = new Set<BotTarget>();
  const priorities: BotTarget[] = [];
  for (const target of values) {
    if (!isBotTarget(target) || seen.has(target)) continue;
    seen.add(target);
    priorities.push(target);
  }
  for (const target of BOT_TARGETS) {
    if (seen.has(target)) continue;
    seen.add(target);
    priorities.push(target);
  }
  return priorities;
}

const ARCHETYPE_DEFINITIONS: Record<BotArchetypeId, BotArchetype> = {
  hunter: freezeArchetype({
    id: 'hunter',
    behaviorLabel: 'Pressure hunter',
    targetPriorities: ['player', 'core', 'powerup', 'route'],
    aggression: 0.78,
    preferredRange: { min: 6, max: 24 },
    weaponAffinity: ['shotgun', 'rocket', 'machine'],
    objectiveCommitment: 0.38,
    pickupGreed: 0.28,
  }),
  anchor: freezeArchetype({
    id: 'anchor',
    behaviorLabel: 'Core anchor',
    targetPriorities: ['core', 'player', 'powerup', 'route'],
    aggression: 0.56,
    preferredRange: { min: 10, max: 34 },
    weaponAffinity: ['plasma', 'laser', 'rocket'],
    objectiveCommitment: 0.9,
    pickupGreed: 0.52,
  }),
  runner: freezeArchetype({
    id: 'runner',
    behaviorLabel: 'Route runner',
    targetPriorities: ['route', 'core', 'powerup', 'player'],
    aggression: 0.48,
    preferredRange: { min: 8, max: 28 },
    weaponAffinity: ['disc', 'rocket', 'plasma', 'shotgun'],
    objectiveCommitment: 0.82,
    pickupGreed: 0.66,
  }),
  thief: freezeArchetype({
    id: 'thief',
    behaviorLabel: 'Powerup thief',
    targetPriorities: ['powerup', 'player', 'core', 'route'],
    aggression: 0.62,
    preferredRange: { min: 12, max: 32 },
    weaponAffinity: ['sniper', 'rail', 'machine', 'laser'],
    objectiveCommitment: 0.42,
    pickupGreed: 0.95,
  }),
};

export const BOT_ARCHETYPES: Readonly<Record<BotArchetypeId, BotArchetype>> = Object.freeze(ARCHETYPE_DEFINITIONS);

function resolveArchetypeId(value: unknown): BotArchetypeId {
  return isArchetypeId(value) ? value : 'hunter';
}

function resolveDifficultyId(value: unknown): BotDifficultyId {
  return isDifficultyId(value) ? value : 'normal';
}

function finiteStableId(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value as number)) : Number.MAX_SAFE_INTEGER;
}

/** Return an immutable definition, falling back to hunter for invalid input. */
export function getBotArchetype(value: BotArchetypeId | string): BotArchetype {
  return BOT_ARCHETYPES[resolveArchetypeId(value)];
}

/** Return an immutable profile, falling back to normal for invalid input. */
export function getBotDifficultyProfile(value: BotDifficultyId | string): BotDifficultyProfile {
  return BOT_DIFFICULTY_PROFILES[resolveDifficultyId(value)];
}

/**
 * Assign archetypes by stable bot id. Candidate pools are canonicalized before
 * cycling, so a caller's array order cannot accidentally change role balance.
 */
export function selectBotArchetype(
  botId: number,
  candidates: readonly (BotArchetypeId | string)[] = BOT_ARCHETYPE_IDS,
): BotArchetype {
  const allowed = new Set(candidates.filter(isArchetypeId));
  const ordered = BOT_ARCHETYPE_IDS.filter((id) => allowed.has(id));
  const pool = ordered.length > 0 ? ordered : BOT_ARCHETYPE_IDS;
  const normalizedId = Number.isFinite(botId) ? Math.max(0, Math.floor(botId)) : 0;
  return getBotArchetype(pool[normalizedId % pool.length]);
}

/** Return zero-based priority rank; values outside the policy are lowest priority. */
export function getTargetPriority(
  archetype: BotArchetypeId | string | BotArchetype,
  target: BotTarget,
): number {
  const definition = typeof archetype === 'object' ? archetype : getBotArchetype(archetype);
  const rank = definition.targetPriorities.indexOf(target);
  return rank >= 0 ? rank : definition.targetPriorities.length;
}

/**
 * Select one available target using fixed priority, bounded urgency, then
 * lowest stable id. No world lookup or randomness occurs here.
 */
export function selectBotTarget(
  archetype: BotArchetypeId | string | BotArchetype,
  candidates: readonly BotTargetCandidate[],
): BotTargetDecision {
  const definition = typeof archetype === 'object' ? archetype : getBotArchetype(archetype);
  let winner: { candidate: BotTargetCandidate; rank: number; urgency: number; stableId: number; score: number } | null = null;

  for (const candidate of candidates) {
    if (candidate.available === false || !isBotTarget(candidate.target)) continue;
    const rank = getTargetPriority(definition, candidate.target);
    const urgency = clampFinite(candidate.urgency, 0, 1, 0);
    const stableId = finiteStableId(candidate.stableId);
    const score = (BOT_TARGETS.length - rank) * TARGET_PRIORITY_WEIGHT + urgency * TARGET_URGENCY_WEIGHT;
    const shouldWin = winner === null
      || rank < winner.rank
      || (rank === winner.rank && urgency > winner.urgency)
      || (rank === winner.rank && urgency === winner.urgency && stableId < winner.stableId);
    if (shouldWin) winner = { candidate, rank, urgency, stableId, score };
  }

  if (winner === null) {
    return Object.freeze({
      target: null,
      stableId: null,
      priorityRank: null,
      urgency: 0,
      score: 0,
      reason: 'none-available',
    });
  }

  const equalPriorityCandidates = candidates.filter((candidate) => {
    if (candidate.available === false || !isBotTarget(candidate.target)) return false;
    const rank = getTargetPriority(definition, candidate.target);
    return rank === winner?.rank && clampFinite(candidate.urgency, 0, 1, 0) === winner?.urgency;
  });
  return Object.freeze({
    target: winner.candidate.target,
    stableId: winner.stableId === Number.MAX_SAFE_INTEGER ? null : winner.stableId,
    priorityRank: winner.rank,
    urgency: winner.urgency,
    score: winner.score,
    reason: equalPriorityCandidates.length > 1 ? 'tie-break' : 'priority',
  });
}

export function snapshotBotArchetype(value: BotArchetypeId | string | BotArchetype): BotArchetype {
  const source = typeof value === 'object' ? value : getBotArchetype(value);
  const rangeMin = clampFinite(source.preferredRange.min, 0, MAX_PREFERRED_RANGE, 0);
  const rangeMax = clampFinite(source.preferredRange.max, 0, MAX_PREFERRED_RANGE, 0);
  return freezeArchetype({
    id: resolveArchetypeId(source.id),
    behaviorLabel: typeof source.behaviorLabel === 'string' && source.behaviorLabel.length > 0
      ? source.behaviorLabel
      : getBotArchetype('hunter').behaviorLabel,
    targetPriorities: normalizeTargetPriorities(source.targetPriorities),
    aggression: clampFinite(source.aggression, 0, 1, 0.5),
    preferredRange: { min: Math.min(rangeMin, rangeMax), max: Math.max(rangeMin, rangeMax) },
    weaponAffinity: freezeArray(source.weaponAffinity),
    objectiveCommitment: clampFinite(source.objectiveCommitment, 0, 1, 0.5),
    pickupGreed: clampFinite(source.pickupGreed, 0, 1, 0.5),
  });
}

export function snapshotBotPolicy(policy: BotPolicySnapshot): BotPolicySnapshot {
  const rangeMin = clampFinite(policy.preferredRange.min, 0, MAX_PREFERRED_RANGE, 0);
  const rangeMax = clampFinite(policy.preferredRange.max, 0, MAX_PREFERRED_RANGE, 0);
  return Object.freeze({
    archetypeId: resolveArchetypeId(policy.archetypeId),
    behaviorLabel: typeof policy.behaviorLabel === 'string' ? policy.behaviorLabel : '',
    difficulty: resolveDifficultyId(policy.difficulty),
    targetPriorities: freezeArray(normalizeTargetPriorities(policy.targetPriorities)),
    aggression: clampFinite(policy.aggression, 0, 1, 0.5),
    preferredRange: Object.freeze({ min: Math.min(rangeMin, rangeMax), max: Math.max(rangeMin, rangeMax) }),
    weaponAffinity: freezeArray(policy.weaponAffinity),
    objectiveCommitment: clampFinite(policy.objectiveCommitment, 0, 1, 0.5),
    pickupGreed: clampFinite(policy.pickupGreed, 0, 1, 0.5),
    reactionDelaySeconds: clampFinite(policy.reactionDelaySeconds, MIN_REACTION_DELAY_SECONDS, MAX_REACTION_DELAY_SECONDS, BASE_REACTION_DELAY_SECONDS),
    aimErrorDegrees: clampFinite(policy.aimErrorDegrees, MIN_AIM_ERROR_DEGREES, MAX_AIM_ERROR_DEGREES, BASE_AIM_ERROR_DEGREES),
  });
}

/** Build the immutable policy snapshot that a Bot integration can consume. */
export function buildBotPolicy(
  archetypeValue: BotArchetypeId | string,
  difficultyValue: BotDifficultyId | string,
  overrides: BotPolicyOverrides = {},
): BotPolicySnapshot {
  const archetype = getBotArchetype(archetypeValue);
  const difficulty = getBotDifficultyProfile(difficultyValue);
  const baseMin = clampFinite(overrides.preferredRange?.min, 0, MAX_PREFERRED_RANGE, archetype.preferredRange.min);
  const baseMax = clampFinite(overrides.preferredRange?.max, 0, MAX_PREFERRED_RANGE, archetype.preferredRange.max);

  return snapshotBotPolicy({
    archetypeId: archetype.id,
    behaviorLabel: archetype.behaviorLabel,
    difficulty: difficulty.id,
    targetPriorities: archetype.targetPriorities,
    aggression: clampFinite(overrides.aggression, 0, 1, archetype.aggression * difficulty.aggressionScale),
    preferredRange: { min: baseMin, max: baseMax },
    weaponAffinity: archetype.weaponAffinity,
    objectiveCommitment: clampFinite(overrides.objectiveCommitment, 0, 1, archetype.objectiveCommitment),
    pickupGreed: clampFinite(overrides.pickupGreed, 0, 1, archetype.pickupGreed),
    reactionDelaySeconds: clampFinite(
      overrides.reactionDelaySeconds,
      MIN_REACTION_DELAY_SECONDS,
      MAX_REACTION_DELAY_SECONDS,
      BASE_REACTION_DELAY_SECONDS * difficulty.reactionDelayScale,
    ),
    aimErrorDegrees: clampFinite(
      overrides.aimErrorDegrees,
      MIN_AIM_ERROR_DEGREES,
      MAX_AIM_ERROR_DEGREES,
      BASE_AIM_ERROR_DEGREES * difficulty.aimErrorScale,
    ),
  });
}
