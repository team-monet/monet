import { getApiClient } from "@/lib/api-client";
import { requireAdmin } from "@/lib/auth";
import type { MetricsResponse } from "@monet/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";
import { StatCard } from "./stat-card";
import { QuotaBars } from "./quota-bars";
import { TagDiversityTable } from "./tag-diversity-table";
import {
  ReadWriteTrendChart,
  UsefulnessHistogram,
  MemoryReuseChart,
  EnrichmentThroughputChart,
  EnrichmentQualityBars,
} from "./metrics-charts";

export default async function MetricsPage() {
  await requireAdmin();

  let metrics: MetricsResponse | null = null;
  let error = "";

  try {
    const client = await getApiClient();
    metrics = await client.getMetrics();
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : "An unexpected error occurred";
  }

  if (error || !metrics) {
    return (
      <div className="flex flex-col gap-6 p-4">
        <h1 className="text-3xl font-bold tracking-tight">Metrics</h1>
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Error loading metrics</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const { usage, benefit, health } = metrics;

  return (
    <div className="flex flex-col gap-8 p-4">
      {/* --- USAGE --- */}
      <section className="space-y-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Metrics</h1>
          <p className="text-muted-foreground mt-1">
            Usage, benefit, and health indicators for your Monet instance.
          </p>
        </div>

        <h2 className="text-lg font-semibold">Usage</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatCard
            title="Active Agents (7d)"
            value={usage.activeAgents.period7d}
            subtitle={`${usage.activeAgents.total} registered`}
          />
          <StatCard
            title="Active Agents (30d)"
            value={usage.activeAgents.period30d}
            subtitle={`${usage.activeAgents.total} registered`}
          />
          <StatCard
            title="Search Hit Rate"
            value={usage.searchHitRate ? `${usage.searchHitRate.rate}%` : null}
            subtitle={
              usage.searchHitRate
                ? `${usage.searchHitRate.withResults} / ${usage.searchHitRate.total} searches`
                : "Collecting data..."
            }
          />
        </div>
        <ReadWriteTrendChart data={usage.readWriteFrequency} />
      </section>

      {/* --- BENEFIT --- */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Benefit</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatCard
            title="Cross-Agent Shares"
            value={benefit.crossAgentSharing?.totalShared ?? null}
            subtitle={
              benefit.crossAgentSharing
                ? `${benefit.crossAgentSharing.topPairs.length} active pairs`
                : "Collecting data..."
            }
          />
          <EnrichmentQualityBars data={benefit.enrichmentQuality} />
          <StatCard
            title="Semantic Search"
            value={usage.semanticSearchPct != null ? `${usage.semanticSearchPct}%` : null}
            subtitle={
              usage.semanticSearchPct != null
                ? "of searches use vector similarity"
                : "Collecting data..."
            }
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <UsefulnessHistogram data={benefit.usefulnessDistribution} />
          <MemoryReuseChart data={benefit.memoryReuseRate} />
        </div>
        <TagDiversityTable data={benefit.tagDiversityByGroup} />
      </section>

      {/* --- HEALTH --- */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Health</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatCard
            title="Avg Memory Age"
            value={health.memoryLifecycle.avgAgeDays}
            suffix="days"
          />
          <StatCard
            title="Outdated"
            value={`${health.memoryLifecycle.outdatedPct}%`}
          />
          <StatCard
            title="Expiry Rate"
            value={`${health.memoryLifecycle.expiryRate}%`}
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <EnrichmentThroughputChart data={usage.enrichmentThroughput} />
          <QuotaBars data={health.quotaUtilization} />
        </div>
      </section>
    </div>
  );
}
