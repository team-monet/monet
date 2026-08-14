/**
 * EVERY *.onnx.test.ts FILE MUST BE NAMED IN THE NIGHTLY.
 *
 * Those files gate themselves on `MONET_EVAL_ONNX`, and the nightly workflow is the only thing that
 * sets it. The workflow selects files with vitest POSITIONAL FILTERS, which are substring matches on
 * the path — not globs. So a file that self-gates but is never named in that list does not run
 * anywhere: not in CI, not in the nightly, not on any developer's machine unless they type its name.
 * It is dead, and it looks exactly like a passing file.
 *
 * That is not hypothetical. `recall-floor.onnx.test.ts` and `resolution-hybrid.onnx.test.ts` were in
 * that state for their whole existence. The first time anyone ran them they failed 5 of 9 assertions,
 * including an absolute constant that had been inert since the embedder swap (monet-core#170) — while
 * the nightly reported green every night, because the two files it did name could not observe any of
 * it.
 *
 * This test runs in ordinary CI on the lexical embedder. It reads no model and asserts nothing about
 * recall; it only checks that the workflow's filter list covers the directory. Adding a new
 * *.onnx.test.ts file without adding it to eval-nightly.yml fails here, at the moment the file is
 * added, rather than silently years later.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = HERE;
// The nightly lives at the REPOSITORY root, not inside this package. GitHub reads workflows only
// from the root `.github/workflows/`, so in a monorepo that is the one place they can be — four
// levels up from packages/core/src/__tests__.
const WORKFLOW = resolve(HERE, "../../../../.github/workflows/eval-nightly.yml");

describe("nightly ONNX gate coverage", () => {
  it("names every *.onnx.test.ts file in the nightly's vitest filter list", () => {
    const files = readdirSync(TESTS_DIR).filter((f) => f.endsWith(".onnx.test.ts"));
    expect(files.length).toBeGreaterThan(0); // the check is vacuous if the glob ever stops matching

    const workflow = readFileSync(WORKFLOW, "utf8");
    // The filters are the bare basenames minus `.test.ts` — e.g. `recall-floor.onnx`. Match on that
    // exact token so a filter that merely mentions the file in a comment does not count as coverage.
    const runLine = workflow
      .split("\n")
      .find((l) => l.includes("vitest run") && l.includes("MONET_EVAL_ONNX") === false && l.includes("--dir src"));
    expect(runLine, "no `vitest run --dir src` line found in eval-nightly.yml").toBeTruthy();

    const missing = files
      .map((f) => f.replace(/\.test\.ts$/, ""))
      .filter((token) => !runLine!.includes(token));

    expect(
      missing,
      `these *.onnx.test.ts files self-gate on MONET_EVAL_ONNX but are not named in eval-nightly.yml, ` +
        `so they never run anywhere: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
