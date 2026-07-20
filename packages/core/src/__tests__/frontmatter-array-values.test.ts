/**
 * Frontmatter array tolerance (ratified): source-chunker.ts's parseFrontmatter used to reject the
 * WHOLE file for any array-valued frontmatter key other than the one it gives dedicated flat-list
 * handling (`tags`) — real vaults (Obsidian, etc.) use array frontmatter routinely for other keys
 * too (`attendees: [Priya Patel, Sarah Chen]`), and this silently dropped those files at
 * ingestion even though sync otherwise reported healthy (the file simply never showed up).
 *
 * A flat scalar list is now accepted for ANY key, stored the same shape a plain scalar already is
 * (frontmatter is a flat Record<string,string> — canonicalizeSourceChunkMetadata sorts/hashes it
 * as such — so the list joins back into one comma-separated string). A genuinely nested value
 * (array of objects, nested array) still fails closed with a per-file skip via the SAME
 * skip-and-diagnose machinery as before (source_skipped_files, PR #49) — never a sync failure.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chunkSourceText, computeSourceContentHash } from "../source-chunker";
import { scanSourceSnapshot } from "../source-scanner";

const RAW = computeSourceContentHash(Buffer.from("raw"));

describe("frontmatter array tolerance — chunkSourceText", () => {
  it("accepts a flat scalar list for a non-tags key and stores it as a flat comma-joined string", () => {
    const result = chunkSourceText({
      relativePath: "meeting.md",
      text: "---\nattendees: [Priya Patel, Sarah Chen]\n---\n# Standup\nDiscussed the roadmap.",
      fileContentHash: RAW, ingestConfigHash: "config", maxChunkBytes: 10_000,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].metadata.frontmatter.attendees).toBe("Priya Patel, Sarah Chen");
  });

  it("accepts a single-element array the same way, indistinguishable from a bare scalar", () => {
    const result = chunkSourceText({
      relativePath: "solo.md",
      text: "---\nattendees: [Priya Patel]\n---\n# Standup\nbody",
      fileContentHash: RAW, ingestConfigHash: "config", maxChunkBytes: 10_000,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.chunks[0].metadata.frontmatter.attendees).toBe("Priya Patel");
  });

  it("accepts an empty array value", () => {
    const result = chunkSourceText({
      relativePath: "empty-array.md",
      text: "---\nattendees: []\n---\n# Standup\nbody",
      fileContentHash: RAW, ingestConfigHash: "config", maxChunkBytes: 10_000,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.chunks[0].metadata.frontmatter.attendees).toBe("");
  });

  it("leaves tags' own dedicated bracket handling completely unchanged", () => {
    const result = chunkSourceText({
      relativePath: "tagged.md",
      text: "---\ntags: [work, urgent]\nattendees: [Priya Patel, Sarah Chen]\n---\n# Standup\nbody",
      fileContentHash: RAW, ingestConfigHash: "config", maxChunkBytes: 10_000,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.chunks[0].metadata.tags).toEqual(["urgent", "work"]); // canonicalized sort order
    expect(result.chunks[0].metadata.frontmatter.attendees).toBe("Priya Patel, Sarah Chen");
    expect(result.chunks[0].metadata.frontmatter).not.toHaveProperty("tags"); // stays its own top-level field
  });

  it("preserves a quoted bracketed scalar as a literal scalar, not a one-item list (review fix, Codex P2 finding 2)", () => {
    const draftTitle = chunkSourceText({
      relativePath: "draft.md",
      text: '---\ntitle: "[Draft]"\n---\n# Notes\nbody',
      fileContentHash: RAW, ingestConfigHash: "config", maxChunkBytes: 10_000,
    });
    expect(draftTitle.diagnostics).toEqual([]);
    // Before the fix: quote-stripping ran first, exposing "[Draft]" to the list check, which
    // parsed it as ["Draft"] and stored the bare word "Draft" — silently dropping the brackets that
    // were part of the actual title and changing this file's content fingerprint.
    expect(draftTitle.chunks[0].metadata.frontmatter.title).toBe("[Draft]");

    const adrAlias = chunkSourceText({
      relativePath: "adr.md",
      text: "---\nalias: '[ADR-42]'\n---\n# Notes\nbody",
      fileContentHash: RAW, ingestConfigHash: "config", maxChunkBytes: 10_000,
    });
    expect(adrAlias.diagnostics).toEqual([]);
    expect(adrAlias.chunks[0].metadata.frontmatter.alias).toBe("[ADR-42]");

    // An actual (unquoted) flow sequence for the same shape of key is unaffected — still a real list.
    const realList = chunkSourceText({
      relativePath: "real-list.md",
      text: "---\naliases: [ADR-42, ADR-43]\n---\n# Notes\nbody",
      fileContentHash: RAW, ingestConfigHash: "config", maxChunkBytes: 10_000,
    });
    expect(realList.diagnostics).toEqual([]);
    expect(realList.chunks[0].metadata.frontmatter.aliases).toBe("ADR-42, ADR-43");
  });

  it("rejects an implicit flow-mapping entry inside a list, keeping the fail-closed contract (review fix, Codex P2 finding 3)", () => {
    // `[name: Priya]` is a flow sequence containing a mapping entry without braces — genuinely
    // nested, not a flat scalar. Before the fix this silently ingested as the literal string
    // "name: Priya" instead of being diagnosed and skipped.
    const implicitMap = chunkSourceText({
      relativePath: "implicit-map.md",
      text: "---\nattendees: [name: Priya]\n---\n# Standup\nbody",
      fileContentHash: RAW, ingestConfigHash: "config", maxChunkBytes: 10_000,
    });
    expect(implicitMap.diagnostics).toEqual([expect.objectContaining({ code: "invalid-frontmatter", relativePath: "implicit-map.md" })]);

    // Same shape, later in a multi-item list — still caught.
    const implicitMapMidList = chunkSourceText({
      relativePath: "implicit-map-2.md",
      text: "---\nattendees: [Priya Patel, name: Sarah]\n---\n# Standup\nbody",
      fileContentHash: RAW, ingestConfigHash: "config", maxChunkBytes: 10_000,
    });
    expect(implicitMapMidList.diagnostics).toEqual([expect.objectContaining({ code: "invalid-frontmatter", relativePath: "implicit-map-2.md" })]);

    // A QUOTED item containing a colon-space is unambiguous — never a mapping indicator, still a
    // legitimate scalar list item (e.g. a meeting note literally named "Standup: kickoff").
    const quotedColon = chunkSourceText({
      relativePath: "quoted-colon.md",
      text: '---\ntopics: ["Standup: kickoff", "Retro: Q3"]\n---\n# Notes\nbody',
      fileContentHash: RAW, ingestConfigHash: "config", maxChunkBytes: 10_000,
    });
    expect(quotedColon.diagnostics).toEqual([]);
    expect(quotedColon.chunks[0].metadata.frontmatter.topics).toBe("Standup: kickoff, Retro: Q3");

    // A colon with no following space/end-of-item (e.g. a URL-ish or timestamp-ish token) is not a
    // mapping indicator and stays a normal scalar list item.
    const colonNoSpace = chunkSourceText({
      relativePath: "colon-no-space.md",
      text: "---\nrefs: [issue:123, issue:456]\n---\n# Notes\nbody",
      fileContentHash: RAW, ingestConfigHash: "config", maxChunkBytes: 10_000,
    });
    expect(colonNoSpace.diagnostics).toEqual([]);
    expect(colonNoSpace.chunks[0].metadata.frontmatter.refs).toBe("issue:123, issue:456");
  });

  it("still diagnoses a genuinely nested value (single-line array of objects) the same way as before", () => {
    // chunkSourceText's own contract on a frontmatter diagnostic is unchanged by this fix: it
    // still reports the diagnostic and still falls back to chunking the RAW (unparsed) lines as
    // body text — the per-file EXCLUSION from a source's ingested corpus is the scanner's job
    // (scanSourceSnapshot / source-scanner.ts), asserted below at that layer, matching this file's
    // OTHER "invalid-frontmatter" case (nested.md) at the same layer.
    const result = chunkSourceText({
      relativePath: "bad-attendees.md",
      text: "---\nattendees: [{name: Priya}, {name: Sarah}]\n---\n# Standup\nbody",
      fileContentHash: RAW, ingestConfigHash: "config", maxChunkBytes: 10_000,
    });
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "invalid-frontmatter", relativePath: "bad-attendees.md" })]);
  });

  it("still diagnoses a mismatched bracket the same way as before", () => {
    const result = chunkSourceText({
      relativePath: "mismatched.md",
      text: "---\nattendees: [Priya Patel, Sarah Chen\n---\n# Standup\nbody",
      fileContentHash: RAW, ingestConfigHash: "config", maxChunkBytes: 10_000,
    });
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "invalid-frontmatter", relativePath: "mismatched.md" })]);
  });

  it("still rejects a block scalar and a duplicate key exactly as before (unaffected code paths)", () => {
    const blockScalar = chunkSourceText({
      relativePath: "block.md",
      text: "---\nnotes: |\n  multi\n  line\n---\n# Standup\nbody",
      fileContentHash: RAW, ingestConfigHash: "config", maxChunkBytes: 10_000,
    });
    expect(blockScalar.diagnostics).toEqual([expect.objectContaining({ code: "invalid-frontmatter", relativePath: "block.md" })]);

    const duplicateKey = chunkSourceText({
      relativePath: "dup.md",
      text: "---\nattendees: [Priya]\nattendees: [Sarah]\n---\n# Standup\nbody",
      fileContentHash: RAW, ingestConfigHash: "config", maxChunkBytes: 10_000,
    });
    expect(duplicateKey.diagnostics).toEqual([expect.objectContaining({ code: "invalid-frontmatter", relativePath: "dup.md" })]);
  });
});

describe("frontmatter array tolerance — scanSourceSnapshot (synced output)", () => {
  const roots: string[] = [];
  function root(): string {
    const path = mkdtempSync(join(tmpdir(), "monet-frontmatter-array-"));
    roots.push(path);
    return path;
  }
  function put(rootPath: string, relativePath: string, content: string): void {
    const parent = relativePath.split("/").slice(0, -1).join("/");
    if (parent) mkdirSync(join(rootPath, parent), { recursive: true });
    writeFileSync(join(rootPath, relativePath), content);
  }
  afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

  it("ingests an array-of-scalars frontmatter file into the synced output, alongside a genuinely-invalid file that still skips", () => {
    const dir = root();
    put(dir, "meeting.md", "---\nattendees: [Priya Patel, Sarah Chen]\n---\n# Standup\nDiscussed the roadmap.\n");
    put(dir, "nested.md", "---\nowner:\n  name: docs\n---\n# Body\ntext\n");
    const result = scanSourceSnapshot({ root: dir, config: { include: ["*.md"] } });
    expect(result.status).toBe("complete");
    expect(result.publishable).toBe(true);
    // The array-frontmatter file is present — this is the incident this fix closes: it used to be
    // silently absent here even though scan/sync otherwise reported healthy.
    expect(result.files.map((f) => f.relativePath)).toEqual(["meeting.md"]);
    expect(result.chunks.map((c) => c.relativePath)).toEqual(["meeting.md"]);
    // The genuinely nested file is unaffected: still skipped, still diagnosed, never a scan failure.
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "invalid-frontmatter", relativePath: "nested.md" })]);
  });

  it("still skips a file with a genuinely nested frontmatter value (array of objects), never a sync failure", () => {
    const dir = root();
    put(dir, "good.md", "# Fine\nordinary body\n");
    put(dir, "bad-attendees.md", "---\nattendees: [{name: Priya}, {name: Sarah}]\n---\n# Standup\nbody\n");
    const result = scanSourceSnapshot({ root: dir, config: { include: ["*.md"] } });
    expect(result.status).toBe("complete"); // a skip is a diagnosed exclusion, never a scan failure
    expect(result.publishable).toBe(true);
    expect(result.files.map((f) => f.relativePath)).toEqual(["good.md"]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "invalid-frontmatter", relativePath: "bad-attendees.md" })]);
  });

  it("ingests array-valued frontmatter for several distinct non-tags keys in the same file", () => {
    const dir = root();
    put(
      dir, "standup.md",
      "---\nattendees: [Priya Patel, Sarah Chen]\nparticipants: [Alex, Jordan]\ntags: [standup, weekly]\n---\n# Notes\nbody\n",
    );
    const result = scanSourceSnapshot({ root: dir, config: { include: ["*.md"] } });
    expect(result.diagnostics).toEqual([]);
    expect(result.files.map((f) => f.relativePath)).toEqual(["standup.md"]);
    expect(result.chunks[0].metadata.frontmatter).toMatchObject({
      attendees: "Priya Patel, Sarah Chen", participants: "Alex, Jordan",
    });
    expect(result.chunks[0].metadata.tags).toEqual(["standup", "weekly"]);
  });
});
