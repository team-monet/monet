import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import {
  GATE_MIRROR_FORMAT,
  RULE_SCOPES,
  RULE_SEVERITIES,
  GATE_JOURNAL_FILENAME,
  clipActionContext,
  closeGateJournalEvent,
  deriveCircle as coreDeriveCircle,
  evaluateGateFromMirror,
  gateJournalDisposition,
  openGateJournalEvent,
  parseActionContext,
  type GateJournalClaimType,
  type GateJournalDisposition,
  type GateMirror,
  type GateResult,
  type GateRule,
  type RuleScope,
  type RuleSeverity,
} from "@team-monet/core";
import { getGateMirrorPath } from "./db/index.js";
import { resolveProjectDir } from "./project-dir.js";
import { defaultNameFromRemote, getOriginRemote } from "./remote-circle.js";

/**
 * Mirrors `@team-monet/core/gates.ts`'s internal `BREADTH_CIRCLE` (value `"*"`, "the reserved
 * global-breadth marker on a rule BINDING, never a circle a query can be scoped to" — its own
 * doc comment). CONFIRMED FINDING (see this slice's report): `gates.ts` exports the constant, but
 * `@team-monet/core`'s public barrel (`src/index.ts`) does not re-export it, so it is not reachable
 * through the package import surface at all — this is a bare literal, not a re-derivation of any
 * logic, and about as stable a literal as this codebase has (the schema itself hardcodes `'*'` in
 * a SQL CHECK constraint for the same marker).
 *
 * TWO USES, kept in sync deliberately (corrected — an earlier version of this comment claimed
 * this constant was used only to recognize a caught error after the fact; Codex round 1 changed
 * that): (1) `runGateUnguarded`'s pre-mirror-read check compares the raw flag/env pick against
 * this constant directly and, on a match, prints a HAND-WRITTEN message matching
 * `assertQueryableCircle`'s own wording — hand-written because there is no mirror yet at that
 * point, so there is nothing to catch a real thrown message FROM. (2) The backstop `catch` around
 * `evaluateGateFromMirror` still compares `resolved.circle` against this constant to decide
 * whether a caught error is that SAME refusal reached some other way — and there, the real
 * thrown message is surfaced verbatim, never re-derived. Never used to pre-empt evaluation with a
 * fabricated verdict; only to recognize or restate the one refusal `assertQueryableCircle` owns.
 *
 * EXPORTED as of FIX 3 (Codex round 2 on PR #42): install-cli.ts's `runInstall` needs the SAME
 * wildcard semantics to refuse pinning `--circle '*'` into a generated hook (see that file's own
 * comment for why a permanently-pinned wildcard is worse than this command's own pre-mirror
 * refusal — it never even reaches a fresh `monet gate` invocation to refuse loudly, since the
 * refusal happens the FIRST time, at install time, then bakes in). One constant, one source of
 * truth, matching GATE_FAIL_OPEN_MARKER's own export precedent immediately below in this file.
 */
export const QUERY_WILDCARD_CIRCLE = "*";

/**
 * `monet gate <action-context>` — the offline hook binary (slice 4b-C).
 *
 * Reads the gate mirror straight off disk: no store open, no MonetCore construction, no network.
 * That is the entire point — the CLI must answer with the server down. See
 * ../monet-core/docs/design/next-monet-tool-surface.md's `monet gate` row and
 * ../monet-core/docs/design/gate-boundary-statement.md's failure policy — this module implements
 * both, adapted to a store-less reader (see readGateMirrorFile's own comment for one adaptation,
 * and the next paragraph for another).
 *
 * STALENESS SUBSTITUTED BY AGE — the ONE other adaptation this module makes and must state
 * plainly: `GateMirror.generation` is only meaningful compared against the LIVE store's own
 * `gateGeneration(db)` (see `inspectSidecar`), which requires exactly the store this command must
 * never open. A store-less reader therefore CANNOT know whether the mirror it is holding is
 * stale — only how OLD it is. `formatMirrorAge` on the deny path is that honest substitute: not
 * "this answer might be wrong", but "this answer is this old, and here is what would refresh it" —
 * the boundary statement's "reason at the moment of action" promise applied to the mirror's own
 * freshness, not only to the rule's.
 *
 * FIVE OUTCOMES, FIVE EXIT CODES (GATE_EXIT_CODE below) — the host maps codes; this CLI never
 * enforces. A plain CLI usage error (bad `--circle '*'`, no `Tool:` prefix and no `--tool`, or
 * excess positional arguments) exits 1, distinct from all five outcomes. `--help`/`-h`/`--version`
 * exit 0 through commander's own paths, before any evaluation runs.
 *
 * STDOUT/STDERR DISCIPLINE, deliberate: stdout carries ONLY the outcome's own injectable payload
 * (rule text/reason for 20 and 30, blocking-only even when an advisory also fired — see
 * SHOULD-FIX 4 in this slice's report) so a hook can pipe it straight into the agent's context or
 * a denial message without scraping it out of diagnostics. Every diagnostic — resolved circle,
 * mirror age, missing/malformed warnings, usage errors, a suppressed advisory — goes to stderr,
 * matching doctor/repair's existing convention in this codebase (repair-cli.ts).
 *
 * PROCESS WALL TIME IS NOT SUB-MS, and this module must not claim it is: the design's "sub-ms" is
 * the ENGINE's own evaluation cost inside `evaluateGateFromMirror` (proved in 4b-B), not this
 * process's end-to-end wall time, which is dominated by Node/bundle startup (measured ~tens of ms
 * — see this slice's report). Circle resolution shells out to git TWICE when it reaches the
 * remote-aware pick (P1 fix, Codex round 2 on PR #40 — see resolveGateCircle's own comment):
 * `git rev-parse --show-toplevel` (`@team-monet/core`'s own `deriveCircle`, folder derivation) and
 * `git remote get-url origin` (`remote-circle.ts`'s `getOriginRemote`, the remote-presence check).
 * BOTH run on every invocation that reaches circle resolution, INCLUDING on the fail-open path
 * (missing/malformed mirror) — the diagnostic circle line is still computed even when nothing was
 * evaluated. Both calls are I/O, never a store touch, and this comment leaves the behavior as is
 * (consistency between the evaluated and fail-open paths beats micro-latency here); they are
 * named so "sub-ms" is never read as a promise about this command's own process.
 */

export const GATE_EXIT_CODE = {
  SILENCE: 0,
  STAGE_HIT_NO_RULES: 10,
  ADVISORY_INJECT: 20,
  BLOCKING_DENY: 30,
  OVERFLOW_ASK: 40,
} as const;

/** Distinct from every outcome code above — a caller-input problem, not a gate verdict. */
const USAGE_ERROR_EXIT_CODE = 1;

/**
 * P1-A (Codex round 1 on PR #42): the shared, load-bearing substring every fail-open diagnostic
 * line below is built through — never a decorative alias. This is what lets a caller detect "monet
 * gate answered exit 0 because it genuinely had nothing to say" from "it answered exit 0 because it
 * COULD NOT EVALUATE AT ALL" WITHOUT parsing prose narrowly enough to break on a wording edit.
 *
 * CONSUMER: install-cli.ts's generated wrapper imports this constant at GENERATION time (build
 * time for the wrapper source, not run time for the wrapper itself — the wrapper is a standalone
 * script with no module graph back to this file) and bakes the literal into the wrapper. On the
 * wrapper's own no-opinion path (exit 0, `main()`'s `default:` case) it greps the CAPTURED stderr
 * for this marker: present → the fail-open is real and gets a `systemMessage` (still no
 * `permissionDecision` — Monet still has no enforcement opinion); absent → genuine silence, stays
 * completely empty. THE BUG THIS CLOSES: a fresh `monet install` (hook wired, no `monet start`
 * session has EVER run to materialize the mirror) answers exit 0 identically to "nothing matched" —
 * the one state every new user passes through was silently, invisibly wired, looking exactly like
 * a working, ungoverned command. See buildWrapperScript's own comment for the wrapper-side half.
 */
