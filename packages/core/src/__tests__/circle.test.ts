import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MonetCore } from "../engine";
import { deriveCircle } from "../circle";

describe("deriveCircle", () => {
  it("derives a stable, non-empty folder-name circle from the working tree", () => {
    const c = deriveCircle(process.cwd());
    expect(c).toBeTruthy();
    expect(c).not.toContain("/"); // a folder name, not a path
  });

  it("falls back to the cwd folder name outside a git repo", () => {
    expect(deriveCircle(join(tmpdir(), "some-project-xyz"))).toBe("some-project-xyz");
  });
});

describe("circleOf — the id scope-enforcement primitive", () => {
  it("returns a concept's circle, or null for unknown ids", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "proj-a" });
    const a = await core.store("A durable fact about the project."); // lands in proj-a (the default circle)
    expect(core.circleOf(a.conceptId)).toBe("proj-a");
    expect(core.circleOf("does-not-exist")).toBeNull();
    core.close();
  });
});
