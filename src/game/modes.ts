export type MatchModeId = 'arena' | 'tdm' | 'ctf' | 'raid';
export type TeamId = 'azure' | 'crimson';
export type MatchActor = 'player' | number;

export type MatchModeDefinition = Readonly<{
  id: MatchModeId;
  label: string;
  shortLabel: string;
  description: string;
  targetScore: number;
  objective: string;
  teamBased: boolean;
  cooperative: boolean;
}>;

export const MATCH_MODE_DEFINITIONS: Readonly<Record<MatchModeId, MatchModeDefinition>> = {
  arena: {
    id: 'arena',
    label: 'Arena',
    shortLabel: 'FFA',
    description: 'Free-for-all combat with a rotating Flux Core.',
    targetScore: 20,
    objective: 'First to 20 frags',
    teamBased: false,
    cooperative: false,
  },
  tdm: {
    id: 'tdm',
    label: 'Team Deathmatch',
    shortLabel: 'TDM',
    description: 'Two squads fight for the frag lead. Friendly fire is disabled.',
    targetScore: 20,
    objective: 'First squad to 20 frags',
    teamBased: true,
    cooperative: false,
  },
  ctf: {
    id: 'ctf',
    label: 'Capture the Flag',
    shortLabel: 'CTF',
    description: 'Steal the opposing flag, return it home, and score three caps.',
    targetScore: 3,
    objective: 'First squad to 3 caps',
    teamBased: true,
    cooperative: false,
  },
  raid: {
    id: 'raid',
    label: 'Raid',
    shortLabel: 'RAID',
    description: 'Two 8-operator squads contest uplinks while hostile drones pressure the push.',
    targetScore: 3,
    objective: 'Secure 3 uplinks',
    teamBased: true,
    cooperative: true,
  },
};

export const TEAM_LABELS: Readonly<Record<TeamId, string>> = {
  azure: 'AZURE',
  crimson: 'CRIMSON',
};

export const TEAM_COLORS: Readonly<Record<TeamId, number>> = {
  azure: 0x55d8ff,
  crimson: 0xff5d7e,
};

export function matchModeFromQuery(search: string = typeof window === 'undefined' ? '' : window.location.search): MatchModeId {
  const value = new URLSearchParams(search).get('mode');
  return value === 'tdm' || value === 'ctf' || value === 'raid' ? value : 'arena';
}

export function matchModeDefinition(mode: MatchModeId): MatchModeDefinition {
  return MATCH_MODE_DEFINITIONS[mode];
}

/** Player and bots zero through six form Azure; bots seven through fourteen form Crimson. */
export function teamForActor(mode: MatchModeId, actor: MatchActor): TeamId | null {
  if (mode === 'arena') return null;
  return actor === 'player' || (typeof actor === 'number' && actor < 7) ? 'azure' : 'crimson';
}

export function areAllies(mode: MatchModeId, left: MatchActor, right: MatchActor): boolean {
  const leftTeam = teamForActor(mode, left);
  const rightTeam = teamForActor(mode, right);
  return leftTeam !== null && leftTeam === rightTeam;
}

export function opposingTeam(team: TeamId): TeamId {
  return team === 'azure' ? 'crimson' : 'azure';
}
