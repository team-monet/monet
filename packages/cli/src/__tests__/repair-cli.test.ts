import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import Database from "better-sqlite3";
import {
  BetterSqlitePort,
  HashingEmbeddingProvider,
  MonetCore,
  inspectStoredEmbedderState,
  instantiateEmbedderForPin,
  type EmbeddingProvider,
  type StoredEmbedderStateInspection,
} from "@team-monet/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultRecoveryDependencies,
  registerRecoveryCommands,
  type RecoveryCliDependencies,
} from "../repair-cli";

function knownPopulation() {
  return {
    status: "known" as const,
    liveRowCount: 0,
    scoredVectorCount: 0,
    ignoredZeroVectorCount: 0,
    dimensions: [] as number[],
    malformed: { count: 0, sampleIds: [] as string[] },
  };
}

function inspection(overrides: Partial<StoredEmbedderStateInspection> = {}): StoredEmbedderStateInspection {
  return {
    dbPath: "/tmp/monet test/store's dir/monet.db",
    exists: true,
    schemaVersion: 10,
    supportedSchemaVersion: 10,
    integrity: { status: "ok", check: "ok" },
    pin: { status: "known", modelId: "hashing:dim=256:tok=2", source: "created", pinnedAt: 1 },
    populations: {
      nativeObservations: knownPopulation(),
      nativeConcepts: knownPopulation(),
      sourceObservations: knownPopulation(),
      sourceConcepts: knownPopulation(),
    },
    migration: { status: "none" },
    assessment: "safe",
    ...overrides,
  };
}

function fakeProvider(modelId = "hashing:dim=256:tok=2", dim = 256): EmbeddingProvider {
  return {
    dim,
    modelId,
    embed: () => new Float32Array(dim),
  };
}

function customInspection(modelId = "acme/custom-embedding"): StoredEmbedderStateInspection {
  const populated = { ...knownPopulation(), liveRowCount: 1, scoredVectorCount: 1, dimensions: [384] };
  return inspection({
    assessment: "unknown",
    pin: { status: "known", modelId, source: "migrated", pinnedAt: 1 },
    populations: {
      nativeObservations: populated,
      nativeConcepts: populated,
      sourceObservations: knownPopulation(),
      sourceConcepts: knownPopulation(),
    },
  });
}

function migrationInspection(
  classification: "safe" | "refused" | "unsupported" | "unknown",
): StoredEmbedderStateInspection {
  return inspection({
    assessment: classification === "safe" ? "unknown" : "unsafe",
    migration: {
      status: "active",
      targetModelId: "hashing:dim=256:tok=2",
      startedAt: 1,
      priorPin: { captured: classification !== "unsupported", modelId: "hashing:dim=256:tok=1", source: "created", pinnedAt: 1 },
      rewriteProgress: classification === "refused" ? "started-or-unknown" : "not-started",
      abandon: { classification, reason: `${classification} fixture` },
    },
  });
}

function fakeDependencies(state: StoredEmbedderStateInspection): RecoveryCliDependencies & {
  exits: number[];
} {
  const exits: number[] = [];
  return {
    exits,
    dbPath: () => state.dbPath,
    inspect: vi.fn(() => state),
    instantiate: vi.fn(async (modelId) => fakeProvider(modelId)),
    createPort: vi.fn(() => { throw new Error("unexpected port open"); }),
    createCore: vi.fn(() => { throw new Error("unexpected core open"); }),
    now: () => new Date("2026-07-22T01:02:03.004Z"),
    uuid: () => "12345678-1234-1234-1234-123456789abc",
    setExitCode: (code) => exits.push(code),
  };
}

