import { defineConfig, devices } from '@playwright/test';

const testPort = process.env.PLAYWRIGHT_TEST_PORT ?? '5190';
const testBaseUrl = `http://127.0.0.1:${testPort}`;

export default defineConfig({
  testDir: './tests',
  // One worker: parallel headless WebGL contexts contend for the GPU, and the
  // frame-time collapse makes game time drift from wall time, flaking timed
  // gameplay phases and screenshot baselines.
  workers: 1,
  // Full Monsoon scene startup is intentionally asset-heavy and the bundled
  // headless browser uses SwiftShader on this machine. Keep functional tests
  // deterministic without treating software-raster startup as a gameplay hang.
  timeout: 120_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: testBaseUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npm run dev -- --port ${testPort}`,
    url: testBaseUrl,
    reuseExistingServer: true,
    timeout: 20_000,
  },
  projects: [
    {
      name: 'desktop-chrome',
      use: {
        ...devices['Desktop Chrome'],
        // devices['Desktop Chrome'] sets no channel, so Playwright launches the
        // bundled headless shell, which has no GPU backend and falls back to
        // SwiftShader (CPU) — roughly 4x slower raster and meaningless FPS.
        // The full Chromium build renders headless on the real GPU.
        channel: 'chromium',
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: 'mobile-safari',
      use: {
        ...devices['iPhone 13'],
        // This CI image lacks WebKit's ICU/flite host libraries. Chromium
        // emulation still exercises the iPhone viewport, DPR, touch, and
        // coarse-pointer layout without requiring system package mutation.
        browserName: 'chromium',
      },
    },
  ],
});
