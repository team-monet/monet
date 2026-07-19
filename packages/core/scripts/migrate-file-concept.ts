/**
 * One-shot DATA migration for the file=concept reshape (Phase 1, ratified).
 *
 * Background: before this reshape, EVERY chunk (heading section) of a source file was its own
 * separate `kind:source` concept. After the reshape, ALL chunks of one file consolidate onto ONE
 * file-level concept — enforced going forward by the write path (source-sync.ts's
 * fileConceptThisRun) and the physical schema (uq_source_chunks_active_concept_slot). Opening an
 * existing store with the new code upgrades its SCHEMA automatically and unconditionally
 * (MonetCore's version-gated ensureSchema — additive columns/indexes, safe on any open), but
 * nothing about that upgrade touches existing DATA. This script does the data half, in three steps:
 *
 * REVIEW FIX (round 4, Codex thread 16): steps 3-4 (native re-embed + graph rebuild) run under
 * --apply REGARDLESS of whether any source matches (or exists at all) — they cover the model-swap
 * consistency of the WHOLE store, not just source-touched concepts, so a native-only store (or one
 * whose only sources have already been removed) still needs them. Only step 1-2 (source re-sync +
 * orphan sweep) is skipped when there is nothing to re-sync.
 *
 *   1. Re-sync every source (independently isolated — REVIEW FIX: one source's failure is caught,
 *      reported, and does not abort the batch). SOURCE_CHUNKER_VERSION bumped v2->v3 (the
 *      minimum-chunk merge pass), which is baked into every chunk's ingestFingerprint — so the
 *      very next sync treats every chunk as changed, regardless of whether its content actually
 *      differs, and runs it through the real write path. fileConceptThisRun (source-sync.ts)
 *      resolves ONE target concept per file from that file's whole staged chunk set upfront, so
 *      every chunk of a file lands on the same concept — whichever prior per-chunk concept a
 *      surviving binding first resolves to.
 *   2. Sweep orphans (per source). Re-sync reassigns a surviving binding's chunk onto the winning
 *      file concept, but nothing in the ordinary sync path retires the LOSING prior per-chunk
 *      concepts it abandons: retire-absent cleanup only fires for a binding that disappeared
 *      entirely, and these bindings didn't disappear, they just changed which concept they point
 *      at. Left alone they end up `status='active'` with zero active source_chunks rows forever.
 *      This finds every such orphan per source (kind='source', source_identity matches,
 *      status='active', zero active chunks per core.hasActiveSourceChunks) and retires it.
 *   3. Re-embed every NATIVE concept (store-wide, once, after the per-source loop). REVIEW FIX
 *      (MAJOR): an embedder swap (item 9's multilingual default) otherwise strands every existing
 *      native concept under the OLD model's vector space while queries embed with the NEW model —
 *      cosine-compared directly, with no model gate, silently degrading (or actively misleading)
 *      similarity search/gather/dedup for the entire pre-existing store, not just source content.
 *      This re-embeds every native concept's CURRENT body with the SAME embedder instance the
 *      whole run uses (see --embedder below), leaving the WHOLE store under one model. Idempotent
 *      (a deterministic embedder re-embedding an unchanged body always produces the same vector).
 *      REVIEW FIX (round 4, Codex thread 11): immediately re-embeds that SAME concept's own
 *      observations too (reembedConceptObservations) — recomputeNativeConceptProjection and
 *      detach() both derive a concept's embedding FROM observations.embedding on ordinary native-
 *      concept paths, so leaving them behind would let a later split/detach silently reintroduce an
 *      old-model vector into concepts.embedding even after this same concept's row is migrated.
 *   4. Rebuild the similarity graph for every concept step 3 re-embedded (store-wide, once, AFTER
 *      step 3 completes in full — never interleaved with it). COLD-AUDIT FIX (MAJOR): step 3 alone
 *      migrates a concept's VECTOR but not its stored `related`/`about` edges (memory_edge) — those
 *      are computed once at write time (upsertEdgeBoth, off a bestMatches neighborhood search) and
 *      never revisited just because the vector they were computed from changed. Left alone, every
 *      edge keeps pointing at OLD-model-similarity neighbors forever, and gather()'s spread walk
 *      trusts them blindly. This step calls MonetCore.rederiveNativeConceptGraph for every
 *      concept step 3 successfully re-embedded — unwinding and rebuilding its edges from its NEW
 *      embedding. Run only AFTER every native is re-embedded, never per-concept inside step 3's own
 *      loop: rederiving concept A's neighbors while concept B (a candidate neighbor) still carries
 *      its PRE-swap vector would score two incompatible embedding spaces against each other and
 *      persist garbage edges — see that method's own docstring for the full reasoning.
 *
 *      DETERMINISM, verified empirically (four consecutive --apply runs against the same store):
 *      `related` edges (NN/cosine over a FIXED post-step-3 embedding set) are order-independent and
 *      stable immediately. `about` edges are gated by a pre-existing, order-sensitive hub threshold
 *      (isHubDf: df/n at the moment each concept is processed — deriveEntityEdges, same mechanism
 *      hub-edge-filter.test.ts documents) — listNativeConceptIds' ORDER BY id makes the processing
 *      order itself repeatable, but the FIRST rebuild pass over a store's pre-existing (possibly
 *      long-accumulated) graph still shows bounded, one-time churn while df/n moves off that old
 *      distribution (observed: ~2-3% of edges on a 441-concept/31k-edge store). A SECOND pass
 *      already reaches a true fixed point: verified byte-identical (src_id, dst_id, type, weight,
 *      origin) edge sets, by SHA-256, across two independent runs starting from a settled store.
 *      Practical implication: run this migration, then run it again once more before trusting the
 *      graph is fully settled — both re-syncing sources and re-embedding natives are already
 *      idempotent no-ops on a second run, so the only thing a second run actually still does is
 *      finish settling the graph.
 *
 *      ROUND 4 UPDATE, verified empirically against a real ~230MB/3600-concept store (a live
 *      corpus's first-ever file=concept consolidation — 2818 legacy per-chunk source concepts
 *      collapsing to 195 file concepts, 444 native concepts, ~39.7k memory_edge rows before):
 *      that "run it again once more" guidance held for Phase 2's PURE re-embed scenario (sources
 *      already consolidated, only vectors moving), but a store's FIRST-EVER file=concept
 *      consolidation is a much bigger one-time topology change — 1903 concepts disappearing in a
 *      single pass moves entity df/n far more than a re-embed alone does. This run needed a THIRD
 *      pass to reach the same byte-identical-edge-set fixed point (pass 1→2: 39681→31398→31302
 *      edges, still moving; pass 2→3: 31302→31302, SHA-256-identical). Don't assume a fixed
 *      number of passes: after --apply, diff the store's own edgesBefore/edgesAfter counts across
 *      consecutive runs (or hash memory_edge's own rows) and keep re-running until two IN A ROW
 *      report no change — that is the only real signal the graph has actually settled, on any
 *      store shape.
 *
 * Embedder pin (Codex review, PR #51 round 5, FIX N): under --apply, this script stamps sync_meta's
 * pin to the CHOSEN --embedder (core.adoptEmbedderPin()) as the FIRST thing it does after opening
 * the store — before source re-sync (step 1), before native re-embed (step 3), before the graph
 * rebuild (step 4). Two consequences this ordering exists to prevent:
 *   (i) Without a stamp, a freshly re-embedded store still has NO recorded pin (or a stale one from
 *       before this run), so its NEXT served open backfills a pin by DIMENSION alone — which cannot
 *       tell "the OLD default that happens to share this dimension" from "the NEW one this run just
 *       wrote every vector in", silently mis-pinning e.g. a multilingual re-embed back to the legacy
 *       English default the very next time anything opens the store for real.
 *   (ii) Re-running this script against its OWN prior --apply output would otherwise open an
 *        ALREADY-pinned store with a constructor embedder that DELIBERATELY differs from that pin
 *        (that mismatch is what --embedder means: "re-embed under THIS model, whatever the store is
 *        pinned to now") — arming the constructor-time pin guard and making every gated call in the
 *        source-sync loop (storeInternal, gather, etc.) throw EmbedderPinUnsatisfiedError. The
 *        per-source try/catch (see migrateOneSource) swallows that as an ordinary sync failure,
 *        reported and skipped exactly like a transient network error — silently leaving that
 *        source's concepts unmigrated forever, not merely delayed to the next run, since nothing
 *        about "sync failed, retry later" distinguishes this from a real transient fault.
 *
 * Stamping EARLY (before any re-embed work, not after) is a deliberate ordering choice for THIS
 * dev/operator harness specifically — not a general pattern to copy. It means a crash mid-run can
 * leave the pin already pointing at the target embedder while some vectors are still, temporarily,
 * under the OLD model: a real, if transient, inconsistent state. Accepted here because (a) a
 * verified backup is ALREADY mandatory before running this script at all (see the NEVER-without-a-
 * backup warning just below — this is designed to run against a disposable COPY), and (b) every
 * step this script runs is idempotent, so simply re-running it converges the store to fully-migrated
 * regardless of where a prior run crashed (see the DETERMINISM note above for the graph
 * specifically — the SAME "just run it again" guidance covers a stamp-then-crash too). The future
 * first-class core.migrateEmbeddings() (slice 2, not yet built) will instead flip the pin LAST,
 * atomically, only once every vector is confirmed re-embedded — this script is a one-shot operator
 * tool bridging until that exists, and its stamp-early ordering should NOT be read as the pattern a
 * production migration primitive ought to follow.
 *
 * Preflight (Codex review, PR #51 round 6, FIX P; reordered round 7, FIX X): under --apply, BEFORE
 * this script even CONSTRUCTS a MonetCore — not merely before adoptEmbedderPin(), as round 6 first
 * had it — this script confirms the chosen --embedder can actually produce a real embedding
 * (preflightEmbedder, below — a plain `await embedder.embed("preflight")`). Round 6's ordering was
 * itself a bug for a vector-free target DB: MonetCore's OWN constructor can mint a 'created' pin
 * (its fresh-store branch) naming an embedder that construction never actually verified could load
 * — a preflight running AFTER that construction could then fail, exiting the whole run while
 * leaving exactly the unsatisfied pin it existed to prevent. Preflighting BEFORE construction closes
 * this: the embedder instance exists independently of the core (it's passed INTO the constructor,
 * not derived from it), so reordering costs nothing. Direct consequence of the stamp-early ordering
 * above either way: without SOME preflight, an --embedder onnx run on a host where the model/
 * transformers.js can't load would stamp a pin, then have every per-item re-embed attempt in
 * reembedNativeConcepts/migrateOneSource fail — each caught individually by its own per-item
 * try/catch, never aborting the run — leaving a NON-EMPTY store permanently pinned to a model that
 * can never produce a vector, its data still unrewritten. A failed preflight ABORTS THE WHOLE RUN
 * before anything is written: no construction, no stamp, no partial work — the thrown error
 * propagates out of main() uncaught (see the bottom of this file), which already prints it and exits
 * non-zero. Gated on --apply only, same as adoptEmbedderPin itself: report-only never writes
 * anything regardless (see below — deferCreatedPin covers even the vector-free-DB construction-time
 * case now), so there is nothing here for a preflight failure to protect. hashing's own preflight is
 * instant and network-free either way (pure synchronous JS, no I/O), so the only real-world trigger
 * for this abort path is --embedder onnx on a host that can't reach or load the model.
 *
 * Exclusivity: this migration workflow requires EXCLUSIVE access to the target store. Close every
 * live session (MCP server, CLI) holding this store open before running --apply — a concurrent
 * writer touching the store mid-migration is undefined territory this script makes no attempt to
 * detect or coordinate with. The planned first-class core.migrateEmbeddings() (slice 2, see the
 * ordering note above) will enforce this mechanically with a real WAL-native lock probe before
 * touching anything; this one-shot operator script relies on the operator's own discipline instead.
 *
 * Exit code (Codex review, PR #51 round 8, FIX Y): every loop in this script (source sync/orphan
 * retirement, native re-embed, native observation re-embed, graph rebuild) is deliberately per-item
 * resilient — one bad item is caught, recorded, and skipped, never aborting the rest of that SAME
 * run (each loop's own docstring explains why: completing everything else maximizes progress per
 * invocation). That resilience has a sharp edge, though: under --apply, the pin is already stamped
 * to the target embedder (stamp-early, see "Embedder pin" above) by the time any of these loops even
 * run — so a run that finishes with SOME failures still exits 0 by default, looking like a clean
 * success, while the store is actually half-migrated: some vectors under the NEW model, some still
 * under the OLD one, all scored under the SAME (new) thresholds. This script now FAILS HARD instead:
 * if --apply and ANY loop recorded even one failure, main() throws after printing the full report
 * (not mid-run — the per-item resilience above is unchanged) and the process exits non-zero, with a
 * prominent, hard-to-miss block explaining the store is mid-migration, must not be opened by any
 * served path, and should simply be re-run (every step here is idempotent and retries failed items
 * from scratch) until a pass reports zero failures everywhere — or the mandatory backup restored.
 * Report-only is unaffected: nothing is ever mutated under it, so there is nothing to warn about
 * (every loop above returns an empty, failure-free report when !applyFlag anyway).
 *
 * Report-only by default (still opens the store, which still auto-upgrades the schema — that half
 * is additive and unconditional either way; the pin is NOT stamped in this mode). Two independent
 * guarantees now cover this, not one: adoptEmbedderPin() only ever runs under --apply (covers an
 * ALREADY-pinned store); MonetCoreOptions.deferCreatedPin is passed whenever NOT --apply (Codex
 * review, PR #51 round 7, FIX V — covers a genuinely vector-free target DB, whose fresh-store
 * branch would otherwise mint a 'created' pin during construction itself, on a plain report-only
 * inspection that promises never to write anything). --apply is required to actually stamp the pin,
 * re-sync sources, retire orphans, re-embed natives, and rebuild their graph. NEVER point this at a
 * store you care about without a tested, verified backup — it is designed to run against a
 * disposable COPY, and the copy step is the caller's job, not this script's: it operates on exactly
 * the db-path and storage-dir it's given.
 *
 * --embedder (hashing|onnx): which embedder generates every fresh vector this run writes — both the
 * source re-sync's recompute and the native re-embed pass share ONE instance, so the whole store
 * ends up under the SAME model consistently. COLD-AUDIT FIX: --apply now REQUIRES --embedder
 * explicitly (errors otherwise) — this decides the store's semantic model, too consequential a
 * choice for an implicit default. A REAL migration must pass --embedder onnx: John's ruling —
 * production uses the multilingual ONNX model (embedding-onnx.ts's default), and this script never
 * assumes that silently. A report-only/dry-run pass (no --apply) may still omit --embedder — it
 * defaults to hashing there, since nothing is actually written.
 *
 * Usage:
 *   tsx scripts/migrate-file-concept.ts <db-path> --storage-dir <dir> [--source <sourceId>]
 *     --embedder hashing|onnx --apply
 *   tsx scripts/migrate-file-concept.ts <db-path> --storage-dir <dir>   # report-only, no flags needed
 */
