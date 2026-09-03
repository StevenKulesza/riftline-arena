import { expect, test } from '@playwright/test';

test('Monsoon biome uses varied model families and preserves competitive clearances', async ({ page }) => {
  await page.goto('/?qa=physics&mapSeed=450600');
  await page.waitForFunction(() => (
    Boolean(window.__THREE_GAME_DIAGNOSTICS__?.map.ready)
    && Boolean(window.__THREE_GAME_TEST_HOOKS__?.getMonsoonBiomeVegetationAudit())
  ));

  const result = await page.evaluate(() => ({
    audit: window.__THREE_GAME_TEST_HOOKS__!.getMonsoonBiomeVegetationAudit()!,
    render: window.__THREE_GAME_TEST_HOOKS__!.getArenaRenderAudit()
      .filter(({ material }) => material.startsWith('MonsoonBiome')),
  }));
  const { audit, render } = result;
  expect(audit.deterministic).toBe(true);
  expect(audit.familyCounts).toEqual({ boulder: 3, fern: 3, shrub: 2, tree: 3 });
  expect(audit.densityZoneCounts).toEqual({ grass: 7, weed: 6, fern: 7, shrub: 6, tree: 6 });
  expect(audit.requestedCounts.rock).toBeGreaterThanOrEqual(700);
  expect(audit.requestedCounts.fern).toBeGreaterThanOrEqual(4_000);
  expect(audit.requestedCounts.shrub).toBeGreaterThanOrEqual(1_000);
  expect(audit.requestedCounts.tree).toBeGreaterThanOrEqual(280);
  expect(audit.placedCounts.grass).toBeGreaterThan(audit.requestedCounts.grass * 0.94);
  expect(audit.placedCounts.weed).toBeGreaterThan(audit.requestedCounts.weed * 0.94);
  expect(audit.placedCounts.fern.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(audit.requestedCounts.fern * 0.94);
  expect(audit.placedCounts.shrub.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(audit.requestedCounts.shrub * 0.94);
  expect(audit.placedCounts.tree.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(audit.requestedCounts.tree * 0.94);
  expect(Math.min(...audit.placedCounts.fern)).toBeGreaterThan(800);
  expect(Math.min(...audit.placedCounts.shrub)).toBeGreaterThan(350);
  expect(Math.min(...audit.placedCounts.tree)).toBeGreaterThan(45);

  expect(audit.routeLimits.tree).toBeLessThan(audit.routeLimits.shrub);
  expect(audit.routeLimits.shrub).toBeLessThan(audit.routeLimits.fern);
  expect(audit.routeLimits.fern).toBeLessThan(audit.routeLimits.grass);
  expect(audit.baseClearance.tree).toBeGreaterThan(audit.baseClearance.shrub);
  expect(audit.baseClearance.shrub).toBeGreaterThan(audit.baseClearance.fern);
  expect(audit.scaleRanges.fern[1] / audit.scaleRanges.fern[0]).toBeGreaterThan(4);
  expect(audit.scaleRanges.shrub[1] / audit.scaleRanges.shrub[0]).toBeGreaterThan(3);
  expect(audit.scaleRanges.boulder[1] / audit.scaleRanges.boulder[0]).toBeGreaterThan(20);

  const materials = new Map(render.map((entry) => [entry.material, entry]));
  expect(materials.get('MonsoonBiomeRockMaterial')?.instances).toBe(audit.requestedCounts.rock);
  expect(materials.get('MonsoonBiomeFernMaterial')?.instances).toBeGreaterThan(4_000);
  expect(materials.get('MonsoonBiomeShrubMaterial')?.instances).toBeGreaterThan(1_000);
  expect(materials.get('MonsoonBiomeTreeMaterial')?.instances).toBeGreaterThan(280);
});
