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
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MonetCore, FIRST_BLOCK_SUMMARY_MAX_CHARS } from "./engine";
import type { MergeConceptResult } from "./engine";
import type { SourceAuthorizationContext } from "./source-types";
import { sanitizeSourceError } from "./source-errors";
import { createSourceScheduler } from "./source-scheduler";
import type { SourceSchedulerHandle, SourceSchedulerOptions } from "./source-scheduler";

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
// REVIEW FIX (MINOR): source concept outline cap (file=concept, Ruling 9). A cheap upper bound on
// how many entries the size-fit loop below ever iterates over — NOT the real guarantee (see that
// loop's own comment). 500 was unsound on its own: headingPath is caller/document content with no
// length ceiling, and at a realistic 2-3-level, moderately-long heading path (~250 chars/entry
// serialized), 500 entries alone runs to ~125 000 chars — over 3x the 40 000-char RESULT_MAX_CHARS
// ceiling, well past where ok() would truncate the JSON mid-array and leave an unparseable
// response. 200 keeps this bound cheap (O(n) JSON.stringify calls in the fit loop, n ≤ 200) while
// staying close enough to the size-fit's own typical stopping point that it rarely binds first.
const FETCH_OUTLINE_MAX_ENTRIES = 200;

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
 * Hard maximum for memory_first_block action:"list" limit in preview (full=false) mode —
 * clamped at request time so a caller cannot request a slice that serialises past
 * RESULT_MAX_CHARS and gets truncated mid-object by ok() (which would leave an un-parseable
 * response exactly when paging through a large First Block store).
 *
 * Worst-case size math (the floor that determines this cap): each row carries conceptId
 * (36-char uuid), position, summaryDirty, conceptStatus, and a 120-char preview summary
 * (120-char slice + "…"), pretty-printed at 2-space indent.  Measured at the max-summary
 * boundary that is ~301 chars/row → 200 rows ≈ 60 000 chars, well OVER the 40 000-char
 * RESULT_MAX_CHARS ceiling (ok() would truncate the JSON mid-object).  At 130 rows the
 * serialized payload is ~38 700 chars, comfortably under the 39 871-char effective ceiling
 * (RESULT_MAX_CHARS minus the ok() truncate-note reservation).  130 keeps the cap close to
 * the 100-row default (1.3×) while staying provably under the ceiling; callers page with
 * offset+limit.  (Finding 1 — Codex PR #33)
 */
const FIRST_BLOCK_LIST_MAX_LIMIT = 130;

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
function buildPrewarmBlock(
  core: MonetCore,
  circle: string,
  sourceAuthorizationContext?: Readonly<SourceAuthorizationContext>,
): string {
  const state = core.prewarm(circle, { sourceAuthorizationContext });
  const ov = core.overview(circle, { sourceAuthorizationContext });

  // === FIRST BLOCK (always-first, protected from truncation) ===
  // Only inject active entries; disputed entries are suppressed here and counted in curationAttention.
  const activeFirstBlock = state.firstBlock.filter((e) => e.conceptStatus === "active");
  const firstBlockLines: string[] = [];
  if (activeFirstBlock.length > 0) {
    firstBlockLines.push("Governing workflows and preferences — MUST follow unless a system/developer instruction or an explicit user instruction overrides:");
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

  // If the first-block blob alone already exceeds the budget, replace it with a compact advisory
  // (telling the agent how many items are pinned and how to trim them) and use THAT as the
  // first-block blob — then CONTINUE into the lower-section fitting below so active workstreams,
  // top concepts, stale, and open contradictions still render instead of being dropped.  The
  // advisory is short (a single line), so there is room left for the normal lower-section fitting
  // even with several long pins.  (Finding 3 — Codex PR #33: oversize pins must not drop
  // session-resume context on auto-prewarm.)
  let firstBlockBlobFinal = firstBlockBlob;
  if (used >= budget) {
    const pinnedCount = activeFirstBlock.length;
    const oversizeAdvisory =
      `[First Block: ${pinnedCount} pinned item${pinnedCount === 1 ? "" : "s"} exceed the prewarm budget ` +
      `(${used} chars vs ${budget} char budget) — review/trim via memory_first_block or the dashboard.]\n`;
    firstBlockBlobFinal = oversizeAdvisory;
    used = oversizeAdvisory.length;
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

  return HEADER + firstBlockBlobFinal + lowerFitted + FOOTER;
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
  /** Host-injected identity; never accepted from tool arguments. */
  sourceAuthorizationContext?: Readonly<SourceAuthorizationContext>;
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
  const sourceAuthorizationContext = opts?.sourceAuthorizationContext
    ? Object.freeze({ ...opts.sourceAuthorizationContext })
    : undefined;

  // In-flight tool-call tracking (Codex P2 #2): wrap server.tool() ONCE, here, before any of the
  // individual registrations below, so every handler (memory_*, source_*, ...) is tracked
  // uniformly without touching each call site. getGracefulShutdown's run() awaits
  // getInFlightTracker(server).quiesce() between server.close() and core.close(), so a
  // long-running handler (e.g. source_sync) can't touch the database after a signal/EOF has
  // closed it out from under it mid-call.
  const inFlightTracker = getInFlightTracker(server);
  const originalTool = server.tool.bind(server);
  server.tool = ((...toolArgs: unknown[]) => {
    const handler = toolArgs[toolArgs.length - 1] as (...handlerArgs: unknown[]) => unknown;
    const trackedHandler = (...handlerArgs: unknown[]): unknown => {
      inFlightTracker.increment();
      let result: unknown;
      try {
        result = handler(...handlerArgs);
      } catch (error) {
        inFlightTracker.decrement();
        throw error;
      }
      if (result instanceof Promise) {
        return result.finally(() => inFlightTracker.decrement());
      }
      inFlightTracker.decrement();
      return result;
    };
    const trackedArgs = [...toolArgs.slice(0, -1), trackedHandler];
    return (originalTool as (...args: unknown[]) => unknown)(...trackedArgs);
  }) as unknown as typeof server.tool;

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
    const block = buildPrewarmBlock(core, resolvedCircle, sourceAuthorizationContext);
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
        const block = buildPrewarmBlock(core, resolvedCircle, sourceAuthorizationContext);
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
    'Store something worth remembering. By default the substrate deduplicates automatically: similar evidence resolves into an existing concept; novel evidence creates a new one. It finds by evidence and confirms by identity — an existing concept is nominated by how well its own stored observations match yours, then kept only if the concept as a whole is still coherent with what you wrote; when those two disagree the concept is bimodal, so instead of absorbing your evidence the substrate forks it and flags the pair as a possible duplicate for you to mediate (that is a fork signal, reported as resolutionMode="fork-signal"). The mirror case is reported as resolutionMode="blur-duplicate": a concept looked like an exact match as a whole but none of its stored evidence agreed, so your memory was kept separate and the pair flagged rather than silently absorbed. Pass resolution="forceNew" to always create a new concept (useful for bulk import flows where each item is known to be distinct). Pass attachTo=<conceptId> to attach directly to a specific concept, bypassing automatic scoring. Cheap and instant — synthesis happens later, on read. If the stored concept is a preference, way-of-working, or something the user flagged as important, consider suggesting memory_first_block with action="promote" to pin it to the First Block — but only propose; never auto-promote; the user must confirm. Use kind="procedure" for behavioral rules and kind="preference" for style/voice/format preferences — these kinds trigger the mandatory First Block offer.',
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
          // Additive companion to `action` — tells apart the two ways a store can report
          // "ambiguous": an ordinary near-miss fork, and a fork SIGNAL (the evidence matched but the
          // target concept is bimodal). See the tool description above.
          ...(r.resolutionMode ? { resolutionMode: r.resolutionMode } : {}),
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
        const results = await core.search(query, {
          circle: circle !== undefined ? scope(circle) : undefined,
          limit,
          sourceAuthorizationContext,
        });
        const circleLabel = circle !== undefined ? scope(circle) : "(all circles)";
        return readOk({
          circle: circleLabel,
          results,
          guidance:
            "Cards show what a memory is about, not what it says. Call memory_fetch(id) to read it — if the card's `circle` isn't your session default, pass it: memory_fetch(id, circle). `matchedObservationId` (when present) names WHICH observation matched, not what it said — still fetch to read. Fewer results than `limit` (or none) means nothing in your own memories scored above the relevance floor, not that the search failed; that floor applies to your memories only, so a connected source file can still appear on a query none of them answered.",
        }, "memory_search", capturedBlock);
      } catch (e) {
        return err(`search failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_overview",
    'A glanceable, read-only snapshot of everything stored for a circle — counts (incl. dirty/disputed/stale/possibleDuplicates), the living model (top concepts), where you left off (active threads), open contradictions, and the connection-graph shape (entity hubs, most-connected memories, edge-type histogram). Open possible-duplicate pairs (concepts that nearly matched at store time and were forked instead of merged) are surfaced in \'possibleDuplicates\' — the list shows the top 10 pairs by score; counts.possibleDuplicates has the full total. Review with memory_fetch (using the conceptAId / conceptBId shown), then use memory_detach with destConceptId to consolidate if they are the same concept. \'resolutionStats\' reports how store-time resolution has been deciding lately (counts by mode over the last 30 days, plus decidedTotal — the count of writes that actually ran the rule, excluding caller-directed attachTo/forceNew): divide by decidedTotal for a rate, and watch fork-signal (concepts going bimodal) and blur-duplicate (centroids drifting off their own evidence) as the health signals behind the duplicate pairs above. Use to answer "what do you actually know about this?" or to report memory health. Read-only — never mutates, never returns memory bodies; fetch by id to read one. Pass `entity` to list the memories tied to one hub. otherCircles lists other circles in the store (name + concept count + last activity).',
    { circle: z.string().optional(), entity: z.string().optional() },
    async ({ circle, entity }) => {
      const capturedBlock = capturePrewarmSnapshot(scope(circle));
      try {
        if (entity) return readOk({ circle: scope(circle), entity, concepts: core.conceptsForEntity(entity, scope(circle)) }, "memory_overview", capturedBlock);
        const ov = core.overview(scope(circle), { sourceAuthorizationContext });
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
        const memories = core.listMemories(scope(circle), {
          withProvenance, limit: lim, cursor: parsed, sourceAuthorizationContext,
        });
        const last = memories[memories.length - 1];
        const nextCursor = memories.length === lim && last ? `${last.updatedAt}:${last.id}` : null;
        return readOk({
          circle: scope(circle),
          total: core.conceptCount(scope(circle), sourceAuthorizationContext), // current size — shrinks as you reassign out
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
        const r = await core.gather(intent, {
          circle: circle !== undefined ? scope(circle) : undefined,
          limit,
          depth: depth ? Number(depth) : undefined,
          sourceAuthorizationContext,
        });
        const circleLabel = circle !== undefined ? scope(circle) : "(all circles)";
        return readOk({
          circle: circleLabel,
          ranked: r.ranked,
          seed: r.seed,
          stopReason: r.stopReason,
          reachableByType: r.reachableByType,
          guidance:
            "Cards show what a memory is about, not what it says. Call memory_fetch(id) to read one — if the card's `circle` isn't your session default, pass it: memory_fetch(id, circle). `matchedObservationId` (on ranked cards, when present) names WHICH observation matched, not what it said — still fetch to read; its absence means the card was reached by the graph or by wording overlap rather than by a direct match. A ranked card's `score` is its fused rank (similarity combined with graph activation), NOT that observation's own similarity. An empty `ranked` (or fewer than `limit`) means the intent matched nothing to build a context from, not that gather failed.",
        }, "memory_gather", capturedBlock);
      } catch (e) {
        return err(`gather failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_fetch",
    "Read the full content of a concept by id. If `needsSynthesis` is true, the concept has new raw evidence: read `observations`, write ONE coherent `body` that reconciles them, and call memory_synthesize(id, body). You are the synthesizer. Each entry in `observations` is {id, content}. The id is needed to call memory_detach. Concepts with many observations: page newest→oldest with observationsOffset (0 = newest page, step by 20); totalObservations tells you when you have reached all of them. Source concepts (kind='source', file=concept) are different: they return STRUCTURE, not content, by default — `title`, `sourcePath` + `sourceId` (pass sourceId to the source_path tool for the on-disk location, then grep the path for detail), and an `outline` of every active section (headingPath, occurrence, observationId), never `observations`/needsSynthesis. Pass includeBody:true for the full concatenated file body if you need it read inline instead of via the path.",
    {
      id: z.string(),
      circle: z.string().optional().describe("The circle the id belongs to. Omit to look the id up store-wide (the response includes its home circle); if provided, the id must live in that circle."),
      observationsOffset: z.number().int().min(0).optional().describe("Page through observations newest-first: skip this many from the newest end before applying the per-page cap (default 20). offset=0 returns the newest page. Increment by 20 each request. Use with totalObservations to know when you've retrieved all pages. Not used for source concepts (they return an outline instead — see includeBody)."),
      includeBody: z.boolean().optional().describe("Source concepts (kind='source'): include the full concatenated file body. Default false — the response returns structure (title, sourcePath, outline) instead, since a source concept's body can run to the whole file. Normal concepts: the body is included by default; pass false to get the OBSERVATIONS instead of the body. That matters only when the body is long enough to be truncated — the response then carries the body alone, and includeBody:false is how you ask for the evidence instead."),
    },
    async ({ id, circle, observationsOffset, includeBody }) => {
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
        const homeCircle = core.circleOf(id, sourceAuthorizationContext);
        if (homeCircle === null) return err(`concept not found: ${id}`);
        // Scope-gate: if the caller named a circle explicitly, the id must live there.
        // Check BEFORE taking the snapshot so a rejection never consumes the one-shot.
        if (circle !== undefined && homeCircle !== scope(circle)) return err(`concept not found: ${id}`);
        // Snapshot circle: explicit caller circle wins; else use the fetched concept's homeCircle.
        const snapshotCircle = circle !== undefined ? scope(circle) : homeCircle;
        const capturedBlock = capturePrewarmSnapshot(snapshotCircle);
        // pageSize=FETCH_MAX_OBS: the engine slices exactly one page newest-first from the offset,
        // so the MCP layer receives at most FETCH_MAX_OBS observations with no secondary cap needed.
        const c = await core.getConcept(id, {
          synthesize: false,
          observationsOffset: observationsOffset ?? 0,
          pageSize: FETCH_MAX_OBS,
          includeBody,
          sourceAuthorizationContext,
        });
        if (!c) return err(`concept not found: ${id}`);

        // File=concept (ratified, Phase 1), Ruling 9: a source concept's outline is present iff
        // the engine classified it as connector-owned — structure, not paginated observations.
        if (c.outline !== undefined) {
          const body = includeBody ? clip(c.body ?? "", FETCH_BODY_MAX_CHARS) : undefined;
          const fixedFields = {
            id: c.id, circle: c.circle, kind: c.kind, title: c.title, sourcePath: c.sourcePath, sourceId: c.sourceId,
            totalObservations: c.totalObservations,
            ...(body ? { body: body.text, ...(body.clipped ? { bodyTruncated: true } : {}) } : { bodyOmitted: true }),
            supportCount: c.supportCount, confidence: c.confidence, version: c.version, lastConfirmedAt: c.lastConfirmedAt,
          };
          // REVIEW FIX (MINOR): headingPath is caller/document content with no length ceiling, so
          // a count cap alone (FETCH_OUTLINE_MAX_ENTRIES) is not provably safe against a file with
          // long or deeply-nested headings — same overflow shape memory_first_block's own "list"
          // action already guards against (see FIRST_BLOCK_LIST_MAX_LIMIT's comment). Two caps
          // cooperate the same way here: the count cap bounds how many JSON.stringify calls this
          // loop makes (cheap, O(n), n ≤ FETCH_OUTLINE_MAX_ENTRIES); the size fit against the ACTUAL
          // serialized envelope (fixed fields + growing outline) is the real guarantee, stopping
          // one entry before the payload would cross budget so ok() never has to truncate this
          // response mid-JSON and leave it unparseable.
          const okNote = `\n\n…[result truncated to fit the host's tool-result limit — narrow the query/intent, lower \`limit\`, or memory_fetch a specific id]`;
          const sizeBudget = RESULT_MAX_CHARS - okNote.length;
          const countCapped = c.outline.slice(0, FETCH_OUTLINE_MAX_ENTRIES);
          const fitOutline: Array<{ headingPath: string[]; occurrence: number; segmentIndex: number; observationId: string }> = [];
          // REVIEW FIX (round 4, Codex thread 10): check the budget BEFORE pushing, uniformly for
          // EVERY entry including the first. The old loop pushed the first candidate unconditionally
          // (its pre-push check was gated on `fitOutline.length > 0`, which is always false on
          // entry 1) and only then checked the budget — so a single pathologically long heading path
          // still landed in fitOutline even though it alone exceeded sizeBudget, and the response
          // fell through to readOk/ok() truncating the serialized JSON mid-object: unparseable
          // output instead of a valid, merely-shorter one. Checking first means a first entry that
          // alone is over budget is dropped entirely, leaving fitOutline empty rather than invalid.
          for (const entry of countCapped) {
            // REVIEW FIX (round 5, Codex thread R5-5): segmentIndex was dropped when building the
            // fitted candidate entries, even though SourceOutlineEntry (engine.ts) carries it — a
            // section split across multiple chunker segments (an oversized heading, see thread 9/
            // R5-3) surfaced as indistinguishable, same-looking outline entries here.
            const candidate = [...fitOutline, { headingPath: entry.headingPath, occurrence: entry.occurrence, segmentIndex: entry.segmentIndex, observationId: entry.observationId }];
            const serialized = JSON.stringify({ ...fixedFields, outline: candidate }, null, 2);
            if (serialized.length > sizeBudget) break; // would cross budget, even as the very first entry — stop, let the note explain
            fitOutline.push(candidate[candidate.length - 1]!);
          }
          return readOk({
            ...fixedFields,
            outline: fitOutline,
            ...(c.outline.length > fitOutline.length
              ? {
                  outlineNote: fitOutline.length === 0
                    ? `This file's outline could not be included: even the first of ${c.outline.length} section(s) exceeds the result-size limit. memory_fetch a specific observation id, or narrow the query.`
                    : `Showing the first ${fitOutline.length} of ${c.outline.length} sections.`,
                }
              : {}),
          }, "memory_fetch", capturedBlock);
        }

        const total = c.totalObservations;
        const offset = c.observationsOffset;
        // Engine already returned exactly one page; all observations in c.observations are kept.
        const kept = c.observations;
        const body = clip(c.body ?? "", FETCH_BODY_MAX_CHARS);
        // BODY OR OBSERVATIONS — NEVER BOTH ONCE THE BODY NO LONGER FITS.
        // A clipped body means this concept has already spent the response budget. Appending an
        // observation page on top spends what is left on newest-first churn (commit hashes, test
        // counts, transport fixes) while the durable synthesized claim is the part that just got
        // cut — the high-value half truncated to pay for the low-value half. Measured on a concept
        // whose body clipped at 191,120 chars: ~200 useful tokens inside ~10K of response.
        // So the default view serves the BODY, and a caller that wants the evidence instead asks
        // for it explicitly with includeBody:false.
        const sendBody = includeBody !== false;
        const sendObservations = !sendBody || !body.clipped;
        return readOk({
          id: c.id,
          circle: c.circle, // pass this back to memory_synthesize if it isn't your session default
          kind: c.kind,
          ...(sendBody ? { body: body.text, ...(body.clipped ? { bodyTruncated: true } : {}) } : { bodyOmitted: true }),
          ...(sendObservations
            ? { observations: kept.map((o) => ({ id: o.id, content: clip(o.content, FETCH_OBS_MAX_CHARS).text })) }
            : {}),
          totalObservations: total,
          observationsOffset: offset,
          // Note: omitted is always 0 (engine returns exactly one page). Use kept.length vs total
          // to detect whether more pages exist. Offset here is newest-first (offset 0 = newest page).
          ...(!sendObservations
            ? {
                observationsNote: `Body truncated, so its ${total} observation(s) were withheld — sending both would cut the synthesized body further to pay for newest-first evidence. Re-fetch with includeBody:false to get the observations instead.`,
              }
            : kept.length === 0 && offset > 0
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
          // Synthesis routing. memory_synthesize clears `dirty` with the body the agent writes, so
          // synthesizing from a partial view would discard unseen observations — hence the
          // offset=0 AND total-fits-one-page gate. But "no observations in THIS response" has two
          // very different causes and only one of them is permanent:
          //   (a) all evidence is here                        → synthesize now
          //   (b) evidence withheld so the truncated body fit, yet it WOULD all fit in one page
          //                                                   → say so, and name the one re-fetch
          //   (c) genuinely more observations than a page     → defer, leave dirty
          // Case (b) is created by the body-or-observations trim above, and without its own branch
          // it fell into (c) — whose message both misstates the reason ("more observations than
          // shown") and says to leave the concept dirty. That permanently strands exactly the
          // concepts the checkpoint worklist points at: 52 of them in the live store at the time of
          // this change, every one synthesizable after a single includeBody:false fetch. Deepening
          // the synthesis debt is the one outcome this whole pass must not produce.
          ...(c.needsSynthesis && offset === 0 && total <= FETCH_MAX_OBS
            ? sendObservations
              ? {
                  synthesisInstruction:
                    "This concept has unsynthesized evidence. Read `observations`, write a single coherent `body`, then call memory_synthesize(id, body) — pass this concept's `circle` (above) if it isn't your session default.",
                }
              : {
                  synthesisInstruction:
                    `This concept has unsynthesized evidence, withheld here so the truncated body could fit. All ${total} observation(s) fit in a single page — re-fetch with includeBody:false to read them, then write a coherent body and call memory_synthesize(id, body), passing this concept's \`circle\` (above) if it isn't your session default. Do NOT synthesize from the body alone.`,
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
    "End of session — preserve where you left off. Pass `workstream`: a COMPRESSED snapshot of this session (open questions, decisions, discarded alternatives, important entities/files, next steps) — many raw turns distilled into a few durable slots. It survives as a workstream that next session's agent_context restores. Also returns the concepts still needing synthesis as a WORKLIST — id, title, kind and observationCount only, never the observation text. memory_fetch(id) the one you decide to synthesize.",
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
            ? "For each dirty concept you choose to work: memory_fetch(id) to read its observations → write a coherent body → memory_synthesize(id, body). If `circle` above isn't your session default, pass it: memory_synthesize(id, body, circle)."
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
    "WHAT GETS SUPERSEDED: pass `contradictedObservationId` to name the observation the correction contradicted — you already have the evidence in front of you at this point, so a name given HERE is not a guess. accept-new then supersedes EXACTLY that observation (successor: the correcting observation), no matter how many other live observations the concept holds. keep-current records it as the prior being kept; it does not change what gets superseded (the correction is still retired with no successor — see below). The name is validated: it must exist, belong to the same concept as the contradiction, be live (not already superseded), predate the correcting observation (a later observation was never in dispute with it — naming one is refused, not silently accepted), and not be the correcting observation itself. It also requires the contradiction to actually HAVE a correcting observation — a bare contradiction (flagged without one, e.g. via memory_flag_contradiction with no observationId) contradicted nothing, so naming a loser for it is refused for every decision, not only accept-new. " +
    "Omit `contradictedObservationId` and the conservative fallback applies, because nothing else records WHICH prior a correction contradicted: accept-new supersedes the single prior ONLY when exactly one live observation predates the correction; with several it supersedes NOTHING and REQUIRES `body`, which is then the only record of the verdict — the contradicted claim stays live evidence INDEFINITELY — nothing retires it automatically (memory_synthesize only rewrites the body), so it keeps contributing to support and the concept embedding until something explicitly supersedes or detaches it. keep-current (named or not) retires the correction terminally, naming no successor. For accept/keep, pass the reconciled `body`. The concept restores to active once no conflicts remain. " +
    "DUPLICATE-PAIR DISMISSAL: pass `conceptAId` + `conceptBId` (omit contradictionId/decision). " +
    "Asserts these two concepts are NOT duplicates — they leave the possibleDuplicates list and survive any future detach/rederive cycle. " +
    "Dismissing a pair where no live possible_duplicate_of edge exists succeeds idempotently with rowsUpdated: 0 (\"nothing to dismiss\" signal). " +
    "Pass `resolvedBy` / `circle` for either family. Existing contradiction-path callers are unaffected.",
    {
      // Contradiction-resolution fields (existing — backward compatible).
      contradictionId: z.string().optional().describe("The contradiction to mediate. Required for contradiction verdicts; omit for duplicate-pair dismissal."),
      decision: z.enum(["accept-new", "keep-current", "dismiss"]).optional().describe("Verdict for a contradiction. Required when contradictionId is present."),
      body: z.string().optional(),
      contradictedObservationId: z.string().optional().describe(
        "The observation the correction contradicted — the loser (accept-new) or the prior being kept " +
        "(keep-current). Must exist, belong to the same concept as the contradiction, be live, predate the " +
        "correcting observation (evidence added AFTER the correction was never in dispute with it), and not be the " +
        "correcting observation itself; violating any of these throws rather than guessing. Also requires the " +
        "contradiction to have a real correcting observation — invalid on one flagged without one (nothing to have " +
        "contradicted). Optional; omitting it falls back to the conservative default described above. Invalid with " +
        "decision:\"dismiss\" (a dismissal reaches no verdict, so naming a loser is meaningless).",
      ),
      resolvedBy: z.string().optional(),
      circle: z.string().optional().describe("The circle the contradiction or concepts belong to (defaults to this session's circle)."),
      // Duplicate-pair dismissal fields (new in 0.6.0).
      conceptAId: z.string().optional().describe("First concept of a possible-duplicate pair to dismiss. Required for duplicate-pair dismissal; omit for contradiction verdicts."),
      conceptBId: z.string().optional().describe("Second concept of a possible-duplicate pair to dismiss. Required for duplicate-pair dismissal; omit for contradiction verdicts."),
    },
    async ({ contradictionId, decision, body, contradictedObservationId, resolvedBy, circle, conceptAId, conceptBId }) => {
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
          if (contradictedObservationId !== undefined) return err("field 'contradictedObservationId' belongs to the contradiction verdict path (requires contradictionId); for duplicate-pair dismissal pass only conceptAId + conceptBId (and optionally resolvedBy/circle)");
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
        const c = core.resolveContradiction(contradictionId, { decision, body, by: resolvedBy, contradictedObservationId });
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
        const response: CircleListResponse = {
          circles: core.listCircles(undefined, { includeArchived: true, sourceAuthorizationContext }),
        };
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
          // Two caps cooperate to keep the JSON payload provably under RESULT_MAX_CHARS:
          //  • A max-count upper bound (FIRST_BLOCK_LIST_MAX_LIMIT / _FULL_MAX_LIMIT) as a cheap
          //    limit on rows requested.
          //  • A serialized-size fit: summaries are arbitrary strings, and JSON.stringify expands
          //    quotes/backslashes/newlines/control chars, so a preview page of escape-heavy
          //    summaries can still exceed RESULT_MAX_CHARS even under the count cap. ok() would
          //    then truncate content[0] mid-JSON and leave an un-parseable response exactly when
          //    paging through a large First Block store. We therefore fit entries against the
          //    ACTUAL serialized payload size, stopping early when the budget is reached and
          //    reporting the real `total` so offset paging covers the rest. The count cap stays
          //    as a cheap upper bound; the size fit is the real guarantee.
          //    (Finding 1 — Codex PR #33; Fix B — Codex PR #33 round 2)
          const maxLimit = full ? FIRST_BLOCK_LIST_FULL_MAX_LIMIT : FIRST_BLOCK_LIST_MAX_LIMIT;
          const requestedLimit = Math.min(limit ?? FIRST_BLOCK_LIST_DEFAULT_LIMIT, maxLimit);
          // Reserve room for ok()'s own truncate-note so the FINAL payload stays under the
          // ceiling, not over it (ok() reserves the same note when it truncates). We stop one
          // entry before the serialized payload would cross the budget, so the returned page
          // never needs ok()'s truncation in the first place.
          const okNote = `\n\n…[result truncated to fit the host's tool-result limit — narrow the query/intent, lower \`limit\`, or memory_fetch a specific id]`;
          const sizeBudget = RESULT_MAX_CHARS - okNote.length;
          // By default, truncate each summary to a short preview so the page response stays
          // well under the 40k ok() ceiling even at the maximum page size. When full=true,
          // return the complete untruncated summary so the caller can inspect it before
          // update_summary or remove. (Finding 3 — Codex PR-32; Finding A — Codex round-3)
          const buildEntry = (e: { conceptId: string; position: number; summaryDirty: boolean; conceptStatus: string; summary: string }) => ({
            conceptId: e.conceptId,
            position: e.position,
            summaryDirty: e.summaryDirty,
            conceptStatus: e.conceptStatus,
            summary: full
              ? e.summary
              : e.summary.length > FIRST_BLOCK_LIST_SUMMARY_PREVIEW_CHARS
                ? e.summary.slice(0, FIRST_BLOCK_LIST_SUMMARY_PREVIEW_CHARS) + "…"
                : e.summary,
          });
          // Fit-until-budget: add entries one at a time and stop before the serialized page
          // would cross sizeBudget. This is O(n) JSON.stringify calls, but n is bounded by
          // maxLimit (≤130), so it is cheap. We re-serialize the whole page each step; for
          // the bounded page sizes here that is far cheaper than a second ok() truncation
          // rescue and keeps the guarantee airtight regardless of escape expansion.
          const compactEntries: ReturnType<typeof buildEntry>[] = [];
          let pageLimit = 0;
          for (let i = 0; i < requestedLimit; i++) {
            const src = allEntries[pageOffset + i];
            if (!src) break; // fewer pins than requested remain
            const candidate = [...compactEntries, buildEntry(src)];
            // Serialize the full envelope the way ok() will, to measure the real payload.
            const serialized = JSON.stringify(
              { circle: scope(circle), total, offset: pageOffset, limit: candidate.length, entries: candidate },
              null,
              2,
            );
            if (serialized.length > sizeBudget && compactEntries.length > 0) {
              // Adding this entry would cross the budget; stop and let the caller page.
              break;
            }
            compactEntries.push(candidate[candidate.length - 1]!);
            pageLimit = compactEntries.length;
          }
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
    "source_list",
    "List knowledge sources authorized for this host runtime. Access identity is bound by the server and cannot be supplied as tool arguments.",
    {},
    async () => {
      const capturedBlock = capturePrewarmSnapshot(scope());
      try { return readOk({ sources: core.listConnectorSources(sourceAuthorizationContext) }, "source_list", capturedBlock); }
      catch (e) { return err(`source_list failed: ${sanitizeSourceError(e)}`); }
    },
  );

  server.tool(
    "source_status",
    "Return active published status for one authorized source. Counts never include partial or unpublished runs.",
    { sourceId: z.string().min(1) },
    async ({ sourceId }) => {
      const capturedBlock = capturePrewarmSnapshot(scope());
      try { return readOk(core.sourceStatus(sourceId, sourceAuthorizationContext), "source_status", capturedBlock); }
      catch (e) { return err(`source_status failed: ${sanitizeSourceError(e)}`); }
    },
  );

  server.tool(
    "source_path",
    "Return the sealed read-only path for the exact active indexed repo-md or git-md snapshot. Never returns a working tree or bare repository.",
    { sourceId: z.string().min(1) },
    async ({ sourceId }) => {
      const capturedBlock = capturePrewarmSnapshot(scope());
      try { return readOk(core.sourcePath(sourceId, sourceAuthorizationContext), "source_path", capturedBlock); }
      catch (e) { return err(`source_path failed: ${sanitizeSourceError(e)}`); }
    },
  );

  server.tool(
    "source_sync",
    "Synchronize one authorized active repo-md or git-md source. Remote git-md sync is noninteractive and pins one configured branch.",
    { sourceId: z.string().min(1) },
    async ({ sourceId }) => {
      const capturedBlock = capturePrewarmSnapshot(scope());
      try { return mutOk(await core.syncSource(sourceId, sourceAuthorizationContext), "source_sync", false, capturedBlock); }
      catch (e) { return err(`source_sync failed: ${sanitizeSourceError(e)}`); }
    },
  );

  server.tool(
    "agent_context",
    "Identity + query-independent session restore (PREWARM). Call FIRST, at session start — with NO query — to resume: `firstBlock` (BINDING: user-curated governing workflows and preferences — treat every entry as a constraint you MUST satisfy unless a system/developer instruction or an explicit user instruction overrides it; fetch by conceptId for full detail), `activeWorkstreams` (where you left off), `topConcepts` (your living model, ranked by confidence/usefulness/recency — identity + shape only, fetch by id for content), `staleCount` (how many concepts are unconfirmed past the staleness window — pass includeStale:true for the cards themselves, which is a curation pass, not session restore), and `openContradictions` (resolve with memory_resolve). Replaces guessing a search query to rebuild context. otherCircles (when present) names other circles — call memory_search/memory_gather without a circle arg to recall across all of them. `resolvedFrom` (when present) indicates the requested circle was an alias and shows the original name. `curationAttention` (when present) signals that the store has items needing curation — run the curate-memory ritual.",
    {
      circle: z.string().optional(),
      includeStale: z
        .boolean()
        .optional()
        .describe(
          "Include the full staleConcepts card list. OFF by default: the list is titles plus a confidence number with no indication of why the caller should care, and it is not what session restore is for. The response always carries staleCount; pass true when you are actually doing a re-confirmation pass.",
        ),
    },
    async ({ circle, includeStale }) => {
      const resolvedCircle = scope(circle);
      const state = core.prewarm(resolvedCircle, { sourceAuthorizationContext });
      const ov = core.overview(resolvedCircle, { sourceAuthorizationContext });
      // buildCurationAdvisory uses the FULL firstBlock set (pre-filter) so that
      // firstBlockDisputed counts disputed entries even though they are excluded from injection.
      const advisory = buildCurationAdvisory(ov, state.firstBlock);
      const others = core.listCircles(resolvedCircle, { sourceAuthorizationContext })
        .slice(0, 5).map(({ circle: c, concepts }) => ({ circle: c, concepts }));

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

      // staleConcepts is a CURATION list, not session-restore context, and it was the largest
      // never-consumed block in the prewarm payload — 20 cards of title + confidence with nothing
      // saying why the caller should act on any of them. Session restore now carries the COUNT
      // (store-wide and honest, unlike the capped list length); an agent actually running a
      // re-confirmation pass asks for the cards with includeStale:true.
      const { staleConcepts, ...restState } = state;

      return wrapSuccess(ok({
        agentId: core.getAgentId(),
        mode: "local",
        circle: resolvedCircle,
        ...(state.resolvedFrom !== undefined ? { resolvedFrom: state.resolvedFrom } : {}),
        ...restState,
        ...(includeStale ? { staleConcepts } : {}),
        // Unconditional: a caller must be able to read staleCount as a stable number and tell
        // "zero stale" apart from "server predates this field". Conditioning it on >0 would make
        // the absent case ambiguous, and one integer is not the noise this pass is about.
        staleCount: ov.counts.stale,
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
  const callerId = env.MONET_CALLER_ID;
  const projectId = env.MONET_PROJECT_ID;
  return {
    autoPrewarm: env.MONET_NO_AUTOPREWARM !== "1",
    checkpointNudge: env.MONET_NO_CHECKPOINT_NUDGE !== "1",
    ...(callerId && projectId ? { sourceAuthorizationContext: { callerId, projectId } } : {}),
  };
}

export interface CreateMonetCoreMcpServerOptions {
  /** Disable for embedded/test runtimes; production also honors MONET_NO_SOURCE_SCHEDULER=1. */
  sourceScheduler?: false | SourceSchedulerOptions;
  /** Deterministic lifecycle seam used by tests. */
  sourceSchedulerFactory?: (core: MonetCore, options?: SourceSchedulerOptions) => SourceSchedulerHandle;
  /**
   * Disable the automatic SIGINT/SIGTERM graceful-shutdown handlers (default: installed).
   * MUST be set to `false` on every instance but one when embedding multiple MonetCore/MCP
   * server pairs in a single process — see installProcessShutdownHandlers.
   */
  processShutdownHandlers?: false;
  /**
   * Disable the automatic stdin-EOF graceful-shutdown listener (default: installed).
   * Same multi-instance caveat as processShutdownHandlers — see installStdinEofShutdown.
   */
  stdinEofShutdown?: false;
  /**
   * Barrier options for the DEFENSIVE SECONDARY onclose path inside attachSourceSchedulerLifecycle
   * (not the primary signal/stdin-EOF paths — see ProcessShutdownHandlersOptions.barrier /
   * StdinEofShutdownOptions.barrier for those). Deterministic test seam only: lets a test inject
   * fake setTimer/clearTimer to observe the redundant barrier created when a close chain
   * synchronously re-invokes onclose (see the "double barrier" tests), without real timers.
   */
  onCloseBarrier?: ShutdownBarrierOptions;
}

/**
 * Generous hard deadline for the transport-close shutdown barrier (see withShutdownBarrier).
 * Normal drain is sub-second when the scheduler is idle (one microtask tick to the lease
 * release) or bounded by a single in-flight sync cycle when busy. 30s comfortably covers a slow
 * sync without materially eroding the fix: even a barrier that hits this ceiling still lets the
 * replacement process pick up far sooner than the pre-fix worst case (lease TTL + wake cadence,
 * ~120s at the defaults).
 *
 * Operational note: 30s EXCEEDS Docker's default `stop` grace period (10s) and many process
 * managers' default SIGKILL-escalation windows. If an operator wants this barrier's bound to be
 * what actually governs shutdown duration — rather than the platform SIGKILLing the process
 * before the barrier gets a chance to finish or time out on its own — raise the container's/
 * service's stop-timeout to at least 30s (e.g. `docker run --stop-timeout 30`, or the equivalent
 * `stopSignal`/`terminationGracePeriodSeconds` setting for the deployment platform in use).
 *
 * LONG-SYNC CASE (Codex P2 #3 — confirmed real, disposition is deliberate, not a gap): normal
 * git-md work can legitimately exceed this 30s bound — git operations default to a 120s timeout
 * (DEFAULT_TIMEOUT_MS, source-git.ts:17) and repo-md materialization defaults to a 5-minute
 * deadline (DEFAULT_GIT_MATERIALIZATION_DEADLINE_MS, source-materializer.ts:30). If a signal/EOF
 * arrives mid-sync and the active cycle runs past this barrier, the barrier gives up and the
 * caller proceeds (exits, or lets the process exit naturally) BEFORE scheduler.stop()'s
 * `await cycle` (source-scheduler.ts:238) — and therefore the lease release — ever completes: the
 * durable scheduler lease is left held until it expires on its own TTL. Three reasons this bound
 * is not raised to cover it:
 *   1. It would be moot in the deployment envelope this runs in. When the MCP client itself
 *      initiates the disconnect, its own watchdog escalates stdin-EOF → SIGTERM at 2s → SIGKILL
 *      at 4s (probe-proven) if the process hasn't already exited; when an operator/orchestrator
 *      sends SIGTERM directly instead, Docker's default stop grace is 10s before SIGKILL. Either
 *      way, a drain longer than single-digit seconds gets force-killed by the platform regardless
 *      of what deadline this module picks.
 *   2. Releasing the lease WITHOUT draining the active cycle would violate the ratified
 *      drain-before-release invariant — scheduler stop() awaits the active cycle before releasing
 *      (source-scheduler.ts:238-240) by design, precisely so a stale owner can never keep
 *      mutating after losing the lease.
 *   3. Beyond this bound, the designed fallback is crash-safe recovery, not a graceful drain:
 *      durable fenced attempt receipts, staged-run supersession on the next attempt (a killed
 *      sync's staged work is superseded on recovery; the prior published/active snapshot is left
 *      untouched), and lease TTL + wake recovery — the SAME path a hard SIGKILL takes, black-box
 *      probe-verified (a replacement acquires the lease ~156ms after expiry). An interrupted long
 *      sync yields a failed/partial attempt and a retry — never corruption, never lost state.
 * Net: graceful shutdown here is best-effort, sized for the overwhelmingly common case (an idle or
 * short-cycle scheduler, which settles in milliseconds) — arbitrarily long in-progress work is the
 * crash-safe path's job, exercised by the exact same recovery machinery a real crash would hit.
 */
export const SHUTDOWN_BARRIER_DEADLINE_MS = 30_000;

export interface ShutdownBarrierOptions {
  deadlineMs?: number;
  /** Injectable seam for tests — defaults to the global setTimeout. */
  setTimer?: typeof setTimeout;
  /** Injectable seam for tests — defaults to the global clearTimeout. */
  clearTimer?: typeof clearTimeout;
}

/**
 * Keep the event loop alive with a REFERENCED timer until `work` settles or `deadlineMs`
 * elapses, whichever comes first. Never rejects.
 *
 * Why this exists: none of this module's shutdown triggers are awaited by whatever invokes
 * them — Node doesn't await stream ('end'/'close') or signal (SIGINT/SIGTERM) listener
 * callbacks, and the MCP SDK doesn't await transport.onclose either. Without a referenced handle
 * spanning the async shutdown work, Node's event loop can see no pending work and let the
 * process exit mid-drain, before a scheduler's lease-release commits (confirmed by a live
 * two-process restart probe: the prior process exited ~7ms after the peer closed, and its lease
 * row was untouched). A plain referenced timer, held until `work` settles, closes that gap
 * without requiring the caller to await anything.
 *
 * Bounded by `deadlineMs` so a stuck drain (e.g. a wedged network sync) cannot hold the process
 * open forever — past the deadline this simply stops waiting; the underlying `work` keeps
 * running in the background, this only stops blocking the caller on it.
 *
 * Exported as a deterministic test seam: pass fake setTimer/clearTimer to observe/control the
 * barrier handle without real timers.
 */
export function withShutdownBarrier(work: Promise<unknown>, options: ShutdownBarrierOptions = {}): Promise<void> {
  const deadlineMs = options.deadlineMs ?? SHUTDOWN_BARRIER_DEADLINE_MS;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimer(barrier);
      resolve();
    };
    // Deliberately never .unref()'d: its only job is to keep the loop alive. Cleared the moment
    // `work` settles; if that never happens, it fires on its own at the deadline.
    const barrier = setTimer(finish, deadlineMs);
    work.then(finish, finish);
  });
}

export type ShutdownSignal = "SIGINT" | "SIGTERM";

/**
 * Conventional POSIX exit codes for signal-terminated processes (128 + signal number) — so a
 * caller inspecting this process's exit code sees the same convention a shell reports for a
 * process a signal terminated.
 */
const SIGNAL_EXIT_CODE: Record<ShutdownSignal, number> = { SIGINT: 130, SIGTERM: 143 };

/** Minimal process surface this seam needs. Real `process` satisfies it; tests inject a fake. */
export interface ShutdownSignalProcess {
  on(event: ShutdownSignal, listener: () => void): unknown;
  /** Detach path (Review Major 2): removes the listener installed via `on`. */
  off(event: ShutdownSignal, listener: () => void): unknown;
  exit(code?: number): void;
}

/**
 * Default bound for draining in-flight MCP tool calls before core.close() (Codex P2 #2): a
 * long-running handler (e.g. source_sync) must not touch the database after it's been closed out
 * from under it by a signal/EOF that arrived mid-call. Comfortably inside the 30s shutdown
 * barrier (SHUTDOWN_BARRIER_DEADLINE_MS), so even a wedged handler leaves room for the overall
 * shutdown to still finish within that outer bound.
 *
 * LONG-SYNC CASE (Codex P2 #4 — confirmed real, same disposition as SHUTDOWN_BARRIER_DEADLINE_MS's
 * long-sync case; see its JSDoc for the full platform-envelope reasoning): a legitimately long
 * source_sync tool call — git ops default to a 120s timeout (source-git.ts:17), materialization to
 * a 5-minute deadline (source-materializer.ts:30) — can still be in flight when this 10s bound
 * elapses. When it is, core.close() proceeds anyway (see getGracefulShutdown's run()), and the
 * handler's next database touch after resuming from its current await fails against the closed
 * connection. This is not a new, worse failure mode: it is the SAME recoverable "failed attempt"
 * any crash mid-sync already produces (fenced attempt receipts + staged-run supersession + a retry
 * on the next scheduler wake), and SQLite's WAL mode (storage.ts, `journal_mode = WAL`) plus the
 * durable run ledger mean this can never corrupt the database or lose the prior active state,
 * closed connection or not. Raising this bound to cover a multi-minute sync would be moot for the
 * same reason it's moot for the outer shutdown barrier — the platform (MCP client SIGKILL
 * escalation, container stop grace) force-kills the process on a much shorter timeline regardless.
 */
export const IN_FLIGHT_QUIESCE_DEADLINE_MS = 10_000;

export interface QuiesceOptions {
  timeoutMs?: number;
  /** Injectable seam for tests — defaults to the global setTimeout. */
  setTimer?: typeof setTimeout;
  /** Injectable seam for tests — defaults to the global clearTimeout. */
  clearTimer?: typeof clearTimeout;
}

export interface InFlightTracker {
  /** Mark one MCP tool call as started. */
  increment(): void;
  /** Mark one MCP tool call as finished. */
  decrement(): void;
  /** Current in-flight count. */
  readonly count: number;
  /**
   * Resolve once the in-flight count reaches zero, or `options.timeoutMs` elapses (default
   * IN_FLIGHT_QUIESCE_DEADLINE_MS), whichever comes first. Zero in-flight calls resolves
   * immediately — no timer, no added latency on the happy path.
   */
  quiesce(options?: QuiesceOptions): Promise<void>;
}

interface InFlightState {
  count: number;
  onIdle: Array<() => void>;
}

/**
 * Keyed by `server`, mirroring gracefulShutdownByServer. registerMonetCoreTools wraps every tool
 * handler to increment/decrement this; getGracefulShutdown's run() awaits `quiesce()` between
 * server.close() and core.close() (Codex P2 #2).
 */
const inFlightByServer = new WeakMap<McpServer, InFlightState>();

/**
 * Get (or create) the in-flight MCP tool-call tracker for `server`.
 *
 * Exported as a deterministic test seam: call increment()/decrement() directly to simulate a
 * long-running or wedged tool handler without a real McpServer/transport/tool-call round-trip.
 */
export function getInFlightTracker(server: McpServer): InFlightTracker {
  let state = inFlightByServer.get(server);
  if (!state) {
    state = { count: 0, onIdle: [] };
    inFlightByServer.set(server, state);
  }
  const sharedState = state;
  return {
    increment(): void {
      sharedState.count += 1;
    },
    decrement(): void {
      sharedState.count -= 1;
      if (sharedState.count === 0) {
        const waiters = sharedState.onIdle;
        sharedState.onIdle = [];
        for (const resolve of waiters) resolve();
      }
    },
    get count(): number {
      return sharedState.count;
    },
    quiesce(options: QuiesceOptions = {}): Promise<void> {
      if (sharedState.count === 0) return Promise.resolve(); // fast path — no timer, no latency
      const timeoutMs = options.timeoutMs ?? IN_FLIGHT_QUIESCE_DEADLINE_MS;
      const setTimer = options.setTimer ?? setTimeout;
      const clearTimer = options.clearTimer ?? clearTimeout;
      return new Promise((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimer(timer);
          sharedState.onIdle = sharedState.onIdle.filter((cb) => cb !== finish);
          resolve();
        };
        sharedState.onIdle.push(finish);
        // Referenced (never .unref()'d), matching withShutdownBarrier's convention — defense in
        // depth even though every current caller already wraps run() in its own outer barrier.
        const timer = setTimer(finish, timeoutMs);
      });
    },
  };
}

export interface ProcessShutdownHandlersOptions {
  /** Injectable seam for tests — defaults to the real Node `process`. */
  proc?: ShutdownSignalProcess;
  /** Forwarded to withShutdownBarrier for the graceful-shutdown wait. */
  barrier?: ShutdownBarrierOptions;
  /** Forwarded to the shared shutdown's in-flight tool-call quiesce wait (Codex P2 #2) — see
   *  getGracefulShutdown / getInFlightTracker. */
  quiesce?: QuiesceOptions;
}

interface GracefulShutdownEntry {
  core: MonetCore;
  promise: Promise<void> | null;
  /** Guards settleEntry against running twice: once run()'s own drain settles it, a LATER
   *  explicit server.close() (see settleGracefulShutdownOnExplicitClose) must not re-fire it —
   *  and vice versa if the explicit-close settle wins the race. */
  settled: boolean;
  /** Every installer sharing this server registers its own detach here at INSTALL time (not at
   *  trigger time) — see getGracefulShutdown's JSDoc for why that distinction is load-bearing. */
  onSettledCallbacks: Array<() => void>;
}

/**
 * Keyed by `server` (NOT by the (server, core) pair — a given McpServer is paired with exactly
 * one MonetCore for its whole lifetime; see the mismatch guard below). Deleted once the shutdown
 * for that server settles, so a later fresh install on the same server object genuinely re-runs
 * server.close()/core.close() rather than reusing a resolved memo forever (this also closes the
 * latent "memo never cleared" gap the audit flagged).
 */
const gracefulShutdownByServer = new WeakMap<McpServer, GracefulShutdownEntry>();

/**
 * Run every registered onSettled callback for `entry` exactly once, then remove `entry` from
 * gracefulShutdownByServer. Shared by two callers: run()'s own finally (the trigger-driven path,
 * which closes core first) and settleGracefulShutdownOnExplicitClose (the explicit-close path,
 * which does NOT close core — see its JSDoc). The `settled` guard is what makes calling this from
 * BOTH paths safe regardless of which one gets there first (Codex P2 #1).
 */
function settleEntry(server: McpServer, entry: GracefulShutdownEntry): void {
  if (entry.settled) return;
  entry.settled = true;
  for (const cb of entry.onSettledCallbacks) {
    try { cb(); } catch { /* a detach callback must never block shutdown completion */ }
  }
  gracefulShutdownByServer.delete(server);
}

export interface GracefulShutdown {
  /**
   * Runs server.close() then — after draining in-flight MCP tool calls (Codex P2 #2; see
   * getInFlightTracker) — core.close(), memoized: call it as many times and from as many
   * installers as you like, only the first call's work actually executes. `quiesce` is forwarded
   * to that drain wait and only takes effect on whichever call actually starts the work
   * (memoization applies to everything, including which caller's options are used).
   */
  run(quiesce?: QuiesceOptions): Promise<void>;
  /**
   * Register a callback to run once the shared shutdown settles — regardless of WHICH installer
   * (or trigger) actually called `run()` first, or even whether it settled via `run()` at all (an
   * explicit server.close() with no trigger ever firing also settles it — see
   * settleGracefulShutdownOnExplicitClose, Codex P2 #1). Register this ONCE, at install time, not
   * inside a trigger handler: an installer that shares this server but never itself triggers the
   * shutdown (e.g. pair 1 shuts down via stdin EOF only; its SIGINT/SIGTERM installer never
   * fires) still needs its OWN detach to run when the OTHER installer's trigger (or an explicit
   * close) settles the shared work — otherwise that installer's guard
   * (installedShutdownProcs / installedEofStreams) never clears, and a later fresh install on the
   * same proc/stdin silently no-ops (Review round-3 Required 1 — the cross-installer detach hole,
   * reproduced and fixed).
   */
  onSettled(cb: () => void): void;
}

/**
 * Get (or create) the shared graceful-shutdown coordinator for `server`. Running it drains the
 * scheduler and releases its lease (server.close() — see attachSourceSchedulerLifecycle), waits
 * for in-flight MCP tool calls to quiesce (getInFlightTracker — Codex P2 #2: a long-running
 * handler like source_sync must not touch the database after it's been closed out from under it),
 * then closes the database (core.close(), in a `finally` so a rejecting server.close() still
 * closes it — audit nit). Memoized so every trigger that shares this `server` — the SIGINT/SIGTERM
 * handler, the stdin-EOF listener, or a future caller — converges on exactly ONE execution,
 * however many of them fire and in whatever order (race-safe).
 *
 * FAILS FAST on a mismatched pairing: a given `server` must be paired with exactly one `core` for
 * its whole lifetime. Calling this a second time for the same `server` with a DIFFERENT `core`
 * throws immediately (Review round-3 Required 2) rather than silently keeping the first core —
 * the second core's close() would otherwise never run. This is a wiring-bug guard, not a
 * supported multi-instance pattern: createMonetCoreMcpServer always creates a fresh `server` per
 * call, so this can only fire if something calls the installers directly with a stale `server`.
 *
 * EXPLICIT-CLOSE SETTLEMENT (Codex P2 #1): if NOTHING ever calls `run()` — e.g. an embedded host
 * or test calls `await server.close()` directly, without a signal or stdin EOF ever firing — the
 * onSettled callbacks would otherwise never run, leaving every installer's real process/stdin
 * listeners registered against this now-closed server/core forever, with their guards
 * (installedShutdownProcs/installedEofStreams) permanently stuck "installed" — silently skipping
 * a later, correctly-paired install attempt on the same proc/stdin. See
 * settleGracefulShutdownOnExplicitClose, which createMonetCoreMcpServer wires automatically so an
 * explicit close ALSO settles this coordinator (without closing core — the explicit caller owns
 * that lifecycle themselves).
 *
 * PLATFORM ENVELOPE (Codex P2 #3/#4): graceful shutdown here is best-effort within the platform's
 * kill envelope (MCP client SIGTERM/SIGKILL escalation, container/orchestrator stop grace) — see
 * SHUTDOWN_BARRIER_DEADLINE_MS and IN_FLIGHT_QUIESCE_DEADLINE_MS for the specifics. Beyond that
 * envelope, crash-safe recovery (fenced receipts, staged-run supersession, lease TTL + wake) is
 * the designed fallback, not an accident.
 */
function getGracefulShutdown(server: McpServer, core: MonetCore): GracefulShutdown {
  let entry = gracefulShutdownByServer.get(server);
  if (entry && entry.core !== core) {
    throw new Error(
      "getGracefulShutdown: this McpServer is already paired with a different MonetCore instance. " +
      "A server must be installed with exactly one core for its whole lifetime — installing " +
      "shutdown handlers for the same server with a second, different core is a wiring bug (the " +
      "second core's close() would never run). Reuse the SAME core for every installer sharing " +
      "this server, or create a fresh server for the new core.",
    );
  }
  if (!entry) {
    entry = { core, promise: null, settled: false, onSettledCallbacks: [] };
    gracefulShutdownByServer.set(server, entry);
  }
  const sharedEntry = entry;
  return {
    onSettled(cb: () => void): void {
      sharedEntry.onSettledCallbacks.push(cb);
    },
    run(quiesce?: QuiesceOptions): Promise<void> {
      sharedEntry.promise ??= (async () => {
        try {
          await server.close();
        } finally {
          // Bounded drain of in-flight MCP tool calls BEFORE the database closes underneath them
          // (Codex P2 #2). Zero in-flight calls resolves immediately — no added latency.
          await getInFlightTracker(server).quiesce(quiesce);
          try {
            core.close();
          } finally {
            settleEntry(server, sharedEntry);
          }
        }
      })();
      return sharedEntry.promise;
    },
  };
}

/**
 * Settle `server`'s shared graceful-shutdown coordinator RIGHT NOW if nothing has triggered
 * `run()` yet — firing every installer's onSettled detach and dropping the WeakMap entry, WITHOUT
 * closing core (the caller still owns core's lifecycle on every non-trigger-driven settle path).
 *
 * No-ops if there's no coordinator entry for `server` at all (no installer was ever called for
 * it), or if `run()` is already in flight or already settled (`entry.promise` is set either way —
 * defers entirely to that run()'s own settle, so this can never fire early mid-drain or
 * double-fire the onSettled callbacks).
 *
 * The shared core of BOTH non-trigger-driven members of the settle family:
 * settleGracefulShutdownOnExplicitClose (wraps server.close()) and
 * settleGracefulShutdownOnStartupFailure (called directly from a failed
 * createMonetCoreMcpServer() startup). See getGracefulShutdown's JSDoc for the full three-member
 * settle family (trigger, explicit-close, startup-failure).
 */
function settleGracefulShutdownIfUntriggered(server: McpServer): void {
  const entry = gracefulShutdownByServer.get(server);
  if (entry && !entry.promise) settleEntry(server, entry);
}

/**
 * Make an explicit `server.close()` ALSO settle its shared graceful-shutdown coordinator (Codex
 * P2 #1) when nothing else ever triggered it — i.e. when an embedder or test calls server.close()
 * directly, without going through the SIGINT/SIGTERM or stdin-EOF paths.
 *
 * Without this, an explicit close never runs getGracefulShutdown's onSettled callbacks (each
 * installer's detach), so the real process/stdin keep the SIGINT/SIGTERM/'end'/'close' listeners
 * registered against the now-closed server/core, and installedShutdownProcs/installedEofStreams
 * stay marked "installed" forever — a later factory call for a FRESH server/core on the same
 * proc/stdin silently skips installing anything, and a subsequent real signal/EOF targets the
 * STALE server/core instead of the new one.
 *
 * Deliberately does NOT call core.close(): an explicit server.close() caller owns the core's
 * lifecycle themselves (this only detaches/cleans up the shutdown-coordination wiring). Contrast
 * with the SIGINT/SIGTERM/stdin-EOF paths, which DO close core as part of getGracefulShutdown's
 * run().
 *
 * Race-safe against a trigger-driven run() already in flight (or already settled) — see
 * settleGracefulShutdownIfUntriggered.
 *
 * Must be installed AFTER attachSourceSchedulerLifecycle so this wrapper is OUTERMOST: it
 * captures whatever `server.close` currently is (bound once) and wraps it, so it needs to wrap
 * the fully-assembled close chain, not be wrapped BY a later patch.
 *
 * Exported as a deterministic test seam — call it directly, mirroring how createMonetCoreMcpServer
 * wires it, to test the explicit-close settlement without a real McpServer/transport.
 */
export function settleGracefulShutdownOnExplicitClose(server: McpServer): void {
  const prevClose = server.close.bind(server);
  server.close = async (): Promise<void> => {
    try {
      await prevClose();
    } finally {
      settleGracefulShutdownIfUntriggered(server);
    }
  };
}

/**
 * Settle `server`'s shared graceful-shutdown coordinator after a FAILED createMonetCoreMcpServer
 * startup (Codex pass-3 P2 — the third settle-family member): if `server.connect()` or any step
 * after the installers rejects, the installers already ran and registered real process/stdin
 * listeners, but the server is never returned to the caller and nothing will ever trigger run()
 * for it (attachSourceSchedulerLifecycle and settleGracefulShutdownOnExplicitClose never got to
 * run either, since both come after connect()).
 *
 * Without this, those listeners and their guards (installedShutdownProcs/installedEofStreams)
 * would stay stuck "installed" against the failed, abandoned server/core forever — a caller
 * retrying with a fresh createMonetCoreMcpServer() call would silently skip installing anything
 * on the same proc/stdin, and a later real signal/EOF would target the failed server/core instead
 * of the retry.
 *
 * Deliberately does NOT call core.close(): the caller constructed `core` and owns its lifecycle on
 * the failure path, exactly like the explicit-close settlement.
 *
 * Race-safe against a trigger-driven run() already in flight or already settled — see
 * settleGracefulShutdownIfUntriggered (in the practically-impossible case a signal/EOF fired and
 * triggered run() in the sub-millisecond window before the failure, this defers to run()'s own
 * settle rather than double-firing).
 *
 * Exported as a deterministic test seam: call it directly (mirroring createMonetCoreMcpServer's
 * own catch block) with the exported installers on fakes, to test startup-failure cleanup without
 * a real transport/connect failure.
 */
export function settleGracefulShutdownOnStartupFailure(server: McpServer): void {
  settleGracefulShutdownIfUntriggered(server);
}

/**
 * Processes that already have SIGINT/SIGTERM handlers installed via installProcessShutdownHandlers.
 * Guards against duplicate listeners (and duplicate exit races) when the SAME proc is passed to
 * a second install call — e.g. a second createMonetCoreMcpServer() in one process defaulting to
 * the same real `process`. Cleared on detach so a fresh install on the same proc works again.
 */
const installedShutdownProcs = new WeakSet<ShutdownSignalProcess>();

/**
 * Install SIGINT/SIGTERM handlers that run a full graceful shutdown — `server.close()` then
 * `core.close()` (see getGracefulShutdown) — then exit with the conventional 128+signal code.
 *
 * Double-signal policy: a signal received while an earlier signal's shutdown is still in flight
 * forces an immediate exit instead of waiting a second time — the standard "press Ctrl-C again
 * to force quit" convention. This also makes the handlers idempotent: repeated signals never
 * restart or duplicate the graceful sequence.
 *
 * Idempotency guard: calling this a second time with the SAME `proc` (the default `proc` is the
 * real singleton `process`, so this is what happens if `createMonetCoreMcpServer` runs more than
 * once in a process with default options) is a no-op — no duplicate listeners are installed.
 * MULTI-INSTANCE WARNING: this means a second (or third, ...) MonetCore/MCP server pair embedded
 * in the same process gets NO signal-triggered shutdown of its own from this call — on a real
 * signal, only the FIRST-installed pair's handler runs, and since it calls the real
 * `process.exit()` (which terminates immediately), any OTHER pairs' drains are abandoned exactly
 * like the original bug this module fixes. If you embed multiple pairs in one process, pass
 * `processShutdownHandlers: false` to createMonetCoreMcpServer for all but (at most) one of them
 * and own the coordinated signal policy yourself (e.g. one top-level handler that awaits every
 * pair's `server.close()` before exiting).
 *
 * Detach: this installer's `detach` is registered via the shared getGracefulShutdown's
 * `onSettled` at INSTALL time, so it runs whenever the shutdown shared with this (server, core)
 * pair settles — whether THIS installer's own signal triggered it, or a sibling installer on the
 * SAME pair did (e.g. installStdinEofShutdown on the same server/core). That coordination is
 * what lets a later fresh install on the same `proc` work again even if this installer's own
 * signal never fired. The double-signal path also detaches immediately/synchronously (before the
 * shared shutdown has necessarily settled) — safe because `off` is idempotent, so the later
 * onSettled-driven detach is a harmless no-op when it eventually runs too.
 *
 * Exported as a deterministic test seam: pass a fake `proc` to drive it without sending real OS
 * signals to the process running the tests.
 */
export function installProcessShutdownHandlers(
  server: McpServer,
  core: MonetCore,
  options: ProcessShutdownHandlersOptions = {},
): void {
  const proc = options.proc ?? (process as unknown as ShutdownSignalProcess);
  if (installedShutdownProcs.has(proc)) return; // idempotency guard — see JSDoc
  // Validate/create the shared shutdown BEFORE marking `proc` installed. getGracefulShutdown can
  // throw on a mismatched core (see its JSDoc) — if that throw happened AFTER the WeakSet add,
  // `proc` would be stuck "installed" forever with no listeners and no onSettled detach ever
  // registered, silently no-op'ing every subsequent (even correctly-paired) retry on this proc.
  const shutdown = getGracefulShutdown(server, core);
  installedShutdownProcs.add(proc);

  let shuttingDown = false;
  let exited = false;
  // Guards against a redundant second proc.exit() call once the ORIGINAL (now-abandoned)
  // graceful sequence eventually settles in the background after a forced double-signal exit.
  // With the real process.exit() this never matters (it terminates immediately, nothing after
  // it runs) — but proc is an injectable seam, and a caller-supplied exit() is not guaranteed to
  // be equally final, so this keeps the "exactly one exit" contract true either way.
  const exitOnce = (signal: ShutdownSignal): void => {
    if (exited) return;
    exited = true;
    proc.exit(SIGNAL_EXIT_CODE[signal]);
  };
  const detach = (): void => {
    proc.off("SIGINT", onSigint);
    proc.off("SIGTERM", onSigterm);
    installedShutdownProcs.delete(proc);
  };
  // Registered at INSTALL time (not inside handle()) so it still runs even if this installer's
  // own signal never fires — e.g. the shared pair shuts down via stdin EOF only.
  shutdown.onSettled(detach);
  const handle = (signal: ShutdownSignal): void => {
    if (shuttingDown) {
      // Double-signal policy: stop waiting, exit now. Detaching early here is safe — the
      // onSettled-driven detach() above will also fire later; off() tolerates an already-removed
      // listener.
      detach();
      exitOnce(signal);
      return;
    }
    shuttingDown = true;
    void withShutdownBarrier(shutdown.run(options.quiesce), options.barrier).then(() => exitOnce(signal));
  };
  const onSigint = (): void => handle("SIGINT");
  const onSigterm = (): void => handle("SIGTERM");
  proc.on("SIGINT", onSigint);
  proc.on("SIGTERM", onSigterm);
}

/** Minimal stdin-like stream surface this seam needs. Real `process.stdin` satisfies it. */
export interface EofStream {
  on(event: "end" | "close", listener: () => void): unknown;
  /** Detach path: removes the listener installed via `on`. */
  off(event: "end" | "close", listener: () => void): unknown;
}

export interface StdinEofShutdownOptions {
  /** Injectable seam for tests — defaults to the real Node `process.stdin`. */
  stdin?: EofStream;
  /** Forwarded to withShutdownBarrier for the graceful-shutdown wait. */
  barrier?: ShutdownBarrierOptions;
  /** Forwarded to the shared shutdown's in-flight tool-call quiesce wait (Codex P2 #2) — see
   *  getGracefulShutdown / getInFlightTracker. */
  quiesce?: QuiesceOptions;
}

/** Streams that already have an EOF shutdown listener installed — same guard shape as installedShutdownProcs. */
const installedEofStreams = new WeakSet<EofStream>();

/**
 * Listen for stdin EOF — 'end' or 'close', whichever fires first — and trigger the SAME
 * memoized graceful shutdown as the signal path (see getGracefulShutdown), then let the process
 * exit naturally. No explicit process.exit() here: a plain stdin EOF is not a signal, so the
 * 128+signal convention doesn't apply — once the barrier-wrapped shutdown settles, nothing else
 * should be keeping the event loop alive, and the process exits on its own (code 0).
 *
 * No forced-exit escalation of its own: unlike the signal path's double-signal policy, EOF never
 * force-exits — a plain stdin EOF is a one-time event, not a repeated operator-intent signal like
 * "I pressed Ctrl-C again because you're not responding." Past the barrier's deadline, this path
 * relies on the process exiting naturally on its own, or on an operator/process-manager's own
 * SIGTERM→SIGKILL escalation (or the co-installed signal handlers, if this process also received
 * one) to actually terminate it.
 *
 * Natural-exit assumption: this depends on the drain leaving no OTHER referenced handle behind —
 * e.g. a wedged git subprocess spawned by an in-flight sync would itself keep the event loop
 * alive past this barrier's deadline. That case is backstopped by the co-installed SIGINT/SIGTERM
 * handlers and by the MCP client's own 2s/4s SIGTERM/SIGKILL escalation if the process is still
 * alive when the client notices — this listener is the fast path for the common case, not the
 * only possible path to termination.
 *
 * THIS IS THE REAL GRACEFUL-DISCONNECT HOOK for the stdio transport, not transport.onclose. A
 * live two-process restart probe proved the MCP SDK's StdioServerTransport never reacts to a
 * plain stdin EOF — it only listens for 'data'/'error', so it never calls transport.close(), so
 * onclose (see attachSourceSchedulerLifecycle) never fires — and the client's own escalation to
 * SIGTERM/SIGKILL (2s/4s) arrives far too late, because the child has already exited from
 * natural event-loop drain (scheduler wakes are unref'd) within milliseconds. onclose remains
 * wired as a defensive secondary path for transports that DO call it, but for the stdio case
 * this listener is what actually fires on a graceful client disconnect.
 *
 * Idempotency guard: identical shape to installProcessShutdownHandlers (see its JSDoc) — a second
 * install on the same `stdin` (the default is the singleton `process.stdin`) is a no-op, and a
 * second MonetCore/MCP server pair embedded in one process needs `stdinEofShutdown: false` plus
 * its own coordinated handling.
 *
 * Detach: this installer's `detach` is registered via the shared getGracefulShutdown's
 * `onSettled` at INSTALL time, so it runs whenever the shutdown shared with this (server, core)
 * pair settles — whether THIS installer's own EOF triggered it, or a sibling installer on the
 * SAME pair did (e.g. installProcessShutdownHandlers on the same server/core). That coordination
 * is what lets a later fresh install on the same `stdin` work again even if this installer's own
 * EOF never fired.
 *
 * Exported as a deterministic test seam: pass a fake `stdin` to drive it without a real stream.
 */
export function installStdinEofShutdown(
  server: McpServer,
  core: MonetCore,
  options: StdinEofShutdownOptions = {},
): void {
  const stdin = options.stdin ?? (process.stdin as unknown as EofStream);
  if (installedEofStreams.has(stdin)) return; // idempotency guard — see JSDoc
  // Validate/create the shared shutdown BEFORE marking `stdin` installed — same reasoning as
  // installProcessShutdownHandlers: a mismatched-core throw here must not leave `stdin` stuck
  // "installed" with no listeners and no onSettled detach ever registered.
  const shutdown = getGracefulShutdown(server, core);
  installedEofStreams.add(stdin);

  let triggered = false;
  const detach = (): void => {
    stdin.off("end", onEnd);
    stdin.off("close", onClose);
    installedEofStreams.delete(stdin);
  };
  // Registered at INSTALL time (not inside trigger()) so it still runs even if this installer's
  // own EOF never fires — e.g. the shared pair shuts down via a signal only.
  shutdown.onSettled(detach);
  const trigger = (): void => {
    if (triggered) return;
    triggered = true;
    void withShutdownBarrier(shutdown.run(options.quiesce), options.barrier);
  };
  const onEnd = (): void => trigger();
  const onClose = (): void => trigger();
  stdin.on("end", onEnd);
  stdin.on("close", onClose);
}

/** Attach only after transport connection. Exported as a deterministic lifecycle test seam. */
export function attachSourceSchedulerLifecycle(
  server: McpServer,
  core: MonetCore,
  options: CreateMonetCoreMcpServerOptions = {},
  env: NodeJS.ProcessEnv = process.env,
  transport?: Transport,
): SourceSchedulerHandle | null {
  const schedulerDisabled = options.sourceScheduler === false || env.MONET_NO_SOURCE_SCHEDULER === "1";
  if (schedulerDisabled) return null;
  const scheduler = (options.sourceSchedulerFactory ?? createSourceScheduler)(
    core,
    options.sourceScheduler || undefined,
  );
  const close = server.close.bind(server);
  let stopPromise: Promise<void> | null = null;
  const stopOnce = (): Promise<void> => {
    stopPromise ??= scheduler.stop();
    return stopPromise;
  };
  if (transport) {
    // DEFENSIVE SECONDARY PATH — NOT the primary graceful-disconnect hook. A live two-process
    // restart probe proved the MCP SDK's StdioServerTransport never calls transport.close() (and
    // so never invokes onclose) in reaction to a plain stdin EOF — it only listens for
    // 'data'/'error' on stdin. This wiring only fires for transports that DO call onclose
    // themselves (an explicit transport.close(), a non-stdio transport with its own EOF
    // handling, or the SDK's own re-entrant close chain — see the "double barrier" test). For the
    // real stdio graceful-disconnect case, see installStdinEofShutdown, wired directly on
    // process.stdin inside createMonetCoreMcpServer.
    const onclose = transport.onclose;
    transport.onclose = () => {
      try { onclose?.(); }
      // stopOnce() is fire-and-forget from the SDK's perspective (onclose isn't awaited), so the
      // barrier keeps the event loop alive until drain + lease release commit (or the deadline).
      // options.onCloseBarrier is a deterministic test seam only (see its own JSDoc) — omitted in
      // production, where withShutdownBarrier falls back to real timers.
      finally { void withShutdownBarrier(stopOnce(), options.onCloseBarrier); }
    };
  }
  server.close = async (): Promise<void> => {
    await stopOnce();
    await close();
  };
  scheduler.start();
  return scheduler;
}

/**
 * Create and connect the monet-core MCP server, with graceful shutdown wired in by default.
 *
 * The shutdown coordinator (getGracefulShutdown) settles through exactly three paths, together
 * covering every way this factory's server can stop existing: a real trigger (SIGINT/SIGTERM or
 * stdin EOF — run()'s own finally, which also closes core), an explicit server.close() with no
 * trigger ever firing (settleGracefulShutdownOnExplicitClose), and this factory's OWN startup
 * failing after the installers already ran (settleGracefulShutdownOnStartupFailure, below). All
 * three are safe to race against each other (see settleGracefulShutdownIfUntriggered).
 */
export async function createMonetCoreMcpServer(
  core: MonetCore,
  options: CreateMonetCoreMcpServerOptions = {},
): Promise<McpServer> {
  // Embedder-pin enforcement (embedder-pin ADR, slice 1) — MonetCore's constructor is synchronous
  // and cannot itself satisfy a pin that requires an async model load, so every served path awaits
  // this once before handling any request. This is the single choke point for both "the MCP
  // server" and "the CLI": scripts/mcp-cli.ts constructs `core` and immediately calls this factory,
  // so covering this call site covers that entry point too, without duplicating the enforcement
  // call at every construction site. Throws UnsatisfiableEmbedderError (never silently substitutes
  // another embedder) if the store's pin can't be honored — propagates uncaught, so the server
  // must not start and the process exits non-zero (see scripts/mcp-cli.ts's main().catch()).
  await core.ensureEmbedderPin();
  const server = new McpServer(
    { name: "monet-core", version: "0.7.0" },
    {
      capabilities: { tools: {} },
      instructions: MONET_SERVER_INSTRUCTIONS,
    },
  );
  registerMonetCoreTools(server, core, deriveOptsFromEnv());
  // Executable-owned graceful shutdown: every process embedding this server gets SIGINT/SIGTERM
  // and stdin-EOF handling "for free" through this one API — no per-entry-point wiring required.
  // Installed BEFORE connect() (not after) so a signal or stdin EOF arriving during a stuck or
  // slow connect() still triggers a real shutdown attempt instead of Node's abrupt default
  // disposition. Crash-safe at any point relative to connect(): both installers call
  // server.close() by dynamic property lookup at the moment they actually fire, not a reference
  // captured now, so whichever close behavior attachSourceSchedulerLifecycle has (or hasn't yet)
  // wired in below is what runs. One narrow, purely theoretical gap: a signal that runs fully
  // synchronously to the point of calling getGracefulShutdown's run() inside the sub-millisecond
  // window between this line and attachSourceSchedulerLifecycle's call below would memoize the
  // pre-scheduler close — negligible in practice, since neither the scheduler nor any lease
  // exists yet at that point to lose (comment only; not worth the complexity of closing it).
  if (options.processShutdownHandlers !== false) installProcessShutdownHandlers(server, core);
  if (options.stdinEofShutdown !== false) installStdinEofShutdown(server, core);
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Connect completes first; start only queues the non-blocking zero-delay cycle.
    attachSourceSchedulerLifecycle(server, core, options, process.env, transport);
    // Explicit server.close() (an embedded host managing its own lifecycle, or a test) must ALSO
    // settle the shared shutdown coordinator even if no signal/EOF trigger ever fires — see
    // settleGracefulShutdownOnExplicitClose (Codex P2 #1). Installed LAST/outermost, after
    // attachSourceSchedulerLifecycle's own close patch, so it wraps the fully-assembled close chain.
    settleGracefulShutdownOnExplicitClose(server);
  } catch (error) {
    // Startup failed (e.g. transport.connect() rejected) after the installers above already
    // registered real process/stdin listeners for this now-abandoned server — settle the
    // coordinator so those listeners detach and their guards clear (Codex pass-3 P2, the third
    // settle-family member: see settleGracefulShutdownOnStartupFailure). The caller constructed
    // `core` and still owns it; this never touches it. Rethrow unchanged — this is cleanup, not
    // error handling.
    settleGracefulShutdownOnStartupFailure(server);
    throw error;
  }
  return server;
}
