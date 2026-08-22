import { createHash } from "node:crypto";
import fs from "node:fs";
import { atomicWriteFile } from "./atomic-write.js";
import path from "node:path";
import { Command } from "commander";
import { MonetCore, type SkeletonBody } from "@team-monet/core";
import { getDbPath, getMaterializePath } from "./db/index.js";
import { resolveProjectDir } from "./project-dir.js";

const BEGIN_MARKER = "<!-- BEGIN monet:skeleton";
const END_MARKER = "<!-- END monet:skeleton -->";
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type MaterializeScope = "global" | { circle: string };

export interface MaterializeSurface {
  /** Absolute standing-file path. This raw string is also the `materialized` map key. */
  path: string;
  scope: MaterializeScope;
}

export interface MaterializedSurface {
  /**
   * sha256 hex of the exact rendered block span: the BEGIN marker's first UTF-8 byte through the
   * END marker's final `>` byte, inclusive. Any newline after that final `>` is excluded.
   */
  blockHash: string;
  /**
   * sha256 hex of canonical JSON for the delivered members. Canonicalization is exactly
   * JSON.stringify([...members].sort((a, b) => a.conceptId < b.conceptId ? -1 :
   * a.conceptId > b.conceptId ? 1 : 0).map(({ conceptId, body, breadth }) =>
   * ({ conceptId, body, breadth }))) encoded as UTF-8: conceptId sorting is raw JavaScript code-unit
   * order (`<`/`>`), never localeCompare/ICU; object keys are emitted in the literal order
   * conceptId, body, breadth; and JSON.stringify supplies all escaping with no whitespace.
   */
  skeletonState: string;
  /** Unix epoch milliseconds of materialization provenance only; never a freshness input. */
  when: number;
}

/**
 * Cross-package contract stored as `<storeHome>/materialize.json`. `@team-monet/core` prewarm reads
 * this exact registry/manifest shape, so field names and scope encoding are a public interchange
 * format, not CLI-private persistence. Each `materialized` key is exactly the raw absolute string
 * in its matching `surfaces[].path`: never realpath-resolved, case-folded, Unicode-normalized (NFC or
 * otherwise), or subjected to any other path normalization.
 */
export interface MaterializeRegistryManifest {
  surfaces: MaterializeSurface[];
  materialized: Record<string, MaterializedSurface>;
}

export interface MaterializeSkeletonCore {
  skeletonBodies(circle?: string): SkeletonBody[];
  close(): void;
}

export interface MaterializeCliDependencies {
  projectDir(): string;
  storeHome(): string;
  dbPath(): string;
  openCore(dbPath: string): MaterializeSkeletonCore;
  now(): number;
  /** Test seam for a write racing after the surface snapshot but before the atomic CAS check. */
  beforeSurfaceWrite?(path: string): void;
  /** Test seam for a registry mutation after the run snapshot but before its atomic CAS check. */
  beforeRegistryWrite?(path: string): void;
  setExitCode(code: number): void;
}

export class MaterializeCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterializeCliError";
  }
}

export class MaterializeRegistryConflictError extends MaterializeCliError {
  constructor(message: string) {
    super(message);
    this.name = "MaterializeRegistryConflictError";
  }
}

export class MaterializeMarkerCollisionError extends MaterializeCliError {
  constructor(message: string) {
    super(message);
    this.name = "MaterializeMarkerCollisionError";
  }
}

export class MaterializeDestinationAliasError extends MaterializeCliError {
  constructor(message: string) {
    super(message);
    this.name = "MaterializeDestinationAliasError";
  }
}

export class MaterializeLossyDecodeError extends MaterializeCliError {
  constructor(message: string) {
    super(message);
    this.name = "MaterializeLossyDecodeError";
  }
}

