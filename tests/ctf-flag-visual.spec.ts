import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';

const captures = [
  { map: 'quicksense', file: 'ctf-shared-model-quicksense-v2.jpg' },
  { map: 'monsoon', file: 'ctf-shared-model-monsoon-v2.jpg' },
] as const;

for (const capture of captures) {
  test(`shared CTF flag model is visibly identical on ${capture.map}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', 'Objective evidence is captured once on desktop.');
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(
      `/?mode=ctf&map=${capture.map}&mapSeed=450600&qa=capture&qaState=ctf-flag-comparison&state=ctf-flag-comparison`,
      { waitUntil: 'domcontentloaded' },
    );
    await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__ && window.__THREE_GAME_DIAGNOSTICS__), null, {
      timeout: 90_000,
    });
    await page.waitForFunction(() => (
      window.__THREE_GAME_DIAGNOSTICS__?.state === 'running'
      && window.__THREE_GAME_DIAGNOSTICS__.flags.length === 2
    ));

    const flags = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.flags);
    expect(new Set(flags.map((flag) => flag.modelId))).toEqual(new Set(['riftline-ctf-standard-v2']));
    expect(new Set(flags.map((flag) => flag.geometrySignature))).toEqual(new Set([
      'cloth-11x7-1.34x0.76|pole-3.04|plinth-1.08-v2',
    ]));
    expect(flags[0].physics.clothVertices).toBe(flags[1].physics.clothVertices);
    expect(flags[0].physics.clothConstraints).toBe(flags[1].physics.clothConstraints);
    expect(flags[0].physics.maxClothDeflection).toBeCloseTo(flags[1].physics.maxClothDeflection, 8);

    const canvasBox = await page.locator('#game-canvas').boundingBox();
    expect(canvasBox).not.toBeNull();
    await page.screenshot({
      path: resolve('gauntlet/shots/8v8-objectives', capture.file),
      clip: canvasBox!,
      type: 'jpeg',
      quality: 93,
      animations: 'disabled',
    });
  });
}
