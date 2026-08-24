export type WeaponId =
  | 'machine'
  | 'shotgun'
  | 'rocket'
  | 'plasma'
  | 'laser'
  | 'sniper'
  | 'rail';

export type WeaponDefinition = {
  id: WeaponId;
  name: string;
  shortName: string;
  color: number;
  cooldown: number;
  damage: number;
  projectileSpeed?: number;
  splash?: number;
  pellets?: number;
  spread?: number;
  falloffStart?: number;
  falloffEnd?: number;
  range?: number;
  recoil: number;
  trauma: number;
  ammo: number;
};

export const WEAPONS: WeaponDefinition[] = [
  { id: 'machine', name: 'VX Machine Gun', shortName: 'MG', color: 0x79f3ff, cooldown: 0.09, damage: 8, spread: 0.0065, range: 110, recoil: 0.075, trauma: 0.025, ammo: 180 },
  { id: 'shotgun', name: 'Scatter-14', shortName: 'SG', color: 0xffc45b, cooldown: 0.9, damage: 7, pellets: 14, spread: 0.09, falloffStart: 5, falloffEnd: 30, recoil: 0.72, trauma: 0.17, ammo: 30 },
  { id: 'rocket', name: 'Rift Rocket', shortName: 'RL', color: 0xff6b55, cooldown: 0.75, damage: 90, projectileSpeed: 40, splash: 5, recoil: 0.62, trauma: 0.25, ammo: 24 },
  { id: 'plasma', name: 'Ion Plasma', shortName: 'PG', color: 0xb474ff, cooldown: 0.125, damage: 18, projectileSpeed: 48, splash: 1.65, recoil: 0.12, trauma: 0.04, ammo: 120 },
  { id: 'laser', name: 'Helix Laser', shortName: 'LZ', color: 0x5dff9a, cooldown: 0.1, damage: 9, range: 54, recoil: 0.06, trauma: 0.015, ammo: 100 },
  { id: 'sniper', name: 'Longshot', shortName: 'SR', color: 0xff4fa8, cooldown: 1.1, damage: 70, range: 165, recoil: 0.82, trauma: 0.3, ammo: 16 },
  { id: 'rail', name: 'Apex Railgun', shortName: 'RG', color: 0xf4ff66, cooldown: 1.5, damage: 110, range: 190, recoil: 0.95, trauma: 0.45, ammo: 0 },
];

export const MATCH_DURATION = 360;
export const SCORE_LIMIT = 20;

export const MOVEMENT = {
  fixedStep: 1 / 120,
  maxSubstepDistance: 0.2,
  // Warsow/qfusion movement constants, expressed in Riftline world units.
  groundAcceleration: 11.5,
  airAcceleration: 1.15,
  airDeceleration: 2.4,
  airControl: 150,
  strafeAcceleration: 74,
  strafeWishSpeed: 1.9,
  airCarveRate: 2.35,
  skiCarveRate: 3.8,
  wishSpeed: 15,
  stopSpeed: 10.5,
  groundFriction: 8,
  skiFriction: 0.045,
  jumpImpulse: 10.2,
  gravity: 25,
  coyoteTime: 0.1,
  jumpBuffer: 0.12,
  // Ground movement tops out around 15 units/sec; air movement and rocket
  // jumps can still build into a much faster combat line.
  maxSpeed: 60,
  // qfusion/Warsow standing bounds are [-16,-16,-24] to [16,16,40], and
  // STEPSIZE is 18. WCA1 is imported at 1/56, so preserve those dimensions.
  playerHeight: 64 / 56,
  playerRadius: 16 / 56,
  stepHeight: 18 / 56,
  groundSnapDistance: 19 / 56,
  maxSlopeCosine: 0.574,
  dashImpulse: 8.8,
  dashCooldown: 0.72,
  dashPreserveTime: 0.16,
  rocketJumpRadius: 5,
  rocketJumpMinVerticalImpulse: 16,
  rocketJumpMaxVerticalImpulse: 23,
  rocketJumpHorizontalImpulse: 8,
  rocketJumpMomentumBoost: 5.5,
} as const;

export const POWERUP = {
  duration: 15,
  respawn: 60,
  railRespawn: 45,
  coreActivation: 30,
  coreHold: 4,
  coreRespawn: 45,
  coreRadius: 4,
} as const;

export const GRAPPLE = {
  // Riftline units are authored from the Quake scale: 22.86 units is roughly 75 ft.
  maxLength: 22.86,
  minLength: 1.35,
  pullAcceleration: 28,
  swingAcceleration: 18,
  ropeTension: 8,
  maxSpeed: 54,
} as const;

export const GRENADE = {
  fuse: 3,
  maxAmmo: 6,
  cooldown: 0.42,
  throwSpeed: 17,
  upwardImpulse: 3.1,
  gravity: 25,
  radius: 0.18,
  restitution: 0.43,
  tangentialDamping: 0.82,
  damage: 82,
  splash: 3.8,
} as const;
