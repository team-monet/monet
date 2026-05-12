import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOidcIssuerForServer, resolveOidcProviderConfig } from "./oidc";

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

  it("keeps browser OIDC URLs public while using the local origin server-side", async () => {
    process.env.PUBLIC_OIDC_BASE_URL = "http://192.168.0.73:4400";
    process.env.LOCAL_OIDC_BASE_URL = "http://keycloak.localhost:4400";

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        issuer: "http://192.168.0.73:4400/realms/acme",
        authorization_endpoint:
          "http://192.168.0.73:4400/realms/acme/protocol/openid-connect/auth",
        token_endpoint:
          "http://192.168.0.73:4400/realms/acme/protocol/openid-connect/token",
        userinfo_endpoint:
          "http://192.168.0.73:4400/realms/acme/protocol/openid-connect/userinfo",
        jwks_uri:
          "http://192.168.0.73:4400/realms/acme/protocol/openid-connect/certs",
      }),
    } as Response);

    const config = await resolveOidcProviderConfig(
      "http://keycloak.localhost:4400/realms/acme",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://keycloak.localhost:4400/realms/acme/.well-known/openid-configuration",
      { cache: "no-store" },
    );
    expect(config.issuer).toBe("http://192.168.0.73:4400/realms/acme");
    expect(config.authorization).toBe(
      "http://192.168.0.73:4400/realms/acme/protocol/openid-connect/auth",
    );
    expect(config.serverIssuer).toBe(
      "http://keycloak.localhost:4400/realms/acme",
    );
    expect(config.wellKnown).toBe(
      "http://keycloak.localhost:4400/realms/acme/.well-known/openid-configuration",
    );
    expect(config.token).toBe(
      "http://keycloak.localhost:4400/realms/acme/protocol/openid-connect/token",
    );
    expect(config.userinfo).toBe(
      "http://keycloak.localhost:4400/realms/acme/protocol/openid-connect/userinfo",
    );
  });

  it("stores a public runtime issuer through the local OIDC origin", () => {
    process.env.PUBLIC_OIDC_BASE_URL = "http://192.168.0.73:4400";
    process.env.LOCAL_OIDC_BASE_URL = "http://keycloak.localhost:4400";

    expect(
      resolveOidcIssuerForServer("http://192.168.0.73:4400/realms/acme"),
    ).toBe("http://keycloak.localhost:4400/realms/acme");
  });
});
