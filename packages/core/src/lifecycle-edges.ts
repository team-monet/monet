/**
 * Lifecycle edges + ratifications — the normative substrate.
 *
 * The design of record ("Next Monet") states that
 * edges are first-class relations in three families — derivation (principle → rule), provenance
 * (rule → transcript span), supersession (rule → rule) — and that authority is *edges, not a flag*:
 * impeachment, audit, extraction-evidence exclusion and mirror regeneration all run on them.
 *
 * WHY A SEPARATE TABLE, NOT `memory_edge`. Two structural reasons, both verified against the live
 * code rather than assumed (cited by function/table name, not line number — a prior version of
 * this comment cited absolute engine.ts line numbers, which drift the moment anything upstream of
 * them changes; a name survives a refactor the way a line number cannot):
 *
 *  1. `memory_edge` is DERIVED state, and the maintenance path treats it as disposable.
 *     `unwindConceptGraph` runs an untyped
 *     `DELETE FROM memory_edge WHERE scope = ? AND (src_id = ? OR dst_id = ?)` — every edge type
 *     touching the concept — while `rederiveConceptGraph` recreates only the
 *     types it can re-derive from body/observations. Anything not re-derivable must be manually
 *     snapshotted and restored around the unwind, which is what the `possible_duplicate_of`
 *     carve-out in `reassignCircle` does. That carve-out exists at 2 of the 7 unwind call sites;
 *     the other five (`recomputeSourceConceptBody`, `retireConcept`, the two sync-apply
 *     sites, and `moveConcept` — the one `reassignCircle` reaches) have none.
 *     A normative edge living in `memory_edge` would therefore be silently destroyed by an ordinary
 *     retire or circle move, taking the provenance that impeachment and audit run on with it.
 *     A separate table is immune BY CONSTRUCTION: graph maintenance does not know it exists.
 *
 *  2. `memory_edge` already has `derived_from` and `supersedes` types (its own `type` column's
 *     vocabulary), and they are HEURISTIC — "agent-asserted typed edges parsed from content" (that
 *     column's own doc comment), matched out of free text by `ASSERTED_RE` and used by graph
 *     diagnostics. The edges here are born from ACTS (a correction, a declaration, a
 *     ratification), never parsed from prose. Sharing rows or type names would conflate heuristic
 *     association with normative authority — precisely the collapse the design directive forbids.
 *
 * Consequences of that separation, all deliberate:
 *   - These rows NEVER participate in similarity-graph adjacency, hub filtering, or edge-type
 *     histograms. They are substrate truth, not a recall surface.
 *   - They are APPEND-ONLY. There is no update path for family/src/dst, and graph maintenance never
 *     deletes them.
 *   - They DO sync: unlike `resolution_events` (deliberately local-only, engine.ts:1691), a
 *     normative record that failed to replicate would make two machines disagree about what governs.
 */

import type { StoragePort } from "./storage";
import { parseSpan } from "./spans";

// ---- vocabulary -------------------------------------------------------------

/** The three normative relation families. Mirrors the `family` CHECK constraint. */
export type LifecycleEdgeFamily = "derivation" | "provenance" | "supersession";

export const LIFECYCLE_EDGE_FAMILIES: readonly LifecycleEdgeFamily[] = [
  "derivation",
  "provenance",
  "supersession",
] as const;

/**
 * The kind of act that gave birth to the edge. An edge is always the record of something that
 * HAPPENED, which is why this is non-null and why `event_ref` exists alongside it.
 */
export type LifecycleEdgeBirth = "correction" | "declaration" | "projection" | "ratification" | "extraction";

export const LIFECYCLE_EDGE_BIRTHS: readonly LifecycleEdgeBirth[] = [
  "correction",
  "declaration",
  "projection",
  "ratification",
  "extraction",
] as const;

/** Human verdicts a ratification can carry. Mirrors the `verdict` CHECK constraint. */
export type RatificationVerdict = "approve" | "reject" | "retire" | "re-ratify";

export const RATIFICATION_VERDICTS: readonly RatificationVerdict[] = [
  "approve",
  "reject",
  "retire",
  "re-ratify",
] as const;

/**
 * Which entrance a verdict came through (monet-core#142). The two are not two flavours of one act:
 * on `extraction` the four-gate battery is the gate and a human approves shown its evidence; on
 * `declaration` sovereignty REPLACES the battery, by right. Recording which one ran is what makes
 * "entered untested" readable instead of buried — it never makes it wrong.
 */
export type RatificationEntrance = "extraction" | "declaration";

export const RATIFICATION_ENTRANCES: readonly RatificationEntrance[] = ["extraction", "declaration"] as const;

// ---- row shapes (column names match the DB schema exactly) ------------------

