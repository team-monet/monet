import type { StoragePort } from "./storage";
import type { MomentAnswer, MomentDisposition, MomentRun, MomentSpoolRecord } from "./moment-spool";
import { readMomentSpool, spoolAnswer, spoolAsk } from "./moment-spool";

/**
 * The moment ledger — the folded side of the governed-moment record.
 *
 * THE SPOOL IS THE TRUTH; THIS IS THE INDEX OF IT. Writers append to a file because an append is the
 * only sink that never blocks and cannot silently drop (see moment-spool.ts). Nothing can be QUERIED
 * from an append-only file, so the fold transcribes it into sqlite, one row per moment, accumulating
 * that moment's life. The direction is one-way: the ledger is derived, and re-deriving it from the
 * spool is always legal.
 *
 * THE FOLD RUNS ON DEMAND, NOT ON A TIMER. An answer normally arrives before its moment has been
 * folded, so anything that reads or writes against a moment folds first — every entry point in this
 * file does. It is cursor-based and incremental, so a fold that has nothing to do costs one stat and
 * one read of zero bytes. An interval, if one is ever added, is a backstop against unbounded spool
 * growth when nobody is asking; it is never the mechanism.
 *
 * RE-FOLDING IS A NO-OP, BY CONSTRUCTION AND NOT BY LUCK. Every apply is keyed on `momentId` plus
 * field identity and is first-write-wins, so applying the same record twice changes nothing and
 * applying records in any order gives the same ledger. That is what lets any range be re-read
 * safely — after a crash between applying records and storing the cursor, or when two processes
 * fold the same store and one stores an older offset than the other.
 *
 * NOTHING EVER SHORTENS THE SPOOL, AND NO MECHANISM HERE RECLAIMS ITS SPACE. An append can land
 * between "read to EOF" and any rewrite of the file, and that record would be lost — which breaks
 * the completeness the sequence exists to prove. Appenders cannot be made to wait for a rewrite
 * either: an interceptor that blocks on a lock is an interceptor on the critical path, which this
 * substrate may not have. So the cursor advances and the file is left alone.
 *
 * Growth is therefore unbounded in principle. It is left that way ON PURPOSE rather than by
 * oversight: no real spool's growth has been measured, so any reclamation threshold would govern a
 * space nobody has measured, and folding on demand keeps the unfolded region near-empty in practice.
 * When growth is real, the measurement that shows it is the one that should set the threshold.
 *
 * NOT KNOWN IS NOT A VERDICT. Every column the interceptor writes is nullable, and NULL means "not
 * observed" — never "no stage", "no rules", or "no session". The values that mean something are
 * written explicitly: `rule_ids = '[]'` is "nothing was bound", `disposition = 'silent'` is "nothing
 * fired", and `opened = 0` is "this moment was attached to but never seen at interception". A schema
 * that cannot say "unavailable" reports its own blind spots as findings.
 *
 * LOCAL AND UNSYNCED. These tables are absent from the sync envelope (`sync-types.ts`) for the same
 * reason `gate_events` is: replicating a local action stream merges two machines' timelines and
 * makes every rate computed from it a lie. `action_rendering` is the privacy-sensitive column here —
 * it holds a bounded rendering of a real command or prompt — and it is covered automatically by the
 * schema-driven scrub closure, which walks every TEXT column at runtime rather than enumerating
 * columns by name.
 */

/**
 * Every table the ledger owns. `IF NOT EXISTS` throughout, so `createMomentTables` is idempotent and
 * safe to call on every fold.
 *
 * NO SECONDARY INDEXES SHIP HERE, deliberately. Nothing queries these tables by anything but their
 * primary keys yet, and this repository's own history says an index added on intuition is the wrong
 * move — the one index on `gate_events` that does exist was added only after its cost was measured
 * over a synthetic store at three sizes. When a real read exists, measure it and add the index that
 * read needs.
 */
