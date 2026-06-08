/**
 * MonetCore — the state-centric substrate engine (ADR 0001).
 *
 * Two layers:
 *   - observation: immutable, append-only evidence (the Forensic Ledger)
 *   - concept:     mutable, deduplicated state node (the State Engine) = read surface
 *
 * Enrichment is split (ADR §4.6): Sift (deterministic, inline — embedding +
 * resolve-or-create #239) and Sieve (LLM, deferred — synthesis of the `body`).
 * Synthesis is lazy · agent-only · touch-triggered: `store` only marks a concept
 * `dirty`; synthesis runs via the `Synthesizer` seam when an agent *touches* it.
 *
 * Retrieval (ADR §4.5): `search` returns a structural CARD — what a memory is and how
 * much is in it — but NEVER its content. There is no prose `summary`: a summary reads
 * like an answer and stops agents from fetching (#232). The full content lives only in
 * `body`, reachable via `getConcept` (fetch).
 */
import { randomUUID } from "node:crypto";
import { StoragePort, BetterSqlitePort } from "./storage";
import { EmbeddingProvider, HashingEmbeddingProvider, cosine, blend, blendWeighted } from "./embedding";
import { Synthesizer, DeterministicSynthesizer } from "./synthesis";
import { extractEntities } from "./extract-entities";
import {
  spread,
  fuse,
  evidenceGapStop,
  rrfFuse,
  DEFAULT_GRAPH_PARAMS,
  type GraphParams,
  type Adj,
  type Ranked,
} from "./graph";

// ---- graph derivation tunables (#245, ADR §3.7) -------------------------
const EDGE_NEIGHBORS = 6; // top-M cosine neighbours per store (dedup argmax + `related` edges)
const MAX_NEIGHBORS = 25; // cap co-member / co-occurrence fan-out per store
const MAX_DF_ABS = 50; // entity hub gate (absolute concept frequency)
const MAX_DF_FRAC = 0.1; // entity hub gate (fraction of concepts in scope)
const RARE_DF_MAX = 5; // a structural entity this rare alone justifies an `about` edge
const EDGE_MIN_STRENGTH = 2.0; // else summed rarity·kindBoost over shared entities must reach this
const CO_OCCURRED_WEIGHT = 0.85;
const FOLLOWS_WEIGHT = 0.5;
const ASSERTED_WEIGHT = 0.95;
const SEED_K = 10; // gather seed-set size
const RRF_K = 60; // RRF constant for seed fusion
const KIND_BOOST: Record<string, number> = { path: 3, id: 3, err: 3, lib: 2, noun: 1 };
const DIRECTED_TYPES = ["follows", "supersedes", "contradicts", "resolves", "derived_from", "supports", "part_of"];
// Edges that may BOOST a similarity hit's rank: the "worked-on-together / causal" signals.
// about/related are excluded — they re-encode similarity and would reorder single-fact hits.
const THREAD_TYPES = new Set(["co_occurred", "follows", "supersedes", "contradicts", "resolves", "derived_from", "supports", "part_of"]);
const ASSERTED_RE = /\b(resolves|supersedes|derived-from|supports|contradicts)\s*:\s*#?([\w:-]+)/gi;
const GRAPH_SCHEMA_VERSION = 1; // PRAGMA user_version gate for the one-time graph backfill (P2)

export type IngestAction = "created" | "attached" | "ambiguous";

export interface Concept {
  id: string;
  slug: string;
  title: string; // identity (in the full system: a topic label, not the claim)
  body: string; // full synthesized content (fetch-only)
  kind: string;
  status: string;
  confidence: number;
  version: number;
  circle: string;
  supportCount: number;
  dirty: boolean;
}

/**
 * What `search` returns: shape + depth, never the claim. An agent can judge relevance
 * and see there's substance, but cannot lift an answer — so it must fetch (#232).
 */
export interface SearchCard {
  id: string;
  slug: string;
  kind: string;
  supportCount: number;
  contradictions: number;
  confidence: number;
  score: number;
  fetchHint: string;
}

export interface IngestResult {
  action: IngestAction;
  conceptId: string;
  score: number;
  concept: Concept;
  contradiction?: Contradiction; // set when a kind="correction" attaches to an existing concept
}

/**
 * The typed payload of a `workstream` concept (ADR §3.6) — the session-state survival
 * policy made concrete. The agent compresses a session into this at `checkpoint`; it
 * survives to the next session's prewarm. These slots SURVIVE; raw turns are EPHEMERAL.
 */
export interface WorkstreamPayload {
  status: "active" | "paused" | "done";
  openQuestions?: string[];
  confirmedContext?: string[];
  decisions?: string[];
  discardedAlternatives?: string[];
  importantEntities?: string[];
  nextSteps?: string[];
  lastSessionId?: string;
}

export interface Workstream {
  id: string;
  slug: string;
  title: string;
  circle: string;
  version: number;
  payload: WorkstreamPayload;
  updatedAt: number;
}

/** A living-model entry in prewarm — identity + shape, never the body (no-leak, §4.5). */
export interface LivingModelCard {
  id: string;
  title: string;
  kind: string;
  confidence: number;
  supportCount: number;
}

/** A surfaced conflict (ADR §3.5). The concept holds evidence in tension until resolved. */
export interface Contradiction {
  id: string;
  conceptId: string;
  observationId: string | null;
  kind: string; // value-conflict | staleness | scope-conflict
  status: string; // open | resolved | dismissed
  detail: string;
  resolutionObsId: string | null;
  detectedAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
}

/** Compact contradiction projection (joined with its concept's title) for prewarm/listing. */
export interface PrewarmContradiction {
  id: string;
  conceptId: string;
  conceptTitle: string;
  kind: string;
  detail: string;
}

/** Query-independent session-start state (ADR §4.2) returned by `prewarm` / `agent_context`. */
export interface PrewarmState {
  activeWorkstreams: Array<{
    id: string;
    title: string;
    status: string;
    openQuestions: string[];
    nextSteps: string[];
    decisions: string[];
  }>;
  topConcepts: LivingModelCard[];
  staleConcepts: LivingModelCard[]; // active but unconfirmed past staleAfterMs — surfaced for re-confirmation
  openContradictions: PrewarmContradiction[];
}

/** A gather result row: a search card plus why it was pulled in (#245, ADR §4.7). */
export interface GatherCard extends SearchCard {
  /** True if this concept matched the intent directly (a seed); false if reached via the graph. */
  viaSeed: boolean;
  sourceRefs?: string[];
}

/** What gather(intent) returns: the seed set, the ranked gathered set, and why it stopped. */
export interface GatherResult {
  seed: SearchCard[];
  ranked: GatherCard[];
  stopReason: string;
  /** Per-edge-type count of distinct concepts reachable from the seeds (explainability + anti-gaming). */
  reachableByType: Record<string, number>;
}

/** An entity hub (#245): a rare, shared anchor — "everything the agent knows touches X". */
export interface EntityHub {
  key: string;
  kind: string; // path | id | err | lib | noun
  surface: string;
  df: number;
  members: number; // distinct active concepts mentioning it
}

/** A concept ranked by THREAD-edge connectivity (worked-together/causal, not worded-similarly). */
export interface ConnectedConcept {
  id: string;
  title: string;
  kind: string;
  degree: number;
  confidence: number;
  status: string;
}

/**
 * A glanceable, read-only snapshot of everything stored for a circle (the "what your agent
 * knows" view). Composes prewarm (living model + threads + contradictions) + scoped counts +
 * the connection-graph shape. Carries identity/shape only — never concept bodies (§4.5).
 */
export interface MemoryOverview {
  circle: string;
  agentId: string;
  generatedAt: number;
  counts: {
    concepts: number;
    observations: number;
    dirty: number;
    workstreams: number;
    sessions: number;
    edges: number;
    entities: number;
    disputed: number;
    stale: number;
  };
  health: { avgConfidence: number; graphDensity: number };
  livingModel: LivingModelCard[];
  activeThreads: PrewarmState["activeWorkstreams"];
  openContradictions: PrewarmContradiction[];
  graph: {
    hubs: EntityHub[];
    connected: ConnectedConcept[];
    edgesByType: Array<{ type: string; count: number }>;
    thread: { label: string; size: number; members: Array<{ id: string; title: string; kind: string }> } | null;
  };
}

/**
 * One row of `listMemories` — a structural card for a stored concept, plus (optionally) the
 * project path(s) its evidence came from. Identity/shape only, NEVER the body (§4.5): the
 * migration agent groups by title + kind + provenance, then fetches a concept to read it.
 */
export interface MemoryListEntry {
  id: string;
  slug: string;
  title: string;
  kind: string;
  status: string;
  confidence: number;
  supportCount: number;
  contradictions: number;
  updatedAt: number;
  /** Distinct `scope_context` (working dir) of the sessions that authored this concept's
   *  observations — the recorded provenance. Present only when `withProvenance` is set. */
  provenance?: string[];
}

/** Outcome of `reassignCircle` — what the move did and which concept survived. */
export interface ReassignResult {
  /** moved: relocated as-is. merged: deduped into an existing target concept. noop: already there. */
  action: "moved" | "merged" | "noop";
  /** The surviving concept's id — the moved concept, or (on merge) the target it folded into. */
  conceptId: string;
  fromCircle: string;
  toCircle: string;
  /** Set on `merged`: the pre-existing target concept the source was absorbed into (== conceptId). */
  mergedIntoId?: string;
  /** Observations relocated into the target circle. */
  observationsMoved: number;
}

export interface MonetCoreOptions {
  embedder?: EmbeddingProvider;
  synthesizer?: Synthesizer;
  tauAttach?: number;
  tauAmbiguous?: number;
  agentId?: string;
  /** Where this runtime is working (repo/path) — recorded on the session (ADR §3.6). */
  scopeContext?: string;
  /** Circle used when a caller doesn't pass one. Lets a single shared store isolate per project:
   *  the runtime derives a stable circle from the working tree and every memory op lands in it. Default "default". */
  defaultCircle?: string;
  /** A concept unconfirmed for longer than this drifts active→stale (ADR §4.4). Default 30d. */
  staleAfterMs?: number;
  /** Id generator (default randomUUID). Inject a deterministic sequence for reproducible eval/tests. */
  idGen?: () => string;
  /** Build the connection graph at store time + enable gather() (#245). Default true. */
  graphEnabled?: boolean;
  /** Override spreading/fusion/stop tunables (ADR §3.7/§4.7). Merged over defaults. */
  graph?: Partial<GraphParams>;
  /** Min cosine for a `related` edge. Default: embedder-bound (0.45 MiniLM / 0.40 lexical). */
  edgeSimMin?: number;
}

interface ConceptRow {
  id: string;
  slug: string;
  title: string;
  body: string;
  kind: string;
  status: string;
  confidence: number;
  version: number;
  circle: string;
  embedding: string;
  support_count: number;
  dirty: number;
  updated_at: number;
  usefulness_score: number;
  source_refs: string | null;
}

interface ContradictionRow {
  id: string;
  concept_id: string;
  observation_id: string | null;
  kind: string;
  status: string;
  detail: string;
  resolution_obs_id: string | null;
  detected_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
}

export class MonetCore {
  private db: StoragePort;
  private embedder: EmbeddingProvider;
  private synthesizer: Synthesizer;
  private tauAttach: number;
  private tauAmbiguous: number;
  private agentId: string;
  private scopeContext: string | null;
  private defaultCircle: string;
  private staleAfterMs: number;
  private sessionId: string | null = null; // lazily opened on first write/checkpoint
  private graphEnabled: boolean;
  private graphParams: GraphParams;
  private edgeSimMin: number;
  private newId: () => string;
  /** The previous concept written in the current session, PER circle — for `follows` edges (ADR §3.7).
   *  Keyed by circle so a session that writes to several circles never chains `follows` across them. */
  private lastConceptByCircle = new Map<string, string>();

