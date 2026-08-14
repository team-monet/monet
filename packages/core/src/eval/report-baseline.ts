/**
 * md-baseline report formatting — extends report.ts's table for the two chunk-granularity
 * arms (chunk-cosine-rag, md-tree), which don't fit report.ts's ArmReport[] shape unmodified
 * (they carry the extra gold-containing-file@k numbers, spec §2.2's granularity-honesty
 * requirement). report.ts itself is untouched — this is purely additive, printed after the
 * concept-arm table it already renders.
 */
import { formatReport } from "./report";
import type { BaselineSuiteReport } from "./harness-baseline";
import { K_LADDER } from "./harness";

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
const pad = (s: string, w: number): string => s.padEnd(w);
const padL = (s: string, w: number): string => s.padStart(w);

export function formatBaselineReport(report: BaselineSuiteReport, opts: { verbose?: boolean } = {}): string {
  const lines: string[] = [formatReport(report, opts)];

  lines.push(`chunk-granularity arms (md-tree export) — retrieval unit is a chunk, not a concept`, "");
  lines.push(`strict chunk-recall (gold chunk in top-k chunks; lower granularity, harder bar)`);
  const armW = 18;
  const colW = 8;
  lines.push(pad("", armW) + K_LADDER.map((k) => padL(`@${k}`, colW)).join(""));
  for (const a of report.chunkArms) {
    lines.push(pad(a.arm, armW) + K_LADDER.map((k) => padL(pct(chunkRecallAt(a, k)), colW)).join(""));
  }

  lines.push("", `gold-containing-file@k (the file holding the gold chunk is in top-k FILES — looser, honest companion to strict chunk-recall above; spec §2.2)`);
  lines.push(pad("", armW) + K_LADDER.map((k) => padL(`@${k}`, colW)).join(""));
  for (const a of report.chunkArms) {
    lines.push(pad(a.arm, armW) + K_LADDER.map((k) => padL(pct(a.goldContainingFileByK[k]), colW)).join(""));
  }

  lines.push(
    "",
    `chunk-granularity rank quality — MRR (higher better, max 1.00)`,
    pad("", armW) + padL("mistake", 13) + padL("re-explain", 13) + padL("restoration", 13) + padL("overall", 13),
    ...report.chunkArms.map((a) => pad(a.arm, armW) + padL(a.metrics!.mrr.mistake.toFixed(2), 13) + padL(a.metrics!.mrr.reexplain.toFixed(2), 13) + padL(a.metrics!.mrr.restoration.toFixed(2), 13) + padL(a.metrics!.mrr.overall.toFixed(2), 13)),
    "",
  );

  return lines.join("\n");
}

/** Overall recall@k across ALL probe categories for a chunk arm (mistake/reexplain/restoration averaged), since report.ts's per-category metric split is less meaningful at chunk granularity where the headline number IS "did the right chunk surface." */
function chunkRecallAt(a: BaselineSuiteReport["chunkArms"][number], k: number): number {
  const probes = a.probes;
  if (probes.length === 0) return 0;
  return probes.reduce((acc, p) => acc + p.recallByK[k], 0) / probes.length;
}
