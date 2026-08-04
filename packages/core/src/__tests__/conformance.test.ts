/**
 * The conformance pass, cheap half — `normative-hierarchy-2026-08-03.md` §4 and §7.3.
 *
 * The property under test throughout is restraint: this half must claim exactly what the journal
 * observes and no more. §4 rejected the counterfactual reading of "changed the action" as
 * unobservable, and a pass that quietly reintroduced it — by guessing whether an advisory's act
 * complied — would be measuring nothing while reporting a number.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendConformanceAnnotations,
  computeConformance,
  retirementCandidates,
  tallyByRule,
} from "../conformance";
import type { JournalDispositionLine } from "../conformance";

const deny = (id: string, ruleIds: string[], actionContext: string): JournalDispositionLine =>
  ({ phase: "disposition", id, disposition: "deny", ruleIds, actionContext });
const advisory = (id: string, ruleIds: string[], actionContext: string): JournalDispositionLine =>
  ({ phase: "disposition", id, disposition: "advisory", ruleIds, actionContext });
const silent = (id: string, actionContext: string): JournalDispositionLine =>
  ({ phase: "disposition", id, disposition: "silent", ruleIds: [], actionContext });

describe("what the journal observes", () => {
  /**
   * The one class decidable with no judgment at all. The host's own contract is that a denied call
   * does not proceed, so "the act did not run as intercepted" is observed — §4's "modified or
   * abandoned". Note what is NOT claimed: that whatever the agent did instead went in the rule's
   * direction. That is judgment, and this pass does not assert it.
   */
  it("a deny is `changed`, on observed evidence", () => {
    const [annotation] = computeConformance([deny("e1", ["rule-a"], "Bash:git push --force")]);
    expect(annotation!.verdict).toBe("changed");
    expect(annotation!.claimType).toBe("source-observed");
    expect(annotation!.retriedUnchanged).toBe(false);
  });

  // The first honest signal that a deny is being fought rather than followed — and it needs no
  // transcript, because the gate sees the subsequent commands too (§7.3).
  it("records that a blocked act was retried unchanged", () => {
    const [annotation] = computeConformance([
      deny("e1", ["rule-a"], "Bash:git push --force"),
      silent("e2", "Bash:git status"),
      deny("e3", ["rule-a"], "Bash:git push --force"),
    ]);
    expect(annotation!.retriedUnchanged).toBe(true);
    expect(annotation!.reason).toContain("was fought");
  });

  /**
   * FOUND BY RUNNING IT. The core-gate mouth records the action context once, at the mouth, and its
   * disposition line carries stages and rule ids instead. Keying on the disposition alone produced
   * `retried: undefined` for every core-gate fire — a missing answer wearing the shape of a real
   * one, which is the failure mode this whole design exists to stop shipping.
   */
  it("finds the act on the ARRIVAL line when the disposition does not carry it", () => {
    const annotations = computeConformance([
      { phase: "arrival", id: "e1", actionContext: "Bash:git push --force" },
      { phase: "disposition", id: "e1", disposition: "deny", ruleIds: ["rule-a"] },
      { phase: "arrival", id: "e2", actionContext: "Bash:git push --force" },
      { phase: "disposition", id: "e2", disposition: "deny", ruleIds: ["rule-a"] },
    ]);
    expect(annotations[0]!.retriedUnchanged).toBe(true);
    expect(annotations[1]!.retriedUnchanged).toBe(false);
  });

  it("matches a clipped act by its hash, so a monster command is still recognisable", () => {
    const clipped = (id: string): JournalDispositionLine => ({
      phase: "disposition", id, disposition: "deny", ruleIds: ["rule-a"],
      actionContext: "Bash:echo AAAA", actionContextClipped: true, actionContextSha256: "abc123",
    });
    const [annotation] = computeConformance([clipped("e1"), clipped("e2")]);
    expect(annotation!.retriedUnchanged).toBe(true);
  });
});

