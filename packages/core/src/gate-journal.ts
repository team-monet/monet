import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";

/**
 * The gate journal — `docs/design/normative-hierarchy-2026-08-03.md` §1 and §5.
 *
 * WHAT THIS IS FOR, in one line: normal silence and broken silence were indistinguishable. §0 of
 * that document is the incident report — the delegation gate surface sat invoked-but-inert for
 * months after the host renamed its tool, and every observable stayed byte-identical to health the
 * whole time, because the guard that declined to evaluate left no trace. With arrival witnessed,
 * normal silence is "an arrival event with nothing to say" and broken silence is "no arrival event
 * at all".
 *
 * TWO MASTERS, ONE FOR EACH DIRECTION (§1). Minimization still governs DELIVERY: nothing here
 * changes what reaches a model's context, and the gate-silence clause is untouched. Completeness
 * governs the RECORD: every governing mechanism appends what it actually did, to a stream no agent
 * reads in-band. This is not a minimization exception — it is the same audit passed. The consumer
 * is curation on a later turn, never a live agent's context.
 *
 * WHY A FILE AND NOT `gate_events`. Core already has sqlite gate instrumentation (`gate_events`,
 * `gate_event_stages`), and it is deliberately kept: it feeds `gateStats`, it is excluded from sync,
 * and it answers aggregate questions. It cannot be this, for two reasons that are not preferences:
 *
 *   1. The busiest mouth cannot reach it. The Claude Code hook wrapper is sqlite-write-free by
 *      standing ruling (gate-boundary-statement item 6) — it runs on every single Bash command, and
 *      the §0 arrival it must witness happens BEFORE any decision to open a store. A record the
 *      most important mouth cannot write is not the record.
 *   2. A verdict row cannot witness a non-verdict. `commitGateWrites` inserts once, after the full
 *      verdict is computed; there is no row for "arrived and declined". That is the exact defect.
 *
 * TWO LINES PER EVALUATION, NOT ONE — the load-bearing choice. §5 says the event is written at the
 * mouth and its outcome appended at exit. In an append-only stream that is two records sharing an
 * id, and it must be: a single line written at exit is lost by precisely the failures worth
 * recording (a crash, an OOM on a monster payload, a kill). An arrival with no matching disposition
 * is itself a finding, and it can only exist if the two are separate appends.
 *
 * CLAIM TYPES SHIP FROM DAY ONE (§9, monet-core#143). Verdicts say WHAT happened; claim types say
 * HOW WE KNOW. They are here on day one rather than added when the conformance pass needs them
 * because records appreciate retroactively and a schema change cannot retrofit events already
 * written — an event journaled today with no claim type is permanently ambiguous to a pass built
 * months later.
 *
 * NEVER SYNCED, NEVER SEARCHED, NEVER DELIVERED. Local instrumentation, for the same reason
 * `gate_events` is excluded from sync (`sync-types.ts`): replicating it would merge two machines'
 * action streams under one timeline and make every rate computed from it a lie.
 */

/** Which mouth wrote the event. Each is a place a governing mechanism can decline. */
export type GateJournalMouth =
  | "host-hook"
  | "gate-cli"
  | "core-gate"
  | "stage-lookup"
  /**
   * The declare-time firing test (monet-client#59). Not an evaluation of an ACTION — an evaluation
   * of a PATTERN, at authoring time, with the same matcher. It belongs in this stream because it
   * answers the same question every other mouth here answers: did this norm ever actually bind?
   */
  | "declare-check";

/**
 * How we know what the event claims (§9.1, adopted from the 2026-07-18 audit kernel).
 *
 * `source-observed` — this process saw it directly (the host handed us the payload; we ran the
 *   evaluation against the live store).
 * `parsed`  — read out of a materialized artifact rather than the store itself. A sidecar answer is
 *   this: true as of a frozen generation, which is a weaker claim than the store's own.
 * `inferred` / `corroborated` — reserved for the conformance pass, which reasons over records
 *   rather than observing acts. Nothing writes them yet; they are named so that when the pass does,
 *   its verdicts are comparable with the events underneath them.
 * `unavailable` — we could not know. An unparseable payload, an unreachable gate, a fail-open with
 *   no rule set consulted. Never collapse this into a verdict: "no rule fired" and "no rule set was
 *   ever loaded" are the two states §0 proved indistinguishable.
 */
