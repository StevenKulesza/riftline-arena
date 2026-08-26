export const FLUX_CORE_TELEGRAPH_SECONDS = 6;
export const FLUX_CORE_DEFAULT_COOLDOWN_SECONDS = 45;

export type FluxCorePhase = 'telegraph' | 'active' | 'cooldown';
export type FluxCoreCaptureOwner = string | number;

export interface FluxCoreAnchor {
  readonly name: string;
}

export interface FluxCoreDirectorOptions {
  readonly cooldownSeconds?: number;
}

export interface FluxCoreDirectorSnapshot<TAnchor extends FluxCoreAnchor> {
  readonly phase: FluxCorePhase;
  readonly active: boolean;
  readonly currentAnchor: TAnchor | null;
  readonly nextAnchor: TAnchor | null;
  readonly secondsRemaining: number;
  /** Number of activations since the most recent reset. */
  readonly cycle: number;
  /** Number of accepted captures since the most recent reset. */
  readonly count: number;
}

type MutableFluxCoreDirectorSnapshot<TAnchor extends FluxCoreAnchor> = {
  -readonly [Key in keyof FluxCoreDirectorSnapshot<TAnchor>]: FluxCoreDirectorSnapshot<TAnchor>[Key];
};

/**
 * Deterministically schedules Flux Core anchors without owning match score.
 *
 * Candidate order is authored: reset starts at index zero and each accepted
 * capture advances one index, wrapping at the end. The snapshot object is
 * reused so reading director state does not allocate in a frame loop.
 */
export class FluxCoreDirector<TAnchor extends FluxCoreAnchor = FluxCoreAnchor> {
  private readonly anchors: readonly TAnchor[];
  private readonly cooldownSeconds: number;
  private readonly state: MutableFluxCoreDirectorSnapshot<TAnchor>;
  private currentAnchorIndex = -1;
  private nextAnchorIndex = 0;

  constructor(anchors: readonly TAnchor[], options: FluxCoreDirectorOptions = {}) {
    if (anchors.length < 2) {
      throw new RangeError('FluxCoreDirector requires at least two anchors to avoid consecutive repeats.');
    }

    const names = new Set<string>();
    for (const anchor of anchors) {
      if (typeof anchor.name !== 'string' || anchor.name.trim().length === 0) {
        throw new TypeError('Every Flux Core anchor requires a non-empty name.');
      }
      if (names.has(anchor.name)) {
        throw new RangeError(`Flux Core anchor names must be unique: ${anchor.name}`);
      }
      names.add(anchor.name);
    }

    const cooldownSeconds = options.cooldownSeconds ?? FLUX_CORE_DEFAULT_COOLDOWN_SECONDS;
    if (!Number.isFinite(cooldownSeconds) || cooldownSeconds <= 0) {
      throw new RangeError('Flux Core cooldown must be a finite number greater than zero.');
    }

    this.anchors = anchors.slice();
    this.cooldownSeconds = cooldownSeconds;
    this.state = {
      phase: 'telegraph',
      active: false,
      currentAnchor: null,
      nextAnchor: this.anchors[0],
      secondsRemaining: FLUX_CORE_TELEGRAPH_SECONDS,
      cycle: 0,
      count: 0,
    };
  }

  snapshot(): Readonly<FluxCoreDirectorSnapshot<TAnchor>> {
    return this.state;
  }

  reset(): void {
    this.currentAnchorIndex = -1;
    this.nextAnchorIndex = 0;
    this.state.phase = 'telegraph';
    this.state.active = false;
    this.state.currentAnchor = null;
    this.state.nextAnchor = this.anchors[0];
    this.state.secondsRemaining = FLUX_CORE_TELEGRAPH_SECONDS;
    this.state.cycle = 0;
    this.state.count = 0;
  }

  update(deltaSeconds: number): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
      throw new RangeError('Flux Core update delta must be a finite number greater than or equal to zero.');
    }

    let remainingDelta = deltaSeconds;
    while (remainingDelta > 0 && this.state.phase !== 'active') {
      if (remainingDelta < this.state.secondsRemaining) {
        this.state.secondsRemaining -= remainingDelta;
        return;
      }

      remainingDelta -= this.state.secondsRemaining;
      this.state.secondsRemaining = 0;

      if (this.state.phase === 'cooldown') {
        this.beginTelegraph();
      } else {
        this.activateNextAnchor();
      }
    }
  }

  captured(_owner: FluxCoreCaptureOwner): boolean {
    if (this.state.phase !== 'active') return false;

    this.state.count += 1;
    this.state.phase = 'cooldown';
    this.state.active = false;
    this.state.secondsRemaining = this.cooldownSeconds;
    this.nextAnchorIndex = (this.currentAnchorIndex + 1) % this.anchors.length;
    this.state.nextAnchor = this.anchors[this.nextAnchorIndex];
    return true;
  }

  private beginTelegraph(): void {
    this.state.phase = 'telegraph';
    this.state.active = false;
    this.state.secondsRemaining = FLUX_CORE_TELEGRAPH_SECONDS;
  }

  private activateNextAnchor(): void {
    this.currentAnchorIndex = this.nextAnchorIndex;
    this.state.phase = 'active';
    this.state.active = true;
    this.state.currentAnchor = this.anchors[this.currentAnchorIndex];
    this.state.nextAnchor = null;
    this.state.secondsRemaining = 0;
    this.state.cycle += 1;
  }
}
