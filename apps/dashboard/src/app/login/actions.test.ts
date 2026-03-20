import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @/lib/db
//
// vi.mock is hoisted above imports, so the factory cannot reference variables
// declared with const/let in module scope. Use vi.hoisted() to declare mock
// functions that are available at hoist-time.
// ---------------------------------------------------------------------------
const { mockSelect } = vi.hoisted(() => {
  const mockSelect = vi.fn();
  return { mockSelect };
});

vi.mock("@/lib/db", () => ({
  db: { select: mockSelect },
}));

import { validateTenantAction } from "./actions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Configure the two sequential db.select() chains that validateTenantAction
 * performs: first for the `tenants` table, then for `tenant_oauth_configs`.
 */
function setupDbMocks(
  tenantResult: Array<{ id: string }>,
  oauthResult: Array<{ id: string }> | Error = [],
) {
  let callCount = 0;

  const limitTenant = vi.fn().mockResolvedValue(tenantResult);
  const whereTenant = vi.fn().mockReturnValue({ limit: limitTenant });
  const fromTenant = vi.fn().mockReturnValue({ where: whereTenant });

  let limitOauth: ReturnType<typeof vi.fn>;
  const whereOauth = vi.fn();
  const fromOauth = vi.fn();

  if (oauthResult instanceof Error) {
    limitOauth = vi.fn().mockRejectedValue(oauthResult);
  } else {
    limitOauth = vi.fn().mockResolvedValue(oauthResult);
  }
  whereOauth.mockReturnValue({ limit: limitOauth });
  fromOauth.mockReturnValue({ where: whereOauth });

  mockSelect.mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      return { from: fromTenant };
    }
    return { from: fromOauth };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateTenantAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    // Defaults: not development, no bypass flags
    vi.stubEnv("NODE_ENV", "test");
  });

  // ---- Input validation ----------------------------------------------------

  describe("input validation", () => {
    it("returns error for empty slug", async () => {
      const result = await validateTenantAction("");
      expect(result).toEqual({
        error: "Please enter your organization slug",
      });
    });

    it("returns error for whitespace-only slug", async () => {
      const result = await validateTenantAction("   ");
      expect(result).toEqual({
        error: "Please enter your organization slug",
      });
    });

    it("returns error for slug with only special characters", async () => {
      const result = await validateTenantAction("!!!");
      expect(result).toEqual({
        error:
          "Organization slugs may only use lowercase letters, numbers, and hyphens",
      });
    });
  });

  // ---- Happy path: valid tenant with OAuth ---------------------------------

  describe("valid tenant with OAuth", () => {
    it("returns success with tenant-oauth provider for valid slug", async () => {
      setupDbMocks(
        [{ id: "tenant-uuid-123" }],
        [{ id: "oauth-uuid-456" }],
      );

      const result = await validateTenantAction("acme-corp");
      expect(result).toEqual({
        success: true,
        provider: "tenant-oauth",
        cookieTenantSlug: "acme-corp",
      });
    });
  });

  // ---- Tenant not found ----------------------------------------------------

  describe("tenant not found", () => {
    it("returns error when tenant does not exist", async () => {
      setupDbMocks([], []);

      const result = await validateTenantAction("nonexistent");
      expect(result).toEqual({ error: "Organization not found" });
    });
  });

  // ---- Dev bypass for test-org (#29) ---------------------------------------

  describe("dev bypass for test-org (#29)", () => {
    it("returns dev-bypass provider when DEV_BYPASS_AUTH is enabled in development", async () => {
      vi.stubEnv("NODE_ENV", "development");
      // DEV_BYPASS_AUTH is not set to "false", so bypass is enabled by default

      const result = await validateTenantAction("test-org");
      expect(result).toEqual({
        success: true,
        provider: "dev-bypass",
        cookieTenantSlug: "test-org",
        orgSlug: "test-org",
      });
    });

    it("returns dev-bypass when DASHBOARD_LOCAL_AUTH is true even outside development", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("DASHBOARD_LOCAL_AUTH", "true");

      const result = await validateTenantAction("test-org");
      expect(result).toEqual({
        success: true,
        provider: "dev-bypass",
        cookieTenantSlug: "test-org",
        orgSlug: "test-org",
      });
    });

    it("does not bypass when DEV_BYPASS_AUTH is explicitly false", async () => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("DEV_BYPASS_AUTH", "false");
      setupDbMocks([{ id: "tenant-uuid-test" }], [{ id: "oauth-uuid" }]);

      const result = await validateTenantAction("test-org");
      expect(result).toEqual({
        success: true,
        provider: "tenant-oauth",
        cookieTenantSlug: "test-org",
      });
    });

    it("returns error for test-org when DEV_BYPASS_AUTH is disabled and no OAuth config (#29)", async () => {
      vi.stubEnv("DEV_BYPASS_AUTH", "false");
      setupDbMocks([{ id: "tenant-uuid-test" }], []);

      const result = await validateTenantAction("test-org");
      expect(result).toEqual({
        error:
          "test-org requires development bypass auth. Start with `pnpm --filter @monet/dashboard dev:seeded` or set DEV_BYPASS_AUTH=true.",
      });
    });
  });

  // ---- Missing tenant_oauth_configs table (#31) ----------------------------

  describe("missing tenant_oauth_configs table (#31)", () => {
    it("returns graceful error for test-org when table is missing", async () => {
      vi.stubEnv("DEV_BYPASS_AUTH", "false");
      const missingTableError = Object.assign(
        new Error('relation "tenant_oauth_configs" does not exist'),
        { code: "42P01" },
      );
      setupDbMocks([{ id: "tenant-uuid-test" }], missingTableError);

      const result = await validateTenantAction("test-org");
      expect(result).toEqual({
        error:
          "test-org requires development bypass auth. Start with `pnpm --filter @monet/dashboard dev:seeded` or set DEV_BYPASS_AUTH=true.",
      });
    });

    it("returns migrate error for non-test-org when table is missing", async () => {
      const missingTableError = Object.assign(
        new Error('relation "tenant_oauth_configs" does not exist'),
        { code: "42P01" },
      );
      setupDbMocks([{ id: "tenant-uuid-123" }], missingTableError);

      const result = await validateTenantAction("acme-corp");
      expect(result).toEqual({
        error:
          "SSO configuration table is missing. Run `pnpm db:migrate` and restart the dashboard.",
      });
    });

    it("re-throws non-42P01 database errors", async () => {
      const genericError = new Error("connection refused");
      setupDbMocks([{ id: "tenant-uuid-123" }], genericError);

      await expect(validateTenantAction("acme-corp")).rejects.toThrow(
        "connection refused",
      );
    });
  });

  // ---- SSO not configured --------------------------------------------------

  describe("SSO not configured", () => {
    it("returns error when tenant exists but has no OAuth config", async () => {
      setupDbMocks([{ id: "tenant-uuid-123" }], []);

      const result = await validateTenantAction("acme-corp");
      expect(result).toEqual({
        error: "SSO not configured for this organization",
      });
    });
  });
});
