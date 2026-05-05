import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOidcProviderConfig } from "./oidc";

describe("resolveOidcProviderConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PUBLIC_OIDC_BASE_URL;
    delete process.env.LOCAL_OIDC_BASE_URL;
    delete process.env.KEYCLOAK_BASE_URL;
  });

  it("keeps provider issuer and well-known on one canonical origin", async () => {
    process.env.PUBLIC_OIDC_BASE_URL = "http://keycloak.localhost:4400";
    process.env.LOCAL_OIDC_BASE_URL = "http://keycloak.localhost:4400";

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        issuer: "http://localhost:4400/realms/monet",
        authorization_endpoint:
          "http://localhost:4400/realms/monet/protocol/openid-connect/auth",
        token_endpoint:
          "http://localhost:4400/realms/monet/protocol/openid-connect/token",
        userinfo_endpoint:
          "http://localhost:4400/realms/monet/protocol/openid-connect/userinfo",
        jwks_uri: "http://localhost:4400/realms/monet/protocol/openid-connect/certs",
      }),
    } as Response);

    const config = await resolveOidcProviderConfig(
      "http://localhost:4400/realms/monet",
    );

    expect(config.issuer).toBe("http://keycloak.localhost:4400/realms/monet");
    expect(config.wellKnown).toBe(
      "http://keycloak.localhost:4400/realms/monet/.well-known/openid-configuration",
    );
    expect(config.authorization).toBe(
      "http://keycloak.localhost:4400/realms/monet/protocol/openid-connect/auth",
    );
    expect(config.token).toBe(
      "http://keycloak.localhost:4400/realms/monet/protocol/openid-connect/token",
    );
    expect(config.serverIssuer).toBe(
      "http://keycloak.localhost:4400/realms/monet",
    );
  });

  it("uses discovered issuer for provider identity", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        issuer: "https://auth.example.com/realms/monet",
        authorization_endpoint:
          "https://auth.example.com/realms/monet/protocol/openid-connect/auth",
        token_endpoint:
          "https://auth.example.com/realms/monet/protocol/openid-connect/token",
      }),
    } as Response);

    const config = await resolveOidcProviderConfig(
      "https://auth.example.com/realms/monet",
    );

    expect(config.issuer).toBe("https://auth.example.com/realms/monet");
    expect(config.wellKnown).toBe(
      "https://auth.example.com/realms/monet/.well-known/openid-configuration",
    );
  });
});
