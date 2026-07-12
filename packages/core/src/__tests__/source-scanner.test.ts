import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SOURCE_CHUNKER_VERSION,
  chunkSourceText,
  computeSourceContentHash,
  computeSourceOperationId,
} from "../source-chunker";
import {
  DEFAULT_SOURCE_SCANNER_LIMITS,
  SOURCE_SCANNER_VERSION,
  computeSourceManifestHash,
  effectiveSourceScanConfig,
  matchesSourceGlob,
  scanSourceSnapshot,
} from "../source-scanner";

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "monet-source-scanner-"));
  roots.push(path);
  return path;
}

function put(rootPath: string, relativePath: string, content: string | Uint8Array): void {
  const parent = relativePath.split("/").slice(0, -1).join("/");
  if (parent) mkdirSync(join(rootPath, parent), { recursive: true });
  writeFileSync(join(rootPath, relativePath), content);
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("source scanner configuration and glob semantics", () => {
  it("unions the exact curated auto-detection set, keeps explicit includes, and installs default excludes", () => {
    const config = effectiveSourceScanConfig({
      autoDetect: true,
      include: ["handbook/**/*.md"],
      exclude: ["private/**"],
    });

    expect(config.include).toEqual([
      ".clinerules",
      ".cursor/rules/**",
      ".github/copilot-instructions.md",
      ".windsurf/**",
      "AGENTS.md",
      "CLAUDE.md",
      "GEMINI.md",
      "handbook/**/*.md",
    ]);
    expect(config.include).not.toContain("README.md");
    expect(config.include).not.toContain("docs/**/*.md");
    expect(config.exclude).toEqual(expect.arrayContaining([
      ".git/**",
      "build/**",
      "coverage/**",
      "dist/**",
      "node_modules/**",
      "private/**",
      "vendor/**",
    ]));
    expect(DEFAULT_SOURCE_SCANNER_LIMITS.maxChunkBytes).toBe(32 * 1024);
    expect(DEFAULT_SOURCE_SCANNER_LIMITS.maxEntries).toBe(100_000);
    expect(SOURCE_SCANNER_VERSION).toBe("v1");
    expect(SOURCE_CHUNKER_VERSION).toBe("v2");
  });

  it("matches conservative anchored POSIX globs with segment-aware **", () => {
    expect(matchesSourceGlob("docs/**/*.md", "docs/a.md")).toBe(true);
    expect(matchesSourceGlob("docs/**/*.md", "docs/deep/a.md")).toBe(true);
    expect(matchesSourceGlob("docs/*.md", "docs/deep/a.md")).toBe(false);
    expect(matchesSourceGlob("*.md", "prefix/a.md")).toBe(false);
    expect(matchesSourceGlob("vendor/**", "vendor")).toBe(true);
    expect(matchesSourceGlob("vendor/**", "vendor/deep/a.md")).toBe(true);
  });

  it("allows an explicit empty selection as a complete empty snapshot without auto-detect", () => {
    const dir = root();
    put(dir, "README.md", "not implicitly selected");
    const result = scanSourceSnapshot({ root: dir, config: { autoDetect: false, include: [], exclude: [] } });
    expect(result).toMatchObject({ status: "complete", publishable: true, files: [], chunks: [], diagnostics: [] });
  });

  it("applies excludes after the union so excluded auto-detected paths cannot leak in", () => {
    const dir = root();
    put(dir, "AGENTS.md", "# Hidden\nno");
    put(dir, "CLAUDE.md", "# Kept\nyes");
    put(dir, "README.md", "# Not auto\nno");
    const result = scanSourceSnapshot({
      root: dir,
      config: { autoDetect: true, include: [], exclude: ["AGENTS.md"] },
    });
    expect(result.files.map((file) => file.relativePath)).toEqual(["CLAUDE.md"]);
  });
});

describe("source scanner deterministic bytes and parsing", () => {
  it("orders POSIX paths by UTF-8 bytes and hashes raw bytes with the exact content domain", () => {
    const dir = root();
    put(dir, "z.md", "z");
    put(dir, "ä.md", "unicode");
    put(dir, "A.md", "abc");
    const result = scanSourceSnapshot({ root: dir, config: { include: ["*.md"] } });

    expect(result.files.map((file) => file.relativePath)).toEqual(["A.md", "z.md", "ä.md"]);
    expect(result.files[0].contentHash).toBe(
      "monet-src-content/v1:sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    // Vector locks bytewise record ordering and direct length framing of path/type/content fields.
    expect(result.manifestHash).toBe(
      "monet-src-manifest/v1:sha256:63d802411e0c7287e83b43e4225a04de677754bdf0a70c15625b93ee6422c23e",
    );
  });

  it("produces the same manifest across creation order and changes it on a raw path/type/content record change", () => {
    const first = root();
    const second = root();
    put(first, "b.md", "B\r\n");
    put(first, "a.md", "A\n");
    put(second, "a.md", "A\n");
    put(second, "b.md", "B\r\n");
    const one = scanSourceSnapshot({ root: first, config: { include: ["*.md"] } });
    const two = scanSourceSnapshot({ root: second, config: { include: ["*.md"] } });
    expect(one.manifestHash).toBe(two.manifestHash);

    put(second, "b.md", "B\n");
    const changed = scanSourceSnapshot({ root: second, config: { include: ["*.md"] } });
    expect(changed.manifestHash).not.toBe(one.manifestHash);
    expect(changed.chunks.find((chunk) => chunk.relativePath === "b.md")!.body).toBe("B");
    expect(one.chunks.find((chunk) => chunk.relativePath === "b.md")!.body).toBe("B");
    expect(computeSourceManifestHash([...one.files].reverse())).toBe(one.manifestHash);
  });

  it("keeps global bytewise order when a sibling file sorts before a directory subtree", () => {
    const dir = root();
    put(dir, "a/file.md", "nested");
    put(dir, "a.md", "sibling");
    put(dir, "a0.md", "later");
    const result = scanSourceSnapshot({ root: dir, config: { include: ["**/*.md"] } });
    expect(result.files.map((file) => file.relativePath)).toEqual(["a.md", "a/file.md", "a0.md"]);
  });

  it("keeps BOM, CRLF, and LF encodings distinct in raw file hashes while LF-normalizing parsed bodies", () => {
    const dir = root();
    put(dir, "bom.md", Buffer.from("\uFEFF# Topic\r\nbody\r\n", "utf8"));
    put(dir, "crlf.md", "# Topic\r\nbody\r\n");
    put(dir, "lf.md", "# Topic\nbody\n");
    const result = scanSourceSnapshot({ root: dir, config: { include: ["*.md"] } });
    expect(new Set(result.files.map((file) => file.contentHash)).size).toBe(3);
    expect(result.chunks.map((chunk) => chunk.body)).toEqual(["body", "body", "body"]);
  });

  it("extracts flat metadata, ATX hierarchy and occurrence while ignoring headings inside fences", () => {
    const dir = root();
    put(dir, "guide.md", [
      "---",
      "scope: repository",
      "tags: [zeta, alpha, zeta]",
      "owner: docs",
      "---",
      "Preamble.",
      "# Parent",
      "first",
      "```md",
      "# Not a heading",
      "```",
      "## Child",
      "one",
      "## Child",
      "two",
      "# Parent",
      "three",
    ].join("\r\n"));
    const result = scanSourceSnapshot({ root: dir, config: { include: ["guide.md"] } });

    expect(result).toMatchObject({ status: "complete", publishable: true, diagnostics: [] });
    expect(result.chunks.map((chunk) => [chunk.headingPath, chunk.occurrence, chunk.segmentIndex])).toEqual([
      [[], 1, 1],
      [["Parent"], 1, 1],
      [["Parent", "Child"], 1, 1],
      [["Parent", "Child"], 2, 1],
      [["Parent"], 2, 1],
    ]);
    expect(result.chunks[1].body).toContain("# Not a heading");
    expect(result.chunks[1].metadata).toEqual({
      tags: ["alpha", "zeta"],
      scope: "repository",
      frontmatter: { owner: "docs" },
    });
    expect(result.chunks[2].sourceRef).toBe("guide.md#parent%2Fchild~1");
    expect(result.chunks[3].sourceRef).toBe("guide.md#parent%2Fchild~2");
  });

  it("uses heading-level refs and separate one-based identities for bounded segments", () => {
    const result = chunkSourceText({
      relativePath: "notes/a.md",
      text: "# Topic\nalpha beta\n\ngamma delta",
      fileContentHash: computeSourceContentHash(Buffer.from("raw")),
      ingestConfigHash: "config",
      maxChunkBytes: 12,
    });
    expect(result.complete).toBe(true);
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks.map((chunk) => chunk.segmentIndex)).toEqual(
      Array.from({ length: result.chunks.length }, (_, index) => index + 1),
    );
    expect(new Set(result.chunks.map((chunk) => chunk.sourceRef))).toEqual(new Set([
      "notes/a.md#topic~1",
    ]));
    expect(new Set(result.chunks.map((chunk) => chunk.ingestFingerprint)).size).toBe(result.chunks.length);
    expect(result.chunks.every((chunk) => Buffer.byteLength(chunk.body) <= 12)).toBe(true);
  });

  it("fails closed when an indivisible fenced block exceeds the inclusive chunk budget", () => {
    const result = chunkSourceText({
      relativePath: "code.md",
      text: "# Code\n```ts\nconst answer = 42;\n```",
      fileContentHash: computeSourceContentHash(Buffer.from("raw")),
      ingestConfigHash: "config",
      maxChunkBytes: 16,
    });
    expect(result.complete).toBe(false);
    expect(result.chunks).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "chunk-budget-exceeded" })]);
  });

  it("bounds chunk cardinality before materializing an unbounded split", () => {
    const result = chunkSourceText({
      relativePath: "tiny.md",
      text: "abcdef",
      fileContentHash: computeSourceContentHash(Buffer.from("abcdef")),
      ingestConfigHash: "config",
      maxChunkBytes: 1,
      maxChunks: 3,
    });
    expect(result).toMatchObject({ complete: false, chunks: [] });
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "chunk-budget-exceeded" })]);

    const dir = root();
    put(dir, "a.md", "a");
    put(dir, "b.md", "b");
    const scan = scanSourceSnapshot({ root: dir, config: { include: ["*.md"], limits: { maxChunks: 1 } } });
    expect(scan).toMatchObject({ status: "partial", publishable: false });
    expect(scan.chunks).toHaveLength(1);
    expect(scan.diagnostics).toEqual([expect.objectContaining({ code: "chunk-budget-exceeded", relativePath: "b.md" })]);
  });

  it("cooperatively stops while parsing instead of merely observing the deadline afterward", () => {
    let checks = 0;
    const result = chunkSourceText({
      relativePath: "large.md",
      text: Array.from({ length: 1_000 }, (_, index) => `line ${index}`).join("\n"),
      fileContentHash: computeSourceContentHash(Buffer.from("raw")),
      ingestConfigHash: "config",
      maxChunkBytes: 32 * 1024,
      deadlineExceeded: () => ++checks > 20,
    });
    expect(result.complete).toBe(false);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "parse-time-exceeded" })]);
    expect(checks).toBeLessThan(100);
  });

  it("marks invalid UTF-8 and unsupported nested frontmatter partial and unpublishable", () => {
    const invalidUtf8 = root();
    put(invalidUtf8, "bad.md", Uint8Array.from([0xc3, 0x28]));
    const badText = scanSourceSnapshot({ root: invalidUtf8, config: { include: ["bad.md"] } });
    expect(badText).toMatchObject({ status: "partial", publishable: false });
    expect(badText.files).toHaveLength(1);
    expect(badText.diagnostics).toEqual([expect.objectContaining({ code: "invalid-utf8" })]);

    const nested = root();
    put(nested, "nested.md", "---\nowner:\n  name: docs\n---\n# Body\ntext");
    const badMetadata = scanSourceSnapshot({ root: nested, config: { include: ["nested.md"] } });
    expect(badMetadata).toMatchObject({ status: "partial", publishable: false });
    expect(badMetadata.diagnostics).toEqual([expect.objectContaining({ code: "invalid-frontmatter" })]);
  });
});

