import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  tenantSchemaNameFromId,
  createClient,
} from "../packages/db/src/index.ts";
import { provisionTenant } from "../apps/api/src/services/tenant.service";
import { generateApiKey, hashApiKey } from "../apps/api/src/services/api-key.service";
import { encrypt } from "../apps/api/src/lib/crypto";
import { provisionAgentWithApiKey } from "../apps/api/src/services/agent-provisioning.service";

const DEFAULT_AGENT_GROUP_NAME = "General";

type KeycloakSummary = {
  keycloak?: {
    baseUrl?: string;
    adminConsoleUrl?: string;
    adminUsername?: string;
  };
  platform?: {
    issuer?: string;
    clientId?: string;
    clientSecret?: string;
    adminUser?: { username?: string; email?: string; password?: string };
  };
  tenant?: {
    issuer?: string;
    clientId?: string;
    clientSecret?: string;
    adminUser?: { username?: string; email?: string; password?: string };
    regularUser?: { id?: string; username?: string; email?: string; password?: string };
  };
};

const DEFAULT_DEMO_TENANT_NAME = "Demo";
const DEFAULT_DEMO_TENANT_SLUG = "demo";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

function env(name: string, fallback?: string) {
  const value = process.env[name];
  if (value && value.length > 0) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is required`);
}

async function readKeycloakSummary(filePath: string): Promise<KeycloakSummary | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as KeycloakSummary;
  } catch {
    return null;
  }
}

function runLocalKeycloakBootstrap() {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("node", [path.resolve(rootDir, "scripts/local-keycloak-setup.mjs")], {
      cwd: rootDir,
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`local-keycloak-setup exited with code ${code ?? "unknown"}`));
    });
  });
}

function assertPlatformSummary(
  summary: KeycloakSummary | null,
  context: { profile: string; summaryPath: string },
) {
  const issuer = summary?.platform?.issuer?.trim();
  const clientId = summary?.platform?.clientId?.trim();
  const clientSecret = summary?.platform?.clientSecret?.trim();
  const adminEmail = summary?.platform?.adminUser?.email?.trim().toLowerCase();

  if (!issuer || !clientId || !clientSecret || !adminEmail) {
    const missing: string[] = [];
    if (!issuer) missing.push("platform.issuer");
    if (!clientId) missing.push("platform.clientId");
    if (!clientSecret) missing.push("platform.clientSecret");
    if (!adminEmail) missing.push("platform.adminUser.email");
    throw new Error(
      `Keycloak bootstrap summary missing required platform fields (${missing.join(", ")}) for profile='${context.profile}' at ${context.summaryPath}`,
    );
  }

  return {
    platform: {
      issuer,
      clientId,
      clientSecret,
      adminUser: {
        email: adminEmail,
      },
    },
  };
}

function assertTenantSummary(
  summary: KeycloakSummary | null,
  context: { profile: string; summaryPath: string },
) {
  const issuer = summary?.tenant?.issuer?.trim();
  const clientId = summary?.tenant?.clientId?.trim();
  const clientSecret = summary?.tenant?.clientSecret?.trim();
  const tenantAdminEmail = summary?.tenant?.adminUser?.email?.trim().toLowerCase();
  const regularUserId = summary?.tenant?.regularUser?.id?.trim();
  const regularUserEmail = summary?.tenant?.regularUser?.email?.trim().toLowerCase();
  const regularUserUsername = summary?.tenant?.regularUser?.username?.trim() || null;
  const missing: string[] = [];
  if (!issuer) missing.push("tenant.issuer");
  if (!clientId) missing.push("tenant.clientId");
  if (!clientSecret) missing.push("tenant.clientSecret");
  if (!tenantAdminEmail) missing.push("tenant.adminUser.email");
  if (!regularUserId) missing.push("tenant.regularUser.id");
  if (!regularUserEmail) missing.push("tenant.regularUser.email");

  if (missing.length > 0) {
    throw new Error(
      `Keycloak bootstrap summary missing required tenant fields (${missing.join(", ")}) for profile='${context.profile}' at ${context.summaryPath}`,
    );
  }

  return {
    tenant: {
      issuer,
      clientId,
      clientSecret,
      adminUser: {
        email: tenantAdminEmail,
      },
      regularUser: {
        id: regularUserId,
        email: regularUserEmail,
        username: regularUserUsername,
      },
    },
  };
}

async function ensureLocalPlatformSetup(sql: ReturnType<typeof createClient>["sql"], summary: {
  platform: { issuer: string; clientId: string; clientSecret: string; adminUser: { email: string } };
}) {
  const now = new Date();
  const nowIso = now.toISOString();
  const encryptedSecret = encrypt(summary.platform.clientSecret);

  const existingOauth = await sql<Array<{ id: string }>>`
    SELECT id
    FROM platform_oauth_configs
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (existingOauth[0]?.id) {
    await sql`
      UPDATE platform_oauth_configs
      SET issuer = ${summary.platform.issuer},
          client_id = ${summary.platform.clientId},
          client_secret_encrypted = ${encryptedSecret}
      WHERE id = ${existingOauth[0].id}
    `;
  } else {
    await sql`
      INSERT INTO platform_oauth_configs (issuer, client_id, client_secret_encrypted)
      VALUES (${summary.platform.issuer}, ${summary.platform.clientId}, ${encryptedSecret})
    `;
  }

  const adminEmail = summary.platform.adminUser.email.trim().toLowerCase();
  const existingAdmin = await sql<Array<{ id: string }>>`
    SELECT id
    FROM platform_admins
    WHERE email = ${adminEmail}
    LIMIT 1
  `;

  if (!existingAdmin[0]?.id) {
    await sql`
      INSERT INTO platform_admins (email)
      VALUES (${adminEmail})
    `;
  }

  const installation = await sql<Array<{ id: string; initialized_at: Date | null }>>`
    SELECT id, initialized_at
    FROM platform_installations
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (installation[0]?.initialized_at) {
    return false;
  }

  if (installation[0]?.id) {
    await sql`
      UPDATE platform_installations
      SET initialized_at = ${nowIso}::timestamptz, updated_at = ${nowIso}::timestamptz
      WHERE id = ${installation[0].id}
    `;
    return true;
  }

  await sql`
    INSERT INTO platform_installations (initialized_at, updated_at)
    VALUES (${nowIso}::timestamptz, ${nowIso}::timestamptz)
  `;
  return true;
}

async function ensureAdminAgentMembership(
  sql: ReturnType<typeof createClient>["sql"],
  tenantId: string,
  agentId: string,
) {
  const schemaName = tenantSchemaNameFromId(tenantId);

  const groupRows = await sql<Array<{ id: string }>>`
    SELECT id
    FROM ${sql(schemaName)}.agent_groups
    WHERE name = ${DEFAULT_AGENT_GROUP_NAME}
    ORDER BY created_at ASC
    LIMIT 1
  `;
  const defaultGroup = groupRows[0] ?? null;

  if (!defaultGroup) {
    throw new Error(`Default agent group '${DEFAULT_AGENT_GROUP_NAME}' not found for tenant ${tenantId}`);
  }

  await sql`
    INSERT INTO ${sql(schemaName)}.agent_group_members (agent_id, group_id)
    VALUES (${agentId}, ${defaultGroup.id})
    ON CONFLICT (agent_id, group_id) DO NOTHING
  `;
}

async function ensureDemoTenantAndApiKey(
  sql: ReturnType<typeof createClient>["sql"],
  db: ReturnType<typeof createClient>["db"],
  tenantName: string,
  tenantSlug: string,
) {
  const adminExternalId = `admin@${tenantSlug}`;
  const existingTenantRows = await sql<Array<{ id: string; name: string; slug: string }>>`
    SELECT id, name, slug
    FROM tenants
    WHERE slug = ${tenantSlug}
    LIMIT 1
  `;
  const existingTenant = existingTenantRows[0];

  if (!existingTenant) {
    const provisioned = await provisionTenant(db, sql, { name: tenantName, slug: tenantSlug });
    return {
      tenant: provisioned.tenant,
      createdTenant: true,
      apiKey: provisioned.rawApiKey,
      adminExternalId,
    };
  }

  const schemaName = tenantSchemaNameFromId(existingTenant.id);
  const agentRows = await sql<Array<{ id: string }>>`
    SELECT id
    FROM ${sql(schemaName)}.agents
    WHERE external_id = ${adminExternalId}
    ORDER BY created_at ASC
    LIMIT 1
  `;

  if (agentRows[0]?.id) {
    const agentId = agentRows[0].id;
    const apiKey = generateApiKey(agentId);
    const { hash, salt } = hashApiKey(apiKey);
    await sql`
      UPDATE ${sql(schemaName)}.agents
      SET api_key_hash = ${hash}, api_key_salt = ${salt}, revoked_at = NULL
      WHERE id = ${agentId}
    `;
    await ensureAdminAgentMembership(sql, existingTenant.id, agentId);

    return {
      tenant: existingTenant,
      createdTenant: false,
      apiKey,
      adminExternalId,
    };
  }

  const provisionedAgent = await provisionAgentWithApiKey(sql, {
    externalId: adminExternalId,
    tenantId: existingTenant.id,
    role: "tenant_admin",
    isAutonomous: false,
  });
  await ensureAdminAgentMembership(sql, existingTenant.id, provisionedAgent.agent.id);

  return {
    tenant: existingTenant,
    createdTenant: false,
    apiKey: provisionedAgent.rawApiKey,
    adminExternalId,
  };
}

async function ensureTenantOauthConfig(
  sql: ReturnType<typeof createClient>["sql"],
  tenantId: string,
  oauth: { issuer: string; clientId: string; clientSecret: string },
) {
  const encryptedSecret = encrypt(oauth.clientSecret);

  const existing = await sql<Array<{ id: string }>>`
    SELECT id
    FROM tenant_oauth_configs
    WHERE tenant_id = ${tenantId}
    LIMIT 1
  `;

  if (existing[0]?.id) {
    await sql`
      UPDATE tenant_oauth_configs
      SET provider = 'oidc',
          issuer = ${oauth.issuer},
          client_id = ${oauth.clientId},
          client_secret_encrypted = ${encryptedSecret}
      WHERE id = ${existing[0].id}
    `;
    return;
  }

  await sql`
    INSERT INTO tenant_oauth_configs (
      tenant_id,
      provider,
      issuer,
      client_id,
      client_secret_encrypted
    ) VALUES (
      ${tenantId},
      'oidc',
      ${oauth.issuer},
      ${oauth.clientId},
      ${encryptedSecret}
    )
  `;
}

async function ensureTenantAdminNomination(
  sql: ReturnType<typeof createClient>["sql"],
  input: { tenantId: string; tenantAdminEmail: string; platformAdminEmail: string },
) {
  const tenantAdminEmail = input.tenantAdminEmail.trim().toLowerCase();
  const platformAdminEmail = input.platformAdminEmail.trim().toLowerCase();

  const platformAdminRows = await sql<Array<{ id: string }>>`
    SELECT id
    FROM platform_admins
    WHERE email = ${platformAdminEmail}
    LIMIT 1
  `;

  const platformAdminId = platformAdminRows[0]?.id;
  if (!platformAdminId) {
    throw new Error(
      `Cannot create tenant admin nomination: platform admin '${platformAdminEmail}' not found`,
    );
  }

  await sql`
    INSERT INTO tenant_admin_nominations (tenant_id, email, created_by_platform_admin_id)
    VALUES (${input.tenantId}, ${tenantAdminEmail}, ${platformAdminId})
    ON CONFLICT (tenant_id, email) DO UPDATE
    SET revoked_at = NULL,
        created_by_platform_admin_id = EXCLUDED.created_by_platform_admin_id
  `;
}

async function ensureTenantUserOwnedMcpAgentApiKey(
  sql: ReturnType<typeof createClient>["sql"],
  tenantId: string,
  regularUser: { id: string; email: string; username: string | null },
) {
  const schemaName = tenantSchemaNameFromId(tenantId);
  const normalizedEmail = regularUser.email.trim().toLowerCase();
  const nowIso = new Date().toISOString();

  const userByExternalRows = await sql<Array<{ id: string }>>`
    SELECT id
    FROM ${sql(schemaName)}.users
    WHERE external_id = ${regularUser.id}
    LIMIT 1
  `;

  const userByEmailRows = userByExternalRows[0]?.id
    ? []
    : await sql<Array<{ id: string }>>`
        SELECT id
        FROM ${sql(schemaName)}.users
        WHERE tenant_id = ${tenantId} AND email = ${normalizedEmail}
        LIMIT 1
      `;

  let tenantUserId = userByExternalRows[0]?.id ?? userByEmailRows[0]?.id ?? null;

  if (!tenantUserId) {
    const insertedUserRows = await sql<Array<{ id: string }>>`
      INSERT INTO ${sql(schemaName)}.users (
        external_id,
        tenant_id,
        display_name,
        email,
        role,
        last_login_at
      ) VALUES (
        ${regularUser.id},
        ${tenantId},
        ${regularUser.username},
        ${normalizedEmail},
        'user',
        ${nowIso}::timestamptz
      )
      RETURNING id
    `;
    tenantUserId = insertedUserRows[0]?.id ?? null;
  } else {
    await sql`
      UPDATE ${sql(schemaName)}.users
      SET external_id = ${regularUser.id},
          display_name = COALESCE(${regularUser.username}, display_name),
          email = ${normalizedEmail},
          last_login_at = ${nowIso}::timestamptz
      WHERE id = ${tenantUserId}
    `;
  }

  if (!tenantUserId) {
    throw new Error(`Failed to create or resolve tenant user for ${normalizedEmail}`);
  }

  const userAgentExternalId = "quickstart:tenant-user";
  const legacyDashboardExternalId = `dashboard:${tenantUserId}`;
  const existingAgentRows = await sql<Array<{ id: string }>>`
    SELECT id
    FROM ${sql(schemaName)}.agents
    WHERE external_id = ${userAgentExternalId}
    LIMIT 1
  `;

  const legacyAgentRows = existingAgentRows[0]?.id
    ? []
    : await sql<Array<{ id: string }>>`
        SELECT id
        FROM ${sql(schemaName)}.agents
        WHERE external_id = ${legacyDashboardExternalId}
        LIMIT 1
      `;

  const targetAgentId = existingAgentRows[0]?.id ?? legacyAgentRows[0]?.id ?? null;

  if (targetAgentId) {
    const apiKey = generateApiKey(targetAgentId);
    const { hash, salt } = hashApiKey(apiKey);
    await sql`
      UPDATE ${sql(schemaName)}.agents
      SET external_id = ${userAgentExternalId},
          user_id = ${tenantUserId},
          role = 'user',
          is_autonomous = FALSE,
          api_key_hash = ${hash},
          api_key_salt = ${salt},
          revoked_at = NULL
      WHERE id = ${targetAgentId}
    `;
    await ensureAdminAgentMembership(sql, tenantId, targetAgentId);
    return {
      apiKey,
      agentId: targetAgentId,
      agentExternalId: userAgentExternalId,
      ownerEmail: normalizedEmail,
      userId: tenantUserId,
    };
  }

  const provisioned = await provisionAgentWithApiKey(sql, {
    externalId: userAgentExternalId,
    tenantId,
    userId: tenantUserId,
    role: "user",
    isAutonomous: false,
  });
  await ensureAdminAgentMembership(sql, tenantId, provisioned.agent.id);

  return {
    apiKey: provisioned.rawApiKey,
    agentId: provisioned.agent.id,
    agentExternalId: userAgentExternalId,
    ownerEmail: normalizedEmail,
    userId: tenantUserId,
  };
}

function renderLoginDetails(summary: KeycloakSummary | null) {
  const keycloakPort = env("KEYCLOAK_PORT", "3400");
  const keycloakBaseUrl = env("KEYCLOAK_BASE_URL", `http://localhost:${keycloakPort}`);
  const keycloakAdmin = env("KEYCLOAK_ADMIN", "admin");
  const keycloakAdminPassword = env("KEYCLOAK_ADMIN_PASSWORD", "admin");
  const platformAdminUsername = env("KEYCLOAK_PLATFORM_ADMIN_USERNAME", "platform-admin");
  const platformAdminEmail = env("KEYCLOAK_PLATFORM_ADMIN_EMAIL", "platform-admin@example.com");
  const platformAdminPassword = env("KEYCLOAK_PLATFORM_ADMIN_PASSWORD", "MonetPlatform1!");
  const tenantAdminUsername = env("KEYCLOAK_TENANT_ADMIN_USERNAME", "tenant-admin");
  const tenantAdminEmail = env("KEYCLOAK_TENANT_ADMIN_EMAIL", "tenant-admin@example.com");
  const tenantAdminPassword = env("KEYCLOAK_TENANT_ADMIN_PASSWORD", "MonetTenantAdmin1!");
  const tenantUserUsername = env("KEYCLOAK_TENANT_USER_USERNAME", "tenant-user");
  const tenantUserEmail = env("KEYCLOAK_TENANT_USER_EMAIL", "tenant-user@example.com");
  const tenantUserPassword = env("KEYCLOAK_TENANT_USER_PASSWORD", "MonetTenantUser1!");

  const resolvedConsole =
    summary?.keycloak?.adminConsoleUrl || `${summary?.keycloak?.baseUrl || keycloakBaseUrl}/admin/`;
  const resolvedPlatformAdmin = summary?.platform?.adminUser;
  const resolvedTenantAdmin = summary?.tenant?.adminUser;
  const resolvedTenantUser = summary?.tenant?.regularUser;

  return [
    "Login details",
    "-------------------",
    `Dashboard URL: ${env("NEXTAUTH_URL", "http://localhost:3310")}`,
    `Keycloak admin console: ${resolvedConsole}`,
    `Keycloak bootstrap admin: ${summary?.keycloak?.adminUsername || keycloakAdmin}`,
    `Keycloak bootstrap admin password: ${keycloakAdminPassword}`,
    "",
    "Platform admin user",
    `  username: ${resolvedPlatformAdmin?.username || platformAdminUsername}`,
    `  email:    ${resolvedPlatformAdmin?.email || platformAdminEmail}`,
    `  password: ${resolvedPlatformAdmin?.password || platformAdminPassword}`,
    "",
    "Tenant demo users (realm defaults)",
    `  admin username: ${resolvedTenantAdmin?.username || tenantAdminUsername}`,
    `  admin email:    ${resolvedTenantAdmin?.email || tenantAdminEmail}`,
    `  admin password: ${resolvedTenantAdmin?.password || tenantAdminPassword}`,
    `  user username:  ${resolvedTenantUser?.username || tenantUserUsername}`,
    `  user email:     ${resolvedTenantUser?.email || tenantUserEmail}`,
    `  user password:  ${resolvedTenantUser?.password || tenantUserPassword}`,
  ].join("\n");
}

