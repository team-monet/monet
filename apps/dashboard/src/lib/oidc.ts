const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const DEFAULT_DASHBOARD_BASE_URL = "http://localhost:3000";

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

function getPublicOidcBaseUrl() {
  const configured =
    process.env.PUBLIC_OIDC_BASE_URL?.trim() ||
    process.env.KEYCLOAK_BASE_URL?.trim() ||
    "";

  return configured ? trimTrailingSlash(configured) : null;
}

function getDashboardBaseUrl() {
  const configured =
    process.env.NEXTAUTH_URL?.trim() ||
    process.env.AUTH_URL?.trim() ||
    DEFAULT_DASHBOARD_BASE_URL;

  return trimTrailingSlash(configured);
}

export function replaceUrlOrigin(value: string, base: string) {
  try {
    const valueUrl = new URL(value);
    const baseUrl = new URL(base);
    valueUrl.protocol = baseUrl.protocol;
    valueUrl.hostname = baseUrl.hostname;
    valueUrl.port = baseUrl.port;
    return valueUrl.toString();
  } catch {
    return value;
  }
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

export function resolveOidcIssuerForBrowser(issuer: string) {
  const trimmedIssuer = trimTrailingSlash(issuer.trim());
  const publicBaseUrl = getPublicOidcBaseUrl();

  if (!publicBaseUrl) {
    return trimmedIssuer;
  }

  return trimTrailingSlash(replaceUrlOrigin(trimmedIssuer, publicBaseUrl));
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

export function getOidcExampleIssuer(realm: string) {
  const publicBaseUrl = getPublicOidcBaseUrl() || getLocalOidcBaseUrl();
  const baseUrl = publicBaseUrl || "http://keycloak.localhost:3400";

  return `${trimTrailingSlash(baseUrl)}/realms/${realm}`;
}

export async function resolveOidcProviderConfig(issuer: string) {
  const browserIssuer = resolveOidcIssuerForBrowser(issuer);
  const serverIssuer = resolveOidcIssuerForServer(issuer);
  const discovery = await fetchOidcDiscoveryDocument(issuer);

  if (!discovery.authorization_endpoint || !discovery.token_endpoint) {
    throw new Error("OIDC discovery document is missing required endpoints.");
  }

  return {
    browserIssuer,
    serverIssuer,
    wellKnown: `${serverIssuer}/.well-known/openid-configuration`,
    authorization: replaceUrlOrigin(
      discovery.authorization_endpoint,
      browserIssuer,
    ),
    token: discovery.token_endpoint,
    userinfo: discovery.userinfo_endpoint,
    jwksEndpoint: discovery.jwks_uri,
  };
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
      ? ` For local setups, use the generated issuer from .local-dev/keycloak.json or .runtime/keycloak.json (for example, ${getOidcExampleIssuer("monet")}).`
      : "";
    const reason =
      error instanceof Error ? error.message : "The issuer could not be reached.";

    throw new Error(
      `OIDC issuer could not be reached from the dashboard server. ${reason}.${localHint}`.trim(),
    );
  }
}

type ValidateOidcClientConfigInput = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  callbackPath: string;
};

export async function validateOidcClientConfig(
  input: ValidateOidcClientConfigInput,
) {
  const discovery = await fetchOidcDiscoveryDocument(input.issuer);
  const tokenEndpoint = discovery.token_endpoint;

  if (!tokenEndpoint) {
    throw new Error("OIDC discovery document is missing token_endpoint");
  }

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: "authorization_code",
      code: "monet-client-config-validation",
      redirect_uri: `${getDashboardBaseUrl()}${input.callbackPath}`,
    }),
  });

  const payload = (await response.json().catch(() => null)) as
    | { error?: string; error_description?: string }
    | null;

  if (response.ok) {
    return;
  }

  const authError = payload?.error;
  if (
    response.status === 401 ||
    response.status === 403 ||
    authError === "invalid_client" ||
    authError === "unauthorized_client"
  ) {
    const description =
      payload?.error_description || "Client authentication failed.";
    throw new Error(
      `OIDC client credentials are invalid for this issuer. ${description}`,
    );
  }

  // A fake authorization code should be rejected once client authentication
  // succeeds, so non-authentication failures mean the client config is usable.
}
