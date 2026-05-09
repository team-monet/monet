import { test as setup, expect } from "@playwright/test";

/**
 * Global setup for Playwright E2E tests.
 *
 * Authenticates via the dev-bypass provider and persists the storage state
 * so all downstream tests can reuse the authenticated session without
 * going through login on every test.
 *
 * Prerequisite: DEV_BYPASS_AUTH=true must be set and the `test-org` tenant
 * must exist in the database.
 */
const authFile = "e2e/.auth/user.json";

setup("authenticate as tenant user", async ({ page }) => {
  const tenantSlug = process.env.E2E_TENANT_SLUG || "test-org";

  // Navigate to login with the tenant query param for auto-login.
  await page.goto(`/login?tenant=${encodeURIComponent(tenantSlug)}`);

  // With dev-bypass, the login page auto-initiates sign-in.
  // Wait for redirect to the dashboard.
  await page.waitForURL("/", { timeout: 30_000 });

  // Verify we are authenticated by checking for the dashboard heading.
  await expect(page.locator("h1", { hasText: "Dashboard" })).toBeVisible();

  // Persist the authenticated session state for all test projects.
  await page.context().storageState({ path: authFile });
});
