import { appendGateJournalLine, GATE_JOURNAL_FORMAT } from "./gate-journal";
import type { GateJournalClaimType } from "./gate-journal";

/**
 * The conformance pass, cheap half.
 *
 * WHAT §4 DEFINES, and why the definition matters more than the verdicts: "changed the action" is
 * given an OBSERVABLE definition on purpose. The counterfactual reading — what would have happened
 * without the rule — is unobservable and was rejected outright. A rule changed the action iff the
 * record shows the governed act's outcome diverging from the act as intercepted, in the direction
 * the rule names. Everything weaker is conformance, and the claim of causation is never made beyond
 * observed divergence.
 *
 * WHAT THIS HALF CAN HONESTLY ANSWER, which is narrower than §4's full table and is stated here
 * rather than discovered later. Of the five verdicts, exactly one class is decidable from our own
 * journal with nothing but observation:
 *
 *   - A BLOCKING DENY. The host's own contract is that the call does not proceed, so the act did not
 *     run as intercepted. That is observed, not inferred, and it is `changed` in §4's sense of
 *     "modified or abandoned".
 *   - Everything else needs to read a rule's MEANING against an act. Whether an advisory's act
 *     complied (`conformed`) or ran against the rule (`breached`), and whether a fire was `vacuous`,
 *     all turn on what the rule says — semantic judgment, which §7.4 assigns to the judgment half
 *     along with grants and gradient metrics.
 *
 * SO THE UNDECIDABLE IS RECORDED AS UNDECIDABLE, never skipped. An advisory fire with no annotation
 * at all would be indistinguishable from one nobody has looked at yet — the exact conflation §0 is
 * an incident report about, one layer up. It gets an annotation whose claim type is `unavailable`,
 * which is a queryable backlog: precisely the set the judgment half will consume when it exists.
 *
 * WHAT THIS BUYS ON DAY ONE, before any judgment half is built:
 *   - "Did our denies actually stop anything?" — answered from observation.
 *   - The process-ratchet watch (`fires > 0 AND changed + conformed = 0`) gets real data, which is
 *     the retirement-candidate query the design of record has wanted and never had.
 *   - Whether an agent retried a blocked act unchanged, which is the first honest signal that a deny
 *     is being fought rather than followed.
 */

/** §4's verdict vocabulary, unchanged. This half emits only what it can observe. */
export type ConformanceVerdict = "changed" | "conformed" | "breached" | "no-effect" | "vacuous";

export interface ConformanceAnnotation {
  /** The fire event this annotates — a disposition line's id. Keyed to the event, per §5. */
  fireEventId: string;
  ruleIds: string[];
  /**
   * The subset of `ruleIds` the verdict actually applies to. Present when one fire mixed severities:
   * only the blocking rules earned the verdict, and the rest are awaiting judgment. Absent means the
   * verdict applies to all of `ruleIds`.
   */
  verdictRuleIds?: string[];
  /** Absent when this half cannot decide without judgment; `claimType` then says `unavailable`. */
  verdict?: ConformanceVerdict;
  claimType: GateJournalClaimType;
  /** Present on a deny: whether the identical act was intercepted again afterwards. */
  retriedUnchanged?: boolean;
  /** Why this verdict, or what is missing. Written for the human reading the backlog. */
  reason: string;
}

/** The minimum a journal line must have for this pass to reason about it. */
export interface JournalDispositionLine {
  phase?: string;
  id?: string;
  disposition?: string;
  ruleIds?: string[];
  actionContext?: string;
  actionContextSha256?: string;
  /** False on the advisory path: a blocking rule was delivered, and nothing was stopped. */
  enforced?: boolean;
  /** The subset of `ruleIds` whose severity actually produced the deny. */
  blockingRuleIds?: string[];
  /** The evaluation that spawned this one, when another mouth did. */
  parentId?: string | null;
  /** On a prior conformance line: what that pass concluded about the retry. */
  retriedUnchanged?: boolean;
  [field: string]: unknown;
}

/**
 * A stable identity for "the same act", used to ask whether a blocked act came back.
 *
 * The hash when the context was clipped, the text when it was not — the two never need to be
 * compared with each other, because clipping is a deterministic function of length. Identity by
 * hash is also why clipping cost the record nothing (see gate-journal.ts's clipActionContext).
 */
function actionKeyOf(line: JournalDispositionLine): string | null {
  if (typeof line.actionContextSha256 === "string") return `sha256:${line.actionContextSha256}`;
  if (typeof line.actionContext === "string") return `text:${line.actionContext}`;
  return null;
}

