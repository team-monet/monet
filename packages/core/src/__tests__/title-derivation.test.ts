/**
 * Title/slug derivation from a concept body's first line/sentence (firstLine in engine.ts).
 *
 * Regression: a period inside a token is not a sentence boundary. Version numbers like "0.5.0" or
 * "v0.6.0" mid-sentence previously truncated the title at the first dot ("Librarian layer design
 * (engine 0.5.0 ...)" derived "Librarian layer design (engine 0"), and filenames, domains and
 * abbreviations kept doing so until #117.
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

describe("title derivation — a period only ends a title at a sentence end (#117)", () => {
  const titleOf = async (body: string) => {
    const core = new MonetCore(":memory:");
    try {
      return (await core.store(body)).concept;
    } finally {
      core.close();
    }
  };

  it.each([
    ["Updated app/card-image.ts downloadCardImage canvas exporter", "Updated app/card-image.ts downloadCardImage canvas exporter"],
    ["Bump vite.config.ts target to es2022", "Bump vite.config.ts target to es2022"],
    ["Layout Height Collapse: Svelte mounts App.svelte at the root", "Layout Height Collapse: Svelte mounts App.svelte at the root"],
    ["The docs live at example.ai and acme.dev now", "The docs live at example.ai and acme.dev now"],
    ["Use e.g. a lexicon entry instead of patching text", "Use e.g. a lexicon entry instead of patching text"],
    ["The U.S. region stays on the old pricing", "The U.S. region stays on the old pricing"],
    ["monet-core 0.6.0 ships the temporal layer", "monet-core 0.6.0 ships the temporal layer"],
  ])("keeps %s whole", async (body, title) => {
    expect((await titleOf(body)).title).toBe(title);
  });

  it.each([
    ["Bump vite.config.ts. The target moves to es2022.", "Bump vite.config.ts"],
    ["Ship it.", "Ship it"],
    ["We chose option A. The other one failed under load.", "We chose option A"],
    ["Fix the crash in main.c. The build failed on arm64.", "Fix the crash in main.c"],
    ["Node 22.x. Older versions are untested.", "Node 22.x"],
    ["Loading...", "Loading"],
    ["Wait... then it worked", "Wait"],
    ["이 결정은 유지한다. 다음 단계로 간다.", "이 결정은 유지한다"],
    ["가. 나는 간다.", "가"],
    ["플랜B. 다음 단계로 간다.", "플랜B"],
  ])("ends %s at its sentence end", async (body, title) => {
    expect((await titleOf(body)).title).toBe(title);
  });
});

describe("title derivation — an email address is masked on the card and the slug (#117)", () => {
  const conceptOf = async (body: string) => {
    const core = new MonetCore(":memory:");
    try {
      return (await core.store(body)).concept;
    } finally {
      core.close();
    }
  };

  it("masks an address that leads the title", async () => {
    const concept = await conceptOf("jane.doe@example.com reported the crash on startup");
    expect(concept.title).toBe("[redacted-email] reported the crash on startup");
    expect(concept.slug).toBe("redacted-email-reported-the-crash-on-startup");
  });

  it("masks an address inside the title, and one that ends the sentence", async () => {
    expect((await conceptOf("Ask jane+ops@mail.example.co.uk about the rollout plan")).title).toBe("Ask [redacted-email] about the rollout plan");
    expect((await conceptOf("The rollout owner is jane@example.com. She is out until May.")).title).toBe("The rollout owner is [redacted-email]");
  });

  it.each([
    ["jane@bücher.de reported the crash"],
    ["jöhn@example.com reported the crash"],
    ["jo\u0308hn@example.com reported the crash"],
    ["jane@例え.jp reported the crash"],
    ["jane%ops@example.com reported the crash"],
    ["jane@163.com reported the crash"],
    ["git@example.com reported the crash"],
  ])("masks %s whole", async (body) => {
    expect((await conceptOf(body)).title).toBe("[redacted-email] reported the crash");
  });

  it.each([
    ["담당자이메일jane@example.com으로문의바랍니다", "담당자이메일[redacted-email]으로문의바랍니다"],
    ["연락처는 jane@example.com입니다. 다음 문장.", "연락처는 [redacted-email]입니다"],
    ["jane@example.com에게 문의하세요", "[redacted-email]에게 문의하세요"],
    ["担当者のメールはjane@example.comです", "担当者のメールは[redacted-email]です"],
    ["请联系jane@example.com获取详情", "请联系[redacted-email]获取详情"],
    ["Reply to git@example.com:", "Reply to [redacted-email]:"],
  ])("masks only the address in %s", async (body, title) => {
    expect((await conceptOf(body)).title).toBe(title);
  });

  it("masks every address, and masks before the title is cut", async () => {
    expect((await conceptOf("Email a@example.com, b@example.org and c@example.net about it")).title)
      .toBe("Email [redacted-email], [redacted-email] and [redacted-email] about it");
    // Raw, this address straddles the 77-character cut, so masking after the cut would keep "jane.".
    const title = (await conceptOf(`${"x ".repeat(36)}jane.doe@example.com reported it`)).title;
    expect(title).toBe(`${"x ".repeat(36)}[reda…`);
  });

  it.each([
    ["Pin vitest@4.1.11 in the workspace catalog"],
    ["Pack team-monet-monet@1.11.0.tgz for the release"],
    ["Install react@19.0.0-canary.next for the test"],
    ["vitest@4.1.11を固定する"],
    ["값@섹션.항목 형식으로 쓴다"],
    ["The remote is git@github.com:acme/repo over ssh"],
    ["The remote is ssh://git@github.com/acme/repo over ssh"],
    ["Import @team-monet/core@0.9.0 from the workspace"],
  ])("leaves %s alone", async (body) => {
    expect((await conceptOf(body)).title).toBe(body);
  });

  it("keeps the address in the body: only the derived card is masked", async () => {
    const concept = await conceptOf("jane.doe@example.com reported the crash on startup");
    expect(concept.body).toContain("jane.doe@example.com");
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
    expect(originalWorkstreamTitle).toBe("wire prewarm");

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
