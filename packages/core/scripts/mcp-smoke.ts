/**
 * End-to-end MCP smoke test — spawns the monet-core MCP server and drives it as a real
 * client would, exercising the full "agent drives it live + is the synthesizer" loop:
 *   store (dedup) → search (card, no body) → fetch (needsSynthesis) → synthesize → re-fetch.
 *
 *   pnpm --filter @monet/core mcp:smoke
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface ToolText {
  content: Array<{ type: string; text: string }>;
}
function parse(r: unknown): Record<string, unknown> {
  return JSON.parse((r as ToolText).content[0].text);
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "scripts/mcp-cli.ts"],
    env: { ...process.env, MONET_STORAGE_DIR: `/tmp/monet-core-smoke-${process.pid}` },
  });
  const client = new Client({ name: "smoke", version: "0.0.1" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("tools:", tools.tools.map((t) => t.name).join(", "));

  const a = parse(
    await client.callTool({
      name: "memory_store",
      arguments: { content: "We decided to use SQLite as the storage backend for Monet Local.", kind: "decision" },
    }),
  );
  console.log(`\nstore A → ${a.action}  ${String(a.conceptId).slice(0, 8)}`);
  const b = parse(
    await client.callTool({
      name: "memory_store",
      arguments: { content: "Monet Local uses SQLite for its local storage backend." },
    }),
  );
  console.log(`store B → ${b.action}  (score ${b.score})  same concept as A? ${b.conceptId === a.conceptId}`);

  const search = parse(
    await client.callTool({ name: "memory_search", arguments: { query: "what does monet local use for storage" } }),
  );
  const top = (search.results as Array<Record<string, unknown>>)[0];
  console.log(`\nsearch top card → kind=${top.kind} support=${top.supportCount}  "body" in card? ${"body" in top}`);

  const fetched = parse(await client.callTool({ name: "memory_fetch", arguments: { id: a.conceptId } }));
  const evidence = parse(await client.callTool({ name: "memory_fetch", arguments: { id: a.conceptId, observations: true } }));
  console.log(`\nfetch → needsSynthesis=${fetched.needsSynthesis}  observationCount=${fetched.observationCount}`);
  console.log(`  explicit evidence page → observations=${(evidence.observations as string[]).length}`);

  const syn = parse(
    await client.callTool({
      name: "memory_synthesize",
      arguments: { id: a.conceptId, body: "Monet Local uses a local SQLite database file as its storage backend." },
    }),
  );
  console.log(`\nsynthesize (agent wrote the body) → ${syn.message}  dirty=${syn.dirty}`);

  const fetched2 = parse(await client.callTool({ name: "memory_fetch", arguments: { id: a.conceptId } }));
  console.log(`re-fetch → needsSynthesis=${fetched2.needsSynthesis}  body="${fetched2.body}"`);

  // Session survival (#241): checkpoint a compressed workstream, then restore it via agent_context.
  const ck = parse(
    await client.callTool({
      name: "memory_checkpoint",
      arguments: {
        summary: "smoke session",
        workstream: {
          status: "active",
          openQuestions: ["does prewarm restore this next session?"],
          nextSteps: ["call agent_context at session start"],
          decisions: [a.conceptId],
        },
      },
    }),
  );
  const ckWs = ck.workstream as { id: string; status: string; version: number } | null;
  console.log(`\ncheckpoint → workstream ${ckWs?.id.slice(0, 8)} (status ${ckWs?.status}), dirtyCount=${ck.dirtyCount}`);

  const ctx = parse(await client.callTool({ name: "agent_context", arguments: {} }));
  const wss = (ctx.activeWorkstreams as Array<{ id: string; nextSteps?: string[] }> | undefined) ?? [];
  const living = (ctx.topConcepts as Array<{ id: string; title: string; kind: string }> | undefined) ?? [];
  const firstCard = living[0];
  console.log(
    `agent_context (prewarm) → ${wss.length} workstream(s); nextSteps=${JSON.stringify(wss[0]?.nextSteps)}; ` +
      `${living.length} living-model concept(s), top="${firstCard?.title}" (body in card? ${firstCard ? "body" in firstCard : false})`,
  );
  if (wss.length !== 1 || ckWs?.id !== wss[0]?.id) throw new Error("workstream did not round-trip through checkpoint → agent_context");
  if (!living.some((c) => c.id === a.conceptId)) throw new Error("prewarm topConcepts missing the stored concept");

  // Contradiction lifecycle (#240): flag drift, see it in prewarm, then mediate it away.
  const flag = parse(
    await client.callTool({
      name: "memory_flag_contradiction",
      arguments: { conceptId: a.conceptId, detail: "a newer note claims it is NOT SQLite" },
    }),
  );
  const ctxDisputed = parse(await client.callTool({ name: "agent_context", arguments: {} }));
  const openBefore = ((ctxDisputed.openContradictions as unknown[]) ?? []).length;
  console.log(`\nflag → contradiction ${String(flag.contradictionId).slice(0, 8)}; prewarm openContradictions=${openBefore}`);

  const res = parse(
    await client.callTool({
      name: "memory_resolve",
      arguments: {
        contradictionId: flag.contradictionId,
        decision: "accept-new",
        body: "Monet Local uses SQLite as its storage backend.",
        resolvedBy: "smoke",
      },
    }),
  );
  const ctxResolved = parse(await client.callTool({ name: "agent_context", arguments: {} }));
  const openAfter = ((ctxResolved.openContradictions as unknown[]) ?? []).length;
  console.log(`resolve(accept-new) → concept status=${res.status}; prewarm openContradictions=${openAfter}`);
  if (openBefore !== 1 || openAfter !== 0 || res.status !== "active") throw new Error("contradiction lifecycle did not round-trip");

  await client.close();
  console.log("\n✓ full MCP dance ran end-to-end (store → search → fetch → synthesize → checkpoint → prewarm → flag → resolve)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
