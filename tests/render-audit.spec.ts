import { test } from '@playwright/test';

test('reports QuickSense arena submissions by material', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?map=quicksense');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));
  const audit = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.getArenaRenderAudit());
  console.log(JSON.stringify(audit, null, 2));
});
