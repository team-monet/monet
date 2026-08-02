/**
 * #245 connection-graph derivation tests: the entity extractor and the edges store() lays
 * down (about / related / co_occurred / asserted). The load-bearing guarantee is that
 * co_occurred is SESSION-scoped — it connects facts worked on together and never bridges a
 * session boundary. That selectivity is what makes gather's restoration lift legitimate.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore } from "../engine";
import { extractEntities, singularize } from "../extract-entities";
import type { EmbeddingProvider } from "../embedding";

/**
 * Read a concept's stored source_refs straight from the row. These tests are about what lands in
 * concepts.source_refs (merge-on-attach, post-upgrade backfill); gather cards were only ever the
 * window onto it, and they now carry sourceRefsCount rather than the refs themselves.
 */
const storedRefs = (core: MonetCore, conceptId: string): string[] => {
  const row = (core as unknown as { db: { prepare(sql: string): { get(id: string): unknown } } }).db
    .prepare(`SELECT source_refs FROM concepts WHERE id = ?`)
    .get(conceptId) as { source_refs: string | null } | undefined;
  return JSON.parse(row?.source_refs ?? "[]") as string[];
};

describe("extractEntities", () => {
  it("pulls structural entities: identifiers, libs, paths, error codes", () => {
    const keys = (s: string): string[] => extractEntities(s).map((e) => e.key);
    expect(keys("moved session validation into a dedicated AuthService class")).toContain("id:AuthService");
    expect(keys("standardized on the jose library for tokens")).toContain("lib:jose");
    expect(keys("migrations live under apps/api/migrations and run on deploy")).toContain("path:apps/api/migrations");
    expect(keys("the request failed with ECONNREFUSED under load")).toContain("err:ECONNREFUSED");
  });

  it("singularizes nouns and drops stopwords + structural re-emission", () => {
    expect(singularize("migrations")).toBe("migration");
    expect(singularize("policies")).toBe("policy");
    expect(singularize("class")).toBe("class");
    const mig = extractEntities("we ran the migrations and more migration work").map((e) => e.key);
    expect(mig.filter((k) => k === "noun:migration")).toHaveLength(1); // both forms collapse to one
    const auth = extractEntities("the AuthService change").map((e) => e.key);
    expect(auth).toContain("id:AuthService");
    expect(auth).not.toContain("noun:authservice"); // structural span not re-counted as a noun
    expect(auth).not.toContain("noun:the"); // stopword
    expect(auth).not.toContain("noun:change"); // code-chatter stopword
  });

  // Regression: LEXICON is a plain `{}` which inherits Object.prototype. Any text containing
  // the word "constructor" causes LEXICON["constructor"] to return the Object constructor Function
  // (truthy), so add("lib", Function, 2) is called with a non-string surface value, crashing at
  // surface.toLowerCase() — "surface.toLowerCase is not a function". Fix: LEXICON must be a
  // null-prototype object so it has no inherited properties.
  it("does not crash on text containing Object.prototype property names (e.g. 'constructor')", () => {
    // Unit: bare word "constructor" must not throw.
    expect(() => extractEntities("constructor")).not.toThrow();
    // The word must be treated as a plain noun, not a lib hit.
    const keys = extractEntities("constructor").map((e) => e.key);
    expect(keys.some((k) => k.startsWith("lib:"))).toBe(false);
    expect(keys).toContain("noun:constructor");
  });

  // Integration-shaped: exact crashing corpus from the production detach-consolidation failure.
  // Observation text A (being moved to destConceptId) followed by a dest body containing
  // "constructor" — the combination that triggered the real crash.
  it("does not crash on the production detach consolidation corpus (text A + dest body with 'constructor')", () => {
    const textA =
      "aart dashboard polish (June 2026, src/cli/commands/dashboard.ts PAGE only — " +
      "pure client-side, no API/security change, typecheck + 6 dashboard tests green, " +
      "verified live in browser w/ zero console errors): (1) Runs tab — a client-side filter " +
      "box (matches block id + status, incl. 'unapproved'), a live \"N runs\" / \"M / N runs\" " +
      "count, and relative timestamps (\"2h ago\") with the absolute time in the cell title. " +
      "(2) Blocks tab — a new `capabilities` column (browser.* now visibly show the `browser` " +
      "capability, closing the block↔pack loop) plus its own filter (id/type/capability). " +
      "Reusable helpers added to PAGE: ago(iso), filterBar(kind,placeholder), applyFilter(kind), " +
      "wireFilter(kind), with state in `filters={runs,blocks}` and `NOUN` map. Filter design " +
      "hides rows by a lowercased data-k attribute WITHOUT re-fetching, so it survives the 5s " +
      "auto-refresh; wireFilter restores the typed text + re-applies after each full re-render; " +
      "the auto-refresh interval skips when a `filter-*` input is focused (so typing isn't " +
      "interrupted). Verified: typing 'failed' → 1/4 runs; 'browser' → 10/23 blocks " +
      "(23 = 21 native + user-registered echo/upper); filter persists across a forced render().";
    // Destination body that contains "constructor" — the word found in real consolidated concept bodies.
    const destBody =
      "127.0.0.1 setup: esc() escapes &<>\", NaNms latency, 5s poll, N runs · X completed · " +
      "Y failed · Z running, 129 passed, constructor function wired in init.";
    const combined = [destBody, textA].join("\n");
    expect(() => extractEntities(combined)).not.toThrow();
    // No lib entity should be derived from prototype-inherited keys.
    const entities = extractEntities(combined);
    const libKeys = entities.filter((e) => e.kind === "lib").map((e) => e.surface);
    // "constructor" must not appear as a lib surface (it would be the Object constructor Function).
    expect(libKeys.every((s) => typeof s === "string")).toBe(true);
  });
});

