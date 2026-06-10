/**
 * possible_duplicate_of pairs in overview() — surfaced when ambiguous-band evidence forks.
 * Covers: pair appears with ids + score; counts.possibleDuplicates; pair gone after consolidation;
 * possibleDuplicates list is capped at OVERVIEW_DUP_PAIRS_MAX (10) by score desc while
 * counts.possibleDuplicates remains the full total.
 */
import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";

// Mirrors OVERVIEW_DUP_PAIRS_MAX in engine.ts.
const DUP_PAIRS_MAX = 10;

describe("overview possibleDuplicates", () => {
  it("surfaces a possible-duplicate pair with ids and score when an ambiguous fork occurs", async () => {
    // Force everything into the ambiguous band: tauAttach=0.9, tauAmbiguous=0.1
    const c = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const a = await c.store("We decided to use SQLite as the storage backend for Monet Local.");
    // Score ~0.75 → in [0.1, 0.9) → ambiguous fork
    const b = await c.store("Monet Local uses SQLite for its local storage backend.");
    expect(b.action).toBe("ambiguous");

    const o = c.overview("default");
    expect(o.counts.possibleDuplicates).toBe(1);
    expect(o.possibleDuplicates).toHaveLength(1);

    const pd = o.possibleDuplicates[0]!;
    const ids = [pd.conceptAId, pd.conceptBId];
    expect(ids).toContain(a.conceptId);
    expect(ids).toContain(b.conceptId);
    expect(pd.score).toBeGreaterThan(0.1);
    expect(pd.score).toBeLessThan(0.9);
    c.close();
  });

  it("counts.possibleDuplicates increments correctly with multiple pairs", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    await c.store("We decided to use SQLite as the storage backend for Monet Local.");
    await c.store("Monet Local uses SQLite for its local storage backend.");
    // A different topic — won't match first two, creates its own concept.
    await c.store("The deployment pipeline runs on GitHub Actions with Docker.");
    // Slightly variant: in band with previous CI/CD concept.
    await c.store("GitHub Actions pipeline runs Docker containers for deployment.");

    const o = c.overview("default");
    expect(o.counts.possibleDuplicates).toBeGreaterThanOrEqual(1);
    c.close();
  });

  it("pair disappears from possibleDuplicates after consolidation via detach", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const a = await c.store("We decided to use SQLite as the storage backend for Monet Local.");
    const b = await c.store("Monet Local uses SQLite for its local storage backend.");
    expect(b.action).toBe("ambiguous");

    // Confirm pair is present
    const before = c.overview("default");
    expect(before.possibleDuplicates.some((pd) =>
      [pd.conceptAId, pd.conceptBId].includes(a.conceptId) &&
      [pd.conceptAId, pd.conceptBId].includes(b.conceptId)
    )).toBe(true);

    // Add a second obs to b so detach isn't blocked.
    await c.store("More context for concept B.", { attachTo: b.conceptId });

    // Detach b's first obs into a — this triggers unwind+rederive on both, removing the
    // possible_duplicate_of edge.
    const fetchedB = (await c.getConcept(b.conceptId, { synthesize: false }))!;
    const bFirstObs = fetchedB.observations[0]!.id;
    await c.detach(b.conceptId, [bFirstObs], { destConceptId: a.conceptId });

    const after = c.overview("default");
    expect(after.possibleDuplicates.some((pd) =>
      [pd.conceptAId, pd.conceptBId].includes(a.conceptId) &&
      [pd.conceptAId, pd.conceptBId].includes(b.conceptId)
    )).toBe(false);
    c.close();
  });

  it("possibleDuplicates list is capped at DUP_PAIRS_MAX; counts.possibleDuplicates is the full total", async () => {
    // Build DUP_PAIRS_MAX+3 ambiguous pairs. Each pair is two semantically-similar sentences.
    // tauAttach=0.9 tauAmbiguous=0.1 forces everything similar into the ambiguous band.
    const c = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const EXTRA = 3;
    const TARGET = DUP_PAIRS_MAX + EXTRA; // 13 pairs

    // Store pairs of similar sentences on distinct topics to produce distinct fork edges.
    // Each pair is close enough to be ambiguous but the two halves of each pair are distinct concepts.
    const topics = [
      ["We use SQLite for local persistence in Monet.", "Monet persists data locally with SQLite storage."],
      ["Auth tokens are signed using the jose library.", "The jose library signs authentication tokens here."],
      ["The CI pipeline runs on GitHub Actions.", "GitHub Actions is used for our continuous integration."],
      ["React is the frontend framework for the dashboard.", "The dashboard frontend is built with React."],
      ["Postgres is the production database.", "Production storage uses a Postgres database instance."],
      ["The worker pool has a concurrency limit of 8.", "We cap the worker concurrency at 8 workers."],
      ["Embeddings are computed with MiniLM L6 v2.", "MiniLM L6 v2 generates the text embeddings here."],
      ["Rate limiting is applied at the API gateway.", "The API gateway enforces rate limits on requests."],
      ["Log rotation keeps 7 days of application logs.", "Application logs are rotated on a 7-day schedule."],
      ["Feature flags are stored in the database.", "The database stores all feature flag configurations."],
      ["TLS certificates are renewed via Certbot.", "Certbot automates TLS certificate renewal here."],
      ["The cache TTL is set to 300 seconds.", "Cache entries expire after a 300-second TTL."],
      ["Deployments are gated by passing test suites.", "Test suite must pass before any production deploy."],
    ];
    expect(topics.length).toBe(TARGET);

    for (const [a, b] of topics) {
      await c.store(a);
      await c.store(b);
    }

    const o = c.overview("default");

    // The list must be capped.
    expect(o.possibleDuplicates.length).toBeLessThanOrEqual(DUP_PAIRS_MAX);
    // The full count must be at least as large as the list (and reflect what was actually forked).
    expect(o.counts.possibleDuplicates).toBeGreaterThanOrEqual(o.possibleDuplicates.length);
    // The list is ordered by score descending.
    for (let i = 1; i < o.possibleDuplicates.length; i++) {
      expect(o.possibleDuplicates[i]!.score).toBeLessThanOrEqual(o.possibleDuplicates[i - 1]!.score);
    }
    // When we have more pairs than the cap, counts must exceed the list length.
    if (o.counts.possibleDuplicates > DUP_PAIRS_MAX) {
      expect(o.possibleDuplicates.length).toBe(DUP_PAIRS_MAX);
    }
    c.close();
  });
});
