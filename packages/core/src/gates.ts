/**
 * Rules, stages, and the gate engine — the deterministic firing path.
 *
 * The design of record says a rule is "bound to a
 * specific action, delivered by lookup at the moment of that action", that "a gate fires
 * deterministically: the host intercepts the action and asks Monet — no model, no judgment, no
 * network in the path, and silence when nothing matches", and that stages "need no taxonomy and no
 * self-recognition — a correction landing on an action with no stage IS the stage's creation".
 *
 * This module owns every statement against `stages` and `rule_bindings`; the engine
 * delegates (refactoring-build directive, same shape as src/resolution.ts and src/lifecycle-edges.ts).
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * TRIGGER PATTERNS WERE RETIRED HERE (2026-08-22) — the plain record of the retreat.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * REMOVED: the `TriggerPattern` format and its whole matcher — `matchesTriggerPattern`,
 * `seedTriggerPattern`, `parseTriggerPatterns`, `readTriggerPatterns`, `serializeTriggerPatterns`,
 * `formatTriggerPattern`, `listMatchableStages`/`MatchableStage`, `MAX_STAGE_PATTERNS`,
 * `MAX_PATTERN_TOKENS`, `assertPatternCountWithinCap`, and `assertNoUnacknowledgedDenies` with its
 * `acknowledgeBlockingRules` parameter. `stages.trigger_patterns` survives as a TOMBSTONE COLUMN
 * only — see its own note in GATE_SCHEMA_SQL for why the column could not go with the concept.
 *
 * WHY: Monet no longer intercepts anything. `stageLookup` resolves a stage BY NAME, never by
 * pattern, so nothing in the store had matched an action since the interception path was removed.
 * The only surviving readers were two declare-time advisories that warned the author about the
 * patterns themselves — circular — and one of them told the author something false: that a rule
 * "governs nothing until the patterns are fixed", when the rule governs by stage name whatever its
 * patterns say. Owner ruled 2026-08-22: retire them.
 *
 * WHAT IS GIVEN UP, stated plainly because it was real protection:
 *
 *   THE DENY RE-AIM ACKNOWLEDGEMENT. Re-authoring a stage's patterns used to require naming every
 *   live blocking rule bound there (`acknowledgeBlockingRules`), so a human could not silently
 *   change what a deny denies. There is no longer any way to re-aim a gate — a stage is its name,
 *   and a rule is bound to the stage — so the act that guard governed cannot be performed at all.
 *   The guard is not weakened; its subject is gone. A guard that cannot fire is the APPEARANCE of
 *   protection rather than protection, which is why it was removed rather than left standing.
 *
 *   THE MALFORMED-PATTERN DIAGNOSTIC (`gateCoverage().malformedPatterns`). It reported stages whose
 *   stored patterns were unreadable. Nothing writes a pattern any more, so it would have answered a
 *   question about a column that only ever holds `[]` — the same not-known-rendered-as-a-verdict
 *   that retired `unverifiedPatterns` alongside the mechanical matcher.
 *
 * WHAT SURVIVES, and why it is not pattern machinery: `parseActionContext` and `tokenizeCommand`.
 * `declareAdvisories` still uses them to notice that a declared principle looks COMMAND-SHAPED
 * ("this reads like `Bash:…` rather than a standing truth") — a check on the declared content's own
 * form that never consulted a stage's patterns. Only `ActionContext.index` went, because it existed
 * solely to make the matcher's candidate-start scan cheap and had no other reader.
 */

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

/**
 * WHAT EVERY NEW STAGE ROW WRITES INTO THE RETIRED `trigger_patterns` COLUMN.
 *
 * THE COLUMN COULD NOT GO WITH THE CONCEPT, for two independent reasons, either one sufficient:
 *
 *   1. THE LOCAL STORE. `createGateTables` is `CREATE TABLE IF NOT EXISTS`, a no-op against a store
 *      that already exists — so a column removed from the DDL stays in every store the previous
 *      release wrote, with the constraints it was declared with. `trigger_patterns` is
 *      `TEXT NOT NULL` with NO DEFAULT (unlike `stages.verified`, whose `DEFAULT 0` is exactly why
 *      that removal could stop naming it). An INSERT that stopped naming this column would fail
 *      with `NOT NULL constraint failed: stages.trigger_patterns` on every upgraded store, breaking
 *      stage creation for existing users while every fresh store stayed green.
 *
 *   2. THE WIRE. `exportDelta` selects `*`, so dropping the column would send peers a stage row with
 *      no `trigger_patterns` property. A peer still running the previous release binds that
 *      positionally into its own NOT NULL column, and its graft loop has no per-row catch — so the
 *      throw aborts the ENTIRE graft, not just the row. The wire field could never have been
 *      dropped independently of the local question.
 *
 * So the CONCEPT retires and the COLUMN stays, holding a constant nothing reads. Do not "clean this
 * up" by removing it from the DDL or from either INSERT.
 */
export const RETIRED_TRIGGER_PATTERNS = "[]";

