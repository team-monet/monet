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
import { MonetCore, WorkstreamAddressRequiredError } from "./engine";
import type { MemoryOverview, MergeConceptResult, RetirementBlocker, RuleSuccession, SearchCard, StageView, WorkstreamItem } from "./engine";
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
 * Session lifecycle instructions surfaced to the host agent via McpServer's `instructions` option.
 *
 * CORRECTED 2026-08-03 (normative-hierarchy-2026-08-03.md §8, which required this before any code):
 * the old text closed with "End with memory_checkpoint... without it, session state is lost", and
 * that promise had stopped being true. Monet is the normative system of record; generic memory and
 * workstreams are ruled out, and a session-end ritual is exactly the shape §6 rejects — every record
 * Monet keeps is written by the mechanism that made it, at the moment it made it, riding an event
 * that already happens. An instruction demanding a closing ceremony taught every agent to believe a
 * mechanism that no longer exists, and to blame itself for state loss it never caused.
 *
 * THAT NOTE'S PREMISE WAS REVERSED; ITS CONCLUSION WAS NOT (#143, amended 2026-08-09 and
 * 2026-08-11). "Generic memory and workstreams are ruled out" is now true of nothing:
 * memory_workstreams, memory_checkpoint and generic recall were ruled KEPT on 2026-08-09, and on
 * 2026-08-11 baseline memory — store, recall, provenance, staleness, dedup, contradiction — was
 * ruled FIRST-CLASS rather than a concession, striking "remove generic memory" from the North Star
 * and retitling it. The paragraph below about pending REMOVALS went with them; there are none. What
 * survives untouched is why the closing ceremony went: a record written by the mechanism that made
 * it needs no ritual, and that holds however much Monet is ruled to hold.
 *
 * This text is re-sent on every request, so it is the most expensive standing surface Monet has:
 * it says what Monet IS and the two moments a session actually touches it, and stops. The tools
 * carry their own descriptions; restating them here would bill every turn for it.
 *
 * WHAT THE SENTENCE BELOW STILL OWES THE 2026-08-11 RULING, named rather than guessed at: it calls
 * Monet the normative system of record and gives memory_store a single trigger, "when a norm
 * changes". Under a first-class memory substrate both are narrower than what is ruled. The
 * replacement is deliberately not written here — #143 records the counterweight boundary that would
 * govern it (Monet is the authoritative home of what it holds, never a second copy of anything whose
 * home is code, a tracker, or a doc) as its own ruling, still being formulated. Guessing at that
 * boundary in the most expensive standing surface Monet has would bill every request until it was
 * corrected again. Correcting a comment costs nothing, which is why the stale premise above is
 * struck today and the sentence waits.
 */
export const MONET_SERVER_INSTRUCTIONS =
  "Monet is the normative system of record: principles, rules, and the records that back them — how a norm was born, how it entered, when it fired, and what it changed. "
  + "Start each project session with agent_context; when it names a stage you are about to act at, call stage_lookup first — the rules never travel with the index, so a stage you do not look up is a stage whose rules do not exist for you. "
  + "Recall with memory_search pointer cards, then memory_fetch content — a search that stops at the cards has recalled nothing. "
  + "Write with memory_store when something durable crosses the boundary: a norm change, or context with no artifact home; never a narrative summary of work whose artifact already exists. When the user states something meant to govern every session, memory_declare places it and memory_ratify records what admitted it — never on your own initiative. "
  + "Track the session's own work with memory_checkpoint as it happens: open the plan when a directive lands, inbox anything you notice that is not this work, and settle both with the user before you report completion. "
  + "Nothing is owed at session end: every record Monet keeps is written by the mechanism that made it, as it happens.";

// Bounds so a tool result never blows past the host's MCP tool-result token budget (a single big
// concept — long body + many observations — otherwise serializes to tens of thousands of chars and
// the host rejects it: "N chars … exceeds maximum allowed tokens"). memory_fetch is bounded at the
// source (below); ok() is the last-resort safety net for every tool (overview/agent_context).
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

/**
 * The declare-time firing test's finding, rendered for the one channel a caller cannot skim past
 * (monet-client#59, `normative-hierarchy-2026-08-03.md` §2).
 *
 * WHY THIS IS GUIDANCE AND NOT JUST AN ADVISORY ENTRY: the write went through — sovereignty, and
 * that is correct — so the only thing standing between the author and a gate that never fires is
 * whether they read this. A rule the user believes protects them and does not is the same class of
 * surprise as a silently removed deny, and the downgrade disclosure right beside this one already
 * settled how that class is handled: say it plainly, in band, at the moment it happens.
 *
 * Returns null when nothing fired, so an ordinary declaration reads exactly as it did before.
 */
function firingWarning(advisories: readonly { kind: string; message: string }[] | undefined): string | null {
  const inert = (advisories ?? []).filter((advisory) => advisory.kind === "pattern_never_matches");
  const mismatch = (advisories ?? []).filter((advisory) => advisory.kind === "pattern_matches_no_example");
  if (inert.length === 0 && mismatch.length === 0) return null;

  // TWO DIFFERENT FINDINGS, SAID DIFFERENTLY (Codex P2 on PR #144, and it was right). One wording
  // covered both and overstated the weaker one: a pattern that misses its example may still govern
  // other action contexts perfectly well, and telling the author it "governs nothing" invites them
  // to replace a good pattern when the EXAMPLE was the wrong thing. Only a pattern that seeds to an
  // empty token run is inert everywhere, and only that one gets the absolute claim.
  const parts: string[] = [];
  if (inert.length > 0) {
    parts.push(
      `PATTERN WILL NOT FIRE: it matches no action at all, so the gate it addresses is inert. It is ` +
        `written anyway — you declared it — but it governs nothing until the patterns are fixed. ` +
        `Tell the user plainly. ${inert.map((advisory) => advisory.message).join(" ")}`,
    );
  }
  if (mismatch.length > 0) {
    parts.push(
      `EXAMPLE MISMATCH: checked with the gate's own matcher, these patterns did not match the ` +
        `example you gave — so this gate would not have fired on the very action it was authored ` +
        `from. They may still match other actions; what is established is that the pattern and the ` +
        `example disagree, and one of the two is wrong. Tell the user plainly. ` +
        `${mismatch.map((advisory) => advisory.message).join(" ")}`,
    );
  }
  return parts.join(" ");
}

function fitRenderedPatternsForAck(patterns: readonly string[]): { items: string[]; omitted: number } {
  const fitted = patterns.slice(0, STAGE_ACK_PATTERNS_MAX)
    .map((pattern) => clip(pattern, STAGE_ACK_PATTERN_MAX_CHARS).text);
  return { items: fitted, omitted: patterns.length - fitted.length };
}

/**
 * Search cards are pointers, so their wire contract is deliberately smaller than the
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

/**
 * Render `retirementBlockers()`'s findings as the refusal an agent reads — EVERY blocker, each one
 * naming its own withdrawal path, because a caller that fixes one and retries into the next has
 * been told the truth twice and helped once. One formatter, shared by the single and batch paths of
 * memory_retire, so the two can never disagree about what a refusal says.
 */
