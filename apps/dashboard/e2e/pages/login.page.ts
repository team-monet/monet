import { type Page, type Locator } from "@playwright/test";

/**
 * Page object for the Monet login page (/login).
 *
 * Handles the tenant-slug-based login flow, including the dev-bypass
 * authentication provider used in E2E tests.
 */
export class LoginPage {
  readonly page: Page;
  readonly tenantInput: Locator;
  readonly submitButton: Locator;
  readonly cardTitle: Locator;
  readonly errorMessage: Locator;
  readonly loadingSpinner: Locator;

  constructor(page: Page) {
    this.page = page;
    this.tenantInput = page.locator("#tenant-slug");
    this.submitButton = page.getByRole("button", { name: /continue to sign in/i });
    this.cardTitle = page.getByRole("heading", { name: "Monet" });
    this.errorMessage = page.locator("[role='alert']");
    this.loadingSpinner = page.locator(".animate-spin");
  }

  async goto() {
    await this.page.goto("/login");
    await this.cardTitle.waitFor();
  }

  /**
   * Perform login via the tenant-slug form.
   * With DEV_BYPASS_AUTH=true, this auto-authenticates without OIDC redirect.
   */
  async loginWithTenantSlug(slug: string) {
    await this.tenantInput.fill(slug);
    await this.submitButton.click();
  }

  /**
   * Navigate to login with a tenant query parameter for auto-login.
   * The dashboard auto-initiates login when `?tenant=slug` is present.
   */
  async autoLogin(slug: string) {
    await this.page.goto(`/login?tenant=${encodeURIComponent(slug)}`);
  }

  /** Wait for the redirect to complete and dashboard to load. */
  async waitForDashboard() {
    await this.page.waitForURL("/", { timeout: 30_000 });
    await this.page.locator("h1", { hasText: "Dashboard" }).waitFor();
  }
}
