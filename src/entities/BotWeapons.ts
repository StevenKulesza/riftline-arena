import type { WeaponId } from '../game/config';

const CLOSE_WEAPONS = ['shotgun', 'plasma', 'machine'] as const;
const SHORT_WEAPONS = ['plasma', 'disc', 'laser', 'shotgun', 'machine'] as const;
const MID_WEAPONS = ['disc', 'rocket', 'laser', 'plasma', 'machine'] as const;
const FAR_WEAPONS = ['sniper', 'rail', 'machine'] as const;
const EXTREME_WEAPONS = ['rail', 'sniper'] as const;
const BLIND_WEAPONS = ['rail', 'sniper', 'rocket', 'machine'] as const;

/** Effective engagement range per weapon; a weapon is never chosen or fired beyond it. */
export const BOT_WEAPON_RANGE: Readonly<Record<WeaponId, number>> = {
  machine: 110,
  shotgun: 34,
  rocket: 70,
  plasma: 60,
  laser: 54,
  sniper: 165,
  rail: 190,
  disc: 95,
};

export function botWeaponBandForDistance(distance: number, visible: boolean): readonly WeaponId[] {
  if (!visible) return BLIND_WEAPONS;
  if (distance < 7.5) return CLOSE_WEAPONS;
  if (distance < 18) return SHORT_WEAPONS;
  if (distance < 42) return MID_WEAPONS;
  if (distance > 78) return EXTREME_WEAPONS;
  return FAR_WEAPONS;
}
