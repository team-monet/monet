/**
 * md-baseline retrieval arms — Phase 0 of the engine-vs-md proof harness (spec §2).
 *
 * These arms are kept in a SEPARATE module/arm-set from strategies.ts's DEFAULT_ARMS
 * deliberately (spec §2.4/§2.6): `pnpm eval` and DEFAULT_ARMS stay byte-for-byte unchanged.
 * This file only ever ADDS arms consumed by run-baseline.ts / `pnpm eval:baseline`.
 *
 *   bm25              — ported from eval/longmemeval-bench (branch strategies.ts:90-170,
 *                        verified portable per spec §1.2/§2.4): from-scratch Okapi BM25
 *                        (k1=1.5, b=0.75) over allConceptTextsForEval(). Genuinely independent
 *                        of Monet's ranking — lexical only, no embeddings.
 *   chunk-cosine-rag   — NOT ported from the branch. The branch's denseRagArm is the
 *                        documented trap (spec §1.2/§2.3): it calls core.search() re-sliced,
 *                        which is bit-identical to monet-search's ranking, not an independent
 *                        signal. This arm embeds md-tree CHUNKS (not concepts) with the same
 *                        embedder the engine uses, stores vectors in a plain array OUTSIDE
 *                        MonetCore, and cosine-ranks them directly in eval code — zero
 *                        dependency on core.search()'s ranking/dedup/scoring path.
 *   md-tree            — BM25-over-chunks against the exported md tree (md-export.ts),
 *                        instead of the concept store. Retrieval unit is a chunkId, not a
 *                        conceptId — the harness-baseline.ts scoring layer maps between them
 *                        via the exporter's gold manifest (spec §2.2).
 *
 * chunk-cosine-rag and md-tree both need PER-SCENARIO state (the chunk index / embeddings
 * built from that scenario's seeded corpus) that the RetrievalArm interface's retrieve(core, ...)
 * signature has no slot for beyond `core` itself. Rather than reach into MonetCore's private
 * embedder (which would violate chunk-cosine-rag's "zero dependency on core" requirement
 * anyway), both are built as FACTORY functions returning a fresh RetrievalArm-shaped object
 * that lazily builds and WeakMap-caches its index per `core` instance on first retrieve() —
 * this lets them satisfy RetrievalArm exactly and run through the unmodified runSuite()/report
 * machinery (same "seed once, shared across arms" contract harness.ts already documents),
 * instead of forking a second scoring loop that could drift from the tested one.
 */
import type { MonetCore } from "../engine";
import type { EmbeddingProvider } from "../embedding";
import { cosine } from "../embedding";
import type { RetrievalArm } from "./strategies";
import { exportMdTree, type ExportedChunk, type MdExportResult, type ExportOpts } from "./md-export";

// ── Minimal BM25 implementation ─────────────────────────────────────────────
// Okapi BM25 with standard parameters (k1=1.5, b=0.75). Index/scorer math ported unchanged
// from eval/longmemeval-bench:src/eval/strategies.ts lines ~95-152 (git show, read-only
// reference — the branch itself is never checked out or merged, per the mission's constraint).
// The one deliberate generalization: parameterized over any {id, text}[] corpus (concepts OR
// chunks) instead of hardcoding allConceptTextsForEval()'s shape, so bm25Arm (concepts) and the
// md-tree arm (chunks) share one index/scorer instead of forking the implementation a second
// time — the underlying BM25 formula itself is untouched from the reference.

const BM25_K1 = 1.5;
const BM25_B = 0.75;

function tokenizeBm25(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

interface Bm25Index {
  tf: Map<string, Map<string, number>>;
  df: Map<string, number>;
  dl: Map<string, number>;
  avgDl: number;
  N: number;
}

function buildBm25Index(docs: Array<{ id: string; text: string }>): Bm25Index {
  const tf = new Map<string, Map<string, number>>();
  const df = new Map<string, number>();
  const dl = new Map<string, number>();
  for (const { id, text } of docs) {
    const tokens = tokenizeBm25(text);
    dl.set(id, tokens.length);
    const freq = new Map<string, number>();
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
    tf.set(id, freq);
    for (const t of freq.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const totalLen = [...dl.values()].reduce((a, v) => a + v, 0);
  const avgDl = docs.length > 0 ? totalLen / docs.length : 1;
  return { tf, df, dl, avgDl, N: docs.length };
}

function bm25Score(idx: Bm25Index, docId: string, queryTokens: string[]): number {
  const docTf = idx.tf.get(docId);
  if (!docTf) return 0;
  const docLen = idx.dl.get(docId) ?? 0;
  let score = 0;
  for (const t of queryTokens) {
    const tf = docTf.get(t) ?? 0;
    if (tf === 0) continue;
    const df = idx.df.get(t) ?? 0;
    const idf = Math.log((idx.N - df + 0.5) / (df + 0.5) + 1);
    const tfNorm = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / idx.avgDl)));
    score += idf * tfNorm;
  }
  return score;
}

