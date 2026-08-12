import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { GATE_JOURNAL_FILENAME } from "@team-monet/core";

/**
 * Storage path resolution for the local runtime. The store itself is provided by
 * `@team-monet/core` (the state-centric substrate engine); this module only resolves where
 * the SQLite file lives.
 */
const MONET_DIR = ".monet";
const DB_FILE = "monet.db";
const GATE_MIRROR_FILE = "gate-mirror.json";
const MATERIALIZE_FILE = "materialize.json";

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
 * Default path for the gate journal — the append-only record every governing mouth writes what it
 * actually did to, including its declines.
 *
 * FILENAME FROM CORE, never a local literal: `GATE_JOURNAL_FILENAME` is exported by
 * `@team-monet/core` precisely because the mouths live in two repos (its own comment: "Shared with
 * the client's hook wrapper and gate CLI — all three mouths write ONE stream"), and gate-cli.ts in
 * this same client already imports it for exactly that reason. A second spelling of the name here
 * would be a fourth mouth writing a file the other three do not read, which is the whole failure
 * one shared constant exists to prevent.
 *
 * DELIBERATELY NOT `getMonetDir`, and deliberately WITHOUT a `baseDir` parameter — the one function
 * in this file that diverges from every neighbour above (P1, Codex round 1 on PR #76). Those resolve
 * THREE rungs (MONET_STORAGE_DIR → an already-existing project-local `.monet` → home); this resolves
 * the TWO that gate-cli.ts's `defaultGateCliDependencies` and the hook wrapper install-cli.ts
 * GENERATES both resolve (MONET_STORAGE_DIR → home). The reason is the same invariant the shared
 * filename above exists to serve: the journal is ONE stream, and its `parentId` correlates a hook
 * event to the gate event it caused ACROSS mouths — a correlation that means nothing once the two
 * halves land in different files. Routed through `getMonetDir`, a project holding its own `.monet`
 * with MONET_STORAGE_DIR unset split exactly that way: MCP-originated events into the project's
 * journal, hook and `monet gate` events into home's. A `baseDir` parameter would be a lie for the
 * same reason — nothing this function reads is project-rooted, and a parameter accepted and ignored
 * invites the `getGateJournalPath(projectDir)` call site that READS as project-aware and is not.
 *
 * WHICH DIRECTION to converge was the actual choice, and store-adjacency lost on reachability, not
 * on merit: the hook wrapper is a standalone generated script with no import of this module
 * available to it (see install-cli.ts, whose own comment already states these two rungs and why the
 * cwd one is absent from them), so home is the only answer all three writers can reach today.
 * Aligning all three on project-aware resolution — the journal beside the store it describes, the
 * way the mirror already is — is known follow-up work, blocked on giving that generated script a
 * resolver it can actually call.
 *
 * Home is `os.homedir()`, which INVERTS what this comment argued one commit ago (P2, Codex round 2
 * on PR #76). That argument was that deriving home as `HOME || USERPROFILE` matched `getMonetDir`'s
 * idiom and kept ONE notion of home in this file, which beat importing `os`. It optimized the wrong
 * thing. The party this function must agree with is the hook wrapper install-cli.ts GENERATES, and
 * that wrapper is the fixed point rather than the follower — a standalone script that cannot import
 * this module, so it bakes in `os.homedir()` and nothing here can change what it resolves. When
 * MONET_STORAGE_DIR, HOME and USERPROFILE are ALL absent — a minimal service environment, a
 * launchd/systemd unit, a bare container — the env-only chain falls through to `process.cwd()`
 * while the hook falls through to the passwd DB and lands in the account's real home. Two files
 * again, one rung further down than the split this function was extracted to close. Agreeing with
 * the hook is FUNCTIONAL; agreeing with the neighbouring function's spelling is COSMETIC.
 *
 * So this file holds two notions of home ON PURPOSE, one per invariant, and `getMonetDir` above is
 * deliberately left exactly as it is. It resolves the STORE — a per-project file whose every
 * reader imports this module, so its env-only chain is self-consistent by construction and has no
 * outside party to match. This resolves the JOURNAL — one shared stream whose writers include a
 * generated script that can import nothing, so it must match that script's resolution instead of
 * its neighbour's. Making the two spellings identical would trade a real divergence for a
 * cosmetic one.
 */
export function getGateJournalPath(): string {
  const storageDir = process.env.MONET_STORAGE_DIR || path.join(os.homedir(), MONET_DIR);
  return path.join(storageDir, GATE_JOURNAL_FILENAME);
}

/** The materialize registry/manifest shares the store home's established resolution chain. */
export function getMaterializePath(baseDir?: string): string {
  return path.join(getMonetDir(baseDir), MATERIALIZE_FILE);
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
