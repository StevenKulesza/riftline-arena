import { expect, test } from '@playwright/test';
import {
  BOT_ARCHETYPES,
  botArchetypeForId,
  botObjectiveUtility,
  botPickupUtility,
  botWeaponUtility,
} from '../src/entities/BotArchetypes';
import {
  BOT_ARCHETYPE_IDS as POLICY_ARCHETYPE_IDS,
  BOT_TARGETS as POLICY_TARGETS,
  buildBotPolicy,
  getBotArchetype,
  getBotDifficultyProfile,
  getTargetPriority,
  selectBotArchetype,
  selectBotTarget,
  snapshotBotArchetype,
  snapshotBotPolicy,
} from '../src/systems/BotArchetypes';

test('bot ids deterministically cycle through named archetypes', () => {
  expect([0, 1, 2, 3, 4, 5].map((id) => botArchetypeForId(id).id)).toEqual([
    'hunter', 'anchor', 'runner', 'hunter', 'anchor', 'runner',
  ]);
  expect([0, 1, 2].map((id) => botArchetypeForId(id).callsign)).toEqual([
    'VIPER', 'BASTION', 'SLIPSTREAM',
  ]);
  expect(botArchetypeForId(-1).id).toBe('runner');
});

test('archetype tunings are distinct and remain inside fair deterministic ranges', () => {
  const tunings = Object.values(BOT_ARCHETYPES);
  expect(new Set(tunings.map((tuning) => JSON.stringify(tuning))).size).toBe(tunings.length);
  expect(new Set(tunings.map((tuning) => tuning.callsign)).size).toBe(tunings.length);
  expect(new Set(tunings.map((tuning) => tuning.visual.accentColor)).size).toBe(tunings.length);

  for (const tuning of tunings) {
    expect(tuning.aggression).toBeGreaterThanOrEqual(0);
    expect(tuning.aggression).toBeLessThanOrEqual(1);
    expect(tuning.reactionSeconds).toBeGreaterThanOrEqual(0.2);
    expect(tuning.reactionSeconds).toBeLessThanOrEqual(0.3);
    expect(tuning.movement.speedScale).toBeGreaterThanOrEqual(0.9);
    expect(tuning.movement.speedScale).toBeLessThanOrEqual(1.12);
    for (const tendency of [
      tuning.movement.strafeTendency,
      tuning.movement.jumpTendency,
      tuning.movement.grappleTendency,
      tuning.movement.jetpackTendency,
      ...Object.values(tuning.objectiveBias),
      ...Object.values(tuning.pickupBias),
    ]) {
      expect(tendency).toBeGreaterThanOrEqual(0);
      expect(tendency).toBeLessThanOrEqual(1);
    }
    expect(new Set(tuning.preferredWeaponRoles).size).toBe(tuning.preferredWeaponRoles.length);
  }
});

test('utility ordering makes each archetype readable', () => {
  const hunter = BOT_ARCHETYPES.hunter;
  const anchor = BOT_ARCHETYPES.anchor;
  const runner = BOT_ARCHETYPES.runner;

  expect(botObjectiveUtility(hunter, 'player')).toBeGreaterThan(botObjectiveUtility(hunter, 'core'));
  expect(botPickupUtility(hunter, 'damage')).toBeGreaterThan(botPickupUtility(hunter, 'armor'));
  expect(botWeaponUtility(hunter, 'sniper')).toBeGreaterThan(botWeaponUtility(hunter, 'machine'));

  expect(botObjectiveUtility(anchor, 'core')).toBeGreaterThan(botObjectiveUtility(anchor, 'player'));
  expect(botPickupUtility(anchor, 'armor')).toBeGreaterThan(botPickupUtility(anchor, 'speed'));
  expect(botWeaponUtility(anchor, 'rocket')).toBeGreaterThan(botWeaponUtility(anchor, 'sniper'));

  expect(botObjectiveUtility(runner, 'pickup')).toBeGreaterThan(botObjectiveUtility(runner, 'player'));
  expect(botPickupUtility(runner, 'speed')).toBeGreaterThan(botPickupUtility(runner, 'armor'));
  expect(botWeaponUtility(runner, 'plasma')).toBeGreaterThan(botWeaponUtility(runner, 'rail'));
});

test('policy archetypes expose four distinct readable tactical roles', () => {
  expect(POLICY_ARCHETYPE_IDS).toEqual(['hunter', 'anchor', 'runner', 'thief']);
  expect(POLICY_TARGETS).toEqual(['player', 'core', 'powerup', 'route']);

  for (const id of POLICY_ARCHETYPE_IDS) {
    const archetype = getBotArchetype(id);
    expect(archetype.behaviorLabel.length).toBeGreaterThan(0);
    expect(archetype.targetPriorities).toEqual(expect.arrayContaining([...POLICY_TARGETS]));
    expect(archetype.targetPriorities).toHaveLength(POLICY_TARGETS.length);
    expect(archetype.aggression).toBeGreaterThanOrEqual(0);
    expect(archetype.aggression).toBeLessThanOrEqual(1);
    expect(archetype.preferredRange.min).toBeLessThan(archetype.preferredRange.max);
    expect(archetype.weaponAffinity.length).toBeGreaterThan(0);
    expect(archetype.objectiveCommitment).toBeGreaterThanOrEqual(0);
    expect(archetype.objectiveCommitment).toBeLessThanOrEqual(1);
    expect(archetype.pickupGreed).toBeGreaterThanOrEqual(0);
    expect(archetype.pickupGreed).toBeLessThanOrEqual(1);
  }

  expect(getBotArchetype('hunter').targetPriorities[0]).toBe('player');
  expect(getBotArchetype('anchor').targetPriorities[0]).toBe('core');
  expect(getBotArchetype('runner').targetPriorities[0]).toBe('route');
  expect(getBotArchetype('thief').targetPriorities[0]).toBe('powerup');
});

