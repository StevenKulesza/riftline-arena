#!/usr/bin/env node
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PORT = process.env.PLAYWRIGHT_TEST_PORT ?? '37499';
const OUT = path.resolve('gauntlet/shots');

async function waitReady(page) {
  await page.waitForFunction(() => (
    Boolean(window.__THREE_GAME_TEST_HOOKS__)
    && Boolean(window.__THREE_GAME_DIAGNOSTICS__?.map?.ready)
    && (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5
  ), null, { timeout: 240_000 });
}

async function captureState(page, name, fileName) {
  const previousFrame = await page.evaluate((n) => {
    const frame = window.__THREE_FRAME_TIMING__?.frame ?? 0;
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    hooks?.setState(n);
    hooks?.setPausedForScreenshot(true);
    return frame;
  }, name);
  await page.waitForFunction((frame) => {
    const diagnostics = window.__THREE_GAME_DIAGNOSTICS__;
    const timing = window.__THREE_FRAME_TIMING__;
    return Boolean(
      diagnostics
      && diagnostics.state === 'running'
      && diagnostics.renderer?.calls > 0
      && timing
      && timing.frame >= frame + 2
    );
  }, previousFrame, { timeout: 90_000 });
  await page.waitForTimeout(100);
  await page.screenshot({ fullPage: false, timeout: 120_000 });
  await page.screenshot({ path: path.join(OUT, fileName), fullPage: false, timeout: 120_000 });
  console.error(`captured ${fileName}`);
  const camera = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.camera ?? null);
  return { state: name, file: fileName, camera };
}

async function captureSpectator(page, fileName, position, target, fov = 62) {
  const previousFrame = await page.evaluate(({ position: p, target: t, fov: f }) => {
    const frame = window.__THREE_FRAME_TIMING__?.frame ?? 0;
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    hooks?.setPausedForScreenshot(true);
    hooks?.setSpectatorCamera(p, t, f);
    for (const selector of ['#hud', '#crosshair', '#touch-controls', '#view-mode-indicator', '#helmet-visor']) {
      document.querySelector(selector)?.classList.add('hidden');
    }
    return frame;
  }, { position, target, fov });
  await page.waitForFunction((frame) => {
    const timing = window.__THREE_FRAME_TIMING__;
    return Boolean(timing && timing.frame >= frame + 2);
  }, previousFrame, { timeout: 60_000 });
  await page.waitForTimeout(80);
  await page.screenshot({ fullPage: false, timeout: 120_000 });
  await page.screenshot({ path: path.join(OUT, fileName), fullPage: false, timeout: 120_000 });
  return { state: 'spectator', file: fileName, position, target, fov };
}

async function measure(page, bounds) {
  return page.evaluate((box) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    const diag = window.__THREE_GAME_DIAGNOSTICS__;
    if (!hooks || !diag) throw new Error('hooks missing');
    const pads = hooks.getJumpPads();
    const spawns = hooks.getSpawnPoints();
    const sight = hooks.getLongSightline();
    const step = box.step;
    const heights = [];
    let hits = 0;
    let cells = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let z = box.minZ; z <= box.maxZ; z += step) {
      for (let x = box.minX; x <= box.maxX; x += step) {
        cells += 1;
        const y = hooks.sampleFloorHeight(x, z, box.fromY);
        if (y === null || !Number.isFinite(y)) continue;
        hits += 1;
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        heights.push({ x, y, z });
      }
    }
    const spawnSpan = {
      minX: Math.min(...spawns.map((s) => s.x)),
      maxX: Math.max(...spawns.map((s) => s.x)),
      minZ: Math.min(...spawns.map((s) => s.z)),
      maxZ: Math.max(...spawns.map((s) => s.z)),
      minY: Math.min(...spawns.map((s) => s.y)),
      maxY: Math.max(...spawns.map((s) => s.y)),
    };
    const spawnDx = spawnSpan.maxX - spawnSpan.minX;
    const spawnDz = spawnSpan.maxZ - spawnSpan.minZ;
    const spawnDiagonal = Math.hypot(spawnDx, spawnDz);
    return {
      map: diag.map,
      fog: diag.fog,
      camera: diag.camera,
      pads,
      spawns,
      spawnSpan,
      spawnDiagonal,
      sight,
      grid: {
        cells,
        hits,
        occupancy: hits / cells,
        minY: Number.isFinite(minY) ? minY : null,
        maxY: Number.isFinite(maxY) ? maxY : null,
        verticalRange: Number.isFinite(maxY) && Number.isFinite(minY) ? maxY - minY : null,
        step,
        bounds: box,
      },
    };
  }, bounds);
}

