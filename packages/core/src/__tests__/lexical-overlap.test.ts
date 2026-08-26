/**
 * THE TOKENIZER, AND THE ONE INVARIANT THAT TIES ITS TWO READERS TOGETHER (#38).
 *
 * `lexicalTokens` feeds the lexical arm's posting list and `lexicalCoverage` decides whether a
 * lexically-blended threshold may be applied to a text at all. Both read one walk of the text, and
 * the reason they must is the bug class #38 belongs to: when the numerator of coverage counts
 * something other than what the tokenizer actually emitted, a text can be called readable that the
 * arm reads nothing of, or unreadable that it reads all of. These tests pin the walk, and pin that
 * the two readers agree.
 */
import { describe, it, expect } from "vitest";
import { LEXICAL_COVERAGE_MIN, lexicalCoverage, lexicalOverlap, lexicalTokens, tokenIdf } from "../lexical-overlap";

/** The tokenizer as it shipped before #38 — Latin-only. The invariance tests compare against it. */
const RETIRED_TOKEN = /[a-z0-9][a-z0-9_-]{2,}/gu;
const retiredTokens = (text: string): Set<string> => new Set(text.toLowerCase().match(RETIRED_TOKEN) ?? []);
function retiredCoverage(text: string): number {
  const lower = text.toLowerCase();
  const alnum = lower.match(/[\p{L}\p{N}]/gu);
  if (alnum === null || alnum.length === 0) return 1;
  let covered = 0;
  for (const m of lower.matchAll(RETIRED_TOKEN)) covered += (m[0].match(/[\p{L}\p{N}]/gu) ?? []).length;
  return Math.min(1, covered / alnum.length);
}

describe("lexicalTokens — the CJK branch (#38)", () => {
  it("emits character bigrams over a Hangul run", () => {
    // A run is a phrase, not a word: Korean spaces at the eojeol boundary, so `페리는` is
    // "the ferry" + a topic particle. Bigrams are what let two different phrasings share evidence.
    expect([...lexicalTokens("페리는 매시")]).toEqual(["페리", "리는", "매시"]);
  });

  it("bigrams a run of n characters into n-1 tokens, in order, without crossing a space", () => {
    const toks = [...lexicalTokens("출발한다")];
    expect(toks).toEqual(["출발", "발한", "한다"]);
    // Two runs stay two runs — no bigram spans the space.
    expect([...lexicalTokens("섬으로 출발")]).toEqual(["섬으", "으로", "출발"]);
  });

  it("drops a one-character run rather than emitting a unigram", () => {
    // The same rule the Latin class applies to `a` and `to`. Single Hangul syllables between spaces
    // are almost all grammatical, and a unigram of one is a token nearly every text contains.
    expect([...lexicalTokens("이 글 은 문서")]).toEqual(["문서"]);
    expect(lexicalTokens("本").size).toBe(0);
  });

  it("reads Han, Hiragana and Katakana, and keeps the marks that belong to a run", () => {
    expect([...lexicalTokens("出発")]).toEqual(["出発"]);
    expect([...lexicalTokens("する")]).toEqual(["する"]);
    // `ー` (U+30FC) and `々` (U+3005) are Script=Common and would split these runs under `sc=`;
    // Script_Extensions keeps them attached.
    expect([...lexicalTokens("データー")]).toEqual(["デー", "ータ", "ター"]);
    expect([...lexicalTokens("人々")]).toEqual(["人々"]);
  });

  it("cuts bigrams on code points, so an astral CJK pair is one token and not two half-surrogates", () => {
    const toks = [...lexicalTokens("\u{20000}\u{20001}")]; // CJK Extension B
    expect(toks).toEqual(["\u{20000}\u{20001}"]);
    expect([...toks[0]].length).toBe(2);
  });

  it("does not let punctuation join two sentences into one bigram", () => {
    // `。` is not a letter, so it ends a run — the whole point of intersecting the CJK class with
    // `[\p{L}\p{N}]`.
    expect([...lexicalTokens("出発。到着")]).toEqual(["出発", "到着"]);
  });
});