export interface LifecycleEdgeRow {
  id: string;
  family: LifecycleEdgeFamily;
  src_concept_id: string;
  /** Non-null for derivation/supersession; always null for provenance. */
  dst_concept_id: string | null;
  /** Non-null for provenance (a `span://` URI); always null for the other two families. */
  dst_span: string | null;
  born_of: LifecycleEdgeBirth;
  /** The birth act's record — an observation id, a ratification id. Never null when ratification-born. */
  event_ref: string | null;
  /** Locality metadata, and the ONE mutable column: a circle rename rewrites it. Not part of the act. */
  circle: string;
  created_at: number;
  sync_updated_at: number;
  /** Convergence clock for `circle` only. Bumped by a rename, compared with `sync_writer` on graft. */
  sync_revision: number;
  sync_writer: string | null;
}

export interface RatificationRow {
  id: string;
  subject_concept_id: string;
  verdict: RatificationVerdict;
  /** JSON evidence packet exactly as shown to the human who ruled. Null when none was recorded. */
  packet: string | null;
  /**
   * Which entrance this verdict came through (monet-core#142). NULL on every row written before the
   * field existed — never inferred, see migrateRatificationColumns.
   *
   * With `verdict`, this is what separates #142's three indistinguishable states: never-ran is
   * `declaration` (sovereignty replaces the battery, by right), ran-and-passed is `extraction` +
   * approve, ran-and-rejected is `extraction` + reject.
   */
  entrance: RatificationEntrance | null;
  /** JSON `BatteryVerdict[]`. Non-null exactly on extraction rows; declaration rows carry none, by right. */
  battery: string | null;
  ratified_by: string | null;
  /** Locality metadata, and the ONE mutable column: a circle rename rewrites it. */
  circle: string;
  created_at: number;
  sync_updated_at: number;
  sync_revision: number;
  sync_writer: string | null;
}

// ---- inputs -----------------------------------------------------------------

export interface AddLifecycleEdgeInput {
  family: LifecycleEdgeFamily;
  srcConceptId: string;
  /** Required for derivation/supersession, forbidden for provenance. */
  dstConceptId?: string | null;
  /** Required for provenance (a `span://` URI), forbidden for the other two families. */
  dstSpan?: string | null;
  bornOf: LifecycleEdgeBirth;
  /** Required when `bornOf` is `ratification`; optional otherwise. */
  eventRef?: string | null;
}

export interface RecordRatificationInput {
  subjectConceptId: string;
  verdict: RatificationVerdict;
  /** The evidence packet as shown to the human. Serialized by the caller; stored verbatim. */
  packet?: string | null;
  ratifiedBy?: string | null;
  /**
   * Which entrance this verdict came through. Omitted only by callers that predate the field — new
   * code names it, because the whole point is that it stops being guessable after the fact.
   */
  entrance?: RatificationEntrance;
  /**
   * The four gates' answers. REQUIRED on an extraction approval and refused on a declaration:
   * sovereignty replaces the battery on the declaration entrance, so a battery recorded there would
   * be a test nobody ran. Rejections keep theirs — a rejection's value IS which gate it failed.
   */
  battery?: readonly BatteryVerdict[];
}

export type LifecycleEdgeDirection = "out" | "in" | "both";

export interface GetLifecycleEdgesOptions {
  family?: LifecycleEdgeFamily;
  direction: LifecycleEdgeDirection;
}

/**
 * The engine-owned collaborators this module needs. Passed in rather than reached for, so the table
 * API is testable against a bare database and the engine keeps ownership of id and clock policy.
 */
export interface LifecycleEdgeDeps {
  db: StoragePort;
  newId: () => string;
  /** The persisted sync clock (engine's `nextSyncTimestamp`), so these rows ride the same watermark. */
  nextSyncTimestamp: () => number;
  /** Stable store identity, recorded as the writer that authored the row's locality. */
  syncDeviceId: string;
}

// ---- schema -----------------------------------------------------------------

/**
 * Bare additive DDL, following the ~30 existing `CREATE TABLE IF NOT EXISTS` precedents in
 * `init()`. No schema-version bump: an older binary opening a newer store simply never reads these
 * tables, and a newer binary opening an older store creates them empty.
 *
 * The two paired CHECKs use SQLite's boolean-equality trick — `family = 'provenance'` and
 * `dst_span IS NOT NULL` each evaluate to 0/1, so `=` asserts they agree. Together they make the
 * family and the shape of the destination inseparable in BOTH directions: a provenance edge cannot
 * lack a span or carry a concept, and a derivation/supersession edge cannot carry a span or lack a
 * concept. (`family` is NOT NULL, so neither side can go three-valued.)
 *
 * The supersession UNIQUE index is partial: a rule has at most ONE direct successor. Chains form
 * across rows (A superseded-by B, later B superseded-by C), which the index permits because it
 * constrains the source only. Derivation and provenance are deliberately non-unique — a principle
 * derives many rules, and a rule corrected twice carries two evidence spans.
 */
