import { z } from "zod";
import { TenantSlug } from "./auth";
import { RuleSet } from "./rule";

export const RegisterAgentInput = z.object({
  agentId: z.string().min(1, "Agent identifier is required"),
  userId: z.string().uuid().optional(),
  groupId: z.string().uuid().optional(),
});
export type RegisterAgentInput = z.infer<typeof RegisterAgentInput>;

export const UserRole = z.enum(["user", "group_admin", "tenant_admin"]);
export type UserRole = z.infer<typeof UserRole>;

export const AgentOwner = z.object({
  id: z.string().uuid(),
  externalId: z.string(),
  displayName: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  label: z.string(),
});
export type AgentOwner = z.infer<typeof AgentOwner>;

export const AgentGroup = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  memoryQuota: z.number().int().positive().nullable(),
  createdAt: z.coerce.date(),
});
export type AgentGroup = z.infer<typeof AgentGroup>;

export const Agent = z.object({
  id: z.string().uuid(),
  externalId: z.string(),
  tenantId: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  isAutonomous: z.boolean(),
  role: UserRole.nullable().optional(),
  revokedAt: z.coerce.date().nullable().optional(),
  displayName: z.string().optional(),
  owner: AgentOwner.nullable().optional(),
  createdAt: z.coerce.date(),
});
export type Agent = z.infer<typeof Agent>;

export const AgentDetail = Agent.extend({
  groups: z.array(AgentGroup),
  ruleSets: z.array(RuleSet),
});
export type AgentDetail = z.infer<typeof AgentDetail>;

export const CreateGroupInput = z.object({
  name: z.string().min(1, "Group name is required"),
  description: z.string().default(""),
});
export type CreateGroupInput = z.infer<typeof CreateGroupInput>;

export const Tenant = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: TenantSlug,
  isolationMode: z.enum(["logical", "physical"]),
  createdAt: z.coerce.date(),
});
export type Tenant = z.infer<typeof Tenant>;

export const TenantUser = z.object({
  id: z.string().uuid(),
  externalId: z.string(),
  tenantId: z.string().uuid(),
  displayName: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  role: UserRole,
  lastLoginAt: z.coerce.date().nullable().optional(),
  createdAt: z.coerce.date(),
});
export type TenantUser = z.infer<typeof TenantUser>;
