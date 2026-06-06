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
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { EmbeddingProvider, HashingEmbeddingProvider, cosine, blend } from "./embedding.js";
import { Synthesizer, DeterministicSynthesizer } from "./synthesis.js";

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

export interface MonetCoreOptions {
  embedder?: EmbeddingProvider;
  synthesizer?: Synthesizer;
  tauAttach?: number;
  tauAmbiguous?: number;
  agentId?: string;
  /** Where this runtime is working (repo/path) — recorded on the session (ADR §3.6). */
  scopeContext?: string;
  /** A concept unconfirmed for longer than this drifts active→stale (ADR §4.4). Default 30d. */
  staleAfterMs?: number;
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
  private db: Database.Database;
  private embedder: EmbeddingProvider;
  private synthesizer: Synthesizer;
  private tauAttach: number;
  private tauAmbiguous: number;
  private agentId: string;
  private scopeContext: string | null;
  private staleAfterMs: number;
  private sessionId: string | null = null; // lazily opened on first write/checkpoint

  constructor(dbPath = ":memory:", opts: MonetCoreOptions = {}) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.embedder = opts.embedder ?? new HashingEmbeddingProvider();
    this.synthesizer = opts.synthesizer ?? new DeterministicSynthesizer();
    // Thresholds belong with the embedding space (cosine distributions differ per model).
    // Precedence: explicit opt → the embedder's calibrated recommendation → legacy default.
    this.tauAttach = opts.tauAttach ?? this.embedder.recommendedThresholds?.tauAttach ?? 0.55;
    this.tauAmbiguous = opts.tauAmbiguous ?? this.embedder.recommendedThresholds?.tauAmbiguous ?? 0.4;
    this.agentId = opts.agentId ?? "local-agent";
    this.scopeContext = opts.scopeContext ?? null;
    this.staleAfterMs = opts.staleAfterMs ?? 30 * 24 * 60 * 60 * 1000; // 30 days
    this.init();
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
    `);
  }

  /** Sift tier (inline): append observation → embed → resolve-or-create. Marks dirty. */
  async store(content: string, opts: { circle?: string; kind?: string } = {}): Promise<IngestResult> {
    const circle = opts.circle ?? "default";
    const emb = await this.embedder.embed(content);
    const obsId = randomUUID();
    const sessionId = this.ensureSession();

    this.db
      .prepare(
        `INSERT INTO observations (id, content, embedding, kind, circle, session_id, author_agent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(obsId, content, embToJson(emb), opts.kind ?? "statement", circle, sessionId, this.agentId);

    const { match, score } = this.bestMatch(emb, circle);

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
    const circle = opts.circle ?? "default";
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
    const rows = (
      circle
        ? this.db.prepare(`SELECT * FROM concepts WHERE dirty = 1 AND circle = ?`).all(circle)
        : this.db.prepare(`SELECT * FROM concepts WHERE dirty = 1`).all()
    ) as ConceptRow[];
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
    const circle = opts.circle ?? "default";
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
      id = randomUUID();
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
  getActiveWorkstreams(circle = "default"): Workstream[] {
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
  prewarm(circle = "default", opts: { conceptLimit?: number } = {}): PrewarmState {
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
    const id = randomUUID();
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
  getOpenContradictions(circle = "default"): PrewarmContradiction[] {
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
  getStaleConcepts(circle = "default"): LivingModelCard[] {
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
    const rows = (
      circle
        ? this.db.prepare(`SELECT * FROM concepts WHERE dirty = 1 AND circle = ?`).all(circle)
        : this.db.prepare(`SELECT * FROM concepts WHERE dirty = 1`).all()
    ) as ConceptRow[];
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

  getAgentId(): string {
    return this.agentId;
  }

  conceptCount(circle = "default"): number {
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

  close(): void {
    this.db.close();
  }

  // ---- internals ---------------------------------------------------------

  private bestMatch(emb: Float32Array, circle: string): { match: ConceptRow | null; score: number } {
    // Workstreams are identity-upserted state, not embedding-resolved knowledge — keep them
    // out of dedup candidates and search cards (they're restored via getActiveWorkstreams).
    const rows = this.db
      .prepare(`SELECT * FROM concepts WHERE circle = ? AND kind != 'workstream'`)
      .all(circle) as ConceptRow[];
    let match: ConceptRow | null = null;
    let score = 0;
    for (const r of rows) {
      const s = cosine(emb, jsonToEmb(r.embedding));
      if (s > score) {
        score = s;
        match = r;
      }
    }
    return { match, score };
  }

  private create(content: string, emb: Float32Array, circle: string, kind?: string): ConceptRow {
    const id = randomUUID();
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
      .run(randomUUID(), conceptId, version, body);
  }

  private getRow(id: string): ConceptRow | null {
    return (this.db.prepare(`SELECT * FROM concepts WHERE id = ?`).get(id) as ConceptRow | undefined) ?? null;
  }

  /** Lazily open the current session on first write/checkpoint (read-only opens stay session-free). */
  private ensureSession(): string {
    if (this.sessionId) return this.sessionId;
    const id = randomUUID();
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

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