export const MOMENT_SCHEMA_SQL = `
  /*
   * THE LEDGER. One row per governed moment, accumulating that moment's life.
   *
   * moment_id is TEXT and comes from the interceptor, never from sqlite. The agent references a
   * moment id before the database has seen the moment — it travels out with a delivered rule and
   * comes back on a read, an ask and an answer — so an autoincrement key could not be this column.
   *
   * opened DISTINGUISHES A MOMENT FROM ITS DEBRIS. 1 means the interception record itself was
   * folded. 0 means only attachments were seen: something read a rule, or returned an outcome,
   * against a moment whose interception record never landed. That row is not a governed moment and
   * must never be counted as one — every field the interceptor writes is NULL on it, which is the
   * record saying "not observed" rather than inventing a verdict. It is also not discarded, because
   * an attachment with no interception is itself the finding.
   */
  CREATE TABLE IF NOT EXISTS governed_moments (
    moment_id TEXT PRIMARY KEY,
    opened INTEGER NOT NULL DEFAULT 0 CHECK (opened IN (0, 1)),
    -- Written at interception. NULL on every one of these means NOT OBSERVED.
    at TEXT,
    session_id TEXT,
    -- THE HOST'S ID FOR THE TOOL CALL, and the only thing that lets a separate PostToolUse process
    -- close this moment. NULL means there is no host tool call (a moment the store opened on
    -- itself) or the host did not supply one -- the docs type it nullable -- and either way the
    -- moment simply closes with its outcome never observed. It is a foreign key into the host's
    -- world, never this record's identity: see the spool's own field comment for why.
    tool_use_id TEXT,
    -- THE CIRCLE THIS MOMENT WAS GOVERNED UNDER. NULL when nothing resolved one, which is a real
    -- state rather than a default. Every count a person reads is scoped by this: the spool is shared
    -- at the home level, so one project's store folds every project's moments, and without a circle
    -- on the row an overview reported another project's activity as its own.
    circle TEXT,
    surface TEXT,
    action_sha256 TEXT,
    -- A bounded rendering of the real action. The most privacy-sensitive column in these tables;
    -- see the module header for why that is survivable.
    action_rendering TEXT,
    action_chars INTEGER,
    action_clipped INTEGER CHECK (action_clipped IS NULL OR action_clipped IN (0, 1)),
    stage_id TEXT,
    -- JSON array. '[]' is a VALUE — the gate looked and nothing was bound. NULL is NOT KNOWN —
    -- nothing evaluated this moment at all, which is what an 'ungoverned' disposition means.
    rule_ids TEXT,
    disposition TEXT CHECK (
      disposition IS NULL OR disposition IN ('blocked', 'advised', 'silent', 'ungoverned')
    ),
    delivered_rule_ids TEXT,
    -- JSON object of ruleId -> ISO timestamp. Per rule, because receipt is a property of one
    -- (moment, rule) pair; a count of reads over a count of deliveries is the ratio of two
    -- unrelated totals, which is the measurement this design replaces.
    rule_reads TEXT NOT NULL DEFAULT '{}',
    -- Written after the tool returns.
    --
    -- WHY A BLOCKED MOMENT NEVER GETS ONE, written here because this is the column whose NULL a
    -- reader has to explain, and because two surfaces below gate on it. The host's own lifecycle
    -- table gives PostToolUse as "After a tool call succeeds" and PostToolUseFailure as "After a
    -- tool call fails" (Claude Code hooks reference, https://code.claude.com/docs/en/hooks — the
    -- lifecycle table near the top; quoted by content rather than by line, since that page moves).
    -- A call the gate DENIED never ran, so neither event fires and this stays NULL forever.
    --
    -- THAT IS CORRECT, NOT A GAP. notAsked and momentsOwingAQuestion both require outcome_at,
    -- so a blocked moment never enters the ask backlog — and it should not: the action did not
    -- happen, so "did the action follow the rule?" has no referent. Enforcement already answered it.
    -- A FAILED call is the opposite case and does belong in the backlog: it ran, and whether it
    -- followed the rule is exactly as askable as for one that succeeded.
    outcome_at TEXT,
    outcome_sha256 TEXT,
    -- Whether the act SUCCEEDED. NULL is not observed — a store-side close has no host event behind
    -- it, and so does every row written before this column existed. The digest is identity, not
    -- meaning: without this, a command that landed and the same command the remote rejected are
    -- indistinguishable, including to a user being asked whether it followed the rule.
    outcome_status TEXT CHECK (outcome_status IS NULL OR outcome_status IN ('ok', 'failed')),
    -- Written when the agent asks, and when the user answers. asked_at NULL with a read and an
    -- outcome present is the 'not asked' state: an agent defect, not a queue.
    asked_at TEXT,
    answer TEXT CHECK (answer IS NULL OR answer IN ('followed', 'not-followed')),
    answered_at TEXT
  );
  -- The ONE index here, and it is not an intuition: every host-side outcome the fold resolves runs
  -- exactly this lookup, so the query exists and is named before the index is. Deliberately NOT
  -- unique -- nothing establishes that the host fires PreToolUse exactly once per tool_use_id, and
  -- a uniqueness claim this record cannot back would turn an unverified assumption into a fold that
  -- throws on real data.
  CREATE INDEX IF NOT EXISTS idx_governed_moments_tool_use
    ON governed_moments(tool_use_id) WHERE tool_use_id IS NOT NULL;

  /*
   * THE FOLD CURSOR. One byte offset into the spool, and nothing else.
   *
   * NOTHING GUARDS THE WRITE, because nothing needs to. A second folder racing this one has read an
   * overlapping range of the same append-only file and applied it idempotently, so whichever offset
   * lands is correct: a lower one costs a harmless re-read, and a higher one skips nothing, since
   * every byte below it has been folded by somebody. A guard would only be needed if some mechanism
   * could rewrite the file underneath a fold, and none exists — see the module header for why the
   * spool is never shortened.
   */
  CREATE TABLE IF NOT EXISTS moment_fold_cursor (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    byte_offset INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO moment_fold_cursor (singleton, byte_offset) VALUES (1, 0);

  /*
   * ONE ROW PER WRITER RUN — the state the completeness proof is computed from.
   *
   * writer_role NULL means the run-start record has not been folded, which is NOT the same as a run
   * with no role. It is the ordinary state for a moment or two, and a permanent one if the
   * run-start append is the one that failed.
   *
   * max_seq is the highest sequence number observed for the run. Everything at or below it that is
   * not recorded as a loss has been seen; everything above it has not been heard of yet, which is
   * the ordinary state of a live run and is never a gap.
   */
  CREATE TABLE IF NOT EXISTS moment_runs (
    run_id TEXT PRIMARY KEY,
    writer_role TEXT,
    started_at TEXT,
    max_seq INTEGER NOT NULL
  );

  /*
   * THE LOSS LEDGER — everything the record knows it is missing, in ONE table.
   *
   * Two kinds live here rather than in two tables because they are one question ("what did this
   * record fail to receive?") with one lifecycle: opened when the absence is observed, closed when
   * the missing thing turns up in a later pass, and reported by one query in between. A second
   * table beside this one would be a second shape for the same fact, and the first surface that
   * reads only one of them would under-report loss.
   *
   * 'sequence-gap' — AS RANGES. "run R is missing seq 41-43" is one row, which is both the shape the
   * question is asked in and the shape that has no pathological case: a single corrupt sequence
   * number cannot make the fold insert a billion rows. A gap is opened when a sequence number
   * arrives above max_seq + 1, and closed (split, if it lands inside a range) when the missing
   * number turns up later. Ranges never need merging: a new range always starts at max_seq + 1, and
   * max_seq is by definition a sequence number that WAS seen, so no two ranges can ever be adjacent.
   *
   * 'unobserved-interception' — AN OUTCOME WITH NO MOMENT, and the reason this table has two kinds
   * at all. A PreToolUse run is typically two records: its run-start and its interception. If the
   * interception append is swallowed, that run is merely SHORT — a hole is only visible when a
   * record follows it, and nothing follows the last one. The sequence is structurally blind to
   * exactly this loss. The orphan outcome its PostToolUse sibling wrote is then the only witness
   * that a governed moment happened at all, so discarding it would make the loss silent, which is
   * the one thing the completeness invariant exists to forbid.
   *
   * The outcome is HELD on the row rather than summarized, so that if the interception turns up in
   * a later pass the fold can close this entry AND apply the outcome it was holding. Nothing is
   * discarded and nothing is reconstructed.
   *
   * NO GRACE WINDOW, deliberately. An outcome is resolved against everything the pass has seen plus
   * everything already folded, and only what survives that becomes a row here. A time-based wait
   * before recording the loss would need a bound, and no measurement of a real spool exists that
   * could set one — an invented bound would govern a space nobody has measured.
   */
  CREATE TABLE IF NOT EXISTS moment_losses (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('sequence-gap', 'unobserved-interception')),
    -- 'sequence-gap' only.
    run_id TEXT,
    from_seq INTEGER,
    to_seq INTEGER,
    -- 'unobserved-interception' only: the tool call nothing was ever intercepted for, and the
    -- outcome record that proves it happened.
    tool_use_id TEXT,
    outcome_at TEXT,
    outcome_sha256 TEXT,
    -- Held with the rest of the orphan outcome, so closing this loss later recovers it in full.
    outcome_status TEXT,
    -- Each kind carries its OWN key and no other's, in the schema rather than by convention: a row
    -- that is half one kind and half the other is not a loss anybody can act on.
    CHECK ((kind = 'sequence-gap') = (run_id IS NOT NULL)),
    CHECK ((kind = 'unobserved-interception') = (tool_use_id IS NOT NULL))
  );
  -- One row per distinct absence, per kind. Partial, because each uniqueness claim is true only of
  -- the kind that owns those columns.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_moment_losses_gap
    ON moment_losses(run_id, from_seq) WHERE kind = 'sequence-gap';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_moment_losses_tool_use
    ON moment_losses(tool_use_id) WHERE kind = 'unobserved-interception';

  /*
   * EVERY READ, joined or not — the read-side twin of the moment ledger.
   *
   * TWO QUESTIONS, ONE ROW PER READ. 'moment_id IS NULL' counts the reads that could not be joined
   * — the health signal for "delivery names its moment", and if that number grows something has
   * stopped naming moments. 'named_stage_id' answers the other one: WHICH STAGES HAS NOBODY EVER
   * LOOKED UP. A declared stage that nobody ever asks for is indistinguishable from a quiet healthy
   * one until a surface can say so, and this column is the only thing that can.
   *
   * MINIMIZATION, for 'named_stage_id': consumed by the coverage surface, on the turn someone asks
   * which stages are never looked up; without it a stage nobody has ever asked for reads exactly
   * like a healthy quiet one. It reaches no model's context — this is a stored fact, not delivery.
   *
   * AN UNJOINABLE READ IS NOT A LOSS, and deliberately not in the loss table above. An orphan
   * outcome is evidence that an interception happened and its record was swallowed; a read with no
   * moment id never had a moment behind it at all — an agent reached stage_lookup from
   * agent_context, with no interception to name. Filing it as a loss would put a permanent,
   * never-closing entry in the loss ledger that looks like a defect and is not one.
   *
   * KEYED ON (run_id, seq) RATHER THAN COUNTED. A running total cannot survive this design: the
   * fold re-reads ranges routinely — a rewound cursor, a crash between applying and storing — and
   * an incremented counter would double-count every re-fold, turning the one number that is
   * supposed to detect a broken delivery into a number nobody can trust. The sequence coordinate is
   * unique per record, so INSERT OR IGNORE makes the count idempotent by construction.
   *
   * THE RULE ID AND THE TIMESTAMP ARE NOT HERE. For a joined read they already live on the
   * moment's own rule_reads column; for an unjoinable one they stay in the spool, which is never
   * shortened. No consumer has been named for them in this table.
   */
  CREATE TABLE IF NOT EXISTS moment_reads (
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    /** NULL when the read could not be joined to a moment. */
    moment_id TEXT,
    /** The stage the AGENT NAMED. Never the stage the gate matched — that is on the moment. */
    named_stage_id TEXT,
    -- The circle the lookup was scoped to. NULL when the writer did not record one.
    --
    -- HERE RATHER THAN JOINED FROM THE MOMENT, because a read does not always have a moment: a
    -- stage_lookup reached from agent_context names none. Joining through governed_moments to find
    -- a circle would silently drop those reads from every circle's coverage map.
    circle TEXT,
    PRIMARY KEY (run_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_moment_reads_named_stage
    ON moment_reads(named_stage_id) WHERE named_stage_id IS NOT NULL;
`;