export type GateJournalClaimType =
  | "source-observed"
  | "parsed"
  | "inferred"
  | "corroborated"
  | "unavailable";

/**
 * `silent` and `stage-hit-no-rules` are distinct on purpose, exactly as `GateResult` keeps them
 * distinct: a matched stage with no live rules is the projection hook, not silence. Everything a
 * mechanism can do other than answer is `declined: <reason>` — §1's "every early return is an
 * outcome, not an exemption from recording".
 */
export type GateJournalDisposition =
  | "silent"
  | "stage-hit-no-rules"
  | "advisory"
  | "deny"
  | "overflow"
  | `declined: ${string}`;

export interface GateJournalHandle {
  /** Shared by this evaluation's arrival and disposition lines, and by any child mouth's events. */
  id: string;
  at: string;
}

export interface GateJournalArrival {
  mouth: GateJournalMouth;
  /**
   * The interception this one is part of, when a mouth was spawned by another. The hook forwards
   * its own event id to the gate it spawns, which is what turns "the hook arrived but the gate
   * never evaluated" from an inference into a query.
   */
  parentId?: string | null;
  claimType: GateJournalClaimType;
  [field: string]: unknown;
}

export interface GateJournalDispositionFields {
  mouth: GateJournalMouth;
  disposition: GateJournalDisposition;
  claimType: GateJournalClaimType;
  [field: string]: unknown;
}

/** Schema version of a journal line. Bumped only when an existing field changes meaning. */
export const GATE_JOURNAL_FORMAT = 1;

/** Shared with the client's hook wrapper and gate CLI — all three mouths write ONE stream. */
export const GATE_JOURNAL_FILENAME = "gate-journal.jsonl";

/**
 * One generation of rotation, bounding the file at 2x this. Not configurable: the goal is to stop a
 * hook that runs on every command from filling a disk, not to offer a retention policy. A cap a
 * user can raise is a cap that gets raised and then forgotten.
 */
export const GATE_JOURNAL_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The single append. Every failure is swallowed, deliberately and without exception: recording is a
 * duty this process owes the record, never one it owes the user's action. A journal that cannot be
 * written must never block, alter, delay past its own cost, or crash an evaluation.
 *
 * `path === null` is the no-op case and the DEFAULT everywhere, matching `gateSidecarPath`'s own
 * discipline in engine.ts — with a default path, every MonetCore ever constructed (tests, evals,
 * one-off scripts) would append into the user's real store.
 */
/**
 * Rotate BEFORE appending, so the cap is a ceiling rather than a threshold this write is allowed to
 * blow past — and SERIALIZED across processes (Codex P2 on PR #144, and it was right).
 *
 * The documented configuration has the host hook and an MCP server writing one journal, so two
 * writers can reach the cap together: the first renames the full file and starts a fresh one, and
 * the second's rename then replaces `.prev` with that new one-line file, discarding the whole
 * retained generation. An exclusive `wx` create makes exactly one of them the rotator; a stale
 * marker is cleared after a minute, because a rotation blocked forever turns a bounded file into an
 * unbounded one, which is the worse failure. Mirrors the hook wrapper's own rotation exactly.
 */
const ROTATE_LOCK_STALE_MS = 60_000;
function rotateIfNeeded(path: string): void {
  try {
    if (statSync(path).size < GATE_JOURNAL_MAX_BYTES) return;
  } catch {
    return; // no file yet — the common case
  }
  const lock = `${path}.rotating`;
  let lockFd: number;
  try {
    lockFd = openSync(lock, "wx", 0o600);
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > ROTATE_LOCK_STALE_MS) unlinkSync(lock);
    } catch {
      // Someone else cleared it, or it cannot be read. Append rather than fight.
    }
    return;
  }
  try {
    // Re-checked under the marker: a racing writer may have rotated in between, and rotating that
    // fresh file is precisely the destructive case this exists to prevent.
    if (statSync(path).size >= GATE_JOURNAL_MAX_BYTES) renameSync(path, `${path}.prev`);
  } catch {
    // Nothing to rotate, or a rename not worth fighting over.
  } finally {
    closeSync(lockFd);
    try {
      unlinkSync(lock);
    } catch {
      // Already gone. Fine.
    }
  }
}