export const LIFECYCLE_EDGE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS lifecycle_edges (
    id TEXT PRIMARY KEY,
    family TEXT NOT NULL CHECK (family IN ('derivation','provenance','supersession')),
    src_concept_id TEXT NOT NULL,
    dst_concept_id TEXT,
    dst_span TEXT,
    born_of TEXT NOT NULL CHECK (born_of IN ('correction','declaration','projection','ratification','extraction')),
    event_ref TEXT,          -- the birth act's record: observation id, ratification id
    circle TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sync_updated_at INTEGER NOT NULL,
    -- Convergence clock for the ONE mutable column, circle. A bare sync_updated_at comparison
    -- cannot decide this: the local value is the receiver's relay watermark and the incoming value
    -- is the sender's, two different clock domains that are not comparable. (revision, writer) is
    -- the house pattern for mutable row convergence (circle_aliases, first_block, sessions) and is
    -- clock-domain independent. Every act field stays immutable regardless.
    sync_revision INTEGER NOT NULL DEFAULT 0,
    sync_writer TEXT,
    CHECK ((family = 'provenance') = (dst_span IS NOT NULL)),
    CHECK ((family = 'provenance') = (dst_concept_id IS NULL)),
    -- A ratification-born edge without its ratification record is unauditable by construction.
    CHECK (born_of != 'ratification' OR event_ref IS NOT NULL),
    -- Nothing derives from, or supersedes, itself. Expressible in SQL, so enforced here rather than
    -- resting on the API check alone — a raw INSERT must not be able to create the cycle.
    CHECK (dst_concept_id IS NULL OR dst_concept_id != src_concept_id)
  );
  CREATE INDEX IF NOT EXISTS idx_lifecycle_edges_src ON lifecycle_edges(src_concept_id, family);
  CREATE INDEX IF NOT EXISTS idx_lifecycle_edges_dst ON lifecycle_edges(dst_concept_id, family)
    WHERE dst_concept_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_lifecycle_edges_circle ON lifecycle_edges(circle);
  -- Every incremental export scans this column over the whole table; index it like any other
  -- watermark. Additive CREATE INDEX IF NOT EXISTS, safe on an existing store by the same
  -- convention as the bare DDL above.
  CREATE INDEX IF NOT EXISTS idx_lifecycle_edges_sync ON lifecycle_edges(sync_updated_at);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_lifecycle_edges_supersession
    ON lifecycle_edges(src_concept_id) WHERE family = 'supersession';

  CREATE TABLE IF NOT EXISTS ratifications (
    id TEXT PRIMARY KEY,
    subject_concept_id TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('approve','reject','retire','re-ratify')),
    packet TEXT,             -- JSON evidence packet as shown to the human
    ratified_by TEXT,
    circle TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sync_updated_at INTEGER NOT NULL,
    -- Same reasoning as lifecycle_edges above: circle is the sole mutable column and converges on
    -- (revision, writer), not on the two incomparable relay clocks.
    sync_revision INTEGER NOT NULL DEFAULT 0,
    sync_writer TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ratifications_subject ON ratifications(subject_concept_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ratifications_circle ON ratifications(circle);
  CREATE INDEX IF NOT EXISTS idx_ratifications_sync ON ratifications(sync_updated_at);
`;

/** Idempotent; safe on every open. */
export function createLifecycleEdgeSchema(db: StoragePort): void {
  db.exec(LIFECYCLE_EDGE_SCHEMA_SQL);
  migrateRatificationColumns(db);
}

/**
 * THE FIRST ALTER THIS TABLE HAS EVER TAKEN — monet-core#142, `normative-hierarchy-2026-08-03.md`
 * §5. `ratifications` was born carrying every column it had; the bare `CREATE TABLE IF NOT EXISTS`
 * above was enough because nothing was ever added. These two are added, so the guard is needed for
 * every store that already exists.
 *
 * WHY THESE COLUMNS AND NOT A PARSE OF `packet`: #142's defect is that three states are one
 * observable — the battery ran and passed, it ran and rejected, it never ran. The information is
 * not entirely absent today; it is unaskable. A live store's own rows prove it: three carry
 * `battery: "Generates / Covers / Transfers / Exits — all four passed, run conversationally with
 * John"` inside `packet` — true, human, and impossible to query for whether Exits passed. `packet`
 * is contractually "stored verbatim and never parsed for decisions", and mining prose out of it
 * would make it retroactively load-bearing while manufacturing a precision the record never had.
 *
 * NULLABLE, AND LEGACY ROWS ARE LEFT NULL. No backfill, deliberately. For declaration-born rows an
 * `origin: "declaration"` key does sit in packet and could be read — but the extraction path has no
 * entrance marker at all, so "extraction wherever origin is absent" would be a guess dressed as a
 * record. NULL says the true thing: this verdict predates the field, and how it entered was never
 * recorded structurally. That is exactly #142's finding, preserved rather than papered over.
 */
function migrateRatificationColumns(db: StoragePort): void {
  const cols = db.prepare(`PRAGMA table_info(ratifications)`).all() as Array<{ name: string }>;
  const addColumn = (name: string, definition: string): void => {
    if (cols.some((c) => c.name === name)) return;
    try {
      db.exec(`ALTER TABLE ratifications ADD COLUMN ${name} ${definition}`);
    } catch (error) {
      // Concurrent opens race here; a duplicate column is the benign outcome, anything else is not.
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("duplicate column name")) throw error;
    }
  };
  addColumn("entrance", `TEXT CHECK (entrance IS NULL OR entrance IN ('extraction','declaration'))`);
  addColumn("battery", "TEXT");
}

