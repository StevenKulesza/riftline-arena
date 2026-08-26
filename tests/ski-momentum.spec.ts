import { expect, test } from '@playwright/test';
import { MOVEMENT } from '../src/game/config';
import { skiMomentumCurve } from '../src/game/SkiMomentum';

test('ski resistance grows progressively while downhill drive tapers', () => {
  const speeds = [10, 16, 70 / 3.6, 30, 40, 44];
  const curve = speeds.map((speed) => skiMomentumCurve(speed));
  for (let index = 1; index < curve.length; index += 1) {
    expect(curve[index].dragAcceleration).toBeGreaterThan(curve[index - 1].dragAcceleration);
    expect(curve[index].gravityDriveScale).toBeLessThanOrEqual(curve[index - 1].gravityDriveScale);
    expect(curve[index].resistance).toBeGreaterThanOrEqual(curve[index - 1].resistance);
  }
  expect(curve[0].gravityDriveScale).toBe(1);
  expect(curve.at(-1)!.gravityDriveScale).toBeCloseTo(MOVEMENT.skiGravityMinimumDrive, 6);
});

test('terrain gravity can cross 70 km/h but each later gain costs more slope time', () => {
  const fixedStep = MOVEMENT.fixedStep;
  const slopeAcceleration = 7.5;
  let speed = 14;
  const speedEachSecond: number[] = [speed];
  for (let step = 1; step <= 10 / fixedStep; step += 1) {
    const curve = skiMomentumCurve(speed);
    speed += Math.max(0, slopeAcceleration * curve.gravityDriveScale - curve.dragAcceleration) * fixedStep;
    if (step % Math.round(1 / fixedStep) === 0) speedEachSecond.push(speed);
  }

  expect(Math.max(...speedEachSecond) * 3.6).toBeGreaterThan(70);
  const gains = speedEachSecond.slice(1).map((value, index) => value - speedEachSecond[index]);
  expect(gains[0]).toBeGreaterThan(gains[3]);
  expect(gains[3]).toBeGreaterThan(gains[7]);
  expect(speed).toBeLessThan(MOVEMENT.skiResistanceFullSpeed);
});
