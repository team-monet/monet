/**
 * THE RECALL UNIT SPLIT (design call 2026-07-26): observations are the unit of RETRIEVAL;
 * concepts are the unit of DELIVERY.
 *
 * The defect: a concept's `concepts.embedding` is a running-mean centroid (blend(), embedding.ts)
 * over every observation ever attached, so a many-observation concept embeds to a blurred mixture
 * that points at no query in particular. Measured on the live store, cosine against that centroid
 * correlated r = -0.584 with log(body length) on ON-TOPIC queries — the store's richest, most
 * consolidated concepts were its LEAST findable. Length normalization cannot fix it: a centroid
 * does not become pointed by scaling. The fix is the split #54 already made for source files
 * (chunk = retrieval unit, file = unit of truth), applied natively.
 *
 * These tests pin the behavior that split buys, and the sharp edges it deliberately keeps:
 * no centroid fallback, an absolute score floor, and observation-granular scoring in search().
 */
import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";
import { HashingEmbeddingProvider, cosine } from "../embedding";
import { NATIVE_SCORE_FLOOR, scoreNativeConceptsByObservation } from "../retrieval";
import type { StoragePort } from "../storage";

const CIRCLE = "unit-split";

/** Same convention as contradiction.test.ts / circle-lifecycle.test.ts: reach the store directly
 *  to set up states no public API produces (legacy placeholder vectors) or to read raw rows. */
const dbOf = (core: MonetCore): StoragePort => (core as unknown as { db: StoragePort }).db;

/**
 * Set an observation's vector by hand, at the granularity retrieval actually ranks (#155).
 *
 * These tests craft vectors directly to reach states normal writes cannot produce — a zero
 * placeholder, or a vector at an exact cosine from a query. Ranking now reads `observation_segments`
 * rather than `observations.embedding`, so writing only the latter leaves the crafted state
 * invisible to the very scorer under test. Every observation in this suite is short enough to be a
 * single whole-content segment, so the observation vector and its one segment vector are the same
 * value by construction and this writes both.
 */
const setObservationVector = (db: StoragePort, observationId: string, embeddingJson: string): void => {
  db.prepare(`UPDATE observations SET embedding = ? WHERE id = ?`).run(embeddingJson, observationId);
  db.prepare(`UPDATE observation_segments SET embedding = ? WHERE observation_id = ?`).run(embeddingJson, observationId);
};

/** Dedup OFF (thresholds above max cosine) so every store() creates a DISTINCT concept and
 *  `attachTo` is the only way observations pile onto one — the eval harness's own convention
 *  (seedScenario, src/eval/harness.ts). Deterministic ids so ranking ties are reproducible. */
function newCore(embedder = new HashingEmbeddingProvider()): MonetCore {
  let seq = 0;
  return new MonetCore(":memory:", {
    embedder, tauAttach: 1.1, tauAmbiguous: 1.1,
    idGen: () => `c${(seq++).toString().padStart(4, "0")}`,
  });
}

/** The deployment/infra bulk that blurs a concept's centroid away from any one query. */
const INFRA_BULK = [
  "The ingest cluster runs on three nodes behind an haproxy load balancer.",
  "Rolling deploys drain each node for sixty seconds before restart.",
  "Node draining is coordinated by the deploy orchestrator daemon.",
  "The haproxy health check polls /healthz every two seconds.",
  "Deploy artifacts are staged in the artifact bucket before rollout.",
  "Rollback restores the previous artifact generation from the bucket.",
  "The orchestrator daemon writes deploy events to the audit log.",
  "Cluster capacity is planned quarterly against ingest volume forecasts.",
  "Each node reserves headroom for a single-node failure during deploys.",
  "Deploy windows avoid the nightly ingest volume peak.",
];

