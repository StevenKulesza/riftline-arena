import { expect, test } from '@playwright/test';

const MAPS = [
  { name: 'Monsoon Divide', profile: 'monsoon', query: '' },
  { name: 'QuickSense', profile: 'quicksense', query: '&map=quicksense' },
] as const;

for (const map of MAPS) {
  test(`${map.name} installs the authored map light and grounded shadow stack`, async ({ page }) => {
    await page.goto(`/?qa=physics${map.query}`);
    await page.waitForFunction(() => Boolean(window.__THREE_GAME_DIAGNOSTICS__?.lighting));
    const lighting = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.lighting);

    expect(lighting.profile).toBe(map.profile);
    expect(lighting.key.intensity).toBeGreaterThanOrEqual(3);
    expect(lighting.fillIntensity).toBeGreaterThan(0);
    expect(lighting.rimIntensity).toBeGreaterThan(0);
    expect(lighting.environmentIntensity).toBeGreaterThan(0.5);
    expect(lighting.shadow.type).toBe('VSMShadowMap');
    expect([1024, 2048]).toContain(lighting.shadow.mapSize);
    expect([4, 8]).toContain(lighting.shadow.blurSamples);
    expect(lighting.shadow.casters).toBeGreaterThan(0);
    expect(lighting.shadow.receivers).toBeGreaterThan(0);
    expect(lighting.contactShadows.sources).toBeGreaterThanOrEqual(7);
    expect(lighting.contactShadows.drawCalls).toBe(1);
  });
}
