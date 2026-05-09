import { test as base, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * Monet E2E test fixtures.
 *
 * Provides a `tenantSlug` fixture so every test can reference the
 * configured tenant without hard-coding it.
 */
export const test = base.extend<{
  tenantSlug: string;
  apiBaseUrl: string;
}>({
  tenantSlug: async ({}, use) => {
    const slug = process.env.E2E_TENANT_SLUG || "test-org";
    await use(slug);
  },
  apiBaseUrl: async ({}, use) => {
    const url = process.env.E2E_API_URL || "http://127.0.0.1:3001";
    await use(url);
  },
});

export { expect };
