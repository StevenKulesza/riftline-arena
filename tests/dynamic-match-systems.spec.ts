import { expect, test } from '@playwright/test';

async function openDeterministicMatch(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/?qa=physics&mapSeed=450600', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__ && window.__THREE_GAME_DIAGNOSTICS__));
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('active-play'));
}

test('core relocation timeline, bot identities, HUD standings, and weather stay synchronized', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'Deterministic integration is checked once on desktop.');
  await openDeterministicMatch(page);

  const opening = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);
  expect(opening.core.phase).toBe('telegraph');
  expect(opening.core.nextLocation).toBe('RIFT NEXUS');
  expect(opening.bots.map((bot) => bot.displayName)).toEqual(['VIPER', 'BASTION', 'SLIPSTREAM']);
  expect(opening.bots.map((bot) => bot.archetype)).toEqual(['hunter', 'anchor', 'runner']);

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(6.1));
  const activeCore = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.core);
  expect(activeCore).toMatchObject({ phase: 'active', active: true, location: 'RIFT NEXUS', cycle: 1 });

  await expect.poll(() => page.locator('.standing-callsign').allTextContents()).toEqual([
    'RIFT-01', 'VIPER', 'BASTION', 'SLIPSTREAM',
  ]);
  await expect(page.locator('#core-location')).toHaveText('RIFT NEXUS');

  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(30);
    window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(6);
  });
  const warning = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.weather);
  expect(warning.phase).toBe('warning');
  expect(warning.label).toContain('MONSOON WARNING');

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(8));
  const monsoon = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.weather);
  expect(monsoon.phase).toBe('monsoon');
  expect(monsoon.multipliers.airControlMultiplier).toBeLessThan(1);
  expect(monsoon.multipliers.visibilityMultiplier).toBeLessThan(1);
  expect(monsoon.visuals.source).toBe('gameplay');
  await expect(page.locator('#weather-slot')).toBeVisible();
  await expect(page.locator('#weather-phase')).toHaveText('MONSOON');
});

test('a real long-range elimination feeds style diagnostics and HUD without changing its score rules', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'Deterministic integration is checked once on desktop.');
  await openDeterministicMatch(page);

  const result = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const points = hooks.getSpawnPoints();
    let pair: [typeof points[number], typeof points[number]] | null = null;
    for (const player of points) {
      for (const bot of points) {
        const distance = Math.hypot(player.x - bot.x, player.y - bot.y, player.z - bot.z);
        if (distance < 40 || distance > 145) continue;
        const playerEye = { x: player.x, y: player.y + 0.96, z: player.z };
        const botCenter = { x: bot.x, y: bot.y + 0.9, z: bot.z };
        if (hooks.sampleLineOfSight(playerEye, botCenter)) {
          pair = [player, bot];
          break;
        }
      }
      if (pair) break;
    }
    if (!pair) throw new Error('No clear long-range spawn pair was available.');

    const [player, bot] = pair;
    hooks.setCombatants(player, bot, true, true);
    const dx = bot.x - player.x;
    const dy = bot.y + 0.9 - (player.y + 0.96);
    const dz = bot.z - player.z;
    const length = Math.hypot(dx, dy, dz);
    hooks.setAim(Math.atan2(-dx, -dz), Math.asin(dy / length));
    hooks.setWeapon('rail');
    hooks.setAmmo('rail', 3);
    hooks.fireWeapon();
    hooks.fireWeapon();
    return {
      score: window.__THREE_GAME_DIAGNOSTICS__!.score,
      style: window.__THREE_GAME_DIAGNOSTICS__!.style,
    };
  });

  expect(result.score).toBe(1);
  expect(result.style.meter).toBeGreaterThan(0);
  expect(result.style.lastMedal).toBe('LONGSHOT');
  await expect(page.locator('#style-slot')).toBeVisible();
  await expect(page.locator('#style-medal')).toHaveText('LONGSHOT');
});
