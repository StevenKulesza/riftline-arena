import { expect, test } from '@playwright/test';

type FrameMetrics = {
  frames: number;
  fps: number;
  onePercentLowFps: number;
  frameTimeMs: {
    mean: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
    slowestOnePercentMean: number;
  };
  longFrames: Record<string, {
    thresholdMs: number;
    count: number;
    percent: number;
    ratePerSecond: number;
  }>;
};

type RendererCounters = {
  calls: number | null;
  triangles: number | null;
  geometries: number | null;
  textures: number | null;
  activeWeaponVfx: number | null;
  activeSurfaceMarks: number | null;
  activeTracers: number | null;
  canvas: {
    clientWidth: number | null;
    clientHeight: number | null;
    renderWidth: number | null;
    renderHeight: number | null;
    dpr: number | null;
    megapixels: number | null;
  };
};

async function loadHarness(): Promise<{
  computeFrameMetrics: (deltas: number[]) => FrameMetrics;
  computeRenderedFrameMetrics: (samples: Array<{ frame: number; renderedAtMs: number }>) => FrameMetrics;
  summarizeRendererCounters: (diagnostics: unknown) => RendererCounters;
}> {
  const harnessUrl = new URL('../scripts/profile-performance.mjs', import.meta.url).href;
  return import(harnessUrl) as Promise<{
    computeFrameMetrics: (deltas: number[]) => FrameMetrics;
    computeRenderedFrameMetrics: (samples: Array<{ frame: number; renderedAtMs: number }>) => FrameMetrics;
    summarizeRendererCounters: (diagnostics: unknown) => RendererCounters;
  }>;
}

test('frame contract reports 1% low FPS and long-frame tail rates', async () => {
  const { computeFrameMetrics } = await loadHarness();
  const deltas = Array.from({ length: 99 }, () => 10).concat(110);
  const metrics = computeFrameMetrics(deltas);

  expect(metrics.frames).toBe(100);
  expect(metrics.fps).toBeCloseTo(90.91, 2);
  expect(metrics.onePercentLowFps).toBeCloseTo(9.09, 2);
  expect(metrics.frameTimeMs).toMatchObject({
    mean: 11,
    p50: 10,
    p95: 10,
    p99: 110,
    max: 110,
    slowestOnePercentMean: 110,
  });
  expect(metrics.longFrames.over16_7ms).toMatchObject({ count: 1, percent: 1 });
  expect(metrics.longFrames.over33_3ms).toMatchObject({ count: 1, percent: 1 });
  expect(metrics.longFrames.over50ms).toMatchObject({ count: 1, percent: 1 });
  expect(metrics.longFrames.over100ms).toMatchObject({ count: 1, percent: 1 });
  expect(metrics.longFrames.over100ms.ratePerSecond).toBeCloseTo(0.91, 2);
});

test('1% low averages the full slowest percentile for larger captures', async () => {
  const { computeFrameMetrics } = await loadHarness();
  const deltas = Array.from({ length: 998 }, () => 8).concat([40, 120]);
  const metrics = computeFrameMetrics(deltas);

  // The slowest 1% is ten frames: eight 8 ms samples plus the two stalls.
  expect(metrics.frameTimeMs.slowestOnePercentMean).toBeCloseTo(22.4, 5);
  expect(metrics.onePercentLowFps).toBeCloseTo(44.64, 2);
  expect(metrics.frameTimeMs.max).toBe(120);
});

test('strict FPS counts actual renders instead of skipped high-refresh callbacks', async () => {
  const { computeRenderedFrameMetrics } = await loadHarness();
  const samples = Array.from({ length: 201 }, (_, callback) => ({
    frame: Math.floor(callback / 2),
    renderedAtMs: Math.floor(callback / 2) * 20,
  }));
  const metrics = computeRenderedFrameMetrics(samples);
  expect(metrics.frames).toBe(100);
  expect(metrics.fps).toBe(50);
  expect(metrics.onePercentLowFps).toBe(50);
});

test('strict rendered-frame metrics retain all stalls and reject missing instrumentation', async () => {
  const { computeRenderedFrameMetrics } = await loadHarness();
  const samples = Array.from({ length: 100 }, (_, frame) => ({ frame, renderedAtMs: frame * 10 }));
  samples.push({ frame: 100, renderedAtMs: 1_100 });
  expect(computeRenderedFrameMetrics(samples).onePercentLowFps).toBeCloseTo(1_000 / 110);
  expect(() => computeRenderedFrameMetrics([])).toThrow('At least one positive finite frame delta');
});

test('renderer summary exposes stable draw, resource, VFX, and canvas counters', async () => {
  const { summarizeRendererCounters } = await loadHarness();
  const counters = summarizeRendererCounters({
    renderer: {
      calls: 420,
      triangles: 854_267,
      geometries: 368,
      textures: 93,
      activeWeaponVfx: 4,
      activeSurfaceMarks: 24,
      activeTracers: 2,
    },
    canvas: {
      clientWidth: 1280,
      clientHeight: 720,
      width: 1600,
      height: 900,
      dpr: 1.25,
    },
  });

  expect(counters).toEqual({
    calls: 420,
    triangles: 854_267,
    geometries: 368,
    textures: 93,
    activeWeaponVfx: 4,
    activeSurfaceMarks: 24,
    activeTracers: 2,
    canvas: {
      clientWidth: 1280,
      clientHeight: 720,
      renderWidth: 1600,
      renderHeight: 900,
      dpr: 1.25,
      megapixels: 1.44,
    },
  });
});
