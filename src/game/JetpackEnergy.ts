export type JetpackEnergyTuning = {
  /** Seconds of uninterrupted thrust available from a full charge. */
  burnSeconds: number;
  /** Grounded recovery delay after the most recent thrust. */
  rechargeDelaySeconds: number;
  /** Grounded time needed to refill an empty pack after the delay. */
  rechargeSeconds: number;
  /** Charge required before a fully depleted pack may ignite again. */
  restartCharge: number;
};

export type JetpackEnergyPhase =
  | 'ready'
  | 'burning'
  | 'available'
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
  /** Grounded recovery time needed before a depleted pack can restart. */
  restartInSeconds: number;
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export class JetpackEnergy {
  private charge = 1;
  private rechargeDelayRemaining = 0;
  private active = false;
  private locked = false;
  private grounded = true;

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
    this.grounded = grounded;
    this.active = false;

    if (wantsThrust && !grounded && !this.locked && this.charge > 0) {
      this.active = true;
      this.charge = clamp01(this.charge - safeDelta / this.tuning.burnSeconds);
      this.rechargeDelayRemaining = this.tuning.rechargeDelaySeconds;
      if (this.charge <= 0) {
        this.charge = 0;
        this.locked = true;
      }
      return this.snapshot();
    }

    // Recovery is deliberately grounded-only. Airborne feathering can conserve
    // the remaining charge, but it can never create permanent flight.
    if (grounded && this.charge < 1) {
      if (this.rechargeDelayRemaining > 0) {
        this.rechargeDelayRemaining = Math.max(0, this.rechargeDelayRemaining - safeDelta);
      } else {
        this.charge = clamp01(this.charge + safeDelta / this.tuning.rechargeSeconds);
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
    this.grounded = true;
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
    if (!this.grounded) return this.locked ? 'depleted' : 'available';
    if (this.rechargeDelayRemaining > 0) return 'cooldown';
    return 'recharging';
  }
}