async function skiProbe(page, start, aim) {
  return page.evaluate(async ({ start: s, aim: a }) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    const floor = hooks.sampleFloorHeight(s.x, s.z, 400) ?? s.y;
    hooks.setState('movement-flat');
    hooks.setCombatants(
      { x: s.x, y: floor + 0.04, z: s.z },
      { x: s.x + 80, y: floor + 40, z: s.z + 80 },
      false,
      true,
    );
    const yaw = Math.atan2(-a.x, -a.z);
    hooks.setAim(yaw, -0.06);
    hooks.setPausedForScreenshot(true);
    const samples = [];
    const read = () => {
      const d = window.__THREE_GAME_DIAGNOSTICS__;
      return {
        x: d.player.position.x,
        y: d.player.position.y,
        z: d.player.position.z,
        speed: d.player.speed,
        grounded: d.player.grounded,
        skiing: d.player.skiing,
      };
    };
    samples.push({ t: 0, ...read() });
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true }));
    hooks.stepSimulation(0.45);
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft', key: 'Shift', bubbles: true }));
    for (let i = 1; i <= 20; i += 1) {
      hooks.stepSimulation(0.2);
      samples.push({ t: 0.45 + i * 0.2, ...read() });
    }
    document.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft', key: 'Shift', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true }));
    const last = samples.at(-1);
    const first = samples[0];
    return {
      start: first,
      end: last,
      duration: last.t,
      distance: Math.hypot(last.x - first.x, last.z - first.z),
      drop: first.y - last.y,
      maxSpeed: Math.max(...samples.map((p) => p.speed)),
      minSpeed: Math.min(...samples.slice(3).map((p) => p.speed)),
      skiingFrames: samples.filter((p) => p.skiing).length,
      samples,
    };
  }, { start, aim });
}

async function padProbe(page, padIndex = 0) {
  return page.evaluate((index) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    const pads = hooks.getJumpPads();
    const pad = pads[index];
    if (!pad) return { error: 'no pad', pads };
    hooks.setState('movement-flat');
    hooks.setCombatants(
      { x: pad.x, y: pad.y + 0.05, z: pad.z },
      { x: pad.x + 40, y: pad.y + 20, z: pad.z + 40 },
      false,
      true,
    );
    hooks.setPausedForScreenshot(true);
    const samples = [];
    const read = () => {
      const d = window.__THREE_GAME_DIAGNOSTICS__;
      return {
        x: d.player.position.x,
        y: d.player.position.y,
        z: d.player.position.z,
        speed: d.player.speed,
        grounded: d.player.grounded,
        vy: d.player.velocity.y,
      };
    };
    samples.push({ t: 0, ...read() });
    for (let i = 1; i <= 18; i += 1) {
      hooks.stepSimulation(0.12);
      samples.push({ t: i * 0.12, ...read() });
    }
    const apex = samples.reduce((best, s) => (s.y > best.y ? s : best), samples[0]);
    const last = samples.at(-1);
    return {
      pad,
      apexY: apex.y,
      lift: apex.y - samples[0].y,
      travel: Math.hypot(last.x - samples[0].x, last.z - samples[0].z),
      stillGroundedAfter: samples.filter((s) => s.t > 0.1 && s.grounded).length,
      maxSpeed: Math.max(...samples.map((s) => s.speed)),
      samples,
    };
  }, padIndex);
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  channel: 'chromium',
  headless: false,
  args: [
    '--ozone-platform=wayland',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--ignore-gpu-blocklist',
  ],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.setDefaultTimeout(180_000);
const consoleErrors = [];
const pageErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => pageErrors.push(error.message));

const report = { port: PORT, generatedAt: new Date().toISOString(), maps: {}, consoleErrors, pageErrors };