test('policy selection uses canonical archetype assignment and target priorities', () => {
  expect([0, 1, 2, 3, 4].map((id) => selectBotArchetype(id).id)).toEqual([
    'hunter', 'anchor', 'runner', 'thief', 'hunter',
  ]);
  expect(selectBotArchetype(1, ['thief', 'runner']).id).toBe('thief');
  expect(getTargetPriority('hunter', 'player')).toBe(0);
  expect(getTargetPriority('hunter', 'route')).toBe(3);

  expect(selectBotTarget('hunter', [
    { target: 'route', urgency: 1 },
    { target: 'player', urgency: 0 },
    { target: 'core', urgency: 1 },
  ])).toMatchObject({ target: 'player', priorityRank: 0, reason: 'priority' });
  expect(selectBotTarget('runner', [
    { target: 'player', available: false },
    { target: 'route' },
  ])).toMatchObject({ target: 'route', priorityRank: 0 });
});

test('policy target ties resolve by urgency then stable id independent of input order', () => {
  const candidates = [
    { target: 'player' as const, urgency: 0.5, stableId: 9 },
    { target: 'player' as const, urgency: 0.5, stableId: 2 },
  ];
  const forward = selectBotTarget('hunter', candidates);
  const reversed = selectBotTarget('hunter', [...candidates].reverse());
  expect(forward).toEqual(reversed);
  expect(forward).toMatchObject({ target: 'player', stableId: 2, reason: 'tie-break' });
  expect(selectBotTarget('hunter', [
    { target: 'player', urgency: 0.2, stableId: 1 },
    { target: 'player', urgency: 0.8, stableId: 8 },
  ])).toMatchObject({ urgency: 0.8, stableId: 8 });
});

test('policy difficulty deterministically scales reaction, aim, and aggression', () => {
  expect(getBotDifficultyProfile('easy').reactionDelayScale).toBeGreaterThan(1);
  expect(getBotDifficultyProfile('hard').reactionDelayScale).toBeLessThan(1);

  const easy = buildBotPolicy('hunter', 'easy');
  const normal = buildBotPolicy('hunter', 'normal');
  const hard = buildBotPolicy('hunter', 'hard');
  expect(easy.reactionDelaySeconds).toBeGreaterThan(normal.reactionDelaySeconds);
  expect(easy.aimErrorDegrees).toBeGreaterThan(normal.aimErrorDegrees);
  expect(easy.aggression).toBeLessThan(normal.aggression);
  expect(hard.reactionDelaySeconds).toBeLessThan(normal.reactionDelaySeconds);
  expect(hard.aimErrorDegrees).toBeLessThan(normal.aimErrorDegrees);
  expect(hard.aggression).toBeGreaterThan(normal.aggression);
  expect(buildBotPolicy('hunter', 'hard')).toEqual(hard);
});

test('policy invalid input falls back and clamps to safe bounds', () => {
  const fallback = buildBotPolicy('missing', 'missing', {
    aggression: Number.POSITIVE_INFINITY,
    objectiveCommitment: -4,
    pickupGreed: 4,
    reactionDelaySeconds: 0,
    aimErrorDegrees: 99,
    preferredRange: { min: 180, max: -4 },
  });
  expect(fallback.archetypeId).toBe('hunter');
  expect(fallback.difficulty).toBe('normal');
  expect(fallback.aggression).toBe(getBotArchetype('hunter').aggression);
  expect(fallback.objectiveCommitment).toBe(0);
  expect(fallback.pickupGreed).toBe(1);
  expect(fallback.reactionDelaySeconds).toBe(0.05);
  expect(fallback.aimErrorDegrees).toBe(8);
  expect(fallback.preferredRange).toEqual({ min: 0, max: 180 });
  expect(selectBotTarget('hunter', [{ target: 'player', available: false }])).toMatchObject({
    target: null,
    reason: 'none-available',
  });
});

test('policy snapshots are deeply immutable and preserve priority ordering', () => {
  const archetype = snapshotBotArchetype('runner');
  const policy = buildBotPolicy('runner', 'normal');
  const snapshot = snapshotBotPolicy(policy);
  expect(archetype.targetPriorities[0]).toBe('route');
  expect(Object.isFrozen(archetype)).toBe(true);
  expect(Object.isFrozen(archetype.targetPriorities)).toBe(true);
  expect(Object.isFrozen(archetype.preferredRange)).toBe(true);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.weaponAffinity)).toBe(true);
  expect(snapshotBotPolicy(snapshot)).toEqual(snapshot);

  const aggression = snapshot.aggression;
  expect(Reflect.set(snapshot as object, 'aggression', 0)).toBe(false);
  expect(snapshot.aggression).toBe(aggression);
});
