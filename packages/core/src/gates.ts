/**
 * Rules, stages, and the gate engine — the deterministic firing path.
 *
 * The design of record says a rule is "bound to a
 * specific action, delivered by lookup at the moment of that action", that "a gate fires
 * deterministically: the host intercepts the action and asks Monet — no model, no judgment, no
 * network in the path, and silence when nothing matches", and that stages "need no taxonomy and no
 * self-recognition — a correction landing on an action with no stage IS the stage's creation".
 *
 * This module owns every statement against `stages`, `rule_bindings` and `gate_events`; the engine
 * delegates (refactoring-build directive, same shape as src/resolution.ts and src/lifecycle-edges.ts).
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * THE TRIGGER PATTERN FORMAT
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * A pattern is a TOOL CONSTRAINT plus an ORDERED TOKEN RUN:
 *
 *     { "tool": "Bash", "tokens": ["git", "push", "--force"] }      rendered:  Bash: git push --force
 *     { "tool": null,   "tokens": ["terraform", "apply"] }          rendered:  *: terraform apply
 *
 * It FIRES on an action context when (a) the pattern's tool equals the context's tool, or the
 * pattern names no tool at all, and (b) the pattern's tokens appear as a CONTIGUOUS RUN anywhere in
 * the context's token stream. So `Bash: git push --force` fires on `Bash:git push --force origin
 * main` and on `Bash:cd /x && git push --force origin dev`, and stays silent on `Bash:git status`
 * and `Read:/etc/hosts`.
 *
 * Why this format, against the four constraints the slice was given:
 *
 *   DETERMINISTIC — the whole matcher is `===` over lowercased tokens. No scoring, no thresholds,
 *   no clock, no embedder. The same (pattern, context) pair answers the same way forever, which is
 *   what lets a blocking rule be a safety boundary rather than a probability.
 *
 *   SUB-MILLISECOND AT HUNDREDS OF STAGES — matching one pattern is O(|context| × |pattern|) string
 *   comparisons over token arrays that are tens of entries long, and the first-token check rejects
 *   almost every non-match after ONE comparison. 200 stages is a few thousand comparisons.
 *
 *   EXPLAINABLE — the rendered form IS the rule of firing: "this tool, these words in this order,
 *   somewhere in the command". That is the property a regex would destroy first. It is NOT a claim
 *   that a reader can predict firing with no further knowledge, and the earlier version of this
 *   comment said so wrongly: matching happens over NORMALIZED tokens, so a reader also has to know
 *   the three normalizations `normalizeMatchToken` performs (case, quoting, backslash escapes). The
 *   honest claim is that the rendered pattern plus one short, fixed, documented normalization rule
 *   predicts firing — not the pattern alone.
 *
 *   NO REGEX FROM USER CONTENT — nothing here ever constructs a RegExp (or a LIKE/GLOB pattern) out
 *   of stored or caller-supplied text. The only regexes in this module are fixed literals used to
 *   validate a tool name. A pathological pattern cannot blow up the matcher: pattern length is
 *   capped on the write path, and match cost is linear in the context's length.
 *
 * NORMALIZATION, AND WHY IT IS ONE FUNCTION. `git "push" --force` is the same command to the shell
 * as `git push --force`, so a gate that fired on one and not the other would be defeated by a pair
 * of quotes. Both sides of every comparison therefore pass through `normalizeMatchToken`: the
 * context tokens on the way out of the tokenizer, and the pattern tokens on the way out of storage.
 * ONE function, applied on BOTH sides, is the whole anti-drift mechanism — two functions that agree
 * today are two functions that can stop agreeing.
 *
 * WHAT NORMALIZATION DELIBERATELY DOES NOT DO — the accepted non-matches, all one judgement:
 *
 *   - `-f` does not match `--force`, and `--force=true` does not match `--force`. Genuinely
 *     different tokens; teaching the matcher otherwise means teaching it every tool's flag grammar,
 *     which is how a deterministic matcher becomes a heuristic one.
 *   - ANSI-C QUOTING: `$'git' push --force` does not match a `git push --force` pattern (the token
 *     reads `$git`). This one is a deliberate stop, not an oversight. The common ACCIDENTAL ways a
 *     command gets written differently — ordinary quotes, backslash escapes, line continuations,
 *     shell comments, newlines between commands — are all handled, because those happen by
 *     accident and a gate that missed them would miss real work. `$'...'` carries its own escape
 *     table (`\n`, `\t`, `\xHH`, `\uHHHH`, `\'`), and a partial implementation is worse than
 *     none: stripping the `$` and treating the run as literal would turn `$'a\nb'` into the three
 *     characters `a`, `\`, `n`, `b` rather than the two words the shell produces — a wrong answer
 *     dressed as a right one, in a matcher whose whole value is that its answers are predictable.
 *     Implement the escape table in full or leave the token alone; this leaves it alone.
 *
 * A stage that needs any of these spellings gets a pattern for each, by declaration.
 *
 * SEEDING (byproduct law — "the trigger pattern is seeded from the concrete instance visible at the
 * capture moment"). `seedTriggerPattern("Bash:git push --force origin main")` yields
 * `Bash: git push --force`, by three mechanical steps:
 *
 *   1. Split the tool prefix off the first `:`, but only when the text before it is a bare
 *      identifier (`Bash`, `Read`, `Task`). `psql -c "select 1:2"` therefore has NO tool prefix
 *      rather than a nonsense one.
 *   2. Tokenize the command shell-ishly: quoted runs are one token, and `&&`, `||`, `;`, `|` are
 *      their own tokens (so they can never be swallowed into a word). Then take the LONGEST
 *      segment between those separators, ties broken toward the first. `cd /x && git push --force
 *      origin dev` seeds from the push, not the cd; `git push --force && echo done` also seeds from
 *      the push. The substantive command in a chain is the long one — navigation prologues and
 *      `echo` epilogues are short — and picking by length needs no verb blocklist to maintain.
 *   3. Keep the command word through the LAST FLAG-SHAPED TOKEN, dropping the operands after it;
 *      with no flag at all, keep the first two tokens (command + subcommand). The correction that
 *      births the rule is almost never about `origin main` — it is about `--force`, and about
 *      `apply` rather than which workspace. Keeping the flags is what makes the pattern fire on the
 *      dangerous shape and stay silent on the safe sibling. A run that would end up ALL FLAGS is
 *      refused: `--force` alone fires on `rm -rf --force` and on every other command that happens
 *      to carry that flag, which is a stage that means nothing. Such a stage is born PATTERN-LESS
 *      and inert, appears in `unverifiedPatterns`, and must be armed by declaration.
 *
 * Seeding is a heuristic over one observed instance and is expected to be wrong sometimes. That is
 * survivable BY CONSTRUCTION and not by care: a pattern that never fires shows up in
 * `gateStats().unverifiedPatterns` (stages carry `verified`, flipped on first live fire), and
 * DECLARATION replaces a stage's patterns outright. The failure mode of a bad seed is a dead
 * pattern surfaced in curation, never a wrong deny — blocking severity is declaration-only.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * THE GATE MIRROR IS A MIRROR, NOT A COPY
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `materializeGateMirror` writes every LIVE RULE — advisory and blocking alike — plus the full
 * stage registry to a local JSON file, so a host CLI can answer the WHOLE gate without reaching the
 * server, not only the offline-deny case ("one artifact, one staleness contract... answerable with
 * the server down" — the `monet gate` contract). The design's own
 * distinction applies verbatim: a source's copy competes with the file as truth, while a MIRROR is
 * a build artifact with an unambiguous master. The store is master. The file is regenerated at
 * every declaration — never edited, never read back as authority, and safe to delete (the next
 * declaration rebuilds it, and `engine.materializeGateMirror(path)` rebuilds it on demand).
 *
 * RULED 2026-07-28 (slice 4b-B): this artifact began as the "blocking sidecar" (slice 4a) — blocking
 * rules only, deliberately kept small for the offline-deny case. That scope is superseded: extending
 * the SAME artifact to carry every live rule (not shipping a second file) keeps one staleness
 * contract instead of two, and is what makes `monet gate` answerable offline in full — per the
 * boundary statement's own dated supersession clause. The on-disk path and the
 * `gateSidecarPath` config key are unchanged; only the entries widened and the names stopped saying
 * "blocking" for an artifact that no longer only carries blocking rules.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { StoragePort } from "./storage";

// ---- vocabulary -------------------------------------------------------------

/**
 * Breadth is a property of the MEMBER, and `*` is a breadth, not a circle (ratified 2026-07-28).
 * A rule carries it on its binding; a principle/preference carries it on its concept membership
 * metadata. A global member delivers in EVERY circle, unioned with the local circle's own members —
 * no shadowing or precedence. Stages are already store-global and therefore carry no breadth.
 *
 * `*` IS NEVER A CIRCLE A CONCEPT LIVES IN. It is a reserved breadth marker forbidden as a circle
 * name at every circle-minting surface (the MonetCore constructor's
 * `defaultCircle`, `store()`'s concept circle, `reassignCircle`'s `toCircle`, `renameCircle`'s
 * `from`/`to`, a relayed CONCEPT row's circle, `createSource`'s registered circle — Codex round 4,
 * item 3, `saveWorkstream`'s own explicit circle — Codex round 7, item 4) — see each surface's own
 * guard. Relayed `rule_bindings.circle` and `concepts.skeleton_breadth` values, by contrast, carry
 * breadth verbatim: relay is not a second way to mint it (sovereignty is unchanged — `*` enters
 * only through the declaration surface), but a peer that already holds a legitimately-declared
 * global member must not lose it on sync.
 */
export const BREADTH_CIRCLE = "*";

/**
 * The PREFERRED (first-choice) destination for a concept that used to live in a circle literally
 * named `*` (review fix — Codex round 1, item 4; the probing behavior below is round 2, item 3).
 * 1.3.1 — RELEASED, predating breadth entirely — accepted any circle name a caller supplied (env
 * var, constructor arg, folder derivation): a real store may hold concepts whose `circle` column is
 * the literal string `*`, with no rule bindings at all (1.3.1 shipped before `rule_bindings`
 * existed). Once breadth ships, every circle-minting surface refuses `*` (BREADTH_CIRCLE's own
 * comment enumerates them) — so those concepts, left alone, are either STRANDED (nothing can create
 * a sibling there, and a rule later bound to one would hit the `rule_bindings.circle` CHECK the
 * moment the backfill tried to copy `*` onto it) or worse, SEMANTICALLY REINTERPRETED as global
 * breadth the first time anything treats their circle name as meaningful rather than historical.
 * `MonetCore`'s own construction sequence (`migrateLegacyStarCircle`, engine.ts — moved there from
 * this module in round 2, item 2; see that method's own comment for why and for the seam decision)
 * renames them to this name, or a numbered variant, before that can happen.
 *
 * NOT A GUARANTEED FINAL NAME (round 2, item 3): this literal string can collide with a circle a
 * real user already named "legacy-star" on purpose, which would silently merge two unrelated
 * populations into one namespace. The migration PROBES for an unused destination at migration
 * time — this constant first, then `legacy-star-2`, `legacy-star-3`, … — and uses whichever is
 * actually free. This constant therefore names the PREFERENCE, not a promise; a store-wide count of
 * "how many concepts ended up somewhere in this family" (`MemoryOverview.legacyStarConcepts`,
 * engine.ts) matches this string OR any numbered variant of it, by a GLOB pattern, rather than
 * assuming this exact name was actually used.
 *
 * Whichever name is actually chosen, the destination is a raw column UPDATE, never `circle_aliases`
 * (an alias entry would make `resolveCircle('*')` resolve, which would poison every breadth query:
 * `*` must stay permanently unresolvable as a circle name, not merely unmintable as one). Ordinary
 * in every other respect afterward — searchable, listable, renamable via the normal API.
 */
export const LEGACY_STAR_CIRCLE = "legacy-star";

/**
 * Severity decides the FAILURE MODE, not the importance: advisory injects, blocking denies.
 * Blocking is declaration-only — "no agent, and no projection, can self-assign deny power" — and
 * that is enforced at the SCHEMA level (see the `severity != 'blocking' OR origin = 'declaration'`
 * CHECK below), not only by the write paths that happen to respect it today.
 */
export type RuleSeverity = "advisory" | "blocking";

export const RULE_SEVERITIES: readonly RuleSeverity[] = ["advisory", "blocking"] as const;

/**
 * `domain` = true for a perfect agent (transfers across models). `agent` = a compensation for THIS
 * model's failure habits, and therefore carries a model tag. Assigned at capture, conservatively:
 * "when uncertain, tag `agent` — a wrong agent tag merely re-verifies on model change, a wrong
 * domain tag shackles the next model."
 */
export type RuleScope = "domain" | "agent";

export const RULE_SCOPES: readonly RuleScope[] = ["domain", "agent"] as const;

/** How a stage came to exist. "Stages have two entrances too": correction and declaration. */
export type StageOrigin = "correction" | "declaration" | "import";

export const STAGE_ORIGINS: readonly StageOrigin[] = ["correction", "declaration", "import"] as const;

/**
 * How a rule came to be bound to its stage. `projection` (a principle producing the rule for a gate
 * nobody has visited) has no write path in this slice — principles arrive with the skeleton — but
 * the vocabulary is fixed here so the projection slice adds a producer, not a schema change.
 */
export type RuleBindingOrigin = "correction" | "declaration" | "projection" | "import";

export const RULE_BINDING_ORIGINS: readonly RuleBindingOrigin[] = [
  "correction",
  "declaration",
  "projection",
  "import",
] as const;

// ---- row shapes (column names match the DB schema exactly) ------------------

export interface StageRow {
  id: string;
  /** Normalized (trimmed, whitespace-collapsed, lowercased) — see `normalizeStageName`. UNIQUE. */
  name: string;
  /** JSON array of TriggerPattern. Replaced wholesale by declaration; never appended to blindly. */
  trigger_patterns: string;
  origin: StageOrigin;
  /** 0 until this stage's patterns have matched a real action at least once, anywhere. */
  verified: number;
  created_at: number;
  sync_updated_at: number;
  sync_revision: number;
  sync_writer: string | null;
}

export interface RuleBindingRow {
  /** The rule concept. PRIMARY KEY: a rule binds to exactly one stage. */
  concept_id: string;
  stage_id: string;
  severity: RuleSeverity;
  scope: RuleScope;
  /** Non-null exactly when scope = 'agent': which model's compensation this is. */
  model_tag: string | null;
  origin: RuleBindingOrigin;
  declared_by: string | null;
  /** The prevented-failure one-liner the gate renders. "The reason is what earns compliance." */
  reason: string | null;
  /**
   * Where this binding delivers — an ordinary circle name, or the breadth marker `BREADTH_CIRCLE`
   * ("*"), meaning every circle. NOT the same field as `concepts.circle`: the rule's CONCEPT keeps
   * living in its own real circle (searchable, listable there, exactly as before); this column is
   * the binding's own, independent locality declaration, normally kept in sync with the concept's
   * circle by every write path (bindRule, moveConcept, renameCircle) and ONLY diverges from it for
   * a breadth binding. See BREADTH_CIRCLE's own comment.
   */
  circle: string;
  created_at: number;
  sync_updated_at: number;
  sync_revision: number;
  sync_writer: string | null;
}

// ---- schema -----------------------------------------------------------------

/**
 * Bare additive DDL, following the existing `CREATE TABLE IF NOT EXISTS` precedents in `init()`.
 * No schema-version bump: an older binary opening a newer store never reads these tables, and a
 * newer binary opening an older store creates them empty. (Same convention and same reasoning as
 * LIFECYCLE_EDGE_SCHEMA_SQL.)
 *
 * WHY STAGES ARE STORE-GLOBAL AND CARRY NO CIRCLE. A stage is a REGISTRY ENTRY (name + trigger
 * patterns), not memory — the design says so explicitly, and the mechanics agree: the stage set is
 * "the union of corrected actions", and `git push --force` is the same action whichever project you
 * are standing in. Locality lives on the BINDING (`rule_bindings.circle`, added for breadth —
 * see BREADTH_CIRCLE's own comment), normally kept equal to its rule's own concept circle, so
 * `gateQuery` scopes by the binding directly rather than joining to the concept for locality. One
 * registry, many circles' rules — plus the one reserved breadth marker that means every circle.
 *
 * WHY `verified` EXISTS. Declaration- and import-born stages author their patterns from a NAME
 * rather than from an observed instance, so nothing proves the pattern matches anything real. The
 * flag is the proof, and the gate-fire is what supplies it: "flagged unverified until its first
 * fire; the gate-fire-rate measure catches dead patterns."
 *
 * WHY THE BLOCKING CHECK IS IN THE TABLE. "Blocking is declaration-only: no agent, and no
 * projection, can self-assign deny power" is a SAFETY BOUNDARY, and a safety boundary enforced only
 * by the code paths that currently exist is enforced until someone adds a path. Expressible in SQL,
 * so enforced in SQL: a raw INSERT cannot mint deny power either.
 */