export const GATE_FAIL_OPEN_MARKER = "failing OPEN";

export class GateActionContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateActionContextError";
  }
}

/** Read chunk size for `readStdinSync`'s own `fs.readSync` loop — named so the cap formula below
 *  can reference it directly instead of repeating the literal `65536` at each of its three uses
 *  (the two `Buffer.alloc` calls and the "+ one chunk of slack" term). */
const STDIN_CHUNK_SIZE = 65536;

/**
 * P1-A (Codex round 4 on PR #42) — SUPERSEDES P2-7's flat 5 MiB byte cap below, which was WRONG
 * for a reason more serious than the memory-bound bug it fixed: it does not guarantee the
 * ENGINE's own overflow verdict for a MULTIBYTE UTF-8 context.
 *
 * THE BUG: `evaluateGateFromMirror`'s own `text.length > MAX_CONTEXT_BYTES` check
 * (`@team-monet/core/gates.ts`, `4 * 1024 * 1024`, not exported — see this module's own
 * `QUERY_WILDCARD_CIRCLE` comment for the precedent of citing an unexported core internal by a
 * stable literal) compares a DECODED JS STRING's `.length` — UTF-16 CODE UNITS — never raw bytes.
 * A flat BYTE cap conflates the two. A 3-byte UTF-8 sequence (most CJK — Korean, Japanese kana,
 * common Chinese hanzi, U+0800-U+FFFF) decodes to exactly ONE UTF-16 code unit: a 3:1 byte-to-unit
 * ratio. Retaining a flat 5 MiB of BYTES from a pure 3-byte-sequence stream therefore decodes to
 * only ~1.67 Mi UTF-16 units — comfortably UNDER the engine's 4 Mi-unit threshold — REGARDLESS of
 * how much larger the genuine, un-truncated input actually was. The result is not merely "capped
 * too early": it is a WRONG VERDICT of a DIFFERENT CLASS than the memory bug it replaced — a
 * multi-hundred-MB multibyte command silently evaluates as an ordinary, in-bounds context (most
 * likely "silence" — no stage matches truncated garbage) instead of the honest overflow-ask (exit
 * 40) it must produce. Worse than losing bytes: losing the CORRECTNESS of the verdict itself.
 *
 * THE FIX: cap retained BYTES at `3 × the engine's own 4 Mi-unit threshold`, plus one chunk of
 * slack. 3 is the TRUE worst case, not an approximation — 1-byte (ASCII) and 2-byte UTF-8
 * sequences decode to one unit each (1:1 and 2:1 ratios, both lower), and 4-byte sequences
 * (astral-plane / supplementary-plane characters, U+10000+) decode to a UTF-16 SURROGATE PAIR —
 * TWO units — a 4:2 = 2:1 ratio, also lower than 3:1. No UTF-8 sequence has a higher bytes-per-unit
 * ratio than 3. So retaining `3 × 4 Mi` bytes GUARANTEES the decoded string reaches AT LEAST 4 Mi
 * units even in the worst (pure 3-byte-sequence) case — and the "+ one chunk of slack" is what
 * pushes that guarantee from "reaches" to "exceeds", matching the engine's own strict `>`
 * comparison (retention stops once `retainedBytes >= cap`, and the loop's own coarse,
 * chunk-at-a-time granularity means the LAST retained chunk can carry retention slightly past the
 * cap itself — see the loop's own comment below for why that overshoot is deliberate, not slop to
 * eliminate). Still bounded, still flat RSS (~12 MiB instead of 5 MiB) — the trade this fix makes is
 * a larger but FIXED constant for a provably correct verdict class, not an open-ended one.
 *
 * EXPORTED so a unit test can assert the retained-size bound directly (by mocking `fs.readSync`)
 * without needing a real, multi-MB piped stdin.
 */
export const RETAINED_STDIN_CAP_BYTES = 3 * 4 * 1024 * 1024 + STDIN_CHUNK_SIZE;

/**
 * Synchronously read the WHOLE stdin stream (4b-D, component A).
 *
 * `fs.readFileSync(0, "utf8")` is Node's usual synchronous-stdin idiom, and this module's own
 * existing style (readGateMirrorFile uses plain synchronous fs throughout) — but it has a
 * well-known failure mode this slice hit EMPIRICALLY, not just in theory: when stdin is a PIPE
 * that ends up in NON-BLOCKING mode (reproduced reliably here piping a multi-MB payload from
 * another `node` process into this one on this platform — not a rare edge case for exactly the
 * overflow-ask scenario --stdin exists to serve), a read attempted before the writer has more
 * data ready fails with EAGAIN instead of blocking for it. `readFileSync` has no retry of its
 * own for that, so the whole command would report "internal error (EAGAIN...)" — a wrapper-level
 * failure indistinguishable from a real crash, for a perfectly ordinary large piped write.
 *
 * The fix: `fs.readSync` in a loop, retrying on EAGAIN after a short synchronous pause
 * (`Atomics.wait` on a scratch `SharedArrayBuffer` — the standard technique for a blocking sleep
 * in synchronous Node code with no native dependency), until genuine EOF (`bytesRead === 0`).
 * Any other error is real and rethrown, surfacing through runGate's own outer catch-all exactly
 * as before.
 *
 * P2-7 BOUNDED RETENTION (cap VALUE superseded by P1-A above — this paragraph documents the
 * MECHANISM, which is unchanged): once `retainedBytes` reaches `RETAINED_STDIN_CAP_BYTES`,
 * subsequent reads land in `scratch` (a SECOND, reused buffer) instead of being pushed onto
 * `chunks` — the stream is still DRAINED all the way to EOF (a writer on the other end of the pipe
 * still needs its own write to complete; leaving unread bytes behind risks EPIPE/a hung writer),
 * the bytes themselves are just discarded rather than retained. The evaluator still sees the full
 * capped payload (whatever was retained before the cap was crossed) — decoding to AT LEAST the
 * engine's own 4 Mi-unit threshold in every case, per P1-A's own worst-case-ratio proof above, so
 * the overflow outcome is unchanged; only the MEMORY this function itself commits to is bounded.
 * Retained size can exceed the cap by up to one chunk (`STDIN_CHUNK_SIZE`, 65536 bytes) — the LAST
 * chunk that pushes `retainedBytes` past the cap is still retained in full, since the boundary
 * check happens once per iteration, before that iteration's own read; this is deliberate (a
 * single read's worth of slop costs nothing worth avoiding the complexity of splitting a chunk to
 * fit exactly) and is what this function's own tests pin as "cap + one chunk", not an exact cap —
 * and is also EXACTLY the slack term P1-A's own cap formula adds on top of `3 × 4 Mi`, so this
 * same slop is what turns "decodes to at least the threshold" into "decodes past it", matching the
 * engine's strict `>` comparison instead of merely reaching equality in the worst case.
 */
