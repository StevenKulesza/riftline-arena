export const WEATHER_PHASE_ORDER = ['calm', 'warning', 'monsoon', 'recovery'] as const;

export type WeatherGameplayPhase = (typeof WEATHER_PHASE_ORDER)[number];
export type LegacyWeatherPhase = 'clear' | 'telegraph' | 'active' | 'recovery';
export type WeatherPhase = WeatherGameplayPhase | LegacyWeatherPhase;

export const WEATHER_PHASE_DURATIONS_SECONDS: Readonly<Record<WeatherGameplayPhase, number>> = Object.freeze({
  calm: 42,
  warning: 8,
  monsoon: 24,
  recovery: 12,
});

export const WEATHER_WARNING_MIN_SECONDS = 6;

export interface WeatherWindVector {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Gameplay-facing environmental values; score and presentation stay external. */
export interface WeatherModifiers {
  /** Multiplier for ground friction. 1 is neutral. */
  readonly friction: number;
  /** Authored world-space wind vector for a future movement integration. */
  readonly wind: Readonly<WeatherWindVector>;
  /** Visibility multiplier. 1 is fully readable. */
  readonly visibility: number;
}

/** Input aliases keep authored data readable while normalizing to WeatherModifiers. */
export interface WeatherModifierInput {
  readonly friction?: number;
  readonly frictionMultiplier?: number;
  readonly wind?: Partial<WeatherWindVector>;
  readonly windVector?: Partial<WeatherWindVector>;
  readonly visibility?: number;
  readonly visibilityMultiplier?: number;
}

export interface WeatherSequenceEntry {
  readonly id: string;
  readonly label: string;
  readonly clearSeconds?: number;
  readonly telegraphSeconds: number;
  readonly activeSeconds: number;
  readonly recoverySeconds: number;
  readonly modifiers?: WeatherModifierInput;
}

export interface WeatherGameplayOptions {
  readonly seed?: number;
  readonly cycleIndex?: number;
  readonly sequence?: readonly WeatherSequenceEntry[];
  readonly clearDurationSeconds?: number;
}

export type WeatherGameplayMultipliers = Readonly<{
  airControlMultiplier: number;
  groundFrictionMultiplier: number;
  groundTractionMultiplier: number;
  /** Scales drift derived from the stable wind vector; zero disables drift. */
  projectileDriftMultiplier: number;
  visibilityMultiplier: number;
}>;

export interface WeatherSnapshot {
  readonly eventId: string | null;
  readonly eventLabel: string;
  readonly sequenceIndex: number;
  readonly phase: WeatherPhase;
  readonly phaseElapsedSeconds: number;
  readonly phaseRemainingSeconds: number;
  /** Whole seconds remaining, suitable for HUD and audio cues. */
  readonly countdownSeconds: number;
  readonly modifiers: Readonly<WeatherModifiers>;
  readonly cycleIndex: number;
  readonly phaseDurationSeconds: number;
  readonly secondsRemaining: number;
  readonly phaseProgress: number;
  /** Visual severity normalized to the inclusive [0, 1] range. */
  readonly severity: number;
  readonly windDirection: Readonly<{ x: number; z: number }>;
  readonly windStrength: number;
  readonly label: string;
  readonly multipliers: WeatherGameplayMultipliers;
}

export type WeatherGameplaySnapshot = WeatherSnapshot;

interface NormalizedWeatherEntry {
  readonly id: string;
  readonly label: string;
  readonly clearSeconds: number;
  readonly telegraphSeconds: number;
  readonly activeSeconds: number;
  readonly recoverySeconds: number;
  readonly modifiers: Readonly<WeatherModifiers>;
}

const DEFAULT_CLEAR_SECONDS = 12;
const DEFAULT_TELEGRAPH_SECONDS = 8;
const DEFAULT_ACTIVE_SECONDS = 24;
const DEFAULT_RECOVERY_SECONDS = 12;
const MIN_PHASE_SECONDS = 0.01;

// Conservative bounds preserve readable movement and telegraphing in a
// competitive arena. Change these only with focused gameplay tuning.
const MIN_FRICTION = 0.85;
const MAX_FRICTION = 1.15;
const MIN_VISIBILITY = 0.7;
const MAX_WIND_SPEED = 8;
const TELEGRAPH_EFFECT_FRACTION = 0.35;
const EPSILON = 1e-9;
const TWO_PI = Math.PI * 2;

const NEUTRAL_GAMEPLAY_MULTIPLIERS: WeatherGameplayMultipliers = Object.freeze({
  airControlMultiplier: 1,
  groundFrictionMultiplier: 1,
  groundTractionMultiplier: 1,
  projectileDriftMultiplier: 0,
  visibilityMultiplier: 1,
});

const MONSOON_GAMEPLAY_MULTIPLIERS: WeatherGameplayMultipliers = Object.freeze({
  airControlMultiplier: 0.96,
  groundFrictionMultiplier: 0.94,
  groundTractionMultiplier: 0.96,
  projectileDriftMultiplier: 0.06,
  visibilityMultiplier: 0.9,
});

const NEUTRAL_WIND: WeatherWindVector = Object.freeze({ x: 0, y: 0, z: 0 });
const NEUTRAL_MODIFIERS: WeatherModifiers = Object.freeze({
  friction: 1,
  wind: NEUTRAL_WIND,
  visibility: 1,
});

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function boundedOr(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === Number.POSITIVE_INFINITY) return maximum;
  if (value === Number.NEGATIVE_INFINITY) return minimum;
  return clamp(finiteOr(value, fallback), minimum, maximum);
}

