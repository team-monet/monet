import { z } from "zod";

export const RegisterAgentInput = z.object({
  agentId: z.string().min(1, "Agent identifier is required"),
  userId: z.string().uuid().optional(),
  groupId: z.string().uuid().optional(),
});
export type RegisterAgentInput = z.infer<typeof RegisterAgentInput>;

export const Agent = z.object({
  id: z.string().uuid(),
  externalId: z.string(),
  userId: z.string().uuid().nullable(),
  isAutonomous: z.boolean(),
  createdAt: z.date(),
});
export type Agent = z.infer<typeof Agent>;

export const AgentGroup = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  memoryQuota: z.number().int().positive().nullable(),
  createdAt: z.date(),
});
export type AgentGroup = z.infer<typeof AgentGroup>;

export const CreateGroupInput = z.object({
  name: z.string().min(1, "Group name is required"),
  description: z.string().default(""),
});
export type CreateGroupInput = z.infer<typeof CreateGroupInput>;

export const Tenant = z.object({
  id: z.string().uuid(),
  name: z.string(),
  isolationMode: z.enum(["logical", "physical"]),
  createdAt: z.date(),
});
export type Tenant = z.infer<typeof Tenant>;

export const HumanUser = z.object({
  id: z.string().uuid(),
  externalId: z.string(),
  tenantId: z.string().uuid(),
  role: z.enum(["user", "group_admin", "tenant_admin"]),
  createdAt: z.date(),
});
export type HumanUser = z.infer<typeof HumanUser>;