describe("a deny that was never enforced is not one", () => {
  /**
   * CODEX P1 ON PR #144, and it was right. The stage-lookup mouth is advisory by design: it
   * journals `disposition: "deny"` because a blocking rule was DELIVERED, and marks
   * `enforced: false` because nothing was stopped. Reading that as an observed `changed` counts
   * acts that ran freely as acts the rule prevented — inflating the exact effectiveness measure
   * this pass exists to make honest.
   */
  it("treats a delivered-but-unenforced blocking rule as awaiting judgment, not as changed", () => {
    const [annotation] = computeConformance([
      { phase: "disposition", id: "e1", disposition: "deny", ruleIds: ["rule-a"], enforced: false, actionContext: "x" },
    ]);
    expect(annotation!.verdict).toBeUndefined();
    expect(annotation!.claimType).toBe("unavailable");
    expect(annotation!.reason).toContain("not enforced");
  });

  it("still counts an enforced deny as changed", () => {
    const [annotation] = computeConformance([deny("e1", ["rule-a"], "x")]);
    expect(annotation!.verdict).toBe("changed");
  });

  // Missing evidence must not become a negative observation — the pass's whole discipline.
  it("says retry status is unavailable when the act has no identity on the record", () => {
    const [annotation] = computeConformance([
      { phase: "disposition", id: "e1", disposition: "deny", ruleIds: ["rule-a"] }, // no actionContext anywhere
    ]);
    expect(annotation!.verdict).toBe("changed"); // the deny itself is still observed
    expect(annotation!.retriedUnchanged).toBeUndefined();
    expect(annotation!.reason).toContain("unavailable");
    expect(annotation!.reason).not.toContain("did not return unchanged");
  });
});

describe("one interception is not its own retry", () => {
  /**
   * CODEX P1 ON PR #144, and it was right. One interception is journaled by several mouths: the
   * host hook records it, and the gate it spawns records the same act again with the same action
   * key. Comparing act keys alone found the child after the parent and called it a retry — so every
   * ordinary hook-gated deny would have been written down as a rule that was fought. `parentId` is
   * on the wire for exactly this correlation.
   */
  it("does not read a child mouth's event as a retry of its parent's", () => {
    const annotations = computeConformance([
      { phase: "disposition", id: "hook-1", disposition: "deny", ruleIds: ["rule-a"], actionContext: "Bash:git push --force" },
      { phase: "disposition", id: "gate-1", parentId: "hook-1", disposition: "deny", ruleIds: ["rule-a"], actionContext: "Bash:git push --force" },
    ]);
    for (const annotation of annotations) {
      expect(annotation.retriedUnchanged, annotation.fireEventId).toBe(false);
    }
  });

  it("still sees a genuine retry — the same act through a different evaluation", () => {
    const [first] = computeConformance([
      { phase: "disposition", id: "hook-1", disposition: "deny", ruleIds: ["rule-a"], actionContext: "Bash:git push --force" },
      { phase: "disposition", id: "gate-1", parentId: "hook-1", disposition: "deny", ruleIds: ["rule-a"], actionContext: "Bash:git push --force" },
      { phase: "disposition", id: "hook-2", disposition: "deny", ruleIds: ["rule-a"], actionContext: "Bash:git push --force" },
    ]);
    expect(first!.retriedUnchanged).toBe(true);
  });
});

describe("a mixed-severity fire credits only the rules that blocked", () => {
  /**
   * CODEX P1 ON PR #144. One evaluation can match a blocking rule and an advisory one; the event is
   * a `deny` as a whole, and crediting `changed` to every id in it hands the advisory rules an
   * interception they had no part in.
   */
  it("scopes the verdict to the blocking ids and leaves the rest awaiting judgment", () => {
    const annotations = computeConformance([
      {
        phase: "disposition", id: "e1", disposition: "deny",
        ruleIds: ["blocking-a", "advisory-b"], blockingRuleIds: ["blocking-a"],
        actionContext: "Bash:git push --force",
      },
    ]);
    expect(annotations[0]!.verdict).toBe("changed");
    expect(annotations[0]!.verdictRuleIds).toEqual(["blocking-a"]);

    const byRule = Object.fromEntries(tallyByRule(annotations).map((t) => [t.ruleId, t]));
    expect(byRule["blocking-a"]!).toMatchObject({ fires: 1, changed: 1, awaitingJudgment: 0 });
    expect(byRule["advisory-b"]!).toMatchObject({ fires: 1, changed: 0, awaitingJudgment: 1 });
  });
});

