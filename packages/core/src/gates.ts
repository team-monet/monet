/**
 * Rules, stages, and the gate engine — the deterministic firing path.
 *
 * The design of record (docs/design/next-monet-skeleton-gates-recall.md) says a rule is "bound to a
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
 * THE BLOCKING SIDECAR IS A MIRROR, NOT A COPY
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `materializeBlockingSidecar` writes every live blocking rule to a local JSON file so a host hook
 * can deny without reaching the server ("blocking is enforceable without the server"; "a Monet
 * outage never *adds* blockage"). The design's own distinction applies verbatim: a source's copy
 * competes with the file as truth, while a MIRROR is a build artifact with an unambiguous master.
 * The store is master. The file is regenerated at every declaration — never edited, never read back
 * as authority, and safe to delete (the next declaration rebuilds it, and
 * `engine.materializeBlockingSidecar(path)` rebuilds it on demand).
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { StoragePort } from "./storage";

// ---- vocabulary -------------------------------------------------------------

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
 * are standing in. Locality lives on the RULE, which is an ordinary concept in an ordinary circle,
 * so `gateQuery` scopes by joining bindings to their concepts. One registry, many circles' rules.
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
    created_at INTEGER NOT NULL,
    sync_updated_at INTEGER NOT NULL,
    sync_revision INTEGER NOT NULL DEFAULT 0,
    sync_writer TEXT,
    -- THE SAFETY BOUNDARY, in the schema. Blocking severity exists only by declaration.
    CHECK (severity != 'blocking' OR origin = 'declaration'),
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
   * what materializeBlockingSidecar would write, and stamped into the file's header. Comparing the
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

/** Idempotent; safe on every open. */
export function createGateSchema(db: StoragePort): void {
  db.exec(GATE_SCHEMA_SQL);
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
 * Does this concept currently hold deny power? The predicate every bump site consults, so "what
 * counts as a blocking mutation" is decided in ONE place rather than re-derived per call site.
 * Deliberately reads the BINDING only: a retire or a supersession changes whether the rule is
 * DELIVERED, and the caller bumping for those already knows the binding is blocking.
 */
export function hasBlockingBinding(db: StoragePort, conceptId: string): boolean {
  return db
    .prepare(`SELECT 1 FROM rule_bindings WHERE concept_id = ? AND severity = 'blocking'`)
    .get(conceptId) !== undefined;
}

/** Does any concept in this circle hold deny power? Used by the circle-rename bump. */
export function circleHasBlockingRule(db: StoragePort, circle: string): boolean {
  return db
    .prepare(
      `SELECT 1 FROM rule_bindings b JOIN concepts c ON c.id = b.concept_id
        WHERE b.severity = 'blocking' AND c.circle = ? LIMIT 1`,
    )
    .get(circle) !== undefined;
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
 *   A CIRCLE MOVE. reassignCircle relocates a rule, and a rule denies only in its own circle, so a
 *   move IS a removal from the origin circle. That is correct by design rather than a gap: the deny
 *   moves WITH the rule and keeps firing in the destination, which is the same relationship every
 *   other memory has with locality. It is named here only because it is the one place a deny
 *   legitimately stops firing somewhere without a declaration.
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
  | "supersession";

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
 * Ask whether `operation` may remove `conceptId` from the gate. Local paths throw `message`;
 * graft paths skip and count, because an incoming row must never abort an otherwise-good graft.
 */
export function blockingRuleMutationGuard(
  db: StoragePort,
  conceptId: string,
  operation: BlockingRuleOperation,
): BlockingRuleGuardVerdict {
  const row = db
    .prepare(
      `SELECT c.title AS title
         FROM rule_bindings b
         JOIN concepts c ON c.id = b.concept_id
        WHERE b.concept_id = ? AND b.severity = 'blocking'
          AND c.status = 'active' AND c.kind = 'rule'
          AND NOT EXISTS (
            SELECT 1 FROM lifecycle_edges e
             WHERE e.family = 'supersession' AND e.src_concept_id = b.concept_id
          )`,
    )
    .get(conceptId) as { title: string } | undefined;
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
const MAX_STAGE_PATTERNS = 32;

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
  if (input.patterns !== undefined && input.patterns.length > MAX_STAGE_PATTERNS) {
    throw new Error(
      `a stage may carry at most ${MAX_STAGE_PATTERNS} trigger patterns (got ${input.patterns.length}): ` +
        `every gate lookup scans every pattern of every stage, so this is a per-action cost. Split the ` +
        `action into separate stages, or use shorter patterns that cover more shapes.`,
    );
  }
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
    // Re-authoring the patterns of a stage that carries a deny CHANGES WHAT THE DENY BLOCKS, which
    // is a change to the sidecar's content even though no binding was touched.
    if (liveBlockingRulesForStage(db, existing.id).length > 0) bumpGateGeneration(db);
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
  return row;
}

// ---- rule bindings ----------------------------------------------------------

export interface BindRuleInput {
  conceptId: string;
  stageId: string;
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
  const touchesDenyPower = previousSeverity === "blocking" || severity === "blocking";

  const syncAt = deps.nextSyncTimestamp();
  if (existing) {
    db.prepare(
      `UPDATE rule_bindings
          SET stage_id = ?, severity = ?, scope = ?, model_tag = ?, origin = ?, declared_by = ?,
              reason = ?, sync_updated_at = ?, sync_revision = sync_revision + 1, sync_writer = ?
        WHERE concept_id = ?`,
    ).run(
      input.stageId, severity, input.scope, modelTag, input.origin,
      input.declaredBy ?? null, reason, syncAt, deps.syncDeviceId, input.conceptId,
    );
    if (touchesDenyPower) bumpGateGeneration(db);
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
    created_at: syncAt,
    sync_updated_at: syncAt,
    sync_revision: 0,
    sync_writer: deps.syncDeviceId,
  };
  db.prepare(
    `INSERT INTO rule_bindings (concept_id, stage_id, severity, scope, model_tag, origin, declared_by,
                                reason, created_at, sync_updated_at, sync_revision, sync_writer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.concept_id, row.stage_id, row.severity, row.scope, row.model_tag, row.origin,
    row.declared_by, row.reason, row.created_at, row.sync_updated_at, row.sync_revision, row.sync_writer,
  );
  if (touchesDenyPower) bumpGateGeneration(db);
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
 * need, which is where paying for the extra field is right (docs/design/next-monet-skeleton-gates-
 * recall.md, "Capabilities are content too — and the payload is the invocation, not a description").
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
}

/**
 * THE shared liveness predicate every rule-delivery query in this module must agree on: active
 * concept, kind='rule', not superseded, in the caller's circle, respecting the model-tag filter.
 * A raw SQL fragment (not a function) because two DIFFERENT queries need to embed it verbatim in
 * their own WHERE clause — `rulesForStages` (full rule delivery, scoped to specific stage ids) and
 * `liveStageIdsWithRules` (liveStageIndex's own minimal existence check, over every stage) — and
 * "the same predicate, maintained as two copies" is exactly the drift risk this module's chokepoint
 * doctrine exists to close. Takes exactly 3 positional params, in order: circle, then the
 * model-tag filter's two placeholders (both the same value — `runtimeModelTag ?? null`).
 */
const RULE_LIVENESS_WHERE = `
          c.circle = ?
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
                ORDER BY p.created_at ASC, p.id ASC LIMIT 1) AS parent_concept_id
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

function gateInternal(db: StoragePort, opts: GateQueryOptions): { result: GateResult; pending: PendingGateWrites | null } {
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
 */
export function liveStageIndex(db: StoragePort, circle: string): LiveStageIndexResult {
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
}

export interface GateStatsOptions {
  circle: string;
  windowDays: number;
  now?: number;
  /** The model now running. Rules tagged for a different one are reported as retirement candidates. */
  runtimeModelTag?: string;
}

export function gateStats(db: StoragePort, opts: GateStatsOptions): GateStats {
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
    retirementCandidates: opts.runtimeModelTag === undefined ? [] : (db
      .prepare(
        `SELECT b.concept_id AS conceptId, c.title AS title, b.model_tag AS modelTag, s.name AS stageName
           FROM rule_bindings b
           JOIN concepts c ON c.id = b.concept_id
           LEFT JOIN stages s ON s.id = b.stage_id
          WHERE b.scope = 'agent' AND b.model_tag IS NOT ? AND c.circle = ?
            AND c.status = 'active' AND c.kind = 'rule'
            AND NOT EXISTS (
              SELECT 1 FROM lifecycle_edges e
               WHERE e.family = 'supersession' AND e.src_concept_id = b.concept_id
            )
          ORDER BY b.model_tag ASC, c.title ASC`,
      )
      .all(opts.runtimeModelTag, opts.circle) as GateStats["retirementCandidates"]),
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
    // blocking population, which is the same set materializeBlockingSidecar already walks in full on
    // every declaration, so this is not a new order of work.
    unexplainedDenies: (db
      .prepare(
        // INNER JOIN, matching listBlockingRules and the stage-first path gateInternal takes. A
        // binding can land without its stage — an incremental graft that omits the stage row, or a
        // name collision that skips it — and graftRows documents that such a binding NEVER FIRES.
        // A LEFT JOIN here put it in the deny list anyway, so the overview named a live deny that
        // cannot deny anything and told the user to redeclare it: advice that would CREATE the
        // missing stage and change what the store does. The disclosure surface has to ask the same
        // question the delivery surface asks, or it describes a store nobody is running.
        //
        // Left out rather than given its own name. An orphaned binding is a different signal from a
        // reasonless deny, and it is an expected TRANSIENT — the dangling-then-live case relay is
        // built to close, self-healing on the graft that brings the stage. A standing curation item
        // for a state that resolves itself is noise, and this branch's subject is denies that cannot
        // explain themselves, not bindings that cannot fire.
        `SELECT b.concept_id AS conceptId, c.title AS title, s.name AS stageName, b.reason AS reason
           FROM rule_bindings b
           JOIN concepts c ON c.id = b.concept_id
           JOIN stages s ON s.id = b.stage_id
          WHERE b.severity = 'blocking'
            AND c.circle = ?
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
      .map(({ conceptId, title, stageName }) => ({ conceptId, title, stageName })),
  };
}

// ---- the blocking sidecar ---------------------------------------------------

/** One blocking rule as the offline hook reads it. Carries the matcher's input, not prose. */
export interface BlockingSidecarEntry {
  stageId: string;
  stageName: string;
  /** Machine-readable, matched with this module's own `matchesTriggerPattern`. */
  patterns: TriggerPattern[];
  /** Human-readable renderings of the same patterns, for the deny message and for eyeballing. */
  patternText: string[];
  conceptId: string;
  ruleText: string;
  reason: string | null;
  /**
   * Same marker the live gate carries (see GateRule.reasonMissing), so the offline hook can say the
   * same sentence. Without it the two disagree exactly where it matters least to be inconsistent
   * and most to be honest: the hook runs when the server is unreachable, which is already the
   * moment a user is least able to go and look the reason up.
   *
   * Every entry here is blocking by construction, so this is simply "no reason" — but it is
   * computed, not implied, so a reader never has to know that `reason: "  "` meant absent.
   */
  reasonMissing: boolean;
  declaredBy: string | null;
  circle: string;
  /**
   * THE OFFLINE HOOK MUST APPLY THE SAME FILTER THE LIVE GATE DOES, and these two fields are what
   * let it. `gateQuery` delivers an `agent`-scoped rule only when the runtime's model tag equals
   * `modelTag` (see GateQueryOptions.runtimeModelTag); a mirror that omitted the scope made that
   * impossible offline, so a compensation for a retired model kept denying whenever the server was
   * unreachable — live and offline disagreeing exactly when the disagreement is hardest to notice.
   *
   * The rule for a reader: `scope === "domain"` always applies; `scope === "agent"` applies only
   * when the running model's tag equals `modelTag`. Circle scoping is the reader's job too —
   * `circle` above is the rule's locality, and the live gate matches it against the invoking one.
   */
  scope: RuleScope;
  modelTag: string | null;
}

/**
 * Bumped whenever an entry's SHAPE changes, so a reader can refuse a file it does not understand
 * rather than silently ignoring a field that decides whether a deny applies. Version 2 added
 * `scope` + `modelTag`; a version-1 file omits them and must not be trusted to filter.
 *
 * VERSION 3 added `reasonMissing`. Unlike `scope`, it does not decide WHETHER a deny applies — it
 * decides what the hook can honestly say while applying it. That still earns the bump: a v2 reader
 * pointed at a v3 file would render a reasonless deny as though nothing were wrong, which is the
 * silent-omission failure the version exists to make impossible. The rule stays "the entry shape
 * changed", not "the filter changed".
 */
export const BLOCKING_SIDECAR_FORMAT = 3;

export interface BlockingSidecar {
  /** Shape version of `entries` — see BLOCKING_SIDECAR_FORMAT. */
  format: number;
  generatedAt: number;
  /**
   * The gate-substrate generation this mirror was built from. THE field that makes the artifact
   * verifiable: comparing it against `gateGeneration(db)` answers "is this snapshot current" with
   * no hashing and no guessing. A hook reading a file whose generation is behind knows it is
   * holding a stale answer, which is the difference between failing loudly and denying wrongly.
   */
  generation: number;
  /** Which store produced this mirror — so a hook can notice it is reading someone else's. */
  storeIdentity?: string;
  entries: BlockingSidecarEntry[];
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
  if (!Array.isArray(header.entries)) return null;
  // FORMAT IS A DISCRETE VERSION NUMBER, not a magnitude to interpolate — there is no meaning between
  // format 3 and format 4, so `3.5` is not "a number we can still compare", it is a corrupt header.
  // Left unchecked, a fractional value greater than BLOCKING_SIDECAR_FORMAT passed `typeof === "number"`
  // and read as a genuine future format: `format-ahead` in inspectSidecar, `skipped-format-ahead`
  // forever in materializeBlockingSidecar — preserved on the promise of an upgrade that fixes nothing,
  // because no build, past or future, will ever actually write a fractional format. Rejecting the
  // whole header here (rather than coercing just this field to null) routes it through the SAME
  // `malformed` path as any other structurally-wrong file, in both consumers, from one place.
  if (typeof header.format === "number" && !Number.isInteger(header.format)) return null;
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
  if (header.format !== BLOCKING_SIDECAR_FORMAT) {
    const ahead = header.format !== null && header.format > BLOCKING_SIDECAR_FORMAT;
    return {
      stale: true,
      reason: ahead ? "format-ahead" : "format",
      fileGeneration, generation,
      fileFormat: header.format, format: BLOCKING_SIDECAR_FORMAT,
    };
  }
  // Strict inequality, not `<`: a file claiming a generation AHEAD of the store is also not a
  // mirror of this store, and treating it as current would let a stale deny set govern here.
  if (fileGeneration !== generation) return { stale: true, reason: "behind", fileGeneration, generation };
  return { stale: false, generation };
}

/** Every live blocking rule, in the gate's own order. Shared by the sidecar and any consumer. */
export function listBlockingRules(db: StoragePort): BlockingSidecarEntry[] {
  const rows = db
    .prepare(
      `SELECT b.concept_id, b.reason, b.declared_by, b.scope, b.model_tag, c.title, c.circle,
              s.id AS stage_id, s.name AS stage_name, s.trigger_patterns
         FROM rule_bindings b
         JOIN concepts c ON c.id = b.concept_id
         JOIN stages s ON s.id = b.stage_id
        WHERE b.severity = 'blocking'
          AND c.status = 'active'
          AND c.kind = 'rule'
          AND NOT EXISTS (
            SELECT 1 FROM lifecycle_edges e
             WHERE e.family = 'supersession' AND e.src_concept_id = b.concept_id
          )
        ORDER BY s.name ASC, b.created_at ASC, b.concept_id ASC`,
    )
    .all() as Array<{
      concept_id: string; reason: string | null; declared_by: string | null; title: string; circle: string;
      scope: RuleScope; model_tag: string | null;
      stage_id: string; stage_name: string; trigger_patterns: string;
    }>;
  return rows.map((row) => {
    const patterns = parseTriggerPatterns(row.trigger_patterns);
    return {
      stageId: row.stage_id,
      stageName: row.stage_name,
      patterns,
      patternText: patterns.map(formatTriggerPattern),
      conceptId: row.concept_id,
      ruleText: row.title,
      // Same normalization as the live gate — and here it is also what keeps the file readable: a
      // Buffer would serialize into the mirror as {"type":"Buffer","data":[...]}, which the hook
      // would then have to parse around.
      reason: typeof row.reason === "string" ? row.reason : null,
      reasonMissing: hasNoReason(row.reason),
      declaredBy: row.declared_by,
      circle: row.circle,
      scope: row.scope,
      modelTag: row.model_tag,
    };
  });
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
  sidecar: BlockingSidecar;
}

/**
 * Regenerate the blocking mirror at `path`, atomically.
 *
 * ATOMIC because the reader is a hook on the critical path of somebody's action: a torn file must
 * never be observable, and "the sidecar was half-written" must never be a way to lose a deny.
 * tmp-in-the-same-directory + rename, which is atomic within a filesystem.
 *
 * The write happens even when there are no blocking rules — an EMPTY entries array is the correct
 * mirror of a store with nothing blocking, and is meaningfully different from a missing file (which
 * a hook must treat as "no mirror, fail open loudly").
 *
 * RETURNS THE OUTCOME, NOT JUST THE ARTIFACT. This used to hand back the freshly generated sidecar
 * whatever happened, so a declined write looked identical to a successful one: install and recovery
 * tooling reported "mirror regenerated" while the file on disk stayed `format-ahead` and unusable by
 * the hook. A function that says it wrote when it did not is the failure this module spends its
 * length preventing everywhere else, committed by the writer itself.
 */
export function materializeBlockingSidecar(
  db: StoragePort,
  path: string,
  opts: { storeIdentity?: string; now?: number } = {},
): SidecarMaterialization {
  // ONE TRANSACTION over the generation and the entries. Read separately, a bump committing between
  // them yields a file that stamps the NEW generation onto the OLD deny set — a mirror that claims
  // to be current while missing the very change that made it stale, which is worse than an honestly
  // stale one because `inspectSidecar` would agree with it.
  const sidecar: BlockingSidecar = db.transaction((): BlockingSidecar => ({
    format: BLOCKING_SIDECAR_FORMAT,
    generatedAt: opts.now ?? Date.now(),
    generation: gateGeneration(db),
    ...(opts.storeIdentity ? { storeIdentity: opts.storeIdentity } : {}),
    entries: listBlockingRules(db),
  }))();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
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
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file is already gone, or was never created. Either way the original error is the
      // one worth reporting.
    }
    throw error;
  }
  return { outcome: "written", sidecar };
}
