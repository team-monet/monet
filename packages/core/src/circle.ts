import { basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * A stable per-project circle derived from the working tree — the git repo root's folder name, else the
 * cwd's folder name, suffixed with a short hash of the absolute path. Lets one shared store (e.g. a global
 * ~/.monet) isolate per project: each runtime passes this as MonetCore's `defaultCircle`, so every
 * circle-less memory op lands in the project's own circle. The path-hash suffix keeps two distinct working
 * trees that share a final folder name (e.g. `client-a/api` and `client-b/api`) in SEPARATE circles.
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
  const abs = resolve(root);
  const name = basename(abs).trim() || "project";
  const hash = createHash("sha1").update(abs).digest("hex").slice(0, 8);
  return `${name}-${hash}`;
}
