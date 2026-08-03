/**
 * A source chunk is embedded with its headings, and stored without them (#135, item 1).
 *
 * The chunker parses each chunk's document and section titles and stores them in
 * `source_chunks.heading_path_json` — then the embed call saw only the body. A chunk's body is a
 * section with the headings that say what it is about stripped off, so a query naming a document
 * matched nothing: on the live store a file's own exact title scored 0.414 against its best chunk,
 * where unrelated pairs sit at a median of 0.328.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore, contextualizeSourceChunk } from "../index";
import type { EmbeddingProvider } from "../embedding";

/** Records exactly what text reached embed(), which is the whole point of this change. */
class RecordingProvider implements EmbeddingProvider {
  readonly dim = 8;
  readonly modelId = "fake/recording-8";
  readonly seen: string[] = [];
  embed(text: string): Float32Array {
    this.seen.push(text);
    const v = new Float32Array(this.dim);
    for (let i = 0; i < text.length; i++) v[i % this.dim] += text.charCodeAt(i) % 5;
    const mag = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    return v.map((x) => x / mag);
  }
}

describe("contextualizeSourceChunk", () => {
  it("puts what the section is about before what it says", () => {
    expect(contextualizeSourceChunk("the body", ["Doc title", "2. A section"]))
      .toBe("Doc title > 2. A section\n\nthe body");
  });

  // A preamble before the first heading, or a file with no headings at all. Today's behavior, and
  // it stays correct — there is nothing to prepend, and an empty separator would be noise.
  it("returns the body unchanged when there are no headings", () => {
    expect(contextualizeSourceChunk("the body", [])).toBe("the body");
    expect(contextualizeSourceChunk("the body", undefined)).toBe("the body");
  });

  it("ignores blank heading entries rather than emitting empty separators", () => {
    expect(contextualizeSourceChunk("b", ["Real", "   ", ""])).toBe("Real\n\nb");
  });

  // Codex review, PR #136. A document's display title comes from frontmatter or its filename, never
  // from the heading hierarchy — so a file with no `#` heading, or a chunk under only `##`, would
  // otherwise be embedded with no idea which document it belongs to.
  it("carries the file title, which never appears in the heading path", () => {
    expect(contextualizeSourceChunk("b", ["2. A section"], "The Document"))
      .toBe("The Document > 2. A section\n\nb");
    expect(contextualizeSourceChunk("b", [], "The Document")).toBe("The Document\n\nb");
  });

  it("does not repeat a title that the first heading already states", () => {
    expect(contextualizeSourceChunk("b", ["The Document", "2. A section"], "The Document"))
      .toBe("The Document > 2. A section\n\nb");
  });

  it("still repeats a title that matches a DEEPER heading, which is a different section", () => {
    expect(contextualizeSourceChunk("b", ["Top", "Overview"], "Overview"))
      .toBe("Overview > Top > Overview\n\nb");
  });

  // Headings are source-controlled text of unbounded length, and maxChunkBytes bounds only the body
  // (heading lines are removed before segmentSection). An unbounded prefix could push a previously
  // fitting input past the model window — where the BODY is what gets discarded, inverting the fix.
  it("truncates an absurdly long single heading", () => {
    const out = contextualizeSourceChunk("b", ["H".repeat(500)]);
    const prefix = out.slice(0, out.indexOf("\n\n"));
    expect(prefix.length).toBeLessThanOrEqual(301);
    expect(prefix.endsWith("…")).toBe(true);
  });

  it("elides the middle of a deep trail, keeping the document and the section", () => {
    const deep = Array.from({ length: 12 }, (_, i) => `Level ${i} ${"x".repeat(40)}`);
    const out = contextualizeSourceChunk("b", deep);
    const prefix = out.slice(0, out.indexOf("\n\n"));
    expect(prefix.length).toBeLessThanOrEqual(300);
    expect(prefix.startsWith("Level 0")).toBe(true);
    expect(prefix).toContain("Level 11");
    expect(prefix).toContain("…");
  });
});

describe("source chunk ingest — headings are embedded, never stored", () => {
  let dir: string;
  let core: MonetCore;
  let embedder: RecordingProvider;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "monet-chunk-context-"));
    embedder = new RecordingProvider();
    core = new MonetCore(join(dir, "monet.db"), { embedder });
  });

  afterEach(() => {
    core.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("hands the embedder the heading path along with the body", async () => {
    await core.storeSource("The free tier exists to create advocates.", {
      sourceRefs: ["source://vault/positioning.md#free-line~1"],
      resolution: "forceNew",
      headingPath: ["Monet — market positioning", "9. The free / paid line"],
    });
    expect(embedder.seen).toContain(
      "Monet — market positioning > 9. The free / paid line\n\nThe free tier exists to create advocates.",
    );
  });

  // The stored string must stay byte-identical to the chunker's output: contentHash,
  // ingestFingerprint and source-ledger's durable receipt validation are all computed from it, so
  // prepending headings to what is STORED would churn every fingerprint in the store to fix a
  // retrieval problem. This is the assertion that keeps the two apart.
  it("stores the body byte-identical, without the headings", async () => {
    const body = "The free tier exists to create advocates.";
    const r = await core.storeSource(body, {
      sourceRefs: ["source://vault/positioning.md#free-line~1"],
      resolution: "forceNew",
      headingPath: ["Monet — market positioning", "9. The free / paid line"],
    });
    // Reading the row directly is the point: the assertion is about the bytes on disk, which is
    // what contentHash, ingestFingerprint and the ledger's receipt validation are computed from.
    const rows = (core as unknown as { db: { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] } } })
      .db.prepare(`SELECT content FROM observations WHERE concept_id = ?`)
      .all(r.conceptId) as Array<{ content: string }>;
    const contents = rows.map((o) => o.content);
    expect(contents).toContain(body);
    expect(contents.some((c) => c.includes("market positioning"))).toBe(false);
  });

  it("falls back to the body alone when a chunk has no headings", async () => {
    await core.storeSource("Preamble before any heading.", {
      sourceRefs: ["source://vault/notes.md#~1"],
      resolution: "forceNew",
      headingPath: [],
    });
    expect(embedder.seen).toContain("Preamble before any heading.");
  });
});
