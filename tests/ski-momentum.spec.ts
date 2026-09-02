import { expect, test } from '@playwright/test';
import { METERS_PER_SECOND_PER_MPH, MOVEMENT, PLAYER_MAX_SPEED_MPH } from '../src/game/config';
import { skiCarveBlend, skiMomentumCurve, skiTerminalSpeed } from '../src/game/SkiMomentum';

const TEN_DEGREES = (10 * Math.PI) / 180;

test('ski drag grows monotonically and only becomes quadratic above the resistance start', () => {
  const speeds = [10, 16, 70 / 3.6, 22, 30, 40, 45, 60, 90, MOVEMENT.maxSpeed];
  const curve = speeds.map((speed) => skiMomentumCurve(speed));
  for (let index = 1; index < curve.length; index += 1) {
    expect(curve[index].dragAcceleration).toBeGreaterThan(curve[index - 1].dragAcceleration);
    expect(curve[index].resistance).toBeGreaterThanOrEqual(curve[index - 1].resistance);
  }
  // Below the resistance start only the tiny linear term applies.
  expect(skiMomentumCurve(MOVEMENT.skiResistanceStart).dragAcceleration)
    .toBeCloseTo(MOVEMENT.skiFriction * MOVEMENT.skiResistanceStart, 9);
  expect(skiMomentumCurve(0).resistance).toBe(0);
  expect(skiMomentumCurve(MOVEMENT.skiResistanceFullSpeed).resistance).toBe(1);
  expect(MOVEMENT.skiFriction).toBe(0.025);
});

test('gravity drive is never scaled down: the curve exposes no drive multiplier', () => {
  const curve = skiMomentumCurve(50) as Record<string, unknown>;
  expect(curve).not.toHaveProperty('gravityDriveScale');
  expect(MOVEMENT).not.toHaveProperty('skiGravityMinimumDrive');
});

test('a full 30° slope reaches at least three times run speed', () => {
  const fixedStep = MOVEMENT.fixedStep;
  const slopeAcceleration = MOVEMENT.gravity * Math.sin(Math.PI / 6) * MOVEMENT.skiGravityScale;
  let speed = 14;
  const speedEachSecond: number[] = [speed];
  for (let step = 1; step <= 12 / fixedStep; step += 1) {
    const curve = skiMomentumCurve(speed);
    speed += (slopeAcceleration - curve.dragAcceleration) * fixedStep;
    if (step % Math.round(1 / fixedStep) === 0) speedEachSecond.push(speed);
  }
  expect(Math.max(...speedEachSecond)).toBeGreaterThanOrEqual(MOVEMENT.wishSpeed * 3);
  expect(skiTerminalSpeed(Math.PI / 6)).toBeGreaterThanOrEqual(PLAYER_MAX_SPEED_MPH * METERS_PER_SECOND_PER_MPH * 0.98);
  expect(skiTerminalSpeed(Math.PI / 6)).toBeLessThanOrEqual(MOVEMENT.maxSpeed);
  expect(MOVEMENT.maxSpeed / METERS_PER_SECOND_PER_MPH).toBeCloseTo(PLAYER_MAX_SPEED_MPH, 5);
  // Each later gain still costs more slope time.
  const gains = speedEachSecond.slice(1).map((value, index) => value - speedEachSecond[index]);
  expect(gains[0]).toBeGreaterThan(gains[3]);
  expect(gains[3]).toBeGreaterThan(gains[7]);
});

test('a gentle 15° slope still crosses 70 km/h', () => {
  expect(skiTerminalSpeed(Math.PI / 12) * 3.6).toBeGreaterThan(70);
});

test('a 90° ski carve at run speed takes more than 1.2 s to settle', () => {
  const fixedStep = MOVEMENT.fixedStep;
  const speed = 15;
  let heading = Math.PI / 2;
  let elapsed = 0;
  let settledAt = Number.POSITIVE_INFINITY;
  let halfwayAt = Number.POSITIVE_INFINITY;
  while (elapsed < 6) {
    const blend = skiCarveBlend(speed, fixedStep);
    // Lerp of unit heading toward the wish direction, then renormalize —
    // exactly what applySkiCarve does with THREE.Vector3.lerp().normalize().
    const x = (1 - blend) * Math.cos(heading) + blend;
    const y = (1 - blend) * Math.sin(heading);
    heading = Math.atan2(y, x);
    elapsed += fixedStep;
    if (heading < Math.PI / 4 && !Number.isFinite(halfwayAt)) halfwayAt = elapsed;
    if (heading < TEN_DEGREES) {
      settledAt = elapsed;
      break;
    }
  }
  expect(halfwayAt).toBeGreaterThan(0.5);
  expect(settledAt).toBeGreaterThanOrEqual(1.2);
  expect(settledAt).toBeLessThan(4);
  // Faster lines steer even less.
  expect(skiCarveBlend(45, fixedStep)).toBeLessThan(skiCarveBlend(15, fixedStep));
});
