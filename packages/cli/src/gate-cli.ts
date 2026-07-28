import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  GATE_MIRROR_FORMAT,
  RULE_SCOPES,
  RULE_SEVERITIES,
  deriveCircle as coreDeriveCircle,
  evaluateGateFromMirror,
  parseActionContext,
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
 */
const QUERY_WILDCARD_CIRCLE = "*";

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

export class GateActionContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateActionContextError";
  }
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
  setExitCode(code: number): void;
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
    setExitCode(code) {
      process.exitCode = code;
    },
  };
}

interface GateCommandOptions {
  circle?: string;
  mirror?: string;
  tool?: string;
}

/**
 * Never throws — every known failure mode sets an exit code and returns; an outer catch-all
 * guards against anything unanticipated in the same direction the rest of this command already
 * leans: fail OPEN, loudly, rather than crash or silently answer wrong (the boundary statement's
 * "never fail closed on an unknown", applied to this command's own defects too).
 */
export function runGate(
  rawActionContext: string,
  options: GateCommandOptions,
  deps: GateCliDependencies = defaultGateCliDependencies(),
): void {
  try {
    runGateUnguarded(rawActionContext, options, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`monet gate: internal error (${message}) — failing OPEN (nothing blocked).`);
    deps.setExitCode(GATE_EXIT_CODE.SILENCE);
  }
}

function runGateUnguarded(rawActionContext: string, options: GateCommandOptions, deps: GateCliDependencies): void {
  // Input-shape validation first: it is cheap, orthogonal to mirror/file state, and a caller bug
  // regardless of what the mirror looks like right now. Never "silently unmatched" — an
  // unprefixed context is refused (exit 1), not answered as if it were evaluated.
  let actionContext: string;
  try {
    actionContext = ensureToolPrefixedContext(rawActionContext, options.tool);
  } catch (error) {
    console.error(`monet gate: ${(error as Error).message}`);
    deps.setExitCode(USAGE_ERROR_EXIT_CODE);
    return;
  }
  if (options.tool && parseActionContext(rawActionContext).tool !== null) {
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
  // only by the stderr line. Never fail closed on an unknown. No `monet materialize` command ships
  // in this client yet (checked: neither this CLI nor any call site that constructs MonetCore passes
  // `gateSidecarPath` today — see this slice's own report) — naming that honestly rather than
  // pointing at a command that does not exist.
  if (read.kind !== "ok") {
    const problem = read.kind === "missing" ? `no readable mirror at ${mirrorPath}` : `mirror at ${mirrorPath} is unusable (${read.reason})`;
    console.error(
      `monet gate: ${problem} — failing OPEN (nothing blocked). No 'monet materialize' command ships ` +
        `in this CLI yet; regenerate via @team-monet/core's MonetCore#materializeGateMirror against ` +
        `the live store until it does.`,
    );
    console.error(`monet gate: circle ${describeResolvedCircle(resolved, null)}`);
    deps.setExitCode(GATE_EXIT_CODE.SILENCE);
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
      return;
    }
    // Structurally, assertQueryableCircle's `circle === '*'` check is the only throw this function
    // has (see its source) — so resolved.circle !== '*' here means something unanticipated by this
    // command's own shape guard slipped through. Fail open rather than crash.
    console.error(`monet gate: evaluation failed unexpectedly (${message}) — failing OPEN (nothing blocked).`);
    console.error(`monet gate: circle ${describeResolvedCircle(resolved, read.mirror)}`);
    deps.setExitCode(GATE_EXIT_CODE.SILENCE);
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
      // does this; the deny path only disclosed age, not the repair. Same honest wording: no
      // `monet materialize` command ships in this client yet (see readGateMirrorFile's own
      // comment / this slice's report).
      const age = formatMirrorAge(read.mirror.generatedAt, deps.now());
      console.error(
        `monet gate: answering from a mirror generated ${age} ago — an offline answer is a cached ` +
          `answer. No 'monet materialize' command ships in this CLI yet; regenerate via ` +
          `@team-monet/core's MonetCore#materializeGateMirror against the live store to refresh it.`,
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
}

export function registerGateCommands(
  program: Command,
  deps: GateCliDependencies = defaultGateCliDependencies(),
): Command {
  program
    .command("gate <action-context>")
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
    .addHelpText("after", `
Exit codes (the host maps these; this command never enforces any of them):
  0   silence              no stage matched — nothing governs this action
  10  stage-hit-no-rules   a stage matched with no live rules bound (the projection-hook signal)
  20  advisory-inject      advisory rule(s) fired; stdout carries "text — reason", one per line
  30  blocking-deny        a blocking rule fired; stdout carries its reason, stderr discloses the
                           mirror's age and the repair command (an offline deny is a cached deny)
  40  overflow-ask         action context past the refusal threshold; NEVER map this to allow
  1   usage error          --circle '*' (not a queryable circle), no 'Tool:' prefix and no --tool,
                           or excess positional arguments (quote the action context)

--help/-h and --version exit 0 through commander's own paths, before any evaluation runs — the
exit-code table above describes outcomes of an actual evaluation only.
`)
    .action((actionContext: string, options: GateCommandOptions) => {
      runGate(actionContext, options, deps);
    });
  return program;
}