export const GATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS stages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    trigger_patterns TEXT NOT NULL,   -- JSON array of {tool: string|null, tokens: string[]}
    origin TEXT NOT NULL CHECK (origin IN ('correction','declaration','import')),
    verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
    created_at INTEGER NOT NULL,
    sync_updated_at INTEGER NOT NULL,
    -- Convergence clock for the mutable columns (trigger_patterns, origin). A bare sync_updated_at
    -- comparison cannot decide these: the local value is the receiver's relay watermark and the
    -- incoming value is the sender's, two incomparable clock domains. (revision, writer) is the
    -- house pattern for mutable row convergence — circle_aliases, first_block, lifecycle_edges.
    -- verified is deliberately OUTSIDE that contest: it is grow-only (see the graft path).
    sync_revision INTEGER NOT NULL DEFAULT 0,
    sync_writer TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_stages_sync ON stages(sync_updated_at);

  CREATE TABLE IF NOT EXISTS rule_bindings (
    concept_id TEXT PRIMARY KEY,      -- the rule concept; one rule, one stage
    stage_id TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('advisory','blocking')),
    scope TEXT NOT NULL CHECK (scope IN ('domain','agent')),
    model_tag TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('correction','declaration','projection','import')),
    declared_by TEXT,
    reason TEXT,
    -- Locality, and (as of breadth) the ONLY place a rule's locality is checked (RULE_LIVENESS_WHERE
    -- reads this column, not the concept's own circle). Nullable at the SQL layer — same lattice as
    -- model_tag above — because a store upgraded via the guarded ALTER below carries pre-existing
    -- rows with no value until the one-time backfill runs; bindRule (the only writer of a NEW row)
    -- never leaves it null. See RuleBindingRow.circle's own comment for why this diverges from
    -- concepts.circle at all.
    circle TEXT,
    created_at INTEGER NOT NULL,
    sync_updated_at INTEGER NOT NULL,
    sync_revision INTEGER NOT NULL DEFAULT 0,
    sync_writer TEXT,
    -- THE SAFETY BOUNDARY, in the schema. Blocking severity exists only by declaration.
    CHECK (severity != 'blocking' OR origin = 'declaration'),
    -- THE SAME SAFETY BOUNDARY, for breadth: global reach exists only by declaration OR by a
    -- GOVERNED INHERITANCE through supersession (review fix -- Codex round 3, item 2) -- exactly
    -- parallel to blocking severity above, except correcting a global rule must be able to carry
    -- its reach forward to the successor, the same way it already carries reason, scope, and model
    -- tag forward. Refusing that would silently narrow a global rule to local the moment anyone
    -- corrected it -- exactly the removed-by-accident failure this whole review series exists to
    -- close, one mechanism over. bindRule's own predecessorCircle check (gates.ts) is the REAL
    -- sovereignty boundary -- this CHECK alone cannot tell inheriting from minting, so it stays a
    -- coarse backstop against capture/import specifically, wide enough for the app-level check to
    -- do the precise work. NULL passes (a not-yet-backfilled legacy row is never '*', since '*' did
    -- not exist before this slice), which is what lets the guarded ALTER below add this CHECK
    -- without first requiring every existing row to already satisfy it.
    CHECK (circle != '${BREADTH_CIRCLE}' OR origin IN ('declaration','correction')),
    -- An 'agent'-scoped rule is a compensation for a SPECIFIC model; without the tag, the "a new
    -- model retires the old model's compensations automatically" maintenance rule has nothing to
    -- read. A 'domain' rule claims to transfer, so a model tag on it would be a contradiction.
    CHECK ((scope = 'agent') = (model_tag IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS idx_rule_bindings_stage ON rule_bindings(stage_id);
  CREATE INDEX IF NOT EXISTS idx_rule_bindings_sync ON rule_bindings(sync_updated_at);
  -- The sidecar regeneration query and the "is deny power in play" probe both scan this predicate.
  CREATE INDEX IF NOT EXISTS idx_rule_bindings_blocking ON rule_bindings(severity)
    WHERE severity = 'blocking';
  -- idx_rule_bindings_circle is NOT here (review fix, BLOCKER B1). This whole string execs
  -- unconditionally, first, on every open (see createGateSchema below) — including against an
  -- UPGRADED store where circle does not exist as a column yet. CREATE TABLE IF NOT EXISTS
  -- degrades safely into a no-op there, but CREATE INDEX ... ON rule_bindings(circle) does not:
  -- it names a real column and SQLite evaluates that reference immediately, so every existing store
  -- failed to open with "no such column: circle" the moment this index sat here. The index is
  -- created in createGateSchema itself, AFTER the guarded ALTER, where the column is guaranteed to
  -- exist under every path (fresh install via this CREATE TABLE, or upgrade via the ALTER).

  /*
   * GATE INSTRUMENTATION. The design names the empirical checks it wants on gates — "fire precision
   * and silence rate (the gate-firing design's own measures)" — so the log ships WITH the firing
   * path rather than being retrofitted once a suspicion arises: a rate you could not compute for
   * the weeks before you thought to ask is a rate you cannot use to judge the design.
   *
   * ONE ROW PER gateQuery(), including the silences. Completeness is what makes it a RATE: silence
   * is the denominator of fire precision and the numerator of silence rate, so a log of only the
   * fires would measure nothing.
   *
   * VOLUME IS NOT resolution_events' VOLUME, and an earlier version of this comment implied it was.
   * resolution_events gets one row per memory_store — an act a human or agent chose to perform,
   * numbering in the hundreds per day at most. This table gets one row per INTERCEPTED ACTION: every
   * Bash call, every tool invocation on a wired surface, whether or not anything matched. That is
   * two or three orders of magnitude more, and it grows with how hard the agent is working rather
   * than with how much is being remembered.
   *
   * RETENTION IS DEFERRED, EXPLICITLY. Nothing prunes this table today, and on a busy store it will
   * become the largest one. The house already has the precedent to copy when that day comes —
   * SOURCE_ATTEMPT_EVENT_RETENTION (source-ledger.ts:44) keeps only the newest 128 immutable
   * attempt receipts per source — and the equivalent here is a per-circle cap plus a rolled-up
   * daily aggregate, since the RATES are what curation reads and the individual rows only matter
   * while they are recent enough to investigate. Not built now: capping before there is a single
   * real store's volume to size it against would be guessing, and a wrong cap silently destroys the
   * evidence the design says to measure.
   *
   * LOCAL AND UNSYNCED, exactly like resolution_events (engine.ts init()): this records what THIS
   * device was asked to do, at THIS device's stage set. Replicating it would merge two machines'
   * action streams under one timeline and make every rate computed from it a lie. It is therefore
   * absent from maxPersistedSyncTimestamp's table map and from the sync envelope, and its clock is
   * wall time rather than the persisted sync clock.
   *
   * action_context IS THE RAW ACTION, verbatim — the actual command line, path or prompt the host
   * intercepted. That is deliberate (curation needs to see what a stage failed to match, and a
   * normalized context answers a different question), and it is the reason this table is the most
   * privacy-sensitive one in the store: it can hold /Users/... paths, hostnames and flags. Two
   * consequences, both already true of this schema rather than new: the table is local-only so
   * nothing leaves the machine, and anything derived FROM the store for sharing must scrub it. The
   * existing schema-driven scrub closure (scripts/scrub-db.mjs + scrub-db-closure.test.ts) walks
   * every TEXT column of every table at runtime and therefore covers this column automatically the
   * moment it holds a match — it does not enumerate columns by name, which is exactly why it was
   * built that way.
   */
  CREATE TABLE IF NOT EXISTS gate_events (
    -- INTEGER PRIMARY KEY (SQLite's rowid alias), not a generator id: instrumentation must not
    -- perturb the thing it instruments by consuming ids from the same sequence concepts use.
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    action_context TEXT NOT NULL,
    -- The stage that ANSWERED: the one contributing the highest-severity rule. Not the oldest —
    -- when a deny and an advisory both match, the row must name the stage that produced the deny,
    -- or a curation reader auditing "which stage is blocking me" reads the wrong name. NULL =
    -- silence. Every matched stage is in gate_event_stages below.
    matched_stage_id TEXT,
    rule_count INTEGER NOT NULL,
    max_severity TEXT,                -- NULL when no rule fired
    latency_us INTEGER NOT NULL,
    circle TEXT NOT NULL,
    -- The STORED text is an excerpt of a longer command. Storage only: matching always ran on the
    -- whole thing, so unlike the two capped matchers this replaced, it says nothing about coverage.
    truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
    -- The context was past the refusal threshold and nothing was matched against it. Distinct from
    -- a silence with rule_count 0: that one means nothing governs, this one means nobody looked.
    overflow INTEGER NOT NULL DEFAULT 0 CHECK (overflow IN (0, 1)),
    -- WHICH MATCHER produced this row. 'mechanical' = gateQuery (trigger-pattern fire against an
    -- intercepted action). 'recognized' = stageLookup (the agent named a stage). The two are
    -- instrumented in the SAME table because both are "the gate answering a question", but they
    -- are NOT the same population — see gateStats' own comment for why every other field on that
    -- read stays scoped to 'mechanical' rather than blending the two. Added on the CREATE TABLE
    -- above for a fresh install; an EXISTING store gets it via the guarded ALTER in
    -- createGateSchema immediately below (SQLite has no ADD COLUMN IF NOT EXISTS).
    matcher TEXT NOT NULL DEFAULT 'mechanical' CHECK (matcher IN ('mechanical', 'recognized'))
  );
  CREATE INDEX IF NOT EXISTS idx_gate_events_circle_ts ON gate_events(circle, ts);

  /*
   * EVERY stage a query matched, not just the one that answered. byStage asks "how often does
   * this stage fire", and answering it from gate_events.matched_stage_id undercounts every stage
   * that matched alongside a higher-severity one — precisely the broad stages whose fire rate is
   * most worth watching. Rows exist only for fires, so this table is bounded by matches rather
   * than by intercepted actions.
   */
  CREATE TABLE IF NOT EXISTS gate_event_stages (
    event_id INTEGER NOT NULL,
    stage_id TEXT NOT NULL,
    PRIMARY KEY (event_id, stage_id)
  );
  CREATE INDEX IF NOT EXISTS idx_gate_event_stages_stage ON gate_event_stages(stage_id);

  /*
   * THE GENERATION COUNTER — the materialized-mirror snapshot principle made CHECKABLE.
   *
   * The design's own extracted principle says a build artifact is a snapshot: "after the source
   * changes, re-materialize and verify the artifact itself." A sidecar with no version has no way
   * to be verified — a hook reading a stale file cannot tell it is stale, so a deny that was
   * retired keeps blocking and a deny that was declared never starts. Both failures are silent.
   *
   * So: one monotonic counter, bumped IN THE SAME TRANSACTION as every mutation that can change
   * what materializeGateMirror would write, and stamped into the file's header. Comparing the
   * header against the counter answers "is this mirror current" with no guessing and no hashing of
   * the world. Local and unsynced by construction (it counts THIS store's mutations, and a peer's
   * count means nothing here), which is why it is a singleton table rather than a synced column.
   */
  CREATE TABLE IF NOT EXISTS gate_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    generation INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO gate_meta (singleton, generation) VALUES (1, 0);
`;

/**
 * PHASE (a): every gate table, `gate_meta` included — nothing but `db.exec(GATE_SCHEMA_SQL)`, split
 * out on its own (review fix — Codex round 3, item 1). MonetCore's own construction calls this
 * BEFORE `migrateLegacyStarCircle()` (engine.ts), which needs `gate_meta` to exist the moment it
 * finds a '*' concept to move — see that method's own comment for the crash this closes: round 2's
 * seam ran the legacy-star migration before ANY gate table existed on a genuine pre-gate 1.3.1
 * store, so `bumpGateGeneration` threw "no such table: gate_meta" — AFTER `moveCircleScopedTables`
 * had already auto-committed (no explicit transaction wraps it, by design — see that method's own
 * comment), aborting construction on the first attempt and silently succeeding on a retry (nothing
 * left to move the second time). Idempotent — every statement in GATE_SCHEMA_SQL is `IF NOT EXISTS`
 * — so calling this again from `createGateSchema`'s own wrapper below costs nothing.
 */
export function createGateTables(db: StoragePort): void {
  db.exec(GATE_SCHEMA_SQL);
}

/**
 * PHASE (c): every gate-substrate migration that is NOT table creation — the `gate_events.matcher`
 * column guard, the `rule_bindings.circle` column guard, its backfill, and the circle index, in
 * that order (review fix — Codex round 3, item 1; split out of createGateSchema, which used to run
 * all of this immediately after its own `db.exec(GATE_SCHEMA_SQL)`). Requires every gate table to
 * already exist — `createGateTables` must run first, in every caller — and, for the backfill to
 * land the CURRENT circle rather than `*`, requires `migrateLegacyStarCircle()` (engine.ts, phase
 * (b)) to already have run: the ordering invariant this whole round-3 split exists to enforce is
 * (a) tables → (b) legacy-star move → (c) this function, and every one of the three remains
 * independently idempotent and race-safe (see each guard's own comment) regardless of which
 * concurrent migrator gets there first.
 */
export function migrateGateColumns(db: StoragePort): void {
  // COLUMN-GUARD PATTERN (SQLite has no ADD COLUMN IF NOT EXISTS), same convention as engine.ts's
  // own migrate(): PRAGMA table_info, then ALTER only if missing. Lives HERE, in the function that
  // owns gate_events' schema, rather than in engine.ts's migrate() — this module owns every
  // statement against stages/rule_bindings/gate_events, migration included (module header).
  //
  // A store created before the recognized matcher shipped has a gate_events table with no
  // `matcher` column; the CREATE TABLE IF NOT EXISTS above is a no-op against it, so the column
  // must be added explicitly. Safe on a fresh store too — the guard simply finds the column
  // already present (declared in the CREATE TABLE above) and does nothing. Every pre-existing row
  // on an upgraded store backfills to 'mechanical', which is true by construction: 'recognized'
  // did not exist before this slice, so every event any prior build could have written was one.
  //
  // NOT ATOMIC AGAINST A CONCURRENT SECOND MIGRATOR (review fix — Codex round 3): the MCP server
  // and a `monet` CLI call are a SUPPORTED topology sharing one `.monet` DB (storage.ts's own WAL +
  // busy_timeout setup exists exactly for this — "the MCP server and a `monet` CLI call can share
  // one `.monet` DB"), so two processes CAN both open a pre-column store at once, both see the
  // column absent via this PRAGMA probe, and both attempt the ALTER. The LOSER's ALTER throws
  // SQLite's "duplicate column name" — which, unhandled, would abort that process's entire startup
  // over a race the WINNER already resolved correctly. Caught here AS SUCCESS
  // (idempotent-by-catch): the only thing this guard promises is "the column exists when this
  // function returns", and a duplicate-column error is proof that promise is ALREADY kept by
  // someone else's ALTER, not a real failure. Re-thrown for any OTHER error shape — those are real
  // problems this guard has no business hiding.
  const gateEventCols = db.prepare(`PRAGMA table_info(gate_events)`).all() as Array<{ name: string }>;
  if (!gateEventCols.some((c) => c.name === "matcher")) {
    try {
      db.exec(
        `ALTER TABLE gate_events ADD COLUMN matcher TEXT NOT NULL DEFAULT 'mechanical' CHECK (matcher IN ('mechanical', 'recognized'))`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("duplicate column name")) throw error;
    }
  }
  // SAME GUARD, for breadth (slice 4b-B follow-up): a store created before breadth shipped has a
  // rule_bindings table with no `circle` column at all. UNLIKE `matcher`, there is no single
  // constant default — the correct value is "whichever circle this binding's own concept already
  // lives in", which is a per-row lookup, not a column DEFAULT. So the column is added nullable
  // (the CREATE TABLE above declares it the same way, for a fresh install), and the backfill just
  // below fills every pre-existing row from its concept — safe to run unconditionally, since
  // `WHERE circle IS NULL` makes every call after the first a no-op scan.
  const ruleBindingCols = db.prepare(`PRAGMA table_info(rule_bindings)`).all() as Array<{ name: string }>;
  if (!ruleBindingCols.some((c) => c.name === "circle")) {
    try {
      // `origin IN ('declaration','correction')`, matching GATE_SCHEMA_SQL's own CHECK exactly
      // (review fix — Codex round 3, item 2) — an upgraded store must enforce the SAME governed-
      // inheritance boundary a fresh install gets from the CREATE TABLE, or a correction-origin '*'
      // successor bind would pass bindRule's own app-level guard and still fail here at the SQL
      // layer on an upgraded store specifically. See that CHECK's own comment for the full reasoning.
      db.exec(
        `ALTER TABLE rule_bindings ADD COLUMN circle TEXT CHECK (circle != '${BREADTH_CIRCLE}' OR origin IN ('declaration','correction'))`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("duplicate column name")) throw error;
    }
  }
  // THE BACKFILL. A row with no circle yet is, by construction, a pre-breadth row — '*' did not
  // exist as a value any build could have written before this slice, so "whichever circle the
  // concept lives in today" is exactly right, not merely a reasonable guess. A dangling binding
  // (concept not yet arrived — the dangling-then-live gap) leaves circle NULL for one more open,
  // same tolerance the rest of this module already has for that case.
  //
  // GUARDED ON `concepts` EXISTING: this module's own header says it "owns every statement against
  // stages/rule_bindings/gate_events" — deliberately NOT concepts, which lives in engine.ts's own
  // schema — and createGateSchema is called standalone, against a bare rule_bindings/stages/
  // gate_events fixture with no concepts table at all, by this file's own concurrent-migrator race
  // tests. A backfill that assumed concepts always exists would turn a legitimate standalone call
  // into a crash rather than the harmless no-op it should be when there is nothing yet to backfill.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  // THE MIXED-BUILD COMPATIBILITY TRIGGER FAMILY — COMPLETE AND FROZEN (Codex round 12, ratified by
  // John, 2026-07-28). Built across rounds 5–11 to close one problem: a build old enough to predate
  // some mirror-widening event (blocking-only → both severities; stages/circle_aliases becoming
  // mirror content) writes to stages/rule_bindings/concepts/circle_aliases with no idea the mirror
  // now depends on what it just touched, and nothing bumps `gate_meta.generation` to make that
  // staleness DETECTABLE. Round 11's own report closed the family with a verbs × tables matrix
  // (INSERT/UPDATE/DELETE against rule_bindings, stages, concepts, circle_aliases) — every cell is
  // now one of: covered-by-trigger, immutable, new-build-only-argued (a kept, deliberate JS-side
  // superset — bindRule's own reclassification bump is the one member of this family), or
  // verified-by-absence (rule_bindings/stages are never explicitly deleted anywhere in this
  // codebase). That matrix is COMPLETE, not merely current — there is no known gap left to close.
  //
  // FROZEN: a new member should be RARE TO NEVER. Every trigger below exists because a SPECIFIC old
  // writer, on a SPECIFIC table, touching a SPECIFIC mirror-relevant column or verb, needed exactly
  // this mechanism — not because "another trigger, just in case" is ever free. Before adding one:
  //   1. Name the OLD writer and the exact verb/column gap, the way every trigger below does in its
  //      own comment — "unknown staleness risk" is not a finding, a cited call site is.
  //   2. Run the SAME double-bump audit every trigger below already ran: does a NEW-build writer at
  //      this same site already bump (JS-side)? If so, is the new trigger's own condition an EXACT
  //      MATCH (remove the JS call — rounds 8–11's own resolution for every case but one) or a
  //      SUPERSET (keep it, document the accepted double — bindRule's reclassification bump is the
  //      only precedent for this). Round 11, item 3's own near-miss is the cautionary case: a
  //      blanket `AFTER UPDATE` trigger cascaded with engine.ts's OWN pre-existing central
  //      mutation-trigger mechanism (`sync_${table}_insert`/`_update`) and double-bumped in
  //      production-shaped code before a test caught it — column-scope every UPDATE trigger to the
  //      fields that actually feed the mirror, never a blanket `AFTER UPDATE ON table`.
  //   3. Pin the exact count with a new-build exact-count test, the same way every removed JS bump
  //      in this family has one, and re-run the full suite once — this family has changed a
  //      pre-existing test's expected count in every round it has grown.
  //
  // THE RECORDED RETREAT LINE. This family's entire cost is bumping `gate_meta.generation` once (or
  // occasionally twice, for an accepted superset) per already-happening write, on tables that are
  // low-to-moderate volume compared to the store's own concept/observation traffic. If per-write
  // trigger overhead ever actually shows up in profiling — not hypothetically, but measured — the
  // deliberate alternative is DROPPING THIS ENTIRE FAMILY and accepting the failure mode it exists to
  // prevent: an old-build write during a mixed-build upgrade window leaves the on-disk mirror
  // silently stale until SOME process restarts on the new build and a routine mutation (or the next
  // open's own backfill) re-triggers a refresh. That is a real regression — bounded to the upgrade
  // window only, self-healing on restart, never permanent — not a silent one: whoever takes this
  // retreat must record it plainly, naming the tradeoff in the change that takes it, the same way
  // every other binding consequence of slice 4b is named.
  // Nobody has taken this retreat; this paragraph exists so a future profiler finding one has the
  // decision already made, not one to re-litigate from scratch.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  const hasConceptsTable = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'concepts'`)
    .get() !== undefined;
  if (hasConceptsTable) {
    // ALL COMPATIBILITY TRIGGERS CREATED FIRST, BEFORE THE BACKFILL BELOW (Codex round 11, item 4,
    // P1 — reordered from the shape every trigger in this family was originally added in). The
    // backfill trigger (the first one below) used to be created AFTER the bulk backfill UPDATE ran
    // — a real window: a concurrent OLD writer (the MCP server and a `monet` CLI call sharing one
    // `.monet` DB is the shipped, supported topology this module's own header already leans on
    // elsewhere) inserting a rule_bindings row DURING that gap lands a NULL-circle row the
    // just-finished backfill never saw and the not-yet-created trigger could not catch either —
    // invisible until some LATER process happens to rerun this migration. Trigger creation order
    // among themselves is free (every one is `CREATE TRIGGER IF NOT EXISTS`, and none of their
    // bodies depends on another having run first), so moving all of them ahead of the backfill
    // closes the window at zero cost: by the time the backfill's own UPDATE runs, every trigger
    // that could ever need to react to a write during it already exists.
    // SAME '*'-MINTING HOLE, SAME FIX FAMILY (Codex round 12, P1 — the review's own "same audit for
    // every other compat trigger that copies a circle value"). If the concept THIS binding names
    // already sits in a circle literally spelled `"*"` (the identical pre-breadth legacy shape the
    // sibling trigger below now guards against), the subquery here would resolve to `'*'` and copy
    // it straight into a brand-new binding — minting global reach (or crashing on the CHECK
    // constraint for a non-declaration/correction origin) on nothing more than an old build's own
    // ordinary INSERT. `CASE WHEN c.circle = '*' THEN NULL ELSE c.circle END`: when the concept is
    // in the reserved circle, this resolves to NULL instead — the SAME value a genuinely dangling
    // binding (no concept row at all) already gets, from the identical subquery pattern, one row
    // down. Not a new state to reason about: NULL already means "not yet safely resolvable" in this
    // exact column, healed later — here, by `migrateLegacyStarCircle` moving the concept out of
    // `'*'` on the next new-build open, which lets this SAME trigger's WHEN-guarded UPDATE (it never
    // stops firing; NULL still satisfies `NEW.circle IS NULL`) resolve it correctly the moment a
    // later write touches this row, or the schema backfill below does on the next open regardless.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_rule_bindings_backfill_circle
      AFTER INSERT ON rule_bindings
      FOR EACH ROW WHEN NEW.circle IS NULL
      BEGIN
        UPDATE rule_bindings SET circle = (
          SELECT CASE WHEN c.circle = '${BREADTH_CIRCLE}' THEN NULL ELSE c.circle END
            FROM concepts c WHERE c.id = NEW.concept_id
        ) WHERE concept_id = NEW.concept_id;
        UPDATE gate_meta SET generation = generation + 1 WHERE singleton = 1;
      END;
    `);
    // A SECOND COMPATIBILITY TRIGGER, THE UPDATE SIDE (Codex round 7, item 2, P1). The INSERT trigger
    // above closes the gap for an old build MINTING a new binding; it says nothing about an old
    // build MOVING an existing concept — `moveConcept`/`renameCircle`'s own pre-breadth code UPDATEs
    // `concepts.circle` directly and has no idea `rule_bindings.circle` exists at all, let alone that
    // it must be kept in step (that rule postdates it) — reopening the exact round-1, item-3 shape
    // (a binding silently pointing at a circle its own concept already left) for any writer old
    // enough to predate the keep-in-step convention, exactly as the INSERT gap did for a fresh bind.
    //
    // FIRES ON EVERY concepts.circle UPDATE, new build or old — there is no way for a trigger to tell
    // who issued the statement, and it does not need to: see below for why a NEW build's own
    // explicit keep-in-step UPDATE colliding with this one is harmless.
    //
    // `circle IS NOT NULL AND circle != '*'` — both written out, even though `!= '*'` alone already
    // excludes NULL under SQL's three-valued comparison logic (NULL != anything is NULL, never true),
    // matching this codebase's own convention of stating an invariant explicitly rather than leaning
    // on a reader's recall of NULL-comparison semantics. NEVER a dangling binding (nothing to
    // re-align — B3, engine.ts, heals it separately when its own concept lands) and NEVER a breadth
    // binding: `*` is the ONE circle value that must NOT follow its concept (BREADTH_CIRCLE's own
    // comment — a global rule's reach is a property of the BINDING, independent of wherever its
    // concept happens to be filed; re-aligning it here would silently narrow a global rule to local
    // the moment its concept moved, exactly the "removed by accident" failure this whole review
    // series exists to close, one mechanism over).
    //
    // DOES NOT FIGHT THE NEW BUILD'S OWN EXPLICIT keep-in-step UPDATE (moveConcept/renameCircle,
    // engine.ts) — verified, not assumed. Both write the IDENTICAL new circle value: this trigger
    // fires FIRST, synchronously, the instant `concepts.circle` commits (AFTER UPDATE, per row,
    // before the statement that fired it even returns), landing the SAME value the engine's own
    // subsequent explicit UPDATE (a separate statement, moments later) would also write — a same-
    // value UPDATE, changing nothing the trigger had not already set. Neither can create a `changes()`-
    // visible surprise or a second, different value winning a race: there is only ever one correct
    // value in flight, written twice.
    //
    // NO RECURSION — CHECKED, NOT ASSUMED. This trigger's own write (`UPDATE rule_bindings ...`)
    // cannot re-fire ITSELF (it is scoped to `concepts`, not `rule_bindings`), and no trigger in this
    // codebase fires on an UPDATE to `rule_bindings` at all — the sibling trigger just above is
    // INSERT-only. So there is no chain to recurse through even in principle. Independently confirmed
    // `recursive_triggers` is OFF regardless (SQLite's own compiled-in default; BetterSqlitePort's
    // constructor, storage.ts, sets `journal_mode`/`busy_timeout` explicitly and never touches this
    // pragma) — queried directly against this exact dependency (better-sqlite3 11.10.0 / SQLite
    // 3.49.2): `PRAGMA recursive_triggers` reads `0`. Recursive firing would require an AFTER UPDATE
    // ON rule_bindings trigger that itself writes back to `concepts.circle` (none exists) AND an
    // explicit `PRAGMA recursive_triggers = ON` this codebase never issues — both would have to be
    // true at once, and neither is.
    //
    // THE GENERATION BUMP, HERE TOO (Codex round 8, item 2, P2) — the symmetric gap to round 7, item
    // 3's fix on the INSERT trigger above: this trigger changes what the mirror should say (a bound
    // rule's effective circle) exactly as an INSERT does, but had no bump of its own, so an old
    // build's own `concepts.circle` UPDATE against a concept with a live binding moved that binding
    // undetectably — the file would report CURRENT while quietly missing the move. Same statement
    // shape, same reason `bumpGateGeneration()` itself cannot be called from inside a trigger body,
    // same honest-stale contract argued in full at the sibling trigger's own comment above (a trigger
    // cannot refresh the FILE; the bump only makes the staleness DETECTABLE) — not repeated here
    // verbatim, but it applies identically.
    //
    // UNCONDITIONAL, and wasted MORE OFTEN than the sibling trigger above — said plainly rather than
    // glossed over: this fires on EVERY `concepts.circle` UPDATE, not only one for a concept that
    // carries a rule binding. A `WHEN` clause on `CREATE TRIGGER` itself can gate whether the trigger
    // fires at all, but not which statements inside its own body run once it does — the rule_bindings
    // UPDATE's WHERE clause decides which BINDING rows move, but the gate_meta UPDATE right after it
    // is a separate statement, reached unconditionally the moment the trigger fires, whether or not
    // the first statement matched anything. So an old build moving an ordinary fact, workstream, or
    // correction between circles — the overwhelmingly common case, since most concepts are never
    // rules — also ticks the generation, with nothing rule-relevant having changed. Same argument as
    // the INSERT trigger's own dangling-row case (not a correctness gap, only an occasional wasted
    // regeneration), just a wider door: `concepts` is a far busier table than `rule_bindings`.
    //
    // A PRECISE VERSION IS POSSIBLE HERE, unlike the INSERT trigger above — noted, not taken. That
    // trigger's own `changes()` is unusable as a guard because its UPDATE's WHERE clause always
    // matches the just-inserted row (a scalar subquery, not a real filter). This one's WHERE clause
    // (`concept_id = NEW.id AND circle IS NOT NULL AND circle != '*'`) is a genuine filter, so
    // `changes() > 0` on it WOULD reliably mean "a binding actually followed" and could gate the bump
    // precisely. Left unconditional anyway: an occasional extra regeneration is cheap and self-
    // limiting (materializeGateMirror compares before replacing), while a second, subtly different
    // conditional-bump idiom sitting right next to this trigger's unconditional sibling is one more
    // shape a future reader has to hold in their head for a savings that costs nothing to skip.
    //
    // NEVER MINT BREADTH FROM AN ORDINARY MOVE (Codex round 12, P1 — found by review, not
    // self-discovered). This trigger's own WHERE clause guards the BINDING's CURRENT circle
    // (`circle != '*'`, above) so it never re-narrows an ALREADY-global binding — but did nothing
    // about the OPPOSITE direction: `NEW.circle` itself. `'*'` is reserved as a breadth marker only
    // by NEW-build convention; an OLD build sharing this same upgraded database has no idea that
    // convention exists, and can legitimately (from its own, pre-breadth perspective) rename or
    // reassign a concept into an ordinary circle that happens to be spelled `"*"` — the exact legacy
    // shape `migrateLegacyStarCircle` exists to clean up on the NEXT new-build open. Before this
    // fix, that OLD write's own `concepts.circle` UPDATE fired this trigger with `NEW.circle = '*'`,
    // and the body copied it verbatim into `rule_bindings.circle` — for a declaration/correction-
    // origin binding, `rule_bindings`' own CHECK constraint (`circle != '*' OR origin IN
    // ('declaration','correction')`) PASSES, so an ordinary local binding — a BLOCKING one included
    // — silently became a live GLOBAL rule, firing in every circle, on the strength of an old
    // process moving its concept into a circle name it has never heard is special. For any OTHER
    // origin, the same write instead CRASHES the old process outright on the CHECK violation — worse
    // than a security hole, but no fix at all.
    //
    // GUARDED AT THE TOP, `WHEN NEW.circle != '${BREADTH_CIRCLE}'` — the trigger simply does not
    // fire at all when the concept's own new circle is the reserved marker, so NEITHER statement in
    // its body runs: the binding is left exactly where it was (no mint, no crash), and no bump fires
    // either — correctly, since nothing about the MIRROR changed (GateMirrorEntry.circle reads the
    // BINDING, never the concept, so a binding that did not move is not mirror-relevant here). The
    // concept itself still lands in `'*'` on this write (this trigger never touches `concepts` at
    // all), so `migrateLegacyStarCircle`'s own next-open scan — which reads `concepts.circle`
    // directly, not anything this trigger does or does not do to a binding — still finds and moves
    // it exactly as it always has; this fix only stops the BINDING side from being corrupted while
    // that concept sits in the pathological circle awaiting that migration.
    //
    // Same guard, same idempotent creation pattern as the trigger above.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_rule_bindings_follow_concept_circle
      AFTER UPDATE OF circle ON concepts
      FOR EACH ROW WHEN NEW.circle != '${BREADTH_CIRCLE}'
      BEGIN
        UPDATE rule_bindings SET circle = NEW.circle
         WHERE concept_id = NEW.id AND circle IS NOT NULL AND circle != '${BREADTH_CIRCLE}';
        UPDATE gate_meta SET generation = generation + 1 WHERE singleton = 1;
      END;
    `);
    // A THIRD COMPATIBILITY TRIGGER, THE STATUS SIDE (Codex round 9, item 2, P2). The two triggers
    // above cover a MOVE (circle) and an INSERT; neither says anything about an old build RETIRING
    // or RESTORING a concept — retireConcept/restoreConcept's own pre-mirror-widening code UPDATEs
    // `concepts.status` directly with no idea the mirror needs to know. An old build retiring an
    // ADVISORY rule (its own era only tracked blocking bumps, if it bumped status at all) leaves the
    // new build's on-disk mirror serving that retired rule as live, indefinitely — nothing else ever
    // re-triggers a refresh for a concept nobody touches again afterward.
    //
    // SCOPED, not blanket — `WHEN EXISTS (SELECT 1 FROM rule_bindings WHERE concept_id = NEW.id)`:
    // an ordinary fact, workstream, or source's status churns constantly (dispute/resolve, retire/
    // restore, connector lifecycle) and none of it is mirror content. A rule is the only kind that
    // can carry a rule_bindings row at all — `flagContradiction` refuses `kind === 'rule'` outright
    // (engine.ts), so a rule concept can never reach the dispute-status paths either, meaning this
    // WHEN clause correctly no-ops for every one of them too, not only for non-rule concepts. Cheap:
    // `rule_bindings.concept_id` is exactly what every rule/gate query already indexes.
    //
    // gate_meta bump: same statement shape, same reason it cannot call `bumpGateGeneration()` from
    // JS, same honest-stale contract as the two triggers above — an old build's own process cannot
    // refresh the sidecar FILE, but the bump makes the staleness DETECTABLE, which is what a NEW
    // build's next refresh or open needs to heal it.
    //
    // COMPOSES WITH THE NEW BUILD'S OWN `noteRuleTouched` CALLS — verified, not assumed, the round-8
    // lesson applied BEFORE shipping this time rather than found by a broken test afterward.
    // retireConcept, restoreConcept, and their relay-graft twins (graftRows' own tombstone/
    // restoration loop, engine.ts) each called `noteRuleTouched(id)` — `if (hasLiveBinding(db, id))
    // bumpGateGeneration(db)` — immediately before the exact `status` UPDATE this trigger now also
    // reacts to. `hasLiveBinding` IS `SELECT 1 FROM rule_bindings WHERE concept_id = ?`: the
    // IDENTICAL predicate this trigger's own WHEN clause tests — not merely a superset of it the way
    // round 8's circle-move fix was — so for a new build, this trigger and each of those four calls
    // always agree on whether to bump, and both firing is a genuine double-count (an increment is
    // not idempotent — round 8's own finding, reapplied). RESOLVED THE SAME WAY round 8 resolved
    // `moveConcept`: removed, not gated — all four call sites' own `noteRuleTouched(id)` lines are
    // gone (see each site's own comment in engine.ts), because the trigger's condition being an
    // EXACT match, not merely a superset, means removal cannot leave a case where a bump was owed
    // and nothing pays it.
    //
    // `OLD.status IS NOT NEW.status` IN THE WHEN CLAUSE — found by a FAILING TEST, not anticipated:
    // `restoreConcept` (engine.ts) issues its own `status = 'active'` UPDATE, then immediately calls
    // `recomputeNativeConceptProjection`, which — for a concept with no live observations, true for
    // most declared rules — issues a SECOND UPDATE whose SET clause also NAMES `status`
    // (`status = CASE WHEN ? THEN 'disputed' ELSE 'active' END`), unconditionally, even though the
    // value it computes is the SAME 'active' the first UPDATE just set. A bare `WHEN EXISTS (...)`
    // fires on BOTH statements — a real column-touch is a real column-touch, whether or not the
    // value differs, exactly the `changes()`-counts-matched-not-changed lesson from round 7, item 3,
    // in a new guise: this time inside a WHEN clause instead of a body statement's `changes()`. AN
    // UPDATE TRIGGER carries BOTH row images, so — unlike round 7 item 3's INSERT trigger, which had
    // no OLD row to compare against and had to accept the occasional wasted bump — this one CAN ask
    // whether the value genuinely changed, and now does. `recomputeNativeConceptProjection` is called
    // from several other sites (store(), detach(), a relay path) with no reason to audit each one
    // individually: the fix belongs in the trigger, once, not in every caller that might incidentally
    // re-touch `status` with its current value.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_rule_bindings_follow_concept_status
      AFTER UPDATE OF status ON concepts
      FOR EACH ROW WHEN OLD.status IS NOT NEW.status AND EXISTS (SELECT 1 FROM rule_bindings WHERE concept_id = NEW.id)
      BEGIN
        UPDATE gate_meta SET generation = generation + 1 WHERE singleton = 1;
      END;
    `);
    // A FOURTH COMPATIBILITY TRIGGER, THE TITLE SIDE (Codex round 10, items 2+3, P2). `GateMirrorEntry.text`
    // (listGateMirrorEntries, this file) reads `c.title` directly — a rule's title IS the text a
    // gate delivers — so a retitle is mirror content exactly as a status or circle change is. An old
    // build's own retitling code (synthesizeRow, applySynthesis, resolveContradiction's
    // explicit-body-override, detach()'s partial-detach branch — engine.ts, all four already fixed
    // for the NEW build: review fix Codex round 2 item 4, plus round 6's own refreshGateSidecar
    // sweep) predates knowing an ADVISORY rule's retitle is mirror-relevant AT ALL — the mirror was
    // blocking-only when every one of those paths was first written. An old build retitling a bound
    // advisory rule leaves the new build's on-disk mirror serving the old text indefinitely.
    //
    // SCOPED the same way the status trigger is, for the same reason: the overwhelming majority of
    // concepts are not rules, and retitle constantly (every synthesis pass touches body+title
    // together) — a blanket trigger would bump on nearly every mutation this store ever makes.
    // `OLD.title IS NOT NEW.title` narrows further: several of the four retitling call sites
    // explicitly preserve the existing title on an empty/whitespace body ("never blank it"), so
    // their own UPDATE can reach this trigger with an unchanged value — a real column-touch, but not
    // a real content change.
    //
    // COMPOSES WITH THE NEW BUILD'S OWN noteRuleTouched CALLS — verified, not assumed. All four
    // retitling sites called `noteRuleTouched(id)` — the IDENTICAL `hasLiveBinding` predicate this
    // trigger's own WHEN clause tests — immediately after their own title-touching UPDATE. Removed,
    // not gated, the same way round 8/9 resolved every other exact-match case: see each site's own
    // comment (engine.ts). TWO OTHER concepts.title writers were swept and found NOT to need this
    // trigger at all: the workstream-save path (`WHERE ... AND kind='workstream'`, so it can never
    // reach a rule concept) and the source-file recompute path (`storeSourceChunk`'s own recompute,
    // `kind='source'`-only — a source can never carry a rule_bindings row, the same invariant
    // assertGraftPayloadIsNativeOnly enforces at the sync boundary) — this trigger's own EXISTS
    // clause would correctly no-op for both regardless, so their continued silence is independently
    // re-verified here, not merely inherited from synthesizeRow's own historical sweep comment.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_rule_bindings_follow_concept_title
      AFTER UPDATE OF title ON concepts
      FOR EACH ROW WHEN OLD.title IS NOT NEW.title AND EXISTS (SELECT 1 FROM rule_bindings WHERE concept_id = NEW.id)
      BEGIN
        UPDATE gate_meta SET generation = generation + 1 WHERE singleton = 1;
      END;
    `);
    // A FIFTH COMPATIBILITY TRIGGER, RULE_BINDINGS' OWN REMAINING COLUMNS (Codex round 10, items
    // 2+3). `stage_id`, `severity`, `scope`, `model_tag`, `origin`, `declared_by`, and `reason`
    // all feed the mirror (listGateMirrorEntries' own SELECT) and all move together, in ONE UPDATE
    // statement, through exactly one shared writer: `bindRule`'s own "replace" branch (this file) —
    // the same single-writer shape `trigger_patterns` had, and the same historical gap: that
    // branch's own bump (KEPT, not removed — see its own comment for why) was "UNCONDITIONAL, not
    // gated on touchesDenyPower... [b]efore the mirror widened past blocking-only". An old build's
    // bindRule, restating or re-aiming an ALREADY-ADVISORY rule's stage, scope, model tag, or reason
    // (severity staying advisory throughout, so deny power is never in play), bumped nothing at
    // all, because nothing about that change touched what its own era's mirror carried.
    //
    // ALL SEVEN COLUMNS IN ONE `UPDATE OF` LIST, one trigger — they all arrive in the SAME
    // statement, so one trigger with an OR'd `OLD IS NOT NEW` guard across all seven is the natural
    // shape, not seven separate triggers each re-testing the same row. NO EXISTS-ON-rule_bindings
    // SCOPING NEEDED, unlike the concepts-table triggers above: this trigger is already ON
    // rule_bindings — every row in that table already IS a rule binding, by definition.
    //
    // `circle` EXCLUDED FROM THIS LIST — NOT because it is already covered (it needs covering here
    // too: bindRule's own direct write to it, on a LOCAL narrow/widen via declare(), is NOT reached
    // by `trg_rule_bindings_follow_concept_circle`, which only fires from a `concepts.circle`
    // UPDATE, never from a direct `rule_bindings.circle` one — this is why THAT bump stays, above).
    // Excluded instead because including it here would create a DIFFERENT double-bump, discovered by
    // direct empirical probe, not assumed: `trg_rule_bindings_follow_concept_circle`'s OWN body
    // (`UPDATE rule_bindings SET circle = NEW.circle ...`) would then cascade into firing THIS
    // trigger too, every time a concept moves circles — cross-trigger cascading that happens
    // regardless of the `recursive_triggers` pragma (confirmed OFF for this project, but shown by a
    // direct three-table probe to gate something narrower than "does trigger A's own write fire
    // trigger B" — that fires either way). So `circle` stays out of this trigger's list, and its own
    // JS-side bump (bindRule's, above) stays in, uninstructed by this one.
    //
    // COMPOSES WITH bindRule's OWN bump — verified, and DIFFERENT from every prior case in this
    // family: its UPDATE branch's bump fires on EVERY reach of that branch ("replace" mode, or a
    // binding's first write), a strict SUPERSET of "did any of these seven columns actually change"
    // (reaching the branch is a PREREQUISITE for any of them to change at all), not an exact match
    // the way round 8/9's JS-side calls were — so, UNLIKE every earlier trigger in this family, that
    // call is kept rather than removed (see its own comment for the full reasoning), and this
    // trigger deliberately DOUBLE-BUMPS alongside it for a genuine new-build reclassification. An
    // accepted, harmless cost (one extra regeneration), checked against the full suite to confirm
    // nothing depends on the OLD single-bump count for that case.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_rule_bindings_bump_on_reclassification
      AFTER UPDATE OF stage_id, severity, scope, model_tag, origin, declared_by, reason ON rule_bindings
      FOR EACH ROW WHEN
        OLD.stage_id IS NOT NEW.stage_id OR OLD.severity IS NOT NEW.severity OR OLD.scope IS NOT NEW.scope OR
        OLD.model_tag IS NOT NEW.model_tag OR OLD.origin IS NOT NEW.origin OR OLD.declared_by IS NOT NEW.declared_by OR
        OLD.reason IS NOT NEW.reason
      BEGIN
        UPDATE gate_meta SET generation = generation + 1 WHERE singleton = 1;
      END;
    `);
    // A SIXTH COMPATIBILITY TRIGGER, STAGE RE-AUTHORING (Codex round 10, items 2+3).
    // `GateMirrorStage.triggerPatterns`
    // (listGateMirrorStages, this file) reads `stages.trigger_patterns` directly — every stage is
    // mirror content (the full registry, not only rule-bound stages), so a pattern re-authoring is
    // mirror content whether or not anything is bound to that stage yet. See `upsertStage`'s own
    // comment (this file) for the old build's exact gap: `liveBlockingRulesForStage(...).length >
    // 0`, correct while the mirror was blocking-only, silently wrong once it widened. No EXISTS
    // scoping needed — every row in `stages` is already mirror content, unconditionally. Placed
    // inside this same `hasConceptsTable` block for locality with the rest of the trigger family,
    // even though its own body needs nothing from `concepts` — `stages` itself is unconditionally
    // guaranteed to exist by this point regardless (this module's own header: it owns every
    // statement against stages/rule_bindings/gate_events, all created before this function runs).
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_stages_bump_on_trigger_patterns
      AFTER UPDATE OF trigger_patterns ON stages
      FOR EACH ROW WHEN OLD.trigger_patterns IS NOT NEW.trigger_patterns
      BEGIN
        UPDATE gate_meta SET generation = generation + 1 WHERE singleton = 1;
      END;
    `);
    // A SEVENTH COMPATIBILITY TRIGGER, STAGE CREATION (Codex round 11, item 1, P2 — closing the
    // VERB dimension round 10's own family table missed: it enumerated COLUMNS an old build's
    // UPDATE could touch, but a brand-new stage arrives via INSERT, a different verb entirely).
    // `GateMirrorStage` carries the FULL stage registry (listGateMirrorStages' own comment: a
    // rule-less stage still matches and still answers stage-hit-no-rules, never silence) — a new
    // stage with patterns changes what the mirror should contain the MOMENT it exists, before any
    // rule ever binds to it. `upsertStage`'s own NEW-STAGE branch (this file) already bumps
    // unconditionally for the current build ("A brand-new stage is new mirror content the moment it
    // exists") — but that is CURRENT code; an old build's own stage-creation path, like every other
    // writer in this family, predates the mirror needing to know about a rule-less stage at all
    // (blocking-only era: nothing before a live deny bound was mirror content), so an old build's
    // own INSERT never bumped for the stage's own arrival.
    //
    // UNCONDITIONAL, no WHEN clause: an INSERT trigger has no OLD row to compare against (the same
    // reason the very first trigger in this file, the backfill one, has none either) — every INSERT
    // is definitionally a new row, so there is nothing to gate on.
    //
    // COMPOSES WITH upsertStage's OWN bump — verified, EXACT MATCH, not a superset: that branch's
    // INSERT statement runs, unconditionally, exactly once per new stage, with its own
    // `bumpGateGeneration(db)` immediately after — the identical condition ("a new stage row was
    // just inserted") this trigger's own unconditional AFTER INSERT tests. REMOVED, not kept,
    // matching round 8/9's own resolution for every exact-match case in this family (contrast
    // `trg_rule_bindings_bump_on_reclassification`'s own bindRule call, kept because IT is a
    // superset, not an exact match — see that trigger's own comment for why the two differ).
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_stages_bump_on_insert
      AFTER INSERT ON stages
      BEGIN
        UPDATE gate_meta SET generation = generation + 1 WHERE singleton = 1;
      END;
    `);
    // AN EIGHTH COMPATIBILITY TRIGGER, CONCEPT DELETION (Codex round 11, item 2, P2 — the other half
    // of the verb dimension: DELETE). A hard-deleted concept's own rule binding, if it had one,
    // disappears from `listGateMirrorEntries`' own result set the moment the concept row is gone —
    // the INNER JOIN to `concepts` simply stops matching it — exactly like a retire, but via a
    // different verb. An old build's own hard-delete code (its era: `hasBlockingBinding`, bumping
    // for blocking only — the same historical shape every trigger in this family closes) hard-
    // deleting an ADVISORY-bound concept bumped nothing, leaving the new build's on-disk mirror
    // serving a rule whose concept no longer exists, indefinitely.
    //
    // THE DELETION ORDER, verified directly against `hardDeleteNativeConcept` (engine.ts), not
    // assumed: `rule_bindings` is NEVER explicitly deleted ANYWHERE in this codebase (grepped: zero
    // `DELETE FROM rule_bindings` statements) — a hard-deleted concept's binding row is left
    // ORPHANED, pointing at a `concept_id` `concepts` no longer has a row for, cleaned up by nothing
    // and relied on by nothing (the INNER JOIN already makes it undeliverable, which is the entire
    // reason no cleanup was ever needed). This trigger's own `EXISTS (SELECT 1 FROM rule_bindings
    // WHERE concept_id = OLD.id)` check, evaluated AFTER the concept row is already gone (AFTER
    // DELETE), still finds the orphaned binding row exactly as it was a moment before — the ORDER
    // this comment exists to settle is therefore moot for correctness (the binding row's own
    // continued, deliberate existence is what makes the EXISTS check work regardless of which row
    // died "first"), but stated plainly rather than left for a future reader to have to re-derive:
    // `concepts` is the only one of the two that ever actually dies.
    //
    // `stages` NEVER EXPLICITLY DELETED EITHER (grepped: zero `DELETE FROM stages` statements) — no
    // trigger added for it; there is no verb×table cell to cover because the cell cannot fire. If a
    // stage-deletion path is ever added, it needs the identical treatment this comment gives
    // `concepts` here.
    //
    // COMPOSES WITH THE NEW BUILD'S OWN noteRuleTouched CALL — verified, EXACT MATCH:
    // `hardDeleteNativeConcept`'s own `noteRuleTouched(conceptId)` (engine.ts) ran BEFORE its own
    // `DELETE FROM concepts`, testing the IDENTICAL `hasLiveBinding` predicate this trigger's own
    // EXISTS clause tests — the deletion-order question above is exactly why this is still an exact
    // match despite firing at a different moment: the binding row neither call reads is ever
    // deleted, so "does a live binding exist" reads the same whether asked immediately before or
    // immediately after the concept row itself is gone. Removed, not gated, the same way as every
    // other exact-match case in this family — see that call site's own comment (engine.ts).
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_concepts_bump_on_delete
      AFTER DELETE ON concepts
      FOR EACH ROW WHEN EXISTS (SELECT 1 FROM rule_bindings WHERE concept_id = OLD.id)
      BEGIN
        UPDATE gate_meta SET generation = generation + 1 WHERE singleton = 1;
      END;
    `);
  }
  // A NINTH, TENTH, AND ELEVENTH COMPATIBILITY TRIGGER, CIRCLE_ALIASES (Codex round 11, item 3, P2).
  // `GateMirror.circleAliases`/`circles` (gateMirrorCircles, this file) read `circle_aliases`
  // directly — every write to it (a rename, merge, archive, or unarchive publishing or retracting a
  // from→to row) is mirror content, in EVERY format-4 build. The gap here is not "blocking-only vs
  // widened" (this table's own mirror inclusion is not severity-gated at all) — it is that
  // circle_aliases/circles were ADDED to the mirror in format 4 (slice 4b-B) ITSELF: an old build
  // predating that slice has NO bump of any kind for an alias write, because in its own era
  // circle_aliases was not mirror content YET, not because its own bump was scoped too narrowly.
  // Any build old enough to lack this — running renameCircle/mergeCircle/archiveCircle/
  // unarchiveCircle compiled before format 4 shipped — writes circle_aliases with zero awareness
  // that the mirror now depends on it.
  //
  // GUARDED ON circle_aliases's OWN TABLE EXISTENCE — this table is created in engine.ts's own
  // migrate(), which runs AFTER init() (the same construction-time gap `chooseLegacyStarDestination`
  // and `migrateLegacyStarCircle` already guard against, engine.ts) — so on a genuinely first-ever
  // construction this function can run before the table exists at all. THIS GUARD ALONE IS NOT
  // ENOUGH, found by this item's own failing tests, not anticipated up front: an earlier version of
  // this comment claimed "migrateGateColumns itself runs on EVERY open, not only the first, so a
  // fresh install simply creates these triggers one open later" — true across a process RESTART
  // against an on-disk store, but FALSE within one construction, which is the only kind of
  // construction a `:memory:` store (or the current, live open of an on-disk one) ever gets. Nothing
  // called migrateGateColumns a second time after migrate() created the table it needs, so this
  // guard read false forever and the whole trigger family below was dead code. Fixed at the call
  // site, not here — see MonetCore's own constructor (engine.ts), which now calls
  // migrateGateColumns(this.db) a second time, immediately after this.migrate() creates the table.
  //
  // NOT NESTED INSIDE `hasConceptsTable` — deliberately: none of the three trigger bodies below
  // reference `concepts` at all, only `gate_meta`, so nesting under a guard about a DIFFERENT
  // table's existence would be an accidental dependency, not a real one.
  const hasCircleAliasesTable = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'circle_aliases'`)
    .get() !== undefined;
  if (hasCircleAliasesTable) {
    // INSERT: UNCONDITIONAL, no WHEN clause — an INSERT trigger has no OLD row to compare against,
    // the same reason every other INSERT trigger in this family has none either.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_circle_aliases_bump_on_insert
      AFTER INSERT ON circle_aliases
      BEGIN
        UPDATE gate_meta SET generation = generation + 1 WHERE singleton = 1;
      END;
    `);
    // UPDATE: SCOPED TO `to_name, status` — NOT a blanket `AFTER UPDATE ON circle_aliases` (an
    // earlier draft of this trigger was exactly that, and it double-bumped; found by this item's own
    // exact-count tests failing at +2 where +1 was expected, not by inspection). `gateMirrorCircles`
    // (this file) reads exactly `from_name, to_name, status` off this table — `from_name` is the
    // PRIMARY KEY and no writer in this codebase ever UPDATEs it, so `to_name`/`status` are the only
    // two columns whose value a mirror-relevant UPDATE can actually change.
    //
    // WHY THE BLANKET VERSION DOUBLE-BUMPED: this table also carries a "central mutation trigger"
    // pair engine.ts installs for every synced table (sync_circle_aliases_insert/_update, engine.ts's
    // own `trigger()` helper inside migrate()) — the mechanism that stamps sync_revision/sync_writer/
    // updated_at on every LOCAL write so it replicates correctly. `sync_circle_aliases_insert` fires
    // on the SAME INSERT this file's own trg_circle_aliases_bump_on_insert reacts to, and its OWN
    // body is a SECOND statement: `UPDATE circle_aliases SET sync_revision = ..., sync_writer = ...,
    // updated_at = ... WHERE from_name = NEW.from_name` — a genuine UPDATE against the row that was
    // just inserted, fired from INSIDE another trigger's body. Cross-trigger cascading fires
    // regardless of `recursive_triggers` (confirmed OFF for this project; round 10's own direct probe
    // already established this pragma gates something narrower than "does trigger A's own write fire
    // trigger B"), so a blanket `AFTER UPDATE ON circle_aliases` reacts to THAT stamp-update too — one
    // logical alias write, two bumps, verified directly (a debug probe against a real renameCircle
    // call showed generation advancing by 3 where 2 were expected: 1 for the concept's own circle
    // move, 1 for the alias INSERT, and a spurious 1 more for the cascaded stamp-UPDATE).
    //
    // SCOPING TO `to_name, status` CLOSES IT AT THE SOURCE: the sync-cascade's own stamp-UPDATE never
    // names either column in its SET clause (only sync_revision/sync_writer/updated_at), so an
    // `UPDATE OF to_name, status` trigger — which SQLite fires based on which columns a statement's
    // OWN SET clause syntactically names, not on whether any value differs — does not react to it at
    // all, regardless of how many other triggers fire in between.
    //
    // `OLD IS NOT NEW` ON BOTH COLUMNS, same reasoning as every other UPDATE trigger in this family
    // with row images to compare (concepts.status/title, above): a real column-touch is not
    // necessarily a real content change (a rename re-issued with the identical destination, or a
    // no-op unarchive-then-rearchive), and an UPDATE trigger — unlike an INSERT trigger — can tell
    // the difference.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_circle_aliases_bump_on_update
      AFTER UPDATE OF to_name, status ON circle_aliases
      FOR EACH ROW WHEN OLD.to_name IS NOT NEW.to_name OR OLD.status IS NOT NEW.status
      BEGIN
        UPDATE gate_meta SET generation = generation + 1 WHERE singleton = 1;
      END;
    `);
    // DELETE: UNCONDITIONAL — no application code path issues this today (every writer upserts,
    // never deletes; see this trigger's own test, gates.test.ts), and engine.ts's own central
    // mutation-trigger mechanism has no DELETE variant at all (only `_insert`/`_update` — see
    // `trigger()`'s own definition), so there is no analogous cascade to guard against here.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_circle_aliases_bump_on_delete
      AFTER DELETE ON circle_aliases
      BEGIN
        UPDATE gate_meta SET generation = generation + 1 WHERE singleton = 1;
      END;
    `);
  }
  if (hasConceptsTable) {
    // LEGACY '*' CIRCLES: moved to engine.ts (review fix — Codex round 2, item 2; originally landed
    // HERE in round 1, item 4). Round 1's version moved only `concepts.circle` — this gates-layer
    // position cannot reach the OTHER circle-scoped tables (observations, memory_edge, entities,
    // first_block, lifecycle_edges/ratifications: this module's own header says it owns
    // "stages/rule_bindings/gate_events" alone) without either duplicating renameCircle's full table
    // list a second time or reaching across the module boundary into engine.ts's private methods.
    // The honest seam is MonetCore's own construction: `migrateLegacyStarCircle()` (engine.ts) now
    // runs inside `init()`, immediately before `createGateSchema(this.db)` is called — so the
    // backfill ordering requirement THIS comment used to explain in full is unchanged in substance,
    // only in which file states it: legacy-star move → THEN this column backfill, still true,
    // enforced by call order rather than by both steps living in one function.
    //
    // BELOW EVERY TRIGGER IN THIS FUNCTION NOW (Codex round 11, item 4) — see the reordering
    // comment at the top of this same `if` block for why: the trigger that reacts to THIS backfill's
    // own shape (an old build's raw, pre-circle-column INSERT) must already exist before this
    // backfill runs, not after, so a concurrent old writer during this exact window is caught too.
    // RESTRICTED TO BINDINGS WITH A RESOLVABLE, SAFE CONCEPT (Codex round 12, P2 — review found;
    // closes two problems in the SAME predicate). BEFORE: `WHERE circle IS NULL` alone matched every
    // dangling binding too — one whose `concept_id` names NO row in `concepts` at all (the
    // dangling-then-live gap) — and the UPDATE's own scalar subquery then evaluates to NULL,
    // assigning NULL to a column that was ALREADY NULL. SQLite's own `changes()` counts ROWS THE
    // WHERE CLAUSE MATCHED, not rows whose VALUE actually changed (the identical lesson this file's
    // own INSERT trigger, above, already learned the hard way) — so a store with nothing but
    // dangling bindings still reported `backfilled.changes > 0` and bumped the generation for a
    // write that resolved nothing. Combined with round 11, item 3's own second `migrateGateColumns`
    // call (this same function now runs twice per construction), a store in that shape bumped TWICE
    // on EVERY open, rewriting the mirror on a read-only open with no delivery change at all — a
    // report-only process now leaves other readers looking at a spuriously stale-flagged mirror for
    // no reason.
    //
    // THE SAME AUDIT ALSO NAMES THIS STATEMENT: like the two triggers above, this UPDATE copies
    // `concepts.circle` verbatim, so a concept an old build parked in the reserved `'*'` circle
    // (legal in its own pre-breadth era) would have this bulk pass mint global breadth on a
    // dangling-turned-live binding too — the identical hole, a different mechanism (a one-shot
    // UPDATE, not a trigger).
    //
    // ONE PREDICATE closes both: `EXISTS (... AND c.circle != '*')`. A binding with no concept row
    // at all fails the EXISTS outright — excluded from the WHERE clause entirely, never touched,
    // never counted, exactly the dangling case staying dangling. A binding whose concept sits in
    // `'*'` ALSO fails it — same exclusion, same reasoning as the sibling INSERT trigger's own CASE
    // fix above, just expressed as a filter instead of a value substitution (this statement has no
    // per-row body to fall back to NULL inside; skipping the row entirely achieves the identical
    // outcome — it stays NULL because nothing here touches it). Only a binding whose concept EXISTS
    // and carries an ordinary circle is actually resolved and counted, which is the one case this
    // backfill was ever supposed to touch.
    const backfilled = db
      .prepare(
        `UPDATE rule_bindings SET circle = (SELECT c.circle FROM concepts c WHERE c.id = rule_bindings.concept_id)
          WHERE circle IS NULL
            AND EXISTS (
              SELECT 1 FROM concepts c
               WHERE c.id = rule_bindings.concept_id AND c.circle != '${BREADTH_CIRCLE}'
            )`,
      )
      .run();
    // EXPLICIT BUMP (review fix — m3). A backfill that actually resolved a row is exactly the same
    // event class as any other write that changes what materializeGateMirror would produce: a
    // binding that could not be delivered (NULL circle matches nothing) becomes one that can. Before
    // this, the ONLY thing that made an upgraded store's mirror end up correct was the FORMAT bump
    // forcing a rewrite regardless of generation — true today, by coincidence, because breadth is
    // also the first format bump this backfill ships alongside. That coincidence stops being true
    // the next time a backfill-shaped migration lands without a format bump riding next to it, so
    // the dependency is made real here instead of staying implicit. Gated on `changes > 0`: a store
    // with nothing to backfill (already migrated, or a fresh install) must not bump on every open —
    // and, as of this same round, a store whose only NULL-circle bindings are unresolvable (dangling
    // or parked in `'*'`) is included in "nothing to backfill", not miscounted as something was.
    if (backfilled.changes > 0) bumpGateGeneration(db);
  }
  // THE INDEX, LAST — see GATE_SCHEMA_SQL's own comment for why it cannot live there (BLOCKER B1):
  // this line is only reachable once the ALTER above has guaranteed the column exists, under every
  // path (fresh install already has it via the CREATE TABLE; an upgrade has just added it).
  db.exec(`CREATE INDEX IF NOT EXISTS idx_rule_bindings_circle ON rule_bindings(circle)`);
}