function retirementRefusal(id: string, blockers: readonly RetirementBlocker[]): string {
  return `cannot retire ${id}: ${blockers
    // THE REMEDY CLAUSE IS OMITTED, NOT FILLED IN, when no withdrawal surface exists — a blocker
    // whose `withdrawVia` is absent says so in its own `detail`. Rendering "withdraw it through
    // <nothing available>" is how a refusal starts reading as an instruction that cannot be
    // followed, which is the round-1 finding this formatter now cannot reproduce.
    .map((blocker) => (blocker.withdrawVia ? `${blocker.detail} — withdraw it through ${blocker.withdrawVia}` : blocker.detail))
    .join("; ")}`;
}

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

  // Auto-prewarm serves agents that never call agent_context, so it needs parity with that surface's
  // open-work cue just as stageIndex does below. Counts only; detail remains intent-gated.
  const workstreams = core.getActiveWorkstreams(circle).length;
  const inboxItems = core.getWorkstreamInbox(circle)?.payload.items.filter((item) => item.state === "open").length ?? 0;
  if (workstreams > 0 || inboxItems > 0) {
    lowerLines.push(`open: ${workstreams} workstreams · ${inboxItems} inbox items`);
  }

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
  // MCP-process affinity for the last ordinary thread this process wrote or detail-read, per circle.
  // The inbox is deliberately never recorded here.
  const touchedWorkstreamByCircle = new Map<string, string>();
  const moveTouchedWorkstreamAffinity = (from: string, to: string): void => {
    // A no-op lifecycle call (self-merge, self-rename) must not destroy affinity: with from === to
    // the "destination already has a key" skip and the source delete are the SAME key (Codex round
    // 4 on #212).
    if (from === to) return;
    const touchedId = touchedWorkstreamByCircle.get(from);
    if (touchedId === undefined) return;
    if (!touchedWorkstreamByCircle.has(to)) touchedWorkstreamByCircle.set(to, touchedId);
    touchedWorkstreamByCircle.delete(from);
  };

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
    'Store durable knowledge. Similar evidence normally attaches to an existing concept; novel, incoherent, species-mismatched, or stage-mismatched evidence creates a concept. The acknowledgement returns `circle`, `action`, and `conceptId`; anomalous forks also return `resolutionMode` and `score`, flagged pairs add `nearMatchId`/`nearMatchScore`, and correction/rule outcomes add `contradiction`, `ruleSuccession`, or `extractionCandidate` only when present. Use `attachTo` only when identity is known, or `resolution="forceNew"` for known-distinct items. Use kind="correction" to challenge prior memory. Use kind="rule" with `rule`; stored rules are advisory because blocking severity is declaration-only in memory_declare. Synthesis happens later on explicit read.',
    {
      content: z
        .string()
        // No number here on purpose (Codex review, PR #134): enforcement reads the SELECTED model's
        // own window, which differs across the hub ids and local paths a custom install may pin, so
        // a figure baked into this description would be wrong for exactly those installs — telling
        // the agent to split when it need not, or not to when it must. The refusal carries the real
        // count and the real limit at the moment it fires, which is where a precise number belongs.
        .describe(
          "One claim. Shorter is better: retrieval measures reliable well under the embedder's " +
            "window, and longer content is both harder to find and more likely to attach to the " +
            "wrong concept. Content past the window is refused outright — the remainder would be " +
            "stored yet absent from every vector — and the error names the exact limits. Several " +
            "claims in one observation is one blurred vector standing for all of them; store them " +
            "separately.",
        ),
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional(),
      kind: z
        .string()
        .optional()
        .describe(
          'Observation kind. Use "correction" when this challenges prior memory; a matching concept becomes disputed until memory_resolve mediates it. Use "procedure" for behavior and "preference" for style, voice, or format.',
        ),
      sourceRefs: z
        .array(z.string())
        .optional()
        .describe(
          "Pointers to the source, such as paths, URLs, tool calls, or concept/observation ids. Store pointers, not copied source content.",
        ),
      resolution: z
        .enum(["auto", "forceNew"])
        .optional()
        .describe(
          '"auto" (default) deduplicates similar evidence. "forceNew" always creates a concept; use only for known-distinct items.',
        ),
      attachTo: z
        .string()
        .optional()
        .describe(
          'Known concept id to attach to directly. It must share the circle. Mutually exclusive with resolution="forceNew".',
        ),
      rule: z
        .object({
          stage: z
            .string()
            .max(STAGE_NAME_MAX_CHARS)
            .describe(
              "Stage name or id where the rule fires. A missing stage is created.",
            ),
          instance: z
            .string()
            .optional()
            .describe(
              'Concrete action that failed, such as "Bash:git push --force origin main". Seeds a new stage pattern.',
            ),
          scope: z
            .enum(["domain", "agent"])
            .optional()
            .describe(
              '"domain" describes reality even for a perfect agent. "agent" (default) compensates for this model. When uncertain use "agent": a wrong agent tag only re-verifies later; a wrong domain tag binds later models.',
            ),
          modelTag: z
            .string()
            .max(MODEL_TAG_MAX_CHARS)
            .optional()
            .describe('Model compensated for. Required for agent scope unless MONET_MODEL_TAG supplies it.'),
          reason: z
            .string()
            .optional()
            .describe("One line naming the failure this prevents; shown when the gate fires."),
          projectedFromPrincipleId: z
            .string()
            .optional()
            .describe(
              'Ratified, active, undisputed same-circle principle that implies this rule at an empty gate. Preferences cannot parent rules. The derivation is disclosed when the rule fires. Projected rules stay advisory and do not count as extraction evidence.',
            ),
        })
        .optional()
        .describe(
          'Required for kind="rule". Binds an advisory rule to its stage. Only memory_declare can create blocking rules.',
        ),
    },
    async ({ content, circle, kind, sourceRefs, resolution, attachTo, rule }) => {
      // Budget check FIRST — ahead of the snapshot below, which reads the store. Content the
      // embedder cannot fully read is refused before this call costs a query, and the message tells
      // the caller how to succeed on the retry (see ContentExceedsEmbedderWindowError). core.store()
      // enforces the same rule for non-MCP callers; this placement only makes the failure cheaper.
      try {
        core.assertEmbedderReadsScript(content);
        await core.assertWithinEmbedderWindow(content);
      } catch (e) {
        return err(msg(e));
      }
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
    'Declare a user-authorized rule, stage, principle, or preference. Never call on agent initiative. This is the only tool that may create blocking rules or replace a rule binding. Stages address gates; rules bind content to stages. Principles and preferences enter the always-on skeleton without stage, severity, or patterns; mechanical concerns return as non-blocking `advisories`. Skeleton changes include `instruction` only when a registered standing surface became stale. A permissive standing grant is a rule, not another species.',
    {
      species: z
        .enum(["rule", "stage", "principle", "preference"])
        .describe('"stage" creates or re-authors a gate; "rule" binds to a stage; "principle"/"preference" enter the momentless skeleton.'),
      stage: z
        .string()
        .max(STAGE_NAME_MAX_CHARS)
        .optional()
        .describe('Gate stage name or id. Required for "rule"/"stage"; omit for momentless "principle"/"preference".'),
      content: z.string().optional().describe("Declaration text. Required for rule, principle, and preference; omit for stage."),
      exitsEvidence: z
        .string()
        .optional()
        .describe(
          'For principle/preference: evidence that would disprove it. Omission advises but never blocks.',
        ),
      patterns: z
        .array(z.string())
        .optional()
        .describe(
          'Concrete command shapes, such as ["terraform apply", "Bash:git push --force"]. Replaces all existing patterns; [] disables firing. Omit to preserve them. Words match in order; an optional tool prefix constrains the tool.',
        ),
      instance: z
        .string()
        .optional()
        .describe("Concrete action used to seed a new stage when patterns are omitted."),
      severity: z
        .enum(["advisory", "blocking"])
        .optional()
        .describe(
          'Pass only when the user rules on enforcement. Omit to preserve existing severity or default a new rule to advisory. "blocking" denies the action and is for safety boundaries. Changing blocking to advisory removes the deny and is disclosed.',
        ),
      acknowledgeBlockingRules: z
        .array(z.string())
        .optional()
        .describe(
          "When replacing patterns on a stage with blocking rules, list every blocking rule id after showing the user any ids reported missing.",
        ),
      scope: z.enum(["domain", "agent"]).optional().describe('"domain" binds any agent; "agent" (default) compensates for this model.'),
      modelTag: z.string().max(MODEL_TAG_MAX_CHARS).optional().describe('Model compensated for. Required for agent scope unless MONET_MODEL_TAG supplies it.'),
      reason: z.string().optional().describe('One-line failure prevented, shown at the gate. Required for blocking severity; ask the user rather than inventing it.'),
      // Bounded like memberRuleIds and ratifiedBy: this lands verbatim in fixed response fields and
      // overview skeleton entries, which are not size-fitted — an actor "name" is never a document.
      declaredBy: z.string().max(200).optional().describe("Ruling actor; defaults to caller id."),
      circle: z
        .string()
        .max(CIRCLE_NAME_MAX_CHARS)
        .optional()
        .describe(
          'Home circle; omit for default. "*" gives a rule/principle/preference global delivery while retaining its home circle. Invalid for store-global stages.',
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
              ...(r.advisories && r.advisories.length > 0 ? { advisories: r.advisories } : {}),
              guidance: firingWarning(r.advisories) ?? guidance,
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
              // THE DECLARE-TIME FIRING TEST (monet-client#59). Same discipline, one axis over: a
              // rule that will never fire is a rule the user believes is protecting them and is
              // not — which is the same class of surprise as a silently removed deny, and belongs
              // on the same loud channel rather than in an advisories array a caller may not read.
              firingWarning(r.advisories),
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
    'Record a human verdict on a principle or preference candidate after conversational review against the skeleton battery (Generates/Covers/Transfers/Exits). Approve/re-ratify enters the candidate in the skeleton and can link generated rules; reject keeps it out; retire ends current membership. The latest verdict governs membership, while every verdict remains in history. `packet` preserves exactly what the human saw. Name `entrance` so the record can later say whether anything gated this entry: "extraction" requires `battery` (all four gates answered), "declaration" forbids it because sovereignty replaced the test. Membership changes include `instruction` only when a registered standing surface became stale.',
    {
      candidateId: z.string().describe("Same-circle principle or preference concept id."),
      verdict: z
        .enum(["approve", "reject", "retire", "re-ratify"])
        .describe('"approve"/"re-ratify" enters; "reject" keeps out; "retire" ends current membership.'),
      memberRuleIds: z
        .array(z.string())
        // Bounded because the response echoes every id back as edgeIds, a fixed (un-fittable)
        // field: ~890 ids push the finished payload past the result ceiling into a mid-JSON
        // slice (recheck finding 2). 200 is far beyond any real principle's membership.
        .max(200)
        .optional()
        .describe(
          'Same-circle rule ids generated by a principle. Linked only for approve/re-ratify; invalid for preferences.',
        ),
      packet: z
        .unknown()
        .optional()
        .describe(
          "Evidence shown to the human, stored verbatim and never parsed for decisions.",
        ),
      entrance: z
        .enum(["extraction", "declaration"])
        .optional()
        .describe(
          'How this ruling was reached. "extraction" means the four-gate battery ran and must carry ' +
            '`battery`; "declaration" means sovereignty replaced the battery and must NOT carry one. ' +
            "Omit only when you genuinely do not know — it records as unknown rather than guessing, " +
            "and unknown is what makes a skeleton entry unauditable later.",
        ),
      battery: z
        .array(
          z.object({
            gate: z.enum(["generates", "covers", "transfers", "exits"]),
            passed: z.boolean(),
            evidenceRef: z.string().max(500).optional(),
          }),
        )
        .optional()
        .describe(
          "All four gates' answers, required with entrance=\"extraction\". evidenceRef points at " +
            "evidence (concept id, path, URL) — never copied content. Refused if a gate is missing: " +
            "the record must be able to say WHICH gate decided, not just that something did.",
        ),
      ratifiedBy: z.string().max(200).optional().describe("Ruling actor; defaults to caller id."),
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional().describe("Candidate's circle; omit for default."),
    },
    async ({ candidateId, verdict, memberRuleIds, packet, entrance, battery, ratifiedBy, circle }) => {
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
          // Typed and explicit, NOT parsed back out of `packet` — same decided deviation
          // memberRuleIds already follows: a decision must never depend on reading the packet,
          // which stays opaque-verbatim for audit fidelity (monet-core#142).
          entrance,
          battery,
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
    "Find memories by similarity. Returns ranked pointer cards, not content; call memory_fetch with a card's id and non-default circle to read it. Omit circle for store-wide search. Empty results mean no match.",
    {
      query: z.string(),
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional().describe("Restrict to one circle; omit for all. Cards include their home circle."),
      limit: z.number().int().positive().optional(),
    },
    async ({ query, circle, limit }) => {
      // Refused before the snapshot below, which reads the store — the same placement memory_store
      // uses, and for the same reason: counting tokens needs no database and no model load, so a
      // query the embedder cannot fully read costs nothing to reject (#137).
      try {
        core.assertEmbedderReadsScript(query, "query");
        await core.assertWithinEmbedderWindow(query, "query");
      } catch (e) {
        return err(msg(e));
      }
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
    "Read-only curation workbench for one circle: compact counts, livingModel cards, bounded queues for possibleDuplicates, extractionCandidates, openContradictions and gate exceptions, plus the ratified skeleton. Opt into dirty or stale worklists; truncation fields report omissions. It never returns bodies: memory_fetch an id, use memory_resolve for contradictions or pair flags, and memory_detach with destConceptId to consolidate a duplicate. Pass entity to list one hub's memories.",
    {
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional(),
      entity: z.string().optional(),
      conceptLimit: z.number().int().min(0).optional().describe("Living-model card limit; default 5."),
      includeDirty: z.boolean().optional().describe("Include the bounded pending-synthesis worklist."),
      includeStale: z.boolean().optional().describe("Include the bounded re-confirmation worklist."),
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
    "List one circle's memories as structural cards, never bodies; use memory_fetch to read one. Returns up to `limit` plus `nextCursor`; pass that as `cursor` until absent. Keyset pagination stays valid while earlier pages are reassigned. Use `withProvenance` to group memories by evidence paths, then memory_reassign_circle to migrate them.",
    {
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional(),
      withProvenance: z
        .boolean()
        .optional()
        .describe("Include distinct working-directory paths recorded for each memory's evidence."),
      limit: z.number().int().positive().max(200).optional().describe("Page size; default 50, maximum 200."),
      cursor: z.string().optional().describe("Prior `nextCursor`; omit for the first page."),
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
    "memory_fetch",
    "Read a concept by id. Normal concepts return `body` and `observationCount`; evidence appears only with observations:true as newest-first pages. If `needsSynthesis:true`, pull every page, reconcile one body, then call memory_synthesize. `bodyTruncated` means recover from observations. A disputed concept adds `status` and `openContradictions`; mediate with memory_resolve({ contradictionId: openContradictions[i].id }). Source concepts instead return title, sourcePath/sourceId, and outline; includeBody:true adds the concatenated file body.",
    {
      id: z.string(),
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional().describe("Expected home circle. Omit for store-wide id lookup; the response includes the home circle."),
      observations: z.boolean().optional().describe("Normal concepts: include one newest-first evidence page. Default false; ignored for sources."),
      observationsOffset: z.number().int().min(0).optional().describe("With observations:true, skip this many newest entries. Start at 0. Advance by observations.length, especially when observationsOmitted appears."),
      includeBody: z.boolean().optional().describe("Source concepts: include the concatenated file body. Default false; ignored for normal concepts."),
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
    "At a stage named by agent_context, fetch its rules before acting. A hit returns bounded rules with reasons and omission recovery fields. `parentDisputed:true` means `disputedParentIds` should be memory_fetched; projectedFromPrincipleId is only the display parent. A miss returns the live stage index.",
    {
      stage: z.string().max(STAGE_NAME_MAX_CHARS).describe("Stage name or id from agent_context/prewarm."),
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
    "Store one coherent body synthesized from all of a concept's observations. Clears `needsSynthesis` and records a revision.",
    { id: z.string(), body: z.string(), circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional().describe("Concept's circle; defaults to session circle.") },
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

  const checkpointDescription = "Track work and capture finds as they happen — nothing is owed at session end. When a work directive lands, open the plan: work-level items that may outlive the session (fine-grained decomposition stays in the host's own todo). When something surfaces that is not this work, `inbox` it — one line, keep moving. Before reporting completion, settle: close what resolved, and dispose the inbox with the user — do it now, `filed` with a `ref`, `dropped`, or leave open to keep. This MERGES: `open` adds, `close` resolves by id, anything unnamed stays untouched. Address a workstream by `title` (mints if new) or `id` (exact); with neither, the one this session already touched, or the only active one — several active means refusal with the list. The receipt is only what this call did: `opened`/`closed` item ids, `status` only when this call changed it.";
  const checkpointSchema = z.object({
    circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional(),
    inbox: z.string().min(1).optional(),
    workstream: z.object({
      id: z.string().optional(),
      // A title IS an address: displayed titles must replay through this field unchanged, so the
      // cap matches the stored-title budget — an over-long title would slug from the full text but
      // display clipped, and the clipped replay would mint a second thread (Codex round 4 on #212).
      // COUNTED IN CODE POINTS, like the engine cap and the renderer: `.max()` counts UTF-16 units,
      // which would refuse an astral title the engine stores and displays (Codex round 6).
      title: z.string().refine(
        (value) => [...value].length <= 80,
        { message: "a workstream title is an address — 80 characters or fewer" },
      ).optional(),
      status: z.enum(["active", "paused", "done"]).optional(),
      // Batch caps refuse BEFORE any mutation: the receipt promises every minted/closed item id,
      // and an unbounded batch would commit and then lose those ids to the generic size-fit
      // truncation — an unreturnable receipt is worse than a bounded input (Codex round 3 on #212).
      open: z.array(z.object({
        kind: z.enum(["question", "step"]),
        text: z.string().min(1),
      }).strict()).max(100, "open at most 100 items per checkpoint — split larger batches").optional(),
      close: z.array(z.object({
        id: z.string(),
        as: z.enum(["done", "dropped", "filed"]),
        // A ref is a pointer (URL, issue number), not a document: unbounded refs render verbatim
        // in includeClosed detail pages and can make an entry that no clipping fits.
        ref: z.string().max(2048, "a ref is a pointer — 2048 characters or fewer").optional(),
      }).strict().refine(
        (entry) => entry.as !== "filed" || (entry.ref !== undefined && entry.ref.trim().length > 0),
        { message: "filed requires a non-empty ref", path: ["ref"] },
      )).max(100, "close at most 100 items per checkpoint — split larger batches")
        .refine(
          (entries) => new Set(entries.map((entry) => entry.id)).size === entries.length,
          { message: "close lists each item id at most once — repeated ids would make the receipt overstate the effects" },
        ).optional(),
    }).strict().optional(),
  }).strict();

  // Deliberately the only tool using registerTool: the deprecated raw-shape overload cannot express
  // a top-level strict object, and removed keys such as `summary` must refuse rather than be stripped.
  // registerTool bypasses the server.tool in-flight patch above, so this one handler carries the
  // tracking explicitly — otherwise a shutdown arriving while the checkpoint awaits an embedding
  // observes zero tracked work and closes the core under it (Codex round 3 on #212).
  const trackedCheckpointHandler = <A, R>(handler: (args: A) => Promise<R>) => (args: A): Promise<R> => {
    inFlightTracker.increment();
    return handler(args).finally(() => inFlightTracker.decrement());
  };
  server.registerTool(
    "memory_checkpoint",
    { description: checkpointDescription, inputSchema: checkpointSchema },
    trackedCheckpointHandler(async ({ circle, inbox, workstream }) => {
      const capturedBlock = capturePrewarmSnapshot(scope(circle));
      try {
        const resolvedCircle = scope(circle);
        let workstreamInput = workstream;
        if (workstreamInput !== undefined && workstreamInput.id === undefined && workstreamInput.title === undefined) {
          const touchedId = touchedWorkstreamByCircle.get(resolvedCircle);
          if (touchedId !== undefined) {
            const touched = core.getWorkstreamById(touchedId, resolvedCircle);
            if (touched !== undefined && touched.payload.status !== "done") {
              workstreamInput = { ...workstreamInput, id: touchedId };
            } else {
              touchedWorkstreamByCircle.delete(resolvedCircle);
            }
          }
        }
        const engineWorkstreamInput = workstreamInput === undefined
          ? undefined
          : {
              ...workstreamInput,
              // Wire `kind` names the reader-facing species; engine `slot` remains the stored shape.
              open: workstreamInput.open?.map(({ kind, text }) => ({ slot: kind, text })),
            };
        // A combined call owes an all-or-refusal boundary for every DETERMINISTIC failure, not just
        // address ambiguity: the dry-run runs the save's full preparation (address, inbox shape,
        // merge validation, done-with-open-items) before captureFind mutates the inbox, so a
        // refusal cannot strand an unreturned find. Only embed-time and concurrent-writer failures
        // can still split the pair, and both are disclosed by the error the caller receives.
        if (inbox !== undefined && engineWorkstreamInput !== undefined) {
          core.previewWorkstreamCheckpoint(engineWorkstreamInput, { circle: resolvedCircle });
        }
        const inboxSaved = inbox !== undefined ? await core.captureFind(inbox, { circle: resolvedCircle }) : undefined;
        const saved = engineWorkstreamInput !== undefined
          ? await core.saveWorkstream(engineWorkstreamInput, { circle: resolvedCircle })
          : null;
        // A settle addressed at the reserved inbox reports under the INBOX receipt: the row's
        // physical UUID is deliberately unusable as an address (the read surface takes the
        // semantic "inbox" only), so returning it as a `workstream` would hand the caller an
        // address that resolves nowhere (Codex round 4 on #212).
        // Classify from the row the engine actually wrote, not from the pre-embed circle name: a
        // rename landing mid-call moves the write, and comparing against the stale name would
        // publish the inbox's unusable physical id as a thread address (Codex round 6 on #212).
        const savedIsInbox = saved !== null && saved.slug === `workstream:${saved.circle}::inbox`;
        if (saved !== null && !savedIsInbox) {
          touchedWorkstreamByCircle.set(saved.circle, saved.id);
        }
        const inboxReceipt = inboxSaved !== undefined || savedIsInbox
          ? {
              inbox: {
                ...(inboxSaved !== undefined ? { opened: [inboxSaved.itemId] } : {}),
                ...(savedIsInbox ? { closed: saved.closedItemIds } : {}),
              },
            }
          : {};
        return mutOk({
          // The circle the writes actually landed in — a mid-call rename moves them, and the
          // receipt names where the work IS, not where the request aimed.
          circle: saved?.circle ?? inboxSaved?.row.circle ?? resolvedCircle,
          ...(saved !== null && !savedIsInbox ? {
            workstream: {
              id: saved.id,
              title: saved.title,
              ...(saved.statusChanged ? { status: saved.payload.status } : {}),
              opened: saved.openedItemIds,
              closed: saved.closedItemIds,
            },
          } : {}),
          ...inboxReceipt,
        }, "memory_checkpoint", capturedBlock);
      } catch (e) {
        if (e instanceof WorkstreamAddressRequiredError) return err(e.message);
        return err(`checkpoint failed: ${msg(e)}`);
      }
    }),
  );

  server.tool(
    "memory_workstreams",
    "Two reads, two moments. Resume — on continuation intent only, never a fresh directive: omit `id` to list active/paused workstreams and confirm which to resume; then pass its `id` for detail — OPEN items only, questions first, each carrying the id `close` takes. Settle — `id: \"inbox\"` before reporting completion: every find awaiting disposition, this session's and every kept one. `closedCount` says how many resolved items exist without delivering them; `includeClosed` returns them with `state`, `closedAt`, and `ref` for the filed. Advance `detailOffset` by items actually returned; `detailOmitted` is the true remainder.",
    {
      id: z.string().optional().describe("Workstream id for detail; omit to list active/paused workstreams."),
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional(),
      detailOffset: z.number().int().min(0).optional().describe("With id, skip this many entries; advance by entries returned."),
      includeClosed: z.boolean().optional().describe("With id, also return done/dropped items. Off by default — the working set is the open ones."),
    },
    async ({ id, circle, detailOffset, includeClosed }) => {
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

        // Resolve the reserved semantic address before any UUID path. Inbox detail is deliberately
        // lifecycle-free and never enters session affinity.
        const inboxDetail = id === "inbox";
        const workstream = inboxDetail
          ? core.getWorkstreamInbox(resolvedCircle)
          : workstreams.find((candidate) => candidate.id === id)
            ?? (includeClosed ? core.getWorkstreamById(id, resolvedCircle) : undefined);
        if (!workstream) return err(`workstream not found: ${id}`);
        if (!inboxDetail) touchedWorkstreamByCircle.set(resolvedCircle, workstream.id);
        // OPEN BY DEFAULT, closed on request. A closed item is not deleted, it is not delivered —
        // which is what makes "was this finished, or dropped three checkpoints ago?" answerable at
        // all, while costing nothing on the turns nobody asks.
        type DetailEntry = { item: WorkstreamItem; value: string };
        const questionsFirst = (a: WorkstreamItem, b: WorkstreamItem): number =>
          a.slot === b.slot ? a.openedAt - b.openedAt : a.slot === "question" ? -1 : 1;
        const allEntries: DetailEntry[] = workstream.payload.items
          .filter((item) => (includeClosed ?? false) || item.state === "open")
          .sort(questionsFirst)
          .map((item) => ({ item, value: item.text }));
        const offsetRequested = detailOffset !== undefined;
        const offset = Math.min(detailOffset ?? 0, allEntries.length);
        const remaining = allEntries.slice(offset);
        const sizeBudget = RESULT_MAX_CHARS - RESULT_TRUNCATE_NOTE.length;
        const buildDetail = (
          entries: DetailEntry[],
          valueClipped: boolean,
        ): Record<string, unknown> => {
          const omitted = allEntries.length - offset - entries.length;
          const openCount = workstream.payload.items.filter((item) => item.state === "open").length;
          const closedCount = workstream.payload.items.length - openCount;
          return {
            id: inboxDetail ? "inbox" : workstream.id,
            ...(!inboxDetail ? { title: workstream.title, status: workstream.payload.status } : {}),
            ...(includeClosed ? { openCount, closedCount } : closedCount > 0 ? { closedCount } : {}),
            items: entries.map(({ item, value }) => ({
              id: item.id,
              ...(!inboxDetail && item.slot !== undefined ? { kind: item.slot } : {}),
              text: value,
              ...(item.state === "open" ? {} : {
                state: item.state,
                ...(includeClosed && item.closedAt !== undefined ? { closedAt: item.closedAt } : {}),
                ...(includeClosed && item.ref !== undefined ? { ref: item.ref } : {}),
              }),
            })),
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
    "Open a contradiction when stored memory conflicts with newer evidence. The concept becomes disputed until memory_resolve mediates it. Prefer memory_store kind=\"correction\" when also storing the correcting evidence.",
    {
      conceptId: z.string(),
      detail: z.string(),
      observationId: z.string().optional(),
      kind: z.enum(["value-conflict", "staleness", "scope-conflict"]).optional(),
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional().describe("Concept's circle; defaults to session circle."),
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
    "Mediate a contradiction or dismiss a flagged pair. CONTRADICTION: pass contradictionId, decision, and a reconciled body for accept-new/keep-current. accept-new keeps the correction; keep-current retires it; dismiss records no conflict. Name contradictedObservationId (a live, older, same-concept observation): on accept-new it is superseded exactly; on keep-current it is recorded as the kept prior while the correction is retired either way. Without it, accept-new supersedes only a sole older live observation; if several exist, none is retired and body is required. PAIR-FLAG DISMISSAL: pass conceptAId + conceptBId only. One dismissal clears both possible-duplicate and extraction-candidate flags between the pair; if only one relation is wrong, correct or detach instead. rowsUpdated:0 is an idempotent no-op.",
    {
      // Contradiction-resolution fields (existing — backward compatible).
      contradictionId: z.string().optional().describe("Contradiction to mediate; omit for pair dismissal."),
      decision: z.enum(["accept-new", "keep-current", "dismiss"]).optional().describe("Required contradiction verdict."),
      body: z.string().optional(),
      contradictedObservationId: z.string().optional().describe(
        "Exact prior observation challenged by the correction. It must be live, older, same-concept, and distinct from a real correcting observation. Omit for conservative fallback; invalid with dismiss.",
      ),
      resolvedBy: z.string().optional(),
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional().describe("Circle containing the contradiction or pair; defaults to the session circle."),
      // Pair-flag dismissal fields (new in 0.6.0; widened from possible-duplicate only in 5-B).
      conceptAId: z.string().optional().describe("First possible-duplicate or extraction-candidate concept from memory_overview. Required with conceptBId for pair dismissal."),
      conceptBId: z.string().optional().describe("Second possible-duplicate or extraction-candidate concept. Dismissal clears both flag types between the pair."),
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
    "Move observations out of a concept to undo a wrong merge. By default they form a new concept; destConceptId attaches them to an existing same-circle concept. The source is recomputed and marked for synthesis. Moving all observations into a destination deletes the source, consolidating a duplicate. Without a destination, at least one observation must remain; use memory_reassign_circle to move a whole concept across circles.",
    {
      conceptId: z.string().describe("Source concept."),
      observationIds: z.array(z.string()).min(1).describe("Observation ids from memory_fetch observations."),
      destConceptId: z
        .string()
        .optional()
        .describe(
          "Existing same-circle destination. If all observations move, the source is deleted.",
        ),
      circle: z
        .string()
        .max(CIRCLE_NAME_MAX_CHARS)
        .optional()
        .describe("Source concept's circle; defaults to the session circle."),
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
    "Move a concept, its observations, and graph membership to another circle. Pass exactly one of id or ids; batches are per-item atomic and report errors without aborting. `circle` is the current home. `auto` merges a destination match; `forceNew` keeps it distinct and flags a near match as possible_duplicate. Use this to home legacy default memory in its project circle.",
    {
      id: z.string().optional().describe("Single concept id; mutually exclusive with ids."),
      ids: z.array(z.string()).optional().describe("Batch concept ids; mutually exclusive with id."),
      toCircle: z.string().max(CIRCLE_NAME_MAX_CHARS).describe("Destination circle."),
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional().describe("Current circle; defaults to session circle. Use \"default\" for legacy unscoped memory."),
      resolution: z
        .enum(["auto", "forceNew"])
        .optional()
        .describe('"auto" (default when omitted) merges into a destination match, removing the source concept; "forceNew" keeps distinct and flags a near match — choose it when identity is uncertain.'),
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
          // OFF EACH RESULT, for the reason the single path states at length: this used to be a
          // pre-scan of `passIds` before the batch call, which is the identical stale-read window
          // one item at a time. `wasCircleLocalLiveDeny` is frozen inside each move's own
          // `BEGIN IMMEDIATE`. CIRCLE-LOCAL denies only — a breadth-bound deny keeps firing
          // everywhere after the move, so announcing that it "now denies only in X" would be a
          // false statement, not an over-disclosure; the engine's predicate is already the narrow
          // one, so that stays true here for free.
          //
          // NO `fromCircle` ON THESE ENTRIES (round 3), matching an instruction that has always said
          // "the circle it left" without naming one. The reservation freezes `wasCircleLocalLiveDeny`;
          // it does NOT freeze the origin, which `reassignCircle` reads off a `src` row fetched before
          // the transaction opens. Reproduced: a second connection moved the rule default→staging
          // during `bestMatches`, and the origin reported was `default` — a circle that had already
          // stopped firing and that this mutation did not empty, sitting beside a sentence that reads
          // as naming exactly the circle emptied. That stale-snapshot family is #197's; the disclosure
          // stops DEPENDING on the fact rather than pretending a frozen copy would have fixed it.
          const relocatedDenies = r.results
            .filter((res): res is Extract<typeof res, { conceptId: string }> =>
              res.action === "moved" && res.wasCircleLocalLiveDeny === true)
            .map((res) => ({ conceptId: res.conceptId }));
          // Present only when a deny actually moved — presence alone is the signal.
          const denyDisclosure = relocatedDenies.length > 0
            ? {
                deniesRelocated: {
                  rules: relocatedDenies,
                  instruction: relocatedDenies.length === 1
                    ? `DENY RELOCATED: this blocking rule no longer fires in the circle it left — it now denies only in ${r.toCircle}. Tell the user plainly.`
                    : `DENY RELOCATED: these ${relocatedDenies.length} blocking rules no longer fire in the circles they left — each now denies only in ${r.toCircle}. Tell the user plainly.`,
                },
              }
            : {};
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
            // `denyDisclosure` RIDES THE ELISION PATH TOO, deliberately. Eliding per-item successes
            // keeps a large response parseable; eliding the one field that says a deny stopped
            // firing somewhere would make a big batch the silent door a small batch is not.
            return mutOk({
              toCircle: r.toCircle,
              counts: totalCounts,
              errors: errorItems,
              ...denyDisclosure,
              note: `per-item results elided for ${mergedResults.length - errorItems.length} items — all non-error items succeeded with the actions in counts`,
            }, "memory_reassign_circle", capturedBlock);
          }
          return mutOk({
            toCircle: r.toCircle,
            counts: totalCounts,
            ...denyDisclosure,
            results: mergedResults,
          }, "memory_reassign_circle", capturedBlock);
        }

        // Single mode.
        // Scope enforcement: the caller may only reassign an id that lives in the circle they named.
        if (core.circleOf(id!) !== scope(circle)) return err(`concept not found: ${id}`);
        const r = core.reassignCircle(id!, toCircle, opts);
        if (!r) return err(`concept not found: ${id}`);
        // A DENY THAT STOPS FIRING SOMEWHERE IS NEVER SOMETHING THE USER FINDS OUT LATER — the same
        // discipline memory_declare's DENY REMOVED / BREADTH NARROWED disclosures carry, one axis
        // over. The move is legal (the deny keeps firing in the destination), which is exactly why
        // nothing else in this response would have mentioned it. A BREADTH-BOUND deny is silent
        // here on purpose: its binding does not travel with the concept, so it stops firing nowhere
        // and there is no severity news to carry.
        //
        // READ OFF THE RESULT, never asked here. The predicate used to be called just before
        // `reassignCircle`, which put the whole `bestMatches` scan between the answer and the move
        // it describes — and a second connection re-declaring the rule's severity inside that
        // window (a supported topology, storage.ts) made this line lie in both directions:
        // silent about a deny that had just become blocking, and — worse — announcing a deny in the
        // destination for a rule that had just become advisory, which is a mandatory disclosure
        // saying the opposite of the truth. `wasCircleLocalLiveDeny` is captured inside
        // reassignCircle's own `BEGIN IMMEDIATE`, so the sentence and the mutation share one fact.
        //
        // AND IT NAMES NO ORIGIN CIRCLE (round 3) — the same words the batch instruction has always
        // used, so both paths carry one wording. The origin is the one input the reservation does NOT
        // freeze: `reassignCircle` reads it off a `src` row fetched before the transaction opens, and
        // a second connection moving the rule default→staging during `bestMatches` made this line say
        // "no longer fires in default" about a circle that had already stopped firing, while the
        // circle this move actually emptied went unnamed. #197 owns that snapshot and its worse
        // consumers; the fix here is to stop depending on the fact, and "the circle it left" is
        // exactly as actionable and cannot go stale.
        const denyRelocated = r.wasCircleLocalLiveDeny && r.action === "moved"
          ? `DENY RELOCATED: this blocking rule no longer fires in the circle it left — it now denies only in ${r.toCircle}. Tell the user plainly. `
          : "";
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
                ? `${denyRelocated}Moved to ${r.toCircle}. It now lives in that circle — fetch/search it there.`
                : `Already in ${r.toCircle}; nothing to do.`,
        }, "memory_reassign_circle", capturedBlock);
      } catch (e) {
        return err(`reassign failed: ${msg(e)}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // memory_retire / memory_restore — the reversible end of a memory's lifecycle
  // -------------------------------------------------------------------------
  /** Same value and same reason as memory_reassign_circle's own copy: keep a big batch parseable. */
  const RETIRE_BATCH_INLINE_LIMIT = 25;
  /**
   * How much of a caller-supplied id an error echoes back (review fix — round 3).
   *
   * An id is a routing identifier, not prose — CIRCLE_NAME_MAX_CHARS' own sentence, applied to the
   * other caller-controlled value these two tools echo. `ids` was size-fitted in round 1, but the
   * SINGLE-id path returns through `err()`, which has no ceiling of its own the way `ok()` does: one
   * id longer than RESULT_MAX_CHARS produced a `CallToolResult` past the host's limit, so the caller
   * got a rejected or unusable response instead of "concept not found". Clipped at the SOURCE, in
   * `applyLifecycle`, so the batch's per-item errors are bounded by the same line rather than
   * relying on `fitObjectArray` to drop the whole item — an error that survives clipped says more
   * than one dropped whole.
   *
   * 128 rather than a tighter number: a concept id is a 36-char uuid, so this shows every real id in
   * full, and enough of an unreal one to recognize what was sent. Only the CALLER's own value is
   * clipped; an engine message reaching `msg(e)` is this codebase's own text, bounded by whoever
   * wrote it.
   */
  const LIFECYCLE_ERROR_ID_MAX_CHARS = 128;
  type LifecycleItem = { id: string; action: "retired" | "restored" | "error"; error?: string };

  /**
   * ONE ITEM OF EITHER ACT, so a batch is exactly its items and a single call is a batch of one.
   * Never throws: a blocked or failing item is a RESULT, which is what lets a batch report it
   * without aborting the items after it (memory_reassign_circle's own per-item contract).
   *
   * `action` REPORTS THE POST-STATE, and there is deliberately no "noop" member. retireConcept and
   * restoreConcept are idempotent and return the same concept whether or not they changed anything,
   * so "already retired" is not a distinction the engine offers this layer — and inventing one from
   * a second read would be a claim this surface cannot actually stand behind. That contract is what
   * makes an ALREADY-RETIRED concept a `retired` result rather than a refusal (review fix — round 2:
   * the blockers used to run first, so a batch retry or a replicated tombstone reported a declared
   * or ratified concept as an error for a retirement that had already happened).
   */
  const applyLifecycle = (id: string, callerCircle: string, act: "retire" | "restore"): LifecycleItem => {
    // SCOPE ENFORCEMENT, identical to memory_reassign_circle's: a caller may only touch an id that
    // lives in the circle they named, and one that does not reads as absent rather than forbidden.
    // Connector-owned rows are invisible to circleOf (it excludes kind='source', source_identity
    // and active_observation_id alike) without a source authorization context, so they are answered
    // here; retirementBlockers' connector clause is the same refusal for any caller that can see
    // the row at all, and restoreConcept throws its own.
    //
    // THE FAST-FAIL COPY, NOT THE ONE THAT HOLDS (review fix — round 2). The binding copy is inside
    // the engine's write reservation (`retireIfUnblocked` / `restoreIfInCircle`, whose comments
    // carry the window and the writers that fit through it); this one runs first so a batch's
    // missing and out-of-circle ids cost no transaction at all, and because it is the only check
    // that can answer before either act is chosen. Both copies produce the SAME sentence, so which
    // one fired is not something a caller can observe — the shape reassignCircle's own paired
    // archived-destination guards already use.
    // EVERY ECHO OF THE CALLER'S OWN ID BELOW IS THE CLIPPED ONE — see
    // LIFECYCLE_ERROR_ID_MAX_CHARS. The `id` FIELD of the item keeps the value verbatim, because
    // that is what a batch caller correlates its own list against; it is the size-fitted array's
    // problem, and it already has one.
    const shownId = clip(id, LIFECYCLE_ERROR_ID_MAX_CHARS).text;
    if (core.circleOf(id) !== callerCircle) return { id, action: "error", error: `concept not found: ${shownId}` };
    try {
      if (act === "restore") {
        // NO BLOCKER PASS ON THIS SIDE. Restoring returns a memory to the authority it already
        // entered on — nothing is being withdrawn — so the only refusal is connector ownership,
        // which restoreConcept itself raises (engine.ts) and which surfaces here as that error.
        return core.restoreIfInCircle(id, callerCircle).outcome === "restored"
          ? { id, action: "restored" }
          : { id, action: "error", error: `concept not found: ${shownId}` };
      }
      // ONE CALL, NOT THREE. `retireIfUnblocked` rechecks the caller's circle, evaluates the
      // blockers and retires under a single write reservation — see its own comment for the two
      // windows that asking them separately left open.
      const outcome = core.retireIfUnblocked(id, callerCircle);
      if (outcome.outcome === "blocked") return { id, action: "error", error: retirementRefusal(shownId, outcome.blockers) };
      // `not-in-circle` is every way the id is not this caller's — including one that became true
      // between the fast-fail above and the reservation — and it reads exactly as that fast-fail
      // does, deliberately.
      return outcome.outcome === "retired"
        ? { id, action: "retired" }
        : { id, action: "error", error: `concept not found: ${shownId}` };
    } catch (e) {
      return { id, action: "error", error: msg(e) };
    }
  };

  /**
   * The batch payload for either act — counts always, per-item results until they stop fitting.
   *
   * COUNTS SURVIVE EVERYTHING (review fix — round 1). `ids` is unbounded and every error echoes its
   * caller-supplied id verbatim, so a large batch of blocked or missing ids could serialize past
   * RESULT_MAX_CHARS — at which point `ok()` replaces the WHOLE payload with its generic truncation
   * object, losing `counts` and every per-item error AFTER the successful mutations had already
   * committed. The caller could not tell what had changed. Both variable-size arrays are now
   * size-fitted with `fitObjectArray` against the same ceiling and the same serialization `ok()`
   * measures, and `circle`/`counts`/`note` sit outside the fitted array, so the worst case is an
   * empty list beside an honest count of what was left out — never a payload that says nothing.
   */
  const lifecycleBatchPayload = (
    circle: string,
    results: LifecycleItem[],
    done: "retired" | "restored",
  ): Record<string, unknown> => {
    const errorItems = results.filter((item) => item.action === "error");
    const counts = { [done]: results.length - errorItems.length, error: errorItems.length };
    // When results are large, elide per-item successes to avoid a blind mid-JSON clip — every
    // ERROR still ships until the ceiling itself binds, because an elided refusal is a refusal the
    // caller never acts on, and `errorsOmitted` says exactly how many went unsaid.
    if (results.length > RETIRE_BATCH_INLINE_LIMIT) {
      const envelope = (fitted: LifecycleItem[], omitted: number): Record<string, unknown> => ({
        circle,
        counts,
        errors: fitted,
        ...(omitted > 0 ? { errorsTruncated: true, errorsOmitted: omitted } : {}),
        note: `per-item results elided for ${results.length - errorItems.length} items — every non-error item is ${done}`,
      });
      const fit = fitObjectArray(envelope, errorItems, RESULT_MAX_CHARS);
      return envelope(fit.fitted, fit.omitted);
    }
    // The small path is size-fitted too: RETIRE_BATCH_INLINE_LIMIT caps the item COUNT, and an id
    // carries no length bound, so 25 long ones reach the ceiling just as readily.
    const envelope = (fitted: LifecycleItem[], omitted: number): Record<string, unknown> => ({
      circle,
      counts,
      results: fitted,
      ...(omitted > 0 ? { resultsTruncated: true, resultsOmitted: omitted } : {}),
    });
    const fit = fitObjectArray(envelope, results, RESULT_MAX_CHARS);
    return envelope(fit.fitted, fit.omitted);
  };

  server.tool(
    "memory_retire",
    "Hide a memory: it leaves memory_search, memory_fetch, memory_list and the overview counts, its evidence untouched, and memory_restore brings it back — its graph re-derived from that evidence rather than replayed, so ordering and reinforcement history do not survive the round trip. Pass exactly one of id or ids; batches are per-item and report errors without aborting. `circle` is the concept's home. A memory leaves with the authority it entered on, so this refuses one that entered by declaration or by ratification, and one carrying an open contradiction or an undismissed duplicate/extraction pair flag — retiring those would end the question by making its subject vanish instead of answering it. Each refusal names the tool that withdraws that authority first, or says plainly when no surface does. Ordinary memories, and rules an agent stored itself, retire freely.",
    {
      id: z.string().optional().describe("Single concept id; mutually exclusive with ids."),
      ids: z.array(z.string()).optional().describe("Batch concept ids; mutually exclusive with id."),
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional().describe("Concept's circle; defaults to the session circle."),
    },
    async ({ id, ids, circle }) => {
      const capturedBlock = capturePrewarmSnapshot(scope(circle));
      try {
        if (id !== undefined && ids !== undefined) return err("provide exactly one of `id` or `ids`, not both");
        if (id === undefined && ids === undefined) return err("provide exactly one of `id` or `ids`");
        const callerCircle = scope(circle);
        if (ids !== undefined) {
          const results = ids.map((each) => applyLifecycle(each, callerCircle, "retire"));
          return mutOk(lifecycleBatchPayload(callerCircle, results, "retired"), "memory_retire", capturedBlock);
        }
        const single = applyLifecycle(id!, callerCircle, "retire");
        if (single.action === "error") return err(single.error!);
        return mutOk({
          circle: callerCircle,
          action: single.action,
          conceptId: id,
          // THE CIRCLE IS PART OF THE CALL (review fix — round 1). `memory_restore` scopes by
          // circle, so the bare `memory_restore("<id>")` this used to suggest answers
          // "concept not found" for every concept outside the session default — an instruction that
          // fails for exactly the caller who needed it. Same shape memory_reassign_circle's own
          // acknowledgement already uses for memory_fetch.
          //
          // AND BOTH ARGUMENTS ARE SERIALIZED, NEVER INTERPOLATED (review fix — round 2). A circle
          // name is only length-bounded (CIRCLE_NAME_MAX_CHARS) — no charset rule anywhere accepts
          // or rejects one — so a name carrying a quote, a backslash or a newline rendered a
          // malformed suggestion (`memory_restore("id", "project"x")`) that the caller cannot
          // replay, for exactly the caller who cannot guess the escaping either. JSON.stringify
          // emits a well-formed string literal for every name this tool accepts, and for a plain
          // name it is byte-identical to what the interpolation produced.
          message: `Retired. It is out of memory_search, memory_fetch, memory_list and the overview counts; memory_restore(${JSON.stringify(id)}, ${JSON.stringify(callerCircle)}) brings it back with its evidence intact.`,
        }, "memory_retire", capturedBlock);
      } catch (e) {
        return err(`retire failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_restore",
    "Undo memory_retire: a retired memory is searchable, fetchable, listed and counted again, and its graph is re-derived. Pass exactly one of id or ids; batches are per-item and report errors without aborting. `circle` is the concept's home.",
    {
      id: z.string().optional().describe("Single retired concept id; mutually exclusive with ids."),
      ids: z.array(z.string()).optional().describe("Batch retired concept ids; mutually exclusive with id."),
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional().describe("Concept's circle; defaults to the session circle."),
    },
    async ({ id, ids, circle }) => {
      const capturedBlock = capturePrewarmSnapshot(scope(circle));
      try {
        if (id !== undefined && ids !== undefined) return err("provide exactly one of `id` or `ids`, not both");
        if (id === undefined && ids === undefined) return err("provide exactly one of `id` or `ids`");
        const callerCircle = scope(circle);
        if (ids !== undefined) {
          const results = ids.map((each) => applyLifecycle(each, callerCircle, "restore"));
          return mutOk(lifecycleBatchPayload(callerCircle, results, "restored"), "memory_restore", capturedBlock);
        }
        const single = applyLifecycle(id!, callerCircle, "restore");
        if (single.action === "error") return err(single.error!);
        return mutOk({
          circle: callerCircle,
          action: single.action,
          conceptId: id,
          message: `Restored to ${callerCircle}. It is searchable, fetchable and listed again.`,
        }, "memory_restore", capturedBlock);
      } catch (e) {
        return err(`restore failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_circle_manage",
    "Manage project-locality circles. Rename preserves the old name as an alias. Merge moves all concepts; forceNew (default) keeps near matches distinct and flags them, while auto deduplicates. Archive hides a circle from store-wide recall/listing without deleting it; unarchive restores it. List includes archived circles. Use entities/edges, not circles, for topics.",
    {
      action: z.enum(["rename", "merge", "archive", "unarchive", "list"]),
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional().describe("Rename/merge source or archive/unarchive target; required for those actions."),
      to: z.string().max(CIRCLE_NAME_MAX_CHARS).optional().describe("Rename or merge destination."),
      resolution: z
        .enum(["auto", "forceNew"])
        .optional()
        .describe('Merge mode: "auto" deduplicates; "forceNew" (default) keeps distinct and flags near matches.'),
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
          if (r.action === "renamed") moveTouchedWorkstreamAffinity(circle, r.to);
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
          moveTouchedWorkstreamAffinity(circle, r.into);
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
    "List sources authorized for this host. Access identity is server-bound, never a tool argument.",
    {},
    async () => {
      const capturedBlock = capturePrewarmSnapshot(scope());
      try { return readOk({ sources: core.listConnectorSources(sourceAuthorizationContext) }, "source_list", capturedBlock); }
      catch (e) { return err(`source_list failed: ${sanitizeSourceError(e)}`); }
    },
  );

  server.tool(
    "source_status",
    "Return one authorized source's active published status; counts exclude partial and unpublished runs.",
    { sourceId: z.string().min(1) },
    async ({ sourceId }) => {
      const capturedBlock = capturePrewarmSnapshot(scope());
      try { return readOk(core.sourceStatus(sourceId, sourceAuthorizationContext), "source_status", capturedBlock); }
      catch (e) { return err(`source_status failed: ${sanitizeSourceError(e)}`); }
    },
  );

  server.tool(
    "source_path",
    "Return the sealed read-only path to an authorized source's active indexed snapshot, never a working tree or bare repository.",
    { sourceId: z.string().min(1) },
    async ({ sourceId }) => {
      const capturedBlock = capturePrewarmSnapshot(scope());
      try { return readOk(core.sourcePath(sourceId, sourceAuthorizationContext), "source_path", capturedBlock); }
      catch (e) { return err(`source_path failed: ${sanitizeSourceError(e)}`); }
    },
  );

  server.tool(
    "source_sync",
    "Synchronize one authorized active source. Remote git sync is noninteractive and uses its configured branch.",
    { sourceId: z.string().min(1) },
    async ({ sourceId }) => {
      const capturedBlock = capturePrewarmSnapshot(scope());
      try { return mutOk(await core.syncSource(sourceId, sourceAuthorizationContext), "source_sync", capturedBlock); }
      catch (e) { return err(`source_sync failed: ${sanitizeSourceError(e)}`); }
    },
  );

  server.tool(
    "agent_context",
    "Session-start orientation. Call first. Returns resolved `circle`; `resolvedFrom` marks an alias. `stageIndex` names moments whose rules require stage_lookup. Skeleton delivery has three states: no mirror fields means loaded standing files are current; `mirrorStale` + `instruction` requires user-confirmed reconciliation; `skeleton` contains members not covered by a standing file. `open` counts workstreams and inbox items still open — mention them to the user; resume only when asked.",
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

      const openWorkstreams = core.getActiveWorkstreams(resolvedCircle).length;
      const openInboxItems = core.getWorkstreamInbox(resolvedCircle)?.payload.items
        .filter((item) => item.state === "open").length ?? 0;
      const baseContentWithoutMirrorOrSkeleton = {
        circle: resolvedCircle,
        ...(state.resolvedFrom !== undefined ? { resolvedFrom: state.resolvedFrom } : {}),
        ...(openWorkstreams > 0 || openInboxItems > 0
          ? { open: { workstreams: openWorkstreams, inboxItems: openInboxItems } }
          : {}),
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
