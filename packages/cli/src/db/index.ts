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

export function getDbPath(): string {
  return path.join(getMonetDir(), DB_FILE);
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

export function ensureMonetDir(): string {
  const dir = getMonetDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
