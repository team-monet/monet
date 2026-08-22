import { randomUUID } from "node:crypto";
import { realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Atomic write-then-rename, extracted from `install-cli.ts` when `monet install` and `monet gate`
 * were removed (the Claude Code gate hook no longer exists, so neither command had a caller).
 *
 * PROVENANCE NOTE for the comment below, which is moved here verbatim from its original home: the
 * two install-time callers it argues from — the generated hook wrapper's forced `0o755` write and
 * the `settings.json` write that omits `mode` — are BOTH GONE. `materialize-cli.ts` is now the only
 * caller in the tree, and it omits `mode` (the preserve-existing branch) and supplies
 * `verifyBeforeRename`. The reasoning is retained because the FUNCTION's contract is unchanged —
 * forced-vs-preserved mode, symlink write-through, tmp cleanup — only the callers that motivated
 * each clause are historical now.
 */

/**
 * FIX 5 (Codex round 2 on PR #42): the wrapper and settings.json were being TRUNCATED IN PLACE
 * (`writeFileSync` straight onto the final path) — a crash mid-write, or a concurrent reader
 * (Claude Code itself, or another `monet install` run) observing the file at exactly the wrong
 * moment, could see a partially-written, invalid file: a truncated settings.json the NEXT hook
 * invocation chokes on, or a half-written wrapper script.
 *
 * Mirrors @team-monet/core's own `materializeGateMirror` atomic-write shape EXACTLY (gates.ts,
 * around its own `const tmp = join(dir, \`.${basename(path)}.${process.pid}.${Date.now()}.
 * ${randomUUID()}.tmp\`)` / `writeFileSync(tmp, data, { flag: "wx", ... })` / `renameSync(tmp,
 * path)` sequence) — the identical write-then-rename mechanism this client's own gate mirror
 * already depends on, for the identical reason: a hidden, pid+timestamp+UUID-suffixed tmp file in
 * the SAME directory as the final RESOLVED target (same-directory is what makes the rename atomic
 * — a cross-filesystem rename is not one), created with EXCLUSIVE creation (`wx` — fails on any
 * existing path at that name, without following a symlink), then renamed onto the final path. A
 * rename is a single filesystem operation: a reader sees either the OLD complete file or the NEW
 * complete file, never a partial write.
 *
 * P2-5 (Codex round 3 on PR #42) — SYMLINK-AWARE: if `targetPath` is a symlink, resolve it via
 * `realpathSync` FIRST and write through to the LINK TARGET instead — both the tmp file's own
 * directory and the final `renameSync` land there, never at the symlink's own path. Refusing to
 * touch a symlinked settings file would be hostile to a common, deliberate dotfiles setup (the
 * real file lives in a dotfiles repo; `~/.claude/settings.local.json` is a symlink to it) — the
 * user would have to re-run this command with `--dry-run` just to discover their own symlink
 * blocked it. Writing through instead leaves the user's symlink completely untouched (it already
 * points at the right inode-holding path; only THAT path's content changes) — this is the exact
 * property a rename-onto-an-existing-path already has (the core's own comment on this pattern:
 * "a rename onto an existing path replaces its inode outright... regardless of what it was before"
 * — replacing the REAL file's inode, not the symlink's).
 *
 * P2-4 (Codex round 3 on PR #42) — MODE PRESERVATION: `mode` is now two DIFFERENT things depending
 * on whether the caller passes it:
 *   - a specific number (the wrapper's own call, always `0o755`): FORCED, unconditionally — a
 *     generated, executable script must always end up executable regardless of what a user might
 *     have hand-chmod'd it to; there is nothing here worth "preserving".
 *   - omitted (the settings.json call): the file's OWN EXISTING mode is preserved when it already
 *     exists (a user who chmod'd their settings file `0600` for extra privacy must not silently
 *     have it widened back to the process umask's default the next time `monet install` re-runs);
 *     Node's own `writeFileSync` default (`0o666`, subject to umask) applies only when the file is
 *     genuinely new. `statSync` follows a symlink on its own (no separate `lstatSync` needed), so
 *     this already reads the REAL file's mode once `resolvedPath` has been resolved above.
 *
 * On any failure (including the exclusive-create itself), the tmp file is best-effort cleaned up
 * and the ORIGINAL error is rethrown — this function adds a safety property, it does not change
 * runInstall's existing behavior of letting a write failure propagate to the top-level handler.
 *
 * `verifyBeforeRename`, when supplied, runs after the complete temporary file is durable enough for
 * this helper's existing contract and immediately before the rename. A thrown verification error
 * aborts replacement and follows the same cleanup/rethrow path. Materialization uses this as a
 * best-effort snapshot compare-and-swap; existing install callers omit it and are unchanged.
 */
export function atomicWriteFile(
  targetPath: string,
  data: string,
  mode?: number,
  verifyBeforeRename?: () => void,
): void {
  let resolvedPath = targetPath;
  try {
    resolvedPath = realpathSync(targetPath);
  } catch {
    // Not a symlink, or does not exist yet — write at targetPath directly, as before.
  }

  let effectiveMode = mode;
  if (effectiveMode === undefined) {
    try {
      effectiveMode = statSync(resolvedPath).mode & 0o777;
    } catch {
      // Genuinely new — no existing mode to preserve; falls through to writeFileSync's own default.
    }
  }

  const dir = dirname(resolvedPath);
  const tmp = join(dir, `.${basename(resolvedPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, data, effectiveMode !== undefined ? { flag: "wx", mode: effectiveMode } : { flag: "wx" });
    verifyBeforeRename?.();
    renameSync(tmp, resolvedPath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup — matches materializeGateMirror's own posture; the ORIGINAL error is
      // what the caller needs to see, not a secondary cleanup failure.
    }
    throw error;
  }
}
