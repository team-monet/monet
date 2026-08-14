import { describe, expect, it } from "vitest";
import {
  MIN_SOURCE_SECTION_BYTES,
  chunkSourceText,
  computeSourceContentHash,
  deriveSourceFileTitle,
} from "../source-chunker";

const RAW = computeSourceContentHash(Buffer.from("raw"));

describe("minimum-chunk merge pass", () => {
  it("forward-merges an undersized section into the next section's identity", () => {
    const big = "y".repeat(MIN_SOURCE_SECTION_BYTES);
    const result = chunkSourceText({
      relativePath: "a.md",
      text: `# Small\ntiny\n# Big\n${big}`,
      fileContentHash: RAW,
      ingestConfigHash: "config",
      maxChunkBytes: 10_000,
    });
    expect(result.complete).toBe(true);
    // "Small" (4-byte body) is undersized and has no prior section to fall back into — it
    // forward-merges into "Big", which keeps its own identity per the docstring.
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].headingPath).toEqual(["Big"]);
    expect(result.chunks[0].occurrence).toBe(1);
    expect(result.chunks[0].body).toContain("tiny");
    expect(result.chunks[0].body).toContain(big);
  });

  it("backward-merges a trailing undersized section at EOF into the previous section's identity", () => {
    const big = "y".repeat(MIN_SOURCE_SECTION_BYTES);
    const result = chunkSourceText({
      relativePath: "a.md",
      text: `# Big\n${big}\n# Small\ntiny`,
      fileContentHash: RAW,
      ingestConfigHash: "config",
      maxChunkBytes: 10_000,
    });
    expect(result.complete).toBe(true);
    // "Small" is the trailing undersized run at EOF: no next section exists, so it merges
    // BACKWARD into "Big" instead, which keeps ITS identity (not "Small"'s).
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].headingPath).toEqual(["Big"]);
    expect(result.chunks[0].body).toContain(big);
    expect(result.chunks[0].body).toContain("tiny");
  });

  it("cascades a run of consecutive undersized sections forward until the accumulation clears the minimum", () => {
    const big = "y".repeat(MIN_SOURCE_SECTION_BYTES);
    const result = chunkSourceText({
      relativePath: "a.md",
      text: `# One\nALPHA_MARK\n# Two\nBETA_MARK\n# Three\nGAMMA_MARK\n# Big\n${big}`,
      fileContentHash: RAW,
      ingestConfigHash: "config",
      maxChunkBytes: 10_000,
    });
    expect(result.complete).toBe(true);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].headingPath).toEqual(["Big"]);
    const body = result.chunks[0].body;
    // All three tiny bodies survived the cascade, in original file order, ahead of Big's own text.
    expect(body.indexOf("ALPHA_MARK")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("ALPHA_MARK")).toBeLessThan(body.indexOf("BETA_MARK"));
    expect(body.indexOf("BETA_MARK")).toBeLessThan(body.indexOf("GAMMA_MARK"));
    expect(body.indexOf("GAMMA_MARK")).toBeLessThan(body.indexOf(big));
  });

  it("keeps an undersized section standalone when merging forward would exceed maxChunkBytes", () => {
    const near = "y".repeat(70);
    const result = chunkSourceText({
      relativePath: "a.md",
      text: `# A\n${near}\n# B\n${near}`,
      fileContentHash: RAW,
      ingestConfigHash: "config",
      // 70 + 1 (blank separator) + 70 = 141 > 100: combining A and B busts the cap, so each is
      // emitted standalone despite both being under MIN_SOURCE_SECTION_BYTES.
      maxChunkBytes: 100,
    });
    expect(result.complete).toBe(true);
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0]).toMatchObject({ headingPath: ["A"], segmentIndex: 1 });
    expect(result.chunks[1]).toMatchObject({ headingPath: ["B"], segmentIndex: 1 });
  });

  it("treats MIN_SOURCE_SECTION_BYTES as an inclusive floor", () => {
    const atFloor = "y".repeat(MIN_SOURCE_SECTION_BYTES);
    const clearsFloor = chunkSourceText({
      relativePath: "a.md",
      text: `# A\n${atFloor}\n# B\n${atFloor}`,
      fileContentHash: RAW,
      ingestConfigHash: "config",
      maxChunkBytes: 10_000,
    });
    // Each section independently sits AT the floor (>=), so neither merges into the other.
    expect(clearsFloor.chunks.map((chunk) => chunk.headingPath)).toEqual([["A"], ["B"]]);

    const underFloor = "y".repeat(MIN_SOURCE_SECTION_BYTES - 1);
    const missesFloor = chunkSourceText({
      relativePath: "a.md",
      text: `# A\n${underFloor}\n# B\n${atFloor}`,
      fileContentHash: RAW,
      ingestConfigHash: "config",
      maxChunkBytes: 10_000,
    });
    // A is exactly one byte under the floor: forward-merges into B, adopting B's identity.
    expect(missesFloor.chunks.map((chunk) => chunk.headingPath)).toEqual([["B"]]);
  });

  it("never merges a file's only section away, no matter how small", () => {
    const result = chunkSourceText({
      relativePath: "a.md",
      text: "# Lonely\nhi",
      fileContentHash: RAW,
      ingestConfigHash: "config",
      maxChunkBytes: 10_000,
    });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].headingPath).toEqual(["Lonely"]);
    expect(result.chunks[0].body).toBe("hi");
  });

  it("never merges away a headingless file's sole root section", () => {
    const result = chunkSourceText({
      relativePath: "a.md",
      text: "just prose, no heading at all",
      fileContentHash: RAW,
      ingestConfigHash: "config",
      maxChunkBytes: 10_000,
    });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].headingPath).toEqual([]);
  });

  it("never treats a horizontal rule as a section boundary, merge pass or not", () => {
    const big = "y".repeat(MIN_SOURCE_SECTION_BYTES);
    const result = chunkSourceText({
      relativePath: "a.md",
      text: `# Section\n${big}\n\n---\n\nmore after the rule`,
      fileContentHash: RAW,
      ingestConfigHash: "config",
      maxChunkBytes: 10_000,
    });
    expect(result.complete).toBe(true);
    // "---" opened no new heading/section, so there was nothing for the merge pass to consider —
    // one section in, one chunk out.
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].headingPath).toEqual(["Section"]);
    expect(result.chunks[0].body).toContain("---");
    expect(result.chunks[0].body).toContain("more after the rule");

    // A horizontal rule contributes ordinary bytes toward its section's merge-pass size — no
    // special-casing (docstring: "nothing here special-cases fences" — same holds for rules).
    const withRuleSmall = chunkSourceText({
      relativePath: "a.md",
      text: `# Tiny\n---\n# Big\n${big}`,
      fileContentHash: RAW,
      ingestConfigHash: "config",
      maxChunkBytes: 10_000,
    });
    expect(withRuleSmall.chunks).toHaveLength(1);
    expect(withRuleSmall.chunks[0].headingPath).toEqual(["Big"]);
    expect(withRuleSmall.chunks[0].body).toContain("---");
  });

  it("merges a lone undersized fenced code block into its neighbor exactly like undersized prose", () => {
    const big = "y".repeat(MIN_SOURCE_SECTION_BYTES);
    const result = chunkSourceText({
      relativePath: "a.md",
      text: `# Snippet\n\`\`\`js\nx();\n\`\`\`\n# Big\n${big}`,
      fileContentHash: RAW,
      ingestConfigHash: "config",
      maxChunkBytes: 10_000,
    });
    expect(result.complete).toBe(true);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].headingPath).toEqual(["Big"]);
    expect(result.chunks[0].body).toContain("```js");
    expect(result.chunks[0].body).toContain("x();");
  });

  it("emits a lone undersized fence standalone when merging would exceed maxChunkBytes, never splitting it", () => {
    const result = chunkSourceText({
      relativePath: "a.md",
      text: `# Snippet\n\`\`\`js\nx();\n\`\`\`\n# Big\n${"y".repeat(90)}`,
      fileContentHash: RAW,
      ingestConfigHash: "config",
      // Fence body alone (~14 bytes) fits; fence + Big (~14 + 2 + 90) doesn't.
      maxChunkBytes: 95,
    });
    expect(result.complete).toBe(true);
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0].headingPath).toEqual(["Snippet"]);
    expect(result.chunks[0].body).toBe("```js\nx();\n```");
    expect(result.chunks[1].headingPath).toEqual(["Big"]);
  });
});

