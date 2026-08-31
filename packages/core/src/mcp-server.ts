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
import { AmbiguousNominationError, MonetCore, WorkstreamAddressRequiredError } from "./engine";
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
import { MIRROR_STALE_INSTRUCTION, SKELETON_CHANGED_INSTRUCTION } from "./skeleton-mirror";
import { inStartupPhase, markStartupPhase } from "./startup-diagnosis";

/**
 * Session lifecycle instructions surfaced to the host agent via McpServer's `instructions` option.
 *
 * CORRECTED 2026-08-03 (the design required this before any code):
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
  + "Track the session's own work with memory_checkpoint as it happens: open the plan when a directive lands, inbox anything you notice that is not this work, and settle both with the user through memory_workstreams before you report completion. "
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
/**
 * A moment id is a v4 UUID and nothing else — 36 characters, exactly. The bound is DERIVED from the
 * format the interceptor mints (`randomUUID()`, moment-spool.ts), not chosen: anything longer was
 * not produced by this system, and accepting it would let an unbounded string through a schema that
 * exists to bound one.
 */
const MOMENT_ID_MAX_CHARS = 36;

/**
 * How many owed moments one ask signal may name.
 *
 * A DELIVERY BOUND, NOT A THRESHOLD ON THE BACKLOG. Nothing has measured how often a real store
 * accumulates unasked moments, so no number here could say when a backlog is "too large" — and this
 * one does not try. It bounds what reaches a model's context (8 ids is roughly 300 characters);
 * the TRUE total is reported by the conformance counts, which are not capped. If more are owed than
 * this names, the rest are named by the next signal.
 */
const ASK_SIGNAL_MAX_MOMENTS = 8;

/**
 * WHAT THE KEY IS FOR — the one line that rides beside `momentId` on every `stage_lookup` response
 * that has one.
 *
 * WHO CONSUMES IT — the agent, and nobody else. ON WHICH TURN — every `stage_lookup` that returns a
 * `momentId`, including the first of a session. WHAT BREAKS WITHOUT IT — the response hands over a
 * key with nothing saying what to do with it. The ask signal cannot cover this: it fires only once a
 * moment already owes a question, so a first lookup carries the key and no instruction at all, and
 * no standing text mentions this loop either.
 *
 * UNCONDITIONAL, WHICH THE SIGNAL IS NOT. The signal is debt-driven and names ids; this says what
 * the ids are for. That split is why the two do not overlap — the signal states a fact (these
 * moments still owe the question), this states the instruction (what asking and recording means),
 * and neither repeats the other.
 *
 * IT ASKS WHETHER THE ACTION FOLLOWED THE RULE, never whether the rule CAUSED it — causation is
 * unobservable and is not what this measures. Same discipline as the ask signal's own wording.
 *
 * ONE LINE, AND BOTH TOOLS NAMED. It ships on every lookup, so every word is paid for repeatedly:
 * what to do, the two tools, the key they take, and nothing else. Naming only `conformance_answer`
 * would leave an obedient agent's `asked_at` null and count it as a defect it did not commit.
 */
const CONFORMANCE_INSTRUCTION =
  "After you act, ask the user whether the action followed these rules — conformance_ask with this momentId when you put the question, then conformance_answer with their reply.";

/**
 * WHERE A `not-followed` GOES NEXT — the one line that rides on `conformance_answer` and only when
 * the user's answer was `not-followed`.
 *
 * WHO CONSUMES IT — the agent, and nobody else. ON WHICH TURN — the turn a `not-followed` is
 * recorded, and no other. WHAT BREAKS WITHOUT IT — the record gains a `not-followed` tally entry
 * and the loop stops there: nothing says which of the moment's rules was broken, and the one thing
 * that should come of a rule being broken repeatedly — changing it, or retiring it — has no
 * prompt and no home.
 *
 * NOT A NOTE FIELD BESIDE THE ANSWER. The owner ruled that out: the result of a rule not being
 * followed belongs on the RULE, whose record already carries authorship, succession and
 * retirement. A `why` column here would be a dead end nothing reads and nothing acts on.
 *
 * ONLY ON `not-followed`, WHICH IS WHY IT IS NOT PART OF `CONFORMANCE_INSTRUCTION`. A `followed`
 * answer has nothing to follow up, and asking anyway is pure context cost on the arm that is
 * supposed to be silent. Minimization: the signal's absence is itself the signal.
 *
 * IT ASKS WHICH RULE, IT DOES NOT GUESS. A moment's `rule_reads` normally holds several rules, so
 * neither this response nor the agent can tell which one the user meant; recording against all of
 * them would manufacture a verdict against rules that were followed. The user names it.
 *
 * THE WORDING KEEPS THE SAME DISCIPLINE as `CONFORMANCE_INSTRUCTION`: it says the action did not
 * follow the rule, never that the rule failed to cause it — causation is unobservable and is not
 * what this measures.
 *
 * NO TOOL NAMES, DELIBERATELY, unlike `CONFORMANCE_INSTRUCTION`'s two. There the tools ARE the
 * instruction — no other surface records the fourth fact. Here the destination is a rule's own
 * record, which the agent already knows how to reach; a call sequence baked in would be a copy of
 * a procedure that rots the first time the surface moves.
 *
 * SIZE: this response has no fit loop and needs none. Every field on it is statically bounded —
 * `recorded` is a literal, `answer` is a two-value enum, `momentId` is capped at
 * MOMENT_ID_MAX_CHARS, and this line is a compile-time constant — so the whole envelope is a few
 * hundred characters against RESULT_MAX_CHARS (40 000) and cannot grow with the store.
 */
const NOT_FOLLOWED_INSTRUCTION =
  "Ask the user which of the rules read at this moment was not followed, and record what comes of that — a change to the rule, or its retirement — on that rule's own record.";

const RESULT_TRUNCATE_NOTE = `\n\n…[result truncated to fit the host's tool-result limit — narrow the query/intent, lower \`limit\`, or memory_fetch a specific id]`;
const RECALL_EMPTY_LINE = "Nothing matched.";
/** Circle names are routing identifiers, not prose; bound every caller-controlled echo before writes. */
export const CIRCLE_NAME_MAX_CHARS = 256;
const WRITE_ACK_LIST_MAX = 25;
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

/**
 * A stage, bounded for the acknowledgement envelope. Only the NAME is caller text now — the pattern
 * array and its three caps (STAGE_ACK_PATTERNS_MAX / _TOKEN_MAX_CHARS / _PATTERN_MAX_CHARS) went
 * with trigger patterns on 2026-08-22, and nothing else on a StageView is caller-controlled.
 */
