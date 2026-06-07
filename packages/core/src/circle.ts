import { basename } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * A stable per-project circle derived from the working tree — the git repo root's folder name, else the
 * cwd's folder name. Lets one shared store (e.g. a global ~/.monet) isolate per project: each runtime
 * passes this as MonetCore's `defaultCircle`, so every circle-less memory op lands in the project's own
 * circle. Falls back to "default" if nothing usable is found.
 *
 * NOTE on upgrades: switching a store that already holds memory under the literal "default" circle to a
 * derived circle leaves that legacy memory in "default" — organize it with the interactive migration
 * (with-monet `bootstrap/migrate-memory.md`) rather than stranding it.
 */
export function deriveCircle(cwd: string = process.cwd()): string {
  let root = cwd;
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (top) root = top;
  } catch {
    // not a git repo, or git unavailable — fall back to the cwd folder name
  }
  return basename(root).trim() || "default";
}
