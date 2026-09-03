#!/usr/bin/env node
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PORT = process.env.PLAYWRIGHT_TEST_PORT ?? '37499';
const OUT = path.resolve('gauntlet/shots');
const MAP_FILTER = process.env.CAPTURE_MAP ?? 'all';
const ROUND = process.env.CAPTURE_ROUND ?? 'r1';
const EXTRAS_ONLY = process.env.CAPTURE_EXTRAS_ONLY === '1';
const EXTRA_FILTER = new Set((process.env.CAPTURE_EXTRA_FILTER ?? '').split(',').filter(Boolean));

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
    hooks?.parkBotsForScreenshot();
    hooks?.resetWeaponCaptureState();
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

async function captureActiveCombat(page, fileName, mobile = false, storm = false) {
  const previousFrame = await page.evaluate(({ showTouch, severeWeather }) => {
    const frame = window.__THREE_FRAME_TIMING__?.frame ?? 0;
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    hooks.setState('active-play');
    hooks.parkBotsForScreenshot();
    hooks.parkBotsForScreenshot();
    hooks.resetWeaponCaptureState();
    const player = { x: 0, z: 200 };
    const bot = { x: 52, z: 200 };
    const playerY = hooks.sampleFloorHeight(player.x, player.z, 800) ?? 0;
    const botY = hooks.sampleFloorHeight(bot.x, bot.z, 800) ?? 0;
    hooks.setCombatants(
      { x: player.x, y: playerY + 0.04, z: player.z },
      { x: bot.x, y: botY + 0.04, z: bot.z },
      true,
      true,
    );
    const dx = bot.x - player.x;
    const dz = bot.z - player.z;
    const dy = botY + 1.05 - (playerY + 1.62);
    const length = Math.max(Math.hypot(dx, dy, dz), 0.001);
    hooks.setAim(Math.atan2(-dx, -dz), Math.asin(dy / length));
    hooks.setWeapon('machine');
    hooks.fireWeapon();
    hooks.triggerHitMarker(false);
    hooks.stepSimulation(0.04);
    if (severeWeather) hooks.stageMonsoonWeather();
    hooks.setPausedForScreenshot(true);
    for (const selector of ['#hud', '#crosshair', '#view-mode-indicator', '#helmet-visor']) {
      document.querySelector(selector)?.classList.remove('hidden');
    }
    document.querySelector('#touch-controls')?.classList.toggle('hidden', !showTouch);
    return frame;
  }, { showTouch: mobile, severeWeather: storm });
  await page.waitForFunction((frame) => (
    (window.__THREE_FRAME_TIMING__?.frame ?? 0) >= frame + 2
    && (window.__THREE_GAME_DIAGNOSTICS__?.renderer?.calls ?? 0) > 0
  ), previousFrame, { timeout: 90_000 });
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(OUT, fileName), fullPage: false, timeout: 120_000 });
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setWeaponHandsVisible(true));
  console.error(`captured ${fileName}`);
  const diagnostics = await page.evaluate(() => ({
    camera: window.__THREE_GAME_DIAGNOSTICS__?.camera ?? null,
    renderer: window.__THREE_GAME_DIAGNOSTICS__?.renderer ?? null,
    frameTiming: window.__THREE_FRAME_TIMING__ ?? null,
  }));
  return { state: storm ? 'active-weather-combat' : 'active-combat', file: fileName, mobile, storm, ...diagnostics };
}

async function captureKineticSki(page, fileName) {
  const previousFrame = await page.evaluate(() => {
    const frame = window.__THREE_FRAME_TIMING__?.frame ?? 0;
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    hooks.setState('movement-slope');
    hooks.parkBotsForScreenshot();
    hooks.resetWeaponCaptureState();
    hooks.setWeapon('disc');
    hooks.setPausedForScreenshot(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft', key: 'Shift', bubbles: true }));
    hooks.stepSimulation(1.35);
    document.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft', key: 'Shift', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true }));
    hooks.setPausedForScreenshot(true);
    for (const selector of ['#hud', '#crosshair', '#view-mode-indicator', '#helmet-visor']) {
      document.querySelector(selector)?.classList.remove('hidden');
    }
    document.querySelector('#touch-controls')?.classList.add('hidden');
    return frame;
  });
  await page.waitForFunction((frame) => (
    (window.__THREE_FRAME_TIMING__?.frame ?? 0) >= frame + 2
    && (window.__THREE_GAME_DIAGNOSTICS__?.renderer?.calls ?? 0) > 0
  ), previousFrame, { timeout: 90_000 });
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(OUT, fileName), fullPage: false, timeout: 120_000 });
  const diagnostics = await page.evaluate(() => ({
    camera: window.__THREE_GAME_DIAGNOSTICS__?.camera ?? null,
    player: window.__THREE_GAME_DIAGNOSTICS__?.player ?? null,
    renderer: window.__THREE_GAME_DIAGNOSTICS__?.renderer ?? null,
  }));
  console.error(`captured ${fileName}`);
  return { state: 'kinetic-ski', file: fileName, ...diagnostics };
}