function fitStageViewForAck(stage: StageView): Record<string, unknown> {
  return { ...stage, name: clip(stage.name, WRITE_ACK_TEXT_MAX_CHARS).text };
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

  if (result.gate.retirementCandidates?.length) {
    result.gate.retirementCandidatesOmitted =
      (result.gate.retirementCandidatesOmitted ?? 0) + result.gate.retirementCandidates.length;
    delete result.gate.retirementCandidates;
  }
  if (result.gate.unexplainedDenies?.length) {
    result.gate.unexplainedDeniesOmitted =
      (result.gate.unexplainedDeniesOmitted ?? 0) + result.gate.unexplainedDenies.length;
    delete result.gate.unexplainedDenies;
  }
  // Dropped the same way, and the COUNT survives the list — an omitted-to-zero list would say the
  // circle is clean, which is the one thing this field exists to stop being confused with.
  if (result.gate.unreadStages?.length) {
    result.gate.unreadStagesOmitted =
      (result.gate.unreadStagesOmitted ?? 0) + result.gate.unreadStages.length;
    delete result.gate.unreadStages;
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
 *
 * `verb` IS THE CALLER'S OWN WORD FOR THE ACT, and the third caller is why it exists (#118):
 * `memory_declare(withdraw)` refuses on the SAME findings, minus the declaration it is there to
 * withdraw, and a refusal that says "cannot retire" to a caller who asked to withdraw sends them
 * looking for a tool they did not use. Defaulted, so memory_retire's two call sites and every
 * sentence they produce are byte-identical to what they were.
 */
function retirementRefusal(id: string, blockers: readonly RetirementBlocker[], verb: "retire" | "withdraw" = "retire"): string {
  return `cannot ${verb} ${id}: ${blockers
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
  // In-flight tool-call tracking (Codex P2 #2): wrap server.tool() ONCE, here, before any of the
  // individual registrations below, so every handler (memory_*, source_*, ...) is tracked
  // uniformly without touching each call site. getGracefulShutdown's run() awaits
  // getInFlightTracker(server).quiesce() between server.close() and core.close(), so a
  // long-running handler (e.g. source_sync) can't touch the database after a signal/EOF has
  // closed it out from under it mid-call.
  const inFlightTracker = getInFlightTracker(server);
  /**
   * THE KEY, MADE REACHABLE FROM INSIDE THE HANDLER THAT NEEDS IT.
   *
   * The wrapper below opens a moment for every call and closes it afterwards, and until this
   * existed that moment id lived only in the wrapper's closure. Nothing the agent received ever
   * named it, so the chain stopped one link short: a rule reached the agent, the agent acted, and
   * there was no id to quote back when the user answered whether the action followed the rule.
   *
   * A SIDE CHANNEL, NOT A WIDER SIGNATURE. Only `stage_lookup` needs the id today, and threading a
   * third parameter through would change the type of every handler in this file to serve one of
   * them. Keyed on the per-request `extra` object the MCP SDK constructs fresh for each request
   * (`fullExtra` in its protocol layer), so concurrent calls cannot read each other's id — the
   * failure mode a module-level "current moment" variable would have.
   *
   * NOT BY MUTATING THE PARSED INPUT. The input object is the agent's own claim about the call, and
   * writing a store-minted id into it would make an argument indistinguishable from a fact this
   * server produced. A WeakMap also drops its entry when the request object is collected, so
   * nothing here accumulates.
   */
  const storeMomentByRequest = new WeakMap<object, string>();
  const openedMomentFor = (extra: unknown): string | null =>
    typeof extra === "object" && extra !== null ? storeMomentByRequest.get(extra) ?? null : null;
  const originalTool = server.tool.bind(server);
  server.tool = ((...toolArgs: unknown[]) => {
    const handler = toolArgs[toolArgs.length - 1] as (...handlerArgs: unknown[]) => unknown;
    // THE STORE'S OWN INTERCEPTION POINT, wrapped ONCE here for the same reason the in-flight
    // tracker is: every handler gets it uniformly, and a tool added later cannot forget to open a
    // moment. Every call into the store opens one and closes one — including the ones that throw,
    // because a call that failed still happened, and an opened-but-never-closed moment means
    // something else entirely (the process died mid-call).
    const toolName = typeof toolArgs[0] === "string" ? toolArgs[0] : "unknown";
    const trackedHandler = (...handlerArgs: unknown[]): unknown => {
      // THE CIRCLE THE CALL ITSELF NAMES, read straight off the handler's own argument object.
      // Every circle-accepting tool takes it under this one key, and `openStoreMoment` resolves
      // aliases and falls back to the server default, so an omitted or unusable value lands exactly
      // where it did before. Without this, a call explicitly targeting another circle was counted
      // against the default one and never appeared in the circle it actually touched.
      //
      // '*' IS NOT A CIRCLE. It is the reserved global-breadth marker for member delivery, and a
      // moment attributed to it would name a population no project can read; the default stands.
      const argCircle =
        typeof handlerArgs[0] === "object" && handlerArgs[0] !== null
          ? (handlerArgs[0] as { circle?: unknown }).circle
          : undefined;
      const callCircle =
        typeof argCircle === "string" && argCircle.length > 0 && argCircle !== "*" ? argCircle : undefined;
      const momentId = core.openStoreMoment(toolName, callCircle);
      // Published on the side channel above, for the one handler that opts in. `handlerArgs[1]` is
      // the SDK's per-request `extra` for every tool registered with a params schema — which is
      // every tool here that reads this, and the same argument position the circle above is read
      // relative to. A null id (no spool configured) publishes nothing, so an opted-in handler sees
      // "no moment" rather than a placeholder.
      const requestExtra = handlerArgs[1];
      if (momentId !== null && typeof requestExtra === "object" && requestExtra !== null) {
        storeMomentByRequest.set(requestExtra, momentId);
      }
      // Identity, never content: a sha256 of the serialized result. A result that cannot be
      // serialized still closes the moment — with the string form — rather than leaving it open.
      // THE STATUS IS OBSERVED HERE, at the only place that can tell. Each caller below already
      // knows which branch it is in — the handler returned, or it threw/rejected — so passing it
      // through is reporting a fact this wrapper holds rather than inferring one. Hard-coding
      // `null` made a failed store operation indistinguishable from a successful one.
      // A RESOLVED RESULT CAN STILL BE A FAILURE, and on this server that is the COMMON shape:
      // `err()` returns `{ content, isError: true }` — a fulfilled promise — and dozens of handlers
      // report a caught database error, a scope refusal or a missing id that way rather than by
      // throwing. Reading fulfillment as success recorded every one of those as `outcome_status:
      // "ok"`, which is this very column asserting a verdict contradicted by the value it was
      // handed. The status is derived from the result, never from which branch delivered it.
      const statusOfResult = (value: unknown): "ok" | "failed" =>
        typeof value === "object" && value !== null && (value as { isError?: unknown }).isError === true
          ? "failed"
          : "ok";
      const closeWith = (value: unknown, outcomeStatus: "ok" | "failed"): void => {
        let rendered: string;
        try {
          rendered = JSON.stringify(value) ?? String(value);
        } catch {
          rendered = String(value);
        }
        core.closeStoreMoment(momentId, rendered, outcomeStatus);
      };
      inFlightTracker.increment();
      let result: unknown;
      try {
        result = handler(...handlerArgs);
      } catch (error) {
        inFlightTracker.decrement();
        closeWith({ threw: String(error) }, "failed");
        throw error;
      }
      if (result instanceof Promise) {
        return result.then(
          (value) => {
            closeWith(value, statusOfResult(value));
            return value;
          },
          (error: unknown) => {
            closeWith({ threw: String(error) }, "failed");
            throw error;
          },
        ).finally(() => inFlightTracker.decrement());
      }
      inFlightTracker.decrement();
      closeWith(result, statusOfResult(result));
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

  // ONE CHAIN (review fix): gate()/stageLookup()/gateCoverage() all resolve `this.runtimeModelTag`
  // when a call omits an explicit tag. Wiring it here, ONCE, is what makes every surface reachable
  // from this process resolve the SAME tag — stage_lookup's handler used to pass `defaultModelTag`
  // per-call while gate() fell back to `this.runtimeModelTag`, and in the default deployment
  // (scripts/mcp-cli.ts constructs MonetCore without a runtimeModelTag option) that meant
  // MonetCore's own field stayed null even with MONET_MODEL_TAG set, so stage_lookup correctly
  // filtered a foreign-model rule while gate()/gateCoverage() (reading the still-null field) did not
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
  /**
   * THE ASK SIGNAL — the one thing in this design that reaches a model's context, and therefore the
   * one that faces the strictest form of the minimization test. Answering it, as the question
   * demands:
   *
   *   WHO CONSUMES IT — the agent, and nobody else. It is an instruction, not data for a reader.
   *   ON WHICH TURN — the next `stage_lookup` response after a moment was read and then acted on,
   *     and NO OTHER TOOL'S. Not at session start (the debt does not exist yet) and not on a timer.
   *   WHAT BREAKS WITHOUT IT — the agent cannot know it owes a question. Nothing else is in a
   *     position to tell it: the read is recorded inside the store, and the agent's own transcript
   *     shows it fetched rules, never that a question is outstanding. Without the signal, `not
   *     asked` stops meaning "the agent failed to ask" and starts meaning "the agent was never
   *     told" — one number covering a defect and an impossibility, which is the precise conflation
   *     this whole rebuild exists to remove.
   *
   * ONE SURFACE, AND THAT IS THE CORRECTION THIS ROUND MAKES. It used to ride EVERY tool response,
   * which spent context on `memory_fetch` and `memory_checkpoint` replies where the agent has no
   * rule in front of it and the instruction is an interruption with nothing to attach to. The agent
   * is told to collect confirmations at the moment it is being handed rules, and nowhere else —
   * `stage_lookup` is the one response where the reminder lands in the context that explains it,
   * beside the very key (`momentId`) the conformance tools take.
   *
   * THE COST IS A LATER REMINDER, NOT A LOST ONE. A moment only enters this backlog once its
   * outcome has landed, and a call's outcome is written after its handler has already returned — so
   * a `stage_lookup` moment is never named on its own response, only on the next one. That is
   * acceptable BECAUSE the response now carries its own `momentId`: the agent holds the key from
   * the first turn, and this signal is the backstop for a debt it did not clear, not the only way
   * it learns the key.
   *
   * IT NAMES MOMENTS; IT NEVER CARRIES THEIR CONTENT. Ids, and the fact that they are outstanding —
   * the what-to-do lives in the response's own `instruction` field (see CONFORMANCE_INSTRUCTION),
   * which ships on every lookup that has a `momentId`, so this no longer restates it. The agent
   * already has the action in its own transcript — re-sending a rendering of it would be paying
   * context to tell the model what it just did.
   *
   * REPEATED WHILE THE DEBT STANDS, and that is a correction. This used to announce each moment
   * exactly once, reasoning that a banner reappearing every turn is standing text by another name
   * and that an ignored signal still surfaces as `notAsked`. Both halves rested on an assumption
   * nothing here can check: that the agent SAW it. The signal rides as a secondary `content` item,
   * and a host that exposes only `content[0]` — a degradation this file's own lifecycle code
   * anticipates — shows it to nobody. Marking it delivered anyway, and then counting the silence as
   * an agent defect, is verbatim the conflation between "ignored the signal" and "was never told"
   * that these counts exist to remove.
   *
   * So delivery is never assumed. The moment stays named until it stops owing a question, which the
   * agent clears by asking. The debt is small and self-clearing by construction — only moments that
   * were read and then acted on are ever in it — so this is a persistent notice rather than a
   * standing banner, and it is bounded by the cap below either way.
   *
   * SILENCE IS THE HEALTHY STATE. Most moments are silent and owe nothing, so this appends nothing
   * at all on the overwhelming majority of responses.
   */
  function askSignalBlock(): string {
    let owed: string[];
    try {
      owed = core.momentsOwingAQuestion(ASK_SIGNAL_MAX_MOMENTS);
    } catch {
      // A signal that cannot be computed must never fail the tool call that carried it.
      return "";
    }
    const fresh = owed.slice(0, ASK_SIGNAL_MAX_MOMENTS);
    if (fresh.length === 0) return "";
    const ids = fresh.join(", ");
    const noun = fresh.length === 1 ? "action" : "actions";
    // A FACT, NOT A SECOND COPY OF THE INSTRUCTION. It used to carry both — what is owed AND what to
    // do about it — because it was the only thing on any response that said either. The response's
    // own `instruction` field now carries the what-to-do on every lookup that has a `momentId`, so
    // repeating it here would say the same thing twice in one payload. What is left is the half only
    // this can know: WHICH earlier moments are still outstanding. The two compose — content[0] says
    // what asking means, this says which ids still need it — and neither is readable as the other's
    // duplicate.
    //
    // THE ORDER SURVIVES A DEGRADED HOST. The instruction rides in content[0], which every host
    // exposes; this rides as a later content item, which some drop. The half that can go missing is
    // the id list, never the instruction — the reverse split would lose the what-to-do entirely.
    //
    // The wording still says the action FOLLOWED a rule it read, never that the rule caused it.
    return `Monet: you read a rule and then acted, for ${fresh.length} ${noun} (${ids}) — each still owes that question.`;
  }

  function wrapSuccess(
    result: CallToolResult,
    {
      toolName,
      capturedBlock,
      carriesConformanceKey,
    }: { toolName: string; capturedBlock?: string | null; carriesConformanceKey?: boolean },
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

    // --- ask signal ---
    // ONE SURFACE ONLY. See askSignalBlock's own header for why: the agent collects confirmations
    // at the moment it is handed rules, so the reminder belongs on the response that hands them
    // over and on no other. Gated HERE rather than inside the block builder so every other tool
    // response skips the `momentsOwingAQuestion` query — and its fold — outright.
    //
    // AND ON THE SAME CONDITION AS THE KEY (review fix — Codex round 2). The two halves were split
    // deliberately: the response's `instruction` says what asking means and names the two tools that
    // take a momentId, and this says WHICH earlier moments still owe it. That split is what keeps
    // either from being the other's duplicate — and it is exactly what stops either from standing
    // alone. Once the key and its instruction became conditional on this lookup actually delivering
    // a rule, a lookup that delivered none carried the id half with the what-to-do half missing:
    // uuids the agent has no surviving text to act on, since nothing else on the response, and no
    // standing text, names `conformance_ask`.
    //
    // WITHHELD RATHER THAN MADE SELF-CONTAINED, and that is the choice. Restating the tool names
    // here would pay context on EVERY debt-bearing response — the common case, where the
    // instruction is already present and would now say the same thing twice — to cover the rare one
    // where it is absent. It would also contradict this surface's own reason for existing: the
    // reminder belongs where the agent is being handed rules, and a lookup that handed over none is
    // precisely not that moment. Nothing is lost by waiting: the debt clears only by asking, so the
    // next lookup that does deliver a rule names it again, beside the line that explains it.
    const askBlock = toolName === "stage_lookup" && carriesConformanceKey === true ? askSignalBlock() : "";
    if (prewarmBlock === "" && askBlock === "") return result;

    const appended = [
      ...(prewarmBlock === "" ? [] : [{ type: "text" as const, text: prewarmBlock }]),
      ...(askBlock === "" ? [] : [{ type: "text" as const, text: askBlock }]),
    ];
    return {
      ...result,
      content: [result.content[0], ...result.content.slice(1), ...appended],
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
   *
   * `carriesConformanceKey` is `stage_lookup`'s alone: it says this response really did hand over a
   * momentId and the instruction that explains it, which is the condition the ask signal now shares
   * — see wrapSuccess. Every other tool omits it and appends nothing either way.
   */
  const readOk = (
    content: object,
    toolName: string,
    capturedBlock?: string | null,
    carriesConformanceKey?: boolean,
  ): CallToolResult =>
    wrapSuccess(ok(content), { toolName, capturedBlock, carriesConformanceKey });

  const mutOk = (
    content: object,
    toolName: string,
    capturedBlock?: string | null,
  ): CallToolResult =>
    wrapSuccess(ok(content), { toolName, capturedBlock });

  server.tool(
    "memory_store",
    'Store durable knowledge. Similar evidence normally attaches to an existing concept; novel, incoherent, species-mismatched, or stage-mismatched evidence creates a concept. Evidence that matches several concepts equally is REFUSED rather than guessed: the error names the candidates, and you re-send with `attachTo` or `resolution="forceNew"`. The acknowledgement returns `circle`, `action`, and `conceptId`; anomalous forks also return `resolutionMode` and `score`, flagged pairs add `nearMatchId`/`nearMatchScore`, and correction/rule outcomes add `contradiction`, `ruleSuccession`, or `extractionCandidate` only when present, and a store into an archived circle adds `guidance` naming what recall will not reach. Use `attachTo` only when identity is known, or `resolution="forceNew"` for known-distinct items. Use kind="correction" to challenge prior memory. Use kind="rule" with `rule`; stored rules are advisory because blocking severity is declaration-only in memory_declare. Synthesis happens later on explicit read.',
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
            .describe("One line naming the failure this prevents; delivered by stage_lookup, not by the gate payload."),
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
        // WHERE THE MEMORY IS, read off the result rather than re-resolved here (Codex round 1 on
        // #55, finding 2). `scope()` consults live alias state, so a rename committed by a second
        // connection between core.store()'s commit and this line — one .monet file shared by the
        // MCP server and a monet CLI call is a supported topology, storage.ts — made this name the
        // rename's target while the write had landed elsewhere. This field's documented job is to be
        // passed to id-based tools, so it must be the circle the concept is IN; the write-time
        // landing circle is a different fact and rides its own field into the disclosure below.
        const conceptCircle = r.concept.circle;
        const envelope = {
          circle: conceptCircle, // the circle these ids live in — pass it to id-based tools if it isn't your session default
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
          // ARCHIVED DESTINATION (#55). A write into an archived circle is legitimate — archiving
          // hides a circle, it does not seal it (archiveCircle) — so this discloses rather than
          // refuses. What it refuses to do is let the caller walk away believing the memory is
          // store-wide recallable: an archived circle is out of memory_search's default scan, out of
          // memory_overview and out of the default circle listing, so an agent that stores here and
          // moves on has recorded something its next session will not find by asking.
          //
          // READ OFF THE RESULT, never asked here — the same discipline memory_reassign_circle's
          // deny disclosure follows. The flag is frozen inside core.store()'s own write reservation,
          // so the sentence and the write share one instant; asking the store after the call would
          // put the whole write between the answer and what it describes.
          //
          // PRESENT ONLY WHEN IT FIRES, like every other conditional field on this envelope. A key
          // repeating "not archived" on every ordinary write is payload with no reader, and silence
          // is the healthy state.
          //
          // WORDED AS OF THE WRITE, WHICH IS THE ONLY INSTANT THIS SENTENCE KNOWS (Codex round 3).
          // Both the verdict and the name are frozen — deliberately, because re-reading either here
          // is the race round 2 closed — so the sentence may not speak in the present tense about a
          // world it stopped observing. It says the circle WAS archived when the write landed, keeps
          // the consequence conditional on that still being so, and sends the caller to
          // memory_circle_manage to LOOK rather than instructing a fix.
          //
          // The instruction it used to give was not merely imprecise, it was unusable in this PR's
          // own race: after a rename the frozen name is an active alias, and unarchiveCircle refuses
          // one ("archive the canonical circle instead"). A remediation that throws for the exact
          // caller most likely to need it is worse than none, because it reads as the way out.
          // SPOKEN ABOUT THE LANDING CIRCLE, not the concept's current one — the two are the same
          // until a later move, and the verdict belongs to the first (Codex round 4). Both halves
          // come from the result's own frozen pair, so the sentence names the circle its `true` was
          // actually about, and says nothing at all if the pair is missing.
          //
          // THE EXCLUSION LIST IS WHAT ARCHIVING ACTUALLY DOES, measured rather than assumed
          // (Codex round 4): store-wide search skips the circle, and `listCircles` drops it from the
          // default listing — which is what another circle's overview shows as `otherCircles`. The
          // overview of the archived circle ITSELF is complete when you name it, so claiming the
          // memory is "out of the overview" was false in exactly the mode a worried caller would
          // check first. `search`, `fetch` and `overview` all reach it by name, which the preceding
          // clause already promises.
          ...(r.landedInArchivedCircle && r.landedCircle
            ? {
              guidance:
                `ARCHIVED CIRCLE: '${r.landedCircle}' was archived when this write landed. The ` +
                `memory is stored and reachable by naming that circle, but while that circle ` +
                `remains archived it stays out of store-wide recall and out of the default circle ` +
                `listing. Check or change the circle's state with memory_circle_manage.`,
            }
            : {}),
        };
        return mutOk(envelope, "memory_store", capturedBlock);
      } catch (e) {
        // NOT A FAILURE, and it must not read as one (#86). The evidence matched several concepts
        // closely enough that nothing distinguished them, so the write was refused rather than
        // guessed — under that bar the guess is wrong 41.7% of the time (bge-m3, monet-hq,
        // legality-aware engine-driven replay 2026-08-26, n=266; this said "about 64%" until that
        // replay refuted it — see embedding.ts's tauMargin block). The caller is the only party
        // that knows which of these it meant, and it knows now, in this turn.
        //
        // The candidates ARE the payload: an instruction alone would send the agent to search for
        // what this call already computed. `resolutionMode` says which decision produced this so it
        // reads in the same vocabulary as an ordinary ack.
        if (e instanceof AmbiguousNominationError) {
          // STRUCTURED, so the candidates are machine-readable rather than scraped out of prose —
          // Codex P2, PR #87, taken. What is NOT taken from that finding is dropping `isError`.
          //
          // The review asked for a normal success result carrying `resolutionMode`. But `isError`
          // is not a claim about who is at fault, it is the one bit that says THE CALL DID NOT DO
          // WHAT YOU ASKED — and here it did not: no memory exists. This whole change exists to stop
          // a store from ending in a quiet wrong outcome, and an ok-shaped envelope is exactly how
          // an agent skims past `action: "ask"` and walks away believing the write landed. A host
          // classifying this as a failed tool execution is classifying it correctly.
          return err(JSON.stringify({
            action: "ask",
            resolutionMode: "ambiguous-ask",
            stored: false,
            reason: e.message,
            margin: Number(e.margin.toFixed(4)),
            candidates: e.candidates.map((c) => ({
              conceptId: c.conceptId,
              title: c.title,
              score: Number(c.score.toFixed(3)),
            })),
            // NOT AN EXHAUSTIVE SET, and the instruction must not pretend otherwise (Codex P1,
            // round 6). These are the closest legal landings, capped at five, and the true home is
            // among the top five for 88.0% of asks — so "none of these" is not the same claim as
            // "this is new". Telling the caller to reach for forceNew on that basis sends the other
            // 12% down the one branch that records no link at all, which is how an unlinked twin of an
            // existing concept gets created by following the instructions exactly.
            //
            // BOTH NUMBERS MOVED WITH THE CAP (3 -> 5, 2026-08-26) and both are now measured rather
            // than asserted — bge-m3, live monet-hq, legality-aware replay over the ask-firing
            // population, n=267. The derivation, the k-table and what it rests on are on
            // AMBIGUOUS_CANDIDATES_MAX in engine.ts; this comment must not restate them or the two
            // will drift, which is the failure the old "about 80%" here already was.
            instruction:
              'Re-send this exact content with attachTo set to one of the conceptIds above. These are ' +
              'the five closest matches, not every concept — if none looks right, memory_search for ' +
              'the right one and pass its id to attachTo instead. Use resolution="forceNew" only to ' +
              'assert this is genuinely new: it records no link to anything, so an unlinked duplicate ' +
              'is invisible to curation afterwards.',
          }, null, 2));
        }
        return err(`store failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_declare",
    'Declare a user-authorized rule, stage, principle, or preference, or withdraw a declared rule. Never call on agent initiative. This is the only tool that may create blocking rules, replace a rule binding, or end a declaration. A stage is a named moment; rules bind content to stages. Principles and preferences enter the always-on skeleton without stage or severity; mechanical concerns return as non-blocking `advisories`. Skeleton changes include `instruction` only when a registered standing surface became stale. A permissive standing grant is a rule, not another species. `withdraw` retires a declared rule so no stage delivers it; a rule whose deny is still live must be declared advisory first, and one carrying an open question is refused until the question is answered. memory_restore brings a withdrawn rule back.',
    {
      species: z
        .enum(["rule", "stage", "principle", "preference"])
        .optional()
        .describe('"stage" registers a named moment; "rule" binds to a stage; "principle"/"preference" enter the momentless skeleton. Omit only when withdrawing.'),
      // THE EXIT A DECLARATION NEVER HAD (#118). `memory_retire` refuses a declared rule — a memory
      // leaves with the authority it entered on — and until now nothing ended that authority, so the
      // refusal pointed at nowhere. It lands HERE because the declaration surface is the one the
      // user authorizes: the same sovereignty that mints a deny is what may give it up.
      withdraw: z
        .string()
        .optional()
        .describe("Concept id of a declared rule to withdraw. Mutually exclusive with `species`; every other field is ignored."),
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
      severity: z
        .enum(["advisory", "blocking"])
        .optional()
        .describe(
          'Pass only when the user rules on enforcement. Omit to preserve existing severity or default a new rule to advisory. "blocking" denies the action and is for safety boundaries. Changing blocking to advisory removes the deny and is disclosed.',
        ),
      scope: z.enum(["domain", "agent"]).optional().describe('"domain" binds any agent; "agent" (default) compensates for this model.'),
      modelTag: z.string().max(MODEL_TAG_MAX_CHARS).optional().describe('Model compensated for. Required for agent scope unless MONET_MODEL_TAG supplies it.'),
      reason: z.string().optional().describe('One-line failure prevented, delivered by stage_lookup rather than by the gate payload. Required for blocking severity; ask the user rather than inventing it.'),
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
    async ({ species, withdraw, stage, content, exitsEvidence, severity, scope: ruleScope, modelTag, reason, declaredBy, circle, sourceRefs }) => {
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
        // THE WITHDRAWAL VERB (#118), AND IT IS A DIFFERENT ACT FROM EVERY OTHER FIELD HERE — which
        // is why `species` and `withdraw` are exclusive rather than a fifth species. A species says
        // WHAT to declare and reads `stage`, `content`, `severity`, `scope`, `circle`; a withdrawal
        // names an EXISTING concept and reads none of them. Folding it into the enum would put a
        // dozen inapplicable fields in front of every withdrawal and make "declared a rule" and
        // "ended one" the same call shape in the record.
        //
        // BOTH AND NEITHER ARE BOTH ERRORS, each naming which. Silently preferring one over the
        // other would let a caller who meant to withdraw declare a NEW rule instead — a mutation
        // through the one surface where an unintended write is least recoverable.
        //
        // THE CIRCLE IS `homeCircle`, NOT `declareCircle`: a concept always lives at a real circle
        // and never at the breadth marker (see that constant's own comment above), and this is a
        // lookup of an existing concept, never a ruling about delivery breadth.
        if (withdraw !== undefined) {
          if (species !== undefined) return err("provide exactly one of `species` or `withdraw`, not both");
          // THE SAME CEILING memory_retire's own single-id path uses, and the same reason (its
          // round-3 review fix): `err()` has no size ceiling of its own the way `ok()` does, so an
          // unbounded caller-supplied id echoed verbatim produces a result past the host's limit —
          // the caller gets an unusable response instead of the refusal. The constant is declared
          // further down in this same registration function; every handler here runs long after
          // registration returns, so it is always initialized by the time this reads it.
          const shownId = clip(withdraw, LIFECYCLE_ERROR_ID_MAX_CHARS).text;
          const outcome = core.withdrawDeclaredRule(withdraw, homeCircle);
          // THE SCOPE GATE'S ANSWER IS memory_retire's, WORD FOR WORD: an id outside the caller's
          // circle reads as absent rather than forbidden, so this surface cannot be used to probe
          // for the existence of concepts in circles the caller did not name.
          if (outcome.outcome === "not-in-circle") return err(`concept not found: ${shownId}`);
          // NOT A NO-OP AND NOT A SUCCESS. This verb's subject is the declaration itself, so a
          // concept carrying none is told exactly that — retiring it anyway would make the
          // sovereignty surface a second `memory_retire` that skips every refusal by construction.
          if (outcome.outcome === "not-declared") {
            return err(
              `cannot withdraw ${shownId}: it carries no declaration binding, so there is no declaration ` +
              `to withdraw and nothing was changed — memory_retire is the exit for a memory that entered ` +
              `on the agent's own authority`,
            );
          }
          // THE OTHER THREE BLOCKERS STILL REFUSE, rendered by the same formatter memory_retire uses
          // so the two surfaces cannot come to describe one finding differently.
          if (outcome.outcome === "blocked") return err(retirementRefusal(shownId, outcome.blockers, "withdraw"));
          return mutOk(
            {
              circle: homeCircle,
              action: "withdrawn",
              conceptId: withdraw,
              // THE PRESERVED ORIGIN IS PART OF THE ACKNOWLEDGEMENT, not an implementation detail
              // left for a reader to discover: a caller who is told only "withdrawn" will assume the
              // declaration was erased, and then read `memory_retire`'s unchanged refusal on the same
              // id as a bug. Serialized arguments in the restore suggestion for memory_retire's own
              // round-2 reason — a circle name carrying a quote or newline must still replay.
              message:
                `Withdrawn. The rule is retired: no stage delivers it, and it is out of memory_search, ` +
                `memory_fetch, memory_list and the overview counts. Its binding still records ` +
                `origin="declaration" — it really did enter that way, and the withdrawal ends its delivery ` +
                `rather than falsifying that record. ` +
                `memory_restore(${JSON.stringify(withdraw)}, ${JSON.stringify(homeCircle)}) brings it back.`,
            },
            "memory_declare",
            capturedBlock,
          );
        }
        if (species === undefined) return err("provide exactly one of `species` or `withdraw`");
        const r = await core.declare({
          species, stage, content, exitsEvidence, severity, scope: ruleScope,
          // LIVE, not the closure-captured `defaultModelTag` — same review-fix reasoning as
          // memory_store's own rule capture just above (Codex round 3). The HOST tag is injected
          // for RULES only: principle/preference are momentless and reject modelTag, but a
          // caller-supplied value must still reach declare() so that rejection is not bypassed.
          modelTag: species === "rule" ? (core.getRuntimeModelTag() ?? modelTag) : modelTag,
          reason, declaredBy, sourceRefs,
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
            // WHAT ACTUALLY HAPPENS NOW, which is less than this used to promise. It said a matching
            // action would REPORT the stage as having no rules — a sentence from the era of trigger
            // patterns and the gate hook, when something watched actions and spoke up. Nothing
            // matches actions any more and nothing reports: an empty stage is simply a `stage_lookup`
            // that comes back with no rules, and only if someone looks it up. A shipped surface
            // describing machinery that no longer exists is worse than one that says less — the user
            // waits for a report that will never arrive, and reads the silence as the stage working.
            guidance = "The stage is registered. It fires nothing until a rule is bound to it — until then a stage_lookup for it returns no rules, which is the signal to reason from principles.";
            return mutOk({
              circle: homeCircle,
              species: r.species,
              stage: fitStageViewForAck(r.stage),
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
              : "The rule is bound. It will be returned the next time that stage is looked up by name.";
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
    "Read-only curation workbench for one circle: compact counts, livingModel cards, bounded queues for possibleDuplicates, extractionCandidates, openContradictions and gate exceptions, plus the ratified skeleton. A skeleton member's `homeCircle` names the circle it is homed in and appears only when that is not the circle you asked from; its absence means the member is homed here, and memory_ratify only accepts a candidate homed in the circle you pass. Opt into dirty or stale worklists; truncation fields report omissions. It never returns bodies: memory_fetch an id, use memory_resolve for contradictions or pair flags, and memory_detach with destConceptId to consolidate a duplicate. Pass entity to list one hub's memories.",
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
          conceptLimit,
          includeDirty,
          includeStale,
        });
        // THE FOUR CONFORMANCE STATES, on the surface curation already reads. `unanswered` and
        // `notAsked` are reported SEPARATELY and never summed: one is a queue owed to the user, the
        // other is an agent defect, and they have different owners and different remedies. No
        // threshold says when a backlog is too large — nothing has measured that — so these are
        // counts and nothing more. `followed` means the action followed the rule; it does not say
        // the rule caused it, which is unobservable.
        // EVERY RETURNED FIELD GOES THROUGH THE FITTER. `ov.gate.conformance` already carries the
        // four states, and a SECOND top-level copy was being attached after `fitOverviewEnvelope`
        // had already measured the response — so near the ceiling the extra object pushed the
        // payload over and `ok()` replaced the entire overview with a generic truncation notice.
        // A field added past the fitter is a field the fitter cannot account for.
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
          withProvenance, limit: lim, cursor: parsed,
        });
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
    "memory_fetch",
    "Read a concept by id. Normal concepts return `body` and `observationCount`; evidence appears only with observations:true as newest-first pages. If `needsSynthesis:true`, pull every page, reconcile one body, then call memory_synthesize. `bodyTruncated` means recover from observations. A disputed concept adds `status` and `openContradictions`; mediate with memory_resolve({ contradictionId: openContradictions[i].id }).",
    {
      id: z.string(),
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional().describe("Expected home circle. Omit for store-wide id lookup; the response includes the home circle."),
      observations: z.boolean().optional().describe("Include one newest-first evidence page. Default false."),
      observationsOffset: z.number().int().min(0).optional().describe("With observations:true, skip this many newest entries. Start at 0. Advance by observations.length, especially when observationsOmitted appears."),
    },
    async ({ id, circle, observations, observationsOffset }) => {
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
        // Only an explicit observations pull asks the engine to materialize one newest-first page.
        // A default body read still counts the evidence but does not load any observation content.
        const c = await core.getConcept(id, {
          synthesize: false,
          observationsOffset: observations ? observationsOffset ?? 0 : 0,
          pageSize: observations ? FETCH_MAX_OBS : 0,
          includeObservations: observations === true,
        });
        if (!c) return err(`concept not found: ${id}`);

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

  /**
   * THE FOURTH FACT — the only one a machine may not produce.
   *
   * Applicable, Delivered and Received are all mechanical. Conformance is not: whether the action
   * followed the rule is a judgement about the act, and the user is the one who makes it. Nothing
   * in this system infers it, and these two tools are the only way it enters the record.
   *
   * TWO TOOLS, NOT ONE, because they are two events with two owners. The ASK is the agent's act and
   * the ANSWER is the user's; a single call carrying both would make the agent the author of a fact
   * it does not own, and would destroy the distinction between `unanswered` (asked, waiting on the
   * user) and `not asked` (never asked, the agent's defect) — the one distinction this surface
   * exists to keep.
   */
  server.tool(
    "conformance_ask",
    "Record that you asked the user whether an action followed the rule it read. Call this when you put the question, before their reply. The momentId is the one `stage_lookup` returned when it handed you that rule; a later `stage_lookup` also names any you still owe.",
    {
      momentId: z.string().max(MOMENT_ID_MAX_CHARS).describe("The moment you asked about."),
    },
    async ({ momentId }) => {
      try {
        core.recordMomentAsk(momentId);
        return ok({ recorded: "ask", momentId });
      } catch (e) {
        // UnknownMomentError reaches the caller as an error rather than being softened into a
        // created row: an ask against a moment nobody intercepted is not an event.
        return err(`conformance_ask failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "conformance_answer",
    "Record the user's reply to that question: 'followed' or 'not-followed'. Their answer only — never your own assessment. This says the action followed the rule; it never says the rule caused it.",
    {
      momentId: z.string().max(MOMENT_ID_MAX_CHARS).describe("The moment the user answered about."),
      answer: z.enum(["followed", "not-followed"]).describe("The user's answer, verbatim in meaning."),
    },
    async ({ momentId, answer }) => {
      try {
        core.recordMomentAnswer(momentId, answer);
        // THE FOLLOW-UP RIDES THE ANSWER THAT NEEDS ONE, AND ONLY THAT ONE. Spread rather than a
        // ternary field so a `followed` response is byte-identical to what it was before this
        // existed — the silent arm stays silent, and its own key is never serialized as null.
        // See NOT_FOLLOWED_INSTRUCTION for why the destination is the rule and not a field here.
        return ok({
          recorded: "answer",
          momentId,
          answer,
          ...(answer === "not-followed" ? { instruction: NOT_FOLLOWED_INSTRUCTION } : {}),
        });
      } catch (e) {
        return err(`conformance_answer failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "stage_lookup",
    "At a stage named by agent_context, fetch its rules before acting. A hit returns bounded rules with reasons and omission recovery fields. `homeCircle` names the circle a rule is homed in, and appears only when that is not the circle you asked from; its absence means the rule is homed here. `parentDisputed:true` means `disputedParentIds` should be memory_fetched; projectedFromPrincipleId is only the display parent. A miss returns the live stage index.",
    {
      stage: z.string().max(STAGE_NAME_MAX_CHARS).describe("Stage name or id from agent_context/prewarm."),
      circle: z.string().max(CIRCLE_NAME_MAX_CHARS).optional(),
      // NO `momentId` INPUT. It used to be one, carrying the id from a gate instruction so the read
      // could join the moment that prompted it — and no gate instruction is emitted any more, so
      // the only id an agent could pass would be one it invented or copied from somewhere else.
      // The moment this read belongs to is now the one THIS CALL opened, which the wrapper mints
      // and the response hands back; a caller-supplied id could only disagree with it.
    },
    async ({ stage, circle }, extra) => {
      // THIS CALL'S OWN MOMENT — the id the wrapper opened for this very `stage_lookup`, which is
      // also the id this response returns. That makes one moment carry the whole chain: the rule
      // reached the agent here, so the read attaches here, and the question the user is later asked
      // is about this same id.
      const momentId = openedMomentFor(extra);
      const capturedBlock = capturePrewarmSnapshot(scope(circle));
      try {
        // ONE CHAIN: no runtimeModelTag passed here — core.setRuntimeModelTag() was called once at
        // registration (above), so this resolves identically to gate()/gateCoverage() by construction.
        // `recordMomentRead: false` — THIS handler records the read itself, a few lines below, over
        // the rules that survived response fitting. Letting the core record as well would both
        // double-count the lookup and re-credit identities the fitter dropped, which is the exact
        // defect an earlier round of this review closed.
        const r = core.stageLookup({ stage, circle: scope(circle), recordMomentRead: false });
        // THE KEY THE AGENT QUOTES BACK. `conformance_ask` and `conformance_answer` both take a
        // momentId, and before this there was no surface an agent could get one from — the fourth
        // fact was unrecordable in practice for want of an identifier. Handing it out HERE, and
        // only here, is deliberate: this is the moment a rule reaches the agent, so it is the
        // moment the eventual question is about.
        //
        // OMITTED, NEVER NULL, WHEN THERE IS NO MOMENT: with no spool configured nothing is
        // recorded and no conformance call could attach anyway, and an explicit `null` would
        // invite one to be attempted against it. Same omit-when-absent convention as every other
        // optional field on this response.
        //
        // THE KEY AND ITS INSTRUCTION SHIP TOGETHER, in one spread, so neither can appear without
        // the other. A key with nothing saying what it is for was the state this closes; an
        // instruction to name a key that is not on the response would be worse than silence.
        const momentFields = momentId !== null ? { momentId, instruction: CONFORMANCE_INSTRUCTION } : {};
        const responseFieldsWithoutMoment = {
          circle: scope(circle),
          matched: r.matched,
          ...(r.stage ? { stage: r.stage } : {}),
        };
        // BUDGETED AS IF THE KEY SHIPS, DECIDED AFTER THE FIT LOOP KNOWS WHETHER IT DOES.
        //
        // The two facts are circular by construction: the key ships only when the response carries
        // at least one rule, and which rules the response carries is what the fit loop below is
        // computing. Budgeting against the LARGER envelope breaks the circle in the only safe
        // direction — dropping the key afterwards can only leave the response smaller than what was
        // measured, never larger, so no field is ever paid for out of a budget that did not know
        // about it. The reverse (budget small, ship large) is the overflow this envelope's whole
        // size-fit discipline exists to prevent.
        const fixedFieldsForBudget = { ...responseFieldsWithoutMoment, ...momentFields };
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
            // WHERE THE RULE IS HOMED, present only when that is not the circle asked about
            // (gates.ts, GateRule.homeCircle). A rule reaching this response from another circle —
            // a breadth binding, typically a norm meant to reach every project — used to arrive
            // byte-identical to a local one, while the response's own top-level `circle` names the
            // SESSION's circle and so quietly read as the rule's. The agent is told elsewhere that
            // another circle's memory is analogy at best; at a stage the rule is binding, so it
            // needs the same provenance a recall card already carries. Omitted in the ordinary
            // case for this response's usual reason: on every rule of every lookup it would be
            // resident cost with none of the signal.
            ...(rule.homeCircle !== undefined ? { homeCircle: rule.homeCircle } : {}),
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
          const serialized = JSON.stringify({ ...fixedFieldsForBudget, rules: candidate }, null, 2);
          if (serialized.length > sizeBudget) break;
          fitRules.push(candidateRule);
        }

        // THE KEY SHIPS ONLY WHEN THIS RESPONSE ACTUALLY DELIVERED A RULE.
        //
        // WHAT IT USED TO DO: hand out a momentId and the instruction on every lookup that had a
        // moment at all — a stage that does not exist, a stage with no live rules bound, or a fit
        // loop that seated none of them. The agent was told to ask the user whether the action
        // followed "these rules" when no rules were on the response to follow, and the
        // `conformance_ask` it was instructed to make could not have succeeded: `recordRuleReads`
        // spools `ruleId: null` for an empty lookup (engine.ts), the fold drops exactly that record
        // rather than writing a rule read (`if (record.ruleId === null) return`, moment-ledger.ts),
        // and `requireObservedMoment` refuses any moment whose `rule_reads` is empty
        // (moment-ledger.ts). So the instruction named a call that was guaranteed to be REFUSED.
        //
        // An instruction whose only possible outcome is an error is worse than no instruction: the
        // agent spends a turn on it, gets `UnknownMomentError`, and has nothing true to tell the
        // user about why. Omitting both fields says the honest thing — this lookup delivered
        // nothing, so there is nothing to ask about — through the same absence-is-the-signal
        // convention the rest of this response uses.
        //
        // GATED ON `fitRules`, NOT ON `r.rules`, for the same reason `recordRuleReads` below is:
        // the response is the authority on what reached the agent. A rule the engine selected and
        // the size budget then dropped was never read, so it can neither be recorded as read nor
        // make the moment answerable — the two must agree, and they now share one condition.
        //
        // A MISS STILL RETURNS ITS `stageIndex` recovery path; only the key and its instruction go.
        const fixedFields = fitRules.length > 0 ? fixedFieldsForBudget : responseFieldsWithoutMoment;
        // HONEST TOTAL (review fix — Codex round 2): `r.rulesTotal`, when present, means the SQL
        // retrieval itself was capped — `r.rules.length` alone would understate how many rules
        // truly exist, not just how many the wire chose to show. Absent means `r.rules.length` IS
        // the whole truth, exactly as before this fix (see StageLookupResult's own comment).
        const rulesTotal = r.rulesTotal ?? r.rules.length;
        const rulesOmittedCount = rulesTotal - fitRules.length;

        // THE READ, RECORDED AGAINST THIS CALL'S OWN MOMENT (invariant 03) — AND ONLY FOR THE
        // RULES THIS RESPONSE ACTUALLY CARRIES.
        //
        // THE MOMENT USED TO COME FROM THE CALLER, named by a gate instruction that no longer
        // exists; with nothing emitting one, every read was recorded against `null` and joined
        // nothing. The moment the wrapper opened for this call is the honest owner: the rules
        // reached the agent through THIS response, so this is the call whose conformance is later
        // in question. A null id here still means an unjoinable read (no spool configured), which
        // is a recorded state rather than an error — see MonetCore.recordRuleReads.
        //
        // THIS USED TO RUN BEFORE THE FIT LOOP, against the engine's whole `r.rules`, on the
        // reasoning that recording the engine's delivered set stops a presentation change from
        // moving what counts as read. That reasoning was wrong, and it confused two different
        // things: what the ENGINE selected, and what the RESPONSE carried. Received is a claim
        // about the AGENT — "it read this rule" — so the response is the authority. A rule the size
        // budget dropped never reached the agent, and recording it as read is a verdict where the
        // value is not known. It then propagates: `notAsked` inherits it, and a user is asked to
        // judge compliance with a rule the agent could not read.
        //
        // A rule listed only in the omitted-ids recovery field is NOT counted either: its identity
        // reached the agent, its content did not, and `stage_lookup`'s whole job is the content.
        // Delivery and receipt stay separate facts.
        core.recordRuleReads(
          momentId,
          fitRules.map((rule) => rule.conceptId as string),
          // THE STAGE THE AGENT NAMED, resolved to its id — never the stage the gate matched. On
          // a miss there is no id, and null is honest: the agent named something this build could
          // not resolve.
          r.stage?.id ?? null,
          // The circle THIS lookup was scoped to — the same value the lookup itself ran under, so
          // stage coverage is read per circle instead of over every project sharing the spool.
          scope(circle),
        );

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
        // THE SAME `fitRules.length > 0` THAT CHOSE `fixedFields` ABOVE, and deliberately the same
        // expression rather than a re-derivation: the ask signal and the key must never disagree
        // about whether this response delivered a rule.
        }, "stage_lookup", capturedBlock, fitRules.length > 0);
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

  const checkpointDescription = "Track work and capture finds as they happen — nothing is owed at session end. When a work directive lands, open the plan: work-level items that may outlive the session (fine-grained decomposition stays in the host's own todo). When something surfaces that is not this work, `inbox` it — one line, keep moving. Before reporting completion, settle: close what resolved, and dispose the inbox with the user — do it now, `filed` with a `ref`, `dropped`, or leave open to keep. This MERGES: `open` adds, `close` resolves by id, anything unnamed stays untouched. Address a workstream by `title` (mints if new) or `id` (exact); with neither, the one this session already touched, or the only active one — several active means refusal with the list. The receipt is only what this call did: `opened`/`closed` item ids, `status` only when this call changed it, and — only when the checkpoint landed in an archived circle — `guidance` naming that circle.";
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
        // THE ARCHIVED-DESTINATION DISCLOSURE (#81) — the gap #55 closed for memory_store, still
        // open on the two checkpoint writers. Each writer carries its own (verdict, circle) pair,
        // both halves read inside its own write transaction, and the sentence takes BOTH halves
        // from whichever pair answered `true`: a verdict from one writer wearing the other's circle
        // name is the half-fact #55's rounds 2 and 4 spent themselves closing. `saved` is preferred
        // only to match this receipt's own precedence for `circle` above; absent a mid-call rename
        // the two writers resolve to the same place, so the choice is invisible in every ordinary
        // call. A combined call therefore discloses once, not twice.
        const archivedLanding = saved?.landedInArchivedCircle === true
          ? saved.circle
          : inboxSaved?.landedInArchivedCircle === true
            ? inboxSaved.row.circle
            : undefined;
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
          // PRESENT ONLY WHEN IT FIRES: a key repeating "not archived" on every ordinary checkpoint
          // is payload with no reader.
          //
          // THE EXCLUSION LIST IS MEASURED AND IS NOT #55's. A workstream is never in store-wide
          // search — `search` filters `kind != 'workstream'` on every branch — so telling a
          // checkpointing agent it fell "out of store-wide recall" would name a loss archiving did
          // not cause. Measured either side of `archiveCircle` on a circle holding concepts and a
          // checkpoint: `getActiveWorkstreams` and `getWorkstreamInbox` both still return it when
          // the circle is named, and the one thing that changes is that the circle leaves
          // `listCircles`' default listing — which is the route a later session takes back to this
          // work. That single exclusion is what the sentence claims, and all it claims.
          //
          // DATED TO THE WRITE, with a consequence conditional on the circle STILL being archived
          // and a place to LOOK rather than an act to perform — the three properties #55 settled on
          // in its rounds 3 and 4. Both halves here are frozen at the write, so the sentence may not
          // assert what the circle IS by the time it is read, and it must not prescribe
          // `unarchiveCircle`, which throws outright for an aliased name.
          ...(archivedLanding !== undefined
            ? {
              guidance:
                `ARCHIVED CIRCLE: '${archivedLanding}' was archived when this checkpoint landed. ` +
                `The checkpoint is saved and reachable by naming that circle, but while that circle ` +
                `remains archived it stays out of the default circle listing. Check or change the ` +
                `circle's state with memory_circle_manage.`,
            }
            : {}),
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
          circles: core.listCircles(undefined, { includeArchived: true }),
        };
        return readOk(response, "memory_circle_manage", capturedBlock);
      } catch (e) {
        return err(`circle_manage failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "agent_context",
    "Session-start orientation. Call first. Returns resolved `circle`; `resolvedFrom` marks an alias. `stageIndex` names moments whose rules require stage_lookup. Skeleton delivery has three states: no mirror fields means loaded standing files are current; `mirrorStale` + `instruction` requires user-confirmed reconciliation; `skeleton` contains members not covered by a standing file. A member's `homeCircle` names the circle it is homed in and appears only when that is not the circle you asked from; its absence means the member is homed here. `open` counts workstreams and inbox items still open — mention them to the user; resume only when asked.",
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
        // VERBATIM, by design — this surface fits the array by COUNT and never reshapes a member
        // field-by-field, so every field toSkeletonEntry sets reaches the wire, `homeCircle` (#127)
        // included. Kept deliberately: the response's own top-level `circle` is the ASKING circle,
        // so without the member's own home a globally delivered member reads as homed here.
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
  return {
    autoPrewarm: env.MONET_NO_AUTOPREWARM !== "1",
  };
}

export interface CreateMonetCoreMcpServerOptions {
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
  //
  // PHASE-TAGGED (#13): this is the LAST fallible step before the transport exists, and it runs
  // with the store already open and migrated — a half-alive process whose failure is otherwise
  // indistinguishable at the host from one that never opened anything. The tag rides on the
  // original error (a non-enumerable symbol), so every `instanceof` check downstream is unaffected.
  await inStartupPhase("embedder-pin", () => core.ensureEmbedderPin());
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
  // captured now, so whatever close behavior is wired in below is what runs.
  if (options.processShutdownHandlers !== false) installProcessShutdownHandlers(server, core);
  if (options.stdinEofShutdown !== false) installStdinEofShutdown(server, core);
  // Which side of the protocol boundary a failure below fell on (#13). Tracked rather than inferred
  // from where the throw came from: "the host never got a channel" and "the host had a live channel
  // and the process died anyway" are different diagnoses, and the catch cannot tell them apart
  // afterwards. Today nothing after connect() is expected to throw — that is a property of the
  // current close-chain wiring, not a guarantee — so this exists to keep the phase honest if one
  // ever does, rather than to serve a known failure.
  let transportConnected = false;
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    transportConnected = true;
    // Explicit server.close() (an embedded host managing its own lifecycle, or a test) must ALSO
    // settle the shared shutdown coordinator even if no signal/EOF trigger ever fires — see
    // settleGracefulShutdownOnExplicitClose (Codex P2 #1). Installed LAST/outermost so it wraps
    // the fully-assembled close chain.
    settleGracefulShutdownOnExplicitClose(server);
  } catch (error) {
    // Startup failed (e.g. transport.connect() rejected) after the installers above already
    // registered real process/stdin listeners for this now-abandoned server — settle the
    // coordinator so those listeners detach and their guards clear (Codex pass-3 P2, the third
    // settle-family member: see settleGracefulShutdownOnStartupFailure). The caller constructed
    // `core` and still owns it; this never touches it. Rethrow the SAME error object — the phase
    // tag is metadata attached to it, not a replacement for it, so this stays cleanup rather than
    // error handling.
    settleGracefulShutdownOnStartupFailure(server);
    throw markStartupPhase(error, transportConnected ? "post-connect" : "transport-connect");
  }
  return server;
}