describe("a chain is followed to its root, and a negative retry stays revisable", () => {
  /**
   * CODEX P1 ON PR #144. A three-deep interception — host-hook → gate-cli → core-gate — got the
   * grandchild its immediate parent while the parent got the root, so the two ends of ONE evaluation
   * carried different chain ids and their identical acts read as a retry. The one-hop version fixed
   * the two-mouth case and left the three-mouth case saying exactly what the fix was for.
   */
  it("does not read a grandchild as a retry of its root", () => {
    const annotations = computeConformance([
      { phase: "disposition", id: "hook", disposition: "deny", ruleIds: ["r"], actionContext: "Bash:x" },
      { phase: "disposition", id: "cli", parentId: "hook", disposition: "deny", ruleIds: ["r"], actionContext: "Bash:x" },
      { phase: "disposition", id: "core", parentId: "cli", disposition: "deny", ruleIds: ["r"], actionContext: "Bash:x" },
    ]);
    for (const annotation of annotations) {
      expect(annotation.retriedUnchanged, annotation.fireEventId).toBe(false);
    }
  });

  /**
   * CODEX P1 ON PR #144. A pass that ran before the retry arrived wrote `retriedUnchanged: false`
   * permanently, and idempotence guaranteed the newly observable retry could never reach the
   * record — so retry counts depended on when the pass happened to run.
   */
  it("upgrades a prior false to true when the retry becomes observable", () => {
    const first = computeConformance([deny("e1", ["r"], "Bash:x")]);
    expect(first[0]!.retriedUnchanged).toBe(false);

    const journalAfterFirstPass: JournalDispositionLine[] = [
      deny("e1", ["r"], "Bash:x"),
      { phase: "conformance", fireEventId: "e1", retriedUnchanged: false },
      deny("e2", ["r"], "Bash:x"), // the retry, arriving later
    ];
    const second = computeConformance(journalAfterFirstPass);
    const revisited = second.find((a) => a.fireEventId === "e1")!;
    expect(revisited.retriedUnchanged).toBe(true);
  });

  // Monotone, so it terminates: once true, a further pass has nothing to improve.
  it("does not re-annotate once the retry is already recorded", () => {
    const settled: JournalDispositionLine[] = [
      deny("e1", ["r"], "Bash:x"),
      { phase: "conformance", fireEventId: "e1", retriedUnchanged: true },
      deny("e2", ["r"], "Bash:x"),
      { phase: "conformance", fireEventId: "e2", retriedUnchanged: false },
    ];
    expect(computeConformance(settled).map((a) => a.fireEventId)).toEqual([]);
  });
});

