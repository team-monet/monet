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
    },
    migration: { status: "none" },
    nonLatin: { status: "known", tolerance: 0.2, observationCount: 0, conceptCount: 0, sampleIds: [] },
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
    const result = JSON.parse(output.stdout);
    expect(result.provider).toMatchObject({
      loadStatus: "unavailable",
      reason: "provider cache unavailable",
    });
    expect(result.nextCommands).toEqual([
      `monet doctor --dir '/tmp/monet test/store'"'"'s dir' --check-provider`,
      `monet repair --dir '/tmp/monet test/store'"'"'s dir' --target 'hashing:dim=256:tok=2'`,
      `monet repair --dir '/tmp/monet test/store'"'"'s dir' --target 'hashing'`,
      `monet repair --dir '/tmp/monet test/store'"'"'s dir' --target 'onnx'`,
    ]);
    expect(unavailable.exits).toEqual([2]);
  });

  it("treats a healthy unpinned store as having no exact provider to check", async () => {
    const state = inspection({ pin: { status: "known", modelId: null, source: null, pinnedAt: null } });
    const dependencies = fakeDependencies(state);

    const output = await run(["doctor", "--check-provider", "--json"], dependencies);

    expect(JSON.parse(output.stdout)).toMatchObject({
      ok: true,
      assessment: "safe",
      provider: {
        loadStatus: "not-checked",
        reason: "The store has no durable embedder pin, so there is no exact provider to check.",
      },
      nextCommands: [],
    });
    expect(dependencies.instantiate).not.toHaveBeenCalled();
    expect(dependencies.exits).toEqual([]);
  });

  it("explains an inapplicable provider check in human output", async () => {
    const state = inspection({ pin: { status: "known", modelId: null, source: null, pinnedAt: null } });
    const dependencies = fakeDependencies(state);

    const output = await run(["doctor", "--check-provider"], dependencies);

    expect(output.stdout).toContain(
      "Provider:   not checked: The store has no durable embedder pin, so there is no exact provider to check.",
    );
    expect(output.stdout).not.toContain("use --check-provider");
    expect(dependencies.instantiate).not.toHaveBeenCalled();
    expect(dependencies.exits).toEqual([]);
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
    expect(JSON.parse(incompatibleOutput.stdout).nextCommands).toEqual([
      `monet doctor --dir '/tmp/monet test/store'"'"'s dir' --check-provider`,
      `monet repair --dir '/tmp/monet test/store'"'"'s dir' --target 'acme/custom-embedding'`,
    ]);
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

/**
 * A TARGET THAT SELECTS NO PROFILE IS AN UNKNOWN, NOT AN EXACT MODEL ID (#15).
 *
 * `resolveTargetAlias` passes anything it does not special-case straight through, and nothing
 * downstream consulted the profile registry — so an unregistered id that happened to load rewrote
 * every vector, pinned the store to a space no profile describes, and exited 0. The declared width
 * never caught it (instantiateEmbedderForPin measures the warmup vector and adopts its real width
 * by design) and neither did the identity check.
 *
 * The middle case is the one that matters and the one that was missing: not a blank target and not
 * a known one, but a PLAUSIBLE unknown — the shape an operator actually types.
 */
describe("repair --target refuses a space this build does not describe", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const seedStore = async (label: string, pinnedTo = 1): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), `monet-target-gate-${label}-`));
    dirs.push(dir);
    const dbPath = join(dir, "monet.db");
    const seed = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, pinnedTo) });
    await seed.store("an entirely english observation", { resolution: "forceNew" });
    seed.close();
    return dbPath;
  };

  /** Stands in for "the unregistered id happens to be loadable", issue #15's shape (b) condition. */
  const loadableDeps = (dbPath: string, exits: number[]): RecoveryCliDependencies => ({
    ...defaultRecoveryDependencies(),
    dbPath: () => dbPath,
    instantiate: async (modelId: string) => ({
      dim: 256,
      modelId,
      embed: () => new Float32Array(256).fill(0.1),
    }),
    now: () => new Date("2026-07-22T01:02:03.004Z"),
    uuid: () => "12345678-1234-1234-1234-123456789abc",
    setExitCode: (code) => exits.push(code),
  });

  it("refuses a plausible-but-unknown model id BEFORE loading a provider or taking a backup", async () => {
    const dbPath = await seedStore("unknown");
    const exits: number[] = [];
    const output = await run(
      ["repair", "--target", "Xenova/bge-small-en-v1.5-quant", "--apply", "--yes", "--json"],
      loadableDeps(dbPath, exits),
    );
    const result = JSON.parse(output.stdout);

    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("names no embedding space this build describes");
    // The message an operator needed and did not get: shape (a) sent one to diagnose a VPN.
    expect(result.error.message).toContain("NOT a download or network condition");
    expect(result.error.message).toContain("Xenova/bge-m3:cls:q8");
    // Refused early enough that nothing was loaded and nothing was written.
    expect(result.provider).toEqual({ loadStatus: "not-checked" });
    expect(result.backup).toBeNull();
    expect(existsSync(join(dirname(dbPath), "backups"))).toBe(false);
    expect(inspectStoredEmbedderState(dbPath).pin).toMatchObject({ modelId: "hashing:dim=256:tok=1" });
    expect(exits).toEqual([1]);
  });

  it("refuses in PREVIEW too — the preview is what an operator reads before committing", async () => {
    const dbPath = await seedStore("preview");
    const exits: number[] = [];
    const output = await run(["repair", "--target", "acme/not-a-real-model", "--json"], loadableDeps(dbPath, exits));
    expect(JSON.parse(output.stdout).error.message).toContain("names no embedding space this build describes");
    expect(exits).toEqual([1]);
  });

  it("still accepts a registered profile id and a canonical hashing pin", async () => {
    // The gate must not be a blanket refusal: both of these name a fully described space.
    const dbPath = await seedStore("known");
    const exits: number[] = [];
    const profile = await run(
      ["repair", "--target", "Xenova/bge-small-en-v1.5", "--json"],
      loadableDeps(dbPath, exits),
    );
    expect(JSON.parse(profile.stdout)).toMatchObject({ ok: true, report: { targetModelId: "Xenova/bge-small-en-v1.5" } });

    const hashing = await run(["repair", "--target", "hashing:dim=256:tok=2", "--json"], loadableDeps(dbPath, exits));
    expect(JSON.parse(hashing.stdout)).toMatchObject({ ok: true, report: { targetModelId: "hashing:dim=256:tok=2" } });
    expect(exits).toEqual([]);
  });

  it("accepts the store's OWN pin even when no profile describes it — that mints nothing", async () => {
    /*
     * `nextCommandsForInspection` emits `--target <the store's current pin>` as recovery advice
     * whenever the pinned provider needs action. A gate keyed on the registry alone would make that
     * shipped command unrunnable for every store pinned outside it — a legacy hand-pin, or a local
     * model path, both of which instantiateEmbedderForPin still loads on purpose. Re-targeting the
     * pin a store already carries does not move it into an undescribed space; it is already there.
     */
    const dbPath = await seedStore("selfpin");
    const raw = new Database(dbPath);
    raw.prepare(`UPDATE sync_meta SET embedder_model_id = ? WHERE singleton = 1`).run("/opt/models/local-thing");
    raw.close();

    const exits: number[] = [];
    const output = await run(
      ["repair", "--target", "/opt/models/local-thing", "--json"],
      loadableDeps(dbPath, exits),
    );
    const result = JSON.parse(output.stdout);
    // Past the gate: it reached provider preflight, which is what the gate must not prevent here.
    expect(result.provider).toMatchObject({ loadStatus: "available", modelId: "/opt/models/local-thing" });
    expect(JSON.stringify(result.error ?? "")).not.toContain("names no embedding space");
  });
});

