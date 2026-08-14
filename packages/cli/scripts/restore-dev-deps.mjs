/**
 * restore-dev-deps.mjs
 *
 * Called by the `postpack` lifecycle hook (after `npm pack` / `npm publish`).
 * Restores the original package.json from the backup written by
 * scripts/strip-dev-deps.mjs (the `prepack` hook) so the working tree is
 * unchanged after packing.
 */

import { copyFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pkgPath = resolve(root, "package.json");
const bakPath = resolve(root, "package.json.bak");

if (!existsSync(bakPath)) {
  // postpack can run even if prepack did not (e.g. when publishing from a CI
  // environment that already has the stripped manifest). Nothing to restore.
  console.log("restore-dev-deps: no backup found; nothing to restore.");
  process.exit(0);
}

copyFileSync(bakPath, pkgPath);
unlinkSync(bakPath);
console.log("restore-dev-deps: package.json restored from backup.");
