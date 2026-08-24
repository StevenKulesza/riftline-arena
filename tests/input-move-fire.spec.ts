import { expect, test } from '@playwright/test';

test('keeps WASD movement while left-click firing', async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10);
  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__?.setState('active-play');
  });
  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.state === 'running');

  const canvas = page.locator('#game-canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(120);

  // Pointer-lock / click transitions used to blur the window and clear held keys.
  await page.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);

  const mid = await page.evaluate(() => {
    const diagnostics = window.__THREE_GAME_DIAGNOSTICS__;
    return {
      speed: diagnostics?.player.speed ?? 0,
      state: diagnostics?.state,
      weapon: diagnostics?.weapon,
    };
  });

  await page.mouse.up();
  await page.keyboard.up('KeyW');

  expect(mid.state).toBe('running');
  expect(mid.speed, 'WASD must remain active while mouse fire is held').toBeGreaterThan(2);
  expect(pageErrors).toEqual([]);
});
