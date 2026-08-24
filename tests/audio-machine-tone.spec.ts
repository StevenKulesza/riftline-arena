import { expect, test } from '@playwright/test';

test('machine gun uses the warmer weapon-only tone chain', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const AudioContextClass = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const original = AudioContextClass.prototype.createBiquadFilter;
    const nodes: BiquadFilterNode[] = [];
    (window as unknown as { __RIFTLINE_AUDIO_FILTERS__: BiquadFilterNode[] }).__RIFTLINE_AUDIO_FILTERS__ = nodes;
    AudioContextClass.prototype.createBiquadFilter = function createTrackedBiquadFilter(): BiquadFilterNode {
      const node = original.call(this);
      nodes.push(node);
      return node;
    };
  });
  await page.route('**/assets/audio/**', (route) => {
    if (route.request().url().includes('/weapons/machine-fire-')) void route.continue();
    else void route.fulfill({ status: 404, body: '' });
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));
  await page.locator('#start-button').click();
  await expect.poll(
    () => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.audio.unlocked),
    { timeout: 60_000 },
  ).toBe(true);
  await expect.poll(
    () => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.audio.loading),
    { timeout: 60_000 },
  ).toBe(false);
  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__!.setState('combat');
    window.__THREE_GAME_TEST_HOOKS__!.fireWeapon();
  });
  await expect.poll(() => page.evaluate(
    () => window.__THREE_GAME_DIAGNOSTICS__?.audio.playCounts['weapon.machine'] ?? 0,
  )).toBeGreaterThan(0);
  const filters = await page.evaluate(() => {
    const nodes = (window as unknown as { __RIFTLINE_AUDIO_FILTERS__: BiquadFilterNode[] }).__RIFTLINE_AUDIO_FILTERS__;
    return nodes.map((node) => ({
      type: node.type,
      frequency: node.frequency.value,
      gain: node.gain.value,
    }));
  });
  expect(filters).toEqual([
    { type: 'lowshelf', frequency: 240, gain: 2.5 },
    { type: 'peaking', frequency: 3_100, gain: -4.5 },
    { type: 'lowpass', frequency: 6_200, gain: 0 },
  ]);
});
