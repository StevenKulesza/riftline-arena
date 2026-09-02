import * as THREE from 'three';
import type { WeaponId } from '../game/config';

const DEG = Math.PI / 180;
/** Warfork `AI_ChangeAngle`: skip the integrate while |error| ≤ 1°. */
export const AIM_DEADZONE_RADIANS = 1 * DEG;
/** Existing rate *= 0.5 while |error| < 10°. */
export const AIM_NEAR_WINDOW_RADIANS = 10 * DEG;
/** Accel is ¼ while |error| < 3°. */
export const AIM_FINE_WINDOW_RADIANS = 3 * DEG;

export type AimAngleRates = {
  speedYaw: number;
  speedPitch: number;
};

export function shortestAngleDelta(from: number, to: number): number {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

export function yawPitchFromDirection(
  direction: THREE.Vector3,
  out: { yaw: number; pitch: number },
): void {
  const horizontal = Math.hypot(direction.x, direction.z);
  out.yaw = Math.atan2(direction.x, direction.z);
  out.pitch = Math.atan2(direction.y, Math.max(horizontal, 1e-8));
}

export function directionFromYawPitch(yaw: number, pitch: number, out: THREE.Vector3): THREE.Vector3 {
  const cosine = Math.cos(pitch);
  return out.set(Math.sin(yaw) * cosine, Math.sin(pitch), Math.cos(yaw) * cosine);
}

function stepAxis(
  error: number,
  speed: number,
  maxStep: number,
  accelStep: number,
): { angleDelta: number; speed: number } {
  if (Math.abs(error) < AIM_NEAR_WINDOW_RADIANS) speed *= 0.5;
  if (Math.abs(error) <= AIM_DEADZONE_RADIANS) return { angleDelta: 0, speed };
  if (error > 0) {
    if (speed > maxStep) speed = maxStep;
    speed += Math.abs(error) < AIM_FINE_WINDOW_RADIANS ? accelStep * 0.25 : accelStep;
  } else {
    if (speed < -maxStep) speed = -maxStep;
    speed -= Math.abs(error) < AIM_FINE_WINDOW_RADIANS ? accelStep * 0.25 : accelStep;
  }
  return { angleDelta: speed, speed };
}

/**
 * Warfork `AI_ChangeAngle` (`ai_movement.cpp:242-377`).
 * Rates are radians this tick; snap-to-ideal is left disabled so the heading overshoots.
 */
export function stepAimChangeAngle(
  currentYaw: number,
  currentPitch: number,
  idealYaw: number,
  idealPitch: number,
  rates: AimAngleRates,
  yawSpeedRadians: number,
  yawAccelRadians: number,
  delta: number,
): { yaw: number; pitch: number } {
  const maxStep = yawSpeedRadians * delta;
  const accelStep = yawAccelRadians * delta;
  const yawStep = stepAxis(
    shortestAngleDelta(currentYaw, idealYaw),
    rates.speedYaw,
    maxStep,
    accelStep,
  );
  const pitchStep = stepAxis(
    shortestAngleDelta(currentPitch, idealPitch),
    rates.speedPitch,
    maxStep,
    accelStep,
  );
  rates.speedYaw = yawStep.speed;
  rates.speedPitch = pitchStep.speed;
  return {
    yaw: currentYaw + yawStep.angleDelta,
    pitch: THREE.MathUtils.clamp(
      currentPitch + pitchStep.angleDelta,
      -Math.PI * 0.49,
      Math.PI * 0.49,
    ),
  };
}

/** 64 u standing height ≈ 1.8 m (`warfork-reference.md` §0). */
export const WARSOW_UNIT_METRES = 0.028;
export const AIM_WFAC_BASE_UNITS = 25;
export const AIM_WFAC_PROJECTILE_UNITS = 300;
export const AIM_WFAC_INSTANT_UNITS = 150;

/** Warfork `WFAC_*` before `25 + W*(1-S)` (`ai_class_dmbot.cpp:1180-1269`). */
export function weaponAimWfacUnits(weapon: WeaponId, targetAirborne: boolean): number {
  switch (weapon) {
    case 'rocket':
      return AIM_WFAC_PROJECTILE_UNITS * 1.3 * (targetAirborne ? 2.5 : 1);
    case 'disc':
      return AIM_WFAC_PROJECTILE_UNITS;
    case 'plasma':
      return AIM_WFAC_PROJECTILE_UNITS * 0.5;
    case 'laser':
      return AIM_WFAC_INSTANT_UNITS * 1.5;
    case 'machine':
    case 'shotgun':
    case 'sniper':
    case 'rail':
      return AIM_WFAC_INSTANT_UNITS;
    default: {
      const exhaustive: never = weapon;
      return exhaustive;
    }
  }
}

export function aimWfacMetres(weapon: WeaponId, skill: number, targetAirborne: boolean): number {
  return (AIM_WFAC_BASE_UNITS + weaponAimWfacUnits(weapon, targetAirborne) * (1 - skill)) * WARSOW_UNIT_METRES;
}

/**
 * Warfork world-XY aim jitter (`ai_class_dmbot.cpp:1294-1301`).
 * LG/PG sweep a circle of radius wfac; other weapons add uniform ±wfac/2.
 */
export function applyAimWfacOffset(
  aimPoint: THREE.Vector3,
  weapon: WeaponId,
  wfacMetres: number,
  elapsed: number,
  unitRandom: () => number,
): void {
  if (weapon === 'laser' || weapon === 'plasma') {
    const phase = elapsed * 10;
    aimPoint.x += Math.sin(phase) * wfacMetres;
    aimPoint.z += Math.cos(phase) * wfacMetres;
    return;
  }
  aimPoint.x += (unitRandom() - 0.5) * wfacMetres;
  aimPoint.z += (unitRandom() - 0.5) * wfacMetres;
}

/**
 * Warfork `BOT_DMclass_FireWeapon` trigger (`ai_class_dmbot.cpp:1284-1288`):
 * in-front (caller) + skill delay. No chest-error cone and no self-splash hold.
 * LG/PG always pull when ready; others fire when `unitRandom ≤ 1.25-S`.
 */
export function botMayPullTrigger(input: {
  visible: boolean;
  acquired: boolean;
  fireCooldown: number;
  continuous: boolean;
  fireProbability: number;
  unitRandom: number;
}): boolean {
  if (!input.visible || !input.acquired || input.fireCooldown > 0) return false;
  if (input.continuous) return true;
  return input.unitRandom <= input.fireProbability;
}