/** Distinct concepts per store (dedup off), matching how the eval exercises the graph. */
function freshCore(): MonetCore {
  return new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
}

/** Seed unrelated filler in their own sessions so the corpus is realistically large (the
 *  entity hub gate is a per-scope FRACTION — a 2-concept store would gate everything). */
async function seedFiller(core: MonetCore, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await core.store(`Filler topic Kappa${i} concerns widget${i} only.`);
    core.endSessionForEval();
  }
}

describe("store-time edge derivation", () => {
  it("links two concepts that share a rare entity, in the same session, with about + co_occurred", async () => {
    const core = freshCore();
    await seedFiller(core, 25);
    const a = await core.store("The AuthService validates every request.");
    const b = await core.store("We split AuthService into smaller modules."); // same (still-open) session
    const about = core.edges({ type: "about" });
    const co = core.edges({ type: "co_occurred" });
    // shared id:AuthService ⇒ an undirected about edge (both directions stored)
    expect(about.some((e) => e.srcId === a.conceptId && e.dstId === b.conceptId)).toBe(true);
    expect(about.some((e) => e.srcId === b.conceptId && e.dstId === a.conceptId)).toBe(true);
    // same session ⇒ co_occurred
    expect(co.some((e) => e.srcId === a.conceptId && e.dstId === b.conceptId)).toBe(true);
    core.close();
  });

  it("co_occurred is session-scoped: a cross-session pair gets about but NOT co_occurred", async () => {
    const core = freshCore();
    await seedFiller(core, 25);
    const a = await core.store("The AuthService validates every request.");
    core.endSessionForEval();
    const b = await core.store("We split AuthService into smaller modules.");
    // durable about edge spans sessions...
    expect(core.edges({ type: "about" }).some((e) => e.srcId === a.conceptId && e.dstId === b.conceptId)).toBe(true);
    // ...but they were never worked on together, so NO co_occurred edge exists at all.
    expect(core.edges({ type: "co_occurred" })).toHaveLength(0);
    core.close();
  });

  it("does not link concepts via a hub term (high document frequency)", async () => {
    const core = freshCore();
    // Every concept shares only the common term "pipeline" + a unique rare id ⇒ df(noun:pipeline)
    // saturates the hub gate, and the unique ids are not shared ⇒ no about edges form.
    for (let i = 0; i < 8; i++) await core.store(`Component Zeta${i} feeds the pipeline.`);
    expect(core.edges({ type: "about" })).toHaveLength(0);
    core.close();
  });

  it("creates an agent-asserted typed edge from `resolves: #slug`", async () => {
    const core = freshCore();
    const plan = await core.store("Auth refactor plan and scope.");
    const slug = (await core.getConcept(plan.conceptId))!.slug;
    const done = await core.store(`Shipped the work. resolves: #${slug}`);
    const resolves = core.edges({ type: "resolves" });
    expect(resolves.some((e) => e.srcId === done.conceptId && e.dstId === plan.conceptId)).toBe(true);
    core.close();
  });

  it("derives no edges when the graph is disabled", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, graphEnabled: false });
    await core.store("The AuthService validates every request.");
    await core.store("We split AuthService into smaller modules.");
    expect(core.edges()).toHaveLength(0);
    core.close();
  });
});

