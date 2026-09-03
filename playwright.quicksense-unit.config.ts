import { defineConfig } from '@playwright/test';

// Exercise generated map geometry in Node; texture painting is stubbed in the
// fixture. This is deliberately independent of browser/GPU availability.
export default defineConfig({
  testDir: './tests',
  testMatch: 'quicksense-dressing.spec.ts',
  workers: 1,
  timeout: 120_000,
  reporter: 'list',
});
