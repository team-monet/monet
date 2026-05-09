import { type Page, type Locator, expect } from "@playwright/test";

/**
 * Page object for the agent detail page (/agents/[id]).
 *
 * Used to inspect individual agent settings, status, and credentials.
 */
export class AgentDetailPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly agentName: Locator;
  readonly agentId: Locator;
  readonly revokeButton: Locator;
  readonly regenerateButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.locator("h1");
    this.agentName = page.locator("[data-testid='agent-name'], h1");
    this.agentId = page.locator("[data-testid='agent-id'], text=/^[a-f0-9]{8}-/");
    this.revokeButton = page.getByRole("button", { name: /revoke/i });
    this.regenerateButton = page.getByRole("button", { name: /regenerate/i });
  }

  async goto(agentId: string) {
    await this.page.goto(`/agents/${agentId}`);
    await this.heading.waitFor();
  }
}