import { HashingEmbeddingProvider } from "../src/embedding";
import { OnnxEmbeddingProvider } from "../src/embedding-onnx";
import { MonetCore } from "../src/engine";
import type { EmbeddingProvider } from "../src/embedding";
import type { KnowledgeSource } from "../src/source-types";
import type { StoragePort } from "../src/storage";

/**
 * Preflight check (Codex review, PR #51 round 6, FIX P) — confirms `embedder` can actually produce
 * a real embedding BEFORE this script commits to anything. See the file docstring's "Preflight"
 * section for the full failure mode this closes (the direct consequence of round 5's stamp-early
 * ordering: an --embedder onnx run on a host where the model can't load would otherwise stamp the
 * pin, then have every per-item re-embed fail silently, caught one at a time, never aborting the
 * run). Throws (never returns a boolean) so a caller can't accidentally proceed past a failed
 * preflight by forgetting to check a return value — main() lets the throw propagate uncaught, which
 * aborts the whole run before adoptEmbedderPin or any re-embed work runs.
 *
 * Exported for testability: embedder-pin.test.ts-adjacent unit tests import this directly against a
 * real (hashing) and a fake failing embedder, without invoking main() — see the entry-point guard
 * at the bottom of this file (same established pattern as scripts/scrub-corpus.mjs/scrub-db.mjs).
 */
