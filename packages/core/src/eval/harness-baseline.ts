/**
 * md-baseline harness — Phase 0 of the engine-vs-md proof harness (spec §2).
 *
 * WHY THIS IS A SEPARATE LOOP FROM runSuite() (harness.ts), not an extra arm passed into it:
 * runSuite()/scoreProbes() computes goldIds as CONCEPT ids (probe.gold keys resolved via the
 * scenario's key→conceptId seeding map) and scores every arm's retrieve() output against that
 * concept-id space. chunk-cosine-rag and md-tree both retrieve CHUNK ids (spec §2.2's "mapping
 * problem" — an md file has no concept id). Feeding their chunk-id output through
 * runSuite()'s concept-id recallAt() would silently score every probe as zero recall — not an
 * error, just wrong numbers that look like a real result. So chunk-granularity arms get their
 * OWN scoring pass here, using the exporter's chunkId→conceptKey manifest (carried mechanically
 * at export time, spec §2.2) to build a gold CHUNK-id set per probe, then reuse harness.ts's
 * OWN recallAt/meanReciprocalRank primitives (imported, not forked) so the arithmetic is
 * identical to the concept-granularity arms — only the id space differs.
 *
 * Concept-granularity arms (no-memory, monet-search, monet-gather, bm25) still run through the
 * UNMODIFIED runSuite() from harness.ts — this file adds a second pass alongside it, combined
 * into one report by runBaselineSuite() below, rather than replacing or forking the tested path.
 *
 * GRANULARITY-MISMATCH HONESTY (spec §2.2's explicit requirement): every chunk-granularity arm
 * report carries BOTH strict chunk-recall (via the concept-key-derived gold-chunk set) AND the
 * looser "gold-containing-file@k" number (is the FILE holding the gold chunk in the top-k
 * FILES, regardless of which chunk within it ranked where) — always both, never just one.
 *
 * A2 fix (Codex finding #3): gold-containing-file@k now ranks FILES DIRECTLY, aggregating the
 * MAX chunk score per file over the FULL (untruncated) per-chunk score list — NOT derived from
 * the RANK_DEPTH-truncated chunk list retrieve() returns. The prior approach could undercount:
 * if one topic file's chunks fill the top RANK_DEPTH ranks, a gold file whose own chunks all
 * rank just past that truncation point was invisible to the file-level metric even though it
 * would legitimately rank in the true top-k files. Strict chunk-recall (recallByK below) is
 * UNCHANGED — it still uses the RANK_DEPTH-bounded retrieve() output, per the metric's own
 * "lower granularity, harder bar" semantics, which are about chunk-level budget, not file
 * discovery. The file@k >= chunk@k invariant (see the fast-tier test) remains structurally
 * true under direct file ranking: if a gold chunk is in the top-k CHUNKS (by the full ranking
 * chunk-recall is scored against), its file's max score is >= that chunk's score, so at most
 * k-1 other files can outrank it in the file ranking — the file is still in the top-k FILES.
 */
import { MonetCore } from "../engine";
import type { EmbeddingProvider } from "../embedding";
import { STARTER_SUITE, type Scenario, type ProbeCategory } from "./scenarios";
import { DEFAULT_ARMS, type RetrievalArm } from "./strategies";
import { bm25Arm, makeChunkCosineRagArm, makeMdTreeArm, type ScoringArm, type ScoredChunk } from "./strategies-baseline";
import { exportMdTree, type MdExportResult } from "./md-export";
import { seedScenario, recallAt, meanReciprocalRank, runSuite, K_LADDER, type SuiteReport, type ArmReport, type MetricSummary, type ProbeResult } from "./harness";

const CIRCLE = "default";
const RANK_DEPTH = 10;

/** The md-baseline arm set: the three existing engine arms + bm25 (concept-granularity, ported per §2.4). Kept separate from DEFAULT_ARMS (spec §2.4/§2.6) so `pnpm eval` is untouched. */
export const MD_BASELINE_CONCEPT_ARMS: RetrievalArm[] = [...DEFAULT_ARMS, bm25Arm];

export interface ChunkArmReport extends ArmReport {
  /** gold-containing-file@k (spec §2.2's granularity-honesty requirement) — the looser file-level number, reported alongside strict chunk recall, always both. Ranked directly over files (A2 fix) — see module doc comment. */
  goldContainingFileByK: Record<number, number>;
}