describe("recall unit split — the r = -0.58 defeat", () => {
  it("ranks a rich concept by its one on-topic observation, above a decoy that beat its blurred centroid", async () => {
    const embedder = new HashingEmbeddingProvider();
    const core = newCore(embedder);
    try {
      // A heavily-consolidated concept: eleven observations about deployment/infra...
      const rich = await core.store("Deployment runbook for the ingest cluster.", { circle: CIRCLE });
      for (const b of INFRA_BULK) await core.store(b, { circle: CIRCLE, attachTo: rich.conceptId });
      // ...and ONE late-added observation on a different topic. This is the memory that answers
      // the query, and the exact kind of evidence consolidation used to bury.
      const late = await core.store(
        "Postgres connection pooling uses pgbouncer in transaction mode.",
        { circle: CIRCLE, attachTo: rich.conceptId },
      );
      // A SHORT, single-observation decoy: a worse answer, but an undiluted vector.
      const decoy = await core.store("Postgres connection limits are tuned per service.", { circle: CIRCLE });

      const query = "pgbouncer transaction mode connection pooling for postgres";
      const emb = embedder.embed(query);
      const db = dbOf(core);
      const centroidOf = (id: string): number => {
        const row = db.prepare(`SELECT embedding FROM concepts WHERE id = ?`).get(id) as { embedding: string };
        const v = Float32Array.from(JSON.parse(row.embedding) as number[]);
        let dot = 0;
        for (let i = 0; i < v.length; i++) dot += emb[i] * v[i];
        return dot;
      };

      // THE PREMISE, asserted rather than assumed: under the retired centroid ranking the decoy
      // WINS — the rich concept's own answer is diluted below a weaker but shorter memory. If a
      // future embedder change makes this premise false, this test must fail loudly rather than
      // pass vacuously on a scenario that no longer demonstrates anything.
      expect(centroidOf(decoy.conceptId)).toBeGreaterThan(centroidOf(rich.conceptId));

      // THE FIX: observation-granular ranking puts the rich concept first, by a wide margin.
      const cards = await core.search(query, { circle: CIRCLE, limit: 5 });
      expect(cards[0].id).toBe(rich.conceptId);
      expect(cards[0].matchedObservationId).toBe(late.observationId);
      expect(cards[0].score).toBeGreaterThan(cards.find((c) => c.id === decoy.conceptId)!.score);
      // And the score is the observation's own cosine, not a rescaled centroid: the concept is
      // now as findable as its single best piece of evidence.
      expect(cards[0].score).toBeGreaterThan(centroidOf(rich.conceptId) * 2);
    } finally {
      core.close();
    }
  });

  it("does not penalise the concept for its OTHER observations — support count grows, findability does not shrink", async () => {
    const embedder = new HashingEmbeddingProvider();
    const query = "pgbouncer transaction mode connection pooling for postgres";
    const claim = "Postgres connection pooling uses pgbouncer in transaction mode.";

    const lean = newCore(embedder);
    const fat = newCore(embedder);
    try {
      const leanConcept = await lean.store(claim, { circle: CIRCLE });
      const fatConcept = await fat.store(claim, { circle: CIRCLE });
      for (const b of INFRA_BULK) await fat.store(b, { circle: CIRCLE, attachTo: fatConcept.conceptId });

      const leanCard = (await lean.search(query, { circle: CIRCLE, limit: 1 }))[0];
      const fatCard = (await fat.search(query, { circle: CIRCLE, limit: 1 }))[0];

      expect(fatCard.supportCount).toBeGreaterThan(leanCard.supportCount);
      // The whole point of the split: identical evidence scores identically no matter how much
      // OTHER evidence sits beside it. Under the centroid this was strictly, steeply worse.
      expect(fatCard.score).toBeCloseTo(leanCard.score, 10);
      // Both rank through the SAME claim, each in its own store.
      expect(leanCard.matchedObservationId).toBe(leanConcept.observationId);
      expect(fatCard.matchedObservationId).toBe(fatConcept.observationId);
    } finally {
      lean.close();
      fat.close();
    }
  });
});

