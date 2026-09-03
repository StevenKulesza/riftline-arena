const CADENCE_SAMPLE_SIZE = 60;

export const workStrideForRefreshRate = (refreshHz: number): number => (
  Number.isFinite(refreshHz) && refreshHz >= 96
    ? Math.max(2, Math.round(refreshHz / 60))
    : 1
);

export class Loop {
  private frameId = 0;
  private frame = 0;
  private animationFrame = 0;
  private lastTime = 0;
  private lastAnimationTime = 0;
  private cadenceSampleCount = 0;
  private cadenceIntervalTotal = 0;
  private workStride = 1;
  private running = false;
  private readonly timing = {
    frame: 0,
    renderedAtMs: 0,
    frameIntervalMs: 0,
    refreshHz: 0,
    workStride: 1,
    updateMs: 0,
    renderMs: 0,
    totalMs: 0,
    worstFrame: null as {
      frame: number;
      updateMs: number;
      renderMs: number;
      totalMs: number;
    } | null,
    slowFrames: [] as Array<{
      frame: number;
      updateMs: number;
      renderMs: number;
      totalMs: number;
    }>,
  };

  constructor(
    private readonly update: (deltaSeconds: number, elapsedSeconds: number) => void,
    private readonly render: () => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.lastAnimationTime = this.lastTime;
    window.__THREE_FRAME_TIMING__ = this.timing;
    this.frameId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frameId);
  }

  private readonly tick = (time: number) => {
    if (!this.running) return;
    const animationInterval = time - this.lastAnimationTime;
    this.lastAnimationTime = time;
    this.animationFrame += 1;
    // A 120/144/165/240 Hz panel should not multiply the arena animation,
    // physics orchestration, post stack, and GPU submissions by its native
    // refresh rate. Sample a full rolling window: the first handful of browser
    // callbacks can arrive at a temporary double cadence while the tab is
    // being presented, and permanently treating a 60 Hz display as 120 Hz
    // cuts live play to 30 FPS.
    if (animationInterval >= 2 && animationInterval <= 20) {
      this.cadenceIntervalTotal += animationInterval;
      this.cadenceSampleCount += 1;
      if (this.cadenceSampleCount === CADENCE_SAMPLE_SIZE) {
        const refreshHz = 1_000 / (this.cadenceIntervalTotal / this.cadenceSampleCount);
        this.timing.refreshHz = refreshHz;
        this.workStride = workStrideForRefreshRate(refreshHz);
        this.timing.workStride = this.workStride;
        this.cadenceSampleCount = 0;
        this.cadenceIntervalTotal = 0;
      }
    }
    if (this.workStride > 1 && this.animationFrame % this.workStride !== 0) {
      this.frameId = requestAnimationFrame(this.tick);
      return;
    }
    const frameStartedAt = performance.now();
    const frameIntervalMs = time - this.lastTime;
    const deltaSeconds = Math.min(frameIntervalMs / 1000, 0.05);
    this.lastTime = time;
    this.update(deltaSeconds, time / 1000);
    const updateFinishedAt = performance.now();
    this.render();
    const renderFinishedAt = performance.now();
    this.frame += 1;
    this.timing.frame = this.frame;
    this.timing.frameIntervalMs = frameIntervalMs;
    this.timing.renderedAtMs = time;
    this.timing.updateMs = updateFinishedAt - frameStartedAt;
    this.timing.renderMs = renderFinishedAt - updateFinishedAt;
    this.timing.totalMs = renderFinishedAt - frameStartedAt;
    if (!this.timing.worstFrame || this.timing.totalMs > this.timing.worstFrame.totalMs) {
      this.timing.worstFrame = {
        frame: this.frame,
        updateMs: this.timing.updateMs,
        renderMs: this.timing.renderMs,
        totalMs: this.timing.totalMs,
      };
    }
    if (this.timing.totalMs > 25) {
      this.timing.slowFrames.push({
        frame: this.frame,
        updateMs: this.timing.updateMs,
        renderMs: this.timing.renderMs,
        totalMs: this.timing.totalMs,
      });
      if (this.timing.slowFrames.length > 128) this.timing.slowFrames.shift();
    }
    this.frameId = requestAnimationFrame(this.tick);
  };
}