function stableTime(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function positiveDuration(value: unknown, fallback: number): number {
  return Math.max(MIN_PHASE_SECONDS, finiteOr(value, fallback));
}

function normalizedIndex(value: unknown): number {
  return Math.max(0, Math.floor(finiteOr(value, 0)));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function smoothstep01(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function hashedUnit(seed: number, cycleIndex: number, salt: number): number {
  let value = (seed ^ Math.imul(cycleIndex + 1, 0x9e3779b1) ^ salt) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  value ^= value >>> 15;
  return (value >>> 0) / 0x100000000;
}

function normalizeWind(input: Partial<WeatherWindVector> | undefined): WeatherWindVector {
  const x = clamp(finiteOr(input?.x, 0), -MAX_WIND_SPEED, MAX_WIND_SPEED);
  const y = clamp(finiteOr(input?.y, 0), -MAX_WIND_SPEED, MAX_WIND_SPEED);
  const z = clamp(finiteOr(input?.z, 0), -MAX_WIND_SPEED, MAX_WIND_SPEED);
  const length = Math.hypot(x, y, z);
  const scale = length > MAX_WIND_SPEED ? MAX_WIND_SPEED / length : 1;
  return Object.freeze({ x: x * scale, y: y * scale, z: z * scale });
}

function normalizeModifiers(input: WeatherModifierInput | undefined): Readonly<WeatherModifiers> {
  const frictionInput = input?.frictionMultiplier ?? input?.friction;
  const visibilityInput = input?.visibilityMultiplier ?? input?.visibility;
  const windInput = input?.windVector ?? input?.wind;
  return Object.freeze({
    friction: boundedOr(frictionInput, 1, MIN_FRICTION, MAX_FRICTION),
    wind: normalizeWind(windInput),
    visibility: clamp(finiteOr(visibilityInput, 1), MIN_VISIBILITY, 1),
  });
}

function normalizeEntry(
  entry: WeatherSequenceEntry,
  index: number,
  defaultClearSeconds: number,
): NormalizedWeatherEntry {
  const id = typeof entry?.id === 'string' && entry.id.trim().length > 0 ? entry.id : `weather-${index}`;
  const label = typeof entry?.label === 'string' && entry.label.trim().length > 0 ? entry.label : 'Weather event';
  return Object.freeze({
    id,
    label,
    clearSeconds: positiveDuration(entry?.clearSeconds, defaultClearSeconds),
    telegraphSeconds: positiveDuration(entry?.telegraphSeconds, DEFAULT_TELEGRAPH_SECONDS),
    activeSeconds: positiveDuration(entry?.activeSeconds, DEFAULT_ACTIVE_SECONDS),
    recoverySeconds: positiveDuration(entry?.recoverySeconds, DEFAULT_RECOVERY_SECONDS),
    modifiers: normalizeModifiers(entry?.modifiers),
  });
}

function mixNumber(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function mixModifiers(from: WeatherModifiers, to: WeatherModifiers, amount: number): WeatherModifiers {
  return Object.freeze({
    friction: mixNumber(from.friction, to.friction, amount),
    wind: Object.freeze({
      x: mixNumber(from.wind.x, to.wind.x, amount),
      y: mixNumber(from.wind.y, to.wind.y, amount),
      z: mixNumber(from.wind.z, to.wind.z, amount),
    }),
    visibility: mixNumber(from.visibility, to.visibility, amount),
  });
}

function cloneModifiers(modifiers: WeatherModifiers): WeatherModifiers {
  return Object.freeze({
    friction: modifiers.friction,
    wind: Object.freeze({ ...modifiers.wind }),
    visibility: modifiers.visibility,
  });
}

/**
 * Deterministic weather timeline for later Game/Arena/HUD integration.
 *
 * Every authored event runs clear -> telegraph -> active -> recovery. The
 * telegraph reaches only 35% of the active effect, active values stay stable,
 * and recovery fades to neutral. Friction is clamped to 0.85..1.15,
 * visibility to 0.7..1, and wind magnitude to 8 world units per second.
 */
export class WeatherGameplaySystem {
  private readonly builtInMode: boolean;
  private readonly seed: number;
  private readonly initialCycleIndex: number;
  private readonly sequence: readonly NormalizedWeatherEntry[];
  private readonly cycleSeconds: number;
  private sequenceIndex = 0;
  private phase: LegacyWeatherPhase = 'clear';
  private phaseElapsedSeconds = 0;
  private phaseRemainingSeconds: number;
  private cycleIndex: number;
  private windDirectionX = 1;
  private windDirectionZ = 0;
  private monsoonWindStrength = 0.7;

  constructor(seed?: number);
  constructor(sequence: readonly WeatherSequenceEntry[]);
  constructor(options?: WeatherGameplayOptions);
  constructor(input: number | readonly WeatherSequenceEntry[] | WeatherGameplayOptions = {}) {
    const options: WeatherGameplayOptions = typeof input === 'number'
      ? { seed: input }
      : Array.isArray(input)
        ? { sequence: input as readonly WeatherSequenceEntry[] }
        : input as WeatherGameplayOptions;
    this.builtInMode = options.sequence === undefined;
    this.seed = normalizedIndex(options.seed) >>> 0;
    this.initialCycleIndex = normalizedIndex(options.cycleIndex);
    this.cycleIndex = this.initialCycleIndex;
    const defaultClearSeconds = positiveDuration(options.clearDurationSeconds, DEFAULT_CLEAR_SECONDS);
    const sequence = options.sequence ?? [{
      id: 'monsoon',
      label: 'Monsoon',
      clearSeconds: WEATHER_PHASE_DURATIONS_SECONDS.calm,
      telegraphSeconds: WEATHER_PHASE_DURATIONS_SECONDS.warning,
      activeSeconds: WEATHER_PHASE_DURATIONS_SECONDS.monsoon,
      recoverySeconds: WEATHER_PHASE_DURATIONS_SECONDS.recovery,
      modifiers: {
        frictionMultiplier: MONSOON_GAMEPLAY_MULTIPLIERS.groundFrictionMultiplier,
        visibilityMultiplier: MONSOON_GAMEPLAY_MULTIPLIERS.visibilityMultiplier,
      },
    }];
    this.sequence = Object.freeze(
      sequence.map((entry, index) => normalizeEntry(entry, index, defaultClearSeconds)),
    );
    this.cycleSeconds = this.sequence.reduce(
      (total, entry) => total + entry.clearSeconds + entry.telegraphSeconds + entry.activeSeconds + entry.recoverySeconds,
      0,
    );
    this.refreshCycleWind();
    this.phaseRemainingSeconds = this.currentPhaseDuration();
  }

  update(deltaSeconds: number): WeatherSnapshot {
    let remaining = finiteOr(deltaSeconds, 0);
    if (remaining <= 0 || this.sequence.length === 0) return this.snapshot();

    // Full authored cycles return to the same phase. Skipping them keeps a
    // background-throttled frame bounded without making the result stochastic.
    if (this.cycleSeconds > 0 && remaining >= this.cycleSeconds) {
      const skippedCycles = Math.floor(remaining / this.cycleSeconds);
      remaining -= skippedCycles * this.cycleSeconds;
      this.cycleIndex += skippedCycles;
      if (this.builtInMode) this.refreshCycleWind();
    }

    while (remaining > EPSILON) {
      if (remaining + EPSILON < this.phaseRemainingSeconds) {
        this.phaseElapsedSeconds += remaining;
        this.phaseRemainingSeconds -= remaining;
        remaining = 0;
      } else {
        remaining = Math.max(0, remaining - this.phaseRemainingSeconds);
        this.advancePhase();
      }
    }
    return this.snapshot();
  }

  snapshot(): WeatherSnapshot {
    const entry = this.sequence[this.sequenceIndex];
    const modifiers = this.currentModifiers(entry);
    const phaseElapsedSeconds = stableTime(this.phaseElapsedSeconds);
    const phaseRemainingSeconds = stableTime(Math.max(0, this.phaseRemainingSeconds));
    const phaseDurationSeconds = this.currentPhaseDuration();
    const phaseProgress = phaseDurationSeconds > 0
      ? stableTime(clamp01(phaseElapsedSeconds / phaseDurationSeconds))
      : 0;
    const phase = this.publicPhase();
    const multipliers = this.gameplayMultipliers(modifiers);
    const wind = this.gameplayWind(modifiers);
    const label = this.playerFacingLabel(entry, phaseRemainingSeconds);
    const snapshot: WeatherSnapshot = {
      eventId: this.builtInMode ? 'monsoon' : entry?.id ?? null,
      eventLabel: label,
      sequenceIndex: this.builtInMode ? this.cycleIndex : entry ? this.sequenceIndex : -1,
      phase,
      phaseElapsedSeconds,
      phaseRemainingSeconds,
      countdownSeconds: entry ? Math.ceil(phaseRemainingSeconds - EPSILON) : 0,
      modifiers,
      cycleIndex: this.cycleIndex,
      phaseDurationSeconds,
      secondsRemaining: phaseRemainingSeconds,
      phaseProgress,
      severity: this.normalizedSeverity(phaseProgress),
      windDirection: Object.freeze({ x: wind.directionX, z: wind.directionZ }),
      windStrength: wind.strength,
      label,
      multipliers: Object.freeze({ ...multipliers }),
    };
    return Object.freeze(snapshot);
  }

  getSnapshot(): WeatherSnapshot {
    return this.snapshot();
  }

  reset(): WeatherSnapshot {
    this.sequenceIndex = 0;
    this.phase = 'clear';
    this.phaseElapsedSeconds = 0;
    this.cycleIndex = this.initialCycleIndex;
    this.refreshCycleWind();
    this.phaseRemainingSeconds = this.currentPhaseDuration();
    return this.snapshot();
  }

  private currentPhaseDuration(): number {
    const entry = this.sequence[this.sequenceIndex];
    if (!entry) return 0;
    switch (this.phase) {
      case 'clear':
        return entry.clearSeconds;
      case 'telegraph':
        return entry.telegraphSeconds;
      case 'active':
        return entry.activeSeconds;
      case 'recovery':
        return entry.recoverySeconds;
    }
  }

  private advancePhase(): void {
    if (this.phase === 'recovery') {
      this.sequenceIndex = (this.sequenceIndex + 1) % this.sequence.length;
      this.phase = 'clear';
      if (this.builtInMode || this.sequenceIndex === 0) {
        this.cycleIndex += 1;
        if (this.builtInMode) this.refreshCycleWind();
      }
    } else if (this.phase === 'clear') {
      this.phase = 'telegraph';
    } else if (this.phase === 'telegraph') {
      this.phase = 'active';
    } else {
      this.phase = 'recovery';
    }
    this.phaseElapsedSeconds = 0;
    this.phaseRemainingSeconds = this.currentPhaseDuration();
  }

  private currentModifiers(entry: NormalizedWeatherEntry | undefined): WeatherModifiers {
    if (this.builtInMode) {
      if (this.phase !== 'active') return cloneModifiers(NEUTRAL_MODIFIERS);
      const driftStrength = this.monsoonWindStrength
        * MONSOON_GAMEPLAY_MULTIPLIERS.projectileDriftMultiplier
        * MAX_WIND_SPEED;
      return Object.freeze({
        friction: MONSOON_GAMEPLAY_MULTIPLIERS.groundFrictionMultiplier,
        wind: Object.freeze({
          x: this.windDirectionX * driftStrength,
          y: 0,
          z: this.windDirectionZ * driftStrength,
        }),
        visibility: MONSOON_GAMEPLAY_MULTIPLIERS.visibilityMultiplier,
      });
    }
    if (!entry || this.phase === 'clear') return cloneModifiers(NEUTRAL_MODIFIERS);
    const progress = clamp(this.phaseElapsedSeconds / this.currentPhaseDuration(), 0, 1);
    if (this.phase === 'telegraph') {
      return mixModifiers(NEUTRAL_MODIFIERS, entry.modifiers, Math.max(TELEGRAPH_EFFECT_FRACTION, progress));
    }
    if (this.phase === 'active') return cloneModifiers(entry.modifiers);
    return mixModifiers(entry.modifiers, NEUTRAL_MODIFIERS, progress);
  }

  private publicPhase(): WeatherPhase {
    if (!this.builtInMode) return this.phase;
    if (this.phase === 'clear') return 'calm';
    if (this.phase === 'telegraph') return 'warning';
    if (this.phase === 'active') return 'monsoon';
    return 'recovery';
  }

  private gameplayMultipliers(modifiers: WeatherModifiers): WeatherGameplayMultipliers {
    if (this.builtInMode) {
      return this.phase === 'active' ? MONSOON_GAMEPLAY_MULTIPLIERS : NEUTRAL_GAMEPLAY_MULTIPLIERS;
    }
    return {
      airControlMultiplier: 1,
      groundFrictionMultiplier: modifiers.friction,
      groundTractionMultiplier: modifiers.friction,
      projectileDriftMultiplier: clamp01(
        Math.hypot(modifiers.wind.x, modifiers.wind.y, modifiers.wind.z) / MAX_WIND_SPEED,
      ),
      visibilityMultiplier: modifiers.visibility,
    };
  }

  private gameplayWind(
    modifiers: WeatherModifiers,
  ): { directionX: number; directionZ: number; strength: number } {
    if (this.builtInMode) {
      const strength = this.phase === 'telegraph'
        ? this.monsoonWindStrength * 0.55
        : this.phase === 'active'
          ? this.monsoonWindStrength
          : 0;
      return { directionX: this.windDirectionX, directionZ: this.windDirectionZ, strength };
    }
    const horizontalLength = Math.hypot(modifiers.wind.x, modifiers.wind.z);
    if (horizontalLength <= EPSILON) {
      return { directionX: this.windDirectionX, directionZ: this.windDirectionZ, strength: 0 };
    }
    return {
      directionX: modifiers.wind.x / horizontalLength,
      directionZ: modifiers.wind.z / horizontalLength,
      strength: clamp01(horizontalLength / MAX_WIND_SPEED),
    };
  }

  private normalizedSeverity(progress: number): number {
    if (this.phase === 'clear') return 0;
    if (this.phase === 'telegraph') return this.builtInMode
      ? smoothstep01(progress) * TELEGRAPH_EFFECT_FRACTION
      : TELEGRAPH_EFFECT_FRACTION;
    if (this.phase === 'active') return 1;
    return this.builtInMode
      ? TELEGRAPH_EFFECT_FRACTION * (1 - smoothstep01(progress))
      : 1 - progress;
  }

  private playerFacingLabel(
    entry: NormalizedWeatherEntry | undefined,
    secondsRemaining: number,
  ): string {
    if (!this.builtInMode) return this.eventLabel(entry);
    if (this.phase === 'clear') return 'CLEAR CONDITIONS';
    if (this.phase === 'telegraph') {
      return `MONSOON WARNING · ${Math.max(1, Math.ceil(secondsRemaining))}S`;
    }
    if (this.phase === 'active') return 'MONSOON ACTIVE';
    return 'WEATHER CLEARING';
  }

  private refreshCycleWind(): void {
    const angle = hashedUnit(this.seed, this.cycleIndex, 0x51ed270b) * TWO_PI;
    this.windDirectionX = Math.cos(angle);
    this.windDirectionZ = Math.sin(angle);
    this.monsoonWindStrength = 0.62 + hashedUnit(this.seed, this.cycleIndex, 0x68bc21eb) * 0.16;
  }

  private eventLabel(entry: NormalizedWeatherEntry | undefined): string {
    if (!entry || this.phase === 'clear') return 'Clear skies';
    if (this.phase === 'telegraph') return `${entry.label} incoming`;
    if (this.phase === 'active') return `${entry.label} active`;
    return `${entry.label} clearing`;
  }
}