describe("lexicalTokens — mixed KO/EN text", () => {
  it("keeps the Latin identifier whole and bigrams the Korean around it", () => {
    const toks = lexicalTokens("tauAttach 임계값을 0.70 으로 조정한다");
    expect(toks.has("tauattach")).toBe(true); // lowercased, undivided
    expect(toks.has("임계")).toBe(true);
    expect(toks.has("계값")).toBe(true);
    expect(toks.has("조정")).toBe(true);
    // No token straddles the boundary between the two scripts.
    for (const t of toks) expect(/^[a-z0-9_-]+$/u.test(t) || !/[a-z0-9]/u.test(t)).toBe(true);
  });

  it("leaves a text with no CJK byte-identical to the retired Latin-only tokenizer", () => {
    // THE GUARD ON THE OTHER 83% OF THE CORPUS. #38 widened the tokenizer; it must not have moved
    // English, and this is the assertion that says so rather than a measurement that hopes so.
    for (const text of [
      "the ferry to the island leaves at quarter past every hour",
      "tauAttach source_chunks api____________________ 0.70",
      "l'été à Genève est déjà arrivé",
      "🚢⏰🏝️",
      "",
    ]) {
      expect([...lexicalTokens(text)].sort()).toEqual([...retiredTokens(text)].sort());
      expect(lexicalCoverage(text)).toBe(retiredCoverage(text));
    }
  });
});

describe("lexicalCoverage — the counting invariant", () => {
  /**
   * The invariant restated as a POSITION MASK, derived from the rule rather than from the
   * implementation: mark every character position an emitted token occupies, then count the marked
   * letters and digits. Once per position, so overlapping bigrams cannot inflate it — which is
   * exactly the arithmetic `lexicalCoverage` has to get right.
   */
  const coveredByMask = (text: string): number => {
    const lower = text.toLowerCase();
    const cps = [...lower];
    const isAlnum = (c: string): boolean => /[\p{L}\p{N}]/u.test(c);
    const alnum = cps.filter(isAlnum).length;
    if (alnum === 0) return 1;
    const mask = new Array<boolean>(cps.length).fill(false);
    const mark = (utf16Index: number, len: number): void => {
      const start = [...lower.slice(0, utf16Index)].length;
      for (let i = 0; i < len; i++) mask[start + i] = true;
    };
    for (const m of lower.matchAll(RETIRED_TOKEN)) mark(m.index!, [...m[0]].length); // Latin: unchanged by #38
    const CJK_RUN = /(?:(?=[\p{L}\p{N}])[\p{scx=Han}\p{scx=Hangul}\p{scx=Hiragana}\p{scx=Katakana}])+/gu;
    for (const m of lower.matchAll(CJK_RUN)) {
      const len = [...m[0]].length;
      if (len < 2) continue; // a lone run emits nothing, so it reads nothing
      mark(m.index!, len);
    }
    let covered = 0;
    for (let i = 0; i < cps.length; i++) if (mask[i] && isAlnum(cps[i])) covered++;
    return Math.min(1, covered / alnum);
  };

  it("counts a bigrammed run once per character, never once per overlapping token", () => {
    // A 3-character run emits 2 bigrams totalling 4 characters. Summing token lengths would report
    // 4/3 = 1.33 coverage and let `Math.min` hide the double count — the CJK face of the same defect
    // `api____________________` was the Latin face of.
    expect(lexicalCoverage("출발한")).toBeCloseTo(1.0, 10);
    expect([...lexicalTokens("출발한")]).toEqual(["출발", "발한"]); // 2 tokens, 4 chars, 3 read
  });

  it("does not count a character no emitted token contains", () => {
    // "본" is a lone run: dropped by the tokenizer, so it must not be counted as read. Four alnum
    // characters, two of them ("문서") read.
    expect(lexicalCoverage("본 문서")).toBeCloseTo(2 / 3, 10);
    expect([...lexicalTokens("본 문서")]).toEqual(["문서"]);
  });

  it("agrees with a character-by-character recount of the tokens it emitted", () => {
    for (const text of [
      "페리는 매시 십오분에 섬으로 출발한다",
      "API 페리는 매시 십오분에 섬으로 출발한다",
      "tauAttach 임계값을 0.70 으로 조정한다",
      "이 글 은 그 수 것 문서",
      "the ferry to the island leaves at quarter past every hour",
      "l'été à Genève est déjà arrivé",
      "出発。到着 する データー 人々",
      "api____________________ 페리",
    ]) {
      expect(lexicalCoverage(text), text).toBeCloseTo(coveredByMask(text), 10);
    }
  });

  it("never exceeds 1, and stays vacuously 1 when there is nothing to read", () => {
    for (const text of ["", "🚢⏰🏝️", "   ", "!!! ??? ...", "페리는 매시 십오분에 섬으로 출발한다"]) {
      const c = lexicalCoverage(text);
      expect(c).toBeLessThanOrEqual(1);
      expect(c).toBeGreaterThanOrEqual(0);
    }
    expect(lexicalCoverage("🚢⏰🏝️")).toBe(1); // no letters or digits at all
  });

  it("lifts Korean prose over LEXICAL_COVERAGE_MIN, which is the write-side half of #38", () => {
    const KO = "페리는 매시 십오분에 섬으로 출발한다";
    expect(retiredCoverage(KO)).toBe(0); // the defect, stated
    expect(lexicalCoverage(KO)).toBeGreaterThanOrEqual(LEXICAL_COVERAGE_MIN); // the fix, stated
  });

  it("still refuses accented Latin, which #38 did not widen", () => {
    // The contrast case LEXICAL_COVERAGE_MIN has cited since its first derivation: `[a-z0-9_-]`
    // drops every accented character, so this text really is mostly unreadable to the arm.
    expect(lexicalCoverage("l'été à Genève est déjà arrivé")).toBeLessThan(LEXICAL_COVERAGE_MIN);
  });
});

