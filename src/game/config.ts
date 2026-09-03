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
  /** Direct-hit knockback in m/s (Warsow 5*kb u/s scaled to wishSpeed 15). */
  knockback?: number;
  splashMinDamage?: number;
  splashMinKnockback?: number;
};

export const WEAPONS: WeaponDefinition[] = [
  { id: 'disc', name: 'Razor Disc Launcher', shortName: 'DL', color: 0x48f4d1, cooldown: 0.72, damage: 52, projectileSpeed: 76, knockback: 20, recoil: 0.68, trauma: 0.2, ammo: 28, secondary: 'Overdrive ricochet' },
  { id: 'machine', name: 'VX Machine Gun', shortName: 'MG', color: 0x79f3ff, cooldown: 0.09, damage: 8, spread: 0.0065, range: 110, knockback: 2.3, recoil: 0.075, trauma: 0.025, ammo: 180, secondary: 'Stabilized fire' },
  { id: 'shotgun', name: 'Scatter-14', shortName: 'SG', color: 0xffc45b, cooldown: 0.9, damage: 7, pellets: 14, spread: 0.09, falloffStart: 5, falloffEnd: 30, knockback: 1.5, recoil: 0.72, trauma: 0.17, ammo: 30, secondary: 'Sabot slug' },
  { id: 'rocket', name: 'Rift Rocket', shortName: 'RL', color: 0xff6b55, cooldown: 0.95, damage: 80, projectileSpeed: 54, splash: 2.2, knockback: 23, splashMinDamage: 15, splashMinKnockback: 8.2, recoil: 0.62, trauma: 0.25, ammo: 24, secondary: 'Tri-salvo' },
  { id: 'plasma', name: 'Ion Plasma', shortName: 'PG', color: 0xb474ff, cooldown: 0.125, damage: 18, projectileSpeed: 90, splash: 1.65, knockback: 4.7, splashMinDamage: 1, splashMinKnockback: 0.5, recoil: 0.12, trauma: 0.04, ammo: 120, secondary: 'Shock orb' },
  { id: 'laser', name: 'Helix Laser', shortName: 'LZ', color: 0x5dff9a, cooldown: 0.1, damage: 9, range: 54, knockback: 3.3, recoil: 0.06, trauma: 0.015, ammo: 100, secondary: 'Cutting focus' },
  { id: 'sniper', name: 'Longshot', shortName: 'SR', color: 0xff4fa8, cooldown: 1.1, damage: 70, range: 165, knockback: 16, recoil: 0.82, trauma: 0.3, ammo: 16, secondary: '3.5× optic' },
  { id: 'rail', name: 'Apex Railgun', shortName: 'RG', color: 0xf4ff66, cooldown: 1.5, damage: 110, range: 190, knockback: 19, recoil: 0.95, trauma: 0.45, ammo: 0, secondary: 'Overcharge' },
];

/** Combat feel constants (Warsow splash/holster/prestep), independent of MOVEMENT. */
export const COMBAT = {
  projectilePrestep: 1.8,
  weaponSwitchHolster: 0.1,
  hitRadiusForgiveness: 0.08,
  splashInnerBot: 0.43,
  splashHeadBias: 0.65,
  splashAngle: (80 * Math.PI) / 180,
  viewKickRadians: 0.044,
  hitFlashSeconds: 0.08,
  selfRocketDamageScale: 1,
  /** g_self_knockback: self splash kick is 1.18× the f² splash, never a canned lift. */
  selfRocketKnockbackScale: 1.18,
  selfPlasmaDamageScale: 0.5,
  selfPlasmaKnockbackScale: 0.5,
  /** G_CanSplashDamage lifts the trace origin 9 u along the impact plane. */
  splashLosLift: 9 * (15 / 320),
} as const;

export const MATCH_DURATION = 360;
export const SCORE_LIMIT = 20;

/** Statute mile per hour expressed in meters per second. */
export const METERS_PER_SECOND_PER_MPH = 1609.344 / 3600;
/** Hard player ceiling: ski lines and air safety clamp at this speed. */
export const PLAYER_MAX_SPEED_MPH = 250;

