import { z } from "zod";

export const CreateTenantInput = z.object({
  name: z.string().min(1, "Tenant name is required").max(255),
  isolationMode: z.enum(["logical", "physical"]).default("logical"),
});
export type CreateTenantInput = z.infer<typeof CreateTenantInput>;

export const CreateTenantResponse = z.object({
  tenant: z.object({
    id: z.string().uuid(),
    name: z.string(),
    isolationMode: z.enum(["logical", "physical"]),
    createdAt: z.date(),
  }),
  agent: z.object({
    id: z.string().uuid(),
    externalId: z.string(),
  }),
  apiKey: z.string(),
});
export type CreateTenantResponse = z.infer<typeof CreateTenantResponse>;

export const RegisterAgentApiInput = z.object({
  externalId: z.string().min(1, "External agent ID is required"),
  isAutonomous: z.boolean().default(false),
});
export type RegisterAgentApiInput = z.infer<typeof RegisterAgentApiInput>;

export const RegisterAgentApiResponse = z.object({
  agent: z.object({
    id: z.string().uuid(),
    externalId: z.string(),
    isAutonomous: z.boolean(),
    createdAt: z.date(),
  }),
  apiKey: z.string(),
});
export type RegisterAgentApiResponse = z.infer<typeof RegisterAgentApiResponse>;
