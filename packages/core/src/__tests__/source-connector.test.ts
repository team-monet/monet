import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { MonetCore } from "../engine";
import { BetterSqlitePort } from "../storage";
import { registerMonetCoreTools } from "../mcp-server";
import { computeSourceManifestHash } from "../source-scanner";
import { validateRepoMdPublishedPath } from "../source-materializer";

const auth = { callerId: "caller", projectId: "project" } as const;
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function makeWritable(path: string): void {
  try {
    const stats = lstatSync(path);
    if (!stats.isDirectory()) { chmodSync(path, 0o600); return; }
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) makeWritable(join(path, entry));
  } catch { /* cleanup */ }
}

function fixture(
  label: string,
  refresh: { mode: "manual" } | { mode: "interval"; intervalSeconds: number } = { mode: "manual" },
  sourcePathValidationCheck?: () => void,
) {
  const root = mkdtempSync(join(tmpdir(), `monet-source-connector-${label}-`));
  const repo = join(root, "repo");
  const storage = join(root, "managed");
  execFileSync("git", ["init", repo]);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# Intro\n\nbody\n");
  git(repo, "add", "README.md"); git(repo, "commit", "-m", "initial");
  const core = new MonetCore(join(root, "monet.db"), { sourceStorageDir: storage, sourcePathValidationCheck });
  core.createSource({
    id: "repo-source", type: "repo-md", name: "repo", localPath: repo, circle: "repo",
    include: ["README.md"], exclude: [], autoDetect: false,
    access: { allowedCallerIds: [auth.callerId], allowedProjectIds: [auth.projectId] }, writeBack: "none",
    refresh,
  });
  core.createSource({
    id: "denied-source", type: "git-md", name: "denied", remoteUrl: "https://example.test/owner/denied.git", branch: "main", circle: "repo",
    include: ["README.md"], exclude: [], autoDetect: false,
    access: { allowedCallerIds: ["other"], allowedProjectIds: [auth.projectId] }, writeBack: "none",
    transport: { allowedUrlSchemes: ["https"], allowedHosts: ["example.test"] },
  });
  return {
    root, repo, storage, db: join(root, "monet.db"), core,
    commit(content: string) {
      writeFileSync(join(repo, "README.md"), content);
      git(repo, "add", "README.md"); git(repo, "commit", "-m", "change");
    },
    cleanup() { core.close(); makeWritable(root); rmSync(root, { recursive: true, force: true }); },
  };
}