/**
 * Creates every ledger table AND brings an existing one up to the current column set.
 *
 * WHY THE SECOND HALF EXISTS. `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already
 * exists, so for as long as this function was only the exec above, a column added to the schema
 * reached FRESH stores only. An existing store kept answering reads and threw on the first write
 * that named the new column — and the ask signal swallows its own failures by design, so it went
 * silently dark while `notAsked` kept accumulating. That is exactly the conflation the signal is
 * there to prevent, produced by the thing meant to prevent it.
 *
 * NOT ON THE `PRAGMA user_version` LADDER, DELIBERATELY — and this is the answer to the question a
 * reader is about to ask, written down so nobody re-litigates it. `engine.ts` carries a twelve-rung
 * ladder plus `MONET_SCHEMA_VERSION`, and it solves a different problem from this one.
 *
 * THE LADDER IS A PENDING-WORK QUEUE over a schema every store already has. Each rung reads
 * `user_version`, does a one-time backfill if the store is in range, and bumps. What proves it is a
 * queue rather than a shape declaration is that rungs are deliberately NOT climbed when the work
 * cannot be done safely: a graph-disabled open holds `user_version` at 0 to keep the graph backfill
 * slot free, and "a store whose caller never calls ensureEmbedderPin() keeps the backfill pending
 * indefinitely". The number records what a store still OWES.
 *
 * THESE TABLES OWE NOTHING AND MAY NOT EXIST AT ALL. `momentSpoolPath` is null by default, and with
 * it null nothing here is ever created — a store that never configured a spool has none of these
 * tables, which is the state most stores are in. They are created lazily, by the fold, long after
 * construction and possibly never; there is no construction-time instant for a rung to act at.
 * And the work itself is convergence, not backfill: `migrateMomentColumnsFrom` is idempotent and
 * derived from the schema, so it is correct to run on every touch and has no pending state a
 * version could remember.
 *
 * #61 SETTLED THE DECIDING RULE, in the commit that retired the source subsystem: "A rung only some
 * stores climb is not a rung. So every store climbs this one, unconditionally." A rung for these
 * tables would be climbed by only some stores BY CONSTRUCTION, and bumping `user_version` on stores
 * that will never hold a moment would leave the next rung gating on a predecessor that means
 * nothing — the exact ambiguity the restored rung 13 exists to remove.
 *
 * BOTH DIRECTIONS ARE COVERED WITHOUT A VERSION, which is why nothing is lost by staying off it. An
 * older build opening a store that has these tables never looks at them. A newer build opening an
 * older store converges them on first touch. The version would record a fact neither side reads.
 *
 * THE MIGRATION IS DERIVED FROM THE SCHEMA, NOT FROM A LIST, and that is the point rather than an
 * implementation detail. A hand-maintained list of added columns is a second place to remember,
 * and the failure this fixes was a failure of remembering. `MOMENT_SPOOL_FORMAT` already governs
 * how a spool LINE may evolve; this is the table half, and it holds for every future column with no
 * further action: add it to `MOMENT_SCHEMA_SQL` and an existing store gets it on the next open.
 */
export function createMomentTables(db: StoragePort): void {
  // THREE PHASES, AND THE ORDER IS LOAD-BEARING. An index may reference a column that is being
  // migrated in this very call — `idx_governed_moments_tool_use` does — and SQLite evaluates that
  // reference immediately, so creating indexes before the ALTERs fails with "no such column" on
  // exactly the old stores this function exists to repair. Same hazard `gates.ts` documents for
  // `idx_rule_bindings_circle`, solved generically here rather than by moving one statement.
  // COMMENTS COME OUT FIRST. This schema explains itself at length, and one of those explanations
  // contains the word INSERT — splitting statements on the raw text matched inside a comment and
  // produced `near "makes": syntax error`. SQLite ignores comments anyway; the parser below strips
  // them for the same reason.
  const executable = stripSqlComments(MOMENT_SCHEMA_SQL);
  const DEFERRED = /(?:CREATE (?:UNIQUE )?INDEX|INSERT)[^;]*;/g;
  const deferred = executable.match(DEFERRED) ?? [];
  db.exec(executable.replace(DEFERRED, ""));
  migrateMomentColumnsFrom(db, MOMENT_SCHEMA_SQL);
  // Indexes AND seed rows both name columns, so both wait for the ALTERs. The singleton seed
  // insert hit this too: it names byte_offset, which an old-enough table does not have yet.
  for (const statement of deferred) db.exec(statement);
}

/** Removes block and line comments, preserving offsets so parallel scans stay aligned. */
function stripSqlComments(schema: string): string {
  return schema
    .replace(/\/\*[\s\S]*?\*\//g, (block) => " ".repeat(block.length))
    .replace(/--[^\n]*/g, (line) => " ".repeat(line.length));
}

/** One column as the schema declares it: the name, and the DDL an ALTER would need. */
interface DeclaredColumn {
  name: string;
  ddl: string;
}

/**
 * Reads the column declarations back out of a schema string.
 *
 * PARSING OUR OWN SQL, which is only defensible because this is a fixed string in this repository
 * rather than arbitrary input — the alternative is the hand-maintained list this exists to avoid.
 * Comments and quoted literals are stripped before any paren counting, so a `CHECK (...)` inside a
 * column definition and a `'{}'` default cannot confuse the split.
 */
export function declaredMomentColumns(schema: string): Map<string, DeclaredColumn[]> {
  // TWO PARALLEL COPIES, SAME INDICES. `text` is the real SQL with comments removed — every DDL
  // fragment is sliced out of THIS one. `scan` additionally blanks the inside of string literals so
  // a `'{}'` default or an `IN ('ok','failed')` list cannot confuse the paren and comma scanning
  // below. Slicing from `scan` instead was a real bug: it produced
  // `CHECK (... IN ('xx','xxxxxx'))`, an ALTER that compiled and then rejected every real value.
  const text = stripSqlComments(schema);
  const scan = text.replace(/'(?:[^']|'')*'/g, (literal) => "'" + "x".repeat(Math.max(0, literal.length - 2)) + "'");
  const cleaned = scan;

  const tables = new Map<string, DeclaredColumn[]>();
  const header = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = header.exec(cleaned)) !== null) {
    const table = match[1]!;
    let depth = 1;
    let i = header.lastIndex;
    for (; i < cleaned.length && depth > 0; i += 1) {
      if (cleaned[i] === "(") depth += 1;
      else if (cleaned[i] === ")") depth -= 1;
    }
    const bodyStart = header.lastIndex;
    const bodyEnd = i - 1;
    const body = scan.slice(bodyStart, bodyEnd);
    const bodyText = text.slice(bodyStart, bodyEnd);

    // Split on TOP-LEVEL commas only: a column's own CHECK clause carries commas of its own.
    // Boundaries are found on `scan` and the text is taken from `bodyText` at the same offsets.
    const parts: string[] = [];
    let nested = 0;
    let start = 0;
    for (let k = 0; k < body.length; k += 1) {
      const ch = body[k];
      if (ch === "(") nested += 1;
      else if (ch === ")") nested -= 1;
      else if (ch === "," && nested === 0) {
        parts.push(bodyText.slice(start, k));
        start = k + 1;
      }
    }
    parts.push(bodyText.slice(start));

    const columns: DeclaredColumn[] = [];
    for (const raw of parts) {
      const part = raw.trim().replace(/\s+/g, " ");
      if (part.length === 0) continue;
      // Table-level constraints are not columns and cannot be added by ALTER.
      if (/^(CHECK|PRIMARY KEY|UNIQUE|FOREIGN KEY|CONSTRAINT)\b/i.test(part)) continue;
      // A PRIMARY KEY column cannot be added by ALTER either — and it is present by construction,
      // since a table cannot have been created without it.
      if (/\bPRIMARY KEY\b/i.test(part)) continue;
      const name = part.split(/\s/)[0]!;
      columns.push({ name, ddl: part });
    }
    tables.set(table, columns);
  }
  return tables;
}

/**
 * Adds any column the schema declares that this database does not have yet.
 *
 * GUARD-THEN-ALTER-THEN-CATCH, the same shape `migrateGateColumns` uses in gates.ts and for the
 * same reason: two processes sharing one `.monet` can both probe a pre-column store, both see the
 * column missing, and both attempt the ALTER. The loser gets SQLite's "duplicate column name",
 * which is proof the promise this function makes — the column exists when it returns — is already
 * kept. Any other error is a real problem and is re-thrown.
 */
export function migrateMomentColumnsFrom(db: StoragePort, schema: string): void {
  for (const [table, columns] of declaredMomentColumns(schema)) {
    const present = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (present.size === 0) continue; // table not created yet; the exec above owns that case
    for (const column of columns) {
      if (present.has(column.name)) continue;
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column.ddl}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("duplicate column name")) throw error;
      }
    }
  }
}

/** What one fold did. Every count here is a fact about the transport, not about any moment. */
export interface MomentFoldResult {
  /** Records recognised and applied. Applying a record already folded still counts it. */
  recordsFolded: number;
  /** Lines this build could not parse. See `MomentSpoolRead.malformedLines`. */
  malformedLines: number;
  /** Lines written by a newer format than this build understands. */
  futureVersionLines: number;
  /** Sequence numbers newly discovered to be missing. */
  gapsOpened: number;
  /** Missing sequence numbers that turned up after all. */
  gapsClosed: number;
  /**
   * Outcomes that named a tool call this record has no interception for, newly recorded as losses.
   * The sequence cannot see this class of loss (see the loss table's own comment), so this count is
   * the only signal that a PreToolUse append was swallowed.
   */
  unobservedInterceptionsOpened: number;
  /** Held outcomes whose interception finally turned up, applied and closed. */
  unobservedInterceptionsClosed: number;
  /**
   * Reads that named no moment, newly observed by THIS pass.
   *
   * The durable total lives in `moment_reads` (see its own comment for why it is keyed on
   * the sequence coordinate rather than accumulated); this field is the delta, so a caller watching
   * for a regression can see one appear rather than having to diff a total.
   */
  unjoinableReads: number;
  /** Byte offset the cursor now points at. */
  cursor: number;
  /** The stored cursor pointed past EOF and this fold started over. See `MomentSpoolRead`. */
  restartedFromZero: boolean;
}

