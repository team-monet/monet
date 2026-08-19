import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  FreshStoreEmbedderUnavailableError,
  GATE_JOURNAL_FILENAME,
  HashingEmbeddingProvider,
  type EmbeddingProvider,
} from "@team-monet/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openServedCore, openStatusCore } from "../bootstrap";
import { ensureMonetDir, getDbPath, getGateJournalPath, getGateMirrorPath } from "../db/index";
import { defaultGateCliDependencies } from "../gate-cli";

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

  // ── Component B (4b-D): mirror freshness — the served core is the one writer surface ─────────

  it("a served core constructed with gateSidecarPath materializes the mirror after a declare", async () => {
    const savedStorageDir = process.env.MONET_STORAGE_DIR;
    // getGateMirrorPath()'s default resolution (db/index.ts) checks MONET_STORAGE_DIR first —
    // the most direct lever to point it at this test's own tmp dir without touching the real
    // ~/.monet, matching circle.test.ts's own established convention for this exact override.
    process.env.MONET_STORAGE_DIR = dir;
    try {
      const mirrorPath = getGateMirrorPath();
      expect(mirrorPath).toBe(join(dir, "gate-mirror.json"));
      expect(existsSync(mirrorPath)).toBe(false);

      // A fake, fast selectEmbedder — matching this file's OWN established pattern (see
      // "served bootstrap surfaces the typed fresh-store fallback error" above): the REAL
      // default (chooseStoreEmbedder) attempts to load the actual MiniLM model, which is slow
      // and environment-dependent (network/model-cache), not what this test is about.
      const core = await openServedCore(
        ":memory:",
        { scopeContext: dir, defaultCircle: "test-circle", gateSidecarPath: mirrorPath },
        async () => new HashingEmbeddingProvider(),
      );
      // CONSTRUCTION ITSELF already refreshes the mirror (core's own generation-bump contract —
      // this test only supplies WHERE): a fresh store's mirror is "missing" per inspectSidecar,
      // which is stale, so the core writes an EMPTY mirror immediately rather than waiting for
      // the first mutation. That is correct and desirable — starting `monet start` alone now
      // establishes a mirror (even an empty one) instead of leaving none until something is
      // declared — so this test pins THAT too, not just the post-declare content.
      expect(existsSync(mirrorPath)).toBe(true);
      const empty = JSON.parse(readFileSync(mirrorPath, "utf8")) as { entries: unknown[] };
      expect(empty.entries).toEqual([]);

      await core.declare({
        species: "rule",
        stage: "git force push",
        patterns: ["Bash:git push --force"],
        content: "Never force-push to main.",
        severity: "blocking",
        scope: "domain",
        reason: "a rewritten history cannot be recovered from a teammate's clone",
      });
      core.close();

      expect(existsSync(mirrorPath)).toBe(true);
      const mirror = JSON.parse(readFileSync(mirrorPath, "utf8")) as {
        entries: Array<{ text: string; severity: string; reason: string | null }>;
      };
      expect(mirror.entries).toHaveLength(1);
      expect(mirror.entries[0]).toMatchObject({
        text: "Never force-push to main",
        severity: "blocking",
        reason: "a rewritten history cannot be recovered from a teammate's clone",
      });
    } finally {
      if (savedStorageDir !== undefined) process.env.MONET_STORAGE_DIR = savedStorageDir;
      else delete process.env.MONET_STORAGE_DIR;
    }
  });

  it("a served core constructed WITHOUT gateSidecarPath never writes a mirror (today's behavior, unchanged for any caller that omits it)", async () => {
    const mirrorPath = join(dir, "gate-mirror.json");
    const core = await openServedCore(
      ":memory:",
      {
        scopeContext: dir,
        defaultCircle: "test-circle",
        // gateSidecarPath deliberately omitted.
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
    core.close();
    expect(existsSync(mirrorPath)).toBe(false);
  });

  // ── #75: the gate journal — the served core is the one writer surface for the MCP mouths ───────

  it("a served core constructed with gateJournalPath journals a stage_lookup, carrying the per-rule identity gate_events cannot", async () => {
    const journalPath = join(dir, "gate-journal.jsonl");
    const core = await openServedCore(
      ":memory:",
      { scopeContext: dir, defaultCircle: "test-circle", gateJournalPath: journalPath },
      async () => new HashingEmbeddingProvider(),
    );
    const declared = await core.declare({
      species: "rule",
      stage: "git force push",
      patterns: ["Bash:git push --force"],
      content: "Never force-push to main.",
      severity: "blocking",
      scope: "domain",
      reason: "a rewritten history cannot be recovered from a teammate's clone",
    });
    // DeclareResult is a union; only the "rule" branch carries conceptId, which is the id the
    // journal's own ruleIds is asserted against below.
    if (declared.species !== "rule") throw new Error("expected a rule declaration");

    // THE CALL BEHIND THE `stage_lookup` MCP TOOL. core's own mcp-server.ts handler is
    // `core.stageLookup({ stage, circle })` — it passes no `record`, so the journal is NOT gated
    // off (engine.ts's beginGateJournal: `opts.record !== false`). Calling it the same way here
    // exercises the identical mouth the shipped server reaches.
    const result = core.stageLookup({ stage: "git force push" });
    expect(result.matched).toBe(true);
    expect(result.rules).toHaveLength(1);
    core.close();

    expect(existsSync(journalPath)).toBe(true);
    const entries = readFileSync(journalPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.mouth === "stage-lookup");
    // Both halves of the event: the arrival written at the mouth, and the disposition.
    expect(entries.map((entry) => entry.phase)).toEqual(["arrival", "disposition"]);
    const disposition = entries[1];
    expect(disposition.disposition).toBe("deny");
    // THE FIELD #62 NEEDS, and the whole reason this wiring matters: `gate_events` records
    // rule_count and stage ids but never rule IDENTITY, so "declared but never fired" is
    // unanswerable from sqlite alone. Asserting the actual declared id, not merely non-emptiness.
    expect(disposition.ruleIds).toEqual([declared.conceptId]);
    // Advisory-only by design: a blocking severity is DELIVERED at this mouth, never enforced.
    expect(disposition.enforced).toBe(false);
  });

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
describe("#75: both served entry points wire the gate journal", () => {
  it("source regression guard: cli.ts's `start` action AND index.ts's stdio entry both pass gateJournalPath, unrooted, at their openServedCore call site", () => {
    // A source-text check, matching this file's own established guard shape above: the FUNCTIONAL
    // test proves a served core given the option journals, and this proves the two REAL entry
    // points actually give it — the exact gap #75 was, where the option existed in core and was
    // set only by monet-core's dev-only scripts/mcp-cli.ts, which the shipped binary never runs.
    const cliSource = readFileSync(join(REPO_ROOT, "src/cli.ts"), "utf8");
    const indexSource = readFileSync(join(REPO_ROOT, "src/index.ts"), "utf8");
    expect(cliSource).toContain("gateJournalPath: getGateJournalPath(),");
    expect(indexSource).toContain("gateJournalPath: getGateJournalPath(),");
    // NOT project-rooted — the inversion of what this guard asserted when #75 landed (P1, Codex
    // round 1 on PR #76). The store and the mirror pair on one projectDir because each serves this
    // project alone; the journal is one stream shared with the hook wrapper and `monet gate`, so
    // per-project rooting silently forked it. `getGateJournalPath` no longer accepts a baseDir at
    // all, which makes the project-rooted call a type error rather than merely a wrong answer —
    // this guard stays because the reverting shape is a plausible re-edit and the reason it is
    // wrong lives nowhere near the call site's type.
    expect(cliSource).not.toContain("gateJournalPath: getGateJournalPath(projectDir),");
    expect(indexSource).not.toContain("gateJournalPath: getGateJournalPath(projectDir),");
  });

  it("every journal writer resolves ONE file: with a project-local .monet present and MONET_STORAGE_DIR unset, getGateJournalPath() and gate-cli's own journalPath() agree", () => {
    // P1 (Codex on PR #76): the finding itself, pinned. The journal's load-bearing invariant is
    // that all mouths append to ONE stream — core's own GATE_JOURNAL_FILENAME comment ("all three
    // mouths write ONE stream"), and `parentId` correlating a hook event to the gate event it
    // caused, only mean anything if those events land in the same file. The divergence this pins
    // shut: getGateJournalPath resolved through getMonetDir's THREE rungs (MONET_STORAGE_DIR →
    // project-local .monet → home) while the gate CLI and the generated hook resolve TWO
    // (MONET_STORAGE_DIR → home), so a project with its own .monet and no MONET_STORAGE_DIR split
    // the stream in half — MCP-originated events into the project, hook/CLI events into home.
    //
    // The scenario is constructed to make exactly that split appear: MONET_STORAGE_DIR unset (the
    // rung that otherwise collapses all three writers onto one answer regardless), a cwd that DOES
    // have a project-local .monet (getMonetDir's second rung, which only fires when the directory
    // already exists), and an isolated HOME so the third rung is observable without touching the
    // operator's real ~/.monet.
    const savedStorageDir = process.env.MONET_STORAGE_DIR;
    const savedHome = process.env.HOME;
    const savedCwd = process.cwd();
    const fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "monet-76-home-")));
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "monet-76-project-")));
    try {
      delete process.env.MONET_STORAGE_DIR;
      process.env.HOME = fakeHome;
      mkdirSync(join(projectDir, ".monet"), { recursive: true });
      process.chdir(projectDir);

      // The gate CLI's REAL default dependency, not a restatement of it — this test is worthless
      // if it asserts against a copy of the resolution rather than the one the shipped `monet
      // gate` actually calls.
      const cliJournalPath = defaultGateCliDependencies().journalPath();

      // THE ASSERTION THE FINDING ASKS FOR: one file, not two.
      expect(getGateJournalPath()).toBe(cliJournalPath);
      // And WHICH file — the two-rung home answer both the gate CLI and install-cli.ts's
      // generated hook already resolve to, not the project-local one. Asserting only equality
      // would be satisfiable by moving the OTHER writers onto the project-aware chain, which the
      // generated hook (a standalone script that cannot import a resolver) cannot follow.
      expect(getGateJournalPath()).toBe(join(fakeHome, ".monet", GATE_JOURNAL_FILENAME));
    } finally {
      process.chdir(savedCwd);
      if (savedStorageDir !== undefined) process.env.MONET_STORAGE_DIR = savedStorageDir;
      else delete process.env.MONET_STORAGE_DIR;
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("getGateJournalPath resolves TWO rungs — MONET_STORAGE_DIR, else home — and never getMonetDir's project-local rung between them", () => {
    const savedStorageDir = process.env.MONET_STORAGE_DIR;
    const savedHome = process.env.HOME;
    const dir = mkdtempSync(join(tmpdir(), "monet-75-path-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "monet-76-ladder-home-"));
    try {
      // RUNG 1 — MONET_STORAGE_DIR, the override every journal writer honors first, and the ONE
      // rung under which the journal does sit beside the store, since getDbPath honors it too.
      process.env.MONET_STORAGE_DIR = dir;
      expect(getGateJournalPath()).toBe(join(dir, "gate-journal.jsonl"));
      expect(getGateJournalPath()).toBe(join(dir, GATE_JOURNAL_FILENAME));
      expect(getDbPath()).toBe(join(dir, "monet.db"));

      // RUNG 2 — unset falls straight through to home. Beside-the-store is NOT a property this
      // function holds in general (P1, Codex round 1 on PR #76): getDbPath keeps getMonetDir's
      // project-local rung BETWEEN these two and the journal deliberately does not, because the
      // journal is one stream shared with mouths — the generated hook wrapper, `monet gate` —
      // that resolve only these two rungs. The test above pins what that difference costs when a
      // project-local .monet actually exists; this pins the ladder itself, including that the
      // middle rung is absent rather than merely untested.
      delete process.env.MONET_STORAGE_DIR;
      process.env.HOME = fakeHome;
      expect(getGateJournalPath()).toBe(join(fakeHome, ".monet", GATE_JOURNAL_FILENAME));
    } finally {
      if (savedStorageDir !== undefined) process.env.MONET_STORAGE_DIR = savedStorageDir;
      else delete process.env.MONET_STORAGE_DIR;
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      rmSync(dir, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("the home rung is os.homedir(), not cwd: with MONET_STORAGE_DIR, HOME and USERPROFILE all unset, getGateJournalPath() lands under the account's real home", () => {
    // P2 (Codex round 2 on PR #76): the LAST rung, which the ladder test above never reaches
    // because it always leaves HOME set. In a minimal service environment — a launchd/systemd
    // unit, a bare container — none of the three variables exist, and an env-only home chain
    // (`HOME || USERPROFILE || cwd`) falls to whatever directory the process happens to have
    // started in. The generated hook has no such rung: install-cli.ts bakes in `os.homedir()`,
    // which falls back to the passwd DB and therefore still resolves the account's real home. So
    // the stream splits again in exactly the environment nobody is watching — the split this
    // shared resolver exists to close, reopened one rung further down.
    const savedStorageDir = process.env.MONET_STORAGE_DIR;
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    try {
      delete process.env.MONET_STORAGE_DIR;
      delete process.env.HOME;
      delete process.env.USERPROFILE;

      // `os.homedir()` is read AFTER the deletes for the same reason the assertion exists: with
      // HOME unset it is the passwd-DB answer, not an echo of the variable this test just removed.
      expect(getGateJournalPath()).toBe(join(homedir(), ".monet", GATE_JOURNAL_FILENAME));
      // And explicitly NOT the cwd answer — the pre-fix value, spelled out so a revert to the
      // env-only chain fails here with the wrong path named rather than merely a mismatch.
      expect(getGateJournalPath()).not.toBe(join(process.cwd(), ".monet", GATE_JOURNAL_FILENAME));
    } finally {
      // Restoring HOME matters more than usual here: leaking an unset HOME into sibling tests
      // would silently move every home-rung assertion in this file onto the real ~/.monet.
      if (savedStorageDir !== undefined) process.env.MONET_STORAGE_DIR = savedStorageDir;
      else delete process.env.MONET_STORAGE_DIR;
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      if (savedUserProfile !== undefined) process.env.USERPROFILE = savedUserProfile;
      else delete process.env.USERPROFILE;
    }
  });
});

// ── FIX 1 (Codex round 2 on PR #42): the served core's store and its mirror sidecar must agree
// on which project they're serving, or a declaration lands in one project's store while
// materializing into a DIFFERENT project's mirror ──────────────────────────────────────────────
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

  it("a declaration through a served core whose store AND mirror are BOTH rooted at the same project dir lands in that project's mirror only — a DIFFERENT project's store stays untouched", async () => {
    // Simulates: MONET_PROJECT_DIR=dirA, cwd=dirB, both with their own project-local .monet dirs
    // (the coordinator's own test shape) — dbPathA/dbPathB stand in for what getDbPath(dirA) and
    // getDbPath(dirB) would each resolve to; mirrorPathA for getGateMirrorPath(dirA). The FIX
    // (cli.ts:61/index.ts:28) is that the served core's OWN dbPath argument now follows the SAME
    // resolved project dir the mirror path already did — reproduced directly here by passing BOTH
    // rooted at dirA, never mixing in dirB anywhere in this core's own construction.
    const dbPathA = join(dirA, "monet.db");
    const dbPathB = join(dirB, "monet.db");
    const mirrorPathA = join(dirA, "gate-mirror.json");

    // B's store: created and left with zero concepts, to prove A's session never reaches it.
    const coreB = await openServedCore(
      dbPathB,
      { scopeContext: dirB, defaultCircle: "circle-b" },
      async () => new HashingEmbeddingProvider(),
    );
    coreB.close();

    // A's served core: dbPath AND gateSidecarPath BOTH rooted at dirA — the fix, exercised
    // directly.
    const coreA = await openServedCore(
      dbPathA,
      { scopeContext: dirA, defaultCircle: "circle-a", gateSidecarPath: mirrorPathA },
      async () => new HashingEmbeddingProvider(),
    );
    await coreA.declare({
      species: "rule", stage: "git force push", patterns: ["Bash:git push --force"],
      content: "Never force-push to main.", severity: "blocking", scope: "domain",
      reason: "declared through A's served core — must land in A's mirror, never B's store",
    });
    coreA.close();

    // A's mirror carries the declaration (materialized FROM A's own store).
    expect(existsSync(mirrorPathA)).toBe(true);
    const mirror = JSON.parse(readFileSync(mirrorPathA, "utf8")) as { entries: Array<{ text: string }> };
    expect(mirror.entries).toHaveLength(1);
    expect(mirror.entries[0].text).toBe("Never force-push to main");

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

  it("source regression guard: cli.ts's `start` action, index.ts's stdio entry, and install-cli.ts's runInstall all call ensureMonetDir WITH the resolved project dir, never bare, at their own fixed call site", () => {
    const cliSource = readFileSync(join(REPO_ROOT, "src/cli.ts"), "utf8");
    const indexSource = readFileSync(join(REPO_ROOT, "src/index.ts"), "utf8");
    const installSource = readFileSync(join(REPO_ROOT, "src/install-cli.ts"), "utf8");
    expect(cliSource).toContain("ensureMonetDir(projectDir);");
    expect(indexSource).toContain("ensureMonetDir(projectDir);");
    expect(installSource).toContain("deps.ensureMonetDir(target.projectDir);");
  });
});
