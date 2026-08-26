export type StyleEventType =
  | 'air-frag'
  | 'high-speed-elimination'
  | 'long-range-elimination'
  | 'grapple-elimination'
  | 'core-denial'
  | 'multikill';

export type StyleMedalTier = 'bronze' | 'silver' | 'gold' | 'platinum';

export type StyleEvent =
  | { readonly type: 'air-frag' }
  | { readonly type: 'high-speed-elimination'; readonly speedMetersPerSecond: number }
  | { readonly type: 'long-range-elimination'; readonly distanceMeters: number }
  | { readonly type: 'grapple-elimination' }
  | { readonly type: 'core-denial' }
  | { readonly type: 'multikill'; readonly killCount: number };

export interface StyleMedal {
  readonly event: StyleEventType;
  readonly label: string;
  readonly tier: StyleMedalTier;
}

export type StyleEventRejection = 'cooldown' | 'below-threshold' | 'invalid-event';

export interface StyleEventResult {
  readonly accepted: boolean;
  readonly event: StyleEventType;
  readonly rejection: StyleEventRejection | null;
  readonly baseStyle: number;
  readonly styleGain: number;
  readonly comboCount: number;
  readonly comboMultiplier: number;
  readonly meter: number;
  readonly medal: StyleMedal | null;
}

export interface StyleSnapshot {
  readonly meter: number;
  readonly comboCount: number;
  readonly comboMultiplier: number;
  readonly comboRemainingSeconds: number;
  readonly decayGraceRemainingSeconds: number;
  readonly cooldowns: Readonly<Record<StyleEventType, number>>;
  readonly lastMedal: StyleMedal | null;
}

const EVENT_COOLDOWNS = Object.freeze({
  'air-frag': 0.75,
  'high-speed-elimination': 1,
  'long-range-elimination': 1,
  'grapple-elimination': 1.25,
  'core-denial': 2,
  multikill: 2.5,
} satisfies Record<StyleEventType, number>);

/**
 * Conservative values keep medals expressive without turning style into match
 * score. The meter is presentation/progression state only; integration must not
 * add it to the arena score.
 */
export const STYLE_CONSTANTS = Object.freeze({
  meterMaximum: 100,
  comboWindowSeconds: 5,
  comboStep: 0.25,
  comboMultiplierMaximum: 2.5,
  decayGraceSeconds: 3,
  decayPerSecond: 8,
  highSpeedThresholdMetersPerSecond: 24,
  longRangeThresholdMeters: 35,
  maximumUpdateSeconds: 60,
  eventCooldowns: EVENT_COOLDOWNS,
});

interface StyleDescriptor {
  readonly baseStyle: number;
  readonly medal: StyleMedal;
}

interface StyleEvaluation {
  readonly descriptor: StyleDescriptor | null;
  readonly rejection: Exclude<StyleEventRejection, 'cooldown'> | null;
}

const STYLE_EVENT_TYPES: readonly StyleEventType[] = [
  'air-frag',
  'high-speed-elimination',
  'long-range-elimination',
  'grapple-elimination',
  'core-denial',
  'multikill',
];

const createCooldownState = (): Record<StyleEventType, number> => ({
  'air-frag': 0,
  'high-speed-elimination': 0,
  'long-range-elimination': 0,
  'grapple-elimination': 0,
  'core-denial': 0,
  multikill: 0,
});

const roundForSnapshot = (value: number): number => Math.round(value * 1_000) / 1_000;

const makeMedal = (event: StyleEventType, label: string, tier: StyleMedalTier): StyleMedal => Object.freeze({
  event,
  label,
  tier,
});

const evaluateEvent = (event: StyleEvent): StyleEvaluation => {
  switch (event.type) {
    case 'air-frag':
      return {
        descriptor: { baseStyle: 12, medal: makeMedal(event.type, 'AIRBORNE', 'bronze') },
        rejection: null,
      };
    case 'high-speed-elimination':
      if (!Number.isFinite(event.speedMetersPerSecond)) return { descriptor: null, rejection: 'invalid-event' };
      if (event.speedMetersPerSecond < STYLE_CONSTANTS.highSpeedThresholdMetersPerSecond) {
        return { descriptor: null, rejection: 'below-threshold' };
      }
      return {
        descriptor: { baseStyle: 14, medal: makeMedal(event.type, 'VELOCITY KILL', 'silver') },
        rejection: null,
      };
    case 'long-range-elimination':
      if (!Number.isFinite(event.distanceMeters)) return { descriptor: null, rejection: 'invalid-event' };
      if (event.distanceMeters < STYLE_CONSTANTS.longRangeThresholdMeters) {
        return { descriptor: null, rejection: 'below-threshold' };
      }
      return {
        descriptor: { baseStyle: 12, medal: makeMedal(event.type, 'LONGSHOT', 'silver') },
        rejection: null,
      };
    case 'grapple-elimination':
      return {
        descriptor: { baseStyle: 16, medal: makeMedal(event.type, 'HOOKED', 'gold') },
        rejection: null,
      };
    case 'core-denial':
      return {
        descriptor: { baseStyle: 10, medal: makeMedal(event.type, 'CORE DENIED', 'silver') },
        rejection: null,
      };
    case 'multikill': {
      if (!Number.isInteger(event.killCount) || !Number.isFinite(event.killCount)) {
        return { descriptor: null, rejection: 'invalid-event' };
      }
      if (event.killCount < 2) return { descriptor: null, rejection: 'below-threshold' };
      const cappedKills = Math.min(event.killCount, 5);
      const baseStyle = 14 + (cappedKills - 2) * 4;
      if (event.killCount === 2) {
        return { descriptor: { baseStyle, medal: makeMedal(event.type, 'DOUBLE KILL', 'silver') }, rejection: null };
      }
      if (event.killCount === 3) {
        return { descriptor: { baseStyle, medal: makeMedal(event.type, 'TRIPLE KILL', 'gold') }, rejection: null };
      }
      return { descriptor: { baseStyle, medal: makeMedal(event.type, 'MULTI KILL', 'platinum') }, rejection: null };
    }
  }
};

