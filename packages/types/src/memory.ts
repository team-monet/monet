import { z } from "zod";

export const MemoryScope = z.enum(["group", "user", "private"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

export const MemoryType = z.enum([
  "decision",
  "pattern",
  "issue",
  "preference",
  "fact",
  "procedure",
]);
export type MemoryType = z.infer<typeof MemoryType>;

export const CreateMemoryEntryInput = z.object({
  content: z.string().min(1, "Content is required"),
  memoryType: MemoryType,
  memoryScope: MemoryScope.default("group"),
  tags: z.array(z.string()).min(1, "At least one tag is required"),
  ttlSeconds: z.number().positive().optional(),
});
export type CreateMemoryEntryInput = z.infer<typeof CreateMemoryEntryInput>;

export const UpdateMemoryEntryInput = z.object({
  content: z.string().min(1).optional(),
  tags: z.array(z.string()).min(1).optional(),
  memoryScope: MemoryScope.optional(),
  memoryType: MemoryType.optional(),
  outdated: z.boolean().optional(),
  expectedVersion: z.number().int().nonnegative(),
});
export type UpdateMemoryEntryInput = z.infer<typeof UpdateMemoryEntryInput>;

export const MemoryEntry = z.object({
  id: z.string().uuid(),
  content: z.string(),
  summary: z.string().max(200).nullable(),
  memoryType: MemoryType,
  memoryScope: MemoryScope,
  tags: z.array(z.string()),
  autoTags: z.array(z.string()),
  relatedMemoryIds: z.array(z.string().uuid()),
  usefulnessScore: z.number().int().nonnegative(),
  outdated: z.boolean(),
  ttlSeconds: z.number().positive().nullable(),
  expiresAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  lastAccessedAt: z.coerce.date(),
  authorAgentId: z.string().uuid(),
  authorAgentDisplayName: z.string().nullable().optional(),
  groupId: z.string().uuid().nullable(),
  userId: z.string().uuid().nullable(),
  version: z.number().int().nonnegative(),
});
export type MemoryEntry = z.infer<typeof MemoryEntry>;

export const MemoryEntryTier1 = MemoryEntry.pick({
  id: true,
  summary: true,
  memoryType: true,
  memoryScope: true,
  tags: true,
  autoTags: true,
  usefulnessScore: true,
  outdated: true,
  createdAt: true,
  authorAgentId: true,
  authorAgentDisplayName: true,
});
export type MemoryEntryTier1 = z.infer<typeof MemoryEntryTier1>;

export const MemoryVersion = z.object({
  id: z.string().uuid(),
  memoryEntryId: z.string().uuid(),
  content: z.string(),
  version: z.number().int().nonnegative(),
  authorAgentId: z.string().uuid(),
  createdAt: z.date(),
});
export type MemoryVersion = z.infer<typeof MemoryVersion>;
