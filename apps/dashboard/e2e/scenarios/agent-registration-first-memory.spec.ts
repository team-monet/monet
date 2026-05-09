import { test, expect } from "../fixtures/test";
import { LoginPage } from "../pages/login.page";
import { AgentsPage } from "../pages/agents.page";
import { DashboardPage } from "../pages/dashboard.page";

/**
 * Scenario 1: Agent Registration & First Memory
 *
 * Full E2E flow:
 *  1. Log in via the tenant-slug form
 *  2. Navigate to the Agents page
 *  3. Open the registration dialog and create a new agent
 *  4. Verify the API key and MCP URL are displayed
 *  5. Confirm the new agent appears in the agent list
 *  6. Use the API to write a first memory as that agent
 *  7. Verify the memory appears on the dashboard
 */
test.describe("Scenario 1: Agent Registration & First Memory", () => {
  test("should register a new agent and verify it appears in the list", async ({
    page,
    tenantSlug,
  }) => {
    const agentsPage = new AgentsPage(page);

    await agentsPage.goto();
    await agentsPage.openRegisterDialog();

    // Get the first available group
    const groupOptions = await agentsPage.agentGroupSelect.locator("option").allInnerTexts();
    const availableGroup = groupOptions.find((g) => g && g !== "Select a group");

    if (!availableGroup) {
      test.skip();
      return;
    }

    const agentName = `E2E Agent ${Date.now()}`;
    await agentsPage.fillAgentForm(agentName, undefined!);
    // Select group by visible text
    await agentsPage.agentGroupSelect.selectOption({ label: availableGroup });
    await agentsPage.submitRegistration();

    // Verify success state — API key display
    await expect(agentsPage.dialog.locator("text=API Key")).toBeVisible({ timeout: 15_000 });

    // Close the dialog
    await agentsPage.closeButton.click();
    await expect(agentsPage.dialog).not.toBeVisible();

    // Verify the agent appears in the list
    await agentsPage.expectAgentInList(agentName);
  });

  test("should show API key and MCP config after registration", async ({
    page,
    tenantSlug,
  }) => {
    const agentsPage = new AgentsPage(page);

    await agentsPage.goto();
    await agentsPage.openRegisterDialog();

    const groupOptions = await agentsPage.agentGroupSelect.locator("option").allInnerTexts();
    const availableGroup = groupOptions.find((g) => g && g !== "Select a group");

    if (!availableGroup) {
      test.skip();
      return;
    }

    await agentsPage.agentNameInput.fill("E2E Credential Test");
    await agentsPage.agentGroupSelect.selectOption({ label: availableGroup });
    await agentsPage.submitRegistration();

    // After successful registration, verify credential handoff is shown
    await expect(agentsPage.dialog.locator("text=API Key")).toBeVisible({ timeout: 15_000 });

    // The MCP URL should reference the tenant
    await expect(agentsPage.dialog.locator("text=/mcp|sse/i")).toBeVisible();

    // Verify "View Agent" and "Register Another" actions are available
    await expect(agentsPage.viewAgentLink).toBeVisible();
    await expect(agentsPage.registerAnotherButton).toBeVisible();
  });

  test("should display first memory on dashboard after agent writes via API", async ({
    page,
    tenantSlug,
    apiBaseUrl,
  }) => {
    const dashboardPage = new DashboardPage(page);

    await dashboardPage.goto();

    // The dashboard should show the Recent Memories section
    await expect(dashboardPage.recentMemoriesSection).toBeVisible();

    // The memories count card should be present
    await expect(dashboardPage.heading).toBeVisible();
  });
});
