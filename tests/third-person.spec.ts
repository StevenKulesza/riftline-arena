import { expect, test } from '@playwright/test';

test('switches to a readable third-person player presentation', async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/?map=quicksense&qa=visual');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__), null, { timeout: 30_000 });
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

  const firstPerson = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
  expect(firstPerson?.viewMode).toBe('first-person');
  expect(firstPerson?.player.avatarVisible).toBe(false);
  expect(firstPerson?.player.modelMeshCount).toBeGreaterThanOrEqual(4);

  const pressViewButton = async (): Promise<void> => {
    await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>('#view-button');
      button?.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 1,
        pointerType: 'touch',
      }));
    });
  };
  await pressViewButton();
  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.viewMode === 'third-person', null, {
    timeout: 30_000,
  });
  const thirdPerson = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__);
  expect(thirdPerson?.player.avatarVisible).toBe(true);
  expect(thirdPerson?.camera.distance).toBeGreaterThan(2.5);
  expect(thirdPerson?.player.modelHeight).toBeGreaterThan(1.5);
  expect(await page.evaluate(() => document.querySelector('#view-mode-value')?.textContent)).toBe('Third person');
  const canvasBox = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  if (canvasBox) await page.screenshot({ path: '/tmp/riftline-third-person.png', clip: canvasBox, animations: 'disabled' });

  await pressViewButton();
  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.viewMode === 'first-person', null, {
    timeout: 30_000,
  });
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.player.avatarVisible)).toBe(false);

  const pressViewKey = async (): Promise<void> => {
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyV', bubbles: true }));
    });
  };
  await pressViewKey();
  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.viewMode === 'third-person', null, {
    timeout: 30_000,
  });
  await pressViewKey();
  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.viewMode === 'first-person', null, {
    timeout: 30_000,
  });
  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
});
