/**
 * Phase 1 corpus derivation — step 2: md-tree export.
 *
 *   tsx scripts/export-corpus-md.ts [--db=eval-corpus/db] [--out=eval-corpus/md]
 *
 * For each derived per-size .db under --db/<size>/monet.db (produced by sample-corpus.ts),
 * exports a steelman md-tree (index.md + topics/*.md + chunks.json) under --out/<size>/, using
 * exportMdTreeFromStore() (md-export-store.ts) — the content-only, gold-manifest-free sibling of
 * the Phase 0 scenario exporter.
 *
 * chunks.json is `Array<{ chunkId, file, text }>` — no gold manifest (there is no synthetic gold
 * for a real store; scoring/gold-mapping is the separate eval-arm actor's concern, not this
 * pipeline's).
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MonetCore } from "../src/engine";
import { exportMdTreeFromStore } from "../src/eval/md-export-store";
import { SAMPLED_CIRCLE } from "../src/eval/corpus-sample";

function parseArgs(argv: string[]): { db: string; out: string } {
  let db = "eval-corpus/db";
  let out = "eval-corpus/md";
  for (const arg of argv) {
    if (arg.startsWith("--db=")) db = arg.slice("--db=".length);
    else if (arg.startsWith("--out=")) out = arg.slice("--out=".length);
  }
  return { db, out };
}

function main(): void {
  const { db, out } = parseArgs(process.argv.slice(2));
  const dbDir = resolve(db);
  const outDir = resolve(out);

  if (!existsSync(dbDir)) {
    throw new Error(`Derived-db dir not found at ${dbDir}. Run scripts/sample-corpus.ts first.`);
  }
  const sizes = readdirSync(dbDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  console.log(`Exporting md-trees for sizes: ${sizes.join(", ")}`);

  for (const size of sizes) {
    const dbPath = join(dbDir, size, "monet.db");
    if (!existsSync(dbPath)) {
      console.log(`  [${size}] SKIP — no monet.db found at ${dbPath}`);
      continue;
    }
    const core = new MonetCore(dbPath);
    try {
      const result = exportMdTreeFromStore(core, { circle: SAMPLED_CIRCLE });
      const sizeOutDir = join(outDir, size);
      const topicsDir = join(sizeOutDir, "topics");
      mkdirSync(topicsDir, { recursive: true });

      writeFileSync(join(sizeOutDir, "index.md"), result.indexMd, "utf8");
      for (const [relPath, content] of result.topicFiles) {
        // relPath is "topics/<slug>.md" — join against sizeOutDir directly, not topicsDir twice.
        writeFileSync(join(sizeOutDir, relPath), content, "utf8");
      }
      writeFileSync(join(sizeOutDir, "chunks.json"), JSON.stringify(result.chunks, null, 2) + "\n", "utf8");

      console.log(
        `  [${size}] topics=${result.topicFiles.size} chunks=${result.chunks.length} collidedSlugs=${result.collidedSlugs.length}` +
          (result.collidedSlugs.length > 0 ? ` (${result.collidedSlugs.join(", ")})` : ""),
      );
    } finally {
      core.close();
    }
  }

  console.log(`\nWritten under ${outDir}/<size>/{index.md,topics/*.md,chunks.json}`);
}

main();
