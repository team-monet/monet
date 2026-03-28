import { describe, expect, it } from "vitest";
import { buildRefreshedToken } from "./auth-refresh";
import { REFRESH_ACCESS_TOKEN_ERROR } from "./session-errors";

describe("buildRefreshedToken", () => {
  it("clears a stale refresh error after a successful token refresh", () => {
    const token = {
      id: "user-1",
      role: "tenant_admin",
      scope: "tenant" as const,
      tenantId: "tenant-1",
      accessToken: "stale-access-token",
      refreshToken: "stale-refresh-token",
      expiresAt: 100,
      error: REFRESH_ACCESS_TOKEN_ERROR,
    };

    const refreshedToken = buildRefreshedToken(
      token,
      {
        access_token: "fresh-access-token",
        refresh_token: "fresh-refresh-token",
        expires_in: 120,
      },
      1000,
    );

    expect(refreshedToken).toMatchObject({
      accessToken: "fresh-access-token",
      refreshToken: "fresh-refresh-token",
      expiresAt: 1120,
    });
    expect(refreshedToken).not.toHaveProperty("error");
  });

  it("keeps the existing refresh token when the provider does not rotate it", () => {
    const token = {
      id: "user-1",
      role: "tenant_admin",
      scope: "tenant" as const,
      tenantId: "tenant-1",
      accessToken: "stale-access-token",
      refreshToken: "existing-refresh-token",
      expiresAt: 100,
      error: REFRESH_ACCESS_TOKEN_ERROR,
    };

    const refreshedToken = buildRefreshedToken(
      token,
      {
        access_token: "fresh-access-token",
        expires_in: 90,
      },
      2000,
    );

    expect(refreshedToken.refreshToken).toBe("existing-refresh-token");
    expect(refreshedToken.expiresAt).toBe(2090);
    expect(refreshedToken).not.toHaveProperty("error");
  });
});
