import { expect, test } from '@playwright/test';
import { WeatherGameplaySystem, type WeatherSequenceEntry } from '../src/systems/WeatherGameplaySystem';

function entry(overrides: Partial<WeatherSequenceEntry> = {}): WeatherSequenceEntry {
  return {
    id: 'rain-front',
    label: 'Rain front',
    clearSeconds: 1,
    telegraphSeconds: 2,
    activeSeconds: 3,
    recoverySeconds: 2,
    modifiers: {
      friction: 0.86,
      wind: { x: 5, y: 0, z: -2 },
      visibility: 0.78,
    },
    ...overrides,
  };
}

test('weather telegraphs before active modifiers and exposes HUD/audio cues', () => {
  const weather = new WeatherGameplaySystem([entry()]);

  expect(weather.snapshot()).toMatchObject({ phase: 'clear', eventLabel: 'Clear skies', countdownSeconds: 1 });
  const telegraph = weather.update(1);
  expect(telegraph.phase).toBe('telegraph');
  expect(telegraph.eventLabel).toBe('Rain front incoming');
  expect(telegraph.countdownSeconds).toBe(2);
  expect(telegraph.modifiers.friction).toBeGreaterThan(0.86);
  expect(telegraph.modifiers.friction).toBeLessThan(1);

  const active = weather.update(2);
  expect(active.phase).toBe('active');
  expect(active.eventLabel).toBe('Rain front active');
  expect(active.modifiers).toEqual({
    friction: 0.86,
    wind: { x: 5, y: 0, z: -2 },
    visibility: 0.78,
  });
});

test('phase transitions and recovery interpolate back to neutral', () => {
  const weather = new WeatherGameplaySystem([entry()]);

  weather.update(1 + 2 + 3);
  expect(weather.snapshot().phase).toBe('recovery');
  const halfway = weather.update(1);
  expect(halfway.phase).toBe('recovery');
  expect(halfway.modifiers.friction).toBeCloseTo((0.86 + 1) / 2, 8);
  expect(halfway.modifiers.wind.x).toBeCloseTo(2.5, 8);
  expect(halfway.modifiers.visibility).toBeCloseTo((0.78 + 1) / 2, 8);

  const next = weather.update(1);
  expect(next.phase).toBe('clear');
  expect(next.sequenceIndex).toBe(0);
  expect(next.modifiers).toEqual({ friction: 1, wind: { x: 0, y: 0, z: 0 }, visibility: 1 });
});

test('authored sequence cycles deterministically in order', () => {
  const sequence = [
    entry({ id: 'rain', label: 'Rain', clearSeconds: 0.5, telegraphSeconds: 0.5, activeSeconds: 1, recoverySeconds: 0.5 }),
    entry({ id: 'wind', label: 'Wind', clearSeconds: 0.5, telegraphSeconds: 0.5, activeSeconds: 1, recoverySeconds: 0.5 }),
  ];
  const first = new WeatherGameplaySystem(sequence);
  const second = new WeatherGameplaySystem(sequence);
  const deltas = [0.25, 0.25, 0.5, 0.5, 0.75, 0.5, 1.25, 0.25];

  for (const delta of deltas) {
    expect(first.update(delta)).toEqual(second.update(delta));
  }
  expect(first.snapshot().eventId).toBe('wind');
});

test('clamps invalid modifiers to conservative finite bounds', () => {
  const weather = new WeatherGameplaySystem([
    entry({
      modifiers: {
        friction: Number.POSITIVE_INFINITY,
        visibility: Number.NaN,
        wind: { x: 100, y: -100, z: 100 },
      },
    }),
  ]);

  const active = weather.update(1 + 2);
  expect(active.phase).toBe('active');
  expect(active.modifiers.friction).toBe(1.15);
  expect(active.modifiers.visibility).toBe(1);
  expect(Math.hypot(active.modifiers.wind.x, active.modifiers.wind.y, active.modifiers.wind.z)).toBeLessThanOrEqual(8);
  expect(Number.isFinite(active.modifiers.wind.x)).toBe(true);
  expect(Number.isFinite(active.modifiers.wind.y)).toBe(true);
  expect(Number.isFinite(active.modifiers.wind.z)).toBe(true);
});

test('large, invalid, and negative deltas are safe and deterministic', () => {
  const weather = new WeatherGameplaySystem([entry()]);
  const initial = weather.snapshot();

  expect(weather.update(Number.NaN)).toEqual(initial);
  expect(weather.update(-10)).toEqual(initial);
  expect(weather.update(Number.POSITIVE_INFINITY)).toEqual(initial);

  const afterLargeDelta = weather.update(1002);
  expect(afterLargeDelta.phase).toBe('telegraph');
  expect(afterLargeDelta.eventId).toBe('rain-front');
  expect(afterLargeDelta.phaseElapsedSeconds).toBeCloseTo(1, 8);
});

test('snapshots and nested modifiers are immutable', () => {
  const weather = new WeatherGameplaySystem([entry()]);
  const snapshot = weather.update(1 + 2);

  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.modifiers)).toBe(true);
  expect(Object.isFrozen(snapshot.modifiers.wind)).toBe(true);
  expect(() => {
    (snapshot as { phase: string }).phase = 'active';
  }).toThrow();
  expect(() => {
    (snapshot.modifiers.wind as { x: number }).x = 0;
  }).toThrow();
  expect(weather.snapshot().phase).toBe('active');
});

test('reset returns the deterministic initial state', () => {
  const weather = new WeatherGameplaySystem([entry()]);
  const initial = weather.snapshot();
  weather.update(20);

  const reset = weather.reset();
  expect(reset).toEqual(initial);
  expect(weather.snapshot()).toEqual(initial);
});
