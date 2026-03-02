import { z } from "zod";

export const Rule = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  createdAt: z.date(),
});
export type Rule = z.infer<typeof Rule>;

export const RuleSet = z.object({
  id: z.string().uuid(),
  name: z.string(),
  ruleIds: z.array(z.string().uuid()),
  createdAt: z.date(),
});
export type RuleSet = z.infer<typeof RuleSet>;

export const CreateRuleInput = z.object({
  name: z.string().min(1, "Rule name is required"),
  description: z.string().min(1, "Rule description is required"),
});
export type CreateRuleInput = z.infer<typeof CreateRuleInput>;
