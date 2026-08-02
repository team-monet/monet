import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MonetCore, type SkeletonEntry } from "../engine";
import { upsertStage } from "../gates";
import { registerMonetCoreTools } from "../mcp-server";
import { MIRROR_STALE_INSTRUCTION } from "../skeleton-mirror";

const cores: MonetCore[] = [];
type RawDb = {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
};
const raw = (core: MonetCore): RawDb => (core as unknown as { db: RawDb }).db;
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const block = (scope: string, body = "# Standing skeleton") =>
  `<!-- BEGIN monet:skeleton scope=${scope} -->\n${body}\n<!-- END monet:skeleton -->`;

function fixture(): { root: string; db: string; core: MonetCore } {
  const root = mkdtempSync(join(tmpdir(), "monet-skeleton-mirror-"));
  const db = join(root, "monet.db");
  const core = new MonetCore(db, {
    tauAttach: 1.1,
    tauAmbiguous: 1.1,
    sourceStorageDir: join(root, "sources"),
  });
  cores.push(core);
  return { root, db, core };
}

const declaredBodies = {
  global: "Global governing principle.",
  alpha: "Alpha local preference.",
  beta: "Beta local principle.",
} as const;

async function seed(core: MonetCore): Promise<{ global: SkeletonEntry; alpha: SkeletonEntry; beta: SkeletonEntry }> {
  await core.declare({ species: "principle", content: declaredBodies.global, circle: "*" });
  await core.declare({ species: "preference", content: declaredBodies.alpha, circle: "alpha" });
  await core.declare({ species: "principle", content: declaredBodies.beta, circle: "beta" });
  const global = core.skeleton("alpha").find((entry) => entry.breadth === "global")!;
  const alpha = core.skeleton("alpha").find((entry) => entry.breadth === "local")!;
  const beta = core.skeleton("beta").find((entry) => entry.breadth === "local")!;
  return { global, alpha, beta };
}

function stateHash(entries: readonly SkeletonEntry[]): string {
  const bodies = Object.fromEntries(entries.map((entry) => {
    const body = entry.breadth === "global"
      ? declaredBodies.global
      : entry.species === "preference" ? declaredBodies.alpha : declaredBodies.beta;
    return [entry.conceptId, body];
  }));
  return stateHashWithBodies(entries, bodies);
}

function stateHashWithBodies(entries: readonly SkeletonEntry[], bodies: Readonly<Record<string, string>> = {}): string {
  const canonical = [...entries]
    .sort((a, b) => a.conceptId < b.conceptId ? -1 : a.conceptId > b.conceptId ? 1 : 0)
    .map(({ conceptId, content, breadth }) => ({ conceptId, body: bodies[conceptId] ?? content, breadth }));
  return sha256(JSON.stringify(canonical));
}

type Surface = { path: string; scope: "global" | { circle: string }; text?: string; entry?: Partial<{ blockHash: string; skeletonState: string; when: number }> | null };
function register(root: string, surfaces: Surface[], states: { global: string; circles: Record<string, string> }): void {
  const manifest = {
    surfaces: surfaces.map(({ path, scope }) => ({ path, scope })),
    materialized: Object.fromEntries(surfaces.flatMap((surface) => {
      if (surface.entry === null) return [];
      const text = surface.text ?? block(surface.scope === "global" ? "global" : surface.scope.circle);
      writeFileSync(surface.path, text);
      const scopeState = surface.scope === "global" ? states.global : states.circles[surface.scope.circle]!;
      return [[surface.path, {
        blockHash: sha256(text),
        skeletonState: scopeState,
        when: 1,
        ...surface.entry,
      }]];
    })),
  };
  writeFileSync(join(root, "materialize.json"), JSON.stringify(manifest));
}

afterEach(() => {
  while (cores.length > 0) cores.pop()!.close();
});