export async function preflightEmbedder(embedder: EmbeddingProvider, label: string): Promise<void> {
  try {
    await embedder.embed("preflight");
  } catch (e) {
    throw new Error(
      `Embedder preflight failed for --embedder ${label}: this model cannot produce an embedding ` +
        `right now (network unreachable, model not cached locally, or a genuine load failure). ` +
        `Aborting BEFORE stamping the pin or touching any data — nothing was written. Fix the ` +
        `underlying issue (or choose a different --embedder) and re-run.`,
      { cause: e },
    );
  }
}

interface OrphanConcept {
  id: string;
  title: string;
}

export interface SourceMigrationReport {
  sourceId: string;
  type: KnowledgeSource["type"];
  lifecycle: KnowledgeSource["lifecycle"];
  syncStatus: string;
  filesPublished: number | null;
  chunksPublished: number | null;
  conceptsBefore: number;
  conceptsAfterSync: number;
  conceptsAfterSweep: number;
  orphansRetired: OrphanConcept[];
  durationMs: number;
  error: string | null;
}

export interface NativeReembedReport {
  attempted: number;
  succeeded: number;
  succeededIds: string[];
  failed: Array<{ id: string; error: string }>;
  observationsReembedded: number;
  observationReembedFailed: Array<{ id: string; error: string }>;
  durationMs: number;
}

