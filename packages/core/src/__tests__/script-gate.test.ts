/**
 * The English-only script gate (#155).
 *
 * An embedder that never saw Hangul maps it to an arbitrary direction: the write succeeds, the row
 * is fetchable, and search can never reach it. That is the window guard's failure in a second
 * dimension — and worse, because the store is pinned, so re-embedding cannot rescue it later.
 *
 * What these pin:
 *   - a provider that says nothing is NOT gated (never invent a restriction)
 *   - a declaring provider refuses wholly non-Latin content, on store AND on query
 *   - English prose QUOTING another script still passes — the band the tolerance exists for
 *   - script-neutral text (digits, punctuation) is never refused
 */
import { describe, it, expect } from "vitest";
import { MonetCore, ContentScriptUnsupportedError, NON_LATIN_LETTER_TOLERANCE } from "../engine";
import { HashingEmbeddingProvider } from "../embedding";

/** The shipping lexical provider, plus the declaration an English-only model would make. */
class LatinOnlyProvider extends HashingEmbeddingProvider {
  readonly readsOnlyLatinScript = true;
}

const core = (latinOnly: boolean): MonetCore =>
  new MonetCore(":memory:", { embedder: latinOnly ? new LatinOnlyProvider() : new HashingEmbeddingProvider() });

const KOREAN = "PR 리뷰 피드백을 수정할 때 코멘트를 기계적으로 닫는 데 집중하지 않는다. 먼저 고객 관점의 실제 임팩트를 본다.";
const ENGLISH_QUOTING_KOREAN =
  "John ruled on 2026-08-05 that the review cycle needs a rule rather than another explanation, saying " +
  '"규칙 정리하자" in the middle of the session, and the disposition doctrine was written down that ' +
  "afternoon so the next reader would not have to re-derive it from the transcript again.";

describe("script gate — a provider that declares nothing", () => {
  it("does not gate, however non-Latin the text", async () => {
    const c = core(false);
    await expect(c.store(KOREAN, { circle: "s" })).resolves.toBeTruthy();
    c.close();
  });
});

describe("script gate — a Latin-only provider", () => {
  it("refuses wholly non-Latin content on store", async () => {
    const c = core(true);
    await expect(c.store(KOREAN, { circle: "s" })).rejects.toThrow(ContentScriptUnsupportedError);
    c.close();
  });

  it("names the share, so the caller can see how far over the line it is", () => {
    const c = core(true);
    try {
      c.assertEmbedderReadsScript(KOREAN);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(ContentScriptUnsupportedError);
      expect((e as ContentScriptUnsupportedError).nonLatinShare).toBeGreaterThan(NON_LATIN_LETTER_TOLERANCE);
    }
    c.close();
  });

  it("accepts English prose that QUOTES another script — the band the tolerance exists for", async () => {
    const c = core(true);
    await expect(c.store(ENGLISH_QUOTING_KOREAN, { circle: "s" })).resolves.toBeTruthy();
    c.close();
  });

  it("gates queries too, not only writes", () => {
    const c = core(true);
    expect(() => c.assertEmbedderReadsScript("코덱스 승인 어떻게 확인해?", "query")).toThrow(ContentScriptUnsupportedError);
    expect(() => c.assertEmbedderReadsScript("how do I check codex approval", "query")).not.toThrow();
    c.close();
  });

  it("never refuses script-neutral text", () => {
    const c = core(true);
    expect(() => c.assertEmbedderReadsScript("2026-08-05 155 :: 90.4% -> 97.4%")).not.toThrow();
    expect(() => c.assertEmbedderReadsScript("")).not.toThrow();
    c.close();
  });
});
