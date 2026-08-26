import { expect, test, type Page } from '@playwright/test';

async function openHud(page: Page): Promise<void> {
  // This suite verifies the authored DOM and responsive CSS in isolation; the
  // full game suites cover the asset-heavy Three.js boot and state integration.
  await page.route('**/src/main.ts', (route) => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.route('**/src/menu.ts', (route) => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#game-canvas')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Combatant standings' })).toBeVisible();
  await expect(page.locator('.match-ribbon')).toHaveCount(1);
  await expect(page.locator('.objective-cluster')).toHaveCount(1);
}

test('competitive HUD exposes standings and objective semantics', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'DOM contract is checked once on desktop.');
  await openHud(page);

  const standings = page.getByRole('region', { name: 'Combatant standings' });
  const standingsContract = await standings.evaluate((node) => ({
    rows: node.querySelectorAll('[data-standing-slot]').length,
    callsigns: node.querySelectorAll('.standing-callsign').length,
    scores: node.querySelectorAll('.standing-score').length,
    players: node.querySelectorAll('.is-player').length,
    leaders: node.querySelectorAll('.is-leader').length,
  }));
  expect(standingsContract).toEqual({ rows: 4, callsigns: 4, scores: 4, players: 1, leaders: 1 });

  const objective = page.getByRole('region', { name: 'Flux Core objective' });
  await expect(objective.locator('#core-location')).toHaveText('RIFT NEXUS');
  await expect(objective.locator('#core-phase')).not.toBeEmpty();
  await expect(objective.locator('#core-status')).not.toBeEmpty();
  await expect(objective.locator('#objective-event')).toContainText(/\d{2}:\d{2}|--:--/);
  await expect(page.getByRole('progressbar', { name: 'Flux Core capture progress' })).toHaveAttribute('aria-valuenow', /\d+/);

  await expect(page.locator('#arena-context')).toHaveAttribute('hidden', '');
  await expect(page.locator('#style-slot')).toHaveAttribute('hidden', '');
  await expect(page.locator('#weather-slot')).toHaveAttribute('hidden', '');
});

test('desktop keeps four fixed-width standings and both optional feedback slots available', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'Desktop layout belongs to the desktop project.');
  await openHud(page);

  const visibleRows = await page.locator('[data-standing-slot]').evaluateAll((rows) => rows.filter((row) => getComputedStyle(row).display !== 'none').length);
  expect(visibleRows).toBe(4);

  const feedbackDisplay = await page.evaluate(() => {
    const context = document.querySelector<HTMLElement>('#arena-context')!;
    const style = document.querySelector<HTMLElement>('#style-slot')!;
    const weather = document.querySelector<HTMLElement>('#weather-slot')!;
    context.hidden = false;
    style.hidden = false;
    weather.hidden = false;
    return {
      style: getComputedStyle(style).display,
      weather: getComputedStyle(weather).display,
      scoreNumerals: getComputedStyle(document.querySelector<HTMLElement>('.standing-score')!).fontVariantNumeric,
    };
  });

  expect(feedbackDisplay.style).not.toBe('none');
  expect(feedbackDisplay.weather).not.toBe('none');
  expect(feedbackDisplay.scoreNumerals).toContain('tabular-nums');
});

test('mobile collapses standings and keeps new HUD clusters above touch controls', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-safari', 'Mobile layout belongs to the mobile project.');
  await openHud(page);

  await expect(page.locator('#touch-controls')).toBeVisible();
  const layout = await page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>('[data-standing-slot]')];
    const standings = document.querySelector<HTMLElement>('.standings-strip')!;
    const objective = document.querySelector<HTMLElement>('.objective-cluster')!;
    const controls = document.querySelector<HTMLElement>('#touch-controls')!;
    const crosshair = document.querySelector<HTMLElement>('#crosshair')!;
    const context = document.querySelector<HTMLElement>('#arena-context')!;
    const style = document.querySelector<HTMLElement>('#style-slot')!;
    const weather = document.querySelector<HTMLElement>('#weather-slot')!;
    context.hidden = false;
    style.hidden = false;
    weather.hidden = false;

    return {
      visibleRows: rows.filter((row) => getComputedStyle(row).display !== 'none').length,
      styleDisplay: getComputedStyle(style).display,
      weatherDisplay: getComputedStyle(weather).display,
      hudBottom: Math.max(standings.getBoundingClientRect().bottom, objective.getBoundingClientRect().bottom),
      controlsTop: controls.getBoundingClientRect().top,
      crosshairTop: crosshair.getBoundingClientRect().top,
    };
  });

  expect(layout.visibleRows).toBe(2);
  expect(layout.styleDisplay).not.toBe('none');
  expect(layout.weatherDisplay).toBe('none');
  expect(layout.hudBottom).toBeLessThan(layout.crosshairTop);
  expect(layout.hudBottom).toBeLessThan(layout.controlsTop);
});