describe("source scanner resource and filesystem boundaries", () => {
  it("treats every configured maximum as inclusive", () => {
    const dir = root();
    put(dir, "a.md", "abc");
    const exact = scanSourceSnapshot({
      root: dir,
      config: {
        include: ["a.md"],
        limits: { maxFiles: 1, maxFileBytes: 3, maxTotalBytes: 3, maxParseMs: 10, maxChunkBytes: 3 },
      },
      now: () => 10,
    });
    expect(exact).toMatchObject({ status: "complete", publishable: true });
    expect(exact.chunks[0].body).toBe("abc");
  });

  it.each([
    ["files", { maxFiles: 0 }, "file-budget-exceeded"],
    ["file bytes", { maxFileBytes: 2 }, "file-too-large"],
    ["total bytes", { maxTotalBytes: 2 }, "file-budget-exceeded"],
  ])("returns a partial snapshot after exceeding the %s budget", (_label, limits, code) => {
    const dir = root();
    put(dir, "a.md", "abc");
    const result = scanSourceSnapshot({ root: dir, config: { include: ["a.md"], limits } });
    expect(result).toMatchObject({ status: "partial", publishable: false });
    expect(result.diagnostics).toEqual([expect.objectContaining({ code })]);
  });

  it("accepts elapsed == maxParseMs and rejects elapsed > maxParseMs", () => {
    const dir = root();
    put(dir, "a.md", "abc");
    const clock = (values: number[]): (() => number) => {
      let index = 0;
      return () => values[Math.min(index++, values.length - 1)];
    };
    expect(scanSourceSnapshot({
      root: dir,
      config: { include: ["a.md"], limits: { maxParseMs: 10 } },
      now: clock([0, 10, 10]),
    }).status).toBe("complete");
    const exceeded = scanSourceSnapshot({
      root: dir,
      config: { include: ["a.md"], limits: { maxParseMs: 10 } },
      now: clock([0, 11]),
    });
    expect(exceeded.status).toBe("partial");
    expect(exceeded.diagnostics[0].code).toBe("parse-time-exceeded");
  });

  it("does not enumerate a huge directory when maxFiles is zero", () => {
    const dir = root();
    for (let index = 0; index < 2_000; index++) put(dir, `many/${String(index).padStart(4, "0")}.md`, "x");
    let clockReads = 0;
    const result = scanSourceSnapshot({
      root: dir,
      config: { include: ["**/*.md"], limits: { maxFiles: 0 } },
      now: () => { clockReads++; return 0; },
    });
    expect(result).toMatchObject({ status: "partial", publishable: false, files: [] });
    expect(result.diagnostics[0].code).toBe("file-budget-exceeded");
    expect(clockReads).toBe(1);
  });

  it("bounds unselected traversal with maxEntries and checks deadlines during enumeration", () => {
    const dir = root();
    for (let index = 0; index < 50; index++) put(dir, `many/${String(index).padStart(3, "0")}.txt`, "x");
    const bounded = scanSourceSnapshot({
      root: dir,
      config: { include: ["**/*.md"], limits: { maxEntries: 10 } },
    });
    expect(bounded).toMatchObject({ status: "partial", publishable: false, files: [] });
    expect(bounded.diagnostics[0].code).toBe("entry-budget-exceeded");

    let time = 0;
    const deadline = scanSourceSnapshot({
      root: dir,
      config: { include: ["**/*.md"], limits: { maxParseMs: 3 } },
      now: () => time++,
    });
    expect(deadline).toMatchObject({ status: "partial", publishable: false });
    expect(deadline.diagnostics[0].code).toBe("parse-time-exceeded");
  });

  it("fails closed if a selected file grows during a bounded chunked read", () => {
    const dir = root();
    put(dir, "growing.md", Buffer.alloc(96 * 1024, 0x61));
    let clockReads = 0;
    const result = scanSourceSnapshot({
      root: dir,
      config: {
        include: ["growing.md"],
        limits: { maxFileBytes: 128 * 1024, maxTotalBytes: 128 * 1024, maxChunkBytes: 128 * 1024 },
      },
      now: () => {
        clockReads++;
        if (clockReads === 7) writeFileSync(join(dir, "growing.md"), Buffer.alloc(1024 * 1024, 0x62), { flag: "a" });
        return 0;
      },
    });
    expect(result).toMatchObject({ status: "partial", publishable: false, files: [] });
    expect(result.diagnostics[0].code).toBe("toctou-rejected");
  });

  it("fails closed if a directory is replaced by a symlink between enumeration and descent", () => {
    const dir = root();
    const outside = root();
    put(dir, "docs/inside.md", "inside");
    put(outside, "outside.md", "outside");
    const moved = join(dir, "docs-original");
    let clockReads = 0;
    const result = scanSourceSnapshot({
      root: dir,
      config: { include: ["docs/**/*.md"] },
      now: () => {
        clockReads++;
        if (clockReads === 6) {
          renameSync(join(dir, "docs"), moved);
          symlinkSync(outside, join(dir, "docs"));
        }
        return 0;
      },
    });
    expect(result).toMatchObject({ status: "partial", publishable: false, files: [] });
    expect(result.diagnostics[0]).toEqual(expect.objectContaining({ code: "toctou-rejected", relativePath: "docs" }));
  });

  it("never follows selected symlinks, skips unselected symlinks, rejects symlink roots, and prunes defaults", () => {
    const dir = root();
    const outside = root();
    put(outside, "secret.md", "secret");
    symlinkSync(join(outside, "secret.md"), join(dir, "linked.md"));
    symlinkSync(join(outside, "secret.md"), join(dir, "unselected.txt"));
    mkdirSync(join(dir, "node_modules"));
    symlinkSync(join(outside, "secret.md"), join(dir, "node_modules", "ignored.md"));
    const result = scanSourceSnapshot({ root: dir, config: { include: ["linked.md", "docs/**/*.md"] } });
    expect(result).toMatchObject({ status: "partial", publishable: false, files: [] });
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "symlink-rejected", relativePath: "linked.md" })]);

    const linkedRoot = join(root(), "linked-root");
    symlinkSync(outside, linkedRoot);
    expect(scanSourceSnapshot({ root: linkedRoot, config: { include: ["**/*.md"] } })).toMatchObject({
      status: "partial",
      publishable: false,
      diagnostics: [expect.objectContaining({ code: "root-escape-rejected" })],
    });
  });

  it("rejects a symlink that can hide selected descendants while leaving an unrelated symlink silent", () => {
    const dir = root();
    const outside = root();
    put(outside, "inside.md", "outside");
    symlinkSync(outside, join(dir, "docs"));
    symlinkSync(outside, join(dir, "unrelated"));
    const result = scanSourceSnapshot({ root: dir, config: { include: ["docs/**/*.md"] } });
    expect(result).toMatchObject({ status: "partial", publishable: false, files: [] });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "symlink-rejected", relativePath: "docs" }),
    ]);
  });

  it("fails closed after a transient root replacement is restored during ordering", () => {
    const dir = root();
    put(dir, "a.md", "a");
    put(dir, "b.md", "b");
    put(dir, "c.md", "c");
    const moved = `${dir}-original`;
    let calls = 0;
    const result = scanSourceSnapshot({
      root: dir,
      config: { include: ["*.md"] },
      now: () => {
        calls++;
        if (calls === 7) {
          renameSync(dir, moved);
          mkdirSync(dir);
        } else if (calls === 8) {
          rmSync(dir, { recursive: true, force: true });
          renameSync(moved, dir);
        }
        return 0;
      },
    });
    expect(result).toMatchObject({ status: "partial", publishable: false });
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "toctou-rejected" })]);
  });

  it("fails closed when a selected path is replaced while its open descriptor is read", () => {
    const dir = root();
    put(dir, "a.md", "original");
    let clockCalls = 0;
    const result = scanSourceSnapshot({
      root: dir,
      config: { include: ["a.md"] },
      now: () => {
        clockCalls++;
        if (clockCalls === 6) {
          rmSync(join(dir, "a.md"));
          put(dir, "a.md", "replacement");
        }
        return 0;
      },
    });
    expect(result).toMatchObject({ status: "partial", publishable: false, files: [] });
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "toctou-rejected", relativePath: "a.md" })]);
  });
});

