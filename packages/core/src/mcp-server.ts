/**
 * monet-core MCP server — exposes the engine over MCP so a host agent (Stig/claude)
 * drives it live (ADR §4.5/§4.6). The agent is the Synthesizer: `memory_fetch` flags
 * a dirty concept with `needsSynthesis`; the agent explicitly pulls its observations,
 * writes a coherent body, and calls `memory_synthesize` to store it.
 *
 * This is a NEW contract (concept model, structural cards, no prose summary) — it does
 * not touch the legacy flat @monet/mcp-tools contract.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MonetCore } from "./engine";
import type { MemoryOverview, MergeConceptResult, RuleSuccession, SearchCard, StageView } from "./engine";
import {
  BREADTH_CIRCLE,
  MODEL_TAG_MAX_CHARS,
  STAGE_INDEX_CAP,
  STAGE_LOOKUP_BODY_CAP,
  STAGE_LOOKUP_OUTLINE_CAP,
  STAGE_LOOKUP_REASON_CAP,
  STAGE_LOOKUP_RULES_CAP,
  STAGE_NAME_MAX_CHARS,
} from "./gates";
import type { SourceAuthorizationContext } from "./source-types";
import { sanitizeSourceError } from "./source-errors";
import { MIRROR_STALE_INSTRUCTION, SKELETON_CHANGED_INSTRUCTION } from "./skeleton-mirror";
import { createSourceScheduler } from "./source-scheduler";
import type { SourceSchedulerHandle, SourceSchedulerOptions } from "./source-scheduler";

/**
 * Session lifecycle instructions surfaced to the host agent via McpServer's `instructions`
 * option. Tells the agent to orient with agent_context, pull workstreams only on continuation
 * intent, use memory_store/search/gather during the session, and close with memory_checkpoint.
 */
export const MONET_SERVER_INSTRUCTIONS =
  "Monet is the user's persistent memory substrate; start by calling agent_context (no arguments) for orientation; only on continuation intent use memory_workstreams to list active/paused threads and confirm which to resume before pulling detail; use memory_store for durable knowledge and memory_search/memory_gather (cards) + memory_fetch (content) to recall; end with memory_checkpoint and a workstream snapshot (open questions, decisions, next steps); without it, session state is lost.";

// Bounds so a tool result never blows past the host's MCP tool-result token budget (a single big
// concept — long body + many observations — otherwise serializes to tens of thousands of chars and
// the host rejects it: "N chars … exceeds maximum allowed tokens"). memory_fetch is bounded at the
// source (below); ok() is the last-resort safety net for every tool (overview/gather/agent_context).
const RESULT_MAX_CHARS = 40_000; // hard ceiling on any serialized tool result
const FETCH_MAX_OBS = 20; // most-recent observations returned by memory_fetch
const FETCH_OBS_MAX_CHARS = 1_200; // per-observation cap
const FETCH_BODY_MAX_CHARS = 6_000; // concept body cap
const FETCH_CONTRADICTION_MAX_CHARS = 400; // per-open-contradiction detail cap (PR #112 round 3)
const FETCH_CONTRADICTIONS_MAX = 5; // newest-first open-contradiction entries per fetch (round 4)
// REVIEW FIX (MINOR): source concept outline cap (file=concept, Ruling 9). A cheap upper bound on
// how many entries the size-fit loop below ever iterates over — NOT the real guarantee (see that
// loop's own comment). 500 was unsound on its own: headingPath is caller/document content with no
// length ceiling, and at a realistic 2-3-level, moderately-long heading path (~250 chars/entry
// serialized), 500 entries alone runs to ~125 000 chars — over 3x the 40 000-char RESULT_MAX_CHARS
// ceiling, well past where ok() would truncate the JSON mid-array and leave an unparseable
// response. 200 keeps this bound cheap (O(n) JSON.stringify calls in the fit loop, n ≤ 200) while
// staying close enough to the size-fit's own typical stopping point that it rarely binds first.
const FETCH_OUTLINE_MAX_ENTRIES = 200;

/**
 * BLOCKER FIX: stage_lookup's `rules` array is unbounded on BOTH axes a memory_fetch response
 * never is — how many rules a stage can accumulate over a store's lifetime, and how long each
 * rule's `body` (a full concept body, no write-time cap) or `reason` (no write-time cap either,
 * unlike a blocking rule's ONE-LINE constraint, which bounds shape, not length) can be. A count cap
 * alone is unsound (a handful of huge bodies still blows the budget) and a per-field cap alone is
 * unsound (many small-but-nonzero rules still add up), so both apply, plus a size-fit loop over the
 * ACTUAL serialized response — the same three-part defense memory_fetch's outline uses
 * (FETCH_OUTLINE_MAX_ENTRIES's own comment), applied here because stage_lookup has the identical
 * "cap alone is a hope, not a guarantee" shape.
 *
 * WORST-CASE SIZE MATH (why a fixed rule-count cap could not be the guarantee on its own): with
 * `body` capped to STAGE_LOOKUP_BODY_CAP (6 000, imported from gates.ts — see ITS OWN comment for
 * why this is SQL-bounded now too, not just wire-clipped) and `reason` capped to
 * STAGE_LOOKUP_REASON_CAP (1 200, SAME reasoning — round 3 extended the SQL bound to this axis
 * too) — each plus clip()'s own truncation note (~40 chars) — one rule's `conceptId` (36-char
 * uuid), `text` (≤80-char title), `severity`, `scope`, `reasonMissing`, `origin`, the optional
 * `modelTag` and the optional `projectedFromPrincipleId` (another uuid) add roughly 300 more value
 * chars, and 2-space pretty-print indentation/punctuation (JSON.stringify(..., null, 2), nested
 * inside `rules` inside the result object) adds roughly 150 more. One capped rule therefore
 * serializes to ~7 750 chars worst case — call it 8 000. The reviewer's own probe shape, 6 such
 * rules, is ~48 000 chars alone — already past RESULT_MAX_CHARS (40 000) before the rest of the
 * envelope (circle/matched/stage) is even counted, which is exactly the unparseable-JSON failure
 * (ok() hard-slicing valid JSON at a byte offset with isError:false) this fitting loop exists to
 * make impossible. A STORE WITH MANY SMALL RULES keeps every one of them; a store with a few huge
 * ones stops before the ceiling — that is what the size-fit buys over a bare count.
 */
// STAGE_LOOKUP_RULES_CAP / STAGE_LOOKUP_BODY_CAP / STAGE_LOOKUP_REASON_CAP / STAGE_LOOKUP_OUTLINE_CAP
// / STAGE_INDEX_CAP (all imported from gates.ts) used to be five separate wire-only constants here
// (STAGE_LOOKUP_RULES_MAX_ITERATE, an inline FETCH_BODY_MAX_CHARS reuse, an inline FETCH_OBS_MAX_CHARS
// reuse, STAGE_LOOKUP_OMITTED_MAX_ITERATE, and two separately-named 2,000s — STAGE_LOOKUP_
// INDEX_MAX_ITERATE / AGENT_CONTEXT_STAGE_INDEX_MAX_ITERATE) that merely happened to agree with the
// SQL-side caps evaluateStageLookup/liveStageIndex now enforce (review fix — Codex rounds 2-3: the
// engine was materializing every rule's full body/reason, for an unbounded rule count, and every
// stage's full row just to read its name, before this layer ever got a chance to clip anything).
// Now there is exactly one definition of each, in gates.ts, so "the wire's cap" and "the SQL's cap"
// cannot drift into two different numbers — this file only ever REFERENCES them below
// (rules.length ≤ STAGE_LOOKUP_RULES_CAP and a stage index's own length ≤ STAGE_INDEX_CAP are now
// ENGINE guarantees, so the size-fit loops no longer need their own separate count-cap slice before
// iterating — STAGE_INDEX_CAP doubles as both the SQL LIMIT and the wire's iteration bound for both
// of its consumers, stage_lookup's miss path and agent_context).
// STAGE_NAME_MAX_CHARS (imported from gates.ts) is the shared ceiling on every `stage` tool
// argument below (memory_store's `rule.stage`, memory_declare's `stage`, stage_lookup's `stage`) —
// referenced directly rather than copied, because a lookup cap that disagreed with the creation
// cap would mean either (a) a legitimately-stored name becomes unlookupable (the review-caught
// bug: lookup capped at 500 while `upsertStage` stayed unbounded), or (b) a lookup would accept
// what creation would refuse. `upsertStage` (gates.ts) is the AUTHORITATIVE enforcement — the one
// place a stage name is ever minted, covering every creation path, including ones with no MCP zod
// schema at all; the zod `.max(STAGE_NAME_MAX_CHARS)` calls below are the fast, friendly rejection
// at the boundary, not a second source of truth.

/** Truncate `s` to `max` chars, flagging whether it was clipped (so callers can signal it). */
function clip(s: string, max: number): { text: string; clipped: boolean } {
  if (s.length <= max) return { text: s, clipped: false };
  return { text: `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`, clipped: true };
}

/**
 * Size-fit loops keep their existing reservation below the hard ceiling. ok() no longer appends this
 * text: its last resort is a small valid-JSON envelope, but changing these established budgets would
 * alter non-pathological fitted responses that already honor the ceiling.
 */
const RESULT_TRUNCATE_NOTE = `\n\n…[result truncated to fit the host's tool-result limit — narrow the query/intent, lower \`limit\`, or memory_fetch a specific id]`;
const RECALL_EMPTY_LINE = "Nothing matched.";
/** Circle names are routing identifiers, not prose; bound every caller-controlled echo before writes. */
export const CIRCLE_NAME_MAX_CHARS = 256;
const WRITE_ACK_LIST_MAX = 25;
const STAGE_ACK_PATTERNS_MAX = 8;
const STAGE_ACK_TOKEN_MAX_CHARS = 80;
const STAGE_ACK_PATTERN_MAX_CHARS = 300;
const WRITE_ACK_TEXT_MAX_CHARS = 1_000;
const ANOMALOUS_STORE_RESOLUTION_MODES = new Set([
  "ambiguous-fork",
  "fork-signal",
  "blur-duplicate",
  "species-fork",
  "stage-fork",
]);

function fitWriteAckList<T>(items: readonly T[]): { items: T[]; omitted: number } {
  const fitted = items.slice(0, WRITE_ACK_LIST_MAX);
  return { items: fitted, omitted: items.length - fitted.length };
}

function fitRuleSuccessionForAck(succession: RuleSuccession): Record<string, unknown> {
  const { impeachedPrincipleIds, ...fixed } = succession;
  if (impeachedPrincipleIds === undefined) return fixed;
  const fit = fitWriteAckList(impeachedPrincipleIds);
  return {
    ...fixed,
    impeachedPrincipleIds: fit.items,
    ...(fit.omitted > 0 ? { impeachedPrincipleIdsOmitted: fit.omitted } : {}),
  };
}

function fitStageViewForAck(stage: StageView): Record<string, unknown> {
  const fitted = stage.patterns.slice(0, STAGE_ACK_PATTERNS_MAX).map((pattern) => ({
    tool: pattern.tool === null ? null : clip(pattern.tool, STAGE_ACK_TOKEN_MAX_CHARS).text,
    tokens: pattern.tokens.map((token) => clip(token, STAGE_ACK_TOKEN_MAX_CHARS).text),
  }));
  return {
    ...stage,
    name: clip(stage.name, WRITE_ACK_TEXT_MAX_CHARS).text,
    patterns: fitted,
    ...(stage.patterns.length > fitted.length ? { patternsOmitted: stage.patterns.length - fitted.length } : {}),
  };
}

function fitRenderedPatternsForAck(patterns: readonly string[]): { items: string[]; omitted: number } {
  const fitted = patterns.slice(0, STAGE_ACK_PATTERNS_MAX)
    .map((pattern) => clip(pattern, STAGE_ACK_PATTERN_MAX_CHARS).text);
  return { items: fitted, omitted: patterns.length - fitted.length };
}

/**
 * Search and gather cards are pointers, so their wire contract is deliberately smaller than the
 * engine's ranking record. Keep ranking inputs inside the engine; the array order is the only rank
 * signal a caller needs. This projection is shared by both tools so their key contracts cannot drift.
 * Circle stays exact because it is a routing key; an oversized card is omitted whole by the envelope
 * fitter below rather than returning a value memory_fetch's scope gate cannot use.
 */
type RecallWireCard = Pick<SearchCard, "id" | "slug" | "kind" | "circle"> & {
  observationCount: number;
  contradictions?: number;
};
function recallWireCard(card: SearchCard, observationCount: number): RecallWireCard {
  return {
    id: card.id,
    slug: card.slug,
    kind: card.kind,
    circle: card.circle,
    observationCount,
    ...(card.contradictions > 0 ? { contradictions: card.contradictions } : {}),
  };
}

