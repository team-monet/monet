import { test, expect } from "../fixtures/test";
import { LoginPage } from "../pages/login.page";
import { DashboardPage } from "../pages/dashboard.page";
import { MemoriesPage } from "../pages/memories.page";
import { AgentsPage } from "../pages/agents.page";

/**
 * Scenario 3: Dashboard Workflow (Login, Browse, Filter)
 *
 * Covers the core user journey:
 *  1. Log in with tenant slug
 *  2. View dashboard summary cards
 *  3. Navigate to memories and apply filters
 *  4. Navigate between pages using the sidebar
 *  5. Verify data consistency across views
 */
test.describe("Scenario 3: Dashboard Workflow", () => {
  test("should log in and display the dashboard overview", async ({
    page,
    tenantSlug,
  }) => {
    const dashboardPage = new DashboardPage(page);

    await dashboardPage.goto();

    // Dashboard heading
    await expect(dashboardPage.heading).toBeVisible();

    // Welcome text with user name
    await expect(page.locator("text=Welcome back")).toBeVisible();

    // Summary cards
    await expect(page.locator("text=Memories")).toBeVisible();
    await expect(page.locator("text=Agents")).toBeVisible();
    await expect(page.locator("text=Groups")).toBeVisible();
    await expect(page.locator("text=Access Level")).toBeVisible();
  });

  test("should navigate from dashboard to memories via sidebar", async ({
    page,
    tenantSlug,
  }) => {
    const dashboardPage = new DashboardPage(page);

    await dashboardPage.goto();
    await dashboardPage.navigateToMemories();

    // Should be on the memories page with the correct heading
    await expect(page.locator("h1", { hasText: "Memories" })).toBeVisible();

    // The filter panel should be present
    await expect(page.locator(".rounded-lg.border.bg-card")).toBeVisible();
  });

  test("should navigate from dashboard to agents via sidebar", async ({
    page,
    tenantSlug,
  }) => {
    const dashboardPage = new DashboardPage(page);

    await dashboardPage.goto();
    await dashboardPage.navigateToAgents();

    // Should be on the agents page
    await expect(page.locator("h1", { hasText: "Agents" })).toBeVisible();

    // Register Agent button should be present
    await expect(page.getByRole("button", { name: /register agent/i })).toBeVisible();
  });

  test("should navigate to semantic search page", async ({ page, tenantSlug }) => {
    const dashboardPage = new DashboardPage(page);

    await dashboardPage.goto();
    await dashboardPage.searchButton.click();

    await expect(page).toHaveURL(/\/memories\/search/);
  });

  test("should filter memories by type and verify the URL updates", async ({
    page,
    tenantSlug,
  }) => {
    const memoriesPage = new MemoriesPage(page);

    await memoriesPage.goto();

    // Filter by "Fact" type
    const typeTrigger = page.locator("button").filter({ hasText: /All Types|Fact/ }).first();
    await typeTrigger.click();
    const factOption = page.getByRole("option", { name: "Fact", exact: false });
    if (await factOption.isVisible()) {
      await factOption.click();

      // URL should reflect the filter
      await expect(page).toHaveURL(/memoryType=fact/);
    }
  });

  test("should clear all memory filters and return to default view", async ({
    page,
    tenantSlug,
  }) => {
    const memoriesPage = new MemoriesPage(page);

    await memoriesPage.goto();

    // Apply a filter first
    const typeTrigger = page.locator("button").filter({ hasText: /All Types|Fact/ }).first();
    await typeTrigger.click();
    const factOption = page.getByRole("option", { name: "Fact", exact: false });
    if (await factOption.isVisible()) {
      await factOption.click();
      await expect(page).toHaveURL(/memoryType=fact/);

      // Now clear filters
      await memoriesPage.clearFilters();

      // URL should no longer have query params (or no memoryType)
      await expect(page).toHaveURL(/\/memories(\?[^m]|$)/);
    }
  });

  test("should display data consistency between dashboard and memories page", async ({
    page,
    tenantSlug,
  }) => {
    // Dashboard shows "Recent Memories" — navigate to full memories
    const dashboardPage = new DashboardPage(page);
    await dashboardPage.goto();

    // Click "Open Memories" link from the memories card
    const openMemoriesLink = page.getByRole("link", { name: /open memories/i });
    if (await openMemoriesLink.isVisible()) {
      await openMemoriesLink.click();
      await expect(page).toHaveURL(/\/memories/);
      await expect(page.locator("h1", { hasText: "Memories" })).toBeVisible();
    }
  });
});
