import "dotenv/config";
import { 
  createClient, 
  createTenantSchema, 
  tenantSchemaNameFromId,
  tenants, 
  humanUsers, 
  agents, 
  agentGroups, 
  agentGroupMembers,
  memoryEntries, 
  auditLog, 
  rules, 
  ruleSets, 
  ruleSetRules, 
  agentRuleSets
} from "@monet/db";
import { eq } from "drizzle-orm";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KEY_PREFIX = "mnt_";

function generateApiKey(agentId: string): string {
  const agentPart = Buffer.from(agentId).toString("base64url");
  const secretPart = randomBytes(32).toString("base64url");
  return `${KEY_PREFIX}${agentPart}.${secretPart}`;
}

function hashApiKey(rawKey: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256")
    .update(salt + rawKey)
    .digest("hex");
  return { hash, salt };
}

async function seed() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }

  console.log("Connecting to database...");
  const { db, sql } = createClient(databaseUrl);

  console.log("Running platform migrations...");
  // Platform migrations are in packages/db/drizzle
  const migrationsFolder = path.resolve(__dirname, "../../../packages/db/drizzle");
  await migrate(db, { migrationsFolder });

  console.log("Cleaning up existing test data...");
  // This is a destructive operation for testing
  await db.delete(agentGroupMembers).execute();
  await db.delete(agents).execute();
  await db.delete(humanUsers).execute();
  await db.delete(agentGroups).execute();
  await sql.unsafe(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'tenant_oauth_configs'
      ) THEN
        DELETE FROM "tenant_oauth_configs";
      END IF;
    END $$;
  `);
  await db.delete(tenants).execute();

  console.log("Creating test tenant...");
  const [tenant] = await db.insert(tenants).values({
    name: "Test Org",
    isolationMode: "logical",
  }).returning();

  const tenantId = tenant.id;
  const schemaName = tenantSchemaNameFromId(tenantId);
  console.log(`Creating tenant schema: ${schemaName}`);
  await createTenantSchema(sql, tenantId);

  console.log("Creating test human user...");
  const [user] = await db.insert(humanUsers).values({
    externalId: "test-user-id",
    tenantId: tenantId,
    role: "tenant_admin",
  }).returning();

  console.log("Creating test agents...");
  const agentData = [
    { name: "agent-1", isAutonomous: true },
    { name: "agent-2", isAutonomous: false },
    { name: "agent-3", isAutonomous: true },
  ];

  const createdAgents = [];
  for (const data of agentData) {
    const agentId = randomUUID();
    const apiKey = generateApiKey(agentId);
    const { hash, salt } = hashApiKey(apiKey);

    const [agent] = await db.insert(agents).values({
      id: agentId,
      externalId: data.name,
      tenantId: tenantId,
      userId: user.id,
      apiKeyHash: hash,
      apiKeySalt: salt,
      isAutonomous: data.isAutonomous,
    }).returning();
    
    createdAgents.push({ ...agent, apiKey });
  }

  console.log("Creating groups...");
  const [engGroup] = await db.insert(agentGroups).values({
    tenantId: tenantId,
    name: "engineering",
    description: "Engineering team",
    memoryQuota: 1000,
  }).returning();

  const [prodGroup] = await db.insert(agentGroups).values({
    tenantId: tenantId,
    name: "product",
    description: "Product team",
    memoryQuota: 500,
  }).returning();

  console.log("Assigning agents to groups...");
  await db.insert(agentGroupMembers).values([
    { agentId: createdAgents[0].id, groupId: engGroup.id },
    { agentId: createdAgents[1].id, groupId: engGroup.id },
    { agentId: createdAgents[2].id, groupId: prodGroup.id },
  ]).execute();

  console.log("Creating test memories...");
  const types = ["decision", "pattern", "issue", "preference", "fact", "procedure"] as const;
  const scopes = ["group", "user", "private"] as const;

  for (let i = 0; i < 60; i++) {
    const agent = createdAgents[i % createdAgents.length];
    const type = types[i % types.length];
    const scope = scopes[i % scopes.length];
    
    await sql.unsafe(`
      INSERT INTO "${schemaName}".memory_entries (
        content, summary, memory_type, memory_scope, author_agent_id, group_id, user_id, tags
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8
      )
    `, [
      `Content for memory ${i}: ${Math.random().toString(36).substring(7)}`,
      `Summary ${i}`,
      type,
      scope,
      agent.id,
      scope === "group" ? (i % 2 === 0 ? engGroup.id : prodGroup.id) : null,
      scope === "user" ? user.id : null,
      ["test", type, scope]
    ]);
  }

  console.log("Creating rules...");
  const createdRules = [];
  for (let i = 1; i <= 5; i++) {
    const [rule] = await sql.unsafe(`
      INSERT INTO "${schemaName}".rules (name, description)
      VALUES ($1, $2)
      RETURNING *
    `, [`Rule ${i}`, `Description for rule ${i}`]);
    createdRules.push(rule);
  }

  console.log("Creating rule sets...");
  for (let i = 1; i <= 2; i++) {
    const [rs] = await sql.unsafe(`
      INSERT INTO "${schemaName}".rule_sets (name)
      VALUES ($1)
      RETURNING *
    `, [`Rule Set ${i}`]);

    await sql.unsafe(`
      INSERT INTO "${schemaName}".rule_set_rules (rule_set_id, rule_id)
      VALUES ($1, $2), ($1, $3)
    `, [rs.id, createdRules[0].id, createdRules[i].id]);

    await sql.unsafe(`
      INSERT INTO "${schemaName}".agent_rule_sets (agent_id, rule_set_id)
      VALUES ($1, $2)
    `, [createdAgents[i-1].id, rs.id]);
  }

  console.log("Creating audit log entries...");
  for (let i = 0; i < 25; i++) {
    await sql.unsafe(`
      INSERT INTO "${schemaName}".audit_log (tenant_id, actor_id, actor_type, action, outcome, reason)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      tenantId,
      createdAgents[i % createdAgents.length].id,
      "agent",
      "memory_create",
      "success",
      `Audit log entry ${i}`
    ]);
  }

  console.log("Creating dashboard agent...");
  const dashboardAgentId = randomUUID();
  const dashboardApiKey = generateApiKey(dashboardAgentId);
  const { hash: dashHash, salt: dashSalt } = hashApiKey(dashboardApiKey);

  await db.insert(agents).values({
    id: dashboardAgentId,
    externalId: "dashboard-agent",
    tenantId: tenantId,
    userId: user.id,
    apiKeyHash: dashHash,
    apiKeySalt: dashSalt,
    isAutonomous: false,
  }).execute();

  console.log("\n" + "=".repeat(40));
  console.log("SEEDING COMPLETED SUCCESSFULLY");
  console.log("=".repeat(40));
  console.log(`Tenant ID:    ${tenantId}`);
  console.log(`Tenant Slug:  test-org (Note: use this for login)`);
  console.log(`User ID:      ${user.id}`);
  console.log(`External ID:  ${user.externalId}`);
  console.log(`Dashboard Agent API Key: ${dashboardApiKey}`);
  console.log("=".repeat(40));
  console.log("Agents:");
  createdAgents.forEach(a => {
    console.log(`- ${a.externalId}: ${a.apiKey}`);
  });
  console.log("=".repeat(40) + "\n");

  await sql.end();
}

seed().catch(err => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
