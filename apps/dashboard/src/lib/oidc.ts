const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const LOCAL_KEYCLOAK_EXAMPLE_ISSUER = "http://keycloak.localhost:3400/realms/monet";

type OidcDiscoveryDocument = {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
};

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function getLocalOidcBaseUrl() {
  const configured =
    process.env.LOCAL_OIDC_BASE_URL?.trim() ||
    process.env.KEYCLOAK_BASE_URL?.trim() ||
    "";

  return configured ? trimTrailingSlash(configured) : null;
}

export function resolveOidcIssuerForServer(issuer: string) {
  const trimmedIssuer = trimTrailingSlash(issuer.trim());
  const localBaseUrl = getLocalOidcBaseUrl();

  if (!localBaseUrl) {
    return trimmedIssuer;
  }

  let issuerUrl: URL;
  let baseUrl: URL;

  try {
    issuerUrl = new URL(trimmedIssuer);
    baseUrl = new URL(localBaseUrl);
  } catch {
    return trimmedIssuer;
  }

  if (!LOOPBACK_HOSTNAMES.has(issuerUrl.hostname)) {
    return trimmedIssuer;
  }

  issuerUrl.protocol = baseUrl.protocol;
  issuerUrl.hostname = baseUrl.hostname;
  issuerUrl.port = baseUrl.port;

  return trimTrailingSlash(issuerUrl.toString());
}

export async function fetchOidcDiscoveryDocument(
  issuer: string,
): Promise<OidcDiscoveryDocument> {
  const response = await fetch(
    `${resolveOidcIssuerForServer(issuer)}/.well-known/openid-configuration`,
    {
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(`OIDC discovery failed with ${response.status}`);
  }

  return response.json() as Promise<OidcDiscoveryDocument>;
}

export async function validateOidcIssuer(issuer: string) {
  try {
    const discovery = await fetchOidcDiscoveryDocument(issuer);
    if (!discovery.authorization_endpoint || !discovery.token_endpoint) {
      throw new Error("OIDC discovery document is missing required endpoints.");
    }
  } catch (error) {
    const baseUrl = getLocalOidcBaseUrl();
    const localHint = baseUrl
      ? ` For the local Docker stack, use the issuer from .local-dev/keycloak.json (for example, ${LOCAL_KEYCLOAK_EXAMPLE_ISSUER}).`
      : "";
    const reason =
      error instanceof Error ? error.message : "The issuer could not be reached.";

    throw new Error(
      `OIDC issuer could not be reached from the dashboard server. ${reason}.${localHint}`.trim(),
    );
  }
}