/**
 * Idempotent; safe on every open. Convenience wrapper over the two phases above, for callers that
 * want the full gate-substrate sequence in ONE call and have no legacy-star migration to sandwich
 * between them — this file's own standalone tests (the concurrent-migrator race, the pre-breadth
 * migration battery) all call this directly, exactly as before the round-3 split. MonetCore's own
 * construction does NOT call this: `init()` (engine.ts) calls `createGateTables`, then
 * `migrateLegacyStarCircle()`, then `migrateGateColumns`, in that order, for the ordering reason
 * each of those three functions' own comments explain.
 */
export function createGateSchema(db: StoragePort): void {
  createGateTables(db);
  migrateGateColumns(db);
}

// ---- the generation counter -------------------------------------------------

/** The store's current gate-substrate generation. Monotonic; only ever read for comparison. */
export function gateGeneration(db: StoragePort): number {
  const row = db.prepare(`SELECT generation FROM gate_meta WHERE singleton = 1`).get() as { generation: number } | undefined;
  return row?.generation ?? 0;
}

/**
 * Advance the counter. MUST be called inside the same transaction as the mutation it describes —
 * a bump that commits without its mutation (or a mutation that commits without its bump) is exactly
 * the stale-mirror-that-looks-current failure this counter exists to make impossible.
 */
export function bumpGateGeneration(db: StoragePort): number {
  db.prepare(`UPDATE gate_meta SET generation = generation + 1 WHERE singleton = 1`).run();
  return gateGeneration(db);
}

/**
 * Does this concept currently hold ANY live rule binding, of either severity? The predicate every
 * retire/supersede/move bump site consults, so "does touching this concept change the mirror" is
 * decided in ONE place rather than re-derived per call site. Deliberately reads the BINDING only:
 * a retire or a supersession changes whether the rule is DELIVERED, and the caller bumping for
 * those already knows a binding exists.
 *
 * WAS `hasBlockingBinding`, scoped to `severity = 'blocking'` alone — correct while the mirror was
 * blocking-only (slice 4a), and systematically wrong once it widened (slice 4b-B): an ADVISORY rule
 * leaving the mirror (retire, supersession, a circle move that merges it away) changes
 * `GateMirror.entries` exactly as a blocking one leaving it does, since entries now carries both
 * severities. Renamed rather than merely widened, for the same reason `BlockingSidecar` became
 * `GateMirror` — a predicate that decides bump timing for BOTH severities must not still say
 * "Blocking" in its name.
 */
export function hasLiveBinding(db: StoragePort, conceptId: string): boolean {
  return db
    .prepare(`SELECT 1 FROM rule_bindings WHERE concept_id = ?`)
    .get(conceptId) !== undefined;
}

/**
 * THE CHOKEPOINT. Every way a rule can leave `gateQuery`'s result set passes through here.
 *
 * WHY THIS EXISTS AS ONE FUNCTION. Deny power was made unforgeable to MINT in a single place — a
 * schema CHECK — and it held against every attempt. Removing it was guarded door by door, and
 * review found EIGHT doors, one at a time: re-declaration, stage re-authoring, sidecar staleness,
 * relayed demotion, contradiction flagging, circle-move auto-merge, relayed contradictions, and
 * consolidating detach. That is not eight oversights; it is the wrong shape. A boundary defended at
 * N call sites is defended until someone writes the N+1th, and the search for doors terminates only
 * when the guard is structural.
 *
 * So: `gateQuery` delivers a rule when its concept is active, is kind='rule', has a blocking
 * binding, and carries no supersession edge. Anything that changes any of those for a live deny is
 * a removal, and every such path calls this. A NEW MUTATION PATH THAT SKIPS THIS GUARD IS BY
 * CONSTRUCTION A NEW DOOR — add the call.
 *
 * THE LEGITIMATE REMOVAL IS DECLARATION: an explicit severity downgrade, or an acknowledged
 * pattern re-authoring. A human deciding, which is the whole content of "declaration-only".
 *
 * SUPERSESSION IS NOT A SECOND PATH, though an earlier version of this comment said it was.
 * Superseding a live deny is guarded like everything else (door 11) — the exported
 * addLifecycleEdge refuses it — because "was this act legitimate" is a question about the rule's
 * state HERE, and a caller holding a successor cannot answer it for a deny they may not have
 * declared. The order is: withdraw the deny by declaration, THEN supersede. Once it is not a live
 * deny this guard is silent and succession is ordinary. When the skeleton slice gives declare() a
 * successor surface, that surface does both halves in one act; until then the two steps are the
 * honest description.
 *
 * A rule that is already retired, already superseded, or no longer blocking is NOT live and is not
 * guarded: cleanup of a deny that has already been withdrawn is ordinary maintenance.
 *
 * WHAT THIS GUARD DOES NOT COVER, written here so the boundary lives beside the thing enforcing it:
 *
 *   DIRECT SQL. This is an API-layer guard. Minting deny power is unforgeable at the raw-SQL layer
 *   because it is expressible as a CHECK constraint; REMOVING one is not — "do not delete this row
 *   while another table says it is live" has no constraint form — so a hand-written DELETE or
 *   UPDATE against the database file bypasses this. The store's file is the trust boundary.
 *
 *   A CIRCLE MOVE TO A LIVE CIRCLE. reassignCircle relocates a rule, and a rule denies only in its
 *   own circle, so a move IS a removal from the origin circle. That stays uncovered by design
 *   rather than as a gap: the deny moves WITH the rule and keeps firing in the destination, which
 *   is the same relationship every other memory has with locality. It is named here only because it
 *   is the one place a deny legitimately stops firing somewhere without a declaration.
 *
 *   A MOVE INTO AN ARCHIVED CIRCLE IS COVERED, and is not an exception to that paragraph but its
 *   premise failing. "Keeps firing in the destination" means keeps firing where someone is, and an
 *   archived circle is the store's own flag that nobody works there — so the move is a removal
 *   wearing a relocation's clothes, and goes through declaration like every other removal.
 *
 *   ...EXCEPT FOR A BREADTH-BOUND DENY, which stays uncovered wherever it moves, archived
 *   destination included — not as a carve-out from the paragraph above but by the same reasoning
 *   turned on the binding. Delivery is decided by `rule_bindings.circle` (RULE_LIVENESS_WHERE), and
 *   `moveConcept` deliberately does not let a `*` binding follow its concept (see its own comment),
 *   so moving a global deny takes delivery away from nowhere: it still fires in the circle it left
 *   and in every other one. Refusing it would be worse than a guard on a path that removes nothing,
 *   because the refusal's own remediation is "declare it advisory" — following it would trade a real
 *   deny away to get past a refusal that was protecting nothing. Hence the move door asks
 *   `isCircleLocalLiveBlockingRule` while every other door asks the plain question: retire, delete,
 *   detach, dispute and supersede end the rule's liveness outright, and breadth is no protection
 *   against that.
 *
 *   ...AND EXCEPT WHERE THE ORIGIN'S NAME IS REPOINTED AT THE DESTINATION, which is that same
 *   reasoning turned on the other end of the move — written down here so the next inventory does not
 *   re-file it as a door. What decides this is ALIAS PUBLICATION, never which method ran: an
 *   operation that upserts an ACTIVE circle alias origin→destination alongside the move keeps every
 *   entrance resolving the old name through that alias before it queries, so a session still working
 *   under it is transparently redirected and delivered the same deny. `renameCircle` does this
 *   (measured: after `renameCircle("work", "attic")` with `attic` already archived, the deny fires
 *   under BOTH names) and so does `mergeCircle` — it publishes from→into in the same transaction as
 *   its moves, so a committed merge always carries the alias (measured the same way). Any future
 *   caller that publishes the alias with the move is covered by this sentence, and any that does not
 *   is a door: `batchReassignCircle` and a bare `reassignCircle` publish nothing, which is exactly
 *   why they stay guarded. What a repoint into an archived name DOES change is discovery, not
 *   delivery: the surviving circle is hidden from `listCircles`' default output.
 */
export type BlockingRuleOperation =
  | "retire"
  | "restore-then-delete"
  | "hard delete"
  | "merge"
  | "dispute (contradiction)"
  | "consolidating detach"
  | "relayed retire"
  | "relayed delete"
  | "relayed contradiction"
  | "relayed supersession"
  | "supersession"
  | "circle move into an archived circle";

export interface BlockingRuleGuardVerdict {
  /** True when the concept is a live deny and the operation must not proceed. */
  blocked: boolean;
  conceptId: string;
  /** The rule's title, for an error a human can act on. Null when not blocked. */
  title: string | null;
  /** Ready-to-throw explanation naming the operation and the two legitimate paths. */
  message: string;
}

/**
 * THE ONE DEFINITION OF "LIVE BLOCKING RULE" in this codebase: a blocking binding whose concept is
 * active, is kind='rule', and carries no supersession edge — gateQuery's own delivery conditions,
 * minus locality. Returns the rule's title, so the guard can name it in an error a human can act on,
 * and the BINDING's own circle, which is what decides whether a given operation takes delivery away
 * from anywhere at all (RULE_LIVENESS_WHERE reads `b.circle`, never the concept's).
 *
 * Extracted so the chokepoint and every caller that merely needs to KNOW a deny is at stake (the
 * MCP layer's relocation disclosure) ask the identical question. Two copies of this predicate is
 * how a guard and the disclosure about that guard's subject drift into disagreeing.
 */
function liveBlockingRuleRow(db: StoragePort, conceptId: string): { title: string; circle: string } | undefined {
  return db
    .prepare(
      `SELECT c.title AS title, b.circle AS circle
         FROM rule_bindings b
         JOIN concepts c ON c.id = b.concept_id
        WHERE b.concept_id = ? AND b.severity = 'blocking'
          AND c.status = 'active' AND c.kind = 'rule'
          AND NOT EXISTS (
            SELECT 1 FROM lifecycle_edges e
             WHERE e.family = 'supersession' AND e.src_concept_id = b.concept_id
          )`,
    )
    .get(conceptId) as { title: string; circle: string } | undefined;
}

/**
 * Is this concept a live deny whose delivery is tied to ONE circle — the narrower question, and the
 * only one a CIRCLE MOVE may be judged on. "A live deny" and "a live deny that a move actually takes
 * away from somewhere" are two different questions, and reading them as one is precisely how the
 * archived-destination guard came to refuse moves that removed nothing: a `*` binding does not
 * follow its concept (moveConcept), so a breadth deny keeps firing in every circle regardless of
 * where its concept is filed.
 *
 * ONLY the circle-move door and the MCP layer's relocation disclosure ask this. Every other door
 * asks `blockingRuleMutationGuard`, which is right for them — see the chokepoint's own comment.
 */
export function isCircleLocalLiveBlockingRule(db: StoragePort, conceptId: string): boolean {
  const row = liveBlockingRuleRow(db, conceptId);
  return row !== undefined && row.circle !== BREADTH_CIRCLE;
}

/**
 * Ask whether `operation` may remove `conceptId` from the gate. Local paths throw `message`;
 * graft paths skip and count, because an incoming row must never abort an otherwise-good graft.
 */
export function blockingRuleMutationGuard(
  db: StoragePort,
  conceptId: string,
  operation: BlockingRuleOperation,
): BlockingRuleGuardVerdict {
  const row = liveBlockingRuleRow(db, conceptId);
  if (!row) return { blocked: false, conceptId, title: null, message: "" };
  return {
    blocked: true,
    conceptId,
    title: row.title,
    message:
      `'${operation}' would remove the blocking rule '${conceptId}' (${row.title}) from the gate, and ` +
      `blocking severity is declaration-only in both directions — as hard to remove as it is to mint. ` +
      `Withdraw the deny first by declaring it advisory (memory_declare with severity="advisory"); ` +
      `this operation is then free to proceed, superseding and retiring included.`,
  };
}

/** Throw when the operation would remove a live deny. The local-path form of the chokepoint. */
export function assertBlockingRuleMutationAllowed(
  db: StoragePort,
  conceptId: string,
  operation: BlockingRuleOperation,
): void {
  const verdict = blockingRuleMutationGuard(db, conceptId, operation);
  if (verdict.blocked) throw new Error(verdict.message);
}

/**
 * The live blocking rules bound to one stage — what a pattern re-authoring would silently reroute.
 * "Live" is the gate's own definition: active, kind rule, not superseded. A dead blocking rule
 * governs nothing, so it must not stand in the way of fixing a stage.
 */
export function liveBlockingRulesForStage(db: StoragePort, stageId: string): Array<{ conceptId: string; title: string }> {
  return db
    .prepare(
      `SELECT b.concept_id AS conceptId, c.title AS title
         FROM rule_bindings b JOIN concepts c ON c.id = b.concept_id
        WHERE b.stage_id = ? AND b.severity = 'blocking'
          AND c.status = 'active' AND c.kind = 'rule'
          AND NOT EXISTS (
            SELECT 1 FROM lifecycle_edges e
             WHERE e.family = 'supersession' AND e.src_concept_id = b.concept_id
          )
        ORDER BY c.title ASC, b.concept_id ASC`,
    )
    .all(stageId) as Array<{ conceptId: string; title: string }>;
}

// ---- trigger patterns -------------------------------------------------------

/**
 * One trigger pattern. `tool` null means "any tool" — the shape a declaration authored from a bare
 * command name ("terraform apply") produces, and the reason such a stage fires on `Bash:terraform
 * apply -auto-approve` without the declarer having to know which host surface will run it.
 */
export interface TriggerPattern {
  tool: string | null;
  tokens: string[];
}

/** A tokenized action context: what the matcher actually compares against. */
export interface ActionContext {
  /** Lowercased tool name, or null when the raw context carried no `Tool:` prefix. */
  tool: string | null;
  /** Lowercased tokens of the whole command, separators included as their own tokens. */
  tokens: string[];
  /**
   * Where each token occurs, built ONCE per context by `parseActionContext`.
   *
   * Without it, matching is O(stages × context length): every stage rescans the whole token stream
   * looking for its first token, so a long command line multiplies the cost of the entire registry.
   * Measured at 200 stages against a 4,000-token command that is 2.4ms — over the sub-ms contract,
   * and the reason the (now removed) context token cap looked necessary. With the index, a stage
   * whose first token does not occur at all costs one Map lookup, and one that does occur only
   * examines the positions where it actually appears.
   *
   * Optional so a hand-built context still matches correctly, just linearly.
   */
  index?: Map<string, number[]>;
}

/**
 * Tool names are a small closed vocabulary of host surfaces (`Bash`, `Read`, `Task`), not user
 * data, so they get a grammar strict enough that a colon inside a command can never be mistaken for
 * the prefix delimiter. Fixed literal — never built from stored content.
 */
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/**
 * A NEWLINE ENDS A COMMAND, so it must break a token run exactly as `&&` does.
 *
 * It was previously treated as plain whitespace, which meant `echo git` followed by
 * `push --force` on the next line produced the contiguous run `git push --force` and fired a gate
 * on a command nobody ran. A false POSITIVE is the expensive kind of wrong here: an advisory that
 * fires on the wrong action teaches the agent to discount gates, and a deny that does it stops
 * work. Emitted as its own token so the contiguous-run check cannot step over it, and a member of
 * the separator set so SEEDING segments on it too — one vocabulary, both sides, no way to disagree.
 */
export const COMMAND_BOUNDARY = "\n";

/** Shell separators that end a command segment. Matched as whole tokens, longest first. */
const SEPARATORS = ["&&", "||", ";", "|"] as const;
const SEPARATOR_SET: ReadonlySet<string> = new Set<string>([...SEPARATORS, COMMAND_BOUNDARY]);

/**
 * A pattern longer than this is not more precise, only slower and less legible. Patterns are
 * AUTHORED (seeded or declared), so clamping one is bounded work on a write path.
 */
const MAX_PATTERN_TOKENS = 12;

/**
 * How many patterns one stage may carry. Every gate lookup parses and scans EVERY pattern of every
 * stage, so an unbounded array is an unbounded per-action cost that any declaration could inflict —
 * and it would show up as the gate getting slower, not as anything looking wrong. 32 is far past
 * what a real gate needs (the busiest hand-authored stage in the design's own fixtures has three)
 * and small enough that the worst case stays bounded. Declaration REJECTS beyond it, so a human
 * finds out immediately; graft CLAMPS and counts, because an incoming row must never abort a graft.
 */
export const MAX_STAGE_PATTERNS = 32;

/**
 * The pattern-count refusal, in ONE place so there is one wording for one rule.
 *
 * Exported because the declare-time firing test has to apply it BEFORE it tokenizes anything
 * (Codex P2 on PR #144): that analysis ran ahead of this check and seeded every entry of an
 * arbitrarily large array just to have it refused a moment later. Re-typing the message at the
 * second call site would have been two refusals that could drift; this is the same refusal, raised
 * earlier.
 */
export function assertPatternCountWithinCap(patterns: readonly string[] | undefined): void {
  if (patterns === undefined || patterns.length <= MAX_STAGE_PATTERNS) return;
  throw new Error(
    `a stage may carry at most ${MAX_STAGE_PATTERNS} trigger patterns (got ${patterns.length}): ` +
      `every gate lookup scans every pattern of every stage, so this is a per-action cost. Split the ` +
      `action into separate stages, or use shorter patterns that cover more shapes.`,
  );
}

/**
 * MATCHING IS ALWAYS OVER THE FULL CONTEXT. There is no cap that silently shortens what gets
 * compared, at any size.
 *
 * This had to be learned twice. First a 512-TOKEN cap, then a 64KiB BYTE cap — and both were the
 * same bug at different thresholds: matching ran on a prefix, so a command long enough to push its
 * dangerous part past the cutoff was never compared against anything and the gate reported SILENCE.
 * Silence is the design's signal for "no rule governs this action". Making it also mean "I stopped
 * looking" inverts it precisely where the input is most suspicious, and recording `truncated = 1`
 * in the event row audits the inversion without preventing it. The rule is: SILENCE MUST NEVER MEAN
 * I GAVE UP.
 *
 * So the cap below is not a matching bound. It is a REFUSAL threshold, far beyond any real command
 * line, and crossing it does not produce silence — it produces `overflow: true`, a verdict distinct
 * from both firing and silence, which a host maps to asking the human rather than to allowing.
 * Measured: a 64KiB context costs ~1ms and a 1MiB context ~16ms, all of it reading the string
 * (matching 200 stages against a 4,000-token context is 0.002ms — the context index makes the
 * registry size irrelevant), so full-context matching is affordable across the entire range of
 * inputs that are not already pathological.
 */
const MAX_CONTEXT_BYTES = 4 * 1024 * 1024;

/**
 * How much of the raw context the instrumentation row keeps. A STORAGE bound only — it never
 * affects what was matched, which is why it can be small while MAX_CONTEXT_BYTES is large.
 */
const MAX_RECORDED_CONTEXT_BYTES = 8 * 1024;

/**
 * THE shared comparison form — applied to context tokens on the way out of the tokenizer AND to
 * pattern tokens on the way out of storage. One function on both sides is the entire reason the two
 * cannot drift apart, and it is now CASE FOLDING ONLY, which is what makes it IDEMPOTENT.
 *
 * IT USED TO ALSO STRIP QUOTES AND UNESCAPE, AND THAT WAS A DOUBLE-PROCESSING BUG. The tokenizer
 * already resolves shell syntax: it strips quoting as it scans and consumes backslash escapes, so
 * its output is the FINAL literal text of the word. Running the same transformations again over
 * that output re-interprets characters that were already data — `foo\\bar` (which the shell reads
 * as the five characters `foo\bar`) came out of the tokenizer correctly and was then unescaped a
 * second time into `foobar`, and a token whose literal content really is `"foo"` had its quotes
 * eaten. Escape processing must happen EXACTLY ONCE, and the tokenizer is where it belongs, because
 * only the tokenizer knows which characters were syntax and which were data.
 *
 * The consequence for stored patterns is the conservative one, and deliberate: a hand-written row
 * containing `\-\-force` is now compared literally and simply will not match, rather than being
 * "helpfully" widened. Corruption and hand-editing narrow a pattern; they never broaden it.
 */
export function normalizeMatchToken(raw: string): string {
  return raw.toLowerCase();
}

/**
 * Shell-ish tokenizer. Quoted runs contribute their CONTENT to the current token (so `-m "a b"` is
 * two tokens and the message can never be mistaken for three separate words, while `git "push"` is
 * the single token `push` exactly as the shell sees it), a backslash escapes the next character,
 * and `&&`/`||`/`;`/`|` become their own tokens so `a&&b` cannot hide a separator inside a word.
 *
 * Deliberately NOT a shell parser: it does not expand, resolve, or interpret anything. It decides
 * where the boundaries are and what the characters are, which is all matching needs.
 */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let pieces: string[] = [];
  let started = false; // an EMPTY quoted run (`""`) is still a token
  const flush = (): void => {
    if (started) tokens.push(normalizeMatchToken(pieces.length === 1 ? pieces[0]! : pieces.join("")));
    pieces = [];
    started = false;
  };
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (ch === "\\" && i + 1 < command.length) {
      // LINE CONTINUATION IS A JOIN, NOT AN ESCAPE. `git \<newline>push --force` is one command to
      // the shell: backslash-newline is removed outright. Making newline a command boundary (which
      // it must be — see COMMAND_BOUNDARY) turned this into the token `\npush`, so a continued
      // command MISSED its deny. Consumed here, before the boundary rule can see the newline, which
      // is also why `\\<newline>` still splits correctly: the first backslash escapes the second,
      // leaving the newline to reach the boundary branch on its own.
      const next = command[i + 1]!;
      if (next === "\n") { i += 2; continue; }
      if (next === "\r") { i += command[i + 2] === "\n" ? 3 : 2; continue; }
      pieces.push(next);
      started = true;
      i += 2;
      continue;
    }
    // SHELL COMMENT. `echo safe # git push --force` runs `echo safe`; firing a gate on the words
    // after the `#` is a false positive on a command nobody ran. Only when the `#` OPENS a token
    // (unquoted, not mid-word), exactly as the shell decides it — so `http://x#frag` and `a#b` keep
    // their `#`, and a bare `#fff` argument is a comment here because it is one there too.
    if (ch === "#" && !started) {
      const lineEnd = command.indexOf("\n", i);
      i = lineEnd === -1 ? command.length : lineEnd;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const close = command.indexOf(ch, i + 1);
      pieces.push(command.slice(i + 1, close === -1 ? command.length : close));
      started = true;
      i = close === -1 ? command.length : close + 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      flush();
      // One boundary per run of newlines: `\r\n` and a blank line both mean "the command ended",
      // and emitting several would only pad the token stream.
      if (tokens[tokens.length - 1] !== COMMAND_BOUNDARY) tokens.push(COMMAND_BOUNDARY);
      i++;
      continue;
    }
    if (ch === " " || ch === "\t") {
      flush();
      i++;
      continue;
    }
    const separator = SEPARATORS.find((candidate) => command.startsWith(candidate, i));
    if (separator) {
      flush();
      tokens.push(separator);
      i += separator.length;
      continue;
    }
    // THE PLAIN RUN, taken as ONE SLICE. This is the whole difference between a tokenizer that
    // handles a 35KB command line in microseconds and one that takes milliseconds: the previous
    // version appended a character at a time and ran the separator probe at every position, so an
    // ordinary word cost work proportional to its length twice over. Scanning ahead to the next
    // interesting character and slicing once makes the common case — a plain word — a single string
    // operation. (Removing the context token cap made this the difference between meeting the
    // sub-ms contract on a long command and missing it by 3x.)
    let end = i;
    while (end < command.length && !INTERESTING.has(command[end]!)) end++;
    if (end === i) {
      // A lone `&` — interesting enough to break a run, but not a separator on its own. Consume it
      // as an ordinary character so the scan cannot stall here.
      pieces.push(ch);
      started = true;
      i++;
      continue;
    }
    pieces.push(command.slice(i, end));
    started = true;
    i = end;
  }
  flush();
  return tokens;
}

/**
 * Characters that end a plain run: whitespace, newlines, quoting, escaping, and separator leads.
 *
 * `#` is deliberately ABSENT. A `#` inside a word is an ordinary character (`http://x#frag`), and
 * the comment rule keys on a `#` that OPENS a token — which the tokenizer sees before it ever
 * enters a plain run. Adding it here would split `a#b` into two tokens for no reason.
 */
const INTERESTING: ReadonlySet<string> = new Set([" ", "\t", "\n", "\r", '"', "'", "\\", "&", "|", ";"]);

/**
 * Split a raw action context into its tool prefix and its token stream.
 *
 * The prefix is recognized ONLY when the text before the first `:` is a bare tool identifier. That
 * is what keeps `psql -c "select 1:2"` tool-less instead of inventing a tool called
 * `psql -c "select 1`, and it needs no escaping rule on the caller's side.
 */
export function parseActionContext(raw: string): ActionContext {
  const text = raw.trim();
  const colon = text.indexOf(":");
  if (colon > 0) {
    const candidate = text.slice(0, colon);
    if (TOOL_NAME_RE.test(candidate)) {
      return withIndex(candidate.toLowerCase(), tokenizeCommand(text.slice(colon + 1)));
    }
  }
  return withIndex(null, tokenizeCommand(text));
}

/** Build the occurrence index alongside the tokens. See ActionContext.index for why. */
function withIndex(tool: string | null, tokens: string[]): ActionContext {
  const index = new Map<string, number[]>();
  for (let i = 0; i < tokens.length; i++) {
    const at = index.get(tokens[i]!);
    if (at) at.push(i);
    else index.set(tokens[i]!, [i]);
  }
  return { tool, tokens, index };
}

/**
 * Is this context beyond the refusal threshold? Returns the trimmed text either way — nothing here
 * shortens it, because nothing may match a prefix.
 */
export function clampActionContext(raw: string): { text: string; overflow: boolean } {
  const text = raw.trim();
  return { text, overflow: text.length > MAX_CONTEXT_BYTES };
}

/** A flag-shaped token: `-f`, `--force`, `-auto-approve`. Never a bare `-` or a negative number. */
function isFlagToken(token: string): boolean {
  if (!token.startsWith("-") || token.length < 2) return false;
  const body = token.replace(/^-+/, "");
  return body.length > 0 && !/^[0-9]/.test(body);
}

/**
 * Seed a trigger pattern from ONE concrete instance — the byproduct law applied to gate addressing.
 * See the module header for the three steps and why each one is what it is.
 *
 * Total: every input yields a pattern. An empty or separator-only instance yields an empty token
 * run, which `matchesTriggerPattern` treats as matching NOTHING (see there) rather than everything
 * — a stage that fires on every action would be the fastest possible way to kill gate trust.
 */
export function seedTriggerPattern(instance: string): TriggerPattern {
  const { tool, tokens } = parseActionContext(instance);

  // Step 2: the longest segment between shell separators, ties toward the first.
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (SEPARATOR_SET.has(token)) segments.push([]);
    else segments[segments.length - 1]!.push(token);
  }
  let chosen: string[] = [];
  for (const segment of segments) {
    if (segment.length > chosen.length) chosen = segment;
  }

  // Step 3: command word through the last flag; with no flag, command + subcommand.
  let lastFlag = -1;
  for (let i = 0; i < chosen.length; i++) {
    if (isFlagToken(chosen[i]!)) lastFlag = i;
  }
  let keep = lastFlag >= 0 ? lastFlag + 1 : Math.min(2, chosen.length);

  // A RUN OF NOTHING BUT FLAGS ADDRESSES NOTHING. `--force` on its own fires on `rm -rf --force`,
  // on `git push --force`, and on every other command that happens to carry that flag — a stage
  // that means "some command, somewhere, with this flag" is noise wearing a gate's clothes, and
  // noise is the fastest way to kill gate trust. Extend the window to reach the first non-flag
  // token if the segment has one; if it has NONE, emit an empty run, which never matches (see
  // matchesTriggerPattern). The stage is then born inert and surfaces in `unverifiedPatterns`,
  // where a declaration can arm it with a pattern a human actually meant.
  if (!chosen.slice(0, keep).some((token) => !isFlagToken(token))) {
    const firstWord = chosen.findIndex((token) => !isFlagToken(token));
    keep = firstWord === -1 ? 0 : Math.max(keep, firstWord + 1);
  }
  return { tool, tokens: chosen.slice(0, Math.min(keep, MAX_PATTERN_TOKENS)) };
}

/**
 * Render a pattern as the line a human reads in curation, the sidecar and the gate response. The
 * rendering is the CONTRACT the module header describes — `Bash: git push --force` means "tool
 * Bash, these three words in this order, anywhere in the command".
 */
export function formatTriggerPattern(pattern: TriggerPattern): string {
  return `${pattern.tool ?? "*"}: ${pattern.tokens.join(" ")}`;
}

/**
 * Read a stage's stored patterns. Tolerant by design: a row whose JSON is unreadable, or whose
 * entries are the wrong shape, yields the patterns it CAN read rather than throwing. A gate lookup
 * is on the critical path of an agent's action, and the correct behaviour when one stage's row is
 * corrupt is that this stage goes quiet — never that every gate in the store starts throwing.
 */
export function parseTriggerPatterns(json: string): TriggerPattern[] {
  return readTriggerPatterns(json).patterns;
}

/**
 * Read a stage's stored patterns, reporting how many were unusable.
 *
 * CORRUPTION MAKES A PATTERN INERT, NEVER BROADER — the single rule this function exists to
 * enforce. The previous version "cleaned" malformed input: a non-string `tool` became `null`, which
 * is the WILDCARD (matches every tool), and a non-string token was filtered out of the run, which
 * SHORTENS it (a shorter run matches strictly more). So a corrupt row silently widened a gate's
 * firing surface — the direction that produces confident wrong denies. Every shape violation now
 * drops the whole pattern instead, and the count surfaces in `gateStats().malformedPatterns` so a
 * stage that has gone quiet says why.
 *
 * `tool` ABSENT or explicitly null is not corruption: that is the legitimate any-tool pattern a
 * declaration authored from a bare command name produces.
 */
export function readTriggerPatterns(json: string): { patterns: TriggerPattern[]; malformed: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { patterns: [], malformed: 1 };
  }
  if (!Array.isArray(raw)) return { patterns: [], malformed: 1 };
  const patterns: TriggerPattern[] = [];
  let malformed = 0;
  // The read-side clamp: a row that arrived over sync, or was hand-written, cannot make this store's
  // gate slow. Counted as malformed so an over-long array surfaces in curation rather than being
  // silently truncated.
  if (raw.length > MAX_STAGE_PATTERNS) malformed += raw.length - MAX_STAGE_PATTERNS;
  for (const entry of raw.slice(0, MAX_STAGE_PATTERNS)) {
    if (typeof entry !== "object" || entry === null) {
      malformed++;
      continue;
    }
    const { tool, tokens } = entry as { tool?: unknown; tokens?: unknown };
    if (tool !== undefined && tool !== null && typeof tool !== "string") {
      malformed++;
      continue;
    }
    if (!Array.isArray(tokens) || tokens.some((token) => typeof token !== "string")) {
      malformed++;
      continue;
    }
    // Normalized on the way OUT of storage, with the same function the tokenizer applies on the way
    // out of the context. Doing it here rather than trusting the write path means a row written by
    // any other route — a raw INSERT, a graft from a peer, a hand-repair — is compared in the same
    // form as everything else instead of silently never matching.
    patterns.push({
      tool: typeof tool === "string" ? tool.toLowerCase() : null,
      tokens: (tokens as string[]).map(normalizeMatchToken).slice(0, MAX_PATTERN_TOKENS),
    });
  }
  return { patterns, malformed };
}

/** Canonical serialization. Tools lowercased and tokens normalized/clamped so stored ≡ matched. */
export function serializeTriggerPatterns(patterns: TriggerPattern[]): string {
  return JSON.stringify(
    patterns.map((pattern) => ({
      tool: pattern.tool === null ? null : pattern.tool.toLowerCase(),
      tokens: pattern.tokens.map(normalizeMatchToken).slice(0, MAX_PATTERN_TOKENS),
    })),
  );
}

/**
 * Does `pattern` fire on `context`? Tool agreement, then a contiguous token run.
 *
 * AN EMPTY TOKEN RUN NEVER MATCHES. Mathematically the empty sequence is contained in everything,
 * and that answer would make an unseedable stage (an empty instance, a corrupt row) fire on every
 * single action in the store. "Noise is the fastest way to kill gates" — so the vacuous truth is
 * refused explicitly here rather than left to the write path to prevent.
 */