/**
 * The four gates a principle must pass to enter the skeleton by extraction
 * (`next-monet-skeleton-gates-recall.md`, Part 1). Ordered as the doc states them; the order is
 * the record's, not an evaluation sequence — all four are answered together.
 */
export const BATTERY_GATES = ["generates", "covers", "transfers", "exits"] as const;
export type BatteryGate = (typeof BATTERY_GATES)[number];

/**
 * One gate's answer. `passed` is the verdict; `evidenceRef` is how it was reached — a pointer
 * (concept id, observation id, path, URL), never copied evidence content.
 *
 * THE POINT OF THE SHAPE: today this lives as a prose sentence inside `packet` and cannot be asked
 * which gate failed. Structured, "which principles entered on a failed Exits" becomes a query, and
 * the doc's own worked rejection — *"verify a prior step's success before depending on it"* fails
 * Exits, "inadmissible mechanically, no human judgment needed" — becomes a record rather than an
 * anecdote.
 */
export interface BatteryVerdict {
  gate: BatteryGate;
  passed: boolean;
  evidenceRef?: string;
}

/**
 * Refuses on FORM, never on content — the #134 write-refusal doctrine, and §2's "stubbornness":
 * Monet cannot know whether an answer is true, only whether one exists. All four gates must be
 * answered, each exactly once. It never asks whether the answer is a good one.
 */
/**
 * The entrance's own rules, enforced on FORM alone (monet-core#142, §5).
 *
 *  - An EXTRACTION approval must carry the battery. That entrance's whole claim is that four gates
 *    were answered; approving through it with no answers on file is the exact state #142 found —
 *    a skeleton whose entries cannot be asked whether anything gated them. A rejection must carry it
 *    too, and for a better reason: a rejection's entire value is WHICH gate it failed.
 *  - A DECLARATION must NOT carry one. Sovereignty replaces the battery there, by right — a battery
 *    recorded on that entrance would be a test nobody ran, which is worse than an admitted absence.
 *  - `retire` answers to neither: it ends a membership rather than judging a candidate.
 *
 * None of this judges an answer. It makes not-answering impossible, which is all a checklist can do.
 */
/**
 * THE ONE PLACE THE (verdict, entrance, battery) RULES LIVE.
 *
 * WHY IT IS ONE PLACE, and this is a design change rather than another patch: the same defect
 * arrived three times on PR #144 — a rule added to the local write path and not to the relay path,
 * or the reverse. Each fix was correct and each left the pair able to drift again, because the
 * invariant was written twice. Three occurrences of one shape is a class, and the house principle
 * says stop patching a class and return to design.
 *
 * The two callers differ only in what they DO about a violation, never in what counts as one:
 *   - a local write throws, because the author is present and can fix it;
 *   - a relayed row degrades to "unrecorded", because one bad ratification must not stop a sync and
 *     a fabricated entrance could never be told from a real one afterwards.
 */
export type RatificationPairVerdict = { ok: true } | { ok: false; reason: string };