/**
 * One thing the record knows it never received. The store saying what is missing, rather than
 * quietly holding less.
 */
export type MomentLoss =
  | {
      kind: "sequence-gap";
      runId: string;
      /** NULL when the run's own run-start record has not been folded — not known, not "no role". */
      writerRole: string | null;
      fromSeq: number;
      toSeq: number;
    }
  | {
      kind: "unobserved-interception";
      /** The host tool call that demonstrably ran and that nothing was ever intercepted for. */
      toolUseId: string;
      outcomeAt: string;
      outcomeSha256: string;
    };

/** One governed moment, as the ledger holds it. Every optional field is "not observed". */
export interface GovernedMomentRow {
  momentId: string;
  /** False means only attachments were seen for this id — never a governed moment. */
  opened: boolean;
  at: string | null;
  sessionId: string | null;
  /** The host's tool-call id. NULL means no host tool call, or none supplied — never a verdict. */
  toolUseId: string | null;
  /** The circle this moment was governed under. NULL means nothing resolved one. */
  circle: string | null;
  surface: string | null;
  actionSha256: string | null;
  actionRendering: string | null;
  actionChars: number | null;
  actionClipped: boolean | null;
  stageId: string | null;
  /** NULL is "not observed"; `[]` is "nothing was bound to this moment". */
  ruleIds: string[] | null;
  disposition: MomentDisposition | null;
  deliveredRuleIds: string[] | null;
  /** ruleId -> when the agent read it. Empty object means nothing has been read. */
  ruleReads: Record<string, string>;
  outcomeAt: string | null;
  outcomeSha256: string | null;
  /** `"ok"` / `"failed"` / `null` for not observed. Never inferred from the digest. */
  outcomeStatus: "ok" | "failed" | null;
  askedAt: string | null;
  answer: MomentAnswer | null;
  answeredAt: string | null;
}

/**
 * An answer or an ask arrived for a moment the record has never seen.
 *
 * THE CALLER SEES THIS; nothing upserts and nothing creates a row. A created row would make the
 * answer path a back door for moments the interceptor never observed, and the ledger would stop
 * being a record of what happened.
 */
export class ConflictingAnswerError extends Error {
  constructor(
    readonly momentId: string,
    readonly recorded: MomentAnswer,
    readonly attempted: MomentAnswer,
  ) {
    super(
      `moment ${momentId} is already answered "${recorded}"; refusing to record "${attempted}". ` +
        "The record keeps the first answer, so accepting this one would report a value it did not store.",
    );
    this.name = "ConflictingAnswerError";
  }
}

/**
 * The write went through every check and still is not on the record.
 *
 * WHY THIS CANNOT BE INFERRED FROM THE CALL SUCCEEDING: every spool append is deliberately
 * best-effort — `spoolAnswer` swallows its own write error, because instrumentation is owed to the
 * record and never to the caller's operation (see moment-spool.ts's header). That posture is right
 * for an interception, whose loss the sequence ledger will name. It is wrong for a conformance
 * answer, which is the ONE datum in this system no machine can reproduce: if the disk filled or the
 * mode changed, the append vanished, the fold found nothing, and the tool told the user their
 * answer was recorded. Reading the value back after the fold is the only way to tell a write that
 * landed from one that was swallowed.
 */
export class MomentWriteNotObservedError extends Error {
  constructor(readonly momentId: string, readonly what: "ask" | "answer") {
    super(
      `the ${what} for moment ${momentId} is not on the record after writing it — the spool append ` +
        "did not land. Nothing was recorded, and the value must be supplied again.",
    );
    this.name = "MomentWriteNotObservedError";
  }
}

export class UnknownMomentError extends Error {
  constructor(readonly momentId: string) {
    super(`no governed moment ${momentId} in the record: an answer attaches to a moment, it never creates one`);
    this.name = "UnknownMomentError";
  }
}

interface CursorRow {
  byte_offset: number;
}

/**
 * Folds the spool into the ledger, from the stored cursor to EOF.
 *
 * Creates its own tables first. That is five `IF NOT EXISTS` statements on a hot path, and it is the
 * right trade today: it keeps this substrate self-contained, so nothing else has to remember to
 * initialise it, and the cost is far below the file read it accompanies. If a measurement ever shows
 * otherwise, that is when to hoist it into store construction — not before.
 */
export function foldMomentSpool(db: StoragePort, spoolPath: string): MomentFoldResult {
  // ONE CHUNK PER PASS, LOOPED TO COMPLETION. `readMomentSpool` bounds what it buffers; this bounds
  // nothing, because a caller that folded only part of the spool would answer from a ledger it knows
  // is behind. The loop ends when a pass stops making progress — at EOF, or at a future-format line
  // the cursor deliberately will not step over.
  let total = foldMomentSpoolOnce(db, spoolPath);
  // PROGRESS IS THE CURSOR MOVING, not records being folded: a chunk can be all malformed lines and
  // still advance. Stopping on "folded nothing" would leave those unconsumed forever.
  while (true) {
    const before = total.cursor;
    const pass = foldMomentSpoolOnce(db, spoolPath);
    total = mergeFoldResults(total, pass);
    if (pass.cursor <= before) break;
  }
  return total;
}

/**
 * Follows an active circle alias, so a renamed circle's history stays reachable under one name.
 *
 * AT FOLD TIME, NOT ONLY AT QUERY TIME, and both are needed for different halves of the same
 * failure. `renameCircle` moves the rows that are already folded; this handles everything that
 * arrives afterwards — the spool is APPEND-ONLY and immutable, so every record written before the
 * rename still says `old` forever, and a re-fold with no resolution here would write `old` back
 * over the row the rename just moved. Resolving on the way in makes the fold converge on the
 * canonical name no matter how many times it runs.
 *
 * THE FOLD MAY READ THE STORE; the INTERCEPTOR may not (invariant 05). This runs inside the fold,
 * which is already database-side by construction, so it costs nothing on the critical path.
 *
 * TOLERATES A STORE WITH NO `circle_aliases` TABLE. The moment tables are created lazily and on
 * their own, so a database holding nothing but them is a real and tested configuration; there, the
 * name is simply already canonical.
 */
function resolveCircleAlias(db: StoragePort, circle: string | null): string | null {
  if (circle === null) return null;
  try {
    const row = db
      .prepare(`SELECT to_name FROM circle_aliases WHERE from_name = ? AND status = 'active'`)
      .get(circle) as { to_name: string } | undefined;
    return row ? row.to_name : circle;
  } catch {
    return circle;
  }
}

function mergeFoldResults(a: MomentFoldResult, b: MomentFoldResult): MomentFoldResult {
  return {
    recordsFolded: a.recordsFolded + b.recordsFolded,
    malformedLines: a.malformedLines + b.malformedLines,
    futureVersionLines: a.futureVersionLines + b.futureVersionLines,
    gapsOpened: a.gapsOpened + b.gapsOpened,
    gapsClosed: a.gapsClosed + b.gapsClosed,
    unobservedInterceptionsOpened: a.unobservedInterceptionsOpened + b.unobservedInterceptionsOpened,
    unobservedInterceptionsClosed: a.unobservedInterceptionsClosed + b.unobservedInterceptionsClosed,
    unjoinableReads: a.unjoinableReads + b.unjoinableReads,
    cursor: b.cursor,
    restartedFromZero: a.restartedFromZero || b.restartedFromZero,
  };
}

