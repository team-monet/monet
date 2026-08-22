/**
 * Findings from the Codex review of PR #63.
 *
 * Every one of these is the same class of defect this ticket exists to remove: a surface reporting a
 * value it does not have, or reporting silence where something broke. They are grouped here rather
 * than scattered so the next reader can see that class in one place.
 */
import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore } from "../engine";
import { BetterSqlitePort } from "../storage";
import type { StoragePort } from "../storage";
import { UnknownMomentError, foldMomentSpool, momentConformance, momentCounts, readGovernedMoment } from "../moment-ledger";
import { MOMENT_SPOOL_READ_CHUNK_BYTES, readMomentSpool } from "../moment-spool";
import { renderOverview } from "../render-overview";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMonetCoreTools } from "../mcp-server";

const dirs: string[] = [];
const ports: StoragePort[] = [];
const cores: MonetCore[] = [];
const mkTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "monet-review-"));
  dirs.push(dir);
  return dir;
};
const mkDb = (): StoragePort => {
  const db = new BetterSqlitePort(":memory:");
  ports.push(db);
  return db;
};
afterEach(() => {
  for (const core of cores.splice(0)) core.close();
  for (const port of ports.splice(0)) port.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function line(path: string, body: Record<string, unknown>): void {
  appendFileSync(path, `${JSON.stringify({ v: 1, runId: "run-review", seq: seq++, ...body })}\n`);
}

function readAndActed(path: string, momentId: string): void {
  line(path, {
    kind: "interception", momentId, at: "2026-08-21T00:00:00.000Z", toolUseId: null, circle: "acme-widgets", sessionId: null,
    surface: "Bash", actionSha256: "a".repeat(64), actionRendering: "terraform apply", actionChars: 15,
    actionClipped: false, stageId: "stage-1", ruleIds: ["rule-a"], disposition: "advised",
    deliveredRuleIds: [],
  });
  line(path, { kind: "read", momentId, ruleId: "rule-a", namedStageId: "stage-1", readAt: "t" });
  line(path, {
    kind: "outcome", momentId, toolUseId: null, outcomeStatus: "ok", outcomeAt: "t",
    outcomeSha256: "b".repeat(64),
  });
}

describe("P1 — a conformance write with no spool must not report success", () => {
  it("refuses an ask when no spool is configured", () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme-widgets" });
    cores.push(core);
    // The MCP handler answers `recorded: "ask"` on a silent return, telling the user their answer
    // was saved when no byte was written anywhere.
    expect(() => core.recordMomentAsk("m1")).toThrow(/spool/i);
  });

  it("refuses an answer when no spool is configured", () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme-widgets" });
    cores.push(core);
    // A conformance answer is the one datum in this system that cannot be reproduced.
    expect(() => core.recordMomentAnswer("m1", "not-followed")).toThrow(/spool/i);
  });
});

