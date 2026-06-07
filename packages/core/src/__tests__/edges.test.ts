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
    const planRow = core.overview().graph.connected.find((c) => c.id === plan.conceptId);
    expect(planRow, "incoming-only hub must appear in the connected overview").toBeTruthy();
    expect(planRow!.degree).toBe(3);
    core.close();
  });

  it("merges concept source_refs across attaching evidence instead of overwriting (P2)", async () => {
    const core = new MonetCore(":memory:"); // dedup ON ⇒ identical evidence attaches to one concept
    const first = await core.store("Auth uses JSON web tokens for sessions.", { sourceRefs: ["docs/auth.md"] });
    await core.store("Auth uses JSON web tokens for sessions.", { sourceRefs: ["src/auth.ts"] }); // attaches; new ref
    const card = (await core.gather("Auth uses JSON web tokens for sessions.")).ranked.find((c) => c.id === first.conceptId);
    expect(card, "the merged concept should be gathered").toBeTruthy();
    expect([...(card!.sourceRefs ?? [])].sort()).toEqual(["docs/auth.md", "src/auth.ts"]);
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
      expect([...(card?.sourceRefs ?? [])].sort()).toEqual(["docs/auth.md", "src/auth.ts"]);
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
