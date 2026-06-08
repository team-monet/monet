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
import { MonetCore } from "./engine";

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

function ok(content: Record<string, unknown>): CallToolResult {
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

export async function createMonetCoreMcpServer(core: MonetCore): Promise<McpServer> {
  const server = new McpServer({ name: "monet-core", version: "0.0.1" }, { capabilities: { tools: {} } });

  // When a tool call omits `circle`, fall back to the runtime's configured default (e.g. a per-project
  // circle the local client derived from the working tree) — so one shared store isolates per project.
  const dc = core.getDefaultCircle();
  const scope = (circle?: string): string => circle ?? dc;

  server.tool(
    "memory_store",
    "Store something worth remembering. The substrate dedupes automatically: similar evidence resolves into an existing concept (no duplicates); novel evidence creates a new one. Cheap and instant — synthesis happens later, on read.",
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
    },
    async ({ content, circle, kind, sourceRefs }) => {
      try {
        const r = await core.store(content, { circle: scope(circle), kind, sourceRefs });
        return ok({
          circle: scope(circle), // the circle these ids live in — pass it to id-based tools if it isn't your session default
          action: r.action,
          conceptId: r.conceptId,
          score: Number(r.score.toFixed(3)),
          ...(r.contradiction
            ? { contradiction: { id: r.contradiction.id, status: r.contradiction.status, detail: r.contradiction.detail } }
            : {}),
        });
      } catch (e) {
        return err(`store failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_search",
    "Search memory. Returns structural CARDS — what each memory is about and how much is in it (kind, support count, confidence, fetch hint) — but NEVER the content. To actually read a memory you MUST call memory_fetch; the answer is never in the search result.",
    { query: z.string(), circle: z.string().optional(), limit: z.number().int().positive().optional() },
    async ({ query, circle, limit }) => {
      try {
        const results = await core.search(query, { circle: scope(circle), limit });
        return ok({
          circle: scope(circle),
          results,
          guidance:
            "Cards show what a memory is about, not what it says. Call memory_fetch(id) to read it — if `circle` above isn't your session default, pass it: memory_fetch(id, circle).",
        });
      } catch (e) {
        return err(`search failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_overview",
    'A glanceable, read-only snapshot of everything stored for a circle — counts (incl. dirty/disputed/stale), the living model (top concepts), where you left off (active threads), open contradictions, and the connection-graph shape (entity hubs, most-connected memories, edge-type histogram). Use to answer "what do you actually know about this?" or to report memory health. Read-only — never mutates, never returns memory bodies; fetch by id to read one. Pass `entity` to list the memories tied to one hub.',
    { circle: z.string().optional(), entity: z.string().optional() },
    async ({ circle, entity }) => {
      try {
        if (entity) return ok({ circle: scope(circle), entity, concepts: core.conceptsForEntity(entity, scope(circle)) });
        return ok({ ...core.overview(scope(circle)) });
      } catch (e) {
        return err(`overview failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_list",
    "Enumerate a circle's memories as structural cards — id, title, kind, support count, confidence, open contradictions — optionally with `withProvenance` for the project path(s) each memory's evidence came from. PAGINATED: returns up to `limit` (default 50) from `offset`, plus `total` and a `nextOffset` cursor when more remain — page until `nextOffset` is absent so a large legacy circle is fully enumerable. Read-only; never returns bodies (memory_fetch reads one). Built for organizing/migrating memory: list a circle (e.g. the legacy \"default\"), group by content + where it came from, then memory_reassign_circle each into its project's circle.",
    {
      circle: z.string().optional(),
      withProvenance: z
        .boolean()
        .optional()
        .describe("Include each memory's `provenance`: the distinct working-dir paths its observations were recorded under (the strongest signal for which project it belongs to)."),
      limit: z.number().int().positive().max(200).optional().describe("Max memories to return (default 50)."),
      offset: z.number().int().nonnegative().optional().describe("Start index for paging (default 0); pass the prior response's `nextOffset` to continue."),
    },
    async ({ circle, withProvenance, limit, offset }) => {
      try {
        const lim = limit ?? 50;
        const off = offset ?? 0;
        const memories = core.listMemories(scope(circle), { withProvenance, limit: lim, offset: off });
        const total = core.conceptCount(scope(circle));
        const nextOffset = off + memories.length < total ? off + memories.length : null;
        return ok({
          circle: scope(circle),
          total,
          offset: off,
          count: memories.length,
          ...(nextOffset != null ? { nextOffset } : {}),
          memories,
          guidance:
            `Cards show what each memory is about, not what it says. ${nextOffset != null ? `More remain — call again with offset=${nextOffset} to get the rest. ` : ""}Group by title/kind + provenance, then memory_reassign_circle(id, toCircle) to move each into its project's circle. memory_fetch(id) to read one.`,
        });
      } catch (e) {
        return err(`list failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_gather",
    "Rebuild the FULL working context for an intent — not just the most-similar few. Seeds from the intent, then spreads across the connection graph (entity, causal, and same-session co-occurrence edges, ≤2 hops) and stops when evidence saturates. Use at the start of a task or when resuming a thread: it recovers the related concepts — decisions, open questions, files worked on together — that a plain memory_search misses because they're worded differently. Returns structural cards (ranked); call memory_fetch(id) to read one.",
    {
      intent: z.string(),
      circle: z.string().optional(),
      limit: z.number().int().positive().optional(),
      depth: z.enum(["1", "2"]).optional().describe("Graph hops from the seeds (default 2)."),
    },
    async ({ intent, circle, limit, depth }) => {
      try {
        const r = await core.gather(intent, { circle: scope(circle), limit, depth: depth ? Number(depth) : undefined });
        return ok({
          circle: scope(circle),
          ranked: r.ranked,
          seed: r.seed,
          stopReason: r.stopReason,
          reachableByType: r.reachableByType,
          guidance:
            "Cards show what a memory is about, not what it says. Call memory_fetch(id) to read one — if `circle` above isn't your session default, pass it: memory_fetch(id, circle).",
        });
      } catch (e) {
        return err(`gather failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_fetch",
    "Read the full content of a concept by id. If `needsSynthesis` is true, the concept has new raw evidence: read `observations`, write ONE coherent `body` that reconciles them, and call memory_synthesize(id, body). You are the synthesizer.",
    { id: z.string(), circle: z.string().optional().describe("The circle the id belongs to (defaults to this session's circle). Pass it when reading results of a search/gather you ran on an explicit circle.") },
    async ({ id, circle }) => {
      try {
        // Scope enforcement: an id from another project's circle must not be readable here (ids leak
        // across sessions / get pasted from prior output). `scope(circle)` honors an explicit circle the
        // client searched, defaulting to this session's circle. Check before getConcept's usefulness bump.
        if (core.circleOf(id) !== scope(circle)) return err(`concept not found: ${id}`);
        const c = await core.getConcept(id, { synthesize: false });
        if (!c) return err(`concept not found: ${id}`);
        // Bound the result: keep the most-recent observations and clip long text, so a heavily-supported
        // concept still fetches instead of being rejected by the host's tool-result limit.
        const total = c.observations.length;
        const kept = c.observations.slice(Math.max(0, total - FETCH_MAX_OBS));
        const omitted = total - kept.length;
        const body = clip(c.body ?? "", FETCH_BODY_MAX_CHARS);
        return ok({
          id: c.id,
          circle: c.circle, // pass this back to memory_synthesize if it isn't your session default
          kind: c.kind,
          body: body.text,
          ...(body.clipped ? { bodyTruncated: true } : {}),
          observations: kept.map((o) => clip(o, FETCH_OBS_MAX_CHARS).text),
          observationCount: total,
          ...(omitted > 0
            ? {
                observationsOmitted: omitted,
                observationsNote: `Showing the ${kept.length} most-recent of ${total} observations; older ones omitted to fit the host limit.`,
              }
            : {}),
          supportCount: c.supportCount,
          confidence: c.confidence,
          version: c.version,
          needsSynthesis: c.needsSynthesis,
          // Only invite synthesis when ALL evidence is shown. memory_synthesize clears `dirty` with the
          // body the agent writes, so synthesizing from a truncated view would discard the omitted
          // observations from the canonical body — don't ask for it here.
          ...(c.needsSynthesis && omitted === 0
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
        });
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
      try {
        if (core.circleOf(id) !== scope(circle)) return err(`concept not found: ${id}`); // scope enforcement
        const c = await core.applySynthesis(id, body);
        if (!c) return err(`concept not found: ${id}`);
        return ok({ id: c.id, circle: scope(circle), version: c.version, dirty: c.dirty, message: "synthesis stored" });
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
      try {
        const saved = workstream ? await core.saveWorkstream(workstream, { circle: scope(circle), summary }) : null;
        const dirty = core.listDirty(scope(circle));
        return ok({
          circle: scope(circle),
          workstream: saved ? { id: saved.id, status: saved.payload.status, version: saved.version } : null,
          dirtyCount: dirty.length,
          dirty,
          guidance: dirty.length
            ? "For each dirty concept: read observations → write a coherent body → memory_synthesize(id, body). If `circle` above isn't your session default, pass it: memory_synthesize(id, body, circle)."
            : saved
              ? "Workstream saved — next session's agent_context will restore it. Nothing left to synthesize."
              : "Nothing to synthesize.",
        });
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
      try {
        if (core.circleOf(conceptId) !== scope(circle)) return err(`concept not found: ${conceptId}`); // scope enforcement
        const c = core.flagContradiction(conceptId, { detail, observationId, kind });
        return ok({ circle: scope(circle), contradictionId: c.id, conceptId: c.conceptId, status: c.status, detail: c.detail });
      } catch (e) {
        return err(`flag failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_resolve",
    "Mediate a contradiction — never silent last-write-wins. decision: 'accept-new' (the correcting evidence wins), 'keep-current' (the prior wins), or 'dismiss' (not a real conflict). The losing observation is superseded; for accept/keep, pass the reconciled `body`. The concept restores to active once no conflicts remain.",
    {
      contradictionId: z.string(),
      decision: z.enum(["accept-new", "keep-current", "dismiss"]),
      body: z.string().optional(),
      resolvedBy: z.string().optional(),
      circle: z.string().optional().describe("The circle the contradiction belongs to (defaults to this session's circle)."),
    },
    async ({ contradictionId, decision, body, resolvedBy, circle }) => {
      try {
        if (core.circleOfContradiction(contradictionId) !== scope(circle)) return err(`contradiction not found: ${contradictionId}`); // scope enforcement
        const c = core.resolveContradiction(contradictionId, { decision, body, by: resolvedBy });
        if (!c) return err(`contradiction not found: ${contradictionId}`);
        return ok({ circle: scope(circle), conceptId: c.id, status: c.status, version: c.version, confidence: Number(c.confidence.toFixed(2)) });
      } catch (e) {
        return err(`resolve failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_reassign_circle",
    "Move a memory — its concept, its observations, and its graph membership — from its current circle into another. The apply step of a memory migration: home a piece of unscoped \"default\" memory into its project's circle. Dedupes: if the target circle already holds a matching memory, the two MERGE (no duplicate, no re-embedding) and `action` comes back \"merged\". Non-destructive to other memories; moves one at a time so you can preview, confirm, then apply in batches. Pass `circle` = the id's CURRENT circle (e.g. \"default\") if it isn't your session default.",
    {
      id: z.string(),
      toCircle: z.string().describe("The destination circle (e.g. the project's per-project circle)."),
      circle: z.string().optional().describe("The id's CURRENT circle (defaults to this session's circle). Pass \"default\" when migrating legacy unscoped memory."),
    },
    async ({ id, toCircle, circle }) => {
      try {
        // Scope enforcement: you may only reassign an id that lives in the circle you named (the
        // caller's session default, or an explicit source circle) — ids leak across sessions/output.
        if (core.circleOf(id) !== scope(circle)) return err(`concept not found: ${id}`);
        const r = core.reassignCircle(id, toCircle);
        if (!r) return err(`concept not found: ${id}`);
        return ok({
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
        });
      } catch (e) {
        return err(`reassign failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "agent_context",
    "Identity + query-independent session restore (PREWARM). Call FIRST, at session start — with NO query — to resume: `activeWorkstreams` (where you left off), `topConcepts` (your living model, ranked by confidence/usefulness/recency — identity + shape only, fetch by id for content), `staleConcepts` (unconfirmed — worth re-checking), and `openContradictions` (resolve with memory_resolve). Replaces guessing a search query to rebuild context.",
    { circle: z.string().optional() },
    async ({ circle }) => {
      const state = core.prewarm(scope(circle));
      return ok({ agentId: core.getAgentId(), mode: "local", circle: scope(circle), ...state });
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
