import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  BetterSqlitePort,
  HashingEmbeddingProvider,
  MonetCore,
  OnnxEmbeddingProvider,
  dropRetiredSourceResidue,
  isRetirementDisposed,
  inspectStoredEmbedderState,
  instantiateEmbedderForPin,
  purgeConnectorPopulation,
  readStartupFailure,
  retirementData,
  startupFailurePath,
  validateEmbeddingProviderOutput,
  type EmbeddingMigrationProgress,
  type EmbeddingMigrationReport,
  type EmbeddingProvider,
  type StartupFailureRead,
  type StoredEmbedderStateInspection,
  type VerifiedBackupResult,
} from "@team-monet/core";
import { getDbPath } from "./db/index.js";
import { resolveProjectDir } from "./project-dir.js";

const RECOVERY_SCHEMA = "monet.recovery.v1";
const PROBE_TEXT = "Monet embedding-provider recovery preflight";

export interface RecoveryCliDependencies {
  dbPath(storageDir?: string): string;
  inspect(dbPath: string): StoredEmbedderStateInspection;
  instantiate(modelId: string): Promise<EmbeddingProvider>;
  createPort(dbPath: string): BetterSqlitePort;
  createCore(port: BetterSqlitePort, embedder?: EmbeddingProvider): MonetCore;
  now(): Date;
  uuid(): string;
  setExitCode(code: number): void;
}

export interface ProviderResult {
  loadStatus: "not-checked" | "available" | "unavailable" | "incompatible";
  modelId?: string;
  dim?: number;
  reason?: string;
  storeCompatibility?: "compatible" | "unproven" | "incompatible";
  storeDimensions?: number[];
}

interface DoctorOptions {
  dir?: string;
  json?: boolean;
  checkProvider?: boolean;
}

interface RepairOptions {
  target?: string;
  resume?: boolean;
  abandon?: boolean;
  dir?: string;
  json?: boolean;
  apply?: boolean;
  yes?: boolean;
  /** Explicit acknowledgement that a Latin-only target will strand non-Latin rows. Not implied by --yes. */
  acceptNonLatinLoss?: boolean;
}

type RepairMode = "target" | "resume" | "abandon";

interface RepairFailureContext {
  dbPath: string;
  inspection?: StoredEmbedderStateInspection;
  assessment?: StoredEmbedderStateInspection["assessment"];
  provider?: ProviderResult;
  nextCommands?: string[];
  backup?: VerifiedBackupResult;
}