export function matchesTriggerPattern(pattern: TriggerPattern, context: ActionContext): boolean {
  if (pattern.tokens.length === 0) return false;
  if (pattern.tool !== null && pattern.tool !== context.tool) return false;
  const { tokens } = context;
  const needle = pattern.tokens;
  const last = tokens.length - needle.length;
  if (last < 0) return false;
  // Candidate start positions: exactly where the first token occurs, when the context carries an
  // index; otherwise every position, which is the same answer computed the slow way.
  const starts = context.index?.get(needle[0]!);
  if (context.index && starts === undefined) return false;
  const count = starts ? starts.length : last + 1;
  for (let s = 0; s < count; s++) {
    const start = starts ? starts[s]! : s;
    if (start > last) break;
    if (!starts && tokens[start] !== needle[0]) continue;
    let matched = true;
    for (let offset = 1; offset < needle.length; offset++) {
      if (tokens[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

// ---- stage registry ---------------------------------------------------------

/**
 * Stage names are compared by identity, so they are normalized to ONE spelling on both write and
 * lookup: trimmed, internal whitespace collapsed, lowercased. Without this, `Git Force Push` and
 * `git force push` are two stages for one action, and the "finite, slow-growing, countable" stage
 * set the design promises quietly stops being either.
 */
export function normalizeStageName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * THE shared ceiling on a stage NAME's length — one constant, enforced at CREATION (upsertStage,
 * below) and referenced by every MCP surface that accepts a stage name as input
 * (mcp-server.ts's `stage_lookup`/`memory_store`/`memory_declare` schemas), so nothing storable is
 * ever unlookupable and nothing lookupable-shaped is ever unstorable (review fix — Codex found the
 * two ends had drifted: lookup capped its input while creation stayed unbounded).
 *
 * 500 is generous relative to what a "moment" name actually needs — every stage in this design's
 * own fixtures and doc examples ("git force push", "opening a PR", "terraform apply") is under 30
 * characters — so this is a REFUSAL threshold for content that was never a stage name in the
 * design's sense, not a working ceiling anything legitimate should ever approach.
 */
export const STAGE_NAME_MAX_CHARS = 500;

/**
 * THE shared ceiling on an agent-scoped rule's `modelTag` length — one constant, enforced at every
 * MINT/ENTRY boundary a modelTag can arrive through (review fix — Codex round 4: modelTag was the
 * one wire-projected field with NO bound anywhere — the MCP capture zod schemas accepted an
 * unrestricted string, `setRuntimeModelTag` accepted anything, `bindRule`/`validateRuleCapture`/
 * `declare()`'s own agent-scope check only tested for PRESENCE, and graft's preflight didn't check
 * it at all. A single oversized tag survives storage, then inflates every rule that carries it on
 * the wire — enough of it, at STAGE_LOOKUP_BODY_CAP scale, could demote an otherwise-deliverable
 * rule into the outline-only recovery tier from this one field's serialized size alone).
 *
 * Enforced as a NAMED REFUSAL, same lattice as STAGE_NAME_MAX_CHARS just above: `bindRule` (the
 * authoritative, inside-the-transaction chokepoint), `MonetCore.validateRuleCapture`/`declare()`'s
 * own early copies (engine.ts, for fast feedback before the embed), both MCP capture zod schemas
 * (`memory_store`'s `rule.modelTag`, `memory_declare`'s `modelTag`), `setRuntimeModelTag` (the one
 * write path that stamps the RUNTIME's own live tag rather than a captured rule's), and
 * `graftRows`' own rule-binding preflight — no honest peer can hold a longer one once every minter
 * refuses it, the same reasoning STAGE_NAME_MAX_CHARS's own graft check rests on.
 *
 * 200 — real model identifiers run well under 40 characters (e.g. "claude-sonnet-4-5-20250929",
 * "gpt-4o-2024-11-20"). This is a REFUSAL threshold for content that was never a model id in the
 * design's sense, generous headroom over anything a real provider actually issues, not a working
 * ceiling anything legitimate should ever approach.
 */
export const MODEL_TAG_MAX_CHARS = 200;

/**
 * THE shared SQL-retrieval bounds for `stageLookup` (review fix — Codex round 2, extended round 3:
 * the engine was materializing every live rule's FULL body, for an UNBOUNDED rule count, before
 * the MCP layer ever got a chance to clip anything — the wire's own caps protected the RESPONSE,
 * but nothing protected the RETRIEVAL that fed it). Defined here, once, and imported by
 * mcp-server.ts rather than kept as separate wire-side constants that merely happened to agree
 * with these, for the same reason STAGE_NAME_MAX_CHARS is shared rather than copied: two numbers
 * that are SUPPOSED to be the same but are maintained as two literals are a drift bug waiting to
 * happen, not a coincidence to document with a comment.
 *
 * STAGE_LOOKUP_RULES_CAP — the primary retrieval's row-count bound. `rulesForStages` is called
 * with `limit: STAGE_LOOKUP_RULES_CAP + 1`: fetching one EXTRA row is the cheap way the engine
 * learns "there are more than the cap" without a second query, and the wire trims that probe row
 * before ever showing it (see evaluateStageLookup's own comment). 200 — unchanged from the wire's
 * former STAGE_LOOKUP_RULES_MAX_ITERATE — is already far past what a real stage needs.
 *
 * STAGE_LOOKUP_BODY_CAP — the primary retrieval's per-row body-length bound, applied IN SQL via
 * `substr(c.body, 1, STAGE_LOOKUP_BODY_CAP + 1)`. The same "+1 probe" trick: a body substr'd to
 * `CAP + 1` chars lets the wire's existing `clip(body, STAGE_LOOKUP_BODY_CAP)` call correctly
 * detect "this needed truncating" (length > CAP) without the engine adding a separate boolean
 * field. KNOWN, ACCEPTED IMPRECISION: when the true body is much longer than `CAP + 1`, the wire's
 * truncation-count note (e.g. "…[truncated 1 chars]") undercounts how much was actually cut — the
 * SIGNAL ("this was truncated") stays correct, which is what the wire's clip() detection depends
 * on, but the exact CHARACTER COUNT in that note is no longer honest once retrieval itself is
 * bounded. Fixing the count would need the query to also return the body's true full length
 * (LENGTH(c.body)) and thread it through StageLookupRule for a cosmetic detail in a note string;
 * not done here — flagged instead of silently accepted. 6 000, matching the wire's prior
 * FETCH_BODY_MAX_CHARS reuse for this surface.
 *
 * STAGE_LOOKUP_REASON_CAP — the SAME "+1 probe" substr bound, applied to `reason` (review fix —
 * Codex round 3: `reason` was the residual axis left unbounded after round 2's body/count fix —
 * advisory reasons carry no write-time length bound at all, unlike a blocking reason's ONE-LINE
 * shape constraint, so one persisted giant reason could still defeat the row/body caps on its own
 * axis). SAME KNOWN, ACCEPTED IMPRECISION as body's truncation-count note, PLUS one more: see
 * `toGateRule`'s own comment for why `reasonMissing` — computed from this now-possibly-truncated
 * value — stays correct for every realistic reason and is only wrong in a doubly-pathological
 * shape this module declines to add SQL-side whitespace matching to chase (that path already
 * caused a real bug once — see `hasNoReason`'s own "THE PREDICATE IS NOT IN THE SQL" doctrine).
 * 1 200, matching the wire's prior FETCH_OBS_MAX_CHARS reuse for this surface.
 *
 * STAGE_LOOKUP_OUTLINE_CAP — bounds BOTH the wire's own outline-building iteration AND
 * `ruleOutlineForStage`'s own SQL LIMIT (the compact {conceptId, title} projection used when the
 * primary retrieval was capped — see that function's own comment for why a "no body" projection
 * still needs a bound of its own). 500 — unchanged from the wire's former
 * STAGE_LOOKUP_OMITTED_MAX_ITERATE.
 *
 * STAGE_INDEX_CAP — the stage-INDEX's own row-count bound (review fix — Codex round 3:
 * `liveStageIndex` used to fetch `listStages`' full-column projection — every stage's serialized
 * `trigger_patterns` blob included — for the ENTIRE registry, just to filter it down to a handful
 * of live names; see `liveStageIndex`'s own comment). Same "+1 probe" shape, shared by both
 * consumers that iterate a stage index at the wire layer (`stage_lookup`'s miss path and
 * `agent_context`), so "the SQL cap" and "the wire's iteration cap" are one number, not two that
 * happen to agree. 2 000 — unchanged from the wire's former STAGE_LOOKUP_INDEX_MAX_ITERATE /
 * AGENT_CONTEXT_STAGE_INDEX_MAX_ITERATE (both were already this value).
 */
export const STAGE_LOOKUP_RULES_CAP = 200;
export const STAGE_LOOKUP_BODY_CAP = 6_000;
export const STAGE_LOOKUP_REASON_CAP = 1_200;
export const STAGE_LOOKUP_OUTLINE_CAP = 500;
export const STAGE_INDEX_CAP = 2_000;
/**
 * Most disputed derivation parents one delivered rule will name (review fix — PR #112 round 5).
 * The disputed-parents scalar rides the mechanical gate path, and derivation rows are append-only
 * with no per-rule cap, so the aggregation is bounded here; the query fetches one extra id as the
 * truncation signal and the mapper delivers at most this many plus `disputedParentsTruncated`.
 * Several simultaneously-disputed parents on one rule is already pathological — the disclosure's
 * job (go mediate) survives a cap comfortably above anything real.
 */
export const DISPUTED_PARENTS_CAP = 8;

/** The engine-owned collaborators this module needs — same seam shape as LifecycleEdgeDeps. */
export interface GateDeps {
  db: StoragePort;
  newId: () => string;
  /** The persisted sync clock, so these rows ride the same watermark as every other synced table. */
  nextSyncTimestamp: () => number;
  syncDeviceId: string;
}

export interface UpsertStageInput {
  /** Name or existing stage id. Resolved as an id first, then as a normalized name. */
  stage: string;
  /** Concrete action instance to seed patterns from, when the stage has to be created. */
  instance?: string;
  /**
   * Explicit patterns. Declaration only: PRESENT means REPLACE this stage's patterns outright, and
   * an EMPTY ARRAY is a present instruction meaning "this stage fires on nothing" — not an absence.
   */
  patterns?: string[];
  /** Concept ids of every live blocking rule bound here, when a replacement would re-aim them. */
  acknowledgeBlockingRules?: string[];
  origin: StageOrigin;
}

/**
 * Refuse a pattern replacement that would re-aim denies the caller has not named.
 *
 * THE guard — shared by declare()'s early check and upsertStage's in-transaction one, so the two
 * cannot disagree about what counts as acknowledged.
 */
export function assertNoUnacknowledgedDenies(
  db: StoragePort,
  stage: StageRow,
  acknowledged: string[] | undefined,
): void {
  const denies = liveBlockingRulesForStage(db, stage.id);
  if (denies.length === 0) return;
  const named = new Set(acknowledged ?? []);
  const missing = denies.filter((deny) => !named.has(deny.conceptId));
  if (missing.length === 0) return;
  throw new Error(
    `re-authoring the patterns of stage '${stage.name}' would change what ${denies.length} blocking ` +
      `rule(s) deny. Confirm by passing acknowledgeBlockingRules with every one of them. Missing: ` +
      missing.map((deny) => `${deny.conceptId} (${deny.title})`).join("; "),
  );
}

/** Resolve a stage by id first, then by normalized name. Null when neither matches. */
export function findStage(db: StoragePort, key: string): StageRow | null {
  const byId = db.prepare(`SELECT * FROM stages WHERE id = ?`).get(key) as StageRow | undefined;
  if (byId) return byId;
  const byName = db.prepare(`SELECT * FROM stages WHERE name = ?`).get(normalizeStageName(key)) as StageRow | undefined;
  return byName ?? null;
}

/** Every stage in the registry, oldest first. Registry-sized (tens to low hundreds), so unpaged. */
export function listStages(db: StoragePort): StageRow[] {
  return db.prepare(`SELECT * FROM stages ORDER BY created_at ASC, id ASC`).all() as StageRow[];
}

/** Exactly the four columns the matcher reads. See `listMatchableStages` for why that matters. */
export interface MatchableStage {
  id: string;
  name: string;
  trigger_patterns: string;
  verified: number;
}

/**
 * The firing path's own projection, deliberately NOT `listStages`.
 *
 * Every gate lookup reads EVERY stage — that is what "no index can help, so keep the row cheap"
 * means here — and the five columns the matcher never looks at (origin, the two clocks, the
 * revision, the writer) are pure marshalling cost paid once per stage per action. Measured at 200
 * stages: dropping them takes a silent lookup from ~0.25ms to ~0.15ms. A narrower SELECT is the
 * whole optimization; there is no cache, so there is no invalidation to get wrong.
 */
export function listMatchableStages(db: StoragePort): MatchableStage[] {
  return db
    .prepare(`SELECT id, name, trigger_patterns, verified FROM stages ORDER BY created_at ASC, id ASC`)
    .all() as MatchableStage[];
}

/**
 * Create the stage if it does not exist; replace its patterns when a declaration supplies them.
 *
 * A CORRECTION NEVER REWRITES AN EXISTING STAGE'S PATTERNS. "A correction landing on an action with
 * no stage IS the stage's creation" — the creation, not a continuous re-authoring. If every capture
 * re-seeded, the gate's addressing would drift with whatever command happened to be corrected last,
 * and the human who declared `terraform apply` would find it silently narrowed to
 * `terraform apply -auto-approve` by the next correction. Editing rides declaration, which is where
 * sovereignty lives.
 */
export function upsertStage(deps: GateDeps, input: UpsertStageInput): StageRow {
  const { db } = deps;
  const existing = findStage(db, input.stage);
  // AN EMPTY ARRAY IS AN INSTRUCTION, NOT AN ABSENCE. `patterns: []` used to coerce to null and be
  // silently ignored, which meant a declarer could not make a stage inert — and, worse, that the
  // one input shape most obviously aimed at disarming a gate slipped past the acknowledgement guard
  // entirely. Only `undefined` means "I am not authoring patterns".
  assertPatternCountWithinCap(input.patterns);
  const declaredPatterns = input.patterns === undefined
    ? null
    : input.patterns.map((pattern) => seedTriggerPattern(pattern));

  if (existing) {
    if (declaredPatterns === null) return existing;
    const nextPatterns = serializeTriggerPatterns(declaredPatterns);
    if (nextPatterns === existing.trigger_patterns) return existing; // no-op: nothing to bump for
    // THE ACKNOWLEDGEMENT GUARD LIVES WITH THE MUTATION, not only at the API edge. declare() checks
    // it early for fast feedback, but that check runs before the embed and outside the write
    // transaction — so a blocking rule bound during the embed window would have its firing surface
    // re-aimed by a call that was validated when no deny existed. Re-checking here closes that
    // window by construction: this runs inside whatever transaction the caller opened.
    assertNoUnacknowledgedDenies(db, existing, input.acknowledgeBlockingRules);
    const syncAt = deps.nextSyncTimestamp();
    db.prepare(
      `UPDATE stages
          SET trigger_patterns = ?, origin = ?, sync_updated_at = ?,
              -- VERIFIED RESETS. The flag means "these patterns matched something real"; after a
              -- replacement they are not those patterns any more, and carrying the proof across
              -- would make the dead-pattern watchlist vouch for a pattern nothing has ever matched
              -- — the one thing it exists to detect.
              verified = 0,
              sync_revision = sync_revision + 1, sync_writer = ?
        WHERE id = ?`,
    ).run(nextPatterns, input.origin, syncAt, deps.syncDeviceId, existing.id);
    // NOT SOURCED FROM AN EXPLICIT bumpGateGeneration(db) CALL HERE ANY MORE (removed — Codex round
    // 10, items 2+3): `trg_stages_bump_on_trigger_patterns` (this file, migrateGateColumns) now
    // bumps unassisted on the `trigger_patterns` UPDATE above — its own `OLD IS NOT NEW` guard is the
    // IDENTICAL condition the removed call relied on (the guard just above, `nextPatterns ===
    // existing.trigger_patterns → return existing`, already proved this statement is reached only on
    // a REAL change), so keeping both would double-count. Every stage is mirror content now
    // (GateMirror.stages carries the full registry, not only stages with a live rule bound) — that
    // widening is also WHY this needed its own trigger at all: an OLD build's own upsertStage
    // (this exact function, at whatever vintage it was compiled from) gated its bump on
    // `liveBlockingRulesForStage(db, existing.id).length > 0` — correct while the mirror was
    // blocking-only, and silently wrong the moment it widened: an old build re-authoring an
    // all-advisory or rule-less stage's patterns never bumped at all, leaving the new build's mirror
    // serving stale patterns indefinitely for exactly the stage shapes the widening was supposed to
    // start covering.
    return db.prepare(`SELECT * FROM stages WHERE id = ?`).get(existing.id) as StageRow;
  }

  // NEW STAGE. STAGE_NAME_MAX_CHARS is enforced HERE — the one place a stage name is ever minted —
  // so every creation surface (memory_store's rule capture, memory_declare's stage/rule species)
  // inherits the bound for free, and stage_lookup's own input cap can reference the SAME constant
  // with the guarantee that anything actually storable stays name-lookupable (review fix: the two
  // ends had drifted, lookup capped at 500 while creation stayed unbounded). A NAMED REFUSAL, not a
  // silent truncation — a name this long was never a "moment" in the design's sense; that content
  // belongs in the rule's own instance/content/reason, not in the address.
  const normalizedName = normalizeStageName(input.stage);
  if (normalizedName.length > STAGE_NAME_MAX_CHARS) {
    throw new Error(
      `a stage name may be at most ${STAGE_NAME_MAX_CHARS} characters (got ${normalizedName.length}): ` +
        `stage names are short, human-readable identifiers for a moment ("git force push", "opening a ` +
        `PR"), not a command or a paragraph — put that in the rule's own instance, content, or reason.`,
    );
  }

  // Seeding precedence: explicit declared patterns, else the observed instance, else the stage name
  // itself. The last is the import/declaration case the design calls out — "their trigger pattern is
  // authored at import from the rule's named action and flagged unverified until its first fire".
  const seeds = declaredPatterns ?? [seedTriggerPattern(input.instance ?? input.stage)];
  const syncAt = deps.nextSyncTimestamp();
  const row: StageRow = {
    id: deps.newId(),
    name: normalizedName,
    trigger_patterns: serializeTriggerPatterns(seeds),
    origin: input.origin,
    verified: 0,
    created_at: syncAt,
    sync_updated_at: syncAt,
    sync_revision: 0,
    sync_writer: deps.syncDeviceId,
  };
  db.prepare(
    `INSERT INTO stages (id, name, trigger_patterns, origin, verified, created_at, sync_updated_at,
                         sync_revision, sync_writer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.name, row.trigger_patterns, row.origin, row.verified,
    row.created_at, row.sync_updated_at, row.sync_revision, row.sync_writer,
  );
  // A brand-new stage is new mirror content the moment it exists — GateMirror.stages carries the
  // full registry regardless of whether any rule is bound yet (a rule-less stage still MATCHES and
  // still answers stage-hit-no-rules; see GateMirror.stages' own comment). No caller of upsertStage
  // creates a stage AND its first rule binding as a single atomic write with only one of the two
  // owed a bump — bindRule bumps for the binding side, and this used to cover the stage side itself
  // with its own explicit call, because a pattern-less, rule-less new stage could not yet hold a
  // deny for the OLD blocking-only mirror to care about.
  //
  // NOT SOURCED FROM AN EXPLICIT bumpGateGeneration(db) CALL HERE ANY MORE (removed — Codex round
  // 11, item 1): `trg_stages_bump_on_insert` (this file, migrateGateColumns) now bumps unassisted on
  // the INSERT above — unconditionally, an EXACT match for this branch's own call, which also fired
  // exactly once per new stage with no condition of its own to narrow it (an INSERT trigger has no
  // OLD row to compare against, the same reason the rule_bindings backfill trigger above it in
  // migrateGateColumns has none either). Same reasoning that removed the "replace" branch's own bump
  // just above in this same function, one INSERT/UPDATE pair over.
  return row;
}

// ---- rule bindings ----------------------------------------------------------

export interface BindRuleInput {
  conceptId: string;
  stageId: string;
  /**
   * REQUIRED, NEVER DEFAULTED HERE — bindRule has no access to the concept row, so it cannot fall
   * back to "whichever circle the concept lives in" on its own; the caller (captureRuleBinding)
   * resolves that. Either an ordinary circle name (normally equal to the rule's own concept circle)
   * or `BREADTH_CIRCLE` ("*"), meaning every circle — see that constant's own comment. A breadth
   * value is refused below unless `origin` is `"declaration"`, OR this is a governed supersession
   * legitimately inheriting one (see `predecessorCircle` below) — the same sovereignty boundary
   * blocking severity already enforces, and enforced a second time at the schema level (the
   * `circle != '*' OR origin IN ('declaration','correction')` CHECK on rule_bindings).
   */
  circle: string;
  /**
   * ONLY meaningful when `origin === "correction"` and `circle === BREADTH_CIRCLE` — the incumbent
   * PREDECESSOR binding's own circle, supplied ONLY by succeedRule's own supersession write (review
   * fix — Codex round 3, item 2). Threaded through rather than inferred: succeedRule already reads
   * the predecessor's binding row before ever calling this (it needs it to carry stage/scope/tag
   * forward regardless), so bindRule does not re-derive "is this a legitimate inheritance" by
   * querying lifecycle_edges itself — it trusts the caller's own already-verified fact, the same
   * "thread the context, do not re-infer it" shape `effectiveCircle`'s own fallback chain
   * (engine.ts's graftRows) already uses. `undefined` (every OTHER caller — captureRuleBinding,
   * memory_store's ordinary capture path — never sets this) means "no claim of inheritance", which
   * is the safe default: a bare correction-origin '*' bind with no predecessor context stays refused
   * by the SAME named error this fix does not weaken. Sovereignty is unchanged even when this
   * unlocks a bind: the '*' already entered, legitimately, at the PREDECESSOR's own declaration —
   * this carries it forward exactly as it already carries forward reason/scope/modelTag on an
   * ordinary succession, never a second way to MINT one.
   */
  predecessorCircle?: string | null;
  /**
   * OMITTED MEANS "DO NOT DECIDE THIS", and that is a safety property rather than a convenience.
   *
   * Re-declaring a rule without naming a severity is the ordinary onboarding re-sort flow — the
   * user is restating the rule's text or its gate, not ruling on its failure mode. Defaulting the
   * omitted field to `advisory` therefore silently REMOVED deny power on a routine, documented,
   * agent-callable path, which is the exact shape of "unforgeable to mint, trivial to remove".
   * Omitted now PRESERVES an existing binding's severity; only an explicit value changes it. On a
   * NEW binding, omitted still means `advisory` — there is nothing to preserve, and capture cannot
   * mint blocking anyway.
   */
  severity?: RuleSeverity;
  scope: RuleScope;
  modelTag?: string | null;
  origin: RuleBindingOrigin;
  declaredBy?: string | null;
  /**
   * OMITTED MEANS "DO NOT DECIDE THIS" HERE TOO — the sibling of `severity` above.
   *
   * Restating a rule's text or its gate is not a ruling on why the rule exists, so an omitted
   * reason PRESERVES the incumbent's; only an explicit one replaces it. Blank is not a value: an
   * empty or whitespace-only string normalizes to absent, which on a blocking rule is refused
   * rather than stored (a deny renders its reason at the moment of refusal, and a blank line there
   * is worse than the guard that would have caught it).
   */
  reason?: string | null;
}

/** What a bind did, so a caller can report a downgrade instead of performing it silently. */
export interface BindRuleResult {
  row: RuleBindingRow;
  /** The severity this replaced, or null when the binding is new. */
  previousSeverity: RuleSeverity | null;
  /** True when an explicit severity took deny power away from a rule that had it. */
  downgradedFromBlocking: boolean;
}

/**
 * `keep` = the first binding wins (capture). `replace` = the last one wins (declaration).
 *
 * The asymmetry is the point. A rule corrected twice is "two observations, one rule": the second
 * capture resolves onto the SAME concept, and re-addressing that concept because an incidental
 * repeat named a different stage would move a live rule's gate without anyone deciding to. A
 * declaration is a human deciding, so it replaces — which is also the only way a rule's severity or
 * reason is ever edited.
 */
export type BindMode = "keep" | "replace";

export function getRuleBinding(db: StoragePort, conceptId: string): RuleBindingRow | null {
  return (db.prepare(`SELECT * FROM rule_bindings WHERE concept_id = ?`).get(conceptId) as RuleBindingRow | undefined) ?? null;
}

/** Record (or replace) the binding that gives a rule its address. */
export function bindRule(deps: GateDeps, input: BindRuleInput, mode: BindMode): BindRuleResult {
  const { db } = deps;
  const existing = getRuleBinding(db, input.conceptId);

  // SEVERITY RESOLUTION, before validation, because what gets validated depends on it. An omitted
  // severity is not a value — it is the absence of a ruling, and the incumbent's ruling stands.
  const severity: RuleSeverity = input.severity ?? existing?.severity ?? "advisory";

  // REASON RESOLVES THE SAME WAY, and for the same reason. Restating a rule's text or its gate is
  // not a ruling on WHY the rule exists, exactly as it is not a ruling on its failure mode. The
  // unconditional write this replaces cleared the incumbent's reason on every replace, so the
  // documented onboarding re-sort — restate the rule, name no severity, name no reason — left a
  // live deny firing with nothing underneath it. That is the precise failure the declaration guard
  // exists to prevent, reached through the path most likely to be walked.
  //
  // A blank normalizes to absent so there is ONE representation of "no reason": the guard below and
  // whatever renders the gate would otherwise disagree about whether "   " counts as an answer.
  //
  // THROUGH hasNoReason RATHER THAN A BARE .trim(), which is not tidying. `existing.reason` is read
  // straight off disk, so it carries whatever a malformed peer wrote — and a bare `.trim()` on a
  // number threw HERE too, meaning a rule with a corrupt reason could not even be re-declared to
  // repair it. Routing through the shared predicate makes this path total for the same reason the
  // read paths are, and rebinding then writes the normalized value, so an ordinary declaration
  // cleans the row up on its way past.
  const statedReason = input.reason ?? existing?.reason ?? null;
  const reason = hasNoReason(statedReason) ? null : statedReason;

  if (!RULE_SEVERITIES.includes(severity)) {
    throw new Error(`rule severity '${severity}' is not one of ${RULE_SEVERITIES.join(", ")}`);
  }
  if (!RULE_SCOPES.includes(input.scope)) {
    throw new Error(`rule scope '${input.scope}' is not one of ${RULE_SCOPES.join(", ")}`);
  }
  if (!RULE_BINDING_ORIGINS.includes(input.origin)) {
    throw new Error(`rule binding origin '${input.origin}' is not one of ${RULE_BINDING_ORIGINS.join(", ")}`);
  }
  // Restated here so the caller gets an error it can act on rather than a bare "CHECK constraint
  // failed"; the table enforces both independently, against raw SQL as well.
  if (severity === "blocking" && input.origin !== "declaration") {
    throw new Error(
      "blocking severity is declaration-only: no agent, and no projection, can self-assign deny power",
    );
  }
  // THE SAME BOUNDARY, for breadth — WITH ONE GOVERNED EXCEPTION (review fix — Codex round 3, item
  // 2). Global reach is exactly as sovereign a claim as denial — "sovereignty is unchanged: `*`
  // enters only through the declaration surface" — so an ORDINARY capture (correction-origin)
  // binding can no more mint `circle: '*'` than it can mint blocking. But INHERITING an incumbent's
  // breadth through supersession is not MINTING it: correcting a global rule births a successor that
  // must carry the SAME reach forward, exactly as it already carries forward reason/scope/modelTag —
  // "no shadowing, no precedence... withdrawing a global line is a global act" cuts both ways, and a
  // correction silently NARROWING a global rule to local (by simply being refused, forcing the
  // correction to roll back entirely) would be exactly the "removed by accident" failure this whole
  // review series exists to close, one mechanism over. `predecessorCircle` (see its own comment) is
  // how the ONE legitimate caller of this exception — succeedRule — proves it, rather than this
  // function trusting a bare origin/circle pair from anyone claiming to be it.
  const inheritsGlobalBreadth = input.origin === "correction" && input.predecessorCircle === BREADTH_CIRCLE;
  if (input.circle === BREADTH_CIRCLE && input.origin !== "declaration" && !inheritsGlobalBreadth) {
    throw new Error(
      "circle '*' (global breadth) is declaration-only: no capture, and no projection, can self-assign global reach",
    );
  }
  // THE AUTHORITATIVE MISSING-REASON CHECK, keyed on the RESOLVED severity rather than the named
  // one. declare()'s copy of this can only see what the caller wrote: it validates before the embed,
  // so it does not yet know which concept it will land on and cannot consult the incumbent binding.
  // A restatement that omits severity therefore never sets `input.severity`, sails straight past
  // that check, and could hand a live deny an empty-string reason. Here the incumbent is finally in
  // hand and severity is already resolved, which is the only place the real question can be asked.
  if (severity === "blocking" && reason === null) {
    throw new Error(
      "a blocking rule requires `reason`: one line naming the failure this deny prevents. " +
        "Omitting it keeps the reason already recorded — there is no way to leave a deny without one.",
    );
  }
  // THE SAME QUESTION, ABOUT THE OTHER WAY A REASON CAN BE THE WRONG SHAPE. Blank asks "is there
  // nothing here"; this asks "is it the ONE LINE three doc comments promise". They sit together
  // because they are one decision — a reason that cannot be rendered as the contract describes is
  // not a reason — and because separating them is how the second one gets forgotten.
  //
  // REJECTED, NOT NORMALIZED, for the reason the blank case is: a malformed reason is refused rather
  // than repaired. `"   "` is not quietly turned into a placeholder on a deny, and `"a\nb"` is not
  // quietly flattened into `"a b"` — silently rewriting somebody's sentence hands them back words
  // they did not choose, in the one field whose whole job is to be the human's own explanation. The
  // caller can fix it; we cannot know what they meant. (Blank IS normalized to null, but only where
  // absence is legal — that is normalizing what is meaningfully absent, not editing what is there.)
  //
  // ON THE SUPPLIED VALUE, not the resolved one, which is the deliberate difference from the check
  // above. A preserved incumbent reason can only be malformed if it arrived by relay, and refusing
  // there would make a peer's bad row block the local human from restating their own rule — turning
  // somebody else's data into a lock on this store. Relay's answer is disclosure, never a veto.
  if (severity === "blocking" && hasLineBreak(input.reason)) {
    throw new Error(
      "a blocking rule's `reason` must be ONE LINE: it is printed beside the deny at the moment it " +
        "fires, so a line break makes the gate appear to say something nobody wrote. Received " +
        `${JSON.stringify(input.reason)} — restate it as a single sentence.`,
    );
  }
  // WHITESPACE IS ABSENCE, here as everywhere (the reason resolution above): "   " is truthy in JS
  // and non-null in SQL, so without this normalization a whitespace-only tag passed the presence
  // check below and landed in rule_bindings as literal whitespace — a tag no runtime ever equals,
  // making the rule undeliverable while looking configured.
  //
  // NONBLANK IS ALSO TRIMMED, not merely checked for blankness (review fix — round 5 follow-up,
  // canonicalization): " gpt-4 " is not blank, so the check alone let it through UNCHANGED — padded,
  // not absent. `setRuntimeModelTag` (engine.ts) already trims the RUNTIME'S OWN tag before storing
  // it, and the SQL comparison this feeds (`RULE_LIVENESS_WHERE`'s `b.model_tag = ?`) is EXACT, not
  // trimmed — so a rule stored with the padded form and a runtime resolved to the trimmed form
  // (" gpt-4 " vs "gpt-4") would never equal each other, making the rule silently undeliverable for
  // the exact model it names, while looking perfectly configured. ONE canonical form, minted HERE
  // (the only place a modelTag is ever written), closes that gap the same way `normalizeStageName`
  // closes it for stage names — trim before the length check below, so a padded-but-otherwise-at-
  // the-boundary tag is judged by the form that is actually stored and actually compared.
  const statedModelTag = input.scope === "agent" ? (input.modelTag ?? null) : null;
  const trimmedModelTag = statedModelTag !== null ? statedModelTag.trim() : null;
  const modelTag = trimmedModelTag === "" ? null : trimmedModelTag;
  if (input.scope === "agent" && modelTag === null) {
    throw new Error("an agent-scoped rule requires a model tag naming the model it compensates for");
  }
  // THE AUTHORITATIVE LENGTH CHECK (review fix — Codex round 4, item 2): this is the one place
  // EVERY agent-scoped modelTag passes through before landing in rule_bindings, so it is where the
  // bound has to hold regardless of which caller (store()'s capture, declare()'s early copies in
  // engine.ts, or a relay that skipped both) got here. Same lattice as the reason-shape checks just
  // above: a bound this narrow (MODEL_TAG_MAX_CHARS's own comment) has no legitimate reason to be
  // exceeded, so a caller that does is malformed, not merely unusual.
  if (modelTag !== null && modelTag.length > MODEL_TAG_MAX_CHARS) {
    throw new Error(
      `a model tag may be at most ${MODEL_TAG_MAX_CHARS} characters (got ${modelTag.length}): ` +
        `modelTag names which model a rule compensates for ("claude-sonnet-4-5-20250929"), not a ` +
        `command or a paragraph.`,
    );
  }

  if (existing && mode === "keep") {
    return { row: existing, previousSeverity: existing.severity, downgradedFromBlocking: false };
  }

  const previousSeverity = existing?.severity ?? null;
  const downgradedFromBlocking = previousSeverity === "blocking" && severity !== "blocking";

  const syncAt = deps.nextSyncTimestamp();
  if (existing) {
    db.prepare(
      `UPDATE rule_bindings
          SET stage_id = ?, severity = ?, scope = ?, model_tag = ?, origin = ?, declared_by = ?,
              reason = ?, circle = ?, sync_updated_at = ?, sync_revision = sync_revision + 1, sync_writer = ?
        WHERE concept_id = ?`,
    ).run(
      input.stageId, severity, input.scope, modelTag, input.origin,
      input.declaredBy ?? null, reason, input.circle, syncAt, deps.syncDeviceId, input.conceptId,
    );
    // UNCONDITIONAL, not gated on touchesDenyPower. Before the mirror widened past blocking-only
    // (slice 4b-B), a bump that did not touch deny power had nothing to tell the mirror — an
    // advisory-to-advisory edit was invisible to it by construction. Now EVERY live rule is mirror
    // content, so an edit that changes only severity-within-advisory, scope, modelTag, reason, or
    // origin on an already-live binding is exactly as mirror-relevant as a blocking-power change —
    // and this branch is only reached when mode is "replace" or this is the binding's first write,
    // so it always represents a real, intended change reaching the row (see BindMode's own comment).
    //
    // KEPT, NOT REMOVED, despite `trg_rule_bindings_bump_on_reclassification` (Codex round 10, items
    // 2+3) now ALSO watching most of these same columns — considered removing it, to match round
    // 8/9's own "one bump source, not two" resolution, and deliberately did not: THIS call is also
    // the ONLY thing that bumps for `circle` changing on THIS exact write (a local narrow/widen via
    // declare() — captureRuleBinding's own three-state fallback chain feeds `input.circle` right
    // above), and `circle` could not be added to that trigger's own column list to cover it, because
    // `trg_rule_bindings_follow_concept_circle`'s OWN body (`UPDATE rule_bindings SET circle = ...`)
    // would then cascade into firing it every time a concept moves circles — verified empirically,
    // not assumed, and NOT prevented by `recursive_triggers` (confirmed OFF, but shown by direct
    // probe to gate something narrower than cross-trigger cascading: a trigger's own write DOES
    // fire a DIFFERENT trigger watching the column it touches, regardless of that pragma). So this
    // call stays for circle's sake, and — since it cannot be split from the other seven columns in
    // ONE UPDATE statement without a second, more invasive change to this branch's own shape — it
    // ALSO still fires for THOSE seven, alongside the new trigger, on every genuine reclassification.
    // A deliberate, accepted double bump for that case (an extra harmless regeneration — the SAME
    // "occasional wasted bump" philosophy round 5's own INSERT trigger already established), traded
    // against the larger, riskier change a truly precise fix would need: giving this "replace"
    // branch its own upsertStage-style genuine-change pre-check across all eight columns, in a
    // function this central and this heavily exercised, for a savings that costs nothing to skip.
    bumpGateGeneration(db);
    return { row: getRuleBinding(db, input.conceptId)!, previousSeverity, downgradedFromBlocking };
  }

  const row: RuleBindingRow = {
    concept_id: input.conceptId,
    stage_id: input.stageId,
    severity,
    scope: input.scope,
    model_tag: modelTag,
    origin: input.origin,
    declared_by: input.declaredBy ?? null,
    reason,
    circle: input.circle,
    created_at: syncAt,
    sync_updated_at: syncAt,
    sync_revision: 0,
    sync_writer: deps.syncDeviceId,
  };
  db.prepare(
    `INSERT INTO rule_bindings (concept_id, stage_id, severity, scope, model_tag, origin, declared_by,
                                reason, circle, created_at, sync_updated_at, sync_revision, sync_writer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.concept_id, row.stage_id, row.severity, row.scope, row.model_tag, row.origin,
    row.declared_by, row.reason, row.circle, row.created_at, row.sync_updated_at, row.sync_revision, row.sync_writer,
  );
  // UNCONDITIONAL — see the UPDATE branch's own comment above. A brand-new binding, of ANY severity,
  // is a brand-new mirror entry.
  bumpGateGeneration(db);
  return { row, previousSeverity, downgradedFromBlocking };
}

// ---- the gate ---------------------------------------------------------------

/**
 * Does this stored reason amount to no reason at all?
 *
 * ONE DEFINITION, shared by the gate, the sidecar and the stats, because a disclosure that three
 * surfaces compute differently is worse than one they all omit. `bindRule` normalizes a blank to
 * NULL on the way in, so locally these are the same question — but a relayed row is written
 * straight through by graft and can arrive carrying "   ", and a whitespace reason renders as a
 * blank line under the deny rather than as an answer.
 */
export function hasNoReason(reason: unknown): boolean {
  // TOTAL OVER PERSISTED VALUES, and that is the load-bearing half. SQLite stores whatever a writer
  // hands the column, so a malformed peer — or an older build, or a hand-edited row — can leave a
  // NUMBER in `reason`. The typed signature says string, the runtime value is not, and `.trim()`
  // threw: a matching gate query, a sidecar rebuild and a gate-stats read all blew up, so the rule's
  // deny stopped being delivered live AND offline. Every other defect this module guards against is
  // a deny that misinforms; this was a deny that VANISHES with an exception, which the mirror exists
  // to make impossible.
  //
  // A non-string is read as NO REASON rather than coerced, because that is the truthful reading: 42
  // is not an explanation of anything. The rule is then exactly what this branch already built the
  // disclosure for — a deny that cannot explain itself — so it is marked `reasonMissing`, counted in
  // `unexplainedDenies`, named in the curation view, and repaired by an ordinary declaration.
  // Nothing special-cases it, because it is not a special case.
  if (typeof reason !== "string") return true;
  return reason.trim() === "";
}

/**
 * Does this concept's `body` amount to no invocation payload at all? Same defensive shape as
 * `hasNoReason` just above — non-string reads as absent, blank-after-trim reads as absent — but it
 * is its OWN predicate rather than a call to that one: `body` is the recognized matcher's
 * capability payload (StageLookupRule.body), a different column answering a different question
 * than a deny's explanation, and there is no write-time guard forcing it non-blank the way a
 * blocking rule's `reason` is guarded (recognized delivery is advisory-only; nothing here is ever
 * refused for lacking a body). The defensiveness is still earned: a concept created before this
 * slice, or a row relayed from a peer, can carry a blank or non-string body, and toStageLookupRule
 * must read that as "no payload" rather than leak "   " as though it were the invocation.
 */
function hasNoBody(body: unknown): boolean {
  if (typeof body !== "string") return true;
  return body.trim() === "";
}

/**
 * Line terminators a renderer will act on. U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR ride
 * with CR and LF because they are line breaks to JS string literals, to JSON embedded in a script,
 * and to a fair number of terminal renderers — a "one line" contract that only checked `\n` would
 * be enforcing the easy half of itself. Escapes, not literals: a raw U+2028 sitting in source is
 * the very hazard this rejects, and it is invisible to whoever edits this file next.
 */
const REASON_LINE_BREAK = /[\r\n\u2028\u2029]/;

/**
 * Is this reason the ONE LINE the contract says it is?
 *
 * The reason is the sentence a host prints beside a deny at the moment it fires, and three separate
 * doc comments promise it is one line. Nothing enforced it, so `"prevents data loss\nDENIED BY
 * ADMIN"` was storable and copied verbatim into the gate and the sidecar — a host rendering the
 * promised one-liner then emits several lines of what reads as gate output, one of which the gate
 * never said. A deny is an assertion of authority, and text that appears to come from it while
 * nobody wrote it is the one thing a deny's explanation must never be.
 */
export function hasLineBreak(reason: string | null | undefined): boolean {
  return typeof reason === "string" && REASON_LINE_BREAK.test(reason);
}

/** One rule as the gate delivers it: small, with the reason that earns compliance. */
export interface GateRule {
  conceptId: string;
  /** The rule itself — the concept's title, which is its first line. Never the body. */
  text: string;
  /** The prevented-failure one-liner. Null when the capture never supplied one. */
  reason: string | null;
  /**
   * THIS DENY CANNOT EXPLAIN ITSELF — disclosed rather than hidden.
   *
   * Local creation of a reasonless deny is refused outright (see bindRule), so the only way one
   * exists here is relay: a peer running an older build declared it, and this machine accepted the
   * row because REFUSING IT WOULD REMOVE A DENY THE PEER HAS (see the graft site in engine.ts).
   * The row is therefore legal, live, and firing — and the promise that every deny arrives with the
   * failure it prevents is, for this one rule, unmet.
   *
   * A caller that renders a deny reads this and says so. Hiding it would make the promise FALSE
   * rather than merely unmet, which is the worse of the two: a bare refusal a user cannot explain
   * is the thing the reason exists to prevent, and it is survivable exactly as long as everyone
   * can see it is happening.
   *
   * ALWAYS PRESENT, never optional, and never encoded into `reason` itself — `reason` stays null so
   * nothing downstream renders a sentinel string at somebody. Advisory rules are never marked: an
   * advisory with no reason is ordinary, and marking it would bury the signal in noise.
   */
  reasonMissing: boolean;
  severity: RuleSeverity;
  scope: RuleScope;
  /** Non-null exactly for agent-scoped rules: which model this compensates for. */
  modelTag: string | null;
  origin: RuleBindingOrigin;
  /** Which matched stage this rule is bound to, so a multi-stage fire stays attributable. */
  stageId: string;
  /**
   * The principle this rule was derived from, when one exists. "A firing projected rule announces
   * its provenance ('derived from principle P'), so a wrong projection misfires in front of the
   * human" — which only works if the gate response carries the parent.
   */
  projectedFromPrincipleId?: string;
  /**
   * A PARENT IS UNDER IMPEACHMENT (slice 5-B) — set when one of this rule's derivation parents is a
   * principle whose status is `disputed`, omitted otherwise. `projectedFromPrincipleId` remains the
   * earliest stable display parent and need not be the disputed one. Never `false`: absence is the
   * ordinary case, and a field that said `false` on every rule in every fire would be pure resident cost.
   *
   * DISCLOSURE ONLY. Delivery, severity and firing are unchanged by it: the rule was born of a
   * correction or a projection and stands on its own evidence, so a doubtful parent does not
   * silently withdraw a rule an agent is relying on. What it changes is what the agent knows —
   * "the rule I am about to follow descends from a principle a human is currently re-ruling on" —
   * which is exactly the "misfires in front of the human" loop projection's missing approval gate
   * rests on, extended from the projection itself to its parent.
   *
   * LIVE PATH ONLY. `status` is live state, and a frozen copy in the gate mirror would keep
   * announcing doubt after the human resolved it (or, worse, stay silent after they opened it) —
   * see `evaluateGateFromMirror`'s own comment.
   */
  parentDisputed?: true;
  /**
   * The disputed parents' identities, present exactly when `parentDisputed` is (review fix — PR
   * #112 round 2). The flag alone advertised a recovery step no MCP caller could take: the wire
   * said "inspect the rule's lifecycle edges", but edge reads are engine-only, so an agent could
   * not learn WHICH parent needs mediation. Carried only in the rare disputed state — the
   * common-case payload cost stays zero — and sorted lexically for deterministic output (the
   * order carries no meaning; a parent's dispute is not ranked). At most `DISPUTED_PARENTS_CAP`
   * entries; membership-restricted like the impeachment write side (a parent the human already
   * rejected or retired is a settled question, not a pending mediation).
   */
  disputedParentIds?: string[];
  /** Present (always `true`) only when disputedParentIds hit its cap — more disputed parents
   *  exist than delivered; memory_overview's open contradictions list the rest. */
  disputedParentsTruncated?: true;
}

export interface GateStageRef {
  id: string;
  name: string;
}

export interface GateResult {
  /**
   * The first matched stage in deterministic order, or null on silence. `stages` carries the full
   * set: several stages CAN match one action (a broad `git push` stage and a narrow
   * `git push --force` one), and the design says nothing about suppressing either, so all of them
   * fire and their rules union.
   */
  stage: GateStageRef | null;
  stages: GateStageRef[];
  rules: GateRule[];
  /**
   * True only when NO stage matched — "the agent is off the map, and says so". A matched stage with
   * zero live rules is NOT silence: it is the projection hook ("stage X, no cached rules — skeleton
   * applies"), and collapsing the two would delete the signal the projection slice consumes.
   *
   * NEVER true on overflow. See `overflow`.
   */
  silence: boolean;
  /**
   * The context was past the refusal threshold and NOTHING was matched against it.
   *
   * A THIRD VERDICT, not a flavour of silence, because the two mean opposite things: silence is
   * "nothing governs this action", overflow is "I could not tell". A host maps this to asking the
   * human — never to allowing — which is exactly what the two prefix-matching bugs before it made
   * impossible by reporting a confident silence over an input nobody had finished reading.
   */
  overflow: boolean;
  /** `live` = answered from the store. The sidecar path (slice 4b) is the other answer. */
  source: "live" | "sidecar";
}

export interface GateQueryOptions {
  /** The raw action the host intercepted, verbatim. */
  actionContext: string;
  /** Locality: only rules whose concept lives in this circle fire. */
  circle: string;
  /**
   * WHICH MODEL IS ASKING — the mechanism behind "a new model retires the old model's compensations
   * automatically" (design of record, *Nothing waits on scheduled review*).
   *
   * An `agent`-scoped rule is a compensation for ONE model's failure habits. Delivering it to a
   * different model is the shackle risk the scope split exists to prevent: the next, better model
   * inherits the last one's defects as instructions. So when this is supplied, agent-scoped rules
   * fire only for their own model tag; `domain` rules (true for a perfect agent) always fire.
   *
   * OMITTED means every agent-scoped rule still fires. That is deliberate backward compatibility,
   * not a default policy — a caller that does not know which model it is must not have its rules
   * silently disappear. The CLI that wires the host hooks always passes it.
   *
   * FILTERING IS NOT RETIREMENT. Nothing here retires anything: mismatched rules stop being
   * DELIVERED and show up in `gateStats().retirementCandidates` for curation to act on. Inventing a
   * model-change detector that retires rules on its own would be a scheduled-review mechanism in
   * disguise, which the design rules out.
   */
  runtimeModelTag?: string;
  /** Clock seam. Defaults to wall time. */
  now?: number;
  /** Sync clock seam for the `verified` flip, so it re-exports. Omitted = flip stamped with `now`. */
  nextSyncTimestamp?: () => number;
  /**
   * `false` makes this call a PURE READ: no instrumentation row, and no `verified` flip either.
   *
   * The flip used to happen regardless, so a benchmark or a preview marked patterns as
   * battle-tested without any real action having been intercepted — the dead-pattern watchlist,
   * whose entire job is to say "this has never matched anything real", was being silenced by
   * measurement. `record: false` now means exactly one thing: asking without it counting.
   */
  record?: boolean;
}

/**
 * `stageLookup`'s own delivery shape: everything `GateRule` carries, plus the capability
 * invocation payload the recognized matcher — and only the recognized matcher — spends the tokens
 * on. A distinct type rather than a widened `GateRule` (design directive): "never the body" stays
 * true for gateQuery's own delivery, unconditionally; this is agent-initiated pull at the moment of
 * need, which is where paying for the extra field is right ("capabilities are content too — and the
 * payload is the invocation, not a description").
 */
export interface StageLookupRule extends GateRule {
  /** The rule concept's body when non-blank, else null — the invocation itself, not a description
   *  of one. Null covers both "nothing was ever written below the title" and a blank/corrupt body
   *  relayed from a peer (see `hasNoBody`) — the caller cannot tell those apart and should not need
   *  to: either way there is no payload to act on. */
  body: string | null;
}

export interface StageLookupOptions {
  /**
   * The stage name (or id) the agent recognizes itself to be at. Resolved via `findStage`: exact
   * id, else exact/normalized (trimmed, whitespace-collapsed, case-insensitive) name. NO fuzzy or
   * embedding matching — recognition is the agent's own act against the resident stage index, and
   * this call is a lookup against it, not a search; a third matcher is out of scope by design.
   *
   * NAME-REACHABILITY SURVIVES A MECHANICAL RE-AIMING (doctrine, ruled). A stage's TRIGGER PATTERNS
   * are the mechanical matcher's own firing surface — re-authoring them (memory_declare's
   * `patterns`) reroutes what `gateQuery` matches, nothing else. This lookup resolves by NAME/id
   * against the stage registry, never by pattern, so a rule bound to this stage — including a
   * blocking one — stays reachable here exactly as before, until the RULE itself is withdrawn,
   * downgraded, or superseded, or the stage's own rules all die (stage retirement/inertness). A
   * pattern change is therefore never a rule-withdrawal lever by itself: it narrows what the agent
   * is INTERCEPTED into, not what it can still ask for by name. See engine.ts's
   * `assertPatternReauthoringAcknowledged` doc comment for the mechanical-side rationale this
   * complements.
   */
  stage: string;
  /** Locality: only rules whose concept lives in this circle are delivered — same as gateQuery. */
  circle: string;
  /** Same model-tag filter as GateQueryOptions.runtimeModelTag, applied through the same query. */
  runtimeModelTag?: string;
  /** Clock seam. Defaults to wall time. */
  now?: number;
  /** Sync clock seam for the gate_events row. Omitted = stamped with `now`. */
  nextSyncTimestamp?: () => number;
  /** `false` makes this call a pure read: no gate_events row. Mirrors GateQueryOptions.record. */
  record?: boolean;
}

export interface StageLookupResult {
  /**
   * True when the named stage exists in the registry — a HIT, whether or not it delivered rules.
   * False = a MISS (no such stage), never conflated with a stage-hit-no-rules: `rules: []` means
   * two different things depending on `matched`, exactly as GateResult.silence disambiguates the
   * mechanical side's own stage-hit-no-rules from a true silence.
   *
   * NIT: a HIT can reach stage-hit-no-rules for TWO different reasons, and this field alone does
   * not distinguish them — the stage genuinely has no rules ANYWHERE, or it has rules bound in
   * OTHER circles but none in the caller's own (stages are store-global; rule bindings are
   * circle-scoped — see the module header's "WHY STAGES ARE STORE-GLOBAL" note). Both render as
   * `matched: true, rules: []` here, which is correct (this circle's gate truly delivers nothing),
   * but a curation reader asking "does anything govern this stage at all" needs `gateStats`/the
   * stage registry, not this result, to tell the two apart.
   */
  matched: boolean;
  /** The resolved stage, or null on a miss. */
  stage: GateStageRef | null;
  /**
   * Live rules bound to the stage. Empty on a genuine stage-hit-no-rules AND on a miss alike.
   *
   * BOUNDED AT RETRIEVAL (review fix — Codex round 2): at most `STAGE_LOOKUP_RULES_CAP` entries,
   * each with `body` itself substr'd to at most `STAGE_LOOKUP_BODY_CAP` characters. When the
   * TRUE population is larger than that on either axis, `rulesTotal`/`rulesOutline` (below) carry
   * what this array alone can no longer tell the whole truth about — `rules.length` is safe to
   * treat as "the whole truth" ONLY when both of those are absent.
   */
  rules: StageLookupRule[];
  /**
   * The TRUE total count of live rules for this stage, present ONLY when it exceeds what `rules`
   * itself holds — i.e., the SQL-level retrieval cap (`STAGE_LOOKUP_RULES_CAP`) actually bound
   * something. Absent means `rules.length` IS the true total (the common case, and the ONLY case
   * before this field existed); present means a caller computing "how many are not shown" must use
   * THIS number, not `rules.length` — the retrieval itself is now capped, so `rules.length` alone
   * can no longer be trusted as the whole truth the way it could when the query was unbounded.
   */
  rulesTotal?: number;
  /**
   * A compact {conceptId, text} outline of live rules BEYOND what `rules` itself holds (via
   * `ruleOutlineForStage`) — present in the SAME situation `rulesTotal` is, and only up to
   * `STAGE_LOOKUP_OUTLINE_CAP` entries (this projection is cheap per row, not free at any row
   * count). Exists so the wire's omitted-rules recovery ladder can still NAME rules the primary,
   * body-bearing fetch never retrieved at all — it cannot outline a row it never fetched, and this
   * is that row's stand-in.
   */
  rulesOutline?: RuleOutlineEntry[];
  /**
   * The live stage index (`liveStageIndex`), carried on EVERY miss — including when the index
   * ITSELF is empty (`[]`) — so a misremembered name self-repairs in one round trip. Absent on a
   * hit — the agent already named the right stage and does not need the whole registry restated.
   *
   * DELIBERATELY NOT the same convention `PrewarmState.stageIndex` uses. Prewarm omits the field
   * entirely when the index is empty ("no schema noise for installs with no stages" — there is
   * nothing actionable to say). A miss is different: "no live stages exist at all" IS the
   * informative answer to "why didn't my lookup match anything", so this field is present
   * (as `[]`) whenever `matched` is false, never folded into an omitted-when-empty convention that
   * would make an empty registry indistinguishable from a server that predates this field.
   */
  stageIndex?: string[];
  /**
   * The TRUE total count of live stages, present ONLY when `stageIndex` itself was capped at
   * retrieval (`STAGE_INDEX_CAP` — review fix, Codex round 3) — mirrors `rulesTotal`'s own honesty
   * contract exactly. Absent means `stageIndex.length` IS the true total.
   */
  stageIndexTotal?: number;
}

interface BindingJoinRow {
  concept_id: string;
  stage_id: string;
  severity: RuleSeverity;
  scope: RuleScope;
  model_tag: string | null;
  origin: RuleBindingOrigin;
  reason: string | null;
  title: string;
  /** The rule concept's full body. gateQuery's own mapper (toGateRule) never reads this field;
   *  only stageLookup's (toStageLookupRule) does — selected unconditionally here rather than by a
   *  second query, because the only thing that differs between the two matchers' delivery is which
   *  fields their own mapper reads off the SAME row, and the chokepoint predicate below must not
   *  have two copies to keep in sync. */
  /**
   * The rule concept's full body, or `null` when the caller asked `rulesForStages` NOT to select
   * it (`withBody: false`). gateQuery's own mapper (toGateRule) never reads this field regardless
   * of what it holds; only stageLookup's (toStageLookupRule) does, which is why ONLY that caller
   * passes `withBody: true`. See rulesForStages' own comment for why this is a column-selection
   * flag rather than always fetching it and discarding it in the mapper.
   */
  body: string | null;
  created_at: number;
  parent_concept_id: string | null;
  /** 1 when any locally resolved derivation parent is a disputed, still-member principle. */
  parent_disputed: number;
  /** Comma-joined disputed-member-parent ids, capped and lexically ordered; NULL on the
   *  mechanical gate path (only the stage_lookup path pays for the aggregation) and when none. */
  disputed_parent_ids: string | null;
}

/**
 * THE one disputed-member-parent predicate — shared verbatim by the hot path's EXISTS and the
 * lookup path's id aggregation (rulesForStages), so the flag and the ids can never answer
 * different questions. Status first: the verdict subquery only runs for rows already disputed.
 */
const DISPUTED_MEMBER_PARENT_WHERE = `p.family = 'derivation' AND p.dst_concept_id = b.concept_id
                  AND pc.kind = 'principle' AND pc.status = 'disputed'
                  AND (SELECT r.verdict FROM ratifications r
                        WHERE r.subject_concept_id = pc.id
                        ORDER BY r.created_at DESC, r.id DESC LIMIT 1) IN ('approve','re-ratify')`;

/**
 * THE shared liveness predicate every rule-delivery query in this module must agree on: active
 * concept, kind='rule', not superseded, in the caller's circle (or breadth), respecting the
 * model-tag filter. A raw SQL fragment (not a function) because two DIFFERENT queries need to embed
 * it verbatim in their own WHERE clause — `rulesForStages` (full rule delivery, scoped to specific
 * stage ids) and `liveStageIdsWithRules` (liveStageIndex's own minimal existence check, over every
 * stage) — and "the same predicate, maintained as two copies" is exactly the drift risk this
 * module's chokepoint doctrine exists to close. Takes exactly 3 positional params, in order: circle,
 * then the model-tag filter's two placeholders (both the same value — `runtimeModelTag ?? null`) —
 * UNCHANGED by breadth: `'${BREADTH_CIRCLE}'` is a FIXED literal interpolated from the exported
 * constant at module load, never a bound value, so it adds no placeholder and every existing call
 * site's param list/order stays exactly as it was (the positional-bind swap this module's own round
 * 3 review already learned the hard way — see rulesForStages' own comment — is the reason this is
 * called out explicitly rather than left to be discovered by a param miscount).
 *
 * THE COLUMN CHECKED IS `b.circle`, NOT `c.circle` — the concept's own circle is no longer what
 * decides delivery (see RuleBindingRow.circle's own comment for why the two can diverge). Every
 * write path that changes a rule's LOCAL circle (bindRule, moveConcept, renameCircle) keeps
 * `rule_bindings.circle` in step with its concept's circle for an ordinary binding; only a breadth
 * binding is allowed to disagree with its own concept's circle, on purpose.
 */
const RULE_LIVENESS_WHERE = `
          (b.circle = ? OR b.circle = '${BREADTH_CIRCLE}')
          AND c.status = 'active'
          AND c.kind = 'rule'
          -- MODEL-TAG RETIREMENT. A domain rule always fires; an agent rule is a compensation for
          -- one model and fires only for that model. A NULL runtime tag disables the filter
          -- entirely rather than hiding every agent rule — see GateQueryOptions.runtimeModelTag.
          AND (b.scope != 'agent' OR ? IS NULL OR b.model_tag = ?)
          AND NOT EXISTS (
            SELECT 1 FROM lifecycle_edges e
             WHERE e.family = 'supersession' AND e.src_concept_id = b.concept_id
          )`;

/**
 * THE shared rules-for-stages selection — every way a rule is fully DELIVERED by EITHER matcher
 * passes through here (refactoring build: this replaces gateInternal's own former inline copy of
 * this query). Same liveness (`RULE_LIVENESS_WHERE`), same circle scope, same model-tag filter,
 * same parent-principle lookup, same ordering (blocking first, then birth order) gateQuery has
 * always used; factoring it out means `stageLookup` answers through IDENTICAL chokepoint semantics
 * rather than a second copy of this SQL that could silently drift from this one.
 *
 * `withBody` — SELECT `c.body` or not. gateInternal (the always-on mechanical fire path) passes
 * `false`: it maps every row through `toGateRule`, which never reads body, so fetching and
 * marshalling a concept's full body across the sqlite boundary on every single intercepted action
 * was pure waste — the same class of waste `listMatchableStages` vs `listStages` already exists to
 * avoid ("a narrower SELECT is the whole optimization; there is no cache, so there is no
 * invalidation to get wrong"). Only `evaluateStageLookup` passes `true`, because only
 * `toStageLookupRule` reads the field.
 *
 * `limit`/`bodyMaxChars`/`reasonMaxChars` — OPTIONAL SQL-level bounds (review fix — Codex round 2,
 * extended round 3 to cover `reason`). All omitted (gateInternal's call, and any other future
 * caller with no reason to cap) is BYTE-IDENTICAL to this function's pre-review-round-2 behavior:
 * no LIMIT clause, `c.body`/`b.reason` selected whole. Only `evaluateStageLookup` passes them, at
 * `STAGE_LOOKUP_RULES_CAP + 1` / `STAGE_LOOKUP_BODY_CAP + 1` / `STAGE_LOOKUP_REASON_CAP + 1` — see
 * those constants' own comment for the "+1 probe" reasoning. `bodyMaxChars`/`reasonMaxChars`
 * choose `substr` over a bare column reference — still a FIXED literal SQL shape, never
 * interpolated caller data; the cap VALUE itself is a bound parameter (`?`), not
 * string-interpolated, so this stays exactly as injection-safe as the unbounded form.
 *
 * `stageIds` empty returns empty with no query — both callers already know a miss/no-match
 * delivers nothing.
 */
function rulesForStages(
  db: StoragePort,
  stageIds: string[],
  circle: string,
  runtimeModelTag: string | undefined,
  withBody: boolean,
  limit?: number,
  bodyMaxChars?: number,
  reasonMaxChars?: number,
  withDisputedParentIds = false,
): BindingJoinRow[] {
  if (stageIds.length === 0) return [];
  const placeholders = stageIds.map(() => "?").join(",");
  // `withBody`/`bodyMaxChars`/`reasonMaxChars` choose between FIXED literal column-expression
  // SHAPES — never interpolated caller data — so this stays exactly as injection-safe as a
  // hand-written static query; the cap VALUES (when set) are bound parameters, never interpolated.
  const bodyColumn = !withBody ? "NULL" : bodyMaxChars !== undefined ? "substr(c.body, 1, ?)" : "c.body";
  const reasonColumn = reasonMaxChars !== undefined ? "substr(b.reason, 1, ?)" : "b.reason";
  const limitClause = limit !== undefined ? "LIMIT ?" : "";
  // PARAMS IN THE EXACT ORDER THEIR `?` PLACEHOLDERS APPEAR IN THE SQL TEXT BELOW: reasonMaxChars'
  // and bodyMaxChars' (both inside the SELECT list, REASON column written first — `reason` is
  // selected before `title`/`body` below) first, then the IN-list, then RULE_LIVENESS_WHERE's own
  // 3, then limit (at the very end) last. better-sqlite3 binds positionally, so this order is
  // load-bearing — review fix (Codex round 3, item 1 follow-up): this was previously written
  // body-then-reason, which is the ORDER THE COLUMNS APPEARED IN BEFORE THIS ROUND (only body had
  // a placeholder; reason was a bare `b.reason` with none) — adding reason's OWN placeholder above
  // without re-checking which column's `?` now comes first in the text silently swapped the two
  // caps: reason bound to bodyMaxChars (6 000, so reasons under that almost never truncated) and
  // body bound to reasonMaxChars (1 200, truncating bodies the wire's own STAGE_LOOKUP_BODY_CAP
  // never asked to touch). Caught empirically, by a test asserting an EXACT capped length rather
  // than only `toBeLessThanOrEqual` — the loose form passes on a swap by coincidence (both caps are
  // "small enough"), which is exactly how this shipped unnoticed the first time.
  const params: unknown[] = [];
  if (reasonMaxChars !== undefined) params.push(reasonMaxChars);
  if (bodyMaxChars !== undefined) params.push(bodyMaxChars);
  params.push(...stageIds, circle, runtimeModelTag ?? null, runtimeModelTag ?? null);
  if (limit !== undefined) params.push(limit);
  return db
    .prepare(
      `SELECT b.concept_id, b.stage_id, b.severity, b.scope, b.model_tag, b.origin, ${reasonColumn} AS reason,
              c.title, ${bodyColumn} AS body, b.created_at,
              -- The parent principle, when there is one, as a CORRELATED SCALAR rather than a
              -- join: a rule may carry several derivation edges, and a join would multiply the
              -- gate's own rows to report a field. Scalar subquery = one row per rule, always,
              -- and one round trip for the whole answer instead of one per delivered rule.
              (SELECT p.src_concept_id FROM lifecycle_edges p
                WHERE p.family = 'derivation' AND p.dst_concept_id = b.concept_id
                ORDER BY p.created_at ASC, p.id ASC LIMIT 1) AS parent_concept_id,
              -- FIRE-TIME DOUBT DISCLOSURE (slice 5-B): ANY derivation parent principle currently
              -- disputed, not only the earliest parent selected for stable display above.
              -- MEMBERS ONLY (review fix — PR #112 round 5): the latest-ratification check is the
              -- same latest-wins read the impeachment WRITE side applies — without it, a disputed
              -- parent the human then REJECTED kept appearing as a pending mediation. The EXISTS
              -- short-circuits at the first qualifying row, and its per-edge cost is one status
              -- probe (the verdict subquery runs only on rows the status filter already passed),
              -- so the mechanical gate pays no aggregation, no DISTINCT, no temp B-tree (review
              -- fix — PR #112 round 8: the previous shape bounded the RESULT but not the WORK).
              EXISTS (
                SELECT 1 FROM lifecycle_edges p
                JOIN concepts pc ON pc.id = p.src_concept_id
                WHERE ${DISPUTED_MEMBER_PARENT_WHERE}
              ) AS parent_disputed,
              -- THE IDS, ON THE LOOKUP PATH ONLY (review fixes — PR #112 rounds 2, 7 and 8): the
              -- identity aggregation (DISTINCT + ORDER BY + LIMIT = temp B-tree over the rule's
              -- whole parent set) exists for the RECOVERY path, which is an agent affordance —
              -- stage_lookup, budget-fitted and latency-tolerant — while the mechanical hook
              -- renders title + reason and never these ids. So the hot path selects literal NULL
              -- and only evaluateStageLookup pays for the aggregation, the same caller split
              -- withBody already draws for the same reason. Ordered before the cap (round 7,
              -- P3) so the capped subset is one deterministic lexical prefix on every replica;
              -- DISTINCT because one parent can hold two edges to the same rule (projection +
              -- ratification); the shared WHERE keeps the flag and the ids answering the same
              -- question. LIMIT is the cap + 1 — the extra id is the mapper's truncation signal,
              -- never delivered.
              ${
                withDisputedParentIds
                  ? `(SELECT group_concat(m.src_id)
                 FROM (SELECT DISTINCT p.src_concept_id AS src_id
                         FROM lifecycle_edges p
                         JOIN concepts pc ON pc.id = p.src_concept_id
                        WHERE ${DISPUTED_MEMBER_PARENT_WHERE}
                        ORDER BY p.src_concept_id ASC
                        LIMIT ${DISPUTED_PARENTS_CAP + 1}
                 ) AS m
              )`
                  : "NULL"
              } AS disputed_parent_ids
         FROM rule_bindings b
         JOIN concepts c ON c.id = b.concept_id
        WHERE b.stage_id IN (${placeholders})
          AND ${RULE_LIVENESS_WHERE}
        ORDER BY (b.severity = 'blocking') DESC, b.created_at ASC, b.concept_id ASC
        ${limitClause}`,
    )
    .all(...params) as BindingJoinRow[];
}

/** One entry of `ruleOutlineForStage`'s compact projection — see that function's own comment. */
export interface RuleOutlineEntry {
  conceptId: string;
  text: string;
}

/**
 * A compact {conceptId, title} projection of a stage's live rules — no body, no reason, no
 * severity/scope, none of the columns `rulesForStages`' full selection carries. Exists for exactly
 * one reason (review fix — Codex round 2): when `evaluateStageLookup`'s primary, body-bearing
 * fetch is capped at `STAGE_LOOKUP_RULES_CAP`, the wire's omitted-rules recovery outline (its
 * degradation ladder's first tier — see mcp-server.ts's stage_lookup handler) still needs to NAME
 * rules the primary fetch never even retrieved, and it cannot outline a row it never fetched. This
 * query is cheap even at a larger cap than the primary one, because a title is ≤80 chars and there
 * is no body/reason to marshal — but "cheap per row" is not "free at any row count", so this has
 * its OWN bound (`limit`, always `STAGE_LOOKUP_OUTLINE_CAP` at the one call site) rather than being
 * left unbounded on the theory that its smallness makes a bound unnecessary.
 *
 * Same liveness (`RULE_LIVENESS_WHERE`) and ordering as `rulesForStages`, so `offset` rows into the
 * IDENTICAL sequence that function enumerates — the caller uses this to fetch exactly the rules
 * BEYOND what the primary fetch already covered (`offset: STAGE_LOOKUP_RULES_CAP`), never
 * re-describing rules the primary fetch already named.
 */
export function ruleOutlineForStage(
  db: StoragePort,
  stageId: string,
  circle: string,
  runtimeModelTag: string | undefined,
  offset: number,
  limit: number,
): RuleOutlineEntry[] {
  return db
    .prepare(
      `SELECT b.concept_id AS conceptId, c.title AS text
         FROM rule_bindings b
         JOIN concepts c ON c.id = b.concept_id
        WHERE b.stage_id = ?
          AND ${RULE_LIVENESS_WHERE}
        ORDER BY (b.severity = 'blocking') DESC, b.created_at ASC, b.concept_id ASC
        LIMIT ? OFFSET ?`,
    )
    .all(stageId, circle, runtimeModelTag ?? null, runtimeModelTag ?? null, limit, offset) as RuleOutlineEntry[];
}

/**
 * Live rule COUNT for one stage — same liveness/circle/model-tag predicate as `rulesForStages`, no
 * row marshaling of any kind. Used only when the primary retrieval was capped (review fix — Codex
 * round 2), so the wire can report an EXACT "how many total" rather than degrading to "at least N"
 * — one indexed `COUNT(*)` is negligible next to the row-fetching cost it replaces, and it is a
 * cost paid only in the (expected-rare) case that actually needs it.
 */
function countLiveRulesForStage(
  db: StoragePort,
  stageId: string,
  circle: string,
  runtimeModelTag: string | undefined,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM rule_bindings b
         JOIN concepts c ON c.id = b.concept_id
        WHERE b.stage_id = ?
          AND ${RULE_LIVENESS_WHERE}`,
    )
    .get(stageId, circle, runtimeModelTag ?? null, runtimeModelTag ?? null) as { n: number };
  return row.n;
}

/**
 * Names-only, LIVE-only, retrieval-bounded stage names, ACROSS EVERY STAGE (no stageIds
 * restriction — this is `liveStageIndex`'s own query, and it always asks about the whole registry,
 * never a subset). Review fix — Codex round 3: this REPLACES a former two-step approach
 * (`listStages` fetching every column of every stage — including each one's serialized
 * `trigger_patterns` blob — then filtering in JS against a separate live-id Set) with ONE JOINed,
 * `SELECT DISTINCT s.name` query: no trigger_patterns, no origin, no verified flag, no clocks,
 * materialized for EVERY stage on EVERY `agent_context` call, every `prewarm`, and every
 * `stageLookup` miss, just to keep a handful of names — exactly the always-on retrieval cost the
 * rules/body/reason SQL bounds elsewhere in this file exist to close. Shares `RULE_LIVENESS_WHERE`
 * with `rulesForStages`/`countLiveRulesForStage` rather than a hand-rolled copy, so "live" cannot
 * drift between them. No model-tag filter (hardcoded `null` params): the index is deliberately not
 * model-tag-aware — see `liveStageIndex`'s own comment. `limit` bounds this too (the caller passes
 * `STAGE_INDEX_CAP + 1`, the same "+1 probe" shape as the rules/body/reason caps) — a bare name is
 * cheap per row, not free at any row count.
 */
function liveStageNamesCapped(db: StoragePort, circle: string, limit: number): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT s.name AS name
         FROM stages s
         JOIN rule_bindings b ON b.stage_id = s.id
         JOIN concepts c ON c.id = b.concept_id
        WHERE ${RULE_LIVENESS_WHERE}
        ORDER BY s.name ASC
        LIMIT ?`,
    )
    .all(circle, null, null, limit) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/**
 * Distinct live-stage COUNT — same liveness/circle predicate as `liveStageNamesCapped`, no row
 * marshaling of any kind. Used only when the primary fetch actually hit `STAGE_INDEX_CAP`, so the
 * caller can report an EXACT "how many total" rather than degrading to "at least N" — mirrors
 * `countLiveRulesForStage`'s own reasoning exactly (one indexed `COUNT(*)`, a cost paid only in
 * this expected-rare case).
 */
function countLiveStages(db: StoragePort, circle: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT s.id) AS n
         FROM stages s
         JOIN rule_bindings b ON b.stage_id = s.id
         JOIN concepts c ON c.id = b.concept_id
        WHERE ${RULE_LIVENESS_WHERE}`,
    )
    .get(circle, null, null) as { n: number };
  return row.n;
}

/** gateQuery's own delivery shape: title + reason, NEVER the body — see GateRule's own comment. */
function toGateRule(row: BindingJoinRow): GateRule {
  return {
    conceptId: row.concept_id,
    text: row.title,
    // NON-STRINGS DELIVER AS NULL, so this field is the `string | null` it is declared to be. A
    // BLOB in the column (TEXT affinity converts numbers, but not blobs) would otherwise be handed
    // to a caller that has every right to call string methods on it — moving the crash from here
    // to them. Blank strings still pass through verbatim: they are text, just useless text, and
    // `reasonMissing` is what says so.
    reason: typeof row.reason === "string" ? row.reason : null,
    // Scoped to blocking on purpose: an advisory rule without a reason is the ordinary case, and
    // marking those would drown the one population a caller actually has to say something about.
    //
    // COMPUTED FROM WHATEVER row.reason HOLDS, which is the FULL value for gateInternal's call
    // (never bounded) but may be substr'd to STAGE_LOOKUP_REASON_CAP + 1 chars for
    // evaluateStageLookup's (review fix — Codex round 3: reason's own SQL-retrieval bound). For
    // every REALISTIC reason (under the cap, which every blocking reason already must be under —
    // one line rarely runs anywhere near 1 200 characters) this is IDENTICAL to computing it on
    // the full value: substr of a short string returns the whole string. The only way this could
    // differ is a reason LONGER than the cap whose first `CAP + 1` characters are ALL
    // whitespace-per-hasNoReason with real content beyond that boundary — a doubly-pathological
    // shape (long AND specifically front-loaded with nothing) with no realistic authoring path,
    // blocking or advisory. DELIBERATELY NOT chased with a SQL-side blank check instead: this
    // module already learned that lesson once (see hasNoReason's own "THE PREDICATE IS NOT IN THE
    // SQL" doctrine, and gateStats' `unexplainedDenies` comment) — SQLite's TRIM() and JS's
    // `.trim()` disagree on tabs/newlines, and a wider hand-picked character set would only move
    // the disagreement to some OTHER whitespace character neither implementation has hit yet. ONE
    // definition of "blank," applied to whatever text actually reached this function, stays the
    // correct trade against reintroducing that exact bug class for an edge case this narrow.
    reasonMissing: row.severity === "blocking" && hasNoReason(row.reason),
    severity: row.severity,
    scope: row.scope,
    modelTag: row.model_tag,
    origin: row.origin,
    stageId: row.stage_id,
    ...(row.parent_concept_id !== null ? { projectedFromPrincipleId: row.parent_concept_id } : {}),
    // SET ONLY WHEN TRUE, and only alongside a display parent. The EXISTS probe may find a later
    // disputed parent while `projectedFromPrincipleId` deliberately stays the earliest stable one;
    // the field documents that one of the rule's actual parents is disputed, not which one.
    ...(row.parent_concept_id !== null && row.parent_disputed === 1 ? { parentDisputed: true as const } : {}),
    ...(row.parent_concept_id !== null && row.parent_disputed === 1 && row.disputed_parent_ids !== null
      ? (() => {
          const ids = row.disputed_parent_ids.split(",").sort();
          return ids.length > DISPUTED_PARENTS_CAP
            ? { disputedParentIds: ids.slice(0, DISPUTED_PARENTS_CAP), disputedParentsTruncated: true as const }
            : { disputedParentIds: ids };
        })()
      : {}),
  };
}

/** stageLookup's own delivery shape: everything toGateRule carries, plus the body payload. */
function toStageLookupRule(row: BindingJoinRow): StageLookupRule {
  return { ...toGateRule(row), body: hasNoBody(row.body) ? null : row.body };
}

/**
 * THE FIRING PATH. Pure SQL and string matching: no model, no network, no embedding, no clock
 * dependence beyond the instrumentation stamp.
 *
 * Three exclusions decide which rules are live, and each one is load-bearing:
 *
 *   CIRCLE — a rule is an ordinary concept in an ordinary circle, and gates are scoped to the
 *   invoking circle exactly as sessions are. (Interpretive addition, flagged for review: the design
 *   says circles are "orthogonal locality, unchanged" but never states which locality a gate reads.
 *   Scoping to the caller's circle is the conservative reading — a store-global rule can be added
 *   when evidence demands one, whereas un-scoping later would silently start firing every project's
 *   rules in every project.)
 *
 *   SUPERSESSION — a rule with an outgoing supersession lifecycle edge has been overturned. "The
 *   superseded rule is retained as history, never re-injected", and "a gate never returns two
 *   contradicting rules". The edge is the only thing that says so: the old concept stays active and
 *   searchable on purpose, because it is the impeachment evidence traveling up the parent edge.
 *
 *   STATUS — a retired concept governs nothing.
 *
 * ORDER is severity-blocking-first, then created_at, then id: a deny must be the first thing an
 * agent reads, and everything after it is stable so two machines with the same rules render the
 * same gate.
 */
/** Which matcher produced a gate_events row. See that column's own comment in GATE_SCHEMA_SQL. */
export type GateMatcher = "mechanical" | "recognized";

/**
 * What a completed gate READ still owes the database. Held as data so the caller decides when — and
 * in what transaction — those writes happen. See `evaluateGate`.
 */
export interface PendingGateWrites {
  actionContext: string;
  circle: string;
  now: number;
  overflow: boolean;
  latencyUs: number;
  matchedStageIds: string[];
  /** Stages whose `verified` flag this fire would flip. Empty when nothing needs flipping. */
  verifyStageIds: string[];
  primaryStageId: string | null;
  ruleCount: number;
  maxSeverity: RuleSeverity | null;
  /** gateInternal always sets 'mechanical'; evaluateStageLookup always sets 'recognized'. */
  matcher: GateMatcher;
}

/**
 * THE GATE, AS A PURE READ. Returns the verdict plus the instrumentation the caller still owes.
 *
 * WHY THE SPLIT EXISTS. Doing the read and the writes in one transaction means a DEFERRED read
 * transaction upgrading to a write one, and SQLite can refuse that upgrade with SQLITE_BUSY when
 * another connection committed in between — the snapshot the reader holds is no longer the head.
 * The consequence would be a gate lookup THROWING because an event row could not be inserted,
 * which is the worst possible trade: losing one instrumentation row is a rounding error on a rate,
 * and failing to deliver a deny is the thing this whole subsystem exists to prevent.
 *
 * So the verdict is computed and returned first; the writes are the caller's separate, short,
 * failure-tolerant transaction — MonetCore.gate() wraps it in try/catch and swallows a failure
 * outright. That tolerance is what actually carries this, not exclusivity: storage.ts's own
 * constructor sets WAL + busy_timeout precisely so the MCP server and a `monet` CLI call can share
 * one `.monet` DB, and `locking_mode=EXCLUSIVE` is a narrow, opt-in, released state used elsewhere in
 * this codebase (acquireExclusiveOwnership) — not the steady one. A second writer really can commit
 * between this read and that write; the split exists so that when it does, the verdict already
 * returned is unaffected and the lost write is a rounding error, not a thrown gate lookup.
 */
export function evaluateGate(db: StoragePort, opts: GateQueryOptions): { result: GateResult; pending: PendingGateWrites | null } {
  return gateInternal(db, opts);
}

/**
 * Apply what a gate read owes. Safe to skip entirely: everything here is instrumentation and the
 * `verified` flag, neither of which any verdict depends on.
 */
export function commitGateWrites(db: StoragePort, pending: PendingGateWrites, nextSyncTimestamp?: () => number): void {
  if (pending.verifyStageIds.length > 0) {
    const stamp = nextSyncTimestamp ? nextSyncTimestamp() : pending.now;
    const flip = db.prepare(`UPDATE stages SET verified = 1, sync_updated_at = ? WHERE id = ?`);
    for (const id of pending.verifyStageIds) flip.run(stamp, id);
  }
  const eventId = db.prepare(
    `INSERT INTO gate_events (ts, action_context, matched_stage_id, rule_count, max_severity, latency_us, circle, truncated, overflow, matcher)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    pending.now,
    pending.actionContext.length > MAX_RECORDED_CONTEXT_BYTES
      ? pending.actionContext.slice(0, MAX_RECORDED_CONTEXT_BYTES)
      : pending.actionContext,
    pending.primaryStageId,
    pending.ruleCount,
    pending.maxSeverity,
    pending.latencyUs,
    pending.circle,
    pending.actionContext.length > MAX_RECORDED_CONTEXT_BYTES ? 1 : 0,
    pending.overflow ? 1 : 0,
    pending.matcher,
  ).lastInsertRowid;
  // `lastInsertRowid` is optional on the port (an adapter may not report it). Without it the
  // per-stage links are skipped rather than written against a guessed id — an undercount in
  // byStage is a worse-but-honest stat, a link to the wrong event is a wrong one.
  if (pending.matchedStageIds.length > 0 && eventId !== undefined) {
    const link = db.prepare(`INSERT OR IGNORE INTO gate_event_stages (event_id, stage_id) VALUES (?, ?)`);
    for (const id of pending.matchedStageIds) link.run(Number(eventId), id);
  }
}

/**
 * Read and write in one call — the standalone form, for callers with no transaction of their own.
 * The engine uses `evaluateGate` + `commitGateWrites` so it can put its own boundaries between them.
 */
export function gateQuery(db: StoragePort, opts: GateQueryOptions): GateResult {
  const { result, pending } = gateInternal(db, opts);
  if (pending) commitGateWrites(db, pending, opts.nextSyncTimestamp);
  return result;
}

/**
 * `*` is the breadth marker on a rule BINDING (BREADTH_CIRCLE's own comment), never a selectable
 * circle a QUERY can be scoped to — refused at every gate-query entrance (Codex round 6, item 2), one
 * shared message so the three call sites cannot drift apart. `RULE_LIVENESS_WHERE`'s own
 * `(b.circle = ? OR b.circle = '*')` (and evaluateGateFromMirror's identical JS-side twin) degenerates
 * to matching ONLY global rules the instant `?` itself is bound to '*' — both halves of the OR become
 * the identical clause — silently dropping every LOCAL rule the caller actually meant to ask about,
 * including a local DENY. Reachable only via a direct argument (a pre-breadth `MONET_CIRCLE=*` config,
 * or any caller passing '*' straight through): `resolveCircle` can never PRODUCE '*' from an ordinary
 * circle name post-migration (round 4, item 4 — no alias can ever hold '*' on either side once a
 * store has been through it), so this is not a resolution bug to fix upstream, it is an input this
 * layer must refuse outright rather than silently misinterpret. Called from gateInternal and
 * evaluateStageLookup (both exported wrappers — gateQuery/stageLookup — and MonetCore's own
 * gate()/stageLookup() funnel through these unchanged, so checking here covers all of them) and from
 * evaluateGateFromMirror directly (the offline evaluator has no shared internal to funnel through).
 */
function assertQueryableCircle(circle: string): void {
  if (circle === BREADTH_CIRCLE) {
    throw new Error(
      `circle '${BREADTH_CIRCLE}' is not a queryable circle: it is the reserved global-breadth marker ` +
        `on a rule BINDING, never a circle a query can be scoped to. Name a real circle — a global ` +
        `rule already delivers everywhere on its own, with no need to ask for it by this name.`,
    );
  }
}

function gateInternal(db: StoragePort, opts: GateQueryOptions): { result: GateResult; pending: PendingGateWrites | null } {
  assertQueryableCircle(opts.circle);
  const startedAt = typeof process !== "undefined" && process.hrtime ? process.hrtime.bigint() : null;
  const now = opts.now ?? Date.now();
  const record = opts.record !== false;
  const clamped = clampActionContext(opts.actionContext);

  // OVERFLOW SHORT-CIRCUITS BEFORE ANY MATCHING, and reports a verdict that is not silence. Matching
  // a prefix here is the bug this replaces; reporting silence here is the same bug wearing the
  // honest-looking half of it.
  if (clamped.overflow) {
    const result: GateResult = { stage: null, stages: [], rules: [], silence: false, overflow: true, source: "live" };
    return {
      result,
      pending: record
        ? {
            actionContext: clamped.text, circle: opts.circle, now, overflow: true,
            latencyUs: elapsedUs(startedAt), matchedStageIds: [], verifyStageIds: [],
            primaryStageId: null, ruleCount: 0, maxSeverity: null, matcher: "mechanical",
          }
        : null,
    };
  }

  const context = parseActionContext(clamped.text);

  const matched: MatchableStage[] = [];
  for (const stage of listMatchableStages(db)) {
    const patterns = parseTriggerPatterns(stage.trigger_patterns);
    if (patterns.some((pattern) => matchesTriggerPattern(pattern, context))) matched.push(stage);
  }

  let rules: GateRule[] = [];
  let unverified: string[] = [];
  if (matched.length > 0) {
    // THE CHOKEPOINT'S SHARED SELECTION (rulesForStages) — see that function's own comment. This
    // used to be an inline query here; factored out so stageLookup answers through the identical
    // liveness/scope/model-tag predicate rather than a second copy that could drift. withBody:
    // false — toGateRule never reads a rule's body, so the mechanical fire path (the always-on,
    // per-intercepted-action one) must not pay to fetch and marshal it either.
    rules = rulesForStages(db, matched.map((stage) => stage.id), opts.circle, opts.runtimeModelTag, false).map(toGateRule);

    // FIRST FIRE VERIFIES THE PATTERN, whether or not it delivered a rule: what the flag records is
    // that the pattern matched something real, which is exactly what an authored-from-a-name
    // pattern has never proved. Gated on `record` for that same reason — a measured or previewed
    // match is not a real action, and letting it verify would silence the dead-pattern watchlist
    // with the very calls made to inspect it. Only sync_updated_at moves: `verified` is grow-only
    // and converges outside the (revision, writer) contest, so bumping the revision here would let
    // a local fire outrank a peer's genuine pattern edit.
    unverified = record ? matched.filter((stage) => stage.verified === 0).map((stage) => stage.id) : [];
  }

  const stages = matched.map((stage) => ({ id: stage.id, name: stage.name }));
  /**
   * THE STAGE THAT ANSWERED is the one that contributed the highest-severity rule, not the oldest
   * one that happened to match. When a broad advisory stage and a narrow blocking stage both fire,
   * naming the advisory one — purely because it was created first — points every reader of this
   * field (the deny message, the curation log, the 4b hook) at the wrong stage while a deny is in
   * effect. Falls back to the oldest matched stage when nothing was delivered, which is the
   * projection-hook case where there is no severity to rank by.
   */
  const primaryStageId = rules[0]?.stageId ?? stages[0]?.id ?? null;
  const result: GateResult = {
    stage: stages.find((stage) => stage.id === primaryStageId) ?? null,
    stages,
    rules,
    silence: matched.length === 0,
    overflow: false,
    source: "live",
  };

  return {
    result,
    pending: record
      ? {
          actionContext: clamped.text, circle: opts.circle, now, overflow: false,
          latencyUs: elapsedUs(startedAt),
          matchedStageIds: matched.map((stage) => stage.id),
          verifyStageIds: unverified,
          primaryStageId: result.stage?.id ?? null,
          ruleCount: rules.length,
          maxSeverity: rules.some((rule) => rule.severity === "blocking") ? "blocking"
            : rules.length > 0 ? "advisory" : null,
          matcher: "mechanical",
        }
      : null,
  };
}

const elapsedUs = (startedAt: bigint | null): number =>
  startedAt === null ? 0 : Number((process.hrtime.bigint() - startedAt) / 1000n);

// ---- the stage index ---------------------------------------------------------

/** `liveStageIndex`'s own result — see that function's comment for `total`'s honesty contract. */
export interface LiveStageIndexResult {
  names: string[];
  /**
   * True total count of live stages, present ONLY when `names` itself was capped at retrieval
   * (`STAGE_INDEX_CAP`) — mirrors `StageLookupResult.rulesTotal`'s own honesty contract exactly.
   * Absent means `names.length` IS the true total.
   */
  total?: number;
}

/**
 * Stage names with at least one LIVE rule bound, in this circle — the resident stage index's whole
 * payload (names only, never rule bodies: "the index carries only stages with live rules", the
 * residency law, design of record ~268-278). "Live" is reused, not re-derived: this calls the exact
 * same liveness predicate (`RULE_LIVENESS_WHERE`) `rulesForStages`/`countLiveRulesForStage` use, via
 * `liveStageNamesCapped`'s own narrow, JOINed, names-only query — see that function's own comment
 * for why materializing `listStages`' full-column projection (every stage's serialized
 * `trigger_patterns` blob included) just to filter it down in JS was exactly the always-on
 * retrieval cost this closes (review fix — Codex round 3). A stage whose rules have all died
 * (retired or superseded) contributes no row and is silently absent — inert, uncounted, exactly as
 * the design requires, and reached through the SAME chokepoint rather than a parallel liveness
 * predicate.
 *
 * NOT model-tag filtered, unlike gateQuery/stageLookup's actual rule DELIVERY: the index is a
 * stable map ("recognizing which named moment you are in"), and making stage NAMES flicker with
 * whichever model happens to be running would defeat the one property recognition depends on —
 * that the map does not move under the agent. `liveStageNamesCapped`'s own `null` model-tag params
 * are exactly gateQuery's own documented meaning for an omitted runtime tag ("every agent-scoped
 * rule still fires"), used here as the deliberate, permanent choice for the index rather than a
 * caller's fallback.
 *
 * RETRIEVAL-BOUNDED (review fix — Codex round 3): at most `STAGE_INDEX_CAP` names. `total` is
 * present, with the EXACT count (one indexed `COUNT(*)`, paid only in this expected-rare case),
 * only when retrieval actually hit the cap — mirroring `StageLookupResult.rulesTotal`'s own
 * contract so both callers (`stageLookup`'s miss path, `agent_context`/`prewarm`) can build an
 * honest truncation signal the same way `rulesOmitted` already does.
 *
 * ONE READ TRANSACTION FOR BOTH QUERIES (review fix — round 5 follow-up): the names query and the
 * count query used to run as two separate, unwrapped statements — a concurrent writer (the
 * SUPPORTED MCP+CLI topology storage.ts's WAL+busy_timeout setup exists for) landing a rule
 * bind/retire BETWEEN them could make `total` describe a DIFFERENT instant than `names` already
 * captured — the same class of bug round 4's `stageLookup` transaction fix closed for
 * `evaluateStageLookup`'s own reads (see that function's own comment). Wrapping HERE, inside
 * `liveStageIndex` itself, means every caller inherits the fix for free — the standalone
 * `stageLookup`'s miss path, `MonetCore.prewarm()`/`agent_context` (via `PrewarmState.stageIndex`),
 * and `evaluateStageLookup`'s own miss branch — none of them has to remember to wrap this call
 * itself. better-sqlite3's `transaction()` NESTS SAFELY via a SAVEPOINT when called from inside an
 * already-open transaction (e.g. `evaluateStageLookup`'s own read transaction, from round 4's
 * `stageLookup` fix, or `MonetCore.stageLookup()`'s), so this is safe to call unconditionally —
 * standalone or nested, never a double-BEGIN.
 *
 * `assertQueryableCircle` GUARDED HERE TOO (post-merge review round, P2 — the SAME "guard once,
 * every caller inherits it" principle the paragraph above already states for the transaction fix,
 * applied to a DIFFERENT bug this function shares with `gateStats`). `liveStageNamesCapped`/
 * `countLiveStages` (below) both embed `RULE_LIVENESS_WHERE` directly — the identical collapsed-OR
 * predicate (`assertQueryableCircle`'s own doc comment) that degenerates to "global rules only" the
 * instant `circle` itself is `'*'`. `evaluateStageLookup`'s own call into this function was already
 * safe (guarded at ITS OWN entrance) — but `MonetCore.prewarm()` reaches this function after only
 * `resolveCircle` (which, by design — see `assertQueryableCircle`'s own comment — passes an explicit
 * `'*'` straight through unchanged). An unguarded `prewarm('*')` therefore silently returned a stage
 * index missing every stage whose only live rule was purely LOCAL — the exact "curation silently
 * omits" failure class `gateStats`' own fix (this same round) closes one surface over. Guarded here,
 * not at `prewarm()`'s own entrance, for the identical reason the transaction wrap above is here and
 * not duplicated at every caller.
 */
export function liveStageIndex(db: StoragePort, circle: string): LiveStageIndexResult {
  assertQueryableCircle(circle);
  return db.transaction((): LiveStageIndexResult => {
    const capped = liveStageNamesCapped(db, circle, STAGE_INDEX_CAP + 1);
    if (capped.length <= STAGE_INDEX_CAP) return { names: capped };
    return { names: capped.slice(0, STAGE_INDEX_CAP), total: countLiveStages(db, circle) };
  })();
}

// ---- the recognized matcher (stageLookup) ------------------------------------

/**
 * THE RECOGNIZED MATCHER, as a pure read — see `evaluateGate`'s own comment for why the read and
 * the write are split (a deferred read transaction upgrading to a write one can be refused with
 * SQLITE_BUSY; splitting them means the worst case is a lost instrumentation row, never a failed
 * lookup). The agent NAMES a stage, so unlike gateInternal one lookup can resolve to at most one
 * stage — there is no trigger-pattern fan-out here, and therefore no `stages`/`matchedStageIds`
 * plural to track.
 */
export function evaluateStageLookup(
  db: StoragePort,
  opts: StageLookupOptions,
): { result: StageLookupResult; pending: PendingGateWrites | null } {
  assertQueryableCircle(opts.circle);
  const startedAt = typeof process !== "undefined" && process.hrtime ? process.hrtime.bigint() : null;
  const now = opts.now ?? Date.now();
  const record = opts.record !== false;
  const stage = findStage(db, opts.stage);

  if (!stage) {
    // THE MISS CARRIES THE LIVE INDEX, unconditionally — this is part of the READ result (so a
    // misremembered name self-repairs in one round trip), not the instrumentation, so it is
    // computed whether or not `record` asked for a gate_events row.
    const stageIndexResult = liveStageIndex(db, opts.circle);
    const result: StageLookupResult = {
      matched: false, stage: null, rules: [],
      stageIndex: stageIndexResult.names,
      ...(stageIndexResult.total !== undefined ? { stageIndexTotal: stageIndexResult.total } : {}),
    };
    return {
      result,
      pending: record
        ? {
            // ATTEMPTED RECOGNITIONS ARE THE NUMERATOR a future recognition-rate (scanner-slice)
            // measure needs, and a miss recorded nowhere would silently drop out of that count —
            // so a miss is recorded exactly like a hit, action_context = the name actually asked.
            actionContext: opts.stage, circle: opts.circle, now, overflow: false,
            latencyUs: elapsedUs(startedAt), matchedStageIds: [], verifyStageIds: [],
            primaryStageId: null, ruleCount: 0, maxSeverity: null, matcher: "recognized",
          }
        : null,
    };
  }

  // SAME CHOKEPOINT SEMANTICS AS gateQuery: liveness, circle, model-tag filter, parent principle —
  // rulesForStages is the one query both matchers deliver through. withBody: true — this is the
  // ONLY caller that needs it, because toStageLookupRule is the only mapper that reads it (the
  // capability invocation payload).
  //
  // SQL-LEVEL BOUNDS (review fix — Codex round 2, extended round 3 to `reason`): the primary fetch
  // caps how many rows come back (STAGE_LOOKUP_RULES_CAP, +1 as a cheap "were there more" probe —
  // see that constant's own comment), how much of `body` each row carries (STAGE_LOOKUP_BODY_CAP,
  // +1 for the same reason), and now how much of `reason` each row carries too
  // (STAGE_LOOKUP_REASON_CAP, +1 — reason has no write-time length bound of its own, so it was the
  // residual axis a persisted giant reason could still use to defeat the row/body caps).
  // Materializing every live rule's FULL body/reason server-side, for an unbounded rule count, was
  // exactly the always-on retrieval cost this closes — the wire only ever shows a bounded prefix
  // on any axis anyway, and nothing upstream of this call needs the untruncated whole.
  const primaryRows = rulesForStages(
    db, [stage.id], opts.circle, opts.runtimeModelTag, true,
    STAGE_LOOKUP_RULES_CAP + 1, STAGE_LOOKUP_BODY_CAP + 1, STAGE_LOOKUP_REASON_CAP + 1,
    // The lookup path pays for the disputed-parent ids (PR #112 round 8); the mechanical gate
    // carries the flag alone — see rulesForStages' own column comment for the split.
    true,
  );
  const capped = primaryRows.length > STAGE_LOOKUP_RULES_CAP;
  const shownRows = capped ? primaryRows.slice(0, STAGE_LOOKUP_RULES_CAP) : primaryRows;
  const rules = shownRows.map(toStageLookupRule);

  // Only when the primary fetch actually hit the cap: an EXACT total (one indexed COUNT(*), a cost
  // paid only in this — expected rare — case) and a compact outline of the rules the primary fetch
  // never retrieved at all, so the wire's recovery ladder can still name them (see
  // StageLookupResult's own comment on `rulesTotal`/`rulesOutline` for why `rules.length` alone can
  // no longer be trusted as "the whole truth" once retrieval itself is bounded).
  const rulesTotal = capped ? countLiveRulesForStage(db, stage.id, opts.circle, opts.runtimeModelTag) : undefined;
  const rulesOutline = capped
    ? ruleOutlineForStage(db, stage.id, opts.circle, opts.runtimeModelTag, STAGE_LOOKUP_RULES_CAP, STAGE_LOOKUP_OUTLINE_CAP)
    : undefined;

  const result: StageLookupResult = {
    matched: true,
    stage: { id: stage.id, name: stage.name },
    rules,
    ...(rulesTotal !== undefined ? { rulesTotal } : {}),
    ...(rulesOutline !== undefined ? { rulesOutline } : {}),
  };
  return {
    result,
    pending: record
      ? {
          actionContext: opts.stage, circle: opts.circle, now, overflow: false,
          latencyUs: elapsedUs(startedAt),
          // A NAME lookup proves nothing about trigger-PATTERN realism, so unlike gateInternal this
          // never populates verifyStageIds — `verified` stays exactly what it has always meant:
          // this pattern matched a real intercepted action, not merely a name a human typed back.
          matchedStageIds: [], verifyStageIds: [],
          primaryStageId: stage.id,
          // HONEST INSTRUMENTATION: the true rule count when retrieval was capped, not the
          // (possibly much smaller) length of what was actually fetched.
          ruleCount: rulesTotal ?? rules.length,
          maxSeverity: rules.some((rule) => rule.severity === "blocking") ? "blocking" : rules.length > 0 ? "advisory" : null,
          matcher: "recognized",
        }
      : null,
  };
}

/**
 * THE RECOGNIZED MATCHER. The agent NAMES a stage — no trigger-pattern matching, no fuzzy or
 * embedding search: recognition is the agent's own act against the resident stage index, and this
 * is a lookup against it. Delivers through the SAME chokepoint semantics as gateQuery (liveness,
 * circle scope, model-tag filtering, parent principle) plus the one payload gateQuery never
 * carries: each rule's `body`, the capability invocation, spent here because this is agent-
 * initiated pull at the moment of need rather than an always-on injection.
 *
 * ADVISORY-ONLY BY DESIGN: severity is delivered as information — a blocking rule appears with its
 * reason, exactly like an advisory one — and never enforced here. The deny tier stays on the
 * mechanical gate; nothing about calling this can refuse an action.
 *
 * A stage with zero live rules is a HIT with `rules: []` (the stage-hit-no-rules signal — see
 * GateResult.silence for why this is never conflated with a miss). A miss (no such stage) carries
 * the live stage index so a misremembered name self-repairs in one round trip. Every call — hit or
 * miss alike — records one gate_events row with matcher='recognized'; a miss records
 * matched_stage_id NULL and action_context = the name actually asked, because attempted
 * recognitions are the numerator a recognition-rate measure needs and a silently-dropped miss
 * would corrupt exactly that count.
 *
 * The standalone form — evaluateStageLookup + commitGateWrites in one call, for a caller with no
 * transaction of its own (same relationship gateQuery has to evaluateGate/commitGateWrites).
 * MonetCore.stageLookup() uses the split form directly, for the same reason MonetCore.gate() does.
 *
 * TRANSACTION-WRAPPED, mirroring MonetCore.stageLookup() (engine.ts) EXACTLY (review fix — Codex
 * round 4, item 3): that method wraps its own call to `evaluateStageLookup` in
 * `this.db.transaction(...)()` — a single consistent read view — and only THEN, separately,
 * `commitGateWrites` in its own `this.db.immediateTransaction(...)()`, inside a try/catch that
 * swallows the write's failure (see MonetCore.gate()'s own comment for why: a deferred read
 * transaction upgrading to a write one can be refused with SQLITE_BUSY, and losing one
 * instrumentation row is the acceptable side of that trade — losing a verdict is not). Before this
 * fix, THIS function — the one path a caller with no transaction of its own actually runs — issued
 * `evaluateStageLookup`'s several reads (findStage, then rulesForStages, then — only when capped —
 * countLiveRulesForStage/ruleOutlineForStage, or on a miss liveStageNamesCapped/countLiveStages) as
 * separate, unwrapped statements. A concurrent writer (the SUPPORTED MCP+CLI topology storage.ts's
 * WAL+busy_timeout setup exists for) landing a rule bind/retire BETWEEN two of those reads could
 * make `rulesTotal`/`rulesOutline`/`stageIndexTotal` describe a DIFFERENT instant than the
 * `rules`/`stageIndex` prefix already returned — an honest-looking total for a snapshot that never
 * existed. Same split as the engine method, same swallow-on-write-failure, just constructed here
 * instead of on `this.db`.
 */
export function stageLookup(db: StoragePort, opts: StageLookupOptions): StageLookupResult {
  const { result, pending } = db.transaction(() => evaluateStageLookup(db, opts))();
  if (pending) {
    try {
      db.immediateTransaction(() => commitGateWrites(db, pending, opts.nextSyncTimestamp))();
    } catch {
      // Instrumentation only. Deliberately swallowed — see this function's own comment above.
    }
  }
  return result;
}

// ---- instrumentation readback -----------------------------------------------

/**
 * The design's own acceptance evidence for gates: "fire precision and silence rate". This is the
 * readback, shaped exactly like ResolutionStats (windowed counts plus an all-time total that says
 * whether the window is representative) so the two read as one instrument in curation.
 *
 * `unverifiedPatterns` is deliberately STORE-GLOBAL rather than circle-scoped, unlike the counts: a
 * stage is a registry entry with no circle, and "this pattern has never matched anything anywhere"
 * is the question a dead pattern needs asked of it.
 *
 * EVERY FIELD BELOW EXCEPT `byMatcher` IS SCOPED TO THE MECHANICAL MATCHER — additive, not a
 * restructure: `fires`/`silences`/`delivered`/`byStage` and the rest were "fire precision and
 * silence rate" for gateQuery before stageLookup existed, and a recognized lookup's `matched` is a
 * different verdict over a different population (an agent naming a stage, not an intercepted
 * action — see stageLookup's own doc comment). Blending the two would silently change what these
 * numbers have always meant the moment stageLookup starts getting called, which is exactly the
 * kind of drift "additive only" is meant to rule out. `byMatcher` is the one new field, and the one
 * place a reader sees recognized activity at all.
 */
export interface GateStats {
  windowDays: number;
  /** Queries in the window where at least one stage matched. */
  fires: number;
  /**
   * Queries in the window where nothing matched — the agent was off the map.
   *
   * EXCLUDES OVERFLOWS. Deriving silence as "not a fire" folded the refusals in, so the
   * confident-silence rate the design's validation checks read was inflated by exactly the queries
   * where nothing was confident about anything.
   */
  silences: number;
  /** Queries refused as past the size threshold. Not silence: nobody looked. */
  overflows: number;
  /** Fires that delivered at least one rule. `fires - delivered` is the projection-hook population. */
  delivered: number;
  windowTotal: number;
  /** All-time query count for this circle: says whether the window is representative. */
  total: number;
  /** Fires per stage in the window, biggest first. */
  byStage: Array<{ stageId: string; stageName: string; fires: number }>;
  /**
   * Counts per matcher in the window — 'mechanical' (gateQuery) vs 'recognized' (stageLookup). The
   * ONE field on this type that is NOT scoped to the mechanical matcher alone (see the interface's
   * own doc comment). Only matcher values that actually appear in the window are listed — no
   * zero-filled row for a matcher that never fired, same convention `byStage` already uses.
   */
  byMatcher: Array<{ matcher: GateMatcher; count: number }>;
  /** Stages whose patterns have never fired anywhere. Store-global; the dead-pattern watchlist. */
  unverifiedPatterns: Array<{ stageId: string; stageName: string; origin: StageOrigin; patterns: string[] }>;
  /**
   * Stages carrying at least one unreadable pattern. Those patterns are INERT — corruption narrows
   * a gate to nothing rather than widening it — so this is the only place a stage that has gone
   * quiet for that reason says so. Surfaced regardless of `verified`, because a stage can lose a
   * pattern to corruption long after proving the ones it had.
   */
  malformedPatterns: Array<{ stageId: string; stageName: string; malformed: number; readable: string[] }>;
  /**
   * Agent-scoped rules whose model tag is not the tag now running — "a new model retires the old
   * model's compensations automatically", surfaced for curation to act on.
   *
   * These are already excluded from delivery by gateQuery. They are NOT retired: retirement is a
   * decision about a stored memory, and a delivery filter that also deleted things would be a
   * scheduled-review mechanism wearing a gate's clothes. Empty when no runtime tag is supplied,
   * because without one there is nothing to be a candidate against.
   */
  retirementCandidates: Array<{ conceptId: string; title: string; modelTag: string; stageName: string }>;
  /** True number omitted after the source cap; absent when the list is complete. */
  retirementCandidatesOmitted?: number;
  /**
   * Live denies in this circle carrying no reason — see GateRule.reasonMissing for how one exists
   * at all (relay from an older peer; local creation is refused).
   *
   * LISTED, NOT COUNTED, and listed for a specific reason: this is a REPAIR QUEUE, and a repair
   * queue that cannot say what to repair is just an alarm. A count tells a reader the population is
   * not zero; these fields tell them what to type. `stageName` and `title` are exactly the `stage`
   * and `content` a repairing declaration takes, so the rendered line can name the rule instead of
   * sending somebody to go find it.
   *
   * A non-empty list is NOT an error state — the denies are live and doing their job. What is
   * missing is the sentence shown to whoever they stop, and only a human can supply it.
   *
   * Empty today and intended to stay that way, but the shape is the one it will need: the sync
   * surface is what makes this population reachable, and inheriting a count somebody has to widen
   * later is how a disclosure ends up narrower than the thing it discloses.
   */
  unexplainedDenies: Array<{ conceptId: string; title: string; stageName: string }>;
  /** True number omitted after the source cap; absent when the list is complete. */
  unexplainedDeniesOmitted?: number;
}

export interface GateStatsOptions {
  circle: string;
  windowDays: number;
  now?: number;
  /** The model now running. Rules tagged for a different one are reported as retirement candidates. */
  runtimeModelTag?: string;
  /** Optional curation-surface cap; omit for the full diagnostic lists used by CLI/dashboard consumers. */
  exceptionLimit?: number;
}

export function gateStats(db: StoragePort, opts: GateStatsOptions): GateStats {
  // ROUND-6'S OWN MISSED ENTRANCE (post-merge review round, P2). `retirementCandidates` and
  // `unexplainedDenies` (below) both embed `(b.circle = ? OR b.circle = '${BREADTH_CIRCLE}')` —
  // RULE_LIVENESS_WHERE's own collapsed-OR shape, restated inline at each — which degenerates to
  // "global rules only" the instant `opts.circle` itself is `'*'`, per `assertQueryableCircle`'s own
  // doc comment. Round 6 swept `gateInternal`/`evaluateStageLookup`/`evaluateGateFromMirror`, every
  // caller of `RULE_LIVENESS_WHERE` at the time — but `gateStats` was written with its own two
  // hand-rolled copies of the same predicate rather than the shared constant, so it never appeared
  // in that sweep's own search surface. An unguarded `gateStats('*')` silently reported ZERO local
  // retirement candidates and ZERO local unexplained denies for circle '*' — not an empty result
  // (nothing wrong), a WRONG one (curation blind to exactly the rules a human most needs to see).
  assertQueryableCircle(opts.circle);
  const now = opts.now ?? Date.now();
  const since = now - opts.windowDays * 24 * 60 * 60 * 1000;
  // MECHANICAL ONLY (see GateStats' own doc comment for why): a recognized lookup's `matched` is
  // not a "fire" in the sense this query has always measured, and letting it through would move
  // `windowTotal`/`total` off `fires + silences + overflows` — an invariant curation and tests
  // already rely on — without changing either constant's name.
  const window = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN matched_stage_id IS NOT NULL THEN 1 ELSE 0 END) AS fires,
         SUM(CASE WHEN rule_count > 0 THEN 1 ELSE 0 END) AS delivered,
         SUM(CASE WHEN overflow = 1 THEN 1 ELSE 0 END) AS overflows
       FROM gate_events WHERE circle = ? AND ts >= ? AND matcher = 'mechanical'`,
    )
    .get(opts.circle, since) as { total: number; fires: number | null; delivered: number | null; overflows: number | null };
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM gate_events WHERE circle = ? AND matcher = 'mechanical'`).get(opts.circle) as { n: number }).n;
  // Counted from EVERY matched stage, not from the one that answered. A broad stage that matches
  // constantly alongside a narrow deny would otherwise report zero fires — and a stage reporting
  // zero fires is exactly what curation reads as "dead, safe to remove". Mechanical-only with no
  // explicit filter needed: stageLookup never writes gate_event_stages (a recognized lookup
  // resolves to at most one stage, so matched_stage_id alone already carries it with no undercount
  // risk — see evaluateStageLookup's own comment), so this table is mechanical fires by construction.
  const byStage = db
    .prepare(
      `SELECT es.stage_id AS stageId, s.name AS stageName, COUNT(*) AS fires
         FROM gate_event_stages es
         JOIN gate_events g ON g.id = es.event_id
         JOIN stages s ON s.id = es.stage_id
        WHERE g.circle = ? AND g.ts >= ?
        GROUP BY es.stage_id, s.name
        ORDER BY fires DESC, stageName ASC`,
    )
    .all(opts.circle, since) as Array<{ stageId: string; stageName: string; fires: number }>;
  // THE ONE UNSCOPED QUERY — byMatcher's whole job is to break the window down BY matcher, so it
  // reads every row rather than pre-filtering to one.
  const byMatcher = db
    .prepare(
      `SELECT matcher, COUNT(*) AS count
         FROM gate_events
        WHERE circle = ? AND ts >= ?
        GROUP BY matcher
        ORDER BY matcher ASC`,
    )
    .all(opts.circle, since) as Array<{ matcher: GateMatcher; count: number }>;
  const unverified = db
    .prepare(`SELECT id, name, origin, trigger_patterns FROM stages WHERE verified = 0 ORDER BY created_at ASC, id ASC`)
    .all() as Array<{ id: string; name: string; origin: StageOrigin; trigger_patterns: string }>;
  const malformedPatterns: GateStats["malformedPatterns"] = [];
  for (const stage of db
    .prepare(`SELECT id, name, trigger_patterns FROM stages ORDER BY created_at ASC, id ASC`)
    .all() as Array<{ id: string; name: string; trigger_patterns: string }>) {
    const read = readTriggerPatterns(stage.trigger_patterns);
    if (read.malformed > 0) {
      malformedPatterns.push({
        stageId: stage.id,
        stageName: stage.name,
        malformed: read.malformed,
        readable: read.patterns.map(formatTriggerPattern),
      });
    }
  }

  const exceptionLimit = opts.exceptionLimit === undefined
    ? undefined
    : Math.max(0, Math.floor(opts.exceptionLimit));
  const retirementCandidatesAll = opts.runtimeModelTag === undefined ? [] : (db
    .prepare(
      `SELECT b.concept_id AS conceptId, c.title AS title, b.model_tag AS modelTag, s.name AS stageName
         FROM rule_bindings b
         JOIN concepts c ON c.id = b.concept_id
         LEFT JOIN stages s ON s.id = b.stage_id
        WHERE b.scope = 'agent' AND b.model_tag IS NOT ? AND (b.circle = ? OR b.circle = '${BREADTH_CIRCLE}')
          AND c.status = 'active' AND c.kind = 'rule'
          AND NOT EXISTS (
            SELECT 1 FROM lifecycle_edges e
             WHERE e.family = 'supersession' AND e.src_concept_id = b.concept_id
          )
        ORDER BY b.model_tag ASC, c.title ASC, b.concept_id ASC
        ${exceptionLimit !== undefined ? "LIMIT ?" : ""}`,
    )
    .all(...(exceptionLimit !== undefined
      ? [opts.runtimeModelTag, opts.circle, exceptionLimit + 1]
      : [opts.runtimeModelTag, opts.circle])) as GateStats["retirementCandidates"]);
  const retirementCandidates = exceptionLimit === undefined
    ? retirementCandidatesAll
    : retirementCandidatesAll.slice(0, exceptionLimit);
  const retirementCandidatesOmitted = exceptionLimit !== undefined && retirementCandidatesAll.length > exceptionLimit
    ? (db.prepare(
        `SELECT COUNT(*) AS n
           FROM rule_bindings b
           JOIN concepts c ON c.id = b.concept_id
          WHERE b.scope = 'agent' AND b.model_tag IS NOT ? AND (b.circle = ? OR b.circle = '${BREADTH_CIRCLE}')
            AND c.status = 'active' AND c.kind = 'rule'
            AND NOT EXISTS (
              SELECT 1 FROM lifecycle_edges e
               WHERE e.family = 'supersession' AND e.src_concept_id = b.concept_id
            )`,
      ).get(opts.runtimeModelTag, opts.circle) as { n: number }).n - retirementCandidates.length
    : 0;
  const unexplainedDeniesAll = (db
    .prepare(
      `SELECT b.concept_id AS conceptId, c.title AS title, s.name AS stageName, b.reason AS reason
         FROM rule_bindings b
         JOIN concepts c ON c.id = b.concept_id
         JOIN stages s ON s.id = b.stage_id
        WHERE b.severity = 'blocking'
          AND (b.circle = ? OR b.circle = '${BREADTH_CIRCLE}')
          AND c.status = 'active'
          AND c.kind = 'rule'
          AND NOT EXISTS (
            SELECT 1 FROM lifecycle_edges e
             WHERE e.family = 'supersession' AND e.src_concept_id = b.concept_id
          )
        ORDER BY s.name ASC, c.title ASC, b.concept_id ASC`,
    )
    .all(opts.circle) as Array<GateStats["unexplainedDenies"][number] & { reason: string | null }>)
    .filter((row) => hasNoReason(row.reason))
    .map(({ conceptId, title, stageName }) => ({ conceptId, title, stageName }));
  const unexplainedDenies = exceptionLimit === undefined
    ? unexplainedDeniesAll
    : unexplainedDeniesAll.slice(0, exceptionLimit);
  const fires = window.fires ?? 0;
  const overflows = window.overflows ?? 0;
  return {
    windowDays: opts.windowDays,
    fires,
    silences: window.total - fires - overflows,
    overflows,
    delivered: window.delivered ?? 0,
    windowTotal: window.total,
    total,
    byStage,
    byMatcher,
    unverifiedPatterns: unverified.map((stage) => ({
      stageId: stage.id,
      stageName: stage.name,
      origin: stage.origin,
      patterns: parseTriggerPatterns(stage.trigger_patterns).map(formatTriggerPattern),
    })),
    malformedPatterns,
    retirementCandidates,
    ...(retirementCandidatesOmitted > 0 ? { retirementCandidatesOmitted } : {}),
    // Deliberately NOT filtered by runtime model tag: a compensation for another model still holds
    // deny power the moment that model runs, and a count that hid it would report zero on exactly
    // the machine best placed to repair it. Same liveness predicate the gate and the sidecar use.
    // THE PREDICATE IS NOT IN THE SQL, on purpose. It was, as `TRIM(b.reason) = ''` — and SQLite's
    // one-argument TRIM strips ORDINARY SPACES ONLY, while `hasNoReason` uses JS trim() and catches
    // tabs and newlines. A peer relaying "\t\n" therefore produced `reasonMissing: true` on the
    // delivered rule and on the sidecar entry while this list stayed EMPTY and the overview's repair
    // section stayed suppressed: a bare deny firing with nothing telling the human it exists. That
    // is exactly the cross-surface disagreement `hasNoReason` was introduced to prevent, reappearing
    // in the one surface that had not been made to share it.
    //
    // So SQL narrows to the live denies and TypeScript asks the question — ONE implementation, no
    // equivalence to maintain between two dialects' idea of whitespace. The scan is bounded by the
    // blocking population, which is the same set materializeGateMirror already walks (as a subset of
    // every live rule) on every declaration, so this is not a new order of work.
    unexplainedDenies,
    ...(unexplainedDeniesAll.length > unexplainedDenies.length
      ? { unexplainedDeniesOmitted: unexplainedDeniesAll.length - unexplainedDenies.length }
      : {}),
  };
}

// ---- the gate mirror ---------------------------------------------------------

/**
 * One live rule as the offline evaluator reads it — the same projection the live gate delivers
 * (see `toGateRule`), minus the body (hook injection is title+reason by budget; a rule's body is the
 * recognized surface's own pull, `stage_lookup`'s alone — see StageLookupRule) and minus
 * `parentDisputed` (live status, deliberately not frozen — see `evaluateGateFromMirror`).
 *
 * NO `stageName`/`patterns` here: those live once each on the stage's own record (`GateMirrorStage`
 * below) rather than repeated on every rule bound to it — a stage with ten rules used to carry its
 * patterns ten times over. NO `reasonMissing`: computed at read time via `hasNoReason`, the same
 * one predicate `toGateRule` uses, rather than persisted and risking drift from it. NO `declaredBy`:
 * dropped along with everything else `GateRule` itself never delivers — this projection's whole
 * promise is "the same projection the live gate delivers", and `declaredBy` was never part of that.
 */
export interface GateMirrorEntry {
  conceptId: string;
  /** Which stage this rule is bound to — join against `GateMirror.stages` to match and to render. */
  stageId: string;
  severity: RuleSeverity;
  /**
   * THE OFFLINE EVALUATOR MUST APPLY THE SAME FILTER THE LIVE GATE DOES, and `scope` + `modelTag`
   * are what let it. `gateQuery` delivers an `agent`-scoped rule only when the runtime's model tag
   * equals `modelTag` (see GateQueryOptions.runtimeModelTag); a mirror that omitted either made that
   * impossible offline, so a compensation for a retired model kept firing whenever the server was
   * unreachable — live and offline disagreeing exactly when the disagreement is hardest to notice.
   *
   * The rule for a reader: `scope === "domain"` always applies; `scope === "agent"` applies only
   * when the running model's tag equals `modelTag`. `circle` below is the rule's locality, and the
   * live gate matches it against the invoking one — the evaluator must too.
   */
  scope: RuleScope;
  modelTag: string | null;
  reason: string | null;
  /** The rule itself — the concept's title. Same field name as `GateRule.text`, never the body. */
  text: string;
  origin: RuleBindingOrigin;
  /**
   * NEVER NULL, deliberately narrower than the column it reads from (review fix — minor m1):
   * `rule_bindings.circle` briefly holds NULL for a dangling binding whose concept has not arrived
   * yet (the dangling-then-live gap), but such a row cannot deliver — RULE_LIVENESS_WHERE's
   * `b.circle = ?` never matches NULL, and neither does this evaluator's own filter — so it is not a
   * "rule with an unknown locality," it is not a live rule at all yet. `listGateMirrorEntries`
   * excludes it at the query rather than admitting `string | null` here and pushing the "what does a
   * null circle mean" question onto every reader. BLOCKER B3 closes the gap early (resolved the
   * moment the concept lands, same transaction), and the schema migration backfill closes it on
   * every store's next open regardless — so in steady state this column is never seen NULL by a
   * mirror written after this slice; the exclusion is a floor under that transient window, not a
   * routine filter.
   */
  circle: string;
  /**
   * THE PARENT PRINCIPLE (slice 5-B, D4) — closes the parity gap `evaluateGateFromMirror`'s own
   * comment recorded and assigned to "whichever later slice ships the mirror's projection-aware
   * write path". Same correlated pick the live path uses (`rulesForStages`), so the offline answer
   * carries the same "derived from principle P" provenance a live fire announces.
   *
   * OPTIONAL, OMIT-WHEN-ABSENT, AND NO FORMAT BUMP. `GATE_MIRROR_FORMAT` is bumped when an entry's
   * shape change could make a reader answer WRONGLY about whether a rule applies (v2's scope/
   * modelTag, v4's both-severities widening are both exactly that). This field decides nothing: it
   * is disclosure carried beside a verdict the reader reaches without it, so a v4 file written
   * before this slice — with no `projectedFromPrincipleId` on any entry — parses and evaluates
   * IDENTICALLY under this build, and a v4 file written after it is read correctly by an older
   * build that simply ignores the key. Bumping would have refused both directions to gain nothing.
   *
   * THE COST OF NOT BUMPING, stated rather than left to be discovered: `inspectSidecar` decides
   * staleness on identity + format + generation, never on content, so an install that upgrades to
   * this build with a mirror already at the current generation keeps that (parentless) file until
   * the next gate-relevant write regenerates it. Accepted — the field is disclosure, so a mirror
   * missing it answers every verdict identically; a format bump would instead have made that same
   * file REFUSED, taking the whole offline gate down for the sake of an annotation.
   */
  projectedFromPrincipleId?: string;
}

/**
 * Bumped whenever an entry's SHAPE changes, so a reader can refuse a file it does not understand
 * rather than silently ignoring a field that decides whether a deny applies. Version 2 added
 * `scope` + `modelTag`; a version-1 file omits them and must not be trusted to filter. Version 3
 * added `reasonMissing` (computed, not persisted, as of version 4 — see GateMirrorEntry's own
 * comment for why).
 *
 * VERSION 4 (slice 4b-B, 2026-07-28) is the artifact ceasing to be blocking-only: `entries` now
 * carries every LIVE rule, both severities, and the mirror gained `stages` (the full stage
 * registry, trigger patterns included — the projection-hook signal, "a stage matched and delivered
 * nothing", cannot exist offline without knowing about rule-less stages too), `circleAliases` and
 * `circles` (what a `--circle` resolver needs without touching the store). A v3 reader pointed at a
 * v4 file would read `entries` as blocking-only and MISS every advisory rule silently — a wider
 * failure than v3's own bump closed, which is exactly why this earns the same kind of refusal
 * rather than a lenient partial read.
 */
export const GATE_MIRROR_FORMAT = 4;

/**
 * One stage as the offline evaluator reads it — everything `matchesTriggerPattern` needs, and
 * nothing `verified`/`origin` add, since a read-only evaluator never flips or reports on either.
 *
 * NO `circle`: stages are store-global and carry no circle column (see GATE_SCHEMA_SQL's own "WHY
 * STAGES ARE STORE-GLOBAL AND CARRY NO CIRCLE" note) — locality lives entirely on the rule side
 * (GateMirrorEntry.circle), so a stage record has none to mirror.
 */
export interface GateMirrorStage {
  id: string;
  name: string;
  /**
   * RAW JSON, the exact `stages.trigger_patterns` column — not the parsed `TriggerPattern[]` form —
   * so the one parse chokepoint (`parseTriggerPatterns`) stays single: the evaluator calls it
   * verbatim, the same function `gateInternal` calls, rather than this module shipping a second
   * reader that could drift from it (a stage whose patterns fail to parse goes quiet the same
   * tolerant way on both paths — see `parseTriggerPatterns`' own comment).
   */
  triggerPatterns: string;
}

/**
 * An active circle rename, exactly as `resolveCircle` follows it (`status = 'active'` only — an
 * archived alias is not a forwarding address). What a `--circle` resolver needs to canonicalize a
 * renamed circle without a store round trip.
 */
export interface GateMirrorCircleAlias {
  from: string;
  to: string;
}

export interface GateMirror {
  /** Shape version of `entries`/`stages` — see GATE_MIRROR_FORMAT. */
  format: number;
  generatedAt: number;
  /**
   * The gate-substrate generation this mirror was built from. THE field that makes the artifact
   * verifiable: comparing it against `gateGeneration(db)` answers "is this snapshot current" with
   * no hashing and no guessing. A reader holding a file whose generation is behind knows it is
   * holding a stale answer, which is the difference between failing loudly and answering wrongly.
   */
  generation: number;
  /** Which store produced this mirror — so a reader can notice it is reading someone else's. */
  storeIdentity?: string;
  /** Every live rule, both severities — the same projection the live gate delivers. */
  entries: GateMirrorEntry[];
  /**
   * The full stage registry — every stage, not only ones with a live rule bound (a rule-less stage
   * still MATCHES and still answers stage-hit-no-rules, never silence; see GateResult.silence).
   */
  stages: GateMirrorStage[];
  /** Active circle renames only — see GateMirrorCircleAlias. */
  circleAliases: GateMirrorCircleAlias[];
  /**
   * Every circle name this mirror has an opinion about: a circle carrying a live rule, plus every
   * `from`/`to` name `circle_aliases` mentions (so an archived or renamed-away circle is still
   * "known", not silently absent). NOT a general circle registry — the store keeps none (see
   * `listCircles`, engine.ts, which derives its own top-N-by-activity view from `concepts` rather
   * than reading a dedicated table) — this is deliberately narrower: only what the gate
   * materializer itself already walked, per the ruling not to invent a mapping the store has no
   * source for.
   *
   * WRITE-ONLY as of this slice (minor m4): nothing in this codebase reads it back yet. Its consumer
   * is the offline CLI's `--circle` resolver, slice 4b-C, not yet built — this field exists now so
   * that CLI can ship without a mirror-format bump of its own.
   */
  circles: string[];
  /**
   * sha256, hex, over the canonical JSON serialization of every OTHER field on this object — see
   * `materializeGateMirror`'s own comment for the exact recipe. Closes the validation-depth category
   * (Codex round 12, item 1): the shape checks in `readSidecarHeader` catch a wrong TYPE or a missing
   * ARRAY, but a single flipped byte inside an otherwise well-typed string (a rule's title, a
   * reason) passes every one of them silently — this is the field that actually detects it.
   *
   * ADDITIVE, NOT A FORMAT BUMP: optional, not required — `readSidecarHeader` verifies it WHEN
   * PRESENT and skips verification entirely when absent, so a pre-checksum v4 file (a dev-window
   * artifact from before this field existed) still reads exactly as it always has. Every file this
   * build's own `materializeGateMirror` writes from now on carries one.
   */
  checksum?: string;
}

/** Why a mirror is (or is not) current. `missing` and `unreadable` are both stale — see below. */
export type SidecarStaleness =
  | { stale: false; generation: number }
  | {
      stale: true;
      /**
       * `foreign` = written by a different store; its generation number means nothing here.
       *
       * `format` / `format-ahead` = this build cannot read the file's entry shape. Two reasons
       * rather than one because they ask the OPERATOR for different things: `format` is a file an
       * older build left behind, which the next materialize rewrites on its own; `format-ahead` is
       * a file a NEWER build wrote, which this build deliberately will not touch — the fix there is
       * to upgrade this install, and nothing that happens here will produce it.
       */
      reason: "missing" | "malformed" | "behind" | "foreign" | "format" | "format-ahead";
      fileGeneration: number | null;
      generation: number;
      /** Present on `foreign`: who wrote the file, and who this store is. */
      fileStoreIdentity?: string | null;
      storeIdentity?: string;
      /** Present on the format reasons: the file's shape version, and the one this build speaks. */
      fileFormat?: number | null;
      format?: number;
    };

/**
 * Is the mirror at `path` current?
 *
 * A MISSING OR UNREADABLE FILE IS STALE, not an error and not "fine". The hook's question is "can I
 * trust this to decide a deny", and the answer for a file that is not there is no. Reporting it as
 * stale rather than throwing lets the caller take the documented path — advisory gates fail open
 * loudly, and a blocking gate with no readable mirror says so — instead of handling an exception on
 * the critical path of somebody's action.
 */
/**
 * Does this `entries[]` element have the shape `evaluateGateFromMirror`'s own filter and mapper
 * actually dereference (Codex round 5, item 1), AND — for the two fields the evaluator BRANCHES on
 * where a wrong-but-well-typed value silently changes the verdict rather than crashing — does it
 * hold one of the VALUES that logic actually distinguishes (Codex round 9, item 4)?
 * `Array.isArray(header.entries)` alone passed `entries: [null]` clean through — the array IS an
 * array — and the crash lands one layer down, on the FIRST read of any element:
 * `mirror.entries.filter((entry) => matchedStageIds.has(entry.stageId) && ...)` dereferences
 * `entry.stageId` unconditionally, so `entry === null` throws "Cannot read properties of null"
 * before the filter predicate's own logic ever runs.
 *
 * TWO DEPTHS, DELIBERATELY DIFFERENT SCOPE, both live in this one function:
 *   - SHAPE (round 5): `conceptId`/`text` (passthrough display) and `stageId`/`circle` (the two
 *     filter keys) are required to be STRINGS — enough to keep the reader from crashing on the way
 *     to asking the store anything, never a semantic check (that authority stays with the store).
 *   - VALUE (round 9, item 4 — a PR finding, not self-discovered: "removing `scope` from an
 *     agent-scoped entry leaves the same-generation file classified as current, and
 *     `ruleTagIsLive(undefined, ...)` then treats that rule as domain-scoped and fires it for the
 *     wrong runtime model; an unrecognized severity can similarly make a cached deny appear
 *     non-blocking to consumers"): `severity` must be one of `RULE_SEVERITIES`, not merely a
 *     string — an unrecognized value does not crash `entry.severity === "blocking"`, it silently
 *     answers false, the exact "appears non-blocking" the finding names. `scope` must be one of
 *     `RULE_SCOPES` — newly checked here AT ALL, not merely compared — because `ruleTagIsLive`'s
 *     own `scope !== "agent"` short-circuits to true for ANY non-"agent" value, missing or
 *     malformed included, silently treating a corrupted agent-scoped rule as domain-scoped and
 *     firing it for every model rather than only the one it was compensating for — the PR finding's
 *     own worked example, verbatim.
 *
 * NOT EXTENDED TO `modelTag`, considered and rejected: unlike severity/scope, it has no closed
 * vocabulary to validate a VALUE against — any string is a legitimate model tag, a fact of the
 * deployment, not of this file. The only checkable thing about it is its TYPE (`string | null`),
 * which is the SHAPE layer's job (round 5), not this one's, and round 5 already deliberately
 * excluded it there too — a blanket "must be string" would reject a legitimate null and be WRONG,
 * not merely stricter; `modelTag === runtimeModelTag` cannot crash on any input regardless of type,
 * so a corrected "string or null" shape check would tighten nothing this round's own bar (silent
 * verdict change) cares about, only defend against a crash that was never reachable to begin with.
 * NOT EXTENDED TO `origin` either: the PR finding never named it, and it is compared with `===`
 * only, never branched into a vocabulary the way severity/scope are.
 *
 * CALLED ONLY INSIDE `readSidecarHeader`'s format-bounded block, NOT unconditionally alongside the
 * array-ness check — corrected within round 5 itself, disclosed in that round's report: entries
 * genuinely exists in every format, but a FUTURE format's entries can legitimately carry a
 * DIFFERENT shape this build has never heard of (the same reason stages/circleAliases' own element
 * checks are bounded), and this module's own existing "REFUSES to overwrite a mirror written by a
 * build AHEAD of this one" tests caught the unconditional version breaking that contract outright —
 * a format-ahead file's `entries` failed this shape check, so the whole header read as `malformed`
 * instead of `format-ahead`, and materializeGateMirror overwrote a file it must never touch. THE
 * SAME MALFORMED-HEADER CONSEQUENCE applies to round 9's own tightening: a mirror failing the new
 * severity/scope checks reads as `malformed`, exactly like a mirror failing the older shape checks
 * — no new plumbing, the existing chokepoint already does the right thing with a stricter predicate.
 */
function hasMirrorEntryShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.conceptId === "string" &&
    typeof entry.stageId === "string" &&
    RULE_SEVERITIES.includes(entry.severity as RuleSeverity) &&
    typeof entry.circle === "string" &&
    typeof entry.text === "string" &&
    RULE_SCOPES.includes(entry.scope as RuleScope)
  );
}

