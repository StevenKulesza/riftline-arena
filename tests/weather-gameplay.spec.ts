import { expect, test } from '@playwright/test';
import {
  WEATHER_PHASE_DURATIONS_SECONDS,
  WEATHER_PHASE_ORDER,
  WEATHER_WARNING_MIN_SECONDS,
  WeatherGameplaySystem,
  type WeatherGameplayMultipliers,
} from '../src/systems/WeatherGameplaySystem';

const NEUTRAL_MULTIPLIERS: WeatherGameplayMultipliers = {
  airControlMultiplier: 1,
  groundFrictionMultiplier: 1,
  groundTractionMultiplier: 1,
  projectileDriftMultiplier: 0,
  visibilityMultiplier: 1,
};

test('weather follows the named phase order and durations', () => {
  const weather = new WeatherGameplaySystem({ seed: 450_600, cycleIndex: 3 });

  for (const phase of WEATHER_PHASE_ORDER) {
    const snapshot = weather.snapshot();
    expect(snapshot.phase).toBe(phase);
    expect(snapshot.phaseDurationSeconds).toBe(WEATHER_PHASE_DURATIONS_SECONDS[phase]);
    expect(snapshot.secondsRemaining).toBe(WEATHER_PHASE_DURATIONS_SECONDS[phase]);
    weather.update(WEATHER_PHASE_DURATIONS_SECONDS[phase]);
  }

  expect(weather.snapshot().phase).toBe('calm');
  expect(weather.snapshot().cycleIndex).toBe(4);
});

test('warning provides notice while calm, warning, and recovery handling stay neutral', () => {
  const weather = new WeatherGameplaySystem(12);
  expect(weather.snapshot().multipliers).toEqual(NEUTRAL_MULTIPLIERS);

  weather.update(WEATHER_PHASE_DURATIONS_SECONDS.calm);
  const warning = weather.snapshot();
  expect(warning.phase).toBe('warning');
  expect(WEATHER_PHASE_DURATIONS_SECONDS.warning).toBeGreaterThanOrEqual(WEATHER_WARNING_MIN_SECONDS);
  expect(warning.secondsRemaining).toBeGreaterThanOrEqual(6);
  expect(warning.label).toContain('MONSOON WARNING');
  expect(warning.multipliers).toEqual(NEUTRAL_MULTIPLIERS);

  weather.update(WEATHER_PHASE_DURATIONS_SECONDS.warning + WEATHER_PHASE_DURATIONS_SECONDS.monsoon);
  const recovery = weather.snapshot();
  expect(recovery.phase).toBe('recovery');
  expect(recovery.multipliers).toEqual(NEUTRAL_MULTIPLIERS);
  expect(recovery.windStrength).toBe(0);
});

test('active monsoon effects are normalized, conservative, and stable', () => {
  const weather = new WeatherGameplaySystem({ seed: 99, cycleIndex: 2 });
  weather.update(WEATHER_PHASE_DURATIONS_SECONDS.calm + WEATHER_PHASE_DURATIONS_SECONDS.warning);

  const start = weather.snapshot();
  expect(start.phase).toBe('monsoon');
  expect(start.severity).toBe(1);
  expect(start.windStrength).toBeGreaterThanOrEqual(0);
  expect(start.windStrength).toBeLessThanOrEqual(1);
  expect(Math.hypot(start.windDirection.x, start.windDirection.z)).toBeCloseTo(1, 10);
  expect(start.multipliers.airControlMultiplier).toBeGreaterThanOrEqual(0.9);
  expect(start.multipliers.airControlMultiplier).toBeLessThanOrEqual(1);
  expect(start.multipliers.groundFrictionMultiplier).toBeGreaterThanOrEqual(0.9);
  expect(start.multipliers.groundFrictionMultiplier).toBeLessThanOrEqual(1);
  expect(start.multipliers.groundTractionMultiplier).toBeGreaterThanOrEqual(0.9);
  expect(start.multipliers.groundTractionMultiplier).toBeLessThanOrEqual(1);
  expect(start.multipliers.projectileDriftMultiplier).toBeGreaterThanOrEqual(0);
  expect(start.multipliers.projectileDriftMultiplier).toBeLessThanOrEqual(0.1);
  expect(start.multipliers.visibilityMultiplier).toBeGreaterThanOrEqual(0.85);
  expect(start.multipliers.visibilityMultiplier).toBeLessThanOrEqual(1);

  weather.update(11.25);
  const later = weather.snapshot();
  expect(later.windDirection).toEqual(start.windDirection);
  expect(later.windStrength).toBe(start.windStrength);
  expect(later.multipliers).toEqual(start.multipliers);
});

test('same seed and cycle remain deterministic across differently sized updates', () => {
  const stepped = new WeatherGameplaySystem({ seed: 7_331, cycleIndex: 5 });
  const batched = new WeatherGameplaySystem({ seed: 7_331, cycleIndex: 5 });
  const deltas = [1 / 120, 3.75, 42, 8, 6.125, 41.5, 19.75];

  for (const delta of deltas) stepped.update(delta);
  batched.update(deltas.reduce((total, delta) => total + delta, 0));

  expect(stepped.snapshot()).toEqual(batched.snapshot());

  const anotherSeed = new WeatherGameplaySystem({ seed: 7_332, cycleIndex: 5 }).snapshot();
  expect(anotherSeed.windDirection).not.toEqual(stepped.snapshot().windDirection);
});

test('reset restores the exact initial snapshot and ignores invalid deltas', () => {
  const weather = new WeatherGameplaySystem({ seed: 101, cycleIndex: 4 });
  const initial = weather.snapshot();

  weather.update(Number.NaN);
  weather.update(-10);
  expect(weather.snapshot()).toEqual(initial);

  weather.update(179.5);
  expect(weather.snapshot()).not.toEqual(initial);
  weather.reset();
  expect(weather.snapshot()).toEqual(initial);
});