describe("recall unit split — which observations count", () => {
  it("does not retrieve through a superseded observation", async () => {
    const core = newCore();
    try {
      const concept = await core.store("The scheduler retries failed jobs.", { circle: CIRCLE });
      const claim = await core.store(
        "Postgres connection pooling uses pgbouncer in transaction mode.",
        { circle: CIRCLE, attachTo: concept.conceptId },
      );
      const query = "pgbouncer transaction mode connection pooling for postgres";

      const before = (await core.search(query, { circle: CIRCLE, limit: 5 })).find((c) => c.id === concept.conceptId)!;
      expect(before.matchedObservationId).toBe(claim.observationId);

      // Terminal supersession: the evidence is gone (superseded_at set, no successor).
      core.supersedeObservation(claim.observationId, null);

      const after = (await core.search(query, { circle: CIRCLE, limit: 5 })).find((c) => c.id === concept.conceptId);
      // Either the concept drops out entirely, or it ranks through some OTHER live observation —
      // never through the superseded one, and never at its score. History does not retrieve.
      expect(after?.matchedObservationId).not.toBe(claim.observationId);
      if (after) expect(after.score).toBeLessThan(before.score);
    } finally {
      core.close();
    }
  });

  it("excludes a zero-vector observation instead of scoring it as 0", async () => {
    const core = newCore();
    try {
      const concept = await core.store("The scheduler retries failed jobs.", { circle: CIRCLE });
      const claim = await core.store(
        "Postgres connection pooling uses pgbouncer in transaction mode.",
        { circle: CIRCLE, attachTo: concept.conceptId },
      );
      const db = dbOf(core);
      const width = (JSON.parse(
        (db.prepare(`SELECT embedding FROM observations WHERE id = ?`).get(claim.observationId) as { embedding: string }).embedding,
      ) as number[]).length;

      // A placeholder vector, as storeSourceChunk used to write for every chunk — the state
      // isZeroVector exists for. A placeholder is not a measurement.
      setObservationVector(db, claim.observationId, JSON.stringify(new Array<number>(width).fill(0)));

      const query = "pgbouncer transaction mode connection pooling for postgres";
      const card = (await core.search(query, { circle: CIRCLE, limit: 5 })).find((c) => c.id === concept.conceptId);
      expect(card?.matchedObservationId).not.toBe(claim.observationId);

      // And when the zeroed observation is the concept's ONLY one, the concept has no usable
      // vector at all: it leaves the dense arm rather than ranking at cosine 0.
      const solo = newCore();
      try {
        const only = await solo.store("Postgres connection pooling uses pgbouncer in transaction mode.", { circle: CIRCLE });
        setObservationVector(dbOf(solo), only.observationId, JSON.stringify(new Array<number>(width).fill(0)));
        expect(await solo.search(query, { circle: CIRCLE, limit: 5 })).toEqual([]);
      } finally {
        solo.close();
      }
    } finally {
      core.close();
    }
  });

  it("ignores a source-kind observation parked on a native concept (migration-coverage invariant)", async () => {
    const embedder = new HashingEmbeddingProvider();
    const core = newCore(embedder);
    try {
      const concept = await core.store("The scheduler retries failed jobs.", { circle: CIRCLE });
      const db = dbOf(core);
      // The graft path writes an incoming observation's `kind` VERBATIM and afterwards normalizes
      // only its `circle` against the owning native concept — never its kind — so a native concept
      // really can end up holding a kind='source' row. migrateEmbeddings' native-observations
      // phase selects `WHERE kind != 'source'` (enforcedNativeObservationRows), so such a vector is
      // never re-embedded; scoring it would compare across two embedding spaces. The scorer's
      // predicate is aligned with the migration's so that cannot happen.
      const claim = "Postgres connection pooling uses pgbouncer in transaction mode.";
      db.prepare(
        `INSERT INTO observations (id, content, embedding, kind, circle, concept_id, author_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, 'source', ?, ?, 'test', ?, ?)`,
      ).run("obs-grafted-source", claim, JSON.stringify(Array.from(embedder.embed(claim))), CIRCLE, concept.conceptId, Date.now(), Date.now());

      const query = "pgbouncer transaction mode connection pooling for postgres";
      const emb = embedder.embed(query);
      // The grafted row is a near-exact match for this query, so if it were scored it would
      // dominate. It is not a native retrieval unit, so the concept falls back to its OWN
      // (much weaker) native evidence instead — the row is skipped, not merely outranked.
      const sourceRowCosine = cosine(emb, embedder.embed(claim));
      expect(sourceRowCosine).toBeGreaterThan(0.9);
      const match = scoreNativeConceptsByObservation(db, [concept.conceptId], emb, query, false).get(concept.conceptId)!;
      expect(match.observationId).toBe(concept.observationId); // the native one
      expect(match.observationId).not.toBe("obs-grafted-source");
      expect(match.score).toBeLessThan(sourceRowCosine / 2);

      // Same through the public read path, and it does not throw.
      const card = (await core.search(query, { circle: CIRCLE, limit: 5 })).find((c) => c.id === concept.conceptId);
      expect(card?.matchedObservationId).toBe(concept.observationId);
    } finally {
      core.close();
    }
  });




});

