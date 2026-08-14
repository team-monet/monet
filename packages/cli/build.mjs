/**
 * Publish build for @team-monet/monet.
 *
 * Bundles the pure-JS dependency graph (including the @team-monet/core workspace engine) into
 * self-contained ESM, but EXTERNALIZES native / heavy modules so esbuild never tries to
 * inline a .node binary and so they load from node_modules at runtime:
 *   - better-sqlite3                       — native; the local store (literal import in engine.ts)
 *   - @huggingface/transformers + onnxruntime-* + sharp — native; the optional MiniLM embedder
 *
 * Those are declared as (optional) runtime dependencies of this package; everything else
 * is bundled. Run `node build.mjs` for all targets, or `node build.mjs <index|cli>`.
 *
 * Post-bundle step: copies the dashboard static assets (index.html, app.js, style.css)
 * from src/dashboard/static/ (vendored in-repo) into dist/dashboard/ so they ship in
 * the npm tarball and are resolved at runtime relative to import.meta.url in dist/cli.js.
 */
import { build } from "esbuild";
import { rmSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
      sourcemap: false,
      minify: true,
      legalComments: "none",
      external: EXTERNAL,
      // ESM output needs a real `require` so bundled CJS deps (e.g. commander's
      // `require("node:events")`) resolve instead of hitting esbuild's throwing stub.
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
      logLevel: "info",
    });
  }),
);

// ── Dashboard asset copy ─────────────────────────────────────────────────────
// Only copy when building the full bundle (not a targeted single-target build).
// Dashboard assets are read-only viewer code — no engine IP, safe to ship readable.
// Assets are vendored in-repo at src/dashboard/static/ — never read from a sibling dir.
if (!only || only === "cli") {
  const DASHBOARD_SRC = join(__dirname, "src", "dashboard", "static");
  const DASHBOARD_OUT = join(__dirname, "dist", "dashboard");
  const ASSETS = ["index.html", "app.js", "style.css"];

  if (!existsSync(DASHBOARD_SRC)) {
    console.error(
      `[build] ERROR: in-repo dashboard assets not found at ${DASHBOARD_SRC}. ` +
      "Run: cp path/to/{index.html,app.js,style.css} src/dashboard/static/"
    );
    process.exit(1);
  }

  const missing = ASSETS.filter((a) => !existsSync(join(DASHBOARD_SRC, a)));
  if (missing.length > 0) {
    console.error(
      `[build] ERROR: missing dashboard asset(s) in ${DASHBOARD_SRC}: ${missing.join(", ")}`
    );
    process.exit(1);
  }

  mkdirSync(DASHBOARD_OUT, { recursive: true });
  for (const asset of ASSETS) {
    const src = join(DASHBOARD_SRC, asset);
    const dst = join(DASHBOARD_OUT, asset);
    copyFileSync(src, dst);
    console.log(`[build] copied dashboard/${asset}`);
  }
  console.log(`[build] dashboard assets → dist/dashboard/`);
}