export interface BaselineSuiteReport extends SuiteReport {
  chunkArms: ChunkArmReport[];
}

function fileOf(chunkId: string, exportResult: MdExportResult): string | undefined {
  return exportResult.chunks.find((c) => c.chunkId === chunkId)?.file;
}

/** All chunkIds (across every topic file) whose manifest-recorded concept key is in `goldKeys`. */
function goldChunkIds(exportResult: MdExportResult, goldKeys: string[]): string[] {
  const goldKeySet = new Set(goldKeys);
  return exportResult.chunks.filter((c) => goldKeySet.has(exportResult.manifest.chunkIdToConceptKey[c.chunkId] ?? "")).map((c) => c.chunkId);
}

/** All topic files containing at least one gold chunk (the file-level gold set for gold-containing-file@k). */
function goldFiles(exportResult: MdExportResult, goldChunks: string[]): string[] {
  const files = new Set<string>();
  for (const chunkId of goldChunks) {
    const f = fileOf(chunkId, exportResult);
    if (f) files.add(f);
  }
  return [...files];
}

/**
 * A2 fix: rank FILES directly from the full per-chunk score list — each file's rank score is
 * the MAX score among its own chunks (a file is as relevant as its single most-relevant
 * chunk), ties broken by file path for determinism. Operates on the FULL scoredChunks list
 * (never truncated to RANK_DEPTH before this aggregation), so a file's true rank reflects its
 * best chunk anywhere in the full ranking, not just within an arbitrary top-N chunk window.
 */
function rankFilesByMaxChunkScore(scoredChunks: ScoredChunk[], exportResult: MdExportResult): string[] {
  const bestScorePerFile = new Map<string, number>();
  for (const { chunkId, score } of scoredChunks) {
    const file = fileOf(chunkId, exportResult);
    if (!file) continue;
    const cur = bestScorePerFile.get(file);
    if (cur === undefined || score > cur) bestScorePerFile.set(file, score);
  }
  return [...bestScorePerFile.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([file]) => file);
}

function summarizeChunkProbes(probes: ProbeResult[]): MetricSummary {
  const by = (c: ProbeCategory): ProbeResult[] => probes.filter((p) => p.category === c);
  const mistake = by("mistake");
  const reexplain = by("reexplain");
  const restoration = by("restoration");
  const missRateAt = (ps: ProbeResult[], k: number): number => (ps.length === 0 ? 0 : ps.filter((p) => p.recallByK[k] < 1).length / ps.length);
  const meanRecallAt = (ps: ProbeResult[], k: number): number => (ps.length === 0 ? 0 : ps.reduce((a, p) => a + p.recallByK[k], 0) / ps.length);
  const byK: MetricSummary["byK"] = {};
  for (const k of K_LADDER) {
    byK[k] = { repeatedMistakeRate: missRateAt(mistake, k), reExplainRate: missRateAt(reexplain, k), restorationRecall: meanRecallAt(restoration, k) };
  }
  const meanMrr = (ps: ProbeResult[]): number => (ps.length === 0 ? 0 : ps.reduce((a, p) => a + p.mrr, 0) / ps.length);
  return {
    byK,
    mrr: { mistake: meanMrr(mistake), reexplain: meanMrr(reexplain), restoration: meanMrr(restoration), overall: meanMrr(probes) },
    counts: { mistake: mistake.length, reexplain: reexplain.length, restoration: restoration.length },
  };
}

/**
 * Run the two chunk-granularity arms (chunk-cosine-rag, md-tree) across the suite. Seeds each
 * scenario via the SAME seedScenario() the concept-granularity pass uses (own core instances —
 * runSuite() is called separately for the concept pass, so this re-seeds; cheap relative to the
 * embedding cost already paid, and keeps this module fully independent of runSuite()'s internal
 * per-scenario core lifecycle).
 */