  /**
   * `db` is either a path for the default SQLite-backed store (":memory:" or a file), or a
   * pre-built StoragePort to run the engine on an alternative backend / an in-test fake. The
   * SQLite-specific connection setup (WAL + busy timeout, so the MCP server and a `monet` CLI
   * call can share one .monet DB without an immediate SQLITE_BUSY) lives in BetterSqlitePort.
   */
  constructor(db: string | StoragePort = ":memory:", opts: MonetCoreOptions = {}) {
    this.db = typeof db === "string" ? new BetterSqlitePort(db) : db;
    this.embedder = opts.embedder ?? new HashingEmbeddingProvider();
    this.synthesizer = opts.synthesizer ?? new DeterministicSynthesizer();
    // Thresholds belong with the embedding space (cosine distributions differ per model).
    // Precedence: explicit opt → the embedder's calibrated recommendation → legacy default.
    this.tauAttach = opts.tauAttach ?? this.embedder.recommendedThresholds?.tauAttach ?? 0.55;
    this.tauAmbiguous = opts.tauAmbiguous ?? this.embedder.recommendedThresholds?.tauAmbiguous ?? 0.4;
    this.agentId = opts.agentId ?? "local-agent";
    this.newId = opts.idGen ?? randomUUID;
    this.scopeContext = opts.scopeContext ?? null;
    this.defaultCircle = opts.defaultCircle ?? "default";
    this.staleAfterMs = opts.staleAfterMs ?? 30 * 24 * 60 * 60 * 1000; // 30 days
    this.graphEnabled = opts.graphEnabled ?? true;
    this.graphParams = { ...DEFAULT_GRAPH_PARAMS, ...opts.graph, wType: { ...DEFAULT_GRAPH_PARAMS.wType, ...opts.graph?.wType } };
    // A `related` edge needs more overlap than a semantic model implies; bind to the embedder scale.
    const semantic = (this.embedder.recommendedThresholds?.tauAttach ?? 0) >= 0.7;
    this.edgeSimMin = opts.edgeSimMin ?? (semantic ? 0.45 : 0.4);
    this.init();
    this.migrate();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        embedding TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'statement',
        circle TEXT NOT NULL DEFAULT 'default',
        concept_id TEXT,
        superseded_by TEXT,
        session_id TEXT,
        author_agent_id TEXT NOT NULL,
        source_refs TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        scope_context TEXT,
        started_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        ended_at INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        summary TEXT
      );
      CREATE TABLE IF NOT EXISTS concepts (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'fact',
        status TEXT NOT NULL DEFAULT 'active',
        confidence REAL NOT NULL DEFAULT 0.6,
        circle TEXT NOT NULL DEFAULT 'default',
        embedding TEXT NOT NULL,
        support_count INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 0,
        dirty INTEGER NOT NULL DEFAULT 0,
        usefulness_score INTEGER NOT NULL DEFAULT 0,
        source_refs TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE TABLE IF NOT EXISTS concept_revisions (
        id TEXT PRIMARY KEY,
        concept_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        body TEXT NOT NULL,
        trigger_observation_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE TABLE IF NOT EXISTS contradictions (
        id TEXT PRIMARY KEY,
        concept_id TEXT NOT NULL,
        observation_id TEXT,
        kind TEXT NOT NULL DEFAULT 'value-conflict',
        status TEXT NOT NULL DEFAULT 'open',
        detail TEXT NOT NULL DEFAULT '',
        resolution_obs_id TEXT,
        detected_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        resolved_at INTEGER,
        resolved_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_concept_circle ON concepts(circle);
      CREATE INDEX IF NOT EXISTS idx_concept_kind ON concepts(circle, kind);
      CREATE INDEX IF NOT EXISTS idx_concept_dirty ON concepts(dirty);
      CREATE INDEX IF NOT EXISTS idx_obs_concept ON observations(concept_id);
      CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id);
      CREATE INDEX IF NOT EXISTS idx_contradiction_concept ON contradictions(concept_id, status);

      -- Connection graph (ADR §3.7, #245). First-class, TRAVERSED edges — not dead metadata.
      -- All edges are concept→concept and scoped to a circle; spread never crosses scope.
      CREATE TABLE IF NOT EXISTS memory_edge (
        id TEXT PRIMARY KEY,
        src_id TEXT NOT NULL,
        src_type TEXT NOT NULL DEFAULT 'concept',
        dst_id TEXT NOT NULL,
        dst_type TEXT NOT NULL DEFAULT 'concept',
        type TEXT NOT NULL,                       -- about|related|co_occurred|follows|supersedes|contradicts|resolves|derived_from|supports|part_of
        weight REAL NOT NULL DEFAULT 0.6,
        origin TEXT NOT NULL DEFAULT 'cheap',     -- cheap|nn|ingest|asserted|coaccess
        count INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        last_reinforced_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        scope TEXT NOT NULL DEFAULT 'default'
      );
      CREATE INDEX IF NOT EXISTS idx_edge_src ON memory_edge(src_id, type);
      CREATE INDEX IF NOT EXISTS idx_edge_dst ON memory_edge(dst_id, type);
      CREATE INDEX IF NOT EXISTS idx_edge_scope ON memory_edge(scope);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_edge ON memory_edge(src_id, dst_id, type, scope);

      -- Entity hubs backing about-edges (ADR §3.7). Entities are NOT concepts (never searched).
      CREATE TABLE IF NOT EXISTS entities (
        key TEXT NOT NULL,
        kind TEXT NOT NULL,
        surface TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'default',
        df INTEGER NOT NULL DEFAULT 0,            -- per-scope concept frequency (rarity signal)
        PRIMARY KEY (key, scope)
      );
      CREATE TABLE IF NOT EXISTS concept_entities (
        concept_id TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'default',
        PRIMARY KEY (concept_id, entity_key, scope)
      );
      CREATE INDEX IF NOT EXISTS idx_ce_entity ON concept_entities(entity_key, scope);
      CREATE INDEX IF NOT EXISTS idx_ce_concept ON concept_entities(concept_id);
    `);
  }

  /** Guarded migration for older DBs: add source_refs columns if missing (SQLite has no ADD COLUMN IF NOT EXISTS). */
  private migrate(): void {
    for (const table of ["observations", "concepts"]) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "source_refs")) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN source_refs TEXT`);
      }
    }
    // One-time graph backfill for pre-graph DBs (P2, Codex review): the graph tables exist but hold no
    // edges for concepts stored before the graph feature. Version-gated so it runs at most once, and only
    // when the graph is enabled — a graph-disabled open must NOT consume the upgrade slot (the next
    // graph-enabled open should still backfill).
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (this.graphEnabled && version < GRAPH_SCHEMA_VERSION) {
      this.backfillGraph();
      this.db.pragma(`user_version = ${GRAPH_SCHEMA_VERSION}`);
    }
  }

  /** Sift tier (inline): append observation → embed → resolve-or-create → derive edges. Marks dirty. */
  async store(content: string, opts: { circle?: string; kind?: string; sourceRefs?: string[] } = {}): Promise<IngestResult> {
    const circle = opts.circle ?? this.defaultCircle;
    const emb = await this.embedder.embed(content);
    const obsId = this.newId();
    const sessionId = this.ensureSession();
    const sourceRefs = opts.sourceRefs ?? [];
    const refsJson = sourceRefs.length ? JSON.stringify(sourceRefs) : null;

    this.db
      .prepare(
        `INSERT INTO observations (id, content, embedding, kind, circle, session_id, author_agent_id, source_refs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(obsId, content, embToJson(emb), opts.kind ?? "statement", circle, sessionId, this.agentId, refsJson);

    // ONE cosine scan serves both dedup (argmax) and `related` edge derivation (top-M) — no extra cost.
    const matches = this.bestMatches(emb, circle, EDGE_NEIGHBORS);
    const { match, score } = matches[0] ?? { match: null, score: 0 };

    let action: IngestAction;
    let row: ConceptRow;
    if (match && score >= this.tauAttach) {
      action = "attached";
      row = this.attach(match, content, emb);
    } else if (match && score >= this.tauAmbiguous) {
      action = "ambiguous"; // conservative dedup: surface, but still attach (never silently fork)
      row = this.attach(match, content, emb);
    } else {
      action = "created";
      row = this.create(content, emb, circle, opts.kind);
    }

    this.db.prepare(`UPDATE observations SET concept_id = ? WHERE id = ?`).run(row.id, obsId);

    // MERGE refs into the concept (don't replace): later evidence attaching from a different file/URL
    // must not erase earlier return-to-source pointers. Recorded UNCONDITIONALLY — NOT gated on the
    // graph: gather()/toGatherCard and any source-keyed lookup read the concept-level `source_refs`, so
    // a graph-disabled store must still record provenance. Otherwise a re-ingest/idempotency check that
    // keys on the source pointer (e.g. the consolidation playbook's "did I already capture this file?")
    // would wrongly report "never captured" on a graph-off runtime.
    if (sourceRefs.length) {
      const cur = this.db.prepare(`SELECT source_refs FROM concepts WHERE id = ?`).get(row.id) as
        | { source_refs: string | null }
        | undefined;
      const existing = cur?.source_refs ? (JSON.parse(cur.source_refs) as string[]) : [];
      const merged = [...new Set([...existing, ...sourceRefs])];
      this.db.prepare(`UPDATE concepts SET source_refs = ? WHERE id = ?`).run(JSON.stringify(merged), row.id);
    }

    if (this.graphEnabled) {
      this.deriveEdges(row.id, content, sourceRefs, circle, sessionId, matches);
      this.lastConceptByCircle.set(circle, row.id);
    }

    // Contradiction detection is agent-judged, expressed cheaply: a "correction" that lands on
    // an EXISTING concept is the agent saying "this overrides what's there" → open a conflict
    // (ADR §4.1 step 4 / §4.6). Novel corrections (action="created") have nothing to contradict.
    let contradiction: Contradiction | undefined;
    if (opts.kind === "correction" && (action === "attached" || action === "ambiguous")) {
      contradiction = this.flagContradiction(row.id, {
        observationId: obsId,
        kind: "value-conflict",
        detail: `correction: ${firstLine(content)}`,
      });
      row = this.getRow(row.id)!; // reflect disputed status + decayed confidence
    }
    return { action, conceptId: row.id, score, concept: toConcept(row), contradiction };
  }

  /**
   * Tier-1 read: returns a structural CARD per match — kind, depth, confidence, a fetch
   * hint — and deliberately NO content. Never triggers synthesis. (ADR §4.5, #232.)
   */
  async search(query: string, opts: { circle?: string; limit?: number } = {}): Promise<SearchCard[]> {
    const circle = opts.circle ?? this.defaultCircle;
    const limit = opts.limit ?? 5;
    const emb = await this.embedder.embed(query);
    // Workstreams are identity-upserted state, not embedding-resolved knowledge — keep them
    // out of dedup candidates and search cards (they're restored via getActiveWorkstreams).
    const rows = this.db
      .prepare(`SELECT * FROM concepts WHERE circle = ? AND kind != 'workstream'`)
      .all(circle) as ConceptRow[];
    const contradictions = this.openContradictionCounts(circle);
    return rows
      .map((r) => ({ row: r, score: cosine(emb, jsonToEmb(r.embedding)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ row, score }) => toCard(row, score, contradictions.get(row.id) ?? 0));
  }

  /**
   * Tier-2 read (touch): returns the full concept + evidence.
   * `synthesize: true` (default, in-process) runs the injected Synthesizer if dirty.
   * `synthesize: false` (agent-driven / MCP) returns raw evidence + `needsSynthesis`,
   * leaving the dirty flag for the host agent to clear via `applySynthesis`.
   */
  async getConcept(
    id: string,
    opts: { synthesize?: boolean } = {},
  ): Promise<
    (Concept & { observations: string[]; revisions: number; synthesizedNow: boolean; needsSynthesis: boolean }) | null
  > {
    let row = this.getRow(id);
    if (!row) return null;
    // A fetch is a "touch": it signals the concept was useful (drives prewarm ranking, §4.2).
    this.db.prepare(`UPDATE concepts SET usefulness_score = usefulness_score + 1 WHERE id = ?`).run(id);
    const synthesizedNow = row.dirty === 1 && (opts.synthesize ?? true);
    if (synthesizedNow) row = await this.synthesizeRow(row);

    const obs = this.db
      .prepare(`SELECT content FROM observations WHERE concept_id = ? ORDER BY created_at`)
      .all(id) as Array<{ content: string }>;
    const revs = this.db.prepare(`SELECT COUNT(*) AS n FROM concept_revisions WHERE concept_id = ?`).get(id) as {
      n: number;
    };
    return {
      ...toConcept(row),
      observations: obs.map((o) => o.content),
      revisions: revs.n,
      synthesizedNow,
      needsSynthesis: row.dirty === 1,
    };
  }

  /** Session checkpoint (touch, batch): synthesize every dirty concept. Returns the count. */
  async checkpoint(circle?: string): Promise<number> {
    circle ??= this.defaultCircle; // honor the per-project default; pass a circle explicitly to scope elsewhere
    const rows = this.db.prepare(`SELECT * FROM concepts WHERE dirty = 1 AND circle = ?`).all(circle) as ConceptRow[];
    for (const r of rows) await this.synthesizeRow(r);
    return rows.length;
  }

  /**
   * Session-state survival (ADR §4.3): the agent compresses a session into a workstream
   * payload; this elevates it into the circle's `workstream` concept (create or update —
   * versioned, with a revision) and ends the current session. Agent-authored, so it is
   * never marked dirty. Restored next session via getActiveWorkstreams / prewarm (#242).
   */
  async saveWorkstream(payload: WorkstreamPayload, opts: { circle?: string; summary?: string } = {}): Promise<Workstream> {
    const circle = opts.circle ?? this.defaultCircle;
    const sessionId = this.ensureSession();
    const full: WorkstreamPayload = { ...payload, lastSessionId: sessionId };
    const slug = `workstream:${circle}`;
    const body = JSON.stringify(full, null, 2);
    const title = workstreamTitle(full);
    const emb = await this.embedder.embed(workstreamText(full)); // column is NOT NULL; not used for dedup

    const existing = this.db
      .prepare(`SELECT * FROM concepts WHERE circle = ? AND kind = 'workstream' AND slug = ?`)
      .get(circle, slug) as ConceptRow | undefined;

    let id: string;
    let version: number;
    if (existing) {
      id = existing.id;
      version = existing.version + 1;
      this.db
        .prepare(
          `UPDATE concepts
              SET body = ?, title = ?, embedding = ?, version = ?, status = 'active',
                  dirty = 0, updated_at = unixepoch() * 1000
            WHERE id = ?`,
        )
        .run(body, title, embToJson(emb), version, id);
    } else {
      id = this.newId();
      version = 0;
      this.db
        .prepare(
          `INSERT INTO concepts (id, slug, title, body, kind, status, embedding, support_count, version, dirty, circle)
           VALUES (?, ?, ?, ?, 'workstream', 'active', ?, 1, 0, 0, ?)`,
        )
        .run(id, slug, title, body, embToJson(emb), circle);
    }
    this.writeRevision(id, version, body);
    this.endSession(opts.summary);
    return toWorkstream(this.getRow(id)!);
  }

  /** Restore a circle's active/paused workstreams (the read path prewarm #242 consumes). */
  getActiveWorkstreams(circle?: string): Workstream[] {
    circle ??= this.defaultCircle;
    const rows = this.db
      .prepare(`SELECT * FROM concepts WHERE circle = ? AND kind = 'workstream' AND status != 'archived'`)
      .all(circle) as ConceptRow[];
    return rows.map(toWorkstream).filter((w) => w.payload.status !== "done");
  }

  /**
   * Prewarm (ADR §4.2): query-independent session-start state for a circle. Returns
   * SYNTHESIZED state, not a query — where you left off (active workstreams), the living
   * model (top concepts ranked by confidence × usefulness × recency), and open
   * contradictions. Bounded + ranked. Carries identity/shape, never concept bodies
   * (the no-answer-leak rule, §4.5) — the agent fetches a concept when it needs content.
   */
  prewarm(circle?: string, opts: { conceptLimit?: number } = {}): PrewarmState {
    circle ??= this.defaultCircle;
    const conceptLimit = opts.conceptLimit ?? 7;
    const now = Date.now();

    const activeWorkstreams = this.getActiveWorkstreams(circle).map((w) => ({
      id: w.id,
      title: w.title,
      status: w.payload.status,
      openQuestions: w.payload.openQuestions ?? [],
      nextSteps: w.payload.nextSteps ?? [],
      decisions: w.payload.decisions ?? [],
    }));

    // Living model = ACTIVE concepts only, partitioned fresh (ranked top) vs stale (surfaced for
    // re-confirmation). Disputed concepts are surfaced via openContradictions, not the top list.
    const active = this.db
      .prepare(`SELECT * FROM concepts WHERE circle = ? AND kind != 'workstream' AND status = 'active'`)
      .all(circle) as ConceptRow[];
    const isStale = (r: ConceptRow): boolean => now - r.updated_at > this.staleAfterMs;
    const topConcepts = active
      .filter((r) => !isStale(r))
      .map((r) => ({ r, score: livingModelScore(r, now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, conceptLimit)
      .map(({ r }) => livingModelCard(r));
    const staleConcepts = active.filter(isStale).map(livingModelCard);

    return { activeWorkstreams, topConcepts, staleConcepts, openContradictions: this.getOpenContradictions(circle) };
  }

  /**
   * Open a contradiction on a concept (ADR §4.4): record the conflict, flip status → disputed,
   * decay confidence. The judgment is the agent's (it called this, or stored a kind="correction");
   * the structural consequence is the substrate's. Mediated later via resolveContradiction.
   */
  flagContradiction(conceptId: string, opts: { observationId?: string; detail?: string; kind?: string } = {}): Contradiction {
    const row = this.getRow(conceptId);
    if (!row) throw new Error(`concept not found: ${conceptId}`);
    const id = this.newId();
    this.db
      .prepare(
        `INSERT INTO contradictions (id, concept_id, observation_id, kind, status, detail)
         VALUES (?, ?, ?, ?, 'open', ?)`,
      )
      .run(id, conceptId, opts.observationId ?? null, opts.kind ?? "value-conflict", opts.detail ?? "");
    this.db
      .prepare(`UPDATE concepts SET status = 'disputed', confidence = ?, updated_at = unixepoch() * 1000 WHERE id = ?`)
      .run(Math.max(0.1, row.confidence - 0.3), conceptId);
    return toContradiction(this.db.prepare(`SELECT * FROM contradictions WHERE id = ?`).get(id) as ContradictionRow);
  }

  /**
   * Mediate a contradiction (ADR §4.4) — never silent last-write-wins. accept-new: the correcting
   * observation wins; keep-current: the prior wins; dismiss: not a real conflict. The loser is
   * superseded; the agent's reconciled `body` (if given) is written; the concept restores to
   * active + confidence once no open contradictions remain. Returns the updated concept.
   */
  resolveContradiction(
    contradictionId: string,
    opts: { decision: "accept-new" | "keep-current" | "dismiss"; body?: string; by?: string },
  ): Concept | null {
    const c = this.db.prepare(`SELECT * FROM contradictions WHERE id = ?`).get(contradictionId) as ContradictionRow | undefined;
    if (!c) return null;
    const conceptId = c.concept_id;

    if (opts.decision === "dismiss") {
      this.db
        .prepare(`UPDATE contradictions SET status = 'dismissed', resolved_at = unixepoch() * 1000, resolved_by = ? WHERE id = ?`)
        .run(opts.by ?? null, contradictionId);
    } else {
      const allIds = (
        this.db.prepare(`SELECT id FROM observations WHERE concept_id = ? ORDER BY created_at`).all(conceptId) as Array<{ id: string }>
      ).map((o) => o.id);
      const priors = allIds.filter((oid) => oid !== c.observation_id);
      const winnerObsId = opts.decision === "accept-new" ? c.observation_id : priors[priors.length - 1] ?? null;

      if (winnerObsId) {
        const supersede = this.db.prepare(`UPDATE observations SET superseded_by = ? WHERE id = ?`);
        for (const loser of allIds.filter((oid) => oid !== winnerObsId)) supersede.run(winnerObsId, loser);
      }
      if (opts.body !== undefined) {
        const row = this.getRow(conceptId)!;
        const version = row.version + 1;
        this.db
          .prepare(`UPDATE concepts SET body = ?, version = ?, updated_at = unixepoch() * 1000 WHERE id = ?`)
          .run(opts.body, version, conceptId);
        this.writeRevision(conceptId, version, opts.body);
      }
      this.db
        .prepare(
          `UPDATE contradictions SET status = 'resolved', resolution_obs_id = ?, resolved_at = unixepoch() * 1000, resolved_by = ? WHERE id = ?`,
        )
        .run(winnerObsId, opts.by ?? null, contradictionId);
    }

    // Restore the concept once nothing is left open against it.
    const open = this.db.prepare(`SELECT COUNT(*) AS n FROM contradictions WHERE concept_id = ? AND status = 'open'`).get(conceptId) as {
      n: number;
    };
    if (open.n === 0) {
      const row = this.getRow(conceptId)!;
      this.db
        .prepare(`UPDATE concepts SET status = 'active', confidence = ?, updated_at = unixepoch() * 1000 WHERE id = ?`)
        .run(Math.min(1, row.confidence + 0.2), conceptId);
    }
    return toConcept(this.getRow(conceptId)!);
  }

  /** Open contradictions in a circle, joined with concept titles (prewarm + listing). */
  getOpenContradictions(circle?: string): PrewarmContradiction[] {
    circle ??= this.defaultCircle;
    return this.db
      .prepare(
        `SELECT k.id AS id, k.concept_id AS conceptId, c.title AS conceptTitle, k.kind AS kind, k.detail AS detail
           FROM contradictions k JOIN concepts c ON c.id = k.concept_id
          WHERE k.status = 'open' AND c.circle = ?
          ORDER BY k.detected_at DESC`,
      )
      .all(circle) as PrewarmContradiction[];
  }

  /** Active concepts unconfirmed past staleAfterMs (ADR §4.4) — detectable + surfaced at prewarm. */
  getStaleConcepts(circle?: string): LivingModelCard[] {
    circle ??= this.defaultCircle;
    const now = Date.now();
    const rows = this.db
      .prepare(`SELECT * FROM concepts WHERE circle = ? AND kind != 'workstream' AND status = 'active'`)
      .all(circle) as ConceptRow[];
    return rows.filter((r) => now - r.updated_at > this.staleAfterMs).map(livingModelCard);
  }

  /** Count of observations superseded by a correction/resolution (observability + tests). */
  supersededObservationCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM observations WHERE superseded_by IS NOT NULL`).get() as { n: number }).n;
  }

  private openContradictionCounts(circle: string): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT k.concept_id AS cid, COUNT(*) AS n FROM contradictions k JOIN concepts c ON c.id = k.concept_id
          WHERE k.status = 'open' AND c.circle = ? GROUP BY k.concept_id`,
      )
      .all(circle) as Array<{ cid: string; n: number }>;
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.cid, r.n);
    return m;
  }

  /** Agent-driven synthesis (MCP): the host LLM writes the body back. Clears dirty, records a revision. */
  async applySynthesis(id: string, body: string): Promise<Concept | null> {
    const row = this.getRow(id);
    if (!row) return null;
    this.db
      .prepare(`UPDATE concepts SET body = ?, dirty = 0, updated_at = unixepoch() * 1000 WHERE id = ?`)
      .run(body, id);
    this.writeRevision(id, row.version, body);
    return toConcept(this.getRow(id)!);
  }

  /** Concepts with unsynthesized evidence + their raw observations (for the agent to synthesize). */
  listDirty(circle?: string): Array<{ id: string; slug: string; kind: string; observations: string[] }> {
    circle ??= this.defaultCircle; // honor the per-project default; pass a circle explicitly to scope elsewhere
    const rows = this.db.prepare(`SELECT * FROM concepts WHERE dirty = 1 AND circle = ?`).all(circle) as ConceptRow[];
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      kind: r.kind,
      observations: (
        this.db
          .prepare(`SELECT content FROM observations WHERE concept_id = ? ORDER BY created_at`)
          .all(r.id) as Array<{ content: string }>
      ).map((o) => o.content),
    }));
  }

  /**
   * Enumerate every concept in a circle as a structural card (no bodies — §4.5), optionally with
   * the project path(s) its observations came from. The read surface the interactive memory
   * migration leans on: group "default" by content + provenance, then reassignCircle each into its
   * project's circle. Workstreams are excluded (identity-scoped session state, not knowledge).
   * Ordered recency-first (updated_at desc, id asc) for a stable, reviewable listing.
   */
  listMemories(circle?: string, opts: { withProvenance?: boolean; limit?: number; offset?: number } = {}): MemoryListEntry[] {
    circle ??= this.defaultCircle;
    // Bounded paging (a real legacy circle can exceed the host's tool-result cap): pass limit/offset to
    // page through; omit limit for the full circle (internal callers/tests). Stable order makes paging safe.
    const params: Array<string | number> = [circle];
    let sql = `SELECT * FROM concepts WHERE circle = ? AND kind != 'workstream' ORDER BY updated_at DESC, id`;
    if (opts.limit != null) {
      sql += ` LIMIT ? OFFSET ?`;
      params.push(Math.max(0, Math.floor(opts.limit)), Math.max(0, Math.floor(opts.offset ?? 0)));
    }
    const rows = this.db.prepare(sql).all(...params) as ConceptRow[];
    const contradictions = this.openContradictionCounts(circle);

    // Provenance only for the page's concepts: distinct session scope_context per returned concept.
    const provByConcept = new Map<string, string[]>();
    if (opts.withProvenance && rows.length) {
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      const prov = this.db
        .prepare(
          `SELECT o.concept_id AS cid, s.scope_context AS scope
             FROM observations o JOIN sessions s ON s.id = o.session_id
            WHERE o.concept_id IN (${placeholders}) AND s.scope_context IS NOT NULL
            GROUP BY o.concept_id, s.scope_context
            ORDER BY o.concept_id, s.scope_context`,
        )
        .all(...ids) as Array<{ cid: string; scope: string }>;
      for (const p of prov) {
        const list = provByConcept.get(p.cid) ?? [];
        list.push(p.scope);
        provByConcept.set(p.cid, list);
      }
    }

    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      kind: r.kind,
      status: r.status,
      confidence: Number(r.confidence.toFixed(2)),
      supportCount: r.support_count,
      contradictions: contradictions.get(r.id) ?? 0,
      updatedAt: r.updated_at,
      ...(opts.withProvenance ? { provenance: provByConcept.get(r.id) ?? [] } : {}),
    }));
  }

  getAgentId(): string {
    return this.agentId;
  }

  /** The circle applied when a caller passes none (per-project isolation in a shared store). */
  getDefaultCircle(): string {
    return this.defaultCircle;
  }

  /** The circle a concept lives in, or null if it doesn't exist — for id-based scope enforcement. */
  circleOf(conceptId: string): string | null {
    const r = this.db.prepare(`SELECT circle FROM concepts WHERE id = ?`).get(conceptId) as { circle: string } | undefined;
    return r?.circle ?? null;
  }

  /** The circle of the concept a contradiction belongs to, or null — for id-based scope enforcement. */
  circleOfContradiction(contradictionId: string): string | null {
    const r = this.db
      .prepare(`SELECT c.circle AS circle FROM contradictions k JOIN concepts c ON c.id = k.concept_id WHERE k.id = ?`)
      .get(contradictionId) as { circle: string } | undefined;
    return r?.circle ?? null;
  }

  /**
   * Move a concept — its observations and its graph membership (entities + edges) — from its
   * current circle into `toCircle`. The apply step of the interactive memory migration: organize
   * a pile of unscoped "default" memory into per-project circles. Dedupes: if `toCircle` already
   * holds a concept this one resolves to (cosine ≥ tauAttach), the two MERGE — the source's
   * evidence, support, and vector fold into the target and the source row is removed (no duplicate,
   * no re-embedding). Otherwise the concept relocates as-is and re-homes its graph in the new
   * circle. Atomic. Returns what happened, or null if `id` doesn't exist. Workstreams (identity-
   * scoped session state, not knowledge) cannot be reassigned.
   */
  reassignCircle(id: string, toCircle: string): ReassignResult | null {
    const src = this.getRow(id);
    if (!src) return null;
    if (src.kind === "workstream") throw new Error("cannot reassign a workstream concept");
    const fromCircle = src.circle;
    if (fromCircle === toCircle) {
      return { action: "noop", conceptId: id, fromCircle, toCircle, observationsMoved: 0 };
    }
    // Dedup target: the best match already in toCircle (bestMatches excludes workstreams; the source
    // lives in fromCircle, so it can never match itself). score ≥ tauAttach ⇒ "same concept" ⇒ merge.
    const top = this.bestMatches(jsonToEmb(src.embedding), toCircle, 1)[0];
    const mergeInto = top && top.score >= this.tauAttach ? top.match : null;
    const result = this.db.transaction(() =>
      mergeInto ? this.mergeConceptInto(src, mergeInto, toCircle) : this.moveConcept(src, toCircle),
    )();
    // `follows` is in-memory + circle-keyed: the source just left (or ceased to exist in) fromCircle,
    // so a later store there must not chain a follows edge onto it (it would point out-of-circle / at a
    // deleted row). Drop any lastConcept pointer to it.
    for (const [c, v] of this.lastConceptByCircle) if (v === src.id) this.lastConceptByCircle.delete(c);
    return result;
  }

  conceptCount(circle?: string): number {
    circle ??= this.defaultCircle;
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM concepts WHERE circle = ? AND kind != 'workstream'`)
      .get(circle) as { n: number };
    return r.n;
  }

  observationCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM observations`).get() as { n: number }).n;
  }

  stats(): { concepts: number; observations: number; dirty: number; workstreams: number; sessions: number } {
    const n = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      concepts: n(`SELECT COUNT(*) AS n FROM concepts WHERE kind != 'workstream'`),
      observations: n(`SELECT COUNT(*) AS n FROM observations`),
      dirty: n(`SELECT COUNT(*) AS n FROM concepts WHERE dirty = 1`),
      workstreams: n(`SELECT COUNT(*) AS n FROM concepts WHERE kind = 'workstream'`),
      sessions: n(`SELECT COUNT(*) AS n FROM sessions`),
    };
  }

  isDirty(id: string): boolean {
    return this.getRow(id)?.dirty === 1;
  }

  /** Observability/testing: list connection-graph edges (optionally filtered by circle/type). */
  edges(opts: { circle?: string; type?: string } = {}): Array<{ srcId: string; dstId: string; type: string; weight: number; origin: string; count: number }> {
    const where: string[] = [];
    const args: string[] = [];
    if (opts.circle) (where.push("scope = ?"), args.push(opts.circle));
    if (opts.type) (where.push("type = ?"), args.push(opts.type));
    const sql = `SELECT src_id AS srcId, dst_id AS dstId, type, weight, origin, count FROM memory_edge${
      where.length ? ` WHERE ${where.join(" AND ")}` : ""
    } ORDER BY src_id, dst_id, type`;
    return this.db.prepare(sql).all(...args) as Array<{ srcId: string; dstId: string; type: string; weight: number; origin: string; count: number }>;
  }

  /** Observability/testing: the entity keys a concept is tagged with (#245 `about` hubs). */
  conceptEntities(conceptId: string): string[] {
    return (
      this.db.prepare(`SELECT entity_key FROM concept_entities WHERE concept_id = ? ORDER BY entity_key`).all(conceptId) as Array<{
        entity_key: string;
      }>
    ).map((r) => r.entity_key);
  }

  // ---- #245 "what your agent knows" overview (read-only) ------------------

  /**
   * Entity hubs — rare shared anchors ("everything it knows touches X"). GATED for honesty:
   * only entities mentioned by ≥minMembers active concepts AND with df/n ≤ maxDfFrac (so
   * stopword-grade common nouns never masquerade as anchors); structural kinds (path/id/err/lib)
   * rank before plain nouns. Without this gate a df=12 filler noun outranks a df=3 real symbol.
   */
  topEntityHubs(
    circle?: string,
    opts: { limit?: number; minMembers?: number; maxDfFrac?: number; nounMinMembers?: number } = {},
  ): EntityHub[] {
    circle ??= this.defaultCircle;
    const limit = opts.limit ?? 6;
    const minMembers = opts.minMembers ?? 2;
    const nounMin = opts.nounMinMembers ?? 3; // a structural entity anchors at 2; a plain noun needs more
    const maxDfFrac = opts.maxDfFrac ?? 0.5;
    const n = this.conceptCount(circle);
    if (n === 0) return [];
    return this.db
      .prepare(
        `SELECT ce.entity_key AS key, e.surface AS surface, e.kind AS kind, e.df AS df,
                COUNT(DISTINCT ce.concept_id) AS members
           FROM concept_entities ce
           JOIN entities e ON e.key = ce.entity_key AND e.scope = ce.scope
           JOIN concepts c ON c.id = ce.concept_id
          WHERE ce.scope = ? AND c.status = 'active' AND c.kind != 'workstream'
          GROUP BY ce.entity_key
         HAVING members >= ? AND (CAST(e.df AS REAL) / ?) <= ?
            AND (e.kind IN ('path','id','err','lib') OR members >= ?)
          ORDER BY (e.kind IN ('path','id','err','lib')) DESC, members DESC, e.df DESC, ce.entity_key
          LIMIT ?`,
      )
      .all(circle, minMembers, n, maxDfFrac, nounMin, limit) as EntityHub[];
  }

  /**
   * Concepts ranked by connection degree over THREAD edges ONLY (the same set fuse() spreads on:
   * worked-together / causal). Excludes `related`/`about` — otherwise similarity edges float
   * near-duplicate filler to the top and bury the real cluster.
   */
  topConnectedConcepts(circle?: string, limit = 6): ConnectedConcept[] {
    circle ??= this.defaultCircle;
    const placeholders = [...THREAD_TYPES].map(() => "?").join(",");
    // Count distinct thread/causal neighbours in BOTH directions (matching adjacency()'s traversal):
    // directed causal edges (supports/resolves/derived_from/…) are stored one-way, so a hub that
    // everything POINTS AT — a plan many memories support/resolve — has only incoming edges. Ranking
    // outgoing degree alone (the old `e.src_id = c.id`) omitted exactly those sinks, the most
    // informative hubs, and misreported the graph vs. what gather() can actually reach. DISTINCT on the
    // neighbour collapses the symmetric co_occurred mirror so it is never double-counted.
    return this.db
      .prepare(
        `SELECT c.id AS id, c.title AS title, c.kind AS kind, c.confidence AS confidence, c.status AS status,
                COUNT(DISTINCT nb.other) AS degree
           FROM concepts c
           JOIN (
             SELECT src_id AS cid, dst_id AS other, type, scope FROM memory_edge
             UNION ALL
             SELECT dst_id AS cid, src_id AS other, type, scope FROM memory_edge
           ) nb ON nb.cid = c.id
          WHERE nb.scope = ? AND c.kind != 'workstream' AND nb.type IN (${placeholders})
          GROUP BY c.id
          ORDER BY degree DESC, c.id
          LIMIT ?`,
      )
      .all(circle, ...THREAD_TYPES, limit) as ConnectedConcept[];
  }

  /** Undirected edge counts by type (symmetric mirror collapsed, directed counted once). */
  edgeCountsByType(circle?: string): Array<{ type: string; count: number }> {
    circle ??= this.defaultCircle;
    return this.db
      .prepare(
        `SELECT type, COUNT(*) AS count FROM (
            SELECT DISTINCT type, MIN(src_id, dst_id) AS a, MAX(src_id, dst_id) AS b
              FROM memory_edge WHERE scope = ?
          ) GROUP BY type ORDER BY count DESC, type`,
      )
      .all(circle) as Array<{ type: string; count: number }>;
  }

  /** The single largest "worked together" cluster (co_occurred connected component), or null. */
  topThread(circle?: string, minSize = 2): MemoryOverview["graph"]["thread"] {
    circle ??= this.defaultCircle;
    const edges = this.edges({ circle, type: "co_occurred" });
    if (edges.length === 0) return null;
    const adj = new Map<string, Set<string>>();
    const link = (a: string, b: string): void => {
      if (!adj.has(a)) adj.set(a, new Set());
      adj.get(a)!.add(b);
    };
    for (const e of edges) {
      link(e.srcId, e.dstId);
      link(e.dstId, e.srcId);
    }
    const seen = new Set<string>();
    let best: string[] = [];
    for (const start of [...adj.keys()].sort()) {
      if (seen.has(start)) continue;
      const comp: string[] = [];
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const id = stack.pop()!;
        comp.push(id);
        for (const nb of adj.get(id) ?? []) if (!seen.has(nb)) (seen.add(nb), stack.push(nb));
      }
      if (comp.length > best.length || (comp.length === best.length && comp.sort()[0] < (best[0] ?? "~"))) best = comp.sort();
    }
    if (best.length < minSize) return null;
    const members = best
      .map((id) => this.getRow(id))
      .filter((r): r is ConceptRow => r !== null)
      .sort((a, b) => b.support_count - a.support_count || (a.id < b.id ? -1 : 1))
      .slice(0, 4)
      .map((r) => ({ id: r.id, title: r.title, kind: r.kind }));
    // Label = the most-shared entity surface across the component, else the lead member's title.
    const hubKeys = new Set(this.topEntityHubs(circle, { limit: 20 }).map((h) => h.key));
    const entityCounts = new Map<string, { surface: string; n: number }>();
    for (const id of best) {
      for (const key of this.conceptEntities(id)) {
        if (!hubKeys.has(key)) continue;
        const surface = key.split(":").slice(1).join(":");
        const cur = entityCounts.get(key) ?? { surface, n: 0 };
        cur.n++;
        entityCounts.set(key, cur);
      }
    }
    let label = members[0]?.title ?? "thread";
    let bestN = 1;
    for (const { surface, n } of entityCounts.values()) if (n > bestN) (label = surface), (bestN = n);
    return { label, size: best.length, members };
  }

  /** Concepts mentioning an entity (hub drill-in). */
  conceptsForEntity(entityKey: string, circle?: string): Array<{ id: string; title: string; kind: string }> {
    circle ??= this.defaultCircle;
    return this.db
      .prepare(
        `SELECT c.id AS id, c.title AS title, c.kind AS kind
           FROM concepts c JOIN concept_entities ce ON ce.concept_id = c.id
          WHERE ce.entity_key = ? AND ce.scope = ? AND c.kind != 'workstream' ORDER BY c.id`,
      )
      .all(entityKey, circle) as Array<{ id: string; title: string; kind: string }>;
  }

  private disputedCount(circle?: string): number {
    circle ??= this.defaultCircle;
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM concepts WHERE circle = ? AND status = 'disputed'`).get(circle) as { n: number }).n;
  }

  private scopedCount(sql: string, circle: string): number {
    return (this.db.prepare(sql).get(circle) as { n: number }).n;
  }

  /**
   * The "what your agent knows" snapshot (ADR §4.7 read surface). READ-ONLY: opens no session,
   * triggers no synthesis, never returns bodies. Composes prewarm + scoped counts + graph shape.
   */
  overview(
    circle?: string,
    opts: { conceptLimit?: number; hubLimit?: number; connectedLimit?: number } = {},
  ): MemoryOverview {
    circle ??= this.defaultCircle;
    const pre = this.prewarm(circle, { conceptLimit: opts.conceptLimit ?? 6 });
    const edgesByType = this.edgeCountsByType(circle);
    const edges = edgesByType.reduce((a, e) => a + e.count, 0);
    const concepts = this.conceptCount(circle);
    const avg = this.db
      .prepare(`SELECT AVG(confidence) AS a FROM concepts WHERE circle = ? AND kind != 'workstream' AND status = 'active'`)
      .get(circle) as { a: number | null };
    return {
      circle,
      agentId: this.agentId,
      generatedAt: Date.now(),
      counts: {
        concepts,
        observations: this.scopedCount(`SELECT COUNT(*) AS n FROM observations WHERE circle = ?`, circle),
        dirty: this.scopedCount(`SELECT COUNT(*) AS n FROM concepts WHERE circle = ? AND dirty = 1`, circle),
        workstreams: this.scopedCount(`SELECT COUNT(*) AS n FROM concepts WHERE circle = ? AND kind = 'workstream'`, circle),
        sessions: this.scopedCount(`SELECT COUNT(DISTINCT session_id) AS n FROM observations WHERE circle = ? AND session_id IS NOT NULL`, circle),
        edges,
        entities: this.scopedCount(`SELECT COUNT(*) AS n FROM entities WHERE scope = ?`, circle),
        disputed: this.disputedCount(circle),
        stale: this.getStaleConcepts(circle).length,
      },
      health: {
        avgConfidence: Number((avg.a ?? 0).toFixed(2)),
        graphDensity: concepts === 0 ? 0 : Number((edges / concepts).toFixed(2)),
      },
      livingModel: pre.topConcepts,
      activeThreads: pre.activeWorkstreams,
      openContradictions: pre.openContradictions,
      graph: {
        hubs: this.topEntityHubs(circle, { limit: opts.hubLimit ?? 6 }),
        connected: this.topConnectedConcepts(circle, opts.connectedLimit ?? 6),
        edgesByType,
        thread: this.topThread(circle),
      },
    };
  }

  close(): void {
    this.db.close();
  }

  // ---- internals ---------------------------------------------------------

  /**
   * Top-m concepts by cosine in a circle (workstreams excluded — identity-upserted, not
   * embedding-resolved). matches[0] is the argmax the old bestMatch returned (so dedup is
   * unchanged); the rest feed `related` edge derivation, reusing this single scan.
   */
  private bestMatches(emb: Float32Array, circle: string, m: number): Array<{ match: ConceptRow; score: number }> {
    const rows = this.db
      .prepare(`SELECT * FROM concepts WHERE circle = ? AND kind != 'workstream'`)
      .all(circle) as ConceptRow[];
    return rows
      .map((r) => ({ match: r, score: cosine(emb, jsonToEmb(r.embedding)) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || (a.match.id < b.match.id ? -1 : 1))
      .slice(0, m);
  }

  // ---- #245 graph: derivation (write path) -------------------------------

  /**
   * Derive connection-graph edges at store time (Sift, inline, deterministic — ADR §3.7/§4.6):
   * `about` (shared rare entity), `related` (semantic NN, reusing the dedup scan), `co_occurred`
   * + `follows` (same session), and agent-asserted typed edges parsed from content. All scoped
   * to the circle; spread never crosses scope. Idempotent + reinforcing via uq_edge.
   */
  private deriveEdges(
    conceptId: string,
    content: string,
    sourceRefs: string[],
    circle: string,
    sessionId: string,
    matches: Array<{ match: ConceptRow; score: number }>,
  ): void {
    // 1) ENTITY / `about` — shared rare anchors (and sourceRefs).
    this.deriveEntityEdges(conceptId, content, sourceRefs, circle);

    // 2) SEMANTIC / `related` — reuse the dedup scan; only the "related but not duplicate" band.
    for (const nb of matches) {
      if (nb.match.id === conceptId || nb.match.kind === "workstream") continue;
      if (nb.score >= this.edgeSimMin && nb.score < this.tauAttach) {
        this.upsertEdgeBoth(conceptId, nb.match.id, "related", nb.score, "nn", circle);
      }
    }

    // 3) TEMPORAL / `co_occurred` + `follows` — same session AND same circle = "worked on together"
    //    (the restoration signal). Constrained to the current circle: a session may write to several
    //    circles, and these edges are circle-scoped, so their targets must be too — otherwise read-path
    //    spread (adjacency() trusts the edge's scope, never rechecks the neighbour's circle) would surface
    //    foreign-circle memories. `follows` is tracked per circle for the same reason.
    const mates = this.db
      .prepare(
        `SELECT DISTINCT concept_id AS id FROM observations
          WHERE session_id = ? AND circle = ? AND concept_id IS NOT NULL AND concept_id != ?
          ORDER BY created_at DESC, concept_id DESC LIMIT ?`, // created_at is whole-ms; id breaks ties deterministically
      )
      .all(sessionId, circle, conceptId, MAX_NEIGHBORS) as Array<{ id: string }>;
    for (const m of mates) this.upsertEdgeBoth(conceptId, m.id, "co_occurred", CO_OCCURRED_WEIGHT, "cheap", circle);
    const prevInCircle = this.lastConceptByCircle.get(circle);
    if (prevInCircle && prevInCircle !== conceptId) {
      this.upsertEdge(prevInCircle, conceptId, "follows", FOLLOWS_WEIGHT, "cheap", circle);
    }

    // 4) AGENT-ASSERTED — `resolves: #slug` etc. The strongest signal: the agent said so.
    this.deriveAssertedEdges(conceptId, content, circle);
  }

  /**
   * ENTITY / `about` derivation — shared rare anchors (structural entities + sourceRefs as synthetic
   * path entities). Extracted so both the write path (deriveEdges) and the one-time backfill use the
   * exact same gating. `n` (scope size, for the df-fraction hub gate) is read fresh from the circle.
   */
  private deriveEntityEdges(conceptId: string, content: string, sourceRefs: string[], circle: string): void {
    const n = this.conceptCount(circle);
    const ents = extractEntities(content);
    for (const ref of sourceRefs) ents.push({ key: `ref:${ref}`, kind: "path", surface: ref, weight: 3 });
    const strength = new Map<string, number>();
    for (const e of ents) {
      const df = this.upsertEntity(conceptId, e.key, e.kind, e.surface, circle);
      // A rare structural anchor (concrete file/symbol/err/lib or sourceRef, df ≤ RARE_DF_MAX) is the
      // strongest possible link and bypasses the df-FRACTION gate — that fraction is meaningless at small n
      // (df=2 of n=2 reads as "common" yet is the rarest, most specific anchor), so without this the
      // `strongAlone` path below was dead until ~10× unrelated filler concepts existed. df ≤ RARE_DF_MAX (5)
      // can never be a true hub, so the absolute cap inside isHubDf is not needed for it.
      const strongAlone = e.kind !== "noun" && df <= RARE_DF_MAX; // one shared rare file/symbol is enough
      if (!strongAlone && this.isHubDf(df, n)) continue; // common term → not an anchor
      const rar = this.rarityFromDf(df, n) * (KIND_BOOST[e.kind] ?? 1);
      for (const m of this.coMembers(e.key, circle, conceptId, MAX_NEIGHBORS)) {
        const next = (strength.get(m) ?? 0) + rar;
        strength.set(m, strongAlone ? Math.max(next, EDGE_MIN_STRENGTH) : next);
      }
    }
    for (const [m, s] of strength) {
      if (s >= EDGE_MIN_STRENGTH) this.upsertEdgeBoth(conceptId, m, "about", Math.min(1, s / 4), "cheap", circle);
    }
  }

  /** AGENT-ASSERTED `resolves: #slug` / `supports: #slug` edges parsed from content. Shared write/backfill. */
  private deriveAssertedEdges(conceptId: string, content: string, circle: string): void {
    ASSERTED_RE.lastIndex = 0;
    let mm: RegExpExecArray | null;
    while ((mm = ASSERTED_RE.exec(content))) {
      const type = mm[1].toLowerCase().replace("-", "_");
      const target = this.resolveRef(mm[2], circle, conceptId);
      if (target) this.upsertEdge(conceptId, target, type, ASSERTED_WEIGHT, "asserted", circle);
    }
  }

  /**
   * ONE-TIME graph backfill for DBs created before the connection graph existed (P2, Codex review):
   * the graph tables are created empty by init() but edges are only ever derived at store time, so a
   * pre-graph .monet DB has no hubs/threads and gather() degrades to plain search for its concepts.
   * Re-derive entity/`about`/`related`/asserted edges from stored bodies+observations, and reconstruct
   * `co_occurred`/`follows` best-effort from observation session+circle ordering. Idempotent (uq_edge /
   * INSERT OR IGNORE), version-gated to run exactly once, and wrapped in a single transaction.
   */
  private backfillGraph(): void {
    const concepts = this.db
      .prepare(`SELECT id, body, circle, embedding, source_refs FROM concepts WHERE kind != 'workstream' ORDER BY created_at, id`)
      .all() as Array<{ id: string; body: string; circle: string; embedding: string; source_refs: string | null }>;
    if (concepts.length === 0) return;

    this.db.transaction(() => {
      // structural + semantic + asserted, per concept (df accumulates as a circle's concepts are processed)
      for (const c of concepts) {
        const obs = this.db
          .prepare(`SELECT content, source_refs FROM observations WHERE concept_id = ? ORDER BY created_at`)
          .all(c.id) as Array<{ content: string; source_refs: string | null }>;
        const text = [c.body, ...obs.map((o) => o.content)].filter(Boolean).join("\n");
        const refs = new Set<string>();
        for (const o of obs) if (o.source_refs) for (const r of JSON.parse(o.source_refs) as string[]) refs.add(r);
        // Merge the observations' refs back onto the concept row too: a DB ingested with graphEnabled:false
        // never ran store()'s concept-level source_refs update, so gather()/toGatherCard (which read
        // concepts.source_refs) would otherwise lose every return-to-source pointer after the upgrade.
        if (refs.size) {
          const cur = c.source_refs ? (JSON.parse(c.source_refs) as string[]) : [];
          const merged = [...new Set([...cur, ...refs])];
          this.db.prepare(`UPDATE concepts SET source_refs = ? WHERE id = ?`).run(JSON.stringify(merged), c.id);
        }
        this.deriveEntityEdges(c.id, text, [...refs], c.circle);
        for (const nb of this.bestMatches(jsonToEmb(c.embedding), c.circle, EDGE_NEIGHBORS)) {
          if (nb.match.id === c.id || nb.match.kind === "workstream") continue;
          if (nb.score >= this.edgeSimMin && nb.score < this.tauAttach) {
            this.upsertEdgeBoth(c.id, nb.match.id, "related", nb.score, "nn", c.circle);
          }
        }
        this.deriveAssertedEdges(c.id, text, c.circle);
      }
      // temporal: reconstruct co_occurred + follows from observation session order, within each circle.
      const sessions = this.db
        .prepare(`SELECT DISTINCT session_id FROM observations WHERE session_id IS NOT NULL`)
        .all() as Array<{ session_id: string }>;
      for (const s of sessions) {
        const seq = this.db
          .prepare(
            `SELECT DISTINCT concept_id AS id, circle FROM observations
              WHERE session_id = ? AND concept_id IS NOT NULL ORDER BY created_at, concept_id`,
          )
          .all(s.session_id) as Array<{ id: string; circle: string }>;
        const priorByCircle = new Map<string, string[]>();
        const lastByCircle = new Map<string, string>();
        for (const r of seq) {
          const prior = priorByCircle.get(r.circle) ?? [];
          for (const p of prior.slice(-MAX_NEIGHBORS)) this.upsertEdgeBoth(r.id, p, "co_occurred", CO_OCCURRED_WEIGHT, "cheap", r.circle);
          const prev = lastByCircle.get(r.circle);
          if (prev && prev !== r.id) this.upsertEdge(prev, r.id, "follows", FOLLOWS_WEIGHT, "cheap", r.circle);
          prior.push(r.id);
          priorByCircle.set(r.circle, prior);
          lastByCircle.set(r.circle, r.id);
        }
      }
    })();
  }

  /** One directed edge, idempotent + reinforcing (count↑, weight = max) on re-encounter. */
  private upsertEdge(src: string, dst: string, type: string, weight: number, origin: string, scope: string): void {
    if (src === dst) return;
    this.db
      .prepare(
        `INSERT INTO memory_edge (id, src_id, dst_id, type, weight, origin, scope)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(src_id, dst_id, type, scope)
         DO UPDATE SET count = count + 1, weight = max(weight, excluded.weight), last_reinforced_at = unixepoch() * 1000`,
      )
      .run(this.newId(), src, dst, type, weight, origin, scope);
  }

  /** A symmetric edge: store both directions so spread reaches it from either endpoint. */
  private upsertEdgeBoth(a: string, b: string, type: string, weight: number, origin: string, scope: string): void {
    this.upsertEdge(a, b, type, weight, origin, scope);
    this.upsertEdge(b, a, type, weight, origin, scope);
  }

  /** Record concept→entity membership and return the entity's updated per-scope df (rarity). */
  private upsertEntity(conceptId: string, key: string, kind: string, surface: string, scope: string): number {
    const ins = this.db
      .prepare(`INSERT OR IGNORE INTO concept_entities (concept_id, entity_key, scope) VALUES (?, ?, ?)`)
      .run(conceptId, key, scope);
    this.db
      .prepare(
        `INSERT INTO entities (key, kind, surface, scope, df) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key, scope) DO UPDATE SET df = df + ?`,
      )
      .run(key, kind, surface, scope, ins.changes, ins.changes);
    const row = this.db.prepare(`SELECT df FROM entities WHERE key = ? AND scope = ?`).get(key, scope) as { df: number } | undefined;
    return row?.df ?? 0;
  }

  private coMembers(entityKey: string, circle: string, excludeId: string, limit: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT concept_id AS id FROM concept_entities WHERE entity_key = ? AND scope = ? AND concept_id != ?
           ORDER BY concept_id LIMIT ?`, // deterministic subset under the cap (graph.ts determinism contract)
        )
        .all(entityKey, circle, excludeId, limit) as Array<{ id: string }>
    ).map((r) => r.id);
  }

  private isHubDf(df: number, n: number): boolean {
    return df > MAX_DF_ABS || (n > 0 && df / n > MAX_DF_FRAC);
  }

  private rarityFromDf(df: number, n: number): number {
    return Math.log((n + 1) / (df + 1));
  }

  private isHub(key: string, circle: string): boolean {
    const row = this.db.prepare(`SELECT df FROM entities WHERE key = ? AND scope = ?`).get(key, circle) as { df: number } | undefined;
    return row ? this.isHubDf(row.df, this.conceptCount(circle)) : true;
  }

  private rarity(key: string, circle: string): number {
    const row = this.db.prepare(`SELECT df FROM entities WHERE key = ? AND scope = ?`).get(key, circle) as { df: number } | undefined;
    return this.rarityFromDf(row?.df ?? 0, this.conceptCount(circle));
  }

  private resolveRef(ref: string, circle: string, excludeId: string): string | null {
    const bySlug = this.db
      .prepare(`SELECT id FROM concepts WHERE circle = ? AND slug = ? AND id != ? LIMIT 1`)
      .get(circle, slugify(ref), excludeId) as { id: string } | undefined;
    if (bySlug) return bySlug.id;
    const byId = this.db.prepare(`SELECT id FROM concepts WHERE id = ? AND circle = ?`).get(ref, circle) as { id: string } | undefined;
    return byId?.id ?? null;
  }

  // ---- circle migration (reassignCircle internals) -----------------------

  /** Relocate a concept + its observations into toCircle, re-homing its graph membership there. */
  private moveConcept(src: ConceptRow, toCircle: string): ReassignResult {
    const id = src.id;
    const fromCircle = src.circle;
    this.db.prepare(`UPDATE concepts SET circle = ?, updated_at = unixepoch() * 1000 WHERE id = ?`).run(toCircle, id);
    const moved = this.db.prepare(`UPDATE observations SET circle = ? WHERE concept_id = ?`).run(toCircle, id);
    // Unwind the concept's footprint in the old circle (entity df + edges), then re-derive it inside
    // the new circle so it reconnects to whatever is already there. Cross-circle edges never survive:
    // a moved concept's old neighbours stay put, and read-path spread trusts an edge's scope blindly.
    this.unwindConceptGraph(id, fromCircle);
    if (this.graphEnabled) this.rederiveConceptGraph(id, toCircle);
    return { action: "moved", conceptId: id, fromCircle, toCircle, observationsMoved: moved.changes };
  }

  /**
   * Dedupe `src` into an existing `target` in toCircle: re-point src's observations onto the target,
   * fold its body/support/vector in (blended, NOT re-embedded), carry over its contradictions, drop
   * the src row + its revisions, then re-derive the target's graph over the now-larger evidence. The
   * target is marked dirty so the agent re-synthesizes the combined body on next touch.
   */
  private mergeConceptInto(src: ConceptRow, target: ConceptRow, toCircle: string): ReassignResult {
    const fromCircle = src.circle;
    // 1) Re-point evidence: src's observations become the target's, in the target circle.
    const moved = this.db
      .prepare(`UPDATE observations SET concept_id = ?, circle = ? WHERE concept_id = ?`)
      .run(target.id, toCircle, src.id);
    // 2) Carry contradictions onto the target BEFORE recomputing status (their observations followed
    //    in step 1) — so a disputed source doesn't get silently restored to active by the merge.
    this.db.prepare(`UPDATE contradictions SET concept_id = ? WHERE concept_id = ?`).run(target.id, src.id);
    // 3) Fold body + support + vector + source_refs into the target (never re-embed; blend the two
    //    centroids WEIGHTED by support so a heavily-supported source isn't treated as one sample).
    const lines = splitLines(target.body);
    for (const l of splitLines(src.body)) if (!lines.includes(l)) lines.push(l);
    const supportCount = target.support_count + src.support_count;
    const blended = blendWeighted(jsonToEmb(target.embedding), target.support_count, jsonToEmb(src.embedding), src.support_count);
    // Union return-to-source pointers — gather cards and source-keyed idempotency read concept-level
    // source_refs, so a dedup-merge must not drop the moved concept's refs.
    const refs = [
      ...new Set([
        ...(target.source_refs ? (JSON.parse(target.source_refs) as string[]) : []),
        ...(src.source_refs ? (JSON.parse(src.source_refs) as string[]) : []),
      ]),
    ];
    const version = target.version + 1;
    // Stay disputed while any open contradiction (target's own or the carried one) remains.
    const status = this.openContraCount(target.id) > 0 ? "disputed" : "active";
    this.db
      .prepare(
        `UPDATE concepts SET body = ?, support_count = ?, embedding = ?, source_refs = ?, version = ?,
                status = ?, dirty = 1, updated_at = unixepoch() * 1000 WHERE id = ?`,
      )
      .run(lines.join("\n"), supportCount, embToJson(blended), refs.length ? JSON.stringify(refs) : null, version, status, target.id);
    // 4) Drop the source: its graph footprint in fromCircle, its revision history, then the row.
    this.unwindConceptGraph(src.id, fromCircle);
    this.db.prepare(`DELETE FROM concept_revisions WHERE concept_id = ?`).run(src.id);
    this.db.prepare(`DELETE FROM concepts WHERE id = ?`).run(src.id);
    // 5) Re-derive the target over the absorbed evidence (idempotent; picks up any new entities/edges).
    if (this.graphEnabled) this.rederiveConceptGraph(target.id, toCircle);
    return { action: "merged", conceptId: target.id, mergedIntoId: target.id, fromCircle, toCircle, observationsMoved: moved.changes };
  }

  /**
   * Remove a concept's footprint from a circle's graph: its entity memberships (decrementing each
   * entity's per-scope df, dropping entities that fall to zero) and every edge that touches it.
   * Leaves no cross-circle dangling edge behind once the concept itself has left the circle.
   */
  private unwindConceptGraph(conceptId: string, circle: string): void {
    const keys = (
      this.db
        .prepare(`SELECT entity_key AS key FROM concept_entities WHERE concept_id = ? AND scope = ?`)
        .all(conceptId, circle) as Array<{ key: string }>
    ).map((r) => r.key);
    for (const key of keys) {
      this.db.prepare(`DELETE FROM concept_entities WHERE concept_id = ? AND entity_key = ? AND scope = ?`).run(conceptId, key, circle);
      this.db.prepare(`UPDATE entities SET df = df - 1 WHERE key = ? AND scope = ?`).run(key, circle);
      this.db.prepare(`DELETE FROM entities WHERE key = ? AND scope = ? AND df <= 0`).run(key, circle);
    }
    this.db.prepare(`DELETE FROM memory_edge WHERE scope = ? AND (src_id = ? OR dst_id = ?)`).run(circle, conceptId, conceptId);
  }

  /**
   * Re-derive a concept's graph membership inside `circle` from its stored body + observations — the
   * same Sift derivation store() runs, used after a move/merge to re-home (or extend) the concept in
   * its target circle. Reconstructs entity/`about`, `related` (NN), asserted, and same-session
   * `co_occurred` edges (the observations keep their session_id, so "worked together" grouping
   * survives the migration among co-moved siblings). All scoped to `circle`; idempotent via uq_edge /
   * INSERT OR IGNORE. `follows` (order-sensitive, weakest signal) is intentionally not reconstructed.
   */
  private rederiveConceptGraph(conceptId: string, circle: string): void {
    const row = this.getRow(conceptId);
    if (!row) return;
    const obs = this.db
      .prepare(`SELECT content, source_refs FROM observations WHERE concept_id = ? ORDER BY created_at`)
      .all(conceptId) as Array<{ content: string; source_refs: string | null }>;
    const text = [row.body, ...obs.map((o) => o.content)].filter(Boolean).join("\n");
    const refs = new Set<string>();
    if (row.source_refs) for (const r of JSON.parse(row.source_refs) as string[]) refs.add(r);
    for (const o of obs) if (o.source_refs) for (const r of JSON.parse(o.source_refs) as string[]) refs.add(r);

    this.deriveEntityEdges(conceptId, text, [...refs], circle);
    for (const nb of this.bestMatches(jsonToEmb(row.embedding), circle, EDGE_NEIGHBORS)) {
      if (nb.match.id === conceptId || nb.match.kind === "workstream") continue;
      if (nb.score >= this.edgeSimMin && nb.score < this.tauAttach) {
        this.upsertEdgeBoth(conceptId, nb.match.id, "related", nb.score, "nn", circle);
      }
    }
    this.deriveAssertedEdges(conceptId, text, circle);
    // INCOMING asserted edges: a concept already in this circle may have asserted an edge TO this one
    // (e.g. `supports: #thisSlug`) while this one was still elsewhere — resolveRef found nothing then, so
    // the directed edge was dropped. Now that it's here, re-derive the assertions of circle-mates whose
    // text references it (by slug or id) so those edges land. Without this, a batch migration that moves
    // the referencing concept before its target permanently loses the asserted edge. Bounded to textual
    // candidates; deriveAssertedEdges is idempotent (uq_edge), so re-deriving an existing edge is a no-op.
    const referrers = this.db
      .prepare(
        `SELECT id, body FROM concepts WHERE circle = ? AND id != ? AND kind != 'workstream' AND (body LIKE ? OR body LIKE ?)`,
      )
      .all(circle, conceptId, `%${row.slug}%`, `%${conceptId}%`) as Array<{ id: string; body: string }>;
    for (const r of referrers) {
      const rObs = this.db.prepare(`SELECT content FROM observations WHERE concept_id = ? ORDER BY created_at`).all(r.id) as Array<{ content: string }>;
      this.deriveAssertedEdges(r.id, [r.body, ...rObs.map((o) => o.content)].filter(Boolean).join("\n"), circle);
    }
    const mates = this.db
      .prepare(
        `SELECT DISTINCT o2.concept_id AS id FROM observations o1
            JOIN observations o2 ON o2.session_id = o1.session_id
           WHERE o1.concept_id = ? AND o2.circle = ? AND o2.concept_id IS NOT NULL AND o2.concept_id != ?
           ORDER BY o2.concept_id LIMIT ?`,
      )
      .all(conceptId, circle, conceptId, MAX_NEIGHBORS) as Array<{ id: string }>;
    for (const m of mates) this.upsertEdgeBoth(conceptId, m.id, "co_occurred", CO_OCCURRED_WEIGHT, "cheap", circle);
  }

  // ---- #245 graph: gather (read path) ------------------------------------

  /**
   * gather(intent) — ADR §4.7's active context-builder: hybrid seed → 2-hop weighted spreading
   * activation across the MAGMA graph → similarity-floored fusion → seed-relative evidence-gap
   * stop. Strictly scope-isolated. Read-only (never opens a session). Where plain top-k returns
   * the most-similar few, gather recovers the whole neighbourhood — the divergent-vocabulary
   * thread members similarity alone misses. Cold graph ⇒ degrades exactly to search().
   */
  async gather(intent: string, opts: { circle?: string; limit?: number; depth?: number } = {}): Promise<GatherResult> {
    const circle = opts.circle ?? this.defaultCircle;
    const limit = opts.limit ?? 12;
    const params = opts.depth ? { ...this.graphParams, hopLimit: Math.max(1, Math.min(opts.depth, 3)) } : this.graphParams;
    const empty: GatherResult = { seed: [], ranked: [], stopReason: "exhausted", reachableByType: {} };

    const emb = await this.embedder.embed(intent);
    const dense = this.scoreAllConcepts(emb, circle); // [{id, cos}] desc
    const sim = new Map<string, number>();
    for (const d of dense) if (d.cos > 0) sim.set(d.id, d.cos);

    const denseIds = dense.filter((d) => d.cos > 0).map((d) => d.id);
    const lexIds = this.lexicalSeed(intent, circle, 30);
    const fused = rrfFuse([denseIds, lexIds], RRF_K).slice(0, SEED_K);
    const seedIds = fused.map((f) => f.id);

    const seedStrength = new Map<string, number>();
    const maxRrf = fused[0]?.rrf ?? 1;
    for (const f of fused) seedStrength.set(f.id, maxRrf > 0 ? f.rrf / maxRrf : 1);

    // Entity-anchored seeding from the PROBE TEXT ONLY (never scenario metadata) — complementary.
    for (const e of extractEntities(intent)) {
      if (this.isHub(e.key, circle)) continue;
      const boost = (params.wType.about ?? 1) * this.rarity(e.key, circle) * (KIND_BOOST[e.kind] ?? 1) * 0.1;
      for (const m of this.coMembers(e.key, circle, "", MAX_NEIGHBORS)) {
        seedStrength.set(m, Math.max(seedStrength.get(m) ?? 0, boost));
      }
    }
    if (seedStrength.size === 0) return empty;

    // Spread ONLY over thread/causal edges (worked-together / caused-by). about/related are NOT
    // spread — they re-encode similarity (the seed signal) and would inject single-fact noise;
    // entity recall enters gather via the entity-anchored SEEDING above, not via spread.
    const activation = spread(seedStrength, (id) => this.adjacency(id, circle, THREAD_TYPES), params);

    const priors = new Map<string, number>();
    for (const id of activation.keys()) if (!sim.has(id)) priors.set(id, this.nodePrior(id));
    const ranked = fuse(activation, sim, seedStrength, priors, params);

    const embCache = new Map<string, Float32Array | null>();
    const embOf = (id: string): Float32Array | null => {
      if (!embCache.has(id)) embCache.set(id, this.embOf(id));
      return embCache.get(id) ?? null;
    };
    const { accepted, stopReason } = evidenceGapStop(ranked, seedIds.length, embOf, cosine, params);

    return {
      seed: seedIds.map((id) => this.cardOf(id)).filter((c): c is SearchCard => c !== null),
      ranked: accepted
        .slice(0, limit)
        .map((r) => this.toGatherCard(r))
        .filter((c): c is GatherCard => c !== null),
      stopReason,
      reachableByType: this.reachableByType(seedIds, circle, params.hopLimit),
    };
  }

  /** Thin id-only overload for retrieval callers (the eval arm). Ranked, stop-trimmed. */
  async gatherIds(intent: string, opts: { circle?: string; limit?: number; depth?: number } = {}): Promise<string[]> {
    const r = await this.gather(intent, opts);
    return r.ranked.map((c) => c.id);
  }

  /** Public, test-scoped wrapper over the private endSession so the eval can mark session boundaries. */
  endSessionForEval(summary?: string): void {
    this.endSession(summary);
  }

  private scoreAllConcepts(emb: Float32Array, circle: string): Array<{ id: string; cos: number }> {
    const rows = this.db
      .prepare(`SELECT id, embedding FROM concepts WHERE circle = ? AND kind != 'workstream'`)
      .all(circle) as Array<{ id: string; embedding: string }>;
    return rows
      .map((r) => ({ id: r.id, cos: cosine(emb, jsonToEmb(r.embedding)) }))
      .sort((a, b) => b.cos - a.cos || (a.id < b.id ? -1 : 1));
  }

  /** Lexical seed: token overlap over title+body (deterministic, no FTS dependency). */
  private lexicalSeed(intent: string, circle: string, n: number): string[] {
    const q = new Set(tokenize(intent));
    if (q.size === 0) return [];
    const rows = this.db
      .prepare(`SELECT id, title, body FROM concepts WHERE circle = ? AND kind != 'workstream'`)
      .all(circle) as Array<{ id: string; title: string; body: string }>;
    return rows
      .map((r) => {
        let overlap = 0;
        for (const t of new Set(tokenize(`${r.title} ${r.body}`))) if (q.has(t)) overlap++;
        return { id: r.id, overlap };
      })
      .filter((x) => x.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || (a.id < b.id ? -1 : 1))
      .slice(0, n)
      .map((x) => x.id);
  }

  /**
   * All edges traversable from a node (symmetric stored both ways; directed reachable either end).
   * `only` restricts to a subset of edge types (used to spread thread/causal signal separately).
   */
  private adjacency(id: string, circle: string, only?: Set<string>): Adj[] {
    const out = this.db
      .prepare(`SELECT dst_id AS dst, type, weight FROM memory_edge WHERE src_id = ? AND scope = ?`)
      .all(id, circle) as Adj[];
    const placeholders = DIRECTED_TYPES.map(() => "?").join(",");
    const inc = this.db
      .prepare(`SELECT src_id AS dst, type, weight FROM memory_edge WHERE dst_id = ? AND scope = ? AND type IN (${placeholders})`)
      .all(id, circle, ...DIRECTED_TYPES) as Adj[];
    const all = out.concat(inc);
    return only ? all.filter((e) => only.has(e.type)) : all;
  }

  private nodePrior(id: string): number {
    const m = this.nodeMeta(id);
    if (!m) return 1;
    const ageDays = Math.max(0, (Date.now() - m.updatedAt) / 86_400_000);
    return Math.max(1e-3, m.confidence * Math.log1p(m.usefulness + m.support) * Math.exp(-ageDays / 30));
  }

  private nodeMeta(id: string): { confidence: number; usefulness: number; support: number; updatedAt: number } | null {
    const r = this.db
      .prepare(`SELECT confidence, usefulness_score, support_count, updated_at FROM concepts WHERE id = ?`)
      .get(id) as { confidence: number; usefulness_score: number; support_count: number; updated_at: number } | undefined;
    return r ? { confidence: r.confidence, usefulness: r.usefulness_score, support: r.support_count, updatedAt: r.updated_at } : null;
  }

  private embOf(id: string): Float32Array | null {
    const r = this.db.prepare(`SELECT embedding FROM concepts WHERE id = ?`).get(id) as { embedding: string } | undefined;
    return r ? jsonToEmb(r.embedding) : null;
  }

  private openContraCount(id: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM contradictions WHERE concept_id = ? AND status = 'open'`).get(id) as { n: number }).n;
  }

  private cardOf(id: string): SearchCard | null {
    const row = this.getRow(id);
    if (!row) return null;
    return toCard(row, row.confidence, this.openContraCount(id));
  }

  private toGatherCard(r: Ranked): GatherCard | null {
    const row = this.getRow(r.id);
    if (!row) return null;
    const refs = row.source_refs ? (JSON.parse(row.source_refs) as string[]) : undefined;
    return { ...toCard(row, r.score, this.openContraCount(r.id)), viaSeed: r.viaSeed, sourceRefs: refs };
  }

  /** Per-edge-type: distinct non-seed concepts reachable from the seeds within `hop` (explainability). */
  private reachableByType(seedIds: string[], circle: string, hop: number): Record<string, number> {
    const result: Record<string, number> = {};
    for (const type of Object.keys(this.graphParams.wType)) {
      const seen = new Set(seedIds);
      let frontier = [...seedIds];
      for (let h = 0; h < hop; h++) {
        const next: string[] = [];
        for (const id of frontier) {
          const nbrs = this.db
            .prepare(
              `SELECT dst_id AS nbr FROM memory_edge WHERE src_id = ? AND scope = ? AND type = ?
               UNION SELECT src_id AS nbr FROM memory_edge WHERE dst_id = ? AND scope = ? AND type = ?`,
            )
            .all(id, circle, type, id, circle, type) as Array<{ nbr: string }>;
          for (const { nbr } of nbrs) if (!seen.has(nbr)) { seen.add(nbr); next.push(nbr); }
        }
        frontier = next;
      }
      const reached = seen.size - seedIds.length;
      if (reached > 0) result[type] = reached;
    }
    return result;
  }

  private create(content: string, emb: Float32Array, circle: string, kind?: string): ConceptRow {
    const id = this.newId();
    const title = firstLine(content);
    this.db
      .prepare(
        `INSERT INTO concepts (id, slug, title, body, kind, embedding, support_count, version, dirty, circle)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0, 1, ?)`,
      )
      .run(id, slugify(title), title, content.trim(), kind ?? "fact", embToJson(emb), circle);
    return this.getRow(id)!;
  }

  private attach(concept: ConceptRow, content: string, emb: Float32Array): ConceptRow {
    // Sift only: append raw evidence (usable fallback), update vector + meta, mark dirty.
    const lines = splitLines(concept.body);
    const trimmed = content.trim();
    if (!lines.includes(trimmed)) lines.push(trimmed);
    const body = lines.join("\n");
    const version = concept.version + 1;
    const supportCount = concept.support_count + 1;
    const blended = blend(jsonToEmb(concept.embedding), emb, concept.support_count);
    const confidence = Math.min(1, concept.confidence + 0.1);

    this.db
      .prepare(
        `UPDATE concepts
            SET body = ?, version = ?, support_count = ?, embedding = ?,
                confidence = ?, status = 'active', dirty = 1, updated_at = unixepoch() * 1000
          WHERE id = ?`,
      )
      .run(body, version, supportCount, embToJson(blended), confidence, concept.id);
    return this.getRow(concept.id)!;
  }

  /** Sieve tier (deferred): run the synthesizer over the concept's evidence, clear dirty. */
  private async synthesizeRow(concept: ConceptRow): Promise<ConceptRow> {
    const obs = this.db
      .prepare(`SELECT content FROM observations WHERE concept_id = ? ORDER BY created_at`)
      .all(concept.id) as Array<{ content: string }>;
    const { body } = await this.synthesizer.synthesize(obs.map((o) => o.content), { body: concept.body });
    this.db
      .prepare(`UPDATE concepts SET body = ?, dirty = 0, updated_at = unixepoch() * 1000 WHERE id = ?`)
      .run(body, concept.id);
    this.writeRevision(concept.id, concept.version, body);
    return this.getRow(concept.id)!;
  }

  private writeRevision(conceptId: string, version: number, body: string): void {
    this.db
      .prepare(
        `INSERT INTO concept_revisions (id, concept_id, version, body, trigger_observation_id)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .run(this.newId(), conceptId, version, body);
  }

  private getRow(id: string): ConceptRow | null {
    return (this.db.prepare(`SELECT * FROM concepts WHERE id = ?`).get(id) as ConceptRow | undefined) ?? null;
  }

  /** Lazily open the current session on first write/checkpoint (read-only opens stay session-free). */
  private ensureSession(): string {
    if (this.sessionId) return this.sessionId;
    const id = this.newId();
    this.db
      .prepare(`INSERT INTO sessions (id, agent_id, scope_context, status) VALUES (?, ?, ?, 'active')`)
      .run(id, this.agentId, this.scopeContext);
    this.sessionId = id;
    return id;
  }

  /** End the current session (checkpoint/disconnect); the next write opens a fresh one. */
  private endSession(summary?: string): void {
    if (!this.sessionId) return;
    this.db
      .prepare(`UPDATE sessions SET ended_at = unixepoch() * 1000, status = 'ended', summary = ? WHERE id = ?`)
      .run(summary ?? null, this.sessionId);
    this.sessionId = null;
    this.lastConceptByCircle.clear(); // `follows` never bridges a session boundary
  }
}

