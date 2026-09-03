import { expect, test } from '@playwright/test';

test('Monsoon biome uses varied model families and preserves competitive clearances', async ({ page }) => {
  await page.goto('/?qa=physics&mapSeed=450600');
  await page.waitForFunction(() => (
    Boolean(window.__THREE_GAME_DIAGNOSTICS__?.map.ready)
    && Boolean(window.__THREE_GAME_TEST_HOOKS__?.getMonsoonBiomeVegetationAudit())
  ));

  const result = await page.evaluate(() => ({
    mobile: window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 600,
    audit: window.__THREE_GAME_TEST_HOOKS__!.getMonsoonBiomeVegetationAudit()!,
    render: window.__THREE_GAME_TEST_HOOKS__!.getArenaRenderAudit()
      .filter(({ material }) => material.startsWith('MonsoonBiome')),
  }));
  const { audit, render, mobile } = result;
  expect(audit.deterministic).toBe(true);
  expect(audit.vegetationConstruction).toBe('fully-procedural');
  expect(audit.familyCounts).toEqual({ boulder: 6, fern: 6, shrub: 4, tree: 6 });
  expect(audit.rockField.variantsPerArchetype).toBe(2);
  expect(audit.rockField.tierCounts.anchor).toBeGreaterThanOrEqual(50);
  expect(audit.rockField.triangles).toBeLessThanOrEqual(115000);
  expect(audit.rockField.drawCalls).toBeLessThanOrEqual(48);
  expect(audit.scannedFernSource).toBe('Project-original procedural pinnate fern geometry');
  expect(audit.scannedFernLicense).toBe('Riftline project original');
  expect(audit.scannedShrubSource).toBe('Project-original procedural tropical shrub geometry');
  expect(audit.scannedShrubLicense).toBe('Riftline project original');
  expect(audit.treeConstruction).toBe('fully-procedural');
  expect(audit.treeVariantNames).toEqual([
    'RainforestBroadleaf',
    'HighlandEmergent',
    'SpreadingKapok',
    'StormCanopyBroadleaf',
    'WindwardPalm',
    'CrownPalm',
  ]);
  expect(audit.scannedTreeSource).toBe('Project-original procedural broadleaf, emergent, and palm geometry');
  expect(audit.scannedTreeLicense).toBe('Riftline project original');
  expect(audit.densityZoneCounts).toEqual({ grass: 7, weed: 6, fern: 16, shrub: 14, tree: 14 });
  expect(audit.requestedCounts.rock).toBeGreaterThanOrEqual(1_400);
  expect(audit.requestedCounts.fern).toBeGreaterThanOrEqual(mobile ? 2_800 : 11_500);
  expect(audit.requestedCounts.shrub).toBeGreaterThanOrEqual(mobile ? 700 : 3_000);
  expect(audit.requestedCounts.tree).toBeGreaterThanOrEqual(mobile ? 350 : 1_400);
  expect(audit.visualPlantEstimate.shrub).toBeGreaterThanOrEqual(mobile ? 700 : 3_000);
  expect(audit.placedCounts.grass).toBeGreaterThan(audit.requestedCounts.grass * 0.94);
  expect(audit.placedCounts.weed).toBeGreaterThan(audit.requestedCounts.weed * 0.94);
  expect(audit.placedCounts.fern.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(audit.requestedCounts.fern * 0.94);
  expect(audit.placedCounts.shrub.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(audit.requestedCounts.shrub * 0.94);
  expect(audit.placedCounts.tree.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(audit.requestedCounts.tree * 0.94);
  expect(Math.min(...audit.placedCounts.fern.slice(0, 3))).toBeGreaterThan(mobile ? 70 : 250);
  expect(Math.min(...audit.placedCounts.fern.slice(3))).toBeGreaterThan(mobile ? 500 : 130);
  expect(audit.placedCounts.shrub).toHaveLength(4);
  expect(Math.min(...audit.placedCounts.shrub)).toBeGreaterThan(mobile ? 120 : 500);
  expect(audit.placedCounts.tree).toHaveLength(6);
  expect(Math.min(...audit.placedCounts.tree)).toBeGreaterThan(mobile ? 30 : 120);
  expect(audit.treeRepresentativePositions).toHaveLength(6);
  expect(Math.min(...audit.treeRepresentativePositions.map((positions) => positions.length))).toBe(4);

  expect(audit.routeLimits.tree).toBeLessThan(audit.routeLimits.shrub);
  expect(audit.routeLimits.shrub).toBeLessThan(audit.routeLimits.fern);
  expect(audit.routeLimits.fern).toBeLessThan(audit.routeLimits.grass);
  expect(audit.baseClearance.tree).toBeGreaterThan(audit.baseClearance.shrub);
  expect(audit.baseClearance.shrub).toBeGreaterThan(audit.baseClearance.fern);
  expect(audit.scaleRanges.fern[1] / audit.scaleRanges.fern[0]).toBeGreaterThan(4);
  expect(audit.scaleRanges.shrub[1] / audit.scaleRanges.shrub[0]).toBeGreaterThan(3);
  expect(audit.scaleRanges.tree).toEqual([9, 44]);
  expect(audit.scaleRanges.boulder[1] / audit.scaleRanges.boulder[0]).toBeGreaterThan(20);

  const materials = new Map(render.map((entry) => [entry.material, entry]));
  expect(materials.get('MonsoonBiomeRockMaterial')?.instances).toBe(audit.requestedCounts.rock);
  expect(materials.get('MonsoonBiomeFernMaterial')?.instances).toBeGreaterThan(mobile ? 2_700 : 11_000);
  expect(materials.has('MonsoonBiomeScannedFernMaterial')).toBe(false);
  expect(materials.get('MonsoonBiomeProceduralTropicalShrubMaterial')?.instances).toBeGreaterThan(mobile ? 680 : 3_000);
  expect(materials.has('MonsoonBiomeScannedShrubMaterial')).toBe(false);
  expect(render.some(({ material }) => material.startsWith('MonsoonBiomeScannedIslandTree'))).toBe(false);
  expect(materials.get('MonsoonBiomeProceduralTropicalWoodMaterial')?.instances).toBeGreaterThan(mobile ? 330 : 1_300);
  expect(materials.get('MonsoonBiomeProceduralTropicalLeafMaterial')?.instances).toBeGreaterThan(mobile ? 230 : 900);
  expect(materials.get('MonsoonBiomeProceduralPalmLeafMaterial')?.instances).toBeGreaterThan(mobile ? 70 : 300);
});
