import { mkdir } from 'node:fs/promises';
import { test } from '@playwright/test';

test.skip('manual artifact capture: every authored CA spawn sightline', async ({ page }) => {
  test.setTimeout(120_000);
  await mkdir('artifacts/wca1-spawns', { recursive: true });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__), null, { timeout: 30_000 });

  for (let index = 0; index < 14; index += 1) {
    await page.evaluate((spawnIndex) => {
      window.__THREE_GAME_TEST_HOOKS__?.setState(`view-${spawnIndex}`);
    }, index);
    await page.waitForTimeout(120);
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot(true));
    await page.locator('#game-canvas').screenshot({
      path: `artifacts/wca1-spawns/view-${String(index).padStart(2, '0')}.png`,
    });
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot(false));
  }
});