/**
 * Does this `stages[]` element have the shape `evaluateGateFromMirror`'s own matching loop
 * dereferences (Codex round 5, item 1)? `stage.triggerPatterns` is read unconditionally
 * (`parseTriggerPatterns(stage.triggerPatterns)`) before anything else about the stage is
 * consulted, so `stage === null` throws there first, identically to the entries case above.
 * `triggerPatterns` is required to be a STRING — the exact parameter type `parseTriggerPatterns`
 * itself declares (`json: string`) and the exact column shape `GateMirrorStage.triggerPatterns`'s
 * own comment documents ("the exact `stages.trigger_patterns` column... not the parsed form") —
 * not "whatever JSON.parse tolerates": `readTriggerPatterns`'s own try/catch already absorbs a
 * non-string value without throwing (JSON.parse coerces via ToString first), so a wrong-typed
 * `triggerPatterns` would not itself crash the evaluator — but it WOULD make that stage silently
 * carry zero usable patterns forever, an offline/live parity gap the mirror exists to prevent, not
 * merely a crash to avoid. Treating it as malformed routes it through the same regeneration path a
 * literal crash would, which is the more protective of the two available readings for a field the
 * evaluator only ever reads as `string`.
 */
function hasMirrorStageShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const stage = value as Record<string, unknown>;
  return typeof stage.id === "string" && typeof stage.name === "string" && typeof stage.triggerPatterns === "string";
}

