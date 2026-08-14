/**
 * The gate journal.
 *
 * THE PROPERTY EVERY TEST HERE IS ABOUT: normal silence and broken silence must stop being
 * indistinguishable. The incident behind it — a gate surface invoked-but-inert for
 * months, byte-identical to health throughout, because the mechanism that declined left no trace.
 * So the assertions below care far more about the events written when NOTHING happened than about
 * the ones written when a rule fired.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore } from "../engine";
import {
  GATE_JOURNAL_CONTEXT_MAX_CHARS,
  GATE_JOURNAL_MAX_BYTES,
  appendGateJournalLine,
  clipActionContext,
} from "../gate-journal";

const dirs: string[] = [];
const mkTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "monet-gate-journal-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface JournalLine {
  v: number;
  phase: "arrival" | "disposition";
  id: string;
  at: string;
  mouth: string;
  disposition?: string;
  claimType: string;
  ruleIds?: string[];
  stageIds?: string[];
  stageNames?: string[];
  actionContext?: string;
  stage?: string;
  enforced?: boolean;
  error?: string;
}

/**
 * Gate-family events only. A declaration with patterns now also leaves a `declare-check` pair (Codex
 * P2 on PR #144), and these tests are about the gate's own mouths — filtering keeps each test's
 * subject its own.
 */
function readJournal(path: string): JournalLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JournalLine)
    .filter((line) => line.mouth !== "declare-check");
}

/** A store with one blocking rule bound to one stage, and a journal sink. */
async function coreWithRule(journalPath: string | null): Promise<{ core: MonetCore; ruleId: string }> {
  const core = new MonetCore(":memory:", {
    defaultCircle: "acme-widgets",
    ...(journalPath === null ? {} : { gateJournalPath: journalPath }),
  });
  const declared = await core.declare({
    species: "rule", stage: "git force push", patterns: ["Bash:git push --force"],
    content: "Never force-push to main.", severity: "blocking", scope: "domain",
    reason: "a rewritten history cannot be recovered from a teammate's clone",
    circle: "acme-widgets",
  });
  return { core, ruleId: (declared as { conceptId: string }).conceptId };
}

describe("gate journal: the sink is opt-in", () => {
  // Same discipline gateSidecarPath holds, for the same reason: with a default, every MonetCore
  // ever constructed — tests, evals, one-off scripts — would append into the user's real store.
  it("writes nothing at all when no path is configured", async () => {
    const dir = mkTmp();
    const { core } = await coreWithRule(null);
    core.gate({ actionContext: "Bash:git push --force" });
    core.gate({ actionContext: "Bash:ls" });
    core.close();
    expect(readJournal(join(dir, "gate-journal.jsonl"))).toEqual([]);
  });
});

describe("gate journal: core-gate mouth", () => {
  it("writes an arrival AND a disposition, sharing one id", async () => {
    const path = join(mkTmp(), "gate-journal.jsonl");
    const { core } = await coreWithRule(path);
    core.gate({ actionContext: "Bash:git push --force" });
    core.close();

    const lines = readJournal(path);
    expect(lines).toHaveLength(2);
    expect(lines[0].phase).toBe("arrival");
    expect(lines[1].phase).toBe("disposition");
    // The correlation that makes the pair one story — and makes a LONE arrival a finding.
    expect(lines[1].id).toBe(lines[0].id);
    expect(lines.every((line) => line.mouth === "core-gate")).toBe(true);
    expect(lines[0].actionContext).toBe("Bash:git push --force");
  });

  it("names the rule ids delivered — the field #62's never-fired query needs", async () => {
    const path = join(mkTmp(), "gate-journal.jsonl");
    const { core, ruleId } = await coreWithRule(path);
    core.gate({ actionContext: "Bash:git push --force" });
    core.close();

    const disposition = readJournal(path)[1];
    expect(disposition.disposition).toBe("deny");
    // gate_events has recorded rule_COUNT since it was built, which cannot answer "did THIS rule
    // ever fire". Identity is the whole query.
    expect(disposition.ruleIds).toEqual([ruleId]);
    expect(disposition.stageNames).toEqual(["git force push"]);
    expect(disposition.claimType).toBe("source-observed");
  });

  /**
   * THE LOAD-BEARING TEST. An action nothing governs produces no signal to any agent — by design,
   * and that stays true. What must ALSO be true after this slice is that it produces an event.
   * Before it, "no rule matched" and "the gate was never reached" were the same observable, which
   * is precisely how §0's surface stayed dark.
   */
  it("records silence as an event, so that ABSENCE of an event means something", async () => {
    const path = join(mkTmp(), "gate-journal.jsonl");
    const { core } = await coreWithRule(path);
    const result = core.gate({ actionContext: "Bash:git status --short" });
    core.close();

    expect(result.silence).toBe(true); // the agent-facing signal is unchanged: nothing is delivered
    const lines = readJournal(path);
    expect(lines).toHaveLength(2);
    expect(lines[1].disposition).toBe("silent");
    expect(lines[1].ruleIds).toEqual([]);
    expect(lines[1].stageIds).toEqual([]);
  });

  it("keeps stage-hit-no-rules distinct from silence, exactly as GateResult does", async () => {
    const path = join(mkTmp(), "gate-journal.jsonl");
    const core = new MonetCore(":memory:", { defaultCircle: "acme-widgets", gateJournalPath: path });
    // A stage with a pattern and no rule bound to it: the projection hook, not an absence.
    await core.declare({ species: "stage", stage: "bare stage", patterns: ["Bash:terraform apply"] });
    core.gate({ actionContext: "Bash:terraform apply" });
    core.close();

    expect(readJournal(path)[1].disposition).toBe("stage-hit-no-rules");
  });

  it("journals a throw as a decline and re-throws unchanged — the journal observes, never participates", async () => {
    const path = join(mkTmp(), "gate-journal.jsonl");
    const { core } = await coreWithRule(path);
    // "*" is the query wildcard and is refused as a gate circle (assertQueryableCircle).
    expect(() => core.gate({ actionContext: "Bash:ls", circle: "*" })).toThrow();
    core.close();

    const lines = readJournal(path);
    expect(lines).toHaveLength(2);
    expect(lines[1].disposition).toBe("declined: internal-error");
    // "we could not know", never a verdict: nothing was evaluated.
    expect(lines[1].claimType).toBe("unavailable");
    expect(lines[1].error).toBeTruthy();
  });
});

