/**
 * THE DECLARE-TIME FIRING TEST — monet-client#59:
 * "a pattern is admitted with at least one example action context it matches, verified at declare
 * time by the same evaluator the gate runs."
 *
 * THE EVALUATOR IS NOW THE ONLY ONE. The mechanical matcher that intercepted actions was removed
 * 2026-08-22, so there is no second firing path to disagree with this check. What the two
 * end-to-end tests below still close is the other half of the same loop: the check validates the
 * pattern `seedTriggerPattern` WOULD store, and they re-run the matcher against the pattern that
 * was ACTUALLY stored on the row.
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
import { matchesTriggerPattern, parseActionContext } from "../gates";
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

  // The check validates the pattern `seedTriggerPattern` WOULD store; this asserts the pattern
  // actually PERSISTED on the row matches the same context, so a check that passed cannot be
  // followed by a stored pattern that does not match — end to end rather than by inspection.
  it("agrees with the stored pattern: one that passes here matches when read back", async () => {
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

    const context = parseActionContext("Task:verifier confirm the migration path");
    const stored = core.stages().find((stage) => stage.name === "worker delegation")!;
    // The rule really is bound at that stage, and the stage's own stored pattern really matches.
    expect(core.stageLookup({ stage: "worker delegation" }).rules.map((rule) => rule.conceptId))
      .toContain((result as { conceptId: string }).conceptId);
    core.close();
    expect(stored.patterns.some((pattern) => matchesTriggerPattern(pattern, context))).toBe(true);
  });

  // ...and the converse, which is the property that actually protects anyone: the check's warning
  // is not pessimism, the stored pattern really does fail to match.
  it("agrees with the stored pattern: one that fails here matches nothing when read back", async () => {
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

    const context = parseActionContext("Task:verifier confirm the migration path");
    const stored = core.stages().find((stage) => stage.name === "worker delegation")!;
    core.close();
    // Exactly what the advisory predicted: nothing this stage stores matches that context.
    expect(stored.patterns.some((pattern) => matchesTriggerPattern(pattern, context))).toBe(false);
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
   * zero-yield noise the residency law exists to prevent.
   */
  it("says nothing when no example was supplied — silence is not an oversight here", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme" });
    const result = await core.declare({
      species: "stage", stage: "git force push", patterns: ["Bash:git push --force"],
    });
    core.close();
    expect(kinds(result)).toEqual([]);
  });

});