/**
 * Does this `circleAliases[]` element have the shape `evaluateGateFromMirror`'s own alias-resolution
 * step dereferences (Codex round 5, item 1)? `mirror.circleAliases.find((row) => row.from ===
 * opts.circle)` reads `row.from` unconditionally, on every element, before any match is decided —
 * `row === null` throws there. Both fields are required strings, matching `GateMirrorCircleAlias`.
 */
function hasMirrorCircleAliasShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const alias = value as Record<string, unknown>;
  return typeof alias.from === "string" && typeof alias.to === "string";
}

/**
 * Read a sidecar file's header WITHOUT trusting its shape.
 *
 * `JSON.parse` succeeding says nothing about structure — `null`, `[]`, `"a string"` and
 * `{"generation": "seven"}` all parse. Reading fields off those and carrying on is how a
 * never-throw contract turns into a TypeError on the critical path of somebody's action, so every
 * field is checked before it is used and anything unrecognizable is reported rather than assumed.
 * Returns null when the file is not a sidecar this build understands.
 */
function readSidecarHeader(path: string): { generation: number; storeIdentity: string | null; format: number | null } | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const header = parsed as Record<string, unknown>;
  if (typeof header.generation !== "number" || !Number.isFinite(header.generation)) return null;
  // ARRAY-NESS ONLY, here — element SHAPE is checked below, bounded to formats this build actually
  // understands (Codex round 5, item 1 — corrected during that same round, disclosed in the report:
  // an EARLIER version of this fix checked entries' element shape unconditionally, right here,
  // reasoning that entries exists in every format so a malformed element is equally dangerous
  // regardless of which format wrote it. That reasoning missed the FORMAT-AHEAD case: a genuinely
  // newer build's `entries` shape can legitimately differ from this build's own `GateMirrorEntry` —
  // exactly parallel to why stages/circleAliases' own element checks are format-bounded below — and
  // the unconditional version broke the format-ahead preservation contract outright, caught by this
  // module's own existing "REFUSES to overwrite a mirror written by a build AHEAD of this one" tests.
  // `entries` still cannot be validated for ELEMENT shape here, unconditionally, for the identical
  // reason stages/circleAliases cannot: doing so would misclassify a legitimate newer-format file as
  // malformed and materializeGateMirror would overwrite it, the exact thrash format-ahead exists to
  // prevent.
  if (!Array.isArray(header.entries)) return null;
  // FORMAT IS A DISCRETE VERSION NUMBER, not a magnitude to interpolate — there is no meaning between
  // format 4 and format 5, so `4.5` is not "a number we can still compare", it is a corrupt header.
  // Left unchecked, a fractional value greater than GATE_MIRROR_FORMAT passed `typeof === "number"`
  // and read as a genuine future format: `format-ahead` in inspectSidecar, `skipped-format-ahead`
  // forever in materializeGateMirror — preserved on the promise of an upgrade that fixes nothing,
  // because no build, past or future, will ever actually write a fractional format. Rejecting the
  // whole header here (rather than coercing just this field to null) routes it through the SAME
  // `malformed` path as any other structurally-wrong file, in both consumers, from one place.
  if (typeof header.format === "number" && !Number.isInteger(header.format)) return null;
  // FORMAT 4 REQUIRES stages/circleAliases TOO — ONLY FOR FORMATS THIS BUILD ACTUALLY UNDERSTANDS
  // (review fix — Codex round 1, item 2; bounded in round 2, item 5). A header claiming format 4
  // but omitting either — or carrying a non-array in their place — is not a v4 file with two empty
  // sections, it is STRUCTURALLY WRONG: `{format:4, generation:n, entries:[]}` passed every check
  // above (a valid generation, entries genuinely an array, format genuinely an integer) and read as
  // CURRENT the moment its generation happened to match — inspectSidecar reported it trustworthy,
  // materializeGateMirror skipped rewriting an "already current" file, and evaluateGateFromMirror
  // then crashed the first time it iterated `mirror.stages` (undefined has no [Symbol.iterator]) —
  // the read-path-throw class. Routed through the SAME `null` (malformed) return as any other
  // structurally-wrong file, from this ONE parse chokepoint both inspectSidecar and
  // materializeGateMirror already share (each calls readSidecarHeader directly, never re-deriving
  // its own notion of "valid header") — so the two cannot independently drift: one reports
  // malformed, the other regenerates, for the identical file.
  //
  // BOUNDED to the closed range [4, GATE_MIRROR_FORMAT] (review fix — Codex round 2, item 5: round
  // 1's own `format >= 4` — no upper bound — applied this requirement to ANY number >= 4, INCLUDING
  // a future format this build has never heard of. A legitimate same-store v5 file that legitimately
  // restructured these fields would fail this check exactly like a truly corrupt one — MALFORMED,
  // not FORMAT-AHEAD — and materializeGateMirror would then OVERWRITE it: the exact thrash the
  // format-ahead machinery exists to prevent, broken by the very guard meant to strengthen it. For
  // `header.format > GATE_MIRROR_FORMAT`, this check is skipped entirely and the header returns with
  // only the fields every format has always carried (generation, storeIdentity, format) — the
  // MINIMAL STABLE SHAPE — letting inspectSidecar's own `format !== GATE_MIRROR_FORMAT` compare
  // (below) classify it `format-ahead` and preserve it untouched, exactly as an unknown format did
  // before this array requirement existed at all. Grows to whatever range this build's OWN
  // GATE_MIRROR_FORMAT actually covers as that constant advances — never wider than what this build
  // can itself validate.
  //
  // `circles` is deliberately NOT checked here: nothing in this codebase reads it back yet (see its
  // own "WRITE-ONLY as of this slice" comment on GateMirror.circles) — there is no reader for a
  // malformed one to crash today. Revisit this the same day something starts reading it.
  if (typeof header.format === "number" && header.format >= 4 && header.format <= GATE_MIRROR_FORMAT) {
    // THIS BLOCK IS THE LAST OF ITS KIND (Codex round 12, item 1 — closing the validation-depth
    // category, John's own ratification 2026-07-28). The shape checks below (element shape, then
    // entries⊆stages) and the checksum verification that follows them exist at genuinely DIFFERENT
    // depths, and the boundary between them is now fixed:
    //   - SHAPE/REFERENTIAL (below, unchanged) stays for CHEAP FAST-FAIL — a wrong type or a missing
    //     array is caught before spending a single hash computation on a file that was never going to
    //     parse into a usable mirror anyway — and for the ONE case checksum verification cannot cover
    //     at all: a file that predates the `checksum` field entirely (the dev-window case; see that
    //     field's own comment on `GateMirror`).
    //   - CORRUPTION — a byte flipped inside an otherwise well-typed, well-shaped value (a rule's
    //     title, a reason, any string these shape checks pass straight through) — is now the
    //     CHECKSUM's job, not this block's. No new per-field VALUE check should be added here going
    //     forward on the theory that it might catch a corrupted byte: it will not catch more than the
    //     checksum already does, at a fraction of the cost, and every one added here is one more
    //     shape a future reader has to hold in their head for protection the checksum already
    //     provides in full. A genuinely NEW structural/referential invariant (the entries⊆stages
    //     shape below, or its future siblings) is still exactly the right kind of addition; a NEW
    //     "is this string exactly what I expect" value check is not.
    //
    // ELEMENT SHAPE (Codex round 5, item 1), gated behind format >= 4 the same as the stages/
    // circleAliases array-ness check just below it always was: none of the three can be validated
    // for element shape outside a format range this build actually understands — see
    // hasMirrorEntryShape/hasMirrorStageShape/hasMirrorCircleAliasShape's own comments for exactly
    // which fields are checked and why. `entries` joins stages/circleAliases HERE, inside the bound,
    // rather than staying unconditional up at the array-ness check — see that check's own comment
    // for why the unconditional version broke the format-ahead contract and was corrected to this.
    if (!header.entries.every(hasMirrorEntryShape)) return null;
    if (!Array.isArray(header.stages) || !header.stages.every(hasMirrorStageShape)) return null;
    if (!Array.isArray(header.circleAliases) || !header.circleAliases.every(hasMirrorCircleAliasShape)) return null;
    // REFERENTIAL: entries⊆stages (Codex round 11, item 5, P2). `GateMirrorEntry.stageId`'s own
    // comment says it plainly: "join against `GateMirror.stages` to match and to render" —
    // evaluateGateFromMirror's own matching loop walks `mirror.stages` to decide which stage(s) a
    // query action hits, then reads `entries` for whichever bindings apply. An entry naming a
    // stageId absent from THIS SAME file's own `stages[]` can never be reached through that join —
    // not a crash (both are plain array scans; a miss is silence, not a throw) — but a rule the file
    // claims to carry that the offline evaluator can never actually deliver: unreachable the same way
    // a version-1 file's missing scope/modelTag once left a rule un-filterable, this time via a
    // dangling foreign key rather than a missing field.
    //
    // HOLDS BY CONSTRUCTION for any file THIS build's own materializeGateMirror writes:
    // listGateMirrorEntries' own SELECT does `JOIN stages s ON s.id = b.stage_id` (INNER, no columns
    // taken from it — see that join's own comment), so a stageId this build ever emits into `entries`
    // is guaranteed, at write time, to name a row listGateMirrorStages' own unconditional `SELECT id,
    // name, trigger_patterns FROM stages` would also have captured in the same materialization pass.
    // A violation here can only mean a file this build did NOT honestly write in one pass —
    // hand-edited, corrupted, or produced by a build with a since-fixed bug — exactly the class of
    // file this whole function exists to refuse rather than trust.
    //
    // CHECKED HERE, not folded into hasMirrorEntryShape: that function validates ONE element in
    // isolation (Array.prototype.every calls it per-entry, with no visibility into the rest of the
    // file), while this check is inherently CROSS-array — it needs `header.stages` already known to
    // be a well-shaped array, which the line above this one just established.
    const knownStageIds = new Set((header.stages as Array<{ id: string }>).map((stage) => stage.id));
    if (!(header.entries as Array<{ stageId: string }>).every((entry) => knownStageIds.has(entry.stageId))) {
      return null;
    }
    // THE CHECKSUM, VERIFY-IF-PRESENT (Codex round 12, item 1). Absent entirely on a pre-checksum v4
    // file (the dev-window case — see `GateMirror.checksum`'s own comment) — skipped, not treated as
    // a failure, so such a file keeps reading exactly as it always has, on the shape checks above
    // alone. Present on every file `materializeGateMirror` writes from now on, and verified here
    // against the IDENTICAL recipe that function's own comment documents: strip `checksum` off the
    // parsed header, re-serialize what remains with the same `JSON.stringify(_, null, 2)` call, sha256
    // it, hex-encode, compare. `JSON.parse` preserves a plain object's own key order from the source
    // text, so `{ checksum, ...rest }` recovers every OTHER field in the EXACT relative order the
    // write-side recipe built them in, regardless of where in the file `checksum` itself sat — the
    // recomputation reproduces the original `canonical` string byte for byte for any file this build
    // (or a future one following the same recipe) honestly wrote.
    //
    // BOUNDED TO THIS SAME format >= 4 && format <= GATE_MIRROR_FORMAT RANGE, not unconditional —
    // matching the array-ness and element-shape checks above for the identical reason: a genuinely
    // FUTURE format's own canonicalization (field order, added fields, a different recipe entirely)
    // is not something this build can know, and computing THIS build's own recipe over a file it
    // cannot otherwise validate risks a false mismatch on a file that is perfectly legitimate —
    // exactly the thrash the format-ahead preservation contract exists to prevent. A format-ahead
    // file's checksum, if it even has one shaped the way this build expects, is simply never checked
    // here; that build's own reader is the one positioned to verify it.
    //
    // MISMATCH → malformed (null) → regeneration, the SAME path every other structurally-wrong file
    // in this function already takes — inspectSidecar and materializeGateMirror's own compare-before-
    // replace both consume readSidecarHeader's return value with no notion of "checksum" at all, so
    // neither needed a single line changed for this to reach them: a corrupted existing file simply
    // reads as if it were not there, and gets overwritten on the next materialize like any other
    // malformed one.
    if (header.checksum !== undefined) {
      if (typeof header.checksum !== "string") return null;
      const { checksum, ...rest } = header;
      const recomputed = createHash("sha256").update(JSON.stringify(rest, null, 2), "utf8").digest("hex");
      if (recomputed !== checksum) return null;
    }
  }
  return {
    generation: header.generation,
    storeIdentity: typeof header.storeIdentity === "string" ? header.storeIdentity : null,
    format: typeof header.format === "number" ? header.format : null,
  };
}

