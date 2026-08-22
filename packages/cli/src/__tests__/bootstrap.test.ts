import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  FreshStoreEmbedderUnavailableError,
  HashingEmbeddingProvider,
  type EmbeddingProvider,
} from "@team-monet/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openServedCore, openStatusCore } from "../bootstrap";
import { ensureMonetDir, getDbPath } from "../db/index";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

interface EmbedderPinRow {
  embedder_model_id: string | null;
}

function readEmbedderPin(dbPath: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT embedder_model_id FROM sync_meta WHERE singleton = 1")
      .get() as EmbedderPinRow;
    return row.embedder_model_id;
  } finally {
    db.close();
  }
}

describe("client core bootstrap", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "monet-client-bootstrap-"));
    dbPath = join(dir, "monet.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function throwingEmbedder(): EmbeddingProvider & { embed: ReturnType<typeof vi.fn> } {
    return {
      dim: 8,
      modelId: "test/inspection-embedder",
      embed: vi.fn(() => {
        throw new Error("inspection path invoked the embedder");
      }),
    };
  }

  it("status-style inspection leaves a fresh store unpinned and does not embed", () => {
    const embedder = throwingEmbedder();
    const core = openStatusCore(dbPath, embedder);

    expect(core.stats()).toMatchObject({ concepts: 0, observations: 0 });
    expect(embedder.embed).not.toHaveBeenCalled();
    core.close();

    expect(readEmbedderPin(dbPath)).toBeNull();
  });

  it("served bootstrap surfaces the typed fresh-store fallback error", async () => {
    const error = new FreshStoreEmbedderUnavailableError();
    const selectEmbedder = vi.fn(async () => {
      throw error;
    });

    await expect(
      openServedCore(
        dbPath,
        { scopeContext: dir, defaultCircle: "test-circle" },
        selectEmbedder,
      ),
    ).rejects.toBe(error);
    expect(selectEmbedder).toHaveBeenCalledWith(dbPath);
  });

  // ── #75: the gate journal — the served core is the one writer surface for the MCP mouths ───────

  it("a served core constructed WITHOUT gateJournalPath writes no journal (today's behavior, unchanged for any caller that omits it)", async () => {
    const journalPath = join(dir, "gate-journal.jsonl");
    const core = await openServedCore(
      ":memory:",
      {
        scopeContext: dir,
        defaultCircle: "test-circle",
        // gateJournalPath deliberately omitted — the no-default stance that keeps a test or a
        // one-off script from appending into a real store.
      },
      async () => new HashingEmbeddingProvider(),
    );
    await core.declare({
      species: "rule",
      stage: "git force push",
      patterns: ["Bash:git push --force"],
      content: "Never force-push to main.",
      severity: "blocking",
      scope: "domain",
      reason: "a rewritten history cannot be recovered from a teammate's clone",
    });
    core.stageLookup({ stage: "git force push" });
    core.close();
    expect(existsSync(journalPath)).toBe(false);
  });
});