/**
 * THE POST-BACKUP RECHECK MUST READ THROUGH THE CONNECTION THAT HOLDS THE STORE (#14).
 *
 * `applyRepair` re-reads the non-English count after `createVerifiedBackup` has taken exclusive
 * ownership, so a row written between preflight and the rewrite cannot wave through a one-way
 * migration. It did that by calling `dependencies.inspect`, which opens its own handle — excluded
 * by this process's own lock, failing SQLITE_BUSY after the full 5s busy timeout and surfacing as
 * `(locked): database is locked`, which reads as contention with something else.
 *
 * Every English-only target failed, deterministically, with one way past: `--accept-non-latin-loss`,
 * which works only because it stops the recheck being constructed at all. The sole workaround was
 * to switch off the data-loss guard.
 *
 * The middle case here is a store whose content is ENTIRELY LATIN — the recheck runs, finds nothing,
 * and must let the migration proceed. Normal (a multilingual target) never builds the closure, and
 * absent (--accept-non-latin-loss) never runs it; neither can exhibit this at all.
 */
describe("repair completes on an English-only target without self-deadlocking", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const ENGLISH_ONLY_TARGET = "Xenova/bge-small-en-v1.5";
  const KOREAN = "게더를 제거하고 검색만 남기기로 했다. 오늘 측정이 그 결정을 뒷받침한다.";

  /**
   * Only `instantiate` is faked, and only to declare `readsOnlyLatinScript`. That flag is the whole
   * of what the real bge-small profile contributes to this chain; the port, the backup, the
   * exclusive ownership, the recheck's read and the migration are all real.
   */
  const englishOnlyDeps = (dbPath: string, exits: number[]): RecoveryCliDependencies => ({
    ...defaultRecoveryDependencies(),
    dbPath: () => dbPath,
    instantiate: async (modelId: string) => ({
      dim: 256,
      modelId,
      readsOnlyLatinScript: true,
      embed: () => new Float32Array(256).fill(0.1),
    }),
    now: () => new Date("2026-07-22T01:02:03.004Z"),
    uuid: () => "12345678-1234-1234-1234-123456789abc",
    setExitCode: (code) => exits.push(code),
  });

  const seedStore = async (label: string, texts: string[]): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), `monet-english-only-${label}-`));
    dirs.push(dir);
    const dbPath = join(dir, "monet.db");
    const seed = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 1) });
    for (const text of texts) await seed.store(text, { resolution: "forceNew" });
    seed.close();
    return dbPath;
  };

  it("migrates an all-Latin store to an English-only target instead of blocking on its own lock", async () => {
    const dbPath = await seedStore("latin", ["an entirely english observation"]);
    const exits: number[] = [];

    const startedAt = Date.now();
    const output = await run(
      ["repair", "--target", ENGLISH_ONLY_TARGET, "--apply", "--yes", "--json"],
      englishOnlyDeps(dbPath, exits),
    );
    const elapsedMs = Date.now() - startedAt;
    const result = JSON.parse(output.stdout);

    expect(result).toMatchObject({ ok: true, applied: true, report: { targetModelId: ENGLISH_ONLY_TARGET } });
    expect(inspectStoredEmbedderState(dbPath).pin).toMatchObject({ modelId: ENGLISH_ONLY_TARGET });
    expect(exits).toEqual([]);
    /*
     * The old failure was a 5s busy timeout, so a wall-clock bound is the assertion that
     * distinguishes "fixed" from "the lock happened not to bite this time". Deliberately loose —
     * this is a floor against the timeout, not a performance budget.
     */
    expect(elapsedMs).toBeLessThan(4_000);
  });

  it("STILL REFUSES when non-Latin rows are there — the recheck was fixed, not removed", async () => {
    /*
     * The guard has to be able to fire from its new reading position. A fix that merely stopped the
     * deadlock by dropping the check would pass the test above and leave the one-way rewrite
     * unguarded, which is worse than the deadlock it replaced.
     */
    const dbPath = await seedStore("korean", [KOREAN]);
    const exits: number[] = [];
    const output = await run(
      ["repair", "--target", ENGLISH_ONLY_TARGET, "--apply", "--yes", "--json"],
      englishOnlyDeps(dbPath, exits),
    );
    const result = JSON.parse(output.stdout);

    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("ENGLISH model");
    expect(result.error.message).toContain("ONE-WAY");
    expect(result.error.message).not.toContain("database is locked");
    // Refused at PREFLIGHT, before ownership is taken, so no backup was needed.
    expect(result.backup).toBeNull();
    expect(inspectStoredEmbedderState(dbPath).pin).toMatchObject({ modelId: "hashing:dim=256:tok=1" });
    expect(exits).toEqual([1]);
  });

  it("refuses from UNDER OWNERSHIP when the rows appear after preflight — the recheck's own reason to exist", async () => {
    /*
     * The preflight count is read before the provider loads. This drives the case it cannot see: an
     * all-Latin store at preflight, non-Latin content written before the rewrite. The recheck is
     * the only thing standing between that row and a one-way migration, and it now reads it through
     * the owning connection — the read the old code could not perform at all.
     */
    const dbPath = await seedStore("racing", ["an entirely english observation"]);
    const exits: number[] = [];
    const deps = englishOnlyDeps(dbPath, exits);
    const writeKoreanOnce = vi.fn(async (modelId: string) => {
      // Between preflight (which saw zero) and applyRepair's backup: exactly the window the
      // recheck exists for, produced here by writing during provider load.
      if (writeKoreanOnce.mock.calls.length === 1) {
        const writer = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 1) });
        await writer.store(KOREAN, { resolution: "forceNew" });
        writer.close();
      }
      return { dim: 256, modelId, readsOnlyLatinScript: true, embed: () => new Float32Array(256).fill(0.1) };
    });
    deps.instantiate = writeKoreanOnce;

    const output = await run(
      ["repair", "--target", ENGLISH_ONLY_TARGET, "--apply", "--yes", "--json"],
      deps,
    );
    const result = JSON.parse(output.stdout);

    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("appeared after preflight");
    expect(result.error.message).not.toContain("database is locked");
    // The backup was taken before the recheck ran, and is retained for the operator.
    expect(result.backup).not.toBeNull();
    expect(inspectStoredEmbedderState(dbPath).pin).toMatchObject({ modelId: "hashing:dim=256:tok=1" });
    expect(exits).toEqual([1]);
  });
});

