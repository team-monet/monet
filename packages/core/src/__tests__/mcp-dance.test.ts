import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore } from "../engine";

/**
 * The agent-as-Synthesizer dance (ADR §4.6) at the engine level — what the MCP
 * memory_fetch → (agent writes body) → memory_synthesize round-trip drives:
 */
describe("agent-driven synthesis (the MCP dance)", () => {
  it("fetch without auto-synthesis flags needsSynthesis + returns raw evidence", async () => {
    const core = new MonetCore(":memory:");
    const a = await core.store("We use SQLite for Monet Local storage.");
    await core.store("Monet Local stores its data in SQLite.");

    const raw = (await core.getConcept(a.conceptId, { synthesize: false }))!;
    expect(raw.needsSynthesis).toBe(true); // dirty, not auto-cleaned
    expect(raw.synthesizedNow).toBe(false); // the engine did NOT synthesize
    expect(raw.observations).toHaveLength(2); // the agent gets the evidence to work from
    core.close();
  });

  it("applySynthesis writes the agent's body back and clears dirty", async () => {
    const core = new MonetCore(":memory:");
    const a = await core.store("We use SQLite for Monet Local storage.");
    await core.store("Monet Local stores its data in SQLite.");

    const updated = (await core.applySynthesis(
      a.conceptId,
      "Monet Local persists memory in a local SQLite database.",
    ))!;
    expect(updated.dirty).toBe(false);
    expect(updated.body).toContain("SQLite");

    const after = (await core.getConcept(a.conceptId, { synthesize: false }))!;
    expect(after.needsSynthesis).toBe(false); // clean now
    expect(after.revisions).toBe(1); // the synthesis was recorded
    core.close();
  });

  it("listDirty surfaces concepts + evidence for batch synthesis (checkpoint)", async () => {
    const core = new MonetCore(":memory:");
    await core.store("We use SQLite for storage.");
    await core.store("The team prefers pytest for testing.");
    const dirty = core.listDirty();
    expect(dirty).toHaveLength(2);
    expect(dirty[0].observations.length).toBeGreaterThan(0);
    core.close();
  });
});

/**
 * The MCP server resolves `circle ?? core.getDefaultCircle()` for every tool, so a single shared
 * store (one global ~/.monet) isolates per project when each runtime sets its own default circle.
 */
describe("default circle — per-project isolation in a shared store", () => {
  it("getDefaultCircle returns the configured circle (else 'default')", () => {
    const a = new MonetCore(":memory:", { defaultCircle: "proj-a" });
    expect(a.getDefaultCircle()).toBe("proj-a");
    a.close();
    const d = new MonetCore(":memory:");
    expect(d.getDefaultCircle()).toBe("default");
    d.close();
  });

  it("two projects sharing one store don't see each other's memory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-circle-"));
    const dbPath = join(dir, "monet.db");
    try {
      // Each runtime stores into its own default circle (what the MCP server does on a circle-less call).
      const a = new MonetCore(dbPath, { defaultCircle: "proj-a" });
      await a.store("Project A standardized on SQLite.", { circle: a.getDefaultCircle() });
      a.close();
      const b = new MonetCore(dbPath, { defaultCircle: "proj-b" });
      await b.store("Project B standardized on Postgres.", { circle: b.getDefaultCircle() });
      b.close();
      // Same physical DB, but each project's concept lives only in its own circle.
      const verify = new MonetCore(dbPath);
      expect(verify.conceptCount("proj-a")).toBe(1);
      expect(verify.conceptCount("proj-b")).toBe(1);
      expect(verify.conceptCount("default")).toBe(0);
      verify.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
