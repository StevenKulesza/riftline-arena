import { expect, test, type Page } from '@playwright/test';

const TEST_SEED = 450_600;

async function prepareDeterministicScreenshot(
  page: Page,
  stateName: 'active-play' | 'fail',
): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#game-canvas')).toBeVisible();
  await page.waitForFunction(
    () => Boolean(window.__THREE_GAME_TEST_HOOKS__),
    null,
    { timeout: 180_000 },
  );

  await page.evaluate(async ({ seed, state }) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    if (!hooks) {
      throw new Error(
        'Riftline deterministic hooks are missing: seed/setState/setPausedForScreenshot/'
        + 'setReducedMotion/hideDebugUi are required for visual baselines.',
      );
    }
    hooks.seed(seed);
    hooks.setReducedMotion(true);
    hooks.hideDebugUi(true);
    hooks.setState(state);
    hooks.setPausedForScreenshot(true);
    await document.fonts.ready;
  }, { seed: TEST_SEED, state: stateName });

  const expectedState = stateName === 'fail' ? 'respawning' : 'running';
  await page.waitForFunction(
    (state) => window.__THREE_GAME_DIAGNOSTICS__?.state === state,
    expectedState,
  );
  await page.waitForFunction(() => {
    const diagnostics = window.__THREE_GAME_DIAGNOSTICS__;
    return Boolean(
      diagnostics
      && diagnostics.canvas.clientWidth > 0
      && diagnostics.canvas.clientHeight > 0
      && diagnostics.renderer.calls > 0,
    );
  });
  await page.waitForTimeout(100);
}

test('active-play desktop visual baseline', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'Desktop baseline belongs to the desktop project.');
  await prepareDeterministicScreenshot(page, 'active-play');
  await expect(page.locator('#start-overlay')).toBeHidden();
  await expect(page.locator('#touch-controls')).toBeHidden();
  await expect(page).toHaveScreenshot('active-play-desktop.png', {
    fullPage: true,
    animations: 'disabled',
    mask: [page.locator('#fps-value')],
    maskColor: '#070b15',
    threshold: 0.2,
    maxDiffPixelRatio: 0.012,
  });
});

test('active-play mobile visual baseline', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-safari', 'Mobile baseline belongs to the mobile project.');
  await prepareDeterministicScreenshot(page, 'active-play');
  await expect(page.locator('#start-overlay')).toBeHidden();
  await expect(page.locator('#touch-controls')).toBeVisible();
  await expect(page.locator('#jump-button')).toBeVisible();
  await expect(page.locator('#ski-button')).toBeVisible();
  await expect(page.locator('#fire-button')).toBeVisible();
  await expect(page).toHaveScreenshot('active-play-mobile.png', {
    fullPage: true,
    animations: 'disabled',
    mask: [page.locator('#fps-value')],
    maskColor: '#070b15',
    threshold: 0.2,
    maxDiffPixelRatio: 0.015,
  });
});

test('fail and redeploy visual baseline', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'The fail-state baseline is captured once on desktop.');
  await prepareDeterministicScreenshot(page, 'fail');
  await expect(page.locator('#respawn-overlay')).toBeVisible();
  await expect(page.locator('#respawn-text')).toContainText('TEST STATE');
  await expect(page).toHaveScreenshot('fail-desktop.png', {
    fullPage: true,
    animations: 'disabled',
    mask: [page.locator('#fps-value')],
    maskColor: '#070b15',
    threshold: 0.2,
    maxDiffPixelRatio: 0.01,
  });
});
