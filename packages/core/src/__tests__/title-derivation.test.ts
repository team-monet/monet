/**
 * Title/slug derivation from a concept body's first line/sentence (firstLine in engine.ts).
 *
 * Regression: a period BETWEEN digits is not a sentence boundary. Version numbers like
 * "0.5.0" or "v0.6.0" mid-sentence previously truncated the title at the first dot
 * ("Librarian layer design (engine 0.5.0 ...)" derived "Librarian layer design (engine 0").
 * Normal sentence splitting, newline splitting, and the 80-char truncation rule are unchanged.
 */
import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";

describe("title derivation — version numbers are not sentence boundaries", () => {
  it("derives the full first sentence when it contains a multi-dot version mid-sentence", async () => {
    const core = new MonetCore(":memory:");
    const r = await core.store(
      "Librarian layer design (engine 0.5.0 plus the sync playbook). Second sentence with more detail.",
    );
    expect(r.concept.title).toBe("Librarian layer design (engine 0.5.0 plus the sync playbook)");
    // Slug stays consistent with the derived title.
    expect(r.concept.slug).toBe("librarian-layer-design-engine-0-5-0-plus-the-sync-playbook");
    core.close();
  });

  it("keeps a v-prefixed version token intact in the title", async () => {
    const core = new MonetCore(":memory:");
    const r = await core.store("Shipped v0.6.0 with the temporal layer. Follow-up hardening is tracked separately.");
    expect(r.concept.title).toBe("Shipped v0.6.0 with the temporal layer");
    core.close();
  });

  it("still splits at a sentence end directly after a version number", async () => {
    const core = new MonetCore(":memory:");
    // The dot after the final digit is followed by a space, not a digit — it IS a boundary.
    const r = await core.store("Upgraded the storage engine to 0.5.0. Migration notes are in the changelog.");
    expect(r.concept.title).toBe("Upgraded the storage engine to 0.5.0");
    core.close();
  });

  it("applies the 80-char truncation rule to a long first sentence containing a version", async () => {
    const core = new MonetCore(":memory:");
    const body =
      "Release 0.5.0 introduced the temporal confidence layer alongside per-session gating for attach flows";
    const r = await core.store(body);
    expect(r.concept.title).toBe(body.slice(0, 77) + "…");
    expect(r.concept.title.length).toBe(78);
    core.close();
  });
});

describe("title derivation — existing behaviour unchanged", () => {
  it("splits a normal body at the first sentence end", async () => {
    const core = new MonetCore(":memory:");
    const r = await core.store("We decided to use SQLite as the storage backend. It keeps deployment simple.");
    expect(r.concept.title).toBe("We decided to use SQLite as the storage backend");
    core.close();
  });

  it("splits at the first newline", async () => {
    const core = new MonetCore(":memory:");
    const r = await core.store("Prefer guard clauses over nested conditionals\nEarly returns keep the body flat.");
    expect(r.concept.title).toBe("Prefer guard clauses over nested conditionals");
    core.close();
  });

  it("truncates a single-line body with no sentence end at 77 chars plus ellipsis", async () => {
    const core = new MonetCore(":memory:");
    const body =
      "A single very long opening line without any sentence-ending punctuation that keeps going well past the eighty character limit";
    const r = await core.store(body);
    expect(r.concept.title).toBe(body.slice(0, 77) + "…");
    expect(r.concept.title.length).toBe(78);
    core.close();
  });
});