async function captureThreatEncounter(page, fileName, state = 'buster-encounter') {
  const previousFrame = await page.evaluate((encounterState) => {
    const frame = window.__THREE_FRAME_TIMING__?.frame ?? 0;
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    hooks.setState(encounterState);
    hooks.resetWeaponCaptureState();
    hooks.setPausedForScreenshot(true);
    for (const selector of ['#hud', '#crosshair', '#view-mode-indicator', '#helmet-visor']) {
      document.querySelector(selector)?.classList.remove('hidden');
    }
    document.querySelector('#touch-controls')?.classList.add('hidden');
    return frame;
  }, state);
  await page.waitForFunction((frame) => (
    (window.__THREE_FRAME_TIMING__?.frame ?? 0) >= frame + 2
    && (window.__THREE_GAME_DIAGNOSTICS__?.renderer?.calls ?? 0) > 0
  ), previousFrame, { timeout: 90_000 });
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(OUT, fileName), fullPage: false, timeout: 120_000 });
  const diagnostics = await page.evaluate(() => ({
    camera: window.__THREE_GAME_DIAGNOSTICS__?.camera ?? null,
    drones: window.__THREE_GAME_DIAGNOSTICS__?.drones ?? null,
    renderer: window.__THREE_GAME_DIAGNOSTICS__?.renderer ?? null,
  }));
  console.error(`captured ${fileName}`);
  return { state, file: fileName, ...diagnostics };
}

