import { expect, test } from '@playwright/test';
import { MONSOON_DIVIDE } from '../src/game/maps/MonsoonDivide';
import { buildMonsoonWorldArt } from '../src/game/maps/MonsoonWorldArt';

test('Monsoon world art is deterministic, landmark-rich, and draw-call bounded', () => {
  const first = buildMonsoonWorldArt(MONSOON_DIVIDE.seed);
  const repeated = buildMonsoonWorldArt(MONSOON_DIVIDE.seed);

  expect(first.diagnostics.anchorCount).toBe(6);
  expect(new Set(first.diagnostics.anchorNames).size).toBe(6);
  expect(first.diagnostics.basaltLayerCounts).toEqual({ near: 8, mid: 14, far: 17 });
  expect(first.diagnostics.instanceCounts.routeSignals).toBeGreaterThanOrEqual(70);
  expect(first.diagnostics.expectedVisibleDrawCalls).toBeLessThanOrEqual(6);
  expect(first.diagnostics.expectedShadowDrawCalls).toBe(2);
  expect(first.diagnostics.expectedDrawCalls).toBeLessThanOrEqual(8);
  expect(first.colliderBoxes).toHaveLength(first.diagnostics.anchorCount);
  expect(first.diagnostics).toEqual(repeated.diagnostics);
  expect(first.colliderBoxes.map((box) => [...box.min.toArray(), ...box.max.toArray()])).toEqual(
    repeated.colliderBoxes.map((box) => [...box.min.toArray(), ...box.max.toArray()]),
  );
  for (const box of first.colliderBoxes) {
    expect(box.min.x).toBeGreaterThan(-MONSOON_DIVIDE.width * 0.5);
    expect(box.max.x).toBeLessThan(MONSOON_DIVIDE.width * 0.5);
    expect(box.min.z).toBeGreaterThan(-MONSOON_DIVIDE.depth * 0.5);
    expect(box.max.z).toBeLessThan(MONSOON_DIVIDE.depth * 0.5);
    expect(box.max.y).toBeGreaterThan(box.min.y + 20);
  }

  for (const build of [first, repeated]) {
    build.geometries.forEach((geometry) => geometry.dispose());
    build.materials.forEach((material) => material.dispose());
    build.textures.forEach((texture) => texture.dispose());
  }
});