/**
 * EVERY GUARD MUST BE ABLE TO FAIL.
 *
 * `resegment` is a recovery command that DELETEs and re-INSERTs segment rows in the operator's live
 * store. Each refusal below was a real Codex finding on PR #66, and each test asserts the thing the
 * unguarded code actually did — opened the port, or advertised a command that cannot run — so a
 * regression that removes the guard turns this file red rather than leaving it green.
 */
describe("resegment refuses before it writes", () => {
  const seg = (state: StoredEmbedderStateInspection) => {
    const deps = fakeDependencies(state);
    return { deps, go: () => run(["resegment", "--dir", "/tmp/monet test/store's dir"], deps) };
  };

  it("refuses a nonexistent store WITHOUT opening SQLite — opening it would create the file", async () => {
    const { deps, go } = seg(inspection({ exists: false }));
    await expect(go()).rejects.toThrow(/no Monet store at/);
    expect(deps.createPort).not.toHaveBeenCalled();
  });

  it("refuses a store whose integrity check FAILED, rather than mutating a corrupt database", async () => {
    const { deps, go } = seg(inspection({ integrity: { status: "failed", check: ["malformed page"] } }));
    await expect(go()).rejects.toThrow(/integrity result is failed.*refusing to rewrite segments/s);
    expect(deps.createPort).not.toHaveBeenCalled();
  });

  it("carries --dir into BOTH recovery commands — without it the operator repairs a different store", async () => {
    const { go } = seg(migrationInspection("safe"));
    await expect(go()).rejects.toThrow(
      /--resume --apply --yes`, or clear it with `monet repair --dir '\/tmp\/monet test\/store'"'"'s dir' --abandon/,
    );
  });

  it("offers --abandon only when inspection classified it safe — repair rejects every other class", async () => {
    const { go } = seg(migrationInspection("refused"));
    const error = (await go().catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/--resume --apply --yes`, then resegment/);
    expect(error.message).not.toMatch(/--abandon/);
  });

  it("does NOT offer --resume for an unreadable sentinel — ensureInspectableForRepair rejects it first", async () => {
    const { go } = seg(inspection({ migration: { status: "unknown", reason: "sentinel row unreadable" } }));
    const error = (await go().catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/could not be read \(sentinel row unreadable\)/);
    expect(error.message).toMatch(/diagnose with `monet doctor --dir/);
    expect(error.message).not.toMatch(/--resume/);
  });

  it("refuses when the pinned provider's width does not match the store's live vectors", async () => {
    // Pin name matches, so an identity-only check passes; the STORED width is 384 and the provider
    // that loads under that name declares 256. Writing segments would put two widths in one space.
    const { deps, go } = seg(customInspection("hashing:dim=256:tok=2"));
    await expect(go()).rejects.toThrow(/not proven compatible.*width 384.*declares width 256/s);
    expect(deps.createPort).not.toHaveBeenCalled();
  });

  it("refuses when the pinned provider cannot be loaded at all", async () => {
    const { deps, go } = seg(inspection());
    deps.instantiate = vi.fn(async () => { throw new Error("model cache empty"); });
    await expect(go()).rejects.toThrow(/could not be loaded \(model cache empty\).*refusing to rebuild/s);
    expect(deps.createPort).not.toHaveBeenCalled();
  });
});