describe("authorized source connector surface", () => {
  it.each([
    ["manual", { mode: "manual" } as const, 86_400],
    ["interval", { mode: "interval", intervalSeconds: 120 } as const, 240],
  ])("durably refreshes a stale %s source on authorized noop without creating a run", async (_label, refresh, threshold) => {
    const f = fixture(`noop-${_label}`, refresh);
    let reopened: MonetCore | null = null;
    try {
      await f.core.syncSource("repo-source", auth);
      const before = f.core.sourceStatus("repo-source", auth);
      const runCount = f.core.listSourceRuns("repo-source").length;
      const staleNow = before.lastSuccessfulSyncAt! + (threshold + 10) * 1000;
      expect(f.core.sourceStatus("repo-source", auth, staleNow).freshness).toBe("stale");
      const originalNow = Date.now;
      Date.now = () => staleNow;
      try {
        await expect(f.core.syncSource("repo-source", auth)).resolves.toMatchObject({ status: "noop", runId: null });
      } finally { Date.now = originalNow; }
      let latestVerification = staleNow;
      const after = f.core.sourceStatus("repo-source", auth, latestVerification);
      expect(after).toMatchObject({ freshness: "fresh", lastAttemptAt: latestVerification, lastSuccessfulSyncAt: latestVerification });
      expect(f.core.listSourceRuns("repo-source")).toHaveLength(runCount);
      const attemptsAfterNoop = (f.core as unknown as { db: { prepare: (sql: string) => { get: (...args: unknown[]) => { count: number } } } }).db
        .prepare("SELECT COUNT(*) AS count FROM source_attempt_events WHERE source_id='repo-source'").get().count;
      expect(attemptsAfterNoop).toBe(3); // run creation + successful invocation + verification
      if (_label === "manual") {
        for (let index = 1; index <= 8; index += 1) {
          latestVerification = staleNow + index;
          const original = Date.now;
          Date.now = () => latestVerification;
          try { await f.core.syncSource("repo-source", auth); } finally { Date.now = original; }
        }
      }
      const checksBeforeDenied = (f.core as unknown as { db: { prepare: (sql: string) => { get: (...args: unknown[]) => { count: number } } } }).db
        .prepare("SELECT COUNT(*) AS count FROM source_verification_checks WHERE source_id='repo-source'").get().count;
      expect(checksBeforeDenied).toBe(1);
      await expect(f.core.syncSource("repo-source")).rejects.toThrow(/trusted source authorization context/);
      await expect(f.core.syncSource("repo-source", { callerId: "other", projectId: "project" })).rejects.toThrow(/unavailable/);
      const checksAfterDenied = (f.core as unknown as { db: { prepare: (sql: string) => { get: (...args: unknown[]) => { count: number } } } }).db
        .prepare("SELECT COUNT(*) AS count FROM source_verification_checks WHERE source_id='repo-source'").get().count;
      expect(checksAfterDenied).toBe(checksBeforeDenied);
      f.core.close();
      reopened = new MonetCore(f.db, { sourceStorageDir: f.storage });
      expect(reopened.sourceStatus("repo-source", auth, latestVerification)).toMatchObject({ freshness: "fresh", lastSuccessfulSyncAt: latestVerification });
    } finally {
      try { reopened?.close(); } catch { /* closed */ }
      makeWritable(f.root); rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("keeps freshness stale while registry configuration is pending replacement", async () => {
    const f = fixture("pending-config");
    try {
      await f.core.syncSource("repo-source", auth);
      await f.core.syncSource("repo-source", auth);
      expect(f.core.sourceStatus("repo-source", auth).freshness).toBe("fresh");
      f.core.updateSource("repo-source", { include: ["*.md"], exclude: ["drafts/**"] });
      const pending = f.core.sourceStatus("repo-source", auth);
      expect(pending).toMatchObject({ freshness: "stale", lastSyncResult: "success" });
      await f.core.syncSource("repo-source", auth);
      expect(f.core.sourceStatus("repo-source", auth)).toMatchObject({ freshness: "fresh", lastSyncResult: "success" });
    } finally { f.cleanup(); }
  });

  it("reads runs, verification, and dirty state from one SQLite snapshot", async () => {
    const f = fixture("status-snapshot", { mode: "interval", intervalSeconds: 60 });
    let writer: MonetCore | null = null;
    try {
      await f.core.syncSource("repo-source", auth);
      await f.core.syncSource("repo-source", auth);
      writer = new MonetCore(f.db, { sourceStorageDir: f.storage });
      const ledger = (f.core as unknown as { sourceLedger: { attemptReadFault?: () => void } }).sourceLedger;
      ledger.attemptReadFault = () => {
        ledger.attemptReadFault = undefined;
        const begun = writer!.beginSourceRun({ sourceId: "repo-source", snapshotId: "c".repeat(40) });
        if (begun.kind !== "started") throw new Error("expected concurrent run");
        writer!.abortSourceRun(begun.run.id, "failed", "concurrent failure");
      };
      expect(f.core.sourceStatus("repo-source", auth)).toMatchObject({
        lastSyncResult: "success", schedule: { state: "scheduled", consecutiveFailures: 0 },
      });
      expect(f.core.sourceStatus("repo-source", auth)).toMatchObject({
        lastSyncResult: "failed", lastError: "concurrent failure",
        schedule: { state: "backoff", consecutiveFailures: 1 },
      });
    } finally { writer?.close(); f.cleanup(); }
  });

  it("fails closed without trusted context and filters list without exposing denied ids", () => {
    const f = fixture("auth");
    try {
      expect(() => f.core.listConnectorSources()).toThrow(/trusted source authorization context/);
      expect(f.core.listConnectorSources(auth).map((source) => source.id)).toEqual(["repo-source"]);
      expect(() => f.core.sourceStatus("denied-source", auth)).toThrow("source is unavailable");
      expect(() => f.core.sourceStatus("missing-source", auth)).toThrow("source is unavailable");
    } finally { f.cleanup(); }
  });

  it("reports only the active publication, conservative partial status, and redacted errors", async () => {
    const f = fixture("status");
    try {
      await f.core.syncSource("repo-source", auth);
      const active = f.core.sourceStatus("repo-source", auth);
      expect(active).toMatchObject({ lastSyncResult: "success", freshness: "fresh", filesIndexed: 1, dirtyFiles: 0 });
      expect(active.chunksIndexed).toBeGreaterThan(0);
      const begun = f.core.beginSourceRun({ sourceId: "repo-source", snapshotId: "a".repeat(40) });
      if (begun.kind !== "started") throw new Error("expected run");
      f.core.stageSourceManifest({ runId: begun.run.id, scanStatus: "partial", manifestHash: computeSourceManifestHash([]), files: [], chunks: [] });
      f.core.abortSourceRun(begun.run.id, "partial", "https://user:pass@example.test ghp_abcdefghijklmnopqrstuvwxyz123456");
      const status = f.core.sourceStatus("repo-source", auth);
      expect(status).toMatchObject({ lastSyncResult: "partial", freshness: "stale", filesIndexed: 1, dirtyFiles: 0 });
      expect(status.lastError).not.toContain("user:pass");
      expect(status.lastError).not.toContain("ghp_");
      f.commit("# Intro\n\nchanged body\n");
      await expect(f.core.syncRepoMdSource("repo-source", {
        fault: (point) => { if (point === "after-stage") throw new Error("pause after complete scan"); },
      })).rejects.toThrow(/pause after complete scan/);
      const staged = f.core.sourceStatus("repo-source", auth);
      expect(staged).toMatchObject({ lastSyncResult: "failed", filesIndexed: 1, dirtyFiles: 1, lastError: "pause after complete scan" });
    } finally { f.cleanup(); }
  });

  it("returns only the exact sealed active variant and does not repair a bad current pointer", async () => {
    const f = fixture("path");
    try {
      await f.core.syncSource("repo-source", auth);
      const before = f.core.sourcePath("repo-source", auth);
      expect(readlinkSync(before.path)).toContain(before.revision);
      f.core.updateSource("repo-source", { include: ["*.md"] });
      expect(f.core.sourcePath("repo-source", auth).snapshotPath).toBe(before.snapshotPath);
      unlinkSync(before.path);
      expect(() => f.core.sourcePath("repo-source", auth)).toThrow();
      expect(() => readlinkSync(before.path)).toThrow();
    } finally { f.cleanup(); }
  });

  it("rejects tombstoned public sync before privileged removal recovery", async () => {
    const f = fixture("tombstone");
    try {
      await f.core.syncSource("repo-source", auth);
      const path = f.core.sourcePath("repo-source", auth).path;
      f.core.removeSource("repo-source");
      await expect(f.core.syncSource("repo-source", auth)).rejects.toThrow("source is unavailable");
      expect(readlinkSync(path)).toBeTruthy();
    } finally { f.cleanup(); }
  });

  it("keeps an unsynced authorized git-md source path closed", () => {
    const f = fixture("git");
    try {
      f.core.updateSource("denied-source", { access: { allowedCallerIds: [auth.callerId], allowedProjectIds: [auth.projectId] } });
      expect(() => f.core.sourcePath("denied-source", auth)).toThrow(/no published snapshot/);
    } finally { f.cleanup(); }
  });

  it("fails closed when repo-md authorization, configuration, or removal changes during exhaustive path validation", async () => {
    let duringValidation = () => undefined;
    const f = fixture("path-toctou", { mode: "manual" }, () => duringValidation());
    try {
      await f.core.syncSource("repo-source", auth);
      const exact = f.core.sourcePath("repo-source", auth);
      let unchangedChecks = 0;
      duringValidation = () => { unchangedChecks += 1; };
      expect(f.core.sourcePath("repo-source", auth)).toEqual(exact);
      expect(unchangedChecks).toBeGreaterThan(1);

      let changed = false;
      duringValidation = () => {
        if (changed) return;
        changed = true;
        f.core.updateSource("repo-source", { name: "changed during validation" });
      };
      expect(() => f.core.sourcePath("repo-source", auth)).toThrow("source changed during operation");

      let revoked = false;
      duringValidation = () => {
        if (revoked) return;
        revoked = true;
        f.core.updateSource("repo-source", {
          access: { allowedCallerIds: ["other"], allowedProjectIds: [auth.projectId] },
        });
      };
      expect(() => f.core.sourcePath("repo-source", auth)).toThrow("source is unavailable");

      f.core.updateSource("repo-source", {
        access: { allowedCallerIds: [auth.callerId], allowedProjectIds: [auth.projectId] },
      });
      let removed = false;
      duringValidation = () => {
        if (removed) return;
        removed = true;
        f.core.removeSource("repo-source");
      };
      expect(() => f.core.sourcePath("repo-source", auth)).toThrow("source is unavailable");
    } finally { f.cleanup(); }
  });

  it("rechecks the lifecycle/config fence inside the sync lock before mutation", async () => {
    const f = fixture("sync-race");
    try {
      const registry = (f.core as unknown as { sourceRegistry: { authorizeSource: (...args: unknown[]) => boolean } }).sourceRegistry;
      const original = registry.authorizeSource.bind(registry);
      let calls = 0;
      registry.authorizeSource = (...args: unknown[]) => {
        calls += 1;
        if (calls === 3) f.core.updateSource("repo-source", { name: "changed" });
        return original(...args);
      };
      await expect(f.core.syncSource("repo-source", auth)).rejects.toThrow(/changed before sync began/);
      expect(f.core.listSourceRuns("repo-source")).toEqual([]);
    } finally { f.cleanup(); }
  });

  it("fails closed on a tampered completion seal without repairing it", async () => {
    const f = fixture("seal");
    try {
      await f.core.syncSource("repo-source", auth);
      const path = f.core.sourcePath("repo-source", auth);
      const sidecar = `${path.snapshotPath}.complete.json`;
      chmodSync(sidecar, 0o600);
      writeFileSync(sidecar, "{}\n");
      expect(() => f.core.sourcePath("repo-source", auth)).toThrow(/sidecar|marker/);
      expect(() => f.core.sourcePath("repo-source", auth)).toThrow(/sidecar|marker/);
    } finally { f.cleanup(); }
  });

  it("counts add/delete/modify/mixed complete staged deltas by distinct path", async () => {
    const cases: Array<[string, (repo: string) => void, number]> = [
      ["add", (repo) => writeFileSync(join(repo, "NEW.md"), "# new\n"), 1],
      ["delete", (repo) => unlinkSync(join(repo, "README.md")), 1],
      ["modify", (repo) => writeFileSync(join(repo, "README.md"), "# changed\n"), 1],
      ["mixed", (repo) => {
        writeFileSync(join(repo, "README.md"), "# changed\n");
        unlinkSync(join(repo, "OLD.md"));
        writeFileSync(join(repo, "NEW.md"), "# new\n");
      }, 3],
    ];
    for (const [label, change, expected] of cases) {
      const f = fixture(`dirty-${label}`);
      try {
        f.core.updateSource("repo-source", { include: ["*.md"] });
        if (label === "mixed") {
          writeFileSync(join(f.repo, "OLD.md"), "# old\n");
          git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "add old");
        }
        await f.core.syncRepoMdSource("repo-source");
        change(f.repo);
        git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", `dirty ${label}`);
        await expect(f.core.syncRepoMdSource("repo-source", {
          fault: (point) => { if (point === "after-stage") throw new Error("pause staged delta"); },
        })).rejects.toThrow(/pause staged delta/);
        expect(f.core.sourceStatus("repo-source", auth).dirtyFiles).toBe(expected);
      } finally { f.cleanup(); }
    }
  });

  it("sanitizes abort reasons before persistence", () => {
    const f = fixture("reason-redaction");
    try {
      const begun = f.core.beginSourceRun({ sourceId: "repo-source", snapshotId: "b".repeat(40) });
      if (begun.kind !== "started") throw new Error("expected run");
      const secret = "https://user:pass@example.test/repo?access_token=secretvalue ghp_abcdefghijklmnopqrstuvwxyz123456 Bearer abcdefghijklmnop "
        + "\"/Users/Alice/My Repo/private notes.md\" \"C:\\Team Repo\\secret.txt\" \"\\\\server\\Team Share\\repo.txt\"\n"
        + "C:\\Unquoted Team Repo\\secret.txt\n\\\\server\\Unquoted Team Share\\repo.txt\n/tmp/Unquoted Repo/secret-file";
      const run = f.core.abortSourceRun(begun.run.id, "failed", secret);
      expect(run.reason).not.toMatch(/user:pass|secretvalue|ghp_|abcdefghijklmnop|My Repo|Team Repo|Team Share|Unquoted Repo|private notes|secret-file/);
      expect(f.core.getSourceRun(run.id)?.reason).toBe(run.reason);
      const raw = (f.core as unknown as { db: { prepare: (sql: string) => { get: (...args: unknown[]) => { reason: string } } } }).db
        .prepare("SELECT reason FROM source_sync_runs WHERE id=?").get(run.id).reason;
      expect(raw).toBe(run.reason);
      expect(raw).not.toMatch(/user:pass|secretvalue|ghp_|abcdefghijklmnop|My Repo|Team Repo|Team Share|Unquoted Repo|private notes|secret-file/);
    } finally { f.cleanup(); }
  });

  it("sanitizes a legacy unsanitized stored reason after reopen", async () => {
    const f = fixture("legacy-reason");
    let reopened: MonetCore | null = null;
    try {
      await f.core.syncSource("repo-source", auth);
      const begun = f.core.beginSourceRun({ sourceId: "repo-source", snapshotId: "d".repeat(40) });
      if (begun.kind !== "started") throw new Error("expected run");
      f.core.abortSourceRun(begun.run.id, "failed", "safe");
      const db = (f.core as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db;
      db.prepare("UPDATE source_sync_runs SET reason=? WHERE id=?").run("legacy /Users/Alice/Old Repo/secret.txt token=abcdefghijklmnop", begun.run.id);
      f.core.close();
      reopened = new MonetCore(f.db, { sourceStorageDir: f.storage });
      const error = reopened.sourceStatus("repo-source", auth).lastError!;
      expect(error).not.toMatch(/Old Repo|secret\.txt|abcdefghijklmnop/);
    } finally {
      try { reopened?.close(); } catch { /* closed */ }
      makeWritable(f.root); rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("migrates uninterrupted append-only verification rows and keeps the latest valid check", async () => {
    const f = fixture("verification-old-current");
    let reopened: MonetCore | null = null;
    try {
      await f.core.syncSource("repo-source", auth);
      const source = f.core.getSource("repo-source")!;
      const runCount = f.core.listSourceRuns("repo-source").length;
      f.core.close();
      const port = new BetterSqlitePort(f.db);
      port.exec(`DROP TABLE source_verification_checks; CREATE TABLE source_verification_checks (
        id TEXT PRIMARY KEY,source_id TEXT NOT NULL,run_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,
        ingest_config_hash TEXT NOT NULL,config_version INTEGER NOT NULL,lease_fence INTEGER NOT NULL,
        observed_run_count INTEGER NOT NULL,checked_at INTEGER NOT NULL)`);
      const insert = port.prepare(`INSERT INTO source_verification_checks VALUES (?,?,?,?,?,?,?,?,?)`);
      insert.run("old", source.id, source.activeRunId!, source.activeSnapshotId!, source.activeIngestConfigHash!, source.appliedConfigVersion!, source.leaseFence, runCount, 10);
      insert.run("new", source.id, source.activeRunId!, source.activeSnapshotId!, source.activeIngestConfigHash!, source.appliedConfigVersion!, source.leaseFence, runCount, 20);
      port.close();
      reopened = new MonetCore(f.db, { sourceStorageDir: f.storage });
      const rows = (reopened as unknown as { db: { prepare: (sql: string) => { all: () => Array<Record<string, unknown>> } } }).db
        .prepare("SELECT * FROM source_verification_checks").all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ source_id: source.id, run_id: source.activeRunId, checked_at: 20 });
    } finally {
      try { reopened?.close(); } catch { /* closed */ }
      makeWritable(f.root); rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each([
    ["legacy-only", null, 20, 20],
    ["current-and-legacy-before-copy", 10, 20, 20],
    ["current-and-legacy-after-copy", 30, 20, 30],
  ])("recovers verification migration state %s", async (label, currentAt, legacyAt, expectedAt) => {
    const f = fixture(`verification-${label}`);
    let reopened: MonetCore | null = null;
    try {
      await f.core.syncSource("repo-source", auth);
      const source = f.core.getSource("repo-source")!;
      const runCount = f.core.listSourceRuns("repo-source").length;
      f.core.close();
      const port = new BetterSqlitePort(f.db);
      const values = [source.id, source.activeRunId!, source.activeSnapshotId!, source.activeIngestConfigHash!, source.appliedConfigVersion!, source.leaseFence, runCount];
      port.exec(`DROP TABLE source_verification_checks`);
      if (currentAt !== null) {
        port.exec(`CREATE TABLE source_verification_checks (
          source_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,ingest_config_hash TEXT NOT NULL,
          config_version INTEGER NOT NULL,lease_fence INTEGER NOT NULL,observed_run_count INTEGER NOT NULL,checked_at INTEGER NOT NULL)`);
        port.prepare(`INSERT INTO source_verification_checks VALUES (?,?,?,?,?,?,?,?)`).run(...values, currentAt);
      }
      port.exec(`CREATE TABLE source_verification_checks_legacy (
        id TEXT PRIMARY KEY,source_id TEXT NOT NULL,run_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,
        ingest_config_hash TEXT NOT NULL,config_version INTEGER NOT NULL,lease_fence INTEGER NOT NULL,
        observed_run_count INTEGER NOT NULL,checked_at INTEGER NOT NULL)`);
      port.prepare(`INSERT INTO source_verification_checks_legacy VALUES (?,?,?,?,?,?,?,?,?)`).run("legacy", ...values, legacyAt);
      port.close();
      reopened = new MonetCore(f.db, { sourceStorageDir: f.storage });
      const db = (reopened as unknown as { db: { prepare: (sql: string) => { all: () => Array<Record<string, unknown>>; get: () => unknown } } }).db;
      expect(db.prepare("SELECT * FROM source_verification_checks").all()).toEqual([
        expect.objectContaining({ source_id: source.id, checked_at: expectedAt }),
      ]);
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_verification_checks_legacy'").get()).toBeUndefined();
      const columns = db.prepare("PRAGMA table_info(source_verification_checks)").all();
      expect(columns.find((column) => column.name === "source_id")).toMatchObject({ pk: 1 });
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_source_verification_checks_source_time'").get()).toBeUndefined();
    } finally {
      try { reopened?.close(); } catch { /* closed */ }
      makeWritable(f.root); rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("fails closed on incompatible verification schema and same-time collisions", async () => {
    for (const mode of ["schema", "collision"] as const) {
      const f = fixture(`verification-corrupt-${mode}`);
      try {
        await f.core.syncSource("repo-source", auth);
        const source = f.core.getSource("repo-source")!;
        const runCount = f.core.listSourceRuns("repo-source").length;
        f.core.close();
        const port = new BetterSqlitePort(f.db);
        if (mode === "schema") {
          port.exec(`DROP TABLE source_verification_checks; CREATE TABLE source_verification_checks (source_id TEXT PRIMARY KEY, surprise BLOB)`);
        } else {
          port.prepare(`INSERT INTO source_verification_checks VALUES (?,?,?,?,?,?,?,?)`).run(
            source.id, source.activeRunId!, source.activeSnapshotId!, source.activeIngestConfigHash!, source.appliedConfigVersion!, source.leaseFence, runCount, 20,
          );
          port.exec(`CREATE TABLE source_verification_checks_legacy (
            id TEXT PRIMARY KEY,source_id TEXT NOT NULL,run_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,
            ingest_config_hash TEXT NOT NULL,config_version INTEGER NOT NULL,lease_fence INTEGER NOT NULL,
            observed_run_count INTEGER NOT NULL,checked_at INTEGER NOT NULL)`);
          port.prepare(`INSERT INTO source_verification_checks_legacy VALUES (?,?,?,?,?,?,?,?,?)`).run(
            "collision", source.id, source.activeRunId!, source.activeSnapshotId!, source.activeIngestConfigHash!,
            source.appliedConfigVersion!, source.leaseFence, 0, 20,
          );
        }
        port.close();
        expect(() => new MonetCore(f.db, { sourceStorageDir: f.storage })).toThrow(/verification migration.*(?:incompatible|collision)/);
      } finally { makeWritable(f.root); rmSync(f.root, { recursive: true, force: true }); }
    }
  });

  it("drops verification checks for completed tombstones during migration and repeated completion", async () => {
    const f = fixture("verification-complete-removal");
    let reopened: MonetCore | null = null;
    try {
      await f.core.syncSource("repo-source", auth);
      await f.core.syncSource("repo-source", auth);
      const source = f.core.getSource("repo-source")!;
      f.core.removeSource("repo-source");
      await f.core.syncRepoMdSource("repo-source");
      const db = (f.core as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown; get: () => { count: number } } } }).db;
      const insert = `INSERT INTO source_verification_checks VALUES (?,?,?,?,?,?,?,?)`;
      db.prepare(insert).run(source.id, source.activeRunId!, source.activeSnapshotId!, source.activeIngestConfigHash!, source.appliedConfigVersion!, source.leaseFence, 1, 30);
      f.core.completeSourceRemoval(source.id);
      expect(db.prepare("SELECT COUNT(*) AS count FROM source_verification_checks").get().count).toBe(0);
      db.prepare(insert).run(source.id, source.activeRunId!, source.activeSnapshotId!, source.activeIngestConfigHash!, source.appliedConfigVersion!, source.leaseFence, 1, 40);
      f.core.close();
      reopened = new MonetCore(f.db, { sourceStorageDir: f.storage });
      const reopenedDb = (reopened as unknown as { db: { prepare: (sql: string) => { get: () => { count: number } } } }).db;
      expect(reopenedDb.prepare("SELECT COUNT(*) AS count FROM source_verification_checks").get().count).toBe(0);
    } finally {
      try { reopened?.close(); } catch { /* closed */ }
      makeWritable(f.root); rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("does not record a verification when an authorized sync fails", async () => {
    const f = fixture("failed-verification");
    try {
      await f.core.syncSource("repo-source", auth);
      rmSync(f.repo, { recursive: true, force: true });
      await expect(f.core.syncSource("repo-source", auth)).rejects.toThrow();
      const count = (f.core as unknown as { db: { prepare: (sql: string) => { get: () => { count: number } } } }).db
        .prepare("SELECT COUNT(*) AS count FROM source_verification_checks WHERE source_id='repo-source'").get().count;
      expect(count).toBe(0);
    } finally { f.cleanup(); }
  });

  it("read-only path validation does not create missing managed directories", () => {
    const root = mkdtempSync(join(tmpdir(), "monet-source-path-readonly-"));
    try {
      const missingBase = join(root, "missing-base");
      expect(() => validateRepoMdPublishedPath("repo-source", "a".repeat(40), "monet-src-ingest-config/v1:sha256:" + "b".repeat(64), missingBase)).toThrow();
      expect(existsSync(missingBase)).toBe(false);
      const existingBase = join(root, "existing-base");
      mkdirSync(existingBase);
      expect(() => validateRepoMdPublishedPath("repo-source", "a".repeat(40), "monet-src-ingest-config/v1:sha256:" + "b".repeat(64), existingBase)).toThrow();
      expect(existsSync(join(existingBase, "repo-md"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("source MCP contract", () => {
  it("binds identity at registration and exposes no spoofable caller/project arguments", async () => {
    const f = fixture("mcp");
    const server = new McpServer({ name: "test", version: "1" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, f.core, { sourceAuthorizationContext: auth });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "client", version: "1" });
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      for (const name of ["source_list", "source_status", "source_path", "source_sync"]) {
        const schema = tools.tools.find((tool) => tool.name === name)?.inputSchema;
        expect(JSON.stringify(schema)).not.toMatch(/callerId|projectId/);
      }
      const listed = await client.callTool({ name: "source_list", arguments: { callerId: "other", projectId: "other" } });
      const content = (listed as { content: Array<{ type: string; text: string }> }).content;
      expect(JSON.parse(content[0]!.text).sources.map((source: { id: string }) => source.id)).toEqual(["repo-source"]);
    } finally { await client.close(); f.cleanup(); }
  });

  it("fails source tools closed when the server has no trusted identity", async () => {
    const f = fixture("mcp-missing");
    const server = new McpServer({ name: "test", version: "1" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, f.core);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "client", version: "1" });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: "source_list", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("trusted source authorization context is unavailable");
    } finally { await client.close(); f.cleanup(); }
  });

  it("sanitizes exceptions from every source MCP tool", async () => {
    const f = fixture("mcp-errors");
    const leak = new Error("https://user:pass@example.test/x?token=secretvalue Bearer abcdefghijklmnop "
      + "\"/Users/Alice/My Repo/private notes.md\" \"C:\\Team Repo\\secret.txt\" \"\\\\server\\Team Share\\repo.txt\"\n"
      + "C:\\Unquoted Team Repo\\secret.txt\n\\\\server\\Unquoted Team Share\\repo.txt\n/tmp/Unquoted Repo/secret-file");
    const target = f.core as unknown as Record<string, (...args: unknown[]) => unknown>;
    target.listConnectorSources = () => { throw leak; };
    target.sourceStatus = () => { throw leak; };
    target.sourcePath = () => { throw leak; };
    target.syncSource = async () => { throw leak; };
    const server = new McpServer({ name: "test", version: "1" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, f.core, { sourceAuthorizationContext: auth });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "client", version: "1" });
    await client.connect(clientTransport);
    try {
      for (const name of ["source_list", "source_status", "source_path", "source_sync"]) {
        const result = await client.callTool({ name, arguments: name === "source_list" ? {} : { sourceId: "repo-source" } });
        const serialized = JSON.stringify(result.content);
        expect(result.isError).toBe(true);
        expect(serialized).not.toMatch(/user:pass|secretvalue|abcdefghijklmnop|My Repo|Team Repo|Team Share|Unquoted Repo|private notes|secret-file/);
      }
    } finally { await client.close(); f.cleanup(); }
  });
});