describe("recall unit split — concepts are the unit of delivery", () => {
  it("emits exactly ONE card per concept however many of its observations match", async () => {
    const core = newCore();
    try {
      const concept = await core.store("Postgres connection pooling notes.", { circle: CIRCLE });
      // Five separately-attached observations, every one of them a strong match for the query.
      for (const text of [
        "Postgres connection pooling uses pgbouncer in transaction mode.",
        "The pgbouncer pool runs in transaction mode for postgres.",
        "Transaction mode pooling for postgres is handled by pgbouncer.",
        "Connection pooling in postgres goes through pgbouncer transaction mode.",
        "We use pgbouncer transaction mode for postgres connection pooling.",
      ]) await core.store(text, { circle: CIRCLE, attachTo: concept.conceptId });
      await core.store("Feature flags are evaluated at request time.", { circle: CIRCLE });

      const query = "pgbouncer transaction mode connection pooling for postgres";
      const cards = await core.search(query, { circle: CIRCLE, limit: 10 });
      expect(cards.filter((c) => c.id === concept.conceptId)).toHaveLength(1);
      expect(new Set(cards.map((c) => c.id)).size).toBe(cards.length);

      // The MAX is the representative: the card's score is the BEST matching observation's.
      const db = dbOf(core);
      const emb = new HashingEmbeddingProvider().embed(query);
      const best = scoreNativeConceptsByObservation(db, [concept.conceptId], emb, query, false).get(concept.conceptId)!;
      expect(cards[0].score).toBeCloseTo(best.score, 10);
      expect(cards[0].matchedObservationId).toBe(best.observationId);

    } finally {
      core.close();
    }
  });

  it("names the matching observation on the card and never its content", async () => {
    const core = newCore();
    try {
      const concept = await core.store("Deployment runbook for the ingest cluster.", { circle: CIRCLE });
      for (const b of INFRA_BULK) await core.store(b, { circle: CIRCLE, attachTo: concept.conceptId });
      const secret = "Postgres connection pooling uses pgbouncer in transaction mode.";
      const late = await core.store(secret, { circle: CIRCLE, attachTo: concept.conceptId });

      const card = (await core.search("pgbouncer transaction mode connection pooling", { circle: CIRCLE, limit: 1 }))[0];
      expect(card.matchedObservationId).toBe(late.observationId);

      // A card is structural: shape and depth, never the claim (ADR §4.5, #232). Naming WHICH
      // observation matched must not become a channel for WHAT it said.
      const serialized = JSON.stringify(card);
      expect(serialized).not.toContain("pgbouncer");
      expect(serialized).not.toContain(secret);
      for (const value of Object.values(card)) {
        if (typeof value === "string") expect(secret.includes(value) && value.length > 12).toBe(false);
      }
    } finally {
      core.close();
    }
  });
});

