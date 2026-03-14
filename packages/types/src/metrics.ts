import { z } from "zod";

// --- Usage metrics ---

export const ReadWriteFrequency = z.object({
  date: z.string(),
  reads: z.number(),
  writes: z.number(),
  searches: z.number(),
});
export type ReadWriteFrequency = z.infer<typeof ReadWriteFrequency>;

export const ActiveAgents = z.object({
  period7d: z.number(),
  period30d: z.number(),
  total: z.number(),
});
export type ActiveAgents = z.infer<typeof ActiveAgents>;

export const EnrichmentThroughput = z.object({
  pending: z.number(),
  processing: z.number(),
  completed: z.number(),
  failed: z.number(),
});
export type EnrichmentThroughput = z.infer<typeof EnrichmentThroughput>;

export const SearchHitRate = z.object({
  total: z.number(),
  withResults: z.number(),
  rate: z.number(),
});
export type SearchHitRate = z.infer<typeof SearchHitRate>;

export const UsageMetrics = z.object({
  readWriteFrequency: z.array(ReadWriteFrequency),
  activeAgents: ActiveAgents,
  enrichmentThroughput: EnrichmentThroughput,
  searchHitRate: SearchHitRate.nullable(),
  semanticSearchPct: z.number().nullable(),
});
export type UsageMetrics = z.infer<typeof UsageMetrics>;

// --- Benefit metrics ---

export const BucketCount = z.object({
  bucket: z.string(),
  count: z.number(),
});
export type BucketCount = z.infer<typeof BucketCount>;

export const TagDiversity = z.object({
  groupId: z.string(),
  groupName: z.string(),
  tagCount: z.number(),
  topTags: z.array(z.string()),
});
export type TagDiversity = z.infer<typeof TagDiversity>;

export const EnrichmentQuality = z.object({
  withSummary: z.number(),
  withEmbedding: z.number(),
  withAutoTags: z.number(),
  total: z.number(),
});
export type EnrichmentQuality = z.infer<typeof EnrichmentQuality>;

export const CrossAgentPair = z.object({
  writerAgentId: z.string(),
  readerAgentId: z.string(),
  count: z.number(),
});
export type CrossAgentPair = z.infer<typeof CrossAgentPair>;

export const CrossAgentSharing = z.object({
  totalShared: z.number(),
  topPairs: z.array(CrossAgentPair),
});
export type CrossAgentSharing = z.infer<typeof CrossAgentSharing>;

export const BenefitMetrics = z.object({
  usefulnessDistribution: z.array(BucketCount),
  memoryReuseRate: z.array(BucketCount),
  tagDiversityByGroup: z.array(TagDiversity),
  enrichmentQuality: EnrichmentQuality,
  crossAgentSharing: CrossAgentSharing.nullable(),
});
export type BenefitMetrics = z.infer<typeof BenefitMetrics>;

// --- Health metrics ---

export const MemoryLifecycle = z.object({
  avgAgeDays: z.number(),
  outdatedPct: z.number(),
  expiryRate: z.number(),
});
export type MemoryLifecycle = z.infer<typeof MemoryLifecycle>;

export const QuotaUtilization = z.object({
  groupId: z.string(),
  groupName: z.string(),
  current: z.number(),
  quota: z.number(),
});
export type QuotaUtilization = z.infer<typeof QuotaUtilization>;

export const HealthMetrics = z.object({
  memoryLifecycle: MemoryLifecycle,
  quotaUtilization: z.array(QuotaUtilization),
});
export type HealthMetrics = z.infer<typeof HealthMetrics>;

// --- Combined response ---

export const MetricsResponse = z.object({
  usage: UsageMetrics,
  benefit: BenefitMetrics,
  health: HealthMetrics,
});
export type MetricsResponse = z.infer<typeof MetricsResponse>;