async function runMap(mapId, states, bounds, skiStarts, extraViews) {
  const url = `http://127.0.0.1:${PORT}/?map=${mapId}&qa=capture`;
  console.error(`loading ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await waitReady(page);
  console.error(`ready ${mapId}`);
  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    hooks.seed(450_600);
    hooks.setReducedMotion(true);
    hooks.hideDebugUi(true);
  });
  const captures = [];
  for (const [state, file] of states) {
    captures.push(await captureState(page, state, file));
  }
  const measures = await measure(page, bounds);
  const ski = [];
  for (const start of skiStarts) {
    ski.push(await skiProbe(page, start.pos, start.aim));
  }
  const pads = [];
  for (let i = 0; i < Math.min(3, measures.pads.length); i += 1) {
    pads.push(await padProbe(page, i));
  }
  const extras = [];
  for (const view of extraViews) {
    extras.push(await captureSpectator(page, view.file, view.position, view.target, view.fov));
  }
  report.maps[mapId] = { captures, extras, measures, ski, pads };
}

await runMap(
  'monsoon',
  [
    ['monsoon-overlook', 'a-monsoon-overlook.png'],
    ['monsoon-ramp', 'a-monsoon-ramp.png'],
    ['monsoon-grassland', 'a-monsoon-grassland.png'],
    ['monsoon-structure', 'a-monsoon-structure.png'],
    ['monsoon-weather', 'a-monsoon-weather.png'],
  ],
  { minX: -480, maxX: 480, minZ: -400, maxZ: 400, step: 32, fromY: 400 },
  [
    { pos: { x: -296, z: 152 }, aim: { x: 60, z: -36 } },
    { pos: { x: 300, z: 130 }, aim: { x: -64, z: -46 } },
  ],
  [
    {
      file: 'a-monsoon-ski-nw.png',
      position: { x: -310, y: 175, z: 168 },
      target: { x: -200, y: 40, z: 90 },
      fov: 64,
    },
    {
      file: 'a-monsoon-bounds-high.png',
      position: { x: -20, y: 320, z: -520 },
      target: { x: 0, y: 40, z: 40 },
      fov: 58,
    },
  ],
);

await runMap(
  'quicksense',
  [
    ['quicksense-overlook', 'a-quicksense-overlook.png'],
    ['quicksense-ramp', 'a-quicksense-ramp.png'],
    ['quicksense-flow', 'a-quicksense-flow.png'],
    ['quicksense-speed', 'a-quicksense-speed.png'],
    ['quicksense-fighter-pads', 'a-quicksense-fighter-pads.png'],
    ['quicksense-crossings', 'a-quicksense-crossings.png'],
  ],
  { minX: -360, maxX: 360, minZ: -320, maxZ: 320, step: 24, fromY: 400 },
  [
    { pos: { x: 0, z: -128 }, aim: { x: 0, z: 1 } },
    { pos: { x: -168, z: -216 }, aim: { x: 40, z: 80 } },
  ],
  [
    {
      file: 'a-quicksense-ski-spine.png',
      position: { x: 8, y: 90, z: -250 },
      target: { x: 0, y: 20, z: 40 },
      fov: 62,
    },
    {
      file: 'a-quicksense-bounds-high.png',
      position: { x: 0, y: 280, z: -420 },
      target: { x: 0, y: 30, z: 0 },
      fov: 58,
    },
  ],
);

const slim = JSON.parse(JSON.stringify(report, (key, value) => {
  if (key === 'samples' && Array.isArray(value) && value.length > 8) {
    return [value[0], value[Math.floor(value.length / 2)], value.at(-1)];
  }
  if (key === 'spawns' && Array.isArray(value)) {
    return value.map((s) => ({
      x: Number(s.x.toFixed(2)),
      y: Number(s.y.toFixed(2)),
      z: Number(s.z.toFixed(2)),
    }));
  }
  if (typeof value === 'number' && Number.isFinite(value)) return Number(value.toFixed(3));
  return value;
}));
await writeFile(path.join(OUT, 'critic-measurements.json'), `${JSON.stringify(slim, null, 2)}\n`);
await browser.close();
console.log(JSON.stringify({
  files: [...slim.maps.monsoon.captures, ...slim.maps.monsoon.extras, ...slim.maps.quicksense.captures, ...slim.maps.quicksense.extras].map((c) => c.file),
  monsoonGrid: slim.maps.monsoon.measures.grid,
  quickGrid: slim.maps.quicksense.measures.grid,
  monsoonPads: slim.maps.monsoon.measures.pads,
  quickPads: slim.maps.quicksense.measures.pads,
  monsoonSki: slim.maps.monsoon.ski.map((s) => ({ distance: s.distance, drop: s.drop, maxSpeed: s.maxSpeed })),
  quickSki: slim.maps.quicksense.ski.map((s) => ({ distance: s.distance, drop: s.drop, maxSpeed: s.maxSpeed })),
  monsoonPadLift: slim.maps.monsoon.pads.map((p) => ({ lift: p.lift, travel: p.travel })),
  quickPadLift: slim.maps.quicksense.pads.map((p) => ({ lift: p.lift, travel: p.travel })),
  consoleErrors,
  pageErrors,
}, null, 2));
