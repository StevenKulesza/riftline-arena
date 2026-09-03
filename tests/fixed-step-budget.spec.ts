import { expect, test } from '@playwright/test';
import { MAX_FIXED_STEPS_PER_FRAME, MOVEMENT } from '../src/game/config';

test('the fixed-step budget advances real time at the supported 30 FPS floor', () => {
  const simulatedSecondsPerRender = MOVEMENT.fixedStep * MAX_FIXED_STEPS_PER_FRAME;
  expect(MAX_FIXED_STEPS_PER_FRAME).toBeGreaterThanOrEqual(4);
  expect(simulatedSecondsPerRender).toBeGreaterThanOrEqual(1 / 30);
  expect(simulatedSecondsPerRender).toBeLessThan(0.05);
});