class RepairOperationError extends Error {
  constructor(message: string, readonly context: RepairFailureContext, options?: ErrorOptions) {
    super(message, options);
    this.name = "RepairOperationError";
  }
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function commandBase(dbPath: string): string {
  return `monet repair --dir ${shellQuote(path.dirname(dbPath))}`;
}

function doctorCommand(dbPath: string, checkProvider = false): string {
  return `monet doctor --dir ${shellQuote(path.dirname(dbPath))}${checkProvider ? " --check-provider" : ""}`;
}

function resumeCommand(dbPath: string, apply = false): string {
  return `${commandBase(dbPath)} --resume${apply ? " --apply --yes" : ""}`;
}

function abandonCommand(dbPath: string, apply = false): string {
  return `${commandBase(dbPath)} --abandon${apply ? " --apply --yes" : ""}`;
}

function targetCommand(dbPath: string, target: string, apply = false): string {
  return `${commandBase(dbPath)} --target ${shellQuote(target)}${apply ? " --apply --yes" : ""}`;
}

function hasStoredVectors(inspection: StoredEmbedderStateInspection): boolean {
  return Object.values(inspection.populations).some((population) =>
    population.status === "known" && (population.scoredVectorCount > 0 || population.malformed.count > 0),
  );
}

function isEmptyUnpinnedStore(inspection: StoredEmbedderStateInspection): boolean {
  if (inspection.pin.status !== "known" || inspection.pin.modelId !== null) return false;
  return Object.values(inspection.populations).every((population) =>
    population.status === "known" && population.liveRowCount === 0 && population.malformed.count === 0,
  );
}

function nextCommandsForInspection(
  inspection: StoredEmbedderStateInspection,
  assessment = inspection.assessment,
  provider: ProviderResult = { loadStatus: "not-checked" },
): string[] {
  const dbPath = inspection.dbPath;
  if (!inspection.exists) return [`monet start --dir ${shellQuote(path.dirname(dbPath))}`];
  if (inspection.migration.status === "active") {
    const commands = [resumeCommand(dbPath), resumeCommand(dbPath, true)];
    if (inspection.migration.abandon.classification === "safe") {
      commands.push(abandonCommand(dbPath), abandonCommand(dbPath, true));
    }
    return commands;
  }
  if (providerNeedsAction(provider) && inspection.pin.status === "known" && inspection.pin.modelId) {
    const commands = [doctorCommand(dbPath, true), targetCommand(dbPath, inspection.pin.modelId)];
    if (provider.loadStatus === "unavailable") {
      commands.push(targetCommand(dbPath, "hashing"), targetCommand(dbPath, "onnx"));
    }
    return [...new Set(commands)];
  }
  if (assessment === "safe") return [];
  if (inspection.pin.status === "known" && inspection.pin.modelId) {
    return [doctorCommand(dbPath, true), targetCommand(dbPath, inspection.pin.modelId)];
  }
  if (hasStoredVectors(inspection)) {
    return [targetCommand(dbPath, "onnx"), targetCommand(dbPath, "hashing")];
  }
  return [doctorCommand(dbPath, true)];
}

function providerNeedsAction(provider: ProviderResult): boolean {
  return provider.loadStatus === "unavailable" || provider.loadStatus === "incompatible";
}

interface ReconciledAssessment {
  assessment: StoredEmbedderStateInspection["assessment"];
  provider: ProviderResult;
}

function reconcileProviderWithStore(
  inspection: StoredEmbedderStateInspection,
  provider: ProviderResult,
): ReconciledAssessment {
  if (provider.loadStatus !== "available" || provider.modelId === undefined || provider.dim === undefined) {
    return { assessment: inspection.assessment, provider };
  }

  const unproven = (reason: string, storeDimensions: number[] = []): ReconciledAssessment => ({
    assessment: inspection.assessment,
    provider: { ...provider, storeCompatibility: "unproven", storeDimensions, reason },
  });
  if (!inspection.exists) return unproven("The store does not exist, so provider compatibility cannot be proven.");
  if (inspection.integrity.status !== "ok") return unproven("SQLite integrity is not clean.");
  if (inspection.schemaVersion !== inspection.supportedSchemaVersion) {
    return unproven("The store schema is not the current supported schema.");
  }
  if (inspection.migration.status !== "none") return unproven("An embedder migration sentinel is present or unknown.");
  if (inspection.pin.status !== "known" || inspection.pin.modelId !== provider.modelId) {
    return unproven("The provider identity does not match the exact durable store pin.");
  }

  const populations = Object.values(inspection.populations);
  if (populations.some((population) => population.status !== "known")) {
    return unproven("At least one live embedding population could not be inspected.");
  }
  const knownPopulations = populations.filter((population) => population.status === "known");
  if (knownPopulations.some((population) => population.malformed.count > 0)) {
    return unproven("Malformed embeddings prevent a compatibility proof.");
  }

  const nonempty = knownPopulations.filter((population) => population.liveRowCount > 0);
  const storeDimensions = [...new Set(nonempty.flatMap((population) => population.dimensions))].sort((a, b) => a - b);
  if (nonempty.length === 0) {
    return unproven("The store has no live embedding population from which to prove a vector width.", storeDimensions);
  }
  if (nonempty.some((population) => population.scoredVectorCount === 0 || population.dimensions.length !== 1)) {
    return unproven("Every nonempty live population must contribute one scored vector width; zero-only populations remain conservative.", storeDimensions);
  }
  if (storeDimensions.length !== 1) {
    return unproven("Live embedding populations do not share one uniform global width.", storeDimensions);
  }
  if (storeDimensions[0] !== provider.dim) {
    return {
      assessment: inspection.assessment,
      provider: {
        ...provider,
        loadStatus: "incompatible",
        storeCompatibility: "incompatible",
        storeDimensions,
        reason: `Stored vectors use width ${storeDimensions[0]}, but provider '${provider.modelId}' declares width ${provider.dim}.`,
      },
    };
  }
  return {
    assessment: inspection.assessment === "unknown" ? "safe" : inspection.assessment,
    provider: { ...provider, storeCompatibility: "compatible", storeDimensions },
  };
}

async function checkProvider(
  modelId: string | null,
  dependencies: RecoveryCliDependencies,
): Promise<{ result: ProviderResult; provider?: EmbeddingProvider }> {
  if (!modelId) {
    return {
      result: {
        loadStatus: "not-checked",
        reason: "The store has no durable embedder pin, so there is no exact provider to check.",
      },
    };
  }
  try {
    const provider = await dependencies.instantiate(modelId);
    if (typeof provider.modelId !== "string" || provider.modelId.trim().length === 0) {
      throw new Error("The selected provider has no stable model ID.");
    }
    if (provider.modelId !== modelId) {
      throw new Error(`The selected provider reports model ID '${provider.modelId}', not '${modelId}'.`);
    }
    const output = await provider.embed(PROBE_TEXT);
    validateEmbeddingProviderOutput(provider, output);
    return {
      provider,
      result: { loadStatus: "available", modelId: provider.modelId, dim: provider.dim },
    };
  } catch (error) {
    return {
      result: { loadStatus: "unavailable", modelId, reason: messageFrom(error) },
    };
  }
}

function resolveTargetAlias(target: string): string {
  const normalized = target.trim();
  if (normalized.length === 0) throw new Error("--target must be a nonblank exact model ID, 'onnx', or 'hashing'.");
  if (normalized === "onnx") {
    // `modelId` became optional in core#178: a provider whose pooling or dtype was overridden off its
    // profile produces vectors no id names, and reports no id rather than a wrong one. A DEFAULT
    // provider has no overrides, so this is not reachable today — but the alias resolves to a
    // MIGRATION TARGET, i.e. the string a store is about to be pinned to permanently, and the one
    // thing that must never happen here is "undefined" reaching that pin. Fail loudly instead.
    const target = new OnnxEmbeddingProvider().modelId;
    if (target === undefined) {
      throw new Error(
        "This build's default ONNX provider reports no model ID, so 'onnx' names no space to migrate " +
          "to. Pass an exact model ID as --target.",
      );
    }
    return target;
  }
  if (normalized === "hashing") return new HashingEmbeddingProvider().modelId;
  if (/^dim:/i.test(normalized)) {
    throw new Error("Dimension-only targets are ambiguous; use 'onnx', 'hashing', or an exact model ID.");
  }
  return normalized;
}

function integrityLabel(inspection: StoredEmbedderStateInspection): string {
  if (inspection.integrity.status === "ok") return "ok";
  if (inspection.integrity.status === "failed") return `failed (${inspection.integrity.check.join("; ")})`;
  return `unknown (${inspection.integrity.reason})`;
}

function pinLabel(inspection: StoredEmbedderStateInspection): string {
  if (inspection.pin.status === "unknown") return `unknown (${inspection.pin.reason})`;
  if (!inspection.pin.modelId) return "unpinned";
  return `${inspection.pin.modelId} (source: ${inspection.pin.source ?? "unknown"})`;
}

function migrationLabel(inspection: StoredEmbedderStateInspection): string {
  const migration = inspection.migration;
  if (migration.status === "none") return "none";
  if (migration.status === "unknown") return `unknown (${migration.reason})`;
  return `active -> ${migration.targetModelId}; rewrite ${migration.rewriteProgress}; abandon ${migration.abandon.classification}`;
}

/**
 * What a move to an ENGLISH-only model would strand, printed on every doctor run. The check itself
 * is a SCRIPT floor — it finds non-Latin script, so it under-counts by exactly the Latin-alphabet
 * languages the model also cannot read.
 *
 * Not gated on the CURRENT pin: the answer only helps before the move, and the rewrite is one-way
 * for content. Measured against the same tolerance the write gate enforces, so this cannot clear a
 * row the write path would refuse.
 */
function nonLatinLabel(inspection: StoredEmbedderStateInspection): string {
  const n = inspection.nonLatin;
  if (n.status === "unknown") return `unknown (${n.reason})`;
  if (n.observationCount === 0 && n.conceptCount === 0) {
    return "0 detected (note: only non-Latin SCRIPT is detectable — French or Vietnamese would not be counted)";
  }
  const samples = n.sampleIds.length > 0 ? `; e.g. ${n.sampleIds.join(", ")}` : "";
  // Listed, not summed: a concept body is derived from its observations, so one piece of non-English
  // content appears in both. A total would over-report what a rewrite actually has to touch.
  return `${n.observationCount} observation(s) and ${n.conceptCount} concept body/bodies ` +
    `not written in English${samples} ` +
    `(detected by script; text in another language using Latin letters is NOT counted)`;
}

function printInspection(
  inspection: StoredEmbedderStateInspection,
  assessment = inspection.assessment,
): void {
  console.log(`Database:   ${inspection.dbPath}`);
  console.log(`Exists:     ${inspection.exists ? "yes" : "no"}`);
  console.log(`Assessment: ${assessment}`);
  if (assessment !== inspection.assessment) console.log(`Raw safety: ${inspection.assessment} (reconciled with exact provider)`);
  console.log(`Schema:     ${inspection.schemaVersion ?? "none"} (supported: ${inspection.supportedSchemaVersion})`);
  console.log(`Integrity:  ${integrityLabel(inspection)}`);
  console.log(`Pin:        ${pinLabel(inspection)}`);
  console.log(`Migration:  ${migrationLabel(inspection)}`);
  console.log(`Non-English: ${nonLatinLabel(inspection)}`);
  console.log("Embedding populations:");
  for (const [name, population] of Object.entries(inspection.populations)) {
    if (population.status === "unknown") {
      console.log(`  ${name}: unknown (${population.reason})`);
    } else {
      const samples = population.malformed.sampleIds.length > 0
        ? `; malformed samples ${population.malformed.sampleIds.join(", ")}`
        : "";
      console.log(
        `  ${name}: rows ${population.liveRowCount}; vectors ${population.scoredVectorCount}; zero ${population.ignoredZeroVectorCount}; dimensions [${population.dimensions.join(", ")}]; malformed ${population.malformed.count}${samples}`,
      );
    }
  }
}

function printCommands(commands: string[]): void {
  if (commands.length === 0) return;
  console.log("Next commands:");
  for (const command of commands) console.log(`  ${command}`);
}

function printProvider(provider: ProviderResult): void {
  if (provider.loadStatus === "not-checked") {
    console.log(provider.reason
      ? `Provider:   not checked: ${provider.reason}`
      : "Provider:   not checked (use --check-provider)");
  } else if (provider.loadStatus === "available") {
    const compatibility = provider.storeCompatibility ? `; store ${provider.storeCompatibility}` : "";
    console.log(`Provider:   available (${provider.modelId}; ${provider.dim} dimensions${compatibility})`);
    if (provider.reason) console.log(`Provider evidence: ${provider.reason}`);
  } else {
    console.log(`Provider:   ${provider.loadStatus}${provider.modelId ? ` (${provider.modelId})` : ""}: ${provider.reason}`);
  }
}

/**
 * The last startup failure, if the store's directory holds one (#13).
 *
 * ON STDERR, NOT STDOUT, and before anything else runs. stdout carries the report (or the `--json`
 * document), and this must not enter either — the same reason the `store:` and `provider:` context
 * lines above it are on stderr. Printed BEFORE the inspection so it still appears when the store
 * itself cannot be read: an unreadable store is exactly the case where the last startup's own
 * account of what happened is the most useful thing `doctor` can say.
 *
 * SILENCE IS THE HEALTHY STATE. No record prints nothing at all. What is never silent is a record
 * that exists and cannot be parsed — that is reported as its own state, because a reader who is
 * told nothing concludes no startup ever failed.
 */
function printStartupFailure(read: StartupFailureRead, dbPath: string): void {
  if (read.status === "none") return;
  if (read.status === "unreadable") {
    console.error(`startup: ${startupFailurePath(dbPath)} exists but could not be read (${read.reason}).`);
    return;
  }
  const record = read.record;
  console.error(
    `startup: last recorded startup failure — ${record.at}, pid ${record.pid}, phase '${record.phase}': ` +
      `${record.error.name}${record.error.code ? ` [${record.error.code}]` : ""}: ${record.error.message}`,
  );
  // A later successful start deliberately does NOT clear the record (a host retries, and deleting
  // it would destroy the evidence of the attempts that failed), so the timestamp is what decides
  // whether this is the current problem. Say that here rather than letting a reader assume freshness.
  console.error(
    `startup: full record at ${startupFailurePath(dbPath)}; it is not cleared by a later ` +
      `successful start, so check the timestamp above before acting on it.`,
  );
}

function jsonDoctor(
  inspection: StoredEmbedderStateInspection,
  assessment: StoredEmbedderStateInspection["assessment"],
  provider: ProviderResult,
  nextCommands: string[],
  startupFailure: StartupFailureRead,
): Record<string, unknown> {
  return {
    schema: RECOVERY_SCHEMA,
    command: "doctor",
    ok: assessment === "safe" && !providerNeedsAction(provider),
    dbPath: inspection.dbPath,
    schemaVersion: inspection.schemaVersion,
    supportedSchemaVersion: inspection.supportedSchemaVersion,
    integrity: inspection.integrity,
    pin: inspection.pin,
    populations: inspection.populations,
    migration: inspection.migration,
    // What a move to an ENGLISH-only model would strand. Present whatever the current pin is, because
    // the answer is only useful BEFORE the move — the rewrite is one-way for content.
    nonLatin: inspection.nonLatin,
    assessment,
    rawAssessment: inspection.assessment,
    provider,
    // Three states, carried through verbatim: absent, unreadable, or the record. A machine reader
    // must be able to tell "no startup has failed" from "I could not tell" (#13).
    startupFailure,
    nextCommands,
  };
}

function jsonInspection(
  inspection: StoredEmbedderStateInspection,
  assessment = inspection.assessment,
): Record<string, unknown> {
  return {
    schemaVersion: inspection.schemaVersion,
    supportedSchemaVersion: inspection.supportedSchemaVersion,
    integrity: inspection.integrity,
    pin: inspection.pin,
    populations: inspection.populations,
    migration: inspection.migration,
    assessment,
    rawAssessment: inspection.assessment,
  };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

function inspectOrThrow(dbPath: string, dependencies: RecoveryCliDependencies): StoredEmbedderStateInspection {
  try {
    return dependencies.inspect(dbPath);
  } catch (error) {
    throw new RepairOperationError(messageFrom(error), { dbPath }, { cause: error });
  }
}

async function runDoctor(options: DoctorOptions, dependencies: RecoveryCliDependencies): Promise<void> {
  const dbPath = path.resolve(dependencies.dbPath(options.dir));
  console.error(`store: ${dbPath}`);
  // Keyed on the store being examined — this exact `dbPath`, not its directory and not a
  // re-resolved project dir. `--dir` makes those different stores, and the directory alone made
  // them the SAME record: core's dev server keeps `monet-core.db` in this very directory, and
  // reading by directory reported its failure as this store's (Codex round 1, PR #79). A record
  // from the wrong database is worse than no record at all.
  const startupFailure = readStartupFailure(dbPath);
  printStartupFailure(startupFailure, dbPath);
  try {
    const inspection = inspectOrThrow(dbPath, dependencies);
    let provider: ProviderResult = { loadStatus: "not-checked" };
    let assessment = inspection.assessment;
    if (options.checkProvider) {
      console.error("provider: checking stored embedder");
      const modelId = inspection.pin.status === "known" ? inspection.pin.modelId : null;
      const checked = await checkProvider(modelId, dependencies);
      const reconciled = reconcileProviderWithStore(inspection, checked.result);
      provider = reconciled.provider;
      assessment = reconciled.assessment;
    }
    const nextCommands = nextCommandsForInspection(inspection, assessment, provider);
    if (options.json) {
      printJson(jsonDoctor(inspection, assessment, provider, nextCommands, startupFailure));
    } else {
      console.log("Monet Doctor");
      console.log("------------");
      printInspection(inspection, assessment);
      printProvider(provider);
      printCommands(nextCommands);
    }
    if (assessment !== "safe" || providerNeedsAction(provider)) dependencies.setExitCode(2);
  } catch (error) {
    printRecoveryError("doctor", options.json ?? false, error, { dbPath });
    dependencies.setExitCode(1);
  }
}

function selectMode(options: RepairOptions): RepairMode {
  const selected = [options.target !== undefined, options.resume === true, options.abandon === true].filter(Boolean).length;
  if (selected !== 1) throw new Error("Choose exactly one repair mode: --target <model-id>, --resume, or --abandon.");
  if (options.apply && !options.yes) throw new Error("--apply requires --yes; repair never prompts interactively.");
  if (options.yes && !options.apply) throw new Error("--yes is valid only with --apply.");
  if (options.resume) return "resume";
  if (options.abandon) return "abandon";
  return "target";
}

function ensureInspectableForRepair(inspection: StoredEmbedderStateInspection): void {
  if (!inspection.exists) throw new Error("The Monet store does not exist; there is nothing to repair.");
  if (inspection.integrity.status !== "ok") {
    throw new Error(`The store integrity result is ${integrityLabel(inspection)}; refusing repair.`);
  }
  if (inspection.schemaVersion !== null && inspection.schemaVersion > inspection.supportedSchemaVersion) {
    throw new Error(
      `Store schema ${inspection.schemaVersion} is newer than supported schema ${inspection.supportedSchemaVersion}; refusing repair.`,
    );
  }
  if (inspection.pin.status === "unknown" || inspection.migration.status === "unknown") {
    throw new Error("The store's embedder state is unknown; refusing repair until diagnosis succeeds completely.");
  }
}

function backupPath(dbPath: string, now: Date, uuid: string): string {
  const timestamp = now.toISOString().replace(/[-:.]/g, "");
  return path.join(path.dirname(dbPath), "backups", `monet-before-repair-${timestamp}-${uuid}.db`);
}

function progressLine(event: EmbeddingMigrationProgress): string {
  const current = event.currentId ? ` ${event.currentId}` : "";
  return `repair: ${event.phase} ${event.completed}/${event.total} failed=${event.failed}${current}`;
}

async function applyRepair(
  mode: RepairMode,
  dbPath: string,
  inspection: StoredEmbedderStateInspection,
  targetModelId: string | undefined,
  provider: EmbeddingProvider | undefined,
  providerResult: ProviderResult,
  dependencies: RecoveryCliDependencies,
  recheckNonEnglish?: (fresh: StoredEmbedderStateInspection) => void,
): Promise<{ backup: VerifiedBackupResult; report: EmbeddingMigrationReport | { action: "abandon"; status: "completed" } }> {
  const destination = backupPath(dbPath, dependencies.now(), dependencies.uuid());
  mkdirSync(path.dirname(destination), { recursive: true });
  let port: BetterSqlitePort | undefined;
  let core: MonetCore | undefined;
  let backup: VerifiedBackupResult | undefined;
  let result: { backup: VerifiedBackupResult; report: EmbeddingMigrationReport | { action: "abandon"; status: "completed" } } | undefined;
  let operationError: unknown;
  try {
    port = dependencies.createPort(dbPath);
    backup = await port.createVerifiedBackup(destination);
    console.error(`backup: ${backup.path}`);
    // The backup is the point exclusive ownership exists. Anything that must be true of the store
    // AT REWRITE TIME, rather than at preflight, is checked here.
    if (recheckNonEnglish) recheckNonEnglish(dependencies.inspect(dbPath));
    core = dependencies.createCore(port, provider);
    if (mode === "abandon") {
      core.abandonEmbedderMigration();
      result = { backup, report: { action: "abandon", status: "completed" } };
    } else {
      const report = await core.migrateEmbeddings({
        targetModelId: targetModelId!,
        onProgress(event) {
          console.error(progressLine(event));
        },
      });
      /*
       * RE-SEGMENT AFTER THE REWRITE, IN THE SAME COMMAND.
       *
       * migrateEmbeddings DROPS observation_segments rather than re-embedding them, and says so at
       * the drop: re-embedding is async and that code runs inside a synchronous transaction. Its
       * stated remedy is "re-run the segment backfill", which is correct — and was unreachable for
       * anyone using the published package, because the backfill lives in a script in the PRIVATE
       * core repo. So the shipped path left a migrated store permanently at pre-#155 granularity:
       * retrieval stayed correct (the scorer falls back to the observation's own vector) but coarser,
       * and only observations written AFTER the migration got segments — two units in one store.
       *
       * Runs here rather than inside migrateEmbeddings because this is outside the transaction, which
       * is the whole reason the drop exists. Idempotent by protocol, so a re-run costs nothing.
       *
       * Failure is reported, not thrown: the migration itself has already committed and is correct.
       * Losing the resegment pass degrades granularity; losing the exit code would suggest the
       * embedder move failed, which would send an operator to restore a backup they do not need.
       */
      try {
        console.error("resegmenting observations in the new space…");
        const resegment = await core.resegmentObservations({
          onProgress(done, total) {
            if (done === total || done % 250 === 0) console.error(`  resegment: ${done}/${total} observations`);
          },
        });
        console.error(`resegment: ${resegment.observations} observations → ${resegment.segments} segments`);
      } catch (error) {
        console.error(
          `resegment FAILED after a successful embedder migration: ${messageFrom(error)}\n` +
          `The store is migrated and searchable, at pre-#155 granularity. Retry with ` +
          `\`monet resegment --dir ${shellQuote(path.dirname(dbPath))}\` — NOT this repair, which now refuses: ` +
          `--target is rejected because the store already matches it, and --resume is rejected because the ` +
          `migration sentinel is cleared. Carrying --dir matters: without it the retry would target the default ` +
          `project store, not this one (Codex P2, PR #66).`,
        );
      }
      result = { backup, report };
    }
  } catch (error) {
    operationError = error;
  }

  let closeError: unknown;
  try {
    if (core) core.close();
    else port?.close();
  } catch (error) {
    closeError = error;
  }
  if (operationError !== undefined || closeError !== undefined) {
    const causes = [operationError, closeError].filter((error) => error !== undefined);
    const cause = causes.length === 1 ? causes[0] : new AggregateError(causes);
    let message = operationError === undefined
      ? `Repair completed, but closing the database failed: ${messageFrom(closeError)}`
      : closeError === undefined
        ? messageFrom(operationError)
        : `${messageFrom(operationError)}; closing the repair database also failed: ${messageFrom(closeError)}`;
    let failureInspection = inspection;
    let nextCommands = mode === "target" && targetModelId
      ? [targetCommand(dbPath, targetModelId), targetCommand(dbPath, targetModelId, true)]
      : [resumeCommand(dbPath), resumeCommand(dbPath, true)];
    if (backup) {
      try {
        failureInspection = dependencies.inspect(dbPath);
        nextCommands = nextCommandsForInspection(failureInspection);
      } catch (error) {
        message += ` Retry-state inspection also failed: ${messageFrom(error)}`;
        // Once an owned repair reached the backup/core boundary, an unseen sentinel is possible.
        // Resume is the conservative retry; it will refuse safely if no sentinel was stamped.
        nextCommands = [resumeCommand(dbPath), resumeCommand(dbPath, true), doctorCommand(dbPath)];
      }
    }
    throw new RepairOperationError(message, {
      dbPath,
      inspection: failureInspection,
      provider: providerResult,
      nextCommands,
      ...(backup ? { backup } : {}),
    }, { cause });
  }
  return result!;
}

async function runRepair(options: RepairOptions, dependencies: RecoveryCliDependencies): Promise<void> {
  const dbPath = path.resolve(dependencies.dbPath(options.dir));
  console.error(`store: ${dbPath}`);
  let latestInspection: StoredEmbedderStateInspection | undefined;
  let latestProvider: ProviderResult | undefined;
  let latestNextCommands: string[] | undefined;
  let latestBackup: VerifiedBackupResult | undefined;
  try {
    const mode = selectMode(options);
    const inspection = inspectOrThrow(dbPath, dependencies);
    latestInspection = inspection;
    ensureInspectableForRepair(inspection);

    let targetModelId: string | undefined;
    if (mode === "target") targetModelId = resolveTargetAlias(options.target!);
    if (mode === "resume") {
      if (inspection.migration.status !== "active") {
        throw new RepairOperationError("No embedder migration sentinel is active; there is nothing to resume.", {
          dbPath,
          inspection,
          provider: { loadStatus: "not-checked" },
          nextCommands: [doctorCommand(dbPath)],
        });
      }
      targetModelId = inspection.migration.targetModelId;
    }

    if (mode === "target" && inspection.migration.status === "active") {
      const resume = resumeCommand(dbPath, true);
      throw new RepairOperationError(
        `An embedder migration to '${inspection.migration.targetModelId}' is already active. Resume the sentinel target instead.`,
        {
          dbPath,
          inspection,
          provider: { loadStatus: "not-checked" },
          nextCommands: [resumeCommand(dbPath), resume],
        },
      );
    }

    if (mode === "abandon") {
      if (inspection.migration.status !== "active") {
        throw new RepairOperationError("No embedder migration sentinel is active; there is nothing to abandon.", {
          dbPath,
          inspection,
          provider: { loadStatus: "not-checked" },
          nextCommands: [doctorCommand(dbPath)],
        });
      }
      if (inspection.migration.abandon.classification !== "safe") {
        throw new RepairOperationError(
          `The active migration cannot be safely abandoned (${inspection.migration.abandon.classification}): ${inspection.migration.abandon.reason}`,
          {
            dbPath,
            inspection,
            provider: { loadStatus: "not-checked" },
            nextCommands: [resumeCommand(dbPath), resumeCommand(dbPath, true)],
          },
        );
      }
    }

    let provider: EmbeddingProvider | undefined;
    let providerResult: ProviderResult = { loadStatus: "not-checked" };
    let loadedProviderResult = providerResult;
    let assessment = inspection.assessment;
    let noOpReason: string | undefined;
    latestProvider = providerResult;
    if (mode === "target" && isEmptyUnpinnedStore(inspection)) {
      noOpReason = "The store is empty and unpinned; no embedding repair is required.";
    }
    if (targetModelId && noOpReason === undefined) {
      console.error(`provider: preflighting ${targetModelId}`);
      const checked = await checkProvider(targetModelId, dependencies);
      provider = checked.provider;
      loadedProviderResult = checked.result;
      providerResult = loadedProviderResult;
      latestProvider = providerResult;
      if (!provider) {
        const providerCommands = mode === "resume"
          ? [resumeCommand(dbPath), resumeCommand(dbPath, true)]
          : [doctorCommand(dbPath, true), targetCommand(dbPath, targetModelId)];
        throw new RepairOperationError(`Provider '${targetModelId}' is unavailable: ${providerResult.reason}`, {
          dbPath,
          inspection,
          provider: providerResult,
          nextCommands: providerCommands,
        });
      }
      if (
        mode === "target"
        && inspection.pin.status === "known"
        && inspection.pin.modelId === targetModelId
      ) {
        const reconciled = reconcileProviderWithStore(inspection, loadedProviderResult);
        providerResult = reconciled.provider;
        assessment = reconciled.assessment;
        latestProvider = providerResult;
        if (assessment === "safe" && !providerNeedsAction(providerResult)) {
          noOpReason = `The store is already compatible with '${targetModelId}'; no embedding repair is required.`;
        }
      }
    }

    const nextCommands = noOpReason !== undefined
      ? []
      : mode === "abandon"
      ? [abandonCommand(dbPath, true), resumeCommand(dbPath)]
      : mode === "resume"
        ? [resumeCommand(dbPath), resumeCommand(dbPath, true)]
        : [targetCommand(dbPath, targetModelId!), targetCommand(dbPath, targetModelId!, true)];
    latestNextCommands = nextCommands;

    if (noOpReason !== undefined) {
      if (options.apply) {
        throw new RepairOperationError(`${noOpReason} Refusing a needless embedding rewrite.`, {
          dbPath,
          inspection,
          assessment,
          provider: providerResult,
          nextCommands,
        });
      }
      const report = {
        status: "preview",
        action: "none",
        targetModelId: targetModelId ?? null,
        repairRequired: false,
        reason: noOpReason,
        databaseMutation: false,
        backupRequiredOnApply: false,
      };
      if (options.json) {
        printJson({
          schema: RECOVERY_SCHEMA,
          command: "repair",
          ok: true,
          applied: false,
          mode,
          dbPath,
          ...jsonInspection(inspection, assessment),
          inspection,
          provider: providerResult,
          nextCommands,
          backup: null,
          report,
        });
      } else {
        console.log("Monet Repair Preview");
        console.log("--------------------");
        printInspection(inspection, assessment);
        printProvider(providerResult);
        console.log("Action:     none");
        console.log(`Reason:     ${noOpReason}`);
        console.log("Mutation:   none");
        console.log("Backup:     not required");
      }
      return;
    }

    if (!options.apply) {
      const report = {
        status: "preview",
        action: mode,
        targetModelId: targetModelId ?? null,
        repairRequired: true,
        databaseMutation: false,
        backupRequiredOnApply: true,
      };
      if (options.json) {
        printJson({
          schema: RECOVERY_SCHEMA,
          command: "repair",
          ok: true,
          applied: false,
          mode,
          dbPath,
          ...jsonInspection(inspection, assessment),
          inspection,
          provider: providerResult,
          nextCommands,
          backup: null,
          report,
        });
      } else {
        console.log("Monet Repair Preview");
        console.log("--------------------");
        printInspection(inspection, assessment);
        printProvider(providerResult);
        console.log(`Action:     ${mode}`);
        if (targetModelId) console.log(`Target:     ${targetModelId}`);
        console.log("Mutation:   none (preview only)");
        console.log("Backup:     required automatically by --apply --yes");
        printCommands(nextCommands);
      }
      return;
    }

    /*
     * REFUSE A ONE-WAY MOVE THAT STRANDS CONTENT.
     *
     * `--yes` confirms "apply without prompting"; it cannot stand in for a decision the operator was
     * never shown. Moving onto a Latin-only checkpoint rewrites every vector and cannot be undone,
     * and rows above the write gate's tolerance do not merely go quiet: measured on
     * bge-small-en-v1.5, unrelated Korean rows score 0.42-0.52 against English queries and take a
     * quarter of the top-5 slots — above the emission floor — while never being retrievable by their
     * own content. So the refusal names the count and requires an explicit second flag.
     *
     * Only fires when the TARGET declares the restriction and the store has something to lose. A
     * move onto a multilingual model is unaffected. The condition reads `readsOnlyLatinScript`
     * because that is what the provider declares today — the flag is misnamed for what these models
     * actually are, and that gap is why the message says the check is a floor.
     */
    /*
     * REFUSE A ONE-WAY MOVE THAT STRANDS CONTENT.
     *
     * `--yes` confirms "apply without prompting"; it cannot stand in for a decision the operator was
     * never shown. Moving onto an English checkpoint rewrites every vector and cannot be undone, and
     * the rows do not merely go quiet: measured on bge-small-en-v1.5, unrelated Korean rows score
     * 0.42-0.52 against English queries and take a quarter of the top-5 slots — above the emission
     * floor — while never being retrievable by their own content.
     *
     * The condition reads `readsOnlyLatinScript` because that is all a provider declares today. The
     * flag is misnamed for what these models are, which is why the message says the check is a floor.
     */
    const targetIsEnglishOnly = provider?.readsOnlyLatinScript === true;
    /*
     * RESUME COUNTS TOO (Codex P2). A sentinel created by an older client, or by an attempt that
     * failed before rewriting anything, carries rewriteProgress "not-started" — the operator never
     * saw this refusal, and resuming performs the same one-way rewrite. A migration already in
     * progress keeps its existing acknowledgement: refusing there would strand a half-rewritten
     * store, which is worse than the loss being re-confirmed.
     */
    const guardedMode =
      mode === "target" ||
      (mode === "resume" && inspection.migration.status === "active" && inspection.migration.rewriteProgress === "not-started");

    if (guardedMode && targetIsEnglishOnly && options.acceptNonLatinLoss !== true) {
      const n = inspection.nonLatin;
      /*
       * UNKNOWN IS NOT ZERO (Codex P1). The previous condition tested `status === "known" &&
       * observationCount > 0`, so a failed or unsupported content scan evaluated false and the
       * irreversible rewrite proceeded unacknowledged — fail-open at precisely the moment the client
       * cannot prove nothing will be stranded. A record must distinguish "not known" from a verdict.
       */
      if (n.status !== "known") {
        throw new RepairOperationError(
          `Refusing: the non-English content scan could not run (${n.reason}), and '${targetModelId}' is an ENGLISH ` +
            `model. This rewrite is ONE-WAY, so proceeding without knowing what it would strand is not something ` +
            `--yes can confirm. Fix the store so \`monet doctor\` can scan it, or pass --accept-non-latin-loss to ` +
            `proceed unverified.`,
          { dbPath, inspection, provider: providerResult, nextCommands },
        );
      }
      if (n.observationCount > 0 || n.conceptCount > 0) {
        throw new RepairOperationError(
          `Refusing: '${targetModelId}' is an ENGLISH model, and ${n.observationCount} observation(s) plus ` +
            `${n.conceptCount} concept body/bodies are not written in English. This rewrite is ONE-WAY — ` +
            `those rows keep their text, become ` +
            `unreachable by their own content, and still surface in unrelated results. Re-express them in ` +
            `English first (they stay addressable by id), or pass --accept-non-latin-loss to proceed ` +
            `knowing the cost. NOTE the check is a FLOOR: it detects non-Latin script only, so content ` +
            `written in French, Vietnamese or another Latin-alphabet language is not counted here and ` +
            `degrades the same way.` +
            (n.sampleIds.length > 0 ? ` Samples: ${n.sampleIds.join(", ")}.` : ""),
          { dbPath, inspection, provider: providerResult, nextCommands },
        );
      }
    }

    /*
     * RECHECK AFTER EXCLUSIVE OWNERSHIP (Codex P1).
     *
     * The count above was read before provider loading and probing — seconds during which another
     * Monet process can write a non-English observation into a live store. Exclusive SQLite
     * ownership is not taken until applyRepair creates its verified backup, so a stale zero could
     * wave through the one rewrite that cannot be undone. applyRepair re-reads the count under that
     * ownership and refuses there if it moved; this closure is how the decision reaches it without
     * duplicating the message.
     */
    const recheckNonEnglish = guardedMode && targetIsEnglishOnly && options.acceptNonLatinLoss !== true
      ? (fresh: StoredEmbedderStateInspection): void => {
          const n = fresh.nonLatin;
          if (n.status !== "known") {
            throw new Error(
              `the non-English content scan stopped working between preflight and the rewrite (${n.reason}). ` +
              `Refusing rather than proceeding blind on a one-way migration.`,
            );
          }
          if (n.observationCount > 0 || n.conceptCount > 0) {
            throw new Error(
              `${n.observationCount} observation(s) and ${n.conceptCount} concept body/bodies not written in English ` +
              `appeared after preflight and before the ` +
              `rewrite; another process is writing to this store. Re-run, or pass --accept-non-latin-loss.` +
              (n.sampleIds.length > 0 ? ` Samples: ${n.sampleIds.join(", ")}.` : ""),
            );
          }
        }
      : undefined;

    const result = await applyRepair(
      mode,
      dbPath,
      inspection,
      targetModelId,
      provider,
      providerResult,
      dependencies,
      recheckNonEnglish,
    );
    latestBackup = result.backup;
    let after: StoredEmbedderStateInspection;
    try {
      after = dependencies.inspect(dbPath);
    } catch (error) {
      throw new RepairOperationError(`Repair applied, but post-repair diagnosis failed: ${messageFrom(error)}`, {
        dbPath,
        inspection,
        provider: providerResult,
        nextCommands: [doctorCommand(dbPath), resumeCommand(dbPath), resumeCommand(dbPath, true)],
        backup: result.backup,
      }, { cause: error });
    }
    latestInspection = after;
    const afterReconciled = provider
      ? reconcileProviderWithStore(after, loadedProviderResult)
      : { assessment: after.assessment, provider: providerResult };
    providerResult = afterReconciled.provider;
    assessment = afterReconciled.assessment;
    latestProvider = providerResult;
    const afterCommands = nextCommandsForInspection(after, assessment);
    latestNextCommands = afterCommands;
    if (options.json) {
      printJson({
        schema: RECOVERY_SCHEMA,
        command: "repair",
        ok: true,
        applied: true,
        mode,
        dbPath,
        ...jsonInspection(after, assessment),
        inspection: after,
        provider: providerResult,
        nextCommands: afterCommands,
        backup: result.backup,
        report: result.report,
      });
    } else {
      console.log("Monet Repair Complete");
      console.log("---------------------");
      printInspection(after, assessment);
      console.log(`Backup:     ${result.backup.path}`);
      console.log(`Action:     ${mode}`);
      if (targetModelId) console.log(`Target:     ${targetModelId}`);
      printCommands(afterCommands);
    }
  } catch (error) {
    const contextual = error instanceof RepairOperationError
      ? error
      : new RepairOperationError(messageFrom(error), {
          dbPath,
          ...(latestInspection ? { inspection: latestInspection } : {}),
          ...(latestProvider ? { provider: latestProvider } : {}),
          ...(latestNextCommands ? { nextCommands: latestNextCommands } : {}),
          ...(latestBackup ? { backup: latestBackup } : {}),
        }, { cause: error });
    printRecoveryError("repair", options.json ?? false, contextual, { dbPath });
    dependencies.setExitCode(1);
  }
}

function printRecoveryError(
  command: "doctor" | "repair",
  json: boolean,
  error: unknown,
  fallback: RepairFailureContext,
): void {
  const context = error instanceof RepairOperationError ? error.context : fallback;
  const message = messageFrom(error);
  if (json) {
    printJson({
      schema: RECOVERY_SCHEMA,
      command,
      ok: false,
      dbPath: context.dbPath,
      ...(context.inspection ? jsonInspection(context.inspection) : {}),
      ...(context.assessment ? { assessment: context.assessment, rawAssessment: context.inspection?.assessment } : {}),
      error: { name: error instanceof Error ? error.name : "Error", message },
      inspection: context.inspection ?? null,
      provider: context.provider ?? { loadStatus: "not-checked" },
      nextCommands: context.nextCommands ?? [],
      backup: context.backup ?? null,
      report: null,
    });
  } else {
    console.error(`monet ${command}: ${message}`);
    console.error(`database: ${context.dbPath}`);
    if (context.inspection) {
      console.error(`assessment: ${context.assessment ?? context.inspection.assessment}`);
      console.error(`pin: ${pinLabel(context.inspection)}`);
      console.error(`migration: ${migrationLabel(context.inspection)}`);
    }
    if (context.provider?.loadStatus === "unavailable" || context.provider?.loadStatus === "incompatible") {
      console.error(`provider: ${context.provider.loadStatus}: ${context.provider.reason}`);
    }
    if (context.backup) console.error(`backup retained: ${context.backup.path}`);
    for (const next of context.nextCommands ?? []) console.error(`next: ${next}`);
  }
}

export function defaultRecoveryDependencies(): RecoveryCliDependencies {
  return {
    // P1-B/P2-D (Codex round 4 on PR #42): the ELSE branch (no explicit -d/--dir — doctor and
    // repair both have their own, checked FIRST via storageDir above) now roots at
    // resolveProjectDir(), NOT bare cwd — matching status/dashboard/source's own fix in cli.ts.
    // The storageDir-given branch already bypasses getDbPath/getMonetDir entirely (a direct
    // path.join), so it was never affected by this bug and needs no change here.
    dbPath(storageDir) {
      return storageDir ? path.join(path.resolve(storageDir), "monet.db") : path.resolve(getDbPath(resolveProjectDir()));
    },
    inspect: inspectStoredEmbedderState,
    instantiate: instantiateEmbedderForPin,
    createPort: (dbPath) => new BetterSqlitePort(dbPath),
    createCore: (port, embedder) => new MonetCore(port, {
      ...(embedder ? { embedder } : {}),
      deferCreatedPin: true,
    }),
    now: () => new Date(),
    uuid: randomUUID,
    setExitCode(code) {
      process.exitCode = code;
    },
  };
}

export function registerRecoveryCommands(
  program: Command,
  dependencies: RecoveryCliDependencies = defaultRecoveryDependencies(),
): Command {
  program
    .command("doctor")
    .description("Diagnose the stored embedder pin, vectors, migration state, and provider availability")
    .option("-d, --dir <storage-directory>", "Storage directory (default: .monet or ~/.monet)")
    .option("--json", "Print one stable JSON result object")
    .option("--check-provider", "Load and validate the exact provider recorded by the store")
    .action((options: DoctorOptions) => runDoctor(options, dependencies));

  program
    .command("repair")
    .description("Preview or apply a verified, backup-first embedder repair")
    .option("--target <onnx|hashing|exact-model-id>", "Rewrite all embeddings to this provider")
    .option("--resume", "Resume the exact target recorded by an active migration sentinel")
    .option("--abandon", "Safely abandon a not-yet-rewritten migration when core permits it")
    .option("-d, --dir <storage-directory>", "Storage directory (default: .monet or ~/.monet)")
    .option("--json", "Print one stable JSON result object")
    .option("--apply", "Apply the repair after provider preflight and verified backup")
    .option("--yes", "Confirm --apply noninteractively")
    .option("--accept-non-latin-loss", "Proceed onto an ENGLISH model knowing it strands non-Latin-script rows")
    .action((options: RepairOptions) => runRepair(options, dependencies));


  /*
   * WHY THIS IS ITS OWN COMMAND AND NOT A REPAIR FLAG.
   *
   * `repair` is about the embedding space: it preflights a provider and refuses outright when no
   * embedding repair is required — which is the state every store needing THIS operation is in.
   * The two also fail differently. A store holding connector rows cannot be opened as a MonetCore
   * at all (the engine's rung-13 migration refuses it), so this command works the port directly.
   *
   * BACKUP FIRST, ALWAYS. The purge is irreversible and there is nothing to re-sync from once the
   * connector is gone, so the verified backup is not a flag — it is the first thing that happens
   * after --apply, and a failure to take one aborts before a single row is touched.
   */
  program
    .command("retire-source")
    .description("Dispose of the retired source subsystem's rows after a verified backup (#16)")
    .option("-d, --dir <storage-directory>", "Storage directory (default: .monet or ~/.monet)")
    .option("--apply", "Delete the connector rows after taking a verified backup")
    .option("--yes", "Confirm --apply noninteractively")
    .action(async (options: { dir?: string; apply?: boolean; yes?: boolean }) => {
      if (options.apply && !options.yes) {
        throw new Error("--apply requires --yes; retire-source never prompts interactively.");
      }
      if (options.yes && !options.apply) throw new Error("--yes is valid only with --apply.");

      const dbPath = dependencies.dbPath(options.dir);
      console.error(`store: ${dbPath}`);
      // BEFORE createPort — opening SQLite CREATES the file, so a typo or stale --dir would leave an
      // empty store behind and report on it as if it were the operator's own.
      const inspection = dependencies.inspect(dbPath);
      if (!inspection.exists) {
        throw new Error(`no Monet store at ${dbPath} — check --dir, or run \`monet doctor\` to see what is there.`);
      }
      if (inspection.integrity.status !== "ok") {
        throw new Error(
          `the store integrity result is ${integrityLabel(inspection)}; refusing to delete rows in it. ` +
          `Restore from a backup, or run \`${doctorCommand(dbPath)}\` for the full report.`,
        );
      }
      // DOWNGRADE REFUSAL, BEFORE THE PORT IS EVEN OPENED — the same guard the repair path carries,
      // and this command needs it more: it decides what to delete from THIS build's ownership
      // predicate and dependency list. A newer schema may reference these rows from tables this
      // build cannot see, or give `kind='source'` a different meaning entirely, so proceeding would
      // delete valid data and strand what it could not name.
      if (inspection.schemaVersion !== null && inspection.schemaVersion > inspection.supportedSchemaVersion) {
        throw new Error(
          `store schema ${inspection.schemaVersion} is newer than supported schema ` +
          `${inspection.supportedSchemaVersion}; refusing to retire source rows from it. Upgrade Monet first.`,
        );
      }

      // ONE finally FOR EVERYTHING AFTER createPort(). The preflight below can refuse — an
      // unusable pin, a model that will not load, residue that turned out not to be empty — and
      // each of those throws is an EXPECTED outcome a programmatic caller may catch. Leaving the
      // port outside the cleanup leaked one SQLite connection per refused attempt.
      const port = dependencies.createPort(dbPath);
      let portClosed = false;
      const closePort = (): void => {
        if (!portClosed) { port.close(); portClosed = true; }
      };
      try {
      const data = retirementData(port);
      const counts = { concepts: data.conceptIds.length, observations: data.observationIds.length };

      if (isRetirementDisposed(data)) {
        // THE EMPTY RESIDUE IS DROPPED HERE OR NOWHERE. Rung 13 is a bare version bump — it does
        // not dispose of anything — so telling the operator "the next open will remove it" would
        // promise a migration that does not exist. With every table empty and both marker columns
        // null there is nothing to lose, which is why this needs no backup.
        if (options.apply) {
          // requireEmpty: the drop re-reads under its own write lock and refuses if data appeared
          // since the reading above, because THIS path deliberately takes no backup.
          dropRetiredSourceResidue(port, { requireEmpty: true });
          console.log("Nothing to retire: no connector-owned rows and no registry data.");
          console.log("Dropped the empty tables and marker columns the subsystem left behind.");
          return;
        }
        console.log("Nothing to retire: this store holds no connector-owned rows and no registry data.");
        console.log(`Its empty tables and marker columns are dropped by: ${commandBase(dbPath).replace(" repair", " retire-source")} --apply --yes`);
        return;
      }

      if (!options.apply) {
        console.log(`Connector-owned rows: ${counts.concepts} concept(s), ${counts.observations} observation(s).`);
        if (data.nonemptyTables.length > 0) {
          console.log(`Registry/ledger data:  ${data.nonemptyTables.join(", ")}`);
        }
        if (data.hybrids.length > 0) {
          console.log(`Left untouched:        ${data.hybrids.length} concept(s) holding both file content and your own writing.`);
        }
        console.log("These are a materialized copy of files outside the store, plus the registry describing");
        console.log("them. The subsystem that could read, re-sync, or repair them was retired (#16), so");
        console.log("deleting them is permanent.");
        console.log(`Backup:     taken automatically by --apply --yes`);
        console.log(`Apply with: ${commandBase(dbPath).replace(" repair", " retire-source")} --apply --yes`);
        return;
      }

      /*
       * THE EMBEDDER IS RESOLVED BEFORE ANYTHING IS DELETED, and that ordering is the fix.
       *
       * Purging a source observation owned by a NATIVE concept leaves that owner's projection
       * describing evidence that is gone, and repairing it runs the engine's real reprojection —
       * which asserts the store's pin. Opening the repair core without the pinned embedder gets
       * MonetCore's hashing default and fails that assert, by which point the purge and the
       * residue drop have committed and the affected ids exist only in memory: a re-run reports
       * nothing to retire and the stale projection can never be repaired. Loading it first turns
       * that unrecoverable state into a refusal that touches nothing.
       */
      {
        const destination = backupPath(dbPath, dependencies.now(), dependencies.uuid());
        mkdirSync(path.dirname(destination), { recursive: true });
        const backup = await port.createVerifiedBackup(destination);
        console.error(`backup: ${backup.path}`);
        const purged = purgeConnectorPopulation(port);
        // BEHIND THE BACKUP, AND ONLY HERE. The tables may still hold a registered source's
        // configuration and its attempt history, which a zero row count does not rule out — so the
        // drop belongs on this side of the backup, never in an ordinary open.
        dropRetiredSourceResidue(port);
        // READ WHILE OWNERSHIP IS STILL HELD. A migration on a shared store can move the pin the
        // moment this connection lets go, and the model chosen from a released-lock read is the
        // one `createCore` then rejects — after the purge has committed. Loading it can happen
        // later; choosing it cannot.
        /*
         * Read THROUGH the owning connection, not `inspect()`: that opens its own and would
         * deadlock against the exclusive ownership this one still holds.
         *
         * GUARDED, AND NEVER ALLOWED TO THROW. The backup, purge and residue drop have all
         * committed by this line, and a legacy store can predate `sync_meta` or its additive
         * `embedder_model_id` column — an unguarded query would exit here with the stale concept
         * ids unnamed, which is the one thing the late-loading design promises not to do. An
         * absent pin is a null, and null goes down the recoverable path below.
         */
        const readPinUnderOwnership = (): string | null => {
          const tables = port.prepare(`PRAGMA table_info(sync_meta)`).all() as Array<{ name: string }>;
          if (!tables.some((column) => column.name === "embedder_model_id")) return null;
          return (port.prepare(`SELECT embedder_model_id AS modelId FROM sync_meta WHERE singleton = 1`)
            .get() as { modelId: string | null } | undefined)?.modelId ?? null;
        };
        const pinUnderOwnership = purged.staleNativeOwners.length > 0 ? readPinUnderOwnership() : null;
        // Closed HERE, before the reprojection opens its own connection: the exclusive ownership
        // this port holds for the backup would otherwise block it.
        closePort();
        console.log(`Retired ${purged.concepts} concept(s) and ${purged.observations} observation(s).`);
        if (purged.hybrids.length > 0) {
          console.log(`Left untouched: ${purged.hybrids.length} concept(s) hold both file content and evidence you`);
          console.log("wrote yourself. Nothing about them was changed.");
          console.log("");
          console.log("To dispose of one, move your own observations to an EXISTING native concept —");
          console.log("`memory_detach` with a destConceptId — then re-run. Detaching without a");
          console.log("destination mints a new concept carrying the same kind, which lands you back");
          console.log("here with one more of them. Or leave them: this command keeps reporting them,");
          console.log("because something really is still there.");
        }
        if (data.nonemptyTables.length > 0) {
          console.log(`Dropped:  ${data.nonemptyTables.join(", ")} (and the rest of the retired schema).`);
        }

        // A NATIVE concept can own a source observation (grafting produces that shape), so deleting
        // the observation leaves its owner's support count, centroid and confidence describing
        // evidence that no longer exists. The engine owns that projection logic; the purge only
        // reports who needs it. Safe to open now — the population it would refuse is gone.
        /*
         * THE EMBEDDER IS LOADED HERE, and only if the purge actually produced work for it.
         *
         * Under this command's policy a connector concept is either deleted whole or left
         * untouched, so neither needs reprojection — the only owner that does is a NATIVE concept
         * that held a grafted source observation, and whether one exists is decided by the purge
         * under its own lock, not by a reading taken before it. Requiring the pin up front
         * therefore blocked disposal on stores that would never have used it: an unreadable model
         * cache was enough to make a store permanently unretirable.
         *
         * Loading late costs the guarantee that a failure happens before any delete. What replaces
         * it is that the failure is recoverable and says so: the backup is on disk and the ids that
         * still need repairing are named, which is exactly what an earlier version of this code
         * could not do when it lost them to a committed purge.
         */
        if (purged.staleNativeOwners.length > 0) {
          // THE WHOLE REPAIR IS INSIDE THE RECOVERY CATCH, construction included. A core built
          // against a pin that moved throws too, and outside this catch that throw would take the
          // concept ids with it — which is the failure this error exists to prevent.
          try {
            if (pinUnderOwnership === null) throw new Error("the store has no embedder pin");
            const embedder = await dependencies.instantiate(pinUnderOwnership);
            const core = dependencies.createCore(dependencies.createPort(dbPath), embedder);
            try {
              const repaired = core.repairNativeProjections(purged.staleNativeOwners);
              console.log(`Reprojected ${repaired} native concept(s) that owned a purged observation.`);
            } finally {
              core.close();
            }
          } catch (error) {
            throw new Error(
              `${purged.staleNativeOwners.length} concept(s) still need reprojection, and the ` +
              `store's pinned embedder could not be loaded ` +
              `(${error instanceof Error ? error.message : String(error)}). The purge is committed ` +
              `and the backup is at ${backup.path}. The concepts are: ` +
              `${purged.staleNativeOwners.join(", ")} — repair them once the model is available.`,
            );
          }
        }
        console.log(`Backup:   ${backup.path}`);
      }
      } finally {
        closePort();
      }
    });

  /*
   * WHY THIS IS ITS OWN COMMAND AND NOT A REPAIR FLAG.
   *
   * migrateEmbeddings drops observation_segments rather than re-embedding them — re-embedding is
   * async and that code runs inside a synchronous transaction — and its stated remedy is to re-run
   * the segment backfill. `repair --apply` now does that automatically after a migration it
   * performs. But `repair` REFUSES when the store is already on the target pin ("no embedding repair
   * is required"), which is exactly the state a store migrated by an earlier release is in: right
   * pin, zero segments, retrieval permanently at pre-#155 granularity with no shipped way back.
   * Until now the only fix lived in a script in the private core repo, so a published-package user
   * could not reach it at all.
   *
   * Idempotent by protocol: each observation's segments are deleted and reinserted in one
   * transaction, so a re-run grows nothing and an interrupt leaves every observation either fully
   * re-segmented or untouched.
   */
  program
    .command("resegment")
    .description("Rebuild observation segments in the store's current embedding space")
    .option("-d, --dir <storage-directory>", "Storage directory (default: .monet or ~/.monet)")
    .option("--circle <name>", "Limit to one circle")
    .action(async (options: { dir?: string; circle?: string }) => {
      const dbPath = dependencies.dbPath(options.dir);
      console.error(`store: ${dbPath}`);
      const inspection = dependencies.inspect(dbPath);
      // BEFORE createPort. Opening SQLite CREATES the file, so a typo or stale --dir would leave an
      // empty store behind and only then report the missing pin (Codex P2, PR #66).
      if (!inspection.exists) {
        throw new Error(`no Monet store at ${dbPath} — check --dir, or run \`monet doctor\` to see what is there.`);
      }
      /*
       * AN ACTIVE MIGRATION MAKES THE PIN A PROMISE, NOT A FACT (Codex P2, PR #66).
       *
       * A migration stamps the TARGET pin before every vector is rewritten — the repair-cli recovery
       * fixture sets exactly that state, target pin with vectors_rewritten = 0. Selecting the provider
       * from that pin would rebuild target-space segments over prior-space observation vectors, which
       * is the same-space invariant this command exists to restore, violated by the command itself.
       */
      /*
       * INTEGRITY BEFORE ANY WRITE (Codex P2, PR #66). resegmentObservations DELETEs and re-INSERTs
       * segment rows; doing that in a database SQLite has already reported as corrupt mutates
       * damage. `ensureInspectableForRepair` refuses this state on the repair path — the recovery
       * path had no reason to be more permissive than the thing it recovers from.
       */
      if (inspection.integrity.status !== "ok") {
        throw new Error(
          `the store integrity result is ${integrityLabel(inspection)}; refusing to rewrite segments in it. ` +
          `Restore from a backup, or run \`${doctorCommand(dbPath)}\` for the full report.`,
        );
      }
      if (inspection.migration.status !== "none") {
        /*
         * PROVEN INACTIVE, not merely not-active (Codex P2). `unknown` means the sentinel could not
         * be read — the pin may still name an uncompleted target, and rebuilding from it would mix
         * target-space segments with prior-space observation vectors: the same-space invariant this
         * command exists to restore, broken by the command itself.
         *
         * EACH BRANCH ADVERTISES ONLY A COMMAND THAT CAN RUN (Codex P2, round 3). `--resume` is
         * reachable only for an `active` sentinel: `ensureInspectableForRepair` rejects every
         * `unknown` migration BEFORE resume handling, so offering it there is guaranteed to fail.
         * Abandon is offered only when inspection classified it `safe`, since the repair path
         * accepts no other classification. Both carry --dir, or the operator repairs a different
         * store than the one just inspected.
         */
        if (inspection.migration.status === "active") {
          const canAbandon = inspection.migration.abandon.classification === "safe";
          throw new Error(
            "a migration is in progress; the pin may already name its target while vectors are still in the " +
            `previous space. Finish it with \`${resumeCommand(dbPath, true)}\`` +
            (canAbandon ? `, or clear it with \`${abandonCommand(dbPath, true)}\`` : "") +
            ", then resegment.",
          );
        }
        throw new Error(
          `the migration sentinel could not be read (${inspection.migration.reason}), so the pin cannot be trusted ` +
          `to describe the vectors. Repair cannot resume an unreadable sentinel either — diagnose with ` +
          `\`${doctorCommand(dbPath)}\` or restore from a backup first.`,
        );
      }
      const modelId = inspection.pin.status === "known" ? inspection.pin.modelId : undefined;
      if (!modelId) throw new Error(`this store has no embedder pin; run \`${doctorCommand(dbPath)}\` first`);
      /*
       * A MATCHING PIN NAME IS NOT A MATCHING SPACE (Codex P2, PR #66).
       *
       * Segments must be embedded by the same provider the store's vectors are in. The pin says
       * which model that is, but says nothing about whether the provider that loads under that name
       * actually produces vectors of the stored width — a store whose live vectors are 384-wide and
       * a provider that now declares 768 both answer to one pin string. Writing segments then puts
       * two widths in one comparison, which is the invariant this command exists to restore.
       *
       * `checkProvider` proves identity and probe output; `reconcileProviderWithStore` proves the
       * declared width against the store's uniform live width. Repair runs exactly this pair before
       * it rewrites anything, and so does this.
       */
      const { result: providerResult, provider } = await checkProvider(modelId, dependencies);
      if (providerResult.loadStatus !== "available" || provider === undefined) {
        throw new Error(
          `the pinned embedder '${modelId}' could not be loaded (${providerResult.reason ?? "unknown reason"}); ` +
          `refusing to rebuild segments in a space that cannot be produced.`,
        );
      }
      const reconciled = reconcileProviderWithStore(inspection, providerResult).provider;
      if (reconciled.storeCompatibility !== "compatible") {
        throw new Error(
          `the pinned embedder '${modelId}' is not proven compatible with this store's vectors ` +
          `(${reconciled.storeCompatibility}: ${reconciled.reason ?? "no reason given"}); refusing to write segments ` +
          `in a space the existing vectors may not share. Run \`${doctorCommand(dbPath, true)}\` for the full report.`,
        );
      }

      const port = dependencies.createPort(dbPath);
      let core: MonetCore | undefined;
      try {
        console.error(`embedder: ${modelId}`);
        core = dependencies.createCore(port, provider);
        const started = Date.now();
        const result = await core.resegmentObservations({
          ...(options.circle ? { circle: options.circle } : {}),
          onProgress(done, total) {
            if (done === total || done % 250 === 0) console.error(`  ${done}/${total} observations`);
          },
        });
        console.error(
          `resegmented ${result.observations} observations into ${result.segments} segments ` +
          `(${(result.segments / Math.max(result.observations, 1)).toFixed(2)} per observation) ` +
          `in ${((Date.now() - started) / 1000).toFixed(1)}s`,
        );
      } finally {
        if (core) core.close();
        else port.close();
      }
    });

  return program;
}