export function readStdinSync(): string {
  const chunks: Buffer[] = [];
  let retainedBytes = 0;
  const buffer = Buffer.alloc(STDIN_CHUNK_SIZE);
  const scratch = Buffer.alloc(STDIN_CHUNK_SIZE); // reused every over-cap iteration; never retained
  const pauseSignal = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const underCap = retainedBytes < RETAINED_STDIN_CAP_BYTES;
    const target = underCap ? buffer : scratch;
    let bytesRead: number;
    try {
      bytesRead = fs.readSync(0, target, 0, target.length, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        Atomics.wait(pauseSignal, 0, 0, 5);
        continue;
      }
      if (code === "EOF") break; // some platforms signal EOF as an error rather than bytesRead 0
      throw error;
    }
    if (bytesRead === 0) break;
    if (underCap) {
      chunks.push(Buffer.from(target.subarray(0, bytesRead)));
      retainedBytes += bytesRead;
    }
    // else: draining to EOF without retaining — target === scratch, its content is discarded.
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ── Step 4: the Tool: prefix is load-bearing ──────────────────────────────────────────────────

/**
 * A tool-constrained trigger pattern (`{tool: "bash", ...}`) NEVER matches a context whose own
 * `tool` is null (see `matchesTriggerPattern` in @team-monet/core/gates.ts: `if (pattern.tool !==
 * null && pattern.tool !== context.tool) return false;`). So a caller that drops the `Tool:`
 * prefix does not get a wrong answer for a tool-scoped blocking rule — it gets a silent
 * non-match, which is a deny quietly failing open. This command refuses that shape outright
 * rather than risk evaluating it, unless `--tool` names the tool to synthesize the prefix from
 * (an accepted convenience for callers whose own plumbing doesn't easily produce "Tool:command"
 * — commander's parsing stays simple because this is the only extra flag it costs).
 *
 * Uses @team-monet/core's own EXPORTED `parseActionContext` to detect the prefix — the identical
 * grammar (`TOOL_NAME_RE`) it enforces internally — rather than re-deriving that grammar here,
 * which is not exported and should not be duplicated.
 */
export function ensureToolPrefixedContext(rawContext: string, tool?: string): string {
  if (parseActionContext(rawContext).tool !== null) return rawContext;
  const trimmedTool = tool?.trim();
  if (trimmedTool) {
    const synthesized = `${trimmedTool}:${rawContext}`;
    if (parseActionContext(synthesized).tool !== null) return synthesized;
    throw new GateActionContextError(
      `--tool ${JSON.stringify(tool)} is not a valid tool name (letters/digits/./_/- only, starting ` +
        `with a letter) and could not be synthesized into a 'Tool:' prefix.`,
    );
  }
  throw new GateActionContextError(
    `action context ${JSON.stringify(rawContext)} has no 'Tool:' prefix. A tool-constrained rule ` +
      `(e.g. "Bash:git push --force") never matches an unprefixed context — it fails open ` +
      `SILENTLY, not loudly — so this command refuses rather than risk that. Supply the prefix ` +
      `yourself (e.g. ${JSON.stringify(`Bash:${rawContext}`)}) or pass --tool <name> to synthesize it.`,
  );
}

// ── Step 1: read the mirror offline, no store, no network ────────────────────────────────────

export type GateMirrorReadResult =
  | { kind: "missing"; path: string }
  | { kind: "malformed"; path: string; reason: string }
  | { kind: "ok"; path: string; mirror: GateMirror };

/**
 * Does this `entries[]` element have the shape `evaluateGateFromMirror`'s own filter/map
 * dereferences? Mirrors `@team-monet/core/gates.ts`'s MODULE-PRIVATE `hasMirrorEntryShape`
 * field-for-field (same six checks, same literal vocabularies via the EXPORTED `RULE_SEVERITIES`/
 * `RULE_SCOPES` constants — not a hand-copied literal set that could drift from core's own). See
 * `readGateMirrorFile`'s own comment for why this exists here at all rather than being imported.
 */
function hasMirrorEntryShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.conceptId === "string"
    && typeof entry.stageId === "string"
    && RULE_SEVERITIES.includes(entry.severity as RuleSeverity)
    && typeof entry.circle === "string"
    && typeof entry.text === "string"
    && RULE_SCOPES.includes(entry.scope as RuleScope)
  );
}

/** Mirrors core's MODULE-PRIVATE `hasMirrorStageShape` field-for-field — see `hasMirrorEntryShape`. */
function hasMirrorStageShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const stage = value as Record<string, unknown>;
  return typeof stage.id === "string" && typeof stage.name === "string" && typeof stage.triggerPatterns === "string";
}

/** Mirrors core's MODULE-PRIVATE `hasMirrorCircleAliasShape` field-for-field — see `hasMirrorEntryShape`. */
function hasMirrorCircleAliasShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const alias = value as Record<string, unknown>;
  return typeof alias.from === "string" && typeof alias.to === "string";
}

/**
 * Read and validate the gate mirror file, entirely offline.
 *
 * WHY THIS DUPLICATES A LITTLE (see this slice's report for the full finding): `@team-monet/core`'s
 * own file-shape validator, `readSidecarHeader` (gates.ts), does exactly this validation — but it
 * is MODULE-PRIVATE (not exported), and even if it were, its return type discards `entries`/
 * `stages`/`circleAliases`/`circles`, which is exactly what `evaluateGateFromMirror` needs. There
 * is no exported, store-less function that hands a file consumer back a validated `GateMirror`.
 *
 * THE REAL POSTURE (corrected — a prior version of this comment claimed the element/referential
 * checks below were subsumed by the checksum and skippable; a reviewer's probe showed that was
 * false for exactly the pre-checksum-field files this function must ALSO accept, per
 * `readSidecarHeader`'s own tolerance — a checksum-STRIPPED file with a corrupted `severity` or a
 * deleted `scope` passed straight through to `evaluateGateFromMirror` with no shape guard at all):
 *
 *   - SHAPE + REFERENTIAL checks run UNCONDITIONALLY, matching `readSidecarHeader`'s own structure
 *     exactly (gates.ts:4160-4189): every `entries[]` element via `hasMirrorEntryShape` (literal
 *     `severity`/`scope` vocabularies via core's own EXPORTED `RULE_SEVERITIES`/`RULE_SCOPES`,
 *     never a hand-copied set), every `stages[]` element via `hasMirrorStageShape`, every
 *     `circleAliases[]` element via `hasMirrorCircleAliasShape`, and the entries⊆stages
 *     referential check (an entry naming a `stageId` absent from this same file's own `stages[]`
 *     can never be reached through `evaluateGateFromMirror`'s own join). These hold for EVERY file
 *     this function accepts, checksum or no — they are what actually stops a corrupted-but-still-
 *     JSON-valid `severity: "Blocking"` from being delivered as an advisory (a lost deny) and a
 *     deleted `scope` on an agent rule from firing for the wrong `MONET_MODEL_TAG` (a deny nobody
 *     declared for this model). `format` must equal this build's `GATE_MIRROR_FORMAT` exactly —
 *     behind OR ahead, both unreadable to THIS build (conservative; matches `inspectSidecar`'s own
 *     `format !== GATE_MIRROR_FORMAT` compare) — before any element check runs, since a
 *     format-ahead file's element shape is not this build's to judge.
 *   - CHECKSUM is the SEPARATE, ADDITIONAL layer — verified WHEN PRESENT, using the EXACT recipe
 *     `materializeGateMirror`'s own comment documents and explicitly invites external
 *     recomputation of: strip `checksum`, `JSON.stringify(rest, null, 2)`, sha256, hex. It catches
 *     what shape checks structurally cannot: a byte flipped inside an otherwise well-typed,
 *     well-shaped VALUE (a rule's title, a reason) — a corrupted `text` or `reason` string that is
 *     still a string, still satisfies every check above, and changes what a deny SAYS rather than
 *     whether it exists. A file with NO checksum (the documented pre-checksum dev-window case)
 *     skips this ONE check, exactly as `readSidecarHeader` itself does — the element/referential
 *     checks above still run unconditionally either way.
 *
 * Any read failure (missing file, permission denied, a directory at this path, ...) collapses to
 * "missing" — the failure policy treats all of them identically (fail open, loudly), and claiming
 * a specific reason here would be dishonest for at least the permission-denied case.
 */
