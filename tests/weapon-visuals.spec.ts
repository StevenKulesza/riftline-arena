import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Playwright's font readiness probe can hang forever on headless Linux when
// local-only font fallbacks are unresolved, even though the canvas is ready.
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = '1';

const weapons = ['machine', 'shotgun', 'rocket', 'plasma', 'laser', 'sniper', 'rail'] as const;
const requestedWeapon = process.env.WEAPON_CAPTURE_FOCUS as (typeof weapons)[number] | undefined;
const captureWeapons = requestedWeapon && weapons.includes(requestedWeapon) ? [requestedWeapon] : weapons;
const artifactDirectory = resolve('artifacts/weapon-aaa');

async function captureWebGlFrame(page: Page, path: string): Promise<void> {
  const session = await page.context().newCDPSession(page);
  const result = await session.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await session.detach();
  await writeFile(path, Buffer.from(result.data, 'base64'));
}

test('captures every authored first-person weapon and verifies firing VFX', async ({ page }) => {
  test.setTimeout(240_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await mkdir(artifactDirectory, { recursive: true });
  await page.goto('/');
  await expect(page.locator('#game-canvas')).toBeVisible();
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5);
  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    if (!hooks) throw new Error('Riftline test hooks are unavailable.');
    hooks.seed(450_600);
    hooks.setState('active-play');
    hooks.setReducedMotion(true);
    hooks.setPausedForScreenshot(true);
  });

  for (const weapon of captureWeapons) {
    await page.evaluate((id) => window.__THREE_GAME_TEST_HOOKS__?.setWeapon(id), weapon);
    expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.weapon)).toBe(weapon);
    await captureWebGlFrame(page, resolve(artifactDirectory, `${weapon}-model.png`));
  }

  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    hooks?.setWeapon('laser');
    hooks?.setAim(-2.35, -0.08);
    hooks?.fireWeapon();
    hooks?.setAim(-1.55, 0.12);
    hooks?.fireWeapon();
  });
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.combat.continuousLaserActive)).toBe(true);
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.combat.continuousLaserBend ?? 0)).toBeGreaterThan(0.12);
  await captureWebGlFrame(page, resolve(artifactDirectory, 'laser-continuous-beam.png'));

  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    hooks?.setWeapon('rocket');
    hooks?.fireWeapon();
  });
  const rocketEffects = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.renderer.activeWeaponVfx ?? 0);
  expect(rocketEffects).toBeGreaterThan(0);
  await captureWebGlFrame(page, resolve(artifactDirectory, 'rocket-firing-vfx.png'));

  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    hooks?.setWeapon('rail');
    hooks?.fireWeapon();
  });
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.renderer.activeWeaponVfx ?? 0)).toBeGreaterThan(rocketEffects);

  const diagnostics = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
  expect(diagnostics?.renderer.geometries).toBeLessThan(300);
  expect(diagnostics?.renderer.textures).toBeLessThan(140);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
