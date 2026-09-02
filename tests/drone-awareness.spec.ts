import { expect, test } from '@playwright/test';
import {
  BUSTER_AWARENESS,
  GRENADIER_AWARENESS,
  SENTINEL_AWARENESS,
  droneCanAcquire,
} from '../src/systems/DroneAwareness';

test('sentinels cannot acquire across the old 118 m map-wide envelope', () => {
  expect(SENTINEL_AWARENESS.acquireRange).toBeLessThanOrEqual(42);
  expect(droneCanAcquire({
    distance: 80,
    acquireRange: SENTINEL_AWARENESS.acquireRange,
    retainRange: SENTINEL_AWARENESS.retainRange,
    proximityRange: SENTINEL_AWARENESS.proximityRange,
    alreadyTargeting: false,
    facingDot: 1,
    acquireDot: SENTINEL_AWARENESS.acquireDot,
    hasLos: true,
  })).toBe(false);
});

test('a new lock needs a forward cone unless the target is already in proximity', () => {
  const facingAway = droneCanAcquire({
    distance: 28,
    acquireRange: SENTINEL_AWARENESS.acquireRange,
    retainRange: SENTINEL_AWARENESS.retainRange,
    proximityRange: SENTINEL_AWARENESS.proximityRange,
    alreadyTargeting: false,
    facingDot: -0.2,
    acquireDot: SENTINEL_AWARENESS.acquireDot,
    hasLos: true,
  });
  const facingToward = droneCanAcquire({
    distance: 28,
    acquireRange: SENTINEL_AWARENESS.acquireRange,
    retainRange: SENTINEL_AWARENESS.retainRange,
    proximityRange: SENTINEL_AWARENESS.proximityRange,
    alreadyTargeting: false,
    facingDot: 0.92,
    acquireDot: SENTINEL_AWARENESS.acquireDot,
    hasLos: true,
  });
  const closeFlank = droneCanAcquire({
    distance: 12,
    acquireRange: SENTINEL_AWARENESS.acquireRange,
    retainRange: SENTINEL_AWARENESS.retainRange,
    proximityRange: SENTINEL_AWARENESS.proximityRange,
    alreadyTargeting: false,
    facingDot: -1,
    acquireDot: SENTINEL_AWARENESS.acquireDot,
    hasLos: true,
  });
  expect(facingAway).toBe(false);
  expect(facingToward).toBe(true);
  expect(closeFlank).toBe(true);
});

test('retained locks use the longer leash and skip the cone', () => {
  expect(droneCanAcquire({
    distance: 46,
    acquireRange: SENTINEL_AWARENESS.acquireRange,
    retainRange: SENTINEL_AWARENESS.retainRange,
    proximityRange: SENTINEL_AWARENESS.proximityRange,
    alreadyTargeting: true,
    facingDot: -1,
    acquireDot: SENTINEL_AWARENESS.acquireDot,
    hasLos: true,
  })).toBe(true);
  expect(droneCanAcquire({
    distance: 56,
    acquireRange: SENTINEL_AWARENESS.acquireRange,
    retainRange: SENTINEL_AWARENESS.retainRange,
    proximityRange: SENTINEL_AWARENESS.proximityRange,
    alreadyTargeting: true,
    facingDot: 1,
    acquireDot: SENTINEL_AWARENESS.acquireDot,
    hasLos: true,
  })).toBe(false);
});

test('acquisition still requires line of sight', () => {
  expect(droneCanAcquire({
    distance: 10,
    acquireRange: SENTINEL_AWARENESS.acquireRange,
    retainRange: SENTINEL_AWARENESS.retainRange,
    proximityRange: SENTINEL_AWARENESS.proximityRange,
    alreadyTargeting: true,
    facingDot: 1,
    acquireDot: SENTINEL_AWARENESS.acquireDot,
    hasLos: false,
  })).toBe(false);
});

test('busters and grenadiers stay inside local sector ranges', () => {
  expect(BUSTER_AWARENESS.acquireRange).toBeLessThanOrEqual(52);
  expect(GRENADIER_AWARENESS.acquireRange).toBeLessThanOrEqual(36);
  expect(droneCanAcquire({
    distance: 92,
    acquireRange: GRENADIER_AWARENESS.acquireRange,
    retainRange: GRENADIER_AWARENESS.retainRange,
    proximityRange: GRENADIER_AWARENESS.proximityRange,
    alreadyTargeting: false,
    facingDot: 1,
    acquireDot: GRENADIER_AWARENESS.acquireDot,
    hasLos: true,
  })).toBe(false);
});