function foldMomentSpoolOnce(db: StoragePort, spoolPath: string): MomentFoldResult {
  createMomentTables(db);
  const cursor = db.prepare(`SELECT byte_offset FROM moment_fold_cursor WHERE singleton = 1`).get() as
    | CursorRow
    | undefined;
  const startOffset = cursor?.byte_offset ?? 0;

  const read = readMomentSpool(spoolPath, startOffset);
  const result: MomentFoldResult = {
    recordsFolded: 0,
    malformedLines: read.malformedLines,
    futureVersionLines: read.futureVersionLines,
    gapsOpened: 0,
    gapsClosed: 0,
    unobservedInterceptionsOpened: 0,
    unobservedInterceptionsClosed: 0,
    unjoinableReads: 0,
    cursor: startOffset,
    restartedFromZero: read.restartedFromZero,
  };
  if (read.records.length === 0 && read.nextCursor === startOffset && !read.restartedFromZero) return result;

  const apply = db.transaction(() => {
    const seen = new SequenceTracker(db);
    // TWO PHASES, and the reason is byte order. A host tool call is opened by one process and closed
    // by another, so an outcome and its interception can land in the spool in either order — and
    // within one pass, resolving an outcome against a half-applied ledger would report a loss that
    // the very next line disproves. So every record is applied first, and tool-call-keyed outcomes
    // are resolved only once every interception in the pass is in.
    const deferred: Array<{
      toolUseId: string;
      outcomeAt: string;
      outcomeSha256: string;
      outcomeStatus: "ok" | "failed" | null;
    }> = [];
    const interceptedToolUses = new Set<string>();
    for (const record of read.records) {
      seen.note(record.runId, record.seq);
      if (record.kind === "outcome" && record.momentId === null && record.toolUseId !== null) {
        deferred.push({
          toolUseId: record.toolUseId,
          outcomeAt: record.outcomeAt,
          outcomeSha256: record.outcomeSha256,
          outcomeStatus: record.outcomeStatus,
        });
      } else {
        if (record.kind === "read") {
          // EVERY read, joined or not. OR IGNORE, so a re-fold of the same range adds nothing; the
          // count returned is "newly observed this pass", which is what a caller watching for a
          // regression wants.
          const noted = db
            .prepare(
              `INSERT OR IGNORE INTO moment_reads (run_id, seq, moment_id, named_stage_id, circle)
                 VALUES (?, ?, ?, ?, ?)`,
            )
            .run(record.runId, record.seq, record.momentId, record.namedStageId, resolveCircleAlias(db, record.circle));
          if (noted.changes === 1 && record.momentId === null) result.unjoinableReads += 1;
        }
        applyRecord(db, record);
        if (record.kind === "interception" && record.toolUseId !== null) {
          interceptedToolUses.add(record.toolUseId);
        }
      }
      result.recordsFolded += 1;
    }
    // PHASE 2a — an interception this pass brought in may close a loss an earlier pass recorded.
    // Only tool calls seen in THIS pass can do that: a loss exists precisely because no moment
    // carried that id, and only a new interception can change it.
    for (const toolUseId of interceptedToolUses) {
      const held = db
        .prepare(
          `SELECT id, outcome_at, outcome_sha256, outcome_status FROM moment_losses
            WHERE kind = 'unobserved-interception' AND tool_use_id = ?`,
        )
        .get(toolUseId) as
        | { id: number; outcome_at: string; outcome_sha256: string; outcome_status: "ok" | "failed" | null }
        | undefined;
      if (held === undefined) continue;
      applyOutcomeByToolUse(db, toolUseId, held.outcome_at, held.outcome_sha256, held.outcome_status);
      db.prepare(`DELETE FROM moment_losses WHERE id = ?`).run(held.id);
      result.unobservedInterceptionsClosed += 1;
    }
    // PHASE 2b — resolve this pass's own outcomes. What cannot be resolved is RECORDED, never
    // dropped: it is the only witness that a tool call the record never intercepted actually ran.
    for (const outcome of deferred) {
      if (applyOutcomeByToolUse(db, outcome.toolUseId, outcome.outcomeAt, outcome.outcomeSha256, outcome.outcomeStatus)) {
        continue;
      }
      const inserted = db
        .prepare(
          `INSERT OR IGNORE INTO moment_losses (kind, tool_use_id, outcome_at, outcome_sha256, outcome_status)
             VALUES ('unobserved-interception', ?, ?, ?, ?)`,
        )
        .run(outcome.toolUseId, outcome.outcomeAt, outcome.outcomeSha256, outcome.outcomeStatus);
      // OR IGNORE, so re-folding the same range re-reports nothing: the loss is already standing.
      if (inserted.changes === 1) result.unobservedInterceptionsOpened += 1;
    }
    result.gapsOpened = seen.gapsOpened;
    result.gapsClosed = seen.gapsClosed;
    db.prepare(`UPDATE moment_fold_cursor SET byte_offset = ? WHERE singleton = 1`).run(read.nextCursor);
    result.cursor = read.nextCursor;
  });
  apply();
  return result;
}

/**
 * Reads one moment, folding first so an answer written moments ago is already in it.
 *
 * Returns null when the record has never heard of the id — which, after a fold, is the same
 * statement as "neither folded nor spooled", because the fold has just consumed everything the spool
 * held. That equivalence is what lets the existence checks below be one indexed lookup.
 */
export function readGovernedMoment(db: StoragePort, spoolPath: string, momentId: string): GovernedMomentRow | null {
  foldMomentSpool(db, spoolPath);
  return selectMoment(db, momentId);
}

/**
 * Everything the record knows it never received, of either kind. Folds before reporting.
 *
 * WHAT THIS STILL DOES NOT COVER, and it must not be read as if it did: a run that vanished
 * entirely AND left no outcome behind leaves nothing to be missing from. The two kinds here cover
 * each other's blind spot only partly — a sequence gap needs a record to follow the hole, and an
 * unobserved interception needs its tool call to have produced an outcome record. A run that
 * managed neither is silent, and no mechanism in this design finds it. See moment-spool.ts's header.
 */
export function observedMomentLosses(db: StoragePort, spoolPath: string): MomentLoss[] {
  foldMomentSpool(db, spoolPath);
  const gaps = db
    .prepare(
      `SELECT l.run_id AS runId, r.writer_role AS writerRole, l.from_seq AS fromSeq, l.to_seq AS toSeq
         FROM moment_losses l
         LEFT JOIN moment_runs r ON r.run_id = l.run_id
        WHERE l.kind = 'sequence-gap'
        ORDER BY l.run_id, l.from_seq`,
    )
    .all() as Array<{ runId: string; writerRole: string | null; fromSeq: number; toSeq: number }>;
  const orphans = db
    .prepare(
      `SELECT tool_use_id AS toolUseId, outcome_at AS outcomeAt, outcome_sha256 AS outcomeSha256
         FROM moment_losses
        WHERE kind = 'unobserved-interception'
        ORDER BY tool_use_id`,
    )
    .all() as Array<{ toolUseId: string; outcomeAt: string; outcomeSha256: string }>;
  return [
    ...gaps.map((gap) => ({ kind: "sequence-gap" as const, ...gap })),
    ...orphans.map((orphan) => ({ kind: "unobserved-interception" as const, ...orphan })),
  ];
}

/**
 * THE FOUR CONFORMANCE STATES, and the two that must never be one number.
 *
 * `unanswered` is a QUEUE OWED TO THE USER — the agent did its part and is waiting. `notAsked` is an
 * AGENT DEFECT — the rule was read, the action happened, and no question was ever put. They have
 * different owners and different remedies, and collapsing them into one "pending" bucket is the
 * exact failure this design exists to prevent.
 *
 * `notAsked` IS DERIVED, NOT STORED: a moment with at least one read, an outcome, and no `asked_at`.
 * That derivation is the whole payoff of making the ask an event — the agent's failure to ask
 * becomes mechanically detectable instead of being something only the agent could report.
 *
 * WHAT THESE NUMBERS DO NOT SAY. `followed` means the action followed the rule. It does NOT mean the
 * rule caused it: what the agent would have done without the rule is unobservable, and nothing here
 * measures it. Any surface rendering these counts must not imply otherwise.
 */
export interface MomentConformance {
  /** The user answered: the action followed the rule. */
  followed: number;
  /** The user answered: the rule was read and still not followed. */
  notFollowed: number;
  /** Asked, no answer yet. A queue, not a defect. Owned by the user. */
  unanswered: number;
  /** Read and acted on, never asked. A defect, not a queue. Owned by the agent. */
  notAsked: number;
  /** Reads that named no moment — the health signal for delivery naming its moment. */
  unjoinableReads: number;
}

/** How many things the record knows it never received, of either kind. Folds first. */
export function momentLossCount(db: StoragePort, spoolPath: string): number {
  foldMomentSpool(db, spoolPath);
  return (db.prepare(`SELECT COUNT(*) AS n FROM moment_losses`).get() as { n: number }).n;
}