describe("prewarm skeleton mirror delivery", () => {
  it("skeletonBodies returns verbatim bodies in skeleton order without touching usefulness", async () => {
    const { core } = fixture();
    const multiline = "Alpha first line.\nAlpha second line remains verbatim.";
    await core.declare({ species: "principle", content: "Global body.", circle: "*" });
    await core.declare({ species: "preference", content: multiline, circle: "alpha" });
    const compact = core.skeleton("alpha");
    const before = raw(core).prepare(
      `SELECT usefulness_score, usefulness_last_fetched_at FROM concepts WHERE id = ?`,
    ).get(compact[1]!.conceptId);

    const bodies = core.skeletonBodies("alpha");

    expect(bodies.map((entry) => entry.conceptId)).toEqual(compact.map((entry) => entry.conceptId));
    expect(bodies[1]).toMatchObject({
      conceptId: compact[1]!.conceptId,
      species: "preference",
      body: multiline,
      breadth: "local",
    });
    expect(raw(core).prepare(
      `SELECT usefulness_score, usefulness_last_fetched_at FROM concepts WHERE id = ?`,
    ).get(compact[1]!.conceptId)).toEqual(before);
  });

  it("bootstrap with no registry delivers the full global + local union in-band", async () => {
    const { core } = fixture();
    const { global, alpha } = await seed(core);
    const state = core.prewarm("alpha");
    expect(state.skeleton?.map((entry) => entry.conceptId)).toEqual([global.conceptId, alpha.conceptId]);
    expect(state).not.toHaveProperty("mirrorStale");
    expect(state).not.toHaveProperty("instruction");
  });

  it("an unparseable registry is bootstrap, never an error", async () => {
    const { root, core } = fixture();
    const { global, alpha } = await seed(core);
    writeFileSync(join(root, "materialize.json"), "{not json");
    expect(core.prewarm("alpha").skeleton?.map((entry) => entry.conceptId))
      .toEqual([global.conceptId, alpha.conceptId]);
  });

  it("hashes each member's full body while in-band delivery stays compact", async () => {
    const { root, core } = fixture();
    const original = "Global first line.\nSecond line changes the materialized state.";
    await core.declare({ species: "principle", content: original, circle: "*" });
    const global = core.skeleton("alpha")[0]!;
    expect(global.content).toBe("Global first line");
    const states = {
      global: stateHashWithBodies([global], { [global.conceptId]: original }),
      circles: { alpha: stateHash([]) },
    };
    const path = join(root, "global.md");
    register(root, [{ path, scope: "global" }], states);
    expect(core.prewarm("alpha")).not.toHaveProperty("mirrorStale");

    const changedSecondLine = "Global first line.\nA different second line must move the store hash.";
    await core.applySynthesis(global.conceptId, changedSecondLine);
    expect(core.skeleton("alpha")[0]!.content).toBe(global.content);
    expect(core.prewarm("alpha").mirrorStale).toEqual([{ path, reason: "store-moved" }]);
  });

  it("a hand-built golden manifest is fresh and omits every action field", async () => {
    const { root, core } = fixture();
    const { global, alpha } = await seed(core);
    const globalPath = join(root, "GLOBAL.md");
    const localPath = join(root, "ALPHA.md");
    const globalBlock = block("global", "Global exact block.");
    const localBlock = block("alpha", "Alpha exact block.");
    writeFileSync(globalPath, `prefix\n${globalBlock}\nsuffix\n`);
    writeFileSync(localPath, localBlock);

    // Golden fixture: canonical JSON is authored here from the contract text, not by production code.
    const globalJson = JSON.stringify([{ conceptId: global.conceptId, body: declaredBodies.global, breadth: "global" }]);
    const localJson = JSON.stringify([{ conceptId: alpha.conceptId, body: declaredBodies.alpha, breadth: "local" }]);
    writeFileSync(join(root, "materialize.json"), JSON.stringify({
      surfaces: [
        { path: globalPath, scope: "global" },
        { path: localPath, scope: { circle: "alpha" } },
      ],
      materialized: {
        [globalPath]: { blockHash: sha256(globalBlock), skeletonState: sha256(globalJson), when: 1 },
        [localPath]: { blockHash: sha256(localBlock), skeletonState: sha256(localJson), when: 2 },
      },
    }));

    const state = core.prewarm("alpha") as unknown as Record<string, unknown>;
    expect(state).not.toHaveProperty("skeleton");
    expect(state).not.toHaveProperty("mirrorStale");
    expect(state).not.toHaveProperty("instruction");
  });

  it("derives block-missing first for absent files, absent markers, and absent manifest entries", async () => {
    const { root, core } = fixture();
    const { global, alpha } = await seed(core);
    const states = { global: stateHash([global]), circles: { alpha: stateHash([alpha]) } };
    const absent = join(root, "absent.md");
    const noMarkers = join(root, "no-markers.md");
    const noEntry = join(root, "no-entry.md");
    writeFileSync(noMarkers, "ordinary prose only");
    writeFileSync(noEntry, block("alpha", "present block"));
    register(root, [
      { path: absent, scope: "global", text: block("global"), entry: { blockHash: sha256("wrong"), skeletonState: "wrong" } },
      { path: noMarkers, scope: { circle: "alpha" }, text: "ordinary prose only", entry: { blockHash: sha256("ordinary prose only"), skeletonState: "wrong" } },
      { path: noEntry, scope: { circle: "alpha" }, entry: null },
    ], states);
    // register writes configured texts; remove the file fixture by pointing its declared surface at a path never written.
    const manifest = JSON.parse(requireManifest(root));
    delete manifest.materialized[noEntry];
    writeFileSync(join(root, "materialize.json"), JSON.stringify(manifest));
    rmSync(absent);

    expect(core.prewarm("alpha").mirrorStale).toEqual([
      { path: absent, reason: "block-missing" },
      { path: noMarkers, reason: "block-missing" },
      { path: noEntry, reason: "block-missing" },
    ]);
  });

  it("block-edited wins over store-moved, and fresh surfaces are excluded", async () => {
    const { root, core } = fixture();
    const { global, alpha } = await seed(core);
    const states = { global: stateHash([global]), circles: { alpha: stateHash([alpha]) } };
    const editedPath = join(root, "edited.md");
    const freshPath = join(root, "fresh.md");
    const editedText = block("global", "hand edit");
    register(root, [
      { path: editedPath, scope: "global", text: editedText, entry: { blockHash: sha256(block("global", "old")), skeletonState: "also-stale" } },
      { path: freshPath, scope: { circle: "alpha" } },
    ], states);
    const state = core.prewarm("alpha");
    expect(state.mirrorStale).toEqual([{ path: editedPath, reason: "block-edited" }]);
    expect(state.instruction).toBe(MIRROR_STALE_INSTRUCTION);
    expect(state).not.toHaveProperty("skeleton");
  });

  it("reports store-moved only after the block hash matches", async () => {
    const { root, core } = fixture();
    const { global, alpha } = await seed(core);
    const states = { global: stateHash([global]), circles: { alpha: stateHash([alpha]) } };
    const path = join(root, "global.md");
    register(root, [{ path, scope: "global", entry: { skeletonState: sha256("stale state") } }], states);
    expect(core.prewarm("alpha").mirrorStale).toEqual([{ path, reason: "store-moved" }]);
  });

  it("reports both covered-stale halves without sending either half in-band", async () => {
    const { root, core } = fixture();
    const { global, alpha } = await seed(core);
    const states = { global: stateHash([global]), circles: { alpha: stateHash([alpha]) } };
    const globalPath = join(root, "global.md");
    const localPath = join(root, "alpha.md");
    register(root, [
      { path: globalPath, scope: "global", entry: { skeletonState: "stale-global" } },
      { path: localPath, scope: { circle: "alpha" }, entry: { skeletonState: "stale-local" } },
    ], states);
    const state = core.prewarm("alpha");
    expect(state).not.toHaveProperty("skeleton");
    expect(state.mirrorStale).toEqual([
      { path: globalPath, reason: "store-moved" },
      { path: localPath, reason: "store-moved" },
    ]);
  });

  it.each([
    { name: "fresh + uncovered", stale: false },
    { name: "stale + uncovered", stale: true },
  ])("composes covered-$name local with an uncovered global half", async ({ stale }) => {
    const { root, core } = fixture();
    const { global, alpha } = await seed(core);
    const states = { global: stateHash([global]), circles: { alpha: stateHash([alpha]) } };
    const path = join(root, "alpha.md");
    register(root, [{ path, scope: { circle: "alpha" }, ...(stale ? { entry: { skeletonState: "stale" } } : {}) }], states);
    const state = core.prewarm("alpha");
    expect(state.skeleton?.map((entry) => entry.conceptId)).toEqual([global.conceptId]);
    expect(state.mirrorStale).toEqual(stale ? [{ path, reason: "store-moved" }] : undefined);
  });

  it.each([
    { name: "fresh + uncovered", stale: false },
    { name: "stale + uncovered", stale: true },
  ])("composes covered-$name global with an uncovered local half", async ({ stale }) => {
    const { root, core } = fixture();
    const { global, alpha } = await seed(core);
    const states = { global: stateHash([global]), circles: { alpha: stateHash([alpha]) } };
    const path = join(root, "global.md");
    register(root, [{ path, scope: "global", ...(stale ? { entry: { skeletonState: "stale" } } : {}) }], states);
    const state = core.prewarm("alpha");
    expect(state.skeleton?.map((entry) => entry.conceptId)).toEqual([alpha.conceptId]);
    expect(state.mirrorStale).toEqual(stale ? [{ path, reason: "store-moved" }] : undefined);
  });

  it("uses store-wide global members and only the requested circle's local members", async () => {
    const { root, core } = fixture();
    const { global, alpha, beta } = await seed(core);
    const states = {
      global: stateHash([global]),
      circles: { alpha: stateHash([alpha]), beta: stateHash([beta]) },
    };
    const globalPath = join(root, "global.md");
    const alphaPath = join(root, "alpha.md");
    const betaPath = join(root, "beta.md");
    register(root, [
      { path: globalPath, scope: "global" },
      { path: alphaPath, scope: { circle: "alpha" } },
      { path: betaPath, scope: { circle: "beta" } },
    ], states);
    expect(core.prewarm("alpha")).not.toHaveProperty("skeleton");
    expect(core.prewarm("alpha")).not.toHaveProperty("mirrorStale");

    await core.declare({ species: "preference", content: "Another beta-only preference.", circle: "beta" });
    expect(core.prewarm("alpha")).not.toHaveProperty("mirrorStale");
    expect(core.prewarm("beta").mirrorStale).toEqual([{ path: betaPath, reason: "store-moved" }]);

    await core.declare({ species: "preference", content: "Another global preference.", circle: "*" });
    expect(core.prewarm("alpha").mirrorStale).toEqual([{ path: globalPath, reason: "store-moved" }]);
  });

  it("matches a registered circle through aliases after rename and checks staleness on both names", async () => {
    const { root, core } = fixture();
    await core.declare({ species: "preference", content: declaredBodies.alpha, circle: "old" });
    const local = core.skeleton("old").find((entry) => entry.breadth === "local")!;
    const path = join(root, "old-circle.md");
    register(root, [{ path, scope: { circle: "old" } }], {
      global: stateHash([]),
      circles: { old: stateHash([local]) },
    });

    core.renameCircle("old", "new");
    expect(core.prewarm("old")).not.toHaveProperty("skeleton");
    expect(core.prewarm("old")).not.toHaveProperty("mirrorStale");
    expect(core.prewarm("new")).not.toHaveProperty("skeleton");
    expect(core.prewarm("new")).not.toHaveProperty("mirrorStale");

    await core.declare({ species: "principle", content: "New local member.", circle: "new" });
    expect(core.prewarm("old").mirrorStale).toEqual([{ path, reason: "store-moved" }]);
    expect(core.prewarm("new").mirrorStale).toEqual([{ path, reason: "store-moved" }]);
  });

  it("bounds oversized mirrorStale on agent_context without corrupting JSON", async () => {
    const { root, core } = fixture();
    const surfaces = Array.from({ length: 350 }, (_, i) => ({
      path: join(root, `standing-skeleton-${String(i).padStart(3, "0")}-${"x".repeat(60)}.md`),
      scope: "global" as const,
    }));
    writeFileSync(join(root, "materialize.json"), JSON.stringify({ surfaces, materialized: {} }));
    const server = new McpServer({ name: "mirror-test", version: "1" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, core, { autoPrewarm: false, checkpointNudge: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "mirror-client", version: "1" });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: "agent_context", arguments: { circle: "alpha" } }) as {
        content: Array<{ type: string; text: string }>;
      };
      expect(() => JSON.parse(result.content[0]!.text)).not.toThrow();
      const payload = JSON.parse(result.content[0]!.text);
      expect(payload.mirrorStaleTruncated).toBe(true);
      expect(payload.mirrorStaleOmitted).toBeGreaterThan(0);
      expect(payload.mirrorStale.length).toBeGreaterThan(0);
      expect(payload.instruction).toBe(MIRROR_STALE_INSTRUCTION);
      expect(payload).toHaveProperty("activeWorkstreams");
      expect(payload).toHaveProperty("topConcepts");
      expect(payload).toHaveProperty("staleCount");
      expect(payload).not.toHaveProperty("firstBlock");
      expect(result.content[0]!.text.length).toBeLessThanOrEqual(40_000);
    } finally {
      await client.close();
      await server.close();
    }
  });


  it("measures the final mirror + stage + skeleton envelope at the boundary", async () => {
    const { root, core } = fixture();
    await core.declare({ species: "principle", content: "Uncovered local skeleton.", circle: "alpha" });
    const surfaces = Array.from({ length: 320 }, (_, i) => ({
      path: join(root, `stale-${String(i).padStart(3, "0")}-${"m".repeat(80)}.md`),
      scope: "global" as const,
    }));
    writeFileSync(join(root, "materialize.json"), JSON.stringify({ surfaces, materialized: {} }));
    const db = raw(core);
    let id = 0;
    const deps = {
      db: db as never,
      newId: () => `boundary-stage-${id++}`,
      nextSyncTimestamp: () => Date.now(),
      syncDeviceId: "boundary-device",
    };
    for (let i = 0; i < 80; i++) {
      const stage = upsertStage(deps, { stage: `boundary stage ${String(i).padStart(3, "0")}`, origin: "declaration" });
      const conceptId = `boundary-rule-${i}`;
      db.prepare(
        `INSERT INTO concepts (id, slug, title, body, kind, status, circle, embedding)
         VALUES (?, ?, ?, ?, 'rule', 'active', 'alpha', '[]')`,
      ).run(conceptId, `boundary-rule-${i}`, `Boundary rule ${i}`, `Boundary rule body ${i}`);
      db.prepare(
        `INSERT INTO rule_bindings (concept_id, stage_id, severity, scope, model_tag, origin, circle, created_at, sync_updated_at, sync_revision)
         VALUES (?, ?, 'advisory', 'domain', NULL, 'import', 'alpha', ?, ?, 0)`,
      ).run(conceptId, stage.id, Date.now(), Date.now());
    }
    const server = new McpServer({ name: "mirror-test", version: "1" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, core, { autoPrewarm: false, checkpointNudge: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "mirror-client", version: "1" });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: "agent_context", arguments: { circle: "alpha" } }) as {
        content: Array<{ type: string; text: string }>;
      };
      expect(() => JSON.parse(result.content[0]!.text)).not.toThrow();
      const payload = JSON.parse(result.content[0]!.text);
      expect(payload.mirrorStaleTruncated).toBe(true);
      expect(payload.stageIndexTruncated).toBe(true);
      expect(payload.skeletonTruncated ?? false).toBe(false);
      expect(payload.skeleton).toHaveLength(1);
      expect(payload.instruction).toBe(MIRROR_STALE_INSTRUCTION);
      expect(result.content[0]!.text.length).toBeLessThanOrEqual(40_000);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("documents the three agent_context states and carries bootstrap skeleton over the wire", async () => {
    const { core } = fixture();
    const { global, alpha } = await seed(core);
    const server = new McpServer({ name: "mirror-test", version: "1" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, core, { autoPrewarm: false, checkpointNudge: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "mirror-client", version: "1" });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: "agent_context", arguments: { circle: "alpha" } }) as {
        content: Array<{ type: string; text: string }>;
      };
      const payload = JSON.parse(result.content[0]!.text);
      expect(payload.skeleton.map((entry: SkeletonEntry) => entry.conceptId)).toEqual([global.conceptId, alpha.conceptId]);
      const description = (await client.listTools()).tools.find((tool) => tool.name === "agent_context")!.description!;
      expect(description).toContain("absence means the standing files you already loaded are current");
      expect(description).toContain("`mirrorStale` + `instruction` appears only");
      expect(description).toContain("`skeleton` appears only");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

function requireManifest(root: string): string {
  return readFileSync(join(root, "materialize.json"), "utf8");
}