export function readGateMirrorFile(mirrorPath: string): GateMirrorReadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(mirrorPath, "utf8");
  } catch {
    return { kind: "missing", path: mirrorPath };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "malformed", path: mirrorPath, reason: "not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "malformed", path: mirrorPath, reason: "not a JSON object" };
  }
  const value = parsed as Record<string, unknown>;

  if (typeof value.generation !== "number" || !Number.isFinite(value.generation)) {
    return { kind: "malformed", path: mirrorPath, reason: "missing or invalid `generation`" };
  }
  if (typeof value.generatedAt !== "number" || !Number.isFinite(value.generatedAt)) {
    return { kind: "malformed", path: mirrorPath, reason: "missing or invalid `generatedAt`" };
  }
  if (typeof value.format !== "number" || !Number.isInteger(value.format) || value.format !== GATE_MIRROR_FORMAT) {
    return {
      kind: "malformed",
      path: mirrorPath,
      reason: `format ${JSON.stringify(value.format)} is not the format this build reads (${GATE_MIRROR_FORMAT})`,
    };
  }
  if (
    !Array.isArray(value.entries) || !Array.isArray(value.stages)
    || !Array.isArray(value.circleAliases) || !Array.isArray(value.circles)
  ) {
    return { kind: "malformed", path: mirrorPath, reason: "missing entries/stages/circleAliases/circles array" };
  }

  // ELEMENT SHAPE, UNCONDITIONAL (SHOULD-FIX 2, coordinator review round) — matching
  // readSidecarHeader's own structure: these run regardless of whether a checksum is present,
  // because a checksum-stripped-or-absent file is exactly the case they alone still guard.
  if (!value.entries.every(hasMirrorEntryShape)) {
    return { kind: "malformed", path: mirrorPath, reason: "an entries[] element has the wrong shape" };
  }
  if (!value.stages.every(hasMirrorStageShape)) {
    return { kind: "malformed", path: mirrorPath, reason: "a stages[] element has the wrong shape" };
  }
  if (!value.circleAliases.every(hasMirrorCircleAliasShape)) {
    return { kind: "malformed", path: mirrorPath, reason: "a circleAliases[] element has the wrong shape" };
  }
  // REFERENTIAL: entries⊆stages, unconditional, same reasoning — an entry naming a stageId this
  // same file's own stages[] does not carry can never be reached through evaluateGateFromMirror's
  // join (see that function's own matching loop), so it is not a rule this evaluator can deliver.
  const knownStageIds = new Set((value.stages as Array<{ id: string }>).map((stage) => stage.id));
  if (!(value.entries as Array<{ stageId: string }>).every((entry) => knownStageIds.has(entry.stageId))) {
    return { kind: "malformed", path: mirrorPath, reason: "an entries[] element names a stageId absent from stages[]" };
  }

  if (value.checksum !== undefined) {
    if (typeof value.checksum !== "string") {
      return { kind: "malformed", path: mirrorPath, reason: "checksum present but not a string" };
    }
    const { checksum, ...rest } = value;
    const recomputed = createHash("sha256").update(JSON.stringify(rest, null, 2), "utf8").digest("hex");
    if (recomputed !== checksum) {
      return { kind: "malformed", path: mirrorPath, reason: "checksum mismatch (file corrupted or hand-edited)" };
    }
  }

  // Narrowed by the checks above, not by a structural TS guarantee — see the comment above this
  // function for exactly what is (and is not) verified before this cast.
  return { kind: "ok", path: mirrorPath, mirror: value as unknown as GateMirror };
}

// ── Step 2: circle resolution WITHOUT the store ───────────────────────────────────────────────

export type GateCircleSource = "flag" | "env" | "remote" | "folder";

export interface ResolvedGateCircle {
  /** The RAW value its source produced — never alias-advanced here (see resolveGateCircle). */
  circle: string;
  source: GateCircleSource;
}

/**
 * The flag/env precedence ALONE — textual, no mirror and no remote/folder derivation needed.
 * Shared by the pre-mirror-read wildcard check in runGateUnguarded and (duplicated as the same
 * two lines, deliberately — see that call site) resolveGateCircle's own first two rungs, so the
 * two can never silently disagree about what counts as "an explicit pick".
 */
function rawCirclePick(explicitCircle: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  return explicitCircle?.trim() || env.MONET_CIRCLE?.trim() || undefined;
}

/**
 * Circle resolution WITHOUT the store (P1 fix, Codex round 2 on PR #40 — round 1's version of
 * this function ignored remotes entirely, which is the bug: see the chain below).
 *
 * THE CHAIN: explicit `--circle` → `MONET_CIRCLE` → **remote-aware pick** → folder derivation.
 * `folderSlug` is computed either way (the remote branch needs it too, for the membership check
 * below) via `@team-monet/core`'s own exported `deriveCircle` — a pure folder-hash (plus, when
 * available, a `git rev-parse --show-toplevel` subprocess call: I/O, never a store touch).
 *
 *   - No origin remote (`getOriginRemote` empty) → `folderSlug`. Unchanged from before this fix.
 *   - Origin remote present → THE REMOTE-AWARE PICK:
 *       `folderSlug ∈ mirror.circles` → use `folderSlug`.
 *       otherwise → `defaultNameFromRemote(remote)`.
 *
 * WHY MEMBERSHIP IN `mirror.circles` IS THE RIGHT QUESTION — delivery equivalence, store-lessly.
 * This resolver's only job is to pick whichever circle name makes rule DELIVERY match what a live
 * session (circle.ts's own `deriveCircle`) would get, without the store circle.ts is allowed to
 * read. Live's own precedence for an unmapped remote (circle.ts:79-105) is: Class A (the
 * folder-hash slug is aliased to a friendly name that already holds memory) → Class B (no alias,
 * but the raw slug itself already holds memory) → `defaultNameFromRemote` (a genuinely new repo).
 * `GateMirror.circles` was materialized FOR EXACTLY THIS (its own doc comment in
 * @team-monet/core/gates.ts: "Its consumer is the offline CLI's `--circle` resolver, slice 4b-C,
 * not yet built" — this is that consumer) and its content (`gateMirrorCircles`,
 * @team-monet/core/gates.ts:4366-4390) is every circle carrying a live rule, PLUS every `from`/`to`
 * name `circleAliases` mentions (both statuses, breadth `'*'` excluded). So:
 *   - Class A reproduces EXACTLY: an aliased slug is ALWAYS in `circles` (gateMirrorCircles adds
 *     every alias `from` name unconditionally), and picking `folderSlug` here lets the
 *     EVALUATOR's own one-hop alias resolution land it on the friendly name — the same single hop
 *     every other input gets (see this function's own history below).
 *   - Class B-WITH-gate-presence reproduces EXACTLY: a rule bound directly under the raw slug
 *     puts that slug in `circles` too (it carries a live rule), so `folderSlug` is queried
 *     directly and the rule delivers.
 *   - Class B-WITHOUT-any-gate-presence is DELIVERY-EQUIVALENT, not exact, and that is the
 *     honest claim: `folderSlug` is absent from `circles` in this case too (no gate rule lives
 *     there), so the `else` branch picks `defaultNameFromRemote` instead — but if NO entry is
 *     bound under `folderSlug` either way, the delivered rule set (breadth rules + whatever
 *     matches under the queried name) is IDENTICAL whichever of the two names this resolver
 *     queries. Live's own choice of `folderSlug` there was never about gate delivery; it was
 *     about not orphaning MEMORY (concepts/observations) under that slug, a concern this
 *     resolver has no way to see and no need to reproduce — it is not answering "what circle
 *     does this repo's memory live in", only "what circle would the live gate deliver from".
 *   - The genuinely-new-repo case (no alias, no memory, no gate presence at all) is exactly THE
 *     P1 THIS FIXES: `defaultNameFromRemote(remote)` is what a live session picks, and this
 *     resolver now picks the identical name instead of silently falling back to `folderSlug`
 *     (which a live session would never choose once a remote exists).
 *
 * RESIDUAL HONEST GAP, NARROWED to exactly one case: a CUSTOM `remote_circle_map` row — the
 * per-user consolidation feature (circle.ts's own "PER-USER CONSOLIDATION" comment, e.g. mapping
 * both `team-monet/monet-core` and `team-monet/monet-client` to one `example-circle` circle) — with no
 * alias trail leading back to `defaultNameFromRemote`'s own output. That mapping is DATA that
 * exists ONLY in the store; this resolver has no way to see it without opening exactly the store
 * it must never open. `--circle`/`MONET_CIRCLE` remain the honest escape hatches for that one
 * case, and slice 4b-D's `monet install` can pin `--circle` into the generated hook definition
 * from a live read taken once, at install time, closing the gap for every invocation after.
 *
 * ONE ALIAS PASS, AND IT IS THE EVALUATOR'S (Codex round 1, item 3, unchanged by this fix):
 * `evaluateGateFromMirror` already resolves whatever circle it is given through
 * `mirror.circleAliases` — single hop, matching the live resolver's own semantics exactly (see its
 * "RESOLVE THE QUERY CIRCLE THROUGH THE ALIAS MAP FIRST" comment in @team-monet/core/gates.ts).
 * An earlier version of THIS function also advanced the folder-derived slug through the alias map
 * itself before handing it over, which made folder-derived circles resolve TWICE (a chained
 * rename A→B, B→C evaluated a folder-derived A as C) while an explicit `--circle A` resolved once
 * (to B). This function must keep returning the RAW selection (flag/env text, the bare folder
 * slug, or `defaultNameFromRemote`'s own output) and NEVER alias-advance it — the `mirror` param
 * below exists ONLY to answer the `circles`-membership question above, never to look anything up
 * in `circleAliases`. The diagnostic line mirrors the evaluator's one hop for DISPLAY only
 * (describeResolvedCircle), never fed back into evaluation.
 *
 * MIRROR MAY BE NULL (the fail-open path — missing/malformed mirror, or a genuine read failure):
 * `opts.mirror?.circles.includes(folderSlug)` is then `undefined`, i.e. falsy, so the remote
 * branch falls through to `defaultNameFromRemote(remote)` whenever a remote exists — exactly the
 * prescribed fail-open behavior (a diagnostic-only best guess with no mirror data to check
 * against): remote present → the remote-derived name; no remote → the folder slug, unchanged.
 */
