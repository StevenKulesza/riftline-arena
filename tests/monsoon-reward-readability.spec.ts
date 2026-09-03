import { expect, test } from '@playwright/test';

type RewardDiagnostic = {
  kind: string;
  active: boolean;
  visible: boolean;
  silhouette: string;
  visualState: string;
  steadyDrawCalls: number;
  transientCollectDrawCalls: number;
  sharedResources: boolean;
  hasAuthoredWeapon: boolean;
  position: { x: number; y: number; z: number };
};

test('Monsoon rewards keep four readable silhouettes and bounded collect states', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto('/?map=monsoon&qa=visual&mapSeed=450600');
  await page.waitForFunction(() => (
    window.__THREE_GAME_DIAGNOSTICS__?.map.name === 'Monsoon Divide'
    && Boolean(window.__THREE_GAME_DIAGNOSTICS__?.map.ready)
    && (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5
  ));

  const initial = await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__?.setReducedMotion(false);
    window.__THREE_GAME_TEST_HOOKS__?.setState('active-play');
    return window.__THREE_GAME_DIAGNOSTICS__!.pickups as unknown as RewardDiagnostic[];
  });
  expect(new Set(initial.map((pickup) => pickup.silhouette))).toEqual(new Set([
    'triage-cross',
    'aegis-shield',
    'ordnance-chevron',
    'overdrive-reactor',
  ]));
  expect(initial.every((pickup) => pickup.sharedResources)).toBe(true);
  expect(initial.every((pickup) => pickup.steadyDrawCalls <= 3)).toBe(true);
  expect(initial.every((pickup) => pickup.transientCollectDrawCalls <= 4)).toBe(true);
  expect(initial.filter((pickup) => !['health', 'armor', 'damage', 'speed'].includes(pickup.kind))
    .every((pickup) => pickup.hasAuthoredWeapon)).toBe(true);

  const health = initial.find((pickup) => pickup.kind === 'health');
  expect(health).toBeDefined();
  if (!health) return;
  await page.evaluate((pickup) => {
    window.__THREE_GAME_TEST_HOOKS__!.setSpectatorCamera(
      { x: pickup.position.x + 4.6, y: pickup.position.y + 2.1, z: pickup.position.z + 4.6 },
      { x: pickup.position.x, y: pickup.position.y + 0.82, z: pickup.position.z },
      54,
    );
  }, health);
  await expect.poll(async () => page.evaluate((kind) => {
    const pickups = window.__THREE_GAME_DIAGNOSTICS__!.pickups as unknown as RewardDiagnostic[];
    const pickup = pickups.find((candidate) => candidate.kind === kind);
    return { state: pickup?.visualState, visible: pickup?.visible };
  }, health.kind)).toEqual({ state: 'attract', visible: true });
  await testInfo.attach(`monsoon-health-attract-${testInfo.project.name}`, {
    body: await page.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  });

  await page.evaluate((pickup) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setPlayerKinematics(
      { x: pickup.position.x, y: pickup.position.y, z: pickup.position.z },
      { x: 0, y: 0, z: 0 },
    );
    hooks.stepSimulation(0.04);
  }, health);
  const collecting = await page.evaluate((kind) => {
    const pickups = window.__THREE_GAME_DIAGNOSTICS__!.pickups as unknown as RewardDiagnostic[];
    return pickups.find((pickup) => pickup.kind === kind);
  }, health.kind);
  expect(collecting).toMatchObject({ active: false, visible: true, visualState: 'collect' });
  await expect.poll(async () => page.evaluate((kind) => {
    const pickups = window.__THREE_GAME_DIAGNOSTICS__!.pickups as unknown as RewardDiagnostic[];
    const pickup = pickups.find((candidate) => candidate.kind === kind);
    return { state: pickup?.visualState, visible: pickup?.visible };
  }, health.kind)).toEqual({ state: 'cooldown', visible: false });

  const resourceAudit = await page.evaluate(async () => {
    const modulePath = '/src/game/maps/MonsoonRewardVisuals.ts';
    const module = await import(modulePath);
    const kit = new module.MonsoonRewardVisualKit();
    const healthA = kit.create('health', 0x5dff8b);
    const healthB = kit.create('health', 0x5dff8b);
    const armor = kit.create('armor', 0x45dfff);
    const ammo = kit.create('rocket', 0xffa63d);
    const reactor = kit.create('damage', 0xff6c38);
    const distinctBodyGeometries = new Set([
      healthA.body.geometry,
      armor.body.geometry,
      ammo.body.geometry,
      reactor.body.geometry,
    ]).size;

    kit.update(reactor, {
      delta: 0.016,
      elapsed: 1,
      active: true,
      distanceSq: 4,
      renderable: true,
      reducedMotion: false,
    });
    const attractState = reactor.state;
    kit.beginCollect(reactor);
    kit.update(reactor, {
      delta: module.MONSOON_REWARD_VISUAL_BUDGET.collectSeconds,
      elapsed: 1.4,
      active: false,
      distanceSq: 0,
      renderable: true,
      reducedMotion: false,
    });
    const cooldownState = reactor.state;
    const cooldownVisible = reactor.root.visible;
    kit.beginRespawn(reactor);
    kit.update(reactor, {
      delta: module.MONSOON_REWARD_VISUAL_BUDGET.respawnSeconds,
      elapsed: 2,
      active: true,
      distanceSq: 400,
      renderable: true,
      reducedMotion: true,
    });
    const respawnSettledState = reactor.state;
    const diagnostics = kit.diagnostics();
    const result = {
      healthGeometryShared: healthA.body.geometry === healthB.body.geometry,
      bodyMaterialShared: [healthB, armor, ammo, reactor].every((visual) => visual.body.material === healthA.body.material),
      distinctBodyGeometries,
      attractState,
      cooldownState,
      cooldownVisible,
      respawnSettledState,
      diagnostics,
    };
    kit.dispose();
    return result;
  });
  expect(resourceAudit).toMatchObject({
    healthGeometryShared: true,
    bodyMaterialShared: true,
    distinctBodyGeometries: 4,
    attractState: 'attract',
    cooldownState: 'cooldown',
    cooldownVisible: false,
    respawnSettledState: 'idle',
    diagnostics: {
      geometries: 10,
      steadyDrawCallsPerPickup: 3,
      transientCollectDrawCallsPerPickup: 4,
    },
  });
});
