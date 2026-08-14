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

  // Session survival (#241): checkpoint a compressed workstream, then pull it on continuation intent.
  const ck = parse(
    await client.callTool({
      name: "memory_checkpoint",
      arguments: {
        workstream: {
          status: "active",
          open: [
            { kind: "question", text: "does continuation restore this next session?" },
            { kind: "step", text: "call memory_workstreams on continuation intent" },
          ],
        },
      },
    }),
  );
  const ckWs = ck.workstream as { id: string; status?: string; opened: string[] } | undefined;
  console.log(`\ncheckpoint → workstream ${ckWs?.id.slice(0, 8)} opened=${ckWs?.opened.length ?? 0}`);

  const ctx = parse(await client.callTool({ name: "agent_context", arguments: {} }));
  if (typeof ctx.circle !== "string" || ctx.circle.length === 0) throw new Error("agent_context did not return session orientation");
  const workstreamList = parse(await client.callTool({ name: "memory_workstreams", arguments: {} }));
  const wss = (workstreamList.workstreams as Array<{ id: string; title: string; status: string }> | undefined) ?? [];
  const detail = parse(await client.callTool({ name: "memory_workstreams", arguments: { id: wss[0]?.id } }));
  console.log(
    `agent_context → circle=${ctx.circle}; memory_workstreams → ${wss.length} thread(s); ` +
      `items=${JSON.stringify(detail.items)}`,
  );
  if (wss.length !== 1 || ckWs?.id !== wss[0]?.id) throw new Error("workstream did not round-trip through checkpoint → memory_workstreams");

  // Contradiction lifecycle (#240): flag drift, see it in overview, then mediate it away.
  const flag = parse(
    await client.callTool({
      name: "memory_flag_contradiction",
      arguments: { conceptId: a.conceptId, detail: "a newer note claims it is NOT SQLite" },
    }),
  );
  const overviewDisputed = parse(await client.callTool({ name: "memory_overview", arguments: {} }));
  const openBefore = ((overviewDisputed.openContradictions as unknown[]) ?? []).length;
  console.log(`\nflag → contradiction ${String(flag.contradictionId).slice(0, 8)}; overview openContradictions=${openBefore}`);

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
  const overviewResolved = parse(await client.callTool({ name: "memory_overview", arguments: {} }));
  const openAfter = ((overviewResolved.openContradictions as unknown[]) ?? []).length;
  console.log(`resolve(accept-new) → concept status=${res.status}; overview openContradictions=${openAfter}`);
  if (openBefore !== 1 || openAfter !== 0 || res.status !== "active") throw new Error("contradiction lifecycle did not round-trip");

  await client.close();
  console.log("\n✓ full MCP dance ran end-to-end (store → search → fetch → synthesize → checkpoint → orient → continue → flag → resolve)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