export function resolveGateCircle(opts: {
  explicitCircle?: string;
  env: NodeJS.ProcessEnv;
  projectDir: string;
  mirror: GateMirror | null;
  deriveFolderCircle?: (projectDir: string) => string;
  getOriginRemote?: (projectDir: string) => string;
}): ResolvedGateCircle {
  const explicit = opts.explicitCircle?.trim();
  if (explicit) return { circle: explicit, source: "flag" };

  const envCircle = opts.env.MONET_CIRCLE?.trim();
  if (envCircle) return { circle: envCircle, source: "env" };

  const deriveFolder = opts.deriveFolderCircle ?? coreDeriveCircle;
  const folderSlug = deriveFolder(opts.projectDir);

  const originRemote = opts.getOriginRemote ?? getOriginRemote;
  const remote = originRemote(opts.projectDir);
  if (!remote) return { circle: folderSlug, source: "folder" };

  if (opts.mirror?.circles.includes(folderSlug)) {
    return { circle: folderSlug, source: "folder" };
  }
  return { circle: defaultNameFromRemote(remote), source: "remote" };
}

/**
 * The diagnostic line shows the circle the EVALUATOR will actually answer under: the same single
 * alias hop `evaluateGateFromMirror` applies internally, computed here for display only (never
 * fed back into evaluation — that would be the double-resolution this file just removed). With no
 * mirror in hand (the fail-open path), no alias map exists and the raw value is shown as is.
 */
export function describeResolvedCircle(resolved: ResolvedGateCircle, mirror: GateMirror | null): string {
  const alias = mirror?.circleAliases.find((row) => row.from === resolved.circle);
  if (alias) {
    return `${alias.to} (mirror alias of ${resolved.circle}, resolved from ${resolved.source})`;
  }
  return `${resolved.circle} (resolved from ${resolved.source})`;
}

/**
 * Which model an agent-scoped rule compensates for — read the IDENTICAL way
 * `registerMonetCoreTools` (@team-monet/core/mcp-server.ts) reads it for the live MCP process, so
 * the two surfaces can never silently disagree about which rules exist for this runtime (the
 * divergence the tool-surface doc's `monet gate` row calls out by name). Not exported (it is
 * inline closure logic there, not a function), so this is the required reimplementation, not an
 * avoidable one: blank counts as absent, matching `MONET_MODEL_TAG=${VAR}` with `VAR` unset
 * expanding to `""` under ordinary env templating rather than to an unset variable.
 */
export function resolveRuntimeModelTag(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.MONET_MODEL_TAG;
  return raw?.trim() ? raw.trim() : undefined;
}

// ── Step 3: five outcomes, five exit codes ────────────────────────────────────────────────────

export interface GateOutcome {
  code: number;
  label: "silence" | "stage-hit-no-rules" | "advisory-inject" | "blocking-deny" | "overflow-ask";
}

/**
 * Overflow is checked first: it is a THIRD verdict, never a flavour of silence (GateResult.silence
 * is always false when overflow is true, by evaluateGateFromMirror's own construction, but this
 * does not rely on that — it checks overflow explicitly regardless). Stage-hit-no-rules is
 * distinct from silence the same way: `silence` is only true when NO stage matched at all.
 */
export function classifyGateResult(result: GateResult): GateOutcome {
  if (result.overflow) return { code: GATE_EXIT_CODE.OVERFLOW_ASK, label: "overflow-ask" };
  if (result.silence) return { code: GATE_EXIT_CODE.SILENCE, label: "silence" };
  if (result.rules.length === 0) return { code: GATE_EXIT_CODE.STAGE_HIT_NO_RULES, label: "stage-hit-no-rules" };
  const hasBlocking = result.rules.some((rule) => rule.severity === "blocking");
  return hasBlocking
    ? { code: GATE_EXIT_CODE.BLOCKING_DENY, label: "blocking-deny" }
    : { code: GATE_EXIT_CODE.ADVISORY_INJECT, label: "advisory-inject" };
}

/**
 * One line per rule, "text — reason", injection-ready. `reasonMissing` (a legally reasonless
 * relayed deny — see GateRule.reasonMissing's own comment in @team-monet/core/gates.ts) is
 * disclosed rather than hidden, matching that field's own design intent.
 */
function formatRuleLine(rule: GateRule): string {
  if (rule.reason) return `${rule.text} — ${rule.reason}`;
  if (rule.reasonMissing) return `${rule.text} — (no reason recorded: relayed from an older peer)`;
  return rule.text;
}