/** Regression tests for the Codex review on PR #1 (graph edge derivation + overview). */
describe("codex-review fixes", () => {
  it("temporal edges never bridge circles within one session (P1)", async () => {
    const core = freshCore();
    // One session writes to circle A, then to circle B twice. co_occurred/follows must stay inside a circle.
    const a = await core.store("Circle A: the AuthService validates requests.", { circle: "A" });
    const b = await core.store("Circle B: the BillingService charges cards.", { circle: "B" });
    const c = await core.store("Circle B: invoices reconcile nightly.", { circle: "B" });
    // within B, the two B concepts co-occur and chain follows b→c...
    expect(core.edges({ type: "co_occurred", circle: "B" }).some((e) => e.srcId === b.conceptId && e.dstId === c.conceptId)).toBe(true);
    expect(core.edges({ type: "follows", circle: "B" }).some((e) => e.srcId === b.conceptId && e.dstId === c.conceptId)).toBe(true);
    // ...but the circle-A concept is touched by NO edge in any circle (the pre-fix bug linked it to B).
    expect(core.edges().some((e) => e.srcId === a.conceptId || e.dstId === a.conceptId)).toBe(false);
    core.close();
  });

  it("a shared rare structural anchor links two concepts even in a tiny circle (P2)", async () => {
    const core = freshCore();
    // Fresh circle, only two concepts, sharing ONE sourceRef — no filler. Pre-fix the df/n hub gate
    // (2/2 > 0.1) skipped this before the strongAlone path could fire, so no about edge formed.
    const a = await core.store("Decided to run the DB in WAL mode.", { sourceRefs: ["src/engine.ts"] });
    core.endSessionForEval();
    const b = await core.store("Set busy_timeout to avoid SQLITE_BUSY.", { sourceRefs: ["src/engine.ts"] });
    expect(core.edges({ type: "about" }).some((e) => e.srcId === a.conceptId && e.dstId === b.conceptId)).toBe(true);
    core.close();
  });

  it("overview ranks an incoming-only causal hub (a plan everything resolves) (P2)", async () => {
    const core = freshCore();
    const plan = await core.store("Plan: refactor the auth layer end to end.");
    const slug = (await core.getConcept(plan.conceptId))!.slug;
    core.endSessionForEval(); // each shipper in its OWN session ⇒ no co_occurred to the plan
    for (const step of ["one", "two", "three"]) {
      await core.store(`Shipped step ${step}. resolves: #${slug}`);
      core.endSessionForEval();
    }
    // The plan's only thread edges are 3 INCOMING resolves (0 outgoing) — pre-fix it was omitted entirely.
    expect(core.edges({ type: "resolves" }).filter((e) => e.dstId === plan.conceptId)).toHaveLength(3);
    const planRow = core.topConnectedConcepts().find((c) => c.id === plan.conceptId);
    expect(planRow, "incoming-only hub must appear in connected diagnostics").toBeTruthy();
    expect(planRow!.degree).toBe(3);
    core.close();
  });

  it("merges concept source_refs across attaching evidence instead of overwriting (P2)", async () => {
    const core = new MonetCore(":memory:"); // dedup ON ⇒ identical evidence attaches to one concept
    const first = await core.store("Auth uses JSON web tokens for sessions.", { sourceRefs: ["docs/auth.md"] });
    await core.store("Auth uses JSON web tokens for sessions.", { sourceRefs: ["src/auth.ts"] }); // attaches; new ref
    const card = (await core.gather("Auth uses JSON web tokens for sessions.")).ranked.find((c) => c.id === first.conceptId);
    expect(card, "the merged concept should be gathered").toBeTruthy();
    expect([...storedRefs(core, first.conceptId)].sort()).toEqual(["docs/auth.md", "src/auth.ts"]);
    expect(card!.sourceRefsCount).toBe(2);
    core.close();
  });

  it("backfills graph edges when a pre-graph database is reopened with the graph enabled (P2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-backfill-"));
    const dbPath = join(dir, "monet.db");
    try {
      // 1) Simulate an old, pre-graph DB: concepts/observations exist but NO edges were ever derived.
      const old = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1, graphEnabled: false });
      const a = await old.store("The AuthService validates every request."); // shares id:AuthService with b
      const b = await old.store("We split AuthService into smaller modules."); // same session
      expect(old.edges()).toHaveLength(0);
      old.close();
      // 2) Reopen with the graph enabled ⇒ the one-time backfill reconstructs the edges.
      const upgraded = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      expect(upgraded.edges({ type: "about" }).some((e) => e.srcId === a.conceptId && e.dstId === b.conceptId)).toBe(true);
      expect(upgraded.edges({ type: "co_occurred" }).some((e) => e.srcId === a.conceptId && e.dstId === b.conceptId)).toBe(true);
      const edgeCount = upgraded.edges().length;
      upgraded.close();
      // 3) Reopening again must NOT duplicate or re-run (version gate) — edge count is stable.
      const again = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      expect(again.edges().length).toBe(edgeCount);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backfill restores concept source_refs from observations after a graph-disabled ingest (P2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-backfill-refs-"));
    const dbPath = join(dir, "monet.db");
    try {
      // graphEnabled:false skips store()'s concept-level source_refs update, so the refs live only on
      // the observation row — gather() (which reads concepts.source_refs) would lose them post-upgrade.
      const old = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1, graphEnabled: false });
      const a = await old.store("Auth uses JSON web tokens for sessions.", { sourceRefs: ["docs/auth.md", "src/auth.ts"] });
      old.close();
      const upgraded = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      const card = (await upgraded.gather("Auth uses JSON web tokens for sessions.")).ranked.find((c) => c.id === a.conceptId);
      expect(card, "the backfilled concept should be gathered").toBeTruthy();
      expect([...storedRefs(upgraded, a.conceptId)].sort()).toEqual(["docs/auth.md", "src/auth.ts"]);
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rederiveNativeConceptGraph (cold-audit fix, MAJOR — model-swap graph consistency)", () => {
  const pairKey = (x: string, y: string): string => [x, y].sort().join("~");
  const relatedPairs = (core: MonetCore): Set<string> =>
    new Set(core.edges({ type: "related" }).map((e) => pairKey(e.srcId, e.dstId)));

  it("rebuilds related edges from the CURRENT embedding — reembedConcept alone leaves them stale, and the rebuild is deterministic", async () => {
    // Fully controlled 2D vector space, keyed by (text, phase) so the SAME concept's body can
    // legitimately answer differently at "old model" store-time vs "new model" reembedConcept-time
    // — mirrors the migration script's own two-phase flow (embed everything under the old model,
    // migrate, embed everything again under the new one) without needing a real second model.
    let phase: "old" | "new" = "old";
    const vectors: Record<string, Record<"old" | "new", [number, number]>> = {
      "concept A body": { old: [1, 0], new: [1, 0] },
      // B: related to A under the OLD model (cos ≈ 0.71, inside [edgeSimMin, tauAttach)),
      // unrelated under the NEW one (orthogonal, cos = 0).
      "concept B body": { old: [1, 1], new: [0, 1] },
      // C: unrelated to A under the OLD model (opposite, cos = -1), related under the NEW one
      // (cos ≈ 0.6, inside the same band) — proves the rebuild creates fresh edges, not just
      // removes stale ones.
      "concept C body": { old: [-1, 0], new: [0.6, 0.8] },
    };
    const embedder: EmbeddingProvider = {
      dim: 2,
      modelId: "edges-test-controlled",
      embed: (text) => {
        const [x, y] = vectors[text]?.[phase] ?? [1, 0];
        const norm = Math.sqrt(x * x + y * y) || 1;
        return new Float32Array([x / norm, y / norm]);
      },
    };
    const core = new MonetCore(":memory:", { embedder, tauAttach: 0.95, tauAmbiguous: 0.85, edgeSimMin: 0.5, graphEnabled: true });
    try {
      const a = await core.store("concept A body", { resolution: "forceNew" });
      const b = await core.store("concept B body", { resolution: "forceNew" });
      const c = await core.store("concept C body", { resolution: "forceNew" });

      // Sanity: under the OLD model, store()'s own write-time derivation already relates A-B, not A-C.
      const beforeReembed = relatedPairs(core);
      expect(beforeReembed.has(pairKey(a.conceptId, b.conceptId))).toBe(true);
      expect(beforeReembed.has(pairKey(a.conceptId, c.conceptId))).toBe(false);

      // The owned migration rewrites all vectors, then rebuilds the graph only after the full set
      // is in the new space. The low-level helpers are intentionally no longer callable standalone.
      phase = "new";
      await core.migrateEmbeddings({ targetModelId: "edges-test-controlled" });
      const afterRebuild = relatedPairs(core);
      expect(afterRebuild.has(pairKey(a.conceptId, b.conceptId))).toBe(false); // stale edge gone
      expect(afterRebuild.has(pairKey(a.conceptId, c.conceptId))).toBe(true); // fresh edge created

      // Determinism: repeating the complete owned repair reproduces the identical edge set.
      await core.migrateEmbeddings({ targetModelId: "edges-test-controlled" });
      expect(relatedPairs(core)).toEqual(afterRebuild);
    } finally {
      core.close();
    }
  });

  it("replaces the complete 9-concept target graph deterministically with self excluded before six and asymmetric selections unioned", async () => {
    const names = ["anchor", "b-one", "b-two", "b-three", "b-four", "b-five", "b-six", "d-seven", "d-eight"];
    const degrees = [0, 20, 25, 30, 35, 40, 50, 80, 85];
    const vectors = new Map(names.map((name, index) => {
      const radians = degrees[index]! * Math.PI / 180;
      return [name, new Float32Array([Math.cos(radians), Math.sin(radians)])] as const;
    }));
    const embedder: EmbeddingProvider = {
      dim: 2,
      modelId: "edges-nine-controlled",
      embed: (text) => vectors.get(text) ?? vectors.get("anchor")!,
    };
    let id = 0;
    const core = new MonetCore(":memory:", {
      embedder, tauAttach: 1.1, tauAmbiguous: 1.1, edgeSimMin: 0,
      idGen: () => `fixture-${String(++id).padStart(4, "0")}`,
    });
    try {
      const conceptByName = new Map<string, string>();
      for (const name of names) {
        const stored = await core.store(name, { resolution: "forceNew" });
        conceptByName.set(name, stored.conceptId);
      }
      const anchor = conceptByName.get("anchor")!;
      const sixth = conceptByName.get("b-six")!;
      (core as any).upsertEdgeBoth(anchor, conceptByName.get("b-one")!, "possible_duplicate_of", .8, "fixture", "default");
      core.dismissPossibleDuplicate(anchor, conceptByName.get("b-one")!, "graph-fixture");
      const db = (core as any).db;
      const preserved = () => JSON.stringify({
        edges: db.prepare(`SELECT * FROM memory_edge WHERE type != 'related' ORDER BY id`).all(),
        components: db.prepare(`SELECT * FROM memory_edge_components WHERE type != 'related' ORDER BY src_id,dst_id,type,scope,writer_id`).all(),
        entities: db.prepare(`SELECT * FROM entities ORDER BY key,scope`).all(),
        memberships: db.prepare(`SELECT * FROM concept_entities ORDER BY concept_id,entity_key,scope`).all(),
      });
      const nonRelatedBefore = preserved();

      const ids = names.map((name) => conceptByName.get(name)!);
      const vectorById = new Map(names.map((name) => [conceptByName.get(name)!, vectors.get(name)!]));
      const directed = new Map<string, Set<string>>();
      for (const src of ids) {
        const a = vectorById.get(src)!;
        const selected = ids.filter((dst) => dst !== src).map((dst) => {
          const b = vectorById.get(dst)!;
          return { dst, score: a[0]! * b[0]! + a[1]! * b[1]! };
        }).sort((x, y) => y.score - x.score || x.dst.localeCompare(y.dst)).slice(0, 6);
        directed.set(src, new Set(selected.map(({ dst }) => dst)));
      }
      expect(directed.get(anchor)!.has(sixth)).toBe(true); // exactly sixth after self is removed
      expect(directed.get(sixth)!.has(anchor)).toBe(false); // union must retain this asymmetric pick
      const expectedPairs = new Set<string>();
      for (const [src, destinations] of directed) {
        for (const dst of destinations) expectedPairs.add(pairKey(src, dst));
      }

      await core.migrateEmbeddings({ targetModelId: embedder.modelId! });
      expect(relatedPairs(core)).toEqual(expectedPairs);
      expect(relatedPairs(core).has(pairKey(anchor, sixth))).toBe(true);
      expect(preserved()).toBe(nonRelatedBefore);
      await core.migrateEmbeddings({ targetModelId: embedder.modelId! });
      expect(relatedPairs(core)).toEqual(expectedPairs);
      expect(preserved()).toBe(nonRelatedBefore);
    } finally {
      core.close();
    }
  });

  it("is a no-op for a retired or nonexistent concept, never leaving one mid-unwound", async () => {
    const core = new MonetCore(":memory:");
    try {
      const stored = await core.store("some native concept to retire", { resolution: "forceNew" });
      core.retireConcept(stored.conceptId);
      expect(() => core.rederiveNativeConceptGraph(stored.conceptId)).toThrow(/requires active embedder migration ownership/);
      expect(() => core.rederiveNativeConceptGraph("does-not-exist")).toThrow(/requires active embedder migration ownership/);
    } finally {
      core.close();
    }
  });
});
