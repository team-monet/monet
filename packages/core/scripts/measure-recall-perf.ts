/**
 * Retrieval latency at scale, for the recall unit split (src/retrieval.ts).
 *
 *   npx tsx scripts/measure-recall-perf.ts            # 250 concepts x 10 observations
 *   CONCEPTS=500 npx tsx scripts/measure-recall-perf.ts
 *
 * WHY THIS LIVES IN THE REPO: the split changed search's cost model. It used to cosine ONE vector
 * per concept (the centroid); it now cosines every live observation vector — roughly 10x the
 * arithmetic on a consolidated store — in exchange for the relevance fix. That trade was accepted
 * against measured numbers, so the measurement has to be repeatable by anyone who touches the
 * scorer, the SQL, or the candidate enumeration. Reporting only; in-memory store, exits 0.
 *
 * Uses the deterministic lexical embedder on purpose: this measures RETRIEVAL, not model
 * inference. Swapping in MiniLM would bury the signal under ~100x of per-query embed time.
 *
 * REFERENCE NUMBERS (this machine, main c24e62e vs the unit split, mean over 40 timed searches):
 *   250 concepts / 2,500 observations   search 3.72ms -> 15.57ms (4.19x)   gather 384ms -> 425ms
 *   500 concepts / 5,000 observations   search 7.47ms -> 33.65ms (4.51x)   gather 1049ms -> 1075ms
 * Both arms are linear in store size and the ratio is stable across the doubling. Gather's own
 * cost is dominated by spreading activation and the evidence-gap stop, NOT by this scorer.
 *
 * WATCH FOR: a search ratio drifting past ~5x, an absolute search time past ~250ms at the sizes
 * above, or a ratio that GROWS with scale (that would mean the json_each batching stopped
 * batching — e.g. a per-concept query creeping back into the arm).
 */
import { MonetCore } from "../src/engine";
import { HashingEmbeddingProvider } from "../src/embedding";
import type { StoragePort } from "../src/storage";

const CIRCLE = "perf";
const CONCEPTS = Number(process.env.CONCEPTS ?? 250);
const OBS_PER_CONCEPT = 9; // + the creating observation => 10 per concept
const SEARCH_ROUNDS = 5;
const GATHER_ROUNDS = 3;

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
  const core = new MonetCore(":memory:", {
    embedder: new HashingEmbeddingProvider(), tauAttach: 1.1, tauAmbiguous: 1.1, // dedup off => exact shape
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
    const gatherTimes: number[] = [];
    for (let round = 0; round < GATHER_ROUNDS; round++) {
      for (const query of QUERIES) {
        const t = nowMs();
        await core.gather(query, { circle: CIRCLE, limit: 12 });
        gatherTimes.push(nowMs() - t);
      }
    }

    console.log(`store:  ${count("concepts")} concepts / ${count("observations")} observations  (seeded in ${seedSeconds.toFixed(1)}s)`);
    console.log(`search  ${summarize(searchTimes)}`);
    console.log(`gather  ${summarize(gatherTimes)}`);
    const cards = await core.search(QUERIES[0], { circle: CIRCLE, limit: 10 });
    console.log(`sanity: "${QUERIES[0]}" -> ${cards.length} cards, top score ${cards[0]?.score.toFixed(4) ?? "n/a"}`);
  } finally {
    core.close();
  }
}

void main();