describe("gate journal: stage-lookup mouth (the advisory path)", () => {
  it("journals a hit with its rule ids, and marks that nothing was enforced", async () => {
    const path = join(mkTmp(), "gate-journal.jsonl");
    const { core, ruleId } = await coreWithRule(path);
    core.stageLookup({ stage: "git force push" });
    core.close();

    const lines = readJournal(path).filter((line) => line.mouth === "stage-lookup");
    expect(lines).toHaveLength(2);
    expect(lines[1].ruleIds).toEqual([ruleId]);
    // The severity is blocking and it was DELIVERED, not acted on. A conformance pass that read
    // this as an enforcement would be reading an act that never happened.
    expect(lines[1].disposition).toBe("deny");
    expect(lines[1].enforced).toBe(false);
  });

  // The honest limit, recorded as such: this witnesses an agent naming a stage that does not
  // exist. It says nothing about moments no agent recognized at all — nothing can.
  it("journals a miss as declined: stage-miss", async () => {
    const path = join(mkTmp(), "gate-journal.jsonl");
    const { core } = await coreWithRule(path);
    core.stageLookup({ stage: "a stage nobody ever declared" });
    core.close();

    const lines = readJournal(path).filter((line) => line.mouth === "stage-lookup");
    expect(lines[1].disposition).toBe("declined: stage-miss");
    expect(lines[1].stageIds).toEqual([]);
  });
});

describe("gate journal: an action context is bounded, never reproduced", () => {
  /**
   * FOUND BY MEASUREMENT, and this test exists so it is never re-found. The first build recorded
   * the action context verbatim, and a real run produced a single 12 MB journal line — structural
   * rather than unlucky, because the overflow outcome exists PRECISELY for enormous contexts, so
   * the one disposition guaranteed to carry a monster payload was the one writing it to disk whole.
   */
  it("clips a monster context and keeps its identity by hash", () => {
    const huge = `Bash:echo ${"A".repeat(5 * 1024 * 1024)}`;
    const clipped = clipActionContext(huge) as Record<string, unknown>;
    expect((clipped.actionContext as string).length).toBe(GATE_JOURNAL_CONTEXT_MAX_CHARS);
    expect(clipped.actionContextClipped).toBe(true);
    expect(clipped.actionContextChars).toBe(huge.length); // the true size survives
    // Identity survives clipping: two events over the same action are still provably the same one.
    expect(clipped.actionContextSha256).toBe(clipActionContext(huge).actionContextSha256);
    expect(JSON.stringify(clipped).length).toBeLessThan(4096);
  });

  // The common case pays nothing — no hash, no extra fields, byte-identical to before the bound.
  it("leaves an ordinary context exactly as it is", () => {
    expect(clipActionContext("Bash:git status --short")).toEqual({ actionContext: "Bash:git status --short" });
  });

  it("bounds the line a real gate evaluation writes, end to end", async () => {
    const path = join(mkTmp(), "gate-journal.jsonl");
    const { core } = await coreWithRule(path);
    core.gate({ actionContext: `Bash:echo ${"A".repeat(2 * 1024 * 1024)}` });
    core.close();
    const longest = Math.max(...readFileSync(path, "utf8").split("\n").map((line) => line.length));
    expect(longest).toBeLessThan(8192);
  });
});

describe("gate journal: the append itself", () => {
  it("creates the file 0600 and never widens it", () => {
    const path = join(mkTmp(), "gate-journal.jsonl");
    appendGateJournalLine(path, { v: 1, phase: "arrival" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("rotates one generation at the cap, so the file is bounded rather than unbounded", () => {
    const path = join(mkTmp(), "gate-journal.jsonl");
    writeFileSync(path, "x".repeat(GATE_JOURNAL_MAX_BYTES), { mode: 0o600 });
    appendGateJournalLine(path, { v: 1, phase: "arrival", marker: "after-rotation" });

    expect(existsSync(`${path}.prev`)).toBe(true);
    expect(statSync(`${path}.prev`).size).toBe(GATE_JOURNAL_MAX_BYTES);
    // The rotation happened BEFORE the append, so the cap is a ceiling and not a threshold this
    // write was allowed to blow past.
    expect(readFileSync(path, "utf8").trim()).toContain("after-rotation");
  });

  // Recording is a duty owed to the record, never to the user's action. An unwritable journal must
  // never surface as a thrown error in an evaluation path.
  it("swallows an unwritable path rather than throwing into the caller", () => {
    expect(() => appendGateJournalLine(join(mkTmp(), "no", "such", "dir", "j.jsonl"), { v: 1 })).not.toThrow();
  });

  it("is a no-op on a null path, at zero cost", () => {
    expect(() => appendGateJournalLine(null, { v: 1 })).not.toThrow();
  });
});