export interface StageRow {
  id: string;
  /** Normalized (trimmed, whitespace-collapsed, lowercased) — see `normalizeStageName`. UNIQUE. */
  name: string;
  /**
   * RETIRED COLUMN — a tombstone, never read. Every row this build writes carries
   * `RETIRED_TRIGGER_PATTERNS`; see that constant for why the column outlived the concept. A row
   * from an older store or an older peer may still hold a real pattern array, and nothing parses it.
   */
  trigger_patterns: string;
  origin: StageOrigin;
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
 * `RULE_LIVENESS_WHERE` scopes by the binding directly rather than joining to the concept for
 * locality. One registry, many circles' rules — plus the one reserved breadth marker that means
 * every circle.
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
    -- RETIRED 2026-08-22, and DELIBERATELY STILL HERE. NOT NULL with no default, so an INSERT that
    -- stopped naming it would break every store the previous release wrote. Writers put
    -- RETIRED_TRIGGER_PATTERNS in it; no reader parses it. See that constant for the full reasoning.
    trigger_patterns TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('correction','declaration','import')),
    created_at INTEGER NOT NULL,
    sync_updated_at INTEGER NOT NULL,
    -- Convergence clock for the mutable columns (origin, and trigger_patterns for as long as any
    -- peer still writes one -- no local path changes either). A bare sync_updated_at
    -- comparison cannot decide these: the local value is the receiver's relay watermark and the
    -- incoming value is the sender's, two incomparable clock domains. (revision, writer) is the
    -- house pattern for mutable row convergence — circle_aliases, first_block, lifecycle_edges.
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
  -- The "is deny power in play" probe scans this predicate.
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
`;

/**
 * PHASE (a): every gate table — nothing but `db.exec(GATE_SCHEMA_SQL)`, split out on its own
 * (review fix — Codex round 3, item 1). MonetCore's own construction calls this BEFORE
 * `migrateLegacyStarCircle()` (engine.ts), which needs the gate tables to exist the moment it
 * finds a '*' concept to move — see that method's own comment. Idempotent — every statement in
 * GATE_SCHEMA_SQL is `IF NOT EXISTS` — so calling this again from `createGateSchema`'s own wrapper
 * below costs nothing.
 */
export function createGateTables(db: StoragePort): void {
  db.exec(GATE_SCHEMA_SQL);
}

/**
 * The eleven triggers of the mixed-build compatibility family, plus the singleton table they all
 * wrote to. Names are the ones the removed CREATE statements declared, verbatim — a name that does
 * not match an object in the store simply drops nothing.
 */
const RETIRED_GATE_TRIGGERS = [
  "trg_rule_bindings_backfill_circle",
  "trg_rule_bindings_follow_concept_circle",
  "trg_rule_bindings_follow_concept_status",
  "trg_rule_bindings_follow_concept_title",
  "trg_rule_bindings_bump_on_reclassification",
  "trg_stages_bump_on_insert",
  "trg_stages_bump_on_trigger_patterns",
  "trg_concepts_bump_on_delete",
  "trg_circle_aliases_bump_on_insert",
  "trg_circle_aliases_bump_on_update",
  "trg_circle_aliases_bump_on_delete",
] as const;

/**
 * DELETING A CREATE STATEMENT IS NOT A MIGRATION. `createGateTables` is `IF NOT EXISTS` per object,
 * so removing the trigger family's DDL stopped FRESH stores from ever getting it and did nothing at
 * all to a store that already had it — exactly the asymmetry gate-schema-compat.test.ts's own header
 * describes for a dropped column, one object type over. Every upgraded store still carries
 * `gate_meta` and all eleven triggers, and they still FIRE: on a concept's title, status or circle
 * changing, on a stage insert, on a rule reclassification, and on every alias mutation — each one
 * bumping a counter that no surviving code reads. Work that cannot be observed is not harmless; it
 * is a write amplification on the hot path of every declaration, plus a schema object a future
 * `ALTER` on `rule_bindings` or `circle_aliases` can collide with.
 *
 * WHY DROPPING IS SAFE, rather than restating it: the removal record in `migrateGateColumns` below
 * ("THE MIXED-BUILD COMPATIBILITY TRIGGER FAMILY WAS REMOVED HERE") holds the owner's ruling that
 * no old build writes to this store, and names what the family's absence gives up. That record is
 * the authority for this function; nothing here re-argues it.
 *
 * TRIGGERS FIRST, THEN THE TABLE, and the order is load-bearing rather than tidy. SQLite resolves a
 * trigger's BODY at fire time, not at drop time — so a store left holding a live
 * `trg_stages_bump_on_insert` after `gate_meta` had gone would fail its NEXT stage insert with
 * "no such table: gate_meta". Dropping in the other order turns a dead counter into a broken write
 * path, which is strictly worse than leaving the family alone.
 *
 * IDEMPOTENT AND SAFE ON A STORE THAT NEVER HAD THE FAMILY: `IF EXISTS` on every statement, so a
 * fresh store drops eleven triggers and one table that are all already absent, at the cost of twelve
 * no-op statements per open. That is the same posture as the guarded ALTER below — cheap enough to
 * run unconditionally, which is what makes it correct without a version gate to keep in step.
 */
function dropRetiredGateTriggerFamily(db: StoragePort): void {
  for (const trigger of RETIRED_GATE_TRIGGERS) {
    db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  db.exec(`DROP TABLE IF EXISTS gate_meta`);
}

/**
 * PHASE (c): every gate-substrate migration that is NOT table creation — the `rule_bindings.circle`
 * column guard, its backfill, and the circle index, in that order (review fix — Codex round 3,
 * item 1; split out of createGateSchema, which used to run all of this immediately after its own
 * `db.exec(GATE_SCHEMA_SQL)`). Requires every gate table to already exist — `createGateTables` must
 * run first, in every caller — and, for the backfill to land the CURRENT circle rather than `*`,
 * requires `migrateLegacyStarCircle()` (engine.ts, phase (b)) to already have run: the ordering
 * invariant this whole round-3 split exists to enforce is (a) tables → (b) legacy-star move →
 * (c) this function, and every one of the three remains independently idempotent and race-safe
 * (see each guard's own comment) regardless of which concurrent migrator gets there first.
 */
export function migrateGateColumns(db: StoragePort): void {
  dropRetiredGateTriggerFamily(db);
  // THE COLUMN GUARD, for breadth (slice 4b-B follow-up): a store created before breadth shipped
  // has a rule_bindings table with no `circle` column at all. No constant would fix it — the
  // correct value is "whichever circle this binding's own concept already lives in", which is a
  // per-row lookup, not a column DEFAULT. So the column is added nullable (the CREATE TABLE above
  // declares it the same way, for a fresh install), and the backfill just below fills every
  // pre-existing row from its concept — safe to run unconditionally, since `WHERE circle IS NULL`
  // makes every call after the first a no-op scan.
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
  // `stages` and `rule_bindings`" — deliberately NOT concepts, which lives in engine.ts's own
  // schema — and `createGateSchema` is exported (index.ts), so a caller can legitimately hold a
  // store carrying the gate tables and no concepts table at all. A backfill that assumed concepts
  // always exists would turn such a call into a crash rather than the harmless no-op it should be
  // when there is nothing yet to backfill.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  // THE MIXED-BUILD COMPATIBILITY TRIGGER FAMILY WAS REMOVED HERE (2026-08-22) — this is the plain
  // record the banner that stood here demanded of whoever took its retreat.
  //
  // REMOVED: the `gate_meta` singleton table, the eleven triggers that bumped its generation counter
  // (trg_rule_bindings_backfill_circle / _follow_concept_circle / _follow_concept_status /
  // _follow_concept_title, trg_rule_bindings_bump_on_reclassification, trg_stages_bump_on_insert /
  // _bump_on_trigger_patterns, trg_concepts_bump_on_delete, trg_circle_aliases_bump_on_insert /
  // _update / _delete), the `gateGeneration`/`bumpGateGeneration` helpers, and every JS bump site.
  //
  // WHY: the owner ruled on 2026-08-22 that no old build will ever write to this store. The family
  // existed solely to make an OLD build's write DETECTABLE to a new build's mirror; with no old
  // writer there is nothing left for it to protect.
  //
  // WHAT IS GIVEN UP: a store written by a build predating the `rule_bindings.circle` column no
  // longer self-heals on a WRITE. The triggers used to fill a NULL circle at insert time and keep a
  // binding's circle in step when its concept moved; the one-shot backfill just below still runs on
  // every open, so such a store now heals at the next OPEN instead. In between, a binding that build
  // wrote delivers nowhere — a NULL circle matches no RULE_LIVENESS_WHERE filter. That window is the
  // whole cost, and the ruling above is what makes it unreachable.
  //
  // `rule_bindings.circle` is UNCHANGED and still load-bearing (RULE_LIVENESS_WHERE, below). The
  // TypeScript write path maintains it unassisted: bindRule's own INSERT and UPDATE branches (this
  // file), graftRows' `effectiveCircle` and its concept-loop repair, and moveConcept's,
  // renameCircle's and mergeCircle's keep-in-step UPDATEs (engine.ts) — audited call site by call
  // site before this removal.
  //
  // THAT AUDIT HAD A HOLE, and this line is the correction rather than a re-statement (Codex round
  // 4, P1). Enumerating the writers of `concepts.circle` and matching each to a TypeScript path that
  // also updates `rule_bindings.circle` establishes that an update EXISTS on every path — never that
  // it always WINS. On the local movers it does: moveConcept, renameCircle and mergeCircle each run
  // an UNCONDITIONAL `UPDATE rule_bindings ... WHERE concept_id ... AND circle != '*'`, contested by
  // nothing. On the GRAFT path it does not: `concepts` and `rule_bindings` carry INDEPENDENT
  // (sync_revision, sync_writer) pairs, so a relayed concept row can win its own contest and MOVE
  // while its binding row loses its own — or never reaches it, `continue`d past by DOOR 12, the
  // breadth boundary check, or the divergent-successor recheck. `trg_rule_bindings_follow_concept_
  // circle` was the only UNCONDITIONAL repair for that case, and the concept-loop heal that
  // outlived it only touched `circle IS NULL` rows, so a binding already holding a value stayed in
  // the circle its concept had left, permanently — a blocking rule included. That heal is now
  // widened to every non-breadth binding of a moved concept (engine.ts, the BLOCKER B3 block's own
  // comment), which is what makes this paragraph true as written; the trigger stays retired.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  const hasConceptsTable = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'concepts'`)
    .get() !== undefined;
  if (hasConceptsTable) {
    // LEGACY '*' CIRCLES: moved to engine.ts (review fix — Codex round 2, item 2; originally landed
    // HERE in round 1, item 4). Round 1's version moved only `concepts.circle` — this gates-layer
    // position cannot reach the OTHER circle-scoped tables (observations, memory_edge, entities,
    // first_block, lifecycle_edges/ratifications: this module's own header says it owns
    // `stages` and `rule_bindings` alone) without either duplicating renameCircle's full table
    // list a second time or reaching across the module boundary into engine.ts's private methods.
    // The honest seam is MonetCore's own construction: `migrateLegacyStarCircle()` (engine.ts) now
    // runs inside `init()`, immediately before `createGateSchema(this.db)` is called — so the
    // backfill ordering requirement THIS comment used to explain in full is unchanged in substance,
    // only in which file states it: legacy-star move → THEN this column backfill, still true,
    // enforced by call order rather than by both steps living in one function.
    //
    // RESTRICTED TO BINDINGS WITH A RESOLVABLE, SAFE CONCEPT (Codex round 12, P2 — review found;
    // closes two problems in the SAME predicate). BEFORE: `WHERE circle IS NULL` alone matched every
    // dangling binding too — one whose `concept_id` names NO row in `concepts` at all (the
    // dangling-then-live gap) — and the UPDATE's own scalar subquery then evaluates to NULL,
    // assigning NULL to a column that was ALREADY NULL. SQLite's own `changes()` counts ROWS THE
    // WHERE CLAUSE MATCHED, not rows whose VALUE actually changed (the identical lesson this file's
    // own INSERT trigger, above, already learned the hard way) — so a store with nothing but
    // dangling bindings reported a changed-row count for a write that resolved nothing, on EVERY
    // open, and this function runs twice per construction. NOTHING READS THE COUNT ANY MORE — the
    // generation counter it fed is gone, and the statement's result is deliberately not bound to a
    // name here rather than bound and ignored. The predicate below is what would make the count
    // honest again if a reader ever returns; it is kept for the write it performs, not for the
    // number it would report.
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
    db.prepare(
      `UPDATE rule_bindings SET circle = (SELECT c.circle FROM concepts c WHERE c.id = rule_bindings.concept_id)
        WHERE circle IS NULL
          AND EXISTS (
            SELECT 1 FROM concepts c
             WHERE c.id = rule_bindings.concept_id AND c.circle != '${BREADTH_CIRCLE}'
          )`,
    ).run();
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

/**
 * THE CHOKEPOINT. Every way a rule can leave the gate's own result set passes through here.
 *
 * WHY THIS EXISTS AS ONE FUNCTION. Deny power was made unforgeable to MINT in a single place — a
 * schema CHECK — and it held against every attempt. Removing it was guarded door by door, and
 * review found EIGHT doors, one at a time: re-declaration, stage re-authoring, sidecar staleness,
 * relayed demotion, contradiction flagging, circle-move auto-merge, relayed contradictions, and
 * consolidating detach. That is not eight oversights; it is the wrong shape. A boundary defended at
 * N call sites is defended until someone writes the N+1th, and the search for doors terminates only
 * when the guard is structural.
 *
 * So: the gate delivers a rule when its concept is active, is kind='rule', has a blocking
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
 * active, is kind='rule', and carries no supersession edge — the gate's own delivery conditions
 * (`RULE_LIVENESS_WHERE`), minus locality. Returns the rule's title, so the guard can name it in an
 * error a human can act on, and the BINDING's own circle, which decides whether a given operation
 * takes delivery away
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

// ---- action-context parsing -------------------------------------------------
//
// WHAT IS LEFT OF THE MATCHER, and it is not a matcher. Nothing here compares an action against a
// stage any more (see the retreat record in the module header). `parseActionContext` survives for
// ONE reader: `declareAdvisories`, which asks whether a declared principle's own text is shaped
// like a command (`context.tool !== null`) rather than like a standing truth. That question is
// about the declared content's form, never about any stage's stored patterns.

/** A tokenized action context: tool prefix plus the command's tokens. */
export interface ActionContext {
  /** Lowercased tool name, or null when the raw context carried no `Tool:` prefix. */
  tool: string | null;
  /** Lowercased tokens of the whole command, separators included as their own tokens. */
  tokens: string[];
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

/**
 * THE LESSON THE CONTEXT BOUNDS LEFT BEHIND, kept because the next thing that matches an action
 * will be tempted by the same shortcut. Nothing in this module reads an intercepted action any
 * more — `clampActionContext` and its `MAX_CONTEXT_BYTES` refusal threshold went with the matcher
 * that consumed them — so this is a constraint on future code, not a description of present code.
 *
 * MATCHING MUST ALWAYS BE OVER THE FULL CONTEXT. It was learned twice here: first a 512-TOKEN cap,
 * then a 64KiB BYTE cap, the same bug at two thresholds. Matching ran on a prefix, so a command
 * long enough to push its dangerous part past the cutoff was never compared against anything and
 * the answer came back SILENT. Silence means "no rule governs this action". Making it also mean "I
 * stopped looking" inverts it precisely where the input is most suspicious, and recording the
 * truncation beside it audits the inversion without preventing it. SILENCE MUST NEVER MEAN I GAVE
 * UP: a size bound belongs at a REFUSAL threshold — a third verdict a host maps to asking the human
 * — never at a matching bound. The cost was measured and is not the obstacle: a 64KiB context read
 * ~1ms and a 1MiB context ~16ms, nearly all of it reading the string, while matching 200 stages
 * against a 4,000-token context was 0.002ms.
 */

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
 * SINCE TRIGGER PATTERNS RETIRED there is no second side to agree with: this now folds case on the
 * tokenizer's output alone, for `parseActionContext`'s one surviving reader. It stays a named
 * function rather than an inline `.toLowerCase()` because the reason it exists — one normalization,
 * applied in one place, by one function — is the thing that would be lost first.
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
      return { tool: candidate.toLowerCase(), tokens: tokenizeCommand(text.slice(colon + 1)) };
    }
  }
  return { tool: null, tokens: tokenizeCommand(text) };
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
 * Derivation rows are append-only with no per-rule cap, so the aggregation is bounded here rather
 * than trusted to stay small; the query fetches one extra id as the truncation signal and the
 * mapper delivers at most this many plus `disputedParentsTruncated`.
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
  origin: StageOrigin;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// `assertNoUnacknowledgedDenies` AND ITS `acknowledgeBlockingRules` PARAMETER WERE REMOVED HERE