export function inspectSidecar(db: StoragePort, path: string, storeIdentity?: string): SidecarStaleness {
  const generation = gateGeneration(db);
  let exists = true;
  try {
    readFileSync(path, "utf8");
  } catch {
    exists = false;
  }
  if (!exists) return { stale: true, reason: "missing", fileGeneration: null, generation };
  const header = readSidecarHeader(path);
  // Present but not a sidecar: unparseable JSON, or JSON of the wrong shape. Both are "I cannot
  // trust this to decide a deny", which is the only question the caller is asking.
  if (header === null) return { stale: true, reason: "malformed", fileGeneration: null, generation };
  const fileGeneration = header.generation;
  // IDENTITY BEFORE GENERATION. A generation is a count of THIS store's mutations, so comparing one
  // across stores compares nothing — and two stores land on the same small integer constantly. A
  // restored backup, a copied database, or a sidecar path reused by a second store would otherwise
  // read as fresh while carrying somebody else's deny set, which is the strongest possible version
  // of the stale-mirror failure: not a missing deny, a WRONG one.
  const fileStoreIdentity = header.storeIdentity;
  if (storeIdentity !== undefined && fileStoreIdentity !== storeIdentity) {
    return { stale: true, reason: "foreign", fileGeneration, generation, fileStoreIdentity, storeIdentity };
  }
  // SHAPE BEFORE VINTAGE, and after identity. The three checks narrow in the order a reader cares
  // about: whose file is this, can I read its entries, is it current. A file whose format is not
  // ours is stale WHATEVER its generation says — and that is the whole point, because the failure
  // this closes is the quiet one: bump the format, and a v2 file whose generation and identity
  // still match reported CURRENT, so an upgraded install kept serving a mirror its own hook would
  // reject. The version number existed to make that impossible and, unchecked here, caused it.
  //
  // `null` covers a v1 file that predates the field entirely; it is not ours either.
  if (header.format !== GATE_MIRROR_FORMAT) {
    const ahead = header.format !== null && header.format > GATE_MIRROR_FORMAT;
    return {
      stale: true,
      reason: ahead ? "format-ahead" : "format",
      fileGeneration, generation,
      fileFormat: header.format, format: GATE_MIRROR_FORMAT,
    };
  }
  // Strict inequality, not `<`: a file claiming a generation AHEAD of the store is also not a
  // mirror of this store, and treating it as current would let a stale deny set govern here.
  if (fileGeneration !== generation) return { stale: true, reason: "behind", fileGeneration, generation };
  return { stale: false, generation };
}