describe("recall unit split — the score floor", () => {
  it("returns NO native cards rather than noise when nothing in the store answers the query", async () => {
    const core = newCore();
    try {
      for (const s of [
        "The billing exporter emits CSV on the first of the month.",
        "Weekly retrospective notes are kept in the team wiki.",
        "Feature flags are evaluated at request time, never cached.",
        "The mobile client retries idempotent writes up to three times.",
      ]) await core.store(s, { circle: CIRCLE });

      // Queries with no lexical or semantic purchase on the store at all. Under the old ranking
      // search() sliced the top `limit` rows regardless of score and always answered SOMETHING.
      for (const junk of ["검색 결과가 없습니다 한국어 질의", "запрос о миграции птиц", "9182 4471 6630 2205"]) {
        expect(await core.search(junk, { circle: CIRCLE, limit: 5 })).toEqual([]);
      }

      // Silence is scoped to the query, not to the store: a real question still answers.
      const real = await core.search("billing exporter CSV monthly", { circle: CIRCLE, limit: 5 });
      expect(real.length).toBeGreaterThan(0);
      expect(real[0].score).toBeGreaterThan(NATIVE_SCORE_FLOOR);
    } finally {
      core.close();
    }
  });

  it("never emits a native card below the floor, on any query", async () => {
    const core = newCore();
    try {
      for (const s of [
        "The billing exporter emits CSV on the first of the month.",
        "Weekly retrospective notes are kept in the team wiki.",
        "Feature flags are evaluated at request time, never cached.",
        "The mobile client retries idempotent writes up to three times.",
      ]) await core.store(s, { circle: CIRCLE });

      for (const q of [
        "billing exporter CSV monthly", "feature flag evaluation caching", "retro notes wiki",
        "sourdough hydration ratio for rye starter", "migratory patterns of arctic terns",
      ]) {
        for (const card of await core.search(q, { circle: CIRCLE, limit: 10 })) {
          expect(card.score).toBeGreaterThanOrEqual(NATIVE_SCORE_FLOOR);
        }
      }
    } finally {
      core.close();
    }
  });




});

describe("recall unit split — scorer integration", () => {
  it("search() consumes the native observation scorer", async () => {
    const embedder = new HashingEmbeddingProvider();
    const core = newCore(embedder);
    try {
      const rich = await core.store("Deployment runbook for the ingest cluster.", { circle: CIRCLE });
      for (const b of INFRA_BULK) await core.store(b, { circle: CIRCLE, attachTo: rich.conceptId });
      await core.store("Postgres connection pooling uses pgbouncer in transaction mode.", { circle: CIRCLE, attachTo: rich.conceptId });
      for (const s of [
        "Postgres connection limits are tuned per service.",
        "Feature flags are evaluated at request time, never cached.",
        "The billing exporter emits CSV on the first of the month.",
      ]) await core.store(s, { circle: CIRCLE });

      const query = "pgbouncer transaction mode connection pooling for postgres";
      const db = dbOf(core);
      const allIds = (db.prepare(`SELECT id FROM concepts WHERE circle = ?`).all(CIRCLE) as Array<{ id: string }>).map((r) => r.id);
      const expected = scoreNativeConceptsByObservation(db, allIds, embedder.embed(query), query, false);

      // search(): score AND matched observation come straight from the shared scorer, and its
      // card set is exactly the scorer's above-floor subset — the floor lives HERE, at emission,
      // not inside the scorer, which stays pure measurement.
      const searchCards = await core.search(query, { circle: CIRCLE, limit: 10 });
      const aboveFloor = [...expected.entries()].filter(([, m]) => m.score >= NATIVE_SCORE_FLOOR);
      expect(searchCards.map((c) => c.id).sort()).toEqual(aboveFloor.map(([id]) => id).sort());
      for (const card of searchCards) {
        const match = expected.get(card.id)!;
        expect(card.score).toBeCloseTo(match.score, 10);
        expect(card.matchedObservationId).toBe(match.observationId);
      }

    } finally {
      core.close();
    }
  });

  it("is deterministic across repeated calls", async () => {
    const core = newCore();
    try {
      const concept = await core.store("Postgres connection pooling notes.", { circle: CIRCLE });
      for (const text of [
        "Postgres connection pooling uses pgbouncer in transaction mode.",
        "The pgbouncer pool runs in transaction mode for postgres.",
      ]) await core.store(text, { circle: CIRCLE, attachTo: concept.conceptId });
      const query = "pgbouncer transaction mode connection pooling for postgres";
      expect(await core.search(query, { circle: CIRCLE, limit: 5 })).toEqual(await core.search(query, { circle: CIRCLE, limit: 5 }));
    } finally {
      core.close();
    }
  });
});
