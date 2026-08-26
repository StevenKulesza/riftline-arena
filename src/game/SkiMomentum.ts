import * as THREE from 'three';
import { MOVEMENT } from './config';

export type SkiMomentumCurve = {
  resistance: number;
  gravityDriveScale: number;
  dragAcceleration: number;
};

/**
 * Converts horizontal ski speed into a progressive resistance curve. Gravity
 * remains the only large source of momentum: drag grows quadratically and the
 * fraction of slope gravity converted into speed eases down at race velocity.
 */
export function skiMomentumCurve(
  horizontalSpeed: number,
  target: SkiMomentumCurve = { resistance: 0, gravityDriveScale: 1, dragAcceleration: 0 },
): SkiMomentumCurve {
  const speed = Math.max(0, horizontalSpeed);
  const span = Math.max(0.001, MOVEMENT.skiResistanceFullSpeed - MOVEMENT.skiResistanceStart);
  const linearResistance = THREE.MathUtils.clamp((speed - MOVEMENT.skiResistanceStart) / span, 0, 1);
  const resistance = linearResistance * linearResistance * (3 - 2 * linearResistance);
  const excessSpeed = Math.max(0, speed - MOVEMENT.skiResistanceStart);
  target.resistance = resistance;
  target.gravityDriveScale = THREE.MathUtils.lerp(1, MOVEMENT.skiGravityMinimumDrive, resistance);
  target.dragAcceleration = MOVEMENT.skiFriction * speed
    + MOVEMENT.skiQuadraticDrag * excessSpeed * excessSpeed;
  return target;
}
