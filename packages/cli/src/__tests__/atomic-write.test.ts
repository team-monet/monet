import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteFile } from "../atomic-write";

describe("atomic-write: FIX 5 (Codex round 2 on PR #42) — atomic write-then-rename, never truncate-in-place", () => {
  const dirs: string[] = [];
  const mkTmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "monet-fix5-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("a successful write leaves NO .tmp sibling behind, and the target has exactly the new content", () => {
    const dir = mkTmp();
    const targetPath = join(dir, "settings.local.json");
    writeFileSync(targetPath, "ORIGINAL CONTENT");

    atomicWriteFile(targetPath, "NEW CONTENT", 0o644);

    expect(readFileSync(targetPath, "utf8")).toBe("NEW CONTENT");
    const entries = readdirSync(dir);
    expect(entries).toEqual(["settings.local.json"]); // no stray .tmp sibling
    expect(statSync(targetPath).mode & 0o777).toBe(0o644);
  });

  it("a FAILED write (target directory not writable — the tmp file can never be created) leaves the ORIGINAL file's content completely untouched, never truncated", () => {
    const dir = mkTmp();
    const targetPath = join(dir, "settings.local.json");
    writeFileSync(targetPath, "ORIGINAL CONTENT — MUST SURVIVE");
    // Directory write bit removed: creating a NEW entry (the tmp file) in it now fails, while the
    // EXISTING target file's own content is untouched by this chmod alone.
    chmodSync(dir, 0o555);
    try {
      expect(() => atomicWriteFile(targetPath, "NEW CONTENT THAT MUST NEVER LAND")).toThrow();
    } finally {
      chmodSync(dir, 0o755); // restore so afterEach's rmSync can clean up
    }
    // THE ATOMICITY PROOF: a write that never completed the tmp-then-rename sequence must never
    // have touched the original — a truncate-in-place write, by contrast, would have destroyed
    // "ORIGINAL CONTENT" the moment it opened the file for writing, before the failure even
    // registered.
    expect(readFileSync(targetPath, "utf8")).toBe("ORIGINAL CONTENT — MUST SURVIVE");
  });
});
