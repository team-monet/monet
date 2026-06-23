/**
 * monet-core MCP server — exposes the engine over MCP so a host agent (Stig/claude)
 * drives it live (ADR §4.5/§4.6). The agent is the Synthesizer: on `memory_fetch`, a
 * dirty concept comes back with its raw observations + a synthesis instruction; the
 * agent writes a coherent body and calls `memory_synthesize` to store it.
 *
 * This is a NEW contract (concept model, structural cards, no prose summary) — it does
 * not touch the legacy flat @monet/mcp-tools contract.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MonetCore, FIRST_BLOCK_SUMMARY_MAX_CHARS } from "./engine";
import type { MergeConceptResult } from "./engine";

/**
 * Session lifecycle instructions surfaced to the host agent via McpServer's `instructions`
 * option. Tells the agent to call agent_context first, use memory_store/search/gather during
 * the session, and close with memory_checkpoint.
 */
export const MONET_SERVER_INSTRUCTIONS =
  "Monet is the user's persistent memory substrate; start by calling agent_context (no arguments) to restore active workstreams, the living model, and open contradictions from prior sessions; during the session use memory_store to record durable knowledge and memory_search/memory_gather (cards) + memory_fetch (content) to recall; end by calling memory_checkpoint with a workstream snapshot (open questions, decisions, next steps) so the session survives; without a checkpoint, session state is lost.";

// Bounds so a tool result never blows past the host's MCP tool-result token budget (a single big
// concept — long body + many observations — otherwise serializes to tens of thousands of chars and
// the host rejects it: "N chars … exceeds maximum allowed tokens"). memory_fetch is bounded at the
// source (below); ok() is the last-resort safety net for every tool (overview/gather/agent_context).
const RESULT_MAX_CHARS = 40_000; // hard ceiling on any serialized tool result
const FETCH_MAX_OBS = 20; // most-recent observations returned by memory_fetch
const FETCH_OBS_MAX_CHARS = 1_200; // per-observation cap
const FETCH_BODY_MAX_CHARS = 6_000; // concept body cap

/** Truncate `s` to `max` chars, flagging whether it was clipped (so callers can signal it). */
function clip(s: string, max: number): { text: string; clipped: boolean } {
  if (s.length <= max) return { text: s, clipped: false };
  return { text: `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`, clipped: true };
}

