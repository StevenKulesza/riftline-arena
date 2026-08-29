export type WeaponId =
  | 'machine'
  | 'shotgun'
  | 'rocket'
  | 'plasma'
  | 'laser'
  | 'sniper'
  | 'rail'
  | 'disc';

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
  secondary: string;
};

export const WEAPONS: WeaponDefinition[] = [
  { id: 'disc', name: 'Razor Disc Launcher', shortName: 'DL', color: 0x48f4d1, cooldown: 0.72, damage: 52, projectileSpeed: 76, recoil: 0.68, trauma: 0.2, ammo: 28, secondary: 'Overdrive ricochet' },
  { id: 'machine', name: 'VX Machine Gun', shortName: 'MG', color: 0x79f3ff, cooldown: 0.09, damage: 8, spread: 0.0065, range: 110, recoil: 0.075, trauma: 0.025, ammo: 180, secondary: 'Stabilized fire' },
  { id: 'shotgun', name: 'Scatter-14', shortName: 'SG', color: 0xffc45b, cooldown: 0.9, damage: 7, pellets: 14, spread: 0.09, falloffStart: 5, falloffEnd: 30, recoil: 0.72, trauma: 0.17, ammo: 30, secondary: 'Sabot slug' },
  { id: 'rocket', name: 'Rift Rocket', shortName: 'RL', color: 0xff6b55, cooldown: 0.75, damage: 90, projectileSpeed: 40, splash: 5, recoil: 0.62, trauma: 0.25, ammo: 24, secondary: 'Tri-salvo' },
  { id: 'plasma', name: 'Ion Plasma', shortName: 'PG', color: 0xb474ff, cooldown: 0.125, damage: 18, projectileSpeed: 48, splash: 1.65, recoil: 0.12, trauma: 0.04, ammo: 120, secondary: 'Shock orb' },
  { id: 'laser', name: 'Helix Laser', shortName: 'LZ', color: 0x5dff9a, cooldown: 0.1, damage: 9, range: 54, recoil: 0.06, trauma: 0.015, ammo: 100, secondary: 'Cutting focus' },
  { id: 'sniper', name: 'Longshot', shortName: 'SR', color: 0xff4fa8, cooldown: 1.1, damage: 70, range: 165, recoil: 0.82, trauma: 0.3, ammo: 16, secondary: '3.5× optic' },
  { id: 'rail', name: 'Apex Railgun', shortName: 'RG', color: 0xf4ff66, cooldown: 1.5, damage: 110, range: 190, recoil: 0.95, trauma: 0.45, ammo: 0, secondary: 'Overcharge' },
];

export const MATCH_DURATION = 360;
export const SCORE_LIMIT = 20;

export const MOVEMENT = {
  fixedStep: 1 / 120,
  maxSubstepDistance: 0.2,
  // Conservative swept-capsule skin used by the controller's BVH guard.
  // Endpoint overlap remains the final contact solver; the sweep prevents a
  // fast capsule from ever arriving on the far side of a thin wall or roof.
  collisionSkin: 0.018,
  // Ordinary ground motion is already protected by 0.2m overlap substeps.
  // Reserve BVH CCD for genuinely fast movement to keep the 120 Hz hot path
  // light even on software-rendered/headless QA machines.
  sweepMinDistance: 0.145,
  arenaBoundaryInset: 0.08,
  // Warsow/qfusion movement constants, expressed in Riftline world units.
  groundAcceleration: 11.5,
  airAcceleration: 1.15,
  airDeceleration: 2.4,
  airControl: 150,
  strafeAcceleration: 74,
  strafeWishSpeed: 1.9,
  airCarveRate: 2.35,
  skiCarveRate: 3.8,
  skiGravityScale: 1.12,
  skiPushAcceleration: 2.15,
  skiPushWishSpeed: 5.8,
  wishSpeed: 15,
  stopSpeed: 10.5,
  groundFriction: 8,
  // Skiing uses low linear drag at ordinary speed, then progressively stronger
  // aerodynamic resistance. Seventy km/h remains reachable from terrain
  // gravity; triple-digit speed demands a steeper, cleaner line.
  skiFriction: 0.025,
  skiResistanceStart: 16,
  skiResistanceFullSpeed: 44,
  skiGravityMinimumDrive: 0.42,
  skiQuadraticDrag: 0.0085,
  jumpImpulse: 10.2,
  jetpackAcceleration: 42,
  jetpackMaxRiseSpeed: 18,
  jetpackBurnSeconds: 2.25,
  jetpackRechargeDelaySeconds: 0.85,
  // Refill at half the burn rate: 2.25 s of thrust costs 4.5 s of recovery.
  jetpackRechargeSeconds: 4.5,
  jetpackRestartCharge: 0.2,
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
  // 60.96 world meters is 200 feet.
  maxLength: 60.96,
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
