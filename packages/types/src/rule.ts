import { z } from "zod";

export const Rule = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  updatedAt: z.coerce.date(),
  createdAt: z.coerce.date(),
});
export type Rule = z.infer<typeof Rule>;

export const RuleSet = z.object({
  id: z.string().uuid(),
  name: z.string(),
  ruleIds: z.array(z.string().uuid()),
  createdAt: z.coerce.date(),
});
export type RuleSet = z.infer<typeof RuleSet>;

export const CreateRuleInput = z.object({
  name: z.string().min(1, "Rule name is required").max(255),
  description: z.string().min(1, "Rule description is required"),
});
export type CreateRuleInput = z.infer<typeof CreateRuleInput>;

export const UpdateRuleInput = z.object({
  name: z.string().min(1, "Rule name is required").max(255).optional(),
  description: z.string().min(1, "Rule description is required").optional(),
});
export type UpdateRuleInput = z.infer<typeof UpdateRuleInput>;

export const CreateRuleSetInput = z.object({
  name: z.string().min(1, "Rule set name is required").max(255),
});
export type CreateRuleSetInput = z.infer<typeof CreateRuleSetInput>;
