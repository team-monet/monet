import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../middleware/context";

const resolveAgentRoleMock = vi.fn();
const getUsageMetricsMock = vi.fn();
const getBenefitMetricsMock = vi.fn();
const getHealthMetricsMock = vi.fn();

vi.mock("../services/group.service", () => ({
  resolveAgentRole: (...args: unknown[]) => resolveAgentRoleMock(...args),
  isTenantAdmin: (role: string | null) => role === "tenant_admin",
}));

vi.mock("../services/metrics.service", () => ({
  getUsageMetrics: (...args: unknown[]) => getUsageMetricsMock(...args),
  getBenefitMetrics: (...args: unknown[]) => getBenefitMetricsMock(...args),
  getHealthMetrics: (...args: unknown[]) => getHealthMetricsMock(...args),
}));

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const AGENT_ID = "00000000-0000-0000-0000-000000000002";

function makeAgent(role?: string) {
  return {
    id: AGENT_ID,
    tenantId: TENANT_ID,
    role: role ?? null,
    userId: null,
    isAutonomous: false,
    externalId: "test-agent",
  };
}

async function buildApp() {
  const { metricsRouter } = await import("../routes/metrics");
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("agent", makeAgent() as never);
    c.set("sql", {} as never);
    await next();
  });
  app.route("/metrics", metricsRouter);
  return app;
}

const stubMetrics = {
  usage: {
    readWriteFrequency: [],
    activeAgents: { period7d: 0, period30d: 0, total: 0 },
    enrichmentThroughput: { pending: 0, processing: 0, completed: 0, failed: 0 },
    searchHitRate: null,
    semanticSearchPct: null,
  },
  benefit: {
    usefulnessDistribution: [],
    memoryReuseRate: [],
    tagDiversityByGroup: [],
    enrichmentQuality: { withSummary: 0, withEmbedding: 0, withAutoTags: 0, total: 0 },
    crossAgentSharing: null,
  },
  health: {
    memoryLifecycle: { avgAgeDays: 0, outdatedPct: 0, expiryRate: 0 },
    quotaUtilization: [],
  },
};

describe("GET /metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 for non-admin agents", async () => {
    resolveAgentRoleMock.mockResolvedValue("user");
    const app = await buildApp();

    const res = await app.request("/metrics");
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toBe("forbidden");
  });

  it("returns combined metrics for tenant_admin", async () => {
    resolveAgentRoleMock.mockResolvedValue("tenant_admin");
    getUsageMetricsMock.mockResolvedValue(stubMetrics.usage);
    getBenefitMetricsMock.mockResolvedValue(stubMetrics.benefit);
    getHealthMetricsMock.mockResolvedValue(stubMetrics.health);

    const app = await buildApp();
    const res = await app.request("/metrics");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("usage");
    expect(body).toHaveProperty("benefit");
    expect(body).toHaveProperty("health");
    expect(body.usage).toHaveProperty("readWriteFrequency");
    expect(body.usage).toHaveProperty("activeAgents");
    expect(body.usage).toHaveProperty("enrichmentThroughput");
  });

  it("returns 500 on service error", async () => {
    resolveAgentRoleMock.mockResolvedValue("tenant_admin");
    getUsageMetricsMock.mockRejectedValue(new Error("db connection lost"));

    const app = await buildApp();
    const res = await app.request("/metrics");

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal_error");
    expect(body.message).toBe("Failed to fetch metrics");
  });
});