// ---- helpers -------------------------------------------------------------

function toConcept(r: ConceptRow): Concept {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    body: r.body,
    kind: r.kind,
    status: r.status,
    confidence: r.confidence,
    version: r.version,
    circle: r.circle,
    supportCount: r.support_count,
    dirty: r.dirty === 1,
  };
}

function toWorkstream(r: ConceptRow): Workstream {
  let payload: WorkstreamPayload;
  try {
    payload = JSON.parse(r.body) as WorkstreamPayload;
  } catch {
    payload = { status: "active" };
  }
  return { id: r.id, slug: r.slug, title: r.title, circle: r.circle, version: r.version, payload, updatedAt: r.updated_at };
}

/** Living-model rank (ADR §4.2): confidence × usefulness × recency-decay (~2-week half-ish). */
function livingModelScore(r: ConceptRow, now: number): number {
  const ageDays = Math.max(0, (now - r.updated_at) / 86_400_000);
  const recency = Math.exp(-ageDays / 14); // fresh ≈ 1, decays with staleness
  return r.confidence * (1 + r.usefulness_score) * recency;
}

function workstreamTitle(p: WorkstreamPayload): string {
  const lead = p.nextSteps?.[0] ?? p.openQuestions?.[0] ?? "session state";
  const t = `workstream: ${lead}`;
  return t.length > 80 ? t.slice(0, 77) + "…" : t;
}