describe("source hash domains", () => {
  it("length-frames operation fields and binding generation in the exact monet-src-op/v2 domain", () => {
    const operation = computeSourceOperationId("source-a", "binding-a", "fingerprint-a", "snapshot-a", 1);
    expect(operation).toMatch(/^monet-src-op\/v2:sha256:[0-9a-f]{64}$/);
    expect(operation).not.toBe(computeSourceOperationId("source", "a-binding-a", "fingerprint-a", "snapshot-a", 1));
    expect(operation).not.toBe(computeSourceOperationId("source-a", "binding-a", "fingerprint", "a-snapshot-a", 1));
    expect(operation).not.toBe(computeSourceOperationId("source-a", "binding-a", "fingerprint-a", "snapshot-a", 2));
  });

  it("changes only the edited sibling fingerprint while keeping natural identity out of it", () => {
    const base = {
      text: "# A\nalpha\n# B\nbravo",
      fileContentHash: computeSourceContentHash(Buffer.from("same raw file")),
      ingestConfigHash: "same-config",
      maxChunkBytes: 100,
    };
    const first = chunkSourceText({ ...base, relativePath: "a.md" }).chunks;
    const moved = chunkSourceText({ ...base, relativePath: "moved.md" }).chunks;
    expect(first.map((chunk) => chunk.ingestFingerprint)).toEqual(moved.map((chunk) => chunk.ingestFingerprint));
    expect(first[0].sourceRef).not.toBe(moved[0].sourceRef);
    const edited = chunkSourceText({
      ...base,
      relativePath: "a.md",
      text: "# A\nalpha edited\n# B\nbravo",
      fileContentHash: computeSourceContentHash(Buffer.from("edited raw file")),
    }).chunks;
    expect(edited[0].ingestFingerprint).not.toBe(first[0].ingestFingerprint);
    expect(edited[1].ingestFingerprint).toBe(first[1].ingestFingerprint);
    const changedConfig = chunkSourceText({ ...base, relativePath: "a.md", ingestConfigHash: "changed" }).chunks;
    expect(changedConfig[0].ingestFingerprint).not.toBe(first[0].ingestFingerprint);
  });

  it("gives slug-colliding exact heading vectors distinct refs without changing content fingerprints on move", () => {
    const base = {
      text: "# A!\nsame\n# a?\nsame",
      fileContentHash: computeSourceContentHash(Buffer.from("raw")),
      ingestConfigHash: "config",
      maxChunkBytes: 100,
    };
    const first = chunkSourceText({ ...base, relativePath: "a.md" }).chunks;
    const moved = chunkSourceText({ ...base, relativePath: "moved.md" }).chunks;
    expect(first.map((chunk) => chunk.sourceRef)).toEqual(["a.md#a~1", "a.md#a~2"]);
    expect(first.map((chunk) => chunk.ingestFingerprint)).toEqual(moved.map((chunk) => chunk.ingestFingerprint));
    expect(first.map((chunk) => chunk.sourceRef)).not.toEqual(moved.map((chunk) => chunk.sourceRef));
  });
});
