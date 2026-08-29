#!/usr/bin/env node
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';

function parseArgs(argv) {
  const args = {
    url: 'http://127.0.0.1:5270/?map=quicksense&qa=capture',
    out: 'artifacts/outpost-tower-audit/current',
    states: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--url') args.url = argv[++index];
    else if (argv[index] === '--out') args.out = argv[++index];
    else if (argv[index] === '--states') args.states = new Set(argv[++index].split(',').filter(Boolean));
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return args;
}

function pixelMetrics(buffer) {
  const png = PNG.sync.read(buffer);
  let minimumLuminance = 255;
  let maximumLuminance = 0;
  let edgeCount = 0;
  let sampleCount = 0;
  const colors = new Set();
  const step = Math.max(1, Math.floor(Math.min(png.width, png.height) / 180));
  const luminance = (x, y) => {
    const offset = (y * png.width + x) * 4;
    return 0.2126 * png.data[offset] + 0.7152 * png.data[offset + 1] + 0.0722 * png.data[offset + 2];
  };
  for (let y = 0; y < png.height - step; y += step) {
    for (let x = 0; x < png.width - step; x += step) {
      const offset = (y * png.width + x) * 4;
      const value = luminance(x, y);
      minimumLuminance = Math.min(minimumLuminance, value);
      maximumLuminance = Math.max(maximumLuminance, value);
      colors.add(`${png.data[offset] >> 4},${png.data[offset + 1] >> 4},${png.data[offset + 2] >> 4}`);
      if (Math.max(
        Math.abs(value - luminance(x + step, y)),
        Math.abs(value - luminance(x, y + step)),
      ) > 12) edgeCount += 1;
      sampleCount += 1;
    }
  }
  return {
    width: png.width,
    height: png.height,
    luminanceRange: Number((maximumLuminance - minimumLuminance).toFixed(2)),
    colorBuckets: colors.size,
    edgeDensity: Number((edgeCount / sampleCount).toFixed(3)),
  };
}

const args = parseArgs(process.argv.slice(2));
await mkdir(args.out, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium' });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.setDefaultTimeout(120_000);
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('requestfailed', (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));

await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__), null, { timeout: 120_000 });
const audit = await page.evaluate(() => {
  const hooks = window.__THREE_GAME_TEST_HOOKS__;
  if (!hooks) throw new Error('Riftline tower audit hooks are unavailable.');
  hooks.seed(450_600);
  hooks.setReducedMotion(true);
  hooks.hideDebugUi(true);
  return {
    tower: hooks.getOutpostTowerAudit(),
    pieces: hooks.getOutpostTowerPieceAudit(),
    states: hooks.getOutpostTowerReviewStates(),
  };
});
if (!audit.tower) throw new Error('The imported outpost tower is not loaded.');
const reviewStates = args.states
  ? audit.states.filter((state) => args.states.has(state) || args.states.has(state.replace('quicksense-tower-', '')))
  : audit.states;
if (reviewStates.length === 0) throw new Error('No requested tower review states were found.');

const captures = [];
for (const [index, state] of reviewStates.entries()) {
  const previousFrame = await page.evaluate((name) => {
    const frame = window.__THREE_FRAME_TIMING__?.frame ?? 0;
    window.__THREE_GAME_TEST_HOOKS__?.setState(name);
    return frame;
  }, state);
  await page.waitForFunction((frame) => {
    const diagnostics = window.__THREE_GAME_DIAGNOSTICS__;
    const timing = window.__THREE_FRAME_TIMING__;
    return Boolean(
      diagnostics
      && diagnostics.state === 'running'
      && diagnostics.renderer.calls > 0
      && timing
      // SwiftShader/compositor captures can trail WebGL by one submitted frame.
      // Require a second completed frame so the PNG always reflects this view.
      && timing.frame >= frame + 2
    );
  }, previousFrame);
  await page.waitForTimeout(80);
  const id = state.replace('quicksense-tower-', '');
  const fileName = `${String(index + 1).padStart(2, '0')}-${id}.png`;
  const filePath = path.join(args.out, fileName);
  // Chromium's software WebGL compositor can return the pre-camera-move frame
  // on its first readback even after the renderer has submitted new work.
  // Prime one readback, then retain the following compositor image.
  await page.screenshot({ fullPage: false, timeout: 120_000 });
  const buffer = await page.screenshot({ fullPage: false, timeout: 120_000 });
  await writeFile(filePath, buffer);
  const diagnostics = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
  captures.push({
    state,
    file: fileName,
    pixels: pixelMetrics(buffer),
    camera: diagnostics?.camera ?? null,
    renderer: diagnostics?.renderer ?? null,
  });
}

const report = {
  url: args.url,
  generatedAt: new Date().toISOString(),
  tower: audit.tower,
  pieces: audit.pieces,
  captures,
  consoleErrors,
  pageErrors,
  failedRequests,
};
await writeFile(path.join(args.out, 'manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
await browser.close();
console.log(JSON.stringify({
  captureCount: captures.length,
  pieceCount: audit.pieces.length,
  output: path.resolve(args.out),
  consoleErrors,
  pageErrors,
  failedRequests,
}, null, 2));
