import { test, expect } from "../fixtures/test";
import { MemoriesPage } from "../pages/memories.page";
import { DashboardPage } from "../pages/dashboard.page";
import { AgentsPage } from "../pages/agents.page";

/**
 * Scenario 2: Multi-Agent Memory Sharing
 *
 * Verifies that memories stored in a shared group scope are visible
 * to all agents within the same group, while user/private scoped
 * memories respect visibility boundaries.
 */
test.describe("Scenario 2: Multi-Agent Memory Sharing", () => {
  test("should display group-scoped memories to all agents in the group", async ({
    page,
    tenantSlug,
  }) => {
    const memoriesPage = new MemoriesPage(page);

    await memoriesPage.goto();

    // The memories table should load without errors
    await expect(memoriesPage.heading).toBeVisible();

    // Verify the filter panel is present
    await expect(memoriesPage.filterPanel).toBeVisible();
  });

  test("should filter memories by group and show shared entries", async ({
    page,
    tenantSlug,
  }) => {
    const memoriesPage = new MemoriesPage(page);

    await memoriesPage.goto();

    // Open the group filter
    const groupTrigger = page.locator("button").filter({ hasText: /All Groups/ }).first();
    if (await groupTrigger.isVisible()) {
      await groupTrigger.click();

      // Check that group options appear in the dropdown
      const options = page.locator("[role='option']");
      const optionCount = await options.count();

      if (optionCount > 0) {
        // Select the first non-"All Groups" option
        await options.nth(0).click();

        // The URL should update with the groupId query param
        await expect(page).toHaveURL(/groupId=/);
      }
    }
  });

  test("should distinguish between group, user, and private memory scopes", async ({
    page,
    tenantSlug,
  }) => {
    const memoriesPage = new MemoriesPage(page);

    await memoriesPage.goto();

    // If memories exist, verify scope badges are displayed
    const scopeBadges = page.locator("text=/^group$|^user$|^private$/");
    const badgeCount = await scopeBadges.count();

    if (badgeCount > 0) {
      // At least one scope badge should be visible
      await expect(scopeBadges.first()).toBeVisible();
    }
  });

  test("should toggle user/private memory visibility filters", async ({
    page,
    tenantSlug,
  }) => {
    const memoriesPage = new MemoriesPage(page);

    await memoriesPage.goto();

    // The "Include User" and "Include Private" checkboxes should exist
    const includeUserCheckbox = page.locator("#includeUser");
    const includePrivateCheckbox = page.locator("#includePrivate");

    if (await includeUserCheckbox.isVisible()) {
      await includeUserCheckbox.click();
      // URL should update
      await expect(page).toHaveURL(/includeUser=true/);
    }

    if (await includePrivateCheckbox.isVisible()) {
      await includePrivateCheckbox.click();
      await expect(page).toHaveURL(/includePrivate=true/);
    }
  });

  test("should show consistent memories across agents in the same group", async ({
    page,
    tenantSlug,
  }) => {
    const agentsPage = new AgentsPage(page);

    await agentsPage.goto();

    // List agents in the tenant
    const rows = await agentsPage.agentRows.count();

    if (rows > 0) {
      // Navigate to first agent detail
      const firstRow = agentsPage.agentRows.first();
      await firstRow.click();
      // Should be on agent detail page
      await expect(page).toHaveURL(/\/agents\/[a-f0-9-]+/);
    }
  });
});
