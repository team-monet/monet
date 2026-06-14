/**
 * Post-build: strip block comments (/** ... *\/ and /* ... *\/) from dist/**\/*.d.ts.
 * Keeps all type declarations intact — only comments are removed.
 *
 * Wired via tsup `onSuccess` so it runs automatically after every build.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { globSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(root, "dist");

// glob is available in Node 22 via fs.globSync; fall back to a manual find for older runtimes.
let files;
try {
  files = globSync("**/*.d.ts", { cwd: distDir }).map((f) => resolve(distDir, f));
} catch {
  // Node < 22: walk manually
  const { readdirSync, statSync } = await import("node:fs");
  function walk(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (entry.endsWith(".d.ts")) out.push(full);
    }
    return out;
  }
  files = walk(distDir);
}

if (files.length === 0) {
  console.error("strip-dts-comments: no .d.ts files found in dist/ — build may not have emitted types");
  process.exit(1);
}

let totalRemoved = 0;

for (const file of files) {
  const original = readFileSync(file, "utf8");

  // Remove block comments: /** ... */ and /* ... */ (non-greedy, dotAll)
  // Using a two-pass regex to catch both JSDoc and plain block comments.
  const stripped = original.replace(/\/\*[\s\S]*?\*\//g, "");

  // Collapse runs of blank lines left behind by removed comments (cosmetic)
  const cleaned = stripped.replace(/\n{3,}/g, "\n\n").trimStart();

  const before = (original.match(/\/\*[\s\S]*?\*\//g) ?? []).length;
  totalRemoved += before;

  if (cleaned !== original) {
    writeFileSync(file, cleaned, "utf8");
    console.log(`strip-dts-comments: ${file} — removed ${before} block comment(s)`);
  }
}

console.log(`strip-dts-comments: done. ${totalRemoved} block comment(s) removed across ${files.length} file(s).`);