async function captureSpectator(page, fileName, position, target, fov = 62) {
  const previousFrame = await page.evaluate(({ position: p, target: t, fov: f }) => {
    const frame = window.__THREE_FRAME_TIMING__?.frame ?? 0;
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    hooks?.parkBotsForScreenshot();
    hooks?.resetWeaponCaptureState();
    hooks?.setPausedForScreenshot(true);
    const cameraPosition = { ...p };
    if (Number.isFinite(p.groundOffset)) {
      const floor = hooks?.sampleFloorHeight(p.x, p.z, 1600);
      if (floor !== null && floor !== undefined) cameraPosition.y = floor + p.groundOffset;
    }
    const lookTarget = { ...t };
    if (Number.isFinite(t.groundOffset)) {
      const floor = hooks?.sampleFloorHeight(t.x, t.z, 1600);
      if (floor !== null && floor !== undefined) lookTarget.y = floor + t.groundOffset;
    }
    hooks?.setSpectatorCamera(cameraPosition, lookTarget, f);
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

async function captureReward(page, fileName, kind) {
  const result = await page.evaluate((rewardKind) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    const pickup = window.__THREE_GAME_DIAGNOSTICS__?.pickups.find((entry) => entry.kind === rewardKind);
    if (!hooks || !pickup) throw new Error(`Missing reward ${rewardKind}.`);
    hooks.setReducedMotion(false);
    hooks.parkBotsForScreenshot();
    hooks.resetWeaponCaptureState();
    hooks.setWeaponHandsVisible(false);
    hooks.setFirstPersonWeaponVisible(false);
    hooks.setPausedForScreenshot(true);
    hooks.setSpectatorCamera(
      { x: pickup.position.x + 4.8, y: pickup.position.y + 2.6, z: pickup.position.z + 4.8 },
      { x: pickup.position.x, y: pickup.position.y + 0.82, z: pickup.position.z },
      50,
    );
    for (const selector of ['#hud', '#crosshair', '#touch-controls', '#view-mode-indicator', '#helmet-visor']) {
      document.querySelector(selector)?.classList.add('hidden');
    }
    return { position: pickup.position, silhouette: pickup.silhouette ?? null };
  }, kind);
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(OUT, fileName), fullPage: false, timeout: 120_000 });
  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__?.setWeaponHandsVisible(true);
    window.__THREE_GAME_TEST_HOOKS__?.setFirstPersonWeaponVisible(true);
  });
  console.error(`captured ${fileName}`);
  return { state: 'reward', file: fileName, kind, ...result };
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
      renderer: diag.renderer,
      frameTiming: window.__THREE_FRAME_TIMING__ ?? null,
      lighting: diag.lighting,
      renderAudit: hooks.getArenaRenderAudit(),
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
    const floor = hooks.sampleFloorHeight(s.x, s.z, 800) ?? s.y;
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
    for (let i = 1; i <= 44; i += 1) {
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

async function runMap(mapId, states, bounds, skiStarts, extraViews, mobileStates = []) {
  const url = `http://127.0.0.1:${PORT}/?map=${mapId}&qa=capture&mapSeed=450600`;
  console.error(`loading ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await waitReady(page);
  console.error(`ready ${mapId}`);
  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    hooks.seed(450_600);
    hooks.setReducedMotion(true);
    hooks.hideDebugUi(true);
    hooks.parkBotsForScreenshot();
    hooks.resetWeaponCaptureState();
  });
  if (EXTRAS_ONLY && states.length > 0) {
    await page.evaluate((state) => window.__THREE_GAME_TEST_HOOKS__?.setState(state), states[0][0]);
    await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.state === 'running');
  }
  const captures = [];
  for (const [state, file] of EXTRAS_ONLY ? [] : states) {
    captures.push(await captureState(page, state, file));
  }
  if (!EXTRAS_ONLY && mapId === 'monsoon') {
    captures.push(await captureActiveCombat(page, `${ROUND}-monsoon-active-combat.png`));
    captures.push(await captureActiveCombat(page, `${ROUND}-monsoon-active-weather-combat.png`, false, true));
    captures.push(await captureKineticSki(page, `${ROUND}-monsoon-kinetic-ski.png`));
    captures.push(await captureThreatEncounter(page, `${ROUND}-monsoon-buster-threat.png`));
    for (const kind of ['health', 'armor', 'plasma', 'damage']) {
      captures.push(await captureReward(page, `${ROUND}-monsoon-reward-${kind}.png`, kind));
    }
  }
  if (!EXTRAS_ONLY && mobileStates.length > 0) {
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const mobilePage = await mobileContext.newPage();
    mobilePage.setDefaultTimeout(180_000);
    mobilePage.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(`[mobile] ${message.text()}`);
    });
    mobilePage.on('pageerror', (error) => pageErrors.push(`[mobile] ${error.message}`));
    await mobilePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await waitReady(mobilePage);
    await mobilePage.evaluate(() => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__;
      hooks.seed(450_600);
      hooks.setReducedMotion(true);
      hooks.hideDebugUi(true);
      hooks.parkBotsForScreenshot();
      hooks.resetWeaponCaptureState();
    });
    for (const [state, file] of mobileStates) {
      captures.push(await captureState(mobilePage, state, file));
    }
    if (mapId === 'monsoon') {
      captures.push(await captureActiveCombat(mobilePage, `${ROUND}-monsoon-active-mobile.png`, true));
    }
    await mobileContext.close();
  }
  const measures = await measure(page, bounds);
  const ski = [];
  for (const start of EXTRAS_ONLY ? [] : skiStarts) {
    ski.push(await skiProbe(page, start.pos, start.aim));
  }
  const pads = [];
  for (let i = 0; i < (EXTRAS_ONLY ? 0 : measures.pads.length); i += 1) {
    pads.push(await padProbe(page, i));
  }
  const extras = [];
  const selectedExtraViews = EXTRA_FILTER.size > 0
    ? extraViews.filter((view) => EXTRA_FILTER.has(view.file.replace(`${ROUND}-monsoon-`, '').replace('.png', '')))
    : extraViews;
  for (const view of selectedExtraViews) {
    extras.push(await captureSpectator(page, view.file, view.position, view.target, view.fov));
  }
  report.maps[mapId] = { captures, extras, measures, ski, pads };
}

if (MAP_FILTER === 'all' || MAP_FILTER === 'monsoon') await runMap(
  'monsoon',
  [
    ['monsoon-overlook', `${ROUND}-monsoon-overlook.png`],
    ['monsoon-ramp', `${ROUND}-monsoon-ramp.png`],
    ['monsoon-grassland', `${ROUND}-monsoon-grassland.png`],
    ['monsoon-structure', `${ROUND}-monsoon-structure.png`],
    ['monsoon-weather', `${ROUND}-monsoon-weather.png`],
  ],
  { minX: -1920, maxX: 1920, minZ: -1600, maxZ: 1600, step: 128, fromY: 1600 },
  [
    { pos: { x: -1184, z: 608 }, aim: { x: 60, z: -36 } },
    { pos: { x: 1200, z: 520 }, aim: { x: -64, z: -46 } },
  ],
  [
    {
      file: `${ROUND}-monsoon-ski-nw.png`,
      position: { x: -1200, y: 610, z: 720 },
      target: { x: -760, y: 260, z: 400 },
      fov: 64,
    },
    {
      file: `${ROUND}-monsoon-bounds-high.png`,
      position: { x: -120, y: 1500, z: -2320 },
      target: { x: 0, y: 210, z: 80 },
      fov: 58,
    },
    {
      file: `${ROUND}-monsoon-west-harvester.png`,
      position: { x: -1712, y: 752, z: 1120 },
      target: { x: -1328, y: 416, z: 728 },
      fov: 58,
    },
    {
      file: `${ROUND}-monsoon-relay-network.png`,
      position: { x: 176, y: 840, z: -680 },
      target: { x: 160, y: 216, z: 320 },
      fov: 60,
    },
    {
      file: `${ROUND}-monsoon-windbreak.png`,
      position: { x: -1272, y: 212, z: 280 },
      target: { x: -1408, y: 164, z: 120 },
      fov: 56,
    },
    {
      file: `${ROUND}-monsoon-storm-drain.png`,
      position: { x: -240, y: 280, z: 760 },
      target: { x: -368, y: 220, z: 896 },
      fov: 52,
    },
    {
      file: `${ROUND}-monsoon-relay-fin.png`,
      position: { x: -820, y: 352, z: -40 },
      target: { x: -960, y: 296, z: 80 },
      fov: 52,
    },
    {
      file: `${ROUND}-monsoon-low-west-route.png`,
      position: { x: -1240, y: 0, z: 560, groundOffset: 28 },
      target: { x: -720, y: 230, z: 320 },
      fov: 66,
    },
    {
      file: `${ROUND}-monsoon-low-basin-route.png`,
      position: { x: -560, y: 0, z: -400, groundOffset: 24 },
      target: { x: 240, y: 146, z: 80 },
      fov: 68,
    },
    {
      file: `${ROUND}-monsoon-horizon-depth.png`,
      position: { x: 80, y: 0, z: 560, groundOffset: 30 },
      target: { x: 880, y: 440, z: -400 },
      fov: 62,
    },
    {
      file: `${ROUND}-monsoon-west-outpost-exterior.png`,
      position: { x: -420, y: 0, z: 760, groundOffset: 34 },
      target: { x: -680, y: 415, z: 1040 },
      fov: 62,
    },
    {
      file: `${ROUND}-monsoon-west-outpost-entrance.png`,
      position: { x: -680, y: 0, z: 840, groundOffset: 12 },
      target: { x: -680, y: 350, z: 980 },
      fov: 68,
    },
    {
      file: `${ROUND}-monsoon-southeast-outpost-exterior.png`,
      position: { x: 500, y: 0, z: -700, groundOffset: 34 },
      target: { x: 760, y: 390, z: -960 },
      fov: 62,
    },
    {
      file: `${ROUND}-monsoon-southeast-outpost-entrance.png`,
      position: { x: 760, y: 0, z: -760, groundOffset: 12 },
      target: { x: 760, y: 324, z: -890 },
      fov: 68,
    },
    {
      file: `${ROUND}-monsoon-fern-gully.png`,
      position: { x: -944, y: 0, z: 424, groundOffset: 5.2 },
      target: { x: -896, y: 0, z: 464, groundOffset: 1.8 },
      fov: 50,
    },
    {
      file: `${ROUND}-monsoon-storm-shelter-grove.png`,
      position: { x: -520, y: 0, z: -864, groundOffset: 7.5 },
      target: { x: -448, y: 0, z: -808, groundOffset: 5 },
      fov: 52,
    },
    {
      file: `${ROUND}-monsoon-east-biome.png`,
      position: { x: 516, y: 0, z: 440, groundOffset: 7 },
      target: { x: 584, y: 0, z: 496, groundOffset: 4.5 },
      fov: 52,
    },
    {
      file: `${ROUND}-monsoon-talus-field.png`,
      position: { x: -1396, y: 0, z: 598, groundOffset: 9 },
      target: { x: -1472, y: 0, z: 656, groundOffset: 4 },
      fov: 52,
    },
  ],
  [['monsoon-overlook', `${ROUND}-monsoon-mobile.png`]],
);

if (MAP_FILTER === 'all' || MAP_FILTER === 'quicksense') await runMap(
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
  files: Object.values(slim.maps).flatMap((map) => [...map.captures, ...map.extras]).map((c) => c.file),
  monsoonGrid: slim.maps.monsoon?.measures.grid ?? null,
  quickGrid: slim.maps.quicksense?.measures.grid ?? null,
  monsoonPads: slim.maps.monsoon?.measures.pads ?? null,
  quickPads: slim.maps.quicksense?.measures.pads ?? null,
  monsoonSki: slim.maps.monsoon?.ski.map((s) => ({ distance: s.distance, drop: s.drop, maxSpeed: s.maxSpeed })) ?? null,
  quickSki: slim.maps.quicksense?.ski.map((s) => ({ distance: s.distance, drop: s.drop, maxSpeed: s.maxSpeed })) ?? null,
  monsoonPadLift: slim.maps.monsoon?.pads.map((p) => ({ lift: p.lift, travel: p.travel })) ?? null,
  quickPadLift: slim.maps.quicksense?.pads.map((p) => ({ lift: p.lift, travel: p.travel })) ?? null,
  consoleErrors,
  pageErrors,
}, null, 2));
