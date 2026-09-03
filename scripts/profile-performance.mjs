import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { preview } from 'vite';

export const LONG_FRAME_THRESHOLDS = Object.freeze([
  Object.freeze({ key: 'over16_7ms', thresholdMs: 1_000 / 60 }),
  Object.freeze({ key: 'over33_3ms', thresholdMs: 1_000 / 30 }),
  Object.freeze({ key: 'over50ms', thresholdMs: 50 }),
  Object.freeze({ key: 'over100ms', thresholdMs: 100 }),
]);

function finiteFrameTimes(deltas) {
  if (!Array.isArray(deltas)) throw new TypeError('Frame deltas must be an array.');
  const samples = deltas.filter((value) => Number.isFinite(value) && value > 0);
  if (!samples.length) throw new Error('At least one positive finite frame delta is required.');
  return samples;
}

/**
 * Computes stable frame pacing metrics from requestAnimationFrame deltas.
 * 1% low FPS is the reciprocal of the mean of the slowest 1% of frames, not
 * simply 1000 / p99, so isolated stalls remain visible in short captures.
 */
export function computeFrameMetrics(deltas) {
  const samples = finiteFrameTimes(deltas);
  const totalMs = samples.reduce((sum, value) => sum + value, 0);
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (amount) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * amount))];
  const slowestOnePercentCount = Math.max(1, Math.ceil(sorted.length * 0.01));
  const slowestOnePercent = sorted.slice(-slowestOnePercentCount);
  const slowestOnePercentMeanMs = slowestOnePercent.reduce((sum, value) => sum + value, 0)
    / slowestOnePercent.length;
  const durationSeconds = totalMs / 1_000;
  const longFrames = Object.fromEntries(LONG_FRAME_THRESHOLDS.map(({ key, thresholdMs }) => {
    const count = samples.reduce((total, value) => total + Number(value > thresholdMs), 0);
    return [key, {
      thresholdMs,
      count,
      percent: (count / samples.length) * 100,
      ratePerSecond: count / durationSeconds,
    }];
  }));

  return {
    frames: samples.length,
    fps: samples.length / durationSeconds,
    onePercentLowFps: 1_000 / slowestOnePercentMeanMs,
    frameTimeMs: {
      mean: totalMs / samples.length,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: sorted.at(-1),
      slowestOnePercentMean: slowestOnePercentMeanMs,
    },
    longFrames,
  };
}

function finiteCounter(value) {
  return Number.isFinite(value) ? value : null;
}

/** Pulls the high-signal renderer counters out of the full game diagnostics. */
export function summarizeRendererCounters(diagnostics) {
  const renderer = diagnostics?.renderer ?? {};
  const canvas = diagnostics?.canvas ?? {};
  const renderWidth = finiteCounter(canvas.width);
  const renderHeight = finiteCounter(canvas.height);
  return {
    calls: finiteCounter(renderer.calls),
    triangles: finiteCounter(renderer.triangles),
    geometries: finiteCounter(renderer.geometries),
    textures: finiteCounter(renderer.textures),
    activeWeaponVfx: finiteCounter(renderer.activeWeaponVfx),
    activeSurfaceMarks: finiteCounter(renderer.activeSurfaceMarks),
    activeTracers: finiteCounter(renderer.activeTracers),
    canvas: {
      clientWidth: finiteCounter(canvas.clientWidth),
      clientHeight: finiteCounter(canvas.clientHeight),
      renderWidth,
      renderHeight,
      dpr: finiteCounter(canvas.dpr),
      megapixels: renderWidth !== null && renderHeight !== null
        ? (renderWidth * renderHeight) / 1_000_000
        : null,
    },
  };
}

