import { expect, test } from '@playwright/test';
import type * as THREE from 'three';
import { getRenderDpr, resizeRenderer } from '../src/core/Renderer';
import { AdaptiveQualitySystem } from '../src/systems/AdaptiveQualitySystem';

const sampleWindow = (
  quality: AdaptiveQualitySystem,
  frameTimeMs: number,
  count: number,
) => {
  let change = null;
  for (let index = 0; index < count; index += 1) {
    change = quality.sampleFrame(frameTimeMs) ?? change;
  }
  return change;
};

test('renderer DPR is capped and rejects invalid runtime values', () => {
  expect(getRenderDpr(1.25, 2)).toBe(1.25);
  expect(getRenderDpr(1, 0.8)).toBe(0.8);
  expect(getRenderDpr(0.25, 2)).toBe(0.25);
  expect(getRenderDpr(Number.NaN, 2)).toBe(1);
  expect(getRenderDpr(1.25, Number.NaN)).toBe(1);
});

test('renderer resize notices a DPR-only quality change', () => {
  let appliedDpr = 0.8;
  let projectionUpdates = 0;
  let sizeUpdates = 0;
  const renderer = {
    domElement: { clientWidth: 100, clientHeight: 100, width: 100, height: 100 },
    getPixelRatio: () => appliedDpr,
    setPixelRatio: (value: number) => { appliedDpr = value; },
    setSize: () => { sizeUpdates += 1; },
  } as unknown as THREE.WebGLRenderer;
  const camera = {
    aspect: 1,
    updateProjectionMatrix: () => { projectionUpdates += 1; },
  } as unknown as THREE.PerspectiveCamera;

  expect(resizeRenderer(renderer, camera, 1)).toBe(true);
  expect(appliedDpr).toBe(1);
  expect(sizeUpdates).toBe(1);
  expect(projectionUpdates).toBe(1);
});

test('adaptive quality degrades one tier after sustained overload', () => {
  const quality = new AdaptiveQualitySystem();
  const change = sampleWindow(quality, 25, 40);

  expect(change).toMatchObject({
    previousDprCap: 1.25,
    dprCap: 1.125,
    reason: 'sustained-overload',
  });
  expect(quality.currentDprCap).toBe(1.125);
});

test('adaptive quality catches repeated burst stalls but ignores one isolated spike', () => {
  const isolated = new AdaptiveQualitySystem();
  isolated.sampleFrame(50);
  expect(sampleWindow(isolated, 10, 95)).toBeNull();
  expect(isolated.currentDprCap).toBe(1.25);

  const burst = new AdaptiveQualitySystem();
  burst.sampleFrame(50);
  burst.sampleFrame(50);
  const change = sampleWindow(burst, 10, 90);
  expect(change).toMatchObject({ dprCap: 1.125, reason: 'burst-overload' });
});

test('adaptive quality recovers slowly after stable headroom', () => {
  const quality = new AdaptiveQualitySystem();
  sampleWindow(quality, 25, 40);
  expect(quality.currentDprCap).toBe(1.125);

  for (let window = 0; window < 3; window += 1) {
    expect(sampleWindow(quality, 10, 100)).toBeNull();
  }
  const recovery = sampleWindow(quality, 10, 100);
  expect(recovery).toMatchObject({
    previousDprCap: 1.125,
    dprCap: 1.25,
    reason: 'recovered-headroom',
  });
});

test('adaptive quality clamps to its configured floor without oscillating', () => {
  const quality = new AdaptiveQualitySystem({ minDpr: 1, maxDpr: 1.25, dprStep: 0.125 });
  sampleWindow(quality, 25, 40);
  sampleWindow(quality, 25, 40);
  sampleWindow(quality, 25, 40);
  expect(quality.currentDprCap).toBe(1);

  const snapshot = quality.snapshot();
  expect(snapshot.renderScale).toBeCloseTo(0.8);
  expect(sampleWindow(quality, 25, 40)).toBeNull();
  expect(quality.currentDprCap).toBe(1);
});
