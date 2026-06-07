/**
 * #245 connection-graph derivation tests: the entity extractor and the edges store() lays
 * down (about / related / co_occurred / asserted). The load-bearing guarantee is that
 * co_occurred is SESSION-scoped — it connects facts worked on together and never bridges a
 * session boundary. That selectivity is what makes gather's restoration lift legitimate.
 */
import { describe, it, expect } from "vitest";
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
