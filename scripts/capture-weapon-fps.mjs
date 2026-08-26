import { mkdir, stat, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Do not use `?qa=physics` here: that deterministic physics mode deliberately
// renders only its first WebGL frame. Visual QA needs the normal live renderer.
const baseUrl = process.env.RIFTLINE_CAPTURE_URL ?? 'http://127.0.0.1:5194/';
const outputDir = new URL('../artifacts/weapon-aaa/fps-top-v1/', import.meta.url);
const allWeapons = ['machine', 'shotgun', 'rocket', 'plasma', 'laser', 'sniper', 'rail', 'disc'];
const weapons = (process.env.RIFTLINE_CAPTURE_WEAPONS ?? allWeapons.join(','))
  .split(',')
  .map((weapon) => weapon.trim())
  .filter((weapon) => allWeapons.includes(weapon));
const firingDelay = {
  machine: 0.02,
  shotgun: 0.16,
  rocket: 0.055,
  plasma: 0.065,
  laser: 0.08,
  sniper: 0.18,
  rail: 0.045,
  disc: 0.048,
};

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});
page.on('pageerror', (error) => errors.push(`page: ${error.message}`));

await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__), null, { timeout: 90_000 });
// Vite may perform one dependency-optimization reload after the first game
// boot. Let that settle so a capture cannot hold hooks from the disposed game.
await page.waitForTimeout(1_200);
await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__), null, { timeout: 90_000 });
await page.evaluate(() => {
  const hooks = window.__THREE_GAME_TEST_HOOKS__;
  hooks.setState('movement-flat');
  hooks.setReducedMotion(false);
  hooks.setPausedForScreenshot(true);
});

const captures = [];
for (const weapon of weapons) {
  await page.evaluate((id) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    // The validated flat lane supplies a level, unobstructed live-game
    // sightline, so proximity tuck cannot hide the top surfaces.
    hooks.setState('movement-flat');
    hooks.parkBotsForScreenshot();
    hooks.setWeapon(id);
    hooks.resetWeaponCaptureState();
    hooks.setPausedForScreenshot(false);
  }, weapon);
  await page.waitForTimeout(260);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setPausedForScreenshot(true));
  await page.waitForTimeout(40);
  const idlePath = new URL(`${weapon}-fps-idle.png`, outputDir);
  await page.screenshot({ path: idlePath.pathname, timeout: 90_000 });

  await page.evaluate(({ id, delay }) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    if (id === 'laser') {
      hooks.setPausedForScreenshot(false);
    } else {
      hooks.setPausedForScreenshot(false);
      hooks.fireWeapon();
    }
  }, { id: weapon, delay: firingDelay[weapon] });
  if (weapon === 'laser') {
    await page.evaluate(async () => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__;
      await new Promise((resolve) => {
        let frames = 0;
        const sustain = () => {
          hooks.fireWeapon();
          frames += 1;
          if (frames < 5) requestAnimationFrame(sustain);
          else resolve();
        };
        sustain();
      });
    });
  } else {
    await page.waitForTimeout(Math.max(18, firingDelay[weapon] * 1_000));
  }
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setPausedForScreenshot(true));
  await page.waitForTimeout(30);
  const firingPath = new URL(`${weapon}-fps-firing.png`, outputDir);
  await page.screenshot({ path: firingPath.pathname, timeout: 90_000 });
  captures.push({
    weapon,
    idle: idlePath.pathname,
    firing: firingPath.pathname,
    capturedAt: new Date().toISOString(),
  });
}

const diagnostics = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.renderer ?? null);
const manifestCaptures = [];
for (const weapon of allWeapons) {
  const idle = new URL(`${weapon}-fps-idle.png`, outputDir);
  const firing = new URL(`${weapon}-fps-firing.png`, outputDir);
  try {
    const [idleStat, firingStat] = await Promise.all([stat(idle), stat(firing)]);
    manifestCaptures.push({
      weapon,
      idle: idle.pathname,
      firing: firing.pathname,
      capturedAt: new Date(Math.max(idleStat.mtimeMs, firingStat.mtimeMs)).toISOString(),
    });
  } catch {
    // Partial runs intentionally leave missing weapons out of the manifest.
  }
}
await writeFile(new URL('manifest.json', outputDir), `${JSON.stringify({
  capturedAt: new Date().toISOString(),
  baseUrl,
  viewport: { width: 1440, height: 900 },
  source: 'actual-game-first-person-camera',
  captures: manifestCaptures,
  diagnostics,
  errors,
}, null, 2)}\n`);

await browser.close();
if (errors.length) {
  throw new Error(`Capture completed with ${errors.length} browser error(s):\n${errors.join('\n')}`);
}
console.log(`Captured ${captures.length * 2} fresh in-game weapon frames; ${manifestCaptures.length}/8 complete pairs in ${outputDir.pathname}`);
