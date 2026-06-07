/**
 * The eval runner: play each scenario through each retrieval
 * arm and score the probes. Pure and deterministic for a given embedder — the embedder is
 * injected so the same suite can run on MiniLM (real recall, the shipping path) or on the
 * lexical hashing fallback (fast, no network — used by the unit test as a regression gate).
 *
 * Scoring is a recall@k LADDER (k ∈ {1,3,5}), not a single k: recall@1 asks "is the right
 * memory the TOP card?" (the agent often acts on the first hit) while recall@5 asks "is it
 * even in a reasonable budget?". A single loose k saturates to 100% on a small store and
 * measures nothing; the ladder exposes rank quality and leaves headroom for #245 to close.
 *
 * Per arm, at each k, we report the three metrics the roadmap names:
 *   - repeated-mistake rate = fraction of "mistake" probes whose gotcha is NOT fully in top-k
 *   - re-explain rate       = fraction of "reexplain" probes whose fact/decision is NOT in top-k
 *   - context-restoration   = mean recall@k over "restoration" probes (|gold ∩ topk| / |gold|)
 */
import { MonetCore } from "../engine";
import type { EmbeddingProvider } from "../embedding";
import { BACKGROUND, type Scenario, type ProbeCategory } from "./scenarios";
import type { RetrievalArm } from "./strategies";

const CIRCLE = "default";
export const K_LADDER = [1, 3, 5] as const;
/** Retrieve this deep to compute true ranks for MRR; the recall ladder uses k ≤ 5. */
const RANK_DEPTH = 10;

export interface ProbeResult {
  scenarioId: string;
  category: ProbeCategory;
  query: string;
  goldIds: string[];
  retrievedIds: string[];
  /** recall@k for each k in the ladder: |gold ∩ top-k| / |gold|. */
  recallByK: Record<number, number>;
  /** Mean reciprocal rank of the gold member(s) within RANK_DEPTH (0 if none surface). */
  mrr: number;
}

export interface MetricsAtK {
  repeatedMistakeRate: number;
  reExplainRate: number;
  restorationRecall: number;
}

/** Rank quality (0..1, higher better): how high gold ranks, not just whether it's in top-k. */
export interface MrrSummary {
  mistake: number;
  reexplain: number;
  restoration: number;
  overall: number;
}

export interface MetricSummary {
  byK: Record<number, MetricsAtK>;
  mrr: MrrSummary;
  counts: { mistake: number; reexplain: number; restoration: number };
}

export interface ArmReport {
  arm: string;
  available: boolean;
  unavailableReason?: string;
  metrics: MetricSummary | null;
  probes: ProbeResult[];
}

export interface SuiteReport {
  embedder: string;
  ladder: number[];
  scenarios: number;
  arms: ArmReport[];
}

/**
 * Seed a fresh in-memory core for one scenario: shared background corpus first (realistic
 * noise so top-k is selective), then the scenario's own seeds + distractors. Returns the
 * core and the key→conceptId map (dedup #239 may collapse several keys onto one concept).
 */
async function seedScenario(
  scenario: Scenario,
  embedder: EmbeddingProvider,
): Promise<{ core: MonetCore; map: Map<string, string> }> {
  // Dedup OFF (thresholds above max cosine ⇒ every store creates a distinct concept). This
  // eval measures RETRIEVAL/ranking quality over a known store; resolve-or-create is a
  // separate mechanism (ingest.test.ts). With dedup on, a gold seed near-duplicate of a
  // background concept would silently merge into it and corrupt the gold denominator.
  // Deterministic ids ⇒ stable tie-breaks ⇒ the eval is fully reproducible run-to-run
  // (ranking ties break by id, which would otherwise be random UUIDs).
  let seq = 0;
  const idGen = (): string => `c${(seq++).toString().padStart(6, "0")}`;
  const core = new MonetCore(":memory:", { embedder, tauAttach: 1.1, tauAmbiguous: 1.1, idGen });
  const map = new Map<string, string>();

  // SESSION MODEL — how co-occurrence (the signal gather exploits for restoration) is formed.
  // This is a realistic model, NOT an adversarial best case for gather:
  //  - BACKGROUND = long-term memory learned across MANY prior sessions — each fact its OWN
  //    session (not worked on together) ⇒ no background co-occurrence clique. (If instead ALL
  //    memory were one undifferentiated session, co_occurred is universal and gather drops BELOW
  //    search — the win depends on sessions being checkpointed, which real agents do.)
  //  - a thread's seed group = ONE focused work session, but that session ALSO holds the
  //    scenario's `tangents` (unrelated things touched in the same sitting). So co_occurred is
  //    NOT a pristine gold-only clique: gather must rank the thread above its own session noise.
  //  - distractors = independent facts, each its OWN session ⇒ they never co-occur with the gold.
  // Entity `about` edges (durable across sessions) span sessions; for divergent-vocabulary
  // threads they connect at most 1–2 members (see restorationReachability), which is why
  // co-occurrence — not entity edges — carries those threads.
  const store = async (s: { key: string; content: string; kind?: string }): Promise<void> => {
    const r = await core.store(s.content, { circle: CIRCLE, kind: s.kind });
    map.set(s.key, r.conceptId);
  };
  for (const s of BACKGROUND) {
    await store(s);
    core.endSessionForEval(); // each background fact learned in its own prior session
  }
  for (const s of [...scenario.seed, ...(scenario.tangents ?? [])]) await store(s); // the work session: thread + tangents
  core.endSessionForEval();
  for (const s of scenario.distractors ?? []) {
    await store(s); // each decoy is an independent fact (own session) — decoys must NOT co-occur
    core.endSessionForEval();
  }
  return { core, map };
}