function parseArgs(argv) {
  const result = {
    duration: 10_000,
    warmup: 3_000,
    state: 'active-play',
    target: 35,
    label: 'profile',
    url: null,
    mobile: false,
    unbatched: false,
    freeze: false,
    speedKmh: 0,
    fireWeapon: null,
    preloadAudio: false,
    combat: false,
    fly: false,
    map: null,
    seed: 450_600,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--duration') result.duration = Number(argv[++index]);
    else if (value === '--warmup') result.warmup = Number(argv[++index]);
    else if (value === '--state') result.state = argv[++index];
    else if (value === '--target') result.target = Number(argv[++index]);
    else if (value === '--label') result.label = argv[++index];
    else if (value === '--url') result.url = argv[++index];
    else if (value === '--mobile') result.mobile = true;
    else if (value === '--unbatched') result.unbatched = true;
    else if (value === '--freeze') result.freeze = true;
    else if (value === '--speed-kmh') result.speedKmh = Number(argv[++index]);
    else if (value === '--fire-weapon') result.fireWeapon = argv[++index];
    else if (value === '--preload-audio') result.preloadAudio = true;
    else if (value === '--combat') result.combat = true;
    else if (value === '--fly') result.fly = true;
    else if (value === '--map') result.map = argv[++index];
    else if (value === '--seed') result.seed = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}

export async function runProfile(argv = process.argv) {
  const args = parseArgs(argv);
  const outputDirectory = new URL('../artifacts/performance/', import.meta.url);
  await mkdir(outputDirectory, { recursive: true });

  let previewServer;
  const port = 5230;
  const url = args.url ?? `http://127.0.0.1:${port}/`;
  const profileUrl = new URL(url);
  if (args.unbatched) profileUrl.searchParams.set('perf-unbatched', '1');
  if (args.map) profileUrl.searchParams.set('map', args.map);
  profileUrl.searchParams.set('mapSeed', String(args.seed));
  if (!args.url) {
    previewServer = await preview({ preview: { host: '127.0.0.1', port, strictPort: true } });
  }

  let browser;
  try {
  // Headed Chromium is intentional: the headless shell selects SwiftShader on
  // many Linux hosts, producing CPU-rendered frame times that cannot validate
  // a real GPU target. AutomationControlled is disabled so the game selects
  // its normal production renderer path instead of the diagnostic fallback.
  browser = await chromium.launch({
    channel: 'chromium',
    headless: false,
    args: [
      '--ozone-platform=wayland',
      '--disable-blink-features=AutomationControlled',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  const viewport = args.mobile ? { width: 390, height: 664 } : { width: 1280, height: 720 };
  const page = await browser.newPage({
    viewport,
    deviceScaleFactor: args.mobile ? 3 : 2,
    isMobile: args.mobile,
    hasTouch: args.mobile,
  });
  await page.bringToFront();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(profileUrl.href, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(
    () => Boolean(window.__THREE_GAME_TEST_HOOKS__ && window.__THREE_GAME_DIAGNOSTICS__?.map?.ready),
    null,
    { timeout: 90_000 },
  );
  if (args.preloadAudio) {
    await page.click('#start-button');
    await page.waitForFunction(
      () => window.__THREE_GAME_DIAGNOSTICS__?.state === 'running',
      null,
      { timeout: 90_000 },
    );
  }
  await page.evaluate(({ state, speedKmh, fireWeapon, combat }) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    hooks.seed(450_600);
    hooks.setState(state);
    hooks.setWeapon(fireWeapon ?? 'machine');
    if (!combat) hooks.parkBotsForScreenshot();
    hooks.setReducedMotion(false);
    if (speedKmh > 0) hooks.setSpeedCapture(speedKmh);
    hooks.setPausedForScreenshot(false);
    if (document.pointerLockElement) document.exitPointerLock();
  }, {
    state: args.state,
    speedKmh: args.speedKmh,
    fireWeapon: args.fireWeapon,
    combat: args.combat,
  });
  await page.waitForTimeout(args.warmup);
  await page.evaluate(({ freeze, speedKmh, combat }) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    if (!combat) hooks.parkBotsForScreenshot();
    if (speedKmh > 0) hooks.setSpeedCapture(speedKmh);
    hooks.setPausedForScreenshot(freeze);
    if (document.pointerLockElement) document.exitPointerLock();
  }, { freeze: args.freeze, speedKmh: args.speedKmh, combat: args.combat });

  if (args.fly) {
    await page.keyboard.down('KeyW');
    await page.keyboard.down('Space');
  }
  if (args.fireWeapon) await page.keyboard.down('KeyF');

  const rawMeasurement = await page.evaluate(async (duration) => {
    const canvas = document.querySelector('canvas');
    const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    const deltas = [];
    const timeline = [];
    const slowFrames = [];
    const longAnimationFrames = [];
    const longFrameObserver = typeof PerformanceObserver !== 'undefined'
      && PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')
      ? new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) {
          longAnimationFrames.push({
            startTime: entry.startTime,
            duration: entry.duration,
            blockingDuration: entry.blockingDuration,
            renderStart: entry.renderStart,
            styleAndLayoutStart: entry.styleAndLayoutStart,
            scripts: (entry.scripts ?? []).map((script) => ({
              duration: script.duration,
              functionName: script.sourceFunctionName,
              sourceURL: script.sourceURL,
              invoker: script.invoker,
            })),
          });
        }
      })
      : null;
    longFrameObserver?.observe({ type: 'long-animation-frame' });
    const started = performance.now();
    let previous = started;
    let nextTimelineSample = 0;
    await new Promise((resolve) => {
      const sample = (now) => {
        const frameTimeMs = now - previous;
        deltas.push(frameTimeMs);
        previous = now;
        const elapsed = now - started;
        if (frameTimeMs > 25) {
          const diagnostics = window.__THREE_GAME_DIAGNOSTICS__;
          const phaseTiming = window.__THREE_FRAME_TIMING__;
          slowFrames.push({
            elapsedMs: elapsed,
            frameTimeMs,
            updateMs: phaseTiming?.updateMs ?? null,
            renderMs: phaseTiming?.renderMs ?? null,
            gameFrameMs: phaseTiming?.totalMs ?? null,
            calls: diagnostics?.renderer.calls ?? null,
            geometries: diagnostics?.renderer.geometries ?? null,
            activeWeaponVfx: diagnostics?.renderer.activeWeaponVfx ?? null,
            activeSurfaceMarks: diagnostics?.renderer.activeSurfaceMarks ?? null,
            projectiles: diagnostics?.projectiles ?? null,
          });
        }
        if (elapsed >= nextTimelineSample) {
          const diagnostics = window.__THREE_GAME_DIAGNOSTICS__;
          const phaseTiming = window.__THREE_FRAME_TIMING__;
          timeline.push({
            elapsedMs: elapsed,
            updateMs: phaseTiming?.updateMs ?? null,
            renderMs: phaseTiming?.renderMs ?? null,
            gameFrameMs: phaseTiming?.totalMs ?? null,
            calls: diagnostics?.renderer.calls ?? null,
            triangles: diagnostics?.renderer.triangles ?? null,
            geometries: diagnostics?.renderer.geometries ?? null,
            textures: diagnostics?.renderer.textures ?? null,
            activeWeaponVfx: diagnostics?.renderer.activeWeaponVfx ?? null,
            activeSurfaceMarks: diagnostics?.renderer.activeSurfaceMarks ?? null,
            activeTracers: diagnostics?.renderer.activeTracers ?? null,
            projectiles: diagnostics?.projectiles ?? null,
          });
          nextTimelineSample += 500;
        }
        if (now - started >= duration) resolve();
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    const renderer = gl && debug
      ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
      : gl ? String(gl.getParameter(gl.RENDERER)) : null;
    longFrameObserver?.disconnect();
    return {
      webdriver: navigator.webdriver,
      gpu: {
        renderer,
        software: renderer ? /swiftshader|llvmpipe|software|basic render/i.test(renderer) : null,
      },
      deltas,
      slowFrames,
      longAnimationFrames,
      timeline,
      frameTiming: window.__THREE_FRAME_TIMING__,
      diagnostics: window.__THREE_GAME_DIAGNOSTICS__,
      memory: performance.memory
        ? {
          usedJsHeap: performance.memory.usedJSHeapSize,
          totalJsHeap: performance.memory.totalJSHeapSize,
        }
        : null,
    };
  }, args.duration);

  if (args.fireWeapon) await page.keyboard.up('KeyF');
  if (args.fly) {
    await page.keyboard.up('Space');
    await page.keyboard.up('KeyW');
  }
  const { deltas, ...measurement } = rawMeasurement;
  const frameMetrics = computeFrameMetrics(deltas);
  const rendererCounters = summarizeRendererCounters(measurement.diagnostics);
  const validHardwareRun = measurement.gpu.software === false && measurement.webdriver === false;
  const passesTarget = validHardwareRun
    && frameMetrics.fps >= args.target
    && frameMetrics.onePercentLowFps >= args.target;
  const result = {
    profileSchemaVersion: 2,
    capturedAt: new Date().toISOString(),
    buildMode: 'vite-production-preview',
    scenario: args.state,
    viewport,
    requestedDeviceScaleFactor: args.mobile ? 3 : 2,
    durationMs: args.duration,
    targetFps: args.target,
    staticWeaponBatching: !args.unbatched,
    simulation: args.freeze ? 'frozen-render-isolation' : 'live-gameplay',
    captureSpeedKmh: args.speedKmh,
    sustainedFireWeapon: args.fireWeapon,
    audioPreloaded: args.preloadAudio,
    activeCombat: args.combat,
    activeFlight: args.fly,
    map: args.map,
    validHardwareRun,
    passesTarget,
    performanceContract: {
      passCriterion: 'valid hardware run with average and 1% low FPS at or above target',
      targetFps: args.target,
      targetFrameTimeMs: 1_000 / args.target,
      observedFps: frameMetrics.fps,
      observedOnePercentLowFps: frameMetrics.onePercentLowFps,
      passes: passesTarget,
    },
    ...measurement,
    ...frameMetrics,
    rendererCounters,
    consoleErrors,
    pageErrors,
  };
  const jsonPath = new URL(`${args.label}-${args.mobile ? 'mobile' : 'desktop'}.json`, outputDirectory);
  const screenshotPath = new URL(`${args.label}-${args.mobile ? 'mobile' : 'desktop'}.png`, outputDirectory);
  await page.evaluate(({ speedKmh, fireWeapon }) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    hooks.setWeapon(fireWeapon ?? 'machine');
    hooks.resetWeaponCaptureState();
    if (speedKmh > 0) hooks.setSpeedCapture(speedKmh);
    hooks.setPausedForScreenshot(true);
  }, { speedKmh: args.speedKmh, fireWeapon: args.fireWeapon });
  await page.waitForTimeout(100);
  await page.screenshot({ path: screenshotPath.pathname, timeout: 90_000 });
  await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({
    capturedAt: result.capturedAt,
    scenario: result.scenario,
    simulation: result.simulation,
    viewport: result.viewport,
    durationMs: result.durationMs,
    gpu: result.gpu,
    validHardwareRun: result.validHardwareRun,
    targetFps: result.targetFps,
    passesTarget: result.passesTarget,
    frames: result.frames,
    fps: result.fps,
    onePercentLowFps: result.onePercentLowFps,
    frameTimeMs: result.frameTimeMs,
    longFrames: result.longFrames,
    rendererCounters: result.rendererCounters,
    memory: result.memory,
    consoleErrorCount: result.consoleErrors.length,
    pageErrorCount: result.pageErrors.length,
  }, null, 2));
  console.log(`Wrote ${jsonPath.pathname} and ${screenshotPath.pathname}`);
  if (!result.passesTarget || consoleErrors.length || pageErrors.length) process.exitCode = 1;
  } finally {
    await browser?.close();
    if (previewServer) await new Promise((resolve) => previewServer.httpServer.close(resolve));
  }
}

const executedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (executedPath === import.meta.url) {
  await runProfile();
}
