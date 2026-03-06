import {
  pgTable,
  uuid,
  varchar,
  boolean,
  timestamp,
  pgEnum,
  integer,
} from "drizzle-orm/pg-core";

export const isolationModeEnum = pgEnum("isolation_mode", [
  "logical",
  "physical",
]);

export const userRoleEnum = pgEnum("user_role", [
  "user",
  "group_admin",
  "tenant_admin",
]);

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull().unique(),
  isolationMode: isolationModeEnum("isolation_mode")
    .notNull()
    .default("logical"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const humanUsers = pgTable("human_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  externalId: varchar("external_id", { length: 255 }).notNull(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  role: userRoleEnum("role").notNull().default("user"),
  dashboardApiKeyEncrypted: varchar("dashboard_api_key_encrypted", {
    length: 1024,
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const tenantOauthConfigs = pgTable("tenant_oauth_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id)
    .unique(),
  provider: varchar("provider", { length: 50 }).notNull().default("oidc"),
  issuer: varchar("issuer", { length: 255 }).notNull(),
  issuerUrl: varchar("issuer_url", { length: 512 }),
  clientId: varchar("client_id", { length: 255 }).notNull(),
  clientSecretEncrypted: varchar("client_secret_encrypted", {
    length: 1024,
  }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  externalId: varchar("external_id", { length: 255 }).notNull(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  userId: uuid("user_id").references(() => humanUsers.id),
  role: userRoleEnum("role"),
  apiKeyHash: varchar("api_key_hash", { length: 255 }).notNull(),
  apiKeySalt: varchar("api_key_salt", { length: 255 }).notNull(),
  isAutonomous: boolean("is_autonomous").notNull().default(false),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const agentGroups = pgTable("agent_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  name: varchar("name", { length: 255 }).notNull(),
  description: varchar("description", { length: 1024 }).default(""),
  memoryQuota: integer("memory_quota"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const agentGroupMembers = pgTable("agent_group_members", {
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  groupId: uuid("group_id")
    .notNull()
    .references(() => agentGroups.id),
  joinedAt: timestamp("joined_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
