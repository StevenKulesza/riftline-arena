/**
 * Deterministic scheduling for the Flux Core objective.
 *
 * This module intentionally does not know about players, capture ownership, or
 * match score. Integration code can use the active phase and events to decide
 * who is contesting the authored location without coupling objective timing to
 * scoring.
 */

export type CoreLocationId = string;

export type CorePhase = 'idle' | 'telegraph' | 'active' | 'cooldown';

export type CoreTransitionReason = 'opening' | 'relocation';

/**
 * Conservative defaults for a six-minute arena match:
 * - the first core becomes active at eight seconds (six seconds of setup plus
 *   a two-second telegraph), satisfying the early-objective contract;
 * - four seconds gives a fast player a meaningful capture window;
 * - twelve seconds of cooldown creates a recovery beat before the next route;
 * - a 30-second update cap prevents a tab wake-up or debugger pause from
 *   causing an unbounded transition loop.
 */
export const CORE_EVENT_DEFAULTS = Object.freeze({
  openingDelaySeconds: 6,
  telegraphDurationSeconds: 2,
  captureWindowSeconds: 4,
  cooldownDurationSeconds: 12,
  maxUpdateDeltaSeconds: 30,
});

export type CoreEventDirectorOptions = {
  readonly locations: readonly CoreLocationId[];
  /**
   * Authored order of location ids. Repeated ids are allowed when a map wants
   * to revisit a landmark; unknown ids are rejected at construction time.
   */
  readonly routeOrder?: readonly CoreLocationId[];
  readonly openingDelaySeconds?: number;
  readonly telegraphDurationSeconds?: number;
  readonly captureWindowSeconds?: number;
  readonly cooldownDurationSeconds?: number;
  readonly maxUpdateDeltaSeconds?: number;
};

export type CoreEvent =
  | {
      readonly type: 'opening-scheduled';
      readonly reason: 'opening';
      readonly fromLocationId: null;
      readonly toLocationId: CoreLocationId;
      readonly sequence: number;
      readonly atSeconds: number;
      readonly durationSeconds: number;
    }
  | {
      readonly type: 'telegraph-started';
      readonly reason: CoreTransitionReason;
      readonly fromLocationId: CoreLocationId | null;
      readonly toLocationId: CoreLocationId;
      readonly sequence: number;
      readonly atSeconds: number;
      readonly durationSeconds: number;
    }
  | {
      readonly type: 'objective-activated';
      readonly locationId: CoreLocationId;
      readonly sequence: number;
      readonly atSeconds: number;
      readonly captureWindowSeconds: number;
    }
  | {
      readonly type: 'capture-window-closed';
      readonly locationId: CoreLocationId;
      readonly sequence: number;
      readonly atSeconds: number;
    }
  | {
      readonly type: 'cooldown-started';
      readonly locationId: CoreLocationId;
      readonly sequence: number;
      readonly atSeconds: number;
      readonly durationSeconds: number;
    };

export type CoreSnapshot = Readonly<{
  readonly phase: CorePhase;
  readonly locationId: CoreLocationId | null;
  readonly previousLocationId: CoreLocationId | null;
  readonly routeIndex: number;
  readonly sequence: number;
  readonly phaseElapsedSeconds: number;
  readonly phaseRemainingSeconds: number;
  readonly captureWindowRemainingSeconds: number;
  readonly cooldownRemainingSeconds: number;
  readonly totalElapsedSeconds: number;
}>;

const EMPTY_EVENTS: readonly CoreEvent[] = Object.freeze([]);
const EPSILON_SECONDS = 1e-9;