/**
 * The act an event is about, taken from the disposition line or — when that line does not carry it —
 * from the ARRIVAL line sharing its id.
 *
 * FOUND BY RUNNING IT, not by reading it: the core-gate mouth records the context once, at the
 * mouth, and its disposition line carries stages and rule ids instead. Keying on the disposition
 * alone silently produced `retried: undefined` for every core-gate fire — a missing answer wearing
 * the shape of a real one. Joining by id is also the right fix rather than repeating the context on
 * both lines: the pair already shares an id precisely so neither has to restate the other.
 */
function buildActionKeys(lines: readonly JournalDispositionLine[]): Map<string, string> {
  const keys = new Map<string, string>();
  for (const line of lines) {
    if (typeof line.id !== "string") continue;
    const key = actionKeyOf(line);
    // Disposition wins when both carry one; otherwise whichever line has it supplies it.
    if (key !== null && (line.phase === "disposition" || !keys.has(line.id))) keys.set(line.id, key);
  }
  return keys;
}

/**
 * The evaluation CHAIN an event belongs to — its own id, or its parent's when it was spawned by
 * another mouth.
 *
 * WHY THIS EXISTS (Codex P1 on PR #144, and it was right): one interception is journaled by several
 * mouths. The host hook records it, and the gate it spawns records the same act again with the same
 * action key. Comparing act keys alone therefore found the child's disposition after the parent's
 * and reported the deny as retried — so every ordinary hook-gated deny would have been written down
 * as a rule that was fought. `parentId` is on the wire for exactly this correlation; it just was not
 * being used.
 */
function buildChainIds(lines: readonly JournalDispositionLine[]): Map<string, string> {
  const parentOf = new Map<string, string>();
  const known = new Set<string>();
  for (const line of lines) {
    if (typeof line.id !== "string") continue;
    known.add(line.id);
    if (typeof line.parentId === "string") parentOf.set(line.id, line.parentId);
  }

  // FOLLOWED TO THE ROOT, not one hop (Codex P1 on PR #144, and it was right). A three-deep
  // interception — host-hook → gate-cli → core-gate — gave the grandchild its immediate parent while
  // the parent got the root, so the two ends of ONE evaluation carried different chain ids and their
  // identical acts read as a retry. The one-hop version fixed the two-mouth case and left the
  // three-mouth case saying exactly what the fix was for.
  //
  // Memoised, and cycle-guarded: a malformed journal must not be able to spin this forever.
  const roots = new Map<string, string>();
  for (const id of known) {
    const path: string[] = [];
    let cursor = id;
    let root = id;
    for (;;) {
      const cached = roots.get(cursor);
      if (cached !== undefined) { root = cached; break; }
      path.push(cursor);
      const parent = parentOf.get(cursor);
      if (parent === undefined || parent === cursor || path.includes(parent)) { root = cursor; break; }
      cursor = parent;
    }
    for (const step of path) roots.set(step, root);
  }
  return roots;
}

const FIRE_DISPOSITIONS = new Set(["deny", "advisory"]);

/**
 * Computes annotations for every fire event not already annotated.
 *
 * PURE, and deliberately so: it takes parsed lines and returns annotations, touching no file. The
 * pass's own correctness is then testable without a store, a journal, or a clock — which matters
 * because this is measurement, and measurement that cannot itself be verified is decoration.
 *
 * IDEMPOTENT by fire-event id: annotations already present are skipped, so the pass may run on every
 * session start forever without duplicating a verdict. That is the §9.2 ingestion contract applied
 * to our own record — core-owned cursors, idempotent canonical events.
 */
