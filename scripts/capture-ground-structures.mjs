#!/usr/bin/env node
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';

function parseArgs(argv) {
  const args = {
    url: 'http://127.0.0.1:5260/?map=quicksense&qa=capture',
    out: 'artifacts/ground-structure-audit/final',
    ids: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--url') args.url = argv[++index];
    else if (argv[index] === '--out') args.out = argv[++index];
    else if (argv[index] === '--ids') args.ids = new Set(argv[++index].split(',').filter(Boolean));
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return args;
}

function samplePixels(buffer) {
  const png = PNG.sync.read(buffer);
  const colors = new Set();
  let min = 255;
  let max = 0;
  let edges = 0;
  let edgeSamples = 0;
  const step = Math.max(1, Math.floor(Math.min(png.width, png.height) / 180));
  const luminance = (x, y) => {
    const offset = (y * png.width + x) * 4;
    return 0.2126 * png.data[offset] + 0.7152 * png.data[offset + 1] + 0.0722 * png.data[offset + 2];
  };
  for (let y = 0; y < png.height - step; y += step) {
    for (let x = 0; x < png.width - step; x += step) {
      const offset = (y * png.width + x) * 4;
      const r = png.data[offset];
      const g = png.data[offset + 1];
      const b = png.data[offset + 2];
      min = Math.min(min, r, g, b);
      max = Math.max(max, r, g, b);
      colors.add(`${r >> 4},${g >> 4},${b >> 4}`);
      if (Math.max(
        Math.abs(luminance(x, y) - luminance(x + step, y)),
        Math.abs(luminance(x, y) - luminance(x, y + step)),
      ) > 12) edges += 1;
      edgeSamples += 1;
    }
  }
  return {
    width: png.width,
    height: png.height,
    variance: max - min,
    colorBuckets: colors.size,
    edgeDensity: Number((edges / edgeSamples).toFixed(3)),
  };
}

const args = parseArgs(process.argv.slice(2));
await mkdir(args.out, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium' });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => pageErrors.push(error.message));

await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__), null, { timeout: 120_000 });
const allStructures = await page.evaluate(() => {
  const hooks = window.__THREE_GAME_TEST_HOOKS__;
  if (!hooks) throw new Error('Riftline structure audit hooks are unavailable.');
  hooks.seed(450_600);
  hooks.setReducedMotion(true);
  hooks.hideDebugUi(true);
  return hooks.getStructureAudit();
});
const structures = args.ids
  ? allStructures.filter((structure) => args.ids.has(structure.id))
  : allStructures;
if (structures.length === 0) throw new Error('The QuickSense structure manifest is empty.');

const captures = [];
for (const [index, structure] of structures.entries()) {
  await page.evaluate((state) => window.__THREE_GAME_TEST_HOOKS__?.setState(state), structure.state);
  await page.waitForFunction(() => {
    const diagnostics = window.__THREE_GAME_DIAGNOSTICS__;
    return Boolean(diagnostics && diagnostics.state === 'running' && diagnostics.renderer.calls > 0);
  });
  await page.waitForTimeout(140);
  const fileName = `${String(index + 1).padStart(2, '0')}-${structure.id}.png`;
  const filePath = path.join(args.out, fileName);
  const buffer = await page.screenshot({ fullPage: false });
  await writeFile(filePath, buffer);
  const diagnostics = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
  captures.push({ ...structure, file: fileName, pixels: samplePixels(buffer), renderer: diagnostics?.renderer ?? null });
}

const report = {
  url: args.url,
  generatedAt: new Date().toISOString(),
  captureCount: captures.length,
  captures,
  consoleErrors,
  pageErrors,
};
await writeFile(path.join(args.out, 'manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
await browser.close();
console.log(JSON.stringify({
  captureCount: captures.length,
  output: path.resolve(args.out),
  consoleErrors,
  pageErrors,
}, null, 2));
