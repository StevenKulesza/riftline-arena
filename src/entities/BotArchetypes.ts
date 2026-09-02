import type { WeaponId } from '../game/config';

export type BotArchetypeId = 'hunter' | 'anchor' | 'runner';
export type BotObjectiveKind = 'player' | 'core' | 'pickup' | 'recovery';
export type BotPickupKind = 'health' | 'armor' | 'damage' | 'speed' | WeaponId;
export type BotWeaponRole = 'close' | 'splash' | 'projectile' | 'sustain' | 'precision';

export type BotMovementTuning = Readonly<{
  speedScale: number;
  strafeTendency: number;
  jumpTendency: number;
  grappleTendency: number;
  jetpackTendency: number;
}>;

export type BotVisualIdentity = Readonly<{
  accentColor: number;
  markerShape: 'chevron' | 'diamond' | 'split-ring';
  roleLabel: 'HUNTER' | 'ANCHOR' | 'RUNNER';
}>;

export type BotArchetypeTuning = Readonly<{
  id: BotArchetypeId;
  callsign: string;
  aggression: number;
  /**
   * Warfork-style skill scalar S in [0.1, 1]. Drives reaction latency, fire
   * probability, aim noise radius, projectile prediction, dodging, weapon
   * lockout and respawn delay.
   */
  skill: number;
  reactionSeconds: number;
  movement: BotMovementTuning;
  objectiveBias: Readonly<Record<BotObjectiveKind, number>>;
  pickupBias: Readonly<Record<'health' | 'armor' | 'damage' | 'speed' | 'weapon', number>>;
  preferredWeaponRoles: readonly BotWeaponRole[];
  visual: BotVisualIdentity;
}>;

export const BOT_ARCHETYPES: Readonly<Record<BotArchetypeId, BotArchetypeTuning>> = {
  hunter: {
    id: 'hunter',
    callsign: 'VIPER',
    aggression: 0.92,
    skill: 0.92,
    reactionSeconds: 0.2,
    movement: {
      speedScale: 1.04,
      strafeTendency: 0.82,
      jumpTendency: 0.74,
      grappleTendency: 0.68,
      jetpackTendency: 0.56,
    },
    objectiveBias: { player: 1, core: 0.62, pickup: 0.42, recovery: 0.34 },
    pickupBias: { health: 0.72, armor: 0.58, damage: 1, speed: 0.7, weapon: 0.82 },
    preferredWeaponRoles: ['precision', 'close', 'splash', 'sustain', 'projectile'],
    visual: { accentColor: 0xff526f, markerShape: 'chevron', roleLabel: 'HUNTER' },
  },
  anchor: {
    id: 'anchor',
    callsign: 'BASTION',
    aggression: 0.56,
    skill: 0.62,
    reactionSeconds: 0.28,
    movement: {
      speedScale: 0.94,
      strafeTendency: 0.42,
      jumpTendency: 0.36,
      grappleTendency: 0.34,
      jetpackTendency: 0.44,
    },
    objectiveBias: { player: 0.58, core: 1, pickup: 0.54, recovery: 0.62 },
    pickupBias: { health: 0.78, armor: 1, damage: 0.74, speed: 0.42, weapon: 0.68 },
    preferredWeaponRoles: ['splash', 'sustain', 'close', 'projectile', 'precision'],
    visual: { accentColor: 0x62a6ff, markerShape: 'diamond', roleLabel: 'ANCHOR' },
  },
  runner: {
    id: 'runner',
    callsign: 'SLIPSTREAM',
    aggression: 0.66,
    skill: 0.76,
    reactionSeconds: 0.24,
    movement: {
      speedScale: 1.1,
      strafeTendency: 0.94,
      jumpTendency: 0.92,
      grappleTendency: 0.96,
      jetpackTendency: 0.9,
    },
    objectiveBias: { player: 0.5, core: 0.88, pickup: 1, recovery: 0.78 },
    pickupBias: { health: 0.56, armor: 0.48, damage: 0.72, speed: 1, weapon: 0.86 },
    preferredWeaponRoles: ['projectile', 'sustain', 'close', 'splash', 'precision'],
    visual: { accentColor: 0x58f5c3, markerShape: 'split-ring', roleLabel: 'RUNNER' },
  },
};

const ARCHETYPE_ORDER: readonly BotArchetypeId[] = ['hunter', 'anchor', 'runner'];

export function botArchetypeForId(botId: number): BotArchetypeTuning {
  const index = ((Math.trunc(botId) % ARCHETYPE_ORDER.length) + ARCHETYPE_ORDER.length) % ARCHETYPE_ORDER.length;
  return BOT_ARCHETYPES[ARCHETYPE_ORDER[index]];
}

export function botObjectiveUtility(tuning: BotArchetypeTuning, objective: BotObjectiveKind): number {
  return tuning.objectiveBias[objective];
}

export function botPickupUtility(tuning: BotArchetypeTuning, pickup: BotPickupKind): number {
  const category = pickup === 'health' || pickup === 'armor' || pickup === 'damage' || pickup === 'speed'
    ? pickup
    : 'weapon';
  return tuning.pickupBias[category];
}

export function weaponRole(weapon: WeaponId): BotWeaponRole {
  switch (weapon) {
    case 'shotgun': return 'close';
    case 'rocket': return 'splash';
    case 'disc': return 'projectile';
    case 'plasma': return 'projectile';
    case 'sniper':
    case 'rail': return 'precision';
    default: return 'sustain';
  }
}

export function botWeaponUtility(tuning: BotArchetypeTuning, weapon: WeaponId): number {
  const rank = tuning.preferredWeaponRoles.indexOf(weaponRole(weapon));
  return rank < 0 ? 0 : 1 - rank / tuning.preferredWeaponRoles.length;
}

/** Skill-derived combat parameters (Warfork `ai_class_dmbot` / `bot_spawn` scaling). */
export type BotSkillProfile = Readonly<{
  skill: number;
  /** Seconds a newly seen enemy stays latched before the bot may fire. */
  reactionSeconds: number;
  /** Chance to pull the trigger on each ready tick for single-shot weapons. */
  fireProbability: number;
  /** Bots below this skill do not lead projectiles. */
  predictsProjectiles: boolean;
  /** Bots below this skill do not sidestep incoming rockets. */
  dodgesProjectiles: boolean;
  /** Seconds a weapon choice is locked after switching. */
  weaponLockoutSeconds: number;
  respawnDelaySeconds: number;
  /** Bots at or above this skill bunny-hop on straight path segments. */
  bunnyHops: boolean;
}>;

export function botSkillProfile(tuning: BotArchetypeTuning): BotSkillProfile {
  const skill = Math.min(1, Math.max(0.1, tuning.skill));
  return {
    skill,
    reactionSeconds: tuning.reactionSeconds * (0.35 + 1.65 * (1 - skill)),
    fireProbability: Math.min(1, Math.max(0.25, 1.25 - skill)),
    predictsProjectiles: skill >= 0.33,
    dodgesProjectiles: skill >= 0.25,
    weaponLockoutSeconds: 1.5 + 1.5 * (1 - skill),
    respawnDelaySeconds: 2.4 - 0.8 * skill,
    bunnyHops: skill >= 0.33,
  };
}