export function defaultMaterializeCliDependencies(): MaterializeCliDependencies {
  return {
    projectDir: resolveProjectDir,
    storeHome: () => path.dirname(getMaterializePath(resolveProjectDir())),
    dbPath: () => getDbPath(resolveProjectDir()),
    openCore: (dbPath) => new MonetCore(dbPath, { deferCreatedPin: true }),
    now: Date.now,
    setExitCode(code) {
      process.exitCode = code;
    },
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function manifestPath(deps: MaterializeCliDependencies): string {
  return path.join(deps.storeHome(), path.basename(getMaterializePath(deps.projectDir())));
}

function emptyManifest(): MaterializeRegistryManifest {
  return { surfaces: [], materialized: {} };
}

function isScope(value: unknown): value is MaterializeScope {
  if (value === "global") return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 1
    && typeof record.circle === "string"
    && record.circle.trim().length > 0
    && record.circle === record.circle.trim()
  );
}

function isMaterializedSurface(value: unknown): value is MaterializedSurface {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.blockHash === "string" && SHA256_HEX.test(record.blockHash)
    && typeof record.skeletonState === "string" && SHA256_HEX.test(record.skeletonState)
    && typeof record.when === "number" && Number.isFinite(record.when)
  );
}

interface MaterializeManifestSnapshot {
  manifest: MaterializeRegistryManifest;
  bytes: Buffer | null;
}