describe("document order", () => {
  it("orders documentSequence by true file position, never lexicographic heading order", () => {
    const filler = "y".repeat(MIN_SOURCE_SECTION_BYTES);
    const result = chunkSourceText({
      relativePath: "a.md",
      text: `# Zebra\n${filler}\n# Apple\n${filler}`,
      fileContentHash: RAW,
      ingestConfigHash: "config",
      maxChunkBytes: 10_000,
    });
    expect(result.chunks.map((chunk) => chunk.headingPath)).toEqual([["Zebra"], ["Apple"]]);
    expect(result.chunks.map((chunk) => chunk.documentSequence)).toEqual([1, 2]);
  });

  it("increments documentSequence per emitted chunk, including multiple bounded segments within one section", () => {
    const result = chunkSourceText({
      relativePath: "notes/a.md",
      text: "# Topic\nalpha beta\n\ngamma delta",
      fileContentHash: RAW,
      ingestConfigHash: "config",
      maxChunkBytes: 12,
    });
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks.map((chunk) => chunk.documentSequence)).toEqual(
      Array.from({ length: result.chunks.length }, (_, index) => index + 1),
    );
    // Every bounded segment shares the same heading identity but a strictly increasing sequence.
    expect(new Set(result.chunks.map((chunk) => chunk.headingPath.join("/")))).toEqual(new Set(["Topic"]));
  });

  it("keeps documentSequence 1-based and contiguous across a merge that drops earlier section identities", () => {
    const big = "y".repeat(MIN_SOURCE_SECTION_BYTES);
    const result = chunkSourceText({
      relativePath: "a.md",
      text: `# One\ntiny\n# Two\n${big}\n# Three\n${big}`,
      fileContentHash: RAW,
      ingestConfigHash: "config",
      maxChunkBytes: 10_000,
    });
    // "One" merges into "Two"; the surviving two chunks are still sequenced 1, 2 (never 2, 3 —
    // sequence numbers are assigned at emission time, post-merge, not inherited from raw sections).
    expect(result.chunks.map((chunk) => chunk.headingPath)).toEqual([["Two"], ["Three"]]);
    expect(result.chunks.map((chunk) => chunk.documentSequence)).toEqual([1, 2]);
  });
});