describe("the pass stays linear over a journal near the cap", () => {
  // CODEX P1 ON PR #144, second time: keeping one entry per chain and scanning the accumulated array
  // went quadratic again whenever ONE command was denied over and over — the same defect wearing
  // different clothes. This is that shape specifically.
  it("stays linear when the SAME act is denied through thousands of distinct evaluations", () => {
    const lines: JournalDispositionLine[] = [];
    for (let i = 0; i < 20000; i++) lines.push(deny(`e${i}`, ["rule-a"], "Bash:git push --force"));
    const started = Date.now();
    const annotations = computeConformance(lines);
    expect(annotations).toHaveLength(20000);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  // CODEX P1 ON PR #144: the old shape sliced the remaining dispositions per deny and scanned them.
  // A deny-heavy journal near 64 MiB would have hung the curation turn this exists to serve.
  it("annotates 20k denies without quadratic blowup", () => {
    const lines: JournalDispositionLine[] = [];
    for (let i = 0; i < 20000; i++) lines.push(deny(`e${i}`, ["rule-a"], `Bash:cmd-${i}`));
    const started = Date.now();
    const annotations = computeConformance(lines);
    const elapsed = Date.now() - started;
    expect(annotations).toHaveLength(20000);
    // Generous by design — this asserts the ALGORITHM, not the machine. The quadratic form took
    // billions of comparisons here; anything near linear finishes far inside this.
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("what the journal cannot answer, recorded as unanswered", () => {
  /**
   * THE RESTRAINT THAT MATTERS. Nothing blocked an advisory, so the act ran as intercepted —
   * but whether it COMPLIED with what the rule says is the rule's meaning read against the act.
   * `conformed` and `breached` are both live, and picking one would be manufacturing the
   * measurement this pass exists to produce.
   */
  it("an advisory gets no verdict and an `unavailable` claim, never a guess", () => {
    const [annotation] = computeConformance([advisory("e1", ["rule-b"], "Bash:terraform apply")]);
    expect(annotation!.verdict).toBeUndefined();
    expect(annotation!.claimType).toBe("unavailable");
    expect(annotation!.reason).toContain("judgment half");
  });

  /**
   * And it is ANNOTATED rather than skipped. An advisory fire with no annotation at all would be
   * indistinguishable from one nobody has looked at yet — §0's conflation, one layer up. The
   * backlog has to be queryable to be a backlog.
   */
  it("annotates the undecidable rather than passing over it in silence", () => {
    expect(computeConformance([advisory("e1", ["rule-b"], "x")])).toHaveLength(1);
  });

  it("ignores dispositions where no rule fired at all", () => {
    expect(computeConformance([
      silent("e1", "Bash:ls"),
      { phase: "disposition", id: "e2", disposition: "declined: foreign-tool" },
      { phase: "disposition", id: "e3", disposition: "stage-hit-no-rules", ruleIds: [] },
    ])).toEqual([]);
  });
});

describe("the pass may run forever without duplicating itself", () => {
  // §9.2's ingestion contract, applied to our own record: core-owned cursors, idempotent events.
  // This pass is meant to ride an event that already happens (a session start), which means it will
  // run over the same journal many times.
  it("skips fire events already annotated", () => {
    const journal: JournalDispositionLine[] = [deny("e1", ["rule-a"], "Bash:git push --force")];
    const first = computeConformance(journal);
    expect(first).toHaveLength(1);

    const withAnnotations = [...journal, { phase: "conformance", fireEventId: "e1" }];
    expect(computeConformance(withAnnotations)).toHaveLength(0);
  });

  it("annotates only the new fires when the journal grows", () => {
    const journal: JournalDispositionLine[] = [
      deny("e1", ["rule-a"], "a"),
      { phase: "conformance", fireEventId: "e1" },
      deny("e2", ["rule-a"], "b"),
    ];
    expect(computeConformance(journal).map((a) => a.fireEventId)).toEqual(["e2"]);
  });
});

describe("the ratchet watch finally has data", () => {
  it("tallies per rule across fires", () => {
    const annotations = computeConformance([
      deny("e1", ["rule-a"], "a"),
      deny("e2", ["rule-a"], "b"),
      advisory("e3", ["rule-b"], "c"),
    ]);
    const byRule = Object.fromEntries(tallyByRule(annotations).map((t) => [t.ruleId, t]));
    expect(byRule["rule-a"]!).toMatchObject({ fires: 2, changed: 2, awaitingJudgment: 0 });
    expect(byRule["rule-b"]!).toMatchObject({ fires: 1, changed: 0, awaitingJudgment: 1 });
  });

  /**
   * THE HONESTY THE WATCH DEMANDS. "Fires but never changes behaviour" is a claim about
   * MEASUREMENT. A rule whose every fire is still awaiting judgment has not been measured, and
   * retiring it would be punishing it for not having been looked at yet.
   */
  it("never proposes retiring a rule that is merely unmeasured", () => {
    const tallies = tallyByRule(computeConformance([advisory("e1", ["rule-b"], "c")]));
    expect(tallies[0]!.awaitingJudgment).toBe(1);
    expect(retirementCandidates(tallies)).toEqual([]);
  });

  it("does propose one that fired and was measured to move nothing", () => {
    const tallies: Parameters<typeof retirementCandidates>[0] = [
      { ruleId: "rule-c", fires: 3, changed: 0, conformed: 0, breached: 3, vacuous: 0, noEffect: 0, awaitingJudgment: 0 },
    ];
    expect(retirementCandidates(tallies).map((t) => t.ruleId)).toEqual(["rule-c"]);
  });
});

describe("annotations land in the journal they annotate", () => {
  it("appends conformance lines to the same stream, keyed to the fire event", () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-conformance-"));
    try {
      const path = join(dir, "gate-journal.jsonl");
      const annotations = computeConformance([deny("e1", ["rule-a"], "Bash:git push --force")]);
      appendConformanceAnnotations(path, annotations);

      const written = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        phase: "conformance", fireEventId: "e1", verdict: "changed", claimType: "source-observed",
      });

      // And re-running over the grown journal adds nothing — the round trip is idempotent, not just
      // the pure function.
      expect(computeConformance([deny("e1", ["rule-a"], "x"), ...written])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op on a null path, like every other journal write", () => {
    expect(() => appendConformanceAnnotations(null, computeConformance([deny("e1", [], "x")]))).not.toThrow();
  });
});