export interface GraphRebuildReport {
  attempted: number;
  succeeded: number;
  failed: Array<{ id: string; error: string }>;
  durationMs: number;
  edgesBefore: number;
  edgesAfter: number;
}

function activeSourceConceptCount(core: MonetCore, sourceId: string): number {
  const db = (core as unknown as { db: StoragePort }).db;
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM concepts WHERE kind = 'source' AND source_identity = ? AND status = 'active'`)
    .get(`source://${sourceId}`) as { n: number };
  return row.n;
}

function findOrphanConcepts(core: MonetCore, sourceId: string): OrphanConcept[] {
  const db = (core as unknown as { db: StoragePort }).db;
  const candidates = db
    .prepare(`SELECT id, title FROM concepts WHERE kind = 'source' AND source_identity = ? AND status = 'active'`)
    .all(`source://${sourceId}`) as OrphanConcept[];
  return candidates.filter((candidate) => !core.hasActiveSourceChunks(candidate.id));
}

async function migrateOneSource(core: MonetCore, source: KnowledgeSource, apply: boolean): Promise<SourceMigrationReport> {
  const startedAt = Date.now();
  const conceptsBefore = activeSourceConceptCount(core, source.id);
  let syncStatus = "skipped (report-only)";
  let filesPublished: number | null = null;
  let chunksPublished: number | null = null;
  let error: string | null = null;

  if (apply) {
    if (source.lifecycle !== "active") {
      syncStatus = `skipped (lifecycle=${source.lifecycle})`;
    } else {
      // REVIEW FIX (MAJOR, operational note): isolated per source — one source's failure (a
      // transient materializer error, an unreadable local path, anything) must not abort every
      // OTHER source's migration. Caught, reported, and the batch continues.
      try {
        const result = source.type === "git-md" ? await core.syncGitMdSource(source.id) : await core.syncRepoMdSource(source.id);
        syncStatus = result.status;
        if (result.runId) {
          filesPublished = core.listSourceFiles(result.runId, true).length;
          chunksPublished = core.listSourceChunks(result.runId, true).length;
        }
      } catch (e) {
        syncStatus = "FAILED";
        error = e instanceof Error ? e.message : String(e);
      }
    }
  }

  const conceptsAfterSync = activeSourceConceptCount(core, source.id);
  let orphans: OrphanConcept[] = [];
  if (apply && !error) {
    orphans = findOrphanConcepts(core, source.id);
    for (const orphan of orphans) {
      try {
        core.retireConcept(orphan.id);
      } catch (e) {
        error = `orphan retirement failed for ${orphan.id}: ${e instanceof Error ? e.message : String(e)}`;
        break;
      }
    }
  }
  const conceptsAfterSweep = activeSourceConceptCount(core, source.id);

  return {
    sourceId: source.id, type: source.type, lifecycle: source.lifecycle, syncStatus,
    filesPublished, chunksPublished, conceptsBefore, conceptsAfterSync, conceptsAfterSweep,
    orphansRetired: orphans, durationMs: Date.now() - startedAt, error,
  };
}

