import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

test('switches to a readable third-person player presentation', async ({ browserName, page }) => {
  test.setTimeout(360_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/?map=quicksense&qa=visual');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__), null, { timeout: 240_000 });
  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__?.setReducedMotion(true);
    window.__THREE_GAME_TEST_HOOKS__?.setState('view-0');
  });
  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.state === 'running', null, {
    timeout: 30_000,
  });
  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.player.modelReady === true, null, {
    timeout: 30_000,
  });
  const initialView = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);
  expect(initialView.viewMode).toBe('first-person');
  expect(initialView.player.avatarVisible).toBe(false);
  expect(initialView.player.firstPersonWeaponVisible).toBe(true);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.toggleViewMode());
  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.viewMode === 'third-person', null, {
    timeout: 30_000,
  });
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setWeapon('machine'));
  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.weapon === 'machine', null, {
    timeout: 30_000,
  });

  const thirdPerson = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
  expect(thirdPerson?.viewMode).toBe('third-person');
  expect(thirdPerson?.player.avatarVisible).toBe(true);
  expect(thirdPerson?.player.modelMeshCount).toBeGreaterThanOrEqual(4);
  expect(thirdPerson?.player.firstPersonWeaponVisible).toBe(false);
  expect(thirdPerson?.player.thirdPersonWeaponVisible).toBe(true);
  expect(thirdPerson?.player.thirdPersonWeapon).toBe('machine');
  expect(thirdPerson?.player.thirdPersonWeaponMeshes).toBeGreaterThan(0);
  expect(thirdPerson?.player.jetpacking).toBe(false);
  expect(thirdPerson?.camera.distance).toBeGreaterThan(2.5);
  expect(thirdPerson?.camera.distance).toBeLessThan(3.7);
  expect(thirdPerson?.player.modelHeight).toBeGreaterThan(1.5);
  if (!thirdPerson) throw new Error('Missing third-person diagnostics');
  const cameraOffset = {
    x: thirdPerson.camera.position.x - thirdPerson.player.position.x,
    y: thirdPerson.camera.position.y - thirdPerson.player.position.y,
    z: thirdPerson.camera.position.z - thirdPerson.player.position.z,
  };
  const rearDistance = cameraOffset.x * Math.sin(thirdPerson.player.yaw)
    + cameraOffset.z * Math.cos(thirdPerson.player.yaw);
  const shoulderDistance = cameraOffset.x * Math.cos(thirdPerson.player.yaw)
    - cameraOffset.z * Math.sin(thirdPerson.player.yaw);
  expect(rearDistance).toBeGreaterThan(1.9);
  expect(rearDistance).toBeLessThan(2.5);
  expect(shoulderDistance).toBeGreaterThan(0.5);
  expect(shoulderDistance).toBeLessThan(0.8);
  expect(cameraOffset.y).toBeGreaterThan(1.45);
  expect(cameraOffset.y).toBeLessThan(2.5);
  expect(await page.evaluate(() => document.querySelector('#view-mode-value')?.textContent)).toBe('Third person');
  const artifactDirectory = resolve('artifacts/third-person');
  await mkdir(artifactDirectory, { recursive: true });
  const machineArtifact = resolve(artifactDirectory, 'quicksense-over-shoulder-machine.png');
  const canvasBox = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  if (canvasBox) {
    const captureCanvas = async (path: string): Promise<void> => {
      if (browserName !== 'chromium') {
        await page.screenshot({ path, clip: canvasBox, animations: 'disabled' });
        return;
      }
      // CDP capture avoids Playwright's global font-ready wait. The game uses
      // local fonts, but a slow software-WebGL frame should not turn a camera
      // regression into a screenshot timeout.
      const session = await page.context().newCDPSession(page);
      const capture = await session.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
        clip: { ...canvasBox, scale: 1 },
      });
      await session.detach();
      await writeFile(path, Buffer.from(capture.data, 'base64'));
    };
    await captureCanvas(machineArtifact);

    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setWeapon('sniper'));
    await page.waitForFunction(() => (
      window.__THREE_GAME_DIAGNOSTICS__?.player.thirdPersonWeapon === 'sniper'
      && window.__THREE_GAME_DIAGNOSTICS__?.player.thirdPersonWeaponVisible === true
    ), null, { timeout: 30_000 });
    await captureCanvas(resolve(artifactDirectory, 'quicksense-over-shoulder-sniper.png'));
  } else {
    throw new Error('Game canvas did not produce a capture rectangle');
  }

  const pressViewKey = async (): Promise<void> => {
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyV', bubbles: true }));
    });
  };
  await pressViewKey();
  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.viewMode === 'first-person', null, {
    timeout: 30_000,
  });
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.player.avatarVisible)).toBe(false);
  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
});
