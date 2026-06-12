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