const positiveFinite = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite number greater than zero.`);
  }
  return value;
};

const copyAndValidateLocations = (locations: readonly CoreLocationId[]): readonly CoreLocationId[] => {
  if (locations.length === 0) throw new RangeError('At least one core location is required.');

  const copy = [...locations];
  const known = new Set<string>();
  copy.forEach((locationId) => {
    if (typeof locationId !== 'string' || locationId.trim().length === 0) {
      throw new TypeError('Core location ids must be non-empty strings.');
    }
    if (known.has(locationId)) throw new RangeError(`Duplicate core location id: ${locationId}`);
    known.add(locationId);
  });
  return Object.freeze(copy);
};

const copyAndValidateRoute = (
  routeOrder: readonly CoreLocationId[] | undefined,
  locations: readonly CoreLocationId[],
): readonly CoreLocationId[] => {
  const route = [...(routeOrder ?? locations)];
  if (route.length === 0) throw new RangeError('At least one route location is required.');
  const known = new Set(locations);
  route.forEach((locationId) => {
    if (!known.has(locationId)) throw new RangeError(`Unknown core route location: ${locationId}`);
  });
  return Object.freeze(route);
};

export class CoreEventDirector {
  private readonly routeOrder: readonly CoreLocationId[];
  private readonly openingDelaySeconds: number;
  private readonly telegraphDurationSeconds: number;
  private readonly captureWindowSeconds: number;
  private readonly cooldownDurationSeconds: number;
  private readonly maxUpdateDeltaSeconds: number;

  private phase: CorePhase = 'idle';
  private locationId: CoreLocationId | null = null;
  private previousLocationId: CoreLocationId | null = null;
  private routeIndex = 0;
  private sequence = 0;
  private phaseElapsedSeconds = 0;
  private totalElapsedSeconds = 0;

  constructor(options: CoreEventDirectorOptions) {
    const locations = copyAndValidateLocations(options.locations);
    this.routeOrder = copyAndValidateRoute(options.routeOrder, locations);
    this.openingDelaySeconds = positiveFinite(
      options.openingDelaySeconds ?? CORE_EVENT_DEFAULTS.openingDelaySeconds,
      'openingDelaySeconds',
    );
    this.telegraphDurationSeconds = positiveFinite(
      options.telegraphDurationSeconds ?? CORE_EVENT_DEFAULTS.telegraphDurationSeconds,
      'telegraphDurationSeconds',
    );
    this.captureWindowSeconds = positiveFinite(
      options.captureWindowSeconds ?? CORE_EVENT_DEFAULTS.captureWindowSeconds,
      'captureWindowSeconds',
    );
    this.cooldownDurationSeconds = positiveFinite(
      options.cooldownDurationSeconds ?? CORE_EVENT_DEFAULTS.cooldownDurationSeconds,
      'cooldownDurationSeconds',
    );
    this.maxUpdateDeltaSeconds = positiveFinite(
      options.maxUpdateDeltaSeconds ?? CORE_EVENT_DEFAULTS.maxUpdateDeltaSeconds,
      'maxUpdateDeltaSeconds',
    );
  }

  /**
   * Advance the schedule and return only transitions crossed by this update.
   * Invalid deltas are a no-op. Large deltas are bounded so a paused tab cannot
   * make the director spin through an unbounded number of authored locations.
   */
  update(deltaSeconds: number): readonly CoreEvent[] {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return EMPTY_EVENTS;

    let remaining = Math.min(deltaSeconds, this.maxUpdateDeltaSeconds);
    const events: CoreEvent[] = [];

    while (remaining > 0) {
      const phaseDuration = this.durationForCurrentPhase();
      const phaseRemaining = Math.max(0, phaseDuration - this.phaseElapsedSeconds);
      const step = Math.min(remaining, phaseRemaining);

      this.advanceTime(step);
      remaining -= step;

      if (phaseRemaining - step <= EPSILON_SECONDS) {
        this.transition(events);
      }
    }

    return events.length === 0 ? EMPTY_EVENTS : Object.freeze(events);
  }

  getSnapshot(): CoreSnapshot {
    const phaseDuration = this.durationForCurrentPhase();
    const phaseRemainingSeconds = Math.max(0, phaseDuration - this.phaseElapsedSeconds);
    return Object.freeze({
      phase: this.phase,
      locationId: this.locationId,
      previousLocationId: this.previousLocationId,
      routeIndex: this.routeIndex,
      sequence: this.sequence,
      phaseElapsedSeconds: this.phaseElapsedSeconds,
      phaseRemainingSeconds,
      captureWindowRemainingSeconds: this.phase === 'active' ? phaseRemainingSeconds : 0,
      cooldownRemainingSeconds: this.phase === 'cooldown' ? phaseRemainingSeconds : 0,
      totalElapsedSeconds: this.totalElapsedSeconds,
    });
  }

  snapshot(): CoreSnapshot {
    return this.getSnapshot();
  }

  reset(): void {
    this.phase = 'idle';
    this.locationId = null;
    this.previousLocationId = null;
    this.routeIndex = 0;
    this.sequence = 0;
    this.phaseElapsedSeconds = 0;
    this.totalElapsedSeconds = 0;
  }

  private durationForCurrentPhase(): number {
    switch (this.phase) {
      case 'idle': return this.openingDelaySeconds;
      case 'telegraph': return this.telegraphDurationSeconds;
      case 'active': return this.captureWindowSeconds;
      case 'cooldown': return this.cooldownDurationSeconds;
    }
  }

  private advanceTime(deltaSeconds: number): void {
    this.phaseElapsedSeconds += deltaSeconds;
    this.totalElapsedSeconds += deltaSeconds;
  }

  private transition(events: CoreEvent[]): void {
    this.phaseElapsedSeconds = 0;
    switch (this.phase) {
      case 'idle': {
        this.phase = 'telegraph';
        this.previousLocationId = null;
        this.locationId = this.routeOrder[this.routeIndex];
        this.sequence = 1;
        const atSeconds = this.totalElapsedSeconds;
        events.push(Object.freeze({
          type: 'opening-scheduled',
          reason: 'opening',
          fromLocationId: null,
          toLocationId: this.locationId,
          sequence: this.sequence,
          atSeconds,
          durationSeconds: this.telegraphDurationSeconds,
        }));
        events.push(Object.freeze({
          type: 'telegraph-started',
          reason: 'opening',
          fromLocationId: null,
          toLocationId: this.locationId,
          sequence: this.sequence,
          atSeconds,
          durationSeconds: this.telegraphDurationSeconds,
        }));
        break;
      }
      case 'telegraph': {
        this.phase = 'active';
        events.push(Object.freeze({
          type: 'objective-activated',
          locationId: this.locationId as CoreLocationId,
          sequence: this.sequence,
          atSeconds: this.totalElapsedSeconds,
          captureWindowSeconds: this.captureWindowSeconds,
        }));
        break;
      }
      case 'active': {
        this.phase = 'cooldown';
        const locationId = this.locationId as CoreLocationId;
        const atSeconds = this.totalElapsedSeconds;
        events.push(Object.freeze({
          type: 'capture-window-closed',
          locationId,
          sequence: this.sequence,
          atSeconds,
        }));
        events.push(Object.freeze({
          type: 'cooldown-started',
          locationId,
          sequence: this.sequence,
          atSeconds,
          durationSeconds: this.cooldownDurationSeconds,
        }));
        break;
      }
      case 'cooldown': {
        this.phase = 'telegraph';
        this.previousLocationId = this.locationId;
        this.routeIndex = (this.routeIndex + 1) % this.routeOrder.length;
        this.locationId = this.routeOrder[this.routeIndex];
        this.sequence += 1;
        events.push(Object.freeze({
          type: 'telegraph-started',
          reason: 'relocation',
          fromLocationId: this.previousLocationId,
          toLocationId: this.locationId,
          sequence: this.sequence,
          atSeconds: this.totalElapsedSeconds,
          durationSeconds: this.telegraphDurationSeconds,
        }));
        break;
      }
    }
  }
}