/**
 * A1 fix (Codex finding #4): zero-score docs are filtered out BEFORE the sort/slice. Without
 * this, once genuine lexical matches are exhausted, the tail of the top-k slice was filled
 * with arbitrary, id-tie-broken, zero-signal documents — a gold doc whose id happened to win
 * that tie-break was scored as a "hit" with NO actual BM25 evidence behind it, inflating
 * bm25/md-tree recall dishonestly. Confirmed reproducible before this fix with an adversarial
 * construction: a query sharing zero tokens with any doc still returned k documents, sorted
 * purely by id, and a "gold" doc among them registered a false hit. Post-fix, a no-overlap
 * query returns FEWER results than requested (possibly zero) instead of fabricated matches —
 * the correct, honest behavior for a sparse lexical baseline.
 *
 * Returns the FULL, unsliced, score-filtered ranking — bm25Rank (below) and md-tree's
 * scoreAllChunks (A2 fix) both slice from this same list, so there is exactly one BM25 scoring
 * computation, never a forked second implementation for the file-ranking path.
 */
function bm25RankAll(docs: Array<{ id: string; text: string }>, query: string): Array<{ id: string; score: number }> {
  const idx = buildBm25Index(docs);
  const qTokens = tokenizeBm25(query);
  return docs
    .map(({ id }) => ({ id, score: bm25Score(idx, id, qTokens) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}

function bm25Rank(docs: Array<{ id: string; text: string }>, query: string, k: number): string[] {
  return bm25RankAll(docs, query)
    .slice(0, k)
    .map((r) => r.id);
}

/**
 * BM25 baseline: classic sparse lexical ranking over concept title+body text. Ported per spec
 * §2.4. Index is rebuilt per retrieve() call (one per probe per scenario) — cheap for a corpus
 * of ≤100 docs, matching the branch's own note on why this is fine at this scale.
 */
export const bm25Arm: RetrievalArm = {
  name: "bm25",
  available: true,
  async retrieve(core, query, { circle, k }) {
    const docs = core.allConceptTextsForEval(circle);
    return bm25Rank(docs, query, k);
  },
};

// ── chunk-cosine-rag: independent embedding pipeline over md-tree chunks ──────────────────
// Deliberately duplicates cosine ranking (not core.search()'s scan+sort) so ranking, dedup,
// and arousal/usefulness scoring in the engine can never leak into this arm's numbers.

interface ChunkCosineIndex {
  chunks: ExportedChunk[];
  vectors: Float32Array[]; // parallel to chunks, computed once per core instance
}

export interface ScoredChunk {
  chunkId: string;
  score: number;
}

export interface ScoringArm {
  arm: RetrievalArm;
  /**
   * A2 fix (Codex finding #3): the FULL, untruncated per-chunk score list for one query —
   * every chunk in the export, scored, in the SAME rank order retrieve() would slice from,
   * but never sliced to k. harness-baseline.ts uses this to rank FILES directly (aggregate
   * max chunk score per file over this full list) rather than deriving files from a
   * RANK_DEPTH-truncated chunk list, which could hide a file whose gold-bearing chunks all
   * rank just past the truncation point behind one dominant file's many higher chunks.
   * retrieve() itself is unchanged — it's implemented as a thin slice over this same list, so
   * there is exactly one scoring computation, never a forked second implementation.
   */
  scoreAllChunks(core: MonetCore, query: string): Promise<ScoredChunk[]>;
}

/**
 * Factory: builds a chunk-cosine-rag arm bound to one embedder instance (the SAME embedder
 * instance the scenario's core was seeded with — cosine across two different embedding spaces
 * is meaningless, so the baseline runner must pass the identical instance it gave
 * seedScenario()). Lazily exports the md-tree and embeds its chunks on first retrieve() call
 * for a given `core`; a WeakMap cache means each scenario's export/embed work happens once,
 * shared across every probe in that scenario (mirrors DEFAULT_ARMS's own "seed once, shared
 * across arms" contract).
 */
export function makeChunkCosineRagArm(embedder: EmbeddingProvider, exportOptsForCore: (core: MonetCore) => ExportOpts): ScoringArm {
  const cache = new WeakMap<MonetCore, Promise<ChunkCosineIndex>>();

  const getIndex = (core: MonetCore): Promise<ChunkCosineIndex> => {
    let idx = cache.get(core);
    if (!idx) {
      idx = (async () => {
        const { chunks } = exportMdTree(core, exportOptsForCore(core));
        const vectors: Float32Array[] = [];
        for (const c of chunks) vectors.push(await embedder.embed(c.text));
        return { chunks, vectors };
      })();
      cache.set(core, idx);
    }
    return idx;
  };

  const scoreAllChunks = async (core: MonetCore, query: string): Promise<ScoredChunk[]> => {
    const { chunks, vectors } = await getIndex(core);
    const qEmb = await embedder.embed(query);
    return chunks
      .map((c, i) => ({ chunkId: c.chunkId, score: cosine(qEmb, vectors[i]) }))
      .sort((a, b) => b.score - a.score || (a.chunkId < b.chunkId ? -1 : 1));
  };

  return {
    arm: {
      name: "chunk-cosine-rag",
      available: true,
      async retrieve(core, query, { k }) {
        return (await scoreAllChunks(core, query)).slice(0, k).map((r) => r.chunkId);
      },
    },
    scoreAllChunks,
  };
}

// ── md-tree arm: BM25-over-chunks against the steelman export ─────────────────────────────

/**
 * Factory: builds the md-tree arm. Retrieval unit is chunkId (not conceptId) — scoring against
 * the concept-id gold set happens one layer up, in harness-baseline.ts, via the exporter's
 * chunkId→conceptKey manifest. Lazily exports+chunks per `core` instance, WeakMap-cached same
 * as chunk-cosine-rag, so the (identical) md-tree export is computed once and shared by both
 * chunk-space arms for a given scenario — not re-exported per arm.
 *
 * A3 design decision (Codex finding #5 — "rank the exported index file as part of md-tree"):
 * DELIBERATELY excludes index.md from this arm's retrieval surface. It ranks ONLY topic-file
 * chunks — named "md-tree (topic-files-only)" specifically to make that scope visible in every
 * report table, not left implicit.
 *
 * Why exclusion is the correct steelman for THIS (flat, single-hop) arm rather than a gap to
 * close: gold always lives on a topic-file chunk, never on an index.md line (index lines are
 * one-line SUMMARIES of topic-file content, not the gold content itself — spec §2.1). In a
 * flat retrieval harness with no hop mechanism (no "read the index, then follow a link to the
 * topic file it points at" step — that's reader behavior, not what this arm's single
 * BM25-over-chunks call can model), adding index.md chunks into the SAME ranked pool as topic
 * chunks can only ever HURT the reported numbers, never help them: an index chunk can rank
 * above a gold topic chunk and DISPLACE it from the top-k (strict chunk-recall's mechanism),
 * and an index chunk's `file` is index.md itself, which is NEVER a gold file — so if it ever
 * won a top-k FILE slot it would insert a genuine false-file into gold-containing-file@k while
 * displacing a real candidate. Both effects only ever move both metrics in the WRONG
 * direction. Since index.md content can only be an add-only source of false positives/
 * displacement for a flat arm, excluding it strictly dominates including it — this makes
 * exclusion the correct choice for measuring "how good is BM25 search over the concept
 * content itself," which is what this arm's numbers are meant to represent.
 *
 * Index-as-routing-vocabulary IS a real, legitimate capability of md-trees — just not one a
 * flat single-hop retrieval arm can honestly exercise. It's exercised properly in Phase 1's
 * agent-in-the-loop A2 arm (spec §3.1), where index.md is a real file on disk the agent can
 * choose to read first and follow links from — the two-hop "read index, then read the file it
 * points at" behavior this arm has no mechanism to model. Taking Codex's own offered
 * alternative here ("include index.md chunks... OR report this arm as topic-files-only") —
 * the topic-files-only label plus this comment IS the resolution, not a placeholder for a
 * future retrieval change.
 */
export function makeMdTreeArm(exportOptsForCore: (core: MonetCore) => ExportOpts): ScoringArm {
  const cache = new WeakMap<MonetCore, MdExportResult>();

  const getExport = (core: MonetCore): MdExportResult => {
    let ex = cache.get(core);
    if (!ex) {
      ex = exportMdTree(core, exportOptsForCore(core));
      cache.set(core, ex);
    }
    return ex;
  };

  const scoreAllChunks = async (core: MonetCore, query: string): Promise<ScoredChunk[]> => {
    const { chunks } = getExport(core);
    return bm25RankAll(
      chunks.map((c) => ({ id: c.chunkId, text: c.text })),
      query,
    ).map((r) => ({ chunkId: r.id, score: r.score }));
  };

  return {
    arm: {
      name: "md-tree (topic-files-only)",
      available: true,
      async retrieve(core, query, { k }) {
        return (await scoreAllChunks(core, query)).slice(0, k).map((r) => r.chunkId);
      },
    },
    scoreAllChunks,
  };
}
