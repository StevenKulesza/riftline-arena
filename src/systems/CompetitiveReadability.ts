export type ReadabilityDirection = 'left' | 'right' | 'ahead' | 'behind' | 'up' | 'down' | 'none';

export type ObjectiveOwner = 'player' | 'enemy' | 'contested' | 'unclaimed';

export type EventTimerKind = 'pickup' | 'event' | 'objective' | 'other';

export interface StandingInput {
  readonly id: string;
  readonly label?: string;
  readonly score?: number;
  readonly isPlayer?: boolean;
}

export interface ObjectiveInput {
  readonly id?: string;
  readonly label?: string;
  readonly active?: boolean;
  readonly owner?: ObjectiveOwner;
  readonly ownerId?: string | null;
  readonly contested?: boolean;
  readonly progress?: number;
  readonly contestProgress?: number;
  readonly remainingSeconds?: number;
  readonly direction?: string;
  readonly distance?: number;
}

export interface EventTimerInput {
  readonly id: string;
  readonly label?: string;
  readonly remainingSeconds?: number;
  readonly kind?: EventTimerKind;
  readonly priority?: number;
  readonly active?: boolean;
}

export interface WeaponInventoryInput {
  readonly id: string;
  readonly label?: string;
  readonly slot?: number;
  readonly ammo?: number;
  readonly maxAmmo?: number;
  readonly infiniteAmmo?: boolean;
  readonly unlocked?: boolean;
  readonly equipped?: boolean;
  readonly cooldownSeconds?: number;
}

export interface LandmarkDirectionInput {
  readonly id: string;
  readonly label?: string;
  readonly direction?: string;
  readonly distance?: number;
  readonly priority?: number;
  readonly active?: boolean;
}

export interface CompetitiveReadabilityInput {
  readonly playerId?: string;
  readonly standings?: readonly StandingInput[];
  readonly objective?: ObjectiveInput | null;
  readonly pickups?: readonly EventTimerInput[];
  readonly events?: readonly EventTimerInput[];
  readonly weapons?: readonly WeaponInventoryInput[];
  readonly landmarks?: readonly LandmarkDirectionInput[];
}

export interface ScoreboardEntry {
  readonly rank: number;
  readonly id: string;
  readonly label: string;
  readonly score: number;
  readonly isPlayer: boolean;
  readonly deltaToLeader: number;
}

export interface ObjectivePresentation {
  readonly id: string | null;
  readonly label: string;
  readonly active: boolean;
  readonly owner: ObjectiveOwner;
  readonly ownerId: string | null;
  readonly contested: boolean;
  readonly progress: number;
  readonly contestProgress: number;
  readonly remainingSeconds: number | null;
}

export interface EventTimerPresentation {
  readonly id: string;
  readonly label: string;
  readonly source: 'pickup' | 'event';
  readonly kind: EventTimerKind;
  readonly priority: number;
  readonly remainingSeconds: number;
  readonly status: 'ready' | 'upcoming';
}

export type WeaponAvailability = 'equipped' | 'available' | 'cooldown' | 'empty' | 'locked';

export interface WeaponAvailabilityEntry {
  readonly id: string;
  readonly label: string;
  readonly slot: number | null;
  /** Non-negative display ammo. Infinite ammo is represented by infiniteAmmo. */
  readonly ammo: number;
  readonly maxAmmo: number | null;
  readonly ammoRatio: number | null;
  readonly infiniteAmmo: boolean;
  readonly unlocked: boolean;
  readonly equipped: boolean;
  readonly cooldownSeconds: number;
  readonly available: boolean;
  readonly status: WeaponAvailability;
}

export interface ReadabilityCue {
  readonly kind: 'objective' | 'landmark' | 'none';
  readonly targetId: string | null;
  readonly label: string | null;
  readonly direction: ReadabilityDirection;
  readonly distance: number | null;
}

