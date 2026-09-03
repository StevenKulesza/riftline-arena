import { expect, test } from '@playwright/test';

test('Bipbeta2 loads as a large procedural fast-movement arena', async ({ page }) => {
  await page.goto('/?map=bipbeta2&qa=physics');
  await page.waitForFunction(() => (
    Boolean(window.__THREE_GAME_TEST_HOOKS__)
    && window.__THREE_GAME_DIAGNOSTICS__?.map.name === 'Bipbeta2'
    && Boolean(window.__THREE_GAME_DIAGNOSTICS__?.map.ready)
  ), null, { timeout: 180_000 });

  const result = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    const spawns = hooks.getSpawnPoints();
    const flow = hooks.getMovementFlow() as {
      primaryJumpers: number;
      nodes: Array<{ kind: string; speedTarget?: number }>;
    };
    return {
      map: window.__THREE_GAME_DIAGNOSTICS__!.map,
      pads: hooks.getJumpPads(),
      flow,
      floors: [[0, 0], [0, -52], [-100, 0], [100, 0]].map(([x, z]) => hooks.sampleFloorHeight(x, z, Infinity)),
      spawnContacts: spawns.map((spawn) => hooks.sampleCapsulePlacement({
        x: spawn.x,
        y: spawn.y + 0.2,
        z: spawn.z,
      })),
    };
  });

  expect(result.map.name).toBe('Bipbeta2');
  expect(result.map.bounds).toEqual({ width: 240, depth: 192 });
  expect(result.map.spawnCount).toBe(12);
  expect(result.map.jumpPadCount).toBe(2);
  expect(result.flow.primaryJumpers).toBe(2);
  expect(result.flow.nodes.filter((node) => node.kind === 'tube')).toHaveLength(2);
  expect(result.flow.nodes.filter((node) => node.kind === 'tube').every((node) => node.speedTarget === 1800)).toBe(true);
  expect(result.map.skiRoutes).toBeGreaterThanOrEqual(8);
  expect(result.map.altitudeRange.max).toBeGreaterThanOrEqual(16);
  expect(result.map.renderTriangles).toBeLessThan(12_000);
  expect(result.floors).toEqual([12.95, 7, 0, 0]);
  expect(result.pads.every((pad) => pad.launchSpeed >= 20)).toBe(true);
  expect(result.spawnContacts.every((contact) => contact.grounded && !contact.wallContact)).toBe(true);
});