export function appendGateJournalLine(path: string | null, fields: Record<string, unknown>): void {
  if (path === null) return;
  try {
    rotateIfNeeded(path);
    // CLOSED IN A `finally` (Codex P2 on PR #144, and it was right). A throw between open and close
    // — a full disk, an unserializable field — was swallowed by the outer catch with the descriptor
    // still open. Under a persistent failure that leaks one per evaluation until the process hits
    // its descriptor limit, at which point optional instrumentation starts breaking operations that
    // have nothing to do with it. Recording must never cost the action anything, and a leaked fd is
    // a cost.
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(fields)}\n`);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Intentionally total. See this function's own comment.
  }
}

/**
 * How much of an action context a journal line may carry verbatim.
 *
 * FOUND BY MEASUREMENT, not foresight: the first build recorded the action context in full, and a
 * real run produced a single 12 MB journal line. The reason is structural rather than unlucky — the
 * overflow-ask outcome exists precisely FOR enormous contexts, so the one disposition guaranteed to
 * carry a monster payload was the one writing it to disk verbatim. A handful of those exhaust the
 * rotation cap, and every cheap line-at-a-time reader of this file chokes on them.
 *
 * 2 KiB is far past any action a human reads back in curation, and far under anything that
 * threatens the file.
 */
export const GATE_JOURNAL_CONTEXT_MAX_CHARS = 2048;

/**
 * Bounds what a journal line says about an action context, WITHOUT losing its identity.
 *
 * The record's job is to say what arrived, not to reproduce it. When a context is clipped the line
 * still carries its true length and a sha256 of the whole thing, so two events over the same action
 * are still provably the same action and a later pass can still count, group, and correlate them.
 *
 * This also brings the journal into line with §9.3's own evidence discipline — "verdicts reference
 * evidence by hash" — which the verbatim version quietly sat outside of. The privacy footprint of
 * an oversized command drops to a prefix plus a digest.
 */
export function clipActionContext(text: string): Record<string, unknown> {
  if (text.length <= GATE_JOURNAL_CONTEXT_MAX_CHARS) return { actionContext: text };
  return {
    actionContext: text.slice(0, GATE_JOURNAL_CONTEXT_MAX_CHARS),
    actionContextClipped: true,
    actionContextChars: text.length,
    // Hashed only on the rare clipped path: digesting a multi-MB context costs real milliseconds,
    // and paying that on every ordinary `Bash:git status` would tax the common case to serve the
    // exception. Here the payload is already enormous and the hash is a rounding error beside it.
    actionContextSha256: createHash("sha256").update(text).digest("hex"),
  };
}

/**
 * The one mapping from a verdict to the word the record uses for it. Kept here, next to the
 * disposition type, so core's gate and the host-side CLI cannot drift into describing the same
 * verdict differently — a stream whose two writers disagree on vocabulary is not one stream.
 *
 * Deliberately structural rather than clever: `overflow` first because it is a third verdict and
 * never a flavour of silence, and `stage-hit-no-rules` distinct from `silent` because a matched
 * stage with no live rules is the projection hook, not an absence.
 */
export function gateJournalDisposition(result: {
  overflow: boolean;
  silence: boolean;
  rules: ReadonlyArray<{ severity: string }>;
}): GateJournalDisposition {
  if (result.overflow) return "overflow";
  if (result.silence) return "silent";
  if (result.rules.length === 0) return "stage-hit-no-rules";
  return result.rules.some((rule) => rule.severity === "blocking") ? "deny" : "advisory";
}

/** Mints the id both lines carry and writes the arrival immediately — at the mouth, before any guard. */
export function openGateJournalEvent(path: string | null, arrival: GateJournalArrival): GateJournalHandle {
  const handle: GateJournalHandle = { id: randomUUID(), at: new Date().toISOString() };
  appendGateJournalLine(path, {
    v: GATE_JOURNAL_FORMAT,
    phase: "arrival",
    id: handle.id,
    at: handle.at,
    ...arrival,
  });
  return handle;
}

/** The closing line. Every exit has one, including — especially — the ones that declined. */
export function closeGateJournalEvent(
  path: string | null,
  handle: GateJournalHandle,
  fields: GateJournalDispositionFields,
): void {
  appendGateJournalLine(path, {
    v: GATE_JOURNAL_FORMAT,
    phase: "disposition",
    id: handle.id,
    at: new Date().toISOString(),
    ...fields,
  });
}
