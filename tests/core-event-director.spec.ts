import { expect, test } from '@playwright/test';
import {
  CORE_EVENT_DEFAULTS,
  CoreEventDirector,
  type CoreEvent,
} from '../src/systems/CoreEventDirector';

const makeDirector = (routeOrder: readonly string[] = ['north', 'west', 'south']): CoreEventDirector => (
  new CoreEventDirector({
    locations: ['north', 'west', 'south'],
    routeOrder,
  })
);

const eventTypes = (events: readonly CoreEvent[]): readonly string[] => events.map((event) => event.type);

test('schedules and activates the opening objective within ten seconds', () => {
  const director = makeDirector(['north']);

  const opening = director.update(CORE_EVENT_DEFAULTS.openingDelaySeconds);
  expect(eventTypes(opening)).toEqual(['opening-scheduled', 'telegraph-started']);
  expect(director.getSnapshot()).toMatchObject({ phase: 'telegraph', locationId: 'north', sequence: 1 });

  const activation = director.update(CORE_EVENT_DEFAULTS.telegraphDurationSeconds);
  expect(eventTypes(activation)).toEqual(['objective-activated']);
  expect(director.getSnapshot()).toMatchObject({
    phase: 'active',
    locationId: 'north',
    captureWindowRemainingSeconds: CORE_EVENT_DEFAULTS.captureWindowSeconds,
  });
  expect(director.getSnapshot().totalElapsedSeconds).toBeLessThanOrEqual(10);
});

test('emits a telegraph before each relocation and then opens the active capture window', () => {
  const director = makeDirector(['north', 'west']);

  director.update(CORE_EVENT_DEFAULTS.openingDelaySeconds + CORE_EVENT_DEFAULTS.telegraphDurationSeconds);
  const closeAndCooldown = director.update(CORE_EVENT_DEFAULTS.captureWindowSeconds);
  expect(eventTypes(closeAndCooldown)).toEqual(['capture-window-closed', 'cooldown-started']);
  expect(director.getSnapshot()).toMatchObject({ phase: 'cooldown', locationId: 'north' });

  const relocation = director.update(CORE_EVENT_DEFAULTS.cooldownDurationSeconds);
  expect(eventTypes(relocation)).toEqual(['telegraph-started']);
  expect(relocation[0]).toMatchObject({
    type: 'telegraph-started',
    reason: 'relocation',
    fromLocationId: 'north',
    toLocationId: 'west',
    sequence: 2,
  });
  expect(director.getSnapshot()).toMatchObject({ phase: 'telegraph', locationId: 'west', previousLocationId: 'north' });

  const active = director.update(CORE_EVENT_DEFAULTS.telegraphDurationSeconds);
  expect(active[0]).toMatchObject({ type: 'objective-activated', locationId: 'west', sequence: 2 });
});

test('follows the injected authored route deterministically and wraps at the end', () => {
  const director = makeDirector(['south', 'north']);
  const cycleSeconds = CORE_EVENT_DEFAULTS.telegraphDurationSeconds
    + CORE_EVENT_DEFAULTS.captureWindowSeconds
    + CORE_EVENT_DEFAULTS.cooldownDurationSeconds;

  const first = director.update(CORE_EVENT_DEFAULTS.openingDelaySeconds + CORE_EVENT_DEFAULTS.telegraphDurationSeconds);
  expect(first.find((event) => event.type === 'objective-activated')).toMatchObject({ locationId: 'south' });

  const second = director.update(cycleSeconds);
  expect(second.find((event) => event.type === 'objective-activated')).toMatchObject({ locationId: 'north' });

  const third = director.update(cycleSeconds);
  expect(third.find((event) => event.type === 'objective-activated')).toMatchObject({ locationId: 'south' });
  expect(director.getSnapshot().routeIndex).toBe(0);
});

test('does not advance for invalid or anti-stall deltas and caps a large delta safely', () => {
  const director = makeDirector();
  const initial = director.getSnapshot();

  expect(director.update(Number.NaN)).toEqual([]);
  expect(director.update(Number.POSITIVE_INFINITY)).toEqual([]);
  expect(director.update(-1)).toEqual([]);
  expect(director.getSnapshot()).toEqual(initial);

  const largeDeltaEvents = director.update(Number.MAX_SAFE_INTEGER);
  expect(largeDeltaEvents.length).toBeGreaterThan(0);
  expect(director.getSnapshot().totalElapsedSeconds).toBe(CORE_EVENT_DEFAULTS.maxUpdateDeltaSeconds);
  expect(Number.isFinite(director.getSnapshot().phaseRemainingSeconds)).toBe(true);
});

test('returns immutable snapshots and event collections', () => {
  const director = makeDirector(['north']);
  const events = director.update(CORE_EVENT_DEFAULTS.openingDelaySeconds);
  const snapshot = director.getSnapshot();

  expect(Object.isFrozen(events)).toBe(true);
  expect(Object.isFrozen(events[0])).toBe(true);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(() => {
    (snapshot as { phase: string }).phase = 'active';
  }).toThrow();
  expect(director.getSnapshot().phase).toBe('telegraph');
});

test('reset returns the director to the initial deterministic state', () => {
  const director = makeDirector(['north', 'west']);
  director.update(100);
  director.reset();

  expect(director.snapshot()).toEqual({
    phase: 'idle',
    locationId: null,
    previousLocationId: null,
    routeIndex: 0,
    sequence: 0,
    phaseElapsedSeconds: 0,
    phaseRemainingSeconds: CORE_EVENT_DEFAULTS.openingDelaySeconds,
    captureWindowRemainingSeconds: 0,
    cooldownRemainingSeconds: 0,
    totalElapsedSeconds: 0,
  });
  expect(eventTypes(director.update(CORE_EVENT_DEFAULTS.openingDelaySeconds))).toEqual([
    'opening-scheduled',
    'telegraph-started',
  ]);
});