/** A representative string for the workstream's (dedup-irrelevant) embedding column. */
function workstreamText(p: WorkstreamPayload): string {
  const parts = [...(p.openQuestions ?? []), ...(p.nextSteps ?? []), ...(p.decisions ?? []), ...(p.confirmedContext ?? [])];
  return parts.join(" ") || "workstream";
}

function toCard(r: ConceptRow, score: number, contradictions: number): SearchCard {
  return {
    id: r.id,
    slug: r.slug,
    kind: r.kind,
    supportCount: r.support_count,
    contradictions,
    confidence: r.confidence,
    score,
    fetchHint: fetchHint(r.kind),
  };
}

function fetchHint(kind: string): string {
  const what =
    kind === "decision"
      ? "the decision, the why, and the alternatives"
      : kind === "issue"
        ? "the problem, the fix, and the repro"
        : kind === "insight"
          ? "the insight and the evidence it was derived from"
          : "the full content and rationale";
  return `fetch for ${what}`;
}

function livingModelCard(r: ConceptRow): LivingModelCard {
  return { id: r.id, title: r.title, kind: r.kind, confidence: Number(r.confidence.toFixed(2)), supportCount: r.support_count };
}

function toContradiction(r: ContradictionRow): Contradiction {
  return {
    id: r.id,
    conceptId: r.concept_id,
    observationId: r.observation_id,
    kind: r.kind,
    status: r.status,
    detail: r.detail,
    resolutionObsId: r.resolution_obs_id,
    detectedAt: r.detected_at,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
  };
}

function embToJson(v: Float32Array): string {
  return JSON.stringify(Array.from(v));
}

function jsonToEmb(s: string): Float32Array {
  return Float32Array.from(JSON.parse(s) as number[]);
}

function firstLine(content: string): string {
  const line = content.trim().split(/[\n.]/)[0].trim();
  return line.length > 80 ? line.slice(0, 77) + "…" : line || content.trim().slice(0, 80);
}

function splitLines(body: string): string[] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Lexical tokens for the gather seed's lexical arm — lowercase alphanumerics, length ≥ 2. */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