export function classifyRatificationPair(
  verdict: RatificationVerdict,
  entrance: RatificationEntrance | null | undefined,
  battery: readonly BatteryVerdict[] | null | undefined,
): RatificationPairVerdict {
  const hasEntrance = entrance !== undefined && entrance !== null;
  const hasBattery = battery !== undefined && battery !== null;

  if (hasEntrance && !RATIFICATION_ENTRANCES.includes(entrance)) {
    return { ok: false, reason: `ratification entrance '${entrance}' is not one of ${RATIFICATION_ENTRANCES.join(", ")}` };
  }

  // A RETIREMENT ANSWERS TO NEITHER ENTRANCE. It ends a membership rather than judging a candidate,
  // and the entrance describes how a candidate was judged.
  if (verdict === "retire" && (hasEntrance || hasBattery)) {
    return { ok: false, reason: "a retirement carries no entrance or battery: it ends a membership rather than judging a candidate" };
  }

  // A BATTERY WITH NO ENTRANCE IS AN IMPOSSIBLE PAIR: curation reads the ruling as unrecorded while
  // the evidence sits right there, and replication drops the evidence entirely.
  if (hasBattery && !hasEntrance) {
    return { ok: false, reason: 'a battery needs its entrance named: pass entrance "extraction" alongside it' };
  }

  // SOVEREIGNTY REPLACES THE TEST on the declaration entrance, so a battery recorded there would be
  // a test nobody ran.
  if (entrance === "declaration" && hasBattery) {
    return { ok: false, reason: 'a declaration carries no battery: on that entrance sovereignty replaces the test' };
  }

  const judged = verdict === "approve" || verdict === "re-ratify" || verdict === "reject";
  if (entrance === "extraction" && judged) {
    if (!hasBattery) {
      return {
        ok: false,
        reason:
          `an extraction verdict must carry the battery it was reached through — all four of ` +
          `${BATTERY_GATES.join(", ")}. Without it the row is indistinguishable from one where the ` +
          `battery never ran (monet-core#142).`,
      };
    }
    try {
      assertBatteryShape(battery);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    // A FAILED GATE IS MECHANICALLY INADMISSIBLE on this entrance (Codex P1 on PR #144, and it was
    // right). The battery IS the gate here — the design's own worked example rejects a candidate for
    // failing Exits, "inadmissible mechanically, no human judgment needed" — so entering the
    // always-on skeleton over a failed answer would make the record say the battery passed something
    // it refused. A sovereign override has its own explicit route: the declaration entrance.
    //
    // Rejections keep their failed answers, and must: which gate refused is the whole value of one.
    if (verdict !== "reject") {
      const failed = battery.filter((gate) => !gate.passed).map((gate) => gate.gate);
      if (failed.length > 0) {
        return {
          ok: false,
          reason:
            `this battery failed ${failed.join(", ")}, so it cannot enter by extraction — a failed ` +
            `gate is inadmissible mechanically. Record the rejection with its battery, or enter by ` +
            `declaration if you are overriding the test on your own authority.`,
        };
      }
    }
  }
  return { ok: true };
}

/** The local write path: the author is present, so a violation is refused rather than degraded. */
export function assertRatificationEntranceRules(input: RecordRatificationInput): void {
  const verdict = classifyRatificationPair(input.verdict, input.entrance, input.battery);
  if (!verdict.ok) throw new Error(verdict.reason);
}

export function assertBatteryShape(battery: readonly BatteryVerdict[]): void {
  const seen = new Set<string>();
  for (const verdict of battery) {
    // SHAPE, NOT JUST MEMBERSHIP (Codex P1 on PR #144, and it was right). Checking gate names and
    // duplicates alone accepted `[{gate:"generates"}, …, {gate:"exits", passed:"yes"}]` — four
    // recognized gates and not one actual answer — which a relaying peer could then present as an
    // extraction-backed ruling. "All four gates are answered" has to mean answered.
    if (verdict === null || typeof verdict !== "object") {
      throw new Error("a battery verdict must be an object naming a gate and its answer");
    }
    if (typeof verdict.passed !== "boolean") {
      throw new Error(
        `battery gate '${String(verdict.gate)}' has no boolean answer: \`passed\` is required, and a ` +
          `gate that was not actually answered is the state this field exists to make visible.`,
      );
    }
    if (verdict.evidenceRef !== undefined && typeof verdict.evidenceRef !== "string") {
      throw new Error(`battery gate '${String(verdict.gate)}' has a non-string evidenceRef`);
    }
    if (!BATTERY_GATES.includes(verdict.gate)) {
      throw new Error(`battery gate '${verdict.gate}' is not one of ${BATTERY_GATES.join(", ")}`);
    }
    if (seen.has(verdict.gate)) throw new Error(`battery gate '${verdict.gate}' is answered twice`);
    seen.add(verdict.gate);
  }
  const missing = BATTERY_GATES.filter((gate) => !seen.has(gate));
  if (missing.length > 0) {
    throw new Error(
      `the battery is incomplete: ${missing.join(", ")} unanswered. All four gates are answered ` +
        `together or the record cannot say which one gated the entry — which is the whole defect ` +
        `this field exists to close (monet-core#142).`,
    );
  }
}

// ---- writes -----------------------------------------------------------------

interface EndpointRow {
  circle: string;
  kind: string;
  source_identity: string | null;
  active_observation_id: string | null;
}

function endpointRow(db: StoragePort, conceptId: string): EndpointRow | undefined {
  return db
    .prepare(`SELECT circle, kind, source_identity, active_observation_id FROM concepts WHERE id = ?`)
    .get(conceptId) as EndpointRow | undefined;
}

/**
 * Refuse a connector-owned or workstream endpoint AT WRITE TIME.
 *
 * Without this the write succeeds, the row is visible to every local read, and the export's
 * native-only kind guard then drops it forever — with no counter, no diagnostic, and no dangling
 * report (the endpoint resolves locally, so the sweep stays silent). That is exactly the
 * silent two-machines-disagree failure this substrate syncs to prevent, so the refusal belongs at
 * the moment of writing, where a caller can still act on it.
 *
 * `workstream` is included alongside the connector markers because a workstream is not a concept at
 * all — the design of record calls it a derived view over transcripts, stored only as cache — so it
 * can neither govern nor be governed.
 */
function assertGovernableEndpoint(row: EndpointRow, conceptId: string, role: "source" | "destination" | "subject"): void {
  const reason = ungovernableReason(row);
  if (reason) throw new Error(`lifecycle ${role} concept '${conceptId}' ${reason}`);
}

/**
 * THE governability predicate — one source of truth, shared by the local write path above and the
 * graft-side guard in engine.ts. Returns a reason string when the concept cannot carry normative
 * record, or null when it can. Kept as a predicate rather than a bare boolean so both call sites
 * report the same diagnosis.
 *
 * Takes the minimal row shape so a caller that has already selected the concept (graft resolves
 * endpoints one at a time) need not re-query.
 */
export function ungovernableReason(
  row: { kind: string; source_identity?: string | null; active_observation_id?: string | null },
): string | null {
  if (row.kind === "source" || row.source_identity != null || row.active_observation_id != null) {
    return `is connector-owned (kind '${row.kind}') and cannot carry normative record`;
  }
  if (row.kind === "workstream") {
    return `is a workstream (kind '${row.kind}'), which is derived cache and cannot carry normative record`;
  }
  return null;
}

/**
 * Hard cap on a supersession chain walk. Chains are append-only and grow one link per correction,
 * so a real one is short; a walk this long means the data is malformed (or a cycle slipped in
 * through some path this check does not cover), and looping forever is never the better answer.
 */
const SUPERSESSION_WALK_CAP = 1000;

/**
 * Reject a supersession edge that would close a cycle.
 *
 * The uniqueness index alone does not prevent one: A→B exists, and B→A passes every check because
 * B has no direct successor of its own. Longer rings are the same story. A cycle makes "every rule
 * is ultimately superseded by itself" true, which breaks any attempt to resolve the currently
 * governing rule by walking to the end of a chain. Walk forward from the proposed destination; if
 * the chain reaches the proposed source, the edge would close a ring.
 */
export type SupersessionCycle =
  /** Adding src → dst would close this ring (the full path, starting and ending at src). */
  | { kind: "cycle"; path: string[] }
  /** The existing chain is longer than any real one should be; refuse rather than loop. */
  | { kind: "cap"; hops: number };

/**
 * THE cycle walk — one source of truth, shared by the local write path below and the graft loop in
 * engine.ts (which cannot throw: an incoming ring must skip rows, not abort the whole graft).
 * Returns null when the edge is safe to add.
 */
export function supersessionCycle(
  db: StoragePort,
  srcConceptId: string,
  dstConceptId: string,
): SupersessionCycle | null {
  const successor = db.prepare(
    `SELECT dst_concept_id AS id FROM lifecycle_edges WHERE family = 'supersession' AND src_concept_id = ?`,
  );
  const path: string[] = [dstConceptId];
  let cursor = dstConceptId;
  for (let hop = 0; hop < SUPERSESSION_WALK_CAP; hop++) {
    if (cursor === srcConceptId) return { kind: "cycle", path: [srcConceptId, ...path] };
    const next = successor.get(cursor) as { id: string } | undefined;
    if (!next) return null; // reached the end of the chain — no cycle
    cursor = next.id;
    path.push(cursor);
  }
  return { kind: "cap", hops: SUPERSESSION_WALK_CAP };
}

function assertNoSupersessionCycle(db: StoragePort, srcConceptId: string, dstConceptId: string): void {
  const found = supersessionCycle(db, srcConceptId, dstConceptId);
  if (!found) return;
  if (found.kind === "cycle") {
    throw new Error(
      `supersession edge '${srcConceptId}' → '${dstConceptId}' would close a cycle: ${found.path.join(" → ")}`,
    );
  }
  throw new Error(
    `supersession chain from '${dstConceptId}' exceeds ${found.hops} hops without terminating; ` +
      `refusing to extend a chain this long`,
  );
}

/**
 * Record one normative edge.
 *
 * WHICH LAYER ENFORCES WHAT. The table itself enforces family vocabulary, born_of vocabulary, the
 * family/destination shape agreement, the ratification-born event_ref requirement, self-edges, and
 * supersession uniqueness — those hold against raw SQL. The checks below restate them only to
 * produce an error a caller can act on instead of a bare `CHECK constraint failed`, and to name the
 * incumbent on a supersession conflict. Three rules exist ONLY at this API layer (and, for incoming
 * sync, at the graft preflight), because SQL cannot see them without foreign keys: the span format,
 * that the endpoints exist, and that they are governable and share a circle.
 *
 * CROSS-CIRCLE IS CHECKED AT CREATION, NOT MAINTAINED. An edge may only be born within one circle —
 * a principle in one circle governing a rule in another is a thing the design has not decided, so
 * refuse rather than guess. But nothing preserves that property afterwards: an ordinary
 * reassignCircle one call later moves one endpoint and leaves a cross-circle edge standing, because
 * the row records the circle its ACT happened in and append-only forbids rewriting it. (A circle
 * RENAME is the exception and does follow — the locality itself is renamed, not the concept moved.)
 * A consumer must therefore treat `circle` as provenance, never as a live locality index.
 */
export function addLifecycleEdge(deps: LifecycleEdgeDeps, input: AddLifecycleEdgeInput): LifecycleEdgeRow {
  const { db } = deps;

  if (!LIFECYCLE_EDGE_FAMILIES.includes(input.family)) {
    throw new Error(`lifecycle edge family '${input.family}' is not one of ${LIFECYCLE_EDGE_FAMILIES.join(", ")}`);
  }
  if (!LIFECYCLE_EDGE_BIRTHS.includes(input.bornOf)) {
    throw new Error(`lifecycle edge born_of '${input.bornOf}' is not one of ${LIFECYCLE_EDGE_BIRTHS.join(", ")}`);
  }

  const dstConceptId = input.dstConceptId ?? null;
  const dstSpan = input.dstSpan ?? null;
  const eventRef = input.eventRef ?? null;

  if (input.family === "provenance") {
    if (dstSpan === null) throw new Error("a provenance lifecycle edge requires dstSpan");
    if (dstConceptId !== null) throw new Error("a provenance lifecycle edge must not carry dstConceptId");
    // The span namespace is the point: a provenance edge that accepted an ordinary source_refs
    // string would make "where did this rule come from" unanswerable without guessing a format.
    if (parseSpan(dstSpan) === null) {
      throw new Error(`provenance lifecycle edge dstSpan '${dstSpan}' is not a span:// URI`);
    }
  } else {
    if (dstConceptId === null) throw new Error(`a ${input.family} lifecycle edge requires dstConceptId`);
    if (dstSpan !== null) throw new Error(`a ${input.family} lifecycle edge must not carry dstSpan`);
    if (dstConceptId === input.srcConceptId) {
      throw new Error(`a ${input.family} lifecycle edge cannot point a concept at itself ('${input.srcConceptId}')`);
    }
  }

  if (input.bornOf === "ratification" && eventRef === null) {
    throw new Error("a ratification-born lifecycle edge requires eventRef naming its ratification record");
  }

  const src = endpointRow(db, input.srcConceptId);
  if (src === undefined) {
    throw new Error(`lifecycle edge source concept '${input.srcConceptId}' does not exist`);
  }
  assertGovernableEndpoint(src, input.srcConceptId, "source");
  const circle = src.circle;
  if (dstConceptId !== null) {
    const dst = endpointRow(db, dstConceptId);
    if (dst === undefined) {
      throw new Error(`lifecycle edge destination concept '${dstConceptId}' does not exist`);
    }
    assertGovernableEndpoint(dst, dstConceptId, "destination");
    if (dst.circle !== circle) {
      throw new Error(
        `lifecycle edge would cross circles: source '${input.srcConceptId}' is in '${circle}', ` +
          `destination '${dstConceptId}' is in '${dst.circle}'`,
      );
    }
  }

  if (input.family === "supersession") {
    // Name the incumbent. "UNIQUE constraint failed" tells a caller nothing about WHICH successor
    // already holds the slot, and that id is the whole content of the answer.
    const existing = db
      .prepare(`SELECT id, dst_concept_id FROM lifecycle_edges WHERE family = 'supersession' AND src_concept_id = ?`)
      .get(input.srcConceptId) as { id: string; dst_concept_id: string } | undefined;
    if (existing) {
      throw new Error(
        `concept '${input.srcConceptId}' is already superseded by '${existing.dst_concept_id}' ` +
          `(lifecycle edge '${existing.id}'); a rule has at most one direct successor`,
      );
    }
    assertNoSupersessionCycle(db, input.srcConceptId, dstConceptId!);
  }

  // A ratification-born edge asserts a human ruled on this, so the ruling must actually be on
  // record. Checking only that eventRef is non-null lets a typo produce an edge that claims
  // ratified authority and cites nothing — the worst possible failure for a substrate whose whole
  // job is making authority auditable.
  //
  // LOCAL WRITE PATH ONLY. Graft stays structural on purpose: normative rows relay independently of
  // endpoint liveness, and a relayed edge may legitimately arrive before (or without) the
  // ratification its peer holds. Enforcing existence there would discard exactly the audit trail
  // the relay exists to carry.
  if (input.bornOf === "ratification") {
    const ruling = db
      .prepare(`SELECT circle FROM ratifications WHERE id = ?`)
      .get(eventRef) as { circle: string } | undefined;
    if (ruling === undefined) {
      throw new Error(`lifecycle edge eventRef '${eventRef}' does not name a ratification on record`);
    }
    if (ruling.circle !== circle) {
      throw new Error(
        `lifecycle edge eventRef '${eventRef}' names a ratification in circle '${ruling.circle}', ` +
          `but the edge is in '${circle}'`,
      );
    }
  }

  const id = deps.newId();
  // `created_at` takes the persisted sync clock rather than Date.now(), unlike memory_edge's wall
  // -clock default. The clock is strictly monotonic, so two edges written in the same millisecond
  // still order deterministically — which matters because these rows are read as a RECORD OF ACTS
  // in sequence (which correction came first), and a wall-clock tie would fall back to comparing
  // UUIDs, i.e. to no order at all.
  const syncAt = deps.nextSyncTimestamp();
  const row: LifecycleEdgeRow = {
    id,
    family: input.family,
    src_concept_id: input.srcConceptId,
    dst_concept_id: dstConceptId,
    dst_span: dstSpan,
    born_of: input.bornOf,
    event_ref: eventRef,
    circle,
    created_at: syncAt,
    sync_updated_at: syncAt,
    sync_revision: 0,
    sync_writer: deps.syncDeviceId,
  };
  db.prepare(
    `INSERT INTO lifecycle_edges
       (id, family, src_concept_id, dst_concept_id, dst_span, born_of, event_ref, circle,
        created_at, sync_updated_at, sync_revision, sync_writer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.family, row.src_concept_id, row.dst_concept_id, row.dst_span,
    row.born_of, row.event_ref, row.circle, row.created_at, row.sync_updated_at,
    row.sync_revision, row.sync_writer,
  );
  return row;
}

/** Record a human ratification verdict over a concept. Append-only: a later verdict is a new row. */
export function recordRatification(deps: LifecycleEdgeDeps, input: RecordRatificationInput): RatificationRow {
  const { db } = deps;
  if (!RATIFICATION_VERDICTS.includes(input.verdict)) {
    throw new Error(`ratification verdict '${input.verdict}' is not one of ${RATIFICATION_VERDICTS.join(", ")}`);
  }
  const subject = endpointRow(db, input.subjectConceptId);
  if (subject === undefined) {
    throw new Error(`ratification subject concept '${input.subjectConceptId}' does not exist`);
  }
  assertGovernableEndpoint(subject, input.subjectConceptId, "subject");
  assertRatificationEntranceRules(input);
  const circle = subject.circle;
  const syncAt = deps.nextSyncTimestamp();
  const row: RatificationRow = {
    id: deps.newId(),
    subject_concept_id: input.subjectConceptId,
    verdict: input.verdict,
    packet: input.packet ?? null,
    entrance: input.entrance ?? null,
    battery: input.battery === undefined ? null : JSON.stringify(input.battery),
    ratified_by: input.ratifiedBy ?? null,
    circle,
    created_at: syncAt,
    sync_updated_at: syncAt,
    sync_revision: 0,
    sync_writer: deps.syncDeviceId,
  };
  db.prepare(
    `INSERT INTO ratifications
       (id, subject_concept_id, verdict, packet, entrance, battery, ratified_by, circle, created_at,
        sync_updated_at, sync_revision, sync_writer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.subject_concept_id, row.verdict, row.packet, row.entrance, row.battery,
    row.ratified_by, row.circle, row.created_at, row.sync_updated_at,
    row.sync_revision, row.sync_writer,
  );
  return row;
}

// ---- reads ------------------------------------------------------------------

/**
 * Edges touching `conceptId`. `direction: "in"` matches `dst_concept_id`, which no provenance edge
 * has — an inbound provenance query is therefore correctly empty rather than an error, since a
 * transcript span is not a queryable endpoint.
 */
export function getLifecycleEdges(
  db: StoragePort,
  conceptId: string,
  opts: GetLifecycleEdgesOptions,
): LifecycleEdgeRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.direction === "out") {
    where.push(`src_concept_id = ?`);
    params.push(conceptId);
  } else if (opts.direction === "in") {
    where.push(`dst_concept_id = ?`);
    params.push(conceptId);
  } else {
    where.push(`(src_concept_id = ? OR dst_concept_id = ?)`);
    params.push(conceptId, conceptId);
  }
  if (opts.family) {
    where.push(`family = ?`);
    params.push(opts.family);
  }
  return db
    .prepare(`SELECT * FROM lifecycle_edges WHERE ${where.join(" AND ")} ORDER BY created_at ASC, id ASC`)
    .all(...params) as LifecycleEdgeRow[];
}

