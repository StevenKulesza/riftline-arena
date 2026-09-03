import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const round = process.argv[2] ?? 'r11';
const prefix = process.argv[3] ?? `${round}-monsoon-`;
const captureDirectory = process.argv[4] ?? './';
const directory = new URL(captureDirectory.endsWith('/') ? captureDirectory : `${captureDirectory}/`, import.meta.url);
const files = (await readdir(directory))
  .filter((file) => file.startsWith(prefix) && /\.(?:png|jpe?g)$/i.test(file))
  .sort();

if (files.length === 0) throw new Error(`No PNG captures found for prefix ${prefix}.`);

const browser = await chromium.launch({ channel: 'chromium', headless: true });
const page = await browser.newPage();
const metrics = {};

try {
  for (const file of files) {
    const url = new URL(file, directory);
    await page.goto(url.href, { waitUntil: 'load' });
    metrics[file] = await page.evaluate(() => {
      const source = document.querySelector('img');
      if (!(source instanceof HTMLImageElement)) throw new Error('Capture image did not load.');
      const width = 320;
      const height = Math.max(1, Math.round(source.naturalHeight * width / source.naturalWidth));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('2D canvas is unavailable.');
      context.drawImage(source, 0, 0, width, height);
      const rgba = context.getImageData(0, 0, width, height).data;
      const pixelCount = width * height;
      const bins = new Uint32Array(4096);
      const luminance = new Float32Array(pixelCount);
      let luminanceSum = 0;
      let saturationSum = 0;
      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        const index = pixel * 4;
        const red = rgba[index] / 255;
        const green = rgba[index + 1] / 255;
        const blue = rgba[index + 2] / 255;
        const value = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
        luminance[pixel] = value;
        luminanceSum += value;
        const maximum = Math.max(red, green, blue);
        const minimum = Math.min(red, green, blue);
        saturationSum += maximum === 0 ? 0 : (maximum - minimum) / maximum;
        bins[((rgba[index] >> 4) << 8) | ((rgba[index + 1] >> 4) << 4) | (rgba[index + 2] >> 4)] += 1;
      }
      const luminanceMean = luminanceSum / pixelCount;
      let luminanceVariance = 0;
      let entropy = 0;
      let dominant = 0;
      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        const difference = luminance[pixel] - luminanceMean;
        luminanceVariance += difference * difference;
      }
      for (const count of bins) {
        if (count === 0) continue;
        dominant = Math.max(dominant, count);
        const probability = count / pixelCount;
        entropy -= probability * Math.log2(probability);
      }
      let edgePixels = 0;
      let testedPixels = 0;
      for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
          const offset = y * width + x;
          const gx = -luminance[offset - width - 1] + luminance[offset - width + 1]
            - 2 * luminance[offset - 1] + 2 * luminance[offset + 1]
            - luminance[offset + width - 1] + luminance[offset + width + 1];
          const gy = -luminance[offset - width - 1] - 2 * luminance[offset - width] - luminance[offset - width + 1]
            + luminance[offset + width - 1] + 2 * luminance[offset + width] + luminance[offset + width + 1];
          edgePixels += Number(Math.hypot(gx, gy) > 0.42);
          testedPixels += 1;
        }
      }
      return {
        width: source.naturalWidth,
        height: source.naturalHeight,
        colorEntropyBits: entropy,
        dominantColorShare: dominant / pixelCount,
        luminance: {
          mean: luminanceMean,
          contrast: Math.sqrt(luminanceVariance / pixelCount),
        },
        meanSaturation: saturationSum / pixelCount,
        edgeDensity: edgePixels / testedPixels,
      };
    });
  }
} finally {
  await browser.close();
}

const values = Object.values(metrics);
const average = Object.fromEntries([
  'colorEntropyBits',
  'dominantColorShare',
  'meanSaturation',
  'edgeDensity',
].map((key) => [key, values.reduce((sum, value) => sum + value[key], 0) / values.length]));
average.luminanceContrast = values.reduce((sum, value) => sum + value.luminance.contrast, 0) / values.length;

const report = { round, files: metrics, average };
const output = path.join(directory.pathname, `${round}-visual-metrics.json`);
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, ...report }, null, 2));