// ── #75: the shipped server never wired the gate journal, so every MCP-originated gate call went
// unrecorded — and there are TWO launch paths of that one server, so wiring either alone leaves
// journaling dependent on which one a host happens to spawn ─────────────────────────────────────
describe("FIX 1: served core store/mirror project pairing", () => {
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    dirA = mkdtempSync(join(tmpdir(), "monet-fix1-a-"));
    dirB = mkdtempSync(join(tmpdir(), "monet-fix1-b-"));
  });

  afterEach(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it("a declaration through a served core whose store is rooted at a project dir lands in that project's store only — a DIFFERENT project's store stays untouched", async () => {
    // Simulates: MONET_PROJECT_DIR=dirA, cwd=dirB, both with their own project-local .monet dirs
    // (the coordinator's own test shape) — dbPathA/dbPathB stand in for what getDbPath(dirA) and
    // getDbPath(dirB) would each resolve to; mirrorPathA for getGateMirrorPath(dirA). The FIX
    // (cli.ts:61/index.ts:28) is that the served core's OWN dbPath argument now follows the SAME
    // resolved project dir the mirror path already did — reproduced directly here by passing BOTH
    // rooted at dirA, never mixing in dirB anywhere in this core's own construction.
    const dbPathA = join(dirA, "monet.db");
    const dbPathB = join(dirB, "monet.db");

    // B's store: created and left with zero concepts, to prove A's session never reaches it.
    const coreB = await openServedCore(
      dbPathB,
      { scopeContext: dirB, defaultCircle: "circle-b" },
      async () => new HashingEmbeddingProvider(),
    );
    coreB.close();

    // A's served core: dbPath rooted at dirA — the fix, exercised directly.
    const coreA = await openServedCore(
      dbPathA,
      { scopeContext: dirA, defaultCircle: "circle-a" },
      async () => new HashingEmbeddingProvider(),
    );
    await coreA.declare({
      species: "rule", stage: "git force push", patterns: ["Bash:git push --force"],
      content: "Never force-push to main.", severity: "blocking", scope: "domain",
      reason: "declared through A's served core — must land in A's mirror, never B's store",
    });
    coreA.close();

    // B's store: still zero concepts — A's session never touched it (opened fresh, independent
    // connection, to prove this from a clean read rather than trusting coreB's own in-memory state).
    const statusB = openStatusCore(dbPathB);
    expect(statusB.stats()).toMatchObject({ concepts: 0 });
    statusB.close();
  });

  it("source regression guard: cli.ts's `start` action and index.ts's stdio entry both pass a resolved projectDir into getDbPath, never the bare cwd-rooted call, at their openServedCore call site", () => {
    // A source-text check, not a behavioral one — the FUNCTIONAL test above proves the PAIRING
    // mechanism is correct when both paths are rooted the same way; this proves the two REAL
    // entry points this bug lived in actually DO that, at the exact call site the bug was in
    // (not merely that it's possible to call openServedCore correctly).
    const cliSource = readFileSync(join(REPO_ROOT, "src/cli.ts"), "utf8");
    const indexSource = readFileSync(join(REPO_ROOT, "src/index.ts"), "utf8");
    expect(cliSource).toContain("openServedCore(getDbPath(projectDir),");
    expect(indexSource).toContain("openServedCore(getDbPath(projectDir),");
    // The bare, bug-shaped call must not remain anywhere in either file's openServedCore call.
    expect(cliSource).not.toContain("openServedCore(getDbPath(),");
    expect(indexSource).not.toContain("openServedCore(getDbPath(),");
  });
});

