import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getUsageMetrics,
  getBenefitMetrics,
  getHealthMetrics,
} from "../services/metrics.service";

const withTenantDrizzleScopeMock = vi.fn();

vi.mock("@monet/db", async () => {
  const actual = await vi.importActual("@monet/db");
  return {
    ...actual,
    withTenantDrizzleScope: (...args: unknown[]) => withTenantDrizzleScopeMock(...args),
  };
});

function setupUsageMetricsMock({
  frequencyRows,
  activeAgentRows,
  totalAgentRows,
  enrichmentRows,
  searchHitRows,
  semanticRows,
}: {
  frequencyRows: unknown[];
  activeAgentRows: unknown[];
  totalAgentRows: unknown[];
  enrichmentRows: unknown[];
  searchHitRows: unknown[];
  semanticRows: unknown[];
}) {
  const executeMock = vi.fn().mockResolvedValue(frequencyRows);
  const selectMock = vi.fn()
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn().mockResolvedValue(activeAgentRows),
        })),
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(totalAgentRows),
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(enrichmentRows),
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(searchHitRows),
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(semanticRows),
      })),
    });

  withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) =>
    fn({ execute: executeMock, select: selectMock }),
  );

  return { executeMock, select: selectMock };
}

function setupHealthMetricsMock({
  liveLifecycleRows,
  allEntryLifecycleRows,
  groupRows,
  groupCurrentRows,
  groupMemberRows,
}: {
  liveLifecycleRows: unknown[];
  allEntryLifecycleRows: unknown[];
  groupRows: unknown[];
  groupCurrentRows: unknown[];
  groupMemberRows: unknown[];
}) {
  const selectMock = vi.fn()
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(liveLifecycleRows),
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn().mockResolvedValue(allEntryLifecycleRows),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn().mockResolvedValue(groupRows),
        })),
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          groupBy: vi.fn().mockResolvedValue(groupCurrentRows),
        })),
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              groupBy: vi.fn().mockResolvedValue(groupMemberRows),
            })),
          })),
        })),
      })),
    });

  withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) =>
    fn({ select: selectMock }),
  );

  return { selectMock };
}

