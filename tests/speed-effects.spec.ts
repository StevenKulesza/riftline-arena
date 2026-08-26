import { expect, test } from '@playwright/test';
import * as THREE from 'three';
import {
  SPEED_EFFECT_FULL_KMH,
  SPEED_EFFECT_START_KMH,
  SpeedTrailSystem,
  speedEffectIntensity,
} from '../src/systems/SpeedTrailSystem';

test('speed effect ramps smoothly from 70 km/h', () => {
  const velocity = new THREE.Vector3();
  velocity.x = (SPEED_EFFECT_START_KMH - 0.1) / 3.6;
  expect(speedEffectIntensity(velocity)).toBe(0);
  velocity.x = SPEED_EFFECT_START_KMH / 3.6;
  expect(speedEffectIntensity(velocity)).toBe(0);
  velocity.x = ((SPEED_EFFECT_START_KMH + SPEED_EFFECT_FULL_KMH) * 0.5) / 3.6;
  expect(speedEffectIntensity(velocity)).toBeCloseTo(0.5, 5);
  velocity.x = SPEED_EFFECT_FULL_KMH / 3.6;
  expect(speedEffectIntensity(velocity)).toBe(1);
});

test('batched wind trails stay dormant below threshold and activate above it', () => {
  const scene = new THREE.Scene();
  const system = new SpeedTrailSystem(scene, 1);
  const source = {
    position: new THREE.Vector3(2, 4, 6),
    velocity: new THREE.Vector3(18, 0, 0),
    active: true,
  };
  system.update([source], 1, false);
  expect(system.activeSourceCount).toBe(0);
  expect(system.mesh.visible).toBe(false);

  source.velocity.x = 30;
  system.update([source], 1, false);
  expect(system.activeSourceCount).toBe(1);
  expect(system.mesh.visible).toBe(true);
  expect(system.mesh.geometry.drawRange.count).toBe(24);
  system.dispose();
  expect(scene.children).not.toContain(system.mesh);
});

test('the first weapon renders as textured metal with no emissive flash', async ({ page }) => {
  await page.goto('/weapon-preview.html?weapon=machine');
  await page.waitForFunction(() => window.__WEAPON_PREVIEW_READY__ === true, null, { timeout: 30_000 });
  const diagnostics = await page.evaluate(() => window.__WEAPON_PREVIEW_DIAGNOSTICS__!);
  expect(diagnostics.weapon).toBe('machine');
  expect(diagnostics.pulseIntensity).toBe(0);
  expect(diagnostics.pulseMetalness.every((metalness) => metalness >= 0.9)).toBe(true);
  expect(diagnostics.texturedPulseMaterials).toBe(2);
});