export interface CompetitiveReadabilityModel {
  readonly scoreboard: readonly ScoreboardEntry[];
  readonly leaderId: string | null;
  readonly leaderIds: readonly string[];
  readonly leaderScore: number;
  readonly tiedForLead: boolean;
  readonly playerScore: number | null;
  readonly deltaToLead: number | null;
  readonly objective: ObjectivePresentation;
  readonly nextEvents: readonly EventTimerPresentation[];
  readonly weaponStrip: readonly WeaponAvailabilityEntry[];
  readonly cue: ReadabilityCue;
}

// These bounds keep presentation data useful even if a future integration
// passes stale, NaN, or unbounded simulation values into the HUD model.
const MAX_SCORE = 9_999;
const MAX_TIMER_SECONDS = 3_600;
const MAX_AMMO = 9_999;
const MAX_COOLDOWN_SECONDS = 60;
const MAX_DISTANCE = 9_999;
const MAX_PRIORITY = 100;

function clamp(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function integer(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  return Math.trunc(clamp(value, minimum, maximum, fallback));
}

function text(value: string | undefined | null, fallback: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || fallback;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function uniqueId(value: string | undefined | null, fallback: string, seen: Set<string>): string {
  const base = text(value, fallback);
  if (!seen.has(base)) {
    seen.add(base);
    return base;
  }
  let suffix = 2;
  let candidate = `${base}#${suffix}`;
  while (seen.has(candidate)) {
    suffix += 1;
    candidate = `${base}#${suffix}`;
  }
  seen.add(candidate);
  return candidate;
}

function direction(value: string | undefined): ReadabilityDirection {
  switch (value) {
    case 'left':
    case 'right':
    case 'ahead':
    case 'behind':
    case 'up':
    case 'down':
      return value;
    default:
      return 'none';
  }
}

function buildScoreboard(input: CompetitiveReadabilityInput): {
  scoreboard: ScoreboardEntry[];
  leaderId: string | null;
  leaderIds: string[];
  leaderScore: number;
  playerScore: number | null;
  deltaToLead: number | null;
} {
  const seenIds = new Set<string>();
  const entries = (input.standings ?? []).map((standing, index) => ({
    id: uniqueId(standing.id, `participant-${index + 1}`, seenIds),
    label: text(standing.label, text(standing.id, `Participant ${index + 1}`)),
    score: integer(standing.score, -MAX_SCORE, MAX_SCORE, 0),
    isPlayer: standing.isPlayer === true,
    sourceIndex: index,
  }));

  entries.sort((left, right) => (
    right.score - left.score
    || Number(right.isPlayer) - Number(left.isPlayer)
    || compareText(left.label, right.label)
    || compareText(left.id, right.id)
    || left.sourceIndex - right.sourceIndex
  ));

  const leaderScore = entries[0]?.score ?? 0;
  const leaderIds = entries.filter((entry) => entry.score === leaderScore).map((entry) => entry.id);
  const scoreboard = entries.map((entry, index) => {
    const previous = entries[index - 1];
    const rank = previous && previous.score === entry.score ? index === 0 ? 1 : scoreboardRank(entries, index) : index + 1;
    return {
      rank,
      id: entry.id,
      label: entry.label,
      score: entry.score,
      isPlayer: entry.isPlayer,
      deltaToLeader: Math.max(0, leaderScore - entry.score),
    };
  });

  const requestedPlayerId = text(input.playerId, '');
  const player = requestedPlayerId
    ? scoreboard.find((entry) => entry.id === requestedPlayerId) ?? scoreboard.find((entry) => entry.isPlayer)
    : scoreboard.find((entry) => entry.isPlayer);

  return {
    scoreboard,
    leaderId: leaderIds[0] ?? null,
    leaderIds,
    leaderScore,
    playerScore: player?.score ?? null,
    deltaToLead: player ? Math.max(0, leaderScore - player.score) : null,
  };
}

function scoreboardRank(entries: Array<{ score: number }>, index: number): number {
  let rank = 1;
  for (let candidate = 1; candidate < index; candidate += 1) {
    if (entries[candidate - 1].score !== entries[candidate].score) rank = candidate + 1;
  }
  return rank;
}

function buildObjective(input: CompetitiveReadabilityInput, playerId: string): ObjectivePresentation {
  const objective = input.objective;
  if (!objective) {
    return {
      id: null,
      label: 'OBJECTIVE',
      active: false,
      owner: 'unclaimed',
      ownerId: null,
      contested: false,
      progress: 0,
      contestProgress: 0,
      remainingSeconds: null,
    };
  }

  const active = objective.active === true;
  const contested = objective.contested === true || objective.owner === 'contested';
  const owner: ObjectiveOwner = contested
    ? 'contested'
    : objective.owner === 'player' || objective.ownerId === playerId
      ? 'player'
      : objective.owner === 'enemy' || Boolean(objective.ownerId)
        ? 'enemy'
        : 'unclaimed';
  const ownerId = owner === 'player'
    ? playerId
    : owner === 'enemy' || owner === 'contested'
      ? text(objective.ownerId, '') || null
      : null;

  return {
    id: text(objective.id, '') || null,
    label: text(objective.label, 'OBJECTIVE'),
    active,
    owner,
    ownerId,
    contested,
    progress: clamp(objective.progress, 0, 1, 0),
    contestProgress: clamp(objective.contestProgress, 0, 1, 0),
    remainingSeconds: objective.remainingSeconds === undefined
      ? null
      : clamp(objective.remainingSeconds, 0, MAX_TIMER_SECONDS, 0),
  };
}

function buildEvents(input: CompetitiveReadabilityInput): EventTimerPresentation[] {
  const sources: Array<{ source: 'pickup' | 'event'; values: readonly EventTimerInput[] }> = [
    { source: 'pickup', values: input.pickups ?? [] },
    { source: 'event', values: input.events ?? [] },
  ];
  const events: Array<EventTimerPresentation & { sourceIndex: number; sourceOrder: number }> = [];

  sources.forEach(({ source, values }, sourceOrder) => {
    values.forEach((event, sourceIndex) => {
      if (event.active === false) return;
      const remainingSeconds = clamp(event.remainingSeconds, 0, MAX_TIMER_SECONDS, 0);
      events.push({
        id: text(event.id, `${source}-${sourceIndex + 1}`),
        label: text(event.label, text(event.id, `${source} ${sourceIndex + 1}`)),
        source,
        kind: event.kind ?? source,
        priority: integer(event.priority, -MAX_PRIORITY, MAX_PRIORITY, 0),
        remainingSeconds,
        status: remainingSeconds <= 0 ? 'ready' : 'upcoming',
        sourceIndex,
        sourceOrder,
      });
    });
  });

  events.sort((left, right) => (
    left.remainingSeconds - right.remainingSeconds
    || right.priority - left.priority
    || left.sourceOrder - right.sourceOrder
    || compareText(left.label, right.label)
    || compareText(left.id, right.id)
    || left.sourceIndex - right.sourceIndex
  ));
  return events.map(({ sourceIndex: _sourceIndex, sourceOrder: _sourceOrder, ...event }) => event);
}

function buildWeaponStrip(input: CompetitiveReadabilityInput): WeaponAvailabilityEntry[] {
  const entries = (input.weapons ?? []).map((weapon, index) => {
    const infiniteAmmo = weapon.infiniteAmmo === true || (weapon.ammo !== undefined && weapon.ammo < 0);
    const ammo = infiniteAmmo ? 0 : integer(weapon.ammo, 0, MAX_AMMO, 0);
    const maxAmmo = weapon.maxAmmo === undefined
      ? null
      : integer(weapon.maxAmmo, 0, MAX_AMMO, 0);
    const cooldownSeconds = clamp(weapon.cooldownSeconds, 0, MAX_COOLDOWN_SECONDS, 0);
    const unlocked = weapon.unlocked !== false;
    const equipped = weapon.equipped === true;
    const hasAmmo = infiniteAmmo || ammo > 0;
    const available = unlocked && hasAmmo && cooldownSeconds <= 0;
    const status: WeaponAvailability = !unlocked
      ? 'locked'
      : available && equipped
        ? 'equipped'
        : cooldownSeconds > 0 && hasAmmo
          ? 'cooldown'
          : hasAmmo
            ? 'available'
            : 'empty';
    const slot = weapon.slot === undefined ? null : integer(weapon.slot, 1, 99, 1);

    return {
      id: text(weapon.id, `weapon-${index + 1}`),
      label: text(weapon.label, text(weapon.id, `Weapon ${index + 1}`)),
      slot,
      ammo,
      maxAmmo,
      ammoRatio: infiniteAmmo || maxAmmo === null || maxAmmo <= 0 ? null : clamp(ammo / maxAmmo, 0, 1, 0),
      infiniteAmmo,
      unlocked,
      equipped,
      cooldownSeconds,
      available,
      status,
      sourceIndex: index,
    };
  });

  entries.sort((left, right) => (
    (left.slot === null ? Number.POSITIVE_INFINITY : left.slot) - (right.slot === null ? Number.POSITIVE_INFINITY : right.slot)
    || compareText(left.label, right.label)
    || compareText(left.id, right.id)
    || left.sourceIndex - right.sourceIndex
  ));
  return entries.map(({ sourceIndex: _sourceIndex, ...entry }) => entry);
}

function buildCue(input: CompetitiveReadabilityInput, objective: ObjectivePresentation): ReadabilityCue {
  if (objective.active) {
    const rawObjective = input.objective;
    return {
      kind: 'objective',
      targetId: objective.id ?? 'objective',
      label: objective.label,
      direction: direction(rawObjective?.direction),
      distance: rawObjective?.distance === undefined ? null : clamp(rawObjective.distance, 0, MAX_DISTANCE, 0),
    };
  }

  const landmarks = (input.landmarks ?? [])
    .filter((landmark) => landmark.active !== false)
    .map((landmark, index) => ({
      id: text(landmark.id, `landmark-${index + 1}`),
      label: text(landmark.label, text(landmark.id, `Landmark ${index + 1}`)),
      direction: direction(landmark.direction),
      distance: landmark.distance === undefined ? null : clamp(landmark.distance, 0, MAX_DISTANCE, 0),
      priority: integer(landmark.priority, -MAX_PRIORITY, MAX_PRIORITY, 0),
      sourceIndex: index,
    }))
    .sort((left, right) => (
      right.priority - left.priority
      || (left.distance === null ? Number.POSITIVE_INFINITY : left.distance) - (right.distance === null ? Number.POSITIVE_INFINITY : right.distance)
      || compareText(left.label, right.label)
      || compareText(left.id, right.id)
      || left.sourceIndex - right.sourceIndex
    ));
  const landmark = landmarks[0];
  if (!landmark) return { kind: 'none', targetId: null, label: null, direction: 'none', distance: null };
  return {
    kind: 'landmark',
    targetId: landmark.id,
    label: landmark.label,
    direction: landmark.direction,
    distance: landmark.distance,
  };
}

export function buildCompetitiveReadabilityModel(input: CompetitiveReadabilityInput = {}): CompetitiveReadabilityModel {
  const playerId = text(input.playerId, 'player');
  const scoreboard = buildScoreboard(input);
  const objective = buildObjective(input, playerId);
  return {
    scoreboard: scoreboard.scoreboard,
    leaderId: scoreboard.leaderId,
    leaderIds: scoreboard.leaderIds,
    leaderScore: scoreboard.leaderScore,
    tiedForLead: scoreboard.leaderIds.length > 1,
    playerScore: scoreboard.playerScore,
    deltaToLead: scoreboard.deltaToLead,
    objective,
    nextEvents: buildEvents(input),
    weaponStrip: buildWeaponStrip(input),
    cue: buildCue(input, objective),
  };
}