async function main() {
  const profile = env("QUICKSTART_PROFILE", "local");
  const defaultApiPort = profile === "runtime" ? "4301" : "3301";
  const defaultDashboardUrl = profile === "runtime" ? "http://localhost:4310" : "http://localhost:3310";
  const defaultKeycloakPort = profile === "runtime" ? "4400" : "3400";
  const defaultKeycloakOutput = profile === "runtime" ? ".runtime/keycloak.json" : ".local-dev/keycloak.json";

  const databaseUrl = env("DATABASE_URL");
  const apiPort = env("API_PORT", defaultApiPort);
  const publicApiBase = env("PUBLIC_API_URL", `http://127.0.0.1:${apiPort}`).replace(/\/$/, "");
  const tenantSlug = env("QUICKSTART_TENANT_SLUG", DEFAULT_DEMO_TENANT_SLUG);
  const tenantName = env("QUICKSTART_TENANT_NAME", DEFAULT_DEMO_TENANT_NAME);
  const keycloakOutput = path.resolve(
    rootDir,
    env("LOCAL_KEYCLOAK_OUTPUT", defaultKeycloakOutput),
  );
  const captureOnly = env("QUICKSTART_INIT_CAPTURE_ONLY", "0") === "1";
  const summaryFile = process.env.QUICKSTART_INIT_SUMMARY_FILE;

  const { db, sql } = createClient(databaseUrl);
  try {
    process.env.LOCAL_KEYCLOAK_OUTPUT = keycloakOutput;
    await runLocalKeycloakBootstrap();
    const keycloakSummary = await readKeycloakSummary(keycloakOutput);
    const platformSummary = assertPlatformSummary(keycloakSummary, {
      profile,
      summaryPath: keycloakOutput,
    });
    const tenantSummary = assertTenantSummary(keycloakSummary, {
      profile,
      summaryPath: keycloakOutput,
    });
    const initializedNow = await ensureLocalPlatformSetup(sql, platformSummary);
    const tenantResult = await ensureDemoTenantAndApiKey(sql, db, tenantName, tenantSlug);
    await ensureTenantOauthConfig(sql, tenantResult.tenant.id, tenantSummary.tenant);
    await ensureTenantAdminNomination(sql, {
      tenantId: tenantResult.tenant.id,
      tenantAdminEmail: tenantSummary.tenant.adminUser.email,
      platformAdminEmail: platformSummary.platform.adminUser.email,
    });
    const userOwnedMcpAgent = await ensureTenantUserOwnedMcpAgentApiKey(
      sql,
      tenantResult.tenant.id,
      tenantSummary.tenant.regularUser,
    );

    console.log(`${profile === "runtime" ? "Runtime" : "Local"} quickstart init complete.`);
    console.log(`Platform initialized this run: ${initializedNow ? "yes" : "no"}`);
    console.log(`Tenant created this run: ${tenantResult.createdTenant ? "yes" : "no"}`);
    console.log(`Tenant: ${tenantResult.tenant.slug} (${tenantResult.tenant.name})`);
    console.log(`Bootstrap admin agent: ${tenantResult.adminExternalId}`);
    console.log(`MCP key owner: ${userOwnedMcpAgent.ownerEmail}`);
    console.log(`MCP agent id: ${userOwnedMcpAgent.agentId}`);
    console.log(`MCP agent external id: ${userOwnedMcpAgent.agentExternalId}`);
    if (!captureOnly) {
      console.log(`MCP API key: ${userOwnedMcpAgent.apiKey}`);
    }
    console.log("Note: re-running quickstart init rotates/replaces the printed API key.");

    const mcpConfig = JSON.stringify({
      mcpServers: {
        monet: {
          url: `${publicApiBase}/mcp/${tenantResult.tenant.slug}`,
          headers: {
            Authorization: `Bearer ${userOwnedMcpAgent.apiKey}`,
          },
        },
      },
    }, null, 2);

    process.env.NEXTAUTH_URL = process.env.NEXTAUTH_URL || defaultDashboardUrl;
    process.env.KEYCLOAK_PORT = process.env.KEYCLOAK_PORT || defaultKeycloakPort;

    const loginDetails = renderLoginDetails(keycloakSummary);
    const summaryBlock = [
      "Ready-to-copy MCP config",
      "------------------------",
      mcpConfig,
      "",
      loginDetails,
      "",
      "Credentials above are for local development only.",
    ].join("\n");

    if (summaryFile) {
      await writeFile(summaryFile, `${summaryBlock}\n`, "utf-8");
    }

    if (!captureOnly) {
      console.log(`\n${summaryBlock}`);
    }

  } finally {
    await sql.end({ timeout: 5 });
  }
}

void main().catch((error) => {
  console.error("quickstart-init failed", error);
  process.exit(1);
});
