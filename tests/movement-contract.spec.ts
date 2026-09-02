import { expect, test } from '@playwright/test';

const diagnostics = async (page: import('@playwright/test').Page) => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);

test('self-fired rockets add movement and cost health or armor', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));
  const before =   await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('movement-flat');
    hooks.setPausedForScreenshot(true);
    hooks.setWeapon('rocket');
    hooks.setAim(0, -1.2);
    return window.__THREE_GAME_DIAGNOSTICS__!;
  });

  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.fireWeapon();
    hooks.stepSimulation(0.24);
  });
  const after = await diagnostics(page);

  expect(after.player.rocketJumpCount).toBe(before.player.rocketJumpCount + 1);
  expect(after.player.velocity.y, 'rocket blast must create clear upward movement').toBeGreaterThan(10);
  expect(
    after.health < before.health || after.armor < before.armor,
    'Warsow rocket jumping spends health/armor (~79 raw before 66% armor)',
  ).toBe(true);
});

test('Warsow movement contract: acceleration, dash, bhop, skiing, and wall containment', async ({ page }) => {
  test.setTimeout(150_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/?qa=physics');
  await page.waitForFunction(() => Boolean(window.__THREE_GAME_TEST_HOOKS__));
  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('movement-flat');
    hooks.setPausedForScreenshot(true);
  });
  await page.keyboard.down('KeyW');
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(0.32));
  const accelerated = await diagnostics(page);
  expect(accelerated.player.speed, 'ground acceleration must reach arena pace quickly').toBeGreaterThan(13);

  await page.keyboard.press('KeyE');
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(0.09));
  const dashed = await diagnostics(page);
  expect(dashed.player.speed, 'dash sets speed to dashSpeed, never adding above the current run').toBeGreaterThanOrEqual(20);
  expect(dashed.player.speed).toBeLessThan(Math.max(accelerated.player.speed, 21) + 0.5);
  expect(dashed.player.dashCooldown, 'dash must enter cooldown').toBeGreaterThan(0.35);
  expect(dashed.player.velocity.y, 'dash hop remains upward after 90 ms of gravity').toBeGreaterThan(2);
  expect(dashed.player.grounded).toBe(false);

  // Dash already used the hop. Land first; a Space press in that airtime would
  // arm the jetpack or wall-jump instead of chaining bunny hops.
  let landed = dashed;
  for (let index = 0; index < 12 && !landed.player.grounded; index += 1) {
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(0.05));
    landed = await diagnostics(page);
  }
  expect(landed.player.grounded, 'dash hop must land before the bhop chain').toBe(true);
  const hopFloor = landed.player.position.y;

  await page.keyboard.down('Space');
  let peakHeight = hopFloor;
  let minimumAirSpeed = Number.POSITIVE_INFINITY;
  let airborneSamples = 0;
  for (let index = 0; index < 8; index += 1) {
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(0.09));
    const sample = await diagnostics(page);
    peakHeight = Math.max(peakHeight, sample.player.position.y);
    if (!sample.player.grounded) {
      airborneSamples += 1;
      minimumAirSpeed = Math.min(minimumAirSpeed, sample.player.speed);
    }
  }
  await page.keyboard.up('Space');
  await page.keyboard.up('KeyW');
  expect(airborneSamples, 'held jump must produce repeatable bunny-hop airtime').toBeGreaterThan(2);
  expect(peakHeight - hopFloor, 'jump arc must clear the capsule step height').toBeGreaterThan(1.1);
  expect(minimumAirSpeed, 'bunny hopping must preserve useful horizontal momentum').toBeGreaterThan(11);

  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('movement-flat');
    hooks.setPausedForScreenshot(true);
  });
  await page.keyboard.down('KeyW');
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(0.26));
  await page.keyboard.down('Space');
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(0.12));
  const beforeCarve = await diagnostics(page);
  const carveYaw = 0.62;
  await page.evaluate((yaw) => window.__THREE_GAME_TEST_HOOKS__?.setAim(yaw, -0.04), carveYaw);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(0.24));
  const afterCarve = await diagnostics(page);
  await page.keyboard.up('Space');
  await page.keyboard.up('KeyW');
  const carveDirection = { x: -Math.sin(carveYaw), z: -Math.cos(carveYaw) };
  const beforeAlignment = (
    beforeCarve.player.velocity.x * carveDirection.x + beforeCarve.player.velocity.z * carveDirection.z
  ) / Math.max(0.001, beforeCarve.player.speed);
  const afterAlignment = (
    afterCarve.player.velocity.x * carveDirection.x + afterCarve.player.velocity.z * carveDirection.z
  ) / Math.max(0.001, afterCarve.player.speed);
  expect(afterAlignment, 'air control must carve conserved momentum toward the aimed heading').toBeGreaterThan(beforeAlignment + 0.16);
  expect(afterCarve.player.speed, 'air carving must preserve rather than replace momentum').toBeGreaterThan(beforeCarve.player.speed * 0.9);

  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('movement-slope');
    hooks.setPausedForScreenshot(true);
  });
  await page.keyboard.down('ShiftLeft');
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(0.2));
  const skied = await diagnostics(page);
  await page.keyboard.up('ShiftLeft');
  await test.info().attach('ski-telemetry', {
    body: JSON.stringify(skied.player),
    contentType: 'application/json',
  });
  expect(skied.player.skiing, 'ski input must be active').toBe(true);
  expect(skied.player.speed, 'downhill tangent gravity must add energy').toBeGreaterThan(15.2);

  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('view-0');
    hooks.setPausedForScreenshot(true);
  });
  await page.keyboard.down('KeyW');
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(1.2));
  const climbedStairs = await diagnostics(page);
  await page.keyboard.up('KeyW');
  expect(climbedStairs.player.position.z, 'WCA1 stairs must be walkable without jump input').toBeLessThan(32);

  const uphillRoutes = [
    { state: 'view-1', yaw: -Math.PI / 2, seconds: 0.8, minHeight: 1.05, axis: 'x' as const, threshold: 27.5, direction: 1 },
    { state: 'view-2', yaw: -Math.PI / 2, seconds: 0.8, minHeight: 3.9, axis: 'x' as const, threshold: -27, direction: 1 },
    { state: 'view-9', yaw: Math.PI / 2, seconds: 0.8, minHeight: 3.9, axis: 'x' as const, threshold: -2, direction: -1 },
  ];
  for (const route of uphillRoutes) {
    await page.evaluate(({ state, yaw }) => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      hooks.setState(state);
      hooks.setPausedForScreenshot(true);
      hooks.setAim(yaw, -0.04);
    }, route);
    await page.keyboard.down('KeyW');
    await page.evaluate((seconds) => window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(seconds), route.seconds);
    await page.keyboard.up('KeyW');
    const result = await diagnostics(page);
    expect(result.player.position.y, `${route.state} must climb its authored stair flight`).toBeGreaterThan(route.minHeight);
    if (route.direction > 0) expect(result.player.position[route.axis]).toBeGreaterThan(route.threshold);
    else expect(result.player.position[route.axis]).toBeLessThan(route.threshold);
  }

  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('view-2');
    hooks.setPausedForScreenshot(true);
    hooks.setAim(-Math.PI / 2, -0.04);
  });
  await page.keyboard.down('KeyW');
  await page.keyboard.down('ShiftLeft');
  let skiStairPeak = Number.NEGATIVE_INFINITY;
  let skiedStairs = await diagnostics(page);
  for (let index = 0; index < 5; index += 1) {
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(0.16));
    skiedStairs = await diagnostics(page);
    skiStairPeak = Math.max(skiStairPeak, skiedStairs.player.position.y);
  }
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');
  expect(skiedStairs.player.skiing, 'ski must remain active while traversing stair contacts').toBe(true);
  expect(skiStairPeak, 'skiing must climb authored stairs without a jump').toBeGreaterThan(3.9);
  expect(skiedStairs.player.speed, 'stair stepping must preserve ski momentum').toBeGreaterThan(14);

  await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__!;
    hooks.setState('view-0');
    hooks.setPausedForScreenshot(true);
  });
  await page.keyboard.down('KeyW');
  await page.keyboard.press('KeyE');
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stepSimulation(1.05));
  const contained = await diagnostics(page);
  await page.keyboard.up('KeyW');
  expect(contained.player.position.z, 'capsule must not tunnel through the Campgrounds wall').toBeGreaterThan(27.5);
  expect(contained.player.position.z).toBeLessThan(41);
  expect(Number.isFinite(contained.player.position.x + contained.player.position.y + contained.player.position.z)).toBe(true);
  expect(pageErrors).toEqual([]);
});
