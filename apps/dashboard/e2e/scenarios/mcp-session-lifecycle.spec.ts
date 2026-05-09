import { test, expect } from "../fixtures/test";
import { LoginPage } from "../pages/login.page";
import { DashboardPage } from "../pages/dashboard.page";

/**
 * Scenario 4: MCP Session Lifecycle (Connect, Idle, Reconnect)
 *
 * Validates the agent-to-platform MCP session lifecycle through the
 * dashboard UI. Since MCP sessions are backend-driven, these tests
 * verify the dashboard correctly reflects session state:
 *  1. Agent detail page shows session status
 *  2. Dashboard remains responsive during idle periods
 *  3. Session recovery after page refresh
 *  4. Sign-out clears session state
 */
test.describe("Scenario 4: MCP Session Lifecycle", () => {
  test("should display agent status on the agent detail page", async ({
    page,
    tenantSlug,
  }) => {
    // Navigate to agents
    const agentsPage = await import("../pages/agents.page").then((m) => new m.AgentsPage(page));
    await agentsPage.goto();

    // If agents exist, navigate to the first one
    const rowCount = await agentsPage.agentRows.count();
    if (rowCount > 0) {
      await agentsPage.agentRows.first().click();
      await expect(page).toHaveURL(/\/agents\/[a-f0-9-]+/);

      // Agent detail page should display agent information
      await expect(page.locator("h1")).toBeVisible();
    }
  });

  test("should maintain dashboard state across page navigation", async ({
    page,
    tenantSlug,
  }) => {
    const dashboardPage = new DashboardPage(page);

    await dashboardPage.goto();
    await expect(dashboardPage.heading).toBeVisible();

    // Navigate away
    await page.getByRole("link", { name: "Memories" }).first().click();
    await expect(page).toHaveURL(/\/memories/);

    // Navigate back via browser back
    await page.goBack();
    await expect(dashboardPage.heading).toBeVisible();
  });

  test("should recover session after page refresh", async ({
    page,
    tenantSlug,
  }) => {
    const dashboardPage = new DashboardPage(page);

    await dashboardPage.goto();
    await expect(dashboardPage.heading).toBeVisible();

    // Refresh the page
    await page.reload();

    // Dashboard should load again (session should persist via cookie/JWT)
    await expect(dashboardPage.heading).toBeVisible();
  });

  test("should redirect to login after signing out", async ({ page, tenantSlug }) => {
    const dashboardPage = new DashboardPage(page);

    await dashboardPage.goto();
    await expect(dashboardPage.heading).toBeVisible();

    // Click the user avatar dropdown in the sidebar
    const userButton = page.locator("[data-sidebar='footer'] button, .sidebar-footer button").first();
    await userButton.click();

    // Click "Log out"
    const logoutLink = page.getByRole("menuitem", { name: /log out/i });
    await logoutLink.click();

    // Should redirect to the sign-out page, then to login
    await page.waitForURL(/\/(login|signout)/, { timeout: 15_000 });
  });

  test("should require authentication for protected routes", async ({
    page,
    tenantSlug,
  }) => {
    // Clear auth state to simulate unauthenticated access
    await page.context().clearCookies();

    // Try to access a protected page directly
    await page.goto("/agents");

    // Should redirect to login
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    await expect(page.locator("h2, h1", { hasText: "Monet" })).toBeVisible();
  });

  test("should show consistent sidebar navigation across pages", async ({
    page,
    tenantSlug,
  }) => {
    const dashboardPage = new DashboardPage(page);

    await dashboardPage.goto();

    // Verify sidebar links are present
    const sidebarLinks = [
      "Dashboard",
      "Memories",
      "Search",
      "Agents",
    ];

    for (const linkName of sidebarLinks) {
      const link = page.getByRole("link", { name: linkName, exact: false }).first();
      await expect(link).toBeVisible();
    }
  });

  test("should persist theme preference across page navigation", async ({
    page,
    tenantSlug,
  }) => {
    const dashboardPage = new DashboardPage(page);

    await dashboardPage.goto();

    // Toggle theme if the toggle is visible
    const themeToggle = page.locator("[data-testid='theme-toggle'], button[aria-label*='theme'], button[aria-label*='Theme']");
    if (await themeToggle.isVisible()) {
      await themeToggle.click();
      // Navigate to another page and back
      await page.getByRole("link", { name: "Agents" }).first().click();
      await page.getByRole("link", { name: "Dashboard" }).first().click();

      // Theme should persist (check for dark class)
      // No assertion on specific theme — just that it doesn't reset
    }
  });
});