export interface ReachabilityRow {
  scenarioId: string;
  goldCount: number;
  /** Per edge type: how many of the thread's gold members are reachable from one member (≤2 hops). */
  byType: Record<string, number>;
}

/**
 * Anti-gaming transparency (the honest read of restoration): for each restoration thread, how
 * many of its gold members are reachable from a single member via EACH edge type alone. This
 * exposes WHICH signal earns the recall — expected to show co_occurred carries the threads while
 * entity `about` only partially connects them. Re-seeds per scenario; for reporting, not scoring.
 */
export async function restorationReachability(scenarios: Scenario[], embedder: EmbeddingProvider): Promise<ReachabilityRow[]> {
  const EDGE_TYPES = ["about", "related", "co_occurred", "follows", "supersedes", "resolves", "contradicts"];
  const out: ReachabilityRow[] = [];
  for (const scenario of scenarios) {
    const probe = scenario.probes.find((p) => p.category === "restoration");
    if (!probe) continue;
    const { core, map } = await seedScenario(scenario, embedder);
    try {
      const goldIds = [...new Set(probe.gold.map((k) => map.get(k)).filter((v): v is string => Boolean(v)))];
      const byType: Record<string, number> = {};
      for (const type of EDGE_TYPES) {
        const edges = core.edges({ circle: CIRCLE, type });
        const seen = new Set([goldIds[0]]);
        let frontier = [goldIds[0]];
        for (let h = 0; h < 2; h++) {
          const next: string[] = [];
          for (const id of frontier) {
            for (const e of edges) if (e.srcId === id && !seen.has(e.dstId)) (seen.add(e.dstId), next.push(e.dstId));
          }
          frontier = next;
        }
        byType[type] = goldIds.filter((g) => seen.has(g)).length;
      }
      out.push({ scenarioId: scenario.id, goldCount: goldIds.length, byType });
    } finally {
      core.close();
    }
  }
  return out;
}

function recallAt(goldIds: string[], retrieved: string[], k: number): number {
  if (goldIds.length === 0) return 0;
  const top = new Set(retrieved.slice(0, k));
  return goldIds.filter((id) => top.has(id)).length / goldIds.length;
}

/** Mean reciprocal rank over the gold set: average of 1/rank for each gold member (0 if absent). */
function meanReciprocalRank(goldIds: string[], retrieved: string[]): number {
  if (goldIds.length === 0) return 0;
  let sum = 0;
  for (const id of goldIds) {
    const idx = retrieved.indexOf(id);
    if (idx >= 0) sum += 1 / (idx + 1);
  }
  return sum / goldIds.length;
}

function scoreProbes(
  scenario: Scenario,
  map: Map<string, string>,
  retrieve: (query: string) => Promise<string[]>,
): Promise<ProbeResult[]> {
  return Promise.all(
    scenario.probes.map(async (probe) => {
      const goldIds = [...new Set(probe.gold.map((key) => map.get(key)).filter((v): v is string => Boolean(v)))];
      const retrievedIds = (await retrieve(probe.query)).slice(0, RANK_DEPTH);
      const recallByK: Record<number, number> = {};
      for (const k of K_LADDER) recallByK[k] = recallAt(goldIds, retrievedIds, k);
      const mrr = meanReciprocalRank(goldIds, retrievedIds);
      return { scenarioId: scenario.id, category: probe.category, query: probe.query, goldIds, retrievedIds, recallByK, mrr } satisfies ProbeResult;
    }),
  );
}

