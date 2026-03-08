import { z } from "zod";

export const TENANT_SLUG_MAX_LENGTH = 63;
export const tenantSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function normalizeTenantSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, TENANT_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
}

export function slugifyTenantName(name: string) {
  const asciiName = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  return normalizeTenantSlug(asciiName) || "tenant";
}

export const TenantSlug = z
  .string()
  .trim()
  .min(2, "Tenant slug is required")
  .max(TENANT_SLUG_MAX_LENGTH, `Tenant slug must be ${TENANT_SLUG_MAX_LENGTH} characters or fewer`)
  .regex(
    tenantSlugPattern,
    "Tenant slug must use lowercase letters, numbers, and hyphens only",
  );

export const CreateTenantInput = z.object({
  name: z.string().min(1, "Tenant name is required").max(255),
  slug: TenantSlug.optional(),
  isolationMode: z.enum(["logical", "physical"]).default("logical"),
});
export type CreateTenantInput = z.infer<typeof CreateTenantInput>;

export const CreateTenantResponse = z.object({
  tenant: z.object({
    id: z.string().uuid(),
    name: z.string(),
    slug: TenantSlug,
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

export const RegisterAgentApiResponse = z.object({
  agent: z.object({
    id: z.string().uuid(),
    externalId: z.string(),
    userId: z.string().uuid().nullable().optional(),
    isAutonomous: z.boolean(),
    createdAt: z.date(),
  }),
  apiKey: z.string(),
});
export type RegisterAgentApiResponse = z.infer<typeof RegisterAgentApiResponse>;
