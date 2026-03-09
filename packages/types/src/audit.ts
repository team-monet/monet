import { z } from "zod";

export const AuditLog = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  actor_id: z.string().uuid(),
  actor_type: z.string(),
  actor_display_name: z.string().nullable().optional(),
  action: z.string(),
  target_id: z.string().nullable().optional(),
  outcome: z.string(),
  reason: z.string().nullable().optional(),
  created_at: z.string(),
});
export type AuditLog = z.infer<typeof AuditLog>;
