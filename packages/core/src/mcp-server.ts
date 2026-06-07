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

function ok(content: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(content, null, 2) }] };
}
function err(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function createMonetCoreMcpServer(core: MonetCore): Promise<McpServer> {
  const server = new McpServer({ name: "monet-core", version: "0.0.1" }, { capabilities: { tools: {} } });

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
        const r = await core.store(content, { circle, kind, sourceRefs });
        return ok({
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
        const results = await core.search(query, { circle, limit });
        return ok({
          results,
          guidance: "Cards show what a memory is about, not what it says. Call memory_fetch(id) to read it.",
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
        if (entity) return ok({ entity, concepts: core.conceptsForEntity(entity, circle) });
        return ok({ ...core.overview(circle) });
      } catch (e) {
        return err(`overview failed: ${msg(e)}`);
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
        const r = await core.gather(intent, { circle, limit, depth: depth ? Number(depth) : undefined });
        return ok({
          ranked: r.ranked,
          seed: r.seed,
          stopReason: r.stopReason,
          reachableByType: r.reachableByType,
          guidance: "Cards show what a memory is about, not what it says. Call memory_fetch(id) to read one.",
        });
      } catch (e) {
        return err(`gather failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "memory_fetch",
    "Read the full content of a concept by id. If `needsSynthesis` is true, the concept has new raw evidence: read `observations`, write ONE coherent `body` that reconciles them, and call memory_synthesize(id, body). You are the synthesizer.",
    { id: z.string() },
    async ({ id }) => {
      try {
        const c = await core.getConcept(id, { synthesize: false });
        if (!c) return err(`concept not found: ${id}`);
        return ok({
          id: c.id,
          kind: c.kind,
          body: c.body,
          observations: c.observations,
          supportCount: c.supportCount,
          confidence: c.confidence,
          version: c.version,
          needsSynthesis: c.needsSynthesis,
          ...(c.needsSynthesis
            ? {
                synthesisInstruction:
                  "This concept has unsynthesized evidence. Read `observations`, write a single coherent `body`, then call memory_synthesize(id, body).",
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
    { id: z.string(), body: z.string() },
    async ({ id, body }) => {
      try {
        const c = await core.applySynthesis(id, body);
        if (!c) return err(`concept not found: ${id}`);
        return ok({ id: c.id, version: c.version, dirty: c.dirty, message: "synthesis stored" });
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
        const saved = workstream ? await core.saveWorkstream(workstream, { circle, summary }) : null;
        const dirty = core.listDirty(circle);
        return ok({
          workstream: saved ? { id: saved.id, status: saved.payload.status, version: saved.version } : null,
          dirtyCount: dirty.length,
          dirty,
          guidance: dirty.length
            ? "For each dirty concept: read observations → write a coherent body → memory_synthesize(id, body)."
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
    },
    async ({ conceptId, detail, observationId, kind }) => {
      try {
        const c = core.flagContradiction(conceptId, { detail, observationId, kind });
        return ok({ contradictionId: c.id, conceptId: c.conceptId, status: c.status, detail: c.detail });
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
    },
    async ({ contradictionId, decision, body, resolvedBy }) => {
      try {
        const c = core.resolveContradiction(contradictionId, { decision, body, by: resolvedBy });
        if (!c) return err(`contradiction not found: ${contradictionId}`);
        return ok({ conceptId: c.id, status: c.status, version: c.version, confidence: Number(c.confidence.toFixed(2)) });
      } catch (e) {
        return err(`resolve failed: ${msg(e)}`);
      }
    },
  );

  server.tool(
    "agent_context",
    "Identity + query-independent session restore (PREWARM). Call FIRST, at session start — with NO query — to resume: `activeWorkstreams` (where you left off), `topConcepts` (your living model, ranked by confidence/usefulness/recency — identity + shape only, fetch by id for content), `staleConcepts` (unconfirmed — worth re-checking), and `openContradictions` (resolve with memory_resolve). Replaces guessing a search query to rebuild context.",
    { circle: z.string().optional() },
    async ({ circle }) => {
      const state = core.prewarm(circle);
      return ok({ agentId: core.getAgentId(), mode: "local", ...state });
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
