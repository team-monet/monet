import { createHash } from "node:crypto";
import fs from "node:fs";
import { atomicWriteFile } from "./install-cli.js";
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
  setExitCode(code: number): void;
}

export class MaterializeCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterializeCliError";
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

export function readMaterializeManifest(filePath: string): MaterializeRegistryManifest {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyManifest();
    throw new MaterializeCliError(`cannot read registry ${filePath}: ${messageFrom(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
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
  return { surfaces, materialized };
}

function writeMaterializeManifest(filePath: string, manifest: MaterializeRegistryManifest): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scopeLabel(scope: MaterializeScope): string {
  return scope === "global" ? "global" : `circle:${scope.circle}`;
}

function assertQueryableMaterializeScope(surface: MaterializeSurface): void {
  if (surface.scope !== "global" && surface.scope.circle === "*") {
    throw new MaterializeCliError(
      "circle '*' is the reserved global-breadth marker, never a queryable circle; register this surface with --global instead",
    );
  }
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

function renderSection(title: "Principles" | "Preferences", bodies: string[]): string {
  return `# ${title}\n\n${bodies.join("\n\n")}`;
}

export function renderSkeletonBlock(
  scope: MaterializeScope,
  members: DeliveredMember[],
  generated: string,
  skeletonState = canonicalSkeletonState(members),
): string {
  const sections: string[] = [];
  const principles = members.filter((member) => member.species === "principle").map((member) => member.body);
  const preferences = members.filter((member) => member.species === "preference").map((member) => member.body);
  if (principles.length > 0) sections.push(renderSection("Principles", principles));
  if (preferences.length > 0) sections.push(renderSection("Preferences", preferences));
  const begin = `${BEGIN_MARKER} scope=${scopeLabel(scope)} state=${skeletonState} generated=${generated} -->`;
  return sections.length > 0
    ? `${begin}\n${sections.join("\n\n")}\n${END_MARKER}`
    : `${begin}\n${END_MARKER}`;
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

function readSurface(pathname: string): string | null {
  try {
    return fs.readFileSync(pathname, "utf8");
  } catch (error) {
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

function snapshotStillMatches(pathname: string, snapshot: string | null): boolean {
  try {
    return fs.readFileSync(pathname, "utf8") === snapshot;
  } catch (error) {
    if (snapshot !== null || (error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    try {
      fs.lstatSync(pathname);
      return false; // Something exists but cannot be followed — notably a newly-created dangling link.
    } catch (linkError) {
      return (linkError as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
}

function writeSurface(pathname: string, text: string, snapshot: string | null): void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  // Reuse install's same-directory atomic writer: it follows a deliberate live dotfile symlink and
  // preserves an existing target's mode. Immediately before its rename, compare the destination to
  // the bytes read at the start of this surface operation. A concurrent edit anywhere in the file —
  // managed block or surrounding hand-written text — refuses replacement rather than being lost.
  // A small compare-to-rename window remains; closing it needs locking and is disproportionate for
  // this single-user CLI. The best-effort CAS still catches the practical race without new lock state.
  atomicWriteFile(pathname, text, undefined, () => {
    if (!snapshotStillMatches(pathname, snapshot)) {
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
  const existing = readSurface(surface.path);
  const span = existing === null ? null : findSkeletonBlock(existing, surface.path);
  const members = currentMembersForSurface(core, surface);
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
  writeSurface(surface.path, output, existing);
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
      const manifest = readMaterializeManifest(filePath);
      const next: MaterializeRegistryManifest = { surfaces: manifest.surfaces, materialized: { ...manifest.materialized } };
      let failed = false;
      const now = deps.now();
      if (manifest.surfaces.length === 0) {
        writeMaterializeManifest(filePath, next);
        return;
      }
      console.error(`store: ${path.resolve(deps.dbPath())}`);
      await openForSkeleton(deps, async (core) => {
        for (const surface of manifest.surfaces) {
          try {
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
      writeMaterializeManifest(filePath, next);
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
      const surfacePath = resolveSurfacePath(inputPath, deps.projectDir());
      const filePath = manifestPath(deps);
      const manifest = readMaterializeManifest(filePath);
      if (manifest.surfaces.some((surface) => surface.path === surfacePath)) {
        throw new MaterializeCliError(`surface already registered: ${surfacePath}`);
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

      // Three states require no store consultation. Compute those first and open the database only
      // if at least one intact, previously materialized block needs its skeletonState checked.
      const states: Array<MaterializeFreshness | null | undefined> = [];
      let needsStore = false;
      for (const surface of manifest.surfaces) {
        try {
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
