import { expect, test } from '@playwright/test';

test('keeps mouse look while WASD is held', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('active-play'));
  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.state === 'running');

  const before = await page.evaluate(() => ({
    yaw: window.__THREE_GAME_DIAGNOSTICS__?.player.yaw ?? 0,
    pitch: window.__THREE_GAME_DIAGNOSTICS__?.player.pitch ?? 0,
  }));

  await page.keyboard.down('KeyW');

  // Dispatch drag-look events in-page. Playwright's mouse.move can hang under pointer lock.
  await page.evaluate(() => {
    const canvas = document.querySelector('#game-canvas');
    if (!canvas) throw new Error('missing canvas');
    canvas.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, clientX: 400, clientY: 300 }),
    );
    for (let step = 1; step <= 12; step += 1) {
      canvas.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          button: 0,
          buttons: 1,
          clientX: 400 + step * 14,
          clientY: 300 + step * 5,
          movementX: 14,
          movementY: 5,
        }),
      );
    }
  });

  await page.waitForTimeout(150);

  const after = await page.evaluate(() => ({
    yaw: window.__THREE_GAME_DIAGNOSTICS__?.player.yaw ?? 0,
    pitch: window.__THREE_GAME_DIAGNOSTICS__?.player.pitch ?? 0,
    speed: window.__THREE_GAME_DIAGNOSTICS__?.player.speed ?? 0,
    state: window.__THREE_GAME_DIAGNOSTICS__?.state,
  }));

  await page.keyboard.up('KeyW');

  expect(after.state).toBe('running');
  expect(after.speed, 'WASD must remain active while aiming').toBeGreaterThan(1);
  expect(Math.abs(after.yaw - before.yaw) + Math.abs(after.pitch - before.pitch)).toBeGreaterThan(0.05);
  expect(pageErrors).toEqual([]);
});
