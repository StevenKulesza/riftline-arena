import type { WeaponId } from '../game/config';
import { assetUrl } from '../assets/assetUrl';

export type AudioGroup = 'weapons' | 'impacts' | 'ui' | 'pickups' | 'movement' | 'voice' | 'music';

export type AudioPool = {
  id: string;
  urls: readonly string[];
  group: AudioGroup;
  volume: number;
  cooldown: number;
  maxVoices: number;
  pitchVariance?: number;
  loop?: boolean;
  tone?: {
    lowShelfFrequencyHz?: number;
    lowShelfGainDb?: number;
    presenceFrequencyHz?: number;
    presenceGainDb?: number;
    lowpassHz?: number;
  };
};

const versions = (stem: string, count: number): string[] =>
  Array.from({ length: count }, (_, index) => assetUrl(`assets/audio/${stem}-v${index + 1}.mp3`));

const pool = (
  id: string,
  urls: readonly string[],
  group: AudioGroup,
  volume: number,
  cooldown: number,
  maxVoices: number,
  pitchVariance = 0.025,
): AudioPool => ({ id, urls, group, volume, cooldown, maxVoices, pitchVariance });

export const WEAPON_AUDIO_POOLS: Record<WeaponId, AudioPool> = {
  machine: {
    ...pool('weapon.machine', versions('weapons/machine-fire', 4), 'weapons', 0.82, 0.055, 7, 0.012),
    tone: {
      lowShelfFrequencyHz: 240,
      lowShelfGainDb: 2.5,
      presenceFrequencyHz: 3_100,
      presenceGainDb: -4.5,
      lowpassHz: 6_200,
    },
  },
  shotgun: pool('weapon.shotgun', versions('weapons/shotgun-fire', 3), 'weapons', 1, 0.12, 5, 0.018),
  // v1 is intentionally excluded: the objective loudness scan measured it roughly
  // 9 dB below v2/v3, which made random rocket launches unpredictably disappear.
  rocket: pool('weapon.rocket', versions('weapons/rocket-launch', 3).slice(1), 'weapons', 0.95, 0.12, 5, 0.018),
  plasma: pool('weapon.plasma', versions('weapons/plasma-fire', 4), 'weapons', 0.78, 0.06, 8),
  laser: pool('weapon.laser', versions('weapons/laser-fire', 4), 'weapons', 0.72, 0.055, 8),
  sniper: pool('weapon.sniper', versions('weapons/sniper-fire', 2), 'weapons', 1, 0.16, 4, 0.012),
  rail: pool('weapon.rail', versions('weapons/rail-fire', 2), 'weapons', 1, 0.2, 4, 0.01),
};

export const EMPTY_TRIGGER_POOL = pool(
  'weapon.empty',
  versions('weapons/empty-trigger', 3),
  'weapons',
  0.48,
  0.2,
  2,
  0.02,
);

export const EQUIP_AUDIO_POOLS = {
  light: pool('equip.light', versions('weapons/equip-light', 1), 'weapons', 0.42, 0.08, 2, 0),
  heavy: pool('equip.heavy', versions('weapons/equip-heavy', 1), 'weapons', 0.5, 0.08, 2, 0),
  precision: pool('equip.precision', versions('weapons/equip-precision', 1), 'weapons', 0.52, 0.08, 2, 0),
} as const;

export const IMPACT_AUDIO_POOLS = {
  rocket: pool('impact.rocket', versions('impacts/rocket-explosion', 4), 'impacts', 0.92, 0.06, 7, 0.02),
  plasma: pool('impact.plasma', versions('impacts/plasma-impact', 3), 'impacts', 0.7, 0.035, 8, 0.025),
  armor: pool('impact.armor', versions('impacts/armor-hit', 3), 'impacts', 0.65, 0.055, 5, 0.02),
} as const;

export const CONFIRM_AUDIO_POOLS = {
  hit: pool('confirm.hit', versions('ui/hit-confirm', 2), 'ui', 0.46, 0.025, 4, 0.015),
  elimination: pool('confirm.elimination', versions('ui/elimination-confirm', 2), 'ui', 0.64, 0.08, 3, 0.01),
} as const;

