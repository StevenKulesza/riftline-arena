import { expect, test } from '@playwright/test';
import {
  FLUX_CORE_TELEGRAPH_SECONDS,
  FluxCoreDirector,
  type FluxCoreAnchor,
} from '../src/systems/FluxCoreDirector';

type TestAnchor = FluxCoreAnchor & {
  readonly x: number;
  readonly z: number;
};

const ANCHORS: readonly TestAnchor[] = [
  { name: 'Central Dais', x: 0, z: 0 },
  { name: 'West Relay', x: -132, z: 112 },
  { name: 'East Ridgeline', x: 118, z: -74 },
];

function createDirector(cooldownSeconds = 4): FluxCoreDirector<TestAnchor> {
  return new FluxCoreDirector(ANCHORS, { cooldownSeconds });
}

test('opens with a six-second telegraph and activates within ten seconds', () => {
  const director = createDirector();

  expect(director.snapshot()).toMatchObject({
    phase: 'telegraph',
    active: false,
    currentAnchor: null,
    nextAnchor: ANCHORS[0],
    secondsRemaining: FLUX_CORE_TELEGRAPH_SECONDS,
    cycle: 0,
    count: 0,
  });
  expect(FLUX_CORE_TELEGRAPH_SECONDS).toBeLessThanOrEqual(10);

  director.update(FLUX_CORE_TELEGRAPH_SECONDS - 0.25);
  expect(director.snapshot().phase).toBe('telegraph');
  expect(director.snapshot().secondsRemaining).toBeCloseTo(0.25, 6);

  director.update(0.25);
  expect(director.snapshot()).toMatchObject({
    phase: 'active',
    active: true,
    currentAnchor: ANCHORS[0],
    nextAnchor: null,
    secondsRemaining: 0,
    cycle: 1,
    count: 0,
  });
});

test('capture enters cooldown and schedules the following authored anchor', () => {
  const director = createDirector(5);
  director.update(FLUX_CORE_TELEGRAPH_SECONDS);

  expect(director.captured('player')).toBe(true);
  expect(director.snapshot()).toMatchObject({
    phase: 'cooldown',
    active: false,
    currentAnchor: ANCHORS[0],
    nextAnchor: ANCHORS[1],
    secondsRemaining: 5,
    cycle: 1,
    count: 1,
  });
  expect(director.captured('bot-1')).toBe(false);
  expect(director.snapshot().count).toBe(1);

  director.update(5);
  expect(director.snapshot()).toMatchObject({
    phase: 'telegraph',
    nextAnchor: ANCHORS[1],
    secondsRemaining: FLUX_CORE_TELEGRAPH_SECONDS,
  });
});

test('relocations follow stable input order without consecutive repeats', () => {
  const director = createDirector(2);
  const activated: TestAnchor[] = [];

  for (let index = 0; index < ANCHORS.length + 1; index += 1) {
    director.update(2 + FLUX_CORE_TELEGRAPH_SECONDS);
    const current = director.snapshot().currentAnchor;
    expect(current).not.toBeNull();
    if (!current) throw new Error('Flux Core failed to activate an authored anchor.');
    activated.push(current);
    if (index < ANCHORS.length) expect(director.captured(`owner-${index}`)).toBe(true);
  }

  expect(activated.map((anchor) => anchor.name)).toEqual([
    ANCHORS[0].name,
    ANCHORS[1].name,
    ANCHORS[2].name,
    ANCHORS[0].name,
  ]);
  for (let index = 1; index < activated.length; index += 1) {
    expect(activated[index]).not.toBe(activated[index - 1]);
  }
});

test('reset restores the opening telegraph, first anchor, and counters', () => {
  const director = createDirector(1);
  director.update(FLUX_CORE_TELEGRAPH_SECONDS);
  director.captured('player');
  director.update(1 + FLUX_CORE_TELEGRAPH_SECONDS);
  director.captured('bot-2');

  director.reset();

  expect(director.snapshot()).toMatchObject({
    phase: 'telegraph',
    active: false,
    currentAnchor: null,
    nextAnchor: ANCHORS[0],
    secondsRemaining: FLUX_CORE_TELEGRAPH_SECONDS,
    cycle: 0,
    count: 0,
  });
});

test('large deltas consume timed phases once and stop at active state', () => {
  const director = createDirector(3);

  director.update(120);
  expect(director.snapshot()).toMatchObject({
    phase: 'active',
    currentAnchor: ANCHORS[0],
    cycle: 1,
  });

  director.captured('player');
  director.update(120);
  expect(director.snapshot()).toMatchObject({
    phase: 'active',
    active: true,
    currentAnchor: ANCHORS[1],
    nextAnchor: null,
    secondsRemaining: 0,
    cycle: 2,
    count: 1,
  });
});
