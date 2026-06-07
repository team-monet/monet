import { defineConfig } from "tsup";

/**
 * Build the library with tsup (esbuild + .d.ts). Bundling lets source imports stay
 * EXTENSIONLESS (`./engine`) while the published dist still resolves under Node ESM —
 * tsc alone would emit the specifiers verbatim and require `.js` everywhere in source.
 *
 * Only the public entry (index.ts) is built; dev scripts (scripts/) and the eval (src/eval)
 * are run via tsx and never shipped. Runtime deps stay external (better-sqlite3 is native;
 * @huggingface/transformers is optional and loaded via a dynamic specifier).
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  external: ["better-sqlite3", "@modelcontextprotocol/sdk", "zod", "@huggingface/transformers"],
});
