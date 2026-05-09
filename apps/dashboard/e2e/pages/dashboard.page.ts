import { type Page, type Locator, expect } from "@playwright/test";

/**
 * Page object for the main Dashboard (/).
 *
 * Encapsulates the summary cards, recent memories list, and navigation
 * elements shown on the authenticated landing page.
 */
export class DashboardPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly memoriesCard: Locator;
  readonly agentsCard: Locator;
  readonly groupsCard: Locator;
  readonly accessLevelCard: Locator;
  readonly recentMemoriesSection: Locator;
  readonly viewMemoriesButton: Locator;
  readonly searchButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.locator("h1", { hasText: "Dashboard" });
    this.memoriesCard = page.locator("section, div").filter({ hasText: /^Memories/ }).first();
    this.agentsCard = page.locator("section, div").filter({ hasText: /^Agents/ }).first();
    this.groupsCard = page.locator("section, div").filter({ hasText: /^Groups/ }).first();
    this.accessLevelCard = page.locator("section, div").filter({ hasText: /^Access Level/ }).first();
    this.recentMemoriesSection = page.locator("div").filter({ hasText: "Recent Memories" }).first();
    this.viewMemoriesButton = page.getByRole("link", { name: /view memories/i });
    this.searchButton = page.getByRole("link", { name: /search/i });
  }

  async goto() {
    await this.page.goto("/");
    await this.heading.waitFor();
  }

  /** Navigate to the Memories page via the sidebar link. */
  async navigateToMemories() {
    await this.page.getByRole("link", { name: "Memories" }).first().click();
    await expect(this.page).toHaveURL(/\/memories/);
    await this.page.locator("h1", { hasText: "Memories" }).waitFor();
  }

  /** Navigate to the Agents page via the sidebar link. */
  async navigateToAgents() {
    await this.page.getByRole("link", { name: "Agents" }).first().click();
    await expect(this.page).toHaveURL(/\/agents/);
    await this.page.locator("h1", { hasText: "Agents" }).waitFor();
  }
}