export const COUNTDOWN_AUDIO_POOLS = {
  READY: pool('announcer.ready', [assetUrl('assets/audio/voice/countdown-ready.mp3')], 'voice', 0.78, 0.15, 1, 0),
  '3': pool('announcer.three', [assetUrl('assets/audio/voice/countdown-three.mp3')], 'voice', 0.78, 0.15, 1, 0),
  '2': pool('announcer.two', [assetUrl('assets/audio/voice/countdown-two.mp3')], 'voice', 0.78, 0.15, 1, 0),
  '1': pool('announcer.one', [assetUrl('assets/audio/voice/countdown-one.mp3')], 'voice', 0.82, 0.15, 1, 0),
} as const;

export const PICKUP_AUDIO_POOLS = {
  ballistic: pool('pickup.ballistic', versions('pickups/ammo-ballistic', 2), 'pickups', 0.65, 0.08, 3, 0.015),
  energy: pool('pickup.energy', versions('pickups/ammo-energy', 2), 'pickups', 0.62, 0.08, 3, 0.015),
  rocket: pool('pickup.rocket', versions('pickups/ammo-rocket', 2), 'pickups', 0.7, 0.08, 3, 0.012),
  rail: pool('pickup.rail', versions('pickups/rail-acquire', 2), 'pickups', 0.78, 0.08, 3, 0.01),
} as const;

export const WORLD_PICKUP_AUDIO_POOLS = {
  health: pool('pickup.health', versions('pickups/health', 2), 'pickups', 0.66, 0.08, 3, 0.012),
  armor: pool('pickup.armor', versions('pickups/armor', 2), 'pickups', 0.7, 0.08, 3, 0.012),
  boost: pool('pickup.boost', versions('pickups/boost', 2), 'pickups', 0.72, 0.08, 3, 0.014),
  core: pool('pickup.core', versions('pickups/core', 2), 'pickups', 0.82, 0.12, 3, 0.008),
} as const;

export const MOVEMENT_AUDIO_POOLS = {
  jump: pool('movement.jump', versions('movement/jump', 2), 'movement', 0.46, 0.08, 3, 0.02),
  dash: pool('movement.dash', versions('movement/dash', 2), 'movement', 0.5, 0.09, 3, 0.025),
  wallJump: pool('movement.wall-jump', versions('movement/wall-jump', 2), 'movement', 0.54, 0.1, 3, 0.022),
  landLight: pool('movement.land-light', versions('movement/land-light', 2), 'movement', 0.42, 0.1, 3, 0.018),
  landHeavy: pool('movement.land-heavy', versions('movement/land-heavy', 2), 'movement', 0.58, 0.12, 3, 0.015),
  footstep: pool('movement.footstep', versions('movement/footstep', 4), 'movement', 0.44, 0.11, 3, 0.055),
} as const;

export const AMBIENCE_AUDIO_POOL: AudioPool = {
  ...pool('music.arena-bed', [assetUrl('assets/audio/music/riftline-ambient-loop.mp3')], 'music', 0.34, 0, 1, 0),
  loop: true,
};

export const PLAYER_AUDIO_POOLS = {
  damage: pool('impact.damage', versions('impacts/player-damage', 3), 'impacts', 0.62, 0.055, 4, 0.016),
  death: pool('impact.death', versions('impacts/player-death', 2), 'impacts', 0.76, 0.2, 2, 0.01),
} as const;

export const AUDIO_POOLS: readonly AudioPool[] = [
  // Countdown voice is latency-critical and must enter the bounded loader
  // before the much larger combat bank on the first user gesture.
  ...Object.values(COUNTDOWN_AUDIO_POOLS),
  ...Object.values(WEAPON_AUDIO_POOLS),
  EMPTY_TRIGGER_POOL,
  ...Object.values(EQUIP_AUDIO_POOLS),
  ...Object.values(IMPACT_AUDIO_POOLS),
  ...Object.values(CONFIRM_AUDIO_POOLS),
  ...Object.values(PICKUP_AUDIO_POOLS),
  ...Object.values(WORLD_PICKUP_AUDIO_POOLS),
  ...Object.values(MOVEMENT_AUDIO_POOLS),
  ...Object.values(PLAYER_AUDIO_POOLS),
  AMBIENCE_AUDIO_POOL,
];

export const AUDIO_ASSET_URLS: readonly string[] = AUDIO_POOLS.flatMap((entry) => entry.urls);