/**
 * Fit a recall card array against one COMPLETE serialized response envelope. The builder owns every
 * returned field, including empty-result teaching and omission signals, so the measured object is the
 * returned object and ok()'s oversized fallback is unreachable by construction. Cards are indivisible
 * pointers: when the next one does not fit, omit it honestly rather than clipping identity fields.
 */
function fitRecallEnvelope(
  buildEnvelope: (cards: RecallWireCard[], omitted: number) => Record<string, unknown>,
  cards: RecallWireCard[],
): Record<string, unknown> {
  const emptyEnvelope = buildEnvelope([], cards.length);
  if (JSON.stringify(emptyEnvelope, null, 2).length > RESULT_MAX_CHARS) {
    throw new Error("recall response fixed fields exceed the host tool-result limit");
  }
  const fit = fitObjectArray(buildEnvelope, cards, RESULT_MAX_CHARS);
  return buildEnvelope(fit.fitted, fit.omitted);
}

/**
 * Fit as many strings from `items` into `envelope[key]` as fit within `budget` once the WHOLE
 * envelope is serialized — the same incremental size-fit technique as memory_fetch's outline
 * (FETCH_OUTLINE_MAX_ENTRIES's own comment) and stage_lookup's own `rules` array, generalized for a
 * plain string array so stage_lookup's miss-path stageIndex and agent_context's stageIndex share
 * ONE implementation rather than two copies that could quietly disagree about what "fits" means.
 * `maxIterate` bounds the O(n) JSON.stringify calls the loop makes, cheaply, before the size check
 * (which is expected to bind first for short strings like stage names) does.
 */
function fitStringArray(
  envelope: Record<string, unknown>,
  key: string,
  items: string[],
  maxIterate: number,
  budget: number,
): { fitted: string[]; omitted: number } {
  const countCapped = items.slice(0, maxIterate);
  const fitted: string[] = [];
  for (const item of countCapped) {
    const candidate = [...fitted, item];
    const serialized = JSON.stringify({ ...envelope, [key]: candidate }, null, 2);
    if (serialized.length > budget) break;
    fitted.push(item);
  }
  return { fitted, omitted: items.length - fitted.length };
}

/**
 * The object-array counterpart to fitStringArray — same incremental size-fit technique for response
 * envelopes that carry arrays of structured records. The builder owns every returned field, so the
 * object measured against the budget is exactly the object returned.
 */
function fitObjectArray<T>(
  buildEnvelope: (fitted: T[], omitted: number) => Record<string, unknown>,
  items: T[],
  budget: number,
): { fitted: T[]; omitted: number } {
  let fitted: T[] = [];
  for (let n = 1; n <= items.length; n++) {
    const candidate = items.slice(0, n);
    const serialized = JSON.stringify(buildEnvelope(candidate, items.length - n), null, 2);
    if (serialized.length > budget) break;
    fitted = candidate;
  }
  return { fitted, omitted: items.length - fitted.length };
}

/** Fit memory_overview as one envelope, degrading only the ratified low-priority worklists. */
export function fitOverviewEnvelope(overview: MemoryOverview & { resolvedFrom?: string }): Record<string, unknown> {
  const result = structuredClone(overview) as MemoryOverview & { resolvedFrom?: string };
  const fits = (): boolean => JSON.stringify(result, null, 2).length <= RESULT_MAX_CHARS;
  if (fits()) return { ...result };

  const removeOptInList = (key: "dirty" | "stale", truncatedKey: "dirtyTruncated" | "staleTruncated", omittedKey: "dirtyOmitted" | "staleOmitted", total: number): void => {
    const shown = result[key]?.length ?? 0;
    if (shown === 0) return;
    delete result[key];
    result[truncatedKey] = true;
    result[omittedKey] = Math.max(total, (result[omittedKey] ?? 0) + shown);
  };
  removeOptInList("dirty", "dirtyTruncated", "dirtyOmitted", result.counts.dirty);
  removeOptInList("stale", "staleTruncated", "staleOmitted", result.counts.stale);
  if (fits()) return { ...result };

  result.possibleDuplicates = [];
  if (fits()) return { ...result };
  result.livingModel = [];
  if (fits()) return { ...result };

  if (result.openContradictions.length > 0) {
    result.openContradictionsOmitted = (result.openContradictionsOmitted ?? 0) + result.openContradictions.length;
    result.openContradictions = [];
  }
  if (fits()) return { ...result };

  if (result.gateStats.retirementCandidates?.length) {
    result.gateStats.retirementCandidatesOmitted =
      (result.gateStats.retirementCandidatesOmitted ?? 0) + result.gateStats.retirementCandidates.length;
    delete result.gateStats.retirementCandidates;
  }
  if (result.gateStats.unexplainedDenies?.length) {
    result.gateStats.unexplainedDeniesOmitted =
      (result.gateStats.unexplainedDeniesOmitted ?? 0) + result.gateStats.unexplainedDenies.length;
    delete result.gateStats.unexplainedDenies;
  }
  if (fits()) return { ...result };

  // FINAL RUNG: skeleton identity and membership always survive. Only its user-authored resident
  // name (`content`) may shrink, and the complete envelope is measured after every shrink. The
  // metadata is fixed-size; empty content is therefore the constructive proof that this loop ends
  // below the ceiling for the source-capped envelope rather than falling through to ok()'s fallback.
  if (result.skeleton.length > 0) {
    const original = result.skeleton.map((member) => member.content);
    let contentLimit = Math.max(...original.map((content) => content.length));
    while (!fits() && contentLimit > 0) {
      contentLimit = Math.floor(contentLimit / 2);
      result.skeleton = result.skeleton.map((member, index) => ({
        ...member,
        content: original[index]!.length > contentLimit
          ? `${original[index]!.slice(0, Math.max(0, contentLimit - 1))}…`
          : original[index]!,
      }));
      result.skeletonClipped = true;
    }
    if (!fits()) {
      result.skeleton = result.skeleton.map((member) => ({ ...member, content: "" }));
      result.skeletonClipped = true;
    }
  }
  if (fits()) return { ...result };
  throw new Error("memory_overview fixed fields exceeded the tool-result limit");
}

