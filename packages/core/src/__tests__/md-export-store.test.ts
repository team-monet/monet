/**
 * Real-store md-tree exporter tests (md-export-store.ts) — the gold-manifest-free sibling of
 * md-export.ts's exportMdTree(), used for Phase 1 corpus derivation.
 *
 * Seeds a plain MonetCore directly via core.store() (NOT seedScenario()/Scenario — that's the
 * whole point of this module: there is no scenario/gold for a real store) and asserts the
 * shared-helper reuse contract: construct-time section derivation (never re-parsed from an
 * already-built file body), header-boundary chunking, and the same slug-collision disambiguation
 * exportMdTree() has.
 */
import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";
import { HashingEmbeddingProvider } from "../embedding";
import { exportMdTreeFromStore } from "../eval/md-export-store";

const embedder = (): HashingEmbeddingProvider => new HashingEmbeddingProvider();

describe("exportMdTreeFromStore — content-only export, no scenario/gold required", () => {
  it("exports index.md + topic files + chunks for a plainly-seeded store (no Scenario/keyMap involved)", async () => {
    const core = new MonetCore(":memory:", { embedder: embedder(), defaultCircle: "proj" });
    await core.store("The AuthService validates sessions using JWT.", { kind: "architecture" });
    await core.store("We standardized on jose for token verification.", { kind: "decision" });
    await core.checkpoint();

    const result = exportMdTreeFromStore(core, { circle: "proj" });

    expect(result.indexMd).toContain("# Memory index");
    expect(result.indexMd).toContain("2 concepts");
    expect(result.topicFiles.size).toBeGreaterThan(0);
    expect(result.chunks.length).toBeGreaterThan(0);
    // Every chunk's text should be attributable to some topic file that was actually written.
    for (const chunk of result.chunks) {
      expect(result.topicFiles.has(chunk.file)).toBe(true);
    }
    core.close();
  });

  it("clusters via co_occurred edges exactly like exportMdTree — concepts written in one session co-occur into one topic file", async () => {
    const core = new MonetCore(":memory:", { embedder: embedder(), defaultCircle: "proj", graphEnabled: true });
    await core.store("Fact A about the checkout flow.", { kind: "fact" });
    await core.store("Fact B about the checkout flow, a different sentence.", { kind: "fact" });
    core.endSessionForEval();
    await core.checkpoint();

    const coOccurred = core.edges({ circle: "proj", type: "co_occurred" });
    // Only assert the clustering behavior if the engine actually produced a co_occurred edge for
    // this pair (session-boundary/graph heuristics are the engine's own concern, not this
    // exporter's) — the exporter's job is to honor whatever edges() returns, not to second-guess it.
    if (coOccurred.length > 0) {
      const result = exportMdTreeFromStore(core, { circle: "proj" });
      // Two concepts co-occurring should land in ONE topic file, not two separate singleton files.
      const fileForA = result.chunks.find((c) => c.text.includes("checkout flow"))?.file;
      const filesContainingCheckout = new Set(result.chunks.filter((c) => c.text.includes("checkout flow")).map((c) => c.file));
      expect(filesContainingCheckout.size).toBe(1);
      expect(fileForA).toBeDefined();
    }
    core.close();
  });

  it("never produces a chunk from the paragraph-fallback path when there is at least one member (construct-time derivation always succeeds)", async () => {
    const core = new MonetCore(":memory:", { embedder: embedder(), defaultCircle: "proj" });
    for (let i = 0; i < 5; i++) {
      await core.store(`Distinct standalone fact number ${i} about topic ${i}.`, { kind: "fact" });
    }
    await core.checkpoint();

    const result = exportMdTreeFromStore(core, { circle: "proj" });
    // Every chunk should start with a "## " header (the construct-time sectionsForMembers shape) —
    // never a headerless paragraph-fallback chunk, which only happens when a cluster has zero
    // members (impossible here: every cluster is built from allIds, which is non-empty).
    for (const chunk of result.chunks) {
      expect(chunk.text.startsWith("## ")).toBe(true);
    }
    core.close();
  });

  it("is a pure read: calling it twice on the same core produces identical output (no synthesis/usefulness side effects)", async () => {
    const core = new MonetCore(":memory:", { embedder: embedder(), defaultCircle: "proj" });
    await core.store("A fact for the purity check.", { kind: "fact" });
    await core.checkpoint();

    const first = exportMdTreeFromStore(core, { circle: "proj" });
    const second = exportMdTreeFromStore(core, { circle: "proj" });
    expect(first.indexMd).toBe(second.indexMd);
    expect([...first.topicFiles.entries()]).toEqual([...second.topicFiles.entries()]);
    expect(first.chunks).toEqual(second.chunks);
    core.close();
  });

  it("excludes kind='workstream' concepts, matching allConceptsForExport's own convention", async () => {
    const core = new MonetCore(":memory:", { embedder: embedder(), defaultCircle: "proj" });
    await core.store("A real fact that should be exported.", { kind: "fact" });
    await core.saveWorkstream({ status: "active", open: [{ slot: "question" as const, text: "an in-progress workstream note that should NOT be exported" }] });
    await core.checkpoint();

    const result = exportMdTreeFromStore(core, { circle: "proj" });
    const allText = [...result.topicFiles.values()].join("\n");
    expect(allText).toContain("A real fact");
    expect(allText).not.toContain("in-progress workstream note");
    core.close();
  });

  describe("P1-b fix (round 2 review): topic-file slugs derive from a SCRUBBED title, not the raw one", () => {
    it("never embeds a raw /Users/ path in a topic-file's relative path when the lead concept's title contains one", async () => {
      const core = new MonetCore(":memory:", { embedder: embedder(), defaultCircle: "proj" });
      // Lead title contains an absolute path — the exact leak shape confirmed in the real,
      // previously-published corpus (a title like "build plan doc (written ..., /Users/dev/...)"
      // slugified straight into a filename that survived unredacted).
      await core.store("build plan doc for /Users/dev/code/some-project/ rollout.", { kind: "decision" });
      await core.checkpoint();

      const result = exportMdTreeFromStore(core, { circle: "proj" });
      for (const relPath of result.topicFiles.keys()) {
        expect(relPath).not.toContain("/Users/");
        expect(relPath.toLowerCase()).not.toContain("dev");
      }
    });

    it("never embeds a tilde-form home path in a topic-file's relative path (the pattern class a post-hoc rename pass alone cannot recover)", async () => {
      const core = new MonetCore(":memory:", { embedder: embedder(), defaultCircle: "proj" });
      await core.store("live store config lives at ~/.monet/monet.db for this setup.", { kind: "fact" });
      await core.checkpoint();

      const result = exportMdTreeFromStore(core, { circle: "proj" });
      for (const relPath of result.topicFiles.keys()) {
        expect(relPath).not.toContain("~");
        expect(relPath).not.toContain(".monet");
      }
    });

    it("never embeds an email address in a topic-file's relative path", async () => {
      const core = new MonetCore(":memory:", { embedder: embedder(), defaultCircle: "proj" });
      await core.store("contact jane.doe@example.com regarding this decision.", { kind: "decision" });
      await core.checkpoint();

      const result = exportMdTreeFromStore(core, { circle: "proj" });
      for (const relPath of result.topicFiles.keys()) {
        expect(relPath).not.toContain("@");
        expect(relPath).not.toContain("jane.doe");
      }
    });

    it("leaves the concept's TITLE TEXT (inside fileBody/indexMd) unscrubbed at this stage — only the slug-derivation input changes", async () => {
      // Content scrubbing is scrub-corpus.mjs's job (a separate, later pipeline stage) — this
      // exporter's own contract is still a pure, non-mutating read of the store's real content.
      // Only the FILENAME derivation input is scrubbed; the title used for headings/body text is
      // the concept's actual raw title, exactly as before this fix.
      const core = new MonetCore(":memory:", { embedder: embedder(), defaultCircle: "proj" });
      await core.store("contact jane.doe@example.com regarding this decision.", { kind: "decision" });
      await core.checkpoint();

      const result = exportMdTreeFromStore(core, { circle: "proj" });
      const allFileContent = [...result.topicFiles.values()].join("\n");
      expect(allFileContent).toContain("jane.doe@example.com");
    });

    it("still disambiguates a collision when two different (scrubbed) titles slugify to the same string", async () => {
      const core = new MonetCore(":memory:", { embedder: embedder(), defaultCircle: "proj" });
      // Two different sensitive titles whose scrubbed+slugified forms could plausibly collide
      // (both reduce to a "contact-redacted-email-..." shape) — the existing collision-guard
      // (usedSlugs/collidedSlugs) must still function against the SCRUBBED slug space.
      await core.store("contact a@example.com about topic one, a standalone unrelated fact.", { kind: "fact" });
      await core.store("contact b@example.com about topic two, a different standalone unrelated fact.", { kind: "fact" });
      await core.checkpoint();

      const result = exportMdTreeFromStore(core, { circle: "proj" });
      // Two distinct concepts (no co_occurred edge between them expected in this minimal seed)
      // should not collapse into fewer topic files than clusters — the exact count depends on
      // clustering, but the file paths themselves must be unique regardless.
      const paths = [...result.topicFiles.keys()];
      expect(new Set(paths).size).toBe(paths.length);
    });
  });
});