/** Maximum 120 Hz simulation ticks spent by one render frame. */
export const MAX_FIXED_STEPS_PER_FRAME = 4;

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
  // Warsow/qfusion movement constants (gs_pmove.c), expressed in Riftline
  // world units. Run speed 320 u/s maps to wishSpeed 15 m/s, so velocity-scale
  // constants use the 15/320 ratio; dimensionless accelerations stay as-is.
  groundAcceleration: 11.5,
  // pm_airaccelerate 1 / pm_airdecelerate 2 (Q3 accelerate in the air).
  airAcceleration: 1,
  airDeceleration: 2,
  // pm_aircontrol 150 is a velocity-scale term (k = 32 * aircontrol * dot² * dt
  // is added to a u/s vector), so it converts by the same 15/320 ratio.
  airControl: 150 * (15 / 320),
  // pm_strafebunnyaccel 70 at pm_wishspeed 30 u/s: CPM side-only strafing.
  strafeAcceleration: 74,
  strafeWishSpeed: 1.9,
  // Ski steering is deliberately slow so a downhill line is a commitment: a
  // 90° carve at 15 m/s needs well over a second to settle.
  skiCarveRate: 1.6,
  skiCarveSpeedDivisor: 42,
  skiGravityScale: 1,
  skiPushAcceleration: 2.15,
  skiPushWishSpeed: 3,
  wishSpeed: 15,
  stopSpeed: 10.5,
  groundFriction: 8,
  // Skiing uses low linear drag at ordinary speed, then quadratic aerodynamic
  // resistance above skiResistanceStart. Gravity's tangential pull is never
  // scaled down, so a full 30° slope can reach the 250 mph player ceiling
  // before the safety clamp; a 15° slope still passes 70 km/h.
  skiFriction: 0.025,
  skiResistanceStart: 22,
  skiResistanceFullSpeed: PLAYER_MAX_SPEED_MPH * METERS_PER_SECOND_PER_MPH,
  skiQuadraticDrag: 0.0012,
  // DEFAULT_JUMPSPEED 280 * 1.0625 → 1.62 m apex, 0.72 s airtime (Warsow 0.70 s).
  jumpImpulse: 9,
  // Ramp/stair launches stack a second jump on top of an existing rise.
  doubleJumpStackThreshold: 0.35,
  jetpackAcceleration: 42,
  jetpackMaxRiseSpeed: 18,
  jetpackBurnSeconds: 2.25,
  jetpackRechargeDelaySeconds: 0.85,
  // Refill at half the burn rate: 2.25 s of thrust costs 4.5 s of recovery.
  jetpackRechargeSeconds: 4.5,
  jetpackRestartCharge: 0.2,
  gravity: 25,
  // Warsow PM_CheckJump returns immediately when groundentity == -1. No coyote.
  coyoteTime: 0,
  jumpBuffer: 0.12,
  // Pure NaN/tunnelling safety clamp at 250 mph. Ground tops out at wishSpeed,
  // air has no gameplay cap (Warsow §7), and steep ski lines can reach this.
  maxSpeed: PLAYER_MAX_SPEED_MPH * METERS_PER_SECOND_PER_MPH,
  // qfusion/Warsow standing bounds are [-16,-16,-24] to [16,16,40], and
  // STEPSIZE is 18. WCA1 is imported at 1/56, so preserve those dimensions.
  playerHeight: 64 / 56,
  playerRadius: 16 / 56,
  stepHeight: 18 / 56,
  groundSnapDistance: 19 / 56,
  maxSlopeCosine: 0.574,
  // PM_StepSlideMove: walkable plane with |normal.y - 1| < 0.05 is treated as
  // flat and restores the full pre-move velocity; otherwise 2D speed is
  // preserved and Z is taken from the first slide. vel.z > 180 u/s un-grounds.
  rampPreserveFlatCosine: 0.95,
  rampUngroundSpeed: 180 * (15 / 320),
  // PM_SlideMove (gs_pmove.c:245-249) zeros downward Z only when
  // groundplane.normal[2] == 1.0, not the 0.05 ramp-preserve epsilon.
  slideMoveHorizontalCosine: 1 - 1e-5,
  // PM_CheckDash: ground only, hspeed = max(current, DEFAULT_DASHSPEED 450 →
  // 1.4 × run), vertical hop pm_dashupspeed 185 u/s ≈ 0.62 × jump, 1000 ms
  // cooldown cleared by any jump or wall jump.
  dashSpeed: 21,
  dashUpSpeed: 5.6,
  dashCooldown: 1,
  // PM_CheckWallJump: 12 probes at 30°, wall must be within ~17° of vertical
  // (|normal.y| < 0.3), 1.3 s cooldown, one per airtime, blocked during the
  // first 100 ms of a dash. Velocity clips off the wall (overbounce 1.0005)
  // plus 0.3 × normal, never below pm_wjminspeed 240 u/s (0.75 × run), and
  // rises at pm_wjupspeed 350 u/s ≈ 1.18 × jump.
  wallJumpProbeCount: 12,
  wallJumpReach: 0.2,
  wallJumpVelocityLookAhead: 0.015,
  wallJumpMaxNormalY: 0.3,
  wallJumpMinSpeedFactor: 0.75,
  wallJumpBounce: 0.3,
  wallJumpOverbounce: 1.0005,
  wallJumpUpSpeed: 10.6,
  wallJumpCooldown: 1.3,
  wallJumpDashBlockSeconds: 0.1,
  rocketJumpRadius: 5,
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
  knockback: 16,
  splashMinDamage: 8,
  splashMinKnockback: 2,
} as const;