function setupBenefitMetricsMock({
  usefulnessRows,
  reuseRows,
  tagDiversityRows,
  enrichmentQualityRows,
  crossAgentTotalRows,
  crossAgentPairRows,
}: {
  usefulnessRows: unknown[];
  reuseRows: unknown[];
  tagDiversityRows: unknown[];
  enrichmentQualityRows: unknown[];
  crossAgentTotalRows: unknown[];
  crossAgentPairRows: unknown[];
}) {
  const executeMock = vi.fn()
    .mockResolvedValueOnce(usefulnessRows)
    .mockResolvedValueOnce(reuseRows)
    .mockResolvedValueOnce(tagDiversityRows)
    .mockResolvedValueOnce(enrichmentQualityRows);
  const selectMock = vi.fn()
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              where: vi.fn().mockResolvedValue(crossAgentTotalRows),
            })),
          })),
        })),
      })),
    })
    .mockReturnValueOnce({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                groupBy: vi.fn(() => ({
                  orderBy: vi.fn(() => ({
                    limit: vi.fn().mockResolvedValue(crossAgentPairRows),
                  })),
                })),
              })),
            })),
          })),
        })),
      })),
    });

  withTenantDrizzleScopeMock.mockImplementation(async (_sql, _schemaName, fn) =>
    fn({ execute: executeMock, select: selectMock }),
  );

  return { execute: executeMock, select: selectMock };
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

      setupUsageMetricsMock({
        frequencyRows: days,
        activeAgentRows: [{ period7d: 5, period30d: 12 }],
        totalAgentRows: [{ total: 20 }],
        enrichmentRows: [{ pending: 3, processing: 1, completed: 50, failed: 2 }],
        searchHitRows: [{ total: 10, withResults: 8 }],
        semanticRows: [{ total: 10, vectorCount: 4 }],
      });

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

      setupUsageMetricsMock({
        frequencyRows: emptyDays,
        activeAgentRows: [{ period7d: 0, period30d: 0 }],
        totalAgentRows: [{ total: 0 }],
        enrichmentRows: [{ pending: 0, processing: 0, completed: 0, failed: 0 }],
        searchHitRows: [{ total: 0, withResults: 0 }],
        semanticRows: [{ total: 0, vectorCount: 0 }],
      });

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
      setupBenefitMetricsMock({
        usefulnessRows: [
          { bucket: "0", count: 1 },
          { bucket: "1", count: 1 },
          { bucket: "2-3", count: 1 },
          { bucket: "4-6", count: 1 },
          { bucket: "7+", count: 1 },
        ],
        reuseRows: [
          { bucket: "Never accessed", count: 1 },
          { bucket: "1-3 times", count: 2 },
          { bucket: "4-10 times", count: 1 },
          { bucket: "10+ times", count: 1 },
        ],
        tagDiversityRows: [
          { groupId: "g1", groupName: "Team A", tagCount: 3, topTags: ["api", "auth", "db"] },
        ],
        enrichmentQualityRows: [
          { withSummary: 4, withEmbedding: 2, withAutoTags: 3, total: 5 },
        ],
        crossAgentTotalRows: [{ total: 5 }],
        crossAgentPairRows: [{ writerAgentId: "a1", readerAgentId: "a2", count: 5 }],
      });

      const result = await getBenefitMetrics({} as never, TENANT_ID);

      expect(result.usefulnessDistribution).toHaveLength(5);
      expect(result.usefulnessDistribution[0]).toEqual({ bucket: "0", count: 1 });
      expect(result.memoryReuseRate).toHaveLength(4);
      expect(result.tagDiversityByGroup).toHaveLength(1);
      expect(result.tagDiversityByGroup[0].tagCount).toBe(3);
      expect(result.tagDiversityByGroup[0].topTags).toEqual(["api", "auth", "db"]);
      expect(result.enrichmentQuality).toEqual({
        withSummary: 4,
        withEmbedding: 2,
        withAutoTags: 3,
        total: 5,
      });
      expect(result.crossAgentSharing).toEqual({
        totalShared: 5,
        topPairs: [{ writerAgentId: "a1", readerAgentId: "a2", count: 5 }],
      });
    });

    it("handles empty data gracefully", async () => {
      setupBenefitMetricsMock({
        usefulnessRows: [],
        reuseRows: [],
        tagDiversityRows: [],
        enrichmentQualityRows: [{ withSummary: 0, withEmbedding: 0, withAutoTags: 0, total: 0 }],
        crossAgentTotalRows: [{ total: 0 }],
        crossAgentPairRows: [],
      });

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
      setupHealthMetricsMock({
        liveLifecycleRows: [{ avgAgeDays: 7.5432, outdatedPct: 12.345 }],
        allEntryLifecycleRows: [{ expiryRate: 3.678 }],
        groupRows: [
          { groupId: "g1", groupName: "Team A", quota: 1000 },
          { groupId: "g2", groupName: "Team B", quota: 1000 },
        ],
        groupCurrentRows: [
          { groupId: "g1", current: 150 },
          { groupId: "g2", current: 900 },
        ],
        groupMemberRows: [
          { groupId: "g1", agentId: "a1", agentCount: 80 },
          { groupId: "g1", agentId: "a2", agentCount: 25 },
          { groupId: "g2", agentId: "a3", agentCount: 500 },
        ],
      });

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
        effectiveQuotaPerAgent: 1000,
        maxAgentCurrent: 80,
      });
    });

    it("handles no data with zero values", async () => {
      setupHealthMetricsMock({
        liveLifecycleRows: [{ avgAgeDays: 0, outdatedPct: 0 }],
        allEntryLifecycleRows: [{ expiryRate: 0 }],
        groupRows: [],
        groupCurrentRows: [],
        groupMemberRows: [],
      });

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
