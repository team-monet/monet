/**
 * md-baseline eval regression gate — Phase 0 (spec §2.6). Fast tier: deterministic hashing
 * embedder, no network, no model download — mirrors eval.test.ts's shape-not-numbers
 * philosophy for the three additional arms (bm25, chunk-cosine-rag, md-tree) plus their combination
 * into runBaselineSuite(). The real (MiniLM) numbers come from `pnpm eval:baseline`; this test
 * guards invariants, not exact percentages — same division of labor as eval.test.ts/pnpm eval.
 *
 * Does NOT touch eval.test.ts or its lockstep assertion (mistake:6, reexplain:8, restoration:6)
 * — that file and its regression gate are untouched by this addition, per the mission's
 * explicit constraint.
 */
import { describe, it, expect } from "vitest";
import { HashingEmbeddingProvider } from "../embedding";
import { MonetCore } from "../engine";
import { STARTER_SUITE } from "../eval/scenarios";
import { DEFAULT_ARMS } from "../eval/strategies";
import { runSuite, K_LADDER, seedScenario } from "../eval/harness";
import { runBaselineSuite, MD_BASELINE_CONCEPT_ARMS } from "../eval/harness-baseline";
import { exportMdTree } from "../eval/md-export";

const embedder = (): HashingEmbeddingProvider => new HashingEmbeddingProvider();

