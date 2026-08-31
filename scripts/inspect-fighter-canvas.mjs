#!/usr/bin/env node
// Project-local specialization of the bundled Three.js canvas inspector. The
// authored QuickSense map intentionally preloads its shader/model bank, so this
// runner waits for the deterministic hooks instead of using the generic 10 s
// canvas deadline.
import { chromium, devices } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';

const BUDGETS = {
  // These screenshot budgets describe the resident, prewarmed QuickSense
  // scene. Weapon variants and both fighter LODs intentionally stay uploaded
  // after the loading gate so combat never performs a first-use GPU upload.
  // Live headed-hardware frame pacing is enforced separately by
  // profile-performance.mjs.
  desktop: { calls: 300, triangles: 650_000, geometries: 310, textures: 100 },
  mobile: { calls: 200, triangles: 475_000, geometries: 300, textures: 80 },
};

const args = process.argv.slice(2);
const option = (name, fallback = undefined) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const mobile = args.includes('--mobile');
const states = String(option('--state', '')).split(',').map((value) => value.trim()).filter(Boolean);
const seed = Number(option('--seed', '450600'));
const url = option('--url', 'http://127.0.0.1:5188/?map=quicksense&qa=visual');
const out = option('--out', 'artifacts/fighter-canvas');

const round = (value, digits) => Number(value.toFixed(digits));

function metrics(png) {
  const stepX = Math.max(1, Math.floor(png.width / 160));
  const stepY = Math.max(1, Math.floor(png.height / 90));
  const cols = Math.floor(png.width / stepX);
  const rows = Math.floor(png.height / stepY);
  const luminance = new Float64Array(cols * rows);
  const buckets = new Map();
  let samples = 0;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const index = ((y * stepY) * png.width + x * stepX) * 4;
      const r = png.data[index];
      const g = png.data[index + 1];
      const b = png.data[index + 2];
      luminance[y * cols + x] = r * 0.2126 + g * 0.7152 + b * 0.0722;
      const key = `${r >> 4},${g >> 4},${b >> 4}`;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
      samples += 1;
    }
  }
  const sorted = Array.from(luminance).sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  let entropy = 0;
  let dominant = 0;
  for (const count of buckets.values()) {
    const probability = count / samples;
    entropy -= probability * Math.log2(probability);
    dominant = Math.max(dominant, count);
  }
  let edges = 0;
  let checked = 0;
  for (let y = 0; y < rows - 1; y += 1) {
    for (let x = 0; x < cols - 1; x += 1) {
      const index = y * cols + x;
      if (Math.max(
        Math.abs(luminance[index] - luminance[index + 1]),
        Math.abs(luminance[index] - luminance[index + cols]),
      ) > 12) edges += 1;
      checked += 1;
    }
  }
  const p5 = sorted[Math.floor(sorted.length * 0.05)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  return {
    colorBuckets: buckets.size,
    colorEntropyBits: round(entropy, 2),
    edgeDensity: round(edges / checked, 3),
    luminance: { mean: round(mean, 1), p5: round(p5, 1), p95: round(p95, 1), contrast: round(p95 - p5, 1) },
    dominantColorShare: round(dominant / samples, 3),
    nonBackgroundShare: round(1 - dominant / samples, 3),
  };
}

await mkdir(out, { recursive: true });
let browser;
try {
  browser = await chromium.launch({ channel: 'chromium' });
} catch {
  browser = await chromium.launch();
}
const context = await browser.newContext(mobile
  ? { ...devices['iPhone 13'], userAgent: undefined }
  : { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => pageErrors.push(error.message));
await page.goto(url, { waitUntil: 'commit', timeout: 30_000 });
await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__), null, { timeout: 240_000 });
const mode = mobile ? 'mobile' : 'desktop';
const gpu = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
  const extension = gl?.getExtension('WEBGL_debug_renderer_info');
  const renderer = extension ? String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  return { renderer, softwareRendered: /swiftshader|llvmpipe|software/i.test(renderer) };
});
const reports = [];
for (const state of states.length ? states : [null]) {
  await page.evaluate(({ state, seed }) => {
    window.__THREE_GAME_TEST_HOOKS__?.seed(seed);
    if (state) window.__THREE_GAME_TEST_HOOKS__?.setState(state);
  }, { state, seed });
  await page.waitForTimeout(1_500);
  const name = `${mode}-${state ?? 'active'}`;
  const screenshotPath = path.join(out, `${name}.png`);
  const screenshotBuffer = await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 60_000 });
  const png = PNG.sync.read(screenshotBuffer);
  const diagnostics = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__ ?? null);
  const renderer = diagnostics?.renderer ?? {};
  const budget = BUDGETS[mode];
  const renderBudget = Object.fromEntries(Object.entries(budget).map(([key, limit]) => [key, {
    actual: Number(renderer[key] ?? 0),
    limit,
    over: Number(renderer[key] ?? 0) > limit,
  } ]));
  const report = {
    url,
    mode,
    state,
    seed,
    screenshotPath,
    gpu,
    result: {
      ok: png.width > 8 && png.height > 8,
      rect: { width: png.width, height: png.height },
      metrics: metrics(png),
      renderBudget,
      diagnostics,
    },
    consoleErrors,
    pageErrors,
  };
  await writeFile(path.join(out, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
  reports.push(report);
}
await browser.close();
console.log(JSON.stringify(reports, null, 2));
if (reports.some((report) => !report.result.ok) || consoleErrors.length || pageErrors.length) process.exitCode = 1;
