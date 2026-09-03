import { expect, test, type Page } from '@playwright/test';
import type * as ThreeTypes from 'three';
import { MOVEMENT } from '../src/game/config';

const STEP = MOVEMENT.fixedStep;
const SLOPE_RADIANS = (20 * Math.PI) / 180;

type BotSkiModule = {
  applyBotSkiMovement: (
    velocity: ThreeTypes.Vector3,
    wishDirection: ThreeTypes.Vector3,
    floorNormal: ThreeTypes.Vector3,
    delta: number,
    scratch: {
      tangentGravity: ThreeTypes.Vector3;
      tangentVelocity: ThreeTypes.Vector3;
      tangentWish: ThreeTypes.Vector3;
      momentum: { resistance: number; dragAcceleration: number };
    },
  ) => void;
};

type SkiScenario = 'downhill' | 'retention' | 'carve';

async function runSkiScenario(page: Page, scenario: SkiScenario): Promise<{
  initialSpeed: number;
  finalSpeed: number;
  downhillBefore: number;
  downhillAfter: number;
  normalSpeed: number;
  crossSlopeSpeed: number;
  walkingSpeed: number;
}> {
  await page.goto('/src/entities/Bot.ts');
  return page.evaluate(async ({ selectedScenario, step, slopeRadians, movement }) => {
    const botModulePath = '/src/entities/Bot.ts';
    const threeModulePath = '/node_modules/three/build/three.module.js';
    const [botModule, THREE] = await Promise.all([
      import(/* @vite-ignore */ botModulePath) as Promise<BotSkiModule>,
      import(/* @vite-ignore */ threeModulePath) as Promise<typeof ThreeTypes>,
    ]);
    const normal = new THREE.Vector3(0, Math.cos(slopeRadians), Math.sin(slopeRadians));
    const downhill = new THREE.Vector3(0, -Math.sin(slopeRadians), Math.cos(slopeRadians));
    const scratch = {
      tangentGravity: new THREE.Vector3(),
      tangentVelocity: new THREE.Vector3(),
      tangentWish: new THREE.Vector3(),
      momentum: { resistance: 0, dragAcceleration: 0 },
    };
    const velocity = selectedScenario === 'retention'
      ? new THREE.Vector3(15, 0, 0)
      : downhill.clone().multiplyScalar(selectedScenario === 'carve' ? 20 : 9);
    const wish = selectedScenario === 'retention'
      ? new THREE.Vector3()
      : selectedScenario === 'carve'
        ? new THREE.Vector3(1, 0, 0)
        : downhill;
    const initialSpeed = velocity.length();
    const downhillBefore = velocity.dot(downhill);
    const duration = selectedScenario === 'downhill' ? 2 : selectedScenario === 'retention' ? 0.5 : 0.25;
    let walkingSpeed = initialSpeed;

    for (let tick = 0; tick < duration / step; tick += 1) {
      botModule.applyBotSkiMovement(velocity, wish, normal, step, scratch);
      if (selectedScenario === 'retention') {
        const control = Math.max(movement.stopSpeed, walkingSpeed);
        walkingSpeed = Math.max(0, walkingSpeed - control * movement.groundFriction * step);
      }
    }

    return {
      initialSpeed,
      finalSpeed: velocity.length(),
      downhillBefore,
      downhillAfter: velocity.dot(downhill),
      normalSpeed: Math.abs(velocity.dot(normal)),
      crossSlopeSpeed: velocity.x,
      walkingSpeed,
    };
  }, {
    selectedScenario: scenario,
    step: STEP,
    slopeRadians: SLOPE_RADIANS,
    movement: {
      stopSpeed: MOVEMENT.stopSpeed,
      groundFriction: MOVEMENT.groundFriction,
    },
  });
}

test('bot ski gravity deterministically builds speed down a grounded slope', async ({ page }) => {
  const result = await runSkiScenario(page, 'downhill');

  expect(result.finalSpeed).toBeGreaterThan(result.initialSpeed + 12);
  expect(result.downhillAfter).toBeGreaterThan(result.initialSpeed);
  expect(result.normalSpeed, 'ski velocity remains tangent to the slope').toBeLessThan(1e-9);
});

test('bot ski drag retains substantially more momentum than walking friction', async ({ page }) => {
  const result = await runSkiScenario(page, 'retention');

  expect(result.finalSpeed).toBeGreaterThan(14);
  expect(result.walkingSpeed).toBeLessThan(1);
  expect(result.finalSpeed).toBeGreaterThan(result.walkingSpeed + 12);
});

test('bot carve adds steering without erasing the downhill line', async ({ page }) => {
  const result = await runSkiScenario(page, 'carve');

  expect(result.crossSlopeSpeed, 'the bot gains cross-slope steering authority').toBeGreaterThan(1);
  expect(result.downhillAfter, 'the downhill component survives the carve').toBeGreaterThan(result.downhillBefore);
  expect(result.normalSpeed, 'carving does not lift the bot off the surface').toBeLessThan(1e-9);
});
