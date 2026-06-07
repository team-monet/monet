/**
 * Publish build for @team-monet/local.
 *
 * Bundles the pure-JS dependency graph (including the @team-monet/core workspace engine) into
 * self-contained ESM, but EXTERNALIZES native / heavy modules so esbuild never tries to
 * inline a .node binary and so they load from node_modules at runtime:
 *   - better-sqlite3                       — native; the local store (literal import in engine.ts)
 *   - @huggingface/transformers + onnxruntime-* + sharp — native; the optional MiniLM embedder
 *
 * Those are declared as (optional) runtime dependencies of this package; everything else
 * is bundled. Run `node build.mjs` for all targets, or `node build.mjs <index|cli|install>`.
 */
import { build } from "esbuild";
import { rmSync } from "node:fs";

const EXTERNAL = [
  "better-sqlite3",
  "@huggingface/transformers",
  "onnxruntime-node",
  "onnxruntime-web",
  "onnxruntime-common",
  "sharp",
];

const TARGETS = {
  index: { entryPoints: ["src/index.ts"], outfile: "dist/index.js" },
  cli: { entryPoints: ["src/cli.ts"], outfile: "dist/cli.js" },
  install: { entryPoints: ["src/install.js"], outfile: "dist/install.js" },
};

const only = process.argv[2];
const names = only ? [only] : Object.keys(TARGETS);
if (!only) rmSync("dist", { recursive: true, force: true });

await Promise.all(
  names.map((name) => {
    const t = TARGETS[name];
    if (!t) throw new Error(`unknown build target "${name}" (expected: ${Object.keys(TARGETS).join(", ")})`);
    return build({
      ...t,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      sourcemap: true,
      external: EXTERNAL,
      // ESM output needs a real `require` so bundled CJS deps (e.g. commander's
      // `require("node:events")`) resolve instead of hitting esbuild's throwing stub.
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
      logLevel: "info",
    });
  }),
);