/** Human-readable age, coarse enough for a disclosure line, never sub-second precision. */
export function formatMirrorAge(generatedAt: number, now: number): string {
  const deltaMs = Math.max(0, now - generatedAt);
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

// ── Wiring ─────────────────────────────────────────────────────────────────────────────────────

export interface GateCliDependencies {
  now(): number;
  env: NodeJS.ProcessEnv;
  projectDir(): string;
  /** Resolves the effective mirror path from the `--mirror` option, applying the default when absent. */
  mirrorPath(explicitMirror?: string): string;
  /**
   * Reads the WHOLE stdin stream synchronously (4b-D, component A — the argv transport can never
   * carry an over-threshold context; --stdin is how one actually reaches the gate instead of
   * silently E2BIG-bypassing it in a wrapper before this CLI ever runs — see MAX_CONTEXT_BYTES /
   * overflow-ask). Default implementation is `readStdinSync` (this module, below) — NOT plain
   * `fs.readFileSync(0, "utf8")`, which fails with EAGAIN on a non-blocking piped stdin (a real,
   * empirically-reproduced failure for exactly the large-payload case --stdin exists to serve —
   * see readStdinSync's own comment).
   */
  readStdin(): string;
  /**
   * NIT (round-5 coordinator review): `--stdin` on an interactive terminal with nothing piped in
   * hangs forever awaiting EOF that never comes (a human sitting at a TTY, not a pipe, has no way
   * to signal end-of-input short of Ctrl-D). Checked BEFORE readStdin() is ever called so this
   * command refuses with a usage error instead — the same "never silently guess, never hang"
   * posture the rest of this file already applies to every other caller-input mistake.
   */
  isStdinTTY(): boolean;
  setExitCode(code: number): void;
  /**
   * Where to append the gate journal, or null to write none (`normative-hierarchy-2026-08-03.md`
   * §1/§5). Resolved the same way the hook wrapper resolves it — MONET_STORAGE_DIR, else ~/.monet —
   * and deliberately NOT via the project dir: a gate's cwd is whatever directory the host happened
   * to spawn it from, and a record that lands in a random project's .monet is worse than one that
   * always lands in the home store. Same reasoning the wrapper's own DENY_LOG_PATH comment gives.
   */
  journalPath(): string | null;
}

export function defaultGateCliDependencies(): GateCliDependencies {
  return {
    now: () => Date.now(),
    env: process.env,
    projectDir: resolveProjectDir,
    // BLOCKER 1 FIX (coordinator review round): the default mirror path must be rooted at the SAME
    // project directory circle resolution already uses (resolveProjectDir — MONET_PROJECT_DIR,
    // then CLAUDE_PROJECT_DIR, then cwd), not at the OS cwd directly. Before this fix,
    // getGateMirrorPath() with no argument resolved via getMonetDir()'s own internal
    // `process.cwd()` default — a SEPARATE "current project" notion from the circle's, silently
    // divergent whenever a host sets MONET_PROJECT_DIR/CLAUDE_PROJECT_DIR to something other than
    // its own cwd (exactly the shape a spawned hook process can have). See db/index.ts's
    // getMonetDir/getGateMirrorPath for the baseDir plumbing this relies on.
    mirrorPath: (explicitMirror) => (explicitMirror ? path.resolve(explicitMirror) : getGateMirrorPath(resolveProjectDir())),
    readStdin: readStdinSync,
    isStdinTTY: () => process.stdin.isTTY === true,
    journalPath: () =>
      path.join(process.env.MONET_STORAGE_DIR || path.join(os.homedir(), ".monet"), GATE_JOURNAL_FILENAME),
    setExitCode(code) {
      process.exitCode = code;
    },
  };
}

interface GateCommandOptions {
  circle?: string;
  stdin?: boolean;
  mirror?: string;
  tool?: string;
}

export type ActionContextSourceResult =
  | { kind: "ok"; raw: string }
  | { kind: "usage-error"; message: string };

/**
 * Which of {the positional argument, --stdin} supplies the raw action context text — resolved
 * BEFORE any of the Tool:-prefix / mirror / circle logic runs, since this decides whether there
 * is a raw context for that logic to run on at all (4b-D, component A).
 *
 * Exactly one of the two must be given: both present is refused (ambiguous — which one did the
 * caller mean?), neither present is refused (nothing to evaluate) — both usage errors, exit 1,
 * matching every other caller-input mistake this command already refuses rather than guesses at.
 */
export function resolveActionContextSource(
  positional: string | undefined,
  useStdin: boolean,
  readStdin: () => string,
): ActionContextSourceResult {
  if (positional !== undefined && useStdin) {
    return {
      kind: "usage-error",
      message: "action context given both as a positional argument and via --stdin; supply exactly one.",
    };
  }
  if (positional === undefined && !useStdin) {
    return {
      kind: "usage-error",
      message: "no action context given: supply it as a positional argument, or pass --stdin and pipe it in.",
    };
  }
  return { kind: "ok", raw: useStdin ? readStdin() : positional! };
}

/**
 * Never throws — every known failure mode sets an exit code and returns; an outer catch-all
 * guards against anything unanticipated in the same direction the rest of this command already
 * leans: fail OPEN, loudly, rather than crash or silently answer wrong (the boundary statement's
 * "never fail closed on an unknown", applied to this command's own defects too).
 */
/**
 * Records what this invocation actually did. Handed down into runGateUnguarded so that every one of
 * its exits — the deliberate refusals as much as the verdicts — names its own outcome.
 *
 * §1: "every early return is an outcome, not an exemption from recording". A guard that declines to
 * evaluate writes `declined: <reason>`. Had that line existed one layer up, monet-client#58's
 * host rename would have surfaced as `declined: foreign-tool` on day one instead of by hand-probing
 * months of silence.
 */
type GateJournalRecorder = (
  disposition: GateJournalDisposition,
  claimType: GateJournalClaimType,
  extra?: Record<string, unknown>,
) => void;

export function runGate(
  positionalActionContext: string | undefined,
  options: GateCommandOptions,
  deps: GateCliDependencies = defaultGateCliDependencies(),
): void {
  const journalPath = deps.journalPath();
  // The parent interception, when a host hook spawned this process. Passed by ENV rather than a
  // flag on purpose (see the wrapper's own comment): an older `monet` reached through the hook's
  // PATH fallback would reject an unknown flag as a usage error and report a broken install, while
  // an unknown env var has been ignored by every version there has ever been.
  const parentId = deps.env.MONET_GATE_JOURNAL_PARENT ?? null;
  // At the mouth — before the TTY guard, before stdin is read, before anything can refuse.
  const handle = openGateJournalEvent(journalPath, {
    mouth: "gate-cli",
    parentId,
    claimType: "source-observed",
  });

  // DEFAULTS TO A COMPLAINT, deliberately. If some path added later returns without recording, the
  // journal says so in as many words rather than quietly attributing the wrong outcome to it — a
  // record that guesses is worse than one that admits a gap, which is this whole design's thesis.
  let disposition: GateJournalDisposition = "declined: unrecorded-exit";
  let claimType: GateJournalClaimType = "unavailable";
  let extra: Record<string, unknown> = {};
  const record: GateJournalRecorder = (d, c, e) => {
    disposition = d;
    claimType = c;
    extra = e ?? {};
  };

  try {
    runGateUnguarded(positionalActionContext, options, deps, record);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`monet gate: internal error (${message}) — ${GATE_FAIL_OPEN_MARKER} (nothing blocked).`);
    deps.setExitCode(GATE_EXIT_CODE.SILENCE);
    record("declined: internal-error", "unavailable", { error: message });
  } finally {
    // In a finally so that a throw this function did not anticipate still closes its own event.
    // An arrival with no disposition would then mean what it should: the process died mid-evaluation.
    closeGateJournalEvent(journalPath, handle, { mouth: "gate-cli", disposition, claimType, parentId, ...extra });
  }
}

