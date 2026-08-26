import { expect, test } from '@playwright/test';
import { STYLE_CONSTANTS, StyleSystem, type StyleEvent } from '../src/systems/StyleSystem';

test('awards a labeled medal for every supported style event', () => {
  const cases: readonly { event: StyleEvent; label: string; tier: string }[] = [
    { event: { type: 'air-frag' }, label: 'AIRBORNE', tier: 'bronze' },
    {
      event: { type: 'high-speed-elimination', speedMetersPerSecond: 31 },
      label: 'VELOCITY KILL',
      tier: 'silver',
    },
    { event: { type: 'long-range-elimination', distanceMeters: 72 }, label: 'LONGSHOT', tier: 'silver' },
    { event: { type: 'grapple-elimination' }, label: 'HOOKED', tier: 'gold' },
    { event: { type: 'core-denial' }, label: 'CORE DENIED', tier: 'silver' },
    { event: { type: 'multikill', killCount: 4 }, label: 'MULTI KILL', tier: 'platinum' },
  ];

  const system = new StyleSystem();
  for (const { event, label, tier } of cases) {
    const result = system.register(event);
    expect(result.accepted).toBe(true);
    expect(result.styleGain).toBeGreaterThan(0);
    expect(result.medal).toMatchObject({ event: event.type, label, tier });
  }
  expect(system.snapshot().meter).toBeLessThanOrEqual(STYLE_CONSTANTS.meterMaximum);
});

test('grows a five-second combo and expires it safely', () => {
  const system = new StyleSystem();
  expect(system.register({ type: 'air-frag' }).comboMultiplier).toBe(1);
  system.update(4.9);
  const chained = system.register({ type: 'core-denial' });
  expect(chained.comboCount).toBe(2);
  expect(chained.comboMultiplier).toBe(1.25);

  system.update(STYLE_CONSTANTS.comboWindowSeconds);
  const expired = system.snapshot();
  expect(expired.comboCount).toBe(0);
  expect(expired.comboMultiplier).toBe(1);
  expect(expired.comboRemainingSeconds).toBe(0);
});

test('rejects repeated medals during their anti-spam cooldown', () => {
  const system = new StyleSystem();
  const first = system.register({ type: 'air-frag' });
  const repeated = system.register({ type: 'air-frag' });
  expect(first.accepted).toBe(true);
  expect(repeated).toMatchObject({ accepted: false, rejection: 'cooldown', styleGain: 0, medal: null });
  expect(system.snapshot().comboCount).toBe(1);

  system.update(STYLE_CONSTANTS.eventCooldowns['air-frag']);
  expect(system.register({ type: 'air-frag' }).accepted).toBe(true);
});

test('rejects invalid thresholds without changing style state', () => {
  const system = new StyleSystem();
  expect(system.register({
    type: 'high-speed-elimination',
    speedMetersPerSecond: STYLE_CONSTANTS.highSpeedThresholdMetersPerSecond - 0.01,
  }).rejection).toBe('below-threshold');
  expect(system.register({ type: 'long-range-elimination', distanceMeters: Number.NaN }).rejection).toBe('invalid-event');
  expect(system.register({ type: 'multikill', killCount: 1 }).rejection).toBe('below-threshold');
  expect(system.snapshot()).toMatchObject({ meter: 0, comboCount: 0, lastMedal: null });
});

test('holds the meter through grace, then decays without crossing zero', () => {
  const system = new StyleSystem();
  const awarded = system.register({ type: 'core-denial' });
  system.update(STYLE_CONSTANTS.decayGraceSeconds);
  expect(system.snapshot().meter).toBe(awarded.meter);

  system.update(1.25);
  expect(system.snapshot().meter).toBe(awarded.meter - STYLE_CONSTANTS.decayPerSecond * 1.25);
  system.update(10_000);
  expect(system.snapshot().meter).toBe(0);
});

test('caps meter and combo multiplier under a sustained mixed-event chain', () => {
  const system = new StyleSystem();
  const events: readonly StyleEvent[] = [
    { type: 'air-frag' },
    { type: 'high-speed-elimination', speedMetersPerSecond: 30 },
    { type: 'long-range-elimination', distanceMeters: 60 },
    { type: 'grapple-elimination' },
    { type: 'core-denial' },
    { type: 'multikill', killCount: 5 },
  ];
  for (const event of events) system.register(event);
  system.update(2.5);
  for (const event of events) system.register(event);

  const snapshot = system.snapshot();
  expect(snapshot.meter).toBe(STYLE_CONSTANTS.meterMaximum);
  expect(snapshot.comboMultiplier).toBe(STYLE_CONSTANTS.comboMultiplierMaximum);
  expect(snapshot.comboCount).toBe(12);
});

test('reset clears meter, combo, cooldowns, and medal state', () => {
  const system = new StyleSystem();
  system.register({ type: 'grapple-elimination' });
  system.update(0.25);
  system.reset();

  const snapshot = system.snapshot();
  expect(snapshot).toMatchObject({
    meter: 0,
    comboCount: 0,
    comboMultiplier: 1,
    comboRemainingSeconds: 0,
    decayGraceRemainingSeconds: 0,
    lastMedal: null,
  });
  expect(Object.values(snapshot.cooldowns).every((cooldown) => cooldown === 0)).toBe(true);
  expect(system.register({ type: 'grapple-elimination' }).accepted).toBe(true);
});
