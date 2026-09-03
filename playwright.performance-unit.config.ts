import { defineConfig } from '@playwright/test';

// Pure timing/geometry contracts need neither a web server nor a GPU. Keep
// them runnable in restricted environments; hardware FPS gates stay separate.
export default defineConfig({
  testDir: './tests',
  testMatch: [
    'adaptive-quality.spec.ts',
    'ground-cover-culling.spec.ts',
    'loop-cadence.spec.ts',
    'performance-contract.spec.ts',
    'monsoon-rock-field.spec.ts',
  ],
  workers: 1,
  reporter: 'list',
});