describe("title re-derivation on synthesis", () => {
  it("applySynthesis (MCP/agent path) updates title from the new body's first line", async () => {
    const core = new MonetCore(":memory:");
    // Create a concept — title set from first sentence of initial observation.
    const a = await core.store("Old title sentence. More detail here.");
    expect(a.concept.title).toBe("Old title sentence");
    const oldSlug = a.concept.slug;

    // Attach a second observation to mark it dirty, then drive applySynthesis directly.
    await core.store("Additional evidence that contradicts the first observation.");
    const newBody = "New synthesized title sentence. Completely rewritten body.";
    const updated = (await core.applySynthesis(a.conceptId, newBody))!;

    expect(updated.title).toBe("New synthesized title sentence");
    // Slug is UNCHANGED — stable wikilink target.
    expect(updated.slug).toBe(oldSlug);
    expect(updated.dirty).toBe(false);
    core.close();
  });

  it("in-process synthesizer path (getConcept synthesize:true) updates title from new body", async () => {
    // Inject a stub synthesizer whose output first line is clearly distinct from the create-time
    // title. This proves synthesizeRow re-derives title from the synthesized body — if the
    // `title = ?` UPDATE in synthesizeRow is deleted, this test turns red.
    const SYNTH_BODY = "Re-derived lead from synthesizer. trailing detail.";
    const stubSynthesizer = {
      synthesize: (_obs: string[], _current: { body: string } | null) => ({ body: SYNTH_BODY }),
    };
    const core = new MonetCore(":memory:", { synthesizer: stubSynthesizer });

    // Create a concept with a clearly different title than what the stub will produce.
    const a = await core.store("We decided to use SQLite as the storage backend for Monet Local.");
    expect(a.concept.title).toBe("We decided to use SQLite as the storage backend for Monet Local");
    const originalSlug = a.concept.slug;

    // Score ~0.75 — robustly above tauAttach (0.55): attaches to the same concept, sets dirty=1.
    const b = await core.store("Monet Local uses SQLite for its local storage backend.");
    expect(b.conceptId).toBe(a.conceptId); // confirmed attach
    expect(b.action).toBe("attached");

    // getConcept with synthesize:true runs synthesizeRow, which calls our stub and re-derives title.
    const after = (await core.getConcept(a.conceptId, { synthesize: true }))!;
    expect(after.synthesizedNow).toBe(true);

    // Title must be firstLine(SYNTH_BODY) — a value the create path could NOT have produced.
    expect(after.title).toBe("Re-derived lead from synthesizer");
    // Body is the stub's output.
    expect(after.body).toBe(SYNTH_BODY);
    // Slug is frozen at create-time — stable wikilink target.
    expect(after.slug).toBe(originalSlug);
    core.close();
  });

  it("title preserves a version number in the new body's first line (no dot-split at digit boundaries)", async () => {
    const core = new MonetCore(":memory:");
    const a = await core.store("Old title. Old detail.");
    const oldSlug = a.concept.slug;

    await core.store("Second observation.");
    const versionBody = "Temporal layer (engine 0.6.0 → 0.8.0): upgraded storage. Follow-up notes below.";
    const updated = (await core.applySynthesis(a.conceptId, versionBody))!;

    // The version number "0.6.0 → 0.8.0" must not be split at the dots between digits.
    expect(updated.title).toBe("Temporal layer (engine 0.6.0 → 0.8.0): upgraded storage");
    expect(updated.slug).toBe(oldSlug);
    core.close();
  });

  it("slug is unchanged by synthesis even when title changes", async () => {
    const core = new MonetCore(":memory:");
    const a = await core.store("First title here. Initial body.");
    const createSlug = a.concept.slug;
    expect(createSlug).toBe("first-title-here");

    await core.store("More evidence.");
    const updated = (await core.applySynthesis(
      a.conceptId,
      "Completely different title now. Body was rewritten.",
    ))!;

    expect(updated.title).toBe("Completely different title now");
    // Slug frozen at create-time value — stable wikilink target.
    expect(updated.slug).toBe(createSlug);
    core.close();
  });

  it("workstream concept title is NOT overwritten by synthesis (guard is correct)", async () => {
    const core = new MonetCore(":memory:");

    // Create a workstream — its title is derived from workstreamTitle(), stored as a JSON body.
    const w = await core.saveWorkstream({
      status: "active",
      open: [{ slot: "question" as const, text: "how to tune thresholds?" }, { slot: "step" as const, text: "wire prewarm" }],
    });
    const originalWorkstreamTitle = w!.title;
    expect(originalWorkstreamTitle).toBeTruthy();

    // Drive applySynthesis directly on the workstream concept id (the MCP path).
    // The body we pass is a plain string — firstLine of it would be "{" if the guard were absent
    // (i.e. if we had passed a JSON body). We pass something whose firstLine is clearly different
    // from the workstream title to prove the guard suppresses the re-derivation.
    const updated = await core.applySynthesis(w!.id, '{"status":"active","nextSteps":["wire prewarm"]}');
    // applySynthesis returns null only when the id is not found; workstreams always exist.
    expect(updated).not.toBeNull();
    // Title must remain the workstream's proper title, not "{" (firstLine of the JSON body).
    expect(updated!.title).toBe(originalWorkstreamTitle);
    expect(updated!.title).not.toBe("{");
    core.close();
  });
});