// ok() is the canonical serializer for successful tool results. content[0] is ALWAYS the
// pure JSON payload — byte-identical to what callers (scripts/mcp-smoke.ts, test helpers)
// expect to JSON.parse. The optional prewarm block is appended as a separate content item.
// Per-item bounds: ok()'s JSON is capped at RESULT_MAX_CHARS; the prewarm block is capped
// at PREWARM_BLOCK_MAX_CHARS.
export function ok(content: object): CallToolResult {
  const serialized = JSON.stringify(content, null, 2);
  const text = serialized.length <= RESULT_MAX_CHARS
    ? serialized
    : JSON.stringify({
        truncated: true,
        originalChars: serialized.length,
        note: "Result exceeded the host tool-result limit; the original payload was omitted.",
      }, null, 2);
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
 * How many stage names buildPrewarmBlock's own recognition-cue line shows before a "+K more" tail
 * (item 5b). 15 real, moderate-length stage names ("git force push", "starting a review pass", …)
 * behind the line's own label render to ~290 chars — comfortably inside this function's own
 * PREWARM_BLOCK_MAX_CHARS budget on its own, and the line still rides the existing lower-section
 * size-fit if the rest of the block is large. Not unbounded: the whole point of a cap is that the
 * cue stays a short, scannable list rather than growing without limit as stages accumulate — see
 * the design's own "names are budgeted like anything else resident" note.
 *
 * A COUNT CAP ALONE IS NOT THE GUARANTEE (review fix — Codex round 2): stage creation imposes no
 * per-name length bound the way this constant assumes ("moderate-length" was an assumption about
 * REALISTIC names, not an enforced one) — wait, it now IS bounded by gates.ts's
 * STAGE_NAME_MAX_CHARS, but that ceiling (500) is still generous enough that a handful of names
 * near it blow well past this line's own budget. See STAGE_INDEX_PREWARM_LINE_MAX_CHARS below for
 * the actual per-line size-fit this cap is now paired with.
 */
const STAGE_INDEX_PREWARM_MAX_SHOWN = 15;
/**
 * The recognition-cue line's OWN character budget (review fix — Codex round 2). The prior version
 * joined up to STAGE_INDEX_PREWARM_MAX_SHOWN names into ONE line BEFORE buildPrewarmBlock's
 * lower-section fitter ever runs — and that fitter accepts or drops WHOLE lines (see its own "Fit
 * as many lower-priority lines as possible" loop), so a handful of names near
 * STAGE_NAME_MAX_CHARS (500) made the JOINED LINE ITSELF exceed the ~2 400-char lower-section
 * budget, and the fitter dropped the entire line — the WHOLE recognition cue silently vanishing,
 * on exactly the rich stores where it matters most, on the auto-prewarm path a worker that never
 * calls agent_context explicitly depends on for the ONLY in-flight delivery it gets.
 *
 * The fix builds the line INCREMENTALLY against THIS budget (append names while they still fit,
 * append the "+K more" tail computed from what REALLY fit) rather than joining first and hoping
 * the outer fitter accepts the result whole — so a non-empty prefix of the cue survives regardless
 * of how long any individual name is. 800 is comfortably under PREWARM_BLOCK_MAX_CHARS (2 500) on
 * its own, generous enough that STAGE_INDEX_PREWARM_MAX_SHOWN (not this budget) is what binds for
 * realistic short names, and small enough that this one line can never itself consume the whole
 * lower-section budget.
 */
const STAGE_INDEX_PREWARM_LINE_MAX_CHARS = 800;
/** Reserved headroom for the optional " (+K more)" tail when deciding whether one more name still
 *  fits (STAGE_INDEX_PREWARM_LINE_MAX_CHARS's own fitting loop) — a 4-digit count is already far
 *  more stages than any real install has, so this margin is never actually exhausted in practice. */
const STAGE_INDEX_PREWARM_TAIL_MARGIN_CHARS = 20;

/**
 * Build the compact prewarm block to prepend on the first successful tool response.
 * Calls core.prewarm(circle); renders the stage-index recognition cue only.
 * Returns the full delimited block string, or an empty string if the store is empty.
 *
 */
function buildPrewarmBlock(
  core: MonetCore,
  circle: string,
): string {
  const state = core.prewarm(circle);

  // === LOWER-PRIORITY SECTIONS (subject to truncation) ===
  const lowerLines: string[] = [];

  // Stage index (review fix, item 5b): the recognition cue MUST actually reach a worker that never
  // calls agent_context explicitly — auto-prewarm is the only in-flight delivery into that
  // junctureless interior, and a stageIndex the structured agent_context payload carried but this
  // rendered block never mentioned would leave that population with no cue at all. Names only, a
  // top-N + "+K more" tail (not the full list — an unbounded join here would defeat the point of a
  // cap), and placed in lowerLines (truncation-protected only up to the same budget every other
  // lower-priority line gets): this is a refreshed-every-call cue.
  const stageIndex = state.stageIndex ?? [];
  if (stageIndex.length > 0) {
    // BUILT INCREMENTALLY AGAINST THE LINE'S OWN BUDGET (review fix — Codex round 2): the prior
    // version joined up to STAGE_INDEX_PREWARM_MAX_SHOWN names into ONE line BEFORE this function's
    // own lower-section fitter (below) ever runs, and that fitter accepts or drops WHOLE lines — so
    // a handful of names near STAGE_NAME_MAX_CHARS made the line ITSELF exceed the lower-section
    // budget, and the fitter silently dropped the ENTIRE cue rather than a truncated prefix of it,
    // on exactly the rich-store case the cue exists for. Appending names one at a time and stopping
    // BEFORE the line would cross its own budget (see STAGE_INDEX_PREWARM_LINE_MAX_CHARS's own
    // comment) guarantees a non-empty prefix survives regardless of name length, and the "+K more"
    // tail below is computed from what ACTUALLY fit, not from the count-based cap alone.
    const label = "Stages you can recognize (ask stage_lookup): ";
    const shown: string[] = [];
    for (const name of stageIndex.slice(0, STAGE_INDEX_PREWARM_MAX_SHOWN)) {
      const candidateNames = shown.length === 0 ? name : `${shown.join(", ")}, ${name}`;
      if (label.length + candidateNames.length + STAGE_INDEX_PREWARM_TAIL_MARGIN_CHARS > STAGE_INDEX_PREWARM_LINE_MAX_CHARS) break;
      shown.push(name);
    }
    // THE TRUE TOTAL, not `stageIndex.length` alone (review fix — Codex round 4, item 1):
    // `state.stageIndexTotal` is present exactly when `liveStageIndex`'s OWN retrieval was capped
    // (STAGE_INDEX_CAP) — mirrors `rulesTotal`'s honesty contract. Before this fix, past that cap,
    // `stageIndex.length` WAS the cap (2 000) regardless of how many more stages were actually
    // retrieval-omitted, so "+K more" undercounted by exactly that omitted amount — an auto-prewarm
    // worker (the ONE population this cue exists for; see the comment above) reading "+1985 more"
    // when the true gap was, say, +3985 has no way to learn the difference from this line alone.
    const trueTotal = state.stageIndexTotal ?? stageIndex.length;
    const more = trueTotal - shown.length;
    lowerLines.push(`${label}${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`);
  }

  // Nothing stored at all → empty render → no block.
  if (lowerLines.length === 0) return "";

  const HEADER = "=== MONET SESSION CONTEXT (auto-prewarm) ===\n";
  const FOOTER = "=== END SESSION CONTEXT ===\n\n";

  const lowerBlob = lowerLines.join("\n") + "\n";
  const fullBlock = HEADER + lowerBlob + FOOTER;
  if (fullBlock.length <= PREWARM_BLOCK_MAX_CHARS) return fullBlock;

  const budget = PREWARM_BLOCK_MAX_CHARS - HEADER.length - FOOTER.length;
  let lowerFitted = "";
  for (const part of lowerBlob.split("\n")) {
    const candidate = lowerFitted + part + "\n";
    if (candidate.length > budget) break;
    lowerFitted = candidate;
  }
  return HEADER + lowerFitted + FOOTER;
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
 */
export interface RegisterMonetCoreToolsOpts {
  autoPrewarm?: boolean;
  /** Deprecated compatibility option. Checkpoint response nags are no longer emitted. */
  checkpointNudge?: boolean;
  /** Host-injected identity; never accepted from tool arguments. */
  sourceAuthorizationContext?: Readonly<SourceAuthorizationContext>;
  /**
   * Which model this runtime is serving — stamped on agent-scoped rules so the next model can
   * retire this one's compensations. Host-supplied for the same reason the authorization context
   * is: it is a property of the runtime, not something a tool argument should be able to claim.
   * Falls back to MONET_MODEL_TAG.
   */
  modelTag?: string;
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

  // When a tool call omits `circle`, fall back to the runtime's configured default (e.g. a per-project
  // circle the local client derived from the working tree) — so one shared store isolates per project.
  // resolveCircleName() transparently follows circle_aliases, so a caller using an old name routes to
  // the canonical circle without needing to know about the rename.
  const dc = core.getDefaultCircle();
  const scope = (circle?: string): string => core.resolveCircleName(circle ?? dc);

  /**
   * Which model an agent-scoped rule compensates for. HOST-SUPPLIED, never asked of the agent: the
   * tag is a property of the runtime rather than of the judgment being stored, and "a new model
   * retires the old model's compensations automatically" must not depend on a model reporting its
   * own identity correctly. Absent (no MONET_MODEL_TAG, no explicit tag on the call), an
   * agent-scoped capture is REFUSED rather than tagged with a guess — an untagged compensation is
   * indistinguishable from a domain rule at the moment it matters, which is the shackle risk.
   *
   * BLANK COUNTS AS ABSENT, not as a configured empty tag (review fix — Codex round 4, item 4: THE
   * BUG this closes). `process.env.MONET_MODEL_TAG` resolves to `""` under ordinary env
   * templating (`MONET_MODEL_TAG=${SOME_VAR}` with `SOME_VAR` unset expands to an empty string,
   * never to an absent variable) — a common, unremarkable deployment shape, not a misconfiguration.
   * `""` is neither `null` nor `undefined`, so a bare `??` chain would happily accept it as "the
   * host's answer" and hand it to `setRuntimeModelTag`, which — even now that the setter itself
   * normalizes blank to a clear (see its own comment) — would still CLEAR an already-good tag the
   * CONSTRUCTOR supplied (a test harness, an embedding host passing `runtimeModelTag` directly).
   * That is the wrong direction: a blank env var should behave as though it were never SET, not as
   * an explicit instruction to unset whatever was already configured. Trimming and treating a blank
   * result as `undefined` HERE makes the `if (defaultModelTag !== undefined)` guard below skip the
   * `setRuntimeModelTag` call entirely in that case, leaving the constructor's own tag untouched.
   * The fix belongs at BOTH ends (this resolution, and the setter's own total-against-blank
   * behavior) because they defend different callers: this one guards MCP registration specifically;
   * the setter guards every OTHER caller of the public API.
   */
  const rawModelTag = opts?.modelTag ?? process.env.MONET_MODEL_TAG;
  const defaultModelTag = rawModelTag?.trim() ? rawModelTag.trim() : undefined;

  // ONE CHAIN (review fix): gate()/stageLookup()/gateStats() all resolve `this.runtimeModelTag`
  // when a call omits an explicit tag. Wiring it here, ONCE, is what makes every surface reachable
  // from this process resolve the SAME tag — stage_lookup's handler used to pass `defaultModelTag`
  // per-call while gate() fell back to `this.runtimeModelTag`, and in the default deployment
  // (scripts/mcp-cli.ts constructs MonetCore without a runtimeModelTag option) that meant
  // MonetCore's own field stayed null even with MONET_MODEL_TAG set, so stage_lookup correctly
  // filtered a foreign-model rule while gate()/gateStats() (reading the still-null field) did not
  // — the two surfaces silently disagreeing about which rules exist. Only set when defined: an
  // explicit runtimeModelTag passed at MonetCore's OWN construction (a test harness, an embedding
  // host) is a real host signal too, and an absent MCP-layer default must not silently erase it.
  //
  // THIS IS THE ONLY PLACE `defaultModelTag` (the CLOSURE-captured copy) is used from here on
  // (review fix — Codex round 3, extending "one chain" to the WRITE path): memory_store's rule
  // capture and memory_declare below used to stamp a NEW rule's modelTag from THIS closure
  // variable directly, so a LATER `core.setRuntimeModelTag(...)` call (a live tag switch, e.g. a
  // host that changes which model it is running mid-session) was invisible to capture even though
  // gate()/stageLookup() already read the live field — a rule captured after the switch was
  // stamped for the OLD model and immediately filtered out by the NEW one. Both handlers now call
  // `core.getRuntimeModelTag()` at CALL TIME instead, so capture resolves from the SAME live source
  // delivery already did.
  if (defaultModelTag !== undefined) core.setRuntimeModelTag(defaultModelTag);

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
   * When it applies, the prewarm block ships as content[1] (a separate text item). A host that drops
   * extra content items degrades to no-prewarm — acceptable best-effort. No combined-ceiling math:
   * each item is independently bounded (ok()'s result at RESULT_MAX_CHARS via ok(); the block at
   * PREWARM_BLOCK_MAX_CHARS via buildPrewarmBlock()).
   *
   * `toolName`: name of the tool (to suppress prewarm block for agent_context).
   * `capturedBlock`: pre-captured prewarm block string from capturePrewarmSnapshot(), or null if
   *   the caller is agent_context (which handles its own lifecycle) or autoPrewarm is off. When
   *   non-null, consumePrewarmSnapshot() is called here and the block (if non-empty) is attached.
   */
  function wrapSuccess(
    result: CallToolResult,
    {
      toolName,
      capturedBlock,
    }: { toolName: string; capturedBlock?: string | null },
  ): CallToolResult {
    if (result.content[0]?.type !== "text") return result;

    let prewarmBlock = "";

    // --- auto-prewarm ---
    if (autoPrewarm && !prewarmed) {
      if (toolName === "agent_context") {
        // First call is agent_context: its payload IS the orientation — no double-inject.
        prewarmed = true;
      } else if (capturedBlock !== null && capturedBlock !== undefined) {
        // Pre-captured block provided (Fix A + Fix B): consume the one-shot and attach if non-empty.
        consumePrewarmSnapshot();
        if (capturedBlock.length > 0) {
          prewarmBlock = capturedBlock;
        }
      } else {
        // Fallback: no pre-captured block supplied (should not happen for well-formed callers).
        // Build inline as before so existing agent_context and legacy paths degrade gracefully.
        const resolvedCircle = scope();
        const block = buildPrewarmBlock(core, resolvedCircle);
        prewarmed = true;
        if (block.length > 0) {
          prewarmBlock = block;
        }
      }
    }

    if (prewarmBlock === "") return result;

    return {
      ...result,
      content: [result.content[0], ...result.content.slice(1), { type: "text", text: prewarmBlock }],
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
    wrapSuccess(ok(content), { toolName, capturedBlock });

  const mutOk = (
    content: object,
    toolName: string,
    capturedBlock?: string | null,
  ): CallToolResult =>
    wrapSuccess(ok(content), { toolName, capturedBlock });

  server.tool(
    "memory_store",
    'Store something worth remembering. By default the substrate deduplicates automatically: similar evidence resolves into an existing concept; novel evidence creates a new one. It finds by evidence and confirms by identity — an existing concept is nominated by how well its own stored observations match yours, then kept only if the concept as a whole is still coherent with what you wrote; when those two disagree the concept is bimodal, so instead of absorbing your evidence the substrate forks it and flags the pair as a possible duplicate for you to mediate (that is a fork signal, reported as resolutionMode="fork-signal"). The mirror case is reported as resolutionMode="blur-duplicate": a concept looked like an exact match as a whole but none of its stored evidence agreed, so your memory was kept separate and the pair flagged rather than silently absorbed. Pass resolution="forceNew" to always create a new concept (useful for bulk import flows where each item is known to be distinct). Pass attachTo=<conceptId> to attach directly to a specific concept, bypassing automatic scoring. Cheap and instant — synthesis happens later, on read. Use kind="procedure" for behavioral rules and kind="preference" for style/voice/format preferences.',
    {
      content: z.string(),
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional(),
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
      rule: z
        .object({
          stage: z
            .string()
            .max(STAGE_NAME_MAX_CHARS)
            .describe(
              "The action this rule fires at — a stage name, or the id of an existing stage. If no stage exists for this action yet, storing the rule CREATES it: a correction landing on an unstaged action is that stage's birth.",
            ),
          instance: z
            .string()
            .optional()
            .describe(
              'The concrete action you just watched go wrong, e.g. "Bash:git push --force origin main". Seeds the stage\'s trigger pattern when the stage is new — pass it whenever you have it.',
            ),
          scope: z
            .enum(["domain", "agent"])
            .optional()
            .describe(
              'Who this binds. "domain": it would still be true for a perfect agent (it describes the world). "agent" (default): it compensates for THIS model\'s failure habits. When uncertain, use "agent" — a wrong agent tag merely re-verifies on a model change, while a wrong domain tag shackles the next model.',
            ),
          modelTag: z
            .string()
            .max(MODEL_TAG_MAX_CHARS)
            .optional()
            .describe('Which model this compensates for. Required when scope is "agent"; defaults from MONET_MODEL_TAG when set.'),
          reason: z
            .string()
            .optional()
            .describe("One line naming the failure this prevents. This is what the gate shows, and the reason is what earns compliance."),
          projectedFromPrincipleId: z
            .string()
            .optional()
            .describe(
              "The skeleton principle this rule is PROJECTED from — for the empty-gate moment (\"stage X, no cached rules — skeleton applies\"): you are at a gate with nothing bound to it, the skeleton in your context speaks to it, so you write down the rule it implies here and it becomes a cache hit next time. The parent must be a ratified, undisputed skeleton principle in the same circle (a preference derives no rules, and neither does a principle that is retired or currently under impeachment). Records a derivation edge, so the rule announces \"derived from principle P\" whenever it fires — a wrong projection misfires in front of the user, which is exactly why this needs no approval step. Projected rules are advisory-only and are excluded from extraction evidence: a principle must not manufacture its own support.",
            ),
        })
        .optional()
        .describe(
          'Required when kind="rule". Binds the rule to the action it governs. Severity is always advisory here — blocking (deny) is declaration-only and lives in memory_declare.',
        ),
    },
    async ({ content, circle, kind, sourceRefs, resolution, attachTo, rule }) => {
      // Fix A + Fix B: capture the snapshot BEFORE the mutation so the block reflects prior state.
      const capturedBlock = capturePrewarmSnapshot(scope(circle));
      try {
        const r = await core.store(content, {
          circle: scope(circle), kind, sourceRefs, resolution, attachTo,
          // THE HOST TAG WINS. An agent-scoped rule names the model it compensates for, and the
          // tag is a property of the RUNTIME, not of the judgment being stored — so the host's
          // value is authoritative and the agent's is a fallback for hosts that supply none.
          // Preferring the caller's had it backwards: a model that misreports its own identity
          // (or simply guesses) would file its compensation under another model's tag, and the
          // "a new model retires the old model's compensations" rule would then retire the wrong
          // ones. Self-knowledge is exactly what this must not depend on.
          //
          // core.getRuntimeModelTag() — LIVE, not the closure-captured `defaultModelTag` (review
          // fix, Codex round 3): a rule captured after a later setRuntimeModelTag() switch must be
          // stamped for the model running NOW, not the one running at MCP registration time.
          ...(rule ? { rule: { ...rule, modelTag: core.getRuntimeModelTag() ?? rule.modelTag } } : {}),
        });
        const anomalousResolution = r.resolutionMode !== undefined &&
          ANOMALOUS_STORE_RESOLUTION_MODES.has(r.resolutionMode);
        const envelope = {
          circle: scope(circle), // the circle these ids live in — pass it to id-based tools if it isn't your session default
          action: r.action,
          conceptId: r.conceptId,
          ...(anomalousResolution
            ? { resolutionMode: r.resolutionMode, score: Number(r.score.toFixed(3)) }
            : {}),
          ...(r.contradiction
            ? { contradiction: { id: r.contradiction.id, status: r.contradiction.status, detail: r.contradiction.detail } }
            : {}),
          ...(r.nearMatchId ? { nearMatchId: r.nearMatchId, nearMatchScore: r.nearMatchScore } : {}),
          // A correction that overturned a rule did not attach to it — it birthed the rule's
          // successor and superseded the incumbent. `conceptId` above is the successor.
          // `ruleSuccession.impeachedPrincipleIds` (slice 5-B) rides along when the correction also
          // cast doubt up a parent edge — the principles that just left the skeleton because of it.
          ...(r.ruleSuccession ? { ruleSuccession: fitRuleSuccessionForAck(r.ruleSuccession) } : {}),
          // EXTRACTION CANDIDATE (slice 5-B), omitted when this write flagged none: the rule just
          // born looks like a rule at ANOTHER stage, which is the breadth precondition for
          // extracting a principle. A flag, not an extraction — the four-test battery and the human
          // ratification stay explicit (memory_ratify).
          ...(r.extractionCandidate ? { extractionCandidate: r.extractionCandidate } : {}),
        };
        return mutOk(envelope, "memory_store", capturedBlock);
      } catch (e) {
        return err(`store failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_declare",
    'Declare a rule, a stage, a principle, or a preference on the user\'s authority. This is the SOVEREIGN entrance: unlike memory_store, which captures what a correction taught, this records what the user has decided — so it is the only surface that accepts severity="blocking" (deny the action, for safety boundaries where softness is dangerous) and the only one that may replace an existing rule\'s binding. NEVER declare on your own initiative: a declaration is the user legislating, so it needs the user to have said so. species="stage" creates or re-authors a gate address ("put a gate on terraform apply") — passing `patterns` REPLACES that stage\'s trigger patterns outright, which is how a mis-seeded pattern is fixed. species="rule" creates the rule and binds it to its stage, creating the stage if it does not exist. species="principle"/"preference" is the DECLARATION entrance into the always-on skeleton — sovereignty replaces the four-test extraction battery here, but the battery still runs as a non-blocking warning light: the response\'s `advisories` array names mechanical signals (content that looks like a rule bound to an existing gate, missing `exitsEvidence`, a near-match/resolution the write itself surfaced) and NEVER blocks the write. Momentless: do not pass stage/severity/patterns for these two species — a preference bound to a moment is just a rule. Pass `exitsEvidence` (what would prove it wrong) to skip that one advisory. A skeleton-changing declaration conditionally instructs the caller to run `monet materialize` when a registered standing surface became stale. Standing grants are NOT a separate thing to declare: a gate returns what the rule says, so "proceed without asking" is a rule with permissive content.',
    {
      species: z
        .enum(["rule", "stage", "principle", "preference"])
        .describe('"stage": create or re-author a gate address. "rule": create a rule and bind it to a stage. "principle"/"preference": declare directly into the always-on skeleton (momentless — no stage/severity/patterns).'),
      stage: z
        .string()
        .max(STAGE_NAME_MAX_CHARS)
        .optional()
        .describe("The action the gate fires on — a stage name, or the id of an existing stage. Required for species \"rule\"/\"stage\"; must be omitted for \"principle\"/\"preference\", which are momentless."),
      content: z.string().optional().describe('What it says. Required for every species.'),
      exitsEvidence: z
        .string()
        .optional()
        .describe(
          'species "principle"/"preference" only: what evidence would prove this wrong (the extraction battery\'s Exits test). Omitting it never blocks the write — it only earns a warning-light advisory prompting for it.',
        ),
      patterns: z
        .array(z.string())
        .optional()
        .describe(
          'Trigger patterns as concrete command shapes, e.g. ["terraform apply", "Bash:git push --force"]. REPLACES the stage\'s existing patterns entirely — including an empty array, which makes the stage fire on nothing. Each is reduced to a tool constraint plus an ordered word run, and fires when those words appear in order anywhere in the intercepted action. Omit the field to leave the patterns alone.',
        ),
      instance: z
        .string()
        .optional()
        .describe("A concrete instance to seed the pattern from, when the stage is new and no explicit patterns are given."),
      severity: z
        .enum(["advisory", "blocking"])
        .optional()
        .describe(
          'OMIT THIS unless the user is ruling on the failure mode. Omitted PRESERVES whatever the rule already has (restating a rule\'s text or its gate is not a decision about whether it denies); on a brand-new rule, omitted means "advisory". "advisory": the rule is injected at the gate. "blocking": the action is DENIED — this exists only here, no agent and no projection can self-assign deny power, and only where softness is genuinely dangerous. Passing "advisory" for a rule that is currently blocking REMOVES the deny; that is allowed but it is the user\'s call, and the response reports it as downgraded.',
        ),
      acknowledgeBlockingRules: z
        .array(z.string())
        .optional()
        .describe(
          "Required when `patterns` would re-author a stage that has blocking rules bound to it: list every one of their concept ids. Changing a stage's patterns changes what its denies deny, so this confirms you have seen them. The error names the ids you are missing — show them to the user before acknowledging.",
        ),
      scope: z.enum(["domain", "agent"]).optional().describe('"domain": true for a perfect agent. "agent" (default): a compensation for this model.'),
      modelTag: z.string().max(MODEL_TAG_MAX_CHARS).optional().describe('Which model this compensates for. Required when scope is "agent"; defaults from MONET_MODEL_TAG when set.'),
      reason: z.string().optional().describe('One line naming the failure this prevents — what the gate shows, and what earns compliance. REQUIRED when severity is "blocking": a deny nobody can explain is a deny people learn to route around. Ask the user for it rather than inventing one.'),
      // Bounded like memberRuleIds and ratifiedBy: this lands verbatim in fixed response fields and
      // overview skeleton entries, which are not size-fitted — an actor "name" is never a document.
      declaredBy: z.string().max(200).optional().describe("Who ruled. Defaults to the calling agent id."),
      circle: z
        .string()
        .max(CIRCLE_NAME_MAX_CHARS)
        .optional()
        .describe(
          'Which circle this declaration lives in. Omit for the default. "*" is the reserved GLOBAL BREADTH declaration for species="rule", "principle", or "preference": the member keeps its ordinary home circle and delivers in every circle, unioned with whatever is local there, no shadowing — never a real circle name. Refused for species="stage" because a stage is store-global already.',
        ),
      sourceRefs: z.array(z.string()).optional(),
    },
    async ({ species, stage, content, exitsEvidence, patterns, instance, severity, scope: ruleScope, modelTag, reason, declaredBy, circle, sourceRefs, acknowledgeBlockingRules }) => {
      // RAW, UNDISTORTED — memory_declare-scoped (review fix — Codex round 2, item 1). declare()
      // itself must be able to tell "the caller said nothing about circle" (`undefined` — preserves
      // an existing binding's circle, including breadth) from "the caller explicitly named the
      // session default" (a REAL ruling that legitimately narrows an existing global rule, even
      // though it happens to equal what scope() would already have produced). scope()'s own eager
      // `?? dc` fallback collapsed that distinction before declare() ever saw it — this is the one
      // seam that must not also default-fill. '*' passes through untouched: it is never a real
      // circle name to alias-resolve, and resolving it through scope() would be the wrong kind of
      // "helpful" even though (circle_aliases can never name '*') it would happen to be harmless
      // today. Every OTHER tool in this file keeps calling scope(circle) exactly as before — this
      // resolution is local to this one handler's call into core.declare().
      const declareCircle = circle === undefined ? undefined : circle === BREADTH_CIRCLE ? BREADTH_CIRCLE : scope(circle);
      // THE HOME CIRCLE — for prewarm snapshotting and the response's own `circle` field, NEVER '*'
      // (review fix — Codex round 3, item 3). '*' is a valid RULING for `declareCircle` above (the
      // member's own delivery breadth, going into declare()'s `circle` input alone) but it is not a
      // real circle anything else here can operate against: the rule/principle/preference CONCEPT
      // always lives at the caller's own circle, never at the breadth marker — so
      // capturePrewarmSnapshot('*') would burn the one-shot mechanism scanning a circle that holds
      // no concepts, and a response claiming `circle: '*'` would misreport where the concept
      // actually lives. Resolves to the session default whenever the caller named nothing OR named
      // '*' explicitly; otherwise resolves the named circle exactly as before. The ruling itself is
      // still fully visible — via `binding.circle` in the spread `...r` below, never hidden, just
      // reported through the field that already exists for it rather than through this one.
      const homeCircle = circle === undefined || circle === BREADTH_CIRCLE ? scope() : scope(circle);
      const capturedBlock = capturePrewarmSnapshot(homeCircle);
      try {
        const r = await core.declare({
          species, stage, content, exitsEvidence, patterns, instance, severity, scope: ruleScope,
          // LIVE, not the closure-captured `defaultModelTag` — same review-fix reasoning as
          // memory_store's own rule capture just above (Codex round 3). The HOST tag is injected
          // for RULES only: principle/preference are momentless and reject modelTag, but a
          // caller-supplied value must still reach declare() so that rejection is not bypassed.
          modelTag: species === "rule" ? (core.getRuntimeModelTag() ?? modelTag) : modelTag,
          reason, declaredBy, sourceRefs,
          acknowledgeBlockingRules,
          circle: declareCircle,
        });
        // BOTH DISCLOSURES CAN APPLY TO ONE DECLARE (Codex round 11, item 7, P2 — found and fixed:
        // the previous version chained these as an if/else-if, `r.downgraded ? ... : r.narrowedFromBreadth
        // ? ... : ...`, so a single declare() that BOTH downgrades severity (blocking → advisory)
        // AND narrows breadth (circle: '*' → local) in the SAME call — a legal, single-act
        // re-declaration, nothing in declare() refuses combining the two — short-circuited past the
        // narrowing branch entirely the moment `r.downgraded` was true, silently swallowing the
        // BREADTH NARROWED disclosure. Each is its OWN mirror-changing act with its OWN "never
        // something the user finds out later" obligation (see each string's own comment below); a
        // ternary chain can only ever surface ONE winner, so it structurally cannot state two
        // independent truths about the same response.
        //
        // AN IF/ELSE STATEMENT, NOT A NESTED TERNARY IN THE OBJECT LITERAL (as the array-building
        // version of this fix first tried) — TypeScript narrows `r`'s discriminated union (`species
        // === "stage"` vs. the rule-bound branch that alone carries `downgraded`/`narrowedFromBreadth`)
        // only within a real conditional's own branch, not across a separately-computed `const` built
        // before that check runs — caught immediately by `tsc`, not by inspection: "Property
        // 'downgraded' does not exist on type '{ species: \"stage\"; ... }'". Restructured so the
        // stage/rule split happens FIRST, matching the narrowing this union actually needs.
        //
        // ORDER: downgraded's own line first, per severity taking precedence over breadth in every
        // other place this codebase orders the two (DOOR 12's own severity gate runs before the
        // breadth boundary check, graftRows).
        // A REAL CONDITIONAL'S OWN BRANCHES, per the lesson the comment just above this one already
        // states about this exact union: TypeScript narrows `r`'s discriminated union only within a
        // real if/else's own branch, not by trusting a narrowing to persist past an early return out
        // of a sibling, separately-checked `if`. species=="principle"/"preference" is therefore its
        // own `if` arm with its own `return`, and the ENTIRE stage/rule split lives inside the paired
        // `else`, so `r` stays narrowed to "stage" | "rule" for all of it, exactly as that split needs.
        if (r.species === "principle" || r.species === "preference") {
          const guidance = r.narrowedFromBreadth
            ? `BREADTH NARROWED: this ${r.species} was global (every circle) and now delivers only in its own circle — every OTHER circle stops receiving it. Tell the user plainly. Re-declare with circle="*" to restore it.`
            : undefined;
          const envelope = {
            circle: homeCircle,
            species: r.species,
            conceptId: r.conceptId,
            action: r.action,
            ...(r.advisories.length > 0 ? { advisories: r.advisories } : {}),
            ...(guidance !== undefined ? { guidance } : {}),
            ...(r.materializeRequired ? { instruction: SKELETON_CHANGED_INSTRUCTION } : {}),
          };
          return mutOk(envelope, "memory_declare", capturedBlock);
        } else {
          let guidance: string;
          if (r.species === "stage") {
            guidance = "The stage is registered. It fires nothing until a rule is bound to it — until then a matching action reports the stage with no rules, which is the signal to reason from principles.";
            const previous = fitRenderedPatternsForAck(r.previousPatterns);
            const patterns = fitRenderedPatternsForAck(r.patterns);
            return mutOk({
              circle: homeCircle,
              species: r.species,
              stage: fitStageViewForAck(r.stage),
              previousPatterns: previous.items,
              ...(previous.omitted > 0 ? { previousPatternsOmitted: previous.omitted } : {}),
              patterns: patterns.items,
              ...(patterns.omitted > 0 ? { patternsOmitted: patterns.omitted } : {}),
              guidance,
            }, "memory_declare", capturedBlock);
          } else {
            const disclosures = [
              // A removed deny is never allowed to be something the user finds out later.
              r.downgraded
                ? "DENY REMOVED: this rule was blocking and is now advisory — the action it used to refuse will go through. Tell the user plainly. Re-declare with severity=\"blocking\" to restore it."
                : null,
              // Same discipline, one axis over (review fix — Codex round 2, item 1): a narrowed-away
              // global rule is never something the user finds out later either. INDEPENDENT of
              // `downgraded` above — checked unconditionally, not as an `else` branch, so this fires
              // whether or not a downgrade also happened in the same call.
              r.narrowedFromBreadth
                ? "BREADTH NARROWED: this rule was global (every circle) and now delivers only in its own circle — every OTHER circle stops receiving it. Tell the user plainly. Re-declare with circle=\"*\" to restore it."
                : null,
            ]
              .filter((line): line is string => line !== null)
              .join(" ");
            guidance = disclosures !== ""
              ? disclosures
              : "The rule is bound. It will be returned at that gate the next time the action is intercepted; its patterns show as unverified until the first real fire.";
          }
          return mutOk(
            {
              circle: homeCircle,
              ...r,
              stage: fitStageViewForAck(r.stage),
              binding: {
                ...r.binding,
                ...(r.binding.reason !== null
                  ? { reason: clip(r.binding.reason, WRITE_ACK_TEXT_MAX_CHARS).text }
                  : {}),
              },
              guidance,
            },
            "memory_declare",
            capturedBlock,
          );
        }
      } catch (e) {
        return err(`declare failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_ratify",
    'The human-approval surface — the OTHER skeleton entrance, alongside memory_declare\'s species="principle"/"preference". Records a ruling on a skeleton candidate (a concept of kind "principle" or "preference"): the lead runs the four-test battery (Generates/Covers/Transfers/Exits) conversationally, and this call is where the human\'s verdict on it becomes durable record. verdict="approve" or "re-ratify" with `memberRuleIds` writes a derivation edge from the principle to EACH named rule (bornOf "ratification") — this is the principle proving it can re-derive its member rules; member rule ids must share the candidate\'s circle. verdict="reject" records that the candidate does not enter. verdict="retire" ends a currently-live membership (an impeached principle\'s own use-maintenance) — every verdict is recorded regardless, since ratification history is append-only. Skeleton membership is ALWAYS derived from the LATEST ratification for a concept, never a stored flag: approve→retire takes something out, retire→re-ratify brings it back. `packet` is the evidence shown to the human (member rules + failures, a re-derivation, the uncovered situation) — stored OPAQUE and VERBATIM for audit fidelity; memberRuleIds is a separate typed field precisely so edge-writing never depends on parsing it. A membership-changing verdict conditionally instructs the caller to run `monet materialize` when a registered standing surface became stale.',
    {
      candidateId: z.string().describe("Concept id of the skeleton candidate. Must be kind 'principle' or 'preference' in the resolved circle."),
      verdict: z
        .enum(["approve", "reject", "retire", "re-ratify"])
        .describe('"approve"/"re-ratify": skeleton entry (or re-entry) — memberRuleIds (if given) each get a derivation edge. "reject": never enters. "retire": ends a current membership.'),
      memberRuleIds: z
        .array(z.string())
        // Bounded because the response echoes every id back as edgeIds, a fixed (un-fittable)
        // field: ~890 ids push the finished payload past the result ceiling into a mid-JSON
        // slice (recheck finding 2). 200 is far beyond any real principle's membership.
        .max(200)
        .optional()
        .describe(
          'Concept ids of the rules this principle generates. One derivation edge is written per id, ONLY when verdict is "approve" or "re-ratify" — ignored for "reject"/"retire". Every id must share the candidate\'s circle.',
        ),
      packet: z
        .unknown()
        .optional()
        .describe(
          "The evidence packet exactly as shown to the human who ruled (member rules + failures, a re-derivation, the uncovered situation) — stored verbatim for audit fidelity, never parsed to decide anything.",
        ),
      ratifiedBy: z.string().max(200).optional().describe("Who ruled. Defaults to the calling agent id."),
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional().describe("Which circle the candidate lives in. Omit for the default."),
    },
    async ({ candidateId, verdict, memberRuleIds, packet, ratifiedBy, circle }) => {
      const capturedBlock = capturePrewarmSnapshot(scope(circle));
      try {
        const resolvedCircle = scope(circle);
        const r = await core.ratify({
          candidateId,
          verdict,
          memberRuleIds,
          // Pre-serialize here, at the wire boundary — core.ratify()/recordRatification store
          // `packet` verbatim as a string and never inspect its shape (see RatifyInput's own
          // comment: the decided deviation is that memberRuleIds is an explicit field precisely so
          // edge-writing never has to parse this back out).
          packet: packet !== undefined ? JSON.stringify(packet) : undefined,
          ratifiedBy,
          circle: resolvedCircle,
        });
        const envelope = {
          circle: resolvedCircle,
          ratificationId: r.ratificationId,
          verdict: r.verdict,
          conceptId: r.conceptId,
          edgeIds: r.edgeIds,
          ...(r.impeachmentsClosed !== undefined ? { impeachmentsClosed: r.impeachmentsClosed } : {}),
          ...(r.extractionFlagsResolved !== undefined ? { extractionFlagsResolved: r.extractionFlagsResolved } : {}),
          ...(r.materializeRequired ? { instruction: SKELETON_CHANGED_INSTRUCTION } : {}),
        };
        return mutOk(envelope, "memory_ratify", capturedBlock);
      } catch (e) {
        return err(`ratify failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_search",
    "Locate memories by query similarity. Results are ranked pointer cards, not content: call memory_fetch(id) to read one, and pass the card's circle when it differs from the session's. An empty result means nothing matched, not failure. Omit circle to search across all circles; pass circle to restrict.",
    {
      query: z.string(),
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional().describe("Restrict search to this circle. Omit to search across all circles — cards include each memory's home circle."),
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
        const cards = results.map((card) => recallWireCard(card, core.countObservationsForConcept(card.id)));
        const envelope = (fitted: RecallWireCard[], omitted: number): Record<string, unknown> => ({
          circle: circleLabel,
          results: fitted,
          ...(omitted > 0 ? { resultsTruncated: true, resultsOmitted: omitted } : {}),
          ...(cards.length === 0 ? { note: RECALL_EMPTY_LINE } : {}),
        });
        return readOk(fitRecallEnvelope(envelope, cards), "memory_search", capturedBlock);
      } catch (e) {
        return err(`search failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_overview",
    "Curation workbench for one circle: compact counts plus bounded actionable queues for possibleDuplicates, extractionCandidates, openContradictions, gate exceptions, and the ratified skeleton. The livingModel shows the top 5 current concepts by default. Pass includeDirty:true for the highest-evidence pending-synthesis cards; pass includeStale:true for the stalest re-confirmation cards. Both lists are capped and carry honest omission signals. Read-only; never returns memory bodies. Fetch an id to inspect evidence, resolve contradictions/pair flags with memory_resolve, and consolidate a true duplicate with memory_detach(destConceptId). Pass entity to list memories tied to one hub.",
    {
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional(),
      entity: z.string().optional(),
      conceptLimit: z.number().int().min(0).optional().describe("Override the living-model card limit (default 5)."),
      includeDirty: z.boolean().optional().describe("Include the capped pending-synthesis worklist; absent by default."),
      includeStale: z.boolean().optional().describe("Include the capped re-confirmation worklist; absent by default."),
    },
    async ({ circle, entity, conceptLimit, includeDirty, includeStale }) => {
      const capturedBlock = capturePrewarmSnapshot(scope(circle));
      try {
        if (entity) return readOk({ circle: scope(circle), entity, concepts: core.conceptsForEntity(entity, scope(circle)) }, "memory_overview", capturedBlock);
        const ov = core.overview(scope(circle), {
          sourceAuthorizationContext,
          conceptLimit,
          includeDirty,
          includeStale,
        });
        return readOk(fitOverviewEnvelope(ov), "memory_overview", capturedBlock);
      } catch (e) {
        return err(`overview failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_list",
    "Enumerate a circle's memories as structural cards — id, title, kind, support count, confidence, open contradictions — optionally with `withProvenance` for the project path(s) each memory's evidence came from. PAGINATED with a KEYSET cursor: returns up to `limit` (default 50) plus a `nextCursor` when more remain; pass it back as `cursor` to continue, until it's absent. The cursor walks a stable order, so it's SAFE to reassign each page out of the circle before fetching the next (an offset would skip rows as the circle shrinks). Read-only; never returns bodies (memory_fetch reads one). Built for organizing/migrating memory: list a circle (e.g. the legacy \"default\"), group by content + where it came from, then memory_reassign_circle each into its project's circle.",
    {
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional(),
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
    "Rebuild working context around an intent via graph spread. Results are ranked pointer cards, not content: call memory_fetch(id) to read one, and pass the card's circle when it differs from the session's. An empty result means nothing matched, not failure. Omit circle to gather across all circles; pass circle to restrict.",
    {
      intent: z.string(),
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional().describe("Restrict gathering to this circle. Omit to gather across all circles — cards include each memory's home circle (spreading stays within each seed's home circle)."),
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
        const cards = r.ranked.map((card) => recallWireCard(card, core.countObservationsForConcept(card.id)));
        const envelope = (fitted: RecallWireCard[], omitted: number): Record<string, unknown> => ({
          circle: circleLabel,
          ranked: fitted,
          ...(omitted > 0 ? { rankedTruncated: true, rankedOmitted: omitted } : {}),
          ...(cards.length === 0 ? { note: RECALL_EMPTY_LINE } : {}),
        });
        return readOk(fitRecallEnvelope(envelope, cards), "memory_gather", capturedBlock);
      } catch (e) {
        return err(`gather failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_fetch",
    "Read a concept by id. For normal concepts, `body` is the payload; observations never ride by default. Pass observations:true only when you need the evidence for synthesis or curation; observations are {id, content} and page newest→oldest with observationsOffset (0 = newest page, normally 20 at a time). `observationCount` is the full count. When `observationsOmitted` appears, the requested page was size-fitted; advance observationsOffset by the number of observations actually returned to continue without gaps. `needsSynthesis:true` means new evidence has not been synthesized: explicitly pull every observation page, write one coherent body, then call memory_synthesize(id, body). `bodyTruncated:true` means the body was clipped; use the observations pull to recover the evidence. A disputed concept adds `status` and `openContradictions` [{id, kind, detail}]; mediate with memory_resolve({ contradictionId: openContradictions[i].id }). Source concepts (kind='source', file=concept) keep their structure-first contract unchanged: title, sourcePath + sourceId, and an outline by default, never observations/needsSynthesis; pass includeBody:true to read the concatenated file body inline.",
    {
      id: z.string(),
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional().describe("The circle the id belongs to. Omit to look the id up store-wide (the response includes its home circle); if provided, the id must live in that circle."),
      observations: z.boolean().optional().describe("Normal concepts only: include one newest-first page of observations for synthesis or curation. Default false. Source concepts keep their structure-first response and ignore this parameter."),
      observationsOffset: z.number().int().min(0).optional().describe("When observations:true, skip this many observations from the newest end before applying the 20-entry page cap. Start at 0. Normally increment by 20; if observationsOmitted appears, increment by observations.length instead so size-fitting cannot create gaps. Paging metadata appears only when observations were requested."),
      includeBody: z.boolean().optional().describe("Source concepts only: include the full concatenated file body. Default false because a source concept's body can span the whole file. Ignored for normal concepts, whose body is always the payload."),
    },
    async ({ id, circle, observations, observationsOffset, includeBody }) => {
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
        // Only an explicit observations pull asks the engine to materialize one newest-first page.
        // A default body read still counts the evidence but does not load any observation content.
        const c = await core.getConcept(id, {
          synthesize: false,
          observationsOffset: observations ? observationsOffset ?? 0 : 0,
          pageSize: observations ? FETCH_MAX_OBS : 0,
          includeObservations: observations === true,
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
          // long or deeply-nested headings. Two caps cooperate here: the count cap bounds how many
          // JSON.stringify calls this
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

        const body = clip(c.body ?? "", FETCH_BODY_MAX_CHARS);
        const observationPage = observations
          ? c.observations.map((o) => {
              const content = clip(o.content, FETCH_OBS_MAX_CHARS);
              return { id: o.id, content: content.text, clipped: content.clipped };
            })
          : [];
        // A disputed concept's fetch is the primary consumption-time doubt channel. Keep its open
        // contradictions capped in SQL; active concepts do not pay even the query cost.
        const openContradictions = c.status === "disputed"
          ? core.getOpenContradictionsForConcept(id, FETCH_CONTRADICTIONS_MAX + 1)
          : [];
        const shownContradictions = openContradictions.slice(0, FETCH_CONTRADICTIONS_MAX);
        const fixedFields = {
          id: c.id,
          circle: c.circle,
          kind: c.kind,
          body: body.text,
          observationCount: c.totalObservations,
          lastConfirmedAt: c.lastConfirmedAt,
          ...(body.clipped ? { bodyTruncated: true } : {}),
          ...(c.needsSynthesis ? { needsSynthesis: true } : {}),
          ...(c.status === "disputed"
            ? {
                status: c.status,
                openContradictions: shownContradictions.map((k) => ({
                  id: k.id,
                  kind: k.kind,
                  detail: clip(k.detail, FETCH_CONTRADICTION_MAX_CHARS).text,
                })),
                ...(openContradictions.length > shownContradictions.length
                  ? { openContradictionsOmitted: core.countOpenContradictionsForConcept(id) - shownContradictions.length }
                  : {}),
              }
            : {}),
        };
        if (!observations) return readOk(fixedFields, "memory_fetch", capturedBlock);

        // ONE BUILDER FOR MEASUREMENT AND RESPONSE: the body and every conditional fixed field stay
        // in every candidate, so an escaping-heavy evidence page cannot push the completed response
        // into ok()'s generic replacement envelope. The observations page is the only degrading axis.
        // The engine page is oldest→newest within the selected newest-first window. Fit a prefix in
        // newest-first traversal order, then reverse it back for the wire; advancing the offset by
        // observations.length therefore continues into older evidence without gaps.
        type WireObservation = { id: string; content: string };
        const newestFirst: WireObservation[] = observationPage.map(({ id: observationId, content }) => ({
          id: observationId,
          content,
        })).reverse();
        const pageHasClippedContent = observationPage.some((observation) => observation.clipped);
        const envelope = (fittedNewestFirst: WireObservation[], omitted: number): Record<string, unknown> => ({
          ...fixedFields,
          observations: [...fittedNewestFirst].reverse(),
          observationsOffset: c.observationsOffset,
          ...(pageHasClippedContent ? { observationsTruncated: true } : {}),
          ...(omitted > 0 ? { observationsOmitted: omitted } : {}),
        });
        const fit = fitObjectArray(envelope, newestFirst, RESULT_MAX_CHARS - RESULT_TRUNCATE_NOTE.length);
        return readOk(envelope(fit.fitted, fit.omitted), "memory_fetch", capturedBlock);
      } catch (e) {
        return err(`fetch failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "stage_lookup",
    "You are at a named moment (see the stage index from agent_context): ask for that stage's rules before proceeding. Advisory delivery — rules arrive with the reason that earns compliance. When parentDisputed is true, one of this rule's derivation parents is currently disputed — disputedParentIds names exactly which (memory_fetch them to see the impeachment; the named projectedFromPrincipleId is the earliest/display parent, not necessarily a disputed one). A miss returns the live index.",
    {
      stage: z.string().max(STAGE_NAME_MAX_CHARS).describe("The stage name (or id) you recognize — from the stage index agent_context/prewarm carries."),
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional(),
    },
    async ({ stage, circle }) => {
      const capturedBlock = capturePrewarmSnapshot(scope(circle));
      try {
        // ONE CHAIN: no runtimeModelTag passed here — core.setRuntimeModelTag() was called once at
        // registration (above), so this resolves identically to gate()/gateStats() by construction.
        const r = core.stageLookup({ stage, circle: scope(circle) });
        const fixedFields = {
          circle: scope(circle),
          matched: r.matched,
          ...(r.stage ? { stage: r.stage } : {}),
        };
        const sizeBudget = RESULT_MAX_CHARS - RESULT_TRUNCATE_NOTE.length;

        // SIZE-FIT #1: rules (blocker fix). Same technique memory_fetch's outline uses (see
        // FETCH_OUTLINE_MAX_ENTRIES's own comment) — per-field clip() bounds one rule's own size;
        // this loop bounds the ARRAY by checking the ACTUAL serialized size against budget rather
        // than trusting a fixed count, so many small rules all survive and a few huge ones stop
        // before the ceiling (see STAGE_LOOKUP_BODY_CAP's own worst-case-math comment above). Always
        // a fast no-op on a MISS — r.rules is [] there. No count-cap slice needed before iterating
        // any more (review fix — Codex round 2): r.rules.length ≤ STAGE_LOOKUP_RULES_CAP is now an
        // ENGINE guarantee (evaluateStageLookup's own SQL LIMIT), not something this loop has to
        // re-enforce.
        const fitRules: Array<Record<string, unknown>> = [];
        for (const rule of r.rules) {
          const bodyClip = rule.body !== null ? clip(rule.body, STAGE_LOOKUP_BODY_CAP) : null;
          const reasonClip = rule.reason !== null ? clip(rule.reason, STAGE_LOOKUP_REASON_CAP) : null;
          const candidateRule = {
            conceptId: rule.conceptId,
            text: rule.text,
            reason: reasonClip ? reasonClip.text : rule.reason,
            // Back on the wire (review fix): dropped in an earlier version, which broke
            // derivability on a whitespace reason ("\t\n " → reason non-null but reasonMissing
            // true) — the exact cross-surface class hasNoReason (gates.ts) exists to prevent, and
            // this surface had quietly re-opened it by omitting the field rather than disagreeing
            // on its value.
            reasonMissing: rule.reasonMissing,
            severity: rule.severity,
            scope: rule.scope,
            // origin/modelTag BACK ON THE WIRE (review fix — Codex round 2). VERIFIED premise: when
            // no runtime model tag is configured, RULE_LIVENESS_WHERE's model-tag filter
            // (`b.scope != 'agent' OR ? IS NULL OR b.model_tag = ?`, gates.ts) delivers EVERY
            // agent-scoped rule regardless of its own model_tag — a NULL runtime tag makes the `?
            // IS NULL` disjunct true unconditionally, so `scope:"agent"` on the wire does NOT imply
            // "this compensates for the model currently running" in that (unconfigured) deployment.
            // Without `modelTag` visible, an agent has no way to notice it just received a stale
            // compensation for a DIFFERENT model — the exact non-derivability class whitespace
            // reasonMissing was fixed for, and both fields are fixed-size (an enum, a short model
            // identifier), so the token-budget argument that justified dropping unbounded prose
            // never applied to them. `origin` always present (never null); `modelTag` omitted when
            // null (domain scope) — matching this response's existing null-vs-omit convention
            // (`body`/`stage`/`projectedFromPrincipleId` are all omit-when-absent, never
            // serialized as an explicit `null`).
            origin: rule.origin,
            ...(rule.modelTag !== null ? { modelTag: rule.modelTag } : {}),
            ...(bodyClip ? { body: bodyClip.text } : {}),
            ...(rule.projectedFromPrincipleId !== undefined ? { projectedFromPrincipleId: rule.projectedFromPrincipleId } : {}),
            // FIRE-TIME DOUBT DISCLOSURE (slice 5-B, D5) — present (always `true`) only when one of
            // this rule's derivation parents is currently disputed. The named
            // `projectedFromPrincipleId` just above is the earliest stable display parent and need
            // not be the disputed one; lifecycle-edge reads carry the full parent identities. Same
            // omit-when-absent discipline as every optional field on this response, and for a
            // stronger reason than budget: `false` on every rule of every lookup would be the
            // resident cost with none of the signal. Disclosure only — this rule still delivers, at
            // its own severity, on its own evidence.
            ...(rule.parentDisputed ? { parentDisputed: true } : {}),
            // The recovery path the flag advertises (review fix — PR #112 round 2): the ids of the
            // disputed parent(s), present exactly when the flag is, so a caller can memory_fetch
            // the principle under impeachment instead of being told to read edges no MCP tool
            // exposes. Rare-state-only: the common case pays nothing.
            ...(rule.disputedParentIds !== undefined ? { disputedParentIds: rule.disputedParentIds } : {}),
            ...(rule.disputedParentsTruncated ? { disputedParentsTruncated: true } : {}),
          };
          const candidate = [...fitRules, candidateRule];
          const serialized = JSON.stringify({ ...fixedFields, rules: candidate }, null, 2);
          if (serialized.length > sizeBudget) break;
          fitRules.push(candidateRule);
        }
        // HONEST TOTAL (review fix — Codex round 2): `r.rulesTotal`, when present, means the SQL
        // retrieval itself was capped — `r.rules.length` alone would understate how many rules
        // truly exist, not just how many the wire chose to show. Absent means `r.rules.length` IS
        // the whole truth, exactly as before this fix (see StageLookupResult's own comment).
        const rulesTotal = r.rulesTotal ?? r.rules.length;
        const rulesOmittedCount = rulesTotal - fitRules.length;

        // RECOVERY FOR OMITTED RULES (review fix): `rulesOmitted: K` alone is disclosure without
        // repair — the caller cannot memory_fetch a rule it cannot name. Three-tier degradation,
        // each tier fit against the SAME remaining budget as everything above (so recovering never
        // itself reopens the ceiling this whole handler exists to respect) and each tier explicitly
        // signaled via `omittedRulesDetail` so the caller never has to guess which shape it got:
        //   1. "outline"       — {conceptId, text} per omitted rule (tiny: a uuid + an ≤80-char
        //                         title) — memory_fetch(conceptId) is the actual recovery path.
        //   2. "ids"           — conceptId only, when not even one outline entry fits.
        //   3. "count-only"    — nothing beyond `rulesOmitted` itself fits (the pre-fix shape).
        // "-partial" variants mean the tier itself had to stop before naming every omitted rule.
        //
        // CANDIDATES COME FROM TWO SOURCES (review fix — Codex round 2, now that retrieval itself
        // can be capped): rules the primary fetch DID retrieve but this handler's own size-fit
        // above did not show (`r.rules.slice(fitRules.length)`), and — only when SQL capped
        // retrieval — rules the primary fetch never even retrieved, named instead by the engine's
        // compact `r.rulesOutline` projection (gates.ts's `ruleOutlineForStage`). Both are projected
        // down to the SAME {conceptId, text} shape up front so the ladder logic below stays single.
        //
        // "-partial" IS JUDGED AGAINST `rulesOmittedCount` (the TRUE omitted total), NOT against
        // `omittedRules.length` (the candidate pool size) — `rulesOutline` can itself already be
        // short of the true total (it has its own STAGE_LOOKUP_OUTLINE_CAP at the engine level), so
        // comparing only to the candidate pool would silently call a pool that was ALREADY
        // incomplete "outline" (fully covered) instead of "outline-partial".
        let omittedRulesFields: Record<string, unknown> = {};
        if (rulesOmittedCount > 0) {
          const withinPrimaryOutline = r.rules.slice(fitRules.length).map((rule) => ({ conceptId: rule.conceptId, text: rule.text }));
          const beyondPrimaryOutline = r.rulesOutline ?? [];
          const omittedRules = [...withinPrimaryOutline, ...beyondPrimaryOutline];
          const envelopeSoFar = { ...fixedFields, rules: fitRules, rulesTruncated: true, rulesOmitted: rulesOmittedCount };

          const outlineCandidates = omittedRules.slice(0, STAGE_LOOKUP_OUTLINE_CAP);
          const fittedOutline: Array<{ conceptId: string; text: string }> = [];
          for (const entry of outlineCandidates) {
            const candidate = [...fittedOutline, entry];
            const serialized = JSON.stringify({ ...envelopeSoFar, omittedRules: candidate }, null, 2);
            if (serialized.length > sizeBudget) break;
            fittedOutline.push(entry);
          }

          if (fittedOutline.length > 0) {
            omittedRulesFields = {
              omittedRules: fittedOutline,
              omittedRulesDetail: fittedOutline.length < rulesOmittedCount ? "outline-partial" : "outline",
            };
          } else {
            const idCandidates = omittedRules.slice(0, STAGE_LOOKUP_OUTLINE_CAP).map((rule) => rule.conceptId);
            const fittedIds: string[] = [];
            for (const id of idCandidates) {
              const candidate = [...fittedIds, id];
              const serialized = JSON.stringify({ ...envelopeSoFar, omittedRuleIds: candidate }, null, 2);
              if (serialized.length > sizeBudget) break;
              fittedIds.push(id);
            }
            omittedRulesFields = fittedIds.length > 0
              ? { omittedRuleIds: fittedIds, omittedRulesDetail: fittedIds.length < rulesOmittedCount ? "ids-partial" : "ids" }
              : { omittedRulesDetail: "count-only" };
          }
        }

        // SIZE-FIT #2: the stage index (review fix — Codex round 1: the MISS path's stageIndex was
        // serialized unbounded, the same class as the rules/body blocker — stage creation imposes
        // no aggregate bound on how many stages, or STAGE_NAME_MAX_CHARS-worth of characters, a
        // store can accumulate). Fit against what's ACTUALLY left after rules + the recovery
        // fields above. Always a fast no-op on a HIT — r.stageIndex is undefined there.
        let stageIndexFit: { fitted: string[]; omitted: number } | null = null;
        if (r.stageIndex !== undefined) {
          const envelopeSoFar = { ...fixedFields, rules: fitRules, ...omittedRulesFields };
          const fit = fitStringArray(envelopeSoFar, "stageIndex", r.stageIndex, STAGE_INDEX_CAP, sizeBudget);
          // HONEST TOTAL (review fix — Codex round 3): `r.stageIndexTotal`, when present, means
          // liveStageIndex's OWN retrieval was capped — `r.stageIndex.length` alone would understate
          // how many live stages truly exist, not just how many the wire chose to show. Mirrors
          // `rulesTotal`'s exact reasoning; see StageLookupResult's own comment.
          const stageIndexTrueTotal = r.stageIndexTotal ?? r.stageIndex.length;
          stageIndexFit = { fitted: fit.fitted, omitted: stageIndexTrueTotal - fit.fitted.length };
        }

        return readOk({
          ...fixedFields,
          rules: fitRules,
          // EXPLICIT TRUNCATION SIGNAL: a caller must be able to tell "this stage really has only
          // N rules" from "there are more, and the response stopped early" — the same distinction
          // memory_fetch's outlineNote exists to carry. omittedRulesFields (above) is the recovery
          // path this signal used to point at nothing.
          ...(rulesOmittedCount > 0 ? { rulesTruncated: true, rulesOmitted: rulesOmittedCount, ...omittedRulesFields } : {}),
          ...(stageIndexFit ? {
            stageIndex: stageIndexFit.fitted,
            ...(stageIndexFit.omitted > 0 ? { stageIndexTruncated: true, stageIndexOmitted: stageIndexFit.omitted } : {}),
          } : {}),
        }, "stage_lookup", capturedBlock);
      } catch (e) {
        return err(`stage_lookup failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_synthesize",
    "Write back a synthesized body for a concept — you, the agent, are the synthesizer. Reconcile the concept's observations into one coherent statement. Clears the dirty flag and records a revision.",
    { id: z.string(), body: z.string(), circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional().describe("The circle the id belongs to (defaults to this session's circle).") },
    async ({ id, body, circle }) => {
      const capturedBlock = capturePrewarmSnapshot(scope(circle));
      try {
        if (core.circleOf(id) !== scope(circle)) return err(`concept not found: ${id}`); // scope enforcement
        const c = await core.applySynthesis(id, body);
        if (!c) return err(`concept not found: ${id}`);
        return mutOk({ id: c.id, circle: scope(circle), version: c.version, dirty: c.dirty, message: "synthesis stored" }, "memory_synthesize", capturedBlock);
      } catch (e) {
        return err(`synthesize failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_checkpoint",
    "End of session — preserve where you left off. Pass `workstream`: a COMPRESSED snapshot of this session (open questions, decisions, discarded alternatives, important entities/files, next steps) — many raw turns distilled into a few durable slots. It survives for a later continuation request through memory_workstreams. This call only preserves session state; synthesis is handled at read time.",
    {
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional(),
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
        const resolvedCircle = scope(circle);
        const saved = workstream ? await core.saveWorkstream(workstream, { circle: resolvedCircle, summary }) : null;
        return mutOk({
          circle: resolvedCircle,
          workstream: saved ? { id: saved.id, status: saved.payload.status, version: saved.version } : null,
        }, "memory_checkpoint", capturedBlock);
      } catch (e) {
        return err(`checkpoint failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_workstreams",
    "Pull active/paused workstreams ONLY when the user expresses continuation intent. For “let's continue”, call with no id to get the compact list, then confirm with the user which thread to resume. For “continue <X>”, list first; if exactly one confident match exists, call again with that id for full detail, otherwise confirm. Full detail pages entries in this fixed order: openQuestions, decisions, discardedAlternatives, confirmedContext, importantEntities, nextSteps; entries retain stored order within each slot. Start detailOffset at 0, then add the number of entries actually returned across all slots; detailOmitted is the true number remaining. A session opened with a fresh directive never calls this tool.",
    {
      id: z.string().optional().describe("Workstream id from the compact list. Omit to list active/paused workstreams."),
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional(),
      detailOffset: z.number().int().min(0).optional().describe("With id: skip this many entries in the documented cross-slot order. Start at 0; continue by adding the number of entries actually returned across all slots."),
    },
    async ({ id, circle, detailOffset }) => {
      const resolvedCircle = scope(circle);
      // A continuation pull must not re-inject session-start orientation. Passing an explicit empty
      // snapshot consumes auto-prewarm deterministically instead of falling through to wrapSuccess's
      // default-circle fallback (which would also ignore an explicit circle argument here).
      const suppressPrewarm = "";
      try {
        const workstreams = core.getActiveWorkstreams(resolvedCircle);
        if (id === undefined) {
          const items = workstreams.map((workstream) => ({
            id: workstream.id,
            title: workstream.title,
            status: workstream.payload.status,
          }));
          const sizeBudget = RESULT_MAX_CHARS - RESULT_TRUNCATE_NOTE.length;
          const envelope = (fitted: typeof items, omitted: number): Record<string, unknown> => ({
            workstreams: fitted,
            ...(omitted > 0 ? { workstreamsTruncated: true, workstreamsOmitted: omitted } : {}),
          });
          const fit = fitObjectArray(envelope, items, sizeBudget);
          if (items.length > 0 && fit.fitted.length === 0) {
            return readOk({
              workstreams: [],
              workstreamsTruncated: true,
              workstreamsOmitted: items.length,
            }, "memory_workstreams", suppressPrewarm);
          }
          return readOk(envelope(fit.fitted, fit.omitted), "memory_workstreams", suppressPrewarm);
        }

        const workstream = workstreams.find((candidate) => candidate.id === id);
        if (!workstream) return err(`workstream not found: ${id}`);
        const arraySlots = [
          "openQuestions",
          "decisions",
          "discardedAlternatives",
          "confirmedContext",
          "importantEntities",
          "nextSteps",
        ] as const;
        type ArraySlot = typeof arraySlots[number];
        type DetailEntry = { slot: ArraySlot; value: string };
        const allEntries: DetailEntry[] = arraySlots.flatMap((slot) =>
          (workstream.payload[slot] ?? []).map((value) => ({ slot, value })),
        );
        const offsetRequested = detailOffset !== undefined;
        const offset = Math.min(detailOffset ?? 0, allEntries.length);
        const remaining = allEntries.slice(offset);
        const sizeBudget = RESULT_MAX_CHARS - RESULT_TRUNCATE_NOTE.length;
        const buildDetail = (
          entries: DetailEntry[],
          valueClipped: boolean,
        ): Record<string, unknown> => {
          const grouped = new Map<ArraySlot, string[]>();
          for (const entry of entries) {
            const values = grouped.get(entry.slot) ?? [];
            values.push(entry.value);
            grouped.set(entry.slot, values);
          }
          const omitted = allEntries.length - offset - entries.length;
          return {
            id: workstream.id,
            title: workstream.title,
            status: workstream.payload.status,
            ...Object.fromEntries(arraySlots.flatMap((slot) => {
              const values = grouped.get(slot);
              return values === undefined ? [] : [[slot, values]];
            })),
            ...(workstream.payload.lastSessionId !== undefined
              ? { lastSessionId: workstream.payload.lastSessionId }
              : {}),
            ...(offsetRequested || omitted > 0 || valueClipped ? { detailOffset: offset } : {}),
            ...(omitted > 0 || valueClipped ? {
              detailTruncated: true,
              ...(omitted > 0 ? { detailOmitted: omitted } : {}),
              ...(valueClipped ? { detailValuesClipped: true } : {}),
            } : {}),
          };
        };
        const fitted: DetailEntry[] = [];
        for (const entry of remaining) {
          const candidate = [...fitted, entry];
          if (JSON.stringify(buildDetail(candidate, false), null, 2).length > sizeBudget) break;
          fitted.push(entry);
        }
        if (remaining.length > 0 && fitted.length === 0) {
          // A page can never be a recovery dead end. Clip the single entry against the COMPLETE
          // response envelope, then return it alone; only a value larger than the whole budget loses
          // bytes, and advancing by one reaches the next deterministic entry.
          const first = remaining[0]!;
          let low = 0;
          let high = first.value.length;
          while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            const candidate = { ...first, value: first.value.slice(0, mid) };
            if (JSON.stringify(buildDetail([candidate], mid < first.value.length), null, 2).length <= sizeBudget) low = mid;
            else high = mid - 1;
          }
          const valueClipped = low < first.value.length;
          let clippedValue = first.value;
          if (valueClipped) {
            let prefixLength = low;
            do {
              clippedValue = `${first.value.slice(0, prefixLength)}\n…[truncated ${first.value.length - prefixLength} chars]`;
              if (JSON.stringify(buildDetail([{ ...first, value: clippedValue }], true), null, 2).length <= sizeBudget) break;
              prefixLength--;
            } while (prefixLength >= 0);
          }
          return readOk(buildDetail([{ ...first, value: clippedValue }], valueClipped), "memory_workstreams", suppressPrewarm);
        }
        return readOk(buildDetail(fitted, false), "memory_workstreams", suppressPrewarm);
      } catch (e) {
        return err(`workstreams failed: ${msg(e)}`);
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
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional().describe("The circle the conceptId belongs to (defaults to this session's circle)."),
    },
    async ({ conceptId, detail, observationId, kind, circle }) => {
      const capturedBlock = capturePrewarmSnapshot(scope(circle));
      try {
        if (core.circleOf(conceptId) !== scope(circle)) return err(`concept not found: ${conceptId}`); // scope enforcement
        const c = core.flagContradiction(conceptId, { detail, observationId, kind });
        return mutOk({ circle: scope(circle), contradictionId: c.id, conceptId: c.conceptId, status: c.status, detail: c.detail }, "memory_flag_contradiction", capturedBlock);
      } catch (e) {
        return err(`flag failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_resolve",
    "Mediate a contradiction OR dismiss a flagged pair (possible-duplicate OR extraction-candidate) — two verdict families, one tool. " +
    "CONTRADICTION VERDICT: pass `contradictionId` + `decision` ('accept-new' / 'keep-current' / 'dismiss'). " +
    "accept-new: the correcting evidence wins; keep-current: the prior wins; dismiss: not a real conflict. " +
    "WHAT GETS SUPERSEDED: pass `contradictedObservationId` to name the observation the correction contradicted — you already have the evidence in front of you at this point, so a name given HERE is not a guess. accept-new then supersedes EXACTLY that observation (successor: the correcting observation), no matter how many other live observations the concept holds. keep-current records it as the prior being kept; it does not change what gets superseded (the correction is still retired with no successor — see below). The name is validated: it must exist, belong to the same concept as the contradiction, be live (not already superseded), predate the correcting observation (a later observation was never in dispute with it — naming one is refused, not silently accepted), and not be the correcting observation itself. It also requires the contradiction to actually HAVE a correcting observation — a bare contradiction (flagged without one, e.g. via memory_flag_contradiction with no observationId) contradicted nothing, so naming a loser for it is refused for every decision, not only accept-new. " +
    "Omit `contradictedObservationId` and the conservative fallback applies, because nothing else records WHICH prior a correction contradicted: accept-new supersedes the single prior ONLY when exactly one live observation predates the correction; with several it supersedes NOTHING and REQUIRES `body`, which is then the only record of the verdict — the contradicted claim stays live evidence INDEFINITELY — nothing retires it automatically (memory_synthesize only rewrites the body), so it keeps contributing to support and the concept embedding until something explicitly supersedes or detaches it. keep-current (named or not) retires the correction terminally, naming no successor. For accept/keep, pass the reconciled `body`. The concept restores to active once no conflicts remain. " +
    "PAIR-FLAG DISMISSAL: pass `conceptAId` + `conceptBId` (omit contradictionId/decision). " +
    "This is the exit for BOTH pair flags memory_overview surfaces — possibleDuplicates (\"are these one thing?\") and extractionCandidates (\"do these two rules share one reason?\"). " +
    "ONE DISMISSAL ANSWERS BOTH: asserting that these two concepts are unrelated retires every flag between them, so the pair leaves possibleDuplicates AND extractionCandidates together and survives any future detach/rederive cycle. That is deliberate, not a limitation — a human saying \"these two are unrelated\" has answered both questions in one breath, and there is no per-flag argument to split them. If the two really are related in one sense but not the other, correct or detach them instead of dismissing. " +
    "Dismissing a pair with no live flag edge of either type succeeds idempotently with rowsUpdated: 0 (\"nothing to dismiss\" signal); rowsUpdated counts edge ROWS, and each flag is stored in both directions. " +
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
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional().describe("The circle the contradiction or concepts belong to (defaults to this session's circle)."),
      // Pair-flag dismissal fields (new in 0.6.0; widened from possible-duplicate only in 5-B).
      conceptAId: z.string().optional().describe("First concept of the flagged pair to dismiss — a possible-duplicate pair or an extraction-candidate pair, from memory_overview. Required for pair-flag dismissal; omit for contradiction verdicts."),
      conceptBId: z.string().optional().describe("Second concept of the flagged pair to dismiss — a possible-duplicate pair or an extraction-candidate pair, from memory_overview. One dismissal clears every flag between the two. Required for pair-flag dismissal; omit for contradiction verdicts."),
    },
    async ({ contradictionId, decision, body, contradictedObservationId, resolvedBy, circle, conceptAId, conceptBId }) => {
      const capturedBlock = capturePrewarmSnapshot(scope(circle));
      try {
        // --- Pair-flag dismissal path (possible-duplicate AND extraction-candidate) ---
        if (conceptAId !== undefined || conceptBId !== undefined) {
          if (!conceptAId || !conceptBId) return err("pair-flag dismissal requires both conceptAId and conceptBId");
          if (contradictionId !== undefined) return err("provide either contradictionId (contradiction verdict) or conceptAId+conceptBId (pair-flag dismissal), not both");
          // Reject contradiction-path-only fields: an agent passing `decision` or `body` alongside
          // conceptAId+conceptBId is attempting a contradiction verdict on a flagged pair, which
          // would silently hide the pair instead. Name the conflict and point at both valid shapes.
          if (decision !== undefined) return err("field 'decision' belongs to the contradiction verdict path (requires contradictionId); for pair-flag dismissal pass only conceptAId + conceptBId (and optionally resolvedBy/circle)");
          if (body !== undefined) return err("field 'body' belongs to the contradiction verdict path (requires contradictionId); for pair-flag dismissal pass only conceptAId + conceptBId (and optionally resolvedBy/circle)");
          if (contradictedObservationId !== undefined) return err("field 'contradictedObservationId' belongs to the contradiction verdict path (requires contradictionId); for pair-flag dismissal pass only conceptAId + conceptBId (and optionally resolvedBy/circle)");
          // Scope enforcement: both concepts must live in the caller-named circle.
          const circleA = core.circleOf(conceptAId);
          const circleB = core.circleOf(conceptBId);
          if (circleA === null) return err(`concept not found: ${conceptAId}`);
          if (circleB === null) return err(`concept not found: ${conceptBId}`);
          if (circleA !== scope(circle)) return err(`concept not found: ${conceptAId}`);
          if (circleB !== scope(circle)) return err(`concept not found: ${conceptBId}`);
          const r = core.dismissPossibleDuplicate(conceptAId, conceptBId, resolvedBy);
          if (!r.dismissed) return err(r.error);
          // RENAMED FROM "duplicate-pair-dismissed" (review fix — Codex 5-B round 1, F5). 5-B
          // widened the engine call to every PAIR_FLAG_EDGE_TYPE, so this one call now also retires
          // an extraction_candidate — and an action string naming only duplicates was the wire
          // reporting the wrong act, on the one field an agent logs and branches on. Renamed rather
          // than joined by a per-type list: every other `action` on this server is one short
          // past-tense phrase naming what happened (archived / unarchived / renamed / noop), and a
          // generic name that is always true stays inside that convention where a new
          // `dismissedFlagTypes` array would invent a shape nothing else here uses. Checked before
          // renaming: the exact string is asserted in two of this repo's own tests (updated with
          // this change) and nowhere else — no CLI, renderer, doc or persisted row reads it, and the
          // package is private and pre-1.0, so no external client contract depends on it.
          return mutOk({ circle: scope(circle), action: "pair-flags-dismissed", conceptAId, conceptBId, rowsUpdated: r.rowsUpdated }, "memory_resolve", capturedBlock);
        }
        // --- Contradiction verdict path (original, unchanged) ---
        if (!contradictionId) return err("contradictionId is required for contradiction verdicts");
        if (!decision) return err("decision is required for contradiction verdicts");
        if (core.circleOfContradiction(contradictionId) !== scope(circle)) return err(`contradiction not found: ${contradictionId}`); // scope enforcement
        const c = core.resolveContradiction(contradictionId, { decision, body, by: resolvedBy, contradictedObservationId });
        if (!c) return err(`contradiction not found: ${contradictionId}`);
        // Idempotent no-op: contradiction already resolved or dismissed — zero mutations occurred.
        if ("alreadyClosed" in c) return mutOk({ circle: scope(circle), contradictionId, alreadyClosed: true, contradictionStatus: c.contradictionStatus }, "memory_resolve", capturedBlock);
        return mutOk({ circle: scope(circle), conceptId: c.id, status: c.status, version: c.version, confidence: Number(c.confidence.toFixed(2)) }, "memory_resolve", capturedBlock);
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
        .max(CIRCLE_NAME_MAX_CHARS)
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
        }, "memory_detach", capturedBlock);
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
      toCircle: z.string().max(CIRCLE_NAME_MAX_CHARS).describe("The destination circle (e.g. the project's per-project circle)."),
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional().describe("The id's CURRENT circle (defaults to this session's circle). Pass \"default\" when migrating legacy unscoped memory."),
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
            }, "memory_reassign_circle", capturedBlock);
          }
          return mutOk({
            toCircle: r.toCircle,
            counts: totalCounts,
            results: mergedResults,
          }, "memory_reassign_circle", capturedBlock);
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
        }, "memory_reassign_circle", capturedBlock);
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
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional().describe("The circle to act on (rename/merge source, archive/unarchive target). Required for rename, merge, archive, unarchive."),
      to: z.string().max(CIRCLE_NAME_MAX_CHARS).optional().describe("Destination circle name for rename or merge."),
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
          return mutOk(response, "memory_circle_manage", capturedBlock);
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
          return mutOk(response, "memory_circle_manage", capturedBlock);
        }
        if (action === "archive") {
          if (!circle) return err("archive requires `circle`");
          core.archiveCircle(circle);
          const response: CircleArchiveResponse = { action: "archived", circle };
          return mutOk(response, "memory_circle_manage", capturedBlock);
        }
        if (action === "unarchive") {
          if (!circle) return err("unarchive requires `circle`");
          core.unarchiveCircle(circle);
          const response: CircleUnarchiveResponse = { action: "unarchived", circle };
          return mutOk(response, "memory_circle_manage", capturedBlock);
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
      try { return mutOk(await core.syncSource(sourceId, sourceAuthorizationContext), "source_sync", capturedBlock); }
      catch (e) { return err(`source_sync failed: ${sanitizeSourceError(e)}`); }
    },
  );

  server.tool(
    "agent_context",
    "Session-start orientation only. Call FIRST with no arguments. Returns the resolved `circle`; `resolvedFrom` appears when the requested circle was an alias. `stageIndex` (when present) names stages you can recognize; call stage_lookup(stage) for that moment's rules. Skeleton delivery has three states: absence means the standing files you already loaded are current; `mirrorStale` + `instruction` appears only when a standing file diverged and needs user-confirmed reconciliation; `skeleton` appears only for members not covered by a standing file.",
    { circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional() },
    async ({ circle }) => {
      const resolvedCircle = scope(circle);
      const state = core.prewarm(circle ?? dc);

      const {
        stageIndex: stageIndexFull,
        stageIndexTotal,
        skeleton,
        mirrorStale,
        instruction,
      } = state;

      const baseContentWithoutMirrorOrSkeleton = {
        circle: resolvedCircle,
        ...(state.resolvedFrom !== undefined ? { resolvedFrom: state.resolvedFrom } : {}),
      };
      const sizeBudget = RESULT_MAX_CHARS - RESULT_TRUNCATE_NOTE.length;
      const stageIndexItems = stageIndexFull?.slice(0, STAGE_INDEX_CAP);
      const stageIndexTrueTotal = stageIndexFull === undefined ? 0 : stageIndexTotal ?? stageIndexFull.length;
      type AgentContextFit = { mirrorCount: number; stageCount: number; skeletonCount: number };
      const buildContent = ({ mirrorCount, stageCount, skeletonCount }: AgentContextFit): Record<string, unknown> => {
        const fittedMirror = mirrorStale?.slice(0, mirrorCount);
        const mirrorOmitted = mirrorStale === undefined ? 0 : mirrorStale.length - mirrorCount;
        const fittedStages = stageIndexItems?.slice(0, stageCount);
        const stageOmitted = stageIndexFull === undefined ? 0 : stageIndexTrueTotal - stageCount;
        const fittedSkeleton = skeleton?.slice(0, skeletonCount);
        const skeletonOmitted = skeleton === undefined ? 0 : skeleton.length - skeletonCount;
        return {
          ...baseContentWithoutMirrorOrSkeleton,
          ...(fittedMirror !== undefined ? {
            mirrorStale: fittedMirror,
            instruction: instruction ?? MIRROR_STALE_INSTRUCTION,
            ...(mirrorOmitted > 0 ? { mirrorStaleTruncated: true, mirrorStaleOmitted: mirrorOmitted } : {}),
          } : {}),
          ...(fittedStages !== undefined ? {
            stageIndex: fittedStages,
            ...(stageOmitted > 0 ? { stageIndexTruncated: true, stageIndexOmitted: stageOmitted } : {}),
          } : {}),
          ...(fittedSkeleton !== undefined ? {
            skeleton: fittedSkeleton,
            ...(skeletonOmitted > 0 ? { skeletonTruncated: true, skeletonOmitted } : {}),
          } : {}),
        };
      };

      // One builder owns the complete final envelope. Preserve uncovered governing members first,
      // then stale-path detail, then the stage cue; every candidate includes all three arrays'
      // zero-item metadata, so no later signal can invalidate an earlier fit.
      const fit: AgentContextFit = { mirrorCount: 0, stageCount: 0, skeletonCount: 0 };
      const grow = (key: keyof AgentContextFit, total: number): void => {
        for (let count = 1; count <= total; count++) {
          const candidate = { ...fit, [key]: count };
          if (JSON.stringify(buildContent(candidate), null, 2).length > sizeBudget) break;
          fit[key] = count;
        }
      };
      grow("skeletonCount", skeleton?.length ?? 0);
      grow("mirrorCount", mirrorStale?.length ?? 0);
      grow("stageCount", stageIndexItems?.length ?? 0);
      const content = buildContent(fit);

      return wrapSuccess(ok(content), { toolName: "agent_context" });
    },
  );

  return server;
}

/**
 * Derive RegisterMonetCoreToolsOpts from environment variables.
 * Exported for testing — lets tests verify the env-var mapping without spawning a process.
 * MONET_NO_AUTOPREWARM=1  → autoPrewarm:false
 */
export function deriveOptsFromEnv(env: NodeJS.ProcessEnv = process.env): RegisterMonetCoreToolsOpts {
  const callerId = env.MONET_CALLER_ID;
  const projectId = env.MONET_PROJECT_ID;
  return {
    autoPrewarm: env.MONET_NO_AUTOPREWARM !== "1",
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
