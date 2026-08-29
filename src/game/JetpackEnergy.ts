export type JetpackEnergyTuning = {
  /** Seconds of uninterrupted thrust available from a full charge. */
  burnSeconds: number;
  /** Recovery delay after the most recent thrust. */
  rechargeDelaySeconds: number;
  /** Time needed to refill an empty pack after the delay. */
  rechargeSeconds: number;
  /** Charge required before a fully depleted pack may ignite again. */
  restartCharge: number;
};

export type JetpackEnergyPhase =
  | 'ready'
  | 'burning'
  | 'cooldown'
  | 'recharging'
  | 'depleted';

export type JetpackEnergySnapshot = {
  /** Normalized charge in the inclusive 0–1 range. */
  charge: number;
  active: boolean;
  locked: boolean;
  phase: JetpackEnergyPhase;
  rechargeDelayRemaining: number;
  /** Recovery time needed before a depleted pack can restart. */
  restartInSeconds: number;
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export class JetpackEnergy {
  private charge = 1;
  private rechargeDelayRemaining = 0;
  private active = false;
  private locked = false;

  constructor(private readonly tuning: JetpackEnergyTuning) {
    if (
      !Number.isFinite(tuning.burnSeconds)
      || tuning.burnSeconds <= 0
      || !Number.isFinite(tuning.rechargeDelaySeconds)
      || tuning.rechargeDelaySeconds < 0
      || !Number.isFinite(tuning.rechargeSeconds)
      || tuning.rechargeSeconds <= 0
      || !Number.isFinite(tuning.restartCharge)
      || tuning.restartCharge <= 0
      || tuning.restartCharge > 1
    ) {
      throw new RangeError('Jetpack energy tuning must use finite positive durations and a 0–1 restart charge.');
    }
  }

  update(delta: number, wantsThrust: boolean, grounded: boolean): JetpackEnergySnapshot {
    const safeDelta = Number.isFinite(delta) ? Math.max(0, delta) : 0;
    this.active = false;

    if (wantsThrust && !grounded && !this.locked && this.charge > 0) {
      this.active = true;
      this.charge = clamp01(this.charge - safeDelta / this.tuning.burnSeconds);
      this.rechargeDelayRemaining = this.tuning.rechargeDelaySeconds;
      if (this.charge <= 0) {
        this.charge = 0;
        this.active = false;
        this.locked = true;
      }
      return this.snapshot();
    }

    // Releasing thrust always recovers energy, including while airborne or
    // falling. Holding thrust on an empty pack does not recover it, so players
    // must coast between burns and cannot sustain permanent flight.
    if (!wantsThrust && this.charge < 1) {
      let rechargeDelta = safeDelta;
      if (this.rechargeDelayRemaining > 0) {
        const cooldownDelta = Math.min(this.rechargeDelayRemaining, rechargeDelta);
        this.rechargeDelayRemaining -= cooldownDelta;
        rechargeDelta -= cooldownDelta;
      }
      if (rechargeDelta > 0) {
        this.charge = clamp01(this.charge + rechargeDelta / this.tuning.rechargeSeconds);
        if (this.locked && this.charge >= this.tuning.restartCharge) this.locked = false;
      }
    }

    if (this.charge >= 1) {
      this.charge = 1;
      this.rechargeDelayRemaining = 0;
      this.locked = false;
    }
    return this.snapshot();
  }

  reset(): JetpackEnergySnapshot {
    this.charge = 1;
    this.rechargeDelayRemaining = 0;
    this.active = false;
    this.locked = false;
    return this.snapshot();
  }

  snapshot(): JetpackEnergySnapshot {
    const restartChargeNeeded = this.locked
      ? Math.max(0, this.tuning.restartCharge - this.charge)
      : 0;
    return {
      charge: this.charge,
      active: this.active,
      locked: this.locked,
      phase: this.phase(),
      rechargeDelayRemaining: this.rechargeDelayRemaining,
      restartInSeconds: this.locked
        ? this.rechargeDelayRemaining + restartChargeNeeded * this.tuning.rechargeSeconds
        : 0,
    };
  }

  private phase(): JetpackEnergyPhase {
    if (this.active) return 'burning';
    if (this.charge >= 1) return 'ready';
    if (this.locked && this.rechargeDelayRemaining > 0) return 'depleted';
    if (this.rechargeDelayRemaining > 0) return 'cooldown';
    return 'recharging';
  }
}
