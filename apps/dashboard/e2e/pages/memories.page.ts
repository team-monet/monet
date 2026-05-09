import { type Page, type Locator, expect } from "@playwright/test";

/**
 * Page object for the Memories list page (/memories).
 *
 * Handles memory filtering, pagination, and navigation to memory details.
 */
export class MemoriesPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly searchButton: Locator;
  readonly filterPanel: Locator;
  readonly memoryTypeFilter: Locator;
  readonly groupFilter: Locator;
  readonly includeUserCheckbox: Locator;
  readonly includePrivateCheckbox: Locator;
  readonly clearFiltersButton: Locator;
  readonly memoryRows: Locator;
  readonly emptyState: Locator;
  readonly paginationNext: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.locator("h1", { hasText: "Memories" });
    this.searchButton = page.getByRole("link", { name: /semantic search/i });
    this.filterPanel = page.locator(".rounded-lg.border.bg-card");
    this.memoryTypeFilter = page.locator("button:has(> span:has-text('Select type')), button[aria-haspopup='listbox']").first();
    this.groupFilter = page.locator("button:has(> span:has-text('Select group')), button[aria-haspopup='listbox']").nth(1);
    this.includeUserCheckbox = page.locator("#includeUser");
    this.includePrivateCheckbox = page.locator("#includePrivate");
    this.clearFiltersButton = page.getByRole("button", { name: /clear filters/i });
    this.memoryRows = page.locator("table tbody tr");
    this.emptyState = page.locator("text=No memories found");
    this.paginationNext = page.getByRole("link", { name: /next/i });
  }

  async goto() {
    await this.page.goto("/memories");
    await this.heading.waitFor();
  }

  /** Select a memory type from the filter dropdown. */
  async filterByType(type: string) {
    // The filter uses Radix Select; click the trigger, then the option
    const trigger = this.page.locator("button").filter({ hasText: /All Types|Fact|Preference|Decision|Pattern|Issue|Procedure/ }).first();
    await trigger.click();
    await this.page.getByRole("option", { name: type, exact: false }).click();
  }

  /** Select a group from the filter dropdown. */
  async filterByGroup(groupName: string) {
    const trigger = this.page.locator("button").filter({ hasText: /All Groups/ }).first();
    await trigger.click();
    await this.page.getByRole("option", { name: groupName, exact: true }).click();
  }

  /** Toggle the "Include User" checkbox. */
  async toggleIncludeUser() {
    await this.includeUserCheckbox.click();
  }

  /** Toggle the "Include Private" checkbox. */
  async toggleIncludePrivate() {
    await this.includePrivateCheckbox.click();
  }

  /** Clear all active filters. */
  async clearFilters() {
    await this.clearFiltersButton.click();
  }

  /** Click into a specific memory row to view its details. */
  async clickMemoryRow(index: number = 0) {
    await this.memoryRows.nth(index).click();
    await expect(this.page).toHaveURL(/\/memories\/[a-f0-9-]+/);
  }

  /** Expect at least N memory rows visible. */
  async expectMinimumRows(n: number) {
    await expect(this.memoryRows).toHaveCount({ minimum: n } as any);
  }

  /** Expect the empty state message. */
  async expectEmpty() {
    await expect(this.emptyState).toBeVisible();
  }
}