// ok() is the canonical serializer for successful tool results. content[0] is ALWAYS the
// pure JSON payload — byte-identical to what callers (scripts/mcp-smoke.ts, test helpers)
// expect to JSON.parse. Any lifecycle decorations (prewarm block, nudge line) are appended
// as ADDITIONAL content items by wrapSuccess so they never interfere with content[0].
// Per-item bounds: ok()'s JSON is capped at RESULT_MAX_CHARS; the prewarm block is capped
// at PREWARM_BLOCK_MAX_CHARS; the nudge line is short and uncapped (its fixed text is ~80 chars).
function ok(content: object): CallToolResult {
  let text = JSON.stringify(content, null, 2);
  if (text.length > RESULT_MAX_CHARS) {
    const note = `\n\n…[result truncated to fit the host's tool-result limit — narrow the query/intent, lower \`limit\`, or memory_fetch a specific id]`;
    // Reserve room for the note so the FINAL payload stays at/under the hard ceiling, not over it.
    text = text.slice(0, Math.max(0, RESULT_MAX_CHARS - note.length)) + note;
  }
  return { content: [{ type: "text", text }] };
}
function err(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------
// Session lifecycle helpers (0.7.0)
// ---------------------------------------------------------------------------

/** Max characters for the prepended prewarm block (keeps it well under the ceiling). */
const PREWARM_BLOCK_MAX_CHARS = 2_500;

/**
 * Max characters for the firstBlock array serialized into the agent_context JSON payload.
 * At 800 chars/summary cap × ~5 entries = 4 000 chars fits comfortably; above this the
 * structured path emits a compact advisory instead of an unbounded array (Finding 4).
 */
const FIRST_BLOCK_INJECTION_MAX_CHARS = 6_000;

/**
 * Preview length for each entry's summary in memory_first_block action:"list" responses.
 * The curation/recovery path must stay parseable at any pin count — truncating summaries to
 * this preview keeps the list well under the 40k ok() ceiling (50 pins × 120 chars = 6 000 chars
 * for summaries alone, leaving ample room for conceptId, position, etc.).
 */
const FIRST_BLOCK_LIST_SUMMARY_PREVIEW_CHARS = 120;

/**
 * Default page size for memory_first_block action:"list" (offset pagination).
 * At ~300 chars/row (conceptId + position + flags + 120-char summary + JSON pretty-print
 * overhead), 100 rows ≈ 30 000 chars — comfortably under the 40 000-char RESULT_MAX_CHARS
 * ceiling even with the enclosing object. Callers may pass offset+limit to page through all
 * pins without a hard count cap hiding any entry.
 */
const FIRST_BLOCK_LIST_DEFAULT_LIMIT = 100;

/**
 * Hard maximum for memory_first_block action:"list" limit — clamped at request time so a
 * caller cannot request an arbitrarily large slice that serialises to more than RESULT_MAX_CHARS.
 * At ~300 chars/row (preview mode), 200 rows ≈ 60 000 chars… but with the 120-char preview cap
 * in place each row is ≈ 200 chars, so 200 × 200 = 40 000 — right at the ceiling.  We keep
 * it at 200 (rather than 100) so a single list call can fully page a moderate store in one
 * shot, while still keeping the serialised output provably under RESULT_MAX_CHARS.
 * (Finding 1 — Codex PR-32)
 */
const FIRST_BLOCK_LIST_MAX_LIMIT = 200;

/**
 * Tighter page-size cap for memory_first_block action:"list" when full=true (untruncated
 * summaries). Each summary can be up to FIRST_BLOCK_SUMMARY_MAX_CHARS = 800 chars; at the
 * max-limit 200 that would yield 200 × 800 = 160 000 chars — far above the 40 000-char
 * RESULT_MAX_CHARS ceiling, which causes ok() to truncate the JSON mid-payload leaving a
 * non-parseable result.  40 entries × 800 chars = 32 000 chars for summaries alone, safely
 * under the 40 000 ceiling even after accounting for conceptId/position/flags/JSON overhead.
 * (full=true overflow — Codex PR-32 follow-up)
 */
const FIRST_BLOCK_LIST_FULL_MAX_LIMIT = 40;

/**
 * Build the compact prewarm block to prepend on the first successful tool response.
 * Calls core.prewarm(circle) + core.overview(circle); renders non-empty sections only.
 * Returns the full delimited block string, or an empty string if the store is empty.
 *
 * First Block renders FIRST (before workstreams) and is protected from truncation:
 * if the block + the first block alone exceeds the budget, the curation advisory notes it
 * rather than silently cutting entries.
 */
function buildPrewarmBlock(core: MonetCore, circle: string): string {
  const state = core.prewarm(circle);
  const ov = core.overview(circle);

  // === FIRST BLOCK (always-first, protected from truncation) ===
  // Only inject active entries; disputed entries are suppressed here and counted in curationAttention.
  const activeFirstBlock = state.firstBlock.filter((e) => e.conceptStatus === "active");
  const firstBlockLines: string[] = [];
  if (activeFirstBlock.length > 0) {
    firstBlockLines.push("First block (always-first, user-curated):");
    for (const e of activeFirstBlock) {
      const staleTag = e.summaryDirty ? ' [summary stale — refresh with memory_first_block action="update_summary"]' : "";
      firstBlockLines.push(`  • [${e.conceptId}] ${e.summary}${staleTag}`);
    }
  }

  // === LOWER-PRIORITY SECTIONS (subject to truncation) ===
  const lowerLines: string[] = [];

  // Curation attention line — placed FIRST in the lower-priority block so that long
  // workstream/top-concept/stale/contradiction content cannot exhaust the budget and drop it.
  // (Finding B — Codex round-5: advisory must survive even when lower content is large.)
  const advisory = buildCurationAdvisory(ov, state.firstBlock);
  if (advisory !== null) {
    lowerLines.push(`Curation attention: ${advisory}.`);
  }

  // Active workstreams — up to 5.
  const workstreams = state.activeWorkstreams.slice(0, 5);
  if (workstreams.length > 0) {
    lowerLines.push("Active workstreams:");
    for (const ws of workstreams) {
      const next = ws.nextSteps[0] ? ` | next: ${ws.nextSteps[0]}` : "";
      lowerLines.push(`  • [${ws.status}] ${ws.title}${next}`);
    }
  }

  // Top concepts — up to 7.
  const topConcepts = state.topConcepts.slice(0, 7);
  if (topConcepts.length > 0) {
    lowerLines.push("Top concepts:");
    for (const c of topConcepts) {
      lowerLines.push(`  • ${c.title} (${c.kind}, conf ${c.confidence.toFixed(2)})`);
    }
  }

  // Stale concepts — up to 5.
  const stale = state.staleConcepts.slice(0, 5);
  if (stale.length > 0) {
    lowerLines.push("Stale (needs re-confirmation):");
    for (const c of stale) {
      lowerLines.push(`  • ${c.title}`);
    }
  }

  // Open contradictions — up to 5.
  const contras = state.openContradictions.slice(0, 5);
  if (contras.length > 0) {
    lowerLines.push("Open contradictions:");
    for (const c of contras) {
      const detail = c.detail ? ` — ${c.detail.slice(0, 80)}` : "";
      lowerLines.push(`  • ${c.conceptTitle}${detail}`);
    }
  }

  // Nothing stored at all → empty render → no block.
  if (firstBlockLines.length === 0 && lowerLines.length === 0) return "";

  const HEADER = "=== MONET SESSION CONTEXT (auto-prewarm) ===\n";
  const FOOTER = "=== END SESSION CONTEXT ===\n\n";

  // Build the first-block blob (protected — injected unconditionally within the cap).
  const firstBlockBlob = firstBlockLines.length > 0 ? firstBlockLines.join("\n") + "\n" : "";
  // Build the lower-priority blob (subject to truncation).
  const lowerBlob = lowerLines.length > 0 ? lowerLines.join("\n") + "\n" : "";

  const fullBlock = HEADER + firstBlockBlob + lowerBlob + FOOTER;

  // Enforce PREWARM_BLOCK_MAX_CHARS. First-block lines are written first and are protected —
  // truncation can only cut into the lower-priority sections.
  if (fullBlock.length <= PREWARM_BLOCK_MAX_CHARS) return fullBlock;

  const budget = PREWARM_BLOCK_MAX_CHARS - HEADER.length - FOOTER.length;
  let used = firstBlockBlob.length;

  // If the first-block blob alone already exceeds the budget, emit a compact advisory instead of
  // returning an unbounded block (which defeats the cap's purpose) or silently dropping pins.
  // The advisory tells the agent how many items are pinned and how to trim them.
  if (used >= budget) {
    const pinnedCount = activeFirstBlock.length;
    const oversizeAdvisory =
      `[First Block: ${pinnedCount} pinned item${pinnedCount === 1 ? "" : "s"} exceed the prewarm budget ` +
      `(${used} chars vs ${budget} char budget) — review/trim via memory_first_block or the dashboard.]\n`;
    return HEADER + oversizeAdvisory + FOOTER;
  }

  // Fit as many lower-priority lines as possible within the remaining budget.
  const remaining = budget - used;
  let lowerFitted = "";
  for (const part of lowerBlob.split("\n")) {
    const candidate = lowerFitted + part + "\n";
    if (candidate.length > remaining) break;
    lowerFitted = candidate;
  }
  used += lowerFitted.length;

  return HEADER + firstBlockBlob + lowerFitted + FOOTER;
}

/**
 * Build the curation advisory string when thresholds trip.
 * Returns a non-empty string (for injection into the prewarm block or agent_context payload)
 * when any threshold is met, or null when none trip.
 * Thresholds: possibleDuplicates>=3, disputed>=1, stale>=5, dirty>=10,
 *             firstBlockStale>=1, firstBlockDisputed>=1.
 * Single source of truth — used by both buildPrewarmBlock and the agent_context tool handler.
 */
function buildCurationAdvisory(
  ov: ReturnType<MonetCore["overview"]>,
  firstBlock?: ReturnType<MonetCore["listFirstBlock"]>,
): string | null {
  const signals: string[] = [];
  if (ov.counts.possibleDuplicates >= 3)
    signals.push(`possibleDuplicates=${ov.counts.possibleDuplicates}`);
  if (ov.counts.disputed >= 1)
    signals.push(`disputed=${ov.counts.disputed}`);
  if (ov.counts.stale >= 5)
    signals.push(`stale=${ov.counts.stale}`);
  if (ov.counts.dirty >= 10)
    signals.push(`dirty=${ov.counts.dirty}`);
  if (firstBlock) {
    const staleCount = firstBlock.filter((e) => e.summaryDirty).length;
    const disputedCount = firstBlock.filter((e) => e.conceptStatus === "disputed").length;
    if (staleCount >= 1) signals.push(`firstBlockStale=${staleCount}`);
    if (disputedCount >= 1) signals.push(`firstBlockDisputed=${disputedCount}`);
  }
  if (signals.length === 0) return null;
  return `${signals.join(", ")} — run the curate-memory ritual`;
}

/**
 * memory_circle_manage response payloads — one per action. Serializing through these (instead of
 * casting engine results to Record) keeps the wire shape compiler-checked; field order mirrors the
 * engine result literals (renameCircle/mergeCircle) so the serialized JSON is unchanged.
 */
type CircleRenameResponse = {
  from: string;
  to: string;
  action: "renamed" | "noop";
  conceptsUpdated: number;
  observationsUpdated: number;
  edgesUpdated: number;
  entitiesUpdated: number;
};
type CircleMergeResponse = {
  from: string;
  into: string;
  conceptResults: MergeConceptResult[];
  counts: { moved: number; merged: number; noop: number; error: number };
};
type CircleArchiveResponse = { action: "archived"; circle: string };
type CircleUnarchiveResponse = { action: "unarchived"; circle: string };
type CircleListResponse = {
  circles: Array<{ circle: string; concepts: number; lastActivity: number; archived: boolean }>;
};

/**
 * Options for registerMonetCoreTools. Both default to true.
 *
 * autoPrewarm: prepend a compact session context block on the first successful non-agent_context
 *   tool response in this server process. Useful for agents that don't explicitly call agent_context.
 *
 * checkpointNudge: append a reminder line when the session accumulates ≥10 unsaved mutations
 *   (and every 20 more) without a memory_checkpoint with a workstream payload.
 */
export interface RegisterMonetCoreToolsOpts {
  autoPrewarm?: boolean;
  checkpointNudge?: boolean;
}

/**
 * Register all monet-core tools on `server` and return it (does NOT connect a transport).
 * Used internally by createMonetCoreMcpServer and by tests that inject an InMemoryTransport.
 */
export function registerMonetCoreTools(
  server: McpServer,
  core: MonetCore,
  opts?: RegisterMonetCoreToolsOpts,
): McpServer {
  const autoPrewarm = opts?.autoPrewarm ?? true;
  const checkpointNudge = opts?.checkpointNudge ?? true;

  // --- lifecycle closure state ---
  // Auto-prewarm: one-shot per server process.
  let prewarmed = false;
  // Checkpoint nudge: count mutating calls; track last nudge position.
  let mutatingCalls = 0;
  let lastNudgeAt = 0;

  // When a tool call omits `circle`, fall back to the runtime's configured default (e.g. a per-project
  // circle the local client derived from the working tree) — so one shared store isolates per project.
  // resolveCircleName() transparently follows circle_aliases, so a caller using an old name routes to
  // the canonical circle without needing to know about the rename.
  const dc = core.getDefaultCircle();
  const scope = (circle?: string): string => core.resolveCircleName(circle ?? dc);

  /**
   * Capture the prewarm block BEFORE a handler runs (Fix B: snapshot prior state, not post-mutation
   * state). Returns the block string if the one-shot is unconsumed and the store has content for the
   * given resolved circle, or an empty string if there is nothing to restore. Returns null when
   * capturePrewarmSnapshot() should be skipped because autoPrewarm is off or the one-shot is already
   * consumed. The returned string (including empty string) must be passed to wrapSuccess so it knows
   * the one-shot was consumed on success (or must be discarded on error via discardPrewarmSnapshot).
   *
   * Separated from wrapSuccess so that mutating handlers can call this BEFORE core.store() / etc.,
   * then consume on success or discard on error — ensuring the block never contains facts written
   * in the same call.
   *
   * The resolved circle must be the same circle the handler will operate on (Fix A), NOT scope()
   * (the session default). Pass scope(circle) for tools that have an explicit circle input, or
   * scope() for multi-circle ops (reassign, circle_manage) where the session default is the right
   * anchor.
   */
  function capturePrewarmSnapshot(resolvedCircle: string): string | null {
    if (!autoPrewarm || prewarmed) return null;
    const block = buildPrewarmBlock(core, resolvedCircle);
    return block; // empty string = nothing to restore, but the snapshot was taken
  }

  /**
   * Consume the one-shot (mark as prewarmed) when the snapshot was successfully delivered.
   * Called inside wrapSuccess when a captured block (empty or non-empty) is committed.
   */
  function consumePrewarmSnapshot(): void {
    prewarmed = true;
  }

  /**
   * Discard a pre-captured snapshot on error — the one-shot is NOT consumed, so the next
   * successful call re-captures (possibly with different state). Preserves the error-first
   * semantics: a failing call never advances the lifecycle.
   */
  // (no-op at runtime — the caller simply doesn't call consumePrewarmSnapshot on the error path)

  /**
   * Wrap a successful (non-error) CallToolResult with lifecycle decorations.
   *
   * MCP tool results are content ARRAYS. content[0] is ALWAYS the pure ok() JSON result —
   * byte-identical to what it was before any lifecycle decoration. This preserves every
   * consumer that does JSON.parse(content[0].text) (scripts/mcp-smoke.ts, test helpers).
   *
   * When decorations apply:
   *  - The prewarm block ships as content[1] (a separate text item).
   *  - The nudge line ships as the final content item (content[1] or content[2] depending
   *    on whether a prewarm block is also present).
   *
   * A host that drops extra content items degrades to no-prewarm/no-nudge — acceptable
   * best-effort. No combined-ceiling math: each item is independently bounded (ok()'s result
   * at RESULT_MAX_CHARS via ok(); the block at PREWARM_BLOCK_MAX_CHARS via buildPrewarmBlock()).
   *
   * `isMutating`: was this a mutating tool call?
   * `isCheckpointWithWorkstream`: was this a successful memory_checkpoint with a workstream?
   * `toolName`: name of the tool (to suppress prewarm block for agent_context).
   * `capturedBlock`: pre-captured prewarm block string from capturePrewarmSnapshot(), or null if
   *   the caller is agent_context (which handles its own lifecycle) or autoPrewarm is off. When
   *   non-null, consumePrewarmSnapshot() is called here and the block (if non-empty) is attached.
   */
  function wrapSuccess(
    result: CallToolResult,
    {
      isMutating,
      isCheckpointWithWorkstream,
      toolName,
      capturedBlock,
    }: { isMutating: boolean; isCheckpointWithWorkstream: boolean; toolName: string; capturedBlock?: string | null },
  ): CallToolResult {
    if (result.content[0]?.type !== "text") return result;

    let prewarmBlock = "";
    let nudgeLine = "";
    let carryingPrewarm = false;

    // --- auto-prewarm ---
    if (autoPrewarm && !prewarmed) {
      if (toolName === "agent_context") {
        // First call is agent_context: its payload IS the prewarm — no double-inject.
        prewarmed = true;
      } else if (capturedBlock !== null && capturedBlock !== undefined) {
        // Pre-captured block provided (Fix A + Fix B): consume the one-shot and attach if non-empty.
        consumePrewarmSnapshot();
        if (capturedBlock.length > 0) {
          prewarmBlock = capturedBlock;
          carryingPrewarm = true;
        }
      } else {
        // Fallback: no pre-captured block supplied (should not happen for well-formed callers).
        // Build inline as before so existing agent_context and legacy paths degrade gracefully.
        const resolvedCircle = scope();
        const block = buildPrewarmBlock(core, resolvedCircle);
        prewarmed = true;
        if (block.length > 0) {
          prewarmBlock = block;
          carryingPrewarm = true;
        }
      }
    }

    // --- checkpoint nudge ---
    if (checkpointNudge && isMutating && !isCheckpointWithWorkstream && !carryingPrewarm) {
      mutatingCalls += 1;
      const shouldNudge =
        mutatingCalls >= 10 && (lastNudgeAt === 0 || mutatingCalls - lastNudgeAt >= 20);
      if (shouldNudge) {
        nudgeLine =
          "[monet] Session has unsaved state — call memory_checkpoint with a workstream snapshot to preserve it.";
        lastNudgeAt = mutatingCalls;
      }
    } else if (checkpointNudge && isMutating && isCheckpointWithWorkstream) {
      // Successful checkpoint-with-workstream resets the counter.
      mutatingCalls = 0;
      lastNudgeAt = 0;
    } else if (checkpointNudge && isMutating && !isCheckpointWithWorkstream && carryingPrewarm) {
      // Mutating call that carries the prewarm block: count it but don't nudge.
      mutatingCalls += 1;
    }

    if (prewarmBlock === "" && nudgeLine === "") return result;

    // content[0] is always the pure result from ok() — never modified.
    // Lifecycle items are appended as additional content items.
    const extra: Array<{ type: "text"; text: string }> = [];
    if (prewarmBlock !== "") extra.push({ type: "text", text: prewarmBlock });
    if (nudgeLine !== "") extra.push({ type: "text", text: nudgeLine });

    return {
      ...result,
      content: [result.content[0], ...result.content.slice(1), ...extra],
    };
  }

  /**
   * Convenience wrappers that call ok() then wrapSuccess() with the right metadata.
   * Used in each tool handler in place of bare ok() for lifecycle-aware responses.
   * Widened to `object` (from `Record<string, unknown>`) so typed response literals
   * pass without casts — removes the `as unknown as Record<string, unknown>` pattern.
   *
   * Both accept a `capturedBlock` from capturePrewarmSnapshot() called BEFORE the handler ran.
   * For agent_context, pass no capturedBlock (it manages its own lifecycle).
   */
  const readOk = (
    content: object,
    toolName: string,
    capturedBlock?: string | null,
  ): CallToolResult =>
    wrapSuccess(ok(content), { isMutating: false, isCheckpointWithWorkstream: false, toolName, capturedBlock });

  const mutOk = (
    content: object,
    toolName: string,
    isCheckpointWithWorkstream = false,
    capturedBlock?: string | null,
  ): CallToolResult =>
    wrapSuccess(ok(content), { isMutating: true, isCheckpointWithWorkstream, toolName, capturedBlock });

  server.tool(
    "memory_store",
    'Store something worth remembering. By default the substrate deduplicates automatically: similar evidence resolves into an existing concept; novel evidence creates a new one. Pass resolution="forceNew" to always create a new concept (useful for bulk import flows where each item is known to be distinct). Pass attachTo=<conceptId> to attach directly to a specific concept, bypassing automatic scoring. Cheap and instant — synthesis happens later, on read. If the stored concept is a preference, way-of-working, or something the user flagged as important, consider suggesting memory_first_block with action="promote" to pin it to the First Block — but only propose; never auto-promote; the user must confirm.',
    {
      content: z.string(),
      circle: z.string().optional(),
      kind: z
        .string()
        .optional()
        .describe(
          'Observation kind. Use "correction" when this overrides/contradicts a prior memory — if it lands on an existing concept the substrate opens a contradiction and marks it disputed for mediation.',
        ),
      sourceRefs: z
        .array(z.string())
        .optional()
        .describe(
          "Pointer(s) HOME to the source (file paths, URLs, tool calls, prior concept/observation ids) — never a copy. Lets memories that share a source link up, and enables later return-to-source re-reading.",
        ),
      resolution: z
        .enum(["auto", "forceNew"])
        .optional()
        .describe(
          'Resolution mode. "auto" (default): the substrate resolves similar evidence into an existing concept automatically. "forceNew": always create a new concept, bypassing deduplication — use for bulk import or migration flows where each item is known to be distinct.',
        ),
      attachTo: z
        .string()
        .optional()
        .describe(
          "Concept id to attach this observation to directly, bypassing automatic deduplication. The concept must exist in the same circle. Mutually exclusive with resolution=\"forceNew\". Useful for manually consolidating a possible-duplicate pair surfaced by memory_overview.",
        ),
    },
    async ({ content, circle, kind, sourceRefs, resolution, attachTo }) => {
      // Fix A + Fix B: capture the snapshot BEFORE the mutation so the block reflects prior state.
      const capturedBlock = capturePrewarmSnapshot(scope(circle));
      try {
        const r = await core.store(content, { circle: scope(circle), kind, sourceRefs, resolution, attachTo });
        return mutOk({
          circle: scope(circle), // the circle these ids live in — pass it to id-based tools if it isn't your session default
          action: r.action,
          conceptId: r.conceptId,
          score: Number(r.score.toFixed(3)),
          ...(r.contradiction
            ? { contradiction: { id: r.contradiction.id, status: r.contradiction.status, detail: r.contradiction.detail } }
            : {}),
          ...(r.nearMatchId ? { nearMatchId: r.nearMatchId, nearMatchScore: r.nearMatchScore } : {}),
        }, "memory_store", false, capturedBlock);
      } catch (e) {
        return err(`store failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_search",
    "Search memory. Returns structural CARDS — what each memory is about and how much is in it (kind, support count, confidence, fetch hint) — but NEVER the content. To actually read a memory you MUST call memory_fetch; the answer is never in the search result. Omit circle to search across all circles — cards include each memory's home circle; pass circle to restrict.",
    {
      query: z.string(),
      circle: z.string().optional().describe("Restrict search to this circle. Omit to search across all circles — cards include each memory's home circle."),
      limit: z.number().int().positive().optional(),
    },
    async ({ query, circle, limit }) => {
      // Fix A: snapshot uses the call's resolved circle; fall back to session default for all-circle searches.
      const capturedBlock = capturePrewarmSnapshot(circle !== undefined ? scope(circle) : scope());
      try {
        // When circle is omitted, search store-wide (circle: undefined); when provided, scope exactly.
        const results = await core.search(query, { circle: circle !== undefined ? scope(circle) : undefined, limit });
        const circleLabel = circle !== undefined ? scope(circle) : "(all circles)";
        return readOk({
          circle: circleLabel,
          results,
          guidance:
            "Cards show what a memory is about, not what it says. Call memory_fetch(id) to read it — if the card's `circle` isn't your session default, pass it: memory_fetch(id, circle).",
        }, "memory_search", capturedBlock);
      } catch (e) {
        return err(`search failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_overview",
    'A glanceable, read-only snapshot of everything stored for a circle — counts (incl. dirty/disputed/stale/possibleDuplicates), the living model (top concepts), where you left off (active threads), open contradictions, and the connection-graph shape (entity hubs, most-connected memories, edge-type histogram). Open possible-duplicate pairs (concepts that nearly matched at store time and were forked instead of merged) are surfaced in \'possibleDuplicates\' — the list shows the top 10 pairs by score; counts.possibleDuplicates has the full total. Review with memory_fetch (using the conceptAId / conceptBId shown), then use memory_detach with destConceptId to consolidate if they are the same concept. Use to answer "what do you actually know about this?" or to report memory health. Read-only — never mutates, never returns memory bodies; fetch by id to read one. Pass `entity` to list the memories tied to one hub. otherCircles lists other circles in the store (name + concept count + last activity).',
    { circle: z.string().optional(), entity: z.string().optional() },
    async ({ circle, entity }) => {
      const capturedBlock = capturePrewarmSnapshot(scope(circle));
      try {
        if (entity) return readOk({ circle: scope(circle), entity, concepts: core.conceptsForEntity(entity, scope(circle)) }, "memory_overview", capturedBlock);
        const ov = core.overview(scope(circle));
        return readOk({ ...ov, ...(ov.resolvedFrom !== undefined ? { resolvedFrom: ov.resolvedFrom } : {}) }, "memory_overview", capturedBlock);
      } catch (e) {
        return err(`overview failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_list",
    "Enumerate a circle's memories as structural cards — id, title, kind, support count, confidence, open contradictions — optionally with `withProvenance` for the project path(s) each memory's evidence came from. PAGINATED with a KEYSET cursor: returns up to `limit` (default 50) plus a `nextCursor` when more remain; pass it back as `cursor` to continue, until it's absent. The cursor walks a stable order, so it's SAFE to reassign each page out of the circle before fetching the next (an offset would skip rows as the circle shrinks). Read-only; never returns bodies (memory_fetch reads one). Built for organizing/migrating memory: list a circle (e.g. the legacy \"default\"), group by content + where it came from, then memory_reassign_circle each into its project's circle.",
    {
      circle: z.string().optional(),
      withProvenance: z
        .boolean()
        .optional()
        .describe("Include each memory's `provenance`: the distinct working-dir paths its observations were recorded under (the strongest signal for which project it belongs to)."),
      limit: z.number().int().positive().max(200).optional().describe("Max memories to return (default 50)."),
      cursor: z.string().optional().describe("Opaque keyset cursor from the prior response's `nextCursor`; omit for the first page."),
    },
    async ({ circle, withProvenance, limit, cursor }) => {
      const capturedBlock = capturePrewarmSnapshot(scope(circle));
      try {
        const lim = limit ?? 50;
        // Cursor is "<updatedAt>:<id>" (ids carry no colon). Walks the stable updated_at DESC, id ASC order.
        let parsed: { updatedAt: number; id: string } | undefined;
        if (cursor) {
          const i = cursor.indexOf(":");
          if (i > 0) parsed = { updatedAt: Number(cursor.slice(0, i)), id: cursor.slice(i + 1) };
        }
        const memories = core.listMemories(scope(circle), { withProvenance, limit: lim, cursor: parsed });
        const last = memories[memories.length - 1];
        const nextCursor = memories.length === lim && last ? `${last.updatedAt}:${last.id}` : null;
        return readOk({
          circle: scope(circle),
          total: core.conceptCount(scope(circle)), // current size — shrinks as you reassign out
          count: memories.length,
          ...(nextCursor ? { nextCursor } : {}),
          memories,
          guidance:
            `Cards show what each memory is about, not what it says. ${nextCursor ? `More remain — call again with cursor=\"${nextCursor}\" (safe to reassign this page first). ` : ""}Group by title/kind + provenance, then memory_reassign_circle(id, toCircle) to move each into its project's circle. memory_fetch(id) to read one.`,
        }, "memory_list", capturedBlock);
      } catch (e) {
        return err(`list failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_gather",
    "Rebuild the FULL working context for an intent — not just the most-similar few. Seeds from the intent, then spreads across the connection graph (entity, causal, and same-session co-occurrence edges, ≤2 hops) and stops when evidence saturates. Use at the start of a task or when resuming a thread: it recovers the related concepts — decisions, open questions, files worked on together — that a plain memory_search misses because they're worded differently. Returns structural cards (ranked); call memory_fetch(id) to read one. Omit circle to search across all circles — cards include each memory's home circle; pass circle to restrict (spreading stays within each seed's home circle).",
    {
      intent: z.string(),
      circle: z.string().optional().describe("Restrict gathering to this circle. Omit to gather across all circles — cards include each memory's home circle (spreading stays within each seed's home circle)."),
      limit: z.number().int().positive().optional(),
      depth: z.enum(["1", "2"]).optional().describe("Graph hops from the seeds (default 2)."),
    },
    async ({ intent, circle, limit, depth }) => {
      // Fix A: snapshot uses the call's resolved circle; fall back to session default for all-circle gathers.
      const capturedBlock = capturePrewarmSnapshot(circle !== undefined ? scope(circle) : scope());
      try {
        // When circle is omitted, gather store-wide (circle: undefined); when provided, scope exactly.
        const r = await core.gather(intent, { circle: circle !== undefined ? scope(circle) : undefined, limit, depth: depth ? Number(depth) : undefined });
        const circleLabel = circle !== undefined ? scope(circle) : "(all circles)";
        return readOk({
          circle: circleLabel,
          ranked: r.ranked,
          seed: r.seed,
          stopReason: r.stopReason,
          reachableByType: r.reachableByType,
          guidance:
            "Cards show what a memory is about, not what it says. Call memory_fetch(id) to read one — if the card's `circle` isn't your session default, pass it: memory_fetch(id, circle).",
        }, "memory_gather", capturedBlock);
      } catch (e) {
        return err(`gather failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_fetch",
    "Read the full content of a concept by id. If `needsSynthesis` is true, the concept has new raw evidence: read `observations`, write ONE coherent `body` that reconciles them, and call memory_synthesize(id, body). You are the synthesizer. Each entry in `observations` is {id, content}. The id is needed to call memory_detach. Concepts with many observations: page newest→oldest with observationsOffset (0 = newest page, step by 20); totalObservations tells you when you have reached all of them.",
    {
      id: z.string(),
      circle: z.string().optional().describe("The circle the id belongs to. Omit to look the id up store-wide (the response includes its home circle); if provided, the id must live in that circle."),
      observationsOffset: z.number().int().min(0).optional().describe("Page through observations newest-first: skip this many from the newest end before applying the per-page cap (default 20). offset=0 returns the newest page. Increment by 20 each request. Use with totalObservations to know when you've retrieved all pages."),
    },
    async ({ id, circle, observationsOffset }) => {
      // memory_fetch is READ-ONLY — the pre-mutation capture rule (Fix B) does not apply here.
      // We defer capturePrewarmSnapshot until after homeCircle is resolved so that an omit-circle
      // call (store-wide lookup) snapshots the concept's actual home circle rather than the
      // session default, which may be empty/unrelated. Error paths (id not found, scope-gate
      // rejection) return before the snapshot is taken, so they never consume the one-shot.
      try {
        // Scope enforcement:
        // - homeCircle null → concept not found (id doesn't exist).
        // - caller provided circle explicitly → id must live in that circle (back-compat gate).
        // - caller omitted circle → look up store-wide; the response surfaces the home circle.
        const homeCircle = core.circleOf(id);
        if (homeCircle === null) return err(`concept not found: ${id}`);
        // Scope-gate: if the caller named a circle explicitly, the id must live there.
        // Check BEFORE taking the snapshot so a rejection never consumes the one-shot.
        if (circle !== undefined && homeCircle !== scope(circle)) return err(`concept not found: ${id}`);
        // Snapshot circle: explicit caller circle wins; else use the fetched concept's homeCircle.
        const snapshotCircle = circle !== undefined ? scope(circle) : homeCircle;
        const capturedBlock = capturePrewarmSnapshot(snapshotCircle);
        // pageSize=FETCH_MAX_OBS: the engine slices exactly one page newest-first from the offset,
        // so the MCP layer receives at most FETCH_MAX_OBS observations with no secondary cap needed.
        const c = await core.getConcept(id, { synthesize: false, observationsOffset: observationsOffset ?? 0, pageSize: FETCH_MAX_OBS });
        if (!c) return err(`concept not found: ${id}`);
        const total = c.totalObservations;
        const offset = c.observationsOffset;
        // Engine already returned exactly one page; all observations in c.observations are kept.
        const kept = c.observations;
        const omitted = 0;
        const body = clip(c.body ?? "", FETCH_BODY_MAX_CHARS);
        return readOk({
          id: c.id,
          circle: c.circle, // pass this back to memory_synthesize if it isn't your session default
          kind: c.kind,
          body: body.text,
          ...(body.clipped ? { bodyTruncated: true } : {}),
          observations: kept.map((o) => ({ id: o.id, content: clip(o.content, FETCH_OBS_MAX_CHARS).text })),
          totalObservations: total,
          observationsOffset: offset,
          // Note: omitted is always 0 (engine returns exactly one page). Use kept.length vs total
          // to detect whether more pages exist. Offset here is newest-first (offset 0 = newest page).
          ...(kept.length === 0 && offset > 0
            ? {
                observationsNote: `No observations at offset ${offset} of ${total}.`,
              }
            : offset > 0
              ? {
                  observationsNote: `Showing observations ${offset + 1}–${offset + kept.length} of ${total} (newest-first). Page forward: increment offset by ${FETCH_MAX_OBS}.`,
                }
              : total > kept.length
                ? {
                    observationsNote: `Showing the ${kept.length} newest of ${total} observations. Use observationsOffset to page older ones (step by ${FETCH_MAX_OBS}).`,
                  }
                : {}),
          supportCount: c.supportCount,
          confidence: c.confidence,
          version: c.version,
          lastConfirmedAt: c.lastConfirmedAt,
          needsSynthesis: c.needsSynthesis,
          // Only invite synthesis when ALL evidence is shown (offset=0 AND total fits one page).
          // memory_synthesize clears `dirty` with the body the agent writes, so synthesizing from
          // a partial view would discard the unseen observations from the canonical body.
          ...(c.needsSynthesis && offset === 0 && total <= FETCH_MAX_OBS
            ? {
                synthesisInstruction:
                  "This concept has unsynthesized evidence. Read `observations`, write a single coherent `body`, then call memory_synthesize(id, body) — pass this concept's `circle` (above) if it isn't your session default.",
              }
            : c.needsSynthesis
              ? {
                  synthesisDeferred:
                    "This concept needs synthesis but has more observations than shown — do NOT call memory_synthesize from this partial view (it would drop the omitted evidence). Leave it dirty.",
                }
              : {}),
        }, "memory_fetch", capturedBlock);
      } catch (e) {
        return err(`fetch failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_synthesize",
    "Write back a synthesized body for a concept — you, the agent, are the synthesizer. Reconcile the concept's observations into one coherent statement. Clears the dirty flag and records a revision.",
    { id: z.string(), body: z.string(), circle: z.string().optional().describe("The circle the id belongs to (defaults to this session's circle).") },
    async ({ id, body, circle }) => {
      const capturedBlock = capturePrewarmSnapshot(scope(circle));
      try {
        if (core.circleOf(id) !== scope(circle)) return err(`concept not found: ${id}`); // scope enforcement
        const c = await core.applySynthesis(id, body);
        if (!c) return err(`concept not found: ${id}`);
        return mutOk({ id: c.id, circle: scope(circle), version: c.version, dirty: c.dirty, message: "synthesis stored" }, "memory_synthesize", false, capturedBlock);
      } catch (e) {
        return err(`synthesize failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_checkpoint",
    "End of session — preserve where you left off. Pass `workstream`: a COMPRESSED snapshot of this session (open questions, decisions, discarded alternatives, important entities/files, next steps) — many raw turns distilled into a few durable slots. It survives as a workstream that next session's agent_context restores. Also returns any concepts still needing synthesis.",
    {
      circle: z.string().optional(),
      summary: z.string().optional(),
      workstream: z
        .object({
          status: z.enum(["active", "paused", "done"]).default("active"),
          openQuestions: z.array(z.string()).optional(),
          confirmedContext: z.array(z.string()).optional(),
          decisions: z.array(z.string()).optional(),
          discardedAlternatives: z.array(z.string()).optional(),
          importantEntities: z.array(z.string()).optional(),
          nextSteps: z.array(z.string()).optional(),
        })
        .optional(),
    },
    async ({ circle, summary, workstream }) => {
      const capturedBlock = capturePrewarmSnapshot(scope(circle));
      try {
        const saved = workstream ? await core.saveWorkstream(workstream, { circle: scope(circle), summary }) : null;
        const dirty = core.listDirty(scope(circle));
        // A successful checkpoint WITH a workstream payload resets the nudge counter.
        const isCheckpointWithWorkstream = saved !== null;
        return mutOk({
          circle: scope(circle),
          workstream: saved ? { id: saved.id, status: saved.payload.status, version: saved.version } : null,
          dirtyCount: dirty.length,
          dirty,
          guidance: dirty.length
            ? "For each dirty concept: read observations → write a coherent body → memory_synthesize(id, body). If `circle` above isn't your session default, pass it: memory_synthesize(id, body, circle)."
            : saved
              ? "Workstream saved — next session's agent_context will restore it. Nothing left to synthesize."
              : "Nothing to synthesize.",
        }, "memory_checkpoint", isCheckpointWithWorkstream, capturedBlock);
      } catch (e) {
        return err(`checkpoint failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_flag_contradiction",
    "Flag that a concept now holds conflicting information (model drift). Opens a contradiction, marks the concept `disputed`, and decays its confidence until you mediate it with memory_resolve. Use when you notice a stored memory is contradicted by newer evidence. (Storing the new evidence with kind=\"correction\" does this automatically.)",
    {
      conceptId: z.string(),
      detail: z.string(),
      observationId: z.string().optional(),
      kind: z.enum(["value-conflict", "staleness", "scope-conflict"]).optional(),
      circle: z.string().optional().describe("The circle the conceptId belongs to (defaults to this session's circle)."),
    },
    async ({ conceptId, detail, observationId, kind, circle }) => {
      const capturedBlock = capturePrewarmSnapshot(scope(circle));
      try {
        if (core.circleOf(conceptId) !== scope(circle)) return err(`concept not found: ${conceptId}`); // scope enforcement
        const c = core.flagContradiction(conceptId, { detail, observationId, kind });
        return mutOk({ circle: scope(circle), contradictionId: c.id, conceptId: c.conceptId, status: c.status, detail: c.detail }, "memory_flag_contradiction", false, capturedBlock);
      } catch (e) {
        return err(`flag failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_resolve",
    "Mediate a contradiction OR dismiss a possible-duplicate pair — two verdict families, one tool. " +
    "CONTRADICTION VERDICT: pass `contradictionId` + `decision` ('accept-new' / 'keep-current' / 'dismiss'). " +
    "accept-new: the correcting evidence wins; keep-current: the prior wins; dismiss: not a real conflict. " +
    "The losing observation is superseded; for accept/keep, pass the reconciled `body`. The concept restores to active once no conflicts remain. " +
    "DUPLICATE-PAIR DISMISSAL: pass `conceptAId` + `conceptBId` (omit contradictionId/decision). " +
    "Asserts these two concepts are NOT duplicates — they leave the possibleDuplicates list and survive any future detach/rederive cycle. " +
    "Dismissing a pair where no live possible_duplicate_of edge exists succeeds idempotently with rowsUpdated: 0 (\"nothing to dismiss\" signal). " +
    "Pass `resolvedBy` / `circle` for either family. Existing contradiction-path callers are unaffected.",
    {
      // Contradiction-resolution fields (existing — backward compatible).
      contradictionId: z.string().optional().describe("The contradiction to mediate. Required for contradiction verdicts; omit for duplicate-pair dismissal."),
      decision: z.enum(["accept-new", "keep-current", "dismiss"]).optional().describe("Verdict for a contradiction. Required when contradictionId is present."),
      body: z.string().optional(),
      resolvedBy: z.string().optional(),
      circle: z.string().optional().describe("The circle the contradiction or concepts belong to (defaults to this session's circle)."),
      // Duplicate-pair dismissal fields (new in 0.6.0).
      conceptAId: z.string().optional().describe("First concept of a possible-duplicate pair to dismiss. Required for duplicate-pair dismissal; omit for contradiction verdicts."),
      conceptBId: z.string().optional().describe("Second concept of a possible-duplicate pair to dismiss. Required for duplicate-pair dismissal; omit for contradiction verdicts."),
    },
    async ({ contradictionId, decision, body, resolvedBy, circle, conceptAId, conceptBId }) => {
      const capturedBlock = capturePrewarmSnapshot(scope(circle));
      try {
        // --- Duplicate-pair dismissal path ---
        if (conceptAId !== undefined || conceptBId !== undefined) {
          if (!conceptAId || !conceptBId) return err("duplicate-pair dismissal requires both conceptAId and conceptBId");
          if (contradictionId !== undefined) return err("provide either contradictionId (contradiction verdict) or conceptAId+conceptBId (duplicate-pair dismissal), not both");
          // Reject contradiction-path-only fields: an agent passing `decision` or `body` alongside
          // conceptAId+conceptBId is attempting a contradiction verdict on a duplicate pair, which
          // would silently hide the pair instead. Name the conflict and point at both valid shapes.
          if (decision !== undefined) return err("field 'decision' belongs to the contradiction verdict path (requires contradictionId); for duplicate-pair dismissal pass only conceptAId + conceptBId (and optionally resolvedBy/circle)");
          if (body !== undefined) return err("field 'body' belongs to the contradiction verdict path (requires contradictionId); for duplicate-pair dismissal pass only conceptAId + conceptBId (and optionally resolvedBy/circle)");
          // Scope enforcement: both concepts must live in the caller-named circle.
          const circleA = core.circleOf(conceptAId);
          const circleB = core.circleOf(conceptBId);
          if (circleA === null) return err(`concept not found: ${conceptAId}`);
          if (circleB === null) return err(`concept not found: ${conceptBId}`);
          if (circleA !== scope(circle)) return err(`concept not found: ${conceptAId}`);
          if (circleB !== scope(circle)) return err(`concept not found: ${conceptBId}`);
          const r = core.dismissPossibleDuplicate(conceptAId, conceptBId, resolvedBy);
          if (!r.dismissed) return err(r.error);
          return mutOk({ circle: scope(circle), action: "duplicate-pair-dismissed", conceptAId, conceptBId, rowsUpdated: r.rowsUpdated }, "memory_resolve", false, capturedBlock);
        }
        // --- Contradiction verdict path (original, unchanged) ---
        if (!contradictionId) return err("contradictionId is required for contradiction verdicts");
        if (!decision) return err("decision is required for contradiction verdicts");
        if (core.circleOfContradiction(contradictionId) !== scope(circle)) return err(`contradiction not found: ${contradictionId}`); // scope enforcement
        const c = core.resolveContradiction(contradictionId, { decision, body, by: resolvedBy });
        if (!c) return err(`contradiction not found: ${contradictionId}`);
        // Idempotent no-op: contradiction already resolved or dismissed — zero mutations occurred.
        if ("alreadyClosed" in c) return mutOk({ circle: scope(circle), contradictionId, alreadyClosed: true, contradictionStatus: c.contradictionStatus }, "memory_resolve", false, capturedBlock);
        return mutOk({ circle: scope(circle), conceptId: c.id, status: c.status, version: c.version, confidence: Number(c.confidence.toFixed(2)) }, "memory_resolve", false, capturedBlock);
      } catch (e) {
        return err(`resolve failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_detach",
    "Split one or more observations out of a concept. The named observations are moved out of their source concept and either create a new concept (default) or are attached to an existing concept you specify with destConceptId. The source concept is recomputed (embedding, support count, confidence, body) from its remaining evidence and marked for re-synthesis. Use to undo a wrong merge, or to consolidate a possible-duplicate pair: memory_fetch both concepts, pick the observations to move, call memory_detach with destConceptId to fold them into the keeper. Detaching ALL observations into a destConceptId consolidates the source away (it is deleted). Cannot detach the last observation without destConceptId — move the whole concept with memory_reassign_circle instead.",
    {
      conceptId: z.string().describe("The concept to detach observations FROM."),
      observationIds: z.array(z.string()).min(1).describe("Ids of the observations to detach (from memory_fetch's observations[].id)."),
      destConceptId: z
        .string()
        .optional()
        .describe(
          "Attach the detached observations TO this existing concept instead of creating a new one. Must be in the same circle. Used to consolidate a possible-duplicate pair. Detaching ALL observations with this set removes the source concept entirely.",
        ),
      circle: z
        .string()
        .optional()
        .describe("The circle the conceptId belongs to (defaults to this session's circle). Pass it when working with an explicit circle."),
    },
    async ({ conceptId, observationIds, destConceptId, circle }) => {
      const capturedBlock = capturePrewarmSnapshot(scope(circle));
      try {
        if (core.circleOf(conceptId) !== scope(circle)) return err(`concept not found: ${conceptId}`);
        if (destConceptId && core.circleOf(destConceptId) !== scope(circle)) return err(`destConceptId concept not found: ${destConceptId}`);
        const r = await core.detach(conceptId, observationIds, { destConceptId, circle: scope(circle) });
        return mutOk({
          circle: scope(circle),
          sourceConceptId: r.sourceConceptId,
          destConceptId: r.destConceptId,
          destAction: r.destAction,
          observationsMoved: r.observationsMoved,
          sourceDeleted: r.sourceDeleted,
          message: r.sourceDeleted
            ? `Source concept consolidated into ${r.destConceptId} and removed.`
            : r.destAction === "created"
              ? `Created new concept ${r.destConceptId} from the detached observations. The source concept has been recomputed.`
              : `Attached detached observations to existing concept ${r.destConceptId}. The source concept has been recomputed.`,
        }, "memory_detach", false, capturedBlock);
      } catch (e) {
        return err(`detach failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_reassign_circle",
    "Move a memory — its concept, its observations, and its graph membership — from its current circle into another. The apply step of a memory migration: home a piece of unscoped \"default\" memory into its project's circle. Dedupes: if the target circle already holds a matching memory, the two MERGE (no duplicate, no re-embedding) and `action` comes back \"merged\". Pass `ids` (array) for a batch move; pass `id` (string) for a single move — exactly one of `id`/`ids` is required. Pass `circle` = the id's CURRENT circle if it isn't your session default. resolution: \"auto\" (default) merges into a matching destination concept. \"forceNew\": always keep distinct, recording a possible_duplicate_of edge on near-match — use for curation batch moves.",
    {
      id: z.string().optional().describe("Single concept id to move. Exactly one of `id` or `ids` is required."),
      ids: z.array(z.string()).optional().describe("Batch of concept ids to move (each individually atomic; errors captured per item without aborting the batch). Exactly one of `id` or `ids` is required."),
      toCircle: z.string().describe("The destination circle (e.g. the project's per-project circle)."),
      circle: z.string().optional().describe("The id's CURRENT circle (defaults to this session's circle). Pass \"default\" when migrating legacy unscoped memory."),
      resolution: z
        .enum(["auto", "forceNew"])
        .optional()
        .describe('"auto" (default): merge into a matching destination concept. "forceNew": always keep distinct, recording a possible_duplicate_of edge on near-match — use for curation batch moves.'),
    },
    async ({ id, ids, toCircle, circle, resolution }) => {
      // memory_reassign_circle is a multi-circle op (source + dest). Snapshot uses the session
      // default as the prewarm anchor — documented choice: the "from" circle is a migration source
      // and may not reflect the agent's working context; the session default is the stable anchor.
      const capturedBlock = capturePrewarmSnapshot(scope());
      try {
        // Validate: exactly one of id/ids.
        if (id !== undefined && ids !== undefined) return err("provide exactly one of `id` or `ids`, not both");
        if (id === undefined && ids === undefined) return err("provide exactly one of `id` or `ids`");
        const opts = resolution ? { resolution } : {};

        if (ids !== undefined) {
          // Batch mode.
          // Scope enforcement (F1): for each id, the concept must live in the caller-named circle.
          // Ids that fail produce a per-item error without aborting the batch; ids that pass go
          // to batchReassignCircle. Mirrors the single-id circleOf check.
          type BatchItem = { id: string; action: "error"; error: string } | (typeof r.results)[number];
          const callerCircle = scope(circle);
          const passIds: string[] = [];
          // scopeErrorByInput[i] is defined only for ids[i] that fail the scope check.
          const scopeErrorByInput: Array<{ id: string; action: "error"; error: string } | null> = ids.map((id) => {
            if (core.circleOf(id) !== callerCircle) {
              return { id, action: "error" as const, error: `concept not found: ${id}` };
            }
            passIds.push(id);
            return null;
          });
          const r = core.batchReassignCircle(passIds, toCircle, opts);
          // Weave scope-error items back in, preserving input id ordering.
          let passIdx = 0;
          const mergedResults: BatchItem[] = ids.map((_id, i) => {
            const scopeErr = scopeErrorByInput[i];
            if (scopeErr) return scopeErr;
            return r.results[passIdx++]!;
          });
          const totalCounts = {
            moved: r.counts.moved,
            merged: r.counts.merged,
            noop: r.counts.noop,
            error: r.counts.error + scopeErrorByInput.filter(Boolean).length,
          };
          // F4: when results are large, elide per-item success entries to avoid blind mid-JSON clip.
          const BATCH_INLINE_LIMIT = 25;
          if (mergedResults.length > BATCH_INLINE_LIMIT) {
            const errorItems = mergedResults.filter((res) => res.action === "error");
            return mutOk({
              toCircle: r.toCircle,
              counts: totalCounts,
              errors: errorItems,
              note: `per-item results elided for ${mergedResults.length - errorItems.length} items — all non-error items succeeded with the actions in counts`,
            }, "memory_reassign_circle", false, capturedBlock);
          }
          return mutOk({
            toCircle: r.toCircle,
            counts: totalCounts,
            results: mergedResults,
          }, "memory_reassign_circle", false, capturedBlock);
        }

        // Single mode.
        // Scope enforcement: the caller may only reassign an id that lives in the circle they named.
        if (core.circleOf(id!) !== scope(circle)) return err(`concept not found: ${id}`);
        const r = core.reassignCircle(id!, toCircle, opts);
        if (!r) return err(`concept not found: ${id}`);
        return mutOk({
          action: r.action,
          conceptId: r.conceptId,
          fromCircle: r.fromCircle,
          toCircle: r.toCircle,
          observationsMoved: r.observationsMoved,
          ...(r.mergedIntoId ? { mergedIntoId: r.mergedIntoId } : {}),
          message:
            r.action === "merged"
              ? `Deduped into an existing memory in ${r.toCircle} (no duplicate). Read it with memory_fetch(id, "${r.toCircle}").`
              : r.action === "moved"
                ? `Moved to ${r.toCircle}. It now lives in that circle — fetch/search it there.`
                : `Already in ${r.toCircle}; nothing to do.`,
        }, "memory_reassign_circle", false, capturedBlock);
      } catch (e) {
        return err(`reassign failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_circle_manage",
    "Create, rename, merge, or archive project-locality circles. RENAME establishes a stable alias so sessions that derive the old name keep resolving. MERGE moves every concept from one circle into another (default resolution forceNew: near-matches are kept distinct and linked with a possible_duplicate_of edge for later mediation). ARCHIVE hides a circle from store-wide recall and listings without deleting or sealing it. LIST enumerates the store's circles including archived ones. Topic organization belongs to the entity/edge graph — circles are write-home/project locality.",
    {
      action: z.enum(["rename", "merge", "archive", "unarchive", "list"]),
      circle: z.string().optional().describe("The circle to act on (rename/merge source, archive/unarchive target). Required for rename, merge, archive, unarchive."),
      to: z.string().optional().describe("Destination circle name for rename or merge."),
      resolution: z
        .enum(["auto", "forceNew"])
        .optional()
        .describe('For merge: "auto" deduplicates into existing concepts; "forceNew" (default) keeps all distinct and records possible_duplicate_of edges for near-matches.'),
    },
    async ({ action, circle, to, resolution }) => {
      // memory_circle_manage is a multi-circle op (rename/merge touch source+dest circles; archive/
      // unarchive/list touch a single circle but the caller's working context is the session default).
      // Snapshot uses the session default as the prewarm anchor — documented choice.
      const capturedBlock = capturePrewarmSnapshot(scope());
      try {
        if (action === "rename") {
          if (!circle) return err("rename requires `circle`");
          if (!to) return err("rename requires `to`");
          const r = core.renameCircle(circle, to);
          const response: CircleRenameResponse = {
            from: r.from,
            to: r.to,
            action: r.action,
            conceptsUpdated: r.conceptsUpdated,
            observationsUpdated: r.observationsUpdated,
            edgesUpdated: r.edgesUpdated,
            entitiesUpdated: r.entitiesUpdated,
          };
          return mutOk(response, "memory_circle_manage", false, capturedBlock);
        }
        if (action === "merge") {
          if (!circle) return err("merge requires `circle`");
          if (!to) return err("merge requires `to`");
          const r = await core.mergeCircle(circle, to, { resolution: resolution ?? "forceNew" });
          const response: CircleMergeResponse = {
            from: r.from,
            into: r.into,
            conceptResults: r.conceptResults,
            counts: r.counts,
          };
          return mutOk(response, "memory_circle_manage", false, capturedBlock);
        }
        if (action === "archive") {
          if (!circle) return err("archive requires `circle`");
          core.archiveCircle(circle);
          const response: CircleArchiveResponse = { action: "archived", circle };
          return mutOk(response, "memory_circle_manage", false, capturedBlock);
        }
        if (action === "unarchive") {
          if (!circle) return err("unarchive requires `circle`");
          core.unarchiveCircle(circle);
          const response: CircleUnarchiveResponse = { action: "unarchived", circle };
          return mutOk(response, "memory_circle_manage", false, capturedBlock);
        }
        // list — read-only (enumerate circles)
        const response: CircleListResponse = { circles: core.listCircles(undefined, { includeArchived: true }) };
        return readOk(response, "memory_circle_manage", capturedBlock);
      } catch (e) {
        return err(`circle_manage failed: ${msg(e)}`);
      }
    },
  );

  // ---- First Block tools --------------------------------------------------

  server.tool(
    "memory_first_block",
    `Manage the First Block — the user-curated, always-injected-first section of agent_context. Dispatch via the \`action\` parameter:

  • "promote"        — Pin a concept. Requires conceptId + summary (up to ${FIRST_BLOCK_SUMMARY_MAX_CHARS} chars). The agent sees the summary at every session start without a search query; full detail is one memory_fetch away. Only the user may promote (never auto-promote). Returns the new entry and totalSummaryChars (a cost signal — keep the total manageable). Errors on double-promote.
  • "remove"         — Unpin a concept. Requires conceptId. Does NOT affect the concept itself. Returns { removed: true/false }.
  • "list"           — List entries for a circle, position-ordered. Returns { total, offset, limit, entries: [{ conceptId, summary, summaryDirty, position, conceptStatus }] }. Paginates: pass offset (default 0) and limit (default ${FIRST_BLOCK_LIST_DEFAULT_LIMIT}, capped at ${FIRST_BLOCK_LIST_MAX_LIMIT} in preview mode or ${FIRST_BLOCK_LIST_FULL_MAX_LIMIT} in full=true mode) to page through ALL pins without missing any. By default, summary is truncated to a short preview; pass full=true to get untruncated summaries — note that full=true uses a smaller page cap (${FIRST_BLOCK_LIST_FULL_MAX_LIMIT}) to stay within the response size limit. summaryDirty=true means the underlying concept changed and needs a refresh (use update_summary). Disputed concepts are suppressed from auto-injection but still listed here for curation.
  • "reorder"        — Reorder the block. Requires orderedConceptIds (all currently pinned ids in the desired order; must be a complete list — no partial reorder). Use list (paging if needed) to discover all ids first. Positions are assigned 0, 1, 2, …
  • "update_summary" — Refresh a stale summary and clear summaryDirty. Requires conceptId + summary. Use when summaryDirty=true (seen in list or agent_context): memory_fetch the concept, write the updated summary here. Max ${FIRST_BLOCK_SUMMARY_MAX_CHARS} chars.

  circle is optional for all actions (defaults to this session's circle).`,
    {
      action: z.enum(["promote", "remove", "list", "reorder", "update_summary"]).describe(
        'The operation to perform. One of: "promote", "remove", "list", "reorder", "update_summary".',
      ),
      conceptId: z.string().optional().describe("Required for promote, remove, update_summary. The concept to act on."),
      summary: z.string().optional().describe(`Required for promote and update_summary. The summary text (max ${FIRST_BLOCK_SUMMARY_MAX_CHARS} chars).`),
      orderedConceptIds: z.array(z.string()).optional().describe("Required for reorder. All pinned conceptIds in the desired order (complete list)."),
      circle: z.string().optional().describe("The circle to operate on (defaults to this session's circle)."),
      promotedBy: z.string().optional().describe("promote only — optional label recording who performed the promotion."),
      offset: z.number().int().min(0).optional().describe("list only — zero-based offset into the position-ordered pin list (default 0)."),
      limit: z.number().int().min(1).optional().describe(`list only — max entries to return per page (default ${FIRST_BLOCK_LIST_DEFAULT_LIMIT}; capped at ${FIRST_BLOCK_LIST_MAX_LIMIT} in preview mode or ${FIRST_BLOCK_LIST_FULL_MAX_LIMIT} when full=true). Use with offset to page through all pins.`),
      full: z.boolean().optional().describe("list only — if true, return the complete untruncated summary for each entry instead of the default 120-char preview. Use when you need to inspect the full existing summary before update_summary or remove (e.g. to avoid clobbering a long summary). Page narrowly when using full=true. (Finding 3 — Codex PR-32)"),
    },
    async ({ action, conceptId, summary, orderedConceptIds, circle, promotedBy, offset, limit, full }) => {
      const capturedBlock = capturePrewarmSnapshot(scope(circle));
      try {
        if (action === "promote") {
          if (!conceptId) return err('action "promote" requires conceptId');
          if (!summary) return err('action "promote" requires summary');
          if (core.circleOf(conceptId) !== scope(circle)) return err(`concept not found: ${conceptId}`);
          const r = core.promoteToFirstBlock(conceptId, summary, scope(circle), { promotedBy });
          return mutOk({ circle: scope(circle), ...r }, "memory_first_block", false, capturedBlock);
        }

        if (action === "remove") {
          if (!conceptId) return err('action "remove" requires conceptId');
          if (core.circleOf(conceptId) !== scope(circle)) return err(`concept not found: ${conceptId}`);
          const r = core.removeFromFirstBlock(conceptId, scope(circle));
          return mutOk({ circle: scope(circle), conceptId, removed: r.removed }, "memory_first_block", false, capturedBlock);
        }

        if (action === "list") {
          const allEntries = core.listFirstBlock(scope(circle));
          const total = allEntries.length;
          // Offset-pagination so ALL pins are addressable regardless of count — no hard cap
          // hides entries from reorder/remove/update_summary. (Finding A — Codex round-5)
          const pageOffset = offset ?? 0;
          // Clamp the effective limit to prevent the JSON payload from overflowing RESULT_MAX_CHARS.
          // Preview mode (full=false): up to FIRST_BLOCK_LIST_MAX_LIMIT (200) — 120-char summaries
          // keep each row ≈ 200 chars, so 200 rows ≈ 40 000 chars. (Finding 1 — Codex PR-32)
          // Full mode (full=true): capped at the tighter FIRST_BLOCK_LIST_FULL_MAX_LIMIT (40) —
          // 800-char max summaries × 40 = 32 000 chars, safely under the 40 000 ceiling.
          // (full=true overflow — Codex PR-32 follow-up)
          const maxLimit = full ? FIRST_BLOCK_LIST_FULL_MAX_LIMIT : FIRST_BLOCK_LIST_MAX_LIMIT;
          const pageLimit = Math.min(limit ?? FIRST_BLOCK_LIST_DEFAULT_LIMIT, maxLimit);
          const pageEntries = allEntries.slice(pageOffset, pageOffset + pageLimit);
          // By default, truncate each summary to a short preview so the page response stays
          // well under the 40k ok() ceiling even at the maximum page size. When full=true,
          // return the complete untruncated summary so the caller can inspect it before
          // update_summary or remove. (Finding 3 — Codex PR-32; Finding A — Codex round-3)
          const compactEntries = pageEntries.map((e) => ({
            conceptId: e.conceptId,
            position: e.position,
            summaryDirty: e.summaryDirty,
            conceptStatus: e.conceptStatus,
            summary: full
              ? e.summary
              : e.summary.length > FIRST_BLOCK_LIST_SUMMARY_PREVIEW_CHARS
                ? e.summary.slice(0, FIRST_BLOCK_LIST_SUMMARY_PREVIEW_CHARS) + "…"
                : e.summary,
          }));
          return readOk(
            {
              circle: scope(circle),
              total,
              offset: pageOffset,
              limit: pageLimit,
              entries: compactEntries,
            },
            "memory_first_block",
            capturedBlock,
          );
        }

        if (action === "reorder") {
          if (!orderedConceptIds) return err('action "reorder" requires orderedConceptIds');
          core.reorderFirstBlock(orderedConceptIds, scope(circle));
          return mutOk({ circle: scope(circle), orderedConceptIds, message: "First Block reordered." }, "memory_first_block", false, capturedBlock);
        }

        if (action === "update_summary") {
          if (!conceptId) return err('action "update_summary" requires conceptId');
          if (!summary) return err('action "update_summary" requires summary');
          if (core.circleOf(conceptId) !== scope(circle)) return err(`concept not found: ${conceptId}`);
          const r = core.updateFirstBlockSummary(conceptId, summary, scope(circle));
          if (!r) return err(`concept ${conceptId} is not in the First Block for circle '${scope(circle)}'`);
          return mutOk({ circle: scope(circle), ...r }, "memory_first_block", false, capturedBlock);
        }

        return err(`unknown action: ${String(action)}`);
      } catch (e) {
        return err(`memory_first_block (${action}) failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "agent_context",
    "Identity + query-independent session restore (PREWARM). Call FIRST, at session start — with NO query — to resume: `firstBlock` (user-curated always-first section — each entry is a rich summary of a pinned concept; fetch the concept by conceptId for full detail), `activeWorkstreams` (where you left off), `topConcepts` (your living model, ranked by confidence/usefulness/recency — identity + shape only, fetch by id for content), `staleConcepts` (unconfirmed — worth re-checking), and `openContradictions` (resolve with memory_resolve). Replaces guessing a search query to rebuild context. otherCircles (when present) names other circles — call memory_search/memory_gather without a circle arg to recall across all of them. `resolvedFrom` (when present) indicates the requested circle was an alias and shows the original name. `curationAttention` (when present) signals that the store has items needing curation — run the curate-memory ritual.",
    { circle: z.string().optional() },
    async ({ circle }) => {
      const resolvedCircle = scope(circle);
      const state = core.prewarm(resolvedCircle);
      const ov = core.overview(resolvedCircle);
      // buildCurationAdvisory uses the FULL firstBlock set (pre-filter) so that
      // firstBlockDisputed counts disputed entries even though they are excluded from injection.
      const advisory = buildCurationAdvisory(ov, state.firstBlock);
      const others = core.listCircles(resolvedCircle).slice(0, 5).map(({ circle: c, concepts }) => ({ circle: c, concepts }));

      // Finding 5: exclude disputed entries from the injection payload (matching the rendered
      // auto-prewarm path). The curationAttention advisory above already counts them.
      const activeFirstBlock = state.firstBlock.filter((e) => e.conceptStatus === "active");

      // Finding 4: bound the firstBlock in the structured payload. If the active entries alone
      // would overflow FIRST_BLOCK_INJECTION_MAX_CHARS, replace with a compact advisory instead
      // of an unbounded array (mirroring the rendered path's oversize advisory).
      const firstBlockSerial = JSON.stringify(activeFirstBlock);
      const injectedFirstBlock: typeof activeFirstBlock | string =
        firstBlockSerial.length > FIRST_BLOCK_INJECTION_MAX_CHARS
          ? `[First Block: ${activeFirstBlock.length} pinned item${activeFirstBlock.length === 1 ? "" : "s"} exceed the injection budget ` +
            `(${firstBlockSerial.length} chars vs ${FIRST_BLOCK_INJECTION_MAX_CHARS} char budget) — review/trim via memory_first_block or the dashboard.]`
          : activeFirstBlock;

      return wrapSuccess(ok({
        agentId: core.getAgentId(),
        mode: "local",
        circle: resolvedCircle,
        ...(state.resolvedFrom !== undefined ? { resolvedFrom: state.resolvedFrom } : {}),
        ...state,
        firstBlock: injectedFirstBlock,
        ...(advisory !== null ? { curationAttention: advisory } : {}),
        ...(others.length > 0 ? { otherCircles: others } : {}),
      }), { isMutating: false, isCheckpointWithWorkstream: false, toolName: "agent_context" });
    },
  );

  return server;
}

/**
 * Derive RegisterMonetCoreToolsOpts from environment variables.
 * Exported for testing — lets tests verify the env-var mapping without spawning a process.
 * MONET_NO_AUTOPREWARM=1  → autoPrewarm:false
 * MONET_NO_CHECKPOINT_NUDGE=1 → checkpointNudge:false
 */
export function deriveOptsFromEnv(env: NodeJS.ProcessEnv = process.env): RegisterMonetCoreToolsOpts {
  return {
    autoPrewarm: env.MONET_NO_AUTOPREWARM !== "1",
    checkpointNudge: env.MONET_NO_CHECKPOINT_NUDGE !== "1",
  };
}

export async function createMonetCoreMcpServer(core: MonetCore): Promise<McpServer> {
  const server = new McpServer(
    { name: "monet-core", version: "0.7.0" },
    {
      capabilities: { tools: {} },
      instructions: MONET_SERVER_INSTRUCTIONS,
    },
  );
  registerMonetCoreTools(server, core, deriveOptsFromEnv());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
