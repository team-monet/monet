/**
 * db-slugify.test.ts — byte-verifies src/db-slugify.mjs's `slugify` mirror against the REAL
 * `slugify` exported from src/engine.ts (round 3, F2 fix — see scrub-db.mjs's module doc, "AUDIT
 * FINDINGS, ROUND 3", F2, for the full leak this mirror closes: concepts.slug derived from a raw
 * pre-scrub title, never regenerated after the title itself is scrubbed).
 *
 * WHY A SEPARATE MIRROR FILE INSTEAD OF IMPORTING engine.ts's slugify DIRECTLY FROM
 * scripts/scrub-db.mjs: scrub-db.mjs is a plain `.mjs` script invoked with plain `node` (not
 * `tsx`) — the exact same portability constraint documented in src/eval/corpus-scope.mjs's own
 * module doc, and the exact same reason src/extract-entities.mjs exists as a byte-verified mirror
 * of src/extract-entities.ts. engine.ts's `slugify` was made `export`ed (previously private)
 * SOLELY so this test can import it directly for a real byte-comparison — see engine.ts's own doc
 * comment on that export for why this is a safe, logic-unchanged visibility-only change.
 *
 * This suite runs a broad batch of representative inputs (including the exact punctuation classes
 * scrubString's own patterns depend on — `/`, `~`, `@`, `.` — plus mixed case, non-ascii-adjacent
 * punctuation, empty string, and boundary lengths around the 60-char slice) through BOTH functions
 * and asserts byte-identical output, so any future drift between the mirror and the real
 * implementation fails a test immediately rather than silently reintroducing a slug-derivation
 * mismatch (which would produce a slug scrub-db.mjs computes that a LIVE engine would never
 * actually have produced for the same title — a correctness bug independent of the scrubbing
 * question this mirror otherwise exists to fix).
 */
import { describe, it, expect } from "vitest";
import { slugify as realSlugify } from "../engine";
// @ts-expect-error — plain .mjs mirror, no type declarations; imported for its exported pure function only.
import { slugify as mirroredSlugify } from "../db-slugify.mjs";

describe("db-slugify.mjs's slugify mirror — byte-identical to engine.ts's real slugify", () => {
  const cases: string[] = [
    "",
    "a",
    "Contact jane.doe@example.com about the deploy",
    "/Users/dev/code/monet-core/src/engine.ts is the file",
    "~/.monet/monet.db is the live store",
    "MixedCASE Title With Numbers123 and-Hyphens",
    "tenant acme reachable at 192.168.1.10:9301",
    "a string exactly sixty characters long, padded out to hit that exact bound!!",
    "a string that is definitely, certainly, and unambiguously longer than sixty characters by a wide margin so the slice(0,60) boundary is exercised for real",
    "!!!___...leading and trailing punctuation-only noise...___!!!",
    "unicode-adjacent: café, naïve, — em dash, “curly quotes”",
    "multiple    consecutive     whitespace   runs",
    "a.b.c.d.e.f.g dotted identifier chain",
    "snake_case_identifier_with_many_underscores",
    "key_Ex4mpleN0tAReal1 is a secret-shaped bare key",
    "?key=abcdef0123456789 query-param-secret shape",
    "   leading and trailing whitespace   ",
    "-already-looks-like-a-slug-",
    "ALLCAPS TITLE CASE",
    "12345 numeric-leading title",
  ];

  it.each(cases.map((input, i) => [i, input] as const))("case %i: %s", (_i, input) => {
    expect(mirroredSlugify(input)).toBe(realSlugify(input));
  });

  it("produces exactly what engine.ts's real slugify produces for a title with all four scrub-relevant separators at once", () => {
    const input = "Contact jane.doe@example.com about ~/code/foo and /Users/dev/bar, tenant acme.";
    expect(mirroredSlugify(input)).toBe(realSlugify(input));
    // Sanity: both actually collapse separators into hyphens (not a vacuous pass where both sides
    // happen to throw or both return the input unchanged).
    expect(mirroredSlugify(input)).toMatch(/^[a-z0-9-]*$/);
  });

  it("both truncate to exactly 60 characters for long input, byte-identically", () => {
    const long = "x".repeat(200);
    const mirrored = mirroredSlugify(long);
    const real = realSlugify(long);
    expect(mirrored).toBe(real);
    expect(mirrored.length).toBeLessThanOrEqual(60);
  });

  it("both return an empty string for input with no letters or numbers", () => {
    const input = "😀✨!!!@@@###$$$";
    expect(mirroredSlugify(input)).toBe(realSlugify(input));
    expect(mirroredSlugify(input)).toBe("");
  });

  it("never emits the colon reserved by the workstream inbox slug", () => {
    for (const input of cases) expect(realSlugify(input)).not.toContain(":");
    expect(realSlugify("a:title::with:colons")).toBe("a-title-with-colons");
  });

  it("is NOT the same function as src/eval/md-export.ts's DIFFERENT slugify (48-char slice + 'topic' fallback) — sanity check that these two are not accidentally conflated", async () => {
    const { slugify: mdExportSlugify } = await import("../eval/md-export");
    // An input engineered to differ under the two different slice lengths (60 vs 48).
    const input = "x".repeat(55);
    expect(mirroredSlugify(input).length).toBe(55); // under 60, unaffected by db-slugify's slice
    expect(mdExportSlugify(input).length).toBe(48); // sliced to 48 by md-export's OWN slugify
    expect(mirroredSlugify(input)).not.toBe(mdExportSlugify(input));
  });
});