describe("deriveSourceFileTitle", () => {
  it("uses the frontmatter title, trimmed, when present and non-blank", () => {
    expect(deriveSourceFileTitle("  My Title  ", "docs/guide.md")).toBe("My Title");
  });

  it("falls back to the filename minus extension when frontmatter title is null", () => {
    expect(deriveSourceFileTitle(null, "docs/guide.md")).toBe("guide");
  });

  it("falls back to the filename minus extension when frontmatter title is blank or whitespace-only", () => {
    expect(deriveSourceFileTitle("   ", "docs/guide.md")).toBe("guide");
    expect(deriveSourceFileTitle("", "docs/guide.md")).toBe("guide");
  });

  it("uses the basename only, stripping any directory prefix", () => {
    expect(deriveSourceFileTitle(null, "a/b/c/README.md")).toBe("README");
  });

  it("strips only the final extension, keeping earlier dots in the basename", () => {
    expect(deriveSourceFileTitle(null, "notes/v1.2.draft.md")).toBe("v1.2.draft");
  });

  it("keeps a dotfile's name intact when its only dot is the leading one", () => {
    expect(deriveSourceFileTitle(null, ".clinerules")).toBe(".clinerules");
    expect(deriveSourceFileTitle(null, "docs/.mdc")).toBe(".mdc");
  });
});

describe("frontmatterTitle resolution", () => {
  it("resolves frontmatterTitle to null when there is no frontmatter", () => {
    const result = chunkSourceText({
      relativePath: "a.md",
      text: "# Heading\nbody",
      fileContentHash: RAW,
      ingestConfigHash: "config",
      maxChunkBytes: 10_000,
    });
    expect(result.frontmatterTitle).toBeNull();
  });

  it("resolves frontmatterTitle to null when frontmatter is present but has no title key", () => {
    const result = chunkSourceText({
      relativePath: "a.md",
      text: "---\nscope: repository\n---\n# Heading\nbody",
      fileContentHash: RAW,
      ingestConfigHash: "config",
      maxChunkBytes: 10_000,
    });
    expect(result.frontmatterTitle).toBeNull();
  });

  it("resolves frontmatterTitle even when the file has zero chunks (frontmatter-only, no trailing body)", () => {
    const result = chunkSourceText({
      relativePath: "a.md",
      text: "---\ntitle: Only Frontmatter\n---",
      fileContentHash: RAW,
      ingestConfigHash: "config",
      maxChunkBytes: 10_000,
    });
    expect(result.chunks).toHaveLength(0);
    expect(result.complete).toBe(true);
    expect(result.frontmatterTitle).toBe("Only Frontmatter");
    expect(deriveSourceFileTitle(result.frontmatterTitle, "a.md")).toBe("Only Frontmatter");
  });

  it("threads a present frontmatter title through to a chunked file's chunks unaffected", () => {
    const result = chunkSourceText({
      relativePath: "a.md",
      text: "---\ntitle: Guide Title\n---\n# Heading\nbody",
      fileContentHash: RAW,
      ingestConfigHash: "config",
      maxChunkBytes: 10_000,
    });
    expect(result.chunks).toHaveLength(1);
    expect(result.frontmatterTitle).toBe("Guide Title");
    expect(deriveSourceFileTitle(result.frontmatterTitle, "a.md")).toBe("Guide Title");
  });
});