/**
 * Every live rule, both severities, in GATE-DELIVERY order — `(severity = 'blocking') DESC,
 * created_at ASC, concept_id ASC`, the EXACT `ORDER BY` `rulesForStages` uses (copied verbatim, not
 * re-derived, so the two cannot silently drift). That ordering choice is what lets
 * `evaluateGateFromMirror` be a plain FILTER rather than a filter-then-sort: a total order (severity,
 * then created_at, then the unique concept_id as tiebreak) restricted to any subset of rows is the
 * same relative sequence you would get sorting that subset alone, so filtering this globally-ordered
 * array down to one query's matched stages + live circle/tag scope reproduces `rulesForStages`' own
 * per-query order with no second sort and no need to carry `created_at` into the serialized entry at
 * all.
 *
 * STORE-WIDE ON PURPOSE — no circle, no model-tag scoping here, matching this function's v3
 * ancestor (`listBlockingRules`): those two axes are the READER's job (GateMirrorEntry's own
 * comment), because a mirror scoped to one circle or one tag at materialize time could not answer
 * for any other, and a store-wide file already does.
 */
export function listGateMirrorEntries(db: StoragePort): GateMirrorEntry[] {
  const rows = db
    .prepare(
      // b.circle, NOT c.circle: the mirror carries the BINDING's own locality — including the
      // breadth marker verbatim, when a rule is global — exactly what RULE_LIVENESS_WHERE checks
      // live. Selecting the concept's circle here would silently un-widen breadth in the one place
      // that most needs to carry it: an offline reader with no other source for "this rule is global".
      `SELECT b.concept_id, b.stage_id, b.severity, b.scope, b.model_tag, b.origin, b.reason,
              c.title, b.circle,
              -- THE SAME CORRELATED PICK THE LIVE PATH USES (slice 5-B, D4) — copied from
              -- rulesForStages verbatim (family, correlation column, ORDER BY, LIMIT) so the mirror
              -- and the live gate cannot name different parents for one rule. Deliberately NOT
              -- accompanied by the parent's STATUS: see evaluateGateFromMirror's own comment for
              -- why a frozen parentDisputed would lie.
              (SELECT p.src_concept_id FROM lifecycle_edges p
                WHERE p.family = 'derivation' AND p.dst_concept_id = b.concept_id
                ORDER BY p.created_at ASC, p.id ASC LIMIT 1) AS parent_concept_id
         FROM rule_bindings b
         JOIN concepts c ON c.id = b.concept_id
         -- INNER JOIN stages, no columns selected from it: a binding whose stage does not exist yet
         -- is ORPHANED — the dangling-then-live gap (an incremental graft can land a binding before
         -- its stage row) — and graftRows documents that such a binding NEVER FIRES. v3's
         -- listBlockingRules enforced exactly this via its own (then column-selecting) JOIN to
         -- stages; dropping the columns must not silently drop the existence check along with them,
         -- or an unfireable binding would appear in the mirror as a deliverable rule.
         JOIN stages s ON s.id = b.stage_id
        WHERE c.status = 'active'
          AND c.kind = 'rule'
          -- b.circle IS NOT NULL (review fix — minor m1): a dangling binding whose concept has not
          -- landed yet — see GateMirrorEntry.circle's own comment for why this is a floor under a
          -- transient window (BLOCKER B3), not a routine filter, and for why the type stays a plain
          -- string rather than admitting null.
          AND b.circle IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM lifecycle_edges e
             WHERE e.family = 'supersession' AND e.src_concept_id = b.concept_id
          )
        ORDER BY (b.severity = 'blocking') DESC, b.created_at ASC, b.concept_id ASC`,
    )
    .all() as Array<{
      concept_id: string; stage_id: string; severity: RuleSeverity; scope: RuleScope;
      model_tag: string | null; origin: RuleBindingOrigin; reason: string | null;
      title: string; circle: string; parent_concept_id: string | null;
    }>;
  return rows.map((row) => ({
    conceptId: row.concept_id,
    stageId: row.stage_id,
    severity: row.severity,
    scope: row.scope,
    modelTag: row.model_tag,
    // Same normalization as the live gate — and here it is also what keeps the file readable: a
    // Buffer would serialize into the mirror as {"type":"Buffer","data":[...]}, which a reader
    // would then have to parse around.
    reason: typeof row.reason === "string" ? row.reason : null,
    text: row.title,
    origin: row.origin,
    circle: row.circle,
    // OMITTED, never `null` — the serialized file's own budget discipline, and what makes an older
    // reader's "key absent" and this build's "no parent" the same thing on disk.
    ...(row.parent_concept_id !== null ? { projectedFromPrincipleId: row.parent_concept_id } : {}),
  }));
}

/**
 * Every stage in the registry — deliberately ALL of them, not only stages with a live rule bound.
 * Mirrors `listMatchableStages`' own reasoning exactly (every gate lookup reads every stage; "no
 * index can help, so keep the row cheap"): a rule-less stage still MATCHES and still answers
 * stage-hit-no-rules rather than silence, and that signal cannot exist offline unless the mirror
 * knows the rule-less stage exists at all.
 */
export function listGateMirrorStages(db: StoragePort): GateMirrorStage[] {
  const rows = db
    .prepare(`SELECT id, name, trigger_patterns FROM stages ORDER BY created_at ASC, id ASC`)
    .all() as Array<{ id: string; name: string; trigger_patterns: string }>;
  return rows.map((row) => ({ id: row.id, name: row.name, triggerPatterns: row.trigger_patterns }));
}

/**
 * `circleAliases` + `circles` for the mirror — see GateMirror's own comments for what each promises
 * and why `circles` stops at "what the materializer already walked" rather than a general registry.
 * Takes the already-materialized `entries` rather than re-querying: their `circle` field is the
 * first half of "known circles", and threading the array through costs nothing a second SELECT
 * would not (both are already resident, mid-transaction, in `materializeGateMirror`).
 */
function gateMirrorCircles(
  db: StoragePort,
  entries: readonly GateMirrorEntry[],
): { circleAliases: GateMirrorCircleAlias[]; circles: string[] } {
  const aliasRows = db
    .prepare(`SELECT from_name, to_name, status FROM circle_aliases`)
    .all() as Array<{ from_name: string; to_name: string; status: string }>;
  const circleAliases = aliasRows
    .filter((row) => row.status === "active")
    .map((row) => ({ from: row.from_name, to: row.to_name }));
  const circles = new Set<string>();
  // BREADTH_CIRCLE EXCLUDED, deliberately: `entries[].circle` can now be "*", and "*" is not a
  // circle a `--circle` resolver could ever be asked to resolve TO — it is a breadth marker on a
  // rule, not a selectable project. Including it here would offer it up as though it were an
  // ordinary (if odd-looking) circle name, the same confusion BREADTH_CIRCLE's own comment forbids
  // at every circle-minting surface.
  for (const entry of entries) if (entry.circle !== BREADTH_CIRCLE) circles.add(entry.circle);
  // BOTH statuses, unlike circleAliases above: an ARCHIVED circle is still a circle this store has
  // an opinion about (it is "known", just hidden) — only the RESOLUTION map (circleAliases) is
  // active-only, because that is exactly what `resolveCircle` itself follows.
  for (const row of aliasRows) {
    circles.add(row.from_name);
    circles.add(row.to_name);
  }
  return { circleAliases, circles: [...circles].sort() };
}

/**
 * What happened to the file on disk. `written` is the only outcome that changed it.
 *
 * `skipped-format-ahead` is the one that has to be legible: the mirror left in place is a shape this
 * build cannot read, so a caller that treats the call as successful regeneration is reporting a
 * working mirror over a file its own hook will reject.
 *
 * `skipped-superseded` is a BENIGN no-op like `skipped-current` — the file on disk already belongs to
 * the store's current lineage, so the mirror is fine either way — but it is not the SAME no-op: it
 * means a concurrent writer's generation outran the one this call snapshotted, not that this call's
 * own snapshot matched what was already there. Kept distinct so instrumentation can tell "nothing had
 * changed" from "something changed out from under us," even though neither is an operator problem.
 */
export type SidecarWriteOutcome = "written" | "skipped-format-ahead" | "skipped-current" | "skipped-superseded";

/** The result of a materialize attempt: what was generated, and whether it reached disk. */
export interface SidecarMaterialization {
  outcome: SidecarWriteOutcome;
  /**
   * The mirror this call GENERATED. On disk only when `outcome` is "written" — on a skip it is what
   * WOULD have been written, which is exactly the distinction the bare-sidecar return erased.
   */
  sidecar: GateMirror;
}

/**
 * Regenerate the gate mirror at `path`, atomically.
 *
 * ATOMIC because the reader is a CLI on the critical path of somebody's action: a torn file must
 * never be observable, and "the mirror was half-written" must never be a way to lose a deny.
 * tmp-in-the-same-directory + rename, which is atomic within a filesystem.
 *
 * The write happens even when there are no live rules at all — an EMPTY entries array is the
 * correct mirror of a store with nothing governing, and is meaningfully different from a missing
 * file (which a reader must treat as "no mirror, fail open loudly").
 *
 * RETURNS THE OUTCOME, NOT JUST THE ARTIFACT. This used to hand back the freshly generated mirror
 * whatever happened, so a declined write looked identical to a successful one: install and recovery
 * tooling reported "mirror regenerated" while the file on disk stayed `format-ahead` and unusable by
 * a reader. A function that says it wrote when it did not is the failure this module spends its
 * length preventing everywhere else, committed by the writer itself.
 */
export function materializeGateMirror(
  db: StoragePort,
  path: string,
  opts: { storeIdentity?: string; now?: number } = {},
): SidecarMaterialization {
  // ONE TRANSACTION over the generation and the entries. Read separately, a bump committing between
  // them yields a file that stamps the NEW generation onto the OLD rule set — a mirror that claims
  // to be current while missing the very change that made it stale, which is worse than an honestly
  // stale one because `inspectSidecar` would agree with it.
  const sidecarWithoutChecksum: Omit<GateMirror, "checksum"> = db.transaction((): Omit<GateMirror, "checksum"> => {
    const entries = listGateMirrorEntries(db);
    const { circleAliases, circles } = gateMirrorCircles(db, entries);
    return {
      format: GATE_MIRROR_FORMAT,
      generatedAt: opts.now ?? Date.now(),
      generation: gateGeneration(db),
      ...(opts.storeIdentity ? { storeIdentity: opts.storeIdentity } : {}),
      entries,
      stages: listGateMirrorStages(db),
      circleAliases,
      circles,
    };
  })();
  // THE CHECKSUM RECIPE (Codex round 12, item 1 — John's own ratification, 2026-07-28; documented
  // here in full so a reader can recompute it independently, matching this codebase's own convention
  // of writing the exact SQL/algorithm inline rather than pointing at it from a distance):
  //
  //   1. Build the mirror object WITH EVERY FIELD EXCEPT `checksum` — exactly the object above.
  //   2. canonical = JSON.stringify(thatObject, null, 2) — the SAME stringify call (same replacer,
  //      same 2-space indent) this function already uses for the file it writes below, so there is
  //      only ONE serialization convention in this function, not two.
  //   3. checksum = sha256(canonical), hex-encoded.
  //   4. The FINAL written object is { ...thatObject, checksum } — checksum spread in LAST.
  //
  // WHY THIS IS RECOMPUTABLE FROM A PARSED FILE, not merely from the in-memory object above:
  // `JSON.parse` reconstructs a plain object's OWN string-keyed properties in the exact order they
  // appeared in the source text (V8's own guarantee, not an assumption) — so a reader who destructures
  // `{ checksum, ...rest }` off the parsed header recovers `rest` with every OTHER key in the IDENTICAL
  // relative order this recipe built them in, regardless of where `checksum` itself sat in the file.
  // `JSON.stringify(rest, null, 2)` therefore reproduces the exact `canonical` string from step 2,
  // byte for byte, for any file this recipe honestly wrote — and reliably fails to for one that was
  // not (see readSidecarHeader's own verification, below in this file).
  const canonical = JSON.stringify(sidecarWithoutChecksum, null, 2);
  const checksum = createHash("sha256").update(canonical, "utf8").digest("hex");
  const sidecar: GateMirror = { ...sidecarWithoutChecksum, checksum };
  const dir = dirname(path);
  // SIDECAR AT 0600 — reusing
  // the source-materializer's own precedent MECHANISM: mode supplied at CREATION time, never a
  // chmod-after-the-fact (see e.g. source-materializer.ts's `writeFileSync(target, bytes, { mode:
  // ... })` and `openSync(..., O_CREAT | O_EXCL | O_WRONLY, 0o600)` call sites — none of them write
  // at a default mode and tighten second; the window between "written" and "tightened" is exactly
  // what that would leave briefly exposed). See the file write below for that half.
  //
  // WHAT THIS DEFENDS AGAINST, PRECISELY — the boundary doc's own words, verbatim: "other local
  // accounts and backup tooling, NOT against the agent (same uid)". The mirror now carries every
  // live rule and its reason, in full, on disk (slice 4b-B's widened blast radius, which the
  // boundary doc calls out by name). This is a permission-BITS fix, not a trust-boundary one:
  // unlike source-materializer's managed source roots — which ingest untrusted external repo
  // content, and so also check uid + symlink + nlink before trusting a path at all, via
  // `assertManagedDirectoryTrust` in source-safe-remove.ts — this directory holds nothing but our
  // own derived output. Reusing that heavier machinery here would defend against a threat this
  // file does not have; matching its PERMISSION-BITS mechanism is the right amount of precedent to
  // borrow, not its entire trust check.
  //
  // THREE POSTURES FOR THE DIRECTORY, CONSIDERED IN ORDER (Codex round 8, item 1, P1 — correcting
  // round 7's own choice here, on review):
  //
  //   1. REFUSE a pre-existing mismatch (`assertManagedDirectoryTrust`'s own posture — throws
  //      "unsafe permissions" rather than correcting it). Right for source-materializer's own
  //      managed roots, which this codebase always creates at 0700 from birth — a later mismatch
  //      there signals tampering worth refusing outright. Wrong here: `dir` routinely PRE-DATES
  //      this permission fix (an ordinary `.monet` directory created before it shipped, sitting at
  //      whatever the process's umask left it), so refusing on mismatch would turn every upgrade of
  //      an existing install into a hard failure of gate refresh on its very next mutation, for a
  //      directory that was never wrong by this store's own doing.
  //   2. TIGHTEN a pre-existing mismatch to 0700 (round 7's own choice here) — an OVERREACH,
  //      corrected this round: `path` (and so `dir`) is caller-supplied
  //      (`MonetCoreOptions.gateSidecarPath`), not a root this module mints itself the way
  //      source-materializer's are. `dirname(path)` can be `$HOME`, a project directory, or any
  //      other shared location the CALLER populated with content that has nothing to do with
  //      Monet — seizing it to 0700 on this module's own say-so would silently break whatever else
  //      already lives there (another account or process that needed to list or create alongside
  //      it, sharing that same directory legitimately). Round 7's own error was treating "the
  //      directory might be loose" as a defect to correct, when for a caller-supplied path it is
  //      simply not this module's directory to tighten.
  //   3. LEAVE a pre-existing directory exactly as it is — neither refused nor tightened — and set
  //      `mode: 0o700` only on the directory THIS CALL actually creates (mkdir's own `mode` option
  //      already applies only to a directory it creates — verified empirically in round 7, not
  //      assumed — so this costs nothing beyond what round 7 already had for the fresh case). This
  //      is the one used.
  //
  // WHY "LEAVE" DOES NOT REOPEN THE CONFIDENTIALITY GAP THIS FIX EXISTS TO CLOSE: directory
  // permission bits govern LISTING (can another account enumerate what is in here) and CREATION
  // (can another account add a new entry) — not READING an existing file whose own mode already
  // restricts that. The mirror's actual confidentiality boundary is the FILE's own 0600, not the
  // directory around it: mode-at-creation for a fresh path, inherited via rename for one that
  // already existed (see below) — unconditional either way, regardless of `dir`'s own permissions.
  // A looser `dir` lets another local account see THAT a file named `gate-sidecar.json` exists (and
  // its size, mtime) but not read a byte of what it says — the rules and reasons themselves stay
  // behind the file's own 0600.
  //
  // CORRECTION (Codex round 9, item 1) — this comment previously also claimed the one thing an 0700
  // `dir` would additionally have bought, preplant resistance at the tmp path, was "already covered"
  // by mode-at-birth alone. That was wrong, and round 7 + round 8 compose to show exactly why: round
  // 7 considered `O_EXCL` for the tmp write and rejected it, reasoning the 0700 directory already
  // closed the preplant window on its own (nothing else could create anything in a directory only we
  // could write into) — a correct argument, AT THE TIME. Round 8 then removed that same directory
  // tightening, correctly, on its own separate terms (a caller-supplied, possibly-shared `dir` is not
  // this module's to seize). Neither round was wrong given what it alone changed; the composition of
  // both left the tmp write with NEITHER protection: no directory exclusivity (round 8) AND no write
  // exclusivity of its own (round 7's own rejected-but-never-added `O_EXCL`). What actually closes
  // the preplant window now is EXCLUSIVITY AND UNPREDICTABILITY on the write itself, added below —
  // not the directory's mode, which this comment no longer claims any confidentiality role for beyond
  // LISTING and CREATION, stated plainly above.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // UNPREDICTABLE FROM BIRTH (Codex round 9, item 1) — a `randomUUID()` suffix APPENDED to the
  // existing pid+timestamp shape, not a replacement for it: the prefix stays useful to a human
  // debugging a stray tmp file ("which process, roughly when"), the suffix is what makes the FULL
  // name unguessable in advance (~122 bits of entropy — computationally infeasible to pre-plant
  // against, unlike the bare pid+millisecond-timestamp name this replaces, which a local attacker
  // can observe or narrowly range). See the mkdir comment above for why unpredictability ALONE is
  // not enough either — paired with `wx` below, not a substitute for it.
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    // EXCLUSIVE CREATION (Codex round 9, item 1) — reusing source-materializer's own precedent
    // MECHANISM exactly: `writeFileSync(path, data, { flag: "wx", mode: 0o600 })`, the identical
    // shape its own `writeOwner` helper uses for a fresh JSON payload written to a token-suffixed
    // temp path ahead of an atomic rename (source-materializer.ts) — the closest analog to this
    // function's own write-then-rename shape, of the several `O_CREAT | O_EXCL` call sites that
    // file has.
    //
    // 'wx' = O_CREAT | O_EXCL | O_WRONLY, Node's flag-string shorthand for the identical numeric
    // flags. FAILS on ANY existing path at `tmp`, including a symlink, WITHOUT following it — POSIX
    // is explicit on exactly this point ("If O_CREAT and O_EXCL are set, and path names a symbolic
    // link, open() shall fail and set errno to [EEXIST], regardless of the contents of the symbolic
    // link"), so this is the LIGHTER of source-materializer's own two `O_CREAT | O_EXCL` shapes
    // (plain, not the separate O_NOFOLLOW-carrying one a couple of its call sites also use) —
    // deliberately: O_EXCL alone already provides no-follow-at-the-leaf here, so an explicit
    // O_NOFOLLOW on top would be redundant, not additionally protective, for this specific write.
    //
    // MODE IS NOW ALWAYS HONORED, not merely "in practice" the way round 8's superseded comment put
    // it: `wx` GUARANTEES this call either creates the inode fresh (mode 0600 live from the first
    // byte) or writes nothing at all — there is no third outcome where it silently opens something
    // that already existed.
    writeFileSync(tmp, `${JSON.stringify(sidecar, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    // `tmp` IS NOT OURS TO CLEAN UP HERE, for ANY failure creating it — `wx` failing means this call
    // did not create the inode, so nothing below (including a pre-existing planted file or symlink)
    // is ours to unlink. The generic cleanup a few lines down is only correct once creation has
    // actually succeeded; reusing it here would delete whatever an attacker planted (destroying the
    // evidence) or, for a planted symlink, remove the link itself — not a write into either, but
    // still not this function's call to make on a path it never owned.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // ONE ATTEMPT, NOT A RETRY LOOP — deliberately (considered and rejected: a single retry with a
      // second fresh random suffix, then throw). `tmp`'s name is already unpredictable (the
      // `randomUUID()` suffix above), so a genuine collision here is not "unlucky" in the way a
      // predictable-name collision would be — it is a signal, not routine contention: either
      // something is enumerating this directory's contents against an infeasibly large guess space,
      // or this process's own random source is broken. A second random name carries the identical
      // risk calculus as the first with no new information gained from the retry, so this throws
      // immediately, loudly, and by name — never silently falling through to a write that might
      // land through whatever is already there.
      throw new Error(
        `gate mirror temp file already exists at a freshly-randomized path on the very first attempt ` +
          `to create it exclusively (${tmp}): refused rather than written through. This should never ` +
          `happen by chance — investigate ${dir} for a hostile actor, or this process's random source, ` +
          `before retrying.`,
      );
    }
    throw error;
  }
  try {
    // COMPARE BEFORE REPLACE. rename() is atomic, so no reader ever sees a torn file — but atomic
    // is not the same as ordered: two writers racing can land an OLDER snapshot on top of a newer
    // one, and the loser's generation then sits in the header claiming to be current. That is worse
    // than staleness, because `inspectSidecar` would agree with it.
    //
    // Under today's WAL + busy_timeout — set in exactly this shape by storage.ts's own constructor,
    // whose comment states the point plainly: "the MCP server and a `monet` CLI call can share one
    // `.monet` DB". Multi-process is not a future architecture question 4b will eventually settle, it
    // is the shipped topology TODAY, so the race the paragraph above describes is not theoretical: a
    // compare before replace is load-bearing right now, not insurance against something that cannot
    // happen. A same-store file already AT our generation is simply current — it already says what we
    // are about to write — and is not one we should overwrite.
    //
    // AHEAD OF OUR SNAPSHOT IS AMBIGUOUS — the old `>=` handled it by preserving every ahead file the
    // same way, which was right for one of the two events that produce this exact shape and wrong for
    // the other:
    //   (a) the store went BACKWARD since that file was written — a restore or a rollback — and the
    //       file is debris of a lineage this store no longer has, the same event class as `foreign`
    //       below, just without a different identity to catch it; or
    //   (b) a legitimate newer writer of THIS SAME lineage published — store AND mirror — while we
    //       were between our snapshot and this compare: exactly the race the first paragraph above
    //       names, now reachable rather than theoretical. That file is not debris, it is simply RIGHT,
    //       and we are the stale write.
    // Both look identical from the snapshot alone (`existing.generation > sidecar.generation`, same
    // store, same format), so the snapshot cannot be the tiebreaker. One more read can: the store's
    // CURRENT generation, taken fresh, right here, rather than trusted from what we snapshotted
    // earlier. (a) is still ahead of that fresh read too — no writer of this lineage could have
    // produced a generation the store itself has never reached, so it falls through to the rename
    // below exactly like foreign debris. (b) is at or behind the fresh read — a real write already
    // landed it — so we decline, but WITHOUT claiming we wrote it: `skipped-superseded`, distinct from
    // `skipped-current` so instrumentation can tell "we matched" from "we lost a race," even though a
    // caller may treat both as the benign no-op they are.
    //
    // NARROWED, NOT CLOSED. A writer can still bump between the fresh read below and the rename two
    // lines down — TOCTOU is inherent to compare-then-replace, and no amount of rereading removes the
    // last gap. What the fresh read buys is the SIZE of the gap: from "any pause between the snapshot
    // at the top of this function and this compare" down to two adjacent syscalls. And a miss in that
    // narrowed gap self-heals: every mutation re-triggers a refresh, so a rare loss here is corrected
    // by the very next one, not carried forward.
    //
    // FORMAT PARTICIPATES, and its absence here was the other half of the bug above. The generation
    // compare was right about vintage and wrong to be the ONLY comparison: an upgraded install whose
    // generation had not moved kept skipping the rename, so its v2 artifact survived indefinitely —
    // until some unrelated mutation happened to bump the counter — while its own v3 hook rejected
    // the file and lost offline blocking outright. Rewriting a file whose shape is not ours is the
    // POINT of a version bump, so a format mismatch overrides the skip in both directions.
    const existing = readSidecarHeader(path);
    // A build AHEAD of this one wrote it. Do not overwrite, and do not pretend it is fine.
    //
    // Not because clobbering loses data — the mirror is derived, and either build regenerates it
    // from the store. The reason is THRASH: if an older build overwrote forward-format files, two
    // installs sharing a path would each clobber the other on every invocation, and both hooks
    // would fail intermittently and unreproducibly. Declining makes the failure deterministic and
    // attributable — only the older install's hook rejects the file — and `inspectSidecar` names it
    // `format-ahead`, which points at the one fix that works: upgrade this install. We also simply
    // cannot know what a future entry shape means, and a writer that overwrites what it cannot read
    // is guessing on the critical path of somebody's action.
    // ...but only for OUR OWN mirror. The thrash argument needs two installs sharing a path for the
    // same store; a forward-format file belonging to a DIFFERENT store is not the other half of a
    // thrash pair, it is debris left in our path — by a restore that reused the directory, most
    // likely. Deferring to it would be deferring to a file `inspectSidecar` has already called
    // `foreign`, i.e. one we have decided we cannot read, and the skip would repeat forever: the
    // refresh is a no-op every time, so this store never gets an offline deny at all. Identity
    // therefore gates the preservation rule, and a foreign file is overwritten whatever its format.
    const sameStore = existing !== null && existing.storeIdentity === (sidecar.storeIdentity ?? null);
    const aheadOfUs = sameStore && existing.format !== null && existing.format > sidecar.format;
    // EQUALITY ONLY. An ahead generation is NOT handled by widening this to `>=` — see AHEAD OF OUR
    // SNAPSHOT IS AMBIGUOUS above — it is handled by asking the store, fresh, just below.
    const alreadyCurrent = sameStore
      && existing.format === sidecar.format
      && existing.generation === sidecar.generation;
    // Same shape as `alreadyCurrent` but for `>` rather than `===` — see the paragraph above for why
    // this cannot be resolved from the snapshot and needs the store's CURRENT generation instead.
    const aheadOfSnapshot = sameStore
      && existing.format === sidecar.format
      && existing.generation > sidecar.generation;
    // THE FRESH READ. Only evaluated when it matters (short-circuited by `aheadOfSnapshot`), since
    // every other path already has its answer without asking the store again.
    const supersededByRace = aheadOfSnapshot && existing.generation <= gateGeneration(db);
    if (aheadOfUs || alreadyCurrent || supersededByRace) {
      unlinkSync(tmp);
      // THREE SKIPS, and no two of them mean the same thing to a caller. `skipped-current`: the file
      // already says what we would have said — a genuine no-op, the mirror is fine. `skipped-superseded`:
      // a legitimate newer write already landed it before we got here — also a no-op, also fine, but
      // named separately so instrumentation can see that THIS call specifically lost a race rather
      // than matching on the first try. `skipped-format-ahead`: the file is a shape this build cannot
      // read and deliberately will not replace — the mirror is NOT fine, and the caller has an
      // operator problem to surface rather than a success to report.
      const outcome: SidecarWriteOutcome = aheadOfUs ? "skipped-format-ahead"
        : alreadyCurrent ? "skipped-current"
        : "skipped-superseded";
      return { outcome, sidecar };
    }
    // TARGET INHERITS 0600 VIA RENAME — verified empirically, needing no separate action here: a
    // rename onto an existing path replaces its inode outright, permission bits included, so `path`
    // ends up at `tmp`'s mode (0600) regardless of what it was before — even a mirror written by a
    // build that predates this fix, sitting at a wider default mode, is tightened the next time it
    // is regenerated, with no extra chmod call needed on `path` itself.
    renameSync(tmp, path);
  } catch (error) {
    // `tmp` IS OURS TO CLEAN UP HERE (Codex round 9, item 1 — narrowed from "gone or never created"):
    // reaching this catch means the exclusive creation above already succeeded, so this path never
    // races the "was it ever created at all" question the old comment hedged against — only whether
    // it is STILL there (e.g. the skip branch above already removed it before an exception could
    // occur here, or something unrelated did).
    try {
      unlinkSync(tmp);
    } catch {
      // Already gone. The original error is still the one worth reporting.
    }
    throw error;
  }
  return { outcome: "written", sidecar };
}

// ---- the offline evaluator ---------------------------------------------------

/**
 * THE OFFLINE EVALUATOR (4b-C's engine half) — answers the SAME five-outcome shape `gateInternal`
 * does (silence / stage-hit-no-rules / advisory / blocking / overflow), from a materialized
 * `GateMirror` alone. No db, no writes, no instrumentation: whether/how an offline call gets
 * recorded is the CLI's own decision (4b-D), not this one — this function is a pure read over data
 * the caller already holds in memory.
 *
 * REUSES THE LIVE MATCHER'S OWN FUNCTIONS, never a reimplementation: `clampActionContext`,
 * `parseActionContext`, `parseTriggerPatterns` and `matchesTriggerPattern` below are the EXACT
 * functions `gateInternal` calls — same module, same code, not a lookalike copy. The one-predicate
 * discipline this whole file is built on means the offline answer IS the live answer, not a
 * hand-tuned approximation of it.
 *
 * ORDERING NEEDS NO SORT HERE: `mirror.entries` already arrives in gate-delivery order
 * (`listGateMirrorEntries`'s own `ORDER BY`) and `Array.prototype.filter` preserves relative order,
 * so filtering down to one query's matched stages plus live circle/tag scope reproduces exactly the
 * order `rulesForStages`' SQL would produce for that same subset — a total order via
 * (severity, created_at, concept_id) restricted to any subset is that subset's own order (see
 * `listGateMirrorEntries`'s own comment for the full argument).
 *
 * THE PARENT-PRINCIPLE GAP IS CLOSED (slice 5-B, D4). Through 5-A this evaluator could not reproduce
 * `GateRule.projectedFromPrincipleId` at all — `GateMirrorEntry` carried no parent id — and that was
 * recorded here as a real, reachable divergence the moment `memory_ratify` started writing
 * derivation edges. `GateMirrorEntry.projectedFromPrincipleId` now carries it, populated by the SAME
 * correlated pick `rulesForStages` uses, so the offline answer announces the same provenance a live
 * fire does. `listGateMirrorEntries` is the write path that gap was waiting on; the two entrances
 * that mint a derivation edge (projection at rule birth, ratification at approve/re-ratify) both
 * bump the mirror generation, so the file does not sit stale behind an edge that just landed.
 *
 * ONE REPRESENTATION GAP REMAINS, AND IT IS DELIBERATE, NOT OWED: `GateRule.parentDisputed` (slice
 * 5-B, D5) is NEVER set offline. Every other field on a mirror entry is a property of an ACT — a
 * binding, a title, an edge — and acts are append-only, so a frozen copy of one stays true until
 * something writes another act and regenerates the file. `status` is not an act: a principle goes
 * disputed the moment a correction impeaches it and returns to active the moment a human mediates,
 * and neither transition need touch a rule binding. A `parentDisputed` frozen into the mirror would
 * therefore keep announcing doubt after the human resolved it, or stay silent after they opened it —
 * a stale flag that LIES rather than merely omits. Omitting is the honest failure: the offline
 * answer says what the rule is and who it descends from, and stops short of claiming to know the
 * parent's current standing, which is exactly what a server-unreachable caller cannot know anyway.
 * This is disclosure-only in both paths, so no verdict, severity or firing decision differs.
 *
 * AND IT REACHES AN AGENT, not only this parity test: `stage_lookup` delivers the parent field on
 * the wire (see its handler in mcp-server.ts), so an ORDINARY declared or correction-born rule that
 * a human later names in `memory_ratify`'s `memberRuleIds` announces a parent principle to every
 * reading agent — the "derived from principle P" provenance line, now true of extraction members and
 * not only of projections. That is correct as written (the rule genuinely IS derived from that
 * principle, which is what the ratification recorded) and it is why the field's own doc comment says
 * "derived from", never "projected from"; the naming is the only thing that still leans projection-
 * ward, and renaming a shipped wire field is not worth a compatibility break on its own.
 */
export function evaluateGateFromMirror(
  mirror: GateMirror,
  opts: { actionContext: string; circle: string; runtimeModelTag?: string; now?: number },
): GateResult {
  assertQueryableCircle(opts.circle);
  const clamped = clampActionContext(opts.actionContext);
  // Same short-circuit as gateInternal: overflow is a THIRD verdict, never silence, and nothing is
  // matched against a context this long — see clampActionContext's own comment.
  if (clamped.overflow) {
    return { stage: null, stages: [], rules: [], silence: false, overflow: true, source: "sidecar" };
  }
  const context = parseActionContext(clamped.text);

  // RESOLVE THE QUERY CIRCLE THROUGH THE ALIAS MAP FIRST (review fix — MATERIAL M3), matching
  // `resolveCircle`'s (engine.ts) own semantics exactly: single-hop, active-only, name unchanged if
  // absent. `mirror.circleAliases` already carries only active rows (see gateMirrorCircles), so no
  // status check is needed here — presence in the array already means active. `entries[].circle` is
  // always written at the CANONICAL name (bindRule/graftRows write whatever circle the store's own
  // resolveCircle already settled on, never an alias's `from` side), while the live path
  // (MonetCore.gate/stageLookup) resolves its query circle before ever reaching gateInternal's
  // filter. Filtering `mirror.entries` against the UNRESOLVED `opts.circle` therefore silently
  // stopped matching every entry the moment its circle was renamed away — live kept answering
  // through the alias, offline went quiet. One hop only, never chased further — and the invariant
  // is PARITY WITH THE LIVE RESOLVER, not totality: the local writers (renameCircle, mergeCircle)
  // flatten chains at write time, but grafted aliases can genuinely chain across devices (A→B from
  // one peer, B→C from another), and resolveCircle stops at one hop there too. Both sides stopping
  // at the same place is what keeps offline ≡ live; "improving" this to multi-hop without changing
  // resolveCircle in the same act would silently break the parity this comment exists to guard.
  const alias = mirror.circleAliases.find((row) => row.from === opts.circle);
  const resolvedCircle = alias ? alias.to : opts.circle;

  const matched: GateMirrorStage[] = [];
  for (const stage of mirror.stages) {
    const patterns = parseTriggerPatterns(stage.triggerPatterns);
    if (patterns.some((pattern) => matchesTriggerPattern(pattern, context))) matched.push(stage);
  }

  const matchedStageIds = new Set(matched.map((stage) => stage.id));
  const rules: GateRule[] = mirror.entries
    .filter((entry) =>
      matchedStageIds.has(entry.stageId)
      // UNIONED WITH BREADTH, identically to RULE_LIVENESS_WHERE's own
      // `(b.circle = ? OR b.circle = '*')` — a global rule delivers in every circle, no shadowing,
      // no precedence: it simply passes this filter alongside whatever is local here too.
      && (entry.circle === resolvedCircle || entry.circle === BREADTH_CIRCLE)
      && ruleTagIsLive(entry.scope, entry.modelTag, opts.runtimeModelTag),
    )
    .map(toGateRuleFromMirrorEntry);

  const stages: GateStageRef[] = matched.map((stage) => ({ id: stage.id, name: stage.name }));
  // SAME FALLBACK gateInternal USES: the rule that answered when there is one (rules[] is already
  // in the right order), else the oldest matched stage — the projection-hook case with no severity
  // to rank by. `mirror.stages` carries no `created_at`, so "oldest" here means "first in the
  // registry-order array `listGateMirrorStages` already produced" — the same order gateInternal's
  // own `listMatchableStages` uses (`created_at ASC, id ASC`), so this agrees with it exactly.
  const primaryStageId = rules[0]?.stageId ?? stages[0]?.id ?? null;

  return {
    stage: stages.find((stage) => stage.id === primaryStageId) ?? null,
    stages,
    rules,
    silence: matched.length === 0,
    overflow: false,
    source: "sidecar",
  };
}

/**
 * THE model-tag liveness clause, JS-side — bound BY THIS COMMENT to `RULE_LIVENESS_WHERE`'s own tag
 * clause (`b.scope != 'agent' OR ? IS NULL OR b.model_tag = ?`, defined far above in this file):
 * a domain rule always lives; an agent rule lives when the caller passed no runtime tag at all (the
 * filter is OFF, not "reject everything"), or when its tag matches exactly. A raw SQL fragment and
 * a JS predicate cannot literally share one function body, so the binding is this comment rather
 * than an import — a change to one that is not mirrored in the other is a reviewer's job to catch.
 */
function ruleTagIsLive(scope: RuleScope, modelTag: string | null, runtimeModelTag: string | undefined): boolean {
  return scope !== "agent" || runtimeModelTag === undefined || modelTag === runtimeModelTag;
}

/**
 * `evaluateGateFromMirror`'s own `toGateRule` — same shape, same `reasonMissing` predicate
 * (`severity === "blocking" && hasNoReason(reason)`) computed HERE rather than trusted from disk,
 * for the exact reason `GateMirrorEntry` carries no such field (see its own comment).
 *
 * `projectedFromPrincipleId` passes through from the entry as of slice 5-B (D4), preserving the
 * omit-when-absent shape on both sides — an entry from a mirror written before that slice has no
 * such key, and the rule it produces has no such field, exactly as a parentless rule does. NO
 * `parentDisputed`, ever: see `evaluateGateFromMirror`'s own comment for why a frozen status flag
 * would lie rather than merely omit.
 */
function toGateRuleFromMirrorEntry(entry: GateMirrorEntry): GateRule {
  return {
    conceptId: entry.conceptId,
    text: entry.text,
    reason: entry.reason,
    reasonMissing: entry.severity === "blocking" && hasNoReason(entry.reason),
    severity: entry.severity,
    scope: entry.scope,
    modelTag: entry.modelTag,
    origin: entry.origin,
    stageId: entry.stageId,
    ...(entry.projectedFromPrincipleId !== undefined
      ? { projectedFromPrincipleId: entry.projectedFromPrincipleId }
      : {}),
  };
}