function runGateUnguarded(
  positionalActionContext: string | undefined,
  options: GateCommandOptions,
  deps: GateCliDependencies,
  record: GateJournalRecorder,
): void {
  // NIT (round-5 coordinator review): refuse BEFORE resolveActionContextSource ever calls
  // deps.readStdin() — on a real TTY (nothing piped), that call blocks forever waiting for input
  // that will never arrive short of a manual Ctrl-D. A usage error is the honest answer; a hang
  // is not.
  if (options.stdin === true && deps.isStdinTTY()) {
    console.error(
      `monet gate: --stdin was given but stdin is a TTY (nothing is piped in) — refusing rather ` +
        `than hanging until EOF. Pipe the action context in instead, e.g. ` +
        `echo "Bash:git push --force" | monet gate --stdin.`,
    );
    deps.setExitCode(USAGE_ERROR_EXIT_CODE);
    record("declined: stdin-is-tty", "unavailable");
    return;
  }

  // COMPONENT A (4b-D): resolve the raw context from EXACTLY ONE of {positional, --stdin} first.
  // --stdin exists because argv can never carry an over-threshold context (Codex round-1
  // deferral on 4b-C: this OS's ARG_MAX, ~1 MiB, is smaller than the engine's own 4 MiB overflow
  // threshold — see this slice's report — so an oversized context passed as a bare positional
  // argument never reaches this process at all; the shell/exec layer rejects it with E2BIG before
  // `monet` even starts, which is a silent, wrapper-level "never asked" rather than the honest
  // overflow-ask (exit 40) outcome 40 exists to name). Reading the WHOLE stream raw, no JSON
  // parsing at this layer, mirrors argv's own contract exactly: the caller hands over the literal
  // text to evaluate, nothing more.
  const source = resolveActionContextSource(positionalActionContext, options.stdin === true, deps.readStdin);
  if (source.kind === "usage-error") {
    console.error(`monet gate: ${source.message}`);
    deps.setExitCode(USAGE_ERROR_EXIT_CODE);
    record("declined: no-action-context", "unavailable", { detail: source.message });
    return;
  }
  const rawContext = source.raw;

  // Input-shape validation first: it is cheap, orthogonal to mirror/file state, and a caller bug
  // regardless of what the mirror looks like right now. Never "silently unmatched" — an
  // unprefixed context is refused (exit 1), not answered as if it were evaluated.
  let actionContext: string;
  try {
    actionContext = ensureToolPrefixedContext(rawContext, options.tool);
  } catch (error) {
    console.error(`monet gate: ${(error as Error).message}`);
    deps.setExitCode(USAGE_ERROR_EXIT_CODE);
    record("declined: unprefixed-context", "unavailable", { detail: (error as Error).message });
    return;
  }
  if (options.tool && parseActionContext(rawContext).tool !== null) {
    console.error(`monet gate: --tool ignored — action context already carries a 'Tool:' prefix.`);
  }

  // WILDCARD REFUSAL BEFORE THE MIRROR READ (Codex round 1, item 1 — PRESERVED through the P1 fix
  // below, not regressed by it): `--circle '*'` is a caller bug regardless of what sits at the
  // mirror path, and answering exit 0 before the wildcard was ever rejected would hide a
  // permanently invalid hook configuration inside the fail-open path until the day the mirror
  // became readable. This check is deliberately TEXTUAL and needs neither the mirror nor a full
  // resolveGateCircle call: '*' can only ever arrive via an explicit flag or env value — a bare
  // folder-hash slug and `defaultNameFromRemote`'s sanitized output can never literally equal
  // '*' (see remote-circle.ts's own sanitization, which strips every character outside
  // `[a-zA-Z0-9._-]`) — so checking the raw flag/env pick ALONE, before remote/folder derivation
  // and before the mirror exists, is sufficient and correct.
  if (rawCirclePick(options.circle, deps.env) === QUERY_WILDCARD_CIRCLE) {
    // Same refusal, same wording as core's own `assertQueryableCircle` (@team-monet/core/gates.ts,
    // not exported — see QUERY_WILDCARD_CIRCLE's comment), issued HERE so it cannot be masked by
    // the fail-open path. The catch around evaluateGateFromMirror below stays as the backstop for
    // any '*' that reaches the evaluator some other way.
    console.error(
      `monet gate: circle '*' is not a queryable circle: it is the reserved global-breadth marker ` +
        `on a rule BINDING, never a circle a query can be scoped to. Name a real circle — a global ` +
        `rule already delivers everywhere on its own, with no need to ask for it by this name.`,
    );
    deps.setExitCode(USAGE_ERROR_EXIT_CODE);
    record("declined: wildcard-circle", "unavailable", clipActionContext(actionContext));
    return;
  }

  const mirrorPath = deps.mirrorPath(options.mirror);
  const read = readGateMirrorFile(mirrorPath);

  // FULL CIRCLE RESOLUTION COMES AFTER THE MIRROR READ (P1 fix, Codex round 2 on PR #40):
  // resolveGateCircle's remote-aware pick needs `mirror.circles` to answer the delivery-
  // equivalence question (see that function's own doc comment) — `read.mirror` when readable,
  // `null` on the fail-open path (where the function still degrades correctly: remote present →
  // the remote-derived name, no remote → the folder slug — see its own "MIRROR MAY BE NULL"
  // paragraph). This can never produce '*' (already refused above, textually, before this point).
  const resolved = resolveGateCircle({
    explicitCircle: options.circle,
    env: deps.env,
    projectDir: deps.projectDir(),
    mirror: read.kind === "ok" ? read.mirror : null,
  });

  // FAILURE POLICY (boundary statement, adapted to a store-less reader): missing or malformed
  // both fail OPEN, loudly, exit 0 — identical to silence from a host's point of view, distinguished
  // only by the stderr line. Never fail closed on an unknown. REPAIR ADVICE UPDATED (4b-D,
  // component D): this used to say no caller anywhere passed `gateSidecarPath`, so the only honest
  // repair was a manual @team-monet/core API call — no longer true (component B wires it into
  // `start`'s own MonetCore construction, the ONE serving-process writer surface — see
  // bootstrap.ts's ServedCoreOptions.gateSidecarPath). The truer repair now is "is a `monet start`
  // session actually running for this project" — the one-shot `monet materialize` command now
  // regenerates registered standing-file skeleton blocks only; it deliberately does not regenerate
  // the separate gate mirror, so that honest gap remains named too.
  //
  // FRESH-INSTALL WORDING (P1-A, Codex round 1 on PR #42): this exact message is now ALSO what a
  // brand-new user sees verbatim in Claude Code's own transcript (install-cli.ts's wrapper greps
  // captured stderr for GATE_FAIL_OPEN_MARKER and surfaces a match as systemMessage) — "missing
  // mirror" is the state EVERY new install passes through (hook wired, no `monet start` session
  // has run yet), so the wording names that plainly rather than reading like an error report.
  if (read.kind !== "ok") {
    const problem = read.kind === "missing" ? `no readable mirror at ${mirrorPath}` : `mirror at ${mirrorPath} is unusable (${read.reason})`;
    console.error(
      `monet gate: ${problem} — ${GATE_FAIL_OPEN_MARKER} (nothing blocked). This is expected right ` +
        `after a fresh \`monet install\`: the hook is wired, but the mirror doesn't exist until a ` +
        `\`monet start\` session has run at least once for this project — it materializes and ` +
        `refreshes the file automatically from then on. Start one now, or re-run \`monet install\` ` +
        `if you're unsure the hook itself is even wired. The separate \`monet materialize\` command ` +
        `regenerates registered standing-file skeleton blocks, not this gate mirror.`,
    );
    console.error(`monet gate: circle ${describeResolvedCircle(resolved, null)}`);
    deps.setExitCode(GATE_EXIT_CODE.SILENCE);
    // THE EXIT CODE IS 0 — INDISTINGUISHABLE FROM SILENCE TO THE HOST, by the failure policy, and
    // that stays true. The record is where the difference survives: no rule set was ever consulted,
    // so nothing is known about whether this act is governed. "unavailable", never "silent".
    record("declined: mirror-unreadable", "unavailable", {
      ...clipActionContext(actionContext), circle: resolved.circle, mirrorPath, reason: read.kind,
    });
    return;
  }

  const runtimeModelTag = resolveRuntimeModelTag(deps.env);

  let result: GateResult;
  try {
    result = evaluateGateFromMirror(read.mirror, { actionContext, circle: resolved.circle, runtimeModelTag });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (resolved.circle === QUERY_WILDCARD_CIRCLE) {
      // BACKSTOP ONLY: the pre-mirror wildcard check above refuses '*' before evaluation is ever
      // reached, so this branch is unreachable through this command's own resolution today. Kept
      // because assertQueryableCircle (@team-monet/core/gates.ts) is the authority on this refusal
      // and its thrown message is surfaced verbatim if it ever fires first.
      console.error(`monet gate: ${message}`);
      deps.setExitCode(USAGE_ERROR_EXIT_CODE);
      record("declined: wildcard-circle", "unavailable", { ...clipActionContext(actionContext), detail: message });
      return;
    }
    // Structurally, assertQueryableCircle's `circle === '*'` check is the only throw this function
    // has (see its source) — so resolved.circle !== '*' here means something unanticipated by this
    // command's own shape guard slipped through. Fail open rather than crash.
    console.error(`monet gate: evaluation failed unexpectedly (${message}) — ${GATE_FAIL_OPEN_MARKER} (nothing blocked).`);
    console.error(`monet gate: circle ${describeResolvedCircle(resolved, read.mirror)}`);
    deps.setExitCode(GATE_EXIT_CODE.SILENCE);
    record("declined: evaluation-failed", "unavailable", {
      ...clipActionContext(actionContext), circle: resolved.circle, error: message,
    });
    return;
  }

  console.error(`monet gate: circle ${describeResolvedCircle(resolved, read.mirror)}`);
  const outcome = classifyGateResult(result);
  switch (outcome.label) {
    case "advisory-inject":
      for (const rule of result.rules) console.log(formatRuleLine(rule));
      break;
    case "blocking-deny": {
      for (const rule of result.rules.filter((r) => r.severity === "blocking")) console.log(formatRuleLine(rule));
      // SHOULD-FIX 4 (coordinator review round): an advisory that ALSO fired alongside the deny
      // (same or another matched stage) must not simply vanish — stdout stays blocking-only (no
      // severity marker in the line protocol, so mixing severities there would make a reader
      // guess which line is the enforceable one), but the advisory is still real guidance and
      // belongs somewhere. Disclosed on stderr instead of dropped.
      for (const rule of result.rules.filter((r) => r.severity === "advisory")) {
        console.error(`monet gate: advisory also fired (not part of the deny): ${formatRuleLine(rule)}`);
      }
      // SHOULD-FIX 5 (coordinator review round): the boundary statement requires naming the
      // staleness AND the repair command in the SAME breath as the reason (gate-boundary-
      // statement.md, "Binding consequences for 4b", item 2) — the missing/malformed path already
      // does this; the deny path only disclosed age, not the repair. REPAIR ADVICE UPDATED (4b-D,
      // component D) — same reasoning as the missing/malformed path above: a running `monet start`
      // now keeps this file fresh on its own.
      const age = formatMirrorAge(read.mirror.generatedAt, deps.now());
      console.error(
        `monet gate: answering from a mirror generated ${age} ago — an offline answer is a cached ` +
          `answer. A running \`monet start\` session for this project refreshes this file on every ` +
          `gate-relevant write; if none is running (or it targets a different project), start one, ` +
          `or run \`monet install\` to wire the hook that depends on it. The separate ` +
          `\`monet materialize\` command regenerates standing-file skeleton blocks, not this mirror.`,
      );
      break;
    }
    case "stage-hit-no-rules":
      console.error(`monet gate: stage '${result.stage?.name ?? "?"}' matched with no live rules bound.`);
      break;
    case "overflow-ask":
      console.error(`monet gate: action context exceeds the refusal threshold — ask, never allow.`);
      break;
    case "silence":
      break;
  }
  deps.setExitCode(outcome.code);
  // The verdict, and the rule ids that produced it — the field #62's "declared but never fired"
  // query needs and that `gate_events` has never carried (it records rule_COUNT, not identity).
  //
  // claimType is `parsed`, NOT `source-observed`, and the distinction is the honest one: this
  // command answers from a materialized mirror by construction (it must work with the store down),
  // so every verdict it reports is true as of a frozen generation rather than as of the store. A
  // later pass reading this stream can tell a live answer from a cached one without guessing, which
  // is exactly what claim typing is for (§9.1).
  record(gateJournalDisposition(result), result.source === "live" ? "source-observed" : "parsed", {
    ...clipActionContext(actionContext),
    circle: resolved.circle,
    stageIds: result.stages.map((stage) => stage.id),
    stageNames: result.stages.map((stage) => stage.name),
    ruleIds: result.rules.map((rule) => rule.conceptId),
    gateExitCode: outcome.code,
    mirrorGeneratedAt: read.mirror.generatedAt,
  });
}

