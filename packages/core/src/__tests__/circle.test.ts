import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MonetCore } from "../engine";
import { deriveCircle } from "../circle";

describe("deriveCircle", () => {
  it("derives a stable, non-empty circle from the working tree", () => {
    const c = deriveCircle(process.cwd());
    expect(c).toBeTruthy();
    expect(c).not.toContain("/"); // a circle name, not a path
    expect(deriveCircle(process.cwd())).toBe(c); // stable across calls
  });

  it("keeps same-named folders in DIFFERENT paths in different circles", () => {
    const a = deriveCircle(join(tmpdir(), "client-a", "api"));
    const b = deriveCircle(join(tmpdir(), "client-b", "api"));
    expect(a).toMatch(/^api-[0-9a-f]{8}$/);
    expect(b).toMatch(/^api-[0-9a-f]{8}$/);
    expect(a).not.toBe(b); // the path-hash suffix disambiguates
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

describe("checkpoint / listDirty honor defaultCircle", () => {
  it("an omitted circle scopes to the default circle, not all circles", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "proj-a" });
    await core.store("A dirty fact in proj-a."); // default circle = proj-a
    await core.store("A dirty fact in proj-b.", { circle: "proj-b" });
    expect(core.listDirty()).toHaveLength(1); // no circle → proj-a only (not both)
    expect(core.listDirty("proj-b")).toHaveLength(1); // an explicit circle still scopes elsewhere
    core.close();
  });
});