function summarize(probes: ProbeResult[]): MetricSummary {
  const by = (c: ProbeCategory): ProbeResult[] => probes.filter((p) => p.category === c);
  const mistake = by("mistake");
  const reexplain = by("reexplain");
  const restoration = by("restoration");
  // A "mistake"/"reexplain" probe is satisfied at k only if its (single) gold is fully in top-k.
  const missRateAt = (ps: ProbeResult[], k: number): number =>
    ps.length === 0 ? 0 : ps.filter((p) => p.recallByK[k] < 1).length / ps.length;
  const meanRecallAt = (ps: ProbeResult[], k: number): number =>
    ps.length === 0 ? 0 : ps.reduce((a, p) => a + p.recallByK[k], 0) / ps.length;

  const byK: Record<number, MetricsAtK> = {};
  for (const k of K_LADDER) {
    byK[k] = {
      repeatedMistakeRate: missRateAt(mistake, k),
      reExplainRate: missRateAt(reexplain, k),
      restorationRecall: meanRecallAt(restoration, k),
    };
  }
  const meanMrr = (ps: ProbeResult[]): number => (ps.length === 0 ? 0 : ps.reduce((a, p) => a + p.mrr, 0) / ps.length);
  const mrr: MrrSummary = {
    mistake: meanMrr(mistake),
    reexplain: meanMrr(reexplain),
    restoration: meanMrr(restoration),
    overall: meanMrr(probes),
  };
  return { byK, mrr, counts: { mistake: mistake.length, reexplain: reexplain.length, restoration: restoration.length } };
}

export interface MergeWarning {
  scenarioId: string;
  kind: "gold-into-background" | "restoration-collapsed";
  detail: string;
}

/**
 * Self-integrity check for the suite under a given embedder. Dedup (#239) is part of the
 * system under test, but two failure modes silently corrupt the GOLD denominator:
 *   - gold-into-background: a scenario seed merges into a shared background concept, so the
 *     probe's gold now points at noise (a hit means nothing). This is a real defect — reword.
 *   - restoration-collapsed: thread members merge into each other, shrinking a multi-gold
 *     thread. Sometimes legitimate, but it changes what recall means — surfaced so it's a choice.
 */
export async function auditScenarios(scenarios: Scenario[], embedder: EmbeddingProvider): Promise<MergeWarning[]> {
  const warnings: MergeWarning[] = [];
  for (const scenario of scenarios) {
    const { core, map } = await seedScenario(scenario, embedder);
    core.close();
    const bgIds = new Set([...map].filter(([key]) => key.startsWith("bg:")).map(([, id]) => id));
    for (const seed of scenario.seed) {
      const id = map.get(seed.key);
      if (id && bgIds.has(id)) {
        warnings.push({ scenarioId: scenario.id, kind: "gold-into-background", detail: `seed '${seed.key}' merged into a background concept` });
      }
    }
    for (const probe of scenario.probes.filter((p) => p.category === "restoration")) {
      const distinct = new Set(probe.gold.map((k) => map.get(k)).filter(Boolean));
      if (distinct.size < probe.gold.length) {
        warnings.push({
          scenarioId: scenario.id,
          kind: "restoration-collapsed",
          detail: `${probe.gold.length} thread members → ${distinct.size} distinct concepts`,
        });
      }
    }
  }
  return warnings;
}

/**
 * Run the whole suite across every arm. Each scenario's store is seeded ONCE (background +
 * seeds) and shared across arms — `search` is a pure read, so this is safe and avoids
 * re-embedding the corpus per arm (the dominant cost under MiniLM). Unavailable arms are
 * recorded with no metrics, never dropped.
 */
export async function runSuite(
  scenarios: Scenario[],
  arms: RetrievalArm[],
  embedder: EmbeddingProvider,
  opts: { embedderName?: string } = {},
): Promise<SuiteReport> {
  const available = arms.filter((a) => a.available);
  const byArm = new Map<string, ProbeResult[]>(available.map((a) => [a.name, []]));

  for (const scenario of scenarios) {
    const { core, map } = await seedScenario(scenario, embedder);
    try {
      for (const arm of available) {
        const probes = await scoreProbes(scenario, map, (q) => arm.retrieve(core, q, { circle: CIRCLE, k: RANK_DEPTH }));
        byArm.get(arm.name)!.push(...probes);
      }
    } finally {
      core.close();
    }
  }

  const armReports: ArmReport[] = arms.map((a) =>
    a.available
      ? { arm: a.name, available: true, metrics: summarize(byArm.get(a.name)!), probes: byArm.get(a.name)! }
      : { arm: a.name, available: false, unavailableReason: a.unavailableReason, metrics: null, probes: [] },
  );

  return { embedder: opts.embedderName ?? embedder.constructor.name, ladder: [...K_LADDER], scenarios: scenarios.length, arms: armReports };
}