async function run(
  args: string[],
  dependencies: RecoveryCliDependencies,
): Promise<{ stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => stdout.push(values.map(String).join(" ")));
  const error = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => stderr.push(values.map(String).join(" ")));
  try {
    const program = new Command().name("monet");
    registerRecoveryCommands(program, dependencies);
    await program.parseAsync(["node", "monet", ...args]);
    return {
      stdout: stdout.length > 0 ? `${stdout.join("\n")}\n` : "",
      stderr: stderr.length > 0 ? `${stderr.join("\n")}\n` : "",
    };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

describe("doctor and repair CLI", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reports healthy raw diagnostics without constructing a provider, port, or core", async () => {
    const state = inspection();
    const dependencies = fakeDependencies(state);
    const output = await run(["doctor", "--json"], dependencies);

    expect(output.stderr).toBe(`store: ${state.dbPath}\n`);
    const result = JSON.parse(output.stdout);
    expect(result).toMatchObject({
      schema: "monet.recovery.v1",
      command: "doctor",
      ok: true,
      dbPath: state.dbPath,
      assessment: "safe",
      provider: { loadStatus: "not-checked" },
    });
    expect(result.populations).toEqual(state.populations);
    expect(dependencies.instantiate).not.toHaveBeenCalled();
    expect(dependencies.createPort).not.toHaveBeenCalled();
    expect(dependencies.createCore).not.toHaveBeenCalled();
    expect(dependencies.exits).toEqual([]);
  });

  it("uses exit 2 for completed diagnosis that needs recovery or provider action", async () => {
    const unsafe = fakeDependencies(inspection({ assessment: "unsafe" }));
    await run(["doctor"], unsafe);
    expect(unsafe.exits).toEqual([2]);

    const unavailable = fakeDependencies(inspection());
    vi.mocked(unavailable.instantiate).mockRejectedValueOnce(new Error("provider cache unavailable"));
    const output = await run(["doctor", "--check-provider", "--json"], unavailable);
    expect(JSON.parse(output.stdout).provider).toMatchObject({
      loadStatus: "unavailable",
      reason: "provider cache unavailable",
    });
    expect(unavailable.exits).toEqual([2]);
  });

  it("reconciles an exact custom provider only when its validated width matches every live population", async () => {
    const state = customInspection();

    const unchecked = fakeDependencies(state);
    const uncheckedOutput = await run(["doctor", "--json"], unchecked);
    expect(JSON.parse(uncheckedOutput.stdout)).toMatchObject({
      ok: false,
      assessment: "unknown",
      rawAssessment: "unknown",
      provider: { loadStatus: "not-checked" },
    });
    expect(unchecked.instantiate).not.toHaveBeenCalled();
    expect(unchecked.exits).toEqual([2]);

    const compatible = fakeDependencies(state);
    vi.mocked(compatible.instantiate).mockResolvedValueOnce(fakeProvider("acme/custom-embedding", 384));
    const compatibleOutput = await run(["doctor", "--check-provider", "--json"], compatible);
    expect(JSON.parse(compatibleOutput.stdout)).toMatchObject({
      ok: true,
      assessment: "safe",
      rawAssessment: "unknown",
      provider: {
        loadStatus: "available",
        storeCompatibility: "compatible",
        storeDimensions: [384],
      },
      nextCommands: [],
    });
    expect(compatible.exits).toEqual([]);

    const incompatible = fakeDependencies(state);
    vi.mocked(incompatible.instantiate).mockResolvedValueOnce(fakeProvider("acme/custom-embedding", 256));
    const incompatibleOutput = await run(["doctor", "--check-provider", "--json"], incompatible);
    expect(JSON.parse(incompatibleOutput.stdout)).toMatchObject({
      ok: false,
      assessment: "unknown",
      provider: {
        loadStatus: "incompatible",
        storeCompatibility: "incompatible",
        storeDimensions: [384],
        reason: expect.stringContaining("declares width 256"),
      },
    });
    expect(incompatible.exits).toEqual([2]);
  });

  it("keeps an exact provider identity mismatch unavailable and recovery-needed", async () => {
    const state = customInspection();
    const dependencies = fakeDependencies(state);
    vi.mocked(dependencies.instantiate).mockResolvedValueOnce(fakeProvider("acme/different-model", 384));

    const output = await run(["doctor", "--check-provider", "--json"], dependencies);
    expect(JSON.parse(output.stdout)).toMatchObject({
      ok: false,
      assessment: "unknown",
      provider: {
        loadStatus: "unavailable",
        reason: expect.stringContaining("not 'acme/custom-embedding'"),
      },
    });
    expect(dependencies.exits).toEqual([2]);
  });

  it("emits exactly one JSON stdout object while store and provider progress stay on stderr", async () => {
    const dependencies = fakeDependencies(inspection());
    const output = await run(["doctor", "--json", "--check-provider"], dependencies);
    expect(output.stdout.trim().split("\n")).toHaveLength(1);
    expect(() => JSON.parse(output.stdout)).not.toThrow();
    expect(output.stderr).toContain("store: ");
    expect(output.stderr).toContain("provider: checking stored embedder");
  });

  it.each([
    [[], "Choose exactly one repair mode"],
    [["--target", "hashing", "--resume"], "Choose exactly one repair mode"],
    [["--target", "hashing", "--apply"], "--apply requires --yes"],
    [["--target", "hashing", "--yes"], "--yes is valid only with --apply"],
    [["--target", "   "], "--target must be a nonblank"],
    [["--target", "dim:384"], "Dimension-only targets are ambiguous"],
  ])("rejects invalid repair grammar %#", async (repairArgs, message) => {
    const dependencies = fakeDependencies(inspection());
    const output = await run(["repair", ...repairArgs, "--json"], dependencies);
    expect(JSON.parse(output.stdout)).toMatchObject({ ok: false, error: { message: expect.stringContaining(message) } });
    expect(dependencies.exits).toEqual([1]);
    expect(dependencies.createPort).not.toHaveBeenCalled();
  });

  it("preflights preview without opening or mutating the database and prints escaped commands", async () => {
    const state = inspection({
      assessment: "unsafe",
      pin: { status: "known", modelId: null, source: null, pinnedAt: null },
      populations: {
        nativeObservations: { ...knownPopulation(), liveRowCount: 1, scoredVectorCount: 1, dimensions: [384] },
        nativeConcepts: knownPopulation(),
        sourceObservations: knownPopulation(),
        sourceConcepts: knownPopulation(),
      },
    });
    const dependencies = fakeDependencies(state);
    const output = await run(["repair", "--target", "hashing", "--json"], dependencies);
    const result = JSON.parse(output.stdout);
    expect(result).toMatchObject({
      ok: true,
      applied: false,
      report: { status: "preview", databaseMutation: false, backupRequiredOnApply: true },
      backup: null,
    });
    expect(result.nextCommands[0]).toContain(`--dir '/tmp/monet test/store'\"'\"'s dir'`);
    expect(dependencies.instantiate).toHaveBeenCalledWith("hashing:dim=256:tok=2");
    expect(dependencies.createPort).not.toHaveBeenCalled();
    expect(dependencies.createCore).not.toHaveBeenCalled();
  });

  it("reports a proven-compatible same-target custom store as no-op and refuses apply before backup", async () => {
    const state = customInspection();
    const dependencies = fakeDependencies(state);
    vi.mocked(dependencies.instantiate).mockImplementation(async () => fakeProvider("acme/custom-embedding", 384));

    const preview = await run(["repair", "--target", "acme/custom-embedding", "--json"], dependencies);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      ok: true,
      applied: false,
      assessment: "safe",
      rawAssessment: "unknown",
      provider: { loadStatus: "available", storeCompatibility: "compatible" },
      nextCommands: [],
      backup: null,
      report: {
        action: "none",
        repairRequired: false,
        backupRequiredOnApply: false,
      },
    });

    const apply = await run([
      "repair", "--target", "acme/custom-embedding", "--apply", "--yes", "--json",
    ], dependencies);
    expect(JSON.parse(apply.stdout)).toMatchObject({
      ok: false,
      assessment: "safe",
      provider: { storeCompatibility: "compatible" },
      nextCommands: [],
      backup: null,
      error: { message: expect.stringContaining("no embedding repair is required") },
    });
    expect(dependencies.createPort).not.toHaveBeenCalled();
    expect(dependencies.createCore).not.toHaveBeenCalled();
  });

  it("keeps a same-target width mismatch explicit and recovery-needed", async () => {
    const state = customInspection();
    const dependencies = fakeDependencies(state);
    vi.mocked(dependencies.instantiate).mockResolvedValueOnce(fakeProvider("acme/custom-embedding", 256));

    const preview = await run(["repair", "--target", "acme/custom-embedding", "--json"], dependencies);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      ok: true,
      assessment: "unknown",
      provider: {
        loadStatus: "incompatible",
        storeCompatibility: "incompatible",
        storeDimensions: [384],
      },
      report: { action: "target", repairRequired: true, backupRequiredOnApply: true },
      backup: null,
    });
    expect(JSON.parse(preview.stdout).nextCommands.join(" ")).toContain("--apply --yes");
    expect(dependencies.createPort).not.toHaveBeenCalled();
  });

  it("reports an empty unpinned target as no-op without loading a provider or creating a backup", async () => {
    const state = inspection({
      pin: { status: "known", modelId: null, source: null, pinnedAt: null },
      assessment: "safe",
    });
    const dependencies = fakeDependencies(state);

    const preview = await run(["repair", "--target", "hashing", "--json"], dependencies);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      ok: true,
      provider: { loadStatus: "not-checked" },
      nextCommands: [],
      backup: null,
      report: { action: "none", repairRequired: false, backupRequiredOnApply: false },
    });
    const apply = await run(["repair", "--target", "hashing", "--apply", "--yes", "--json"], dependencies);
    expect(JSON.parse(apply.stdout)).toMatchObject({
      ok: false,
      nextCommands: [],
      backup: null,
      error: { message: expect.stringContaining("empty and unpinned") },
    });
    expect(dependencies.instantiate).not.toHaveBeenCalled();
    expect(dependencies.createPort).not.toHaveBeenCalled();
  });

  it("refuses an explicit target during an active sentinel and returns the exact resume command", async () => {
    const state = inspection({
      migration: {
        status: "active",
        targetModelId: "hashing:dim=256:tok=2",
        startedAt: 1,
        priorPin: { captured: true, modelId: "hashing:dim=256:tok=1", source: "created", pinnedAt: 1 },
        rewriteProgress: "not-started",
        abandon: { classification: "safe", reason: "safe" },
      },
    });
    const dependencies = fakeDependencies(state);
    const output = await run(["repair", "--target", "hashing", "--json"], dependencies);
    const result = JSON.parse(output.stdout);
    expect(result.ok).toBe(false);
    expect(result.nextCommands[1]).toContain("--resume --apply --yes");
    expect(dependencies.exits).toEqual([1]);
    expect(dependencies.createPort).not.toHaveBeenCalled();
  });

  it("refuses abandon without a sentinel in preview and apply before backup", async () => {
    for (const flags of [[], ["--apply", "--yes"]]) {
      const dependencies = fakeDependencies(inspection());
      const output = await run(["repair", "--abandon", ...flags, "--json"], dependencies);
      expect(JSON.parse(output.stdout)).toMatchObject({
        ok: false,
        backup: null,
        error: { message: expect.stringContaining("No embedder migration sentinel") },
      });
      expect(dependencies.createPort).not.toHaveBeenCalled();
    }
  });

  it.each(["refused", "unsupported", "unknown"] as const)(
    "refuses %s abandon in preview and apply without advertising abandon apply",
    async (classification) => {
      for (const flags of [[], ["--apply", "--yes"]]) {
        const dependencies = fakeDependencies(migrationInspection(classification));
        const output = await run(["repair", "--abandon", ...flags, "--json"], dependencies);
        const result = JSON.parse(output.stdout);
        expect(result).toMatchObject({
          ok: false,
          backup: null,
          error: { message: expect.stringContaining(classification) },
        });
        expect(result.nextCommands).toEqual([
          expect.stringContaining("--resume"),
          expect.stringContaining("--resume --apply --yes"),
        ]);
        expect(result.nextCommands.join(" ")).not.toContain("--abandon");
        expect(dependencies.createPort).not.toHaveBeenCalled();
      }
    },
  );

  it("uses exact resume commands when sentinel provider preflight fails", async () => {
    const dependencies = fakeDependencies(migrationInspection("safe"));
    vi.mocked(dependencies.instantiate).mockRejectedValueOnce(new Error("provider unavailable"));

    const output = await run(["repair", "--resume", "--json"], dependencies);
    const result = JSON.parse(output.stdout);
    expect(result).toMatchObject({
      ok: false,
      provider: { loadStatus: "unavailable" },
      backup: null,
    });
    expect(result.nextCommands).toEqual([
      expect.stringContaining("--resume"),
      expect.stringContaining("--resume --apply --yes"),
    ]);
    expect(result.nextCommands.join(" ")).not.toContain("--target");
    expect(dependencies.createPort).not.toHaveBeenCalled();
  });

  it("fails provider preflight before opening a port or creating a backup", async () => {
    const dependencies = fakeDependencies(inspection({ assessment: "unsafe" }));
    vi.mocked(dependencies.instantiate).mockRejectedValueOnce(new Error("unsupported hashing tokenizer version 99"));
    const output = await run(["repair", "--target", "hashing:dim=256:tok=99", "--apply", "--yes", "--json"], dependencies);
    expect(JSON.parse(output.stdout)).toMatchObject({
      ok: false,
      provider: { loadStatus: "unavailable", reason: "unsupported hashing tokenizer version 99" },
      backup: null,
    });
    expect(dependencies.createPort).not.toHaveBeenCalled();
  });

  it("retains and reports a verified backup when the post-backup operation fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-repair-failure-"));
    dirs.push(dir);
    const state = inspection({ dbPath: join(dir, "monet.db"), assessment: "unsafe" });
    const dependencies = fakeDependencies(state);
    vi.mocked(dependencies.inspect)
      .mockReturnValueOnce(state)
      .mockImplementationOnce(() => { throw new Error("retry inspection unavailable"); });
    const backup = {
      sourcePath: state.dbPath,
      path: "/tmp/retained-backup.db",
      createdAt: 1,
      bytes: 42,
      quickCheck: "ok" as const,
    };
    const close = vi.fn();
    dependencies.createPort = vi.fn(() => ({
      createVerifiedBackup: vi.fn(async () => backup),
      close,
    } as unknown as BetterSqlitePort));
    dependencies.createCore = vi.fn(() => { throw new Error("schema migration failed"); });

    const output = await run(["repair", "--target", "hashing", "--apply", "--yes", "--json"], dependencies);
    const result = JSON.parse(output.stdout);
    expect(result).toMatchObject({
      ok: false,
      backup,
      error: { message: expect.stringContaining("Retry-state inspection also failed") },
    });
    expect(result.nextCommands.slice(0, 2)).toEqual([
      expect.stringContaining("--resume"),
      expect.stringContaining("--resume --apply --yes"),
    ]);
    expect(result.nextCommands.join(" ")).not.toContain("--target");
    expect(output.stderr).toContain(`backup: ${backup.path}`);
    expect(close).toHaveBeenCalledOnce();
  });

  it("reinspects after a target failure, retains the backup, and switches guidance to the durable sentinel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-repair-sentinel-failure-"));
    dirs.push(dir);
    const dbPath = join(dir, "monet.db");
    const initial = inspection({
      dbPath,
      assessment: "safe",
      pin: { status: "known", modelId: "hashing:dim=256:tok=1", source: "created", pinnedAt: 1 },
      populations: {
        nativeObservations: { ...knownPopulation(), liveRowCount: 1, scoredVectorCount: 1, dimensions: [256] },
        nativeConcepts: knownPopulation(),
        sourceObservations: knownPopulation(),
        sourceConcepts: knownPopulation(),
      },
    });
    const stamped = migrationInspection("refused");
    stamped.dbPath = dbPath;
    const dependencies = fakeDependencies(initial);
    vi.mocked(dependencies.inspect).mockReturnValueOnce(initial).mockReturnValueOnce(stamped);
    const backup = {
      sourcePath: dbPath,
      path: join(dir, "backups", "verified.db"),
      createdAt: 1,
      bytes: 42,
      quickCheck: "ok" as const,
    };
    dependencies.createPort = vi.fn(() => ({
      createVerifiedBackup: vi.fn(async () => backup),
      close: vi.fn(),
    } as unknown as BetterSqlitePort));
    dependencies.createCore = vi.fn(() => ({
      migrateEmbeddings: vi.fn(async () => { throw new Error("mid-migration failure"); }),
      close: vi.fn(),
    } as unknown as MonetCore));

    const output = await run(["repair", "--target", "hashing", "--apply", "--yes", "--json"], dependencies);
    const result = JSON.parse(output.stdout);
    expect(result).toMatchObject({
      ok: false,
      backup,
      migration: { status: "active", targetModelId: "hashing:dim=256:tok=2" },
      error: { message: "mid-migration failure" },
    });
    expect(result.nextCommands).toEqual([
      expect.stringContaining("--resume"),
      expect.stringContaining("--resume --apply --yes"),
    ]);
    expect(result.nextCommands.join(" ")).not.toContain("--target");
    expect(dependencies.inspect).toHaveBeenCalledTimes(2);
  });

  it("reports lock or backup failure before constructing core and without claiming a backup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-repair-lock-"));
    dirs.push(dir);
    const state = inspection({ dbPath: join(dir, "monet.db"), assessment: "unsafe" });
    const dependencies = fakeDependencies(state);
    const close = vi.fn();
    dependencies.createPort = vi.fn(() => ({
      createVerifiedBackup: vi.fn(async () => { throw new Error("exclusive ownership unavailable"); }),
      close,
    } as unknown as BetterSqlitePort));

    const output = await run(["repair", "--target", "hashing", "--apply", "--yes", "--json"], dependencies);
    expect(JSON.parse(output.stdout)).toMatchObject({
      ok: false,
      error: { message: "exclusive ownership unavailable" },
      backup: null,
    });
    expect(dependencies.createCore).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(existsSync(join(dir, "backups"))).toBe(true);
  });

  it("retains backup context when post-repair diagnosis fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-repair-postcheck-"));
    dirs.push(dir);
    const state = inspection({ dbPath: join(dir, "monet.db"), assessment: "unsafe" });
    const dependencies = fakeDependencies(state);
    const backup = {
      sourcePath: state.dbPath,
      path: join(dir, "backups", "verified.db"),
      createdAt: 1,
      bytes: 42,
      quickCheck: "ok" as const,
    };
    vi.mocked(dependencies.inspect)
      .mockReturnValueOnce(state)
      .mockImplementationOnce(() => { throw new Error("postcheck unavailable"); });
    dependencies.createPort = vi.fn(() => ({
      createVerifiedBackup: vi.fn(async () => backup),
      close: vi.fn(),
    } as unknown as BetterSqlitePort));
    dependencies.createCore = vi.fn(() => ({
      migrateEmbeddings: vi.fn(async () => ({ targetModelId: "hashing:dim=256:tok=2", failures: [] })),
      close: vi.fn(),
    } as unknown as MonetCore));

    const output = await run(["repair", "--target", "hashing", "--apply", "--yes", "--json"], dependencies);
    const result = JSON.parse(output.stdout);
    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("post-repair diagnosis failed") },
      backup,
      assessment: "unsafe",
    });
    expect(result.nextCommands.join(" ")).not.toContain("--target");
    expect(result.nextCommands).toEqual([
      expect.stringContaining("monet doctor"),
      expect.stringContaining("--resume"),
      expect.stringContaining("--resume --apply --yes"),
    ]);
  });

  it("migrates a real store only after a verified backup and converges on retry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-repair-cli-"));
    dirs.push(dir);
    const dbPath = join(dir, "monet.db");
    const seed = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 1) });
    await seed.store("real recovery fixture", { resolution: "forceNew" });
    seed.close();

    const exits: number[] = [];
    const dependencies: RecoveryCliDependencies = {
      ...defaultRecoveryDependencies(),
      dbPath: () => dbPath,
      now: () => new Date("2026-07-22T01:02:03.004Z"),
      uuid: () => "12345678-1234-1234-1234-123456789abc",
      setExitCode: (code) => exits.push(code),
    };
    const output = await run(["repair", "--target", "hashing", "--apply", "--yes", "--json"], dependencies);
    const result = JSON.parse(output.stdout);
    expect(result).toMatchObject({ ok: true, applied: true, provider: { loadStatus: "available" } });
    expect(result.backup.path).toContain("monet-before-repair-20260722T010203004Z-12345678");
    expect(existsSync(result.backup.path)).toBe(true);
    expect(inspectStoredEmbedderState(dbPath).pin).toMatchObject({ modelId: "hashing:dim=256:tok=2" });
    expect(inspectStoredEmbedderState(result.backup.path).pin).toMatchObject({ modelId: "hashing:dim=256:tok=1" });
    expect(exits).toEqual([]);

    const retryPreview = await run(["repair", "--target", "hashing", "--json"], dependencies);
    expect(JSON.parse(retryPreview.stdout)).toMatchObject({
      ok: true,
      applied: false,
      nextCommands: [],
      backup: null,
      report: { action: "none", repairRequired: false, backupRequiredOnApply: false },
    });
    const retry = await run(["repair", "--target", "hashing", "--apply", "--yes", "--json"], dependencies);
    expect(JSON.parse(retry.stdout)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("already compatible") },
      nextCommands: [],
      backup: null,
    });
    expect(exits).toEqual([1]);
  });

  it("resumes the exact sentinel target and safely abandons only through core", async () => {
    const makeSentinel = async () => {
      const dir = mkdtempSync(join(tmpdir(), "monet-repair-sentinel-"));
      dirs.push(dir);
      const dbPath = join(dir, "monet.db");
      const seed = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 1) });
      await seed.store("sentinel fixture", { resolution: "forceNew" });
      seed.close();
      const raw = new Database(dbPath);
      raw.prepare(
        `INSERT INTO embedder_migration
          (singleton, target_model_id, started_at, prior_model_id, prior_pin_source, prior_pinned_at, prior_pin_captured, vectors_rewritten)
         VALUES (1, ?, 123, ?, 'created', 100, 1, 0)`,
      ).run("hashing:dim=256:tok=2", "hashing:dim=256:tok=1");
      raw.prepare(
        `UPDATE sync_meta SET embedder_model_id = ?, embedder_pin_source = 'migrated', embedder_pinned_at = 123 WHERE singleton = 1`,
      ).run("hashing:dim=256:tok=2");
      raw.close();
      return dbPath;
    };

    const resumePath = await makeSentinel();
    const resumeDeps: RecoveryCliDependencies = {
      ...defaultRecoveryDependencies(),
      dbPath: () => resumePath,
      now: () => new Date("2026-07-22T01:02:03.004Z"),
      uuid: () => "11111111-1111-1111-1111-111111111111",
      setExitCode: vi.fn(),
    };
    const resumed = await run(["repair", "--resume", "--apply", "--yes", "--json"], resumeDeps);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ ok: true, mode: "resume" });
    expect(inspectStoredEmbedderState(resumePath).migration).toEqual({ status: "none" });

    const abandonPath = await makeSentinel();
    const abandonDeps: RecoveryCliDependencies = {
      ...defaultRecoveryDependencies(),
      dbPath: () => abandonPath,
      now: () => new Date("2026-07-22T01:02:03.004Z"),
      uuid: () => "22222222-2222-2222-2222-222222222222",
      setExitCode: vi.fn(),
    };
    const abandonPreview = await run(["repair", "--abandon", "--json"], abandonDeps);
    expect(JSON.parse(abandonPreview.stdout)).toMatchObject({
      ok: true,
      applied: false,
      report: { action: "abandon", repairRequired: true, backupRequiredOnApply: true },
      backup: null,
    });
    expect(existsSync(join(dirname(abandonPath), "backups"))).toBe(false);
    const abandoned = await run(["repair", "--abandon", "--apply", "--yes", "--json"], abandonDeps);
    expect(JSON.parse(abandoned.stdout)).toMatchObject({
      ok: true,
      mode: "abandon",
      report: { action: "abandon", status: "completed" },
    });
    const after = inspectStoredEmbedderState(abandonPath);
    expect(after.migration).toEqual({ status: "none" });
    expect(after.pin).toMatchObject({ modelId: "hashing:dim=256:tok=1" });
  });
});