/** Counts the four states, folding first so a just-recorded answer is already in them. */
export function momentConformance(db: StoragePort, spoolPath: string, circle: string): MomentConformance {
  foldMomentSpool(db, spoolPath);
  // A moment "was read" when its rule_reads object holds at least one entry. Stored as JSON rather
  // than a table (one moment, one row — see the ledger's own comment), so the emptiness test is on
  // the serialized object.
  const READ = `rule_reads IS NOT NULL AND rule_reads != '{}'`;
  // F3: EVERY POPULATION BELOW IS SCOPED TO `opened = 1`. A row whose interception record was never
  // folded is debris — something attached to a moment nobody observed — and this schema's own
  // comment has always said it "must never be counted as one". Nothing read the column until an
  // audit found debris counted in `total`, reported to a human as an agent defect, and served at
  // the HEAD of the ask backlog (its `at` is NULL, and ORDER BY at puts NULLs first).
  const OPENED = `opened = 1 AND circle = ?`;
  const one = (sql: string): number => (db.prepare(sql).get(circle) as { n: number }).n;
  return {
    followed: one(`SELECT COUNT(*) AS n FROM governed_moments WHERE ${OPENED} AND answer = 'followed'`),
    notFollowed: one(`SELECT COUNT(*) AS n FROM governed_moments WHERE ${OPENED} AND answer = 'not-followed'`),
    unanswered: one(
      `SELECT COUNT(*) AS n FROM governed_moments WHERE ${OPENED} AND asked_at IS NOT NULL AND answer IS NULL`,
    ),
    // F2: `answer IS NULL` is load-bearing. AN ANSWER IS PROOF AN ASK HAPPENED — the user cannot
    // reply to a question nobody put — so a moment carrying an answer has not gone unasked, whatever
    // `asked_at` says. Without this clause one answered moment was counted in `followed` AND in
    // `notAsked` at once, and rendered to a human as "read and acted on without asking".
    notAsked: one(
      `SELECT COUNT(*) AS n FROM governed_moments
        WHERE ${OPENED} AND asked_at IS NULL AND answer IS NULL AND outcome_at IS NOT NULL AND ${READ}`,
    ),
    // NOT circle-scoped: a read that named no moment has no circle to scope by.
    unjoinableReads: (db.prepare(`SELECT COUNT(*) AS n FROM moment_reads WHERE moment_id IS NULL`).get() as { n: number }).n,
  };
}

/**
 * THE RATE COUNTERS, rebuilt on the governed moment.
 *
 * These replace what `gate_events` used to answer, and one distinction had to change to stay honest.
 * The old counters had an `overflows` bucket meaning "the payload was past the threshold and nothing
 * was matched against it". The moment record has a wider version of that fact: `ruleIds IS NULL`
 * means NOTHING EVALUATED THIS MOMENT AT ALL — an overflow, a tool the hook could not read, or a
 * call into the store, which no gate evaluates by design.
 *
 * SO THE SPLIT IS ON WHETHER A GATE LOOKED, not on the disposition word alone. `fires` and
 * `silences` are both claims about an evaluation that happened, so both are scoped to moments where
 * one did; lumping the never-evaluated moments into `silences` would report "nothing governs this"
 * for actions no rule set was ever consulted about — the substitution this whole record exists to
 * prevent, and the reason `ungoverned` is its own number rather than folded into either.
 *
 * `delivered` counts moments where at least one rule's IDENTITY reached the agent. An advisory
 * delivers stage names and no rule id, so it is deliberately not counted here — receipt cannot be
 * claimed for an identity that was never sent.
 */
export interface MomentCounts {
  /** A gate evaluated, and at least one rule was bound. */
  fires: number;
  /** A gate evaluated, and nothing was bound. Silence is a value. */
  silences: number;
  /** Nothing evaluated this moment: an overflow, an unreadable surface, or a call into the store. */
  ungoverned: number;
  /** Moments where at least one rule id actually reached the agent. */
  delivered: number;
  /** Every governed moment on record in this circle. Debris is excluded and counted below. */
  total: number;
  /**
   * Observed moments whose circle was never resolved.
   *
   * ITS OWN NUMBER, for the same reason `unopened` is: scoping the counts to a circle must not make
   * an unattributable moment invisible. It is a real observation with one field missing, and
   * folding it into whichever circle happened to ask would be the guess this record forbids.
   */
  unattributed: number;
  /**
   * Rows that were attached to but never observed at interception — `opened = 0`.
   *
   * ITS OWN NUMBER, because excluding it from the counts must not make it invisible. A swallowed
   * interception is a real loss: something read a rule or returned an outcome against a moment this
   * record never saw open. Folding it into `total` (as this did until an audit caught it) inflates
   * every rate; dropping it silently hides a loss.
   */
  unopened: number;
}

/** Counts every moment by what the gate did. Folds first. */
export function momentCounts(db: StoragePort, spoolPath: string, circle: string): MomentCounts {
  foldMomentSpool(db, spoolPath);
  const one = (sql: string): number => (db.prepare(sql).get(circle) as { n: number }).n;
  const oneNoArg = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  // F3: scoped to observed moments. `ungoverned` in particular is documented as "an overflow, an
  // unreadable surface, or a call into the store" — debris is none of those, and counting it there
  // put a fourth, undocumented population inside a number a human reads.
  // SCOPED, because the spool is shared across projects and this store folded all of it.
  const EVALUATED = `opened = 1 AND circle = ? AND rule_ids IS NOT NULL`;
  return {
    fires: one(`SELECT COUNT(*) AS n FROM governed_moments WHERE ${EVALUATED} AND rule_ids != '[]'`),
    silences: one(`SELECT COUNT(*) AS n FROM governed_moments WHERE ${EVALUATED} AND rule_ids = '[]'`),
    ungoverned: one(`SELECT COUNT(*) AS n FROM governed_moments WHERE opened = 1 AND circle = ? AND rule_ids IS NULL`),
    delivered: one(
      `SELECT COUNT(*) AS n FROM governed_moments
        WHERE opened = 1 AND circle = ? AND delivered_rule_ids IS NOT NULL AND delivered_rule_ids != '[]'`,
    ),
    total: one(`SELECT COUNT(*) AS n FROM governed_moments WHERE opened = 1 AND circle = ?`),
    // NOT circle-scoped, deliberately: debris has no interception, so it has no circle either.
    unopened: oneNoArg(`SELECT COUNT(*) AS n FROM governed_moments WHERE opened = 0`),
    unattributed: oneNoArg(`SELECT COUNT(*) AS n FROM governed_moments WHERE opened = 1 AND circle IS NULL`),
  };
}

/**
 * How many times each stage was NAMED by an agent, across every read — joined or not.
 *
 * THE ZEROES ARE THE POINT, which is why this returns counts by id and leaves the caller to join it
 * against the stage registry: a stage that appears here with a count is being asked for, and a
 * declared stage ABSENT from this map is one nobody has ever looked up. That second state is
 * indistinguishable from a healthy quiet stage unless something says otherwise, and this is the only
 * thing that can say it.
 *
 * NAMED, NOT MATCHED. This counts the stage the agent asked for. The stage the gate matched against
 * an action is a different fact and lives on the moment as `stage_id`; the two can disagree in one
 * call and are deliberately never merged.
 */
export function momentStageReads(db: StoragePort, spoolPath: string, circle: string): Map<string, number> {
  foldMomentSpool(db, spoolPath);
  // SCOPED, for the same reason every other count here is: the spool is home-level and this store
  // folds every project's reads. Unscoped, one lookup of a global stage in circle A made that stage
  // stop reporting as never-looked-up in circle B — the map's entire purpose is to name a stage
  // NOBODY has consulted, and another project's activity was answering that question for it.
  const rows = db
    .prepare(
      `SELECT named_stage_id AS stageId, COUNT(*) AS reads
         FROM moment_reads
        WHERE named_stage_id IS NOT NULL AND circle = ?
        GROUP BY named_stage_id`,
    )
    .all(circle) as Array<{ stageId: string; reads: number }>;
  return new Map(rows.map((row) => [row.stageId, row.reads]));
}

/**
 * The moments that owe the user a question: read, acted on, never asked.
 *
 * BOUNDED BY THE CALLER, because this feeds a signal that reaches a model's context and an unbounded
 * list there is a payload. Oldest first, so a backlog is worked from its head rather than its tail
 * and nothing starves.
 *
 * NO THRESHOLD ON "TOO MANY". Nothing has measured how often this fires on a real store, so any
 * cutoff for "the backlog is unhealthy" would govern a space nobody has measured. The caller says
 * how many it wants; this says what is owed.
 *
 * TWO CLAUSES HERE ARE CORRECTIONS, not tidying. `answer IS NULL` (F2): an answered moment owes
 * nothing, and without this the signal named a closed moment forever. `opened = 1` (F3): debris
 * would otherwise be fed to a model as a moment to ask a user about — and served FIRST, because its
 * `at` is NULL and this orders oldest-first.
 */
export function momentsOwingAQuestion(
  db: StoragePort,
  spoolPath: string,
  circle: string,
  limit: number,
): string[] {
  foldMomentSpool(db, spoolPath);
  const rows = db
    .prepare(
      `SELECT moment_id FROM governed_moments
        WHERE opened = 1
          AND circle = ?
          AND asked_at IS NULL
          AND answer IS NULL
          AND outcome_at IS NOT NULL
          AND rule_reads IS NOT NULL AND rule_reads != '{}'
        ORDER BY at
        LIMIT ?`,
    )
    .all(circle, limit) as Array<{ moment_id: string }>;
  return rows.map((row) => row.moment_id);
}

/**
 * Applies an outcome to whatever moment recorded the same host tool call.
 *
 * Returns false when no moment carries that id — which is a FINDING, not an error: the caller turns
 * it into a recorded loss. First-write-wins, like every other apply, so a re-fold changes nothing.
 */