export function computeConformance(lines: readonly JournalDispositionLine[]): ConformanceAnnotation[] {
  // ANNOTATED ONCE, EXCEPT WHEN THE ANSWER IMPROVED (Codex P1 on PR #144, and it was right). A pass
  // that ran before a retry arrived wrote `retriedUnchanged: false` permanently, and idempotence then
  // guaranteed the newly observable retry could never reach the record — so retry counts depended on
  // when the pass happened to run, and incremental operation systematically underreported them.
  //
  // The upgrade is monotone and therefore still terminating: false may become true, never the
  // reverse, so an event is re-annotated at most once and a pass over an unchanged journal remains a
  // no-op. Absence of a retry is a window that is still open, not a finding.
  const annotatedRetry = new Map<string, boolean>();
  for (const line of lines) {
    if (line.phase === "conformance" && typeof line.fireEventId === "string") {
      const priorSaidRetried = line.retriedUnchanged === true;
      annotatedRetry.set(line.fireEventId, (annotatedRetry.get(line.fireEventId) ?? false) || priorSaidRetried);
    }
  }

  const dispositions = lines.filter((line) => line.phase === "disposition");
  const actionKeys = buildActionKeys(lines);

  // LAST OCCURRENCE OF EACH ACT, in one pass (Codex P1 on PR #144, and it was right). The previous
  // shape sliced the remaining dispositions per deny and scanned them — quadratic, and this journal
  // is capped at 64 MiB, which is hundreds of thousands of dispositions. A deny-heavy pass would
  // have hung the very curation turn it exists to serve. A deny at index i was retried iff its act
  // appears again after i, which one reverse index answers in constant time.
  const chainIds = buildChainIds(lines);
  // THE TWO MOST RECENT OCCURRENCES WITH DISTINCT CHAINS, and no more (Codex P1 on PR #144, and it
  // was right). The previous shape kept one entry per chain and `.some()`-scanned the accumulated
  // array, so a journal dominated by ONE repeatedly denied command grew a bucket per attempt and
  // went quadratic again — the same defect the first fix was for, wearing different clothes.
  //
  // Two is provably enough for the only question asked: "is there a later occurrence in a DIFFERENT
  // chain?" Scanning backwards, if the most recent entry's chain differs from the asker's, it
  // answers. If it does not differ, any later occurrence in another chain would itself have been the
  // second distinct entry — so checking that one settles it.
  const recentActs = new Map<string, Array<{ index: number; chain: string }>>();
  for (let i = dispositions.length - 1; i >= 0; i--) {
    const id = dispositions[i]!.id;
    const key = typeof id === "string" ? actionKeys.get(id) : undefined;
    if (key === undefined || typeof id !== "string") continue;
    const chain = chainIds.get(id) ?? id;
    const bucket = recentActs.get(key);
    if (bucket === undefined) recentActs.set(key, [{ index: i, chain }]);
    else if (bucket.length < 2 && bucket[0]!.chain !== chain) bucket.push({ index: i, chain });
  }

  const out: ConformanceAnnotation[] = [];

  for (let i = 0; i < dispositions.length; i++) {
    const line = dispositions[i]!;
    const id = line.id;
    const disposition = line.disposition;
    if (typeof id !== "string" || typeof disposition !== "string") continue;
    if (!FIRE_DISPOSITIONS.has(disposition)) continue; // no rule fired; nothing to be conformant to
    const ruleIds = Array.isArray(line.ruleIds) ? (line.ruleIds as string[]) : [];

    // A "deny" THAT WAS NEVER ENFORCED IS NOT ONE (Codex P1 on PR #144, and it was right). The
    // stage-lookup mouth is advisory by design: it journals `disposition: "deny"` because a blocking
    // rule was DELIVERED, and marks `enforced: false` because nothing was stopped. Reading that as an
    // observed `changed` would count acts that ran freely as acts the rule prevented — inflating the
    // exact effectiveness measure this pass exists to make honest. It falls through to the advisory
    // treatment below, which is what it actually was.
    const enforced = line.enforced !== false;

    if (disposition === "deny" && enforced) {
      // OBSERVED, not inferred: the host does not run a denied call. The act did not proceed as
      // intercepted, which is §4's "modified or abandoned" — the weaker half of `changed`, and the
      // only half this pass claims. Whether what the agent did INSTEAD went in the rule's direction
      // is judgment, and is deliberately not asserted here.
      const key = actionKeys.get(id);
      const chain = chainIds.get(id) ?? id;
      const occurrences = key === undefined ? undefined : recentActs.get(key);
      const retried =
        occurrences === undefined
          ? undefined
          : occurrences.some((entry) => entry.index > i && entry.chain !== chain);
      // A MIXED-SEVERITY FIRE CREDITS ONLY THE RULES THAT BLOCKED (Codex P1 on PR #144, and it was
      // right). One evaluation can match a blocking rule and an advisory one; the event is labelled
      // `deny` as a whole, and crediting `changed` to every id in it would hand the advisory rules
      // an interception they had no part in. The gate now journals which ids were the blocking ones,
      // and the verdict is scoped to those; the rest stay awaiting judgment, which is their real
      // state.
      const blockingRuleIds = Array.isArray(line.blockingRuleIds)
        ? (line.blockingRuleIds as string[])
        : undefined;
      const previouslySaidRetried = annotatedRetry.get(id);
      // Emitted when never annotated, or when a retry has become observable since.
      if (previouslySaidRetried !== undefined && !(retried === true && previouslySaidRetried === false)) continue;
      out.push({
        fireEventId: id,
        ruleIds,
        ...(blockingRuleIds === undefined ? {} : { verdictRuleIds: blockingRuleIds }),
        verdict: "changed",
        claimType: "source-observed",
        ...(retried === undefined ? {} : { retriedUnchanged: retried }),
        // MISSING EVIDENCE IS NOT A NEGATIVE OBSERVATION (Codex P2 on PR #144, and it was right).
        // With no recoverable act — a truncated arrival, a pair split by rotation — the old wording
        // still asserted the act "did not return unchanged", which is a claim nobody made. The
        // deny itself is still observed; only the retry question is unanswerable.
        reason:
          retried === undefined
            ? "denied; the act did not run as intercepted, and whether it was retried is unavailable — no act identity on the record"
            : retried
              ? "denied, and the identical act was intercepted again afterwards — the rule held, and was fought"
              : "denied; the act did not run as intercepted and did not return unchanged",
      });
      continue;
    }

    if (annotatedRetry.has(id)) continue; // an advisory annotation has nothing that can improve
    // ADVISORY, or a blocking rule that was only DELIVERED: nothing stopped the call, so the act ran
    // as intercepted. Whether it COMPLIED with what the rule says is exactly the semantic question
    // this half cannot answer — `conformed` and `breached` are both live, and guessing between them
    // would manufacture the measurement.
    out.push({
      fireEventId: id,
      ruleIds,
      claimType: "unavailable",
      reason:
        disposition === "deny"
          ? "a blocking rule was DELIVERED but not enforced (the advisory path); the act ran as " +
            "intercepted, so whether it conformed or breached needs the judgment half (§7.4)"
          : "advisory delivered and the act ran as intercepted; whether it conformed or breached needs " +
            "the rule's meaning read against the act — the judgment half (§7.4)",
    });
  }

  return out;
}