async function runChunkArms(scenarios: Scenario[], embedder: EmbeddingProvider): Promise<ChunkArmReport[]> {
  // Per-core scratch state so the arm factories' exportOptsForCore callback (called INSIDE
  // retrieve(), after the arms below are already constructed) can recover the scenario + key
  // map that produced whichever `core` instance is passed to it. WeakMap-keyed so it's scoped
  // exactly to the arms' own lifetime and requires no manual cleanup.
  const coreSeedState = new WeakMap<MonetCore, { map: Map<string, string>; scenario: Scenario }>();
  const exportOptsForCore = (core: MonetCore): { circle: string; keyMap: Map<string, string>; scenario: Scenario } => {
    const state = coreSeedState.get(core)!;
    return { circle: CIRCLE, keyMap: state.map, scenario: state.scenario };
  };

  const chunkCosineRagArm = makeChunkCosineRagArm(embedder, exportOptsForCore);
  const mdTreeArm = makeMdTreeArm(exportOptsForCore);
  const arms: ScoringArm[] = [chunkCosineRagArm, mdTreeArm];

  const byArm = new Map<string, ProbeResult[]>(arms.map((a) => [a.arm.name, []]));
  const byArmFileHits = new Map<string, Array<{ k: number; recall: number }>>(arms.map((a) => [a.arm.name, []]));

  for (const scenario of scenarios) {
    const { core, map } = await seedScenario(scenario, embedder);
    coreSeedState.set(core, { map, scenario });
    try {
      // One export per scenario, shared by both chunk arms' scoring (the arms themselves ALSO
      // cache their own export internally for retrieval — this second call is for gold-mapping
      // only, and exportMdTree is a pure read so a second call is correctness-safe, just an
      // extra (cheap, no-embedding) computation, not a source of drift).
      const exportResult = exportMdTree(core, { circle: CIRCLE, keyMap: map, scenario });

      for (const arm of arms) {
        for (const probe of scenario.probes) {
          const goldConceptKeys = probe.gold; // logical keys, not resolved conceptIds — chunk gold is manifest-derived from these directly
          const goldChunks = goldChunkIds(exportResult, goldConceptKeys);
          const goldFileSet = goldFiles(exportResult, goldChunks);

          // Strict chunk-recall: UNCHANGED semantics — RANK_DEPTH-bounded retrieve() output,
          // per the metric's own "lower granularity, harder bar" definition (A2 fix note above).
          const retrievedChunkIds = (await arm.arm.retrieve(core, probe.query, { circle: CIRCLE, k: RANK_DEPTH })).slice(0, RANK_DEPTH);
          const recallByK: Record<number, number> = {};
          for (const k of K_LADDER) recallByK[k] = recallAt(goldChunks, retrievedChunkIds, k);
          const mrr = meanReciprocalRank(goldChunks, retrievedChunkIds);
          byArm.get(arm.arm.name)!.push({ scenarioId: scenario.id, category: probe.category, query: probe.query, goldIds: goldChunks, retrievedIds: retrievedChunkIds, recallByK, mrr });

          // gold-containing-file@k (spec §2.2, A2-fixed): ranked directly over FILES, from the
          // FULL (untruncated) per-chunk score list — not derived from the RANK_DEPTH-bounded
          // chunk list above. |gold files ∩ top-k files| / |gold files|, the same recallAt
          // primitive applied to a file-ranked list instead of a chunk-derived one.
          const scoredChunks = await arm.scoreAllChunks(core, probe.query);
          const rankedFiles = rankFilesByMaxChunkScore(scoredChunks, exportResult);
          for (const k of K_LADDER) byArmFileHits.get(arm.arm.name)!.push({ k, recall: recallAt(goldFileSet, rankedFiles, k) });
        }
      }
    } finally {
      core.close();
    }
  }

  return arms.map((a) => {
    const probes = byArm.get(a.arm.name)!;
    const goldContainingFileByK: Record<number, number> = {};
    for (const k of K_LADDER) {
      const atK = byArmFileHits.get(a.arm.name)!.filter((h) => h.k === k);
      goldContainingFileByK[k] = atK.length === 0 ? 0 : atK.reduce((acc, h) => acc + h.recall, 0) / atK.length;
    }
    return { arm: a.arm.name, available: true, metrics: summarizeChunkProbes(probes), probes, goldContainingFileByK };
  });
}

/**
 * Full md-baseline run: concept-granularity arms via the UNMODIFIED runSuite(), plus the two
 * chunk-granularity arms via runChunkArms() above — combined into one report.
 */
export async function runBaselineSuite(scenarios: Scenario[] = STARTER_SUITE, embedder: EmbeddingProvider, opts: { embedderName?: string } = {}): Promise<BaselineSuiteReport> {
  const conceptReport = await runSuite(scenarios, MD_BASELINE_CONCEPT_ARMS, embedder, opts);
  const chunkArms = await runChunkArms(scenarios, embedder);
  return { ...conceptReport, chunkArms };
}
