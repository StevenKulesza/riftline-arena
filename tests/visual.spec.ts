import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

const TEST_SEED = 450_600;

type CanvasSample = {
  ok: boolean;
  reason: string;
  variance?: number;
  colorBuckets?: number;
};

function collectRuntimeErrors(page: Page): { consoleErrors: string[]; pageErrors: string[] } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  return { consoleErrors, pageErrors };
}

async function enterDeterministicActivePlay(page: Page): Promise<void> {
  await page.goto('/?map=quicksense&qa=visual');
  await expect(page.locator('#game-canvas')).toBeVisible();
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10);

  await page.evaluate((seed) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    if (!hooks) throw new Error('Riftline test hooks are unavailable.');
    hooks.seed(seed);
    hooks.setReducedMotion(true);
    hooks.hideDebugUi(true);
    hooks.setPausedForScreenshot(false);
    hooks.setState('active-play');
  }, TEST_SEED);

  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.state === 'running');
}

async function sampleCanvas(page: Page): Promise<CanvasSample> {
  const box = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  if (!box || box.width < 32 || box.height < 32) {
    return { ok: false, reason: 'canvas-too-small' };
  }

  // Locator screenshots wait for layout stability, which a continuously
  // rendering WebGL canvas never reaches under SwiftShader. A clipped page
  // capture samples the same pixels without that animation-stability gate.
  const buffer = await page.screenshot({ clip: box, animations: 'disabled' });
  const png = PNG.sync.read(buffer);
  let min = 255;
  let max = 0;
  let alphaPixels = 0;
  const buckets = new Set<string>();
  const stride = Math.max(1, Math.floor((png.width * png.height) / 4096));

  for (let pixel = 0; pixel < png.width * png.height; pixel += stride) {
    const offset = pixel * 4;
    const r = png.data[offset];
    const g = png.data[offset + 1];
    const b = png.data[offset + 2];
    const a = png.data[offset + 3];
    min = Math.min(min, r, g, b);
    max = Math.max(max, r, g, b);
    if (a > 0) alphaPixels += 1;
    buckets.add(`${r >> 4},${g >> 4},${b >> 4},${a >> 6}`);
  }

  const variance = max - min;
  return {
    ok: alphaPixels > 256 && variance > 12 && buckets.size > 8,
    reason: 'sampled',
    variance,
    colorBuckets: buckets.size,
  };
}

async function dragTouchStick(page: Page): Promise<void> {
  const stick = page.locator('#touch-stick');
  const knob = page.locator('#touch-knob');
  const box = await stick.boundingBox();
  expect(box, 'touch joystick must have a rendered hit area').not.toBeNull();
  if (!box) return;

  const pointerId = 41;
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const targetX = centerX + box.width * 0.34;
  const targetY = centerY - box.height * 0.34;

  await stick.dispatchEvent('pointerdown', {
    pointerId,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: centerX,
    clientY: centerY,
  });
  await stick.dispatchEvent('pointermove', {
    pointerId,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: targetX,
    clientY: targetY,
  });

  await expect(knob).not.toHaveCSS('transform', 'none');
  await page.waitForTimeout(550);
  await stick.dispatchEvent('pointerup', {
    pointerId,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    buttons: 0,
    clientX: targetX,
    clientY: targetY,
  });
}

