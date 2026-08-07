/**
 * Human-readable rendering of a SuiteReport. One sub-table per metric, arms as rows, the
 * recall@k ladder as columns. recall@1 is the demanding "is the right memory the TOP card?"
 * view where headroom lives; recall@5 is the lenient "is it in budget?" view. Verbose mode adds
 * a per-scenario recall@1 grid so
 * a single weak case (a paraphrase miss, a half-recovered thread) is visible, not averaged away.
 */
import type { SuiteReport, ArmReport, MetricsAtK } from "./harness";
import { STARTER_SUITE } from "./scenarios";

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
const pad = (s: string, w: number): string => s.padEnd(w);
const padL = (s: string, w: number): string => s.padStart(w);

type MetricKey = keyof MetricsAtK;

export function formatReport(report: SuiteReport, opts: { verbose?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`Monet memory eval — ${report.scenarios} scenarios · recall@${report.ladder.join("/")} · embedder=${report.embedder}`);
  lines.push("");

  lines.push(...metricTable(report, "repeatedMistakeRate", "repeated-mistake rate", "lower is better"));
  lines.push(...metricTable(report, "reExplainRate", "re-explain rate", "lower is better"));
  lines.push(...metricTable(report, "restorationRecall", "context-restoration recall", "higher is better"));
  lines.push(...mrrTable(report));

  if (opts.verbose) lines.push(...perScenarioAt1(report));

  const pending = report.arms.filter((a) => !a.available);
  if (pending.length) {
    lines.push("");
    lines.push("pending arms (reported, not run):");
    for (const a of pending) lines.push(`  · ${a.arm}: ${a.unavailableReason}`);
  }
  lines.push("");
  lines.push("not covered here: a Vestige arm (separate store; needs an adapter — parked, demand-driven).");
  lines.push("");
  return lines.join("\n");
}

function metricTable(report: SuiteReport, key: MetricKey, title: string, hint: string): string[] {
  const lines = ["", `${title} (${hint})`];
  const armW = 14;
  const colW = 8;
  lines.push(pad("", armW) + report.ladder.map((k) => padL(`@${k}`, colW)).join(""));
  for (const a of report.arms) {
    if (!a.available || !a.metrics) {
      lines.push(pad(a.arm, armW) + padL(`— ${a.unavailableReason ?? "not run"}`, colW * report.ladder.length));
      continue;
    }
    lines.push(pad(a.arm, armW) + report.ladder.map((k) => padL(pct(a.metrics!.byK[k][key]), colW)).join(""));
  }
  return lines;
}

function mrrTable(report: SuiteReport): string[] {
  const lines = ["", "rank quality — mean reciprocal rank (higher is better, max 1.00)"];
  const armW = 14;
  const colW = 13;
  const cols: Array<["mistake" | "reexplain" | "restoration" | "overall", string]> = [
    ["mistake", "mistake"],
    ["reexplain", "re-explain"],
    ["restoration", "restoration"],
    ["overall", "overall"],
  ];
  lines.push(pad("", armW) + cols.map(([, h]) => padL(h, colW)).join(""));
  for (const a of report.arms) {
    if (!a.available || !a.metrics) {
      lines.push(pad(a.arm, armW) + padL(`— ${a.unavailableReason ?? "not run"}`, colW * cols.length));
      continue;
    }
    lines.push(pad(a.arm, armW) + cols.map(([key]) => padL(a.metrics!.mrr[key].toFixed(2), colW)).join(""));
  }
  return lines;
}

function perScenarioAt1(report: SuiteReport): string[] {
  const lines: string[] = ["", "per-scenario recall@1 (the top-card view):", ""];
  const arms = report.arms.filter((a) => a.available);
  const idW = 18;
  lines.push(pad("scenario", idW) + arms.map((a) => padL(a.arm, 14)).join(""));
  lines.push("─".repeat(idW + arms.length * 14));
  for (const scenario of STARTER_SUITE) {
    const cells = arms.map((a) => {
      const ps = a.probes.filter((p) => p.scenarioId === scenario.id);
      const r = ps.length ? ps.reduce((acc, p) => acc + p.recallByK[1], 0) / ps.length : 0;
      return padL(pct(r), 14);
    });
    lines.push(pad(scenario.id, idW) + cells.join(""));
  }
  return lines;
}
