#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function env(name, fallback) {
  const value = process.env[name];
  if (value && value.length > 0) return value;
  return fallback;
}

function trimTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function jsonHeaders(token) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function request(baseUrl, pathname, { method = "GET", token, body, headers } = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: {
      ...(body ? jsonHeaders(token) : { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let parsed = null;

  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    const details =
      parsed === null
        ? `${response.status} ${response.statusText}`
        : `${response.status} ${response.statusText}: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`;
    const error = new Error(`Keycloak request failed for ${method} ${pathname}: ${details}`);
    error.status = response.status;
    throw error;
  }

  return parsed;
}

async function getAdminToken(baseUrl, username, password) {
  const response = await fetch(
    new URL("/realms/master/protocol/openid-connect/token", baseUrl),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username,
        password,
      }),
    },
  );

  const payload = await response.json();
  if (!response.ok || typeof payload?.access_token !== "string") {
    throw new Error(`Failed to obtain Keycloak admin token: ${JSON.stringify(payload)}`);
  }

  return payload.access_token;
}

async function ensureRealm(baseUrl, token, realm) {
  try {
    await request(baseUrl, `/admin/realms/${realm}`, { token });
    return;
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  await request(baseUrl, "/admin/realms", {
    method: "POST",
    token,
    body: {
      realm,
      enabled: true,
      registrationAllowed: false,
      resetPasswordAllowed: true,
      rememberMe: true,
      loginWithEmailAllowed: true,
      duplicateEmailsAllowed: false,
      editUsernameAllowed: false,
    },
  });
}

async function findClient(baseUrl, token, realm, clientId) {
  const clients = await request(
    baseUrl,
    `/admin/realms/${realm}/clients?clientId=${encodeURIComponent(clientId)}`,
    { token },
  );

  return Array.isArray(clients)
    ? clients.find((client) => client.clientId === clientId)
    : undefined;
}

async function ensureClient(baseUrl, token, realm, config) {
  const payload = {
    clientId: config.clientId,
    name: config.name,
    description: config.description,
    enabled: true,
    protocol: "openid-connect",
    publicClient: false,
    bearerOnly: false,
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    implicitFlowEnabled: false,
    redirectUris: [config.redirectUri],
    webOrigins: [config.webOrigin],
    attributes: {
      "post.logout.redirect.uris": "+",
    },
  };

  const existing = await findClient(baseUrl, token, realm, config.clientId);
  if (!existing) {
    await request(baseUrl, `/admin/realms/${realm}/clients`, {
      method: "POST",
      token,
      body: payload,
    });
  } else {
    await request(baseUrl, `/admin/realms/${realm}/clients/${existing.id}`, {
      method: "PUT",
      token,
      body: {
        ...existing,
        ...payload,
      },
    });
  }

  const client = await findClient(baseUrl, token, realm, config.clientId);
  if (!client?.id) {
    throw new Error(`Failed to resolve Keycloak client ${config.clientId} in realm ${realm}`);
  }

  const secret = await request(
    baseUrl,
    `/admin/realms/${realm}/clients/${client.id}/client-secret`,
    { token },
  );

  if (typeof secret?.value !== "string" || secret.value.length === 0) {
    throw new Error(`Failed to resolve secret for Keycloak client ${config.clientId}`);
  }

  return {
    id: client.id,
    clientId: config.clientId,
    secret: secret.value,
  };
}

async function findUser(baseUrl, token, realm, username) {
  const users = await request(
    baseUrl,
    `/admin/realms/${realm}/users?username=${encodeURIComponent(username)}&exact=true`,
    { token },
  );

  return Array.isArray(users)
    ? users.find((user) => user.username === username)
    : undefined;
}

async function ensureUser(baseUrl, token, realm, user) {
  const payload = {
    username: user.username,
    email: user.email,
    enabled: true,
    emailVerified: true,
    firstName: user.firstName,
    lastName: user.lastName,
  };

  const existing = await findUser(baseUrl, token, realm, user.username);
  let userId = existing?.id;

  if (!existing) {
    await request(baseUrl, `/admin/realms/${realm}/users`, {
      method: "POST",
      token,
      body: payload,
    });
    const created = await findUser(baseUrl, token, realm, user.username);
    userId = created?.id;
  } else {
    await request(baseUrl, `/admin/realms/${realm}/users/${existing.id}`, {
      method: "PUT",
      token,
      body: {
        ...existing,
        ...payload,
      },
    });
  }

  if (!userId) {
    throw new Error(`Failed to resolve Keycloak user ${user.username} in realm ${realm}`);
  }

  await request(baseUrl, `/admin/realms/${realm}/users/${userId}/reset-password`, {
    method: "PUT",
    token,
    body: {
      type: "password",
      temporary: false,
      value: user.password,
    },
  });

  return {
    id: userId,
    username: user.username,
    email: user.email,
    password: user.password,
  };
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..");
  const keycloakPort = env("KEYCLOAK_PORT", "3400");
  const dashboardPort = env("DASHBOARD_PORT", "3310");
  const keycloakBaseUrl = env(
    "KEYCLOAK_BASE_URL",
    `http://keycloak.localhost:${keycloakPort}`,
  );
  const dashboardBaseUrl = trimTrailingSlash(
    env("DASHBOARD_BASE_URL", env("NEXTAUTH_URL", `http://localhost:${dashboardPort}`)),
  );
  const outputPath = path.resolve(
    repoRoot,
    env("LOCAL_KEYCLOAK_OUTPUT", ".local-dev/keycloak.json"),
  );

  const keycloakAdmin = requiredEnv("KEYCLOAK_ADMIN");
  const keycloakAdminPassword = requiredEnv("KEYCLOAK_ADMIN_PASSWORD");

  const platformRealm = env("KEYCLOAK_PLATFORM_REALM", "monet");
  const platformClientId = env("KEYCLOAK_PLATFORM_CLIENT_ID", "monet-platform");
  const platformAdmin = {
    username: env("KEYCLOAK_PLATFORM_ADMIN_USERNAME", "platform-admin"),
    email: env("KEYCLOAK_PLATFORM_ADMIN_EMAIL", "platform-admin@example.com"),
    password: env("KEYCLOAK_PLATFORM_ADMIN_PASSWORD", "MonetPlatform1!"),
    firstName: "Platform",
    lastName: "Admin",
  };

  const tenantRealm = env("KEYCLOAK_TENANT_REALM", "acme");
  const tenantClientId = env("KEYCLOAK_TENANT_CLIENT_ID", "monet-tenant");
  const tenantAdmin = {
    username: env("KEYCLOAK_TENANT_ADMIN_USERNAME", "tenant-admin"),
    email: env("KEYCLOAK_TENANT_ADMIN_EMAIL", "tenant-admin@example.com"),
    password: env("KEYCLOAK_TENANT_ADMIN_PASSWORD", "MonetTenantAdmin1!"),
    firstName: "Tenant",
    lastName: "Admin",
  };
  const tenantUser = {
    username: env("KEYCLOAK_TENANT_USER_USERNAME", "tenant-user"),
    email: env("KEYCLOAK_TENANT_USER_EMAIL", "tenant-user@example.com"),
    password: env("KEYCLOAK_TENANT_USER_PASSWORD", "MonetTenantUser1!"),
    firstName: "Tenant",
    lastName: "User",
  };

  const adminToken = await getAdminToken(
    keycloakBaseUrl,
    keycloakAdmin,
    keycloakAdminPassword,
  );

  await ensureRealm(keycloakBaseUrl, adminToken, platformRealm);
  await ensureRealm(keycloakBaseUrl, adminToken, tenantRealm);

  const platformClient = await ensureClient(
    keycloakBaseUrl,
    adminToken,
    platformRealm,
    {
      clientId: platformClientId,
      name: "Monet Platform",
      description: "Local platform admin OIDC client for Monet",
      redirectUri: `${dashboardBaseUrl}/api/auth/callback/platform-oauth`,
      webOrigin: dashboardBaseUrl,
    },
  );

  const tenantClient = await ensureClient(
    keycloakBaseUrl,
    adminToken,
    tenantRealm,
    {
      clientId: tenantClientId,
      name: "Monet Tenant",
      description: "Local tenant OIDC client for Monet",
      redirectUri: `${dashboardBaseUrl}/api/auth/callback/tenant-oauth`,
      webOrigin: dashboardBaseUrl,
    },
  );

  const ensuredPlatformAdmin = await ensureUser(
    keycloakBaseUrl,
    adminToken,
    platformRealm,
    platformAdmin,
  );

  const ensuredTenantAdmin = await ensureUser(
    keycloakBaseUrl,
    adminToken,
    tenantRealm,
    tenantAdmin,
  );

  const ensuredTenantUser = await ensureUser(
    keycloakBaseUrl,
    adminToken,
    tenantRealm,
    tenantUser,
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    keycloak: {
      baseUrl: keycloakBaseUrl,
      adminConsoleUrl: `${keycloakBaseUrl}/admin/`,
      adminUsername: keycloakAdmin,
    },
    platform: {
      realm: platformRealm,
      issuer: `${keycloakBaseUrl}/realms/${platformRealm}`,
      clientId: platformClient.clientId,
      clientSecret: platformClient.secret,
      callbackUrl: `${dashboardBaseUrl}/api/auth/callback/platform-oauth`,
      adminUser: ensuredPlatformAdmin,
    },
    tenant: {
      realm: tenantRealm,
      issuer: `${keycloakBaseUrl}/realms/${tenantRealm}`,
      clientId: tenantClient.clientId,
      clientSecret: tenantClient.secret,
      callbackUrl: `${dashboardBaseUrl}/api/auth/callback/tenant-oauth`,
      adminUser: ensuredTenantAdmin,
      regularUser: ensuredTenantUser,
    },
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");

  console.log(`Keycloak bootstrap complete: ${outputPath}`);
  console.log(`platform issuer=${summary.platform.issuer}`);
  console.log(`platform clientId=${summary.platform.clientId}`);
  console.log(`platform admin email=${summary.platform.adminUser.email}`);
  console.log(`tenant issuer=${summary.tenant.issuer}`);
  console.log(`tenant clientId=${summary.tenant.clientId}`);
  console.log(`tenant admin email=${summary.tenant.adminUser.email}`);
}

void main().catch((error) => {
  console.error("Keycloak bootstrap failed", error);
  process.exit(1);
});
