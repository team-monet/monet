import { z } from "zod";

export const SearchQuery = z.object({
  query: z.string().optional(),
  tags: z.array(z.string()).optional(),
  memoryType: z.string().optional(),
  includeUser: z.boolean().default(false),
  includePrivate: z.boolean().default(false),
  fromDate: z.string().datetime().optional(),
  toDate: z.string().datetime().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(100).default(20),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export const PaginatedResponse = <T extends z.ZodType>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable(),
    total: z.number().int().nonnegative(),
  });

export const ApiError = z.object({
  error: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ApiError = z.infer<typeof ApiError>;

export const RegisterAgentApiInput = z.object({
  externalId: z.string().min(1, "External agent ID is required"),
  isAutonomous: z.boolean().default(false),
  userId: z.string().uuid().optional(),
  groupId: z.string().uuid().optional(),
});
export type RegisterAgentApiInput = z.infer<typeof RegisterAgentApiInput>;