describe("md-baseline eval — shape/crash guarantees (deterministic lexical embedder)", () => {
  it("does not mutate DEFAULT_ARMS or pnpm eval's 2-arm shape", async () => {
    // Defense-in-depth: MD_BASELINE_CONCEPT_ARMS must be DEFAULT_ARMS plus exactly bm25 appended
    // — never a different arm set for the two existing engine arms (asserted structurally, not just
    // by inspection).
    expect(DEFAULT_ARMS).toHaveLength(2);
    expect(MD_BASELINE_CONCEPT_ARMS.map((a) => a.name)).toEqual([...DEFAULT_ARMS.map((a) => a.name), "bm25"]);

    const plainReport = await runSuite(STARTER_SUITE, DEFAULT_ARMS, embedder());
    expect(plainReport.arms.map((a) => a.arm)).toEqual(["no-memory", "monet-search"]);
  });

  // Explicit ceilings preserve CI headroom for deterministic full-suite baseline work.
  it("bm25 runs without crashing and produces non-degenerate output", async () => {
    const report = await runBaselineSuite(STARTER_SUITE, embedder());
    const bm25 = report.arms.find((a) => a.arm === "bm25");
    expect(bm25?.available).toBe(true);
    expect(bm25?.metrics?.counts).toEqual({ mistake: 6, reexplain: 8, restoration: 6 });
    // Non-degenerate: bm25 beats the no-memory baseline (it must find SOMETHING via lexical
    // overlap on a suite deliberately containing lexically-strong probes, per scenarios.ts).
    const noMemory = report.arms.find((a) => a.arm === "no-memory")!.metrics!;
    expect(bm25!.metrics!.byK[5].repeatedMistakeRate).toBeLessThan(noMemory.byK[5].repeatedMistakeRate);
  }, 10_000);

  it("chunk-cosine-rag and md-tree run without crashing and produce non-degenerate output", async () => {
    const report = await runBaselineSuite(STARTER_SUITE, embedder());
    // "md-tree (topic-files-only)" per the A3 fix: index.md is deliberately excluded from this
    // arm's retrieval surface (documented design decision, not a bug — see strategies-baseline.ts).
    expect(report.chunkArms.map((a) => a.arm)).toEqual(["chunk-cosine-rag", "md-tree (topic-files-only)"]);

    for (const arm of report.chunkArms) {
      expect(arm.available).toBe(true);
      // Same lockstep probe-count tripwire eval.test.ts enforces at concept granularity —
      // the chunk-granularity pass must cover the identical probe population.
      expect(arm.metrics!.counts).toEqual({ mistake: 6, reexplain: 8, restoration: 6 });
      // Non-degenerate: at least SOME probe finds its gold chunk within RANK_DEPTH — an arm
      // that retrieves nothing (a wiring bug, e.g. an empty chunk index) would score exactly 0
      // everywhere, indistinguishable from "ran but is broken."
      expect(arm.metrics!.mrr.overall).toBeGreaterThan(0);
      for (const k of K_LADDER) expect(arm.goldContainingFileByK[k]).toBeGreaterThanOrEqual(0);
    }
  }, 10_000);

  it("granularity-mismatch honesty: gold-containing-file@k is never below strict chunk-recall at the same k (spec §2.2)", async () => {
    // The file-level number is a STRICT LOOSENING of the chunk-level number (any top-k chunk
    // hit implies its containing file is a top-k-files hit, by construction) — if this ever
    // inverts, the file/chunk id mapping in harness-baseline.ts has a real bug, not just a
    // reporting quirk. Guards spec §2.2's "report both, always" requirement structurally.
    const report = await runBaselineSuite(STARTER_SUITE, embedder());
    for (const arm of report.chunkArms) {
      const overallChunkRecallAtK = (k: number): number =>
        arm.probes.length === 0 ? 0 : arm.probes.reduce((acc, p) => acc + p.recallByK[k], 0) / arm.probes.length;
      for (const k of K_LADDER) {
        expect(arm.goldContainingFileByK[k]).toBeGreaterThanOrEqual(overallChunkRecallAtK(k) - 1e-9);
      }
    }
  }, 10_000);

  it("the md-tree export's gold manifest carries every scenario's seed keys mechanically, across the WHOLE suite (spec §2.2)", async () => {
    // Direct check on the exporter contract itself, independent of the arm-scoring layer above:
    // exportMdTree's own unmappedGoldKeys self-integrity signal (mirrors harness.ts's
    // auditScenarios philosophy) must be empty for every scenario in the suite — not just one
    // representative case. A non-empty list means some concept's chunk could not be
    // mechanically identified, so no chunk could be mechanically mapped back to it — a real
    // defect. collidedSlugs must ALSO be empty for the real corpus today (§F1 below covers the
    // constructed-collision case; this asserts the current 20-scenario suite has none).
    for (const scenario of STARTER_SUITE) {
      const { core, map } = await seedScenario(scenario, embedder());
      try {
        const result = exportMdTree(core, { circle: "default", keyMap: map, scenario });
        expect(result.unmappedGoldKeys, `scenario '${scenario.id}' has unmapped gold keys`).toEqual([]);
        expect(result.collidedSlugs, `scenario '${scenario.id}' has slug collisions`).toEqual([]);
      } finally {
        core.close();
      }
    }
  });

  it("no duplicate chunkIds or relPaths across ANY scenario in the whole suite (F1 whole-suite guard)", async () => {
    // Structural, corpus-wide check independent of whether a collision happens to exist today:
    // even without a slug collision, this guards the more basic invariant that chunkId/relPath
    // are genuinely unique WITHIN each scenario's own export — the property the F1 fix restores
    // by construction (chunkId is always derived from the now-unique relPath). A regression
    // here (e.g. someone reintroducing clusterSlug-only chunkIds) fails immediately, suite-wide,
    // rather than only on a specifically constructed adversarial case.
    for (const scenario of STARTER_SUITE) {
      const { core, map } = await seedScenario(scenario, embedder());
      try {
        const result = exportMdTree(core, { circle: "default", keyMap: map, scenario });
        const chunkIds = result.chunks.map((c) => c.chunkId);
        expect(new Set(chunkIds).size, `scenario '${scenario.id}' has duplicate chunkIds`).toBe(chunkIds.length);
        const relPaths = [...result.topicFiles.keys()];
        expect(new Set(relPaths).size, `scenario '${scenario.id}' has duplicate relPaths`).toBe(relPaths.length);
        // Every chunk's `file` must point at a relPath that actually exists in topicFiles — no
        // chunk silently orphaned by a relPath that got overwritten (the exact F1 failure mode).
        for (const c of result.chunks) {
          expect(result.topicFiles.has(c.file), `chunk '${c.chunkId}' points at missing file '${c.file}'`).toBe(true);
        }
      } finally {
        core.close();
      }
    }
  });

  it("F1/F2 regression: a constructed cross-cluster slug collision is disambiguated, not silently dropped (empirically-constructed cold-audit finding)", async () => {
    // Two concepts, each its OWN singleton cluster (separate sessions ⇒ no co_occurred edge,
    // same pattern scenarios.ts's single-fact scenarios use), whose titles share an identical
    // first-48-slugified-chars prefix — verified by direct slugify() computation before writing
    // this test (see the exact construction below), NOT assumed. Before the fix this collision
    // would: silently overwrite the first cluster's topics/<slug>.md entry, emit two chunks
    // sharing one chunkId (corrupting the BM25 index — a later tf.set(id) drops the earlier
    // chunk's text), and overwrite chunkIdToConceptKey so one concept's gold became unmappable.
    const titleA =
      "Gotcha: the shared prefix collision test concept number one has this exact common beginning phrase but then diverges into unique content afterward.";
    const titleB =
      "Gotcha: the shared prefix collision test concept number two has this exact common beginning phrase but then diverges into other content afterward.";

    // Mirrors seedScenario()'s own core construction exactly (harness.ts:91): dedup OFF via
    // thresholds above max cosine, deterministic ids so the test is fully reproducible.
    let seq = 0;
    const idGen = (): string => `c${(seq++).toString().padStart(6, "0")}`;
    const core = new MonetCore(":memory:", { embedder: embedder(), tauAttach: 1.1, tauAmbiguous: 1.1, idGen });
    try {
      const rA = await core.store(titleA, { circle: "default", kind: "issue" });
      core.endSessionForEval(); // own session ⇒ no co_occurred edge to B ⇒ two singleton clusters
      const rB = await core.store(titleB, { circle: "default", kind: "issue" });
      core.endSessionForEval();

      const keyMap = new Map([
        ["concept-a", rA.conceptId],
        ["concept-b", rB.conceptId],
      ]);
      const scenario = {
        id: "constructed-slug-collision",
        title: "constructed collision fixture",
        rationale: "F1/F2 regression fixture — not part of STARTER_SUITE",
        seed: [
          { key: "concept-a", content: titleA, kind: "issue" },
          { key: "concept-b", content: titleB, kind: "issue" },
        ],
        probes: [],
      };
      const result = exportMdTree(core, { circle: "default", keyMap, scenario });

      // The collision actually happened (confirms the fixture is real, not vacuously passing).
      expect(result.collidedSlugs.length).toBeGreaterThan(0);

      // No dropped topic file: both clusters' content survives as two DISTINCT topicFiles
      // entries, not one overwriting the other.
      expect(result.topicFiles.size).toBe(2);
      const bodies = [...result.topicFiles.values()];
      expect(bodies.some((b) => b.includes("concept number one"))).toBe(true);
      expect(bodies.some((b) => b.includes("concept number two"))).toBe(true);

      // No duplicate chunkIds.
      const chunkIds = result.chunks.map((c) => c.chunkId);
      expect(new Set(chunkIds).size).toBe(chunkIds.length);
      expect(chunkIds.length).toBe(2); // one chunk per concept, both header-split

      // The manifest maps BOTH concepts correctly — neither key silently lost to the other.
      const mappedKeys = Object.values(result.manifest.chunkIdToConceptKey);
      expect(mappedKeys.sort()).toEqual(["concept-a", "concept-b"]);
      expect(result.unmappedGoldKeys).toEqual([]);
    } finally {
      core.close();
    }
  });

  it("A4 regression (i): a member whose body contains its own internal ## heading is correctly mapped, not null, not mis-split (Codex finding #6)", async () => {
    // Before the A4 fix: an internal `## ` line inside a concept's body inflated the
    // header-split section count past members.length, failing the old count-equality gate and
    // dumping the WHOLE cluster into the paragraph fallback with conceptId=null — an honest
    // miss, but a total one for what's really only one member's content being irregular.
    // Verified this reproduces against the pre-A4-fix code before writing this test (see the
    // PR's fix-round notes) — unmappedGoldKeys came back non-empty for this exact fixture.
    const bodyWithInternalHeading =
      "Never run the deploy script twice in one session.\n\n## Root cause\n\nA race condition in the lock file causes duplicate deploys when run concurrently.";

    let seq = 0;
    const idGen = (): string => `c${(seq++).toString().padStart(6, "0")}`;
    const core = new MonetCore(":memory:", { embedder: embedder(), tauAttach: 1.1, tauAmbiguous: 1.1, idGen });
    try {
      const r = await core.store(bodyWithInternalHeading, { circle: "default", kind: "issue" });
      core.endSessionForEval();

      const keyMap = new Map([["gotcha-key", r.conceptId]]);
      const scenario = {
        id: "a4-internal-heading",
        title: "A4 regression fixture (i)",
        rationale: "A4 regression fixture — not part of STARTER_SUITE",
        seed: [{ key: "gotcha-key", content: bodyWithInternalHeading, kind: "issue" }],
        probes: [],
      };
      const result = exportMdTree(core, { circle: "default", keyMap, scenario });

      // Post-fix: correctly mapped, not lost to the fallback. (A5 note: this fixture's old
      // `incompleteHeadingClusters`/`allMembersFound` assertion is gone — A5 deletes the
      // positional-search machinery those signals were about entirely; construct-time
      // derivation has no search step to report on. unmappedGoldKeys below is the surviving,
      // still-meaningful integrity check.)
      expect(result.unmappedGoldKeys).toEqual([]);
      expect(result.chunks).toHaveLength(1);
      expect(result.manifest.chunkIdToConceptKey[result.chunks[0].chunkId]).toBe("gotcha-key");
      // The internal heading's content is still present in the chunk text (not truncated away
      // by construct-time derivation — the whole member's content, including its own
      // subsection, belongs to this one chunk since there's only one member in this cluster).
      expect(result.chunks[0].text).toContain("Root cause");
      expect(result.chunks[0].text).toContain("race condition in the lock file");
    } finally {
      core.close();
    }
  });

  it("A4 regression (ii): combined hard case — duplicate titles within a cluster AND an internal ## heading in one body, all mappings correct (Codex finding #6)", async () => {
    // The case A4's forward-search design is specifically built to handle: two members with
    // the IDENTICAL title (so title-string matching alone couldn't disambiguate them) in the
    // SAME cluster, where the FIRST member's body ALSO contains an internal ## heading (so a
    // naive header-count check would additionally misfire). Forward positional search from the
    // previous member's found position resolves both simultaneously: the internal heading lives
    // before the search window for the SECOND member's heading even starts, and the i-th
    // forward occurrence of the (duplicate) title is necessarily member[i]'s own heading.
    const sharedFirstSentence = "Gotcha: never restart the worker mid-batch.";
    const bodyA = `${sharedFirstSentence} It corrupts in-flight job state.\n\n## Symptom\n\nJobs silently disappear from the queue without erroring.`;
    const bodyB = `${sharedFirstSentence} Wait for the batch to drain first.`;

    let seq = 0;
    const idGen = (): string => `c${(seq++).toString().padStart(6, "0")}`;
    const core = new MonetCore(":memory:", { embedder: embedder(), tauAttach: 1.1, tauAmbiguous: 1.1, idGen });
    try {
      const rA = await core.store(bodyA, { circle: "default", kind: "issue" });
      const rB = await core.store(bodyB, { circle: "default", kind: "issue" });
      core.endSessionForEval(); // SAME session ⇒ co_occurred ⇒ one cluster, both members

      // Confirms the fixture is real: both concepts DO share an identical title (title derives
      // from the shared first sentence), so this genuinely exercises the duplicate-title path.
      const titleA = (await core.getConcept(rA.conceptId, { synthesize: false }))?.title;
      const titleB = (await core.getConcept(rB.conceptId, { synthesize: false }))?.title;
      expect(titleA).toBe(titleB);

      const keyMap = new Map([
        ["worker-a", rA.conceptId],
        ["worker-b", rB.conceptId],
      ]);
      const scenario = {
        id: "a4-combined-hard-case",
        title: "A4 regression fixture (ii)",
        rationale: "A4 regression fixture — not part of STARTER_SUITE",
        seed: [
          { key: "worker-a", content: bodyA, kind: "issue" },
          { key: "worker-b", content: bodyB, kind: "issue" },
        ],
        probes: [],
      };
      const result = exportMdTree(core, { circle: "default", keyMap, scenario });

      expect(result.unmappedGoldKeys).toEqual([]);
      expect(result.chunks).toHaveLength(2);

      // Both keys correctly mapped — neither collapsed onto the other despite the shared title.
      const mappedKeys = Object.values(result.manifest.chunkIdToConceptKey).sort();
      expect(mappedKeys).toEqual(["worker-a", "worker-b"]);

      // The FIRST chunk (worker-a's, which has the internal heading) is mapped to worker-a
      // specifically, and its text carries the internal heading's content intact — the
      // positional split didn't fracture worker-a's own subsection into a separate, unmapped
      // chunk, and didn't let it bleed into worker-b's chunk either.
      const chunkForA = result.chunks.find((c) => result.manifest.chunkIdToConceptKey[c.chunkId] === "worker-a")!;
      const chunkForB = result.chunks.find((c) => result.manifest.chunkIdToConceptKey[c.chunkId] === "worker-b")!;
      expect(chunkForA.text).toContain("Symptom");
      expect(chunkForA.text).toContain("silently disappear from the queue");
      expect(chunkForA.text).not.toContain("Wait for the batch to drain first"); // worker-b's content, must not have bled in
      expect(chunkForB.text).toContain("Wait for the batch to drain first");
      expect(chunkForB.text).not.toContain("Symptom"); // worker-a's internal heading, must not have bled in
    } finally {
      core.close();
    }
  });

  it("A5 regression: a trap heading in an earlier member's body — matching a LATER member's exact title — no longer mis-splits (adversarial-verification finding)", async () => {
    // The defect A4 left unguarded: A4's forward search is robust to an internal `## ` line
    // and to duplicate titles, but NOT to a body containing the literal string `## <exact
    // title of a DIFFERENT, LATER member>`. Before A5, the forward indexOf search for member
    // B's heading would match this trap line first (it's textually earlier than B's real
    // heading) — a SILENT wrong-occurrence mis-split: A's chunk truncated (real content lost),
    // B's chunk contaminated with A's misattributed content. `allMembersFound`/
    // `unmappedGoldKeys` both stayed clean under the old code (a heading WAS found — just the
    // wrong occurrence of it), so nothing signaled the corruption. Verified this reproduces
    // against the pre-A5 positional-search-only code (splitByMemberHeadings, now deleted
    // entirely — see md-export.ts's doc comment on sectionsForMembers for why it isn't kept
    // even as a self-check) before writing this test.
    const titleB = "Member B real title for the trap regression fixture";
    const bodyA = `Member A's own content, unrelated to B.\n\n## ${titleB}\n\nThis exact line is a TRAP: it lives inside A's body, textually before B's real heading, and is byte-identical to it.`;
    const bodyB = `${titleB}. The rest of B's real content, which must end up ONLY in B's chunk.`;

    let seq = 0;
    const idGen = (): string => `c${(seq++).toString().padStart(6, "0")}`;
    const core = new MonetCore(":memory:", { embedder: embedder(), tauAttach: 1.1, tauAmbiguous: 1.1, idGen });
    try {
      const rA = await core.store(bodyA, { circle: "default", kind: "issue" });
      const rB = await core.store(bodyB, { circle: "default", kind: "issue" });
      core.endSessionForEval(); // SAME session ⇒ co_occurred ⇒ one cluster, A before B (insertion order)

      // Confirms the fixture is real: B's derived title genuinely equals the literal string
      // embedded in A's body (so the trap line really is byte-identical to B's real heading,
      // not just superficially similar).
      const derivedTitleB = (await core.getConcept(rB.conceptId, { synthesize: false }))?.title;
      expect(derivedTitleB).toBe(titleB);

      const keyMap = new Map([
        ["member-a", rA.conceptId],
        ["member-b", rB.conceptId],
      ]);
      const scenario = {
        id: "a5-trap-heading",
        title: "A5 regression fixture",
        rationale: "A5 regression fixture — not part of STARTER_SUITE",
        seed: [
          { key: "member-a", content: bodyA, kind: "issue" },
          { key: "member-b", content: bodyB, kind: "issue" },
        ],
        probes: [],
      };
      const result = exportMdTree(core, { circle: "default", keyMap, scenario });

      // unmappedGoldKeys stays empty — both members' content is mechanically identifiable and
      // mapped, exactly as it was (deceptively) under the old code too. The REAL assertions are
      // below: not that a signal fires, but that the CONTENT itself is correct — this is
      // precisely the defect class where the old code's signals stayed clean while the content
      // was silently wrong, so an empty unmappedGoldKeys here proves nothing on its own.
      expect(result.unmappedGoldKeys).toEqual([]);
      expect(result.chunks).toHaveLength(2);

      const mappedKeys = Object.values(result.manifest.chunkIdToConceptKey).sort();
      expect(mappedKeys).toEqual(["member-a", "member-b"]);

      const chunkForA = result.chunks.find((c) => result.manifest.chunkIdToConceptKey[c.chunkId] === "member-a")!;
      const chunkForB = result.chunks.find((c) => result.manifest.chunkIdToConceptKey[c.chunkId] === "member-b")!;

      // A's chunk contains ALL of A's content, including the trap line itself — nothing lost
      // to a premature boundary cut (the old bug: A's chunk truncated at the trap line).
      expect(chunkForA.text).toContain("Member A's own content, unrelated to B");
      expect(chunkForA.text).toContain("This exact line is a TRAP");

      // B's chunk contains ONLY B's real content — nothing misattributed from A (the old bug:
      // B's chunk contaminated with everything from the trap line through A's true end, which
      // for a 2-member cluster is nothing since A has no content after the trap line here —
      // the stronger 3-member cascade below exercises genuine cross-contamination directly).
      expect(chunkForB.text).toContain("The rest of B's real content");
      expect(chunkForB.text).not.toContain("Member A's own content");
      expect(chunkForB.text).not.toContain("unrelated to B");
    } finally {
      core.close();
    }
  });

  it("A5 regression: 3-member cascade — A's body contains trap headings for BOTH B and C — all three chunks correct and correctly mapped", async () => {
    // The stress case: under the old positional-search code, A's body containing trap lines for
    // TWO later members would misdirect BOTH B's and C's forward searches, and — per the
    // mission's verified finding — the MIDDLE member's chunk (B's) ends up 100% wrong content
    // (entirely A/trap material, none of B's own). Construct-time derivation sidesteps all of
    // it: each member's section is built directly from that member's own {id, title, body},
    // never by searching anyone else's text.
    const titleB = "Member B cascade title";
    const titleC = "Member C cascade title";
    const bodyA =
      `A's real content, paragraph one.\n\n## ${titleB}\n\nTrap line 1: looks exactly like B's heading, lives inside A.` +
      `\n\n## ${titleC}\n\nTrap line 2: looks exactly like C's heading, ALSO lives inside A.\n\nA's real content, paragraph two — still A's, after both traps.`;
    const bodyB = `${titleB}. B's own real content, which must end up ONLY in B's chunk.`;
    const bodyC = `${titleC}. C's own real content, which must end up ONLY in C's chunk.`;

    let seq = 0;
    const idGen = (): string => `c${(seq++).toString().padStart(6, "0")}`;
    const core = new MonetCore(":memory:", { embedder: embedder(), tauAttach: 1.1, tauAmbiguous: 1.1, idGen });
    try {
      const rA = await core.store(bodyA, { circle: "default", kind: "issue" });
      const rB = await core.store(bodyB, { circle: "default", kind: "issue" });
      const rC = await core.store(bodyC, { circle: "default", kind: "issue" });
      core.endSessionForEval(); // SAME session ⇒ co_occurred ⇒ one cluster, insertion order A, B, C

      const derivedTitleB = (await core.getConcept(rB.conceptId, { synthesize: false }))?.title;
      const derivedTitleC = (await core.getConcept(rC.conceptId, { synthesize: false }))?.title;
      expect(derivedTitleB).toBe(titleB);
      expect(derivedTitleC).toBe(titleC);

      const keyMap = new Map([
        ["cascade-a", rA.conceptId],
        ["cascade-b", rB.conceptId],
        ["cascade-c", rC.conceptId],
      ]);
      const scenario = {
        id: "a5-trap-heading-cascade",
        title: "A5 3-member cascade regression fixture",
        rationale: "A5 regression fixture — not part of STARTER_SUITE",
        seed: [
          { key: "cascade-a", content: bodyA, kind: "issue" },
          { key: "cascade-b", content: bodyB, kind: "issue" },
          { key: "cascade-c", content: bodyC, kind: "issue" },
        ],
        probes: [],
      };
      const result = exportMdTree(core, { circle: "default", keyMap, scenario });

      expect(result.unmappedGoldKeys).toEqual([]);
      expect(result.chunks).toHaveLength(3);

      const mappedKeys = Object.values(result.manifest.chunkIdToConceptKey).sort();
      expect(mappedKeys).toEqual(["cascade-a", "cascade-b", "cascade-c"]);

      const chunkForA = result.chunks.find((c) => result.manifest.chunkIdToConceptKey[c.chunkId] === "cascade-a")!;
      const chunkForB = result.chunks.find((c) => result.manifest.chunkIdToConceptKey[c.chunkId] === "cascade-b")!;
      const chunkForC = result.chunks.find((c) => result.manifest.chunkIdToConceptKey[c.chunkId] === "cascade-c")!;

      // A's chunk: ALL of A's content survives, including both trap lines AND the paragraph
      // written after them — the old bug truncated A at the FIRST trap line, losing everything
      // after it (including "paragraph two").
      expect(chunkForA.text).toContain("A's real content, paragraph one");
      expect(chunkForA.text).toContain("Trap line 1");
      expect(chunkForA.text).toContain("Trap line 2");
      expect(chunkForA.text).toContain("A's real content, paragraph two");

      // B's chunk: ONLY B's real content — the old bug made this chunk 100% wrong (entirely
      // trap/A material, spanning from the B-trap to the C-trap, none of B's own real content).
      expect(chunkForB.text).toContain("B's own real content");
      expect(chunkForB.text).not.toContain("Trap line");
      expect(chunkForB.text).not.toContain("A's real content");
      expect(chunkForB.text).not.toContain("C's own real content");

      // C's chunk: ONLY C's real content — nothing bled in from A or B.
      expect(chunkForC.text).toContain("C's own real content");
      expect(chunkForC.text).not.toContain("Trap line");
      expect(chunkForC.text).not.toContain("A's real content");
      expect(chunkForC.text).not.toContain("B's own real content");
    } finally {
      core.close();
    }
  });
});
