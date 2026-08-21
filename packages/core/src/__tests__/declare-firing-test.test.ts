/**
 * THE DECLARE-TIME FIRING TEST — monet-client#59:
 * "a pattern is admitted with at least one example action context it matches, verified at declare
 * time by the same evaluator the gate runs."
 *
 * The trap it exists to catch, in the design's own words: "a `Bash:` pattern can never match a
 * `Task:` context — and after §0, tool names are known to be host variables, not constants."
 * Before this check, such a pattern was accepted in silence and simply never fired, which is the
 * same shape as the incident the whole document is a response to.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore } from "../engine";
import type { DeclareAdvisory } from "../engine";

const dirs: string[] = [];
const mkTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "monet-firing-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function advisoriesOf(result: unknown): DeclareAdvisory[] {
  return ((result as { advisories?: DeclareAdvisory[] }).advisories ?? []);
}
function kinds(result: unknown): string[] {
  return advisoriesOf(result).map((advisory) => advisory.kind);
}

describe("declare-time firing test: the tool-prefix trap", () => {
  /**
   * THE CASE THE DESIGN NAMES BY NAME. An author means to govern delegation, and writes the
   * pattern with the tool prefix they are used to. The example they supply is a real delegation
   * context. The two can never match, and until now nothing said so.
   */
  it("catches a Bash: pattern declared against a Task: example", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme" });
    const result = await core.declare({
      species: "stage",
      stage: "worker delegation",
      patterns: ["Bash:verifier"],
      instance: "Task:verifier confirm the migration path",
    });
    core.close();

    expect(kinds(result)).toContain("pattern_matches_no_example");
    const message = advisoriesOf(result).find((a) => a.kind === "pattern_matches_no_example")!.message;
    expect(message).toContain("Task:verifier confirm the migration path");
    expect(message).toContain("tool prefix");
  });

  it("stays silent when the pattern DOES match its example", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme" });
    const result = await core.declare({
      species: "stage",
      stage: "worker delegation",
      patterns: ["Task:verifier"],
      instance: "Task:verifier confirm the migration path",
    });
    core.close();
    expect(kinds(result)).toEqual([]);
  });

  // The check must use the SAME matcher the gate fires with, or it could pass on a pattern the gate
  // then fails to fire — a worse lie than no check. Asserted end to end rather than by inspection:
  // the declaration passes the firing test, and the real gate then really fires on that context.
  it("agrees with the gate itself: a pattern that passes here fires there", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme" });
    const result = await core.declare({
      species: "rule",
      stage: "worker delegation",
      patterns: ["Task:verifier"],
      instance: "Task:verifier confirm the migration path",
      content: "Name the lens before delegating verification.",
      severity: "advisory", scope: "domain",
      reason: "an unlensed verification returns agreement, not proof",
      circle: "acme",
    });
    expect(kinds(result)).toEqual([]);

    const fired = core.gate({ actionContext: "Task:verifier confirm the migration path" });
    core.close();
    expect(fired.silence).toBe(false);
    expect(fired.rules.map((rule) => rule.conceptId)).toContain((result as { conceptId: string }).conceptId);
  });

  // ...and the converse, which is the property that actually protects anyone: the check's warning
  // is not pessimism, the gate really does stay silent.
  it("agrees with the gate itself: a pattern that fails here fires nowhere", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme" });
    const result = await core.declare({
      species: "rule",
      stage: "worker delegation",
      patterns: ["Bash:verifier"],
      instance: "Task:verifier confirm the migration path",
      content: "Name the lens before delegating verification.",
      severity: "advisory", scope: "domain",
      reason: "an unlensed verification returns agreement, not proof",
      circle: "acme",
    });
    expect(kinds(result)).toContain("pattern_matches_no_example");

    const fired = core.gate({ actionContext: "Task:verifier confirm the migration path" });
    core.close();
    expect(fired.silence).toBe(true); // exactly what the advisory predicted
  });
});

describe("declare-time firing test: inert patterns need no example", () => {
  // A run of nothing but flags seeds to an empty token list, which matchesTriggerPattern refuses
  // unconditionally. Knowable as pure FORM — no example, no judgment about content.
  it("flags a pattern that can never match anything at all", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme" });
    const result = await core.declare({ species: "stage", stage: "flags only", patterns: ["--force"] });
    core.close();
    expect(kinds(result)).toContain("pattern_never_matches");
  });
});

describe("declare-time firing test: sovereignty, and rationing", () => {
  /**
   * WARNED, NEVER REFUSED. `patterns` is reachable from the declaration entrance alone, where
   * sovereignty replaces the battery — so the write lands, and the author is told. This asserts the
   * write really did land, because a check that quietly swallowed a declaration would be a far
   * worse failure than the one it is preventing.
   */
  it("writes the declaration anyway — the warning never becomes a refusal", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme" });
    const result = await core.declare({
      species: "stage", stage: "worker delegation",
      patterns: ["Bash:verifier"], instance: "Task:verifier confirm",
    });
    expect(kinds(result)).toContain("pattern_matches_no_example");
    // The stage exists, with the patterns as declared.
    const stages = core.stages();
    core.close();
    expect(stages.some((stage) => stage.name === "worker delegation")).toBe(true);
  });

  /**
   * RATIONED. "Patterns given, no example" is deliberately NOT advised: it would fire on nearly
   * every pattern declaration ever made, and an advisory that fires every time is the unrationed,
   * zero-yield noise the residency law exists to prevent. That signal already has two homes —
   * gateCoverage().unverifiedPatterns.
   */
  it("says nothing when no example was supplied — silence is not an oversight here", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme" });
    const result = await core.declare({
      species: "stage", stage: "git force push", patterns: ["Bash:git push --force"],
    });
    core.close();
    expect(kinds(result)).toEqual([]);
  });

  /**
   * DOES NOT COUNTERFEIT `verified`. That flag means "these patterns matched a REAL action at least
   * once", and a real fire proves a HOST produced that context; an author's example proves only
   * that they wrote a matching string. The Agent: trap is precisely a pair of matching fictions.
   */
  it("leaves the stage unverified even when the example matches", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme" });
    await core.declare({
      species: "stage", stage: "worker delegation",
      patterns: ["Task:verifier"], instance: "Task:verifier confirm the path",
    });
    const stage = core.stages().find((s) => s.name === "worker delegation")!;
    core.close();
    expect(stage.verified).toBe(false);
  });
});
