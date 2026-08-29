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
    // refresh rate. Measure only the first stable callbacks, then select an
    // integer cadence near 60 Hz. Ninety-Hz and ordinary 60-Hz displays keep
    // every callback to avoid uneven 45-Hz presentation.
    if (this.cadenceSampleCount < 12 && animationInterval >= 2 && animationInterval <= 12) {
      this.cadenceIntervalTotal += animationInterval;
      this.cadenceSampleCount += 1;
      if (this.cadenceSampleCount === 12) {
        const refreshHz = 1_000 / (this.cadenceIntervalTotal / this.cadenceSampleCount);
        this.timing.refreshHz = refreshHz;
        // A 120 Hz panel can measure near 100 Hz while the compositor is busy
        // during startup. The old 105 Hz cutoff then misclassified the same
        // display from run to run and occasionally submitted the full arena on
        // every callback. Keep genuine 90 Hz panels on stride 1, but absorb
        // realistic startup jitter around the high-refresh boundary.
        if (refreshHz >= 96) this.workStride = Math.max(2, Math.round(refreshHz / 60));
        this.timing.workStride = this.workStride;
      }
    }
    if (this.workStride > 1 && this.animationFrame % this.workStride !== 0) {
      this.frameId = requestAnimationFrame(this.tick);
      return;
    }
    const frameStartedAt = performance.now();
    const deltaSeconds = Math.min((time - this.lastTime) / 1000, 0.05);
    this.lastTime = time;
    this.update(deltaSeconds, time / 1000);
    const updateFinishedAt = performance.now();
    this.render();
    const renderFinishedAt = performance.now();
    this.frame += 1;
    this.timing.frame = this.frame;
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
