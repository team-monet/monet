import path from "node:path";
import fs from "node:fs";

/**
 * Storage path resolution for the local runtime. The store itself is provided by
 * `@team-monet/core` (the state-centric substrate engine); this module only resolves where
 * the SQLite file lives.
 */
const MONET_DIR = ".monet";
const DB_FILE = "monet.db";
const GATE_MIRROR_FILE = "gate-mirror.json";

/**
 * `baseDir` defaults to `process.cwd()` — behavior-identical for every EXISTING caller (getDbPath,
 * ensureMonetDir, and every command that calls either without an argument). The parameter exists
 * so a caller whose "current project" is NOT the OS cwd (the `gate` command, which resolves its
 * project via MONET_PROJECT_DIR/CLAUDE_PROJECT_DIR — see project-dir.ts — not via cwd) can ask for
 * the SAME `.monet`-or-home resolution rooted at that project instead. Bug this closes (coordinator
 * review, Blocker 1): `monet gate` derived its CIRCLE from resolveProjectDir() but its DEFAULT
 * MIRROR PATH from this function's old cwd-only behavior — two different "current project"
 * notions in the same command. With MONET_PROJECT_DIR pointing at project A and cwd sitting in
 * project B (both with their own .monet/gate-mirror.json), the circle line correctly reported "A"
 * while the mirror actually read was B's — a deny that should have fired reads as silence instead,
 * with no visible sign anything was wrong. See gate-cli.ts's `defaultGateCliDependencies` for the
 * fix on the calling side.
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
 * `baseDir` mirrors `getGateMirrorPath`'s own parameter exactly (added there in 4b-C) — forwards
 * straight to `getMonetDir`, omitted defaults to cwd exactly as before, so every EXISTING caller
 * that calls `getDbPath()` with no argument is behavior-identical. The parameter exists so a
 * caller resolving a circle/store for a project that is NOT the OS cwd (P1-B, Codex round 1 on PR
 * #42 — `monet install --project <dir>`) can open the SAME `.monet`-or-home resolution rooted at
 * that project instead — see circle.ts's `openMapStore` for the caller this closes the gap for.
 */
export function getDbPath(baseDir?: string): string {
  return path.join(getMonetDir(baseDir), DB_FILE);
}

/**
 * Default path for the offline gate mirror (`monet gate`'s `--mirror`, slice 4b-C).
 *
 * THIS IS A NEW CONVENTION, not one carried over from an existing default: `@team-monet/core`'s
 * `MonetCoreOptions.gateSidecarPath` has no built-in default of its own (`opts.gateSidecarPath ??
 * null` in engine.ts — a caller that never passes it simply never materializes a mirror), and
 * nothing in this client passes that option today (`start`, `status`, the source commands, and
 * `doctor`/`repair` all construct `MonetCore`/open the store without it). The one place this path
 * already existed before this file named it was a mirror a human materialized by hand at
 * `~/.monet/gate-mirror.json` — this just makes that the documented default, alongside `getDbPath`
 * exactly the way `getMonetDir` already resolves both.
 *
 * `baseDir` forwards straight to `getMonetDir` (see that function's own comment for why the
 * parameter exists at all) — omitted, this defaults to cwd exactly as before; the `gate` command
 * passes its resolved project dir so the mirror-path default and the circle default are rooted at
 * the SAME directory.
 */
export function getGateMirrorPath(baseDir?: string): string {
  return path.join(getMonetDir(baseDir), GATE_MIRROR_FILE);
}

/**
 * P1-1 (Codex round 3 on PR #42): `baseDir` mirrors `getDbPath`/`getGateMirrorPath`'s own optional
 * parameter exactly — omitted, behavior-identical (cwd-rooted) for every EXISTING caller. Added
 * because `start`/the stdio entry/`runInstall` all call `getDbPath(projectDir)` to open the served
 * store at a specific resolved project directory, but were still calling this function BARE
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
