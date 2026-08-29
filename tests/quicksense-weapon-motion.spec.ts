import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';

type RouteSample = {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  tuck: number;
  obstruction: number;
  grounded: boolean;
  playerY: number;
  velocityY: number;
};

const delta = (left: number, right: number) => Math.abs(left - right);

test('QuickSense view-model stays stable across roads, hills, and stairs', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'View-model motion QA runs once in desktop Chromium.');
  test.setTimeout(180_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/?map=quicksense&qa=physics&mapSeed=450600');
  await page.waitForFunction(() => (
    Boolean(window.__THREE_GAME_TEST_HOOKS__)
    && Boolean(window.__THREE_GAME_DIAGNOSTICS__?.map.ready)
    && (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5
  ));
  const captureDirectory = 'artifacts/quicksense-weapon-motion';
  mkdirSync(captureDirectory, { recursive: true });

  const sampleRoute = async (
    state: 'movement-flat' | 'movement-slope' | 'view-0' | 'view-1' | 'view-2',
    options: { name: string; yaw?: number; key: 'KeyW' | 'ShiftLeft'; frames: number },
  ) => {
    await page.evaluate(({ stateName, yaw }) => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      hooks.setState(stateName);
      hooks.parkBotsForScreenshot();
      hooks.setWeapon('sniper');
      hooks.resetWeaponCaptureState();
      hooks.setReducedMotion(false);
      hooks.setPausedForScreenshot(false);
      if (yaw !== undefined) hooks.setAim(yaw, -0.04);
    }, { stateName: state, yaw: options.yaw });
    await page.keyboard.down(options.key);
    const samples = await page.evaluate((frames) => {
      const hooks = window.__THREE_GAME_TEST_HOOKS__!;
      const values: RouteSample[] = [];
      for (let index = 0; index < frames; index += 1) {
        hooks.stepSimulation(1 / 120);
        const diagnostics = window.__THREE_GAME_DIAGNOSTICS__!;
        values.push({
          position: { ...diagnostics.renderer.weaponViewPosition },
          rotation: { ...diagnostics.renderer.weaponViewRotation },
          tuck: diagnostics.renderer.weaponTuck,
          obstruction: diagnostics.renderer.weaponObstructionDistance,
          grounded: diagnostics.player.grounded,
          playerY: diagnostics.player.position.y,
          velocityY: diagnostics.player.velocity.y,
        });
      }
      return values;
    }, options.frames);
    await page.keyboard.up(options.key);
    await page.waitForTimeout(100);
    await page.screenshot({
      path: `${captureDirectory}/${options.name}.png`,
      animations: 'disabled',
    });
    return samples;
  };

  const routes = [
    { name: 'floor', samples: await sampleRoute('movement-flat', { name: 'floor', key: 'KeyW', frames: 180 }) },
    { name: 'hill', samples: await sampleRoute('movement-slope', { name: 'hill', key: 'ShiftLeft', frames: 240 }) },
    { name: 'stairs-west', samples: await sampleRoute('view-1', { name: 'stairs-west', yaw: -Math.PI / 2, key: 'KeyW', frames: 180 }) },
    { name: 'stairs-east', samples: await sampleRoute('view-2', { name: 'stairs-east', yaw: -Math.PI / 2, key: 'KeyW', frames: 180 }) },
  ];

  const metrics = routes.map(({ name, samples }) => ({
    name,
    maxTuck: Math.max(...samples.map((sample) => sample.tuck)),
    minObstruction: Math.min(...samples.map((sample) => sample.obstruction)),
    maxPositionStep: Math.max(...samples.slice(1).map((sample, index) => Math.max(
      delta(sample.position.x, samples[index].position.x),
      delta(sample.position.y, samples[index].position.y),
      delta(sample.position.z, samples[index].position.z),
    ))),
    maxRotationStep: Math.max(...samples.slice(1).map((sample, index) => Math.max(
      delta(sample.rotation.x, samples[index].rotation.x),
      delta(sample.rotation.y, samples[index].rotation.y),
      delta(sample.rotation.z, samples[index].rotation.z),
    ))),
    groundedChanges: samples.slice(1).filter((sample, index) => sample.grounded !== samples[index].grounded).length,
    verticalTravel: Math.max(...samples.map((sample) => sample.playerY)) - Math.min(...samples.map((sample) => sample.playerY)),
    maxVerticalSpeed: Math.max(...samples.map((sample) => Math.abs(sample.velocityY))),
  }));
  await test.info().attach('quicksense-view-model-motion', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  });

  expect(
    metrics.every((route) => (
      route.maxTuck < 0.05
      && route.maxPositionStep < 0.035
      && route.maxRotationStep < 0.035
    )),
    JSON.stringify(metrics, null, 2),
  ).toBe(true);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
