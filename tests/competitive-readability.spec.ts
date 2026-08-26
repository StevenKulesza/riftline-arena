import { expect, test } from '@playwright/test';
import { buildCompetitiveReadabilityModel, type CompetitiveReadabilityInput } from '../src/systems/CompetitiveReadability';

test.describe('competitive readability model', () => {
  test('sorts standings, exposes the leader, and handles a tied lead', () => {
    const model = buildCompetitiveReadabilityModel({
      playerId: 'player',
      standings: [
        { id: 'bot-b', label: 'Beta', score: 8 },
        { id: 'player', label: 'You', score: 8, isPlayer: true },
        { id: 'bot-a', label: 'Alpha', score: 4 },
      ],
    });

    expect(model.scoreboard.map((entry) => [entry.rank, entry.id, entry.score])).toEqual([
      [1, 'player', 8],
      [1, 'bot-b', 8],
      [3, 'bot-a', 4],
    ]);
    expect(model.leaderId).toBe('player');
    expect(model.leaderIds).toEqual(['player', 'bot-b']);
    expect(model.leaderScore).toBe(8);
    expect(model.tiedForLead).toBe(true);
    expect(model.playerScore).toBe(8);
    expect(model.deltaToLead).toBe(0);
  });

  test('reports objective ownership, contest state, and clamped progress', () => {
    const model = buildCompetitiveReadabilityModel({
      playerId: 'player',
      objective: {
        id: 'flux-core',
        label: 'Flux Core',
        active: true,
        owner: 'contested',
        progress: 1.4,
        contestProgress: -0.2,
        remainingSeconds: 8,
        direction: 'right',
        distance: 24,
      },
    });

    expect(model.objective).toMatchObject({
      id: 'flux-core',
      active: true,
      owner: 'contested',
      contested: true,
      progress: 1,
      contestProgress: 0,
      remainingSeconds: 8,
    });
    expect(model.cue).toEqual({
      kind: 'objective',
      targetId: 'flux-core',
      label: 'Flux Core',
      direction: 'right',
      distance: 24,
    });
  });

  test('sorts ready and upcoming pickup/event timers deterministically', () => {
    const model = buildCompetitiveReadabilityModel({
      pickups: [
        { id: 'armor', label: 'Armor', remainingSeconds: 12 },
        { id: 'rail', label: 'Rail', remainingSeconds: 0 },
      ],
      events: [
        { id: 'storm', label: 'Storm', remainingSeconds: 4, priority: 1 },
        { id: 'hidden', label: 'Hidden', remainingSeconds: 1, active: false },
      ],
    });

    expect(model.nextEvents.map((event) => [event.id, event.status, event.remainingSeconds])).toEqual([
      ['rail', 'ready', 0],
      ['storm', 'upcoming', 4],
      ['armor', 'upcoming', 12],
    ]);
  });

  test('builds a weapon availability strip with equipped, cooldown, empty, and locked states', () => {
    const model = buildCompetitiveReadabilityModel({
      weapons: [
        { id: 'rocket', label: 'Rocket', slot: 3, ammo: 2, equipped: true },
        { id: 'rail', label: 'Rail', slot: 7, ammo: -1, infiniteAmmo: true },
        { id: 'laser', label: 'Laser', slot: 5, ammo: 20, cooldownSeconds: 2 },
        { id: 'sniper', label: 'Sniper', slot: 6, ammo: 0 },
        { id: 'plasma', label: 'Plasma', slot: 4, ammo: 10, unlocked: false },
      ],
    });

    expect(model.weaponStrip.map((weapon) => [weapon.id, weapon.status, weapon.available])).toEqual([
      ['rocket', 'equipped', true],
      ['plasma', 'locked', false],
      ['laser', 'cooldown', false],
      ['sniper', 'empty', false],
      ['rail', 'available', true],
    ]);
    expect(model.weaponStrip[4]).toMatchObject({ id: 'rail', infiniteAmmo: true, ammo: 0, ammoRatio: null });
  });

  test('uses the active objective cue first, then the highest-priority nearest landmark', () => {
    const landmarkModel = buildCompetitiveReadabilityModel({
      landmarks: [
        { id: 'far-high', label: 'High', direction: 'up', distance: 80, priority: 4 },
        { id: 'near-low', label: 'Near', direction: 'left', distance: 10, priority: 1 },
        { id: 'near-high', label: 'Rail', direction: 'right', distance: 10, priority: 4 },
      ],
    });
    expect(landmarkModel.cue).toEqual({
      kind: 'landmark',
      targetId: 'near-high',
      label: 'Rail',
      direction: 'right',
      distance: 10,
    });

    const objectiveModel = buildCompetitiveReadabilityModel({
      objective: { id: 'core', label: 'Core', active: true, direction: 'ahead' },
      landmarks: [{ id: 'rail', label: 'Rail', direction: 'right', distance: 1, priority: 99 }],
    });
    expect(objectiveModel.cue.kind).toBe('objective');
    expect(objectiveModel.cue.targetId).toBe('core');
  });

  test('clamps invalid display values and safely handles empty input', () => {
    const model = buildCompetitiveReadabilityModel({
      standings: [
        { id: 'bad', score: Number.POSITIVE_INFINITY },
        { id: 'nan', score: Number.NaN },
      ],
      objective: {
        active: true,
        progress: Number.POSITIVE_INFINITY,
        contestProgress: Number.NaN,
        remainingSeconds: Number.POSITIVE_INFINITY,
        direction: 'diagonal',
        distance: Number.NEGATIVE_INFINITY,
      },
      events: [{ id: 'bad-event', remainingSeconds: Number.NEGATIVE_INFINITY }],
      weapons: [{ id: 'bad-weapon', ammo: Number.POSITIVE_INFINITY, maxAmmo: Number.NaN, cooldownSeconds: Number.POSITIVE_INFINITY }],
    });

    expect(model.leaderScore).toBe(9999);
    expect(model.objective.progress).toBe(1);
    expect(model.objective.contestProgress).toBe(0);
    expect(model.objective.remainingSeconds).toBe(3600);
    expect(model.cue.direction).toBe('none');
    expect(model.cue.distance).toBe(0);
    expect(model.nextEvents[0].remainingSeconds).toBe(0);
    expect(model.weaponStrip[0]).toMatchObject({ ammo: 9999, maxAmmo: 0, cooldownSeconds: 60, status: 'cooldown' });

    const empty = buildCompetitiveReadabilityModel();
    expect(empty.scoreboard).toEqual([]);
    expect(empty.leaderId).toBeNull();
    expect(empty.leaderIds).toEqual([]);
    expect(empty.playerScore).toBeNull();
    expect(empty.deltaToLead).toBeNull();
    expect(empty.cue.kind).toBe('none');
  });

  test('does not mutate any input arrays or records', () => {
    const input: CompetitiveReadabilityInput = {
      playerId: 'player',
      standings: [
        { id: 'bot', label: 'Bot', score: 3 },
        { id: 'player', label: 'You', score: 5, isPlayer: true },
      ],
      objective: { id: 'core', active: true, owner: 'player', progress: 0.5 },
      pickups: [{ id: 'armor', remainingSeconds: 2 }],
      events: [{ id: 'storm', remainingSeconds: 1 }],
      weapons: [{ id: 'rocket', slot: 2, ammo: 4 }],
      landmarks: [{ id: 'rail', direction: 'left', distance: 12 }],
    };
    const before = JSON.stringify(input);
    const model = buildCompetitiveReadabilityModel(input);

    expect(JSON.stringify(input)).toBe(before);
    expect(model.scoreboard).not.toBe(input.standings);
    expect(model.nextEvents).not.toBe(input.events);
    expect(model.weaponStrip).not.toBe(input.weapons);
  });
});
