import { type Page, type Locator, expect } from "@playwright/test";

/**
 * Page object for the Agents list page (/agents).
 *
 * Handles agent registration dialog interaction and agent list verification.
 */
export class AgentsPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly registerButton: Locator;
  readonly agentRows: Locator;
  readonly emptyState: Locator;

  // Dialog locators
  readonly dialog: Locator;
  readonly agentNameInput: Locator;
  readonly agentTypeSelect: Locator;
  readonly agentGroupSelect: Locator;
  readonly agentUserSelect: Locator;
  readonly dialogSubmitButton: Locator;
  readonly dialogTitle: Locator;
  readonly successMessage: Locator;
  readonly apiKeyDisplay: Locator;
  readonly mcpUrlDisplay: Locator;
  readonly viewAgentLink: Locator;
  readonly registerAnotherButton: Locator;
  readonly closeButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.locator("h1", { hasText: "Agents" });
    this.registerButton = page.getByRole("button", { name: /register agent/i });
    this.agentRows = page.locator("table tbody tr, [data-testid='agent-row']");
    this.emptyState = page.locator("text=No agents registered yet");

    // Dialog
    this.dialog = page.locator("[role='dialog']");
    this.dialogTitle = this.dialog.locator("h2", { hasText: "Register Agent" });
    this.agentNameInput = this.dialog.locator("#agent-name");
    this.agentTypeSelect = this.dialog.locator("#agent-type");
    this.agentGroupSelect = this.dialog.locator("#agent-group");
    this.agentUserSelect = this.dialog.locator("#agent-user");
    this.dialogSubmitButton = this.dialog.getByRole("button", { name: /register agent/i });
    this.successMessage = this.dialog.locator("[data-testid='api-key-display'], text=API Key");
    this.apiKeyDisplay = this.dialog.locator("code, [data-testid='api-key-value']").first();
    this.mcpUrlDisplay = this.dialog.locator("text=mcp").first();
    this.viewAgentLink = this.dialog.getByRole("link", { name: /view agent/i });
    this.registerAnotherButton = this.dialog.getByRole("button", { name: /register another/i });
    this.closeButton = this.dialog.getByRole("button", { name: /close/i });
  }

  async goto() {
    await this.page.goto("/agents");
    await this.heading.waitFor();
  }

  async openRegisterDialog() {
    await this.registerButton.click();
    await this.dialogTitle.waitFor();
  }

  async fillAgentForm(name: string, groupId: string, options?: { type?: string; userId?: string }) {
    await this.agentNameInput.fill(name);

    if (options?.type) {
      await this.agentTypeSelect.selectOption(options.type);
    }

    if (options?.userId) {
      await this.agentUserSelect.selectOption(options.userId);
    }

    await this.agentGroupSelect.selectOption(groupId);
  }

  async submitRegistration() {
    await this.dialogSubmitButton.click();
  }

  async registerAgent(name: string, groupId: string, options?: { type?: string; userId?: string }) {
    await this.openRegisterDialog();
    await this.fillAgentForm(name, groupId, options);
    await this.submitRegistration();
    // Wait for success — the API key display or success indicator
    await expect(this.dialog.locator("text=API Key")).toBeVisible({ timeout: 15_000 });
  }

  /** Get the agent ID from the "View Agent" link after registration. */
  async getRegisteredAgentId(): Promise<string | null> {
    const href = await this.viewAgentLink.getAttribute("href");
    if (!href) return null;
    const match = href.match(/\/agents\/([a-f0-9-]+)/);
    return match ? match[1] : null;
  }

  /** Verify an agent with the given name appears in the list. */
  async expectAgentInList(name: string) {
    await expect(this.page.locator(`text="${name}"`).first()).toBeVisible();
  }
}
