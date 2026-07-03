#!/usr/bin/env node
/**
 * verify-scrub-marker.mjs — the non-skippable enforcement half of scrub-corpus.mjs (spec §3.6:
 * "a checked-in 'scrub ran, hash X' marker the publish script verifies").
 *
 * Re-hashes every file currently under eval-corpus/publish/ and compares against
 * eval-corpus/SCRUB_MANIFEST.json (written by scrub-corpus.mjs immediately after scrubbing).
 * FAILS LOUDLY (non-zero exit, no output suppression) when:
 *   - the manifest file is missing entirely (scrub was never run),
 *   - any published file's current hash doesn't match its manifest entry (published content
 *     was modified/regenerated AFTER the scrub step, without re-running scrub-corpus.mjs),
 *   - any file present under eval-corpus/publish/ has no manifest entry (a file was added to
 *     the publish tree that scrub never saw), or
 *   - any manifest entry has no corresponding file (a published file was deleted after scrubbing
 *     without regenerating the manifest — stale-in-the-other-direction).
 *
 * This is meant to be the LAST step before anything under eval-corpus/publish/ is treated as
 * "done"/committable — run it after scrub-corpus.mjs and treat a non-zero exit as a hard stop,
 * not a warning.
 *
 * Usage: node scripts/verify-scrub-marker.mjs [--publish=eval-corpus/publish] [--manifest=eval-corpus/SCRUB_MANIFEST.json]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function collectFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full, base));
    else out.push(relative(base, full));
  }
  return out.sort();
}

function parseArgs(argv) {
  let publish = "eval-corpus/publish";
  let manifest = "eval-corpus/SCRUB_MANIFEST.json";
  for (const arg of argv) {
    if (arg.startsWith("--publish=")) publish = arg.slice("--publish=".length);
    else if (arg.startsWith("--manifest=")) manifest = arg.slice("--manifest=".length);
  }
  return { publish, manifest };
}

function main() {
  const { publish, manifest } = parseArgs(process.argv.slice(2));
  const publishDir = resolve(REPO_ROOT, publish);
  const manifestPath = resolve(REPO_ROOT, manifest);

  const problems = [];

  if (!existsSync(manifestPath)) {
    console.error(`FAIL: scrub marker not found at ${manifestPath}. Scrub has never been run — run scripts/scrub-corpus.mjs before publishing.`);
    process.exit(1);
  }
  if (!existsSync(publishDir)) {
    console.error(`FAIL: publish dir not found at ${publishDir}. Run scripts/scrub-corpus.mjs first.`);
    process.exit(1);
  }

  const manifestData = JSON.parse(readFileSync(manifestPath, "utf8"));
  const manifestFiles = new Set(Object.keys(manifestData.hashes ?? {}));
  const actualFiles = new Set(collectFiles(publishDir));

  for (const f of actualFiles) {
    if (!manifestFiles.has(f)) {
      problems.push(`file present but NOT in scrub manifest (never scrubbed): ${f}`);
      continue;
    }
    const actualHash = sha256File(join(publishDir, f));
    const expectedHash = manifestData.hashes[f];
    if (actualHash !== expectedHash) {
      problems.push(`hash mismatch (modified after scrub ran): ${f}  expected=${expectedHash.slice(0, 12)}… actual=${actualHash.slice(0, 12)}…`);
    }
  }
  for (const f of manifestFiles) {
    if (!actualFiles.has(f)) {
      problems.push(`file in scrub manifest but missing from publish dir (deleted after scrub, manifest stale): ${f}`);
    }
  }

  if (problems.length > 0) {
    console.error(`FAIL: scrub marker verification found ${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(`\nRe-run scripts/scrub-corpus.mjs to regenerate a fresh, matching manifest before publishing.`);
    process.exit(1);
  }

  console.log(`OK: scrub marker verified — ${actualFiles.size} published files, all hashes match ${manifestPath}.`);
  console.log(`Content hash: ${manifestData.contentHash}`);
}

main();