/**
 * Appends the annotations to the journal they annotate. Keyed to fire events, appended by the pass,
 * never by the live agent (§5).
 *
 * The SAME stream, not a second one, and for the same reason all the mouths share it: a verdict that
 * lived somewhere else would have to be correlated back by hand, and the correlation is the record.
 */
export function appendConformanceAnnotations(
  path: string | null,
  annotations: readonly ConformanceAnnotation[],
): void {
  for (const annotation of annotations) {
    appendGateJournalLine(path, { v: GATE_JOURNAL_FORMAT, phase: "conformance", ...annotation });
  }
}

/**
 * The process-ratchet watch, from the design's own retirement-candidate
 * question: "rules and gates that fire but never change behavior".
 *
 * §4 makes it the query `fires > 0 AND changed + conformed = 0`, and this computes it — with the
 * one honesty the design demands of it: a rule whose every fire is still awaiting judgment is NOT a
 * retirement candidate, it is an unmeasured one. Collapsing those two would retire rules for the
 * crime of not having been looked at yet.
 */
export interface RuleConformanceTally {
  ruleId: string;
  fires: number;
  changed: number;
  conformed: number;
  breached: number;
  vacuous: number;
  /**
   * A standing grant whose opportunity arose and went unexercised (§4). MEASURED, not backlog
   * (Codex P2 on PR #144, and it was right): it is a completed observation, and counting it as
   * awaiting judgment both understated the measurement and made such grants permanently invisible
   * to the retirement query — the one question they exist to answer.
   */
  noEffect: number;
  /** Fires whose verdict needs the judgment half. A rule that is all backlog is unmeasured. */
  awaitingJudgment: number;
}

export function tallyByRule(annotations: readonly ConformanceAnnotation[]): RuleConformanceTally[] {
  const tallies = new Map<string, RuleConformanceTally>();
  for (const annotation of annotations) {
    for (const ruleId of annotation.ruleIds) {
      let tally = tallies.get(ruleId);
      if (tally === undefined) {
        tally = { ruleId, fires: 0, changed: 0, conformed: 0, breached: 0, vacuous: 0, noEffect: 0, awaitingJudgment: 0 };
        tallies.set(ruleId, tally);
      }
      tally.fires++;
      // The verdict is this rule's only when it is one the verdict was scoped to.
      const verdictApplies =
        annotation.verdictRuleIds === undefined || annotation.verdictRuleIds.includes(ruleId);
      if (!verdictApplies) {
        tally.awaitingJudgment++;
        continue;
      }
      if (annotation.verdict === "changed") tally.changed++;
      else if (annotation.verdict === "conformed") tally.conformed++;
      else if (annotation.verdict === "breached") tally.breached++;
      else if (annotation.verdict === "vacuous") tally.vacuous++;
      else if (annotation.verdict === "no-effect") tally.noEffect++;
      else tally.awaitingJudgment++;
    }
  }
  return [...tallies.values()];
}

/**
 * Retirement candidates: fired, and never observed to change or conform.
 *
 * Excludes anything still awaiting judgment, per the tally's own comment — "fires but never changes
 * behavior" is a claim about measurement, and an unmeasured rule has not earned it.
 */
export function retirementCandidates(tallies: readonly RuleConformanceTally[]): RuleConformanceTally[] {
  return tallies.filter(
    // `no-effect` counts as measured and as "moved nothing" — an opportunity that arose and was not
    // taken is exactly the retirement evidence a standing grant can offer.
    (tally) => tally.fires > 0 && tally.changed + tally.conformed === 0 && tally.awaitingJudgment === 0,
  );
}
