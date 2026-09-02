import * as THREE from 'three';
import { MOVEMENT } from './config';

export type SkiMomentumCurve = {
  resistance: number;
  dragAcceleration: number;
};

/**
 * Converts horizontal ski speed into a progressive resistance curve. Gravity's
 * tangential pull is never scaled down; the only thing that limits a ski line
 * is drag, which is linear at ordinary speed and grows quadratically above
 * `skiResistanceStart`. `resistance` is a 0–1 readout of how deep into the
 * quadratic regime the skier is, for HUD/diagnostics only.
 */
export function skiMomentumCurve(
  horizontalSpeed: number,
  target: SkiMomentumCurve = { resistance: 0, dragAcceleration: 0 },
): SkiMomentumCurve {
  const speed = Math.max(0, horizontalSpeed);
  const span = Math.max(0.001, MOVEMENT.skiResistanceFullSpeed - MOVEMENT.skiResistanceStart);
  const linearResistance = THREE.MathUtils.clamp((speed - MOVEMENT.skiResistanceStart) / span, 0, 1);
  const excessSpeed = Math.max(0, speed - MOVEMENT.skiResistanceStart);
  target.resistance = linearResistance * linearResistance * (3 - 2 * linearResistance);
  target.dragAcceleration = MOVEMENT.skiFriction * speed
    + MOVEMENT.skiQuadraticDrag * excessSpeed * excessSpeed;
  return target;
}

/**
 * Fraction of the way the ski heading lerps toward the wish direction in one
 * step. Steering authority falls off with speed so fast lines must be planned
 * rather than yanked around.
 */
export function skiCarveBlend(tangentSpeed: number, delta: number): number {
  return Math.min(1, MOVEMENT.skiCarveRate * delta / (1 + Math.max(0, tangentSpeed) / MOVEMENT.skiCarveSpeedDivisor));
}

/**
 * Terminal tangential speed on a slope of the given angle: where the gravity
 * drive equals ski drag. Exposed for tests and design documentation.
 */
export function skiTerminalSpeed(slopeRadians: number): number {
  const drive = MOVEMENT.gravity * Math.sin(slopeRadians) * MOVEMENT.skiGravityScale;
  let low = 0;
  let high: number = MOVEMENT.maxSpeed;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const middle = (low + high) * 0.5;
    if (skiMomentumCurve(middle).dragAcceleration < drive) low = middle;
    else high = middle;
  }
  return (low + high) * 0.5;
}
