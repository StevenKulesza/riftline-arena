export type AdaptiveQualityReason = 'burst-overload' | 'sustained-overload' | 'recovered-headroom';

export interface AdaptiveQualityOptions {
  minDpr?: number;
  maxDpr?: number;
  targetFrameMs?: number;
  sampleWindowMs?: number;
  dprStep?: number;
  degradeCooldownMs?: number;
  recoverCooldownMs?: number;
  healthyWindowsToRecover?: number;
}

export interface AdaptiveQualityWindow {
  meanFrameMs: number;
  worstFrameMs: number;
  overBudgetRatio: number;
  severeFrameCount: number;
  sampleCount: number;
}

export interface AdaptiveQualityChange {
  previousDprCap: number;
  dprCap: number;
  reason: AdaptiveQualityReason;
  window: AdaptiveQualityWindow;
}

export interface AdaptiveQualitySnapshot {
  dprCap: number;
  minDpr: number;
  maxDpr: number;
  renderScale: number;
  healthyWindows: number;
}

const roundDpr = (value: number): number => Math.round(value * 1_000) / 1_000;
const finiteOption = (value: number | undefined, fallback: number): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

/**
 * Small, allocation-free-per-frame controller for dynamic resolution.
 *
 * Overload reacts after one measured window, while recovery needs several
 * clean windows. That asymmetry prevents resolution reallocations from
 * oscillating during combat bursts, which would create more stalls than it
 * removes. Callers only need to resize render targets when sampleFrame returns
 * a change.
 */
export class AdaptiveQualitySystem {
  private readonly minDpr: number;
  private readonly maxDpr: number;
  private readonly targetFrameMs: number;
  private readonly sampleWindowMs: number;
  private readonly dprStep: number;
  private readonly degradeCooldownMs: number;
  private readonly recoverCooldownMs: number;
  private readonly healthyWindowsToRecover: number;

  private dprCap: number;
  private elapsedMs = 0;
  private lastChangeAtMs = Number.NEGATIVE_INFINITY;
  private windowDurationMs = 0;
  private windowFrameTotalMs = 0;
  private windowWorstFrameMs = 0;
  private windowSamples = 0;
  private windowOverBudgetFrames = 0;
  private windowSevereFrames = 0;
  private healthyWindows = 0;

  constructor(options: AdaptiveQualityOptions = {}) {
    const requestedMax = finiteOption(options.maxDpr, 1.25);
    const requestedMin = finiteOption(options.minDpr, 0.75);
    this.maxDpr = Math.max(0.25, requestedMax);
    this.minDpr = Math.min(this.maxDpr, Math.max(0.25, requestedMin));
    this.targetFrameMs = Math.max(8, finiteOption(options.targetFrameMs, 1_000 / 60));
    this.sampleWindowMs = Math.max(250, finiteOption(options.sampleWindowMs, 1_000));
    this.dprStep = Math.max(0.05, finiteOption(options.dprStep, 0.125));
    this.degradeCooldownMs = Math.max(
      this.sampleWindowMs,
      finiteOption(options.degradeCooldownMs, 1_000),
    );
    this.recoverCooldownMs = Math.max(
      this.sampleWindowMs,
      finiteOption(options.recoverCooldownMs, 4_000),
    );
    this.healthyWindowsToRecover = Math.max(
      2,
      Math.floor(finiteOption(options.healthyWindowsToRecover, 4)),
    );
    this.dprCap = this.maxDpr;
  }

  get currentDprCap(): number {
    return this.dprCap;
  }

  sampleFrame(frameTimeMs: number): AdaptiveQualityChange | null {
    if (!Number.isFinite(frameTimeMs) || frameTimeMs <= 0) return null;

    // Browser scheduling can report multi-second gaps after a hidden tab. The
    // game loop clamps simulation deltas to 50 ms, so cap quality samples at
    // the same boundary rather than treating tab suspension as GPU overload.
    const sampleMs = Math.min(frameTimeMs, 50);
    this.elapsedMs += sampleMs;
    this.windowDurationMs += sampleMs;
    this.windowFrameTotalMs += sampleMs;
    this.windowWorstFrameMs = Math.max(this.windowWorstFrameMs, sampleMs);
    this.windowSamples += 1;
    if (sampleMs > this.targetFrameMs * 1.15) this.windowOverBudgetFrames += 1;
    if (sampleMs > this.targetFrameMs * 2) this.windowSevereFrames += 1;

    if (this.windowDurationMs < this.sampleWindowMs) return null;

    const window = this.finishWindow();
    const sustainedOverload = window.meanFrameMs > this.targetFrameMs * 1.08
      || window.overBudgetRatio >= 0.18;
    const burstOverload = window.severeFrameCount >= 2;
    const canDegrade = this.dprCap > this.minDpr
      && this.elapsedMs - this.lastChangeAtMs >= this.degradeCooldownMs;

    if (canDegrade && (sustainedOverload || burstOverload)) {
      this.healthyWindows = 0;
      return this.changeDpr(
        Math.max(this.minDpr, this.dprCap - this.dprStep),
        burstOverload ? 'burst-overload' : 'sustained-overload',
        window,
      );
    }

    const hasHeadroom = window.meanFrameMs < this.targetFrameMs * 0.78
      && window.overBudgetRatio <= 0.02
      && window.severeFrameCount === 0;
    this.healthyWindows = hasHeadroom ? this.healthyWindows + 1 : 0;
    const canRecover = this.dprCap < this.maxDpr
      && this.healthyWindows >= this.healthyWindowsToRecover
      && this.elapsedMs - this.lastChangeAtMs >= this.recoverCooldownMs;

    if (canRecover) {
      this.healthyWindows = 0;
      return this.changeDpr(
        Math.min(this.maxDpr, this.dprCap + this.dprStep),
        'recovered-headroom',
        window,
      );
    }

    return null;
  }

  snapshot(): AdaptiveQualitySnapshot {
    return {
      dprCap: this.dprCap,
      minDpr: this.minDpr,
      maxDpr: this.maxDpr,
      renderScale: this.dprCap / this.maxDpr,
      healthyWindows: this.healthyWindows,
    };
  }

  reset(dprCap = this.maxDpr): void {
    this.dprCap = roundDpr(Math.min(this.maxDpr, Math.max(this.minDpr, dprCap)));
    this.elapsedMs = 0;
    this.lastChangeAtMs = Number.NEGATIVE_INFINITY;
    this.healthyWindows = 0;
    this.clearWindow();
  }

  private finishWindow(): AdaptiveQualityWindow {
    const window = {
      meanFrameMs: this.windowFrameTotalMs / this.windowSamples,
      worstFrameMs: this.windowWorstFrameMs,
      overBudgetRatio: this.windowOverBudgetFrames / this.windowSamples,
      severeFrameCount: this.windowSevereFrames,
      sampleCount: this.windowSamples,
    };
    this.clearWindow();
    return window;
  }

  private clearWindow(): void {
    this.windowDurationMs = 0;
    this.windowFrameTotalMs = 0;
    this.windowWorstFrameMs = 0;
    this.windowSamples = 0;
    this.windowOverBudgetFrames = 0;
    this.windowSevereFrames = 0;
  }

  private changeDpr(
    nextDprCap: number,
    reason: AdaptiveQualityReason,
    window: AdaptiveQualityWindow,
  ): AdaptiveQualityChange {
    const previousDprCap = this.dprCap;
    this.dprCap = roundDpr(nextDprCap);
    this.lastChangeAtMs = this.elapsedMs;
    return { previousDprCap, dprCap: this.dprCap, reason, window };
  }
}
