import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E configuration for the Monet Dashboard.
 *
 * Environment variables (set in CI or local .env):
 *   E2E_BASE_URL        – Dashboard URL (default http://127.0.0.1:3000)
 *   E2E_API_URL         – API URL (default http://127.0.0.1:3001)
 *   E2E_TENANT_SLUG     – Tenant slug used for dev-bypass login (default test-org)
 *   DEV_BYPASS_AUTH      – Must be "true" to enable credential-less login
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ["html", { open: "never", outputFolder: "e2e-report" }],
    ["json", { outputFile: "e2e-results.json" }],
    ...(process.env.CI ? [["github"] as const] : [["list"] as const]),
  ],

  outputDir: "e2e-artifacts",

  use: {
    baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: "setup",
      testMatch: /global-setup\.ts/,
    },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/user.json",
      },
      dependencies: ["setup"],
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        storageState: "e2e/.auth/user.json",
      },
      dependencies: ["setup"],
    },
  ],

  webServer: {
    command: "pnpm dev:local",
    port: 3000,
    timeout: 120_000,
    reuseExistingServer: true,
    env: {
      DEV_BYPASS_AUTH: "true",
      PORT: "3000",
    },
  },
});
