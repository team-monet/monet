import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getUsageMetrics,
  getBenefitMetrics,
  getHealthMetrics,
} from "../services/metrics.service";

const withTenantScopeMock = vi.fn();

vi.mock("@monet/db", async () => {
  const actual = await vi.importActual("@monet/db");
  return {
    ...actual,
    withTenantScope: (...args: unknown[]) => withTenantScopeMock(...args),
  };
});

function setupMock(unsafeResults: unknown[][]) {
  let callIndex = 0;
  const unsafeMock = vi.fn().mockImplementation(() => {
    const result = unsafeResults[callIndex] ?? [];
    callIndex++;
    return Promise.resolve(result);
  });
  withTenantScopeMock.mockImplementation(async (_sql, _schemaName, fn) =>
    fn({ unsafe: unsafeMock }),
  );
  return unsafeMock;
}

const TENANT_ID = "00000000-0000-0000-0000-000000000001";

describe("metrics service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getUsageMetrics", () => {
    it("returns 14-day read/write/search frequency with correct shape", async () => {
      const days = Array.from({ length: 14 }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - 13 + i);
        return {
          date: d,
          reads: i,
          writes: i + 1,
          searches: i + 2,
        };
      });

      setupMock([
        days, // frequency query
        [{ period_7d: 5, period_30d: 12, total: 20 }], // active agents
        [{ pending: 3, processing: 1, completed: 50, failed: 2 }], // enrichment
        [{ total: 10, with_results: 8 }], // search hit rate
        [{ total: 10, vector_count: 4 }], // semantic search
      ]);

      const result = await getUsageMetrics({} as never, TENANT_ID);

      expect(result.readWriteFrequency).toHaveLength(14);
      expect(result.readWriteFrequency[0]).toHaveProperty("date");
      expect(result.readWriteFrequency[0]).toHaveProperty("reads");
      expect(result.readWriteFrequency[0]).toHaveProperty("writes");
      expect(result.readWriteFrequency[0]).toHaveProperty("searches");
      expect(result.activeAgents).toEqual({
        period7d: 5,
        period30d: 12,
        total: 20,
      });
      expect(result.enrichmentThroughput).toEqual({
        pending: 3,
        processing: 1,
        completed: 50,
        failed: 2,
      });
      expect(result.searchHitRate).toEqual({ total: 10, withResults: 8, rate: 80 });
      expect(result.semanticSearchPct).toBe(40);
    });

    it("returns zero counts when no data exists", async () => {
      const emptyDays = Array.from({ length: 14 }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - 13 + i);
        return { date: d, reads: 0, writes: 0, searches: 0 };
      });

      setupMock([
        emptyDays,
        [{ period_7d: 0, period_30d: 0, total: 0 }],
        [{ pending: 0, processing: 0, completed: 0, failed: 0 }],
        [{ total: 0, with_results: 0 }],
        [{ total: 0, vector_count: 0 }],
      ]);

      const result = await getUsageMetrics({} as never, TENANT_ID);

      expect(result.activeAgents).toEqual({ period7d: 0, period30d: 0, total: 0 });
      expect(result.enrichmentThroughput).toEqual({
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
      });
      expect(result.searchHitRate).toBeNull();
      expect(result.semanticSearchPct).toBeNull();
    });
  });

  describe("getBenefitMetrics", () => {
    it("returns bucketed usefulness scores and reuse rates", async () => {
      setupMock([
        // usefulness distribution
        [
          { bucket: "0", count: 10 },
          { bucket: "1", count: 5 },
          { bucket: "2-3", count: 8 },
          { bucket: "4-6", count: 3 },
          { bucket: "7+", count: 1 },
        ],
        // reuse rate
        [
          { bucket: "Never accessed", count: 10 },
          { bucket: "1-3 times", count: 12 },
          { bucket: "4-10 times", count: 3 },
          { bucket: "10+ times", count: 1 },
        ],
        // tag diversity
        [
          {
            group_id: "g1",
            group_name: "Team A",
            tag_count: 15,
            top_tags: ["api", "auth", "db"],
          },
        ],
        // enrichment quality
        [{ with_summary: 40, with_embedding: 35, with_auto_tags: 30, total: 50 }],
        // cross-agent sharing
        [{ writer_agent_id: "a1", reader_agent_id: "a2", count: 5 }],
      ]);

      const result = await getBenefitMetrics({} as never, TENANT_ID);

      expect(result.usefulnessDistribution).toHaveLength(5);
      expect(result.usefulnessDistribution[0]).toEqual({ bucket: "0", count: 10 });
      expect(result.memoryReuseRate).toHaveLength(4);
      expect(result.tagDiversityByGroup).toHaveLength(1);
      expect(result.tagDiversityByGroup[0].topTags).toEqual(["api", "auth", "db"]);
      expect(result.enrichmentQuality).toEqual({
        withSummary: 40,
        withEmbedding: 35,
        withAutoTags: 30,
        total: 50,
      });
      expect(result.crossAgentSharing).toEqual({
        totalShared: 5,
        topPairs: [{ writerAgentId: "a1", readerAgentId: "a2", count: 5 }],
      });
    });

    it("handles empty data gracefully", async () => {
      setupMock([
        [], // usefulness
        [], // reuse
        [], // tag diversity
        [{ with_summary: 0, with_embedding: 0, with_auto_tags: 0, total: 0 }],
        [], // cross-agent sharing
      ]);

      const result = await getBenefitMetrics({} as never, TENANT_ID);

      expect(result.usefulnessDistribution).toEqual([]);
      expect(result.memoryReuseRate).toEqual([]);
      expect(result.tagDiversityByGroup).toEqual([]);
      expect(result.enrichmentQuality.total).toBe(0);
      expect(result.crossAgentSharing).toBeNull();
    });
  });

  describe("getHealthMetrics", () => {
    it("calculates lifecycle stats and quota utilization", async () => {
      setupMock([
        // lifecycle
        [{ avg_age_days: 7.5432, outdated_pct: 12.345, expiry_rate: 3.678 }],
        // quota utilization
        [
          { group_id: "g1", group_name: "Team A", current: 150, quota: 1000 },
          { group_id: "g2", group_name: "Team B", current: 900, quota: 1000 },
        ],
      ]);

      const result = await getHealthMetrics({} as never, TENANT_ID);

      expect(result.memoryLifecycle.avgAgeDays).toBe(7.5);
      expect(result.memoryLifecycle.outdatedPct).toBe(12.3);
      expect(result.memoryLifecycle.expiryRate).toBe(3.7);
      expect(result.quotaUtilization).toHaveLength(2);
      expect(result.quotaUtilization[0]).toEqual({
        groupId: "g1",
        groupName: "Team A",
        current: 150,
        quota: 1000,
      });
    });

    it("handles no data with zero values", async () => {
      setupMock([
        [{ avg_age_days: 0, outdated_pct: 0, expiry_rate: 0 }],
        [],
      ]);

      const result = await getHealthMetrics({} as never, TENANT_ID);

      expect(result.memoryLifecycle).toEqual({
        avgAgeDays: 0,
        outdatedPct: 0,
        expiryRate: 0,
      });
      expect(result.quotaUtilization).toEqual([]);
    });
  });
});