test('renders a nonblank, responsive Riftline active-play canvas', async ({ page }, testInfo) => {
  // Screenshot readback is intentionally exercised here and can be slow under
  // Playwright's software WebGL fallback on CI hosts without a GPU.
  test.setTimeout(120_000);
  const errors = collectRuntimeErrors(page);
  await enterDeterministicActivePlay(page);

  const diagnostics = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
  expect(diagnostics, 'Riftline diagnostics must be published').toBeDefined();
  expect(diagnostics).toMatchObject({
    state: 'running',
    complete: false,
    targetScore: 20,
    weapon: 'machine',
    physics: {
      engine: 'fixed-step-capsule-heightfield-bvh',
      timestep: 1 / 120,
    },
  });
  expect(diagnostics?.health).toBeGreaterThan(0);
  expect(diagnostics?.botsAlive).toBeGreaterThan(0);
  expect(diagnostics?.renderer.calls).toBeGreaterThan(0);
  expect(diagnostics?.renderer.triangles).toBeGreaterThan(1_000);
  expect(diagnostics?.canvas.clientWidth).toBeGreaterThanOrEqual(320);
  expect(diagnostics?.canvas.clientHeight).toBeGreaterThanOrEqual(568);
  const renderDpr = diagnostics?.canvas.dpr ?? 0;
  expect(renderDpr).toBeGreaterThanOrEqual(0.24);
  expect(diagnostics?.canvas.width).toBeGreaterThanOrEqual(
    Math.floor((diagnostics?.canvas.clientWidth ?? Number.MAX_SAFE_INTEGER) * renderDpr) - 1,
  );
  expect(diagnostics?.canvas.height).toBeGreaterThanOrEqual(
    Math.floor((diagnostics?.canvas.clientHeight ?? Number.MAX_SAFE_INTEGER) * renderDpr) - 1,
  );
  expect(diagnostics?.canvas.dpr).toBeLessThanOrEqual(1.75);

  const sample = await sampleCanvas(page);
  expect(sample, JSON.stringify(sample)).toMatchObject({ ok: true });

  const before = await page.evaluate(() => ({
    x: window.__THREE_GAME_DIAGNOSTICS__?.player.position.x ?? 0,
    z: window.__THREE_GAME_DIAGNOSTICS__?.player.position.z ?? 0,
  }));

  let movementAfter: { x: number; z: number } | undefined;
  if (testInfo.project.name === 'mobile-safari') {
    await expect(page.locator('#touch-controls')).toBeVisible();
    await expect(page.locator('#touch-stick')).toBeVisible();
    await expect(page.locator('#jump-button')).toBeVisible();
    await expect(page.locator('#ski-button')).toBeVisible();
    await expect(page.locator('#fire-button')).toBeVisible();
    await dragTouchStick(page);
    movementAfter = await page.evaluate(() => ({
      x: window.__THREE_GAME_DIAGNOSTICS__?.player.position.x ?? 0,
      z: window.__THREE_GAME_DIAGNOSTICS__?.player.position.z ?? 0,
    }));

    const ski = page.locator('#ski-button');
    await ski.dispatchEvent('pointerdown', { pointerId: 42, pointerType: 'touch', buttons: 1 });
    await expect.poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.player.skiing)).toBe(true);
    await ski.dispatchEvent('pointerup', { pointerId: 42, pointerType: 'touch', buttons: 0 });
    await expect.poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.player.skiing)).toBe(false);

    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('active-play'));
    await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.player.grounded === true);
    await page.locator('#jump-button').dispatchEvent('pointerdown', {
      pointerId: 43,
      pointerType: 'touch',
      buttons: 1,
    });
    await expect
      .poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.player.velocity.y ?? 0))
      .toBeGreaterThan(2);
  } else {
    await expect(page.locator('#touch-controls')).toBeHidden();
    const canvas = page.locator('#game-canvas');
    await canvas.dispatchEvent('pointerdown', {
      pointerId: 91,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: 640,
      clientY: 360,
    });
    await canvas.dispatchEvent('pointerup', {
      pointerId: 91,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 0,
      clientX: 640,
      clientY: 360,
    });
    await page.waitForTimeout(50);
    const yawBefore = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.player.yaw ?? 0);
    await page.keyboard.down('KeyD');
    await page.evaluate(() => {
      const move = new MouseEvent('mousemove', {
        bubbles: true,
        buttons: 0,
        clientX: 704,
        clientY: 344,
      });
      Object.defineProperty(move, 'movementX', { value: 64 });
      Object.defineProperty(move, 'movementY', { value: -16 });
      document.dispatchEvent(move);
    });
    await page.waitForTimeout(550);
    await page.keyboard.up('KeyD');
    const yawAfter = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.player.yaw ?? 0);
    expect(Math.abs(yawAfter - yawBefore), 'mouse aim must remain active while WASD is held').toBeGreaterThan(0.04);
  }

  const after = movementAfter ?? await page.evaluate(() => ({
    x: window.__THREE_GAME_DIAGNOSTICS__?.player.position.x ?? 0,
    z: window.__THREE_GAME_DIAGNOSTICS__?.player.position.z ?? 0,
  }));
  expect(Math.hypot(after.x - before.x, after.z - before.z), 'player input must move the combat frame').toBeGreaterThan(1);

  const screenshot = await page.screenshot({ fullPage: true });
  await testInfo.attach(`${testInfo.project.name}-active-play-smoke`, {
    body: screenshot,
    contentType: 'image/png',
  });

  expect(errors.consoleErrors, 'console errors during active play').toEqual([]);
  expect(errors.pageErrors, 'page errors during active play').toEqual([]);
});
