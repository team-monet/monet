import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  boolean,
  timestamp,
  pgEnum,
  vector,
  index,
  primaryKey,
  jsonb,
} from "drizzle-orm/pg-core";

export const memoryScopeEnum = pgEnum("memory_scope", [
  "group",
  "user",
  "private",
]);

export const memoryTypeEnum = pgEnum("memory_type", [
  "decision",
  "pattern",
  "issue",
  "preference",
  "fact",
  "procedure",
]);

export const enrichmentStatusEnum = pgEnum("enrichment_status", [
  "pending",
  "processing",
  "completed",
  "failed",
]);

export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    content: text("content").notNull(),
    summary: varchar("summary", { length: 200 }),
    enrichmentStatus: enrichmentStatusEnum("enrichment_status")
      .notNull()
      .default("pending"),
    memoryType: memoryTypeEnum("memory_type").notNull(),
    memoryScope: memoryScopeEnum("memory_scope").notNull().default("group"),
    tags: text("tags").array().notNull().default([]),
    autoTags: text("auto_tags").array().notNull().default([]),
    embedding: vector("embedding", {
      dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || "1024", 10),
    }),
    relatedMemoryIds: uuid("related_memory_ids").array().notNull().default([]),
    usefulnessScore: integer("usefulness_score").notNull().default(0),
    outdated: boolean("outdated").notNull().default(false),
    ttlSeconds: integer("ttl_seconds"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    authorAgentId: uuid("author_agent_id").notNull(),
    groupId: uuid("group_id"),
    userId: uuid("user_id"),
    version: integer("version").notNull().default(0),
  },
  (table) => [
    index("idx_memory_scope").on(table.memoryScope),
    index("idx_memory_type").on(table.memoryType),
    index("idx_memory_author").on(table.authorAgentId),
    index("idx_memory_group").on(table.groupId),
    index("idx_memory_user").on(table.userId),
    index("idx_memory_expires").on(table.expiresAt),
  ]
);

export const memoryVersions = pgTable("memory_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  memoryEntryId: uuid("memory_entry_id")
    .notNull()
    .references(() => memoryEntries.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  version: integer("version").notNull(),
  authorAgentId: uuid("author_agent_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  actorId: uuid("actor_id").notNull(),
  actorType: varchar("actor_type", { length: 20 }).notNull(),
  action: varchar("action", { length: 50 }).notNull(),
  targetId: varchar("target_id", { length: 255 }),
  outcome: varchar("outcome", { length: 20 }).notNull(),
  reason: text("reason"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const rules = pgTable("rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description").notNull(),
  ownerUserId: uuid("owner_user_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  index("idx_rules_owner_user").on(table.ownerUserId),
]);

export const ruleSets = pgTable("rule_sets", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  ownerUserId: uuid("owner_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [
  index("idx_rule_sets_owner_user").on(table.ownerUserId),
]);

export const ruleSetRules = pgTable(
  "rule_set_rules",
  {
    ruleSetId: uuid("rule_set_id")
      .notNull()
      .references(() => ruleSets.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => rules.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.ruleSetId, table.ruleId] }),
  ],
);

export const agentRuleSets = pgTable(
  "agent_rule_sets",
  {
    agentId: uuid("agent_id").notNull(),
    ruleSetId: uuid("rule_set_id")
      .notNull()
      .references(() => ruleSets.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.ruleSetId] }),
  ],
);

export const groupRuleSets = pgTable(
  "group_rule_sets",
  {
    groupId: uuid("group_id").notNull(),
    ruleSetId: uuid("rule_set_id")
      .notNull()
      .references(() => ruleSets.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.ruleSetId] }),
  ],
);
