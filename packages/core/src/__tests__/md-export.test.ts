/**
 * md-export.ts unit tests — oneLineSummary (F1 fix regression coverage).
 *
 * F1 (post-review, confirmed in shipped artifacts): the prior regex `/^[^.!?]*[.!?]/` excluded
 * `.!?` from its character class but not `\n`, so a body whose first sentence spanned a newline
 * produced a "one-line" summary that embedded a literal newline — corrupting the index.md bullet
 * it's interpolated into. Verified empirically against the real corpus (eval-corpus/source/monet.db):
 * exactly 4 concepts triggered it. These tests cover the two independent code paths that could
 * carry a newline through (the ≤160-char first-sentence branch, and the verbatim-body fallback
 * branch) plus the ordinary non-pathological case, so a regression in either branch is caught.
 */
import { describe, it, expect } from "vitest";
import { oneLineSummary } from "../eval/md-export";

describe("oneLineSummary — F1 fix: never embeds a raw newline", () => {
  it("ordinary single-line body with an early period is unaffected (baseline, non-regression)", () => {
    const body = "This is a short sentence. It has a second sentence too.";
    const summary = oneLineSummary(body);
    expect(summary).toBe("This is a short sentence.");
    expect(summary).not.toMatch(/\n/);
  });

  it("first-sentence-spans-a-newline case (the exact bug shape): heading-prefixed body with '.' after a line break", () => {
    // Mirrors the real "## aart Production-Readiness Audit (2-dimensional map)\n\n### 1. ..." shape
    // that triggered the bug — no '.' on the first line, so the old regex's match ran through the
    // newline to find one, embedding it in the "one-line" result.
    const body = "## Section header\n\n### 1. First real point follows here with more detail than fits.";
    const summary = oneLineSummary(body);
    expect(summary).not.toMatch(/\n/);
    expect(summary.startsWith("## Section header ### 1.")).toBe(true);
  });

  it("verbatim-fallback branch (no '.!?' within 160 chars) also collapses embedded newlines", () => {
    // No sentence-ending punctuation at all within the 160-char window, so the fallback branch
    // (candidate = body verbatim) is taken — that branch must ALSO strip newlines, not just the
    // first-sentence branch, since a body can have an early line break with no early punctuation.
    const body = "no punctuation on this first line at all\nsecond line continues the thought without a period anywhere near the start of this body text";
    const summary = oneLineSummary(body);
    expect(summary).not.toMatch(/\n/);
  });

  it("collapses internal whitespace runs (multiple newlines/spaces) to single spaces, not just the first", () => {
    const body = "Line one has no period\n\n\nLine two   also   has   extra   spaces and no early punctuation either, running well past a hundred and sixty characters just to be sure the fallback branch is the one exercised here.";
    const summary = oneLineSummary(body);
    expect(summary).not.toMatch(/\n/);
    expect(summary).not.toMatch(/ {2,}/);
  });

  it("real corpus regression sample: the RATINGS DATA SOURCE shape (list-style body, period after a newline)", () => {
    const body =
      "RATINGS DATA SOURCE (price-intel, probed 2026-06-27) — exact fields for the customer-review quality gate:\n- JB Hi-Fi: REAL stars = product.rating (0-5), reviewCount = product.reviewCount.";
    const summary = oneLineSummary(body);
    expect(summary).not.toMatch(/\n/);
  });

  it("still truncates to ~137 chars + ellipsis when the collapsed candidate exceeds 140 chars", () => {
    const longSentence = "A".repeat(200) + ".";
    const summary = oneLineSummary(longSentence);
    expect(summary.endsWith("…")).toBe(true);
    expect(summary.length).toBe(138); // 137 chars + the ellipsis character
  });
});