export class StyleSystem {
  private meter = 0;
  private comboCount = 0;
  private comboRemainingSeconds = 0;
  private decayGraceRemainingSeconds = 0;
  private cooldowns = createCooldownState();
  private lastMedal: StyleMedal | null = null;

  register(event: StyleEvent): StyleEventResult {
    const evaluation = evaluateEvent(event);
    if (!evaluation.descriptor) return this.rejectedResult(event.type, evaluation.rejection ?? 'invalid-event');
    if (this.cooldowns[event.type] > 0) return this.rejectedResult(event.type, 'cooldown');

    this.comboCount = this.comboRemainingSeconds > 0 ? this.comboCount + 1 : 1;
    this.comboRemainingSeconds = STYLE_CONSTANTS.comboWindowSeconds;
    this.decayGraceRemainingSeconds = STYLE_CONSTANTS.decayGraceSeconds;
    this.cooldowns[event.type] = STYLE_CONSTANTS.eventCooldowns[event.type];

    const comboMultiplier = this.getComboMultiplier();
    const availableMeter = STYLE_CONSTANTS.meterMaximum - this.meter;
    const styleGain = Math.min(availableMeter, evaluation.descriptor.baseStyle * comboMultiplier);
    this.meter = Math.min(STYLE_CONSTANTS.meterMaximum, this.meter + styleGain);
    this.lastMedal = evaluation.descriptor.medal;

    return Object.freeze({
      accepted: true,
      event: event.type,
      rejection: null,
      baseStyle: evaluation.descriptor.baseStyle,
      styleGain: roundForSnapshot(styleGain),
      comboCount: this.comboCount,
      comboMultiplier,
      meter: roundForSnapshot(this.meter),
      medal: this.lastMedal,
    });
  }

  update(deltaSeconds: number): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    const safeDelta = Math.min(deltaSeconds, STYLE_CONSTANTS.maximumUpdateSeconds);

    for (const eventType of STYLE_EVENT_TYPES) {
      this.cooldowns[eventType] = Math.max(0, this.cooldowns[eventType] - safeDelta);
    }

    if (this.comboRemainingSeconds > 0) {
      this.comboRemainingSeconds = Math.max(0, this.comboRemainingSeconds - safeDelta);
      if (this.comboRemainingSeconds === 0) this.comboCount = 0;
    }

    const graceConsumed = Math.min(this.decayGraceRemainingSeconds, safeDelta);
    this.decayGraceRemainingSeconds -= graceConsumed;
    const decaySeconds = safeDelta - graceConsumed;
    if (decaySeconds > 0 && this.meter > 0) {
      this.meter = Math.max(0, this.meter - STYLE_CONSTANTS.decayPerSecond * decaySeconds);
    }
  }

  snapshot(): Readonly<StyleSnapshot> {
    const cooldowns = Object.freeze(Object.fromEntries(
      STYLE_EVENT_TYPES.map((eventType) => [eventType, roundForSnapshot(this.cooldowns[eventType])]),
    ) as Record<StyleEventType, number>);
    const lastMedal = this.lastMedal ? makeMedal(this.lastMedal.event, this.lastMedal.label, this.lastMedal.tier) : null;
    return Object.freeze({
      meter: roundForSnapshot(this.meter),
      comboCount: this.comboCount,
      comboMultiplier: this.getComboMultiplier(),
      comboRemainingSeconds: roundForSnapshot(this.comboRemainingSeconds),
      decayGraceRemainingSeconds: roundForSnapshot(this.decayGraceRemainingSeconds),
      cooldowns,
      lastMedal,
    });
  }

  reset(): void {
    this.meter = 0;
    this.comboCount = 0;
    this.comboRemainingSeconds = 0;
    this.decayGraceRemainingSeconds = 0;
    this.cooldowns = createCooldownState();
    this.lastMedal = null;
  }

  private getComboMultiplier(): number {
    if (this.comboCount <= 1) return 1;
    return Math.min(
      STYLE_CONSTANTS.comboMultiplierMaximum,
      1 + (this.comboCount - 1) * STYLE_CONSTANTS.comboStep,
    );
  }

  private rejectedResult(event: StyleEventType, rejection: StyleEventRejection): StyleEventResult {
    return Object.freeze({
      accepted: false,
      event,
      rejection,
      baseStyle: 0,
      styleGain: 0,
      comboCount: this.comboCount,
      comboMultiplier: this.getComboMultiplier(),
      meter: roundForSnapshot(this.meter),
      medal: null,
    });
  }
}