describe("tokenIdf over CJK bigrams", () => {
  it("weighs a bigram by the concepts that hold it, exactly as it weighs a Latin token", () => {
    // The arm's whole discriminative claim is document frequency, and a bigram is just a token to
    // it. A bigram in one concept of ten outweighs one in nine.
    expect(tokenIdf(10, 1)).toBeGreaterThan(tokenIdf(10, 9));
    expect(tokenIdf(10, 10)).toBe(0); // a bigram every concept holds is NEUTRAL, never negative
  });

  it("lets a rare bigram carry the overlap while a grammatical one cannot", () => {
    // `한다` is a verb ending: on a Korean corpus it is in nearly every concept. `페리` ("ferry") is
    // in one. The overlap must be decided by the second, which is what IDF weighting is for.
    const conceptCount = 20;
    const df = new Map([["한다", 20], ["출발", 12], ["페리", 1]]);
    const idfOf = (t: string): number => tokenIdf(conceptCount, df.get(t) ?? 0);
    const probe = new Set(["페리", "출발", "한다"]);

    const sharesTheRareOne = lexicalOverlap(probe, new Set(["페리", "한다"]), idfOf);
    const sharesOnlyGrammar = lexicalOverlap(probe, new Set(["한다"]), idfOf);
    expect(sharesTheRareOne).toBeGreaterThan(sharesOnlyGrammar);
    expect(sharesOnlyGrammar).toBe(0); // df === conceptCount clamps to zero: it decides nothing
  });

  it("scores a real Korean pair above zero, where the retired tokenizer scored exactly zero", () => {
    // The read-side half of #38 at unit scale: two Korean texts about the same thing shared no
    // token at all before the CJK branch, so `applyLexicalArm` short-circuited on an empty probe.
    const a = lexicalTokens("페리는 매시 십오분에 섬으로 출발한다");
    const b = lexicalTokens("페리는 주말에 매시 십오분에 항구에서 출발한다");
    expect(retiredTokens("페리는 매시 십오분에 섬으로 출발한다").size).toBe(0);
    expect(a.size).toBeGreaterThan(0);
    const shared = [...a].filter((t) => b.has(t));
    expect(shared.length).toBeGreaterThan(0);
    // With every token in one of two concepts, tokenIdf(N=3, df=1) is positive and the overlap is
    // a real fraction rather than the 0 the old tokenizer forced.
    const idfOf = (): number => tokenIdf(3, 1);
    expect(lexicalOverlap(a, b, idfOf)).toBeGreaterThan(0);
  });
});
