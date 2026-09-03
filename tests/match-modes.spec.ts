import { expect, test } from '@playwright/test';

const modes = [
  { id: 'tdm', label: 'TEAM DEATHMATCH', bots: 15, azure: 8, crimson: 8, target: 20 },
  { id: 'ctf', label: 'CAPTURE THE FLAG', bots: 15, azure: 8, crimson: 8, target: 3 },
  { id: 'raid', label: 'RAID', bots: 15, azure: 8, crimson: 8, target: 3 },
] as const;

for (const mode of modes) {
  test(`${mode.id} provisions its ${mode.azure}v${mode.crimson ? mode.crimson : 'AI'} roster and objective`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', 'Deterministic mode integration is checked once on desktop.');
    await page.goto(`/?mode=${mode.id}&qa=physics&mapSeed=450600`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__ && window.__THREE_GAME_DIAGNOSTICS__));

    const opening = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);
    expect(opening.matchMode).toBe(mode.id);
    expect(opening.bots).toHaveLength(mode.bots);
    expect(opening.teams).toEqual({
      player: 'azure',
      azure: mode.azure,
      crimson: mode.crimson,
    });
    expect(opening.targetScore).toBe(mode.target);
    expect(await page.locator('#match-mode-value')).toHaveText(mode.label);
    await expect(page.locator('[data-mode-choice="' + mode.id + '"]')).toHaveClass(/active/);

    await page.evaluate(() => {
      window.__THREE_GAME_TEST_HOOKS__?.setState('active-play');
      window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(0.1);
    });

    const active = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);
    expect(active.state).toBe('running');
    if (mode.id === 'ctf') {
      expect(active.flags).toHaveLength(2);
      expect(new Set(active.flags.map((flag) => flag.team))).toEqual(new Set(['azure', 'crimson']));
      expect(new Set(active.flags.map((flag) => flag.modelId))).toEqual(new Set(['riftline-ctf-standard-v2']));
      expect(new Set(active.flags.map((flag) => flag.geometrySignature))).toEqual(new Set([
        'cloth-11x7-1.34x0.76|pole-3.04|plinth-1.08-v2',
      ]));
      active.flags.forEach((flag) => {
        expect(flag.physics).toMatchObject({
          engine: 'custom-verlet-cloth',
          modelId: 'riftline-ctf-standard-v2',
          geometrySignature: 'cloth-11x7-1.34x0.76|pole-3.04|plinth-1.08-v2',
          objectTimestep: 1 / 120,
          clothTimestep: 1 / 60,
          bodyCount: 1,
          colliderCount: 1,
          clothVertices: 77,
          mode: 'base',
        });
      });
      await expect(page.locator('#core-location')).toHaveText('AZURE BASE // CRIMSON BASE');
    } else if (mode.id === 'raid') {
      expect(active.raid).toMatchObject({ uplinksSecured: 0, uplinkTarget: 3, activeUplink: 0 });
      expect(active.core.active).toBe(true);
      await expect(page.locator('#core-phase')).toHaveText('UPLINK');
    } else {
      await expect(page.locator('#core-phase')).toHaveText(/CAPTURE|TELEGRAPH/);
    }
  });
}

const ctfLayouts = [
  {
    query: '',
    name: 'Monsoon Divide',
    positions: [[-680, 933], [760, -846]],
  },
  {
    query: '&map=bipbeta2',
    name: 'Bipbeta2',
    positions: [[-76, -52], [76, 52]],
  },
  {
    query: '&map=quicksense',
    name: 'QuickSense',
    positions: [[-308, -72], [308, 72]],
  },
] as const;

for (const layout of ctfLayouts) {
  test(`CTF bases use authored opposing anchors on ${layout.name}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chrome', 'Deterministic map placement is checked once on desktop.');
    await page.goto(`/?mode=ctf&qa=physics&mapSeed=450600${layout.query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__ && window.__THREE_GAME_DIAGNOSTICS__));

    const opening = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);
    expect(opening.map.name).toBe(layout.name);
    expect(opening.flags.map((flag) => [flag.position.x, flag.position.z])).toEqual(layout.positions);

    const supportHeights = await page.evaluate((flags) => flags.map((flag) => (
      window.__THREE_GAME_TEST_HOOKS__?.sampleFloorHeight(flag.position.x, flag.position.z, Number.POSITIVE_INFINITY) ?? null
    )), opening.flags);
    supportHeights.forEach((supportY, index) => {
      expect(supportY).not.toBeNull();
      expect(Math.abs((supportY ?? 0) - opening.flags[index].position.y)).toBeLessThan(0.01);
    });

    const [azure, crimson] = opening.flags;
    const baseDistance = Math.hypot(
      crimson.position.x - azure.position.x,
      crimson.position.z - azure.position.z,
    );
    expect(baseDistance).toBeGreaterThan(Math.min(opening.map.bounds.width, opening.map.bounds.depth) * 0.25);
  });
}
