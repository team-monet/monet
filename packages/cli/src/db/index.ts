import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { MOMENT_SPOOL_FILENAME, startupFailurePath } from "@team-monet/core";

/**
 * Storage path resolution for the local runtime. The store itself is provided by
 * `@team-monet/core` (the state-centric substrate engine); this module only resolves where
 * the SQLite file lives.
 */
const MONET_DIR = ".monet";
const DB_FILE = "monet.db";
const MATERIALIZE_FILE = "materialize.json";

/**
 * `baseDir` defaults to `process.cwd()` — behavior-identical for every EXISTING caller (getDbPath,
 * ensureMonetDir, and every command that calls either without an argument). The parameter exists
 * so a caller whose "current project" is NOT the OS cwd (anything resolving its project via
 * MONET_PROJECT_DIR/CLAUDE_PROJECT_DIR — see project-dir.ts — rather than via cwd) can ask for the
 * SAME `.monet`-or-home resolution rooted at that project instead.
 *
 * THE BUG CLASS IT CLOSES (coordinator review, Blocker 1): a command that derives one answer from
 * `resolveProjectDir()` and another from this function's cwd default carries two different "current
 * project" notions at once. With MONET_PROJECT_DIR pointing at project A and cwd sitting in project
 * B (each with its own `.monet`), those two answers diverge silently — the command reports A while
 * actually reading or writing B's files, with no visible sign anything is wrong. Every caller that
 * has resolved a project must pass that SAME directory here rather than calling bare; cli.ts's
 * `start` action is the live instance.
 */
export function getMonetDir(baseDir: string = process.cwd()): string {
  if (process.env.MONET_STORAGE_DIR) {
    return process.env.MONET_STORAGE_DIR;
  }
  const projectMonetDir = path.join(baseDir, MONET_DIR);
  if (fs.existsSync(projectMonetDir)) {
    return projectMonetDir;
  }
  const homeDir = process.env.HOME || process.env.USERPROFILE || baseDir;
  return path.join(homeDir, MONET_DIR);
}

/**
 * `baseDir` forwards straight to `getMonetDir`; omitted, it defaults to cwd exactly as before, so
 * every EXISTING caller that calls `getDbPath()` with no argument is behavior-identical. The
 * parameter exists so a caller resolving a circle/store for a project that is NOT the OS cwd (P1-B,
 * Codex round 1 on PR #42) can open the SAME `.monet`-or-home resolution rooted at that project
 * instead — see circle.ts's `openMapStore` for the caller this closes the gap for.
 */
export function getDbPath(baseDir?: string): string {
  return path.join(getMonetDir(baseDir), DB_FILE);
}

/**
 * The governed-moment spool.
 *
 * DELIBERATELY NOT `getMonetDir`'s PROJECT-AWARE RESOLUTION: `$MONET_STORAGE_DIR` else
 * `os.homedir()/.monet`, and nothing else. The spool is ONE stream, and its format admits writers
 * that do not run in the serving process at all (`MomentWriterRole`'s `host-hook`) — a standalone
 * script that can import nothing from this module and can only bake in those same two rungs.
 * Resolving a project-local `.monet` here would put the in-process writer and that one on two
 * different files, which is the one failure a shared record cannot survive.
 *
 * NO SUCH OUT-OF-PROCESS WRITER SHIPS TODAY — the generated hook wrapper went with `monet install`.
 * The home-level rung is held by the spool format's own contract and by every spool already on
 * disk, not by a second live writer.
 */
export function getMomentSpoolPath(): string {
  const storageDir = process.env.MONET_STORAGE_DIR || path.join(os.homedir(), MONET_DIR);
  return path.join(storageDir, MOMENT_SPOOL_FILENAME);
}

/**
 * Where a failed startup leaves its diagnosis (#13).
 *
 * DERIVED FROM THE STORE PATH, not assembled from the directory and a filename. The record is a
 * sidecar of ONE database, and this directory routinely holds two — `monet.db` here and
 * `monet-core.db` from core's own dev server — so a per-directory name gave them one file between
 * them and let `doctor` report one store's failure as the other's (Codex round 1, PR #79). Composing
 * `getDbPath` with core's own `startupFailurePath` keeps the record rooted at exactly the store this
 * project resolves, with one spelling of the suffix, owned by the package that owns the format.
 */
export function getStartupFailurePath(baseDir?: string): string {
  return startupFailurePath(getDbPath(baseDir));
}

/** The materialize registry/manifest shares the store home's established resolution chain. */
export function getMaterializePath(baseDir?: string): string {
  return path.join(getMonetDir(baseDir), MATERIALIZE_FILE);
}

/**
 * P1-1 (Codex round 3 on PR #42): `baseDir` mirrors `getDbPath`'s own optional parameter exactly —
 * omitted, behavior-identical (cwd-rooted) for every EXISTING caller. Added because `start` and the
 * stdio entry both call `getDbPath(projectDir)` to open the served store at a specific resolved
 * project directory, but were still calling this function BARE
 * (cwd-rooted) beforehand — with `projectDir !== cwd` (a host spawning `monet` from elsewhere;
 * cwd happening to have its own `.monet`, the target not), the PARENT DIRECTORY for the db path
 * `getDbPath(projectDir)` resolves to never gets created, and better-sqlite3 fails to open it
 * (SQLITE_CANTOPEN — it does not create missing parent directories, only the file itself). Every
 * call site that opens a store at `getDbPath(projectDir)` must call `ensureMonetDir(projectDir)`
 * with the SAME `projectDir` first, not a bare call.
 */
export function ensureMonetDir(baseDir?: string): string {
  const dir = getMonetDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