/** REVIEW FIX (MAJOR): re-embeds every native concept under the run's chosen embedder — see the
 *  file docstring's step 3. Each concept is isolated (one bad body/embed() failure is recorded and
 *  skipped, never aborts the pass) since this can touch every native concept in the store.
 *
 *  REVIEW FIX (round 4, Codex thread 11): also re-embeds each successfully-migrated concept's own
 *  OBSERVATIONS (reembedConceptObservations, engine.ts) — reembedConcept above only ever rewrote
 *  concepts.embedding, but recomputeNativeConceptProjection and detach() both derive a concept's
 *  embedding FROM observations.embedding on ordinary, frequently-hit native-concept paths. Left
 *  un-migrated, any one of those would silently pull an old-model vector back into a concept this
 *  script JUST migrated. Tracked separately from the concept-level failed list: an observation
 *  re-embed failure leaves that concept's OWN vector correctly migrated (still eligible for the
 *  graph rebuild pass below) and only that concept's observations at risk of the stale-vector
 *  regression on a LATER split/detach — worth surfacing, not worth treating as a re-embed failure. */
async function reembedNativeConcepts(core: MonetCore, apply: boolean): Promise<NativeReembedReport> {
  const startedAt = Date.now();
  if (!apply) {
    return { attempted: 0, succeeded: 0, succeededIds: [], failed: [], observationsReembedded: 0, observationReembedFailed: [], durationMs: 0 };
  }
  const ids = core.listNativeConceptIds();
  const succeededIds: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  let observationsReembedded = 0;
  const observationReembedFailed: Array<{ id: string; error: string }> = [];
  for (const id of ids) {
    let conceptReembedded = false;
    try {
      conceptReembedded = await core.reembedConcept(id);
      if (conceptReembedded) succeededIds.push(id);
    } catch (e) {
      failed.push({ id, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!conceptReembedded) continue;
    try {
      observationsReembedded += await core.reembedConceptObservations(id);
    } catch (e) {
      observationReembedFailed.push({ id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return {
    attempted: ids.length, succeeded: succeededIds.length, succeededIds, failed,
    observationsReembedded, observationReembedFailed, durationMs: Date.now() - startedAt,
  };
}

function totalEdgeCount(core: MonetCore): number {
  const db = (core as unknown as { db: StoragePort }).db;
  return (db.prepare(`SELECT COUNT(*) AS n FROM memory_edge`).get() as { n: number }).n;
}

/**
 * COLD-AUDIT FIX (MAJOR): rebuilds the stored similarity graph for every concept step 3 (re-embed)
 * successfully touched — see the file docstring's step 4 for why this is a strictly SEPARATE,
 * later pass, never folded into the re-embed loop. Scoped to succeededIds only, deliberately: a
 * concept whose re-embed itself failed is STILL under the old model, so rederiving its neighbors
 * now would be scoring it against a store that (from its own vector's perspective) hasn't swapped
 * yet — left alone, it stays exactly as consistent as it was before this script ran, healed the
 * next time the migration re-runs (see the report's own failed-source caveat, printReport). Each
 * concept is isolated the same way the re-embed loop is. */
async function rederiveNativeConceptGraphs(core: MonetCore, succeededIds: string[], apply: boolean): Promise<GraphRebuildReport> {
  const startedAt = Date.now();
  const edgesBefore = totalEdgeCount(core);
  if (!apply) return { attempted: 0, succeeded: 0, failed: [], durationMs: 0, edgesBefore, edgesAfter: edgesBefore };
  let succeeded = 0;
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of succeededIds) {
    try {
      if (core.rederiveNativeConceptGraph(id)) succeeded++;
    } catch (e) {
      failed.push({ id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { attempted: succeededIds.length, succeeded, failed, durationMs: Date.now() - startedAt, edgesBefore, edgesAfter: totalEdgeCount(core) };
}

function printReport(
  reports: SourceMigrationReport[], native: NativeReembedReport, graph: GraphRebuildReport, apply: boolean, embedderLabel: string,
): void {
  console.log(`\n=== file=concept migration report (${apply ? "APPLIED" : "report-only"}, embedder=${embedderLabel}) ===\n`);
  for (const r of reports) {
    console.log(`source ${r.sourceId} (${r.type}, lifecycle=${r.lifecycle})`);
    console.log(`  sync status:         ${r.syncStatus}${r.error ? `  [ERROR: ${r.error}]` : ""}`);
    console.log(`  files published:     ${r.filesPublished ?? "n/a"}`);
    console.log(`  chunks published:    ${r.chunksPublished ?? "n/a"}`);
    console.log(`  active source concepts  before: ${r.conceptsBefore}`);
    console.log(`  active source concepts  after sync (pre-sweep): ${r.conceptsAfterSync}`);
    console.log(`  active source concepts  after orphan sweep:     ${r.conceptsAfterSweep}`);
    console.log(`  orphans retired:     ${r.orphansRetired.length}`);
    const shown = r.orphansRetired.slice(0, 20);
    for (const o of shown) console.log(`    - ${o.id}  "${o.title}"`);
    if (r.orphansRetired.length > shown.length) console.log(`    ... and ${r.orphansRetired.length - shown.length} more`);
    console.log(`  duration:            ${r.durationMs}ms\n`);
  }
  const totals = reports.reduce(
    (acc, r) => ({
      before: acc.before + r.conceptsBefore,
      afterSweep: acc.afterSweep + r.conceptsAfterSweep,
      orphans: acc.orphans + r.orphansRetired.length,
      failures: acc.failures + (r.error ? 1 : 0),
    }),
    { before: 0, afterSweep: 0, orphans: 0, failures: 0 },
  );
  console.log(`SOURCES TOTAL: ${totals.before} active source concepts before -> ${totals.afterSweep} after `
    + `(${totals.orphans} orphans retired, ${totals.failures} source(s) failed).`);
  if (totals.failures > 0) {
    const failedIds = reports.filter((r) => r.error).map((r) => r.sourceId);
    console.log(`  CAVEAT: ${totals.failures} source(s) failed and were skipped: ${failedIds.join(", ")}.`);
    console.log(`  Their concepts remain exactly as they were before this run (still under the OLD`);
    console.log(`  chunk-per-concept shape, and — if this is also an embedder-swap run — still under`);
    console.log(`  the OLD embedding model too, since a failed sync never reaches this source's own`);
    console.log(`  data). Re-running this migration heals them: every step here is idempotent, and a`);
    console.log(`  source that failed once is retried from scratch on the next invocation, exactly`);
    console.log(`  like a source that was never migrated at all.`);
  }

  console.log(`\nnative re-embed (item 9, model-swap consistency)`);
  console.log(`  attempted: ${native.attempted}`);
  console.log(`  succeeded: ${native.succeeded}`);
  console.log(`  failed:    ${native.failed.length}`);
  for (const f of native.failed.slice(0, 20)) console.log(`    - ${f.id}: ${f.error}`);
  if (native.failed.length > 20) console.log(`    ... and ${native.failed.length - 20} more`);
  console.log(`  duration:  ${native.durationMs}ms`);
  if (native.failed.length > 0) {
    console.log(`  CAVEAT: ${native.failed.length} native concept(s) failed to re-embed and were skipped —`);
    console.log(`  they remain under the OLD embedding model. Re-running this migration retries them`);
    console.log(`  (listNativeConceptIds re-lists every non-retired native every run; this is not a`);
    console.log(`  one-shot list consumed on first failure).`);
  }

  // REVIEW FIX (round 4, Codex thread 11): observation-level re-embed — see reembedNativeConcepts'
  // own docstring for why this has to run per-concept, right after that concept's own re-embed.
  console.log(`\nnative observation re-embed (round 4, thread 11: detach()/projection-rebuild consistency)`);
  console.log(`  observations re-embedded: ${native.observationsReembedded}`);
  console.log(`  concepts with a failed observation re-embed: ${native.observationReembedFailed.length}`);
  for (const f of native.observationReembedFailed.slice(0, 20)) console.log(`    - ${f.id}: ${f.error}`);
  if (native.observationReembedFailed.length > 20) console.log(`    ... and ${native.observationReembedFailed.length - 20} more`);
  if (native.observationReembedFailed.length > 0) {
    console.log(`  CAVEAT: this concept's OWN vector is correctly migrated (still eligible for the graph`);
    console.log(`  rebuild below) — only its observations remain under the OLD model, at risk of a later`);
    console.log(`  memory_detach or projection rebuild pulling an old-model vector back into`);
    console.log(`  concepts.embedding. Re-running this migration retries them (reembedConceptObservations`);
    console.log(`  is idempotent, same as reembedConcept).`);
  }

  // COLD-AUDIT FIX (MAJOR): graph rebuild — see the file docstring's step 4.
  console.log(`\nnative similarity-graph rebuild (cold-audit fix, item 9 model-swap consistency)`);
  console.log(`  attempted: ${graph.attempted} (every native concept re-embed just succeeded for)`);
  console.log(`  succeeded: ${graph.succeeded}`);
  console.log(`  failed:    ${graph.failed.length}`);
  for (const f of graph.failed.slice(0, 20)) console.log(`    - ${f.id}: ${f.error}`);
  if (graph.failed.length > 20) console.log(`    ... and ${graph.failed.length - 20} more`);
  console.log(`  store-wide memory_edge rows before: ${graph.edgesBefore}`);
  console.log(`  store-wide memory_edge rows after:  ${graph.edgesAfter}`);
  console.log(`  duration:  ${graph.durationMs}ms`);
  if (graph.failed.length > 0) {
    console.log(`  CAVEAT: ${graph.failed.length} concept(s) re-embedded successfully but failed to`);
    console.log(`  rebuild their graph — their VECTOR is under the new model, but their stored`);
    console.log(`  related/about edges may still reflect old-model neighbors. Re-running this`);
    console.log(`  migration retries them (reembedConcept is idempotent, so the vector step is a`);
    console.log(`  harmless no-op the second time; only the graph step actually needed a retry).`);
  }
}

/**
 * Whether ANY loop above recorded a failure — source sync/orphan retirement, native concept
 * re-embed, native observation re-embed, or graph rebuild (Codex review, PR #51 round 8, FIX Y).
 * Every one of those loops is deliberately per-item resilient (one bad item never aborts the rest —
 * see each loop's own docstring for why), so a --apply run can complete and print a report while
 * some vectors are still stranded under the OLD embedding model. This predicate is what main() uses
 * to decide whether a completed run must still exit non-zero. Exported for testability: a pure
 * function over the three report shapes, no I/O of its own — the ordering/looping logic that
 * PRODUCES these reports still isn't independently testable without a real MonetCore and real (or
 * poisoned) sources, but the fail-hard DECISION itself is exercised directly, without needing to
 * drive a full run to prove this part works.
 */
export function anyMigrationFailure(
  reports: SourceMigrationReport[], native: NativeReembedReport, graph: GraphRebuildReport,
): boolean {
  return (
    reports.some((r) => r.error !== null) ||
    native.failed.length > 0 ||
    native.observationReembedFailed.length > 0 ||
    graph.failed.length > 0
  );
}

/**
 * Builds the prominent, impossible-to-miss failure message main() throws when
 * anyMigrationFailure() is true under --apply (Codex review, PR #51 round 8, FIX Y). Exported for
 * testability — asserting on its exact content without needing to drive main() end-to-end.
 */
export function migrationIncompleteMessage(embedderLabel: string): string {
  const bar = "!".repeat(78);
  return [
    "",
    bar,
    "MIGRATION INCOMPLETE — this store is MID-MIGRATION, not done.",
    bar,
    `The pin already points at the target embedder (${embedderLabel}) — that stamp happens`,
    "deliberately EARLY, before this run's own work, and stays UNCHANGED by a failure discovered",
    "later (see this file's docstring, \"Embedder pin\" section). Some vectors reported above are",
    "STILL under the OLD model, mismatched against that pin.",
    "",
    "DO NOT open this store with any served path (the MCP server, the CLI) until it is fully",
    "migrated — queries would silently mix two incompatible vector spaces.",
    "",
    "Re-run this script against the SAME db-path: every step here is idempotent, and a failed",
    "item is retried from scratch on the next invocation exactly like one that was never touched",
    "(see the per-section CAVEATs printed above). Keep re-running until a pass reports ZERO",
    "failures in every section. If failures persist, restore the mandatory backup instead.",
    bar,
  ].join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flagValue = (name: string): string | undefined => {
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  const dbPath = args.find((a, i) => !a.startsWith("--") && !["--storage-dir", "--source", "--embedder"].includes(args[i - 1] ?? ""));
  const applyFlag = args.includes("--apply");
  const storageDir = flagValue("--storage-dir");
  const onlySourceId = flagValue("--source");
  const embedderArg = flagValue("--embedder");

  if (!dbPath) {
    console.error("Usage: tsx scripts/migrate-file-concept.ts <db-path> --storage-dir <dir> [--source <sourceId>]");
    console.error("         --embedder hashing|onnx --apply");
    console.error("       tsx scripts/migrate-file-concept.ts <db-path> --storage-dir <dir>   # report-only");
    console.error("  (no --apply = report-only: opens the store [schema auto-upgrades], counts");
    console.error("   concepts per source, re-syncs/retires/re-embeds NOTHING)");
    process.exit(1);
  }
  // COLD-AUDIT FIX: --apply requires --embedder explicitly — this decides the store's semantic
  // model, too consequential a choice for an implicit default. Report-only may still omit it
  // (defaults to hashing) since nothing is actually written under either model.
  if (applyFlag && embedderArg === undefined) {
    console.error('--apply requires --embedder explicitly: specify --embedder onnx|hashing explicitly —');
    console.error("this decides the store's semantic model.");
    console.error("(A REAL migration should pass --embedder onnx — John's ruling, production uses the");
    console.error(" multilingual ONNX model. --embedder hashing is for a fast, dependency-free dry run.)");
    process.exit(1);
  }
  const embedderChoice = embedderArg ?? "hashing";
  if (embedderChoice !== "hashing" && embedderChoice !== "onnx") {
    console.error(`--embedder must be "hashing" or "onnx", got "${embedderChoice}"`);
    process.exit(1);
  }

  if (!applyFlag) {
    console.log("REPORT-ONLY mode (the store's SCHEMA still auto-upgrades on open — additive, not");
    console.log("destructive: new columns/index only). No source is re-synced, no concept is retired,");
    console.log("re-embedded, or graph-rebuilt. Pass --apply (and --embedder) to actually run the migration.\n");
  } else {
    console.log("WARNING: --apply re-syncs every listed source, retires orphaned concepts, re-embeds");
    console.log("every native concept, and rebuilds its similarity graph. This should be running");
    console.log("against a disposable COPY, never a store you care about.");
    console.log(`Target db:      ${dbPath}`);
    console.log(`Target storage: ${storageDir ?? "(engine default)"}`);
    console.log(`Embedder:       ${embedderChoice}${embedderChoice === "hashing" ? " (NOT the production model — pass --embedder onnx for a real migration)" : ""}\n`);
  }

  const embedder: EmbeddingProvider = embedderChoice === "onnx" ? new OnnxEmbeddingProvider() : new HashingEmbeddingProvider();
  // Codex review (PR #51 round 7, FIX X): preflight BEFORE constructing MonetCore, not after (round
  // 6's FIX P ran it post-construction) — see the file docstring's "Preflight" section for why: on a
  // vector-free target DB, construction's OWN fresh-store branch can stamp a 'created' pin naming
  // an embedder that then turns out to be unloadable, so a preflight that runs AFTER construction
  // can fail while leaving exactly the unsatisfied pin it was meant to prevent. The embedder
  // instance exists independently of the core, so running this first costs nothing.
  if (applyFlag) await preflightEmbedder(embedder, embedderChoice);
  const core = new MonetCore(dbPath, {
    ...(storageDir ? { sourceStorageDir: storageDir } : {}),
    embedder,
    // Codex review (PR #51 round 7, FIX V): report-only must never write a pin, even against a
    // vector-free target DB whose fresh-store branch would otherwise mint one — see
    // MonetCoreOptions.deferCreatedPin's own doc comment and the file docstring's "Report-only by
    // default" section. Under --apply, construction now runs only AFTER a successful preflight
    // (immediately above), so any 'created' pin minted here is always of a PROVEN-loadable embedder
    // — closing the interplay between the two fixes: report-only never stamps regardless of
    // preflight; --apply's stamp (construction's own, or adoptEmbedderPin's below) is never of an
    // embedder that hasn't just been confirmed to actually work.
    deferCreatedPin: !applyFlag,
  });
  try {
    // Codex review (PR #51 round 5, FIX N): stamp the pin to THIS run's --embedder before any
    // re-sync/re-embed/graph work — see the file docstring's "Embedder pin" section for why the
    // ordering matters and why --apply gates it (a report-only/dry-run pass must never write
    // anything, pin included; deferCreatedPin above already covers the fresh-store case — this
    // covers the already-pinned-to-something-else case adoptEmbedderPin exists for).
    // adoptEmbedderPin() is synchronous — no await needed.
    if (applyFlag) core.adoptEmbedderPin();
    const sources = core.listSources({ includeTombstoned: true }).filter((s) => !onlySourceId || s.id === onlySourceId);
    // REVIEW FIX (round 4, Codex thread 16): a store with NO matching sources (a native-only
    // store, or one whose sources were already migrated/removed since the last embedder swap)
    // used to return here BEFORE reaching the native re-embed pass — but the whole POINT of that
    // pass (item 9's model-swap consistency, see the file docstring's step 3) is that it affects
    // EVERY native concept in the store regardless of whether any source happens to exist, let
    // alone match --source. The early return now only skips the PER-SOURCE loop (nothing to
    // re-sync/sweep-orphan when there is no matching source); native re-embed + graph rebuild
    // always run under --apply, same as when sources ARE present. --embedder stays hard-required
    // for --apply regardless (checked above, before this function's own logic runs at all).
    if (sources.length === 0) {
      console.log(`No sources found${onlySourceId ? ` matching --source ${onlySourceId}` : ""}. Skipping source re-sync/orphan-sweep —`);
      console.log("still running the native re-embed + graph rebuild passes below (they cover the whole");
      console.log("store, not just source-touched concepts).");
    }
    const reports: SourceMigrationReport[] = [];
    for (const source of sources) reports.push(await migrateOneSource(core, source, applyFlag));
    const native = await reembedNativeConcepts(core, applyFlag);
    // COLD-AUDIT FIX (MAJOR): strictly AFTER the re-embed loop above has fully completed — see the
    // file docstring's step 4 and rederiveNativeConceptGraphs' own docstring for why.
    const graph = await rederiveNativeConceptGraphs(core, native.succeededIds, applyFlag);
    printReport(reports, native, graph, applyFlag, embedderChoice);

    // Codex review (PR #51 round 8, FIX Y): every loop above is deliberately per-item resilient (see
    // each loop's own docstring) so ONE run makes maximum progress even when something is broken —
    // but that same resilience means a --apply run can complete and exit 0 with the pin ALREADY
    // stamped to the target space (adoptEmbedderPin above, or construction's own fresh-store branch)
    // while some vectors are STILL under the OLD model: a genuinely half-migrated store that looks,
    // from the exit code alone, like a clean success. FAIL HARD here, at the very end, on the
    // SUMMARY — never mid-run (the loops above are untouched; this is purely a post-hoc check).
    // Report-only is unaffected: nothing was ever mutated under it, so there is nothing to warn
    // about — anyMigrationFailure is always false there anyway (every loop above returns an empty
    // report when !applyFlag), but the guard below is explicit about it, not incidental.
    if (applyFlag && anyMigrationFailure(reports, native, graph)) {
      throw new Error(migrationIncompleteMessage(embedderChoice));
    }
  } finally {
    core.close();
  }
}

// Run only when invoked directly (`tsx scripts/migrate-file-concept.ts ...`), never as a side
// effect of importing this module's exported preflightEmbedder elsewhere (Codex review, PR #51
// round 6, FIX P's test coverage imports it from src/__tests__ — that import must not also execute
// a full migration run). Same established pattern as scripts/scrub-corpus.mjs/scrub-db.mjs.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