export function registerGateCommands(
  program: Command,
  deps: GateCliDependencies = defaultGateCliDependencies(),
): Command {
  program
    // OPTIONAL positional (4b-D, component A): --stdin supplies the context instead, and exactly
    // one of the two is required — enforced in resolveActionContextSource, not by commander's own
    // required-argument machinery, since commander has no "required unless --flag" primitive.
    .command("gate [action-context]")
    .description("Evaluate the offline gate mirror for an action context (no store, no network)")
    // SHOULD-FIX 3 (coordinator review round): commander's default silently binds only the FIRST
    // excess positional argument and drops the rest — an unquoted `monet gate Bash:terraform
    // apply` (two argv tokens) would otherwise evaluate just "Bash:terraform" and report silence,
    // the same silent-fail-open class ensureToolPrefixedContext already refuses for a missing
    // Tool: prefix. Refusing excess arguments outright closes it the same way.
    .allowExcessArguments(false)
    .option("--circle <name>", "Circle to query (default: MONET_CIRCLE env, else the remote-derived default when the repo has an origin, else folder derivation; the evaluator applies the mirror's one-hop alias map to every input)")
    .option("--mirror <path>", "Path to the gate mirror file (default: .monet/gate-mirror.json or ~/.monet/gate-mirror.json)")
    .option("--tool <name>", "Synthesize the required 'Tool:' prefix from this tool name when the action context omits it")
    .option("--stdin", "Read the action context from stdin instead of the positional argument (required for a context too large for argv — see overflow-ask; mutually exclusive with the positional)")
    .addHelpText("after", `
Exit codes (the host maps these; this command never enforces any of them):
  0   silence              no stage matched — nothing governs this action
  10  stage-hit-no-rules   a stage matched with no live rules bound (the projection-hook signal)
  20  advisory-inject      advisory rule(s) fired; stdout carries "text — reason", one per line
  30  blocking-deny        a blocking rule fired; stdout carries its reason, stderr discloses the
                           mirror's age and the repair command (an offline deny is a cached deny)
  40  overflow-ask         action context past the refusal threshold; NEVER map this to allow
  1   usage error          --circle '*' (not a queryable circle), no 'Tool:' prefix and no --tool,
                           excess positional arguments (quote the action context), or the action
                           context given both as a positional argument and via --stdin (or neither)

--help/-h and --version exit 0 through commander's own paths, before any evaluation runs — the
exit-code table above describes outcomes of an actual evaluation only.

An oversized action context can never reach this command as a positional argument — the OS's own
ARG_MAX (often ~1 MiB) is smaller than the engine's 4 MiB overflow threshold, so the shell/exec
layer itself rejects it (E2BIG) before \`monet\` starts. Pipe it in instead:
  echo "Bash:$LONG_COMMAND" | monet gate --stdin --tool Bash
`)
    .action((actionContext: string | undefined, options: GateCommandOptions) => {
      runGate(actionContext, options, deps);
    });
  return program;
}
