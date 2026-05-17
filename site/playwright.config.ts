import { defineConfig, devices } from '@playwright/test';

// Playwright runs the local dev server, exercises the app in chromium, and
// targets /e2e for spec files. Vitest stays unit-only (npm test); these are
// browser-level smoke tests (npm run test:e2e).
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4321',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      // Fast browser-level smoke tests. Excludes e2e/llm/ — those load a
      // multi-GB model and need WebGPU, so they run only in the `llm`
      // project via `npm run test:llm_tests`.
      name: 'chromium',
      testIgnore: /e2e[\\/]llm[\\/]/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Heavyweight LLM suite: real local Gemma .task model + WebGPU
      // inference. Headed real Chrome is by far the most reliable WebGPU
      // path on macOS; the suite self-skips when the model is absent or
      // WebGPU is unavailable (environmentally red, not a regression).
      name: 'llm',
      testMatch: /e2e[\\/]llm[\\/].*\.spec\.ts$/,
      timeout: 15 * 60_000,
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        headless: false,
        launchOptions: {
          args: [
            '--enable-unsafe-webgpu',
            '--enable-features=Vulkan',
            '--use-angle=metal',
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:4321',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