// ── P1-1 (Codex round 3 on PR #42): ensureMonetDir() was still bare/cwd-rooted while
// getDbPath(projectDir) roots at the target — with projectDir ≠ cwd (cwd has its own .monet, the
// target does not), the target's own parent directory never gets created and better-sqlite3's own
// open call fails CANTOPEN (it does not create missing parent directories, only the file) ─────────
describe("P1-1: ensureMonetDir(baseDir) roots the CREATED directory at baseDir, not cwd", () => {
  let target: string;
  let elsewhere: string;
  let savedStorageDir: string | undefined;

  beforeEach(() => {
    target = mkdtempSync(join(tmpdir(), "monet-p1-1-target-"));
    elsewhere = mkdtempSync(join(tmpdir(), "monet-p1-1-elsewhere-"));
    // getMonetDir's FIRST-priority rung: MONET_STORAGE_DIR, if set, wins over baseDir entirely —
    // these tests exist specifically to exercise the SECOND (project-local .monet) and THIRD
    // (HOME fallback) rungs, so a value inherited from the invoking shell (this suite's own test
    // runs are routinely launched with MONET_STORAGE_DIR set, to isolate OTHER tests) must not
    // leak in here. Found by this fix's own full-suite run: passed in isolation, failed under a
    // MONET_STORAGE_DIR-set invocation — a real gap in this test's own isolation, not the fix.
    savedStorageDir = process.env.MONET_STORAGE_DIR;
    delete process.env.MONET_STORAGE_DIR;
  });

  afterEach(() => {
    if (savedStorageDir !== undefined) process.env.MONET_STORAGE_DIR = savedStorageDir;
    else delete process.env.MONET_STORAGE_DIR;
    rmSync(target, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it("ensureMonetDir(baseDir) resolves and creates baseDir's OWN pre-existing project-local .monet, never a DIFFERENT directory's", () => {
    // getMonetDir's SECOND rung (baseDir/.monet) only applies when that directory ALREADY exists
    // (db/index.ts's own getMonetDir: `if (fs.existsSync(projectMonetDir)) return projectMonetDir`
    // — a fresh baseDir with no project-local .monet yet falls through to the HOME rung instead,
    // covered by the next test). Pre-creating target's own .monet exercises this rung specifically
    // and confirms baseDir threading reaches it rather than elsewhere's (the cwd-analog)'s own.
    mkdirSync(join(target, ".monet"), { recursive: true });
    mkdirSync(join(elsewhere, ".monet"), { recursive: true });
    const elsewhereMonetMtimeBefore = statSync(join(elsewhere, ".monet")).mtimeMs;

    const created = ensureMonetDir(target);

    expect(created).toBe(join(target, ".monet"));
    expect(statSync(join(elsewhere, ".monet")).mtimeMs).toBe(elsewhereMonetMtimeBefore); // untouched
  });

  it("ensureMonetDir(target) — target with NO pre-existing .monet — creates the SAME home-fallback resolution getDbPath(target) will use, closing the CANTOPEN gap; a bare/cwd-rooted call does not", async () => {
    // EMPIRICALLY-GROUNDED reproduction of the exact bug scenario (coordinator's own framing:
    // "projectDir≠cwd, cwd having .monet, target+home not") — isolates HOME so this never touches
    // the real ~/.monet, and proves BOTH halves in one test: the OLD bare-call shape leaves the
    // resolution's own parent directory missing (CANTOPEN reproduced directly against a real
    // better-sqlite3 Database open, not merely asserted), and the FIX (ensureMonetDir(target))
    // closes it.
    const savedHome = process.env.HOME;
    const fakeHome = mkdtempSync(join(tmpdir(), "monet-p1-1-home-"));
    try {
      process.env.HOME = fakeHome;
      // "cwd having .monet": elsewhere (the cwd-analog) has its OWN pre-existing project-local
      // store — a bare/cwd-rooted ensureMonetDir() call resolves and no-ops THERE, never reaching
      // fakeHome at all.
      mkdirSync(join(elsewhere, ".monet"), { recursive: true });
      // "target+home not": target has no project-local .monet, and the isolated fakeHome's own
      // .monet does not exist yet either.
      expect(existsSync(join(fakeHome, ".monet"))).toBe(false);

      // THE BUG, reproduced directly: the OLD code's bare call is EQUIVALENT to ensureMonetDir()
      // with no argument, which (via getMonetDir's own process.cwd() default) resolves however
      // the ACTUAL OS cwd happens to — modeled here as ensureMonetDir(elsewhere), since that is
      // what "cwd, with its own .monet" resolves and no-ops on. Either way, fakeHome/.monet is
      // NEVER created by it — leaving getDbPath(target)'s own resolution (which, since target has
      // no project-local .monet, ALSO falls through to fakeHome) with a missing parent directory.
      ensureMonetDir(elsewhere);
      expect(existsSync(join(fakeHome, ".monet"))).toBe(false); // still missing — the bug

      const dbPath = getDbPath(target);
      expect(dbPath).toBe(join(fakeHome, ".monet", "monet.db"));
      expect(() => new Database(dbPath)).toThrow(/directory does not exist/i); // CANTOPEN, reproduced

      // THE FIX: ensureMonetDir(target) — not bare, not elsewhere — resolves via the SAME
      // fallback getDbPath(target) will use (target has no project-local .monet either) and
      // creates it, closing the gap.
      ensureMonetDir(target);
      expect(existsSync(join(fakeHome, ".monet"))).toBe(true);

      const core = await openServedCore(
        dbPath,
        { scopeContext: target, defaultCircle: "test-circle" },
        async () => new HashingEmbeddingProvider(),
      );
      core.close();
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("source regression guard: cli.ts's `start` action and index.ts's stdio entry both call ensureMonetDir WITH the resolved project dir, never bare, at their own fixed call site", () => {
    const cliSource = readFileSync(join(REPO_ROOT, "src/cli.ts"), "utf8");
    const indexSource = readFileSync(join(REPO_ROOT, "src/index.ts"), "utf8");
    expect(cliSource).toContain("ensureMonetDir(projectDir);");
    expect(indexSource).toContain("ensureMonetDir(projectDir);");
  });
});