function applyOutcomeByToolUse(
  db: StoragePort,
  toolUseId: string,
  outcomeAt: string,
  outcomeSha256: string,
  outcomeStatus: "ok" | "failed" | null,
): boolean {
  const applied = db
    .prepare(
      `UPDATE governed_moments
          SET outcome_at = COALESCE(outcome_at, ?),
              outcome_sha256 = COALESCE(outcome_sha256, ?),
              outcome_status = COALESCE(outcome_status, ?)
        WHERE tool_use_id = ?`,
    )
    .run(outcomeAt, outcomeSha256, outcomeStatus, toolUseId);
  return applied.changes > 0;
}

/**
 * Records that the agent asked the user about a moment. Attaches; never creates.
 *
 * Same rule as the answer below and for the same reason: whether the agent asked is an EVENT, and an
 * event invented for a moment nobody intercepted is not an event.
 */
export function attachMomentAsk(db: StoragePort, run: MomentRun, fields: { momentId: string; askedAt?: string }): void {
  const spoolPath = requireSpool(run);
  foldMomentSpool(db, spoolPath);
  requireObservedMoment(db, fields.momentId);
  spoolAsk(run, fields);
  foldMomentSpool(db, spoolPath);
  // READ IT BACK. See MomentWriteNotObservedError for why a successful return is not evidence.
  if (selectMoment(db, fields.momentId)?.askedAt == null) {
    throw new MomentWriteNotObservedError(fields.momentId, "ask");
  }
}

/**
 * Records the user's answer against an existing moment.
 *
 * THE WRITE GOES THROUGH THE SPOOL, not straight into the ledger, so the answer is sequenced like
 * every other record and its own loss would be observable. The fold that follows is what makes the
 * answer readable by the time this returns.
 */
export function attachMomentAnswer(
  db: StoragePort,
  run: MomentRun,
  fields: { momentId: string; answer: MomentAnswer; answeredAt?: string },
): void {
  const spoolPath = requireSpool(run);
  foldMomentSpool(db, spoolPath);
  requireObservedMoment(db, fields.momentId);
  // A SECOND, DIFFERENT ANSWER IS REFUSED — not dropped. The apply below is first-write-wins, so a
  // correction was silently ignored while the tool echoed it back as recorded, leaving the durable
  // tally disagreeing with what the user was told. Repeating the SAME answer is allowed: it asserts
  // nothing new. Changing one is a correction this record does not yet model, and saying so is the
  // only honest option available — the alternative was a lie.
  const existing = selectMoment(db, fields.momentId);
  if (existing !== null && existing.answer !== null && existing.answer !== fields.answer) {
    throw new ConflictingAnswerError(fields.momentId, existing.answer, fields.answer);
  }
  spoolAnswer(run, fields);
  foldMomentSpool(db, spoolPath);
  // READ IT BACK, and compare the VALUE rather than merely checking for one: first-write-wins means
  // a stale answer already on the row would otherwise pass an existence check while the caller's
  // own answer was never stored.
  if (selectMoment(db, fields.momentId)?.answer !== fields.answer) {
    throw new MomentWriteNotObservedError(fields.momentId, "answer");
  }
}

/**
 * The moment an ask or an answer is allowed to attach to: one this record actually OBSERVED.
 *
 * `opened = 1`, NOT MERELY "A ROW EXISTS", and the difference is a whole class of silent loss. A
 * debris row — an attachment whose interception append was swallowed — is a real row, so a plain
 * existence check accepted an answer against it. Every population that a human or an agent reads is
 * scoped to observed moments, so the answer landed on disk and was counted by nothing: all four
 * conformance states reported zero while a user's "not-followed" sat in the table.
 *
 * REFUSING LOUDLY BEATS LOSING QUIETLY. The agent gets `UnknownMomentError` and can tell the user
 * the answer could not be recorded, which is recoverable. A stored-but-unreadable answer is not:
 * it is the one datum in this system no machine can reproduce, and nothing would ever surface it.
 *
 * This is deliberately the same error the never-seen case raises. From the caller's side both mean
 * "this record cannot carry an answer for that id", and splitting them would invite a caller to
 * treat one as retryable.
 */
function requireObservedMoment(db: StoragePort, momentId: string): void {
  const moment = selectMoment(db, momentId);
  if (moment === null || !moment.opened) throw new UnknownMomentError(momentId);
  // AND THERE MUST BE SOMETHING TO JUDGE. `opened` alone let two populations through that no user
  // can answer about: a silent or store-side moment where no rule was ever read, and a BLOCKED
  // moment — whose id is handed to the agent in the deny instruction, and which by design never
  // acts. Accepting either produced a `followed`/`notFollowed` tally entry for an action that
  // either had no rule behind it or never happened. Same two conditions `momentsOwingAQuestion`
  // uses, so what may be answered is exactly what was asked for.
  if (Object.keys(moment.ruleReads).length === 0 || moment.outcomeAt === null) {
    throw new UnknownMomentError(momentId);
  }
}

/**
 * A run with no spool cannot carry a checked write. Silently succeeding would report an answer that
 * was never recorded anywhere, which is worse than refusing.
 */
function requireSpool(run: MomentRun): string {
  if (run.path === null) {
    throw new Error("the moment spool is disabled for this run: an answer cannot attach to a record nobody keeps");
  }
  return run.path;
}

function selectMoment(db: StoragePort, momentId: string): GovernedMomentRow | null {
  createMomentTables(db);
  const row = db.prepare(`SELECT * FROM governed_moments WHERE moment_id = ?`).get(momentId) as
    | Record<string, unknown>
    | undefined;
  if (row === undefined) return null;
  return {
    momentId: row.moment_id as string,
    opened: row.opened === 1,
    at: (row.at as string | null) ?? null,
    sessionId: (row.session_id as string | null) ?? null,
    toolUseId: (row.tool_use_id as string | null) ?? null,
    circle: (row.circle as string | null) ?? null,
    surface: (row.surface as string | null) ?? null,
    actionSha256: (row.action_sha256 as string | null) ?? null,
    actionRendering: (row.action_rendering as string | null) ?? null,
    actionChars: (row.action_chars as number | null) ?? null,
    actionClipped: row.action_clipped === null || row.action_clipped === undefined ? null : row.action_clipped === 1,
    stageId: (row.stage_id as string | null) ?? null,
    ruleIds: parseJsonArray(row.rule_ids),
    disposition: (row.disposition as MomentDisposition | null) ?? null,
    deliveredRuleIds: parseJsonArray(row.delivered_rule_ids),
    ruleReads: parseJsonObject(row.rule_reads),
    outcomeAt: (row.outcome_at as string | null) ?? null,
    outcomeSha256: (row.outcome_sha256 as string | null) ?? null,
    outcomeStatus: (row.outcome_status as "ok" | "failed" | null) ?? null,
    askedAt: (row.asked_at as string | null) ?? null,
    answer: (row.answer as MomentAnswer | null) ?? null,
    answeredAt: (row.answered_at as string | null) ?? null,
  };
}