/**
 * One hop along the derivation family: `"out"` yields the member rules a principle derives,
 * `"in"` the parent principles a rule was derived from. Deliberately ONE hop — multi-hop walking
 * (and the cycle handling it needs) arrives with the consumers that have a reason to want it.
 *
 * The returned ids are edge endpoints, NOT a guarantee that the concepts resolve locally: normative
 * rows replicate independently of endpoint liveness, so a synced store can hold an edge whose
 * endpoint concept has not arrived (or was deleted). Callers must fetch and handle the miss rather
 * than assume every id names a live concept.
 */
export function walkDerivation(db: StoragePort, conceptId: string, direction: "out" | "in"): string[] {
  const column = direction === "out" ? "dst_concept_id" : "src_concept_id";
  const match = direction === "out" ? "src_concept_id" : "dst_concept_id";
  const rows = db
    .prepare(
      `SELECT DISTINCT ${column} AS id FROM lifecycle_edges
        WHERE family = 'derivation' AND ${match} = ? AND ${column} IS NOT NULL
        ORDER BY id ASC`,
    )
    .all(conceptId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/** Ratifications over a concept, newest first. */
export function getRatifications(db: StoragePort, subjectConceptId: string): RatificationRow[] {
  return db
    .prepare(
      `SELECT * FROM ratifications WHERE subject_concept_id = ? ORDER BY created_at DESC, id DESC`,
    )
    .all(subjectConceptId) as RatificationRow[];
}