// (2026-08-22, owner ruling) — the plain record of the retreat, in the place the guard stood.
//
// WHAT IT DID: re-authoring a stage's trigger patterns would silently change what every blocking
// rule bound to that stage denies. The guard refused such a call unless the caller NAMED each live
// deny it was re-aiming — acknowledgement, never prohibition, so a human could still do it but only
// with the denies in front of them. It ran twice on purpose: once early in declare() for fast
// feedback, and once inside upsertStage's write transaction, which is what closed the window where
// a deny bound during the embed could be re-aimed by a call validated before it existed.
//
// WHY IT IS GONE: its only entry condition was a supplied `patterns`. With trigger patterns retired
// there is no act of re-aiming a gate at all — a stage is its name, a rule is bound to the stage —
// so the guard could never fire again. A guard that cannot fire is the APPEARANCE of protection,
// and leaving it standing would have told the next reader that this authority was still checked.
//
// WHAT IS GIVEN UP: nothing that is still reachable. The authority it protected (what a deny
// denies) is now changed only by rule-level acts — declaring the rule advisory, or letting a
// correction supersede it — each of which says plainly that the rule is changing.
//
// THE RELAY-SIDE TWIN SURVIVES: graftRows' Door 10 still refuses a pattern change arriving from a
// peer, because an OLD peer can still send one. See its own comment for when it becomes retirable.
// ════════════════════════════════════════════════════════════════════════════════════════════════

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

