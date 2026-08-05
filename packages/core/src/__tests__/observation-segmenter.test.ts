/**
 * Observation segmenter tests (#155, docs/design/bounded-retrieval-unit.md).
 *
 * The segmenter is where RELIABLE_EMBED_TOKENS stops being advice and becomes a bound, so the
 * properties that matter are the ones a downstream consumer is entitled to assume:
 *
 *   - no segment exceeds the budget (the whole point — ranking must happen inside the reliable zone)
 *   - non-empty text always yields at least one segment (an observation with none is invisible to
 *     retrieval, which is the design's own failure mode reintroduced by its fix)
 *   - segmentation is deterministic (what makes the migration idempotent by protocol)
 *   - an unbounded provider is untouched (a lexical-embedder store pays nothing for this layer)
 *   - the boundary hierarchy is respected: paragraph, then sentence, then a hard cut
 *
 * A FAKE TOKENIZER, deliberately. These are properties of the packing algorithm, not of MiniLM, and
 * a word-count tokenizer makes every expected boundary computable by hand. The ONNX tokenizer is
 * exercised where it belongs — the embedder's own tests.
 */
import { describe, it, expect } from "vitest";
import { segmentObservation, segmentTokenBudget, type SegmentBudgetProvider } from "../observation-segmenter";
import { RELIABLE_EMBED_TOKENS } from "../embed-budget";

/** One token per whitespace-separated word — small, exact, and independent of any model. */
const words: SegmentBudgetProvider = {
  inputWindow: () => 512,
  countTokens: (t: string) => (t.trim() === "" ? 0 : t.trim().split(/\s+/u).length),
};
const countWords = (t: string) => (t.trim() === "" ? 0 : t.trim().split(/\s+/u).length);
const sentence = (n: number, word: string) => `${Array.from({ length: n }, () => word).join(" ")}.`;

describe("segmentTokenBudget", () => {
  it("is the smaller of the reliable budget and the provider's window", async () => {
    expect(await segmentTokenBudget(words)).toBe(RELIABLE_EMBED_TOKENS);
  });

  it("takes the provider's window when it is narrower than the reliable budget", async () => {
    const narrow: SegmentBudgetProvider = { ...words, inputWindow: () => 64 };
    expect(await segmentTokenBudget(narrow)).toBe(64);
  });

  it("reports unbounded for a provider that declares no window", async () => {
    expect(await segmentTokenBudget({})).toBeNull();
    expect(await segmentTokenBudget({ ...words, inputWindow: () => null })).toBeNull();
  });
});

describe("segmentObservation", () => {
  it("returns the observation unchanged when it already fits", async () => {
    const text = "One short claim about the store.";
    expect(await segmentObservation(text, 280, words)).toEqual([text]);
  });

  it("returns a single segment for an unbounded provider however long the text", async () => {
    const long = sentence(5000, "alpha");
    expect(await segmentObservation(long, null, words)).toEqual([long]);
  });

  it("returns no segments for empty or whitespace-only text", async () => {
    expect(await segmentObservation("", 280, words)).toEqual([]);
    expect(await segmentObservation("   \n\n  ", 280, words)).toEqual([]);
  });

  it("never emits a segment over budget", async () => {
    const text = [sentence(40, "alpha"), sentence(60, "beta"), sentence(30, "gamma")].join("\n\n");
    const segments = await segmentObservation(text, 50, words);
    expect(segments.length).toBeGreaterThan(1);
    for (const s of segments) expect(countWords(s)).toBeLessThanOrEqual(50);
  });

  it("splits a single over-budget sentence by hard cut rather than dropping it", async () => {
    // No paragraph and no sentence boundary anywhere: the hard cut is the only way this indexes.
    const runOn = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
    const segments = await segmentObservation(runOn, 30, words);
    expect(segments.length).toBeGreaterThanOrEqual(7);
    for (const s of segments) expect(countWords(s)).toBeLessThanOrEqual(30);
    // Nothing is lost: every original word survives somewhere, in order.
    expect(segments.join(" ").split(/\s+/u)).toEqual(runOn.split(" "));
  });

  it("prefers the paragraph boundary when paragraphs fit the budget", async () => {
    const a = sentence(20, "alpha");
    const b = sentence(20, "beta");
    const segments = await segmentObservation(`${a}\n\n${b}`, 25, words);
    expect(segments).toEqual([a, b]);
  });

  it("falls to sentence boundaries only when a paragraph does not fit", async () => {
    const paragraph = `${sentence(20, "alpha")} ${sentence(20, "beta")}`;
    const segments = await segmentObservation(paragraph, 25, words);
    expect(segments).toEqual([sentence(20, "alpha"), sentence(20, "beta")]);
  });

  it("packs small units back up instead of emitting thin fragments", async () => {
    // Ten 5-word sentences under a 28-token budget: greedy packing should fill segments, not emit ten.
    const text = Array.from({ length: 10 }, (_, i) => sentence(4, `w${i}`)).join(" ");
    const segments = await segmentObservation(text, 28, words);
    expect(segments.length).toBeLessThanOrEqual(3);
    for (const s of segments) expect(countWords(s)).toBeLessThanOrEqual(28);
  });

  it("is deterministic — the migration's idempotency rests on this", async () => {
    const text = [sentence(40, "alpha"), sentence(90, "beta"), sentence(15, "gamma")].join("\n\n");
    const once = await segmentObservation(text, 33, words);
    const twice = await segmentObservation(text, 33, words);
    expect(twice).toEqual(once);
  });

  it("segments Korean text on its token count, not its character count", async () => {
    // The budget is in the provider's tokens; a character-length shortcut would split this
    // differently from the way the model actually reads it.
    const ko = Array.from({ length: 60 }, (_, i) => `문장${i} 입니다.`).join(" ");
    const segments = await segmentObservation(ko, 20, words);
    expect(segments.length).toBeGreaterThan(1);
    for (const s of segments) expect(countWords(s)).toBeLessThanOrEqual(20);
  });
});
