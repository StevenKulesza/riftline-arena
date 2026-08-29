import { expect, test } from '@playwright/test';
import { workStrideForRefreshRate } from '../src/core/Loop';

test('render work cadence preserves 60/90 Hz and caps high-refresh displays near 60 Hz', () => {
  expect(workStrideForRefreshRate(60)).toBe(1);
  expect(workStrideForRefreshRate(90)).toBe(1);
  expect(workStrideForRefreshRate(95.9)).toBe(1);
  expect(workStrideForRefreshRate(96)).toBe(2);
  expect(workStrideForRefreshRate(120)).toBe(2);
  expect(workStrideForRefreshRate(144)).toBe(2);
  expect(workStrideForRefreshRate(165)).toBe(3);
  expect(workStrideForRefreshRate(240)).toBe(4);
  expect(workStrideForRefreshRate(Number.NaN)).toBe(1);
});
