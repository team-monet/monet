/**
 * Latency at scale for the two slices that moved scoring from concept centroids to observation
 * vectors: the recall unit split (src/retrieval.ts, READ path) and store-time resolution
 * (src/resolution.ts, WRITE path).
 *
 *   npx tsx scripts/measure-recall-perf.ts            # 250 concepts x 10 observations
 *   CONCEPTS=500 npx tsx scripts/measure-recall-perf.ts
 *
 * WHY THIS LIVES IN THE REPO: both slices changed a cost model. Search used to cosine ONE vector
 * per concept (the centroid); it now cosines every live observation vector — roughly 10x the
 * arithmetic on a consolidated store — in exchange for the relevance fix. Store then ADDED a second
 * scan of the same shape: the centroid scan stays (it still derives `related` edges, which are a
 * concept-to-concept question) and an observation scan runs beside it to nominate the resolution
 * target. Both trades were accepted against measured numbers, so the measurement has to be
 * repeatable by anyone who touches the scorers, the SQL, or the candidate enumeration. Reporting
 * only; in-memory store, exits 0.
 *
 * Uses the deterministic lexical embedder on purpose: this measures RETRIEVAL and RESOLUTION, not
 * model inference. Swapping in MiniLM would bury the signal under ~100x of per-call embed time.
 *
 * STORE TIMING METHOD: the store path is timed on auto-resolution writes only — the seed phase uses
 * attachTo, which bypasses scoring by design and would dilute the number with writes that never
 * scan at all. The timed writes go into the SEEDED circle, because a scan of an empty circle
 * measures nothing; the store size reported is the one they were measured against.
 *
 * REFERENCE NUMBERS — SEARCH (this machine, main c24e62e vs the unit split, mean over 40 searches):
 *   250 concepts / 2,500 observations   search 3.72ms -> 15.57ms (4.19x)
 *   500 concepts / 5,000 observations   search 7.47ms -> 33.65ms (4.51x)
 * Search is linear in store size and the ratio is stable across the doubling.
 *
 * REFERENCE NUMBERS — STORE (this machine, main ad3ee70 vs the resolution hybrid, mean over 40):
 *    50 concepts /   500 observations   store()  5.29ms -> 9.06ms  (+3.8ms)
 *   250 concepts / 2,500 observations   store() 10.08ms -> 27.50ms (+17.4ms)
 *   500 concepts / 5,000 observations   store() 15.53ms -> 53.73ms (+38.2ms)
 * The ADDED cost is linear in observation count (roughly the same arithmetic search's own
 * observation arm does at that size) while the baseline it is added to is dominated by fixed
 * write/edge work — which is why the RATIO grows with scale even though nothing super-linear is
 * happening. attachTo and forceNew are unaffected: they skip the nomination scan entirely.
 *
 * WATCH FOR: a search ratio drifting past ~5x, an absolute search time past ~250ms at the sizes
 * above, or a search ratio that GROWS with scale (that would mean the json_each batching stopped
 * batching — e.g. a per-concept query creeping back into the arm). For store: an added cost that
 * outruns search's own observation scan at the same size — the two do the same work, so store
 * pulling ahead means the nomination scan has stopped sharing that shape.
 */
import { MonetCore } from "../src/engine";
import { HashingEmbeddingProvider } from "../src/embedding";
import { printProviderIdentity, printSyntheticStoreHeader, requireTrustableSpace } from "./measure-header";
import type { StoragePort } from "../src/storage";

const CIRCLE = "perf";
const CONCEPTS = Number(process.env.CONCEPTS ?? 250);
const OBS_PER_CONCEPT = 9; // + the creating observation => 10 per concept
const SEARCH_ROUNDS = 5;
const STORE_WRITES = 40; // matches the search sample size (8 queries x 5 rounds)

const NOUNS = ["scheduler", "exporter", "cluster", "cache", "queue", "router", "ledger", "indexer", "planner", "collector"];
const VERBS = ["retries", "batches", "streams", "compacts", "throttles", "replicates", "validates", "shards", "drains", "checkpoints"];
const OBJECTS = [
  "idempotent writes", "partition offsets", "stale sessions", "audit records", "chunk manifests",
  "credential leases", "retry budgets", "vector payloads", "sync watermarks", "tombstoned rows",
];

