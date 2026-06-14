/**
 * strip-dev-deps.mjs
 *
 * Called by the `prepack` lifecycle hook (before `npm pack` / `npm publish`).
 * Rewrites package.json in place with devDependencies removed so the published
 * tarball does not leak internal build tooling or the private file: path to
 * @team-monet/core. The original file is saved as package.json.bak.
 *
 * The companion `postpack` hook (scripts/restore-dev-deps.mjs) restores the
 * backup so the working tree is unchanged after packing.
 */

import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pkgPath = resolve(root, "package.json");
const bakPath = resolve(root, "package.json.bak");

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

// Back up the original before mutating.
copyFileSync(pkgPath, bakPath);

// Remove the devDependencies key entirely — it should not appear in the tarball.
delete pkg.devDependencies;

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log("strip-dev-deps: devDependencies removed from package.json for packing.");
