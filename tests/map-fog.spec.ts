import { expect, test } from '@playwright/test';

const MAPS = [
  {
    name: 'Monsoon Divide',
    query: '',
    color: '#86a2aa',
    near: 920,
    far: 5200,
  },
  {
    name: 'QuickSense',
    query: '&map=quicksense',
    color: '#c9b99d',
    near: 210,
    far: 1120,
  },
] as const;

for (const map of MAPS) {
  test(`${map.name} uses subtle map-toned linear distance fog`, async ({ page }) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto(`/?qa=physics${map.query}`, { waitUntil: 'commit' });
    await page.waitForFunction(() => Boolean(window.__THREE_GAME_DIAGNOSTICS__?.fog));
    const result = await page.evaluate(() => ({
      fog: window.__THREE_GAME_DIAGNOSTICS__!.fog,
      map: window.__THREE_GAME_DIAGNOSTICS__!.map.name,
    }));

    expect(result.map).toBe(map.name);
    expect(result.fog).toEqual({
      type: 'linear',
      color: map.color,
      near: map.near,
      far: map.far,
    });
    expect(result.fog!.near).toBeGreaterThanOrEqual(100);
    expect(result.fog!.far).toBeGreaterThan(result.fog!.near * 4);
    expect(result.fog!.far).toBeLessThan(map.name === 'Monsoon Divide' ? 5_300 : 1_400);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
}