/** Synthetic but not degenerate: overlapping vocabulary, so candidates genuinely compete. */
const observationText = (i: number, j: number): string =>
  `The ${NOUNS[i % 10]}-${i} ${VERBS[j % 10]} ${OBJECTS[(i + j) % 10]} every ${(i * 7 + j) % 60} seconds under the ${NOUNS[(i + 3) % 10]} policy.`;

const QUERIES = [
  "how does the scheduler handle idempotent writes",
  "partition offsets batching in the exporter",
  "stale session compaction policy for the cache",
  "credential lease throttling in the router",
  "vector payload sharding across the indexer",
  "sync watermark checkpointing in the collector",
  "audit record replication for the ledger",
  "retry budget draining under the queue policy",
];

const nowMs = (): number => Number(process.hrtime.bigint() / 1000n) / 1000;

function summarize(samples: number[]): string {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return `mean=${mean.toFixed(2)}ms  p50=${s[Math.floor(s.length / 2)].toFixed(2)}ms` +
    `  p95=${s[Math.floor(s.length * 0.95)].toFixed(2)}ms  max=${s[s.length - 1].toFixed(2)}ms  (n=${s.length})`;
}

async function main(): Promise<void> {
  let seq = 0;
  const embedder = new HashingEmbeddingProvider();
  // No store to name: the fixture is built here, in memory, by the one provider below. These are
  // TIMINGS rather than cosines, so the space governs the shape of the scan and not the numbers'
  // meaning — but a timing on 256-dim hashing vectors is not a timing on 1024-dim semantic ones,
  // which is reason enough for the run to say which it was.
  printSyntheticStoreHeader(`${CONCEPTS} concepts x ${OBS_PER_CONCEPT + 1} observations`);
  // Same gate as the store-reading scripts, in the same place. This one builds its own store, so
  // there is nothing to attribute and nothing to refuse — the call documents that rather than
  // leaving a reader to wonder whether the check was forgotten here.
  requireTrustableSpace(null);
  printProviderIdentity("timings below", embedder);
  const core = new MonetCore(":memory:", {
    embedder, tauAttach: 1.1, tauAmbiguous: 1.1, // dedup off => exact shape
    idGen: () => `c${(seq++).toString().padStart(6, "0")}`,
  });
  try {
    const seedStart = nowMs();
    for (let i = 0; i < CONCEPTS; i++) {
      const concept = await core.store(observationText(i, 0), { circle: CIRCLE });
      for (let j = 1; j <= OBS_PER_CONCEPT; j++) {
        await core.store(observationText(i, j), { circle: CIRCLE, attachTo: concept.conceptId });
      }
    }
    const seedSeconds = (nowMs() - seedStart) / 1000;

    const db = (core as unknown as { db: StoragePort }).db;
    const count = (table: string): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE circle = ?`).get(CIRCLE) as { n: number }).n;

    for (const query of QUERIES) await core.search(query, { circle: CIRCLE, limit: 10 }); // warm caches

    const searchTimes: number[] = [];
    for (let round = 0; round < SEARCH_ROUNDS; round++) {
      for (const query of QUERIES) {
        const t = nowMs();
        await core.search(query, { circle: CIRCLE, limit: 10 });
        searchTimes.push(nowMs() - t);
      }
    }

    // AUTO-RESOLUTION WRITES against a store of this size. Each one runs BOTH store-time scans (the
    // centroid scan for `related` edges, the observation scan for nomination) plus the write itself.
    const sizeAtStoreTiming = `${count("concepts")} concepts / ${count("observations")} observations`;
    const storeTimes: number[] = [];
    for (let i = 0; i < STORE_WRITES; i++) {
      const text = observationText(CONCEPTS + i, (i * 3) % 10);
      const t = nowMs();
      await core.store(text, { circle: CIRCLE });
      storeTimes.push(nowMs() - t);
    }

    console.log(`store:  ${sizeAtStoreTiming}  (seeded in ${seedSeconds.toFixed(1)}s)`);
    console.log(`search  ${summarize(searchTimes)}`);
    console.log(`store() ${summarize(storeTimes)}   <- auto resolution: centroid scan + nomination scan + write`);
    const cards = await core.search(QUERIES[0], { circle: CIRCLE, limit: 10 });
    console.log(`sanity: "${QUERIES[0]}" -> ${cards.length} cards, top score ${cards[0]?.score.toFixed(4) ?? "n/a"}`);
  } finally {
    core.close();
  }
}

void main();