function parseJsonArray(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

function parseJsonObject(value: unknown): Record<string, string> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * FIRST WRITE WINS, EVERYWHERE. Each apply either creates the row or fills in only the fields that
 * are still NULL — which is what makes re-folding a no-op and makes the ledger independent of the
 * order records are read in. A second record claiming a different value for a field already set is
 * ignored rather than overwriting: the record is what was observed first, and a contradiction
 * between two records is a transport fault to be found in the spool, not resolved silently here.
 */
function applyRecord(db: StoragePort, record: MomentSpoolRecord): void {
  switch (record.kind) {
    case "run-start":
      db.prepare(
        `INSERT INTO moment_runs (run_id, writer_role, started_at, max_seq) VALUES (?, ?, ?, -1)
           ON CONFLICT(run_id) DO UPDATE SET
             writer_role = COALESCE(moment_runs.writer_role, excluded.writer_role),
             started_at = COALESCE(moment_runs.started_at, excluded.started_at)`,
      ).run(record.runId, record.writerRole, record.at);
      return;
    case "interception":
      db.prepare(
        `INSERT INTO governed_moments (
           moment_id, opened, at, session_id, tool_use_id, circle, surface, action_sha256,
           action_rendering, action_chars, action_clipped, stage_id, rule_ids, disposition,
           delivered_rule_ids
         ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(moment_id) DO UPDATE SET
             opened = 1,
             at = COALESCE(governed_moments.at, excluded.at),
             session_id = COALESCE(governed_moments.session_id, excluded.session_id),
             tool_use_id = COALESCE(governed_moments.tool_use_id, excluded.tool_use_id),
             circle = COALESCE(governed_moments.circle, excluded.circle),
             surface = COALESCE(governed_moments.surface, excluded.surface),
             action_sha256 = COALESCE(governed_moments.action_sha256, excluded.action_sha256),
             action_rendering = COALESCE(governed_moments.action_rendering, excluded.action_rendering),
             action_chars = COALESCE(governed_moments.action_chars, excluded.action_chars),
             action_clipped = COALESCE(governed_moments.action_clipped, excluded.action_clipped),
             stage_id = COALESCE(governed_moments.stage_id, excluded.stage_id),
             rule_ids = COALESCE(governed_moments.rule_ids, excluded.rule_ids),
             disposition = COALESCE(governed_moments.disposition, excluded.disposition),
             delivered_rule_ids = COALESCE(governed_moments.delivered_rule_ids, excluded.delivered_rule_ids)`,
      ).run(
        record.momentId,
        record.at,
        record.sessionId,
        record.toolUseId,
        resolveCircleAlias(db, record.circle),
        record.surface,
        record.actionSha256,
        record.actionRendering,
        record.actionChars,
        record.actionClipped === null ? null : record.actionClipped ? 1 : 0,
        record.stageId,
        // SQL NULL, not the four-character string "null": the column's own NULL is what every
        // reader here already treats as "not observed".
        record.ruleIds === null ? null : JSON.stringify(record.ruleIds),
        record.disposition,
        record.deliveredRuleIds === null ? null : JSON.stringify(record.deliveredRuleIds),
      );
      return;
    case "read": {
      // A read that names no moment cannot be attached to one. Counted by the caller; nothing is
      // written here, because every row in this ledger is keyed on a moment id.
      if (record.momentId === null) return;
      // F7: a lookup that returned NO rules is still a read — the attempt is the numerator a
      // recognition rate needs. It has no rule to attribute receipt to, so it lands in
      // `moment_reads` (above, keyed on the sequence coordinate) and adds nothing here.
      if (record.ruleId === null) return;
      // FIRST READ OF A RULE WINS. The read that matters is the one that fell between delivery and
      // the act; a later re-read of the same rule in the same moment does not change whether the
      // rule was received before the agent acted.
      const existing = db
        .prepare(`SELECT rule_reads, rule_ids, outcome_at FROM governed_moments WHERE moment_id = ?`)
        .get(record.momentId) as
        | { rule_reads: string; rule_ids: string | null; outcome_at: string | null }
        | undefined;
      if (existing === undefined) {
        // No interception folded yet. The moment id is minted BY the interceptor and only travels
        // out with a delivered rule, so a read naming an id the record has never seen means the
        // interception append was lost — the row stays `opened = 0` debris, which no count reads.
        db.prepare(`INSERT INTO governed_moments (moment_id, opened, rule_reads) VALUES (?, 0, ?)`).run(
          record.momentId,
          JSON.stringify({ [record.ruleId]: record.readAt }),
        );
        return;
      }
      // A READ AFTER THE ACTION IS NOT A READ BEFORE ACTING. An agent can name a stale moment id
      // in a later `stage_lookup` — the id is durable and nothing stops it being reused — and
      // crediting that would report the completed action as governed by a rule the agent met only
      // afterwards, then ask the user to judge it. Fact 3 is an ORDERING claim, so it is checked
      // as one. Both stamps are `toISOString()`, whose fixed-width UTC form compares correctly as
      // text; a read at exactly the outcome instant is KEPT, because a tie cannot be ordered from
      // the record and discarding a real read on a coincidence is the worse error.
      if (existing.outcome_at !== null && record.readAt > existing.outcome_at) return;
      // ONLY A RULE THIS MOMENT WAS GOVERNED BY. A stale gate mirror, or a stage edited between
      // interception and lookup, can hand back a rule that was not bound when the action was
      // intercepted. Crediting it would enter the moment into conformance as though a rule that
      // did not apply had been read and followed. The lookup is still recorded as a stage-read
      // event in `moment_reads` above — what happened is kept; only the receipt claim is refused.
      if (existing.rule_ids !== null) {
        const applicable = parseJsonArray(existing.rule_ids);
        // A rule_ids column that will not parse leaves nothing to check against, so the read is
        // credited rather than dropped: refusing on an unreadable column would turn a storage
        // defect into a silent loss of real receipts.
        if (applicable !== null && !applicable.includes(record.ruleId)) return;
      }
      const reads = parseJsonObject(existing.rule_reads);
      if (Object.prototype.hasOwnProperty.call(reads, record.ruleId)) return;
      reads[record.ruleId] = record.readAt;
      db.prepare(`UPDATE governed_moments SET rule_reads = ? WHERE moment_id = ?`).run(
        JSON.stringify(reads),
        record.momentId,
      );
      return;
    }
    case "outcome":
      // Only the moment-keyed form lands here. A tool-call-keyed outcome cannot be applied in file
      // order at all — its interception may sit later in the same pass — so the fold defers it and
      // resolves it after every interception in the pass is in. See foldMomentSpool.
      if (record.momentId === null) return;
      db.prepare(
        `INSERT INTO governed_moments (moment_id, opened, outcome_at, outcome_sha256, outcome_status)
           VALUES (?, 0, ?, ?, ?)
           ON CONFLICT(moment_id) DO UPDATE SET
             outcome_at = COALESCE(governed_moments.outcome_at, excluded.outcome_at),
             outcome_sha256 = COALESCE(governed_moments.outcome_sha256, excluded.outcome_sha256),
             outcome_status = COALESCE(governed_moments.outcome_status, excluded.outcome_status)`,
      ).run(record.momentId, record.outcomeAt, record.outcomeSha256, record.outcomeStatus);
      return;
    case "ask":
      db.prepare(
        `INSERT INTO governed_moments (moment_id, opened, asked_at) VALUES (?, 0, ?)
           ON CONFLICT(moment_id) DO UPDATE SET
             asked_at = COALESCE(governed_moments.asked_at, excluded.asked_at)`,
      ).run(record.momentId, record.askedAt);
      return;
    case "answer":
      db.prepare(
        `INSERT INTO governed_moments (moment_id, opened, answer, answered_at) VALUES (?, 0, ?, ?)
           ON CONFLICT(moment_id) DO UPDATE SET
             answer = COALESCE(governed_moments.answer, excluded.answer),
             answered_at = COALESCE(governed_moments.answered_at, excluded.answered_at)`,
      ).run(record.momentId, record.answer, record.answeredAt);
      return;
  }
}

/**
 * The completeness proof, one sequence number at a time.
 *
 * The rule is small enough to state whole: everything at or below a run's `max_seq` that is not
 * inside a gap range has been seen. So a number at or below `max_seq` either closes a gap or is a
 * number already accounted for (which is exactly what a re-fold presents), and a number above
 * `max_seq` opens a gap for everything skipped over on the way to it.
 */
class SequenceTracker {
  gapsOpened = 0;
  gapsClosed = 0;

  constructor(private readonly db: StoragePort) {}

  note(runId: string, seq: number): void {
    const run = this.db.prepare(`SELECT max_seq FROM moment_runs WHERE run_id = ?`).get(runId) as
      | { max_seq: number }
      | undefined;
    if (run === undefined) {
      // A run first heard of at seq N is missing 0..N-1 — including, when N > 0, its own run-start
      // record. That hole is reported like any other rather than excused as "we joined late".
      this.db.prepare(`INSERT INTO moment_runs (run_id, writer_role, started_at, max_seq) VALUES (?, NULL, NULL, ?)`).run(
        runId,
        seq,
      );
      if (seq > 0) this.openGap(runId, 0, seq - 1);
      return;
    }
    if (seq > run.max_seq) {
      if (seq > run.max_seq + 1) this.openGap(runId, run.max_seq + 1, seq - 1);
      this.db.prepare(`UPDATE moment_runs SET max_seq = ? WHERE run_id = ?`).run(seq, runId);
      return;
    }
    this.closeGap(runId, seq);
  }

  private openGap(runId: string, fromSeq: number, toSeq: number): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO moment_losses (kind, run_id, from_seq, to_seq) VALUES ('sequence-gap', ?, ?, ?)`)
      .run(runId, fromSeq, toSeq);
    this.gapsOpened += toSeq - fromSeq + 1;
  }

  /** A missing number turned up. Splits the range it landed in; a no-op if it was never missing. */
  private closeGap(runId: string, seq: number): void {
    const range = this.db
      .prepare(
        `SELECT from_seq, to_seq FROM moment_losses
          WHERE kind = 'sequence-gap' AND run_id = ? AND from_seq <= ? AND to_seq >= ?`,
      )
      .get(runId, seq, seq) as { from_seq: number; to_seq: number } | undefined;
    if (range === undefined) return;
    this.db
      .prepare(`DELETE FROM moment_losses WHERE kind = 'sequence-gap' AND run_id = ? AND from_seq = ?`)
      .run(runId, range.from_seq);
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO moment_losses (kind, run_id, from_seq, to_seq) VALUES ('sequence-gap', ?, ?, ?)`,
    );
    if (range.from_seq <= seq - 1) insert.run(runId, range.from_seq, seq - 1);
    if (seq + 1 <= range.to_seq) insert.run(runId, seq + 1, range.to_seq);
    this.gapsClosed += 1;
  }
}
