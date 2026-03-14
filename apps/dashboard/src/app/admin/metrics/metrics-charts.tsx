"use client";

import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import type {
  ReadWriteFrequency,
  BucketCount,
  EnrichmentThroughput,
  EnrichmentQuality,
} from "@monet/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

const COLORS = ["hsl(var(--chart-1))", "hsl(var(--chart-2))", "hsl(var(--chart-3))", "hsl(var(--chart-4))", "hsl(var(--chart-5))"];
const PIE_COLORS = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444"];

// --- Read/Write Trend ---

interface ReadWriteTrendChartProps {
  data: ReadWriteFrequency[];
}

export function ReadWriteTrendChart({ data }: ReadWriteTrendChartProps) {
  const formatted = data.map((d) => ({
    ...d,
    date: d.date.slice(5), // MM-DD
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Read / Write / Search Trend (14 days)</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={formatted}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis dataKey="date" className="text-xs" tick={{ fontSize: 12 }} />
            <YAxis allowDecimals={false} className="text-xs" tick={{ fontSize: 12 }} />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="writes" stroke="#3b82f6" strokeWidth={2} dot={false} name="Writes" />
            <Line type="monotone" dataKey="reads" stroke="#22c55e" strokeWidth={2} dot={false} name="Reads" />
            <Line type="monotone" dataKey="searches" stroke="#f59e0b" strokeWidth={2} dot={false} name="Searches" />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// --- Usefulness Histogram ---

interface UsefulnessHistogramProps {
  data: BucketCount[];
}

export function UsefulnessHistogram({ data }: UsefulnessHistogramProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Usefulness Score Distribution</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis dataKey="bucket" className="text-xs" tick={{ fontSize: 12 }} />
            <YAxis allowDecimals={false} className="text-xs" tick={{ fontSize: 12 }} />
            <Tooltip />
            <Bar dataKey="count" name="Memories">
              {data.map((_, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// --- Memory Reuse Rate ---

interface MemoryReuseChartProps {
  data: BucketCount[];
}

export function MemoryReuseChart({ data }: MemoryReuseChartProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Memory Reuse Rate</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={data} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis type="number" allowDecimals={false} className="text-xs" tick={{ fontSize: 12 }} />
            <YAxis type="category" dataKey="bucket" width={120} className="text-xs" tick={{ fontSize: 12 }} />
            <Tooltip />
            <Bar dataKey="count" name="Memories" fill="#3b82f6" />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// --- Enrichment Throughput Donut ---

interface EnrichmentThroughputChartProps {
  data: EnrichmentThroughput;
}

export function EnrichmentThroughputChart({ data }: EnrichmentThroughputChartProps) {
  const chartData = [
    { name: "Pending", value: data.pending },
    { name: "Completed", value: data.completed },
    { name: "Processing", value: data.processing },
    { name: "Failed", value: data.failed },
  ].filter((d) => d.value > 0);

  const total = data.pending + data.processing + data.completed + data.failed;

  if (total === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Enrichment Pipeline</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No memories to enrich.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Enrichment Pipeline</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={240}>
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={90}
              paddingAngle={2}
              dataKey="value"
              label={({ name, value }) => `${name}: ${value}`}
            >
              {chartData.map((_, index) => (
                <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// --- Enrichment Quality Bars ---

interface EnrichmentQualityBarsProps {
  data: EnrichmentQuality;
}

export function EnrichmentQualityBars({ data }: EnrichmentQualityBarsProps) {
  if (data.total === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Enrichment Quality</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No memories yet.</p>
        </CardContent>
      </Card>
    );
  }

  const items = [
    { label: "With Summary", value: data.withSummary, pct: Math.round((data.withSummary / data.total) * 100) },
    { label: "With Embedding", value: data.withEmbedding, pct: Math.round((data.withEmbedding / data.total) * 100) },
    { label: "With Auto-Tags", value: data.withAutoTags, pct: Math.round((data.withAutoTags / data.total) * 100) },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Enrichment Quality</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {items.map((item) => (
          <div key={item.label} className="space-y-1.5">
            <div className="flex justify-between text-sm">
              <span>{item.label}</span>
              <span className="text-muted-foreground">
                {item.value} / {data.total} ({item.pct}%)
              </span>
            </div>
            <Progress value={item.pct} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