function readMaterializeManifestSnapshot(filePath: string): MaterializeManifestSnapshot {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { manifest: emptyManifest(), bytes: null };
    throw new MaterializeCliError(`cannot read registry ${filePath}: ${messageFrom(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new MaterializeCliError(`registry ${filePath} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MaterializeCliError(`registry ${filePath} is not a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.surfaces) || typeof record.materialized !== "object" || record.materialized === null || Array.isArray(record.materialized)) {
    throw new MaterializeCliError(`registry ${filePath} must contain surfaces[] and materialized{}`);
  }

  const surfaces: MaterializeSurface[] = [];
  const seen = new Set<string>();
  for (const value of record.surfaces) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new MaterializeCliError(`registry ${filePath} contains an invalid surface`);
    }
    const surface = value as Record<string, unknown>;
    if (typeof surface.path !== "string" || !path.isAbsolute(surface.path) || !isScope(surface.scope)) {
      throw new MaterializeCliError(`registry ${filePath} contains a surface with an invalid absolute path or scope`);
    }
    if (seen.has(surface.path)) throw new MaterializeCliError(`registry ${filePath} contains duplicate surface ${surface.path}`);
    seen.add(surface.path);
    surfaces.push({ path: surface.path, scope: surface.scope });
  }

  const materialized: Record<string, MaterializedSurface> = {};
  for (const [surfacePath, value] of Object.entries(record.materialized)) {
    if (!path.isAbsolute(surfacePath) || !isMaterializedSurface(value)) {
      throw new MaterializeCliError(`registry ${filePath} contains invalid materialized state for ${surfacePath}`);
    }
    materialized[surfacePath] = value;
  }
  return { manifest: { surfaces, materialized }, bytes };
}

export function readMaterializeManifest(filePath: string): MaterializeRegistryManifest {
  return readMaterializeManifestSnapshot(filePath).manifest;
}

function byteSnapshotStillMatches(pathname: string, snapshot: Buffer | null): boolean {
  if (snapshot !== null) {
    try {
      return fs.readFileSync(pathname).equals(snapshot);
    } catch {
      return false;
    }
  }
  try {
    fs.lstatSync(pathname);
    return false; // Something now exists — notably a newly-created dangling link.
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function writeMaterializeManifest(
  filePath: string,
  manifest: MaterializeRegistryManifest,
  expectedSnapshot?: Buffer | null,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Bare materialization uses the same best-effort snapshot CAS as standing files. The comparison is
  // immediately before rename; the remaining check-to-rename window is accepted for this single-user
  // CLI because closing it requires cross-process locking and persistent lock-recovery state.
  atomicWriteFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, undefined, expectedSnapshot === undefined ? undefined : () => {
    if (!byteSnapshotStillMatches(filePath, expectedSnapshot)) {
      throw new MaterializeRegistryConflictError(
        `registry conflict at ${filePath}: materialize.json changed after this run started; refusing to overwrite a concurrent add/remove. Surfaces already materialized remain materialized; rerun monet materialize`,
      );
    }
  });
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scopeLabel(scope: MaterializeScope): string {
  return scope === "global" ? "global" : `circle:${scope.circle}`;
}

function assertMarkerSafeScope(scope: MaterializeScope): void {
  if (scope === "global") return;
  const label = scopeLabel(scope);
  if (label.includes(BEGIN_MARKER) || label.includes(END_MARKER)) {
    throw new MaterializeMarkerCollisionError(
      `marker collision in circle scope ${JSON.stringify(scope.circle)}: scope label contains a monet:skeleton control-marker substring; refusing to render a poisoned block`,
    );
  }
}

function assertQueryableMaterializeScope(surface: MaterializeSurface): void {
  if (surface.scope !== "global" && surface.scope.circle === "*") {
    throw new MaterializeCliError(
      "circle '*' is the reserved global-breadth marker, never a queryable circle; register this surface with --global instead",
    );
  }
  assertMarkerSafeScope(surface.scope);
}

function canonicalSurfaceDestination(surfacePath: string): string | null {
  let ancestor = surfacePath;
  const unresolvedSuffix: string[] = [];
  while (true) {
    try {
      return path.join(fs.realpathSync.native(ancestor), ...unresolvedSuffix);
    } catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return null;
      unresolvedSuffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function sameDestinationRefusals(surfaces: MaterializeSurface[]): Map<string, MaterializeDestinationAliasError> {
  const pathsByDestination = new Map<string, string[]>();
  for (const surface of surfaces) {
    const destination = canonicalSurfaceDestination(surface.path);
    if (destination === null) continue;
    const paths = pathsByDestination.get(destination) ?? [];
    paths.push(surface.path);
    pathsByDestination.set(destination, paths);
  }

  const refusals = new Map<string, MaterializeDestinationAliasError>();
  for (const [destination, paths] of pathsByDestination) {
    if (paths.length < 2) continue;
    for (const surfacePath of paths) {
      refusals.set(surfacePath, new MaterializeDestinationAliasError(
        `same-destination aliases ${paths.map((alias) => JSON.stringify(alias)).join(", ")} resolve to ${JSON.stringify(destination)}; refusing every alias in this group`,
      ));
    }
  }
  return refusals;
}

function resolveSurfacePath(input: string, projectDir: string): string {
  return path.resolve(projectDir, input);
}

export interface DeliveredMember {
  conceptId: string;
  species: "principle" | "preference";
  body: string;
  breadth: "global" | "local";
}

export function canonicalSkeletonState(members: DeliveredMember[]): string {
  const canonical = [...members]
    .sort((a, b) => a.conceptId < b.conceptId ? -1 : a.conceptId > b.conceptId ? 1 : 0)
    .map(({ conceptId, body, breadth }) => ({ conceptId, body, breadth }));
  return sha256(JSON.stringify(canonical));
}

function deliveredMembers(core: MaterializeSkeletonCore, scope: MaterializeScope): DeliveredMember[] {
  const skeleton = core.skeletonBodies(scope === "global" ? undefined : scope.circle);
  // Hosts load the global standing file and the project standing file in the same session. Keep the
  // breadths disjoint here and let that file layering form the union, or global members double-deliver
  // in every project — exactly the waste materialization exists to remove.
  return skeleton.filter((entry) => scope === "global" ? entry.breadth === "global" : entry.breadth === "local");
}

function assertMarkerSafeMembers(members: DeliveredMember[]): void {
  for (const member of members) {
    if (member.body.includes(BEGIN_MARKER) || member.body.includes(END_MARKER)) {
      throw new MaterializeMarkerCollisionError(
        `marker collision in conceptId ${JSON.stringify(member.conceptId)}: delivered body contains a monet:skeleton control-marker substring; refusing to write a block that would poison the next run`,
      );
    }
  }
}

function renderSection(title: "Principles" | "Preferences", bodies: string[]): string {
  return `# ${title}\n\n${bodies.join("\n\n")}`;
}

export function renderSkeletonBlock(
  scope: MaterializeScope,
  members: DeliveredMember[],
  generated: string,
  skeletonState = canonicalSkeletonState(members),
): string {
  assertMarkerSafeScope(scope);
  const sections: string[] = [];
  const principles = members.filter((member) => member.species === "principle").map((member) => member.body);
  const preferences = members.filter((member) => member.species === "preference").map((member) => member.body);
  if (principles.length > 0) sections.push(renderSection("Principles", principles));
  if (preferences.length > 0) sections.push(renderSection("Preferences", preferences));
  const begin = `${BEGIN_MARKER} scope=${scopeLabel(scope)} state=${skeletonState} generated=${generated} -->`;
  const block = sections.length > 0
    ? `${begin}\n${sections.join("\n\n")}\n${END_MARKER}`
    : `${begin}\n${END_MARKER}`;
  // Belt-and-braces postcondition: future interpolations must not bypass the specific body/scope guards.
  assertSingleMarkerPair(block);
  return block;
}

function markerCount(text: string, marker: string): number {
  let count = 0;
  for (let offset = text.indexOf(marker); offset !== -1; offset = text.indexOf(marker, offset + marker.length)) {
    count += 1;
  }
  return count;
}

function assertSingleMarkerPair(block: string): void {
  const beginCount = markerCount(block, BEGIN_MARKER);
  const endCount = markerCount(block, END_MARKER);
  if (beginCount !== 1 || endCount !== 1) {
    throw new MaterializeMarkerCollisionError(
      `marker collision in rendered block: expected exactly one monet:skeleton marker pair, found ${beginCount} BEGIN and ${endCount} END markers; refusing to write a poisoned block`,
    );
  }
}

interface MarkerSpan {
  start: number;
  end: number;
  block: string;
}

export function findSkeletonBlock(text: string, surfacePath: string): MarkerSpan | null {
  const begin = text.indexOf(BEGIN_MARKER);
  const end = text.indexOf(END_MARKER);
  if (begin === -1 && end === -1) return null;
  // Any unmatched or reversed marker is malformed. The reversed case is checked before unmatched
  // duplicates so a later valid-looking span cannot hide an orphan END earlier in the file.
  if (begin === -1 || end === -1 || end < begin) {
    throw new MaterializeCliError(`${surfacePath}: malformed monet:skeleton markers`);
  }
  if (text.indexOf(BEGIN_MARKER, begin + BEGIN_MARKER.length) !== -1 || text.indexOf(END_MARKER, end + END_MARKER.length) !== -1) {
    throw new MaterializeCliError(`${surfacePath}: multiple monet:skeleton marker spans`);
  }
  const spanEnd = end + END_MARKER.length;
  return { start: begin, end: spanEnd, block: text.slice(begin, spanEnd) };
}

function nextSurfaceText(existing: string | null, surfacePath: string, block: string): string {
  if (existing === null) return block;
  const span = findSkeletonBlock(existing, surfacePath);
  if (span !== null) return `${existing.slice(0, span.start)}${block}${existing.slice(span.end)}`;
  if (existing.length === 0) return block;
  // Preserve every existing byte. Add only the separators the tail does not already supply:
  // `\n\n` after ordinary text, `\n` after one newline, and nothing after an existing blank line.
  const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}${block}`;
}

function currentMembersForSurface(core: MaterializeSkeletonCore, surface: MaterializeSurface): DeliveredMember[] {
  return deliveredMembers(core, surface.scope);
}

interface SurfaceSnapshot {
  text: string;
  bytes: Buffer;
}

function readSurfaceSnapshot(pathname: string): SurfaceSnapshot | null {
  try {
    const bytes = fs.readFileSync(pathname);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) {
      // Byte-level block splicing could preserve an arbitrary surrounding encoding, but refusal is the
      // deliberately smaller first step: never rewrite hand-authored bytes through U+FFFD replacement.
      throw new MaterializeLossyDecodeError(
        `${pathname}: surface is not losslessly UTF-8-decodable; refusing to rewrite bytes outside the managed block`,
      );
    }
    return { text, bytes };
  } catch (error) {
    if (error instanceof MaterializeCliError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        if (fs.lstatSync(pathname).isSymbolicLink()) {
          const target = fs.readlinkSync(pathname);
          throw new MaterializeCliError(
            `${pathname}: dangling symbolic link targets ${JSON.stringify(target)}; repair the link or create its target before materializing`,
          );
        }
      } catch (linkError) {
        if (linkError instanceof MaterializeCliError) throw linkError;
        // lstat itself reports ENOENT for a genuinely missing surface — creation is allowed.
      }
      return null;
    }
    throw new MaterializeCliError(`${pathname}: cannot read surface (${messageFrom(error)})`);
  }
}

function readSurface(pathname: string): string | null {
  return readSurfaceSnapshot(pathname)?.text ?? null;
}

function writeSurface(pathname: string, text: string, snapshot: Buffer | null): void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  // Reuse install's same-directory atomic writer: it follows a deliberate live dotfile symlink and
  // preserves an existing target's mode. Immediately before its rename, compare the destination to
  // the bytes read at the start of this surface operation. A concurrent edit anywhere in the file —
  // managed block or surrounding hand-written text — refuses replacement rather than being lost.
  // A small compare-to-rename window remains; closing it needs locking and is disproportionate for
  // this single-user CLI. The best-effort CAS still catches the practical race without new lock state.
  atomicWriteFile(pathname, text, undefined, () => {
    if (!byteSnapshotStillMatches(pathname, snapshot)) {
      throw new MaterializeCliError(`${pathname}: changed after it was read; refusing to overwrite concurrent edits (rerun materialize)`);
    }
  });
}

async function materializeOne(
  surface: MaterializeSurface,
  core: MaterializeSkeletonCore,
  now: number,
  prior?: MaterializedSurface,
  beforeSurfaceWrite?: (path: string) => void,
): Promise<MaterializedSurface> {
  const snapshot = readSurfaceSnapshot(surface.path);
  const existing = snapshot?.text ?? null;
  const span = existing === null ? null : findSkeletonBlock(existing, surface.path);
  const members = currentMembersForSurface(core, surface);
  assertMarkerSafeMembers(members);
  const skeletonState = canonicalSkeletonState(members);

  // `generated` and `when` describe a materialization event, not an invocation. If both the store
  // state and exact managed block still match the manifest, there is nothing to regenerate; retain
  // all bytes and hashes. This is the minimization principle in executable form.
  if (
    prior !== undefined && span !== null
    && prior.skeletonState === skeletonState
    && prior.blockHash === sha256(span.block)
  ) {
    return prior;
  }

  const block = renderSkeletonBlock(surface.scope, members, new Date(now).toISOString(), skeletonState);
  const output = nextSurfaceText(existing, surface.path, block);
  beforeSurfaceWrite?.(surface.path);
  writeSurface(surface.path, output, snapshot?.bytes ?? null);
  return { blockHash: sha256(block), skeletonState, when: now };
}

async function openForSkeleton<T>(deps: MaterializeCliDependencies, action: (core: MaterializeSkeletonCore) => Promise<T>): Promise<T> {
  const dbPath = deps.dbPath();
  try {
    if (!fs.statSync(dbPath).isFile()) throw new Error("not a regular file");
    fs.accessSync(dbPath, fs.constants.R_OK);
  } catch {
    throw new MaterializeCliError(`store is not a readable database file: ${dbPath}`);
  }
  const core = deps.openCore(dbPath);
  try {
    return await action(core);
  } finally {
    core.close();
  }
}

export type MaterializeFreshness = "fresh" | "stale" | "block-missing" | "never-materialized";

function freshnessWithoutStore(
  surface: MaterializeSurface,
  prior: MaterializedSurface | undefined,
): MaterializeFreshness | null {
  if (prior === undefined) return "never-materialized";
  const existing = readSurface(surface.path);
  if (existing === null) return "block-missing";
  return findSkeletonBlock(existing, surface.path) === null ? "block-missing" : null;
}

async function freshnessFromStore(
  surface: MaterializeSurface,
  prior: MaterializedSurface,
  core: MaterializeSkeletonCore,
): Promise<MaterializeFreshness> {
  // Re-read after opening the store rather than trusting preflight bytes: a concurrent edit between
  // those two moments must be classified, not hidden by an earlier snapshot.
  const existing = readSurface(surface.path);
  if (existing === null) return "block-missing";
  const span = findSkeletonBlock(existing, surface.path);
  if (span === null) return "block-missing";
  const members = currentMembersForSurface(core, surface);
  const skeletonState = canonicalSkeletonState(members);
  return sha256(span.block) === prior.blockHash && skeletonState === prior.skeletonState ? "fresh" : "stale";
}

interface AddOptions {
  global?: boolean;
  circle?: string;
}

export function registerMaterializeCommands(
  program: Command,
  deps: MaterializeCliDependencies = defaultMaterializeCliDependencies(),
): Command {
  const materialize = program
    .command("materialize")
    .description("Regenerate registered standing-file skeleton blocks from the store")
    .action(async () => {
      const filePath = manifestPath(deps);
      const { manifest, bytes: registrySnapshot } = readMaterializeManifestSnapshot(filePath);
      const next: MaterializeRegistryManifest = { surfaces: manifest.surfaces, materialized: { ...manifest.materialized } };
      const aliasRefusals = sameDestinationRefusals(manifest.surfaces);
      let failed = false;
      const now = deps.now();
      if (manifest.surfaces.length === 0) {
        deps.beforeRegistryWrite?.(filePath);
        writeMaterializeManifest(filePath, next, registrySnapshot);
        return;
      }
      console.error(`store: ${path.resolve(deps.dbPath())}`);
      await openForSkeleton(deps, async (core) => {
        for (const surface of manifest.surfaces) {
          try {
            const aliasRefusal = aliasRefusals.get(surface.path);
            if (aliasRefusal !== undefined) throw aliasRefusal;
            assertQueryableMaterializeScope(surface);
            next.materialized[surface.path] = await materializeOne(
              surface,
              core,
              now,
              manifest.materialized[surface.path],
              deps.beforeSurfaceWrite,
            );
            console.log(`Materialized ${surface.path}`);
          } catch (error) {
            failed = true;
            console.error(`monet materialize: ${surface.path}: ${messageFrom(error)}`);
          }
        }
      });
      deps.beforeRegistryWrite?.(filePath);
      writeMaterializeManifest(filePath, next, registrySnapshot);
      if (failed) deps.setExitCode(1);
    });

  materialize
    .command("add <path>")
    .description("Register a standing-file surface")
    .option("--global", "Deliver global-breadth skeleton members")
    .option("--circle <name>", "Deliver local-breadth members from this circle")
    .action((inputPath: string, options: AddOptions) => {
      const rawCircle = options.circle;
      const circle = rawCircle?.trim();
      if ((options.global === true) === (circle !== undefined && circle.length > 0)) {
        throw new MaterializeCliError("add requires exactly one of --global or --circle <name>");
      }
      if (rawCircle !== undefined && rawCircle !== circle) {
        throw new MaterializeCliError("--circle <name> must not have leading or trailing whitespace");
      }
      if (circle === "*") {
        throw new MaterializeCliError(
          "circle '*' is the reserved global-breadth marker, never a queryable circle; use --global instead",
        );
      }
      if (circle !== undefined) assertMarkerSafeScope({ circle });
      const surfacePath = resolveSurfacePath(inputPath, deps.projectDir());
      const filePath = manifestPath(deps);
      const manifest = readMaterializeManifest(filePath);
      if (manifest.surfaces.some((surface) => surface.path === surfacePath)) {
        throw new MaterializeCliError(`surface already registered: ${surfacePath}`);
      }
      const destination = canonicalSurfaceDestination(surfacePath);
      if (destination !== null) {
        const existing = manifest.surfaces.find((surface) => canonicalSurfaceDestination(surface.path) === destination);
        if (existing !== undefined) {
          throw new MaterializeDestinationAliasError(
            `same-destination aliases ${JSON.stringify(surfacePath)} and ${JSON.stringify(existing.path)} resolve to ${JSON.stringify(destination)}; refusing registration`,
          );
        }
      }
      manifest.surfaces.push({ path: surfacePath, scope: options.global === true ? "global" : { circle: circle! } });
      writeMaterializeManifest(filePath, manifest);
      console.log(`Registered ${surfacePath} (${options.global === true ? "global" : `circle:${circle}`})`);
    });

  materialize
    .command("remove <path>")
    .description("Unregister a standing-file surface without changing the file")
    .action((inputPath: string) => {
      const surfacePath = resolveSurfacePath(inputPath, deps.projectDir());
      const filePath = manifestPath(deps);
      const manifest = readMaterializeManifest(filePath);
      const index = manifest.surfaces.findIndex((surface) => surface.path === surfacePath);
      if (index === -1) throw new MaterializeCliError(`surface is not registered: ${surfacePath}`);
      manifest.surfaces.splice(index, 1);
      delete manifest.materialized[surfacePath];
      writeMaterializeManifest(filePath, manifest);
      console.log(`Removed ${surfacePath}`);
    });

  materialize
    .command("list")
    .description("List registered surfaces and their freshness")
    .action(async () => {
      const manifest = readMaterializeManifest(manifestPath(deps));
      if (manifest.surfaces.length === 0) return;
      const aliasRefusals = sameDestinationRefusals(manifest.surfaces);

      // Three states require no store consultation. Compute those first and open the database only
      // if at least one intact, previously materialized block needs its skeletonState checked.
      const states: Array<MaterializeFreshness | null | undefined> = [];
      let needsStore = false;
      for (const surface of manifest.surfaces) {
        try {
          const aliasRefusal = aliasRefusals.get(surface.path);
          if (aliasRefusal !== undefined) throw aliasRefusal;
          assertQueryableMaterializeScope(surface);
          const state = freshnessWithoutStore(surface, manifest.materialized[surface.path]);
          states.push(state);
          needsStore ||= state === null;
        } catch (error) {
          states.push(undefined);
          console.error(`monet materialize list: ${surface.path}: ${messageFrom(error)}`);
          deps.setExitCode(1);
        }
      }
      if (!needsStore) {
        for (let index = 0; index < manifest.surfaces.length; index += 1) {
          const state = states[index];
          if (state !== null && state !== undefined) {
            console.log(`${state}\t${scopeLabel(manifest.surfaces[index].scope)}\t${manifest.surfaces[index].path}`);
          }
        }
        return;
      }

      console.error(`store: ${path.resolve(deps.dbPath())}`);
      await openForSkeleton(deps, async (core) => {
        for (let index = 0; index < manifest.surfaces.length; index += 1) {
          const surface = manifest.surfaces[index];
          let state = states[index];
          if (state === undefined) continue;
          if (state === null) {
            try {
              const prior = manifest.materialized[surface.path]!;
              state = await freshnessFromStore(surface, prior, core);
            } catch (error) {
              console.error(`monet materialize list: ${surface.path}: ${messageFrom(error)}`);
              deps.setExitCode(1);
              continue;
            }
          }
          console.log(`${state}\t${scopeLabel(surface.scope)}\t${surface.path}`);
        }
      });
    });

  return materialize;
}