describe("P1 — an unreadable spool is not a missing one", () => {
  it("surfaces a permission failure instead of reporting zero activity", () => {
    const dir = mkTmp();
    const path = join(dir, "moments.jsonl");
    writeFileSync(path, "");
    chmodSync(path, 0o000);
    try {
      // Broken recording indistinguishable from healthy inactivity is the incident this whole
      // subsystem was built after.
      expect(() => readMomentSpool(path, 0)).toThrow();
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it("still treats a genuinely absent spool as the ordinary pre-first-append state", () => {
    const read = readMomentSpool(join(mkTmp(), "never-created.jsonl"), 0);
    expect(read).toMatchObject({ records: [], nextCursor: 0 });
  });
});

describe("P2 — the cursor does not step over records a later reader must fold", () => {
  it("stops at a future-version line rather than skipping past it", () => {
    const dir = mkTmp();
    const path = join(dir, "moments.jsonl");
    seq = 0;
    line(path, { kind: "run-start", writerRole: "core", at: "t" });
    appendFileSync(path, `${JSON.stringify({ v: 99, runId: "run-review", seq: 1, kind: "something-new" })}\n`);
    line(path, { kind: "ask", momentId: "m1", askedAt: "t" });

    const read = readMomentSpool(path, 0);
    expect(read.futureVersionLines).toBe(1);
    // Advancing past it makes that data permanently absent from the ledger once the build that
    // understands it arrives: nothing ever reads it, and nothing says so.
    const bytesBeforeFuture = `${JSON.stringify({ v: 1, runId: "run-review", seq: 0, kind: "run-start", writerRole: "core", at: "t" })}\n`.length;
    expect(read.nextCursor).toBe(bytesBeforeFuture);
  });
});

describe("P2 — conformance writes require something to judge", () => {
  it("refuses an ask for a moment with no read", () => {
    const dir = mkTmp();
    const path = join(dir, "moments.jsonl");
    seq = 0;
    // A silent moment: intercepted and acted on, nothing read. Nothing to have followed.
    line(path, {
      kind: "interception", momentId: "silent", at: "2026-08-21T00:00:00.000Z", toolUseId: null, circle: "acme-widgets",
      sessionId: null, surface: "Bash", actionSha256: "a".repeat(64), actionRendering: "git status",
      actionChars: 10, actionClipped: false, stageId: null, ruleIds: [], disposition: "silent",
      deliveredRuleIds: [],
    });
    line(path, {
      kind: "outcome", momentId: "silent", toolUseId: null, outcomeStatus: "ok", outcomeAt: "t",
      outcomeSha256: "c".repeat(64),
    });
    const core = new MonetCore(":memory:", { momentSpoolPath: path, defaultCircle: "acme-widgets" });
    cores.push(core);
    expect(() => core.recordMomentAsk("silent")).toThrow(UnknownMomentError);
  });

  it("refuses an ask for a blocked moment, which by design never acts", () => {
    const dir = mkTmp();
    const path = join(dir, "moments.jsonl");
    seq = 0;
    line(path, {
      kind: "interception", momentId: "blocked", at: "2026-08-21T00:00:00.000Z", toolUseId: null, circle: "acme-widgets",
      sessionId: null, surface: "Bash", actionSha256: "a".repeat(64), actionRendering: "git push --force",
      actionChars: 16, actionClipped: false, stageId: "s1", ruleIds: ["rule-a"], disposition: "blocked",
      deliveredRuleIds: ["rule-a"],
    });
    line(path, { kind: "read", momentId: "blocked", ruleId: "rule-a", namedStageId: "s1", readAt: "t" });
    const core = new MonetCore(":memory:", { momentSpoolPath: path, defaultCircle: "acme-widgets" });
    cores.push(core);
    // Its id IS handed to the agent in the deny instruction, so it can be asked about — and it has
    // no outcome by design, so there is no completed action for a user to judge.
    expect(() => core.recordMomentAsk("blocked")).toThrow(UnknownMomentError);
  });

  it("accepts an ask for a moment that was read and acted on", () => {
    const dir = mkTmp();
    const path = join(dir, "moments.jsonl");
    seq = 0;
    readAndActed(path, "m1");
    const core = new MonetCore(":memory:", { momentSpoolPath: path, defaultCircle: "acme-widgets" });
    cores.push(core);
    expect(() => core.recordMomentAsk("m1")).not.toThrow();
  });
});

describe("P2 — a conflicting second answer is refused, not silently dropped", () => {
  it("throws rather than echoing a replacement the tally ignored", () => {
    const dir = mkTmp();
    const path = join(dir, "moments.jsonl");
    const db = mkDb();
    seq = 0;
    readAndActed(path, "m1");
    const core = new MonetCore(":memory:", { momentSpoolPath: path, defaultCircle: "acme-widgets" });
    cores.push(core);
    core.recordMomentAsk("m1");
    core.recordMomentAnswer("m1", "followed");

    // COALESCE keeps the first value; the tool returned a success payload naming the second. The
    // durable tally then disagrees with what the user was told.
    expect(() => core.recordMomentAnswer("m1", "not-followed")).toThrow(/already/i);
    expect(momentConformance(db, path, "acme-widgets")).toMatchObject({ followed: 1, notFollowed: 0 });
  });

  it("accepts a repeat of the SAME answer, which asserts nothing new", () => {
    const dir = mkTmp();
    const path = join(dir, "moments.jsonl");
    seq = 0;
    readAndActed(path, "m2");
    const core = new MonetCore(":memory:", { momentSpoolPath: path, defaultCircle: "acme-widgets" });
    cores.push(core);
    core.recordMomentAsk("m2");
    core.recordMomentAnswer("m2", "followed");
    expect(() => core.recordMomentAnswer("m2", "followed")).not.toThrow();
  });
});

describe("P1 — the fold does not allocate the whole spool", () => {
  it("folds a spool larger than one chunk without materializing it at once", () => {
    const dir = mkTmp();
    const path = join(dir, "moments.jsonl");
    const db = mkDb();
    seq = 0;
    // Comfortably more than one bounded chunk, so a single-buffer read would be visible.
    for (let i = 0; i < 15000; i += 1) {
      line(path, { kind: "ask", momentId: `m${i}`, askedAt: "t" });
    }
    const { size } = statSync(path);
    expect(size).toBeGreaterThan(MOMENT_SPOOL_READ_CHUNK_BYTES);

    // ONE READ IS BOUNDED. Without this the buffer is the whole remaining spool, which on a fresh
    // store replaying all of history is an ordinary MCP read allocating the entire file.
    const oneRead = readMomentSpool(path, 0);
    expect(oneRead.nextCursor).toBeLessThan(size);
    expect(oneRead.nextCursor).toBeLessThanOrEqual(MOMENT_SPOOL_READ_CHUNK_BYTES);

    // AND THE FOLD IS STILL COMPLETE: bounding memory must not bound WORK, or a fresh store would
    // be permanently behind on a spool nothing reclaims.
    const folded = foldMomentSpool(db, path);
    expect(folded.recordsFolded).toBe(15000);
    expect(readGovernedMoment(db, path, "m14999")).not.toBeNull();
  });
});


describe("P1 — moment counts are scoped to the circle the overview asked for", () => {
  function interception(path: string, momentId: string, circle: string | null): void {
    line(path, {
      kind: "interception", momentId, at: "2026-08-21T00:00:00.000Z", toolUseId: null, sessionId: null,
      circle, surface: "Bash", actionSha256: "a".repeat(64), actionRendering: "terraform apply",
      actionChars: 15, actionClipped: false, stageId: "s1", ruleIds: ["rule-a"], disposition: "advised",
      deliveredRuleIds: [],
    });
  }

  it("does not report another circle's activity", () => {
    const dir = mkTmp();
    const path = join(dir, "moments.jsonl");
    const db = mkDb();
    seq = 0;
    interception(path, "mine", "acme-widgets");
    // The spool is HOME-LEVEL and shared, so a second project's moments land in this store's fold.
    interception(path, "theirs", "other-project");
    foldMomentSpool(db, path);

    const core = new MonetCore(":memory:", { momentSpoolPath: path, defaultCircle: "acme-widgets" });
    cores.push(core);
    // `total` rather than the removed `fires` (2026-08-22): the scoping is what is under test, and
    // it is the same WHERE clause on either counter. Both moments are evaluated records, so both
    // stay out of `ungoverned` — asserted here so the scoping check cannot silently start passing
    // against a counter that counts everything.
    expect(core.momentCounts("acme-widgets").total).toBe(1);
    expect(core.momentCounts("other-project").total).toBe(1);
    expect(core.momentCounts("acme-widgets").ungoverned).toBe(0);
  });

  it("counts a moment whose circle was never known as unattributed, not as this circle's", () => {
    const dir = mkTmp();
    const path = join(dir, "moments.jsonl");
    const db = mkDb();
    seq = 0;
    interception(path, "mine", "acme-widgets");
    // The gate failed before resolving a circle, or the hook had none pinned. Excluding it must not
    // hide it: an unattributable moment is a real observation with a missing field.
    interception(path, "unknown", null);
    foldMomentSpool(db, path);

    const core = new MonetCore(":memory:", { momentSpoolPath: path, defaultCircle: "acme-widgets" });
    cores.push(core);
    const counts = core.momentCounts("acme-widgets");
    // The attributed one lands in this circle; the unattributable one lands in NEITHER circle's
    // `total` and is reported on its own — which is the whole point of the split.
    expect(counts.total).toBe(1);
    expect(counts.unattributed).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CODEX ROUND TWO — reproductions written BEFORE any fix.
// ─────────────────────────────────────────────────────────────────────────────

describe("R2 P1 — a read recorded after the action is not a read before acting", () => {
  it("does not credit a stage_lookup that lands after the moment's outcome", () => {
    const dir = mkTmp();
    const spool = join(dir, "moments.jsonl");
    const db = mkDb();
    const m = "11111111-1111-4111-8111-111111111111";
    line(spool, {
      kind: "interception", momentId: m, at: "2026-08-21T00:00:00.000Z", toolUseId: null,
      circle: "acme-widgets", sessionId: null, surface: "Bash", actionSha256: "a".repeat(64),
      actionRendering: "terraform apply", actionChars: 15, actionClipped: false,
      stageId: "stage-1", ruleIds: ["rule-a"], disposition: "advised", deliveredRuleIds: ["rule-a"],
    });
    // The action completes FIRST.
    line(spool, {
      kind: "outcome", momentId: m, toolUseId: null, outcomeStatus: "ok",
      outcomeAt: "2026-08-21T00:00:10.000Z", outcomeSha256: "b".repeat(64),
    });
    // THEN the agent looks the rule up, naming the stale moment id.
    line(spool, {
      kind: "read", momentId: m, ruleId: "rule-a", namedStageId: "stage-1",
      readAt: "2026-08-21T00:00:20.000Z",
    });
    foldMomentSpool(db, spool);
    const row = readGovernedMoment(db, spool, m);
    // Fact 3 is "the agent read it BEFORE acting". A read stamped after outcome_at is not that.
    expect(Object.keys(row?.ruleReads ?? {})).toEqual([]);
  });
});

describe("R2 P1 — only rules applicable to the moment may be credited", () => {
  it("does not credit a rule absent from the moment's own rule_ids", () => {
    const dir = mkTmp();
    const spool = join(dir, "moments.jsonl");
    const db = mkDb();
    const m = "22222222-2222-4222-8222-222222222222";
    line(spool, {
      kind: "interception", momentId: m, at: "2026-08-21T00:00:00.000Z", toolUseId: null,
      circle: "acme-widgets", sessionId: null, surface: "Bash", actionSha256: "a".repeat(64),
      actionRendering: "terraform apply", actionChars: 15, actionClipped: false,
      stageId: "stage-1", ruleIds: ["rule-a"], disposition: "advised", deliveredRuleIds: ["rule-a"],
    });
    // A stale mirror hands back a rule that was NOT bound when this moment was intercepted.
    line(spool, {
      kind: "read", momentId: m, ruleId: "rule-added-later", namedStageId: "stage-1",
      readAt: "2026-08-21T00:00:05.000Z",
    });
    foldMomentSpool(db, spool);
    const row = readGovernedMoment(db, spool, m);
    expect(Object.keys(row?.ruleReads ?? {})).toEqual([]);
  });
});

describe("R2 P1 — an unwritable spool must not acknowledge a conformance answer", () => {
  it("refuses when the append is swallowed and the answer never lands", () => {
    const dir = mkTmp();
    const spool = join(dir, "moments.jsonl");
    const db = mkDb();
    const m = "33333333-3333-4333-8333-333333333333";
    readAndActed(spool, m);
    const core = new MonetCore(":memory:", { defaultCircle: "acme-widgets", momentSpoolPath: spool });
    cores.push(core);
    core.momentCounts(); // folds
    // The disk goes read-only between the fold and the answer.
    chmodSync(spool, 0o444);
    expect(() => core.recordMomentAnswer(m, "followed")).toThrow();
  });
});

describe("R2 P1 — a store call is attributed to the circle it targets", () => {
  it("does not count a call against another circle's totals", () => {
    const dir = mkTmp();
    const spool = join(dir, "moments.jsonl");
    const core = new MonetCore(":memory:", { defaultCircle: "circle-a", momentSpoolPath: spool });
    cores.push(core);
    // An MCP request that explicitly targets circle-b.
    const id = core.openStoreMoment("memory_recall", "circle-b");
    core.closeStoreMoment(id, "{}", "ok");
    expect(core.momentCounts("circle-b").total).toBe(1);
    expect(core.momentCounts("circle-a").total).toBe(0);
  });
});

describe("R2 P2 — a store call's observed failure is on the record", () => {
  it("distinguishes a handler that threw from one that returned", () => {
    const dir = mkTmp();
    const spool = join(dir, "moments.jsonl");
    const db = mkDb();
    const core = new MonetCore(":memory:", { defaultCircle: "circle-a", momentSpoolPath: spool });
    cores.push(core);
    const ok = core.openStoreMoment("memory_fetch");
    core.closeStoreMoment(ok, "{}", "ok");
    const bad = core.openStoreMoment("memory_store");
    core.closeStoreMoment(bad, '{"threw":"boom"}', "failed");
    foldMomentSpool(db, spool);
    expect(readGovernedMoment(db, spool, ok as string)?.outcomeStatus).toBe("ok");
    expect(readGovernedMoment(db, spool, bad as string)?.outcomeStatus).toBe("failed");
  });
});

describe("R2 P2 — stage-read coverage is scoped to the circle that asked", () => {
  it("does not let a lookup in one circle answer for another", () => {
    const dir = mkTmp();
    const spool = join(dir, "moments.jsonl");
    const core = new MonetCore(":memory:", { defaultCircle: "circle-a", momentSpoolPath: spool });
    cores.push(core);
    // One lookup of a global stage, in circle-a only.
    core.recordRuleReads(null, ["rule-a"], "stage-shared", "circle-a");
    expect(core.momentStageReads("circle-a").get("stage-shared")).toBe(1);
    // circle-b has never looked this stage up, and must still report it as unread.
    expect(core.momentStageReads("circle-b").has("stage-shared")).toBe(false);
  });
});

describe("R2 P2 — governed moments survive a circle rename", () => {
  it("keeps pre-rename history reachable under the new name", async () => {
    const dir = mkTmp();
    const spool = join(dir, "moments.jsonl");
    const core = new MonetCore(":memory:", { defaultCircle: "old-name", momentSpoolPath: spool });
    cores.push(core);
    // A circle is renameable because it HOLDS something — governed moments alone do not make one
    // exist, so this mirrors the only shape a rename actually happens in.
    await core.store("A fact that gives this circle something to hold.", { kind: "fact" });
    const id = core.openStoreMoment("memory_recall");
    core.closeStoreMoment(id, "{}", "ok");
    expect(core.momentCounts("old-name").total).toBe(1);

    core.renameCircle("old-name", "new-name");
    // Reachable under the new name...
    expect(core.momentCounts("new-name").total).toBe(1);
    // ...and under the old one, which resolves through the alias.
    expect(core.momentCounts("old-name").total).toBe(1);
    // AND A RECORD WRITTEN AFTER THE RENAME UNDER THE OLD NAME STILL LANDS IN THE CIRCLE.
    // This is the case the rename migration alone cannot reach and it is not hypothetical: the
    // generated hook has `--circle old-name` baked into settings.json, and renaming a circle in
    // the store does not rewrite that file — so every later invocation keeps writing the old name.
    // Without alias resolution on the way in, each one is orphaned under a circle nobody queries.
    line(spool, {
      kind: "interception", momentId: "55555555-5555-4555-8555-555555555555",
      at: "2026-08-21T00:00:00.000Z", toolUseId: null, circle: "old-name", sessionId: null,
      surface: "Bash", actionSha256: "a".repeat(64), actionRendering: "ls", actionChars: 2,
      actionClipped: false, stageId: null, ruleIds: null, disposition: "ungoverned",
      deliveredRuleIds: null,
    });
    expect(core.momentCounts("new-name").total).toBe(2);
    expect(core.momentCounts("new-name").unattributed).toBe(0);
  });
});

describe("R2 P2 — the terminal overview never hides an unattributed population", () => {
  it("does not print the all-clear while moments sit with no circle", () => {
    const dir = mkTmp();
    const spool = join(dir, "moments.jsonl");
    const db = mkDb();
    const core = new MonetCore(":memory:", { defaultCircle: "circle-a", momentSpoolPath: spool });
    cores.push(core);
    // A gate that failed before it resolved a circle: observed, attributed to nothing.
    const m = "44444444-4444-4444-8444-444444444444";
    line(spool, {
      kind: "interception", momentId: m, at: "2026-08-21T00:00:00.000Z", toolUseId: null,
      circle: null, sessionId: null, surface: "Bash", actionSha256: "a".repeat(64),
      actionRendering: "ls", actionChars: 2, actionClipped: false, stageId: null,
      ruleIds: null, disposition: "ungoverned", deliveredRuleIds: null,
    });
    foldMomentSpool(db, spool);
    const ov = core.overview("circle-a");
    expect(ov.gate.unattributed).toBe(1);
    const rendered = renderOverview(ov, { color: false });
    expect(rendered).not.toContain("no curation work queued");
    expect(rendered).toContain("GATE");
    expect(rendered).toContain("no circle resolved");
  });
});

describe("R2 P2 — the overview response is measured whole before it is returned", () => {
  it("attaches no field past the fitter that the fitter never counted", async () => {
    const dir = mkTmp();
    const core = new MonetCore(":memory:", {
      defaultCircle: "circle-a",
      momentSpoolPath: join(dir, "moments.jsonl"),
    });
    const server = new McpServer(
      { name: "monet-core-test", version: "0.6.0" },
      { capabilities: { tools: {} } },
    );
    registerMonetCoreTools(server, core);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);
    try {
      const res = await client.callTool({ name: "memory_overview", arguments: { circle: "circle-a" } });
      const text = (res.content as Array<{ type: string; text: string }>)[0].text;
      const payload = JSON.parse(text) as Record<string, unknown>;
      // The four states belong to the gate block, which the fitter measures.
      expect(payload.gate).toHaveProperty("conformance");
      // A SECOND top-level copy was appended AFTER fitOverviewEnvelope had measured the response,
      // so near the ceiling it pushed the payload over and the whole overview was replaced by a
      // generic truncation notice. Anything returned must be inside what the fitter counted.
      expect(payload).not.toHaveProperty("conformance");
    } finally {
      await client.close();
      core.close();
    }
  });
});

describe("R3 — unjoinable reads are scoped to the circle that asked", () => {
  it("does not count another project's moment-less lookups", () => {
    const dir = mkTmp();
    const spool = join(dir, "moments.jsonl");
    const core = new MonetCore(":memory:", { defaultCircle: "circle-a", momentSpoolPath: spool });
    cores.push(core);
    // A stage_lookup reached from agent_context in circle-a: a real read, naming no moment.
    core.recordRuleReads(null, ["rule-a"], "stage-alpha", "circle-a");
    expect(core.momentConformance("circle-a").unjoinableReads).toBe(1);
    // circle-b did nothing, and its overview must not inherit circle-a's count. The read knows its
    // own circle even though the moment does not — that is why this is scopable at all.
    expect(core.momentConformance("circle-b").unjoinableReads).toBe(0);
  });
});

describe("R4 — the spool's own directory is created rather than assumed", () => {
  it("creates the spool directory when the storage home does not exist yet", () => {
    const dir = mkTmp();
    // A project-local `.monet` store is supported, and a user who has only ever had one may have
    // no `~/.monet` at all. The spool is home-level by construction — the hook wrapper can import
    // nothing and must agree with core on one path — so this is a real, reachable configuration.
    const spool = join(dir, "never", "created", "moments.jsonl");
    const core = new MonetCore(":memory:", { defaultCircle: "acme-widgets", momentSpoolPath: spool });
    cores.push(core);
    const id = core.openStoreMoment("memory_recall");
    core.closeStoreMoment(id, "{}", "ok");
    // Before the directory was created on demand, every append failed ENOENT into a silent catch
    // and this read reported the ordinary pre-first-append state: recording silently off.
    expect(core.momentCounts("acme-widgets").total).toBe(1);
  });
});

describe("R4 — an interception written before `circle` existed is history, not garbage", () => {
  it("folds a format-1 interception with no circle key as unattributed", () => {
    const dir = mkTmp();
    const spool = join(dir, "moments.jsonl");
    const db = mkDb();
    const m = "77777777-7777-4777-8777-777777777777";
    // EXACTLY the shape a writer produced before `circle` was added: same format version, no key.
    // This is not hypothetical — spools written by earlier commits of this branch hold these, and
    // a malformed line is CONSUMED and its cursor advanced, so rejecting it destroys the record.
    appendFileSync(spool, `${JSON.stringify({
      v: 1, runId: "run-old", seq: 0,
      kind: "interception", momentId: m, at: "2026-08-19T00:00:00.000Z", toolUseId: null,
      sessionId: null, surface: "Bash", actionSha256: "a".repeat(64), actionRendering: "ls",
      actionChars: 2, actionClipped: false, stageId: null, ruleIds: [], disposition: "silent",
      deliveredRuleIds: [],
    })}\n`);
    const res = foldMomentSpool(db, spool);
    expect(res.malformedLines).toBe(0);
    expect(res.recordsFolded).toBe(1);
    const row = readGovernedMoment(db, spool, m);
    expect(row?.opened).toBe(true);
    // The schema already had a word for an unknown circle, and this is it.
    expect(row?.circle).toBeNull();
    expect(momentCounts(db, spool, "acme-widgets").unattributed).toBe(1);
  });
});

describe("R5 — governed moments survive a circle MERGE, not only a rename", () => {
  it("keeps pre-merge history reachable under the surviving name", async () => {
    const dir = mkTmp();
    const spool = join(dir, "moments.jsonl");
    const core = new MonetCore(":memory:", { defaultCircle: "old-team", momentSpoolPath: spool });
    cores.push(core);
    // Both circles must exist as circles, which means holding something.
    await core.store("A fact filed under the circle being merged away.", { kind: "fact" });
    await core.store("A fact in the surviving circle.", { kind: "fact", circle: "new-team" });

    const id = core.openStoreMoment("memory_recall");
    core.closeStoreMoment(id, "{}", "ok");
    core.recordRuleReads(null, ["rule-a"], "stage-shared", "old-team");
    expect(core.momentCounts("old-team").total).toBe(1);
    expect(core.momentStageReads("old-team").get("stage-shared")).toBe(1);

    await core.mergeCircle("old-team", "new-team");

    // `mergeCircle` publishes the same from -> into alias `renameCircle` does, so BOTH names now
    // resolve to `new-team`. Without the rows moving, this history sits under a name that nothing
    // resolves to any more — reachable from neither side.
    expect(core.momentCounts("new-team").total).toBe(1);
    expect(core.momentCounts("old-team").total).toBe(1);
    expect(core.momentStageReads("new-team").get("stage-shared")).toBe(1);
    expect(core.momentCounts("new-team").unattributed).toBe(0);
  });
});

describe("R5 — a REPLICATED alias moves the local moment population too", () => {
  it("keeps local history reachable after a peer's rename is grafted in", async () => {
    const dir = mkTmp();
    // The peer performs the rename; it never sees this machine's moments, which are local-only —
    // the moment tables appear in no export or graft path by design.
    const peer = new MonetCore(":memory:", { defaultCircle: "old-team" });
    cores.push(peer);
    await peer.store("A fact that makes old-team a real circle.", { kind: "fact" });
    peer.renameCircle("old-team", "new-team");

    const local = new MonetCore(":memory:", {
      defaultCircle: "old-team", momentSpoolPath: join(dir, "moments.jsonl"),
    });
    cores.push(local);
    await local.store("This machine's own fact under the same circle name.", { kind: "fact" });
    const id = local.openStoreMoment("memory_recall");
    local.closeStoreMoment(id, "{}", "ok");
    expect(local.momentCounts("old-team").total).toBe(1);

    local.graftRows(peer.exportDelta(0));

    // The alias landed, so BOTH names resolve to `new-team` here. Rows still carrying `old-team`
    // would be reachable from neither — the same silent orphaning a local merge caused, arriving
    // over sync instead.
    expect(local.resolveCircleName("old-team")).toBe("new-team");
    expect(local.momentCounts("new-team").total).toBe(1);
    expect(local.momentCounts("old-team").total).toBe(1);
  });
});

describe("R6 — a resolved-but-failed tool result is not an ok outcome", () => {
  it("records isError results as failed, not as success", async () => {
    const dir = mkTmp();
    const spool = join(dir, "moments.jsonl");
    const db = mkDb();
    const core = new MonetCore(":memory:", { defaultCircle: "acme-widgets", momentSpoolPath: spool });
    cores.push(core);
    const server = new McpServer({ name: "t", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, core);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "c", version: "0.0.1" });
    await client.connect(ct);
    try {
      // `err()` returns a RESOLVED result with isError: true — the shape dozens of handlers use to
      // report a refusal or a caught database error. A fetch for an id that does not exist is one.
      const res = await client.callTool({ name: "memory_fetch", arguments: { id: "no-such-id" } });
      expect(res.isError).toBe(true);
      foldMomentSpool(db, spool);
      const statuses = (db
        .prepare(`SELECT surface, outcome_status FROM governed_moments WHERE surface = 'memory_fetch'`)
        .all()) as Array<{ surface: string; outcome_status: string | null }>;
      expect(statuses.length).toBeGreaterThan(0);
      // Recorded as failed. Reading fulfillment as success made this column assert a verdict the
      // value it was handed contradicts.
      expect(statuses.every((r) => r.outcome_status === "failed")).toBe(true);
    } finally {
      await client.close();
    }
  });
});

/**
 * WHAT USED TO SIT HERE TOO: "counts fires and silences from MonetCore.gate()" — the library
 * caller's own interception moment, written by `spoolApiGateMoment`. That method went with
 * `MonetCore.gate()` on 2026-08-22, and with it the last IN-PROCESS producer of a fire or a
 * silence. The counters themselves followed later the same day: with no writer left anywhere in
 * this tree, `fires`/`silences`/`delivered` could only report a structurally-fixed zero, which
 * reads as a measurement and is not one. See `MomentCounts`.
 */
describe("R6 — the public stageLookup() record for a library caller", () => {
  it("counts stage reads from MonetCore.stageLookup()", async () => {
    const dir = mkTmp();
    const spool = join(dir, "moments.jsonl");
    const core = new MonetCore(":memory:", { defaultCircle: "acme-widgets", momentSpoolPath: spool });
    cores.push(core);
    await core.declare({
      species: "rule", stage: "terraform apply", patterns: ["Bash:terraform apply"],
      content: "Always run plan first.", severity: "advisory", scope: "domain", circle: "acme-widgets",
    });
    const r = core.stageLookup({ stage: "terraform apply" });
    expect(r.rules.length).toBeGreaterThan(0);
    // Without this, a stage an embedder consults every day reads as one nobody has ever looked up.
    expect(core.momentStageReads("acme-widgets").size).toBeGreaterThan(0);
  });
});