/**
 * Create the stage if it does not exist. An EXISTING stage is returned untouched.
 *
 * THERE IS NO UPDATE BRANCH ANY MORE, and that is the shape of the whole registry now: a stage is
 * its NAME, and trigger patterns were the only mutable thing it carried (see the module header's
 * retreat record). "A correction landing on an action with no stage IS the stage's creation" is now
 * the entirety of this function rather than its first half.
 *
 * The schema still calls `origin` a mutable column for convergence purposes because a GRAFT can
 * still change it. No LOCAL path does.
 */
export function upsertStage(deps: GateDeps, input: UpsertStageInput): StageRow {
  const { db } = deps;
  const existing = findStage(db, input.stage);
  if (existing) return existing;

  // NEW STAGE. STAGE_NAME_MAX_CHARS is enforced HERE — the one place a stage name is ever minted —
  // so every creation surface (memory_store's rule capture, memory_declare's stage/rule species)
  // inherits the bound for free, and stage_lookup's own input cap can reference the SAME constant
  // with the guarantee that anything actually storable stays name-lookupable (review fix: the two
  // ends had drifted, lookup capped at 500 while creation stayed unbounded). A NAMED REFUSAL, not a
  // silent truncation — a name this long was never a "moment" in the design's sense; that content
  // belongs in the rule's own content or reason, not in the address.
  const normalizedName = normalizeStageName(input.stage);
  if (normalizedName.length > STAGE_NAME_MAX_CHARS) {
    throw new Error(
      `a stage name may be at most ${STAGE_NAME_MAX_CHARS} characters (got ${normalizedName.length}): ` +
        `stage names are short, human-readable identifiers for a moment ("git force push", "opening a ` +
        `PR"), not a command or a paragraph — put that in the rule's own content or reason.`,
    );
  }

  const syncAt = deps.nextSyncTimestamp();
  const row: StageRow = {
    id: deps.newId(),
    name: normalizedName,
    // THE TOMBSTONE, WRITTEN DELIBERATELY. See RETIRED_TRIGGER_PATTERNS: naming this column in the
    // INSERT is what keeps stage creation working on a store the previous release wrote.
    trigger_patterns: RETIRED_TRIGGER_PATTERNS,
    origin: input.origin,
    created_at: syncAt,
    sync_updated_at: syncAt,
    sync_revision: 0,
    sync_writer: deps.syncDeviceId,
  };
  db.prepare(
    `INSERT INTO stages (id, name, trigger_patterns, origin, created_at, sync_updated_at,
                         sync_revision, sync_writer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.name, row.trigger_patterns, row.origin,
    row.created_at, row.sync_updated_at, row.sync_revision, row.sync_writer,
  );
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
      "a blocking rule's `reason` must be ONE LINE: it is delivered as the rule's own explanation " +
        "of a refusal, so a line break makes the rule appear to say something nobody wrote. Received " +
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
  return { row, previousSeverity, downgradedFromBlocking };
}

// ---- the gate ---------------------------------------------------------------

/**
 * Does this stored reason amount to no reason at all?
 *
 * ONE DEFINITION, shared by the gate, the curation view and the stats, because a disclosure that
 * three surfaces compute differently is worse than one they all omit. `bindRule` normalizes a blank
 * to NULL on the way in, so locally these are the same question — but a relayed row is written
 * straight through by graft and can arrive carrying "   ", and a whitespace reason renders as a
 * blank line under the deny rather than as an answer.
 */
export function hasNoReason(reason: unknown): boolean {
  // TOTAL OVER PERSISTED VALUES, and that is the load-bearing half. SQLite stores whatever a writer
  // hands the column, so a malformed peer — or an older build, or a hand-edited row — can leave a
  // NUMBER in `reason`. The typed signature says string, the runtime value is not, and `.trim()`
  // threw: a matching gate query and a gate-stats read both blew up, so the rule's deny stopped
  // being delivered at all. Every other defect this module guards against is a deny that
  // misinforms; this was a deny that VANISHES with an exception, which is the one failure a gate
  // must never have.
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
 * ADMIN"` was storable and copied verbatim into the gate response — a host rendering the
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
   * THE CIRCLE THIS RULE IS HOMED IN — present ONLY when that is not the circle that asked.
   *
   * OMITTED IN THE ORDINARY CASE, and absence is a positive statement, not a gap: delivery already
   * requires `b.circle` to equal the asking circle (or the breadth marker), and every write path
   * that moves a rule's local circle keeps `rule_bindings.circle` in step with its concept's — see
   * `RULE_LIVENESS_WHERE`'s own comment. So for an ordinary binding the home IS the circle asked
   * about, and a field restating it on every rule of every lookup would be the resident cost with
   * none of the signal — the same discipline `projectedFromPrincipleId` and `parentDisputed` are
   * held to, for the same reason.
   *
   * COMPARED AGAINST THE ASKING CIRCLE, NEVER INFERRED FROM "is this a breadth binding". Breadth is
   * the only binding ALLOWED to diverge from its concept's circle, but that is an invariant of the
   * local write paths, and this read also serves rows grafted from a peer. Computing the field from
   * the two actual values makes a row that broke the invariant SAY so; deriving it from the breadth
   * marker would encode the invariant as a premise and hide exactly the row worth seeing.
   *
   * DECLARED HERE, NOT ON `StageLookupRule`: this is provenance, not the capability payload. A
   * cross-circle rule arriving byte-identical to a local one is the same defect on any future
   * always-on delivery path, which is precisely what `GateRule` is kept separate to serve.
   */
  homeCircle?: string;
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
   * LIVE PATH ONLY. `status` is live state: this flag is computed at the moment of delivery and
   * never cached, because a frozen copy would keep announcing doubt after the human resolved it
   * (or, worse, stay silent after they opened it).
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

/**
 * `stageLookup`'s own delivery shape: everything `GateRule` carries, plus the capability invocation
 * payload. A distinct type rather than a widened `GateRule` (design directive): the body is paid
 * for HERE because this is agent-initiated pull at the moment of need ("capabilities are content
 * too — and the payload is the invocation, not a description"), and `GateRule` stays the shape any
 * future always-on delivery can use without carrying content it never asked for.
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
   * this call is a lookup against it, not a search; a fuzzy or embedding matcher here is out of
   * scope by design.
   *
   * REACHABILITY IS A PROPERTY OF THE RULE, NOT OF ANY ADDRESSING (doctrine, ruled — the surviving
   * half). This lookup resolves by NAME/id against the stage registry, so a rule bound to this
   * stage — including a blocking one — stays reachable here until the RULE itself is withdrawn,
   * downgraded, or superseded, or the stage's own rules all die (stage retirement/inertness). No
   * other act can take it away. The doctrine's other half was about re-aiming a stage's TRIGGER
   * PATTERNS, and it went with them (2026-08-22 — see this module's own retreat record): there is
   * no addressing left to re-aim, and the write-side guard this note used to point at
   * (`assertPatternReauthoringAcknowledged`, engine.ts) was removed with the act it governed.
   */
  stage: string;
  /** Locality: only rules whose concept lives in this circle are delivered. */
  circle: string;
  /**
   * WHICH MODEL IS ASKING — the mechanism behind "a new model retires the old model's compensations
   * automatically" (design of record, *Nothing waits on scheduled review*).
   *
   * An `agent`-scoped rule is a compensation for ONE model's failure habits. Delivering it to a
   * different model is the shackle risk the scope split exists to prevent: the next, better model
   * inherits the last one's defects as instructions. So when this is supplied, agent-scoped rules
   * are delivered only for their own model tag; `domain` rules (true for a perfect agent) always
   * are.
   *
   * OMITTED means every agent-scoped rule is still delivered. That is deliberate backward
   * compatibility, not a default policy — a caller that does not know which model it is must not
   * have its rules silently disappear.
   *
   * FILTERING IS NOT RETIREMENT. Nothing here retires anything: mismatched rules stop being
   * DELIVERED and show up in `gateCoverage().retirementCandidates` for curation to act on. Inventing
   * a model-change detector that retires rules on its own would be a scheduled-review mechanism in
   * disguise, which the design rules out.
   */
  runtimeModelTag?: string;
}

export interface StageLookupResult {
  /**
   * True when the named stage exists in the registry — a HIT, whether or not it delivered rules.
   * False = a MISS (no such stage), never conflated with a stage-hit-no-rules: `rules: []` means
   * two different things depending on `matched`. A stage that exists and binds nothing in this
   * circle is the projection hook ("stage X, no rules — reason from the skeleton"); a name that
   * resolves to no stage at all is the agent being off the map. Collapsing the two would delete the
   * signal the projection slice consumes.
   *
   * NIT: a HIT can reach stage-hit-no-rules for TWO different reasons, and this field alone does
   * not distinguish them — the stage genuinely has no rules ANYWHERE, or it has rules bound in
   * OTHER circles but none in the caller's own (stages are store-global; rule bindings are
   * circle-scoped — see the module header's "WHY STAGES ARE STORE-GLOBAL" note). Both render as
   * `matched: true, rules: []` here, which is correct (this circle's gate truly delivers nothing),
   * but a curation reader asking "does anything govern this stage at all" needs `gateCoverage`/the
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
  /** The rule concept's full body. The gate's own mapper (toGateRule) never reads this field;
   *  only stageLookup's (toStageLookupRule) does — selected unconditionally here rather than by a
   *  second query, because the only thing that differs between the two matchers' delivery is which
   *  fields their own mapper reads off the SAME row, and the chokepoint predicate below must not
   *  have two copies to keep in sync. */
  /**
   * The rule concept's full body, or `null` when the caller asked `rulesForStages` NOT to select
   * it (`withBody: false`). The gate's own mapper (toGateRule) never reads this field regardless
   * of what it holds; only stageLookup's (toStageLookupRule) does, which is why ONLY that caller
   * passes `withBody: true`. See rulesForStages' own comment for why this is a column-selection
   * flag rather than always fetching it and discarding it in the mapper.
   */
  body: string | null;
  created_at: number;
  /** The rule CONCEPT's own circle (`c.circle`) — never the binding's. Carried so the mapper can
   *  compare it with the circle that asked; see `GateRule.homeCircle` for why the comparison is on
   *  these two values rather than on the binding's breadth marker. */
  home_circle: string;
  parent_concept_id: string | null;
  /** 1 when any locally resolved derivation parent is a disputed, still-member principle. */
  parent_disputed: number;
  /** Comma-joined disputed-member-parent ids, capped and lexically ordered; NULL when the caller
   *  did not ask for the aggregation (`withDisputedParentIds: false`) and when there are none. */
  disputed_parent_ids: string | null;
}

/**
 * THE one disputed-member-parent predicate — shared verbatim by the flag's EXISTS and the id
 * aggregation beside it (rulesForStages), so the two can never answer different questions. Status
 * first: the verdict subquery only runs for rows already disputed.
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
          -- entirely rather than hiding every agent rule — see StageLookupOptions.runtimeModelTag.
          AND (b.scope != 'agent' OR ? IS NULL OR b.model_tag = ?)
          AND NOT EXISTS (
            SELECT 1 FROM lifecycle_edges e
             WHERE e.family = 'supersession' AND e.src_concept_id = b.concept_id
          )`;

/**
 * THE shared rules-for-stages selection — every way a rule is fully DELIVERED passes through here.
 * `evaluateStageLookup` is its only caller today; it was factored out while there were two, and it
 * stays one function so a second delivery path cannot arrive with its own copy of this SQL and
 * silently drift from this one. Liveness (`RULE_LIVENESS_WHERE`), circle scope, model-tag filter,
 * parent-principle lookup and ordering (blocking first, then birth order) are decided here and
 * nowhere else.
 *
 * THE FLAGS AND BOUNDS BELOW ARE ALL OPT-IN, and every one of them defaults to the cheaper answer.
 * That shape is deliberate and outlived the caller it was built for: an always-on delivery path
 * paid these costs on EVERY intercepted action, so each was made something a caller asks for rather
 * than something the query always does. Keeping the defaults cheap is what lets a future always-on
 * caller reuse this query as-is instead of writing a leaner second copy.
 *
 * `withBody` — SELECT `c.body` or not. Omitting it skips fetching and marshalling a concept's full
 * body across the sqlite boundary, the same class of waste `liveStageIndex`'s narrow projection
 * already exists to avoid ("a narrower SELECT is the whole optimization; there is no cache, so
 * there is no invalidation to get wrong"). `evaluateStageLookup` passes `true`, because
 * `toStageLookupRule` reads the field; `toGateRule` never does.
 *
 * `limit`/`bodyMaxChars`/`reasonMaxChars` — OPTIONAL SQL-level bounds (review fix — Codex round 2,
 * extended round 3 to cover `reason`). All omitted is BYTE-IDENTICAL to this function's
 * pre-review-round-2 behavior: no LIMIT clause, `c.body`/`b.reason` selected whole. Only
 * `evaluateStageLookup` passes them, at
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
              -- AFTER both placeholder-bearing columns (reason, body) ON PURPOSE. This one binds
              -- nothing, so it cannot shift the param order by itself — but the param array above
              -- is assembled by TEXTUAL COLUMN ORDER, and the last edit to this SELECT list swapped
              -- two caps precisely by changing which placeholder came first. Appending after them
              -- keeps that reading true for whoever adds the next column.
              --
              -- c.circle, NOT b.circle: the concept's home is the question (GateRule.homeCircle),
              -- and the binding's circle is already pinned by the delivery predicate to either the
              -- asking circle or the breadth marker, so it could never answer it.
              c.circle AS home_circle,
              -- The parent principle, when there is one, as a CORRELATED SCALAR rather than a
              -- join: a rule may carry several derivation edges, and a join would multiply the
              -- gate's own rows to report a field. Scalar subquery = one row per rule, always,
              -- and one round trip for the whole answer instead of one per delivered rule.
              (SELECT p.src_concept_id FROM lifecycle_edges p
                WHERE p.family = 'derivation' AND p.dst_concept_id = b.concept_id
                ORDER BY p.created_at ASC, p.id ASC LIMIT 1) AS parent_concept_id,
              -- DELIVERY-TIME DOUBT DISCLOSURE (slice 5-B): ANY derivation parent principle
              -- currently disputed, not only the earliest parent selected for stable display above.
              -- MEMBERS ONLY (review fix — PR #112 round 5): the latest-ratification check is the
              -- same latest-wins read the impeachment WRITE side applies — without it, a disputed
              -- parent the human then REJECTED kept appearing as a pending mediation. The EXISTS
              -- short-circuits at the first qualifying row, and its per-edge cost is one status
              -- probe (the verdict subquery runs only on rows the status filter already passed),
              -- so the FLAG costs no aggregation, no DISTINCT, no temp B-tree (review fix — PR #112
              -- round 8: the previous shape bounded the RESULT but not the WORK). That is what
              -- makes it affordable to select unconditionally, unlike the ids below.
              EXISTS (
                SELECT 1 FROM lifecycle_edges p
                JOIN concepts pc ON pc.id = p.src_concept_id
                WHERE ${DISPUTED_MEMBER_PARENT_WHERE}
              ) AS parent_disputed,
              -- THE IDS, ONLY WHEN ASKED FOR (review fixes — PR #112 rounds 2, 7 and 8): the
              -- identity aggregation (DISTINCT + ORDER BY + LIMIT = temp B-tree over the rule's
              -- whole parent set) exists for the RECOVERY path, which is an agent affordance —
              -- stage_lookup, budget-fitted and latency-tolerant. A caller that renders only title
              -- and reason has no use for these ids and should not buy the temp B-tree to get
              -- them, so the default selects literal NULL and the flag is the same caller split
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
 * `SELECT DISTINCT s.name` query: no trigger_patterns, no origin, no clocks,
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

/**
 * The gate's own delivery shape: title + reason, NEVER the body — see GateRule's own comment.
 *
 * `askingCircle` is a PARAMETER because the row cannot supply it: `b.circle` holds `'*'` for a
 * breadth binding and `c.circle` is the rule's answer, not the caller's question. Only the caller
 * knows which circle delivery was scoped to, so only the caller can say when the two differ.
 */
function toGateRule(row: BindingJoinRow, askingCircle: string): GateRule {
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
    // COMPUTED FROM WHATEVER row.reason HOLDS, which is the FULL value when the caller passed no
    // `reasonMaxChars` but may be substr'd to STAGE_LOOKUP_REASON_CAP + 1 chars when it did, as
    // evaluateStageLookup does (review fix — Codex round 3: reason's own SQL-retrieval bound). For
    // every REALISTIC reason (under the cap, which every blocking reason already must be under —
    // one line rarely runs anywhere near 1 200 characters) this is IDENTICAL to computing it on
    // the full value: substr of a short string returns the whole string. The only way this could
    // differ is a reason LONGER than the cap whose first `CAP + 1` characters are ALL
    // whitespace-per-hasNoReason with real content beyond that boundary — a doubly-pathological
    // shape (long AND specifically front-loaded with nothing) with no realistic authoring path,
    // blocking or advisory. DELIBERATELY NOT chased with a SQL-side blank check instead: this
    // module already learned that lesson once (see hasNoReason's own "THE PREDICATE IS NOT IN THE
    // SQL" doctrine, and gateCoverage' `unexplainedDenies` comment) — SQLite's TRIM() and JS's
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
    // PRESENT ONLY WHEN THE HOME DIFFERS — see GateRule.homeCircle for why absence is the ordinary
    // case and why this reads the two circles rather than the binding's breadth marker.
    ...(row.home_circle !== askingCircle ? { homeCircle: row.home_circle } : {}),
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
function toStageLookupRule(row: BindingJoinRow, askingCircle: string): StageLookupRule {
  return { ...toGateRule(row, askingCircle), body: hasNoBody(row.body) ? null : row.body };
}

/**
 * WHAT MAKES A RULE LIVE, stated once here because `RULE_LIVENESS_WHERE` above is the only place it
 * is enforced and three exclusions are each load-bearing:
 *
 *   CIRCLE — a rule is an ordinary concept in an ordinary circle, and delivery is scoped to the
 *   asking circle exactly as sessions are. (Interpretive addition, flagged for review: the design
 *   says circles are "orthogonal locality, unchanged" but never states which locality delivery
 *   reads. Scoping to the caller's circle is the conservative reading — a store-global rule can be
 *   added when evidence demands one, whereas un-scoping later would silently start delivering every
 *   project's rules in every project.)
 *
 *   SUPERSESSION — a rule with an outgoing supersession lifecycle edge has been overturned. "The
 *   superseded rule is retained as history, never re-injected", and a lookup never returns two
 *   contradicting rules. The edge is the only thing that says so: the old concept stays active and
 *   searchable on purpose, because it is the impeachment evidence traveling up the parent edge.
 *
 *   STATUS — a retired concept governs nothing.
 *
 * ORDER is severity-blocking-first, then created_at, then id: a deny must be the first thing an
 * agent reads, and everything after it is stable so two machines with the same rules deliver the
 * same answer.
 */

/**
 * `*` is the breadth marker on a rule BINDING (BREADTH_CIRCLE's own comment), never a selectable
 * circle a QUERY can be scoped to — refused at every gate-query entrance (Codex round 6, item 2), one
 * shared message so the call sites cannot drift apart. `RULE_LIVENESS_WHERE`'s own
 * `(b.circle = ? OR b.circle = '*')` degenerates to matching ONLY global rules the instant `?`
 * itself is bound to '*' — both halves of the OR become
 * the identical clause — silently dropping every LOCAL rule the caller actually meant to ask about,
 * including a local DENY. Reachable only via a direct argument (a pre-breadth `MONET_CIRCLE=*` config,
 * or any caller passing '*' straight through): `resolveCircle` can never PRODUCE '*' from an ordinary
 * circle name post-migration (round 4, item 4 — no alias can ever hold '*' on either side once a
 * store has been through it), so this is not a resolution bug to fix upstream, it is an input this
 * layer must refuse outright rather than silently misinterpret. Called from evaluateStageLookup —
 * the exported `stageLookup` and MonetCore.stageLookup() both funnel through it, so checking here
 * covers every entrance.
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
 * NOT model-tag filtered, unlike the gate's and stageLookup's actual rule DELIVERY: the index is a
 * stable map ("recognizing which named moment you are in"), and making stage NAMES flicker with
 * whichever model happens to be running would defeat the one property recognition depends on —
 * that the map does not move under the agent. `liveStageNamesCapped`'s own `null` model-tag params
 * are exactly the gate's own documented meaning for an omitted runtime tag ("every agent-scoped
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
 * applied to a DIFFERENT bug this function shares with `gateCoverage`). `liveStageNamesCapped`/
 * `countLiveStages` (below) both embed `RULE_LIVENESS_WHERE` directly — the identical collapsed-OR
 * predicate (`assertQueryableCircle`'s own doc comment) that degenerates to "global rules only" the
 * instant `circle` itself is `'*'`. `evaluateStageLookup`'s own call into this function was already
 * safe (guarded at ITS OWN entrance) — but `MonetCore.prewarm()` reaches this function after only
 * `resolveCircle` (which, by design — see `assertQueryableCircle`'s own comment — passes an explicit
 * `'*'` straight through unchanged). An unguarded `prewarm('*')` therefore silently returned a stage
 * index missing every stage whose only live rule was purely LOCAL — the exact "curation silently
 * omits" failure class `gateCoverage`' own fix (this same round) closes one surface over. Guarded here,
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
 * THE RECOGNIZED MATCHER — A PURE READ, END TO END. The agent NAMES a stage, so one lookup resolves
 * to at most one stage: no trigger-pattern fan-out, and therefore no plural `stages` to track.
 *
 * NOTHING IS WRITTEN HERE, and that is now a property of the function rather than a promise about
 * one. This used to return the verdict alongside a `PendingGateWrites` describing what the read
 * still owed the store — a `gate_events` row and a stage's first-fire `verified` flag — and the
 * caller committed it in a separate `immediateTransaction` so a refused DEFERRED-to-write upgrade
 * could not make a LOOKUP throw. Both writes are gone (the governed moment replaced the event row;
 * `verified` was unmeasurable once nothing matched an action), so the payload described nothing and
 * the second transaction committed nothing. It was not free: an empty `immediateTransaction` still
 * issues `BEGIN IMMEDIATE`, which holds the store's write lock for the length of the no-op —
 * measured, a concurrent writer on a second connection takes SQLITE_BUSY while it is open. A read
 * path that delivers rules has no business taking the write lock, so the seam was removed rather
 * than kept warm for a write nobody has named. Reinstating one means reinstating the split too, for
 * the reason above.
 */
export function evaluateStageLookup(db: StoragePort, opts: StageLookupOptions): StageLookupResult {
  assertQueryableCircle(opts.circle);
  const stage = findStage(db, opts.stage);

  if (!stage) {
    // THE MISS CARRIES THE LIVE INDEX, unconditionally: it is part of the READ result — a
    // misremembered name self-repairs in one round trip — never instrumentation.
    const stageIndexResult = liveStageIndex(db, opts.circle);
    return {
      matched: false, stage: null, rules: [],
      stageIndex: stageIndexResult.names,
      ...(stageIndexResult.total !== undefined ? { stageIndexTotal: stageIndexResult.total } : {}),
    };
  }

  // THE ONE DELIVERY CHOKEPOINT: liveness, circle, model-tag filter, parent principle —
  // rulesForStages. withBody: true — this is the ONLY caller that needs it, because
  // toStageLookupRule is the only mapper that reads it (the capability invocation payload).
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
    // This path pays for the disputed-parent ids (PR #112 round 8) — see rulesForStages' own
    // column comment for why the aggregation is opt-in rather than always selected.
    true,
  );
  const capped = primaryRows.length > STAGE_LOOKUP_RULES_CAP;
  const shownRows = capped ? primaryRows.slice(0, STAGE_LOOKUP_RULES_CAP) : primaryRows;
  // The SAME circle handed to `rulesForStages` above — delivery scope and provenance comparison
  // must read one value, or a rule could be selected as local and then labelled foreign.
  const rules = shownRows.map((row) => toStageLookupRule(row, opts.circle));

  // Only when the primary fetch actually hit the cap: an EXACT total (one indexed COUNT(*), a cost
  // paid only in this — expected rare — case) and a compact outline of the rules the primary fetch
  // never retrieved at all, so the wire's recovery ladder can still name them (see
  // StageLookupResult's own comment on `rulesTotal`/`rulesOutline` for why `rules.length` alone can
  // no longer be trusted as "the whole truth" once retrieval itself is bounded).
  const rulesTotal = capped ? countLiveRulesForStage(db, stage.id, opts.circle, opts.runtimeModelTag) : undefined;
  const rulesOutline = capped
    ? ruleOutlineForStage(db, stage.id, opts.circle, opts.runtimeModelTag, STAGE_LOOKUP_RULES_CAP, STAGE_LOOKUP_OUTLINE_CAP)
    : undefined;

  return {
    matched: true,
    stage: { id: stage.id, name: stage.name },
    rules,
    ...(rulesTotal !== undefined ? { rulesTotal } : {}),
    ...(rulesOutline !== undefined ? { rulesOutline } : {}),
  };
}

/**
 * THE RECOGNIZED MATCHER. The agent NAMES a stage — no trigger-pattern matching, no fuzzy or
 * embedding search: recognition is the agent's own act against the resident stage index, and this
 * is a lookup against it. Delivers through the one chokepoint (liveness, circle scope, model-tag
 * filtering, parent principle) plus each rule's `body`, the capability invocation, spent here
 * because this is agent-initiated pull at the moment of need rather than an always-on injection.
 *
 * ADVISORY-ONLY BY DESIGN: severity is delivered as information — a blocking rule appears with its
 * reason, exactly like an advisory one — and never enforced here. Nothing about calling this can
 * refuse an action; refusal is the host's to perform.
 *
 * A stage with zero live rules is a HIT with `rules: []` (the stage-hit-no-rules signal — see
 * `StageLookupResult.matched` for why this is never conflated with a miss). A miss (no such stage)
 * carries the live stage index so a misremembered name self-repairs in one round trip.
 *
 * ONE READ TRANSACTION, WHICH IS THE WHOLE OF IT (review fix — Codex round 4, item 3, and now the
 * only thing that fix's split still protects). Before it, this function — the path a caller with no
 * transaction of its own actually runs — issued `evaluateStageLookup`'s several reads (findStage,
 * then rulesForStages, then, only when capped, countLiveRulesForStage/ruleOutlineForStage; or on a
 * miss liveStageNamesCapped/countLiveStages) as separate, unwrapped statements. A concurrent writer
 * — the SUPPORTED MCP+CLI topology storage.ts's WAL+busy_timeout setup exists for — landing a rule
 * bind/retire BETWEEN two of them could make `rulesTotal`/`rulesOutline`/`stageIndexTotal` describe
 * a DIFFERENT instant than the `rules`/`stageIndex` prefix already returned: an honest-looking total
 * for a snapshot that never existed. The DEFERRED transaction is what closes that window.
 *
 * NO WRITE TRANSACTION FOLLOWS IT any more — see `evaluateStageLookup` for what was there, why it
 * was a separate `immediateTransaction`, and why an empty one was worse than none.
 * MonetCore.stageLookup() holds the identical shape on `this.db`.
 */
export function stageLookup(db: StoragePort, opts: StageLookupOptions): StageLookupResult {
  return db.transaction(() => evaluateStageLookup(db, opts))();
}

// ---- instrumentation readback -----------------------------------------------

/**
 * WHAT THE GATE'S REGISTRY CAN SAY ABOUT ITSELF — the curation lists, and nothing that counts acts.
 *
 * THIS USED TO CARRY RATES TOO (`fires`, `silences`, `overflows`, `delivered`, `byStage`,
 * `byStageRead`), all read from a `gate_events` row per intercepted action. That table is gone: a
 * verdict row could not name the rules that fired, could not be joined back to the act that
 * prompted it, and could not record an interception that declined to evaluate at all. The governed
 * moment replaced it, and the rates did NOT survive the move: `momentCounts` reports populations
 * only. Every rate came off on 2026-08-22 once nothing wrote the columns behind them, `overflows`'
 * successor `ungoverned` with them for restating `total` (see `MomentCounts`). The read dimension
 * is answered by `momentRuleReadsByStage` against this registry.
 *
 * WHAT REMAINS IS EVERYTHING THAT READS `stages` AND `rule_bindings` — facts about what is
 * DECLARED, not about what happened. Those never depended on the event table and are unchanged.
 *
 * `unverifiedPatterns` IS GONE TOO, with the mechanical matcher that fed it. It listed stages whose
 * `verified` flag was still 0 — "these patterns have never matched a real action". Nothing matches
 * an action any more, so every stage would have qualified, forever: a not-known rendered as a
 * verdict.
 *
 * `malformedPatterns` FOLLOWED IT ON 2026-08-22, for the same fault one step later. It listed stages
 * whose stored `trigger_patterns` would not parse, and it outlived the matcher because "is this row
 * readable" was still answerable. Retiring trigger patterns ended that: every row this build writes
 * holds `RETIRED_TRIGGER_PATTERNS` and no reader parses any of them, so the list could only ever
 * report on a column nothing writes — the same not-known-rendered-as-a-verdict, one column over.
 */
export interface GateCoverage {
  retirementCandidates: Array<{ conceptId: string; title: string; modelTag: string; stageName: string }>;
  /** True number omitted after the source cap; absent when the list is complete. */
  retirementCandidatesOmitted?: number;
  unexplainedDenies: Array<{ conceptId: string; title: string; stageName: string }>;
  unexplainedDeniesOmitted?: number;
  /**
   * Every stage with a live rule bound in this circle.
   *
   * THE DENOMINATOR FOR THE READ DIMENSION, and the reason it is here rather than derived by a
   * caller: "which stages has nobody ever looked up" is this list minus the stages agents have
   * actually named (momentRuleReadsByStage). Scoped to stages with something live to deliver, so an empty
   * registry entry cannot manufacture a finding.
   */
  liveStages: Array<{ stageId: string; stageName: string }>;
}

export interface GateCoverageOptions {
  circle: string;
  now?: number;
  /** The model now running. Rules tagged for a different one are reported as retirement candidates. */
  runtimeModelTag?: string;
  /** Optional curation-surface cap; omit for the full diagnostic lists used by CLI/dashboard consumers. */
  exceptionLimit?: number;
}

export function gateCoverage(db: StoragePort, opts: GateCoverageOptions): GateCoverage {
  // ROUND-6'S OWN MISSED ENTRANCE (post-merge review round, P2). `retirementCandidates` and
  // `unexplainedDenies` (below) both embed `(b.circle = ? OR b.circle = '${BREADTH_CIRCLE}')` —
  // RULE_LIVENESS_WHERE's own collapsed-OR shape, restated inline at each — which degenerates to
  // "global rules only" the instant `opts.circle` itself is `'*'`, per `assertQueryableCircle`'s own
  // doc comment. Round 6 swept every caller of `RULE_LIVENESS_WHERE` there was at the time (the
  // always-on fire path, since removed, and `evaluateStageLookup`) — but `gateCoverage` was
  // written with its own two
  // hand-rolled copies of the same predicate rather than the shared constant, so it never appeared
  // in that sweep's own search surface. An unguarded `gateCoverage('*')` silently reported ZERO local
  // retirement candidates and ZERO local unexplained denies for circle '*' — not an empty result
  // (nothing wrong), a WRONG one (curation blind to exactly the rules a human most needs to see).
  assertQueryableCircle(opts.circle);
  const now = opts.now ?? Date.now();
  // THE READ DIMENSION'S DENOMINATOR. Every stage with a live rule bound in this circle — the set
  // "which stages has nobody ever looked up" is computed against. Scoped by the shared liveness
  // predicate, so a registry entry with nothing bound to it in this circle cannot manufacture a
  // finding by having nothing to deliver.
  const liveStages = db
    .prepare(
      `SELECT s.id AS stageId, s.name AS stageName
         FROM stages s
        WHERE EXISTS (
                SELECT 1
                  FROM rule_bindings b
                  JOIN concepts c ON c.id = b.concept_id
                 WHERE b.stage_id = s.id AND ${RULE_LIVENESS_WHERE}
              )
        ORDER BY s.name ASC`,
    )
    .all(opts.circle, opts.runtimeModelTag ?? null, opts.runtimeModelTag ?? null) as GateCoverage["liveStages"];

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
      : [opts.runtimeModelTag, opts.circle])) as GateCoverage["retirementCandidates"]);
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
    .all(opts.circle) as Array<GateCoverage["unexplainedDenies"][number] & { reason: string | null }>)
    .filter((row) => hasNoReason(row.reason))
    .map(({ conceptId, title, stageName }) => ({ conceptId, title, stageName }));
  const unexplainedDenies = exceptionLimit === undefined
    ? unexplainedDeniesAll
    : unexplainedDeniesAll.slice(0, exceptionLimit);
  return {
    liveStages,
    retirementCandidates,
    ...(retirementCandidatesOmitted > 0 ? { retirementCandidatesOmitted } : {}),
    // Deliberately NOT filtered by runtime model tag: a compensation for another model still holds
    // deny power the moment that model runs, and a count that hid it would report zero on exactly
    // the machine best placed to repair it. Same liveness predicate the gate uses.
    // THE PREDICATE IS NOT IN THE SQL, on purpose. It was, as `TRIM(b.reason) = ''` — and SQLite's
    // one-argument TRIM strips ORDINARY SPACES ONLY, while `hasNoReason` uses JS trim() and catches
    // tabs and newlines. A peer relaying "\t\n" therefore produced `reasonMissing: true` on the
    // delivered rule while this list stayed EMPTY and the overview's repair section stayed
    // suppressed: a bare deny firing with nothing telling the human it exists. That
    // is exactly the cross-surface disagreement `hasNoReason` was introduced to prevent, reappearing
    // in the one surface that had not been made to share it.
    //
    // So SQL narrows to the live denies and TypeScript asks the question — ONE implementation, no
    // equivalence to maintain between two dialects' idea of whitespace. The scan is bounded by the
    // blocking population — a strict subset of the live rules the gate already walks — so this is
    // not a new order of work.
    unexplainedDenies,
    ...(unexplainedDeniesAll.length > unexplainedDenies.length
      ? { unexplainedDeniesOmitted: unexplainedDeniesAll.length - unexplainedDenies.length }
      : {}),
  };
}
