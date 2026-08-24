import { expect, test } from '@playwright/test';

test('AI can bunny-hop, switch weapons, throw grenades, and grapple', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));
  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('active-play');
    const spawn = hooks.getSpawnPoints()[13];
    hooks.setCombatants(spawn, { x: spawn.x, y: spawn.y, z: spawn.z - 16 }, true, false);
    hooks.setPausedForScreenshot(true);
  });
  const { bots, distanceMoved, maxPinnedWindows } = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const initialBots = window.__THREE_GAME_DIAGNOSTICS__!.bots;
    const previous = initialBots.map((bot) => ({ ...bot.position }));
    const previousContacts = initialBots.map((bot) => bot.wallContacts + bot.ceilingContacts);
    const distanceMoved = initialBots.map(() => 0);
    const pinnedWindows = initialBots.map(() => 0);
    const maxPinnedWindows = initialBots.map(() => 0);
    for (let sample = 0; sample < 16; sample += 1) {
      hooks.stepSimulation(0.5);
      window.__THREE_GAME_DIAGNOSTICS__!.bots.forEach((bot, index) => {
        const moved = Math.hypot(
          bot.position.x - previous[index].x,
          bot.position.y - previous[index].y,
          bot.position.z - previous[index].z,
        );
        distanceMoved[index] += moved;
        const contacts = bot.wallContacts + bot.ceilingContacts;
        const contactedSurface = contacts > previousContacts[index];
        pinnedWindows[index] = contactedSurface && moved < 0.05 ? pinnedWindows[index] + 1 : 0;
        maxPinnedWindows[index] = Math.max(maxPinnedWindows[index], pinnedWindows[index]);
        previous[index] = { ...bot.position };
        previousContacts[index] = contacts;
      });
    }
    return { bots: window.__THREE_GAME_DIAGNOSTICS__!.bots, distanceMoved, maxPinnedWindows };
  });
  expect(bots.some((bot) => bot.bunnyHops > 0)).toBe(true);
  expect(bots.some((bot) => bot.weaponSwitches > 0)).toBe(true);
  expect(bots.some((bot) => bot.grenadesThrown > 0)).toBe(true);
  expect(bots.some((bot) => bot.grapplesUsed > 0)).toBe(true);
  expect(distanceMoved.every((distance) => distance > 3), 'every bot must keep making traversal progress').toBe(true);
  expect(maxPinnedWindows.every((windows) => windows <= 2), 'no bot may remain pinned to a wall/ceiling for over one second').toBe(true);
  expect(bots.every((bot) => Object.values(bot.position).every(Number.isFinite))).toBe(true);
});
